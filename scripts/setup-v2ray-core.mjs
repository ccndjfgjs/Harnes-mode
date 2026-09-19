#!/usr/bin/env node
import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  cpSync,
  statSync,
  createWriteStream,
  readFileSync,
  openSync,
  ftruncateSync,
  closeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  normalizeBase,
  sourceName,
  parseSha256Line,
  looksLikeHtml,
  downloadPercent,
  describeFetchError,
} from './v2ray-sources.mjs'

const VERSION = process.env.DSH_V2RAY_VERSION ?? 'v5.53.0'
const ZIP_NAME = process.env.DSH_V2RAY_ZIP ?? 'v2ray-windows-64.zip'
const METADATA_IDLE_TIMEOUT_MS = Number(process.env.DSH_V2RAY_METADATA_IDLE_TIMEOUT_MS ?? '25000')
const ZIP_IDLE_TIMEOUT_MS = Number(process.env.DSH_V2RAY_ZIP_IDLE_TIMEOUT_MS ?? '45000')
const PROGRESS_UPDATE_INTERVAL_MS = Number(process.env.DSH_V2RAY_PROGRESS_INTERVAL_MS ?? '400')
const MAX_DOWNLOAD_ATTEMPTS = Number(process.env.DSH_V2RAY_MAX_ATTEMPTS ?? '2')
const CHECKSUM_PARALLELISM = Number(process.env.DSH_V2RAY_CHECKSUM_PARALLELISM ?? '5')

const PROJECT_ROOT = resolve(process.cwd())
const TARGET_DIR = join(PROJECT_ROOT, 'installer', 'resources', 'v2ray')

// Download state lives in a stable directory (NOT mkdtemp) so an interrupted
// download can be resumed on the next attempt: the .part file survives the run.
const STATE_DIR = join(TARGET_DIR, '.download')
const PART_PATH = join(STATE_DIR, ZIP_NAME + '.part')
const PART_META_PATH = join(STATE_DIR, ZIP_NAME + '.part.json')
const PARTIAL_TTL_MS = Number(process.env.DSH_V2RAY_PARTIAL_TTL_MS ?? String(7 * 24 * 60 * 60 * 1000))

function fail(message) {
  throw new Error(message)
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function emitProgress(percent, stage, message, details = {}) {
  const safe = Math.max(0, Math.min(100, Math.floor(percent)))
  console.log(`[v2ray-progress] ${JSON.stringify({ percent: safe, stage, message, ...details })}`)
}

/**
 * Download sources, ordered by measured reachability from this machine.
 *
 * The list is deliberately ordered fastest-first and short: every entry was
 * verified on 18.09.2026 to return a real archive (`PK` header, HTTP 206 on a
 * ranged request). Mirrors that answer with an HTML landing page instead of the
 * file are worse than absent — they cost a full round trip and, worse, can pass
 * an "HTTP 200" check while delivering nothing. `ghproxy.com` and `ghps.cc` are
 * removed for exactly that reason; `gitdl.cn` and `hub.gitmirror.com` timed out.
 *
 * `github.com` stays last: it is the canonical origin, useful when reachable.
 */
function buildSources() {
  const fromEnv = process.env.DSH_V2RAY_SOURCES
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return fromEnv.split(',').map(s => normalizeBase(s.trim())).filter(Boolean)
  }

  const releaseDir = `github.com/v2fly/v2ray-core/releases/download/${VERSION}`
  return [
    `https://gh-proxy.com/https://${releaseDir}`,
    `https://gh.llkk.cc/https://${releaseDir}`,
    `https://ghfast.top/https://${releaseDir}`,
    `https://ghproxy.net/https://${releaseDir}`,
    `https://mirror.ghproxy.com/https://${releaseDir}`,
    `https://${releaseDir}`,
  ]
}

/**
 * Sources probed for the checksum. Ordered so that the two mirrors which were
 * observed to serve `.dgst` quickly come first, and `github.com` (canonical,
 * but blocked from some networks for the archive itself) is tried early here
 * because a reachable `.dgst` is enough to get past this stage.
 */
function buildChecksumSources(sources) {
  const canonical = `https://github.com/v2fly/v2ray-core/releases/download/${VERSION}`
  const preferred = [canonical, `https://gh-proxy.com/${canonical}`, `https://gh.llkk.cc/${canonical}`]
  const ordered = [...preferred, ...sources]
  const seen = new Set()
  return ordered.filter((url) => {
    const key = normalizeBase(url)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function isAbortError(error) {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

async function fetchWithIdleTimeout(url, idleTimeoutMs, options = {}) {
  const controller = new AbortController()
  let idleTimer = null
  let timedOut = false

  const touch = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, idleTimeoutMs)
  }

  try {
    touch()
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'dsh-v2ray-bootstrap/1.4',
        accept: '*/*',
        ...(options.headers ?? {}),
      },
    })
    touch()
    return { response, controller, touch, didTimeOut: () => timedOut }
  } catch (error) {
    clearTimeout(idleTimer)
    fail(describeFetchError(error, timedOut))
  }
}

async function fetchText(url, idleTimeoutMs) {
  const { response, touch, didTimeOut } = await fetchWithIdleTimeout(url, idleTimeoutMs)
  try {
    if (!response.ok) fail(`HTTP ${String(response.status)}`)
    touch()
    const bytes = Buffer.from(await response.arrayBuffer())
    touch()
    return bytes.toString('utf8')
  } catch (error) {
    if (isAbortError(error)) fail(describeFetchError(error, didTimeOut()))
    throw error
  }
}

function partialMeta() {
  try {
    if (!existsSync(PART_META_PATH)) return null
    const raw = JSON.parse(readFileSync(PART_META_PATH, 'utf8'))
    if (typeof raw?.url !== 'string' || typeof raw?.loadedBytes !== 'number') return null
    if (typeof raw?.createdAt === 'string' && Date.now() - Date.parse(raw.createdAt) > PARTIAL_TTL_MS) return null
    return raw
  } catch {
    return null
  }
}

function writePartialMeta(meta) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(PART_META_PATH, JSON.stringify(meta, null, 2))
  } catch {}
}

function partialBytesOnDisk() {
  try {
    return existsSync(PART_PATH) ? statSync(PART_PATH).size : 0
  } catch {
    return 0
  }
}

function discardPartial(reason) {
  try {
    if (existsSync(PART_PATH) || existsSync(PART_META_PATH)) {
      console.log(`[v2ray] отбрасываю недокачанный файл: ${reason}`)
    }
  } catch {}
  try { rmSync(PART_PATH, { force: true }) } catch {}
  try { rmSync(PART_META_PATH, { force: true }) } catch {}
}

function truncatePartial(size) {
  try {
    if (!existsSync(PART_PATH)) return
    if (size <= 0) {
      rmSync(PART_PATH, { force: true })
      return
    }
    const fd = openSync(PART_PATH, 'r+')
    try { ftruncateSync(fd, size) } finally { closeSync(fd) }
  } catch {}
}

/**
 * Download the archive to `PART_PATH`, resuming from whatever is already there.
 *
 * Resume is only attempted when the previous attempt recorded the *same* URL,
 * so bytes from two different mirrors are never spliced together. When the
 * server ignores `Range` (status 200 instead of 206) the sink restarts at zero.
 */
async function downloadOnce(url, idleTimeoutMs, onProgress) {
  const name = sourceName(url)
  const existing = partialMeta()
  let resumeFrom = 0
  if (existing !== null && existing.url === url) {
    const onDisk = partialBytesOnDisk()
    if (onDisk > 0 && (existing.totalBytes === 0 || onDisk < existing.totalBytes)) {
      // Trust the smaller of the two: a crash can leave more bytes on disk than
      // were confirmed flushed, and re-fetching a few is cheaper than a corrupt tail.
      resumeFrom = Math.min(onDisk, existing.loadedBytes)
      console.log(`[v2ray] докачиваю ${name} с ${(resumeFrom / 1048576).toFixed(1)} МБ`)
    }
  } else if (existing !== null) {
    console.log(`[v2ray] сохранившийся кусок от другого источника (${sourceName(existing.url)}), начинаю заново`)
    resumeFrom = 0
  }
  if (resumeFrom === 0) truncatePartial(0)

  const headers = resumeFrom > 0 ? { range: `bytes=${String(resumeFrom)}-` } : {}
  const { response, touch, didTimeOut } = await fetchWithIdleTimeout(url, idleTimeoutMs, { headers })

  if (!response.ok && response.status !== 416) fail(`HTTP ${String(response.status)}`)
  if (response.status === 416) fail('сервер отклонил докачку')

  // A mirror that answers with a landing page would otherwise be written to disk
  // as a ~4 KB "archive" and only fail much later, at checksum time. Detect it
  // from the first bytes instead — a real archive always starts with `PK`.
  const contentType = response.headers.get('content-type') ?? ''
  if (resumeFrom === 0 && (contentType.includes('text/html') || contentType.includes('text/plain'))) {
    fail(`отдан не архив (${contentType.split(';')[0] ?? 'unknown'})`)
  }

  if (resumeFrom > 0 && response.status !== 206) {
    console.log(`[v2ray] ${name} не поддерживает докачку, начинаю заново`)
    resumeFrom = 0
    truncatePartial(0)
  }

  let totalBytes = Number(response.headers.get('content-length') ?? '0')
  const contentRange = response.headers.get('content-range')
  if (totalBytes > 0 && resumeFrom > 0) totalBytes += resumeFrom
  else if (typeof contentRange === 'string') {
    const m = /\/(\d+)\s*$/.exec(contentRange)
    if (m !== null) totalBytes = Number(m[1])
  }

  mkdirSync(STATE_DIR, { recursive: true })
  writePartialMeta({ url, loadedBytes: resumeFrom, totalBytes, createdAt: new Date().toISOString() })

  let loadedBytes = resumeFrom
  let lastEmitAt = 0
  const report = (force) => {
    const now = Date.now()
    if (!force && now - lastEmitAt < PROGRESS_UPDATE_INTERVAL_MS) return
    lastEmitAt = now
    onProgress?.(loadedBytes, totalBytes, force === true)
  }

  if (!response.body || typeof response.body.getReader !== 'function') {
    const bytes = Buffer.from(await response.arrayBuffer())
    touch()
    writeFileSync(PART_PATH, bytes)
    loadedBytes = bytes.byteLength
    writePartialMeta({ url, loadedBytes, totalBytes, createdAt: new Date().toISOString() })
    report(true)
    return { loadedBytes, totalBytes }
  }

  const reader = response.body.getReader()
  const sink = createWriteStream(PART_PATH, resumeFrom > 0 ? { flags: 'r+', start: resumeFrom } : { flags: 'w' })

  const pump = (async () => {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      touch()
      loadedBytes += value.byteLength
      report(false)
      if (!sink.write(Buffer.from(value))) {
        await new Promise((resolveDrain) => { sink.once('drain', resolveDrain) })
      }
    }
  })()

  try {
    await pump
    await new Promise((resolveFinish, rejectFinish) => {
      sink.end(() => { resolveFinish() })
      sink.once('error', rejectFinish)
    })
  } catch (error) {
    try { sink.destroy() } catch {}
    try { await reader.cancel() } catch {}
    // Record how much did land, so the next attempt resumes close to the edge.
    const onDisk = partialBytesOnDisk()
    writePartialMeta({ url, loadedBytes: Math.min(loadedBytes, onDisk), totalBytes, createdAt: new Date().toISOString() })
    if (isAbortError(error)) fail(describeFetchError(error, didTimeOut()))
    fail(describeFetchError(error, false))
  }

  loadedBytes = partialBytesOnDisk()
  writePartialMeta({ url, loadedBytes, totalBytes, createdAt: new Date().toISOString() })
  report(true)

  if (totalBytes > 0 && loadedBytes < totalBytes) {
    fail(`файл скачан не полностью (${String(loadedBytes)} из ${String(totalBytes)} байт)`)
  }

  return { loadedBytes, totalBytes }
}

async function downloadZipFromSources(sources) {
  const failures = []
  for (let index = 0; index < sources.length; index += 1) {
    const base = sources[index]
    const name = sourceName(base)
    const url = `${base}/${ZIP_NAME}`

    for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt += 1) {
      try {
        const attemptSuffix = attempt > 1 ? `, попытка ${String(attempt)}` : ''
        emitProgress(16, 'source', `Источник ${String(index + 1)}/${String(sources.length)}: ${name}${attemptSuffix}`)
        const result = await downloadOnce(url, ZIP_IDLE_TIMEOUT_MS, (loadedBytes, totalBytes, force) => {
          emitProgress(
            downloadPercent(loadedBytes, totalBytes),
            'download',
            `Скачиваю V2Ray: ${name}`,
            { loadedBytes, totalBytes, source: name },
          )
          if (force === true) return
        })

        emitProgress(88, 'download', 'Загрузка завершена', {
          loadedBytes: result.loadedBytes,
          totalBytes: result.totalBytes || result.loadedBytes,
          source: name,
        })
        return { bytes: readFileSync(PART_PATH), zipUrl: url, source: name }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        const resumable = partialBytesOnDisk()
        if (attempt < MAX_DOWNLOAD_ATTEMPTS) {
          emitProgress(16, 'source', `Обрыв в ${name} (${reason}), докачиваю`)
          continue
        }
        failures.push(`${name} (${reason})`)
        if (resumable > 0) {
          console.log(`[v2ray] оставляю ${(resumable / 1048576).toFixed(1)} МБ для следующего запуска`)
        }
        emitProgress(16, 'source', `${name} недоступен, переключаюсь на следующий`)
      }
    }
  }

  fail(`all download sources failed for ${ZIP_NAME}: ${failures.join(' ; ')}`)
}

/**
 * Resolve the expected SHA256 by querying many sources **in parallel**.
 *
 * Serial probing was the cause of the reported 8% stall: five mirrors × two
 * candidate files, each waiting out a 20 s idle timeout, is up to 200 s with no
 * progress. Probing in parallel turns the worst case into roughly one timeout.
 *
 * `sha256sums` is listed because `v2fly` publishes it alongside the per-file
 * `.dgst` files; any one of them answering is enough.
 */
async function resolveExpectedSha256(sources) {
  if (typeof process.env.DSH_V2RAY_SHA256 === 'string' && /^[0-9a-f]{64}$/i.test(process.env.DSH_V2RAY_SHA256)) {
    return { sha256: process.env.DSH_V2RAY_SHA256.toLowerCase(), source: 'env:DSH_V2RAY_SHA256' }
  }

  const candidates = []
  for (const base of buildChecksumSources(sources)) {
    const label = sourceName(base)
    candidates.push({ url: `${base}/${ZIP_NAME}.dgst`, label: `${label}:${ZIP_NAME}.dgst` })
    candidates.push({ url: `${base}/sha256sums.txt`, label: `${label}:sha256sums.txt` })
  }

  const total = candidates.length
  const failures = []
  let settled = 0
  let found = null

  emitProgress(8, 'checksum', `Проверяю контрольную сумму (${String(total)} адресов параллельно)`)

  const workers = candidates.map(async (candidate) => {
    if (found !== null) return
    try {
      const text = await fetchText(candidate.url, METADATA_IDLE_TIMEOUT_MS)
      if (found !== null) return
      if (looksLikeHtml(text)) {
        failures.push(`${candidate.label}: отдан не файл суммы`)
        return
      }
      const parsed = parseSha256Line(text, ZIP_NAME)
      if (parsed !== null) {
        found = { sha256: parsed, source: candidate.label }
        return
      }
      failures.push(`${candidate.label}: формат не распознан`)
    } catch (error) {
      failures.push(`${candidate.label}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      settled += 1
      if (found === null) {
        emitProgress(
          Math.min(11, 8 + Math.floor((settled / total) * 3)),
          'checksum',
          `Проверяю контрольную сумму (${String(settled)}/${String(total)})`,
        )
      }
    }
  })

  await Promise.all(workers)

  if (found !== null) return found
  fail(`cannot resolve SHA256 for ${ZIP_NAME}. Tried: ${failures.join(' ; ')}`)
}

function expandZipOnWindows(zipPath, destination) {
  const command = `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destination.replace(/'/g, "''")}' -Force`
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    fail(`Expand-Archive failed: ${result.stderr || result.stdout || `exit ${String(result.status)}`}`)
  }
}

function copyIfExists(source, target) {
  if (!existsSync(source)) return false
  cpSync(source, target)
  return true
}

async function main() {
  if (process.platform !== 'win32') {
    fail('this helper currently supports Windows only')
  }

  mkdirSync(TARGET_DIR, { recursive: true })
  const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-v2ray-'))

  try {
    emitProgress(0, 'start', 'Начинаю установку V2Ray')

    const sources = buildSources()
    console.log(`[v2ray] release: ${VERSION}`)
    console.log(`[v2ray] sources: ${sources.join(', ')}`)

    const resumedBytes = partialBytesOnDisk()
    if (resumedBytes > 0) {
      console.log(`[v2ray] найден недокачанный файл (${(resumedBytes / 1048576).toFixed(1)} МБ), продолжаю`)
    }

    const expected = await resolveExpectedSha256(sources)
    emitProgress(12, 'checksum', 'Контрольная сумма получена')
    console.log(`[v2ray] expected SHA256: ${expected.sha256} (${expected.source})`)

    const downloaded = await downloadZipFromSources(sources)

    emitProgress(90, 'verify', 'Проверяю целостность архива')
    const actualSha256 = sha256Hex(downloaded.bytes)
    if (actualSha256 !== expected.sha256) {
      discardPartial('не сошлась контрольная сумма — файл повреждён')
      fail(`SHA256 mismatch: expected ${expected.sha256}, got ${actualSha256}`)
    }

    const zipPath = join(tempRoot, ZIP_NAME)
    const extractDir = join(tempRoot, 'extract')
    writeFileSync(zipPath, downloaded.bytes)
    mkdirSync(extractDir, { recursive: true })

    emitProgress(94, 'extract', 'Распаковываю архив')
    expandZipOnWindows(zipPath, extractDir)

    const binaryPath = join(extractDir, 'v2ray.exe')
    if (!existsSync(binaryPath)) fail('archive does not contain v2ray.exe')

    cpSync(binaryPath, join(TARGET_DIR, 'v2ray.exe'))
    const copiedGeoIp = copyIfExists(join(extractDir, 'geoip.dat'), join(TARGET_DIR, 'geoip.dat'))
    const copiedGeoSite = copyIfExists(join(extractDir, 'geosite.dat'), join(TARGET_DIR, 'geosite.dat'))

    const manifest = {
      source: 'v2fly/v2ray-core',
      sourceUrl: downloaded.zipUrl,
      sourceMirror: downloaded.source,
      sourceCandidates: sources,
      version: VERSION,
      downloadedAt: new Date().toISOString(),
      checksumSource: expected.source,
      sha256: expected.sha256,
      settings: {
        progressIntervalMs: PROGRESS_UPDATE_INTERVAL_MS,
        metadataIdleTimeoutMs: METADATA_IDLE_TIMEOUT_MS,
        zipIdleTimeoutMs: ZIP_IDLE_TIMEOUT_MS,
        maxDownloadAttempts: MAX_DOWNLOAD_ATTEMPTS,
        checksumParallelism: CHECKSUM_PARALLELISM,
      },
      files: {
        'v2ray.exe': true,
        'geoip.dat': copiedGeoIp,
        'geosite.dat': copiedGeoSite,
      },
    }

    writeFileSync(join(TARGET_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

    // The archive has been verified and unpacked, so the partial no longer serves
    // any purpose; leaving it would silently consume ~20 MB forever.
    discardPartial('установка завершена успешно')

    emitProgress(100, 'done', 'V2Ray установлен')
    console.log('[v2ray] done')
    console.log(`[v2ray] v2ray.exe -> ${join(TARGET_DIR, 'v2ray.exe')}`)
    if (!copiedGeoIp || !copiedGeoSite) {
      console.log('[v2ray] note: one or more *.dat files were absent in the archive')
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

try {
  await main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[v2ray] setup failed: ${message}`)
  process.exitCode = 1
}

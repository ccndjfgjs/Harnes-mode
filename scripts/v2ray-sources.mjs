/**
 * Pure helpers shared by `scripts/setup-v2ray-core.mjs` and its tests.
 *
 * These were extracted so the parsing and ordering rules — the parts that a
 * future edit is most likely to break silently — can be covered without
 * network access or a Windows host. The installer keeps its I/O; this file
 * keeps the decisions.
 */

/** Strip trailing slashes so a base URL can be concatenated safely. */
export function normalizeBase(url) {
  return String(url).replace(/\/+$/, '')
}

/** Human-readable name for a download source, used in progress messages. */
export function sourceName(baseUrl) {
  const known = [
    ['mirror.ghproxy.com', 'mirror.ghproxy.com'],
    ['ghproxy.com', 'ghproxy.com'],
    ['ghproxy.net', 'ghproxy.net'],
    ['gh-proxy.com', 'gh-proxy.com'],
    ['gh.llkk.cc', 'gh.llkk.cc'],
    ['hub.gitmirror.com', 'hub.gitmirror.com'],
    ['gitdl.cn', 'gitdl.cn'],
    ['ghfast.top', 'ghfast.top'],
    ['github.com', 'github.com'],
  ]
  for (const [fragment, label] of known) {
    if (baseUrl.includes(fragment)) return label
  }
  return baseUrl
}

/**
 * Extract a SHA-256 from a v2fly checksum document.
 *
 * v2fly publishes `.dgst` files in OpenSSL's *plain digest list* form, which
 * names the algorithm without a file name:
 *
 *     MD5= bd4da003…
 *     SHA1= 65a4fd12…
 *     SHA2-256= 46ee170d…
 *
 * The `SHA2-256` label is the one that matters, and it is easy to miss: the
 * earlier implementation only understood `SHA256(<file>)= …`, so every source
 * reported "формат не распознан" and the whole install died asking for a
 * checksum that was in fact being served. Keep all three shapes supported.
 */
export function parseSha256Line(text, expectedFileName) {
  const source = String(text)
  const escaped = String(expectedFileName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const opensslByFile = new RegExp(`SHA256\\s*\\(${escaped}\\)\\s*=\\s*([0-9a-f]{64})`, 'i').exec(source)
  if (opensslByFile !== null) return opensslByFile[1].toLowerCase()

  // `Release.dgst` lists a digest for *every* asset in the release. Accepting
  // "any SHA-256 in the file" would happily return the checksum of, say,
  // `v2ray-linux-64.zip` and then reject the correctly-downloaded Windows
  // archive at verification time — a confusing failure blamed on the network.
  // A bare digest is therefore only trusted when no file name appears at all.
  const namesAFile = /\b[a-z0-9][a-z0-9._-]*\.(zip|tar|gz|xz)\b/i.test(source)
  if (!namesAFile) {
    const digestList = /^\s*SHA2-256\s*=\s*([0-9a-f]{64})\s*$/im.exec(source)
    if (digestList !== null) return digestList[1].toLowerCase()

    const legacyLabel = /^\s*SHA256\s*=\s*([0-9a-f]{64})\s*$/im.exec(source)
    if (legacyLabel !== null) return legacyLabel[1].toLowerCase()
  }

  const sumStyle = source
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => /[0-9a-f]{64}/i.test(line) && line.includes(expectedFileName))
  if (sumStyle !== undefined) {
    const m = /^([0-9a-f]{64})\s+\*?\S+$/i.exec(sumStyle)
    if (m !== null) return m[1].toLowerCase()
  }

  return null
}

/**
 * Detect a mirror that answered with a web page instead of a file.
 *
 * `ghproxy.com` returns an HTML landing page with HTTP 200 for archive requests.
 * Without this check the page is written to disk as a few kilobytes of "archive"
 * and only fails much later, at checksum time — after a full wasted round trip.
 */
export function looksLikeHtml(text) {
  const head = String(text).slice(0, 400).trimStart().toLowerCase()
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.includes('<head>')
}

/** Map downloaded bytes onto the 18–88% band reserved for the transfer stage. */
export function downloadPercent(loadedBytes, totalBytes) {
  if (totalBytes > 0) return 18 + Math.min(70, Math.floor((loadedBytes / totalBytes) * 70))
  return Math.min(87, 18 + Math.floor(loadedBytes / (1024 * 1024)))
}

/**
 * Turn a failed fetch into a sentence a person can act on.
 *
 * Node's undici reports every transport problem as the same opaque
 * "fetch failed"; the cause carries the actual reason. Surfacing it matters
 * because "нет ответа (таймаут)" and "адрес не найден" call for different
 * responses from whoever is reading the screen.
 */
export function describeFetchError(error, timedOut) {
  if (timedOut === true) return 'нет ответа (таймаут)'
  if (!(error instanceof Error)) return String(error)
  const cause = error.cause
  if (cause instanceof Error && typeof cause.message === 'string' && cause.message !== '') {
    if (cause.code === 'ENOTFOUND') return 'адрес не найден'
    if (cause.code === 'ECONNREFUSED') return 'соединение отклонено'
    if (cause.code === 'ECONNRESET' || cause.code === 'UND_ERR_SOCKET') return 'соединение разорвано'
    if (cause.code === 'ETIMEDOUT') return 'нет ответа (таймаут)'
    return cause.message
  }
  return error.message
}

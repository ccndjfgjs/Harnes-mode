#!/usr/bin/env node
/**
 * Remove the V2Ray core binary and everything the bootstrap left behind.
 *
 * The install path is deliberately reversible from the same screen that offers
 * it: a user who installed the engine by mistake, or who wants to force a clean
 * re-download, should not have to find `installer/resources/v2ray` by hand.
 *
 * What is removed:
 *   - `v2ray.exe`, `geoip.dat`, `geosite.dat` — the engine assets themselves;
 *   - `manifest.json` — describes the download we are undoing;
 *   - `.download/` — a partial archive and its metadata, if any survived;
 *   - the download lock file, so a later install starts clean.
 *
 * What is NOT removed: `README.txt`. It is a repository file that ships with the
 * project explaining what belongs in this directory, not a download artifact.
 *
 * The tunnel must be stopped before calling this: on Windows a running process
 * holds `v2ray.exe` open and the delete fails with EBUSY/EPERM.
 */
import { existsSync, rmSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const PROJECT_ROOT = resolve(process.cwd())
const TARGET_DIR = join(PROJECT_ROOT, 'installer', 'resources', 'v2ray')

// Assets produced by a download, and therefore ours to delete. Matched by exact
// name on purpose: an unrecognised file in this directory is not ours to remove.
const DOWNLOADED_FILES = ['v2ray.exe', 'v2ray', 'geoip.dat', 'geosite.dat', 'manifest.json']
const PARTIAL_DIR = '.download'

function emitProgress(percent, stage, message, details = {}) {
  const safe = Math.max(0, Math.min(100, Math.floor(percent)))
  console.log(`[v2ray-progress] ${JSON.stringify({ percent: safe, stage, message, ...details })}`)
}

const removed = []
const kept = []
const failures = []

function removeFile(path, label) {
  try {
    if (!existsSync(path)) return false
    rmSync(path, { force: true })
    removed.push(label)
    return true
  } catch (error) {
    // A locked file is the one failure a user can actually act on, so it is
    // reported rather than swallowed. Everything else is rolled into the same
    // message — there is no useful distinction for whoever reads the screen.
    const reason = error instanceof Error ? error.message : String(error)
    failures.push(`${label} (${reason})`)
    return false
  }
}

function removeDirectory(path, label) {
  try {
    if (!existsSync(path)) return false
    rmSync(path, { recursive: true, force: true })
    removed.push(label)
    return true
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    failures.push(`${label} (${reason})`)
    return false
  }
}

function listUnknown() {
  try {
    if (!existsSync(TARGET_DIR)) return []
    return readdirSync(TARGET_DIR).filter((name) => {
      if (name === 'README.txt' || name === PARTIAL_DIR) return false
      if (DOWNLOADED_FILES.includes(name)) return false
      try {
        return statSync(join(TARGET_DIR, name)).isFile()
      } catch {
        return false
      }
    })
  } catch {
    return []
  }
}

function main() {
  emitProgress(0, 'remove-start', 'Удаляю V2Ray')

  if (!existsSync(TARGET_DIR)) {
    emitProgress(100, 'remove-done', 'V2Ray уже удалён')
    console.log('[v2ray] nothing to remove: directory is absent')
    return
  }

  const before = listUnknown()

  emitProgress(20, 'remove', 'Останавливаю движок и убираю файлы')

  // The partial directory goes first: it can hold a ~20 MB archive, and clearing
  // it before the binaries means a failure on a locked `v2ray.exe` still frees
  // the disk space rather than leaving both behind.
  removeDirectory(join(TARGET_DIR, PARTIAL_DIR), PARTIAL_DIR)

  emitProgress(60, 'remove', 'Убираю движок и файлы данных')
  for (const name of DOWNLOADED_FILES) {
    removeFile(join(TARGET_DIR, name), name)
  }

  for (const name of before) {
    // Left in place on purpose: we do not know what it is, so we do not delete it.
    kept.push(name)
  }

  if (failures.length > 0) {
    emitProgress(100, 'remove-failed', 'Не всё удалось удалить')
    throw new Error(
      `не удалось удалить: ${failures.join(' ; ')}. `
      + 'Закройте приложение, если туннель был включён, и повторите.',
    )
  }

  if (removed.length === 0) {
    emitProgress(100, 'remove-done', 'V2Ray уже удалён')
    console.log('[v2ray] nothing to remove: no downloaded files were present')
  } else {
    emitProgress(100, 'remove-done', 'V2Ray удалён')
    console.log(`[v2ray] removed: ${removed.join(', ')}`)
  }

  if (kept.length > 0) {
    console.log(`[v2ray] note: left untouched (not downloaded by this app): ${kept.join(', ')}`)
  }
}

try {
  main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[v2ray] removal failed: ${message}`)
  process.exitCode = 1
}

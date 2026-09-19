#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const PROJECT_ROOT = resolve(process.cwd())
const V2RAY_BINARY = join(PROJECT_ROOT, 'installer', 'resources', 'v2ray', 'v2ray.exe')
const REQUIRED = process.argv.includes('--required')

function runSetup() {
  const result = spawnSync(process.execPath, [join(PROJECT_ROOT, 'scripts', 'setup-v2ray-core.mjs')], {
    stdio: 'inherit',
    env: process.env,
  })
  return result.status === 0
}

if (existsSync(V2RAY_BINARY)) {
  console.log(`[v2ray] already present: ${V2RAY_BINARY}`)
  process.exit(0)
}

console.log('[v2ray] core binary is missing; trying automatic setup...')
const ok = runSetup()

if (ok && existsSync(V2RAY_BINARY)) {
  console.log(`[v2ray] ready: ${V2RAY_BINARY}`)
  process.exit(0)
}

const message = [
  '[v2ray] automatic setup did not complete.',
  `[v2ray] expected file: ${V2RAY_BINARY}`,
  '[v2ray] retry manually: npm run setup:v2ray-core',
].join('\n')

if (REQUIRED) {
  console.error(message)
  process.exit(1)
}

console.warn(message)
process.exit(0)

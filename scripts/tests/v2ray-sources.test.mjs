/**
 * Tests for the V2Ray bootstrap's decision logic.
 *
 * These cover the rules that fail *silently* in production — a checksum format
 * that is not understood reads as "no source works", and a mirror that answers
 * with a landing page looks like a successful download. Neither throws where a
 * casual glance would catch it, so they are pinned here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeBase,
  sourceName,
  parseSha256Line,
  looksLikeHtml,
  downloadPercent,
  describeFetchError,
} from '../v2ray-sources.mjs'

// A real `.dgst` body as served by gh-proxy.com for v2ray-windows-64.zip.
const REAL_DGST = [
  'MD5= bd4da003dd4a4ae8f24fcda2f6f9868d',
  'SHA1= 65a4fd1293182d9f8e13cd0d60c9881c8f7bb947',
  'SHA2-256= 46ee170d031ea3be79cc583e61e6335a612e4c87925deed2a7179b0a5fb79f60',
  'SHA2-512= 49ee335668896acafff5c4bc5d0b06642f5b010bcdfd339f9e6cc415eafa90e201113ba82fbe23d6747c9a101400f2771d4f9e5878605e8c3231552f3f97d649',
  '',
].join('\n')

const EXPECTED = '46ee170d031ea3be79cc583e61e6335a612e4c87925deed2a7179b0a5fb79f60'
const ZIP = 'v2ray-windows-64.zip'

test('the real v2fly .dgst format is understood', () => {
  // This is the shape that broke the installer: OpenSSL's plain digest list,
  // with `SHA2-256` rather than `SHA256(...)`. Every mirror served it, and the
  // old parser rejected all of them.
  assert.equal(parseSha256Line(REAL_DGST, ZIP), EXPECTED)
})

test('the older OpenSSL by-file form still parses', () => {
  const text = `SHA256(${ZIP})= ${EXPECTED}\n`
  assert.equal(parseSha256Line(text, ZIP), EXPECTED)
})

test('a bare SHA256 label parses', () => {
  assert.equal(parseSha256Line(`SHA256= ${EXPECTED}\n`, ZIP), EXPECTED)
})

test('the coreutils two-column form parses', () => {
  assert.equal(parseSha256Line(`${EXPECTED}  ${ZIP}\n`, ZIP), EXPECTED)
  assert.equal(parseSha256Line(`${EXPECTED} *${ZIP}\n`, ZIP), EXPECTED)
})

test('the MD5 and SHA1 lines are never mistaken for the SHA-256', () => {
  // A 32-hex or 40-hex digest must not be padded, truncated, or returned.
  const parsed = parseSha256Line(REAL_DGST, ZIP)
  assert.equal(parsed.length, 64)
  assert.notEqual(parsed, 'bd4da003dd4a4ae8f24fcda2f6f9868d')
  assert.notEqual(parsed, '65a4fd1293182d9f8e13cd0d60c9881c8f7bb947')
})

test('a document with no SHA-256 returns null rather than guessing', () => {
  assert.equal(parseSha256Line('MD5= bd4da003dd4a4ae8f24fcda2f6f9868d\n', ZIP), null)
  assert.equal(parseSha256Line('not a checksum at all', ZIP), null)
  assert.equal(parseSha256Line('', ZIP), null)
})

test('a checksum file for a different archive is not accepted', () => {
  const other = 'a'.repeat(64)
  assert.equal(parseSha256Line(`SHA256(v2ray-linux-64.zip)= ${other}\n`, ZIP), null)
})

test('mirror landing pages are recognised as not-a-file', () => {
  // ghproxy.com answers archive requests with this, at HTTP 200.
  const landingPage = '<!DOCTYPE html>\n<html lang=""><head><title>GitHub Proxy</title>'
  assert.equal(looksLikeHtml(landingPage), true)
  assert.equal(looksLikeHtml('  <html><head></head></html>'), true)
  assert.equal(looksLikeHtml('   <!doctype html><html'), true)
})

test('a real archive or checksum body is not mistaken for a landing page', () => {
  assert.equal(looksLikeHtml('PK\u0003\u0004\u0014\u0000'), false)
  assert.equal(looksLikeHtml(REAL_DGST), false)
})

test('source names are short labels, not URLs', () => {
  const base = 'https://gh-proxy.com/https://github.com/v2fly/v2ray-core/releases/download/v5.53.0'
  assert.equal(sourceName(base), 'gh-proxy.com')
  assert.equal(sourceName('https://gh.llkk.cc/https://github.com/x/y'), 'gh.llkk.cc')
  assert.equal(sourceName('https://github.com/v2fly/v2ray-core/releases/download/v5.53.0'), 'github.com')
  // An unrecognised mirror falls back to its own URL, which is still readable.
  assert.equal(sourceName('https://example.test/gh'), 'https://example.test/gh')
})

test('ghproxy.com and gh.llkk.cc are not confused', () => {
  // `ghproxy.com` is a substring of nothing here, but `gh.llkk.cc` and
  // `mirror.ghproxy.com` both contain fragments that must win over `ghproxy.com`.
  assert.equal(sourceName('https://mirror.ghproxy.com/x'), 'mirror.ghproxy.com')
  assert.equal(sourceName('https://ghproxy.net/x'), 'ghproxy.net')
})

test('trailing slashes are trimmed so URLs concatenate cleanly', () => {
  assert.equal(normalizeBase('https://example.test/gh/'), 'https://example.test/gh')
  assert.equal(normalizeBase('https://example.test/gh///'), 'https://example.test/gh')
  assert.equal(normalizeBase('https://example.test/gh'), 'https://example.test/gh')
})

test('progress stays inside the band reserved for downloading', () => {
  const total = 19363950
  assert.equal(downloadPercent(0, total), 18)
  assert.equal(downloadPercent(total, total), 88)
  // Never reaches the verify (90) or extract (94) stages, which have their own.
  assert.ok(downloadPercent(total, total) < 90)
})

test('a mirror without a length still produces a rising progress figure', () => {
  const oneMb = 1024 * 1024
  assert.equal(downloadPercent(oneMb, 0), 19)
  assert.equal(downloadPercent(5 * oneMb, 0), 23)
  // Capped short of the verify stage so the bar cannot run away.
  assert.equal(downloadPercent(500 * oneMb, 0), 87)
})

test('progress never exceeds 100 or goes below zero', () => {
  assert.ok(downloadPercent(19363950 * 2, 19363950) <= 100)
  assert.ok(downloadPercent(0, 0) >= 0)
})

test('a timeout is reported in words, not as an abort code', () => {
  const aborted = new Error('This operation was aborted')
  aborted.name = 'AbortError'
  assert.equal(describeFetchError(aborted, true), 'нет ответа (таймаут)')
})

test('the underlying reason of an opaque "fetch failed" is surfaced', () => {
  // Node's undici collapses every transport problem into "fetch failed" and
  // hides the cause. "адрес не найден" and "соединение разорвано" call for
  // different reactions from whoever reads the message.
  const dns = new Error('fetch failed')
  dns.cause = Object.assign(new Error('getaddrinfo ENOTFOUND mirror.test'), { code: 'ENOTFOUND' })
  assert.equal(describeFetchError(dns, false), 'адрес не найден')

  const refused = new Error('fetch failed')
  refused.cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
  assert.equal(describeFetchError(refused, false), 'соединение отклонено')

  const reset = new Error('fetch failed')
  reset.cause = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
  assert.equal(describeFetchError(reset, false), 'соединение разорвано')
})

test('an error with no cause still yields a usable message', () => {
  assert.equal(describeFetchError(new Error('HTTP 404'), false), 'HTTP 404')
  assert.equal(describeFetchError('plain string', false), 'plain string')
})

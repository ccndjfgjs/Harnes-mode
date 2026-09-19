const { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { createHash } = require('node:crypto')
const { spawn } = require('node:child_process')

const DEFAULT_SOCKS_PORT = 10808
const DEFAULT_HTTP_PORT = 10809
const SUPPORTED_PROTOCOLS = ['vless', 'vmess', 'trojan', 'shadowsocks']
const SETTINGS_FILE = 'v2ray.settings.json'
const SUBSCRIPTION_MAX_BYTES = 2 * 1024 * 1024
const HTTP_TEST_MAX_BYTES = 64 * 1024
const STOP_GRACE_MS = 3000
const STOP_KILL_MS = 3000
const SECRET_FIELDS = ['uuid', 'password', 'publicKey']
const EMPTY_SETTINGS = Object.freeze({
  enabled: false,
  subscriptionUrl: '',
  servers: [],
  activeId: '',
  socksPort: DEFAULT_SOCKS_PORT,
  httpPort: DEFAULT_HTTP_PORT,
})

function hasControlChars(value) {
  return typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)
}

function validText(value, maxLength, { allowEmpty = true, pattern } = {}) {
  if (typeof value !== 'string' || value.length > maxLength || hasControlChars(value)) return false
  if (!allowEmpty && value.length === 0) return false
  return pattern ? pattern.test(value) : true
}

function validHost(value) {
  if (!validText(value, 253, { allowEmpty: false }) || /\s/.test(value)) return false
  const unbracketed = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
  if (net.isIP(unbracketed)) return true
  if (value.includes(':') || value.startsWith('[') || value.endsWith(']')) return false
  const labels = value.split('.')
  return labels.every(label => label.length > 0 && label.length <= 63
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label))
}

function validPort(value) {
  if (value === '' || value === null || value === undefined) return false
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port <= 65535
}

function validUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

function validPortPair(socksPort, httpPort) {
  return validPort(socksPort) && validPort(httpPort) && Number(socksPort) !== Number(httpPort)
}

function validateOptionalServerFields(server) {
  const checks = [
    ['wsHost', 253, value => value === '' || validHost(value)],
    ['wsPath', 2048, value => value === '' || value.startsWith('/')],
    ['serverName', 253, value => value === '' || validHost(value)],
    ['fingerprint', 64, value => value === '' || /^[A-Za-z0-9._-]+$/.test(value)],
    ['publicKey', 512, () => true],
    ['shortId', 32, value => value === '' || /^[0-9a-f]+$/i.test(value)],
    ['flow', 64, value => value === '' || /^[A-Za-z0-9._-]+$/.test(value)],
  ]
  for (const [field, limit, predicate] of checks) {
    const value = server[field]
    if (value === undefined) continue
    if (!validText(value, limit) || !predicate(value)) throw new Error(`Недопустимое поле ${field}`)
  }
}

function safeUnlink(filePath) {
  try { unlinkSync(filePath) } catch (error) { if (error?.code !== 'ENOENT') throw error }
}

/**
 * Locate the V2Ray core binary.
 *
 * The binary is never downloaded at runtime: packaging ships a reviewed artifact
 * and the README beside it says so, so a missing file is a configuration error the
 * caller reports, not something to fetch.
 *
 * @param root - the repository or packaged-app root.
 * @returns the first candidate path, which the caller tests for existence.
 */
function resolveBinary(root) {
  const name = process.platform === 'win32' ? 'v2ray.exe' : 'v2ray'
  const candidates = [
    process.env.DSH_V2RAY_BINARY,
    process.resourcesPath ? path.join(process.resourcesPath, 'v2ray', name) : undefined,
    path.join(root, 'installer', 'resources', 'v2ray', name),
    path.join(root, 'resources', 'v2ray', name),
  ].filter(Boolean)
  return candidates.find(candidate => existsSync(candidate)) || candidates[0]
}

/**
 * Decode base64 that may be URL-safe, unpadded, or wrapped in whitespace.
 * @param value - the encoded text.
 * @returns the decoded UTF-8 text, or null when it is not decodable.
 */
function decodeBase64Loose(value) {
  if (typeof value !== 'string') return null
  const cleaned = value.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
  if (cleaned === '') return null
  const padded = cleaned + '='.repeat((4 - (cleaned.length % 4)) % 4)
  try {
    const text = Buffer.from(padded, 'base64').toString('utf8')
    // A decode of non-base64 input yields replacement characters; treat that as failure
    // so a plain-text subscription body is not mistaken for an encoded one.
    return text.includes('\uFFFD') ? null : text
  } catch { return null }
}

/**
 * Read one query value, preferring the first occurrence.
 * @param params - the parsed query.
 * @param name - parameter name.
 * @returns the value, or an empty string.
 */
function queryValue(params, name) {
  const value = params.get(name)
  return value === null ? '' : value
}

/**
 * Stable identifier for a server entry, so the same link keeps the same selection
 * across imports. Built from the fields that make the endpoint unique.
 *
 * The secret is folded through a hash rather than embedded: the id reaches the
 * settings page and the launcher list, and a truncated password there would be a
 * leak, not a label.
 *
 * @param server - a parsed server entry.
 * @returns the identifier.
 */
function serverId(server) {
  const secret = server.uuid || server.password || ''
  const digest = createHash('sha256').update(String(secret)).digest('hex').slice(0, 16)
  return `${server.protocol}-${server.host}-${server.remotePort}-${digest}`
}

/**
 * Parse one share link into a server entry.
 *
 * Handles the `vless://`, `vmess://`, `trojan://`, and `ss://` forms that
 * subscription lists carry. Anything else returns null rather than throwing, so a
 * mixed list keeps its usable entries.
 *
 * @param line - one line of a subscription or a single pasted link.
 * @returns a normalized server entry, or null when the line is not a supported link.
 */
function parseShareLink(line) {
  if (typeof line !== 'string') return null
  const text = line.trim()
  if (text === '' || text.startsWith('#')) return null
  const scheme = text.slice(0, text.indexOf('://')).toLowerCase()
  if (!SUPPORTED_PROTOCOLS.includes(scheme === 'ss' ? 'shadowsocks' : scheme)) return null

  try {
    if (text.startsWith('vmess://')) return parseVmessLink(text)
    if (text.startsWith('ss://')) return parseShadowsocksLink(text)
    return parseUrlLink(text)
  } catch { return null }
}

/**
 * Parse the `vless://` and `trojan://` forms, which share a URL shape.
 * @param text - the link.
 * @returns a server entry, or null when the link is incomplete.
 */
function parseUrlLink(text) {
  const url = new URL(text)
  const protocol = url.protocol.replace(':', '')
  const host = url.hostname
  const remotePort = Number(url.port || (protocol === 'trojan' ? 443 : 443))
  if (!validHost(host) || !validPort(remotePort)) return null
  const params = url.searchParams
  const security = queryValue(params, 'security').toLowerCase()
  const server = {
    protocol,
    host,
    remotePort,
    name: decodeURIComponent(url.hash.replace(/^#/, '')) || `${host}:${remotePort}`,
    transport: (queryValue(params, 'type') || 'tcp').toLowerCase(),
    security: security === 'reality' ? 'reality' : (security === 'tls' || security === 'xtls' ? 'tls' : 'none'),
    serverName: queryValue(params, 'sni') || queryValue(params, 'host') || host,
    wsPath: queryValue(params, 'path') || '/',
    wsHost: queryValue(params, 'host'),
    fingerprint: queryValue(params, 'fp'),
    publicKey: queryValue(params, 'pbk'),
    shortId: queryValue(params, 'sid'),
    spiderX: queryValue(params, 'spx'),
    flow: queryValue(params, 'flow'),
  }
  if (protocol === 'vless') {
    server.uuid = decodeURIComponent(url.username)
    if (!validUuid(server.uuid)) return null
  } else {
    server.password = decodeURIComponent(url.username || url.password)
    if (!validText(server.password, 1024, { allowEmpty: false })) return null
  }
  validateOptionalServerFields(server)
  server.id = serverId(server)
  return server
}

/**
 * Parse the `vmess://` form, whose payload is a base64 JSON object.
 * @param text - the link.
 * @returns a server entry, or null when the payload is unusable.
 */
function parseVmessLink(text) {
  const decoded = decodeBase64Loose(text.slice('vmess://'.length))
  if (decoded === null) return null
  const payload = JSON.parse(decoded)
  const host = String(payload.add || '')
  const remotePort = Number(payload.port)
  const uuid = String(payload.id || '')
  if (!validHost(host) || !validPort(remotePort) || !validUuid(uuid)) return null
  const tls = String(payload.tls || '').toLowerCase() === 'tls'
  const server = {
    protocol: 'vmess',
    host,
    remotePort,
    uuid,
    alterId: Number(payload.aid || 0),
    name: String(payload.ps || `${host}:${remotePort}`),
    transport: String(payload.net || 'tcp').toLowerCase(),
    security: tls ? 'tls' : 'none',
    serverName: String(payload.sni || payload.host || host),
    wsPath: String(payload.path || '/'),
    wsHost: String(payload.host || ''),
  }
  validateOptionalServerFields(server)
  server.id = serverId(server)
  return server
}

/**
 * Parse the `ss://` form, in both the legacy all-in-one and the URL shapes.
 * @param text - the link.
 * @returns a server entry, or null when the link is unusable.
 */
function parseShadowsocksLink(text) {
  const body = text.slice('ss://'.length)
  const hashIndex = body.indexOf('#')
  const name = hashIndex === -1 ? '' : decodeURIComponent(body.slice(hashIndex + 1))
  const withoutHash = hashIndex === -1 ? body : body.slice(0, hashIndex)
  let method = ''
  let password = ''
  let host = ''
  let port = 0
  if (withoutHash.includes('@')) {
    // URL shape: ss://base64(method:password)@host:port
    const at = withoutHash.lastIndexOf('@')
    const credentials = decodeBase64Loose(withoutHash.slice(0, at)) ?? ''
    const separator = credentials.indexOf(':')
    if (separator === -1) return null
    method = credentials.slice(0, separator)
    password = credentials.slice(separator + 1)
    const authority = withoutHash.slice(at + 1)
    const colon = authority.lastIndexOf(':')
    if (colon === -1) return null
    host = authority.slice(0, colon)
    port = Number(authority.slice(colon + 1))
  } else {
    // Legacy shape: ss://base64(method:password@host:port)
    const decoded = decodeBase64Loose(withoutHash)
    if (decoded === null) return null
    const at = decoded.lastIndexOf('@')
    const credentials = at === -1 ? '' : decoded.slice(0, at)
    const authority = at === -1 ? decoded : decoded.slice(at + 1)
    const separator = credentials.indexOf(':')
    const colon = authority.lastIndexOf(':')
    if (separator === -1 || colon === -1) return null
    method = credentials.slice(0, separator)
    password = credentials.slice(separator + 1)
    host = authority.slice(0, colon)
    port = Number(authority.slice(colon + 1))
  }
  if (!validHost(host) || !validPort(port) || method === '' || password === '') return null
  const server = {
    protocol: 'shadowsocks',
    host,
    remotePort: port,
    method,
    password,
    name: name || `${host}:${port}`,
    transport: 'tcp',
    security: 'none',
  }
  server.id = serverId(server)
  return server
}

/**
 * Parse a subscription body into server entries.
 *
 * Accepts both the encoded form (the whole body is base64) and the plain form
 * (one link per line), because providers ship either.
 *
 * @param body - the subscription response body.
 * @returns the parsed servers, in list order.
 */
function parseSubscription(body) {
  if (typeof body !== 'string' || body.trim() === '') return []
  // Providers ship either one link per line or the whole body base64-encoded, and
  // the two are told apart by whether a scheme is already visible. Decoding a body
  // that already carries links would destroy them, so the decode is only tried when
  // no scheme is present.
  let text = body
  if (!body.includes('://')) {
    const decoded = decodeBase64Loose(body)
    if (decoded !== null) text = decoded
  }
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
  const servers = []
  for (const line of lines) {
    const server = parseShareLink(line)
    if (server !== null) servers.push(server)
  }
  return servers
}

/**
 * Build the streamSettings block shared by every outbound.
 * @param server - a parsed server entry.
 * @returns the streamSettings object.
 */
function buildStreamSettings(server) {
  const streamSettings = { network: server.transport || 'tcp', security: server.security || 'none' }
  if (streamSettings.security === 'tls') {
    streamSettings.tlsSettings = {
      serverName: server.serverName || server.host,
      allowInsecure: Boolean(server.allowInsecure),
      ...(server.fingerprint ? { fingerprint: server.fingerprint } : {}),
    }
  }
  if (streamSettings.security === 'reality') {
    streamSettings.realitySettings = {
      serverName: server.serverName || server.host,
      fingerprint: server.fingerprint || 'chrome',
      publicKey: server.publicKey || '',
      shortId: server.shortId || '',
      spiderX: server.spiderX || '/',
    }
  }
  if (streamSettings.network === 'ws') {
    streamSettings.wsSettings = {
      path: server.wsPath || '/',
      headers: server.wsHost ? { Host: server.wsHost } : {},
    }
  }
  if (streamSettings.network === 'grpc') {
    streamSettings.grpcSettings = { serviceName: server.wsPath || '' }
  }
  return streamSettings
}

/**
 * Build the V2Ray outbound for one server.
 * @param server - a parsed server entry.
 * @returns the outbound object.
 */
function buildOutbound(server) {
  const streamSettings = buildStreamSettings(server)
  if (server.protocol === 'vless') {
    return {
      tag: 'proxy',
      protocol: 'vless',
      settings: {
        vnext: [{
          address: server.host,
          port: server.remotePort,
          users: [{ id: server.uuid, encryption: 'none', ...(server.flow ? { flow: server.flow } : {}) }],
        }],
      },
      streamSettings,
    }
  }
  if (server.protocol === 'vmess') {
    return {
      tag: 'proxy',
      protocol: 'vmess',
      settings: {
        vnext: [{
          address: server.host,
          port: server.remotePort,
          users: [{ id: server.uuid, alterId: Number(server.alterId || 0), security: 'auto' }],
        }],
      },
      streamSettings,
    }
  }
  if (server.protocol === 'trojan') {
    return {
      tag: 'proxy',
      protocol: 'trojan',
      settings: { servers: [{ address: server.host, port: server.remotePort, password: server.password }] },
      streamSettings,
    }
  }
  if (server.protocol === 'shadowsocks') {
    return {
      tag: 'proxy',
      protocol: 'shadowsocks',
      settings: {
        servers: [{ address: server.host, port: server.remotePort, method: server.method, password: server.password }],
      },
      streamSettings,
    }
  }
  throw new Error(`Протокол «${server.protocol}» не поддерживается`)
}

/**
 * Build a complete V2Ray configuration for one server.
 *
 * Both inbounds bind loopback only. The HTTP inbound exists for the Harness
 * (see the module header); the SOCKS inbound is what the tunnel self-test speaks.
 *
 * @param input - the server entry plus the two local ports.
 * @returns the configuration object to write to disk.
 */
function createV2RayConfig(input) {
  const server = sanitizeServer(input.server ?? input)
  const socksPort = Number(input.socksPort ?? input.localPort ?? DEFAULT_SOCKS_PORT)
  const httpPort = Number(input.httpPort ?? DEFAULT_HTTP_PORT)
  if (!validPortPair(socksPort, httpPort)) throw new Error('Проверьте локальные порты: нужны два разных свободных порта')
  if (!validHost(server.host) || !validPort(server.remotePort)) throw new Error('Проверьте адрес сервера и порт')
  validateOptionalServerFields(server)
  if (!SUPPORTED_PROTOCOLS.includes(server.protocol)) throw new Error(`Протокол «${server.protocol}» не поддерживается`)
  if (server.protocol === 'vless' && !validUuid(server.uuid)) throw new Error('Проверьте UUID VLESS')
  if (server.protocol === 'vmess' && !validUuid(server.uuid)) throw new Error('Проверьте UUID VMess')
  if ((server.protocol === 'trojan' || server.protocol === 'shadowsocks') && !server.password) {
    throw new Error('Проверьте пароль сервера')
  }
  return {
    log: { loglevel: 'warning' },
    inbounds: [
      { tag: 'socks-in', listen: '127.0.0.1', port: socksPort, protocol: 'socks', settings: { udp: true } },
      { tag: 'http-in', listen: '127.0.0.1', port: httpPort, protocol: 'http', settings: { allowTransparent: false } },
    ],
    outbounds: [
      buildOutbound(server),
      { tag: 'direct', protocol: 'freedom' },
      { tag: 'blocked', protocol: 'blackhole' },
    ],
    routing: { domainStrategy: 'AsIs', rules: [{ type: 'field', network: 'tcp,udp', outboundTag: 'proxy' }] },
  }
}

/**
 * Build a configuration from the launcher's flat field set. Kept because the
 * launcher window and its tests speak this shape; it normalizes into the server
 * entry {@link createV2RayConfig} consumes.
 *
 * @param input - flat fields: host, remotePort, uuid, transport, security, …
 * @returns the configuration object.
 */
function createVlessConfig(input) {
  const server = {
    protocol: 'vless',
    host: String(input.host || '').trim(),
    remotePort: Number(input.remotePort),
    uuid: String(input.uuid || '').trim(),
    transport: input.transport === 'ws' ? 'ws' : (input.transport === 'grpc' ? 'grpc' : 'tcp'),
    security: input.security === 'tls' ? 'tls' : (input.security === 'reality' ? 'reality' : 'none'),
    serverName: String(input.serverName || input.host || '').trim(),
    wsPath: String(input.wsPath || '/').trim() || '/',
    wsHost: String(input.wsHost || '').trim(),
    fingerprint: String(input.fingerprint || '').trim(),
    publicKey: String(input.publicKey || '').trim(),
    shortId: String(input.shortId || '').trim(),
    flow: String(input.flow || '').trim(),
  }
  if (!validHost(server.host) || !validPort(server.remotePort) || !validUuid(server.uuid)) {
    throw new Error('Проверьте адрес сервера, удалённый порт и UUID VLESS')
  }
  return createV2RayConfig({
    server,
    socksPort: Number(input.localPort ?? DEFAULT_SOCKS_PORT),
    httpPort: Number(input.httpPort ?? DEFAULT_HTTP_PORT),
  })
}

function validateSubscriptionUrl(value) {
  let parsed
  try { parsed = new URL(String(value)) } catch { throw new Error('Ссылка на список серверов не похожа на адрес') }
  if (parsed.username || parsed.password) throw new Error('Ссылка на список серверов не должна содержать учётные данные')
  if (parsed.hash) throw new Error('Ссылка на список серверов не должна содержать фрагмент')
  const urlHost = parsed.hostname.startsWith('[') ? parsed.hostname.slice(1, -1) : parsed.hostname
  const loopback = urlHost === 'localhost' || urlHost === '127.0.0.1' || urlHost === '::1'
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error('Ссылка должна использовать HTTPS; HTTP разрешён только для loopback')
  }
  return parsed
}

async function readLimitedResponse(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`Ответ списка серверов больше ${maxBytes} байт`)
  if (!response.body?.getReader) {
    const text = await response.text()
    if (Buffer.byteLength(text) > maxBytes) throw new Error(`Ответ списка серверов больше ${maxBytes} байт`)
    return text
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new Error(`Ответ списка серверов больше ${maxBytes} байт`)
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock?.()
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

/** Download a bounded subscription after validating every redirect. */
async function fetchSubscription(url, timeoutMs = 15000, signal) {
  const controller = new AbortController()
  let timedOut = false
  const onAbort = () => controller.abort(signal.reason)
  if (signal?.aborted) controller.abort(signal.reason)
  else signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  try {
    let current = validateSubscriptionUrl(url)
    let response
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      response = await fetch(current.toString(), {
        signal: controller.signal,
        redirect: 'manual',
        headers: { 'user-agent': 'v2rayN/6.0', accept: '*/*' },
      })
      if (![301, 302, 303, 307, 308].includes(response.status)) break
      if (redirects === 5) throw new Error('Слишком много перенаправлений списка серверов')
      const location = response.headers?.get?.('location')
      if (!location) throw new Error('Перенаправление списка серверов не содержит адрес')
      current = validateSubscriptionUrl(new URL(location, current).toString())
    }
    if (!response.ok) throw new Error(`Список серверов не отдался: код ${response.status}`)
    const servers = parseSubscription(await readLimitedResponse(response, SUBSCRIPTION_MAX_BYTES))
    if (servers.length === 0) throw new Error('В ответе не нашлось ни одной понятной ссылки на сервер')
    return servers
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(timedOut ? 'Список серверов не ответил вовремя' : 'Загрузка списка серверов отменена')
    }
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

function waitForTcpPort(port, timeoutMs = 8000, signal) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    let socket = null
    let timer = null
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket?.destroy()
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }
    const onAbort = () => finish(new Error(`Ожидание локального порта ${port} отменено`))
    const attempt = () => {
      if (settled) return
      socket = net.createConnection({ host: '127.0.0.1', port: Number(port) })
      socket.once('connect', () => finish())
      socket.once('error', () => {
        socket?.destroy()
        if (Date.now() - started >= timeoutMs) finish(new Error(`Локальный порт ${port} не открылся за ${timeoutMs} мс`))
        else timer = setTimeout(attempt, 150)
      })
    }
    if (signal?.aborted) onAbort()
    else {
      signal?.addEventListener('abort', onAbort, { once: true })
      attempt()
    }
  })
}

function testSocksProxy(port, targetHost = 'example.com', targetPort = 443, timeoutMs = 10000) {
  if (!validPort(port) || !validHost(targetHost) || !validPort(targetPort)) return Promise.reject(new Error('Недопустимые параметры проверки SOCKS5'))
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: Number(port) })
    let phase = 'greeting'
    const fail = error => { socket.destroy(); reject(error instanceof Error ? error : new Error(String(error))) }
    socket.setTimeout(timeoutMs, () => fail(new Error('Тайм-аут проверки SOCKS5')))
    socket.once('error', fail)
    socket.once('connect', () => socket.write(Buffer.from([0x05, 0x01, 0x00])))
    socket.on('data', data => {
      if (phase === 'greeting') {
        if (data.length < 2 || data[0] !== 0x05 || data[1] !== 0x00) return fail(new Error('Локальный порт не отвечает как SOCKS5 без аутентификации'))
        const host = Buffer.from(targetHost, 'utf8')
        phase = 'connect'
        socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host, Buffer.from([targetPort >> 8, targetPort & 0xff])]))
        return
      }
      if (data.length < 2 || data[0] !== 0x05 || data[1] !== 0x00) return fail(new Error(`V2Ray не установил внешний туннель (SOCKS code ${data[1] ?? 'unknown'})`))
      socket.destroy()
      resolve({ ok: true, localPort: Number(port), target: `${targetHost}:${targetPort}`, latencyMs: Date.now() - started })
    })
  })
}

/**
 * Drive a real CONNECT through the local HTTP proxy.
 *
 * This is the test that matters: the HTTP inbound is what the Harness uses, and
 * a `CONNECT host:port` answered with `200` proves the proxy opened the tunnel
 * outbound — the same path every model request takes.
 *
 * @param port - the local HTTP proxy port.
 * @param targetHost - the host to tunnel to.
 * @param targetPort - the port to tunnel to.
 * @param timeoutMs - request timeout.
 * @returns the observed result.
 */
function testHttpProxy(port, targetHost = 'api.ipify.org', targetPort = 443, timeoutMs = 15000) {
  if (!validPort(port) || !validHost(targetHost) || !validPort(targetPort)) {
    return Promise.reject(new Error('Недопустимые параметры проверки HTTP-прокси'))
  }
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: Number(port) })
    let answer = ''
    const fail = error => { socket.destroy(); reject(error instanceof Error ? error : new Error(String(error))) }
    socket.setTimeout(timeoutMs, () => fail(new Error('Тайм-аут проверки HTTP-прокси')))
    socket.once('error', fail)
    socket.once('connect', () => {
      socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`)
    })
    socket.on('data', chunk => {
      if (Buffer.byteLength(answer) + chunk.length > HTTP_TEST_MAX_BYTES) {
        fail(new Error('Ответ HTTP-прокси превышает допустимый размер'))
        return
      }
      answer += String(chunk)
      if (!answer.includes('\r\n')) return
      const statusLine = answer.split('\r\n')[0]
      const status = Number(statusLine.split(' ')[1])
      if (status === 200) {
        socket.destroy()
        resolve({ ok: true, localPort: Number(port), target: `${targetHost}:${targetPort}`, latencyMs: Date.now() - started })
        return
      }
      fail(new Error(`V2Ray не открыл туннель: ${statusLine.trim() || 'пустой ответ'}`))
    })
  })
}

function sanitizeServer(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Недопустимая запись сервера')
  const protocol = String(input.protocol || '')
  const host = String(input.host || '')
  const remotePort = Number(input.remotePort)
  if (!SUPPORTED_PROTOCOLS.includes(protocol) || !validHost(host) || !validPort(remotePort)) {
    throw new Error('Недопустимые протокол, адрес или порт сервера')
  }
  const server = {
    id: validText(input.id, 512, { allowEmpty: false }) ? input.id : '',
    name: validText(input.name, 256) ? input.name : `${host}:${remotePort}`,
    protocol,
    host,
    remotePort,
    transport: ['tcp', 'ws', 'grpc'].includes(input.transport) ? input.transport : 'tcp',
    security: ['none', 'tls', 'reality'].includes(input.security) ? input.security : 'none',
  }
  for (const field of ['uuid', 'password', 'method', 'serverName', 'wsPath', 'wsHost', 'fingerprint', 'publicKey', 'shortId', 'spiderX', 'flow']) {
    if (input[field] !== undefined) server[field] = String(input[field])
  }
  if (input.alterId !== undefined) {
    const alterId = Number(input.alterId)
    if (!Number.isInteger(alterId) || alterId < 0 || alterId > 65535) throw new Error('Недопустимый alterId')
    server.alterId = alterId
  }
  validateOptionalServerFields(server)
  if ((protocol === 'vless' || protocol === 'vmess') && !validUuid(server.uuid)) throw new Error(`Недопустимый UUID ${protocol}`)
  if ((protocol === 'trojan' || protocol === 'shadowsocks') && !validText(server.password, 1024, { allowEmpty: false })) {
    throw new Error('Недопустимый пароль сервера')
  }
  if (protocol === 'shadowsocks' && !validText(server.method, 64, { allowEmpty: false, pattern: /^[A-Za-z0-9._-]+$/ })) {
    throw new Error('Недопустимый метод Shadowsocks')
  }
  server.id = server.id || serverId(server)
  return server
}

function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise(resolve => {
    let timer
    const done = () => { clearTimeout(timer); child.removeListener('exit', done); resolve(true) }
    child.once('exit', done)
    timer = setTimeout(() => { child.removeListener('exit', done); resolve(false) }, timeoutMs)
  })
}

function runKiller(spawnImpl, args, timeoutMs) {
  return new Promise(resolve => {
    let settled = false
    let timer
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    try {
      const killer = spawnImpl('taskkill', args, { windowsHide: true, shell: false, stdio: 'ignore' })
      killer.once('exit', finish)
      killer.once('error', finish)
      timer = setTimeout(finish, timeoutMs)
    } catch { finish() }
  })
}

function waitForPortReleased(port, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    let timer
    const attempt = () => {
      const probe = net.createServer()
      const retry = () => {
        try { probe.close() } catch {}
        if (Date.now() >= deadline) reject(new Error(`Локальный порт ${port} не освободился после остановки V2Ray`))
        else timer = setTimeout(attempt, 100)
      }
      probe.once('error', retry)
      probe.listen(Number(port), '127.0.0.1', () => {
        clearTimeout(timer)
        probe.close(resolve)
      })
    }
    attempt()
  })
}

/** The V2Ray lifecycle owner. */
class V2RayClient {
  constructor(root, userData, options = {}) {
    this.root = root
    this.userData = userData
    this.process = null
    this.socksPort = null
    this.httpPort = null
    this.configPath = path.join(userData, 'v2ray.generated.json')
    this.settingsPath = path.join(userData, SETTINGS_FILE)
    this.startPromise = null
    this.stopPromise = null
    this.startController = null
    this.lifecycleVersion = 0
    this.spawnImpl = options.spawnImpl || spawn
    this.platform = options.platform || process.platform
    this.binaryPath = options.binaryPath || null
    this.encryptSecret = typeof options.encryptSecret === 'function' ? options.encryptSecret : null
    this.decryptSecret = typeof options.decryptSecret === 'function' ? options.decryptSecret : null
    this.stopGraceMs = options.stopGraceMs || STOP_GRACE_MS
    this.stopKillMs = options.stopKillMs || STOP_KILL_MS
  }

  status() {
    const binary = this.binaryPath || resolveBinary(this.root)
    return {
      running: Boolean(this.process && this.process.exitCode === null),
      socksPort: this.socksPort,
      httpPort: this.httpPort,
      binaryAvailable: Boolean(binary && existsSync(binary)),
    }
  }

  /**
   * The proxy environment handed to the Harness backend.
   *
   * `http://`, never `socks5://` — the Harness refuses a SOCKS value and then
   * connects directly, which silently defeats the whole tunnel.
   *
   * @returns the environment overlay, empty while the tunnel is down.
   */
  proxyEnv() {
    if (!this.status().running || !this.httpPort) return {}
    const proxy = `http://127.0.0.1:${this.httpPort}`
    return { ALL_PROXY: proxy, HTTP_PROXY: proxy, HTTPS_PROXY: proxy }
  }

  _decodeSecrets(server) {
    const decoded = { ...server }
    for (const field of SECRET_FIELDS) {
      const value = decoded[field]
      if (!value || typeof value !== 'object' || typeof value.encrypted !== 'string') continue
      if (!this.decryptSecret) throw new Error(`Секрет ${field} зашифрован, но расшифровщик не настроен`)
      decoded[field] = String(this.decryptSecret(value.encrypted))
    }
    return decoded
  }

  _encodeSecrets(server) {
    if (!this.encryptSecret) return server
    const encoded = { ...server }
    for (const field of SECRET_FIELDS) {
      if (typeof encoded[field] === 'string' && encoded[field] !== '') {
        encoded[field] = { encrypted: String(this.encryptSecret(encoded[field])) }
      }
    }
    return encoded
  }

  _backupCorruptSettings(error) {
    const backupPath = `${this.settingsPath}.corrupt-${Date.now()}.bak`
    try {
      copyFileSync(this.settingsPath, backupPath)
    } catch (backupError) {
      throw new Error(`Не удалось прочитать настройки V2Ray и создать резервную копию: ${backupError.message}`, { cause: error })
    }
    throw new Error(`Настройки V2Ray повреждены. Исходный файл сохранён, копия: ${backupPath}`, { cause: error })
  }

  readSettings() {
    let raw
    try {
      raw = readFileSync(this.settingsPath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return { ...EMPTY_SETTINGS, servers: [] }
      this._backupCorruptSettings(error)
    }
    try {
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('корень документа должен быть объектом')
      const servers = Array.isArray(parsed.servers)
        ? parsed.servers.map(server => sanitizeServer(this._decodeSecrets(server)))
        : []
      const socksPort = validPort(parsed.socksPort) ? Number(parsed.socksPort) : DEFAULT_SOCKS_PORT
      const httpPort = validPort(parsed.httpPort) ? Number(parsed.httpPort) : DEFAULT_HTTP_PORT
      const activeId = validText(parsed.activeId, 512) && servers.some(server => server.id === parsed.activeId)
        ? parsed.activeId
        : servers[0]?.id ?? ''
      return {
        enabled: Boolean(parsed.enabled),
        subscriptionUrl: validText(parsed.subscriptionUrl, 4096) ? parsed.subscriptionUrl : '',
        servers,
        activeId,
        socksPort,
        httpPort: httpPort === socksPort ? DEFAULT_HTTP_PORT : httpPort,
      }
    } catch (error) {
      this._backupCorruptSettings(error)
    }
  }

  writeSettings(patch = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Недопустимые настройки V2Ray')
    const next = { ...this.readSettings() }
    if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled)
    if (patch.subscriptionUrl !== undefined) {
      if (!validText(patch.subscriptionUrl, 4096)) throw new Error('Недопустимая ссылка на список серверов')
      next.subscriptionUrl = patch.subscriptionUrl
    }
    if (patch.servers !== undefined) {
      if (!Array.isArray(patch.servers) || patch.servers.length > 5000) throw new Error('Недопустимый список серверов')
      next.servers = patch.servers.map(sanitizeServer)
    }
    if (patch.activeId !== undefined) {
      if (!validText(patch.activeId, 512)) throw new Error('Недопустимый идентификатор активного сервера')
      next.activeId = patch.activeId
    }
    if (patch.socksPort !== undefined) {
      if (!validPort(patch.socksPort)) throw new Error('Недопустимый SOCKS-порт')
      next.socksPort = Number(patch.socksPort)
    }
    if (patch.httpPort !== undefined) {
      if (!validPort(patch.httpPort)) throw new Error('Недопустимый HTTP-порт')
      next.httpPort = Number(patch.httpPort)
    }
    if (!validPortPair(next.socksPort, next.httpPort)) throw new Error('Локальные порты должны быть разными')
    if (!next.servers.some(server => server.id === next.activeId)) next.activeId = next.servers[0]?.id ?? ''
    mkdirSync(this.userData, { recursive: true })
    const stored = { ...next, servers: next.servers.map(server => this._encodeSecrets(server)) }
    try {
      writeFileSync(this.settingsPath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 })
    } catch (error) {
      throw new Error(`Не удалось записать настройки V2Ray: ${error.message}`, { cause: error })
    }
    return next
  }

  /**
   * Add servers parsed from a link or a subscription, skipping duplicates.
   * @param servers - parsed server entries.
   * @returns the stored document after the merge.
   */
  addServers(servers) {
    const current = this.readSettings()
    const merged = [...current.servers]
    for (const server of servers) {
      if (!server || typeof server.id !== 'string') continue
      const index = merged.findIndex(entry => entry.id === server.id)
      if (index === -1) merged.push(server)
      else merged[index] = { ...merged[index], ...server }
    }
    return this.writeSettings({ servers: merged, activeId: current.activeId || merged[0]?.id || '' })
  }

  /**
   * Resolve the server the tunnel should use.
   * @param settings - the stored document.
   * @returns the active server, or null when the list is empty.
   */
  activeServer(settings = this.readSettings()) {
    return settings.servers.find(server => server.id === settings.activeId) ?? settings.servers[0] ?? null
  }

  start(input = {}) {
    if (this.startPromise) return this.startPromise
    const version = ++this.lifecycleVersion
    const operation = this._start(input, version)
    this.startPromise = operation.finally(() => {
      if (this.startPromise === wrapped) this.startPromise = null
    })
    const wrapped = this.startPromise
    return wrapped
  }

  async _start(input, version) {
    await this._stopCurrent()
    if (version !== this.lifecycleVersion) throw new Error('Запуск V2Ray отменён')
    const settings = this.readSettings()
    const server = input.server ?? this.activeServer(settings)
    if (server === null) throw new Error('Сначала добавьте хотя бы один сервер: вставьте ссылку или список серверов')
    const socksPort = Number(input.localPort ?? settings.socksPort ?? DEFAULT_SOCKS_PORT)
    const httpPort = Number(input.httpPort ?? settings.httpPort ?? DEFAULT_HTTP_PORT)
    const config = createV2RayConfig({ server, socksPort, httpPort })
    const binary = this.binaryPath || resolveBinary(this.root)
    if (!binary || !existsSync(binary)) throw new Error('V2Ray не найден. Поместите v2ray.exe в installer/resources/v2ray')
    mkdirSync(this.userData, { recursive: true })
    writeFileSync(this.configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
    if (version !== this.lifecycleVersion) {
      safeUnlink(this.configPath)
      throw new Error('Запуск V2Ray отменён')
    }

    const controller = new AbortController()
    this.startController = controller
    this.socksPort = socksPort
    this.httpPort = httpPort
    let stderr = ''
    let child
    try {
      child = this.spawnImpl(binary, ['run', '-c', this.configPath], {
        cwd: path.dirname(binary), windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'],
      })
      this.process = child
      child.stderr?.on('data', chunk => { stderr = `${stderr}${String(chunk)}`.slice(-4000) })
      child.once('exit', () => {
        if (this.process === child) {
          this.process = null
          this.socksPort = null
          this.httpPort = null
        }
        try { safeUnlink(this.configPath) } catch {}
      })
      await new Promise((resolve, reject) => {
        const cleanup = () => {
          child.removeListener('error', onError)
          child.removeListener('exit', onExit)
        }
        const onError = error => { cleanup(); controller.abort(); reject(error) }
        const onExit = code => {
          cleanup()
          controller.abort()
          reject(new Error(`V2Ray завершился с кодом ${code}: ${stderr.trim()}`))
        }
        child.once('error', onError)
        child.once('exit', onExit)
        Promise.all([
          waitForTcpPort(socksPort, 8000, controller.signal),
          waitForTcpPort(httpPort, 8000, controller.signal),
        ]).then(() => { cleanup(); resolve() }, error => { cleanup(); reject(error) })
      })
      if (version !== this.lifecycleVersion) throw new Error('Запуск V2Ray отменён')
      return this.status()
    } catch (error) {
      controller.abort()
      await this._stopCurrent()
      throw error
    } finally {
      if (this.startController === controller) this.startController = null
    }
  }

  /**
   * Prove the tunnel carries traffic.
   *
   * The HTTP inbound is tested, not the SOCKS one: it is the inbound the Harness
   * actually uses, so a pass here is the only result that predicts model calls
   * working. The SOCKS port is reported alongside for diagnostics.
   *
   * @returns the observed tunnel result.
   */
  async test() {
    const status = this.status()
    if (!status.running || !this.httpPort) throw new Error('Сначала запустите V2Ray')
    const result = await testHttpProxy(this.httpPort)
    return { ...result, socksPort: this.socksPort }
  }

  stop() {
    this.lifecycleVersion += 1
    this.startController?.abort()
    return this._stopCurrent()
  }

  _stopCurrent() {
    if (this.stopPromise) return this.stopPromise
    const operation = this._performStop()
    this.stopPromise = operation.finally(() => {
      if (this.stopPromise === wrapped) this.stopPromise = null
    })
    const wrapped = this.stopPromise
    return wrapped
  }

  async _performStop() {
    const child = this.process
    const ports = [this.socksPort, this.httpPort].filter(validPort)
    if (!child) {
      this.socksPort = null
      this.httpPort = null
      safeUnlink(this.configPath)
      return this.status()
    }

    let exited = child.exitCode !== null || child.signalCode !== null
    if (!exited && this.platform === 'win32') {
      await runKiller(this.spawnImpl, ['/pid', String(child.pid), '/t'], this.stopGraceMs)
      exited = await waitForChildExit(child, this.stopGraceMs)
      if (!exited) {
        await runKiller(this.spawnImpl, ['/pid', String(child.pid), '/f', '/t'], this.stopKillMs)
        exited = await waitForChildExit(child, this.stopKillMs)
      }
    } else if (!exited) {
      child.kill('SIGTERM')
      exited = await waitForChildExit(child, this.stopGraceMs)
      if (!exited) {
        child.kill('SIGKILL')
        exited = await waitForChildExit(child, this.stopKillMs)
      }
    }

    try {
      if (!exited) throw new Error('V2Ray не завершился после принудительной остановки')
      await Promise.all(ports.map(port => waitForPortReleased(port)))
      if (this.process === child) this.process = null
      this.socksPort = null
      this.httpPort = null
      return this.status()
    } finally {
      safeUnlink(this.configPath)
    }
  }
}

module.exports = {
  V2RayClient,
  createV2RayConfig,
  createVlessConfig,
  parseShareLink,
  parseSubscription,
  fetchSubscription,
  buildOutbound,
  resolveBinary,
  testSocksProxy,
  testHttpProxy,
  waitForTcpPort,
  validHost,
  validateSubscriptionUrl,
  sanitizeServer,
  DEFAULT_SOCKS_PORT,
  DEFAULT_HTTP_PORT,
  SUPPORTED_PROTOCOLS,
}

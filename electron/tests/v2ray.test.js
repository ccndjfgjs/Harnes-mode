const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const { spawn } = require('node:child_process')
const { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const {
  createVlessConfig, createV2RayConfig, parseShareLink, parseSubscription,
  fetchSubscription, testSocksProxy, testHttpProxy, V2RayClient, validHost,
} = require('../v2ray')

const b64 = value => Buffer.from(value, 'utf8').toString('base64')
const UUID = '12345678-1234-1234-1234-123456789abc'

test('createVlessConfig builds localhost-only SOCKS and VLESS WS/TLS outbound', () => {
  const config = createVlessConfig({
    host: 'proxy.example.com', remotePort: 443, uuid: UUID,
    localPort: 10808, transport: 'ws', security: 'tls', serverName: 'edge.example.com', wsPath: '/vless',
  })
  assert.equal(config.inbounds[0].listen, '127.0.0.1')
  assert.equal(config.inbounds[0].port, 10808)
  assert.equal(config.outbounds[0].streamSettings.network, 'ws')
  assert.equal(config.outbounds[0].streamSettings.tlsSettings.serverName, 'edge.example.com')
  assert.equal(config.outbounds[0].streamSettings.wsSettings.path, '/vless')
})

test('createVlessConfig rejects invalid external input', () => {
  assert.throws(() => createVlessConfig({ host: 'bad host', remotePort: 70000, uuid: 'invalid' }))
})

// The HTTP inbound is the one the Harness reads. A SOCKS-only tunnel is refused by
// its http-proxy layer and every model call then goes direct, so the pair of
// inbounds is the whole point of this configuration.
test('createV2RayConfig opens both a SOCKS and an HTTP loopback inbound', () => {
  const server = parseShareLink(`vless://${UUID}@proxy.example.com:443?security=tls#Тест`)
  const config = createV2RayConfig({ server, socksPort: 10808, httpPort: 10809 })
  assert.deepEqual(config.inbounds.map(inbound => inbound.protocol), ['socks', 'http'])
  assert.deepEqual(config.inbounds.map(inbound => inbound.port), [10808, 10809])
  assert.deepEqual(config.inbounds.map(inbound => inbound.listen), ['127.0.0.1', '127.0.0.1'])
})

test('createV2RayConfig refuses two identical local ports', () => {
  const server = parseShareLink(`vless://${UUID}@proxy.example.com:443#Тест`)
  assert.throws(() => createV2RayConfig({ server, socksPort: 10808, httpPort: 10808 }), /два разных/)
})

test('parseShareLink reads a vless link with transport, TLS and name', () => {
  const server = parseShareLink(
    `vless://${UUID}@proxy.example.com:443?type=ws&security=tls&sni=edge.example.com&path=%2Fvless#Мой%20сервер`,
  )
  assert.equal(server.protocol, 'vless')
  assert.equal(server.host, 'proxy.example.com')
  assert.equal(server.remotePort, 443)
  assert.equal(server.transport, 'ws')
  assert.equal(server.security, 'tls')
  assert.equal(server.serverName, 'edge.example.com')
  assert.equal(server.wsPath, '/vless')
  assert.equal(server.name, 'Мой сервер')
})

test('parseShareLink reads a reality vless link', () => {
  const server = parseShareLink(
    `vless://${UUID}@proxy.example.com:443?security=reality&sni=www.example.com&fp=chrome&pbk=КЛЮЧ&sid=abcd&flow=xtls-rprx-vision#Реальность`,
  )
  assert.equal(server.security, 'reality')
  assert.equal(server.fingerprint, 'chrome')
  assert.equal(server.publicKey, 'КЛЮЧ')
  assert.equal(server.shortId, 'abcd')
  assert.equal(server.flow, 'xtls-rprx-vision')
})

test('parseShareLink reads a vmess link', () => {
  const server = parseShareLink(`vmess://${b64(JSON.stringify({
    v: '2', ps: 'Тест VMess', add: 'vm.example.com', port: '8443',
    id: '87654321-4321-4321-4321-cba987654321', aid: '0', net: 'ws', tls: 'tls', path: '/ws', host: 'vm.example.com',
  }))}`)
  assert.equal(server.protocol, 'vmess')
  assert.equal(server.host, 'vm.example.com')
  assert.equal(server.remotePort, 8443)
  assert.equal(server.transport, 'ws')
  assert.equal(server.security, 'tls')
  assert.equal(server.name, 'Тест VMess')
})

test('parseShareLink reads trojan and both shadowsocks shapes', () => {
  const trojan = parseShareLink('trojan://pass123@tr.example.com:443?security=tls#Троян')
  assert.equal(trojan.protocol, 'trojan')
  assert.equal(trojan.password, 'pass123')

  const modern = parseShareLink(`ss://${b64('aes-256-gcm:секрет')}@ss.example.com:8388#Тень`)
  assert.equal(modern.protocol, 'shadowsocks')
  assert.equal(modern.method, 'aes-256-gcm')
  assert.equal(modern.host, 'ss.example.com')
  assert.equal(modern.remotePort, 8388)

  const legacy = parseShareLink(`ss://${b64('aes-256-gcm:секрет@ss2.example.com:8388')}#Тень2`)
  assert.equal(legacy.host, 'ss2.example.com')
  assert.equal(legacy.remotePort, 8388)
})

test('parseShareLink returns null instead of throwing on unusable lines', () => {
  for (const line of ['', '   ', '# комментарий', 'просто текст', 'http://example.com', 'vless://not-a-uuid@host:443']) {
    assert.equal(parseShareLink(line), null, `ожидался null для ${JSON.stringify(line)}`)
  }
})

test('a server id never carries the secret and is stable across imports', () => {
  const link = 'trojan://supersecret@tr.example.com:443#Троян'
  const first = parseShareLink(link)
  const second = parseShareLink(link)
  assert.equal(first.id, second.id)
  assert.equal(first.id.includes('supersecret'), false)
})

test('parseSubscription reads plain and base64 bodies alike', () => {
  const body = [
    '# комментарий',
    `vless://${UUID}@a.example.com:443?security=tls#Первый`,
    '',
    'мусор',
    'trojan://pass@b.example.com:443?security=tls#Второй',
  ].join('\n')
  assert.deepEqual(parseSubscription(body).map(server => server.name), ['Первый', 'Второй'])
  assert.deepEqual(parseSubscription(b64(body)).map(server => server.name), ['Первый', 'Второй'])
  assert.deepEqual(parseSubscription(''), [])
  assert.deepEqual(parseSubscription('совсем не список'), [])
})

test('testSocksProxy completes SOCKS5 greeting and CONNECT', async t => {
  const server = net.createServer(socket => {
    let phase = 0
    socket.on('data', () => {
      if (phase++ === 0) socket.write(Buffer.from([0x05, 0x00]))
      else socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 80]))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const address = server.address()
  assert.equal(typeof address, 'object')
  const result = await testSocksProxy(address.port, 'example.com', 443, 2000)
  assert.equal(result.ok, true)
  assert.equal(result.localPort, address.port)
})

test('testHttpProxy accepts a CONNECT the proxy grants and rejects a refusal', async t => {
  const granted = net.createServer(socket => {
    socket.on('data', () => socket.write('HTTP/1.1 200 Connection established\r\n\r\n'))
  })
  const refused = net.createServer(socket => {
    socket.on('data', () => socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'))
  })
  await new Promise(resolve => granted.listen(0, '127.0.0.1', resolve))
  await new Promise(resolve => refused.listen(0, '127.0.0.1', resolve))
  t.after(() => { granted.close(); refused.close() })
  const grantedAddress = granted.address()
  const refusedAddress = refused.address()
  assert.equal(typeof grantedAddress, 'object')
  assert.equal(typeof refusedAddress, 'object')

  const ok = await testHttpProxy(grantedAddress.port, 'example.com', 443, 2000)
  assert.equal(ok.ok, true)
  await assert.rejects(() => testHttpProxy(refusedAddress.port, 'example.com', 443, 2000), /не открыл туннель/)
})

// The Harness refuses a SOCKS proxy URL and connects directly instead, so the
// environment must name the HTTP inbound or the tunnel is invisible to model calls.
test('proxyEnv hands the Harness an http:// proxy, never socks5://', () => {
  const client = new V2RayClient(process.cwd(), process.cwd())
  client.httpPort = 10809
  client.socksPort = 10808
  client.process = { exitCode: null }
  const env = client.proxyEnv()
  assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:10809')
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:10809')
  assert.equal(env.ALL_PROXY, 'http://127.0.0.1:10809')
  assert.equal(Object.values(env).some(value => value.includes('socks')), false)
})

test('V2RayClient reports an idle status without throwing', () => {
  const client = new V2RayClient(process.cwd(), process.cwd())
  assert.deepEqual(client.proxyEnv(), {})
  assert.equal(client.status().running, false)
})

test('host and optional V2Ray fields reject injection-shaped input', () => {
  for (const host of ['127.0.0.1', '::1', '[2001:db8::1]', 'proxy.example.com']) assert.equal(validHost(host), true)
  for (const host of ['bad host', 'under_score.example', '-bad.example', 'bad-.example', 'host\r\nInjected: yes']) {
    assert.equal(validHost(host), false)
  }
  assert.throws(() => createVlessConfig({
    host: 'proxy.example.com', remotePort: 443, uuid: UUID,
    wsHost: 'edge.example.com\r\nX-Test: injected', localPort: 10808, httpPort: 10809,
  }), /wsHost/)
})

test('server IDs use a 16-hex secret digest', () => {
  const parsed = parseShareLink(`vless://${UUID}@proxy.example.com:443`)
  assert.match(parsed.id, /-[0-9a-f]{16}$/)
})

test('corrupt settings are preserved and copied before read or write fails', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'v2ray-corrupt-'))
  const settingsPath = path.join(dir, 'v2ray.settings.json')
  writeFileSync(settingsPath, '{not json', 'utf8')
  const client = new V2RayClient(process.cwd(), dir)
  assert.throws(() => client.readSettings(), /повреждены/)
  assert.equal(readFileSync(settingsPath, 'utf8'), '{not json')
  assert.ok(readdirSync(dir).some(name => /^v2ray\.settings\.json\.corrupt-\d+\.bak$/.test(name)))
  assert.throws(() => client.writeSettings({ enabled: true }), /повреждены/)
  assert.equal(readFileSync(settingsPath, 'utf8'), '{not json')
})

test('writeSettings validates servers and supports optional secret encryption callbacks', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'v2ray-settings-'))
  const client = new V2RayClient(process.cwd(), dir, {
    encryptSecret: value => Buffer.from(value).toString('base64'),
    decryptSecret: value => Buffer.from(value, 'base64').toString(),
  })
  const server = parseShareLink(`vless://${UUID}@proxy.example.com:443`)
  client.writeSettings({ servers: [server], activeId: server.id, socksPort: 12080, httpPort: 12081 })
  const raw = readFileSync(path.join(dir, 'v2ray.settings.json'), 'utf8')
  assert.equal(raw.includes(UUID), false)
  assert.equal(client.readSettings().servers[0].uuid, UUID)
  assert.throws(() => client.writeSettings({ servers: [{ ...server, wsPath: '/ok\r\nbad' }] }), /wsPath/)
  assert.throws(() => client.writeSettings({ socksPort: 12081 }), /разными/)
})

test('wait-for-port can be aborted without leaving a polling timer', async () => {
  const { waitForTcpPort } = require('../v2ray')
  const controller = new AbortController()
  const waiting = waitForTcpPort(65534, 5000, controller.signal)
  controller.abort()
  await assert.rejects(waiting, /отменено/)
})

test('fetchSubscription rejects unsafe URLs, validates redirects, bounds bodies, and supports abort', async t => {
  await assert.rejects(() => fetchSubscription('http://example.com/list'), /HTTPS/)
  await assert.rejects(() => fetchSubscription('https://user:pass@example.com/list'), /учётные данные/)
  await assert.rejects(() => fetchSubscription('https://example.com/list#fragment'), /фрагмент/)

  const server = net.createServer(socket => {
    socket.once('data', data => {
      const target = String(data).split(' ')[1]
      if (target === '/redirect') {
        socket.end('HTTP/1.1 302 Found\r\nLocation: file:///tmp/secret\r\nContent-Length: 0\r\n\r\n')
      } else {
        socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${2 * 1024 * 1024 + 1}\r\n\r\n`)
      }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const port = server.address().port
  await assert.rejects(() => fetchSubscription(`http://127.0.0.1:${port}/redirect`), /HTTPS/)
  await assert.rejects(() => fetchSubscription(`http://127.0.0.1:${port}/large`), /больше/)

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(() => fetchSubscription(`http://127.0.0.1:${port}/large`, 15000, controller.signal), /отменена/)
})

test('concurrent starts share one process and stop waits for exit, frees ports, and deletes config', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'v2ray-lifecycle-'))
  const firstPortServer = net.createServer()
  const secondPortServer = net.createServer()
  await new Promise(resolve => firstPortServer.listen(0, '127.0.0.1', resolve))
  await new Promise(resolve => secondPortServer.listen(0, '127.0.0.1', resolve))
  const socksPort = firstPortServer.address().port
  const httpPort = secondPortServer.address().port
  await Promise.all([
    new Promise(resolve => firstPortServer.close(resolve)),
    new Promise(resolve => secondPortServer.close(resolve)),
  ])

  let spawnCount = 0
  const script = [
    "const fs=require('node:fs'),net=require('node:net')",
    "const c=JSON.parse(fs.readFileSync(process.argv[1],'utf8'))",
    "const servers=c.inbounds.map(x=>net.createServer().listen(x.port,'127.0.0.1'))",
    "process.on('SIGTERM',()=>Promise.all(servers.map(s=>new Promise(r=>s.close(r)))).then(()=>process.exit(0)))",
    "setInterval(()=>{},1000)",
  ].join(';')
  const client = new V2RayClient(process.cwd(), dir, {
    platform: 'linux',
    binaryPath: process.execPath,
    spawnImpl: (_binary, args, options) => {
      spawnCount += 1
      return spawn(process.execPath, ['-e', script, args[2]], options)
    },
  })
  const input = { server: parseShareLink(`vless://${UUID}@proxy.example.com:443`), localPort: socksPort, httpPort }
  const first = client.start(input)
  const second = client.start(input)
  assert.equal(first, second)
  assert.equal((await first).running, true)
  assert.equal(spawnCount, 1)
  assert.equal(existsSync(client.configPath), true)
  const stopped = await client.stop()
  assert.equal(stopped.running, false)
  assert.equal(existsSync(client.configPath), false)
  const rebound = net.createServer()
  await new Promise((resolve, reject) => rebound.once('error', reject).listen(socksPort, '127.0.0.1', resolve))
  await new Promise(resolve => rebound.close(resolve))
})

const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const {
  buildGoogleAuthorizeUrl,
  createPkcePair,
  exchangeGoogleCode,
  pollGithubDeviceToken,
  registerAccountsOAuth,
  startGithubDeviceFlow,
  startLoopbackServer,
} = require('../oauth-flow')

test('createPkcePair returns a verifier and a distinct challenge', () => {
  const { verifier, challenge } = createPkcePair()
  assert.equal(typeof verifier, 'string')
  assert.ok(verifier.length >= 43)
  assert.ok(challenge.length >= 43)
  assert.notEqual(challenge, verifier)
  assert.match(verifier, /^[A-Za-z0-9_-]+$/)
})

test('buildGoogleAuthorizeUrl carries the PKCE loopback parameters', () => {
  const url = new URL(buildGoogleAuthorizeUrl({
    clientId: 'client-1',
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    redirectUri: 'http://127.0.0.1:51234/callback',
    challenge: 'challenge-1',
    state: 'state-1',
  }))
  assert.equal(`${url.origin}${url.pathname}`, 'https://accounts.google.com/o/oauth2/v2/auth')
  assert.equal(url.searchParams.get('client_id'), 'client-1')
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:51234/callback')
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('state'), 'state-1')
})

test('exchangeGoogleCode returns tokens with an absolute deadline', async () => {
  const seen = {}
  const fetchImpl = async (url, options) => {
    seen.url = url
    seen.body = String(options.body)
    return {
      ok: true,
      json: async () => ({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 }),
    }
  }
  const before = Date.now()
  const tokens = await exchangeGoogleCode({
    code: 'code-1', clientId: 'client-1', verifier: 'verifier-1',
    redirectUri: 'http://127.0.0.1:1/callback', fetchImpl,
  })
  assert.equal(tokens.accessToken, 'access-1')
  assert.equal(tokens.refreshToken, 'refresh-1')
  assert.ok(tokens.expiresAt >= before + 3599 * 1000)
  assert.ok(seen.body.includes('code_verifier=verifier-1'))
})

test('exchangeGoogleCode throws a readable error on rejection', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: 'invalid_grant', error_description: 'Bad code' }),
  })
  await assert.rejects(
    () => exchangeGoogleCode({ code: 'bad', clientId: 'c', verifier: 'v', redirectUri: 'http://127.0.0.1:1/callback', fetchImpl }),
    /Bad code/,
  )
})

test('startGithubDeviceFlow returns the user code and polling parameters', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      device_code: 'device-1', user_code: 'WDJB-MJHT',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900, interval: 5,
    }),
  })
  const device = await startGithubDeviceFlow({ clientId: 'client-1', fetchImpl })
  assert.equal(device.userCode, 'WDJB-MJHT')
  assert.equal(device.verificationUri, 'https://github.com/login/device')
  assert.equal(device.intervalSec, 5)
})

test('pollGithubDeviceToken survives pending polls then returns the token', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    if (calls < 3) return { ok: true, json: async () => ({ error: 'authorization_pending' }) }
    return { ok: true, json: async () => ({ access_token: 'ghu-1' }) }
  }
  const { accessToken } = await pollGithubDeviceToken({
    clientId: 'client-1', deviceCode: 'device-1', intervalSec: 0, expiresIn: 60,
    fetchImpl, sleepImpl: async () => {},
  })
  assert.equal(accessToken, 'ghu-1')
  assert.equal(calls, 3)
})

test('pollGithubDeviceToken stops when the popup is closed', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ error: 'authorization_pending' }) })
  await assert.rejects(
    () => pollGithubDeviceToken({
      clientId: 'client-1', deviceCode: 'device-1', intervalSec: 0, expiresIn: 60,
      fetchImpl, sleepImpl: async () => {}, shouldStop: () => true,
    }),
    /login window was closed/,
  )
})

class FakePopup {
  static instances = []
  constructor(options) {
    this.options = options
    this.handlers = {}
    this.destroyed = false
    this.url = ''
    FakePopup.instances.push(this)
  }
  once(event, fn) {
    this.handlers[event] = this.handlers[event] || []
    this.handlers[event].push({ once: true, fn })
  }
  on(event, fn) {
    this.handlers[event] = this.handlers[event] || []
    this.handlers[event].push({ once: false, fn })
  }
  emit(event, ...args) {
    const list = [...(this.handlers[event] || [])]
    for (const entry of list) {
      entry.fn(...args)
      if (entry.once) this.handlers[event] = this.handlers[event].filter(item => item !== entry)
    }
  }
  show() {}
  close() {
    this.destroyed = true
    this.emit('closed')
  }
  isDestroyed() {
    return this.destroyed
  }
  async loadURL(url) {
    this.url = url
    this.emit('ready-to-show')
  }
}

function fakeIpc() {
  return { handlers: {}, handle(name, fn) { this.handlers[name] = fn } }
}

function fakeMainWindow() {
  const sent = []
  return {
    sent,
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (channel, payload) => { sent.push([channel, payload]) },
    },
  }
}

async function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for IPC event')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

test('registerAccountsOAuth completes a Google login through the in-app popup', async () => {
  FakePopup.instances = []
  const fetchImpl = async (url) => {
    if (String(url).includes('oauth2.googleapis.com')) {
      return { ok: true, json: async () => ({ access_token: 'a1', refresh_token: 'r1', expires_in: 3600 }) }
    }
    return { ok: true, json: async () => ({ email: 'user@example.com' }) }
  }
  const ipc = fakeIpc()
  const win = fakeMainWindow()
  registerAccountsOAuth({ ipcMain: ipc, BrowserWindow: FakePopup, getMainWindow: () => win, fetchImpl })
  const result = await ipc.handlers['accounts-oauth-start']({}, { provider: 'google-drive', clientId: 'client-1' })
  assert.equal(result.ok, true)
  const popup = FakePopup.instances[FakePopup.instances.length - 1]
  assert.equal(popup.options.width, 520)
  const authUrl = new URL(popup.url)
  const redirectUri = authUrl.searchParams.get('redirect_uri')
  const state = authUrl.searchParams.get('state')
  assert.match(redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/)
  await new Promise((resolve, reject) => {
    http.get(`${redirectUri}?code=code-7&state=${state}`, (res) => {
      res.resume()
      res.on('end', resolve)
    }).on('error', reject)
  })
  await waitFor(() => win.sent.some(([channel]) => channel === 'accounts-oauth-done'))
  const [, done] = win.sent.find(([channel]) => channel === 'accounts-oauth-done')
  assert.equal(done.provider, 'google-drive')
  assert.equal(done.accountLabel, 'user@example.com')
  assert.equal(done.accessToken, 'a1')
  assert.ok(done.expiresAt > Date.now())
})

test('registerAccountsOAuth completes a GitHub device login', async () => {
  FakePopup.instances = []
  let tokenCalls = 0
  const fetchImpl = async (url) => {
    const target = String(url)
    if (target.includes('/login/device/code')) {
      return {
        ok: true,
        json: async () => ({
          device_code: 'd1', user_code: 'UC-1',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900, interval: 0,
        }),
      }
    }
    if (target.includes('/login/oauth/access_token')) {
      tokenCalls += 1
      if (tokenCalls < 2) return { ok: true, json: async () => ({ error: 'authorization_pending' }) }
      return { ok: true, json: async () => ({ access_token: 'ghu-1' }) }
    }
    return { ok: true, json: async () => ({ login: 'octocat' }) }
  }
  const ipc = fakeIpc()
  const win = fakeMainWindow()
  registerAccountsOAuth({ ipcMain: ipc, BrowserWindow: FakePopup, getMainWindow: () => win, fetchImpl })
  const result = await ipc.handlers['accounts-oauth-start']({}, { provider: 'github', clientId: 'client-1' })
  assert.equal(result.ok, true)
  assert.equal(result.device.userCode, 'UC-1')
  const popup = FakePopup.instances[FakePopup.instances.length - 1]
  assert.equal(popup.url, 'https://github.com/login/device')
  await waitFor(() => win.sent.some(([channel]) => channel === 'accounts-oauth-done'))
  const [, done] = win.sent.find(([channel]) => channel === 'accounts-oauth-done')
  assert.equal(done.provider, 'github')
  assert.equal(done.accountLabel, 'octocat')
  assert.equal(done.accessToken, 'ghu-1')
})

test('registerAccountsOAuth rejects an empty Client ID without opening a popup', async () => {
  FakePopup.instances = []
  const ipc = fakeIpc()
  const win = fakeMainWindow()
  registerAccountsOAuth({ ipcMain: ipc, BrowserWindow: FakePopup, getMainWindow: () => win, fetchImpl: async () => { throw new Error('no network') } })
  const result = await ipc.handlers['accounts-oauth-start']({}, { provider: 'github', clientId: '   ' })
  assert.equal(result.ok, false)
  assert.equal(FakePopup.instances.length, 0)
  assert.equal(win.sent.length, 0)
})

test('startLoopbackServer captures the provider redirect code', async t => {
  let captured = null
  const server = await startLoopbackServer({ onCode: (result) => { captured = result } })
  t.after(() => server.close())
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/callback$/)
  await new Promise((resolve, reject) => {
    http.get(`${server.url}?code=code-9&state=state-9`, (res) => {
      res.resume()
      res.on('end', resolve)
    }).on('error', reject)
  })
  assert.deepEqual(captured, { code: 'code-9', state: 'state-9' })
})

// electron/oauth-flow.js — In-app OAuth for the Accounts settings section.
//
// The renderer (AccountsSection) asks the main process to authorize a cloud:
// Google (Drive/Gmail) runs a PKCE + loopback-redirect flow inside a small
// in-app popup window; GitHub runs its device flow (no client secret needed,
// installed apps must not ship one). The code/token exchange happens here in
// Node, so browser CORS policies never get in the way. Results travel back
// to the renderer over IPC: 'accounts-oauth-done' / 'accounts-oauth-error'
// (plus the device payload in the 'accounts-oauth-start' invoke result).
//
// Pure helpers take injectable deps (fetchImpl, createServer) so they stay
// unit-testable with plain `node --test` (see tests/oauth-flow.test.js).
const { randomBytes, createHash } = require('node:crypto');
const http = require('node:http');

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';

const GOOGLE_SCOPES = {
  'google-drive': ['https://www.googleapis.com/auth/drive.readonly'],
  'gmail': ['https://www.googleapis.com/auth/gmail.readonly'],
};
const GITHUB_SCOPES = ['repo', 'read:user'];

const GOOGLE_PROVIDERS = new Set(['google-drive', 'gmail']);
const FETCH_TIMEOUT_MS = 25000;
const GOOGLE_FLOW_LIFETIME_MS = 10 * 60 * 1000;
const OAUTH_CANCELLED = 'OAUTH_CANCELLED';

class OAuthCancelledError extends Error {
  constructor(message = 'OAuth flow was cancelled') {
    super(message);
    this.name = 'OAuthCancelledError';
    this.code = OAUTH_CANCELLED;
  }
}

async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs = FETCH_TIMEOUT_MS, onController) {
  const controller = new AbortController();
  let timedOut = false;
  const externalSignal = options.signal;
  const onAbort = () => controller.abort(externalSignal.reason);
  if (externalSignal?.aborted) controller.abort(externalSignal.reason);
  else externalSignal?.addEventListener('abort', onAbort, { once: true });
  if (typeof onController === 'function') onController(controller);
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') {
      if (timedOut) throw new Error(`OAuth request timed out after ${timeoutMs} ms`);
      throw new OAuthCancelledError();
    }
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onAbort);
    if (typeof onController === 'function') onController(null, controller);
  }
}

function base64url(bytes) {
  return Buffer.from(bytes).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** One PKCE verifier/challenge pair for the pending Google exchange. */
function createPkcePair() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** Opaque round-trip state for the loopback callback. */
function randomState() {
  return base64url(randomBytes(16));
}

/**
 * Google authorize URL for the in-app popup (Desktop-client loopback flow).
 * @param {object} args - { clientId, scopes, redirectUri, challenge, state }
 * @returns {string} the login-page URL.
 */
function buildGoogleAuthorizeUrl({ clientId, scopes, redirectUri, challenge, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/** Read one token-endpoint JSON body, throwing a readable Error otherwise. */
async function readTokenJson(response, provider) {
  let data = null;
  try {
    data = await response.json();
  } catch {
    throw new Error(`${provider}: token endpoint returned a non-JSON answer`);
  }
  if (!response.ok) {
    const detail = typeof data?.error_description === 'string' ? data.error_description
      : typeof data?.error === 'string' ? data.error
        : `HTTP ${response.status}`;
    throw new Error(`${provider}: ${detail}`);
  }
  return data;
}

/**
 * Exchange a Google authorization code for tokens (Node fetch — no CORS).
 * @param {object} args - { code, clientId, verifier, redirectUri, fetchImpl }
 * @returns {Promise<{accessToken, refreshToken, expiresAt}>} expiresAt is epoch ms (0 = unknown).
 */
async function exchangeGoogleCode({ code, clientId, verifier, redirectUri, fetchImpl = fetch, signal, onController }) {
  const body = new URLSearchParams({
    client_id: clientId,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });
  const response = await fetchWithTimeout(fetchImpl, GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal,
  }, FETCH_TIMEOUT_MS, onController);
  const data = await readTokenJson(response, 'Google');
  if (typeof data.access_token !== 'string' || data.access_token === '') {
    throw new Error('Google: token endpoint returned no access token');
  }
  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : '',
    expiresAt: typeof data.expires_in === 'number' ? Date.now() + data.expires_in * 1000 : 0,
  };
}

/**
 * Best-effort account email for the Authorization card (null when unavailable).
 * @param {object} args - { accessToken, fetchImpl }
 */
async function fetchGoogleEmail({ accessToken, fetchImpl = fetch }) {
  const response = await fetchImpl(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (!response.ok) return null;
  const data = await response.json().catch(() => null);
  return data && typeof data.email === 'string' ? data.email : null;
}

/**
 * Start the GitHub device flow (no client secret required).
 * @param {object} args - { clientId, fetchImpl }
 * @returns {Promise<{deviceCode, userCode, verificationUri, expiresIn, intervalSec}>}
 */
async function startGithubDeviceFlow({ clientId, fetchImpl = fetch, signal, onController }) {
  const body = new URLSearchParams({ client_id: clientId, scope: GITHUB_SCOPES.join(' ') });
  const response = await fetchWithTimeout(fetchImpl, GITHUB_DEVICE_CODE_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal,
  }, FETCH_TIMEOUT_MS, onController);
  const data = await readTokenJson(response, 'GitHub');
  if (typeof data.device_code !== 'string' || typeof data.user_code !== 'string') {
    throw new Error('GitHub: device endpoint returned no codes');
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: typeof data.verification_uri === 'string' ? data.verification_uri : 'https://github.com/login/device',
    expiresIn: typeof data.expires_in === 'number' ? data.expires_in : 900,
    intervalSec: typeof data.interval === 'number' ? data.interval : 5,
  };
}

/** Minimal sleep, injectable for tests. */
function defaultSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Poll the GitHub device endpoint until the user approves (or it expires).
 * @param {object} args - { clientId, deviceCode, intervalSec, expiresIn,
 *   fetchImpl, sleepImpl, shouldStop } shouldStop aborts on popup close.
 * @returns {Promise<{accessToken}>}
 */
async function pollGithubDeviceToken({
  clientId, deviceCode, intervalSec, expiresIn,
  fetchImpl = fetch, sleepImpl = defaultSleep, shouldStop = () => false, signal, onController,
}) {
  const deadline = Date.now() + expiresIn * 1000;
  let waitSec = intervalSec;
  for (;;) {
    if (shouldStop() || signal?.aborted) throw new OAuthCancelledError('GitHub: the login window was closed');
    if (Date.now() >= deadline) throw new Error('GitHub: the device code expired');
    await sleepImpl(waitSec * 1000);
    if (shouldStop() || signal?.aborted) throw new OAuthCancelledError('GitHub: the login window was closed');
    const body = new URLSearchParams({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    const response = await fetchWithTimeout(fetchImpl, GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal,
    }, FETCH_TIMEOUT_MS, onController);
    const data = await response.json().catch(() => ({}));
    if (typeof data.access_token === 'string' && data.access_token !== '') {
      return { accessToken: data.access_token };
    }
    const error = typeof data.error === 'string' ? data.error : `HTTP ${response.status}`;
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      waitSec += 5;
      continue;
    }
    if (error === 'expired_token') throw new Error('GitHub: the device code expired');
    if (error === 'access_denied') throw new Error('GitHub: authorization was denied');
    throw new Error(`GitHub: ${error}`);
  }
}

/**
 * Best-effort GitHub login for the Authorization card (null when unavailable).
 * @param {object} args - { accessToken, fetchImpl }
 */
async function fetchGithubLogin({ accessToken, fetchImpl = fetch }) {
  const response = await fetchImpl(GITHUB_USER_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'User-Agent': 'deepseek-harness' },
  });
  if (!response.ok) return null;
  const data = await response.json().catch(() => null);
  return data && typeof data.login === 'string' ? data.login : null;
}

/**
 * Loopback HTTP server capturing the provider redirect with the auth code.
 * @param {object} args - { onCode, createServer } onCode receives { code, state }.
 * @returns {Promise<{url, close}>} url is the redirect_uri to use.
 */
async function startLoopbackServer({ onCode, createServer = http.createServer } = {}) {
  const server = createServer(async (req, res) => {
    try {
      const target = new URL(req.url || '/', 'http://127.0.0.1');
      if (target.pathname === '/callback') {
        const code = target.searchParams.get('code') || '';
        const state = target.searchParams.get('state') || '';
        const providerError = target.searchParams.get('error') || '';
        if (providerError || !code) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<html><body><h3>Authorization failed</h3></body></html>');
          await onCode?.({ code, state, error: providerError || 'missing_code' });
          return;
        }
        try {
          const result = await onCode?.({ code, state, error: '' });
          if (result?.ok === false) {
            res.writeHead(result.status || 400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<html><body><h3>Authorization failed</h3></body></html>');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<html><body><h3>Authorization complete — this window can be closed</h3></body></html>');
        } catch {
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<html><body><h3>Authorization failed</h3></body></html>');
        }
        return;
      }
    } catch { /* malformed request: fall through to 404 */ }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });
  await new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/callback`,
    close: () => {
      try {
        server.close();
      } catch { /* already closed */ }
    },
  };
}

/**
 * Register the Accounts OAuth IPC surface on the main process.
 * @param {object} deps - { ipcMain, BrowserWindow, getMainWindow,
 *   fetchImpl, createServer } fetchImpl/createServer default to the real ones.
 */
function registerAccountsOAuth({ ipcMain, BrowserWindow, getMainWindow, fetchImpl = fetch, createServer }) {
  let pending = null;

  const send = (channel, payload) => {
    try {
      const win = getMainWindow();
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
    } catch { /* renderer gone */ }
  };

  const isCurrent = flow => pending === flow && !flow.cancelled;
  const trackController = flow => (controller, previous) => {
    if (previous) flow.activeControllers.delete(previous);
    if (controller) flow.activeControllers.add(controller);
  };

  const cleanupPending = (flow) => {
    if (!flow) return;
    if (pending === flow) pending = null;
    flow.cancelled = true;
    clearTimeout(flow.deadlineTimer);
    flow.abortController.abort();
    for (const controller of flow.activeControllers) controller.abort();
    flow.activeControllers.clear();
    try { if (flow.popup && !flow.popup.isDestroyed()) flow.popup.close(); } catch {}
    try { flow.closeServer?.(); } catch {}
    flow.popup = null;
    flow.closeServer = null;
  };

  const finishError = (flow, message, cancelled = false) => {
    if (flow.notified) return;
    flow.notified = true;
    flow.settled = true;
    cleanupPending(flow);
    send('accounts-oauth-error', {
      provider: flow.provider,
      message: String(message || 'unknown error'),
      cancelled,
    });
  };

  const finishSuccess = (flow, payload) => {
    if (!isCurrent(flow) || flow.notified) return false;
    flow.notified = true;
    flow.settled = true;
    cleanupPending(flow);
    send('accounts-oauth-done', { provider: flow.provider, ...payload });
    return true;
  };

  const allowedNavigation = (flow, rawUrl) => {
    try {
      const target = new URL(rawUrl);
      if (flow.provider === 'github') return target.protocol === 'https:' && target.hostname === 'github.com';
      if (target.protocol === 'https:' && target.hostname === 'accounts.google.com') return true;
      return Boolean(flow.redirectUri && target.origin === new URL(flow.redirectUri).origin && target.pathname === '/callback');
    } catch { return false; }
  };

  const openPopup = async (flow, url) => {
    if (!isCurrent(flow)) return false;
    const parent = getMainWindow();
    const popup = new BrowserWindow({
      width: 520,
      height: 660,
      ...(parent && !parent.isDestroyed() ? { parent } : {}),
      modal: false,
      show: false,
      autoHideMenuBar: true,
      frame: true,
      title: 'Вход — облачный сервис',
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
      backgroundColor: '#151517',
    });
    flow.popup = popup;
    popup.webContents?.setWindowOpenHandler?.(() => ({ action: 'deny' }));
    popup.webContents?.on?.('will-navigate', (event, target) => {
      if (!allowedNavigation(flow, target)) event.preventDefault();
    });
    popup.once('ready-to-show', () => {
      try { if (isCurrent(flow) && !popup.isDestroyed()) popup.show(); } catch {}
    });
    popup.on('closed', () => {
      if (!isCurrent(flow) || flow.settled) return;
      finishError(flow, 'the login window was closed', true);
    });
    try {
      await popup.loadURL(url);
    } catch {
      if (isCurrent(flow) && !flow.settled) finishError(flow, 'could not open the login page');
      return false;
    }
    if (!isCurrent(flow)) {
      cleanupPending(flow);
      return false;
    }
    return true;
  };

  const startGoogle = async (flow, clientId) => {
    const { verifier, challenge } = createPkcePair();
    flow.state = randomState();
    flow.deadlineTimer = setTimeout(() => {
      if (isCurrent(flow)) finishError(flow, 'Google: authorization timed out');
    }, GOOGLE_FLOW_LIFETIME_MS);
    const server = await startLoopbackServer({
      ...(createServer ? { createServer } : {}),
      onCode: async ({ code, state, error }) => {
        if (!isCurrent(flow) || flow.settled) return { ok: false, status: 410 };
        if (error) {
          finishError(flow, `Google: ${error}`);
          return { ok: false, status: 400 };
        }
        if (state !== flow.state) {
          finishError(flow, 'Google: OAuth state mismatch');
          return { ok: false, status: 400 };
        }
        try {
          const tokens = await exchangeGoogleCode({
            code, clientId, verifier, redirectUri: flow.redirectUri, fetchImpl,
            signal: flow.abortController.signal, onController: trackController(flow),
          });
          if (!isCurrent(flow)) return { ok: false, status: 410 };
          const email = await fetchGoogleEmail({
            accessToken: tokens.accessToken, fetchImpl,
            signal: flow.abortController.signal, onController: trackController(flow),
          }).catch(() => null);
          if (!isCurrent(flow)) return { ok: false, status: 410 };
          finishSuccess(flow, {
            accountLabel: email || '',
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt: tokens.expiresAt,
          });
          return { ok: true };
        } catch (errorValue) {
          if (isCurrent(flow)) finishError(flow, errorValue?.message || errorValue, errorValue?.code === OAUTH_CANCELLED);
          return { ok: false, status: 500 };
        }
      },
    });
    flow.closeServer = server.close;
    flow.redirectUri = server.url;
    if (!isCurrent(flow)) {
      cleanupPending(flow);
      return false;
    }
    const url = buildGoogleAuthorizeUrl({
      clientId,
      scopes: GOOGLE_SCOPES[flow.provider],
      redirectUri: server.url,
      challenge,
      state: flow.state,
    });
    return openPopup(flow, url);
  };

  const startGithub = async (flow, clientId) => {
    const device = await startGithubDeviceFlow({
      clientId, fetchImpl, signal: flow.abortController.signal, onController: trackController(flow),
    });
    if (!isCurrent(flow)) {
      cleanupPending(flow);
      return null;
    }
    if (!await openPopup(flow, device.verificationUri)) return null;
    void (async () => {
      try {
        const { accessToken } = await pollGithubDeviceToken({
          clientId,
          deviceCode: device.deviceCode,
          intervalSec: device.intervalSec,
          expiresIn: device.expiresIn,
          fetchImpl,
          signal: flow.abortController.signal,
          onController: trackController(flow),
          shouldStop: () => !isCurrent(flow),
        });
        if (!isCurrent(flow)) return;
        const login = await fetchGithubLogin({
          accessToken, fetchImpl, signal: flow.abortController.signal, onController: trackController(flow),
        }).catch(() => null);
        if (!isCurrent(flow)) return;
        finishSuccess(flow, { accountLabel: login || '', accessToken, refreshToken: '', expiresAt: 0 });
      } catch (errorValue) {
        if (isCurrent(flow)) finishError(flow, errorValue?.message || errorValue, errorValue?.code === OAUTH_CANCELLED);
      }
    })();
    return { userCode: device.userCode, verificationUri: device.verificationUri, expiresIn: device.expiresIn };
  };

  ipcMain.handle('accounts-oauth-start', async (_event, args) => {
    const provider = args && typeof args.provider === 'string' ? args.provider : '';
    const clientId = args && typeof args.clientId === 'string' ? args.clientId.trim() : '';
    if (!GOOGLE_PROVIDERS.has(provider) && provider !== 'github') return { ok: false, error: `unknown provider: ${provider}` };
    if (clientId === '') return { ok: false, error: 'empty Client ID' };
    if (pending) cleanupPending(pending);
    const flow = {
      provider,
      popup: null,
      closeServer: null,
      state: '',
      redirectUri: '',
      settled: false,
      cancelled: false,
      notified: false,
      deadlineTimer: null,
      abortController: new AbortController(),
      activeControllers: new Set(),
    };
    pending = flow;
    try {
      if (GOOGLE_PROVIDERS.has(provider)) {
        const opened = await startGoogle(flow, clientId);
        return opened && isCurrent(flow) ? { ok: true } : { ok: false, error: 'login was superseded' };
      }
      const device = await startGithub(flow, clientId);
      return device && isCurrent(flow) ? { ok: true, device } : { ok: false, error: 'login was superseded' };
    } catch (errorValue) {
      if (isCurrent(flow)) finishError(flow, errorValue?.message || errorValue, errorValue?.code === OAUTH_CANCELLED);
      else cleanupPending(flow);
      return { ok: false, error: errorValue?.message || String(errorValue) };
    }
  });

  ipcMain.handle('accounts-oauth-cancel', async () => {
    if (pending) finishError(pending, 'cancelled by user', true);
    return { ok: true };
  });
}

module.exports = {
  GOOGLE_AUTH_URL,
  GOOGLE_TOKEN_URL,
  GITHUB_DEVICE_CODE_URL,
  FETCH_TIMEOUT_MS,
  OAUTH_CANCELLED,
  OAuthCancelledError,
  fetchWithTimeout,
  buildGoogleAuthorizeUrl,
  createPkcePair,
  randomState,
  exchangeGoogleCode,
  fetchGoogleEmail,
  startGithubDeviceFlow,
  pollGithubDeviceToken,
  fetchGithubLogin,
  startLoopbackServer,
  registerAccountsOAuth,
};

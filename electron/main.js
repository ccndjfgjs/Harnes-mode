// electron/main.js — Seamless Single-Window Launcher
const { app, BrowserWindow, desktopCapturer, ipcMain, powerSaveBlocker, screen, session } = require('electron');
const { execFile, spawn } = require('child_process');
const { promisify } = require('node:util');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const net = require('node:net');
const { V2RayClient, parseShareLink, parseSubscription, fetchSubscription } = require('./v2ray');
const { registerAccountsOAuth } = require('./oauth-flow');
let portfinder;
try {
  portfinder = require('portfinder');
} catch (err) {
  console.error('[DeepSeek Harness] Missing dependency "portfinder". Launch via Harness_Browser.bat (auto-installs) or run `pnpm install`.');
  const { dialog } = require('electron');
  app.whenReady().then(() => {
    dialog.showErrorBox(
      'DeepSeek Harness — нет зависимостей',
      'Не найден модуль portfinder.\nЗапустите через Harness_Browser.bat (сам доустановит) или выполните:\n\npnpm install'
    );
    app.exit(1);
  });
  // Stub so the module stays loadable until the app exits
  portfinder = { basePort: 3000, getPortPromise: async () => { throw new Error('portfinder missing'); } };
}

// TEMP/E2E: allow loopback CDP diagnostics in development only. Chromium's
// remote-debugging server binds locally; no permissive remote-allow-origins
// switch is needed or enabled.
const debugPort = Number.parseInt(process.env.TB_DEBUG_PORT || '', 10);
if (app.isPackaged !== true && Number.isInteger(debugPort) && debugPort >= 1 && debugPort <= 65535) {
  app.commandLine.appendSwitch('remote-debugging-port', String(debugPort));
}

// --- GPU resilience --------------------------------------------------------
// PERF: smooth minimize/restore + SPA animations.
// - ignore-gpu-blocklist + enable-gpu-rasterization: force hardware compositing
//   (on blocklisted GPUs Chromium falls back to software → all animations stutter).
// - disable-renderer-backgrounding + disable-background-timer-throttling: keep the
//   renderer at full priority while minimized/hidden so restore paints instantly
//   and the native minimize animation doesn't fight a throttled renderer.
// NOTE: the backgrounding flags slightly raise idle CPU while minimized.
//
// The acceleration switches assume the GPU process can start. On hosts where it
// cannot (VMs without a GPU, RDP sessions, some sandboxes) Chromium does NOT
// fall back to software — it aborts the whole browser process with
// "GPU process isn't usable. Goodbye." before any window exists. Two guards:
//
//   1. An escape hatch: `--dsh-software-rendering` (or DSH_SOFTWARE_RENDERING=1)
//      keeps the compositor inside the browser process (--in-process-gpu) and
//      lifts its sandbox, which is the combination that survives a GPU-less
//      host. `--disable-gpu` alone is NOT enough: Chromium still spawns a GPU
//      process and still aborts when that child dies.
//   2. Automatic recovery: the first GPU crash relaunches the app once with
//      that flag, so a user never has to know about it. The relaunch is
//      single-shot by construction — a run that already carries the flag never
//      relaunches again — so a host where even software mode fails cannot enter
//      a restart loop.
const SOFTWARE_RENDERING_FLAG = '--dsh-software-rendering';
const softwareFlagArg = process.argv.find(
  (arg) => arg === SOFTWARE_RENDERING_FLAG || arg.startsWith(`${SOFTWARE_RENDERING_FLAG}=`),
);
/** 'flag' | 'env' | 'crash' when software rendering is on, else null. */
const softwareRenderingReason = softwareFlagArg
  ? (softwareFlagArg.includes('=') ? softwareFlagArg.slice(softwareFlagArg.indexOf('=') + 1) : 'flag')
  : (process.env.DSH_SOFTWARE_RENDERING === '1' ? 'env' : null);
const softwareRendering = softwareRenderingReason !== null;

const PORT_SELECTOR_PATH = path.resolve(__dirname, 'port-selector.html');
let rendererTrustPhase = 'selector';
let trustedHarnessPort = null;

function isTrustedSelectorUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'file:' && path.resolve(fileURLToPath(url)) === PORT_SELECTOR_PATH;
  } catch {
    return false;
  }
}

function isTrustedHarnessUrl(rawUrl) {
  if (!Number.isInteger(trustedHarnessPort)) return false;
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'http:'
      && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
      && url.port === String(trustedHarnessPort)
      && url.username === ''
      && url.password === '';
  } catch {
    return false;
  }
}

function isTrustedRendererUrl(rawUrl) {
  return rendererTrustPhase === 'selector'
    ? isTrustedSelectorUrl(rawUrl)
    : isTrustedHarnessUrl(rawUrl);
}

function isTrustedMainWebContents(webContents, rawUrl = webContents?.getURL?.()) {
  return Boolean(mainWindow && !mainWindow.isDestroyed()
    && webContents === mainWindow.webContents
    && isTrustedRendererUrl(rawUrl));
}

function requireTrustedIpcSender(event) {
  if (!isTrustedMainWebContents(event?.sender)) {
    throw new Error('IPC sender is not trusted');
  }
}

function secureHandle(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    requireTrustedIpcSender(event);
    return handler(event, ...args);
  });
}

function secureOn(channel, handler) {
  ipcMain.on(channel, (event, ...args) => {
    try {
      requireTrustedIpcSender(event);
    } catch (err) {
      console.warn(`[DeepSeek Harness] Blocked untrusted IPC event: ${channel}`);
      return;
    }
    return handler(event, ...args);
  });
}

// --- Media capture permissions ---------------------------------------------
// Electron permission names used here are `media` for getUserMedia and
// `display-capture` for display capture checks. All other permission classes,
// non-main webContents, selector-file requests, and non-loopback origins fail
// closed.
function installCapturePermissionHandlers() {
  const ses = session.defaultSession;
  const isAllowedCapture = (webContents, permission, rawUrl) => {
    return (permission === 'media' || permission === 'display-capture')
      && rendererTrustPhase === 'harness'
      && isTrustedMainWebContents(webContents, rawUrl);
  };

  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(isAllowedCapture(webContents, permission, details?.requestingUrl || webContents?.getURL?.()));
  });
  ses.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    return isAllowedCapture(webContents, permission, details?.requestingUrl || requestingOrigin || webContents?.getURL?.());
  });
  ses.setDisplayMediaRequestHandler((request, callback) => {
    const frameUrl = request?.frame?.url || request?.securityOrigin || '';
    const isMainFrame = request?.frame === mainWindow?.webContents?.mainFrame;
    if (rendererTrustPhase !== 'harness' || !isMainFrame || !isTrustedMainWebContents(mainWindow?.webContents, frameUrl)) {
      callback({});
      return;
    }
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      callback(sources[0] ? { video: sources[0] } : {});
    }).catch(() => {
      callback({});
    });
  }, { useSystemPicker: true });
}

if (softwareRendering) {
  app.commandLine.appendSwitch('in-process-gpu');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  console.warn('[DeepSeek Harness] GPU недоступен — включён программный рендеринг (анимации могут быть менее плавными).');
} else {
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('enable-gpu-rasterization');
}

app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

// Registered before ready so the very first GPU crash is caught. Relaunching
// with the flag carries the reason across, so the selector can explain itself.
// The latch is load-bearing: the GPU child is respawned and crashes several
// times before the browser gives up, and app.exit is asynchronous, so without
// it the handler would spawn one instance per crash.
let gpuRelaunchIssued = false;
app.on('child-process-gone', (_event, details) => {
  if (softwareRendering || gpuRelaunchIssued || details?.type !== 'GPU') return;
  gpuRelaunchIssued = true;
  console.warn(`[DeepSeek Harness] GPU-процесс упал (${details.reason}) — перезапуск в программном режиме.`);
  app.relaunch({ args: [...process.argv.slice(1), `${SOFTWARE_RENDERING_FLAG}=crash`] });
  app.exit(0);
});

const REPO_ROOT = path.resolve(__dirname, '..');
const BASE_PORT = 3000;
const STATE_FILENAME = 'windowState.json';

function resolveBrandIconPath() {
  const candidates = [process.env.DSH_APP_ICON, path.join(__dirname, 'icon.ico'), path.join(__dirname, 'icon.png')].filter(Boolean);
  return candidates.find(candidate => existsSync(candidate)) || null;
}

let backendProcess = null;
let mainWindow = null;
let isLaunching = false;
let v2rayClient = null;
// stdout копится только ДО захвата readiness-строки (она может разорваться
// между chunk'ами), после захвата ссылка отпускается — память не растёт весь сеанс.
let backendStdout = '';
// Readiness-URL захватывается ровно один раз в момент прихода из stdout.
let backendReadyUrl = null;
// Флаг «текущий бэкенд завершился» — ранний выход waitForBackend.
let backendExitObserved = false;
// ИЗМЕНЕНО: константа вместо литерала в горячем обработчике stdout.
const BACKEND_READY_URL_RE = /dsh web:\s+(https?:\/\/[^\s]+)/;
const BACKEND_LOG_TAIL_LIMIT = 128 * 1024;

function maskSensitiveUrlTokens(value) {
  return String(value).replace(/([?&]token=)[^&#\s]+/gi, '$1[REDACTED]');
}

function appendLogTail(current, chunk) {
  const combined = current + String(chunk);
  return combined.length > BACKEND_LOG_TAIL_LIMIT
    ? combined.slice(combined.length - BACKEND_LOG_TAIL_LIMIT)
    : combined;
}

portfinder.basePort = BASE_PORT;

// --- Window state persistence (bounds + fullscreen) ---
function getStatePath() {
  try {
    return path.join(app.getPath('userData'), STATE_FILENAME);
  } catch {
    return path.join(REPO_ROOT, 'electron', STATE_FILENAME);
  }
}

function loadWindowState() {
  try {
    const raw = readFileSync(getStatePath(), 'utf8');
    const s = JSON.parse(raw);
    if (!s || typeof s !== 'object') return null;
    return s;
  } catch {
    return null;
  }
}

function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const s = { bounds: win.getBounds(), fullscreen: win.isFullScreen() };
    writeFileSync(getStatePath(), JSON.stringify(s));
  } catch (err) {
    console.error('Failed to save window state:', err);
  }
}

// --- PERF: pre-warm IPC channels so the first real click has no cold-start cost ---
function prewarmIPCChannels(win) {
  try {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    // Push current states through the real channels: warms the send path in
    // main and gives the renderer correct initial glyphs before any click.
    win.webContents.send('maximize-changed', win.isMaximized());
    win.webContents.send('fullscreen-changed', win.isFullScreen());
  } catch (err) {
    console.error('IPC prewarm failed:', err);
  }
}

// --- Single window: loads port-selector first, then loadURL in place ---
function createMainWindow() {
  rendererTrustPhase = 'selector';
  trustedHarnessPort = null;
  v2rayClient = new V2RayClient(REPO_ROOT, app.getPath('userData'));
  const state = loadWindowState();
  const iconPath = resolveBrandIconPath();
  mainWindow = new BrowserWindow({
    width: state?.bounds?.width ?? 1280,
    height: state?.bounds?.height ?? 800,
    x: state?.bounds?.x,
    y: state?.bounds?.y,
    show: false,
    title: 'DeepSeek Harness',
    frame: false, // Custom titlebar (port-selector.html)
    titleBarStyle: 'hidden', // macOS: hide native titlebar
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // A backgrounded window is throttled by default: timers slow to roughly
      // once a minute, which would stall a screen broadcast the moment the
      // window is minimised. The capture is meant to keep running in the
      // background, so the throttle is off.
      backgroundThrottling: false,
    },
    backgroundColor: '#151517',
  });
  // Fullscreen must be applied after creation, before show
  if (state?.fullscreen) mainWindow.setFullScreen(true);

  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const blockUntrustedNavigation = (event, targetUrl) => {
    if (!isTrustedRendererUrl(targetUrl)) event.preventDefault();
  };
  mainWindow.webContents.on('will-navigate', blockUntrustedNavigation);
  mainWindow.webContents.on('will-redirect', blockUntrustedNavigation);

  // The renderer path this run took is handed to the selector as a query
  // parameter instead of over IPC: it is known before the window exists, and a
  // synchronous read cannot race the first paint. Absent when hardware
  // compositing is active, so the selector stays silent by default.
  mainWindow.loadFile(
    PORT_SELECTOR_PATH,
    softwareRendering ? { query: { gpu: softwareRenderingReason } } : undefined,
  );
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    prewarmIPCChannels(mainWindow);
  });

  // Voice status helper (dedup)
  let lastStatusText = ''
  let lastStatusAt = 0
  const sendAppStatus = (text) => {
    const now = Date.now()
    if (text === lastStatusText && now - lastStatusAt < 800) return
    lastStatusText = text; lastStatusAt = now
    try { if (!mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('voice-app-status', text) } catch {}
  }
  const sendAppStatusDelayed = (text) => {
    setTimeout(() => sendAppStatus(text), 250)
  }

  // Forward OS-level fullscreen changes to renderer checkbox + voice
  mainWindow.on('enter-full-screen', () => {
    if (!mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('fullscreen-changed', true);
    sendAppStatus('Приложение в полноэкранном режиме')
  });
  mainWindow.on('leave-full-screen', () => {
    if (!mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('fullscreen-changed', false);
    sendAppStatus('Приложение в окне')
  });

  // Forward maximize changes (custom titlebar glyph) + voice status
  mainWindow.on('maximize', () => {
    if (!mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('maximize-changed', true);
    sendAppStatus('Приложение развёрнуто')
  });
  mainWindow.on('unmaximize', () => {
    if (!mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('maximize-changed', false);
    sendAppStatus('Приложение в окне')
  });
  mainWindow.on('minimize', () => sendAppStatus('Приложение свёрнуто'))
  mainWindow.on('restore', () => sendAppStatusDelayed('Приложение развёрнуто'))
  // Clicking the taskbar/dock/shortcut icon when minimized triggers show on some platforms
  mainWindow.on('show', () => sendAppStatusDelayed('Приложение развёрнуто'))

  // Window-scoped keys (no system-wide globalShortcut hijack):
  // F11 = toggle native fullscreen; Escape = exit fullscreen only (noop otherwise)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || mainWindow.isDestroyed()) return;
    if (input.key === 'F11') {
      event.preventDefault();
      try {
        mainWindow.setFullScreen(!mainWindow.isFullScreen());
      } catch (err) {
        console.error('F11 fullscreen toggle failed:', err);
      }
    } else if (input.key === 'Escape' && mainWindow.isFullScreen()) {
      event.preventDefault();
      try {
        mainWindow.setFullScreen(false); // exit to windowed mode only
      } catch (err) {
        console.error('Escape exit-fullscreen failed:', err);
      }
      // NOT fullscreen -> do nothing (never minimize/close here)
    }
  });

  // Persist state on close + synchronous backend kill fallback
  mainWindow.on('close', () => {
    saveWindowState(mainWindow);
    void v2rayClient?.stop();
    killBackendSync();
  });
  mainWindow.on('closed', () => {
    // A blocker outliving the window would hold the display awake for nothing.
    releaseBroadcastBlocker();
    mainWindow = null;
  });
}

// FIX #1: .on instead of .once — survives renderer reload (Cmd+R)
secureOn('selector-ready', async (event) => {
  // ИЗМЕНЕНО: единый путь отправки — порт из portfinder либо BASE_PORT при
  // ошибке; дублировавшийся код с двумя ветками try/catch свёрнут (DRY).
  let freePort = BASE_PORT;
  try {
    freePort = await portfinder.getPortPromise();
  } catch (err) {
    console.error('Port finder failed:', err);
  }
  const isFullscreen = mainWindow ? mainWindow.isFullScreen() : false;
  if (!event.sender.isDestroyed()) event.sender.send('suggested-port', freePort, isFullscreen);
});

// Live port availability check for the selector (dynamic status).
// Tries a real bind: free → { ok: true }; busy/invalid → { ok: false, reason }.
secureHandle('check-port', async (_event, port) => {
  const p = parseInt(port, 10);
  if (Number.isNaN(p) || p < 1 || p > 65535) return { ok: false, reason: 'range' };
  try {
    await new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.once('error', reject);
      srv.listen(p, '127.0.0.1', () => {
        srv.close(() => resolve());
      });
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err && err.code === 'EADDRINUSE' ? 'busy' : 'unavailable' };
  }
});

// --- Backend lifecycle: kill-before-spawn, awaited taskkill ---
function killBackendSync() {
  if (backendProcess && backendProcess.pid) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(backendProcess.pid), '/f', '/t'], {
          windowsHide: true,
          shell: false,
        });
      } else {
        process.kill(-backendProcess.pid, 'SIGKILL');
      }
    } catch (err) {
      console.error('Sync backend kill failed:', err);
    }
    backendProcess = null;
  }
}

async function killBackend() {
  if (backendProcess && backendProcess.pid) {
    const pid = backendProcess.pid;
    backendProcess = null;
    try {
      if (process.platform === 'win32') {
        await new Promise((resolve) => {
          let done = false;
          // ИЗМЕНЕНО: finish гасит 3-секундный страховочный таймер — после
          // завершения taskkill он больше не держит event loop лишние секунды.
          let safetyTimer = null;
          const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(safetyTimer);
            resolve();
          };
          const killer = spawn('taskkill', ['/pid', String(pid), '/f', '/t'], {
            windowsHide: true,
            shell: false,
          });
          killer.once('error', (err) => {
            console.error('taskkill error:', err);
            finish();
          });
          killer.once('exit', finish);
          // Safety: never hang quit longer than 3s
          safetyTimer = setTimeout(finish, 3000);
        });
      } else {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch (err) {
          console.error('Backend kill failed:', err);
        }
      }
    } catch (err) {
      console.error('Backend kill failed:', err);
    }
  }
}

function backendCommand() {
  const appRoot = app.isPackaged ? app.getAppPath() : REPO_ROOT;
  const localCli = path.join(appRoot, 'apps', 'cli', 'lib', 'bin.js');
  if (!existsSync(localCli)) {
    throw new Error(`Local Harness CLI is missing: ${localCli}. Run pnpm.cmd run build first.`);
  }
  const command = app.isPackaged ? process.execPath : (process.env.DSH_NODE_BINARY || 'node');
  return { command, args: [localCli, 'web'], cwd: appRoot, packaged: app.isPackaged };
}

function spawnBackend(port) {
  return new Promise((resolve, reject) => {
    const launch = backendCommand();
    backendStdout = '';
    backendReadyUrl = null;
    backendExitObserved = false;
    backendProcess = spawn(launch.command, [...launch.args, '--port', String(port), '--no-open'], {
      cwd: launch.cwd,
      env: { ...process.env, ...(launch.packaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}), ...(v2rayClient ? v2rayClient.proxyEnv() : {}) },
      windowsHide: true,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // ИЗМЕНЕНО: замыкаем конкретный экземпляр процесса — поздний 'exit'/'error'
    // СТАРОГО бэкенда при перезапуске больше не затирает ссылку на новый.
    const proc = backendProcess;

    if (proc.stdout) {
      proc.stdout.on('data', (d) => {
        console.log(`[dsh:${port}] ${maskSensitiveUrlTokens(d)}`);
        // ИЗМЕНЕНО: regex только до захвата URL; дальше буфер не копится
        // и никакой проверки в тике опроса готовности не выполняется.
        if (backendReadyUrl === null) {
          backendStdout = appendLogTail(backendStdout, d);
          const match = backendStdout.match(BACKEND_READY_URL_RE);
          if (match && match[1]) {
            backendReadyUrl = match[1];
            backendStdout = '';
          }
        }
      });
    }
    if (proc.stderr) {
      proc.stderr.on('data', (d) => console.error(`[dsh:${port} ERR] ${maskSensitiveUrlTokens(d)}`));
    }
    proc.on('error', (err) => {
      // ИЗМЕНЕНО: обнуляем только если это всё ещё текущий процесс.
      if (backendProcess === proc) {
        backendProcess = null;
        backendExitObserved = true;
      }
      reject(err);
    });
    proc.on('exit', (code) => {
      console.log(`Backend exited: ${code}`);
      // Don't null here if killBackend already cleared — harmless either way
      if (backendProcess === proc) {
        backendProcess = null;
        backendExitObserved = true;
      }
    });
    resolve();
  });
}

// The backend's readiness line: `dsh web: http://127.0.0.1:<port>/?token=...`.
// Load that exact URL so the launch-token exchange mints the browser cookie and
// the SPA routes to `/` instead of answering 401.
function authenticatedUrl(port) {
  // ИЗМЕНЕНО: готовый URL из однократного захвата вместо regex по всему
  // накопленному stdout на каждый вызов; контракт тот же — URL или fallback.
  if (backendReadyUrl !== null) return backendReadyUrl;
  return `http://localhost:${port}`;
}

// FIX #3: health-check instead of fixed setTimeout (cold boot ~30-45s)
async function waitForBackend(port, maxMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    // The backend prints `dsh web: http://...?token=...` only once the whole
    // plugin tree settled and the frontend fallback is registered. Before that
    // the socket already accepts, but `/` answers 401/404. Treat the printed
    // authenticated URL as the readiness signal.
    if (backendReadyUrl !== null) return true;
    // ИЗМЕНЕНО: мёртвый бэкенд — тот же контракт ошибки, но сразу,
    // а не по истечении maxMs.
    if (backendExitObserved) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
  return backendReadyUrl !== null;
}

function safeSend(sender, channel, ...payload) {
  try {
    if (!sender.isDestroyed()) sender.send(channel, ...payload);
  } catch (err) {
    console.error(`IPC send ${channel} failed:`, err);
  }
}

// V2Ray is an optional, user-configured local proxy. It never changes traffic unless enabled.
const unavailableV2RayStatus = () => ({
  running: false,
  binaryAvailable: false,
  socksPort: null,
  httpPort: null,
});
secureHandle('v2ray-status', () => v2rayClient ? v2rayClient.status() : unavailableV2RayStatus());
secureHandle('v2ray-start', async (_event, settings) => {
  if (!v2rayClient) throw new Error('V2Ray client is not initialized');
  return await v2rayClient.start(settings || {});
});
secureHandle('v2ray-stop', async () => { await v2rayClient?.stop(); return v2rayClient?.status() ?? unavailableV2RayStatus(); });
secureHandle('v2ray-test', async () => {
  if (!v2rayClient) throw new Error('V2Ray client is not initialized');
  return await v2rayClient.test();
});

/**
 * Install the V2Ray core binary from the launcher window.
 *
 * The installer script already enforces checksum verification and writes the
 * files into installer/resources/v2ray. This IPC wraps it for the first screen
 * so users can install the core without leaving the app.
 */
let v2rayInstallPromise = null;

function runV2RayCoreInstaller() {
  return new Promise((resolve) => {
    const script = path.join(REPO_ROOT, 'scripts', 'setup-v2ray-core.mjs');
    const child = spawn(process.execPath, [script], {
      cwd: REPO_ROOT,
      env: { ...process.env },
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    let done = false;
    let stdoutLines = '';
    let stderrLines = '';
    const idleTimeoutMs = Number(process.env.DSH_V2RAY_INSTALL_IDLE_TIMEOUT_MS ?? '45000');
    let idleTimer = null;

    const emitInstallProgress = (percent, message, details = {}) => {
      try {
        if (!mainWindow?.webContents?.isDestroyed()) {
          mainWindow.webContents.send('v2ray-install-progress', { percent, message, ...details });
        }
      } catch {}
    };

    const armIdleWatchdog = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        const logs = `${out}\n${err}`.trim();
        emitInstallProgress(100, 'Установка остановлена: нет активности');
        finish({
          ok: false,
          status: v2rayClient?.status() ?? unavailableV2RayStatus(),
          message: `Установка остановлена: не было активности ${String(idleTimeoutMs)} мс. Проверьте сеть и повторите.`,
          logs,
        });
      }, idleTimeoutMs);
    };

    const parseProgressLines = (chunk, source) => {
      const data = String(chunk);
      const previousTail = source === 'stdout' ? stdoutLines : stderrLines;
      const lines = `${previousTail}${data}`.split(/\r?\n/);
      const tail = appendLogTail('', lines.pop() ?? '');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('[v2ray-progress]')) continue;
        const json = trimmed.slice('[v2ray-progress]'.length).trim();
        try {
          const payload = JSON.parse(json);
          if (typeof payload.percent === 'number') {
            emitInstallProgress(
              payload.percent,
              typeof payload.message === 'string' ? payload.message : 'Установка V2Ray…',
              {
                loadedBytes: typeof payload.loadedBytes === 'number' ? payload.loadedBytes : undefined,
                totalBytes: typeof payload.totalBytes === 'number' ? payload.totalBytes : undefined,
              },
            );
            armIdleWatchdog();
          }
        } catch {}
      }
      if (source === 'stdout') stdoutLines = tail;
      else stderrLines = tail;
    };

    const finish = (payload) => {
      if (done) return;
      done = true;
      clearTimeout(idleTimer);
      resolve(payload);
    };

    armIdleWatchdog();
    child.stdout?.on('data', (chunk) => { out = appendLogTail(out, chunk); parseProgressLines(chunk, 'stdout'); armIdleWatchdog(); });
    child.stderr?.on('data', (chunk) => { err = appendLogTail(err, chunk); parseProgressLines(chunk, 'stderr'); armIdleWatchdog(); });

    child.once('error', (error) => {
      finish({
        ok: false,
        status: v2rayClient?.status() ?? unavailableV2RayStatus(),
        message: error instanceof Error ? error.message : String(error),
        logs: `${out}\n${err}`.trim(),
      });
    });
    child.once('exit', (code) => {
      const logs = `${out}\n${err}`.trim();
      if (code === 0) {
        const status = v2rayClient?.status() ?? unavailableV2RayStatus();
        finish({ ok: true, status, logs });
        return;
      }
      const lines = logs.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      const reversed = [...lines].reverse();
      const friendly = reversed.find(line => line.startsWith('[v2ray] setup failed:'))
        ?? reversed.find(line => line.startsWith('[v2ray]'))
        ?? 'Не удалось установить V2Ray. Проверьте подключение к сети и повторите.';
      finish({ ok: false, status: v2rayClient?.status() ?? unavailableV2RayStatus(), message: friendly, logs });
    });
  });
}

function installV2RayCoreFromLauncher() {
  if (v2rayInstallPromise) return v2rayInstallPromise;
  v2rayInstallPromise = runV2RayCoreInstaller().finally(() => {
    v2rayInstallPromise = null;
  });
  return v2rayInstallPromise;
}

secureHandle('v2ray-install-core', () => installV2RayCoreFromLauncher());

/**
 * Remove the V2Ray core binary from the launcher window.
 *
 * The tunnel is stopped first and unconditionally: on Windows a running
 * `v2ray.exe` is held open by the process, and the delete would fail with a
 * locked-file error that says nothing useful. Stopping is best-effort because a
 * tunnel that was never started has nothing to stop.
 *
 * The removal itself runs in a child process for the same reason the installer
 * does: the file operations must not depend on the renderer, and a partial
 * failure must be reportable rather than fatal.
 */
let v2rayRemovePromise = null;

function runV2RayCoreRemover() {
  return new Promise((resolve) => {
    const script = path.join(REPO_ROOT, 'scripts', 'remove-v2ray-core.mjs');
    const child = spawn(process.execPath, [script], {
      cwd: REPO_ROOT,
      env: { ...process.env },
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    let done = false;

    const finish = (payload) => {
      if (done) return;
      done = true;
      resolve(payload);
    };

    child.stdout?.on('data', (chunk) => { out = appendLogTail(out, chunk); });
    child.stderr?.on('data', (chunk) => { err = appendLogTail(err, chunk); });

    child.once('error', (error) => {
      finish({
        ok: false,
        status: v2rayClient?.status() ?? unavailableV2RayStatus(),
        message: error instanceof Error ? error.message : String(error),
        logs: `${out}\n${err}`.trim(),
      });
    });

    child.once('exit', (code) => {
      const logs = `${out}\n${err}`.trim();
      if (code === 0) {
        finish({ ok: true, status: v2rayClient?.status() ?? unavailableV2RayStatus(), logs });
        return;
      }
      const lines = logs.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      const reversed = [...lines].reverse();
      const friendly = reversed.find(line => line.startsWith('[v2ray] removal failed:'))
        ?? reversed.find(line => line.startsWith('[v2ray]'))
        ?? 'Не удалось удалить V2Ray. Закройте приложение и повторите.';
      finish({ ok: false, status: v2rayClient?.status() ?? unavailableV2RayStatus(), message: friendly, logs });
    });
  });
}

function removeV2RayCoreFromLauncher() {
  if (v2rayRemovePromise) return v2rayRemovePromise;
  v2rayRemovePromise = (async () => {
    try {
      await v2rayClient?.stop();
    } catch { /* nothing to stop, or already stopped */ }
    return await runV2RayCoreRemover();
  })().finally(() => {
    v2rayRemovePromise = null;
  });
  return v2rayRemovePromise;
}

secureHandle('v2ray-remove-core', () => removeV2RayCoreFromLauncher());

// --- Server list: links, subscriptions, selection, persistence ---
// The launcher window and the in-app settings page are two faces of one document,
// so both go through these handlers rather than keeping state of their own.

function requireV2RayClient() {
  if (!v2rayClient) throw new Error('V2Ray client is not initialized');
  return v2rayClient;
}

secureHandle('v2ray-settings', () => requireV2RayClient().readSettings());

secureHandle('v2ray-save', (_event, patch) => requireV2RayClient().writeSettings(patch || {}));

// --- Launcher accessibility: one checkbox in the selector window -------------
// The file stores only the checkbox ({ enabled }). The Harness-side document
// (localStorage `dsh.accessibility.settings`, the same one the Accessibility
// page edits) is merged by the preload running in the Harness origin, so the
// menu and the checkbox always show one setting, never two.
const LAUNCHER_A11Y_FILENAME = 'launcher-a11y.json';

function launcherA11yPath() {
  try {
    return path.join(app.getPath('userData'), LAUNCHER_A11Y_FILENAME);
  } catch {
    return path.join(REPO_ROOT, 'electron', LAUNCHER_A11Y_FILENAME);
  }
}

function readLauncherA11y() {
  try {
    const raw = readFileSync(launcherA11yPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad document');
    return {
      enabled: parsed.enabled === true,
      speakPress: parsed.speakPress === true,
      speakHover: parsed.speakHover === true,
    };
  } catch {
    return { enabled: false, speakPress: false, speakHover: false };
  }
}

function writeLauncherA11y(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Bad launcher accessibility patch');
  const next = {
    enabled: patch.enabled === true,
    speakPress: patch.speakPress === true,
    speakHover: patch.speakHover === true,
  };
  try {
    require('node:fs').mkdirSync(path.dirname(launcherA11yPath()), { recursive: true });
  } catch {
    // userData exists in practice; a missing dir fails loudly on write below.
  }
  writeFileSync(launcherA11yPath(), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
}

secureHandle('a11y-settings', () => readLauncherA11y());

secureHandle('a11y-save', (_event, patch) => writeLauncherA11y(patch || {}));

// --- Self-update: check GitHub, describe, pull --------------------------------
// "New version" means any new commit on origin/master. The window asks first
// and shows the commit list; pulling never runs while the tree has tracked
// changes (untracked scraps like logs cannot block it). After a pull the
// built backend is stale, so its entry file is removed and the next launcher
// run rebuilds it through the normal build branch.
const UPDATE_STATE_FILENAME = 'launcher-update.json';
const execFileAsync = promisify(execFile);

function updateStatePath() {
  try {
    return path.join(app.getPath('userData'), UPDATE_STATE_FILENAME);
  } catch {
    return path.join(REPO_ROOT, 'electron', UPDATE_STATE_FILENAME);
  }
}

function readUpdateState() {
  try {
    const raw = readFileSync(updateStatePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad document');
    return {
      skippedCommit: typeof parsed.skippedCommit === 'string' ? parsed.skippedCommit : '',
      previousCommit: typeof parsed.previousCommit === 'string' ? parsed.previousCommit : '',
    };
  } catch {
    return { skippedCommit: '', previousCommit: '' };
  }
}

function writeUpdateState(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Bad update state patch');
  const current = readUpdateState();
  const next = {
    skippedCommit: typeof patch.skippedCommit === 'string' ? patch.skippedCommit : current.skippedCommit,
    previousCommit: typeof patch.previousCommit === 'string' ? patch.previousCommit : current.previousCommit,
  };
  try {
    require('node:fs').mkdirSync(path.dirname(updateStatePath()), { recursive: true });
  } catch {
    // userData exists in practice; a missing dir fails loudly on write below.
  }
  writeFileSync(updateStatePath(), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
}

function gitAsync(args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    execFileAsync('git', args, { cwd: REPO_ROOT, timeout: timeoutMs, windowsHide: true })
      .then(({ stdout }) => resolve({ ok: true, out: String(stdout || '') }))
      .catch((err) => {
        const detail = err && (err.stderr || err.stdout || err.message);
        resolve({ ok: false, error: String(detail || err).split('\n')[0], timeout: Boolean(err && err.killed) });
      });
  });
}

/**
 * Whether a git failure looks like a dead/slow network rather than a repo
 * problem: timeouts and DNS/connect errors get a human message instead of
 * the raw command line.
 */
function isNetworkGitError(result) {
  if (result && result.timeout) return true;
  return /timeout|timed out|connect|resolve|handshake|TLS|SSL|proxy|empty reply|reset by peer|econn|enet|eai_|ehost|epipe|enotfound/i
    .test(String((result && result.error) || ''));
}

function parseUpdateLog(out) {
  return String(out || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [hash, date, ...rest] = line.split('|');
      return { hash: String(hash || ''), short: String(hash || '').slice(0, 7), date: String(date || ''), subject: rest.join('|') };
    })
    .filter((entry) => /^[0-9a-f]{40}$/.test(entry.hash));
}

secureHandle('update-check', async () => {
  const remote = await gitAsync(['ls-remote', 'origin', 'refs/heads/master']);
  if (!remote.ok) {
    throw new Error(isNetworkGitError(remote)
      ? 'Не удалось спросить GitHub: нет сети. Попробуйте ещё раз.'
      : `Не удалось спросить GitHub: ${remote.error}`);
  }
  const remoteHash = remote.out.trim().split(/\s+/)[0] || '';
  if (!/^[0-9a-f]{40}$/.test(remoteHash)) throw new Error('GitHub ответил непонятно.');
  const local = await gitAsync(['rev-parse', 'HEAD']);
  const localHash = local.ok ? local.out.trim() : '';
  const stated = readUpdateState().previousCommit;
  const previous = /^[0-9a-f]{40}$/.test(stated) ? stated : '';
  if (remoteHash === localHash) return { upToDate: true, local: localHash, remote: remoteHash, previous };
  const fetched = await gitAsync(['fetch', 'origin', 'master'], 60000);
  if (!fetched.ok) {
    throw new Error(isNetworkGitError(fetched)
      ? 'Не удалось скачать список изменений: сеть оборвалась. Попробуйте ещё раз.'
      : `Не удалось скачать описание: ${fetched.error}`);
  }
  const log = await gitAsync(['log', `${localHash}..FETCH_HEAD`, '--format=%H|%ad|%s', '--date=short', '--max-count=30']);
  const commits = log.ok ? parseUpdateLog(log.out) : [];
  return {
    upToDate: false,
    local: localHash,
    remote: remoteHash,
    commits,
    skipped: readUpdateState().skippedCommit === remoteHash,
    previous,
  };
});

secureHandle('update-skip', (_event, hash) => writeUpdateState({ skippedCommit: String(hash || '') }));

secureHandle('update-apply', async () => {
  const status = await gitAsync(['status', '--porcelain', '--untracked-files=no']);
  if (!status.ok) throw new Error(`Не удалось проверить папку: ${status.error}`);
  if (status.out.trim() !== '') {
    throw new Error('В папке есть несохранённые изменения — обновление отказался, чтобы их не потерять.');
  }
  const before = await gitAsync(['rev-parse', 'HEAD']);
  const beforeHash = before.ok ? before.out.trim() : '';
  const pulled = await gitAsync(['pull', '--ff-only', 'origin', 'master'], 120000);
  if (!pulled.ok) {
    throw new Error(isNetworkGitError(pulled)
      ? 'Не удалось подтянуть: сеть оборвалась. Попробуйте ещё раз.'
      : `Не удалось подтянуть: ${pulled.error}`);
  }
  // The sources moved but the built files did not: drop the backend entry so
  // the launcher rebuilds through its normal build branch on the next run.
  try {
    require('node:fs').unlinkSync(path.join(REPO_ROOT, 'apps', 'cli', 'lib', 'bin.js'));
  } catch {
    // Already unbuilt (fresh clone): the build branch handles it.
  }
  const head = await gitAsync(['rev-parse', 'HEAD']);
  const headHash = head.ok ? head.out.trim() : '';
  // Remember where we came from, so rollback stays available after restarts.
  // A no-op pull keeps the older memory instead of pointing at itself.
  if (/^[0-9a-f]{40}$/.test(beforeHash) && beforeHash !== headHash) {
    writeUpdateState({ previousCommit: beforeHash });
  }
  return { ok: true, head: headHash };
});

secureHandle('update-rollback', async () => {
  const target = readUpdateState().previousCommit;
  if (!/^[0-9a-f]{40}$/.test(target)) {
    throw new Error('Нечего откатывать: версия до обновления не запомнена.');
  }
  const head = await gitAsync(['rev-parse', 'HEAD']);
  const headHash = head.ok ? head.out.trim() : '';
  if (headHash === target) throw new Error('Вы уже на этой версии.');
  const status = await gitAsync(['status', '--porcelain', '--untracked-files=no']);
  if (!status.ok) throw new Error(`Не удалось проверить папку: ${status.error}`);
  if (status.out.trim() !== '') {
    throw new Error('В папке есть несохранённые изменения — откат отказался, чтобы их не потерять.');
  }
  const reset = await gitAsync(['reset', '--hard', target], 60000);
  if (!reset.ok) throw new Error(`Не удалось откатить: ${reset.error}`);
  try {
    require('node:fs').unlinkSync(path.join(REPO_ROOT, 'apps', 'cli', 'lib', 'bin.js'));
  } catch {
    // Already unbuilt: the build branch handles it.
  }
  // Swap the memory so the road back stays paved too.
  if (/^[0-9a-f]{40}$/.test(headHash)) writeUpdateState({ previousCommit: headHash });
  return { ok: true, head: target, previous: headHash };
});

// A pasted block may hold one link or a whole list, so the text is split first and
// each line parsed: that is what makes "paste everything you copied" work.
secureHandle('v2ray-import-link', (_event, text) => {
  const client = requireV2RayClient();
  const trimmed = String(text || '').trim();
  if (trimmed === '') throw new Error('Вставьте ссылку на сервер');
  const single = parseShareLink(trimmed);
  const servers = single ? [single] : parseSubscription(trimmed);
  if (servers.length === 0) {
    throw new Error('Ссылка не распознана. Подходят vless://, vmess://, trojan:// и ss://');
  }
  return { servers, settings: client.addServers(servers) };
});

secureHandle('v2ray-import-subscription', async (_event, url) => {
  const client = requireV2RayClient();
  const servers = await fetchSubscription(String(url || '').trim());
  return { servers, settings: client.writeSettings({ subscriptionUrl: String(url || '').trim(), servers, activeId: servers[0].id }) };
});

secureHandle('v2ray-select', (_event, id) => requireV2RayClient().writeSettings({ activeId: String(id || '') }));

secureHandle('v2ray-remove', (_event, id) => {
  const client = requireV2RayClient();
  const current = client.readSettings();
  const servers = current.servers.filter(server => server.id !== String(id || ''));
  return client.writeSettings({ servers, activeId: servers[0]?.id ?? '' });
});

// Seamless launch in the SAME window
secureOn('start-harness', async (event, port) => {
  const p = parseInt(port, 10);
  if (Number.isNaN(p) || p < 1 || p > 65535) {
    safeSend(event.sender, 'launch-error', 'Invalid port (1-65535)');
    return;
  }
  if (isLaunching) return;
  isLaunching = true;
  try {
    safeSend(event.sender, 'launch-progress', { stage: 'spawning' });
    // FIX #4: kill old backend before new spawn (re-launch / retry safe)
    await killBackend();
    await spawnBackend(p);

    safeSend(event.sender, 'launch-progress', { stage: 'waiting' });
    const ok = await waitForBackend(p);
    if (!ok) {
      await killBackend();
      safeSend(event.sender, 'launch-error', 'Backend failed to start in time');
      return;
    }

    if (!mainWindow || mainWindow.isDestroyed()) return;
    const win = mainWindow;
    const savedBounds = win.getBounds();
    const savedFullscreen = win.isFullScreen();

    safeSend(event.sender, 'launch-progress', { stage: 'loading' });

    // Restore geometry after loadURL swaps content
    win.webContents.once('did-finish-load', () => {
      try {
        if (savedFullscreen && !win.isFullScreen()) win.setFullScreen(true);
        // setBounds after fullscreen to keep non-fullscreen geometry
        if (!savedFullscreen) win.setBounds(savedBounds);
      } catch (err) {
        console.error('Failed to restore window state:', err);
      }
    });
    win.webContents.once('did-fail-load', (_e, _code, desc) => {
      console.error(`Failed to load http://localhost:${p}: ${desc}`);
      safeSend(event.sender, 'launch-error', `Failed to load UI: ${desc}`);
    });

    trustedHarnessPort = p;
    rendererTrustPhase = 'harness';
    const targetUrl = authenticatedUrl(p);
    if (!isTrustedHarnessUrl(targetUrl)) {
      throw new Error('Бэкенд вернул недоверенный адрес интерфейса');
    }
    await win.loadURL(targetUrl);
  } catch (err) {
    await killBackend();
    if (mainWindow && isTrustedSelectorUrl(mainWindow.webContents.getURL())) {
      rendererTrustPhase = 'selector';
      trustedHarnessPort = null;
    }
    safeSend(event.sender, 'launch-error', err instanceof Error ? err.message : String(err));
  } finally {
    isLaunching = false;
  }
});

// FIX #6: real-time fullscreen toggle (selector phase included)
secureOn('toggle-fullscreen', (_event, enabled) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.setFullScreen(Boolean(enabled));
      // Persist immediately: checkbox = config for next launch,
      // independent of F11 / Maximize live state
      saveWindowState(mainWindow);
    } catch (err) {
      console.error('Fullscreen toggle failed:', err);
    }
  }
});

// Screen broadcast: hold the display awake while frames are being taken.
// A broadcast that stalls on a sleeping display keeps sending the same black
// frame, so the renderer asks for the blocker when sampling starts and releases
// it when sampling ends. The blocker is never left running on its own.
let broadcastBlockerId = null;

function releaseBroadcastBlocker() {
  if (broadcastBlockerId === null) return;
  try {
    if (powerSaveBlocker.isStarted(broadcastBlockerId)) powerSaveBlocker.stop(broadcastBlockerId);
  } catch (err) {
    console.error('Releasing the display blocker failed:', err);
  }
  broadcastBlockerId = null;
}

secureOn('screen-broadcast', (_event, active) => {
  if (Boolean(active)) {
    if (broadcastBlockerId === null) {
      broadcastBlockerId = powerSaveBlocker.start('prevent-display-sleep');
    }
    return;
  }
  releaseBroadcastBlocker();
});

// Fit the window to the selector content once at startup, so the whole
// panel (now taller than the old default) shows without scrolling —
// including the backend-loading phase. Clamped to the work area, never
// touching a maximized/fullscreen window or a size the user chose later.
secureOn('fit-window', (event, contentHeight) => {
  const sender = event.sender;
  setImmediate(() => {
    const win = BrowserWindow.fromWebContents(sender);
    if (!win || win.isDestroyed() || win.isMaximized() || win.isFullScreen()) return;
    const content = Math.max(200, Math.min(Number(contentHeight) || 0, 9000));
    if (!content) return;
    try {
      const wa = screen.getPrimaryDisplay().workArea;
      const bounds = win.getBounds();
      const targetH = Math.min(content, wa.height);
      const y = Math.max(wa.y, Math.min(bounds.y, wa.y + wa.height - targetH));
      win.setBounds({ x: bounds.x, y, width: bounds.width, height: targetH });
      saveWindowState(win);
    } catch (err) {
      console.error('Fit window failed:', err);
    }
  });
});

// Custom titlebar window controls (frameless window)
// PERF: setImmediate keeps the main-process event loop responsive so the
// first click after launch doesn't freeze the UI on a cold IPC path.
secureOn('window-minimize', (event) => {
  const sender = event.sender;
  setImmediate(() => {
    const win = BrowserWindow.fromWebContents(sender);
    if (win && !win.isDestroyed()) win.minimize();
  });
});

// Restore-down size (fraction of work area), tuned with the user.
// Smaller values = smaller window when □ restores from maximized.
const RESTORE_FRACTION_W = 0.7;
const RESTORE_FRACTION_H = 0.75;

// Debounce: a real double-click on the □ button produces two toggle
// requests; native titlebars treat dblclick as ONE toggle. Swallow repeats
// within 400ms so a fast double-click never cancels itself out.
let lastMaximizeToggle = 0;
secureOn('window-maximize', (event) => {
  const now = Date.now();
  if (now - lastMaximizeToggle < 400) return;
  lastMaximizeToggle = now;
  const sender = event.sender;
  // PERF: defer native window ops off the IPC callback tick.
  setImmediate(() => {
    const win = BrowserWindow.fromWebContents(sender);
    if (!win || win.isDestroyed()) return;
    if (win.isMaximized()) {
      // Restore to a comfortably smaller, centered size instead of
      // near-full pre-maximize bounds. Single snap in the same tick:
      // a stepped glide would fight the native DWM unmaximize animation
      // and cross the SPA sidebar collapse breakpoint mid-motion (jerk).
      const wa = screen.getPrimaryDisplay().workArea;
      const w = Math.max(640, Math.round(wa.width * RESTORE_FRACTION_W));
      const h = Math.max(420, Math.round(wa.height * RESTORE_FRACTION_H));
      const x = wa.x + Math.round((wa.width - w) / 2);
      const y = wa.y + Math.round((wa.height - h) / 2);
      try {
        win.unmaximize();
      } catch (err) {
        console.error('Unmaximize failed:', err);
        return;
      }
      try {
        win.setBounds({ x, y, width: w, height: h });
      } catch (err) {
        console.error('Restore bounds failed:', err);
      }
    } else {
      win.maximize();
    }
  });
});

secureOn('window-close', (event) => {
  const sender = event.sender;
  setImmediate(() => {
    const win = BrowserWindow.fromWebContents(sender);
    if (win && !win.isDestroyed()) win.close();
  });
});

// State queries for injected Harness titlebar (initial glyph sync)
secureHandle('is-maximized', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return win ? win.isMaximized() : false;
});

secureHandle('is-fullscreen', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return win ? win.isFullScreen() : false;
});

// App icon for titlebars. Read here because preload runs sandboxed
// (no fs there). Same file the window icon uses; cached after first read.
let cachedAppIconUrl = null;
secureHandle('get-app-icon', () => {
  try {
    if (cachedAppIconUrl !== null) return cachedAppIconUrl;
    cachedAppIconUrl = '';
    const iconPath = resolveBrandIconPath();
    if (iconPath) {
      const mime = path.extname(iconPath).toLowerCase() === '.ico' ? 'image/x-icon' : 'image/png';
      const buf = readFileSync(iconPath);
      if (buf.length > 0) cachedAppIconUrl = `data:${mime};base64,${buf.toString('base64')}`;
    }
  } catch (err) {
    console.error('App icon read failed:', err);
  }
  return cachedAppIconUrl;
});

// Cloud accounts OAuth: the in-app login popup + PKCE loopback / device flow.
// The Accounts settings section drives it via window.harnessAPI.
registerAccountsOAuth({
  ipcMain: { handle: (channel, handler) => secureHandle(channel, handler) },
  BrowserWindow,
  getMainWindow: () => mainWindow,
});

// FIX #5: awaited cleanup on quit
app.on('will-quit', async (e) => {
  if ((backendProcess && backendProcess.pid) || v2rayClient?.status().running) {
    e.preventDefault();
    await Promise.all([killBackend(), v2rayClient?.stop()]);
    app.exit(0);
  }
});

// Single instance lock (prevents double-launch)
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(() => {
    // Session APIs require the ready event; handlers must exist before the
    // window's first getUserMedia/getDisplayMedia call.
    installCapturePermissionHandlers();
    createMainWindow();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

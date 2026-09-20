// electron/preload.js — single-window IPC bridge + Harness UI titlebar injection
const { contextBridge, ipcRenderer } = require('electron');

function onIpc(channel, callback, mapPayload = (_event, value) => value) {
  const handler = (...args) => callback(mapPayload(...args));
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

// App icon for the titlebars. NOTE: preload runs sandboxed here (no fs, no
// __dirname — only require('electron') works), so the icon is read by the
// main process and fetched over IPC. Cached after the first fetch.
let appIconDataUrl = '';

// Document-scoped listeners are attached ONCE per document: if the SPA ever
// drops our bar and buildTitlebar re-runs, re-attaching the click delegation
// would double-fire every IPC (double toggle on □). Guarded by the flag.
let titlebarListenersAttached = false;
async function getAppIconUrl() {
  if (appIconDataUrl) return appIconDataUrl;
  try {
    const url = await ipcRenderer.invoke('get-app-icon');
    if (typeof url === 'string' && url.length > 0) {
      appIconDataUrl = url;
    }
  } catch { /* dot fallback */ }
  return appIconDataUrl;
}

contextBridge.exposeInMainWorld('harnessAPI', {
  // 1. Selector readiness: main sends 'suggested-port' with (port, isFullscreen).
  // Use once per call to avoid duplicates on renderer reload; returns cleanup.
  onReady: (callback) => {
    ipcRenderer.send('selector-ready');
    const handler = (_, port, isFullscreen) => callback(port, isFullscreen);
    ipcRenderer.once('suggested-port', handler);
    return () => ipcRenderer.removeListener('suggested-port', handler);
  },

  // 2. Window controls (custom titlebar, frameless window)
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),

  // 2.1 Fullscreen sync
  toggleFullscreen: (enabled) => ipcRenderer.send('toggle-fullscreen', enabled),
  onFullscreenChanged: (callback) => onIpc('fullscreen-changed', callback),

  // 2.1.1 Screen broadcast: hold the display awake while frames are sampled.
  // The capture engine calls this when a broadcast starts and when it ends.
  setScreenBroadcast: (active) => ipcRenderer.send('screen-broadcast', Boolean(active)),

  // 2.2 Maximize sync (channel 'maximize-changed' — shared with port-selector.html)
  onMaximizedChanged: (callback) => onIpc('maximize-changed', callback),
  // Alias for older selector HTML builds using onMaximizeChanged
  onMaximizeChanged: (callback) => onIpc('maximize-changed', callback),

  // 2.3 State queries (initial glyph sync for injected titlebar)
  isMaximized: () => ipcRenderer.invoke('is-maximized'),
  isFullScreen: () => ipcRenderer.invoke('is-fullscreen'),

  // 2.4 App icon data URL (used by port-selector logo; injected bar uses internal fetch)
  getAppIcon: () => ipcRenderer.invoke('get-app-icon'),

  // 2.5 Live port availability check (dynamic selector status)
  checkPort: (port) => ipcRenderer.invoke('check-port', port),

  // 2.6 Optional V2Ray local proxy lifecycle
  v2rayStatus: () => ipcRenderer.invoke('v2ray-status'),
  v2rayStart: (settings) => ipcRenderer.invoke('v2ray-start', {
    host: String(settings?.host || '').trim(),
    remotePort: Number(settings?.remotePort),
    uuid: String(settings?.uuid || '').trim(),
    // Omitted ports let the main process fall back to the saved document, so a
    // caller that has no port UI (the in-app settings page) does not silently
    // reset ports the launcher window configured.
    ...(settings?.localPort === undefined ? {} : { localPort: Number(settings.localPort) }),
    ...(settings?.httpPort === undefined ? {} : { httpPort: Number(settings.httpPort) }),
    transport: ['ws', 'grpc', 'tcp'].includes(settings?.transport) ? settings.transport : 'tcp',
    security: ['tls', 'reality', 'none'].includes(settings?.security) ? settings.security : 'none',
    serverName: String(settings?.serverName || '').trim(),
    wsPath: String(settings?.wsPath || '').trim(),
    wsHost: String(settings?.wsHost || '').trim(),
    fingerprint: String(settings?.fingerprint || '').trim(),
    publicKey: String(settings?.publicKey || '').trim(),
    shortId: String(settings?.shortId || '').trim(),
    flow: String(settings?.flow || '').trim(),
    server: settings?.server && typeof settings.server === 'object' ? settings.server : undefined,
  }),
  v2rayStop: () => ipcRenderer.invoke('v2ray-stop'),
  v2rayTest: () => ipcRenderer.invoke('v2ray-test'),
  v2rayInstallCore: () => ipcRenderer.invoke('v2ray-install-core'),
  v2rayRemoveCore: () => ipcRenderer.invoke('v2ray-remove-core'),
  onV2RayInstallProgress: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('v2ray-install-progress', handler);
    return () => ipcRenderer.removeListener('v2ray-install-progress', handler);
  },

  // 2.7 Server list: paste a link, load a subscription, pick the active server.
  // Shared by the launcher window and the in-app settings page.
  v2raySettings: () => ipcRenderer.invoke('v2ray-settings'),
  v2raySave: (patch) => ipcRenderer.invoke('v2ray-save', patch || {}),
  v2rayImportLink: (text) => ipcRenderer.invoke('v2ray-import-link', String(text || '')),
  v2rayImportSubscription: (url) => ipcRenderer.invoke('v2ray-import-subscription', String(url || '')),
  v2raySelect: (id) => ipcRenderer.invoke('v2ray-select', String(id || '')),
  v2rayRemove: (id) => ipcRenderer.invoke('v2ray-remove', String(id || '')),

  // 2.8 Launcher accessibility: one checkbox (contrast + voice), stored in main.
  // The Harness-side merge below writes the same localStorage document the
  // Accessibility page edits, so the menu and the checkbox show one setting.
  a11ySettings: () => ipcRenderer.invoke('a11y-settings'),
  a11ySave: (patch) => ipcRenderer.invoke('a11y-save', patch && typeof patch === 'object'
    ? { enabled: patch.enabled === true, speakPress: patch.speakPress === true, speakHover: patch.speakHover === true }
    : {}),

  // 2.9 Self-update: check the repo, hide one version, pull the new one.
  updateCheck: () => ipcRenderer.invoke('update-check'),
  updateSkip: (hash) => ipcRenderer.invoke('update-skip', String(hash || '')),
  updateApply: () => ipcRenderer.invoke('update-apply'),
  updateRollback: () => ipcRenderer.invoke('update-rollback'),

  // 2.10 Fit the window to the selector content height (once at startup).
  fitWindow: (height) => ipcRenderer.send('fit-window', Number(height) || 0),

  // 3. Backend launch
  startHarness: (port) => ipcRenderer.send('start-harness', port),

  // 4. Fatal launch errors
  onLaunchError: (callback) => onIpc('launch-error', callback),

  // 5. Progressive stages: { stage: 'spawning' | 'waiting' | 'loading' }
  onLaunchProgress: (callback) => onIpc('launch-progress', callback),

  // 6. Cloud accounts OAuth (in-app login popup, flow runs in main).
  // start resolves { ok, device? } — device carries the GitHub user code;
  // the finish arrives via onAccountsOAuthDone / onAccountsOAuthError.
  accountsOAuthStart: (args) => ipcRenderer.invoke('accounts-oauth-start', {
    provider: String(args?.provider || ''),
    clientId: String(args?.clientId || ''),
  }),
  accountsOAuthCancel: () => ipcRenderer.invoke('accounts-oauth-cancel'),
  onAccountsOAuthDone: (callback) => {
    const handler = (_, payload) => callback(payload);
    ipcRenderer.on('accounts-oauth-done', handler);
    return () => ipcRenderer.removeListener('accounts-oauth-done', handler);
  },
  onAccountsOAuthError: (callback) => {
    const handler = (_, payload) => callback(payload);
    ipcRenderer.on('accounts-oauth-error', handler);
    return () => ipcRenderer.removeListener('accounts-oauth-error', handler);
  },
});

// ============================================
// ИНЪЕКЦИЯ TITLEBAR В HARNESS UI
// Runs in every page loaded in our window. Injects ONLY into Harness UI
// (localhost). Selector (loadFile, hostname '') and its own #titlebar skip out.
// ============================================

function injectHarnessTitlebar() {
  // Inject ONLY for Harness UI (localhost with port)
  const isHarnessUI = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (!isHarnessUI) return;

  // Don't inject into port-selector (it owns #titlebar)
  if (document.getElementById('titlebar')) return;

  // Don't inject twice
  if (document.getElementById('harness-injected-titlebar')) return;

  return getAppIconUrl().then(() => buildTitlebar());
}

function buildTitlebar() {
  if (document.getElementById('harness-injected-titlebar')) return;

  // Create titlebar element
  const titlebar = document.createElement('div');
  titlebar.id = 'harness-injected-titlebar';
  titlebar.className = 'harness-titlebar';
  titlebar.innerHTML = `
    <div class="tb-drag"><span class="tb-brand-mark"></span><span>DeepSeek Harness</span></div>
    <div class="titlebar-controls">
      <button class="titlebar-btn" id="btnMinimize" aria-label="Свернуть" title="Свернуть">\u2500</button>
      <button class="titlebar-btn" id="btnMaximize" aria-label="Развернуть" title="Развернуть">\u25A1</button>
      <button class="titlebar-btn titlebar-btn-close" id="btnClose" aria-label="Закрыть" title="Закрыть">\u00D7</button>
    </div>
  `;
  const brandMark = titlebar.querySelector('.tb-brand-mark');
  if (appIconDataUrl) {
    const icon = document.createElement('img');
    icon.className = 'tb-icon';
    icon.alt = '';
    icon.draggable = false;
    icon.src = appIconDataUrl;
    brandMark.replaceWith(icon);
  } else {
    brandMark.className = 'tb-dot';
  }

  // Inline styles (no external CSS dependency)
  const style = document.createElement('style');
  style.textContent = `
    .harness-titlebar {
      position: fixed; top: 0; left: 0; right: 0;
      height: 36px;
      display: flex; align-items: center; justify-content: space-between;
      padding: 0 16px 0 0;
      background: #151517;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      z-index: 2147483647;
      pointer-events: auto;
      /* PERF: GPU-composited layer, cheap show/hide transforms */
      will-change: transform;
      transform: translate3d(0, 0, 0);
      backface-visibility: hidden;
      contain: layout style;
      transition: transform 0.2s ease, opacity 0.2s ease;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .harness-titlebar.hidden { transform: translateY(-100%); opacity: 0; pointer-events: none; }
    .tb-drag { flex: 1; height: 100%; display: flex; align-items: center; gap: 12px; padding-left: 16px; font-size: 14px; color: #9ca3af; -webkit-app-region: drag; }
    .tb-dot { width: 12px; height: 12px; border-radius: 4px; background: linear-gradient(135deg, #5686FE, #4176E6); }
    .tb-icon { width: 20px; height: 20px; border-radius: 4px; -webkit-user-drag: none; user-select: none; }
    .harness-titlebar .titlebar-controls { display: flex; gap: 0; -webkit-app-region: no-drag; }
    .harness-titlebar .titlebar-btn {
      width: 36px; height: 28px; border: none; background: transparent;
      color: #9ca3af; font-size: 12px; font-weight: 500;
      cursor: pointer; display: flex; align-items: center; justify-content: center;
      pointer-events: auto;
      transition: background 0.1s, color 0.1s; -webkit-app-region: no-drag;
    }
    .harness-titlebar .titlebar-btn:hover { background: rgba(255,255,255,0.08); color: #f9fafb; }
    .harness-titlebar .titlebar-btn:active { background: rgba(255,255,255,0.12); }
    .harness-titlebar .titlebar-btn-close { color: #6b7280; }
    .harness-titlebar .titlebar-btn-close:hover { background: #ef4444; color: white; }
    .harness-titlebar .titlebar-btn-close:active { background: #f87171; }
    body.harness-titlebar-injected { padding-top: 36px !important; box-sizing: border-box; }
    /* PERF: while resizing, kill transitions/animations (the SPA sidebar
       re-triggers its width transitions on every intermediate size).
       Layout-neutral only: no overflow changes (those shift layout themselves).
       Removed ~250ms after the last resize event. */
    body.harness-resizing, body.harness-resizing * { transition: none !important; animation: none !important; }
  `;

  document.head.appendChild(style);
  document.body.classList.add('harness-titlebar-injected');
  document.body.prepend(titlebar);

  // Document-scoped listeners below attach ONCE (titlebarListenersAttached):
  // re-running them on bar rebuild would double-fire IPC (double toggle).
  const syncMaxGlyph = (maximized) => {
    const btn = document.getElementById('btnMaximize');
    if (btn) {
      btn.textContent = maximized ? '❐' : '□';
      const label = maximized ? 'Восстановить' : 'Развернуть';
      btn.setAttribute('aria-label', label);
      btn.setAttribute('title', label);
    }
  };
  if (!titlebarListenersAttached) {
    titlebarListenersAttached = true;
  // Wire buttons via ipcRenderer DIRECTLY.
  // NOTE: do NOT call window.harnessAPI here — with contextIsolation the
  // preload runs in an isolated world where that bridge does NOT exist, so
  // window.harnessAPI?.minimize?.() silently no-ops.
  // Delegate on document (capture) so wiring survives any DOM node swap.
  document.addEventListener('click', (e) => {
    const target = e.target.closest?.('#btnMinimize, #btnMaximize, #btnClose');
    if (!target) return;
    e.preventDefault();
    if (target.id === 'btnMinimize') ipcRenderer.send('window-minimize');
    else if (target.id === 'btnMaximize') ipcRenderer.send('window-maximize');
    else if (target.id === 'btnClose') ipcRenderer.send('window-close');
  }, true);

  // Fullscreen sync (hide bar in native fullscreen)
  ipcRenderer.on('fullscreen-changed', (_evt, enabled) => {
    const tb = document.getElementById('harness-injected-titlebar');
    if (tb) tb.classList.toggle('hidden', Boolean(enabled));
  });

  // Maximize sync (glyph □ ↔ ❐)
  ipcRenderer.on('maximize-changed', (_evt, maximized) => syncMaxGlyph(Boolean(maximized)));

  // Voice: app status (minimize / restore) — respects master voiceNav gate
  const speakAppStatus = (text) => {
    try {
      const raw = localStorage.getItem('dsh.accessibility.settings')
      if (raw) {
        const doc = JSON.parse(raw)
        if (doc && doc.voiceNav !== true) return
      } else {
        // No stored doc → default voiceNav false
        return
      }
    } catch { return }
    try {
      const utter = new SpeechSynthesisUtterance(text)
      utter.lang = 'ru-RU'
      utter.rate = 1; utter.pitch = 1; utter.volume = 1
      try { speechSynthesis.cancel() } catch {}
      speechSynthesis.speak(utter)
    } catch {}
  }
  ipcRenderer.on('voice-app-status', (_evt, text) => {
    if (typeof text === 'string' && text.trim() !== '') speakAppStatus(text.trim())
  })

  // (initial glyph sync runs below, outside the once-block)

  // PERF: ЕДИНЫЙ resize-слушатель (было два): (a) без троттлинга ставит класс
  // заморозки transitions на весь burst, (b) с троттлингом ≤60fps проверяет,
  // не скинул ли SPA наш бар. Оба эффекта семантически независимы, как и раньше.
  let lastResizeTime = 0;
  let resizeRAF = 0;
  let resizeEndTimer = 0;
  const updateTitlebarIfNeeded = () => {
    resizeRAF = 0;
    if (!document.getElementById('harness-injected-titlebar')) {
      injectHarnessTitlebar();
    }
  };
  window.addEventListener('resize', () => {
    // (a) freeze transitions until 250ms after the last resize event
    if (document.body) document.body.classList.add('harness-resizing');
    clearTimeout(resizeEndTimer);
    resizeEndTimer = setTimeout(() => {
      if (document.body) document.body.classList.remove('harness-resizing');
    }, 250);
    // (b) throttled re-inject check
    const now = performance.now();
    if (now - lastResizeTime < 16) return;
    lastResizeTime = now;
    if (!resizeRAF) resizeRAF = requestAnimationFrame(updateTitlebarIfNeeded);
  }, { passive: true });
  } // titlebarListenersAttached

  // Initial maximize state (runs on every build so a rebuilt bar gets the right glyph)
  ipcRenderer.invoke('is-maximized')
    .then((maximized) => syncMaxGlyph(Boolean(maximized)))
    .catch((err) => console.warn('[Harness Titlebar] is-maximized query failed:', err));

  // NOTE: deliberately NO DOM freeze on minimize/restore. Mutating styles
  // exactly when DWM captures/animates the window bitmap swaps the bitmap
  // mid-animation — that 1-frame swap IS the sidebar flicker. The bar is a
  // tiny composited layer; leaving it alone is the smoothest option.

}

// Selector titlebar icon: swap the CSS dot for the real app icon (same file
// the window icon uses). Runs only on the selector page (owns #titlebar).
function applyAppIconToSelector() {
  if (!document.getElementById('titlebar')) return;
  if (document.querySelector('#titlebar .titlebar-icon')) return;
  getAppIconUrl().then(() => swapSelectorDot());
}

function swapSelectorDot() {
  if (!appIconDataUrl) return;
  if (document.querySelector('#titlebar .titlebar-icon')) return;
  const dot = document.querySelector('#titlebar .titlebar-dot');
  if (!dot) return;
  const style = document.createElement('style');
  style.textContent = '.titlebar-icon { width: 16px; height: 16px; border-radius: 4px; }';
  document.head.appendChild(style);
  const img = document.createElement('img');
  img.className = 'titlebar-icon';
  img.alt = '';
  img.draggable = false;
  img.src = appIconDataUrl;
  dot.replaceWith(img);
}

// Launcher accessibility carried into the Harness UI.
//
// The selector checkbox stores only { enabled } in main. This runs in the
// Harness origin (localhost), where the Accessibility page's own document
// lives, and merges exactly its two fields — contrast 'yellow' and
// voiceNav — so the menu and the checkbox edit one document. Disabling
// restores what was there before enabling (kept in a stash of our own),
// and never touches anything the user set elsewhere.
const LAUNCHER_A11Y_DOC_KEY = 'dsh.accessibility.settings';
const LAUNCHER_A11Y_STASH_KEY = 'dsh.launcher-a11y.prev';

function launcherA11yValidContrast(value) {
  return value === 'none' || value === 'bw' || value === 'yellow' || value === 'daltonism';
}

function launcherA11yReadJson(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function launcherA11yProjectAttrs(doc) {
  try {
    const root = document.documentElement;
    const font = doc.font === 'mono' ? 'mono' : 'atkinson';
    const contrast = launcherA11yValidContrast(doc.contrast) ? doc.contrast : 'none';
    root.setAttribute('data-dsh-a11y-font', font);
    root.setAttribute('data-dsh-a11y-contrast', contrast);
  } catch { /* never break page boot */ }
}

async function applyLauncherA11y() {
  try {
    // Harness UI only: localhost pages without the selector's own #titlebar.
    const isHarnessUI = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (!isHarnessUI || document.getElementById('titlebar')) return;
    let enabled = false;
    let speakHoverOn = false;
    try {
      const doc = await ipcRenderer.invoke('a11y-settings');
      enabled = Boolean(doc && doc.enabled === true);
      speakHoverOn = Boolean(doc && doc.speakHover === true);
    } catch { return; }
    const current = launcherA11yReadJson(LAUNCHER_A11Y_DOC_KEY) || {};
    if (enabled) {
      if (!launcherA11yReadJson(LAUNCHER_A11Y_STASH_KEY)) {
        try {
          localStorage.setItem(LAUNCHER_A11Y_STASH_KEY, JSON.stringify({
            contrast: current.contrast, voiceNav: current.voiceNav, voiceNavHover: current.voiceNavHover,
          }));
        } catch { /* stash is best-effort */ }
      }
      // Суб-галочка наведения из запускальщика включает то же поле внутри.
      const next = {
        ...current,
        contrast: 'yellow',
        voiceNav: true,
        ...(speakHoverOn ? { voiceNavHover: true } : {}),
      };
      try { localStorage.setItem(LAUNCHER_A11Y_DOC_KEY, JSON.stringify(next)); } catch { /* page keeps its draft */ }
      launcherA11yProjectAttrs(next);
      return;
    }
    const stash = launcherA11yReadJson(LAUNCHER_A11Y_STASH_KEY);
    if (!stash) return;
    const next = { ...current };
    if (launcherA11yValidContrast(stash.contrast)) next.contrast = stash.contrast;
    else delete next.contrast;
    if (typeof stash.voiceNav === 'boolean') next.voiceNav = stash.voiceNav;
    else delete next.voiceNav;
    if (typeof stash.voiceNavHover === 'boolean') next.voiceNavHover = stash.voiceNavHover;
    else delete next.voiceNavHover;
    try { localStorage.setItem(LAUNCHER_A11Y_DOC_KEY, JSON.stringify(next)); } catch { /* page keeps its draft */ }
    try { localStorage.removeItem(LAUNCHER_A11Y_STASH_KEY); } catch { /* stale stash is harmless */ }
    launcherA11yProjectAttrs(next);
  } catch { /* never break page boot */ }
}

// Run injection on DOM ready (no-op outside Harness UI by guards above)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    injectHarnessTitlebar();
    applyAppIconToSelector();
    void applyLauncherA11y();
  });
} else {
  injectHarnessTitlebar();
  applyAppIconToSelector();
  void applyLauncherA11y();
}

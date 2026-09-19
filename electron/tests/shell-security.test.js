const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');

test('main window denies popups and blocks untrusted navigation', () => {
  assert.match(mainSource, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);
  assert.match(mainSource, /webContents\.on\('will-navigate', blockUntrustedNavigation\)/);
  assert.match(mainSource, /webContents\.on\('will-redirect', blockUntrustedNavigation\)/);
  assert.match(mainSource, /url\.protocol === 'file:'[\s\S]*PORT_SELECTOR_PATH/);
  assert.match(mainSource, /url\.protocol === 'http:'[\s\S]*localhost[\s\S]*127\.0\.0\.1[\s\S]*trustedHarnessPort/);
  assert.match(mainSource, /rendererTrustPhase = 'harness';[\s\S]*isTrustedHarnessUrl\(targetUrl\)[\s\S]*loadURL\(targetUrl\)/);
});

test('sensitive IPC registrations use the centralized sender guard', () => {
  assert.match(mainSource, /webContents === mainWindow\.webContents/);
  assert.match(mainSource, /requireTrustedIpcSender\(event\)/);

  const handleChannels = [
    'check-port', 'v2ray-status', 'v2ray-start', 'v2ray-stop', 'v2ray-test',
    'v2ray-install-core', 'v2ray-remove-core', 'v2ray-settings', 'v2ray-save', 'v2ray-import-link',
    'v2ray-import-subscription', 'v2ray-select', 'v2ray-remove', 'is-maximized',
    'is-fullscreen', 'get-app-icon',
  ];
  for (const channel of handleChannels) {
    assert.match(mainSource, new RegExp(`secureHandle\\('${channel}'`), channel);
  }

  for (const channel of ['selector-ready', 'start-harness', 'toggle-fullscreen', 'screen-broadcast', 'window-minimize', 'window-maximize', 'window-close']) {
    assert.match(mainSource, new RegExp(`secureOn\\('${channel}'`), channel);
  }
  assert.match(mainSource, /ipcMain: \{ handle: \(channel, handler\) => secureHandle\(channel, handler\) \}/);
});

test('capture permissions are restricted to trusted local media requests', () => {
  assert.match(mainSource, /permission === 'media' \|\| permission === 'display-capture'/);
  assert.match(mainSource, /rendererTrustPhase === 'harness'/);
  assert.match(mainSource, /isTrustedMainWebContents\(webContents, rawUrl\)/);
  assert.doesNotMatch(mainSource, /setPermissionCheckHandler\(\(\) => true\)/);
  assert.doesNotMatch(mainSource, /setPermissionRequestHandler\([^]*callback\(true\)/);
  assert.match(mainSource, /request\?\.frame === mainWindow\?\.webContents\?\.mainFrame/);
});

test('backend token is masked only in logs while the captured URL stays intact', () => {
  const functionSource = mainSource.match(/function maskSensitiveUrlTokens\(value\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(functionSource);
  const context = {};
  vm.runInNewContext(`${functionSource}; globalThis.mask = maskSensitiveUrlTokens;`, context);
  assert.equal(
    context.mask('dsh web: http://127.0.0.1:3000/?token=secret-1&next=yes'),
    'dsh web: http://127.0.0.1:3000/?token=[REDACTED]&next=yes',
  );
  assert.match(mainSource, /console\.log\(`\[dsh:\$\{port\}\] \$\{maskSensitiveUrlTokens\(d\)\}`\)/);
  assert.match(mainSource, /backendReadyUrl = match\[1\]/);
  assert.doesNotMatch(mainSource, /backendReadyUrl = maskSensitiveUrlTokens/);
});

test('backend process groups and taskkill are configured safely', () => {
  assert.match(mainSource, /detached: process\.platform !== 'win32'/);
  assert.match(mainSource, /process\.kill\(-pid, 'SIGKILL'\)/);
  const taskkillBlocks = mainSource.match(/spawn\('taskkill',[\s\S]*?\n\s*\}\);/g) || [];
  assert.equal(taskkillBlocks.length, 2);
  for (const block of taskkillBlocks) assert.match(block, /shell: false/);
});

test('V2Ray install is latched and installer output is bounded', async () => {
  const functionSource = mainSource.match(/function installV2RayCoreFromLauncher\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(functionSource);
  const resolvers = [];
  const context = {
    runV2RayCoreInstaller: () => new Promise((resolve) => resolvers.push(resolve)),
  };
  vm.runInNewContext(`let v2rayInstallPromise = null; ${functionSource}; globalThis.install = installV2RayCoreFromLauncher;`, context);
  const first = context.install();
  const second = context.install();
  assert.equal(first, second);
  assert.equal(resolvers.length, 1);
  resolvers[0]({ ok: true });
  await first;
  const third = context.install();
  assert.notEqual(third, first);
  assert.equal(resolvers.length, 2);
  resolvers[1]({ ok: true });
  await third;

  assert.match(mainSource, /const BACKEND_LOG_TAIL_LIMIT = 128 \* 1024/);
  assert.match(mainSource, /out = appendLogTail\(out, chunk\)/);
  assert.match(mainSource, /err = appendLogTail\(err, chunk\)/);
});

test('uninitialized V2Ray status explicitly reports binary and both ports', () => {
  assert.match(mainSource, /binaryAvailable: false,[\s\S]*socksPort: null,[\s\S]*httpPort: null/);
});

test('packaged applications never enable TB_DEBUG_PORT or wildcard origins', () => {
  assert.match(mainSource, /app\.isPackaged !== true[\s\S]*remote-debugging-port/);
  assert.doesNotMatch(mainSource, /appendSwitch\('remote-allow-origins'/);
});

test('all public preload onX subscriptions return working disposers', () => {
  const listeners = new Map();
  let exposedApi = null;
  const ipcRenderer = {
    send() {},
    invoke: async () => '',
    on(channel, handler) {
      const handlers = listeners.get(channel) || [];
      handlers.push(handler);
      listeners.set(channel, handlers);
      return this;
    },
    once(channel, handler) {
      return this.on(channel, handler);
    },
    removeListener(channel, handler) {
      listeners.set(channel, (listeners.get(channel) || []).filter((entry) => entry !== handler));
      return this;
    },
  };
  const document = {
    readyState: 'loading',
    addEventListener() {},
  };
  vm.runInNewContext(preloadSource, {
    require: (name) => {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (_name, api) => { exposedApi = api; } },
        ipcRenderer,
      };
    },
    console,
    document,
    window: {},
    location: { hostname: '' },
    setTimeout,
    clearTimeout,
  });

  const names = Object.keys(exposedApi).filter((name) => name.startsWith('on'));
  assert.ok(names.length > 0);
  for (const name of names) {
    const dispose = exposedApi[name](() => {});
    assert.equal(typeof dispose, 'function', `${name} must return a disposer`);
    dispose();
  }
  for (const [channel, handlers] of listeners) {
    assert.equal(handlers.length, 0, `${channel} listener must be removed`);
  }
});

test('titlebar icon is assigned as a DOM property, not interpolated into HTML', () => {
  assert.match(preloadSource, /icon\.src = appIconDataUrl/);
  assert.doesNotMatch(preloadSource, /innerHTML\s*=\s*`[^`]*\$\{appIconDataUrl/s);
});

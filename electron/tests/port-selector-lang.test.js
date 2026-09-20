/**
 * Launcher window: RU/EN/ZH language switch.
 *
 * All of the window's own strings live in a three-language dictionary;
 * messages from deeper layers (backend, tunnel engine) stay Russian.
 * The choice persists in the window's own storage, the default is Russian,
 * and the voice follows the language. These tests cover the switch against
 * a fake shell.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { JSDOM } = require('jsdom')

const HTML = readFileSync(join(__dirname, '..', 'port-selector.html'), 'utf8')

/** Let the window's async load settle before asserting on it. */
const settle = async () => {
  for (let tick = 0; tick < 8; tick += 1) await new Promise((resolve) => { setTimeout(resolve, 0) })
}

/**
 * Mount the launcher against a fake shell.
 * @param seedLang - language to seed into storage before the scripts run.
 */
async function mount(seedLang = null) {
  const calls = []
  const spoken = []
  const captured = {}
  const a11y = { enabled: true }

  const bridge = {
    onReady: (callback) => { captured.ready = callback; setTimeout(() => { try { callback(3101, false); } catch {} }, 0) },
    onFullscreenChanged: () => {},
    onMaximizeChanged: () => {},
    onMaximizedChanged: () => {},
    onLaunchProgress: () => {},
    onLaunchError: () => {},
    minimize: () => {},
    maximize: () => {},
    close: () => {},
    toggleFullscreen: () => {},
    getAppIcon: async () => '',
    checkPort: async () => ({ ok: true }),
    startHarness: () => {},
    v2raySettings: async () => ({
      enabled: false, subscriptionUrl: '', servers: [], activeId: '', socksPort: 10808, httpPort: 10809,
    }),
    v2rayStatus: async () => ({ running: false, socksPort: null, httpPort: null, binaryAvailable: true }),
    v2raySave: async (patch) => patch,
    v2rayImportLink: async () => ({ servers: [], settings: {} }),
    v2rayImportSubscription: async () => ({ servers: [], settings: {} }),
    v2raySelect: async (id) => ({ activeId: id }),
    v2rayRemove: async () => ({}),
    v2rayStart: async () => ({ running: true, socksPort: 10808, httpPort: 10809, binaryAvailable: true }),
    v2rayStop: async () => ({ running: false, socksPort: null, httpPort: null, binaryAvailable: true }),
    v2rayTest: async () => ({ ok: true, target: 'example.com', latencyMs: 42 }),
    v2rayInstallCore: async () => ({ ok: true, status: { binaryAvailable: true } }),
    v2rayRemoveCore: async () => ({ ok: true, status: { binaryAvailable: false } }),
    onV2RayInstallProgress: () => () => {},
    a11ySettings: async () => ({ enabled: a11y.enabled }),
    a11ySave: async (patch) => {
      a11y.enabled = patch && patch.enabled === true
      return { enabled: a11y.enabled }
    },
    updateCheck: async () => ({ upToDate: true, local: 'aaaaaaa', remote: 'aaaaaaa' }),
    updateSkip: async () => ({}),
    updateApply: async () => ({ ok: true, head: 'aaaaaaa' }),
    updateRollback: async () => ({ ok: true, head: 'aaaaaaa' }),
  }

  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously',
    // http-ориджин: у file:// localStorage считается непрозрачным и бросает.
    url: 'http://localhost/launcher/',
    beforeParse(window) {
      window.harnessAPI = bridge
      if (seedLang) {
        try { window.localStorage.setItem('dsh.launcher.lang', seedLang) } catch {}
      }
      window.SpeechSynthesisUtterance = function (text) {
        this.text = String(text || '')
        this.lang = ''
        this.rate = 1
        this.pitch = 1
        this.volume = 1
      }
      window.speechSynthesis = {
        cancel() {},
        speak(utterance) { spoken.push({ text: String(utterance && utterance.text || ''), lang: String(utterance && utterance.lang || '') }) },
        getVoices() { return [] },
      }
    },
  })
  await settle()

  const win = dom.window
  const byId = (id) => win.document.getElementById(id)
  const click = (element) => element.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }))
  const subtitle = () => win.document.querySelector('.subtitle').textContent

  return { win, byId, click, subtitle, calls, spoken, captured, close: () => { dom.window.close() } }
}

test('the window opens in Russian by default', async () => {
  const env = await mount()
  try {
    assert.equal(env.win.document.documentElement.lang, 'ru')
    assert.equal(env.subtitle(), 'Настройте локальный запуск приложения')
    assert.equal(env.byId('checkUpdatesBtn').textContent, 'Проверить обновления')
    assert.equal(env.byId('launchBtn').textContent, 'Запустить Harness')
  } finally { env.close() }
})

test('switching to English repaints the window', async () => {
  const env = await mount()
  try {
    env.click(env.byId('langEn'))
    await settle()
    assert.equal(env.win.document.documentElement.lang, 'en')
    assert.equal(env.subtitle(), 'Set up the local app launch')
    assert.equal(env.byId('launchBtn').textContent, 'Launch Harness')
    assert.equal(env.byId('portInput').placeholder, 'Auto-find')
    assert.equal(env.win.localStorage.getItem('dsh.launcher.lang'), 'en')
    assert.equal(env.byId('langEn').disabled, true, 'активный язык нельзя нажать повторно')
    assert.equal(env.byId('langRu').disabled, false)
  } finally { env.close() }
})

test('switching to Chinese repaints the window', async () => {
  const env = await mount()
  try {
    env.click(env.byId('langZh'))
    await settle()
    assert.equal(env.win.document.documentElement.lang, 'zh')
    assert.equal(env.subtitle(), '设置本地应用启动')
    assert.equal(env.byId('checkUpdatesBtn').textContent, '检查更新')
    assert.equal(env.byId('launchBtn').textContent, '启动 Harness')
  } finally { env.close() }
})

test('the saved language opens at once, and switching back works', async () => {
  const env = await mount('zh')
  try {
    assert.equal(env.subtitle(), '设置本地应用启动', 'сохранённый язык применяется при входе')
    env.click(env.byId('langRu'))
    await settle()
    assert.equal(env.subtitle(), 'Настройте локальный запуск приложения')
    assert.equal(env.win.localStorage.getItem('dsh.launcher.lang'), 'ru')
  } finally { env.close() }
})

test('the voice follows the language', async () => {
  const env = await mount()
  try {
    env.click(env.byId('langEn'))
    await settle()
    const last = env.spoken[env.spoken.length - 1]
    assert.ok(last, 'переключение должны озвучить')
    assert.equal(last.lang, 'en-US')
    assert.match(last.text, /Language: English/)
  } finally { env.close() }
})

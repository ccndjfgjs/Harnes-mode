/**
 * Launcher window: the accessibility checkbox.
 *
 * The checkbox is a shortcut for the Accessibility page's own two fields
 * (contrast 'yellow' + voiceNav): the window turns black-yellow and speaks
 * Russian status lines, the choice is stored in the shell, and the Harness
 * side merges the same fields into the page's own document. These tests
 * cover the window side — initial state, toggle, persistence calls, and
 * announcements — against a fake shell, in the style of
 * port-selector-v2ray.test.js.
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
 * @param enabled - the saved checkbox the shell should open on.
 * @param withA11yBridge - when false the shell predates the checkbox (compat).
 */
async function mount(enabled = false, withA11yBridge = true) {
  const calls = []
  const spoken = []
  const captured = {}
  const state = { enabled }

  const bridge = {
    onReady: (callback) => { captured.ready = callback },
    onFullscreenChanged: () => {},
    onMaximizeChanged: () => {},
    onMaximizedChanged: () => {},
    onLaunchProgress: (callback) => { captured.progress = callback },
    onLaunchError: (callback) => { captured.launchError = callback },
    minimize: () => {},
    maximize: () => {},
    close: () => {},
    toggleFullscreen: () => {},
    getAppIcon: async () => '',
    checkPort: async () => ({ ok: true }),
    startHarness: (port) => { calls.push(['startHarness', port]) },
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
  }
  if (withA11yBridge) {
    bridge.a11ySettings = async () => { calls.push(['a11ySettings']); return { enabled: state.enabled } }
    bridge.a11ySave = async (patch) => {
      calls.push(['a11ySave', patch])
      state.enabled = patch && patch.enabled === true
      return { enabled: state.enabled }
    }
  }

  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously',
    beforeParse(window) {
      window.harnessAPI = bridge
      window.SpeechSynthesisUtterance = function (text) {
        this.text = String(text || '')
        this.lang = ''
        this.rate = 1
        this.pitch = 1
        this.volume = 1
      }
      window.speechSynthesis = {
        cancel() {},
        speak(utterance) { spoken.push(utterance && utterance.text ? String(utterance.text) : '') },
        getVoices() { return [] },
      }
    },
  })
  await settle()

  const win = dom.window
  const byId = (id) => win.document.getElementById(id)
  const setChecked = (element, on) => {
    element.checked = on
    element.dispatchEvent(new win.Event('change', { bubbles: true, cancelable: true }))
  }

  return { win, byId, setChecked, calls, spoken, captured, state, close: () => { dom.window.close() } }
}

test('the window opens on the saved checkbox', async () => {
  const on = await mount(true)
  try {
    assert.equal(on.byId('a11yToggle').checked, true, 'сохранённая галочка должна быть отмечена')
    assert.equal(on.win.document.documentElement.getAttribute('data-launcher-a11y'), 'yellow')
    assert.equal(on.spoken.length, 0, 'вход без озвучки: просто применяем тему')
  } finally { on.close() }

  const off = await mount(false)
  try {
    assert.equal(off.byId('a11yToggle').checked, false)
    assert.equal(off.win.document.documentElement.getAttribute('data-launcher-a11y'), 'none')
  } finally { off.close() }
})

test('checking the box saves, paints yellow and announces', async () => {
  const env = await mount(false)
  try {
    env.setChecked(env.byId('a11yToggle'), true)
    await settle()
    const saved = env.calls.find(([name]) => name === 'a11ySave')
    assert.ok(saved, 'окно должно сохранить выбор в оболочку')
    // Поле читаем напрямую: объект создан в другом мире JSDOM, deepEqual по
    // прототипам там не сходится.
    assert.equal(saved[1] && saved[1].enabled, true)
    assert.equal(env.win.document.documentElement.getAttribute('data-launcher-a11y'), 'yellow')
    assert.ok(env.spoken.some((line) => line.includes('Доступная версия включена')), 'включение надо проговорить')
  } finally { env.close() }
})

test('unchecking the box saves, clears the theme and announces', async () => {
  const env = await mount(true)
  try {
    env.setChecked(env.byId('a11yToggle'), false)
    await settle()
    const saved = env.calls.find(([name]) => name === 'a11ySave')
    assert.ok(saved, 'окно должно сохранить выбор в оболочку')
    assert.equal(saved[1] && saved[1].enabled, false)
    assert.equal(env.win.document.documentElement.getAttribute('data-launcher-a11y'), 'none')
    assert.ok(env.spoken.some((line) => line.includes('Доступная версия выключена')), 'выключение надо проговорить')
  } finally { env.close() }
})

test('status lines are spoken while the mode is on', async () => {
  const env = await mount(true)
  try {
    env.captured.ready(3101, false)
    await settle()
    assert.ok(env.spoken.some((line) => line.includes('Порт 3101')), 'готовый порт надо проговорить')

    env.captured.progress({ stage: 'waiting' })
    await settle()
    assert.ok(env.spoken.some((line) => line.includes('Ожидание готовности')), 'этапы запуска надо проговаривать')

    env.captured.launchError('Backend failed to start in time')
    await settle()
    assert.ok(env.spoken.some((line) => line.includes('Не удалось запустить')), 'ошибку запуска надо проговорить')
  } finally { env.close() }
})

test('status lines stay silent while the mode is off', async () => {
  const env = await mount(false)
  try {
    env.captured.ready(3101, false)
    env.captured.progress({ stage: 'waiting' })
    env.captured.launchError('Backend failed to start in time')
    await settle()
    assert.equal(env.spoken.length, 0, 'без галочки окно должно молчать')
  } finally { env.close() }
})

test('an older shell without the checkbox methods does not break the window', async () => {
  const env = await mount(false, false)
  try {
    assert.equal(env.byId('a11yToggle').checked, false, 'без мостика галочка просто выключена')
    env.setChecked(env.byId('a11yToggle'), true)
    await settle()
    assert.equal(env.win.document.documentElement.getAttribute('data-launcher-a11y'), 'yellow', 'тема работает и без сохранения')
  } finally { env.close() }
})

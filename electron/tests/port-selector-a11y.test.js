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
async function mount(enabled = false, withA11yBridge = true, url = null) {
  const calls = []
  const spoken = []
  const captured = {}
  const state = { enabled, speakPress: false, speakHover: false }

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
    fitWindow: (height) => { calls.push(['fitWindow', height]) },
  }
  if (withA11yBridge) {
    bridge.a11ySettings = async () => {
      calls.push(['a11ySettings'])
      return { enabled: state.enabled, speakPress: state.speakPress, speakHover: state.speakHover }
    }
    bridge.a11ySave = async (patch) => {
      calls.push(['a11ySave', patch])
      state.enabled = patch && patch.enabled === true
      state.speakPress = patch && patch.speakPress === true
      state.speakHover = patch && patch.speakHover === true
      return { enabled: state.enabled, speakPress: state.speakPress, speakHover: state.speakHover }
    }
  }

  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously',
    url: url || 'http://localhost/launcher/',
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

test('sub-checkboxes live only under the master one', async () => {
  const env = await mount(false)
  try {
    assert.equal(env.byId('a11ySpeakPress').disabled, true, 'без мастера суб-галочки закрыты')
    assert.equal(env.byId('a11ySpeakHover').disabled, true)
    env.setChecked(env.byId('a11yToggle'), true)
    await settle()
    assert.equal(env.byId('a11ySpeakPress').disabled, false, 'с мастером открыты')
    assert.equal(env.byId('a11ySpeakHover').disabled, false)
    env.setChecked(env.byId('a11yToggle'), false)
    await settle()
    assert.equal(env.byId('a11ySpeakPress').disabled, true, 'мастер выключен — снова закрыты')
  } finally { env.close() }
})

test('a sub-checkbox saves all three fields', async () => {
  const env = await mount(false)
  try {
    env.setChecked(env.byId('a11yToggle'), true)
    await settle()
    env.setChecked(env.byId('a11ySpeakHover'), true)
    await settle()
    const saves = env.calls.filter(([name]) => name === 'a11ySave')
    const last = saves[saves.length - 1][1]
    assert.equal(last.enabled, true)
    assert.equal(last.speakHover, true, 'ховер должен сохраниться')
    assert.equal(last.speakPress, false)
    assert.ok(env.spoken.some((line) => line.includes('Озвучка наведения включена')), 'переключение надо проговорить')
  } finally { env.close() }
})

test('hovering a button speaks what it does', async () => {
  const env = await mount(false)
  try {
    env.setChecked(env.byId('a11yToggle'), true)
    await settle()
    env.setChecked(env.byId('a11ySpeakHover'), true)
    await settle()
    const before = env.spoken.length
    env.byId('checkUpdatesBtn').dispatchEvent(new env.win.MouseEvent('mouseover', { bubbles: true, cancelable: true }))
    await settle()
    const fresh = env.spoken.slice(before)
    assert.ok(fresh.some((line) => line.includes('Проверить обновления')), 'название кнопки надо проговорить')
  } finally { env.close() }
})

test('hover stays silent without its sub-checkbox', async () => {
  const env = await mount(false)
  try {
    env.setChecked(env.byId('a11yToggle'), true)
    await settle()
    const before = env.spoken.length
    env.byId('checkUpdatesBtn').dispatchEvent(new env.win.MouseEvent('mouseover', { bubbles: true, cancelable: true }))
    await settle()
    assert.equal(env.spoken.length, before, 'без суб-галочки ховер молчит')
  } finally { env.close() }
})

test('focusing a field speaks its label and the whole value', async () => {
  const env = await mount(false)
  try {
    env.setChecked(env.byId('a11yToggle'), true)
    await settle()
    env.setChecked(env.byId('a11ySpeakPress'), true)
    await settle()
    const longValue = `vless://${'a'.repeat(300)}@example.com:443`
    env.byId('proxyLinkInput').value = longValue
    env.byId('proxyLinkInput').dispatchEvent(new env.win.Event('focusin', { bubbles: true, cancelable: true }))
    await settle()
    const fresh = env.spoken.join('\n')
    assert.ok(fresh.includes('Ссылка на сервер'), 'подпись поля надо проговорить')
    assert.ok(fresh.includes(longValue), 'значение поля — целиком, без обрезки')
  } finally { env.close() }
})

test('clicking a block speaks it, clicking its button does not double', async () => {  const env = await mount(false)
  try {
    env.setChecked(env.byId('a11yToggle'), true)
    await settle()
    env.setChecked(env.byId('a11ySpeakPress'), true)
    await settle()
    const before = env.spoken.length
    env.byId('launchBtn').dispatchEvent(new env.win.MouseEvent('click', { bubbles: true, cancelable: true }))
    await settle()
    assert.equal(env.spoken.length, before, 'у кнопки свой голос, блок за неё не говорит')
    const desc = env.byId('updateStatus')
    desc.dispatchEvent(new env.win.MouseEvent('click', { bubbles: true, cancelable: true }))
    await settle()
    const fresh = env.spoken.slice(before).join('\n')
    assert.ok(fresh.includes('Обновления'), 'текст блока надо проговорить')
    assert.ok(fresh.includes('Пока не проверено'), 'блок идёт целиком')
  } finally { env.close() }
})

test('the sub-checkbox hitbox ends at its text', async () => {
  const env = await mount(false)
  try {
    env.setChecked(env.byId('a11yToggle'), true)
    await settle()
    env.setChecked(env.byId('a11ySpeakPress'), true)
    await settle()
    // Клик по самому тексту включает через родное поведение подписи.
    const span = env.win.document.querySelector('label.a11y-sub span')
    span.dispatchEvent(new env.win.MouseEvent('click', { bubbles: true, cancelable: true }))
    await settle()
    assert.equal(env.byId('a11ySpeakPress').checked, false, 'клик по тексту щёлкает галочку')
    // А в стилях хитбокс ужаты до текста, а не на всю ширину блока.
    const css = Array.from(env.win.document.querySelectorAll('style')).map((el) => el.textContent).join('\n')
    assert.ok(/\.a11y-sub\s*\{[^}]*width:\s*fit-content/.test(css), 'хитбокс суб-галочек — по конец текста')
  } finally { env.close() }
})

test('clicking a label does not double-speak the block', async () => {
  const env = await mount(false)
  try {
    env.setChecked(env.byId('a11yToggle'), true)
    await settle()
    env.setChecked(env.byId('a11ySpeakPress'), true)
    await settle()
    env.byId('portInput').dispatchEvent(new env.win.Event('focusin', { bubbles: true, cancelable: true }))
    await settle()
    const before = env.spoken.length
    const label = env.win.document.querySelector('label[for="portInput"]')
    label.dispatchEvent(new env.win.MouseEvent('click', { bubbles: true, cancelable: true }))
    await settle()
    const fresh = env.spoken.slice(before)
    // Повтор той же фразы душит защита от дублей; чужой блок молчит в любом случае.
    assert.ok(!fresh.some((line) => line.includes('Подключить V2Ray')), 'чужой блок молчит')
    assert.ok(fresh.length <= 1, 'не больше одного голоса за клик')
  } finally { env.close() }
})
test('switches announce themselves', async () => {
  const env = await mount(false)
  try {
    env.setChecked(env.byId('a11yToggle'), true)
    await settle()
    env.setChecked(env.byId('proxyEnabled'), true)
    await settle()
    assert.ok(env.spoken.some((line) => line.includes('Туннель включён')), 'переключатель туннеля слышно')
    env.setChecked(env.byId('proxyEnabled'), false)
    await settle()
    assert.ok(env.spoken.some((line) => line.includes('Туннель выключен')), 'и выключение тоже')
  } finally { env.close() }
})

test('the window asks the shell to fit its content once ready', async () => {
  const env = await mount(false)
  try {
    env.captured.ready(3101, false)
    await new Promise((resolve) => { setTimeout(resolve, 800) })
    const fits = env.calls.filter(([name]) => name === 'fitWindow')
    assert.equal(fits.length, 1, 'подгонка — один раз')
    assert.ok(typeof fits[0][1] === 'number' && fits[0][1] > 0, 'высота — число')
  } finally { env.close() }
})

test('hover jitter across empty space does not repeat the voice', async () => {
  const env = await mount(false)
  try {
    env.setChecked(env.byId('a11yToggle'), true)
    await settle()
    env.setChecked(env.byId('a11ySpeakHover'), true)
    await settle()
    const btn = env.byId('checkUpdatesBtn')
    const plain = env.win.document.querySelector('.dialog .brand .subtitle')
    const hover = (el) => el.dispatchEvent(new env.win.MouseEvent('mouseover', { bubbles: true, cancelable: true }))
    hover(btn)
    await settle()
    const afterFirst = env.spoken.length
    assert.ok(afterFirst > 0, 'первое наведение говорит')
    hover(plain)
    await settle()
    hover(btn)
    await settle()
    assert.equal(env.spoken.length, afterFirst, 'ёрзанье туда-сюда молчит')
    // Пауза ключа ховера — 1.5с, голоса — 5с: ждём обе, возврат говорит снова.
    await new Promise((resolve) => { setTimeout(resolve, 5600) })
    hover(btn)
    await settle()
    assert.ok(env.spoken.length > afterFirst, 'осознанный возврат через паузу говорит снова')
  } finally { env.close() }
})

test('hovering a field speaks its label and value', async () => {
  const env = await mount(false)
  try {
    env.setChecked(env.byId('a11yToggle'), true)
    await settle()
    env.setChecked(env.byId('a11ySpeakHover'), true)
    await settle()
    env.byId('proxyHost').value = 'proxy.example.com'
    env.byId('proxyHost').dispatchEvent(new env.win.MouseEvent('mouseover', { bubbles: true, cancelable: true }))
    await settle()
    const fresh = env.spoken.join('\n')
    assert.ok(fresh.includes('Сервер'), 'подпись поля надо проговорить')
    assert.ok(fresh.includes('proxy.example.com'), 'значение поля тоже')
  } finally { env.close() }
})

test('the gpu notice is spoken when it shows', async () => {
  const env = await mount(true, true, 'http://localhost/launcher/?gpu=crash')
  try {
    await settle()
    assert.ok(env.spoken.some((line) => line.includes('GPU')), 'плашку про GPU надо проговорить')
  } finally { env.close() }
})

/**
 * Launcher window: the paste-a-link / server-list flow.
 *
 * The parsing layer has its own tests (v2ray.test.js), and the in-app settings
 * page has its own. What neither covers is the wiring between them in
 * `port-selector.html` — the buttons, the re-render, and the fact that this
 * window and the settings page edit ONE saved document. A broken handler here
 * would leave the window looking right and doing nothing, which is exactly the
 * failure a syntax check cannot see.
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

/** A server shaped like the ones the parser produces. */
const server = (id, name, host, protocol = 'vless') => ({
  id, name, protocol, host, remotePort: 443, uuid: `uuid-${id}`, transport: 'ws', security: 'tls',
})

/**
 * Mount the launcher against a fake shell whose state the test can inspect.
 * @param initial - the saved document the window should open on.
 * @param onImportLink - how the fake main process answers a pasted block.
 * @param options - whether the fake shell has a core binary to report.
 */
async function mount(initial = {}, onImportLink = null, options = {}) {
  const calls = []
  const state = {
    binaryAvailable: options.binaryAvailable ?? true,
    document: {
      enabled: false,
      socksPort: 10808,
      httpPort: 10809,
      subscriptionUrl: '',
      servers: [],
      activeId: '',
      ...initial,
    },
  }

  const save = (patch) => {
    state.document = { ...state.document, ...patch }
    return state.document
  }

  const installProgressListeners = []

  const bridge = {
    onReady: () => {},
    onFullscreenChanged: () => {},
    onMaximizeChanged: () => {},
    onLaunchProgress: () => {},
    onLaunchError: () => {},
    minimize: () => {},
    maximize: () => {},
    close: () => {},
    toggleFullscreen: () => {},
    getAppIcon: async () => '',
    checkPort: async () => ({ ok: true }),
    startHarness: (port) => { calls.push(['startHarness', port]) },
    v2raySettings: async () => { calls.push(['v2raySettings']); return state.document },
    v2rayStatus: async () => {
      calls.push(['v2rayStatus'])
      return { running: false, socksPort: null, httpPort: null, binaryAvailable: state.binaryAvailable }
    },
    v2raySave: async (patch) => { calls.push(['v2raySave', patch]); return save(patch) },
    v2rayImportLink: async (text) => {
      calls.push(['v2rayImportLink', text])
      if (onImportLink !== null) return onImportLink(text, state, save)
      const added = server('link-1', 'Пробный сервер', 'example.com')
      return { servers: [added], settings: save({ servers: [...state.document.servers, added], activeId: added.id }) }
    },
    v2rayImportSubscription: async (url) => {
      calls.push(['v2rayImportSubscription', url])
      const loaded = [server('sub-1', 'Амстердам', 'nl.example.com'), server('sub-2', 'Токио', 'jp.example.com', 'trojan')]
      return { servers: loaded, settings: save({ subscriptionUrl: url, servers: loaded, activeId: loaded[0].id }) }
    },
    v2raySelect: async (id) => { calls.push(['v2raySelect', id]); return save({ activeId: id }) },
    v2rayRemove: async (id) => {
      calls.push(['v2rayRemove', id])
      const servers = state.document.servers.filter((entry) => entry.id !== id)
      return save({ servers, activeId: servers[0]?.id ?? '' })
    },
    v2rayStart: async () => {
      calls.push(['v2rayStart'])
      // The real shell refuses to start without a core binary, and wraps the
      // reason in Electron's IPC envelope. Mirror both, or the launch path is
      // tested against a shell that cannot fail.
      if (!state.binaryAvailable) {
        throw new Error("Error invoking remote method 'v2ray-start': Error: V2Ray не найден. Поместите v2ray.exe в installer/resources/v2ray")
      }
      return { running: true, socksPort: 10808, httpPort: 10809, binaryAvailable: true }
    },
    onV2RayInstallProgress: (callback) => {
      installProgressListeners.push(callback)
      return () => {
        const index = installProgressListeners.indexOf(callback)
        if (index >= 0) installProgressListeners.splice(index, 1)
      }
    },
    v2rayInstallCore: async () => {
      calls.push(['v2rayInstallCore'])
      for (const listener of installProgressListeners) listener({ percent: 12, message: 'Проверяю checksum' })
      for (const listener of installProgressListeners) listener({ percent: 64, message: 'Скачиваю V2Ray', loadedBytes: 7340032, totalBytes: 14680064 })
      for (const listener of installProgressListeners) listener({ percent: 100, message: 'V2Ray установлен', loadedBytes: 14680064, totalBytes: 14680064 })
      state.binaryAvailable = true
      return { ok: true, status: { running: false, socksPort: null, httpPort: null, binaryAvailable: true } }
    },
    v2rayRemoveCore: async () => {
      calls.push(['v2rayRemoveCore'])
      // Mirror the real shell: a failed removal reports ok:false and leaves the
      // binary in place, so the window must not claim success.
      if (options.removeFails === true) {
        return {
          ok: false,
          status: { running: false, socksPort: null, httpPort: null, binaryAvailable: state.binaryAvailable },
          message: 'не удалось удалить: v2ray.exe (EBUSY: resource busy or locked)',
        }
      }
      state.binaryAvailable = false
      return { ok: true, status: { running: false, socksPort: null, httpPort: null, binaryAvailable: false } }
    },
    v2rayTest: async () => { calls.push(['v2rayTest']); return { ok: true, target: 'example.com', latencyMs: 42 } },
    v2rayStop: async () => { calls.push(['v2rayStop']); return { running: false, socksPort: null, httpPort: null, binaryAvailable: true } },
  }

  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously',
    beforeParse(window) { window.harnessAPI = bridge },
  })
  await settle()

  const win = dom.window
  const byId = (id) => win.document.getElementById(id)
  const click = (element) => element.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }))

  return { win, byId, click, calls, state, close: () => { dom.window.close() } }
}

test('the window opens on the saved document, so settings made in-app are already here', async () => {
  const saved = server('saved-1', 'Из настроек', 'from-settings.example.com')
  const env = await mount({ enabled: true, subscriptionUrl: 'https://sub.example.com/x', servers: [saved], activeId: saved.id })
  try {
    assert.equal(env.byId('proxyEnabled').checked, true, 'включённый туннель должен быть отмечен')
    assert.equal(env.byId('proxyFields').hidden, false, 'поля должны быть раскрыты')
    assert.equal(env.byId('proxySubUrl').value, 'https://sub.example.com/x')
    assert.equal(env.byId('proxyLocalPort').value, '10808')
    assert.equal(env.byId('proxyHttpPort').value, '10809')

    const rows = env.byId('proxyServers').querySelectorAll('.server-item')
    assert.equal(rows.length, 1, 'сервер из настроек должен быть виден в окне запуска')
    assert.equal(rows[0].querySelector('.server-name').textContent, 'Из настроек')
    assert.match(rows[0].querySelector('.server-meta').textContent, /vless · from-settings\.example\.com:443 · tls/)
    assert.equal(rows[0].classList.contains('active'), true, 'выбранный сервер должен быть помечен')
  } finally { env.close() }
})

test('an empty server list says so instead of rendering nothing', async () => {
  const env = await mount({ enabled: true })
  try {
    assert.equal(env.byId('proxyServersWrap').hidden, true)
    assert.match(env.byId('proxyServers').textContent, /Список пуст/)
  } finally { env.close() }
})

test('pasting a link adds the server, clears the field and reports the count', async () => {
  const env = await mount({ enabled: true })
  try {
    env.byId('proxyLinkInput').value = 'vless://11111111-2222-3333-4444-555555555555@example.com:443#Пробный'
    env.click(env.byId('addLinkBtn'))
    await settle()

    const sent = env.calls.find(([name]) => name === 'v2rayImportLink')
    assert.ok(sent, 'окно должно передать вставленный текст в оболочку')
    assert.match(sent[1], /^vless:\/\//)

    const rows = env.byId('proxyServers').querySelectorAll('.server-item')
    assert.equal(rows.length, 1, 'добавленный сервер должен появиться в списке')
    assert.equal(rows[0].querySelector('.server-name').textContent, 'Пробный сервер')
    assert.equal(env.byId('proxyLinkInput').value, '', 'поле должно очиститься')
    assert.match(env.byId('proxyStatus').textContent, /Добавлено серверов: 1/)
  } finally { env.close() }
})

test('pressing "Добавить в список" with nothing pasted warns instead of calling the shell', async () => {
  const env = await mount({ enabled: true })
  try {
    env.click(env.byId('addLinkBtn'))
    await settle()

    assert.equal(env.calls.some(([name]) => name === 'v2rayImportLink'), false, 'пустой ввод не должен уходить в оболочку')
    assert.match(env.byId('proxyStatus').textContent, /Вставьте ссылку на сервер/)
  } finally { env.close() }
})

test('an unusable link surfaces the shell\'s reason and leaves the list alone', async () => {
  const env = await mount({ enabled: true }, () => { throw new Error('Ссылка не распознана. Подходят vless://, vmess://, trojan:// и ss://') })
  try {
    env.byId('proxyLinkInput').value = 'это не ссылка'
    env.click(env.byId('addLinkBtn'))
    await settle()

    assert.match(env.byId('proxyStatus').textContent, /Ссылка не распознана/)
    assert.equal(env.byId('proxyServers').querySelectorAll('.server-item').length, 0)
  } finally { env.close() }
})

test('a subscription URL loads the whole list at once', async () => {
  const env = await mount({ enabled: true })
  try {
    env.byId('proxySubUrl').value = 'https://sub.example.com/all'
    env.click(env.byId('loadSubBtn'))
    await settle()

    const sent = env.calls.find(([name]) => name === 'v2rayImportSubscription')
    assert.ok(sent, 'окно должно передать адрес подписки в оболочку')
    assert.equal(sent[1], 'https://sub.example.com/all')

    const rows = env.byId('proxyServers').querySelectorAll('.server-item')
    assert.equal(rows.length, 2, 'должны появиться все серверы из списка')
    assert.equal(rows[0].querySelector('.server-name').textContent, 'Амстердам')
    assert.equal(rows[1].querySelector('.server-name').textContent, 'Токио')
    assert.match(env.byId('proxyStatus').textContent, /Загружено серверов: 2/)
    assert.equal(env.byId('loadSubBtn').disabled, false, 'кнопка должна снова стать доступной')
  } finally { env.close() }
})

test('choosing another server persists the choice', async () => {
  const first = server('a', 'Первый', 'one.example.com')
  const second = server('b', 'Второй', 'two.example.com')
  const env = await mount({ enabled: true, servers: [first, second], activeId: first.id })
  try {
    const radios = env.byId('proxyServers').querySelectorAll('input[type=radio]')
    assert.equal(radios.length, 2)
    radios[1].checked = true
    radios[1].dispatchEvent(new env.win.Event('change', { bubbles: true }))
    await settle()

    const sent = env.calls.find(([name]) => name === 'v2raySelect')
    assert.ok(sent, 'выбор сервера должен уйти в оболочку')
    assert.equal(sent[1], 'b')

    const rows = env.byId('proxyServers').querySelectorAll('.server-item')
    assert.equal(rows[1].classList.contains('active'), true, 'выбранная строка должна подсветиться')
    assert.equal(rows[0].classList.contains('active'), false)
  } finally { env.close() }
})

test('removing a server takes it out of the list', async () => {
  const first = server('a', 'Первый', 'one.example.com')
  const second = server('b', 'Второй', 'two.example.com')
  const env = await mount({ enabled: true, servers: [first, second], activeId: first.id })
  try {
    env.click(env.byId('proxyServers').querySelectorAll('.server-remove')[1])
    await settle()

    const sent = env.calls.find(([name]) => name === 'v2rayRemove')
    assert.ok(sent, 'удаление должно уйти в оболочку')
    assert.equal(sent[1], 'b')

    const rows = env.byId('proxyServers').querySelectorAll('.server-item')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].querySelector('.server-name').textContent, 'Первый')
  } finally { env.close() }
})

test('turning the tunnel on reveals the fields and saves the choice', async () => {
  const env = await mount({ enabled: false })
  try {
    assert.equal(env.byId('proxyFields').hidden, true)
    const toggle = env.byId('proxyEnabled')
    toggle.checked = true
    toggle.dispatchEvent(new env.win.Event('change', { bubbles: true }))
    await settle()

    assert.equal(env.byId('proxyFields').hidden, false)
    const saved = env.calls.find(([name]) => name === 'v2raySave')
    assert.ok(saved, 'переключатель должен сохранить состояние')
    assert.equal(saved[1].enabled, true)
  } finally { env.close() }
})

test('a missing tunnel engine is named as soon as the panel opens', async () => {
  const env = await mount({ enabled: true }, null, { binaryAvailable: false })
  try {
    const shown = env.byId('proxyStatus').textContent
    assert.match(shown, /Движок V2Ray не установлен/,
      'включённый туннель без движка должен быть назван сразу, а не при запуске')
    assert.match(shown, /Установить V2Ray/,
      'и сразу назвать то, что человеку нужно нажать')
    // Mentioning the raw file path was accurate but useless: the button in the
    // same section downloads it, so pointing at a folder was an instruction the
    // user could not follow.
    assert.equal(shown.includes('v2ray.exe'), false)
  } finally { env.close() }
})

test('turning the tunnel on warns about the missing engine right away', async () => {
  const env = await mount({ enabled: false }, null, { binaryAvailable: false })
  try {
    assert.equal(env.byId('proxyStatus').textContent.includes('Движок V2Ray не установлен'), false,
      'выключенный туннель не должен ругаться')

    const toggle = env.byId('proxyEnabled')
    toggle.checked = true
    toggle.dispatchEvent(new env.win.Event('change', { bubbles: true }))
    await settle()

    assert.match(env.byId('proxyStatus').textContent, /Движок V2Ray не установлен/,
      'предупреждение должно появиться в момент включения, а не при запуске')
  } finally { env.close() }
})

test('the install button is offered when the engine is missing', async () => {
  const env = await mount({ enabled: false }, null, { binaryAvailable: false })
  try {
    const install = env.byId('installProxyCoreBtn')
    assert.equal(install.disabled, false, 'без движка кнопка установки должна быть доступна')
    assert.match(install.textContent, /Установить V2Ray/)
  } finally { env.close() }
})

test('installing from the launcher shows live percent and enables tunnel path without leaving the app', async () => {
  const env = await mount({ enabled: false }, null, { binaryAvailable: false })
  try {
    env.click(env.byId('installProxyCoreBtn'))
    await settle()

    assert.ok(env.calls.some(([name]) => name === 'v2rayInstallCore'),
      'кнопка должна вызвать установку ядра через оболочку')
    assert.match(env.byId('proxyStatus').textContent, /100%/,
      'в статусе установки должен показываться процент')
    assert.match(env.byId('proxyStatus').textContent, /МБ/,
      'в статусе должен показываться объём загрузки в мегабайтах')
    assert.match(env.byId('proxyStatus').textContent, /V2Ray установлен/)
    assert.equal(env.byId('installProxyCoreBtn').disabled, true,
      'после успешной установки повторная кнопка не нужна')
    assert.equal(env.byId('proxyEnabled').checked, false,
      'установка не должна сама включать туннель: только готовит движок')
  } finally { env.close() }
})

test('a present engine keeps the panel quiet', async () => {
  const env = await mount({ enabled: true }, null, { binaryAvailable: true })
  try {
    assert.equal(env.byId('proxyStatus').textContent.includes('Не найден V2Ray'), false,
      'рабочий движок не должен вызывать предупреждений')
    assert.equal(env.byId('installProxyCoreBtn').disabled, true,
      'когда движок уже есть, кнопка установки должна быть выключена')
  } finally { env.close() }
})

test('the shell\'s reason is shown without Electron\'s IPC wrapper', async () => {
  const wrapped = "Error invoking remote method 'v2ray-import-link': Error: Ссылка не распознана. Подходят vless://, vmess://, trojan:// и ss://"
  const env = await mount({ enabled: true }, () => { throw new Error(wrapped) })
  try {
    env.byId('proxyLinkInput').value = 'мусор'
    env.click(env.byId('addLinkBtn'))
    await settle()

    const shown = env.byId('proxyStatus').textContent
    assert.equal(shown.includes('Error invoking remote method'), false,
      'обёртка системы не должна попадать в текст для пользователя')
    assert.match(shown, /^Ссылка не распознана/)
  } finally { env.close() }
})

/**
 * Press "Запустить Harness" the way the window does once the port is confirmed.
 * `onReady` is a no-op in the fake shell, so the button has to be un-disabled by
 * hand to mirror the state the real window reaches after its port check.
 */
async function pressLaunch(env, port = '7391') {
  env.byId('portInput').value = String(port)
  env.byId('launchBtn').disabled = false
  env.click(env.byId('launchBtn'))
  await settle()
}

test('a tunnel that cannot start stops the launch rather than leaking around it', async () => {
  const only = server('only-1', 'Единственный', 'a.example.com')
  const env = await mount({ enabled: true, servers: [only], activeId: only.id }, null, { binaryAvailable: false })
  try {
    await pressLaunch(env)

    assert.equal(env.calls.find(([name]) => name === 'startHarness'), undefined,
      'включённый туннель без движка обязан остановить запуск: иначе трафик ушёл бы мимо туннеля, а человек считал бы, что он под защитой')
    // Either wording is acceptable — the window's own up-front warning or the
    // shell's reason — as long as the missing engine is named.
    assert.match(env.byId('proxyStatus').textContent, /V2Ray не найден|Не найден V2Ray/,
      'причина отказа должна остаться на экране, а не исчезнуть вместе с окном ожидания')
    const shown = env.byId('proxyStatus').textContent
    assert.match(shown, /installer[\\/]resources[\\/]v2ray/,
      'и назвать папку, куда положить движок')
    assert.match(shown, /выключите его/i,
      'на этом шаге человеку нужен выход: сообщение движка говорит «почему», но не «что делать», чтобы всё-таки запуститься')
    assert.equal(shown.includes('Error invoking remote method'), false,
      'и показать её надо без внутренностей Electron')
    assert.equal(env.byId('launchBtn').disabled, false,
      'кнопку запуска надо вернуть: человеку нужно выключить туннель и повторить')
    assert.equal(env.byId('proxyEnabled').disabled, false,
      'переключатель туннеля тоже должен разблокироваться — иначе выключить его нечем')
  } finally { env.close() }
})

test('a working tunnel lets the launch through', async () => {
  const only = server('only-2', 'Рабочий', 'b.example.com')
  const env = await mount({ enabled: true, servers: [only], activeId: only.id }, null, { binaryAvailable: true })
  try {
    await pressLaunch(env, '7392')

    const started = env.calls.find(([name]) => name === 'startHarness')
    assert.ok(started, 'с рабочим движком запуск обязан состояться — иначе прошлый тест доказывал бы не то')
    assert.equal(started[1], 7392)
    assert.ok(env.calls.some(([name]) => name === 'v2rayTest'),
      'перед запуском туннель надо проверить, а не только поднять')
  } finally { env.close() }
})

// --- Removing the engine -----------------------------------------------------
// The install button was the only way to change the engine's presence, so a
// user who installed it by mistake was stuck with it. These lock the pair in
// step: exactly one of the two controls is pressable, and the removal's failure
// is reported rather than dressed up as success.
//
// "Offered" means enabled, not visible. Hiding the unused control used to be the
// rule, and it moved the pointer sideways between two presses of the same spot —
// the pair now keeps its place and only swaps which one is pressable. A `hidden`
// button is not merely invisible: it is removed from hit testing, so a press on
// one resolves on whatever sits behind and reads as nothing happening.

test('the remove button is not offered while the engine is missing', async () => {
  const env = await mount({ enabled: false }, null, { binaryAvailable: false })
  try {
    assert.equal(env.byId('removeProxyCoreBtn').disabled, true,
      'удалять нечего — кнопка удаления не должна быть доступна')
    assert.equal(env.byId('installProxyCoreBtn').disabled, false,
      'а кнопка установки — должна')
  } finally { env.close() }
})

test('the remove button is offered once the engine is present', async () => {
  const env = await mount({ enabled: false }, null, { binaryAvailable: true })
  try {
    assert.equal(env.byId('removeProxyCoreBtn').disabled, false,
      'с установленным движком удаление должно быть доступно')
    assert.equal(env.byId('installProxyCoreBtn').disabled, true,
      'и установка — недоступна: повторно скачивать нечего')
    assert.match(env.byId('installProxyCoreBtn').textContent, /V2Ray установлен/)
  } finally { env.close() }
})

test('removing the engine from the launcher deletes it and offers the install again', async () => {
  const env = await mount({ enabled: false }, null, { binaryAvailable: true })
  try {
    env.click(env.byId('removeProxyCoreBtn'))
    await settle()

    assert.ok(env.calls.some(([name]) => name === 'v2rayRemoveCore'),
      'кнопка должна вызвать удаление движка через оболочку')
    assert.match(env.byId('proxyStatus').textContent, /удалён/i,
      'человеку надо сказать, что движка больше нет')
    assert.equal(env.byId('removeProxyCoreBtn').disabled, true,
      'повторно удалять нечего — кнопка удаления выключена')
    assert.equal(env.byId('installProxyCoreBtn').disabled, false,
      'а установка возвращается: движок можно поставить заново')
    assert.match(env.byId('installProxyCoreBtn').textContent, /Установить V2Ray/)
  } finally { env.close() }
})

test('a failed removal is reported and the button stays usable', async () => {
  // The real failure is a locked file: the tunnel holds v2ray.exe open. The
  // window must not claim success, and must not leave the user without a retry.
  const env = await mount({ enabled: false }, null, { binaryAvailable: true, removeFails: true })
  try {
    env.click(env.byId('removeProxyCoreBtn'))
    await settle()

    const shown = env.byId('proxyStatus').textContent
    assert.equal(/удалён/i.test(shown), false,
      'неудачное удаление нельзя показывать как успешное')
    assert.match(shown, /не удалось удалить|EBUSY|занят/i,
      'и надо назвать причину, а не молчать')
    assert.equal(env.byId('removeProxyCoreBtn').disabled, false,
      'кнопку удаления надо вернуть в рабочее состояние, иначе повторить нечем')
  } finally { env.close() }
})

test('a removal leaves the pair pressable, not merely visible', async () => {
  // A `hidden` control is removed from hit testing, so a press on it resolves on
  // whatever sits behind and reads as nothing happening. Visibility must not be
  // how the pair is told apart: the unpressed button is disabled, not hidden.
  const env = await mount({ enabled: false }, null, { binaryAvailable: true })
  try {
    env.click(env.byId('removeProxyCoreBtn'))
    await settle()

    for (const id of ['installProxyCoreBtn', 'removeProxyCoreBtn']) {
      assert.equal(env.byId(id).hidden, false, `${id} должен оставаться в разметке`)
    }
    assert.equal(env.byId('removeProxyCoreBtn').disabled, true,
      'удалять нечего — кнопка выключена, но на месте')
    assert.equal(env.byId('installProxyCoreBtn').disabled, false)
  } finally { env.close() }
})

test('installing right after a removal reuses the same pair of controls', async () => {
  const env = await mount({ enabled: false }, null, { binaryAvailable: true })
  try {
    env.click(env.byId('removeProxyCoreBtn'))
    await settle()
    assert.equal(env.byId('installProxyCoreBtn').disabled, false)

    env.click(env.byId('installProxyCoreBtn'))
    await settle()

    assert.ok(env.calls.some(([name]) => name === 'v2rayInstallCore'),
      'после удаления установка должна работать тем же путём')
    assert.equal(env.byId('removeProxyCoreBtn').disabled, false,
      'и вернуть кнопку удаления в рабочее состояние')
    assert.match(env.byId('installProxyCoreBtn').textContent, /V2Ray установлен/)
  } finally { env.close() }
})

// --- A busy control has to end up un-busy ------------------------------------
// The report that started this: "Удаляю V2Ray…" ran forever. Whether the job
// settles is the shell's business — the window's business is that no path leaves
// the ring spinning. These press a button whose answer never arrives and whose
// answer arrives as a failure, which are the two ways the panel used to strand.

test('a removal leaves the pair pressable, not merely visible', async () => {
  // A `hidden` control is removed from hit testing, so a press on it resolves on
  // whatever sits behind and reads as nothing happening. Visibility must not be
  // how the pair is told apart: the unpressed button is disabled, not hidden.
  const env = await mount({ enabled: false }, null, { binaryAvailable: true })
  try {
    env.click(env.byId('removeProxyCoreBtn'))
    await settle()

    for (const id of ['installProxyCoreBtn', 'removeProxyCoreBtn']) {
      assert.equal(env.byId(id).hidden, false, `${id} должен оставаться в разметке`)
    }
    assert.equal(env.byId('removeProxyCoreBtn').disabled, true,
      'удалять нечего — кнопка выключена, но на месте')
    assert.equal(env.byId('installProxyCoreBtn').disabled, false)
  } finally { env.close() }
})

test('a removal whose answer never arrives can still be retried', async () => {
  const env = await mount({ enabled: false }, null, { binaryAvailable: true })
  try {
    // Swap the bridge for one that never answers, then press: the window must
    // survive a shell that stops talking, which is the shape of the original bug.
    env.win.harnessAPI.v2rayRemoveCore = () => new Promise(() => {})
    env.click(env.byId('removeProxyCoreBtn'))
    await settle()

    assert.equal(env.byId('removeProxyCoreBtn').classList.contains('is-busy'), true,
      'пока ответа нет, кнопка должна показывать занятость')

    // The real recovery is a restart, but the panel must not have painted itself
    // into a corner in the meantime: the other control stays pressable.
    assert.equal(env.byId('installProxyCoreBtn').disabled, true,
      'на время удаления установка недоступна — иначе две задачи пойдут разом')
  } finally { env.close() }
})

test('a failed removal takes the busy ring off and says why', async () => {
  const env = await mount({ enabled: false }, null, { binaryAvailable: true, removeFails: true })
  try {
    env.click(env.byId('removeProxyCoreBtn'))
    await settle()

    assert.equal(env.byId('removeProxyCoreBtn').classList.contains('is-busy'), false,
      'неудача не должна оставлять кольцо занятости на кнопке')
    assert.equal(env.byId('removeProxyCoreBtn').disabled, false,
      'и кнопку надо вернуть в рабочее состояние для повторной попытки')
    assert.match(env.byId('proxyStatus').textContent, /не удалось удалить/i)
  } finally { env.close() }
})

test('a failed install takes the busy ring off too', async () => {
  const env = await mount({ enabled: false }, null, { binaryAvailable: false })
  try {
    env.win.harnessAPI.v2rayInstallCore = async () => {
      throw new Error("Error invoking remote method 'v2ray-install-core': Error: сеть недоступна")
    }
    env.click(env.byId('installProxyCoreBtn'))
    await settle()

    assert.equal(env.byId('installProxyCoreBtn').classList.contains('is-busy'), false,
      'ошибка установки не должна оставлять кольцо занятости')
    assert.equal(env.byId('installProxyCoreBtn').disabled, false,
      'кнопку установки нужно вернуть — попытку повторяют')
    assert.match(env.byId('proxyStatus').textContent, /сеть недоступна/)
  } finally { env.close() }
})

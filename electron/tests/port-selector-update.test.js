/**
 * Launcher window: the self-update check.
 *
 * A new version means any new commit on master. The window asks the shell,
 * shows the commit list in a dialog with three outcomes (apply, later,
 * skip this one), and never touches the tree on failure. These tests cover
 * the window side against a fake shell; the git half in main.js is
 * exercised live.
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

const commit = (hash, date, subject) => ({ hash, short: hash.slice(0, 7), date, subject })

/**
 * Mount the launcher against a fake shell.
 * @param check - how updateCheck answers (value or thrown error).
 */
async function mount(check) {
  const calls = []
  const spoken = []
  const captured = {}
  const state = { skipped: '' }

  const bridge = {
    // Колбэк готовности приходит сам (как в настоящем окне после загрузки):
    // именно оттуда стартует тихая автопроверка.
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
    a11ySettings: async () => ({ enabled: false }),
    a11ySave: async (patch) => patch,
    updateCheck: async () => {
      calls.push(['updateCheck'])
      if (check instanceof Error) throw check
      return check
    },
    updateSkip: async (hash) => {
      calls.push(['updateSkip', hash])
      state.skipped = String(hash || '')
      return { skippedCommit: state.skipped }
    },
    updateApply: async () => {
      calls.push(['updateApply'])
      if (check && check.applyFails) throw new Error(check.applyFails)
      return { ok: true, head: 'fedcba9876543210fedcba9876543210fedcba98' }
    },
    updateRollback: async () => {
      calls.push(['updateRollback'])
      if (check && check.rollbackFails) throw new Error(check.rollbackFails)
      return { ok: true, head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', previous: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }
    },
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
  const click = (element) => element.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }))

  return { win, byId, click, calls, spoken, state, close: () => { dom.window.close() } }
}

test('no new commits says so and opens no dialog', async () => {
  const env = await mount({ upToDate: true, local: 'aaaaaaa0000000000000000000000000000000000', remote: 'aaaaaaa0000000000000000000000000000000000' })
  try {
    env.click(env.byId('checkUpdatesBtn'))
    await settle()
    assert.match(env.byId('updateStatus').textContent, /последняя версия/)
    assert.equal(env.byId('updateDialog').hidden, true, 'диалогу нечего показывать')
  } finally { env.close() }
})

test('new commits open the dialog with their list', async () => {
  const commits = [
    commit('1111111000000000000000000000000000000000', '2026-09-20', 'Галочка доступности'),
    commit('2222222000000000000000000000000000000000', '2026-09-19', 'Починка запускалки'),
  ]
  const env = await mount({ upToDate: false, local: 'old', remote: 'new', commits, skipped: false })
  try {
    env.click(env.byId('checkUpdatesBtn'))
    await settle()
    assert.equal(env.byId('updateDialog').hidden, false, 'вопрос должен показаться')
    const rows = env.byId('updateList').querySelectorAll('.server-item')
    assert.equal(rows.length, 2, 'оба коммита должны быть в списке')
    assert.match(rows[0].querySelector('.server-name').textContent, /Галочка доступности/)
    assert.match(rows[0].querySelector('.server-meta').textContent, /1111111 · 2026-09-20/)
    assert.match(env.byId('updateStatus').textContent, /Найдено обновлений: 2/)
    assert.ok(!env.byId('updateStatus').className.includes('scanning'), 'кольцо должно остановиться')
  } finally { env.close() }
})

test('a skipped version still opens on manual check, with a note', async () => {
  const env = await mount({ upToDate: false, local: 'old', remote: 'new', commits: [], skipped: true })
  try {
    // Автопроверка при входе скрытое не показывает — сбрасываем её след...
    env.byId('updateDialog').hidden = true
    env.click(env.byId('checkUpdatesBtn'))
    await settle()
    assert.equal(env.byId('updateDialog').hidden, false, 'вручную спросили — показываем даже скрытое')
    assert.equal(env.byId('updateSkippedNote').hidden, false, 'с пометкой что скрывали')
  } finally { env.close() }
})

test('opening the window auto-checks: new and unskipped proposes itself', async () => {
  const commits = [commit('1111111000000000000000000000000000000000', '2026-09-20', 'Галочка доступности')]
  const env = await mount({ upToDate: false, local: 'old', remote: 'new', commits, skipped: false })
  try {
    // Без единого клика: автопроверка при входе сама открыла диалог.
    assert.equal(env.byId('updateDialog').hidden, false, 'новое и нескрытое предлагается само')
    assert.equal(env.byId('updateList').querySelectorAll('.server-item').length, 1)
  } finally { env.close() }
})

test('opening the window auto-checks: skipped stays silent', async () => {
  const commits = [commit('1111111000000000000000000000000000000000', '2026-09-20', 'Галочка доступности')]
  const env = await mount({ upToDate: false, local: 'old', remote: 'new', commits, skipped: true })
  try {
    assert.equal(env.byId('updateDialog').hidden, true, 'скрытое при входе молчит')
    assert.match(env.byId('updateStatus').textContent, /скрыли/)
  } finally { env.close() }
})

test('apply pulls and asks for a relaunch', async () => {
  const commits = [commit('1111111000000000000000000000000000000000', '2026-09-20', 'Галочка доступности')]
  const env = await mount({ upToDate: false, local: 'old', remote: 'new', commits, skipped: false })
  try {
    env.click(env.byId('checkUpdatesBtn'))
    await settle()
    env.click(env.byId('applyUpdateBtn'))
    await settle()
    assert.ok(env.calls.some(([name]) => name === 'updateApply'), 'окно должно попросить подтянуть')
    assert.equal(env.byId('updateDialog').hidden, true, 'диалог закрывается')
    assert.match(env.byId('updateStatus').textContent, /Перезапустите/)
  } finally { env.close() }
})

test('a failed apply keeps the dialog and reports', async () => {
  const commits = [commit('1111111000000000000000000000000000000000', '2026-09-20', 'Галочка доступности')]
  const env = await mount({
    upToDate: false, local: 'old', remote: 'new', commits, skipped: false, applyFails: 'В папке есть несохранённые изменения',
  })
  try {
    env.click(env.byId('checkUpdatesBtn'))
    await settle()
    env.click(env.byId('applyUpdateBtn'))
    await settle()
    assert.equal(env.byId('updateDialog').hidden, false, 'диалог остаётся для повтора')
    assert.match(env.byId('updateProgress').textContent, /несохранённые/)
  } finally { env.close() }
})

test('later just closes, skip remembers the version', async () => {
  const commits = [commit('1111111000000000000000000000000000000000', '2026-09-20', 'Галочка доступности')]
  const env = await mount({ upToDate: false, local: 'old', remote: 'new', commits, skipped: false })
  try {
    env.click(env.byId('checkUpdatesBtn'))
    await settle()
    env.click(env.byId('laterUpdateBtn'))
    await settle()
    assert.equal(env.byId('updateDialog').hidden, true)
    assert.ok(!env.calls.some(([name]) => name === 'updateSkip'), '«не сейчас» ничего не запоминает')

    env.click(env.byId('checkUpdatesBtn'))
    await settle()
    env.click(env.byId('skipUpdateBtn'))
    await settle()
    const skipped = env.calls.find(([name]) => name === 'updateSkip')
    assert.ok(skipped, 'окно должно запомнить скрытую версию')
    assert.equal(skipped[1], 'new')
    assert.equal(env.byId('updateDialog').hidden, true)
    assert.match(env.byId('updateStatus').textContent, /Скрыто/)
  } finally { env.close() }
})

test('no network reports instead of opening the dialog', async () => {  const env = await mount(new Error("Error invoking remote method 'update-check': Error: Не удалось спросить GitHub: нет сети. Попробуйте ещё раз."))
  try {
    env.click(env.byId('checkUpdatesBtn'))
    await settle()
    assert.equal(env.byId('updateDialog').hidden, true)
    assert.match(env.byId('updateStatus').textContent, /нет сети/)
  } finally { env.close() }
})

test('a hanging check says the network is slow instead of spinning silently', async () => {
  const env = await mount(new Promise(() => {}))
  try {
    env.click(env.byId('checkUpdatesBtn'))
    await settle()
    assert.match(env.byId('updateStatus').textContent, /Спрашиваю GitHub/)
    await new Promise((resolve) => { setTimeout(resolve, 9500) })
    assert.match(env.byId('updateStatus').textContent, /медленная/, 'долгое молчание надо объяснять')
  } finally { env.close() }
})

test('rollback offers the remembered version', async () => {
  const prev = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  const env = await mount({ upToDate: true, local: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', remote: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', previous: prev })
  try {
    // Автопроверка при входе уже подтянула состояние кнопки.
    assert.equal(env.byId('rollbackUpdateBtn').disabled, false, 'кнопка доступна')
    assert.match(env.byId('rollbackStatus').textContent, /bbbbbbb/)
  } finally { env.close() }
})

test('rollback without a remembered version stays unavailable', async () => {
  const env = await mount({ upToDate: true, local: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', remote: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })
  try {
    assert.equal(env.byId('rollbackUpdateBtn').disabled, true, 'откатывать некуда')
    assert.equal(env.byId('rollbackStatus').hidden, true)
  } finally { env.close() }
})

test('rollback returns the code and asks for a relaunch', async () => {
  const prev = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  const env = await mount({ upToDate: true, local: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', remote: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', previous: prev })
  try {
    env.click(env.byId('rollbackUpdateBtn'))
    await settle()
    assert.ok(env.calls.some(([name]) => name === 'updateRollback'), 'окно должно попросить откат')
    assert.match(env.byId('updateStatus').textContent, /Откачено на aaaaaaa/)
    assert.match(env.byId('updateStatus').textContent, /Перезапустите/)
  } finally { env.close() }
})

test('a refused rollback reports and keeps the button alive', async () => {
  const prev = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  const env = await mount({
    upToDate: true, local: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', remote: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    previous: prev, rollbackFails: 'В папке есть несохранённые изменения',
  })
  try {
    env.click(env.byId('rollbackUpdateBtn'))
    await settle()
    assert.match(env.byId('updateStatus').textContent, /несохранённые/)
  } finally { env.close() }
})

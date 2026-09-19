const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM, VirtualConsole } = require('jsdom')

const htmlPath = path.join(__dirname, '..', 'port-selector.html')
const html = fs.readFileSync(htmlPath, 'utf8')

// The inline script talks to the main process through `window.harnessAPI`, which
// preload.js normally injects. Stub every member the script touches so the whole
// file can execute for real instead of being sliced up by the test.
function stubHarnessAPI() {
  const noop = () => {}
  return {
    getAppIcon: () => Promise.resolve(''),
    checkPort: () => Promise.resolve({ ok: true }),
    startHarness: noop,
    minimize: noop,
    maximize: noop,
    close: noop,
    toggleFullscreen: noop,
    v2rayStart: () => Promise.resolve({ running: false, socksPort: 0 }),
    v2rayTest: () => Promise.resolve({ target: 'example.com', latencyMs: 0 }),
    v2rayStop: () => Promise.resolve(),
    onReady: noop,
    onFullscreenChanged: noop,
    onMaximizeChanged: noop,
    onLaunchProgress: noop,
    onLaunchError: noop,
  }
}

// Boots port-selector.html with the real inline script and returns the document.
// `search` is appended to the document URL, which is how main.js forwards the
// software-rendering reason. Any error raised by the inline script fails the test.
function renderPortSelector(search = '') {
  const scriptErrors = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', error => scriptErrors.push(error))

  const dom = new JSDOM(html, {
    url: `https://localhost/port-selector.html${search}`,
    runScripts: 'dangerously',
    virtualConsole,
    beforeParse(window) {
      window.harnessAPI = stubHarnessAPI()
    },
  })

  assert.deepEqual(scriptErrors, [], 'the inline script must run without throwing')
  return dom
}

test('the GPU notice is hidden in the markup and stays hidden without a reason', () => {
  const dom = renderPortSelector()
  const notice = dom.window.document.getElementById('gpuNotice')

  assert.ok(notice, 'port-selector.html must contain the #gpuNotice element')
  assert.ok(notice.classList.contains('hidden'), 'the notice starts hidden')
  assert.equal(notice.textContent, '', 'no reason means no message')

  dom.window.close()
})

test('a crash fallback explains that the app restarted in software rendering', () => {
  const dom = renderPortSelector('?gpu=crash')
  const notice = dom.window.document.getElementById('gpuNotice')

  assert.equal(notice.classList.contains('hidden'), false, 'the notice becomes visible')
  assert.match(notice.textContent, /перезапустилось/)
  assert.match(notice.textContent, /программного рендеринга/)

  dom.window.close()
})

test('an environment or flag fallback names DSH_SOFTWARE_RENDERING', () => {
  for (const reason of ['flag', 'env']) {
    const dom = renderPortSelector(`?gpu=${reason}`)
    const notice = dom.window.document.getElementById('gpuNotice')

    assert.equal(notice.classList.contains('hidden'), false, `${reason}: the notice becomes visible`)
    assert.match(notice.textContent, /DSH_SOFTWARE_RENDERING/, `${reason}: the message names the switch`)

    dom.window.close()
  }
})

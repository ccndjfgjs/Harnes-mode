// Source contract for the media-capture wiring in electron/main.js. The
// handlers themselves resolve inside a live Electron session, which a
// node:test process cannot boot; what this file can pin is the wiring that
// makes the desktop voice features possible at all:
//
//   - setDisplayMediaRequestHandler: without it Electron REJECTS every
//     getDisplayMedia call, so deleting it silently kills screen broadcast
//     in the desktop app while the browser keeps working;
//   - useSystemPicker: the flag that turns the handler into the OS share
//     prompt instead of a silent full-screen capture;
//   - setPermissionRequestHandler / setPermissionCheckHandler: the pinned
//     grant behind getUserMedia and navigator.permissions.query;
//   - installation before the window is created: a handler registered after
//     the first renderer call would simply never run.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const mainPath = path.join(__dirname, '..', 'main.js')
const source = fs.readFileSync(mainPath, 'utf8')

test('main.js wires the display-media handler to the system picker', () => {
  assert.match(source, /setDisplayMediaRequestHandler\(/)
  assert.match(source, /useSystemPicker:\s*true/)
  assert.match(source, /desktopCapturer\.getSources\(/)
})

test('main.js pins the capture permission grant', () => {
  assert.match(source, /setPermissionRequestHandler\(/)
  assert.match(source, /setPermissionCheckHandler\(/)
})

test('the handlers install before the window is created', () => {
  const install = source.indexOf('installCapturePermissionHandlers();')
  const create = source.indexOf('createMainWindow();', install)
  assert.notEqual(install, -1, 'install call missing')
  assert.notEqual(create, -1, 'window creation missing after install')
  assert.ok(install < create, 'handlers must be installed before createMainWindow runs')
})

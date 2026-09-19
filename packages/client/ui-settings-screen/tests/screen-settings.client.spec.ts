// @vitest-environment jsdom
// Screen Broadcast settings document: defaults, per-field validation, and the
// clamped writer over the browser-local storage.

import { afterEach, describe, expect, it } from 'vitest'
import {
  BUFFER_BYTES_MAX, BUFFER_BYTES_MIN, BUFFER_FRAMES_MAX, BUFFER_FRAMES_MIN, BUFFER_TEXT_MAX, BUFFER_TEXT_MIN,
  CAPTURE_SCOPES, DEFAULT_SCREEN_SETTINGS, INTERVAL_MAX_MS, INTERVAL_MIN_MS, MAX_EDGE_CHOICES,
  PREVIEW_CORNERS, THRESHOLD_MAX, THRESHOLD_MIN,
  readScreenSettings, writeScreenSettings,
} from '../src/client/screen-settings.ts'

afterEach(() => {
  localStorage.clear()
})

describe('readScreenSettings', () => {
  it('answers the shipped defaults without a stored document', () => {
    expect(readScreenSettings()).toEqual(DEFAULT_SCREEN_SETTINGS)
  })

  it('treats a corrupt or non-object document as absent', () => {
    localStorage.setItem('dsh.screen.settings', '{nope')
    expect(readScreenSettings()).toEqual(DEFAULT_SCREEN_SETTINGS)
    localStorage.setItem('dsh.screen.settings', '"text"')
    expect(readScreenSettings()).toEqual(DEFAULT_SCREEN_SETTINGS)
  })

  it('reads a complete stored document', () => {
    localStorage.setItem('dsh.screen.settings', JSON.stringify({
      broadcast: false,
      intervalMs: 2000,
      showPreview: false,
      previewCorner: 'top-left',
      maxEdge: 1920,
      quality: 0.5,
      captureAudio: true,
      stopOnEnded: false,
      sendOnChange: true,
      changeThreshold: 0.05,
      captureScope: 'window',
      sendText: true,
      bufferFrames: 12,
      bufferBytes: 8 * 1024 * 1024,
      bufferTextChars: 5000,
    }))
    expect(readScreenSettings()).toEqual({
      broadcast: false,
      intervalMs: 2000,
      showPreview: false,
      previewCorner: 'top-left',
      maxEdge: 1920,
      quality: 0.5,
      captureAudio: true,
      stopOnEnded: false,
      sendOnChange: true,
      changeThreshold: 0.05,
      captureScope: 'window',
      sendText: true,
      bufferFrames: 12,
      bufferBytes: 8 * 1024 * 1024,
      bufferTextChars: 5000,
    })
  })

  it('validates each field on its own, so one bad field spares the rest', () => {
    localStorage.setItem('dsh.screen.settings', JSON.stringify({
      broadcast: 'yes',
      intervalMs: 'soon',
      previewCorner: 'middle',
      maxEdge: 999,
      quality: 'crisp',
      sendOnChange: 'maybe',
      changeThreshold: 'sensitive',
      captureScope: 'everything',
      sendText: 'perhaps',
      bufferFrames: 'many',
      bufferBytes: 'plenty',
      bufferTextChars: 'lots',
    }))
    const settings = readScreenSettings()
    expect(settings.broadcast).toBe(DEFAULT_SCREEN_SETTINGS.broadcast)
    expect(settings.intervalMs).toBe(DEFAULT_SCREEN_SETTINGS.intervalMs)
    expect(settings.previewCorner).toBe(DEFAULT_SCREEN_SETTINGS.previewCorner)
    expect(settings.maxEdge).toBe(DEFAULT_SCREEN_SETTINGS.maxEdge)
    expect(settings.quality).toBe(DEFAULT_SCREEN_SETTINGS.quality)
    expect(settings.sendOnChange).toBe(DEFAULT_SCREEN_SETTINGS.sendOnChange)
    expect(settings.changeThreshold).toBe(DEFAULT_SCREEN_SETTINGS.changeThreshold)
    expect(settings.captureScope).toBe(DEFAULT_SCREEN_SETTINGS.captureScope)
    expect(settings.sendText).toBe(DEFAULT_SCREEN_SETTINGS.sendText)
    expect(settings.bufferFrames).toBe(DEFAULT_SCREEN_SETTINGS.bufferFrames)
    expect(settings.bufferBytes).toBe(DEFAULT_SCREEN_SETTINGS.bufferBytes)
    expect(settings.bufferTextChars).toBe(DEFAULT_SCREEN_SETTINGS.bufferTextChars)
  })

  it('clamps an out-of-range interval and quality', () => {
    localStorage.setItem('dsh.screen.settings', JSON.stringify({ intervalMs: 999_999, quality: 5 }))
    expect(readScreenSettings().intervalMs).toBe(INTERVAL_MAX_MS)
    expect(readScreenSettings().quality).toBe(1)
    localStorage.setItem('dsh.screen.settings', JSON.stringify({ intervalMs: 1, quality: -1 }))
    expect(readScreenSettings().intervalMs).toBe(INTERVAL_MIN_MS)
    expect(readScreenSettings().quality).toBe(0.1)
  })

  it('clamps the change threshold into its allowed range', () => {
    localStorage.setItem('dsh.screen.settings', JSON.stringify({ changeThreshold: 5 }))
    expect(readScreenSettings().changeThreshold).toBe(THRESHOLD_MAX)
    localStorage.setItem('dsh.screen.settings', JSON.stringify({ changeThreshold: 0 }))
    expect(readScreenSettings().changeThreshold).toBe(THRESHOLD_MIN)
  })

  it('clamps the three buffer limits into their allowed ranges', () => {
    localStorage.setItem('dsh.screen.settings', JSON.stringify({
      bufferFrames: 10_000, bufferBytes: 10 ** 12, bufferTextChars: 10 ** 9,
    }))
    expect(readScreenSettings().bufferFrames).toBe(BUFFER_FRAMES_MAX)
    expect(readScreenSettings().bufferBytes).toBe(BUFFER_BYTES_MAX)
    expect(readScreenSettings().bufferTextChars).toBe(BUFFER_TEXT_MAX)
    localStorage.setItem('dsh.screen.settings', JSON.stringify({
      bufferFrames: 0, bufferBytes: 1, bufferTextChars: 1,
    }))
    expect(readScreenSettings().bufferFrames).toBe(BUFFER_FRAMES_MIN)
    expect(readScreenSettings().bufferBytes).toBe(BUFFER_BYTES_MIN)
    expect(readScreenSettings().bufferTextChars).toBe(BUFFER_TEXT_MIN)
  })

  it('keeps a fractional frame count whole, because half a frame is not a frame', () => {
    localStorage.setItem('dsh.screen.settings', JSON.stringify({ bufferFrames: 7.6, bufferTextChars: 4321.8 }))
    expect(readScreenSettings().bufferFrames).toBe(8)
    expect(readScreenSettings().bufferTextChars).toBe(4322)
  })

  it('accepts every offered resolution and corner', () => {
    for (const edge of MAX_EDGE_CHOICES) {
      localStorage.setItem('dsh.screen.settings', JSON.stringify({ maxEdge: edge }))
      expect(readScreenSettings().maxEdge).toBe(edge)
    }
    for (const corner of PREVIEW_CORNERS) {
      localStorage.setItem('dsh.screen.settings', JSON.stringify({ previewCorner: corner }))
      expect(readScreenSettings().previewCorner).toBe(corner)
    }
    for (const scope of CAPTURE_SCOPES) {
      localStorage.setItem('dsh.screen.settings', JSON.stringify({ captureScope: scope }))
      expect(readScreenSettings().captureScope).toBe(scope)
    }
  })
})

describe('writeScreenSettings', () => {
  it('merges a patch over the stored document', () => {
    writeScreenSettings({ intervalMs: 3000 })
    expect(readScreenSettings().intervalMs).toBe(3000)
    writeScreenSettings({ showPreview: false })
    const settings = readScreenSettings()
    expect(settings.intervalMs).toBe(3000)
    expect(settings.showPreview).toBe(false)
  })

  it('stores a document the reader need not sanitize', () => {
    writeScreenSettings({
      intervalMs: 999_999,
      quality: 5,
      maxEdge: 777,
      previewCorner: 'nowhere' as never,
      changeThreshold: 9,
      captureScope: 'everywhere' as never,
    })
    expect(readScreenSettings()).toEqual({
      ...DEFAULT_SCREEN_SETTINGS,
      intervalMs: INTERVAL_MAX_MS,
      quality: 1,
      changeThreshold: THRESHOLD_MAX,
    })
  })

  it('writes the smart-send, scope, and text switches', () => {
    writeScreenSettings({ sendOnChange: true, sendText: true, captureScope: 'screen' })
    const settings = readScreenSettings()
    expect(settings.sendOnChange).toBe(true)
    expect(settings.sendText).toBe(true)
    expect(settings.captureScope).toBe('screen')
  })

  it('stores the three buffer limits and clamps what is out of range', () => {
    writeScreenSettings({ bufferFrames: 16, bufferBytes: 4 * 1024 * 1024, bufferTextChars: 8000 })
    const stored = readScreenSettings()
    expect(stored.bufferFrames).toBe(16)
    expect(stored.bufferBytes).toBe(4 * 1024 * 1024)
    expect(stored.bufferTextChars).toBe(8000)
    writeScreenSettings({ bufferFrames: -5, bufferBytes: 1, bufferTextChars: 10 ** 9 })
    expect(readScreenSettings()).toEqual({
      ...DEFAULT_SCREEN_SETTINGS,
      bufferFrames: BUFFER_FRAMES_MIN,
      bufferBytes: BUFFER_BYTES_MIN,
      bufferTextChars: BUFFER_TEXT_MAX,
    })
  })

  it('survives a storage that refuses writes', () => {
    const original = Object.getOwnPropertyDescriptor(Storage.prototype, 'setItem')
    Object.defineProperty(Storage.prototype, 'setItem', {
      configurable: true,
      value: () => { throw new Error('quota') },
    })
    expect(() => { writeScreenSettings({ broadcast: false }) }).not.toThrow()
    if (original !== undefined) Object.defineProperty(Storage.prototype, 'setItem', original)
  })
})

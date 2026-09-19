// @vitest-environment jsdom
// Screen capture: an explicit lifecycle, a bounded frame buffer, and consumers
// that come and go without touching the broadcast.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createScreenCaptureEngine, displayConstraints, screenCapture } from '../src/screen-capture-engine.ts'
import type { FrameTimer } from '../src/screen-capture-engine.ts'
import { readScreenSettings } from '../src/screen-settings.ts'

/** Size of the next encoded frame, in bytes. */
let frameBytes = 4096
/** Grey value the change detector sees; changing it fakes a moved screen. */
let pixel = 0

beforeEach(() => {
  frameBytes = 4096
  pixel = 0
  // jsdom has no canvas backend, so the two encoding steps are faked here.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement, kind: string,
  ): unknown {
    if (kind !== '2d') return null
    return {
      drawImage: (): void => {},
      getImageData: (_x: number, _y: number, width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4).fill(pixel),
      }),
    }
  } as never)
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
    this: HTMLCanvasElement, callback: BlobCallback,
  ): void {
    callback(new Blob([new Uint8Array(frameBytes)]))
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,preview')
  // A hidden element still has to "play"; jsdom does not implement it.
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

/** One fake video track, so a spec can end the capture the way the system does. */
interface FakeTrack {
  readonly kind: string
  readonly stop: ReturnType<typeof vi.fn>
  readonly addEventListener: (type: string, listener: () => void) => void
  readonly end: () => void
}

/** A display stream with one video track. */
function fakeStream(): { stream: MediaStream; track: FakeTrack } {
  const ended: (() => void)[] = []
  const track: FakeTrack = {
    kind: 'video',
    stop: vi.fn(),
    addEventListener: (type, listener): void => { if (type === 'ended') ended.push(listener) },
    end: (): void => { for (const listener of ended) listener() },
  }
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream
  return { stream, track }
}

/** A frame scheduler the spec drives by hand. */
function fakeTimer() {
  let tick: (() => void) | undefined
  let interval = 0
  const timer: FrameTimer = {
    start: (intervalMs, onTick): void => {
      interval = intervalMs
      tick = onTick
    },
    stop: (): void => { tick = undefined },
  }
  return {
    timer,
    interval: (): number => interval,
    running: (): boolean => tick !== undefined,
    /** Fire one tick and let the sampling chain settle. */
    fire: async (): Promise<void> => {
      tick?.()
      for (let index = 0; index < 6; index += 1) await Promise.resolve()
    },
  }
}

/** Stage a broadcast preference document. */
function stage(overrides: Record<string, unknown> = {}): void {
  localStorage.setItem('dsh.screen.settings', JSON.stringify({
    broadcast: true, intervalMs: 1000, showPreview: false, ...overrides,
  }))
}

/** Build an engine over a stream the spec controls. */
function bench(overrides: Record<string, unknown> = {}) {
  stage(overrides)
  const { stream, track } = fakeStream()
  const clock = fakeTimer()
  let time = 1000
  const requestStream = vi.fn(() => Promise.resolve(stream))
  const engine = createScreenCaptureEngine({
    requestStream,
    timer: clock.timer,
    now: () => { time += 1; return time },
  })
  return { engine, requestStream, track, clock }
}

describe('lifecycle', () => {
  it('starts idle with nothing held', () => {
    const { engine } = bench()
    expect(engine.state()).toBe('idle')
    expect(engine.snapshot()).toEqual({
      state: 'idle',
      frames: 0,
      bytes: 0,
      text: '',
      captured: 0,
      evicted: 0,
      skipped: 0,
      lastError: '',
      startedAt: undefined,
      preview: undefined,
    })
  })

  it('goes idle → starting → live and takes the first frame at once', async () => {
    const { engine, requestStream } = bench()
    const seen: string[] = []
    engine.subscribe((snapshot) => { seen.push(snapshot.state) })
    await engine.start()
    expect(requestStream).toHaveBeenCalledOnce()
    // The second 'starting' is the first frame arriving while the broadcast is
    // still being set up: a consumer hears about the picture, not just the state.
    expect(seen).toEqual(['starting', 'starting', 'live'])
    const snapshot = engine.snapshot()
    expect(snapshot.state).toBe('live')
    expect(snapshot.captured).toBe(1)
    expect(snapshot.frames).toBe(1)
    expect(snapshot.startedAt).toBeDefined()
  })

  it('starts sampling on the configured cadence', async () => {
    const { engine, clock } = bench({ intervalMs: 2500 })
    await engine.start()
    expect(clock.running()).toBe(true)
    expect(clock.interval()).toBe(2500)
    await clock.fire()
    expect(engine.snapshot().captured).toBe(2)
  })

  it('ignores a second start while one is already running', async () => {
    const { engine, requestStream } = bench()
    await engine.start()
    await engine.start()
    expect(requestStream).toHaveBeenCalledOnce()
  })

  it('keeps the stream across a pause and resumes without asking again', async () => {
    const { engine, requestStream, track, clock } = bench()
    await engine.start()
    engine.pause()
    expect(engine.state()).toBe('paused')
    expect(track.stop).not.toHaveBeenCalled()
    expect(clock.running()).toBe(false)
    await engine.start()
    expect(engine.state()).toBe('live')
    expect(requestStream).toHaveBeenCalledOnce()
  })

  it('releases the stream on stop but keeps what was already collected', async () => {
    const { engine, track } = bench()
    await engine.start()
    await engine.stop()
    expect(track.stop).toHaveBeenCalled()
    expect(engine.state()).toBe('idle')
    // The frames are the broadcast's product: a consumer that has not taken
    // them yet still finds them.
    expect(engine.drain()).toHaveLength(1)
  })

  it('records a refused request as a failure with the reason', async () => {
    stage()
    const engine = createScreenCaptureEngine({
      requestStream: () => Promise.reject(new Error('Permission denied')),
      timer: fakeTimer().timer,
    })
    await engine.start()
    expect(engine.state()).toBe('failed')
    expect(engine.snapshot().lastError).toBe('Permission denied')
    expect(engine.snapshot().frames).toBe(0)
  })

  it('ends the broadcast when the system takes the screen back', async () => {
    const { engine, track } = bench({ stopOnEnded: true })
    await engine.start()
    track.end()
    expect(engine.state()).toBe('idle')
  })

  it('reports instead of stopping when the setting says to carry on', async () => {
    const { engine, track } = bench({ stopOnEnded: false })
    await engine.start()
    track.end()
    expect(engine.state()).toBe('failed')
    expect(engine.snapshot().lastError).toContain('released')
  })

  it('takes exactly one frame in one-shot mode and releases the stream', async () => {
    const { engine, track } = bench({ broadcast: false })
    await engine.start()
    expect(track.stop).toHaveBeenCalled()
    expect(engine.state()).toBe('idle')
    expect(engine.snapshot().captured).toBe(1)
    expect(engine.drain()).toHaveLength(1)
  })

  it('clears everything on dispose', async () => {
    const { engine } = bench()
    await engine.start()
    engine.addText('экран')
    engine.dispose()
    const snapshot = engine.snapshot()
    expect(snapshot.state).toBe('idle')
    expect(snapshot.frames).toBe(0)
    expect(snapshot.text).toBe('')
    expect(snapshot.captured).toBe(0)
    expect(engine.drain()).toEqual([])
  })
})

describe('bounded buffer', () => {
  it('keeps only the newest frames and counts every eviction', async () => {
    const { engine, clock } = bench({ bufferFrames: 3, bufferBytes: 100_000_000 })
    await engine.start()
    for (let index = 0; index < 5; index += 1) await clock.fire()
    const snapshot = engine.snapshot()
    expect(snapshot.captured).toBe(6)
    expect(snapshot.frames).toBe(3)
    // Six taken, three kept: three were dropped, and the drop is counted.
    expect(snapshot.evicted).toBe(3)
  })

  it('drops by total size as well as by count', async () => {
    frameBytes = 400_000
    const { engine, clock } = bench({ bufferFrames: 64, bufferBytes: 1_000_000 })
    await engine.start()
    for (let index = 0; index < 4; index += 1) await clock.fire()
    const snapshot = engine.snapshot()
    expect(snapshot.captured).toBe(5)
    expect(snapshot.frames).toBe(2)
    expect(snapshot.bytes).toBe(800_000)
    expect(snapshot.evicted).toBe(3)
  })

  it('keeps a single frame that is larger than the whole budget', async () => {
    frameBytes = 2_000_000
    const { engine } = bench({ bufferFrames: 8, bufferBytes: 1_000_000 })
    await engine.start()
    // An empty buffer would be less useful than one frame the consumer can use.
    expect(engine.snapshot().frames).toBe(1)
    expect(engine.snapshot().evicted).toBe(0)
  })

  it('hands frames out oldest first and empties the buffer', async () => {
    const { engine, clock } = bench({ bufferFrames: 8 })
    await engine.start()
    await clock.fire()
    const taken = engine.drain()
    expect(taken).toHaveLength(2)
    expect(taken[0]!.at).toBeLessThan(taken[1]!.at)
    expect(engine.snapshot().frames).toBe(0)
    expect(engine.snapshot().bytes).toBe(0)
    expect(engine.drain()).toEqual([])
  })

  it('describes every frame it hands out', async () => {
    const { engine } = bench()
    await engine.start()
    const [frame] = engine.drain()
    expect(frame?.bytes).toBe(frameBytes)
    expect(frame?.width).toBe(1280)
    expect(frame?.height).toBe(720)
    expect(frame?.blob.size).toBe(frameBytes)
  })

  it('bounds the accumulated text and keeps its tail', () => {
    const { engine } = bench({ bufferTextChars: 1000 })
    engine.addText('a'.repeat(700))
    engine.addText('b'.repeat(700))
    const text = engine.snapshot().text
    expect(text).toHaveLength(1000)
    expect(text.endsWith('b'.repeat(700))).toBe(true)
  })

  it('joins successive readings with a newline and ignores blanks', () => {
    const { engine } = bench()
    engine.addText('первая строка')
    engine.addText('   ')
    engine.addText('вторая строка')
    expect(engine.snapshot().text).toBe('первая строка\nвторая строка')
    engine.clearText()
    expect(engine.snapshot().text).toBe('')
  })
})

describe('change gate', () => {
  it('takes the first frame of a run whatever the screen shows', async () => {
    const { engine, clock } = bench({ sendOnChange: true, changeThreshold: 0.02 })
    await engine.start()
    expect(engine.snapshot().captured).toBe(1)
    // Nothing moved since: the scheduled tick is declined and counted.
    await clock.fire()
    const snapshot = engine.snapshot()
    expect(snapshot.captured).toBe(1)
    expect(snapshot.skipped).toBe(1)
  })

  it('takes a scheduled frame once the screen moves', async () => {
    const { engine, clock } = bench({ sendOnChange: true, changeThreshold: 0.02 })
    await engine.start()
    pixel = 200
    await clock.fire()
    expect(engine.snapshot().captured).toBe(2)
    expect(engine.snapshot().skipped).toBe(0)
  })
})

describe('preview', () => {
  it('paints a preview picture when the setting is on', async () => {
    const { engine } = bench({ showPreview: true })
    await engine.start()
    expect(engine.snapshot().preview).toBe('data:image/jpeg;base64,preview')
  })

  it('paints nothing when the setting is off', async () => {
    const { engine } = bench({ showPreview: false })
    await engine.start()
    expect(engine.snapshot().preview).toBeUndefined()
  })

  it('drops the preview once the broadcast ends', async () => {
    const { engine } = bench({ showPreview: true })
    await engine.start()
    await engine.stop()
    expect(engine.snapshot().preview).toBeUndefined()
  })
})

describe('consumers', () => {
  it('tells every consumer, not just the first one', async () => {
    const { engine } = bench()
    const first: string[] = []
    const second: string[] = []
    engine.subscribe((snapshot) => { first.push(snapshot.state) })
    engine.subscribe((snapshot) => { second.push(snapshot.state) })
    await engine.start()
    expect(first).toEqual(['starting', 'starting', 'live'])
    expect(second).toEqual(['starting', 'starting', 'live'])
  })

  it('keeps running when a consumer disappears', async () => {
    // This is the whole point: the panel unmounting must not touch the capture.
    const { engine, clock, track } = bench()
    const unsubscribe = engine.subscribe(() => {})
    await engine.start()
    unsubscribe()
    await clock.fire()
    expect(engine.state()).toBe('live')
    expect(engine.snapshot().captured).toBe(2)
    expect(track.stop).not.toHaveBeenCalled()
  })

  it('survives a consumer that throws', async () => {
    const { engine, clock } = bench()
    const heard: number[] = []
    engine.subscribe(() => { throw new Error('consumer exploded') })
    engine.subscribe((snapshot) => { heard.push(snapshot.captured) })
    await expect(engine.start()).resolves.toBeUndefined()
    await clock.fire()
    expect(heard.length).toBeGreaterThan(0)
  })

  it('stops notifying once disposed', async () => {
    const { engine } = bench()
    const heard: string[] = []
    engine.subscribe((snapshot) => { heard.push(snapshot.state) })
    engine.dispose()
    expect(heard).toEqual([])
  })
})

describe('displayConstraints', () => {
  it('leaves the choice to the picker in ask mode', () => {
    stage({ captureScope: 'ask', captureAudio: false })
    expect(displayConstraints(readScreenSettings())).toEqual({ video: true, audio: false })
  })

  it('expresses the scope as a preference the picker may still confirm', () => {
    stage({ captureScope: 'window', captureAudio: true })
    expect(displayConstraints(readScreenSettings()))
      .toEqual({ video: { displaySurface: 'window' }, audio: true })
  })
})

describe('the app-wide capture', () => {
  it('is one instance, created on first use', () => {
    const first = screenCapture()
    expect(screenCapture()).toBe(first)
    first.dispose()
  })
})

describe('display sleep', () => {
  /** Stage the desktop shell the packaged app exposes. */
  function stubShell(): ReturnType<typeof vi.fn> {
    const setScreenBroadcast = vi.fn()
    vi.stubGlobal('harnessAPI', { setScreenBroadcast })
    return setScreenBroadcast
  }

  it('holds the display awake only while frames are being taken', async () => {
    const setScreenBroadcast = stubShell()
    const { engine, clock } = bench()
    await engine.start()
    expect(setScreenBroadcast).toHaveBeenLastCalledWith(true)
    engine.pause()
    expect(setScreenBroadcast).toHaveBeenLastCalledWith(false)
    await engine.start()
    expect(setScreenBroadcast).toHaveBeenLastCalledWith(true)
    await clock.fire()
    await engine.stop()
    expect(setScreenBroadcast).toHaveBeenLastCalledWith(false)
  })

  it('lets the display go when a broadcast fails', async () => {
    const setScreenBroadcast = stubShell()
    stage()
    const engine = createScreenCaptureEngine({
      requestStream: () => Promise.reject(new Error('Permission denied')),
      timer: fakeTimer().timer,
    })
    await engine.start()
    expect(setScreenBroadcast).toHaveBeenLastCalledWith(false)
  })

  it('lets the display go on dispose', async () => {
    const setScreenBroadcast = stubShell()
    const { engine } = bench()
    await engine.start()
    engine.dispose()
    expect(setScreenBroadcast).toHaveBeenLastCalledWith(false)
  })

  it('is a no-op where there is no desktop shell', async () => {
    const { engine } = bench()
    await expect(engine.start()).resolves.toBeUndefined()
    await expect(engine.stop()).resolves.toBeUndefined()
  })

  it('survives a shell that refuses the request', async () => {
    vi.stubGlobal('harnessAPI', {
      setScreenBroadcast: () => { throw new Error('shell refused') },
    })
    const { engine } = bench()
    await expect(engine.start()).resolves.toBeUndefined()
    expect(engine.state()).toBe('live')
  })
})

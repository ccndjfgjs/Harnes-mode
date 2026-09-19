// @vitest-environment jsdom
// Microphone capture: the bottom layer of the voice module. The device, the
// recorder, and the decoder are all replaced here, because what matters is the
// lifecycle the layers above depend on — not whether this machine has a mic.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createAudioCapture, isAudioCaptureAvailable,
} from '../src/voice/audio-capture.ts'
import type { DecoderLike, RecorderLike } from '../src/voice/audio-capture.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** One granted microphone stream holding a single stoppable track. */
function makeStream(): { stream: MediaStream, stop: ReturnType<typeof vi.fn> } {
  const stop = vi.fn()
  const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream
  return { stream, stop }
}

/** Options for {@link makeRecorder}. */
interface RecorderOptions {
  /** Container the recorder reports. */
  readonly mimeType?: string
  /** Chunks handed over on stop; defaults to one non-empty chunk. */
  readonly chunks?: readonly Blob[]
  /** Fail the recording instead of finishing it. */
  readonly fail?: boolean
  /** Never report the stop, as a wedged device would. */
  readonly silent?: boolean
}

/** A recorder the spec drives through its own stop(). */
function makeRecorder(options: RecorderOptions = {}): RecorderLike {
  const recorder: RecorderLike = {
    mimeType: options.mimeType ?? 'audio/webm;codecs=opus',
    start: (): void => {},
    stop: (): void => {
      if (options.silent === true) return
      if (options.fail === true) {
        recorder.onerror?.(new Error('device lost'))
        return
      }
      for (const chunk of options.chunks ?? [new Blob([new Uint8Array(8)])]) {
        recorder.ondataavailable?.({ data: chunk })
      }
      recorder.onstop?.()
    },
    ondataavailable: null,
    onstop: null,
    onerror: null,
  }
  return recorder
}

/** A decoder that hands back prepared channels. */
function makeDecoder(channels: readonly Float32Array[], sampleRate = 48000): DecoderLike {
  return {
    decodeAudioData: async () => ({
      sampleRate,
      numberOfChannels: channels.length,
      getChannelData: (channel: number): Float32Array => channels[channel] ?? new Float32Array(0),
    }),
    close: async () => {},
  }
}

/** A decoder that refuses, as an unsupported container would. */
function brokenDecoder(): DecoderLike {
  return {
    decodeAudioData: async () => { throw new Error('cannot decode') },
    close: async () => {},
  }
}

/** A watchdog the spec fires by hand, so no test waits on real time. */
function fakeTimers(): {
  schedule: (run: () => void, ms: number) => ReturnType<typeof setTimeout>
  unschedule: (handle: ReturnType<typeof setTimeout>) => void
  fire: () => void
} {
  const pending: (() => void)[] = []
  return {
    schedule: (run) => {
      pending.push(run)
      return pending.length as unknown as ReturnType<typeof setTimeout>
    },
    unschedule: () => {},
    fire: () => { pending.shift()?.() },
  }
}

describe('isAudioCaptureAvailable', () => {
  it('answers false when the runtime has neither a microphone nor a recorder', () => {
    expect(isAudioCaptureAvailable()).toBe(false)
  })

  it('answers true only when both halves exist', () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: async () => makeStream().stream },
      configurable: true,
    })
    expect(isAudioCaptureAvailable()).toBe(false)
    vi.stubGlobal('MediaRecorder', function MediaRecorder(): void {})
    expect(isAudioCaptureAvailable()).toBe(true)
  })

  it('answers false when only the recorder exists', () => {
    Object.defineProperty(navigator, 'mediaDevices', { value: {}, configurable: true })
    vi.stubGlobal('MediaRecorder', function MediaRecorder(): void {})
    expect(isAudioCaptureAvailable()).toBe(false)
  })
})

describe('createAudioCapture over injected devices', () => {
  it('records through the injected stream and hands back a recognizer-shaped clip', async () => {
    const { stream, stop } = makeStream()
    const capture = createAudioCapture({
      requestStream: async () => stream,
      createRecorder: () => makeRecorder(),
      pickMimeType: () => 'audio/webm;codecs=opus',
      createDecoder: () => makeDecoder([new Float32Array(48000).fill(0.5)], 48000),
      now: () => 1000,
    })
    const seen: string[] = []
    capture.subscribe((snapshot) => { seen.push(snapshot.state) })
    expect(capture.state()).toBe('idle')
    await capture.start()
    expect(capture.state()).toBe('recording')
    expect(capture.snapshot().startedAt).toBe(1000)
    const clip = await capture.stop()
    expect(clip?.sampleRate).toBe(16000)
    expect(clip?.blob.type).toBe('audio/wav')
    expect(clip?.durationMs).toBe(1000)
    expect(clip?.bytes).toBeGreaterThan(44)
    expect(capture.state()).toBe('idle')
    expect(capture.snapshot().startedAt).toBeUndefined()
    // The microphone is released as soon as the recording ends.
    expect(stop).toHaveBeenCalledTimes(1)
    expect(seen).toEqual(['recording', 'encoding', 'idle'])
  })

  it('answers nothing when the recording held no audio at all', async () => {
    const capture = createAudioCapture({
      requestStream: async () => makeStream().stream,
      createRecorder: () => makeRecorder({ chunks: [new Blob([])] }),
      pickMimeType: () => '',
      createDecoder: () => makeDecoder([]),
    })
    await capture.start()
    expect(await capture.stop()).toBeUndefined()
    expect(capture.state()).toBe('idle')
  })

  it('ignores a start while a recording is already running', async () => {
    const stream = makeStream().stream
    const requestStream = vi.fn(async () => stream)
    const capture = createAudioCapture({
      requestStream,
      createRecorder: () => makeRecorder(),
      pickMimeType: () => '',
      createDecoder: () => makeDecoder([new Float32Array(16000)]),
    })
    await capture.start()
    await capture.start()
    expect(requestStream).toHaveBeenCalledTimes(1)
  })

  it('answers nothing when stopped while not recording', async () => {
    const capture = createAudioCapture({ requestStream: async () => makeStream().stream })
    expect(await capture.stop()).toBeUndefined()
  })

  it('fails loudly when the microphone is refused', async () => {
    const capture = createAudioCapture({
      requestStream: async () => { throw new Error('permission denied') },
      createRecorder: () => makeRecorder(),
      pickMimeType: () => '',
      createDecoder: () => makeDecoder([]),
    })
    await capture.start()
    expect(capture.state()).toBe('failed')
    expect(capture.snapshot().lastError).toBe('permission denied')
  })

  it('fails loudly when the recorder reports an error', async () => {
    const capture = createAudioCapture({
      requestStream: async () => makeStream().stream,
      createRecorder: () => makeRecorder({ fail: true }),
      pickMimeType: () => '',
      createDecoder: () => makeDecoder([]),
    })
    await capture.start()
    // A failing recorder must end the wait, not freeze it: this resolves only
    // because the error reports the stop as well as the failure.
    expect(await capture.stop()).toBeUndefined()
    expect(capture.state()).toBe('failed')
    expect(capture.snapshot().lastError).toBe('device lost')
  })

  it('fails loudly when a wedged recorder never reports its stop', async () => {
    const timers = fakeTimers()
    const capture = createAudioCapture({
      requestStream: async () => makeStream().stream,
      createRecorder: () => makeRecorder({ silent: true }),
      pickMimeType: () => '',
      createDecoder: () => makeDecoder([]),
      schedule: timers.schedule,
      unschedule: timers.unschedule,
      stopTimeoutMs: 50,
    })
    await capture.start()
    const stopping = capture.stop()
    expect(capture.state()).toBe('encoding')
    timers.fire()
    expect(await stopping).toBeUndefined()
    expect(capture.state()).toBe('failed')
    expect(capture.snapshot().lastError).toContain('did not report that it stopped')
  })

  it('fails loudly when the recording cannot be decoded', async () => {
    const capture = createAudioCapture({
      requestStream: async () => makeStream().stream,
      createRecorder: () => makeRecorder(),
      pickMimeType: () => '',
      createDecoder: brokenDecoder,
    })
    await capture.start()
    expect(await capture.stop()).toBeUndefined()
    expect(capture.state()).toBe('failed')
    expect(capture.snapshot().lastError).toBe('cannot decode')
  })

  it('describes a non-Error failure as text', async () => {
    const capture = createAudioCapture({
      requestStream: async () => { throw 'flat refusal' },
      createRecorder: () => makeRecorder(),
      pickMimeType: () => '',
      createDecoder: () => makeDecoder([]),
    })
    await capture.start()
    expect(capture.snapshot().lastError).toBe('flat refusal')
  })

  it('abandons a recording without producing a clip', async () => {
    const { stream, stop } = makeStream()
    const capture = createAudioCapture({
      requestStream: async () => stream,
      createRecorder: () => makeRecorder(),
      pickMimeType: () => '',
      createDecoder: () => makeDecoder([]),
    })
    await capture.start()
    capture.cancel()
    expect(capture.state()).toBe('idle')
    expect(capture.snapshot().lastError).toBe('')
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('ignores a cancel when nothing is being recorded', () => {
    const capture = createAudioCapture({ requestStream: async () => makeStream().stream })
    capture.cancel()
    expect(capture.state()).toBe('idle')
  })

  it('stops notifying after dispose and releases the device', async () => {
    const { stream, stop } = makeStream()
    const capture = createAudioCapture({
      requestStream: async () => stream,
      createRecorder: () => makeRecorder(),
      pickMimeType: () => '',
      createDecoder: () => makeDecoder([]),
    })
    const listener = vi.fn()
    const unsubscribe = capture.subscribe(listener)
    await capture.start()
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    capture.dispose()
    expect(capture.state()).toBe('idle')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledTimes(1)
  })
})

describe('createAudioCapture over the real defaults', () => {
  it('asks the runtime for a microphone and records in the preferred container', async () => {
    const { stream, stop } = makeStream()
    const getUserMedia = vi.fn(async () => stream)
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia },
      configurable: true,
    })
    const isTypeSupported = vi.fn(() => true)
    let recorded: { mimeType?: string } | undefined
    vi.stubGlobal('MediaRecorder', function MediaRecorder(_stream: unknown, options?: { mimeType?: string }) {
      recorded = options ?? {}
      return makeRecorder({ mimeType: options?.mimeType ?? '' })
    })
    Object.assign(MediaRecorder, { isTypeSupported })
    const decodeAudioData = vi.fn(async () => ({
      sampleRate: 48000,
      numberOfChannels: 1,
      getChannelData: () => new Float32Array(4800).fill(0.1),
    }))
    vi.stubGlobal('AudioContext', function AudioContext() {
      return { decodeAudioData, close: async () => {} }
    })

    const capture = createAudioCapture()
    expect(isAudioCaptureAvailable()).toBe(true)
    await capture.start()
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true })
    const clip = await capture.stop()
    expect(isTypeSupported).toHaveBeenCalledWith('audio/webm;codecs=opus')
    expect(recorded?.mimeType).toBe('audio/webm;codecs=opus')
    expect(decodeAudioData).toHaveBeenCalledTimes(1)
    expect(clip?.durationMs).toBe(100)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('lets the browser choose a container when the preferred one is unsupported', async () => {
    const getUserMedia = vi.fn(async () => makeStream().stream)
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true })
    let recorded: { mimeType?: string } | undefined
    vi.stubGlobal('MediaRecorder', function MediaRecorder(_stream: unknown, options?: { mimeType?: string }) {
      recorded = options ?? {}
      return makeRecorder({ mimeType: options?.mimeType ?? '' })
    })
    Object.assign(MediaRecorder, { isTypeSupported: () => false })
    vi.stubGlobal('AudioContext', function AudioContext() {
      return {
        decodeAudioData: async () => ({
          sampleRate: 16000,
          numberOfChannels: 1,
          getChannelData: () => new Float32Array(1600),
        }),
        close: async () => {},
      }
    })
    const capture = createAudioCapture()
    await capture.start()
    await capture.stop()
    expect(recorded).toEqual({})
  })

  it('reports a runtime with no microphone as a clear failure', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true })
    const capture = createAudioCapture()
    await capture.start()
    expect(capture.state()).toBe('failed')
    expect(capture.snapshot().lastError).toContain('no mediaDevices')
  })

  it('reports a runtime with no audio decoder as a clear failure', async () => {
    const getUserMedia = vi.fn(async () => makeStream().stream)
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true })
    vi.stubGlobal('MediaRecorder', function MediaRecorder() { return makeRecorder() })
    Object.assign(MediaRecorder, { isTypeSupported: () => false })
    vi.stubGlobal('AudioContext', undefined)
    const capture = createAudioCapture()
    await capture.start()
    expect(await capture.stop()).toBeUndefined()
    expect(capture.snapshot().lastError).toContain('no AudioContext')
  })
})

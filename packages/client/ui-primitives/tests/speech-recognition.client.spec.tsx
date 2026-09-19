// @vitest-environment jsdom
// Browser-local dictation: unavailable without the engine, and a faithful
// adapter over the engine's callbacks when it is present.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RecognitionResult } from '../src/speech-recognition.ts'
import { createRecognition, isSpeechRecognitionAvailable } from '../src/speech-recognition.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Result event shaped the way the engine hands it to onresult. */
function resultEvent(
  chunks: { isFinal: boolean; text?: string; empty?: boolean }[],
  resultIndex = 0,
) {
  const results: Record<string, unknown> = { length: chunks.length }
  chunks.forEach((chunk, index) => {
    results[index] = chunk.empty === true
      ? { isFinal: chunk.isFinal }
      : { isFinal: chunk.isFinal, 0: { transcript: chunk.text ?? '' } }
  })
  return { resultIndex, results } as never
}

/** Engine stand-in recording configuration and exposing its handlers. */
class FakeEngine {
  static instances: FakeEngine[] = []
  lang = ''
  continuous = false
  interimResults = false
  maxAlternatives = 0
  onresult: ((event: never) => void) | null = null
  onerror: ((event: { error?: string }) => void) | null = null
  onend: (() => void) | null = null
  readonly started: string[] = []
  constructor() {
    FakeEngine.instances.push(this)
  }
  start(): void { this.started.push('start') }
  stop(): void { this.started.push('stop') }
  abort(): void { this.started.push('abort') }
}

function stubEngine(global: 'SpeechRecognition' | 'webkitSpeechRecognition' = 'SpeechRecognition'): void {
  FakeEngine.instances = []
  vi.stubGlobal(global, FakeEngine)
}

describe('isSpeechRecognitionAvailable', () => {
  it('is false without the engine', () => {
    expect(isSpeechRecognitionAvailable()).toBe(false)
  })

  it('is true with the unprefixed constructor', () => {
    stubEngine()
    expect(isSpeechRecognitionAvailable()).toBe(true)
  })

  it('is true with the webkit-prefixed constructor', () => {
    stubEngine('webkitSpeechRecognition')
    expect(isSpeechRecognitionAvailable()).toBe(true)
  })
})

describe('createRecognition', () => {
  it('answers undefined when the engine is missing', () => {
    expect(createRecognition()).toBeUndefined()
  })

  it('defaults the locale to Russian and stays single-shot', () => {
    stubEngine()
    createRecognition()
    const engine = FakeEngine.instances[0]
    expect(engine?.lang).toBe('ru-RU')
    expect(engine?.continuous).toBe(false)
    expect(engine?.interimResults).toBe(false)
    expect(engine?.maxAlternatives).toBe(1)
  })

  it('honors locale and continuity overrides', () => {
    stubEngine()
    createRecognition({ lang: 'en-US', continuous: true, interimResults: true })
    const engine = FakeEngine.instances[0]
    expect(engine?.lang).toBe('en-US')
    expect(engine?.continuous).toBe(true)
    expect(engine?.interimResults).toBe(true)
  })

  it('delegates start, stop, and abort to the engine', () => {
    stubEngine()
    const handle = createRecognition()
    handle?.start()
    handle?.stop()
    handle?.abort()
    expect(FakeEngine.instances[0]?.started).toEqual(['start', 'stop', 'abort'])
  })

  it('propagates a synchronous start failure to the caller', () => {
    stubEngine()
    vi.spyOn(FakeEngine.prototype, 'start').mockImplementation(() => { throw new Error('already started') })
    const handle = createRecognition()
    expect(() => { handle?.start() }).toThrow('already started')
  })

  it('reports final and interim chunks', () => {
    stubEngine()
    const onResult = vi.fn((_result: RecognitionResult) => {})
    createRecognition({ onResult })
    FakeEngine.instances[0]?.onresult?.(resultEvent([
      { isFinal: true, text: 'привет' },
      { isFinal: false, text: 'как' },
    ]))
    expect(onResult.mock.calls.map(call => call[0])).toEqual([
      { isFinal: true, text: 'привет' },
      { isFinal: false, text: 'как' },
    ])
  })

  it('reads from the engine-reported result index', () => {
    stubEngine()
    const onResult = vi.fn((_result: RecognitionResult) => {})
    createRecognition({ onResult })
    FakeEngine.instances[0]?.onresult?.(resultEvent([
      { isFinal: true, text: 'старое' },
      { isFinal: true, text: 'новое' },
    ], 1))
    expect(onResult).toHaveBeenCalledOnce()
    expect(onResult.mock.calls[0]?.[0]).toEqual({ isFinal: true, text: 'новое' })
  })

  it('skips empty transcripts and sparse slots', () => {
    stubEngine()
    const onResult = vi.fn((_result: RecognitionResult) => {})
    createRecognition({ onResult })
    FakeEngine.instances[0]?.onresult?.(resultEvent([
      { isFinal: false, empty: true },
      { isFinal: false, text: '' },
      { isFinal: true, text: 'ok' },
    ]))
    expect(onResult).toHaveBeenCalledOnce()
    expect(onResult.mock.calls[0]?.[0]).toEqual({ isFinal: true, text: 'ok' })
  })

  it('reports the engine error code, defaulting to unknown', () => {
    stubEngine()
    const onError = vi.fn((_code: string) => {})
    createRecognition({ onError })
    FakeEngine.instances[0]?.onerror?.({ error: 'not-allowed' })
    FakeEngine.instances[0]?.onerror?.({})
    expect(onError.mock.calls.map(call => call[0])).toEqual(['not-allowed', 'unknown'])
  })

  it('reports the end of the run', () => {
    stubEngine()
    const onEnd = vi.fn(() => {})
    createRecognition({ onEnd })
    FakeEngine.instances[0]?.onend?.()
    expect(onEnd).toHaveBeenCalledOnce()
  })

  it('is silent when the caller subscribes to nothing', () => {
    stubEngine()
    createRecognition()
    const engine = FakeEngine.instances[0]
    expect(() => {
      engine?.onresult?.(resultEvent([{ isFinal: true, text: 'ok' }]))
      engine?.onerror?.({ error: 'no-speech' })
      engine?.onend?.()
    }).not.toThrow()
  })
})

// @vitest-environment jsdom
// Read-aloud engine: the configured service, Google's keyless engine, and the
// built-in voice — chosen per utterance, degrading instead of going silent.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SPEECH_ROUTE, chooseSpeechEngine, createSpeechEngine, installSpeechEngine, planSpeech,
} from '../src/speech-engine.ts'
import { speakNavText } from '../src/speak-nav.ts'
import { writeAccessibilitySettings } from '../src/accessibility-settings.ts'
import type { SpeechLifecycle } from '../src/speech-synthesis.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
  FakeAudio.refusePlay = false
  FakeAudio.instances = []
})

/** One playing clip, standing in for the audio element. */
class FakeAudio {
  static instances: FakeAudio[] = []
  static refusePlay = false
  readonly src: string
  pauses = 0
  plays = 0
  playbackRate = 1
  onplaying: (() => void) | null = null
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(src?: string) {
    this.src = src ?? ''
    FakeAudio.instances.push(this)
  }

  pause(): void {
    this.pauses += 1
  }

  play(): Promise<void> {
    this.plays += 1
    return FakeAudio.refusePlay ? Promise.reject(new Error('autoplay blocked')) : Promise.resolve()
  }
}

/** The clip that is currently playing. */
function playingClip(): FakeAudio {
  const clip = FakeAudio.instances[0]
  if (clip === undefined) throw new Error('no clip was played')
  return clip
}

/** Object-URL bookkeeping for one test. */
let minted: string[] = []
let released: string[] = []

function stubObjectUrls(): void {
  minted = []
  released = []
  vi.stubGlobal('URL', {
    createObjectURL: () => {
      const url = `blob:clip-${String(minted.length + 1)}`
      minted.push(url)
      return url
    },
    revokeObjectURL: (url: string) => { released.push(url) },
  })
}

/** Stand in for the host's audio answer. */
function clipResponse(bytes: number[], ok = true, status = 200): Response {
  return {
    ok,
    status,
    blob: () => Promise.resolve(new Blob([new Uint8Array(bytes)])),
  } as unknown as Response
}

/** One utterance the built-in voice was handed, with its own lifecycle hooks. */
class FakeUtterance {
  text: string
  rate = 1
  pitch = 1
  volume = 1
  lang = ''
  voice: unknown = undefined
  onstart: (() => void) | null = null
  onend: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(text: string) {
    this.text = text
  }
}

/** Stub the built-in Web Speech engine, reporting what it was asked to say. */
function stubBuiltInVoice(voices: { lang: string }[] = []): {
  spoken: string[]
  utterances: FakeUtterance[]
  cancels: number
} {
  const spoken: string[] = []
  const utterances: FakeUtterance[] = []
  const state = { cancels: 0 }
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance)
  vi.stubGlobal('speechSynthesis', {
    cancel: () => { state.cancels += 1 },
    getVoices: () => voices,
    speak: (utterance: FakeUtterance) => {
      spoken.push(utterance.text)
      utterances.push(utterance)
    },
  })
  return {
    spoken,
    utterances,
    get cancels() { return state.cancels },
  }
}

/** Store one voice-settings document. */
function storeVoice(patch: Record<string, string>): void {
  localStorage.setItem('dsh.voice.settings', JSON.stringify(patch))
}

/** Let queued microtasks and the pending fetch chain settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

describe('chooseSpeechEngine', () => {
  it('prefers the configured service', () => {
    stubBuiltInVoice([{ lang: 'ru-RU' }])
    storeVoice({ ttsUrl: 'https://tts.example.com', ttsKey: 'key' })
    expect(chooseSpeechEngine()).toBe('service')
  })

  it('uses the built-in voice when it can pronounce Russian', () => {
    stubBuiltInVoice([{ lang: 'en-US' }, { lang: 'ru-RU' }])
    expect(chooseSpeechEngine()).toBe('browser')
  })

  it('uses Google when no Russian voice exists', () => {
    stubBuiltInVoice([{ lang: 'en-US' }])
    expect(chooseSpeechEngine()).toBe('google')
  })

  it('uses Google without any speech engine at all', () => {
    expect(chooseSpeechEngine()).toBe('google')
  })

  it('uses Google when the engine refuses to list voices', () => {
    vi.stubGlobal('speechSynthesis', {
      cancel: () => {},
      getVoices: () => { throw new Error('engine unavailable') },
      speak: () => {},
    })
    expect(chooseSpeechEngine()).toBe('google')
  })
})

describe('createSpeechEngine', () => {
  it('is always available: some engine always answers', () => {
    expect(createSpeechEngine().isAvailable()).toBe(true)
  })

  it('speaks through the configured service with its credential', async () => {
    stubObjectUrls()
    vi.stubGlobal('Audio', FakeAudio)
    FakeAudio.instances = []
    storeVoice({ ttsUrl: 'https://tts.example.com/say', ttsKey: 'secret' })
    const fetchMock = vi.fn(() => Promise.resolve(clipResponse([1, 2, 3])))
    vi.stubGlobal('fetch', fetchMock)
    createSpeechEngine().speak('Привет')
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [route, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(route).toBe(SPEECH_ROUTE)
    expect(init.headers).toEqual({
      'content-type': 'application/json',
      'x-dsh-media-url': 'https://tts.example.com/say',
      'x-dsh-media-key': 'secret',
    })
    expect(init.body).toBe(JSON.stringify({
      text: 'Привет', lang: 'ru-RU', provider: 'custom', voice: '', model: '', speed: 1, pitch: 1,
    }))
    expect(minted).toEqual(['blob:clip-1'])
    expect(FakeAudio.instances[0]?.src).toBe('blob:clip-1')
    expect(FakeAudio.instances[0]?.plays).toBe(1)
  })

  it('omits the credential header when the service needs none', async () => {
    stubObjectUrls()
    vi.stubGlobal('Audio', FakeAudio)
    storeVoice({ ttsUrl: 'https://tts.example.com/say' })
    const fetchMock = vi.fn(() => Promise.resolve(clipResponse([1])))
    vi.stubGlobal('fetch', fetchMock)
    createSpeechEngine().speak('Привет')
    await flush()
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.headers).toEqual({ 'content-type': 'application/json', 'x-dsh-media-url': 'https://tts.example.com/say' })
  })

  it('speaks through the keyless path without endpoint headers', async () => {
    stubObjectUrls()
    vi.stubGlobal('Audio', FakeAudio)
    stubBuiltInVoice([{ lang: 'en-US' }])
    const fetchMock = vi.fn(() => Promise.resolve(clipResponse([1])))
    vi.stubGlobal('fetch', fetchMock)
    createSpeechEngine().speak('Привет')
    await flush()
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.headers).toEqual({ 'content-type': 'application/json' })
  })

  it('plays the keyless clip at the stored speed', async () => {
    stubObjectUrls()
    vi.stubGlobal('Audio', FakeAudio)
    FakeAudio.instances = []
    stubBuiltInVoice([{ lang: 'en-US' }])
    storeVoice({ ttsSpeed: 1.5 } as unknown as Record<string, string>)
    vi.stubGlobal('fetch', () => Promise.resolve(clipResponse([1])))
    createSpeechEngine().speak('Привет')
    await flush()
    expect(playingClip().playbackRate).toBe(1.5)
  })

  it('does not double the speed when the host bakes it in', async () => {
    stubObjectUrls()
    vi.stubGlobal('Audio', FakeAudio)
    FakeAudio.instances = []
    storeVoice({ ttsUrl: 'https://tts.example.com/say', ttsSpeed: 1.5 } as unknown as Record<string, string>)
    vi.stubGlobal('fetch', () => Promise.resolve(clipResponse([1, 2, 3])))
    createSpeechEngine().speak('Привет')
    await flush()
    expect(playingClip().playbackRate).toBe(1)
  })

  it('stays with the built-in voice when it can pronounce Russian', async () => {
    const voice = stubBuiltInVoice([{ lang: 'ru-RU' }])
    const fetchMock = vi.fn(() => Promise.resolve(clipResponse([1])))
    vi.stubGlobal('fetch', fetchMock)
    createSpeechEngine().speak('Привет')
    await flush()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(voice.spoken).toEqual(['Привет'])
  })

  it('degrades to the built-in voice when the service refuses', async () => {
    stubObjectUrls()
    vi.stubGlobal('Audio', FakeAudio)
    const voice = stubBuiltInVoice([])
    vi.stubGlobal('fetch', () => Promise.resolve(clipResponse([], false, 503)))
    createSpeechEngine().speak('Привет')
    await flush()
    expect(voice.spoken).toEqual(['Привет'])
  })

  it('degrades to the built-in voice when the transport fails', async () => {
    stubObjectUrls()
    vi.stubGlobal('Audio', FakeAudio)
    const voice = stubBuiltInVoice([])
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')))
    createSpeechEngine().speak('Привет')
    await flush()
    expect(voice.spoken).toEqual(['Привет'])
  })

  it('degrades to the built-in voice when the runtime cannot play a clip', async () => {
    stubObjectUrls()
    vi.stubGlobal('Audio', undefined)
    const voice = stubBuiltInVoice([])
    vi.stubGlobal('fetch', () => Promise.resolve(clipResponse([1])))
    createSpeechEngine().speak('Привет')
    await flush()
    expect(voice.spoken).toEqual(['Привет'])
  })

  it('degrades to the built-in voice when the runtime has no object URLs', async () => {
    vi.stubGlobal('URL', {})
    const voice = stubBuiltInVoice([])
    vi.stubGlobal('fetch', () => Promise.resolve(clipResponse([1])))
    createSpeechEngine().speak('Привет')
    await flush()
    expect(voice.spoken).toEqual(['Привет'])
  })

  it('survives an engine that refuses autoplay', async () => {
    stubObjectUrls()
    FakeAudio.instances = []
    FakeAudio.refusePlay = true
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('fetch', () => Promise.resolve(clipResponse([1])))
    createSpeechEngine().speak('Привет')
    await flush()
    expect(FakeAudio.instances[0]?.plays).toBe(1)
    FakeAudio.refusePlay = false
  })

  it('stays silent when a run is cancelled before the clip arrives', async () => {
    stubObjectUrls()
    vi.stubGlobal('Audio', FakeAudio)
    const voice = stubBuiltInVoice([])
    vi.stubGlobal('fetch', (_input: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { reject(new Error('aborted')) })
    }))
    const engine = createSpeechEngine()
    engine.speak('Привет')
    engine.cancel()
    await flush()
    expect(voice.spoken).toEqual([])
  })

  it('releases the previous clip when the next one starts', async () => {
    stubObjectUrls()
    FakeAudio.instances = []
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('fetch', () => Promise.resolve(clipResponse([1])))
    const engine = createSpeechEngine()
    engine.speak('Первый')
    await flush()
    engine.speak('Второй')
    await flush()
    expect(minted).toEqual(['blob:clip-1', 'blob:clip-2'])
    expect(released).toEqual(['blob:clip-1'])
    expect(FakeAudio.instances[1]?.src).toBe('blob:clip-2')
  })

  it('stops playback, releases the clip, and cancels speech', async () => {
    stubObjectUrls()
    FakeAudio.instances = []
    vi.stubGlobal('Audio', FakeAudio)
    const voice = stubBuiltInVoice([])
    vi.stubGlobal('fetch', () => Promise.resolve(clipResponse([1])))
    const engine = createSpeechEngine()
    engine.speak('Привет')
    await flush()
    engine.cancel()
    expect(FakeAudio.instances[0]?.pauses).toBe(1)
    expect(released).toEqual(['blob:clip-1'])
    expect(voice.cancels).toBeGreaterThan(0)
    engine.cancel()
    expect(released).toEqual(['blob:clip-1'])
  })
})

describe('installSpeechEngine', () => {
  it('routes the app-wide read-aloud through the engine, then restores the default', async () => {
    stubObjectUrls()
    vi.stubGlobal('Audio', FakeAudio)
    stubBuiltInVoice([{ lang: 'en-US' }])
    writeAccessibilitySettings({ voiceNav: true, voiceNavDelay: 0 })
    const fetchMock = vi.fn(() => Promise.resolve(clipResponse([1])))
    vi.stubGlobal('fetch', fetchMock)
    const dispose = installSpeechEngine()
    speakNavText('Привет')
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    dispose()
    expect(released).toEqual(['blob:clip-1'])
    speakNavText('Пока')
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('watching an utterance through the engine', () => {
  /** Speak one phrase through the engine and collect the events it reports. */
  function watched(): { seen: SpeechLifecycle[]; engine: ReturnType<typeof createSpeechEngine> } {
    const seen: SpeechLifecycle[] = []
    const engine = createSpeechEngine()
    engine.speak('Привет', { onLifecycle: (event) => { seen.push(event) } })
    return { seen, engine }
  }

  it('reports a synthesized clip that starts and ends', async () => {
    stubObjectUrls()
    vi.stubGlobal('Audio', FakeAudio)
    FakeAudio.instances = []
    storeVoice({ ttsUrl: 'https://tts.example.com/say' })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(clipResponse([1, 2]))))
    const { seen } = watched()
    await flush()
    const clip = playingClip()
    clip.onplaying?.()
    clip.onended?.()
    expect(seen).toEqual(['start', 'end'])
  })

  it('reports a clip that could not be played', async () => {
    stubObjectUrls()
    vi.stubGlobal('Audio', FakeAudio)
    FakeAudio.instances = []
    storeVoice({ ttsUrl: 'https://tts.example.com/say' })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(clipResponse([1, 2]))))
    const { seen } = watched()
    await flush()
    playingClip().onerror?.()
    expect(seen).toEqual(['error'])
  })

  it('reports the built-in voice that starts and ends', () => {
    const voice = stubBuiltInVoice([{ lang: 'ru-RU' }])
    const { seen } = watched()
    const utterance = voice.utterances[0]
    utterance?.onstart?.()
    utterance?.onend?.()
    expect(seen).toEqual(['start', 'end'])
  })

  it('reports the end of a built-in utterance that was cancelled', () => {
    stubBuiltInVoice([{ lang: 'ru-RU' }])
    const { seen, engine } = watched()
    engine.cancel()
    expect(seen).toEqual(['end'])
  })

  it('settles the replaced utterance when the next one starts', () => {
    stubBuiltInVoice([{ lang: 'ru-RU' }])
    const seen: SpeechLifecycle[] = []
    const engine = createSpeechEngine()
    engine.speak('Первый', { onLifecycle: (event) => { seen.push(event) } })
    engine.speak('Второй')
    expect(seen).toEqual(['end'])
  })

  it('settles an utterance cancelled while its clip was still in flight', async () => {
    stubObjectUrls()
    vi.stubGlobal('Audio', FakeAudio)
    storeVoice({ ttsUrl: 'https://tts.example.com/say' })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(clipResponse([1, 2]))))
    const { seen, engine } = watched()
    engine.cancel()
    await flush()
    expect(seen).toEqual(['end'])
  })

  it('passes pacing the caller asked for to the built-in voice', () => {
    const voice = stubBuiltInVoice([{ lang: 'ru-RU' }])
    createSpeechEngine().speak('Привет', { rate: 1.5, pitch: 0.5 })
    expect(voice.utterances[0]).toMatchObject({ rate: 1.5, pitch: 0.5 })
  })

  it('keeps the stored pacing when the caller has no opinion', () => {
    const voice = stubBuiltInVoice([{ lang: 'ru-RU' }])
    // Stored as numbers, which is the shape the settings page writes.
    localStorage.setItem('dsh.voice.settings', JSON.stringify({ ttsSpeed: 1.8, ttsPitch: 0.6 }))
    createSpeechEngine().speak('Привет')
    expect(voice.utterances[0]).toMatchObject({ rate: 1.8, pitch: 0.6 })
  })
})

describe('the plan behind one utterance', () => {
  it('keeps the shipped order when no provider was chosen', () => {
    expect(planSpeech()).toMatchObject({ engine: 'google', provider: 'google' })
  })

  it('routes a named built-in voice to the browser', () => {
    storeVoice({ provider: 'system' })
    expect(planSpeech()).toMatchObject({ engine: 'browser', provider: 'system' })
  })

  it('routes the keyless Google engine to itself', () => {
    storeVoice({ provider: 'google' })
    expect(planSpeech()).toMatchObject({ engine: 'google', provider: 'google' })
  })

  it('routes a provider with its own service to the provider path', () => {
    storeVoice({ provider: 'openai' })
    expect(planSpeech()).toMatchObject({
      engine: 'provider', provider: 'openai', voice: 'alloy', model: 'tts-1',
    })
  })

  it('carries the chosen voice and the caller’s pacing', () => {
    storeVoice({ provider: 'openai', ttsVoiceId: 'nova' })
    localStorage.setItem('dsh.voice.settings', JSON.stringify({
      provider: 'openai', ttsVoiceId: 'nova', ttsSpeed: 1.4, ttsPitch: 0.9,
    }))
    expect(planSpeech()).toMatchObject({ voice: 'nova', speed: 1.4, pitch: 0.9 })
  })

  it('passes a chosen voice through, leaving the judgement to the service', () => {
    // The voice catalog is advisory: a service may offer voices this build has
    // never heard of, so a non-empty choice is never second-guessed here.
    localStorage.setItem('dsh.voice.settings', JSON.stringify({ provider: 'openai', ttsVoiceId: 'coral' }))
    expect(planSpeech().voice).toBe('coral')
  })

  it('takes the provider default when no voice was chosen', () => {
    localStorage.setItem('dsh.voice.settings', JSON.stringify({ provider: 'openai', ttsVoiceId: '' }))
    expect(planSpeech().voice).toBe('alloy')
  })

  it('watches the built-in voice it degrades to', async () => {
    const voice = stubBuiltInVoice([{ lang: 'ru-RU' }])
    storeVoice({ ttsUrl: 'https://tts.example.com/say' })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(clipResponse([1], false, 500))))
    const seen: SpeechLifecycle[] = []
    createSpeechEngine().speak('Привет', { onLifecycle: (event) => { seen.push(event) } })
    await flush()
    voice.utterances[0]?.onend?.()
    expect(seen).toEqual(['end'])
  })
})

describe('a named provider as the engine', () => {
  it('lets the host adapter resolve the endpoint, sending no override headers', async () => {
    stubObjectUrls()
    vi.stubGlobal('Audio', FakeAudio)
    FakeAudio.instances = []
    // A named provider carries no endpoint of its own: the host knows where it
    // lives, so the renderer must not send one.
    localStorage.setItem('dsh.voice.settings', JSON.stringify({ provider: 'openai', ttsKey: 'k' }))
    const fetchMock = vi.fn(() => Promise.resolve(clipResponse([1, 2])))
    vi.stubGlobal('fetch', fetchMock)
    createSpeechEngine().speak('Привет')
    await flush()
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.headers).toEqual({ 'content-type': 'application/json' })
    expect(JSON.parse(String(init.body))).toMatchObject({ provider: 'openai', voice: 'alloy', model: 'tts-1' })
    expect(FakeAudio.instances[0]?.plays).toBe(1)
  })
})

describe('a named provider as the engine', () => {
  it('lets the host adapter resolve the endpoint, sending no override headers', async () => {
    stubObjectUrls()
    vi.stubGlobal('Audio', FakeAudio)
    FakeAudio.instances = []
    // A named provider carries no endpoint of its own: the host knows where it
    // lives, so the renderer must not send one.
    localStorage.setItem('dsh.voice.settings', JSON.stringify({ provider: 'openai', ttsKey: 'k' }))
    const fetchMock = vi.fn(() => Promise.resolve(clipResponse([1, 2])))
    vi.stubGlobal('fetch', fetchMock)
    createSpeechEngine().speak('Привет')
    await flush()
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.headers).toEqual({ 'content-type': 'application/json' })
    expect(JSON.parse(String(init.body))).toMatchObject({ provider: 'openai', voice: 'alloy', model: 'tts-1' })
    expect(FakeAudio.instances[0]?.plays).toBe(1)
  })
})

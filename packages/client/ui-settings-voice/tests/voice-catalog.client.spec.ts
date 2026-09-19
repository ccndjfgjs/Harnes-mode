// @vitest-environment jsdom
// The Voice Settings page never talks to a provider itself: these helpers post
// to the gateway and read back a voice list or an audio clip.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VOICES_ROUTE, fetchVoices, previewVoice } from '../src/client/voice-catalog.ts'

/**
 * Read the JSON body a stubbed `fetch` was handed.
 *
 * `RequestInit.body` is typed as `BodyInit`, so the narrowing is explicit
 * rather than a `String()` coercion — which would turn a non-string body into
 * `[object Object]` and hide a real change in what the code puts on the wire.
 * @param init - the request init captured from the stub.
 * @returns the parsed body.
 */
function jsonBodyOf(init: RequestInit): Record<string, unknown> {
  const body = init.body
  return JSON.parse(typeof body === 'string' ? body : '{}') as Record<string, unknown>
}


/** Sources handed to `new Audio(...)` since the last reset. */
let played: string[] = []
/** Object URLs the helper asked the runtime to release. */
let revoked: string[] = []
/** Whether the fake runtime refuses to start playback. */
let playRejects = false
/** Listeners the helper attached, so the spec can end the clip itself. */
let listeners: (() => void)[] = []

const originalCreateObjectURL = URL.createObjectURL.bind(URL)
const originalRevokeObjectURL = URL.revokeObjectURL.bind(URL)

beforeEach(() => {
  played = []
  revoked = []
  playRejects = false
  listeners = []
  vi.stubGlobal('Audio', class {
    readonly src: string
    constructor(src: string) {
      this.src = src
      played.push(src)
    }
    play(): Promise<void> {
      return playRejects ? Promise.reject(new Error('autoplay refused')) : Promise.resolve()
    }
    addEventListener(type: string, listener: () => void): void {
      if (type === 'ended') listeners.push(listener)
    }
  })
  URL.createObjectURL = () => 'blob:clip'
  URL.revokeObjectURL = (url: string) => { revoked.push(url) }
})

afterEach(() => {
  vi.unstubAllGlobals()
  URL.createObjectURL = originalCreateObjectURL
  URL.revokeObjectURL = originalRevokeObjectURL
})

/**
 * Capture the request the helper makes and answer it with `body`. A string body
 * is passed through verbatim; anything else is JSON-encoded. The body is never
 * a `Blob`: jsdom's Blob has no `stream()`, so a clip is stubbed as text and
 * `Response.blob()` turns it into bytes on its own.
 */
function stubFetch(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(() => Promise.resolve(new Response(
    typeof body === 'string' ? body : JSON.stringify(body),
    { status },
  )))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** The request a single-call stub received. */
function requestOf(fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit] {
  return fetchMock.mock.calls[0] as unknown as [string, RequestInit]
}

describe('fetchVoices', () => {
  it('posts the provider to the gateway and keeps only well-formed entries', async () => {
    const fetchMock = stubFetch({
      voices: [
        { id: 'ru-1', label: 'Голос', lang: 'ru-RU' },
        { id: 'ru-2' },
        { id: '' },
        { label: 'нет идентификатора' },
        null,
        'строка',
      ],
    })
    const voices = await fetchVoices('elevenlabs', 'key-1')
    expect(voices).toEqual([
      { id: 'ru-1', label: 'Голос', lang: 'ru-RU' },
      // A missing name falls back to the id, a missing language to ''.
      { id: 'ru-2', label: 'ru-2', lang: '' },
    ])
    const [route, init] = requestOf(fetchMock)
    expect(route).toBe(VOICES_ROUTE)
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ provider: 'elevenlabs' }))
    expect((init.headers as Record<string, string>)['x-dsh-media-key']).toBe('key-1')
  })

  it('sends no credential header for a provider that needs none', async () => {
    const fetchMock = stubFetch({ voices: [] })
    await fetchVoices('google-cloud', '')
    const [, init] = requestOf(fetchMock)
    expect((init.headers as Record<string, string>)['x-dsh-media-key']).toBeUndefined()
    expect(init.signal).toBeUndefined()
  })

  it('passes the caller signal through so a second ask cancels the first', async () => {
    const fetchMock = stubFetch({ voices: [] })
    const controller = new AbortController()
    await fetchVoices('openai', 'key-1', controller.signal)
    expect(requestOf(fetchMock)[1].signal).toBe(controller.signal)
  })

  it('answers an empty list when the payload carries no voices array', async () => {
    stubFetch({ error: 'nope' })
    await expect(fetchVoices('openai', 'key-1')).resolves.toEqual([])
  })

  it('rejects when the gateway refuses the ask', async () => {
    stubFetch({ error: 'nope' }, 502)
    await expect(fetchVoices('openai', 'key-1')).rejects.toThrow('voices HTTP 502')
  })
})

describe('previewVoice', () => {
  it('speaks the clip and releases it when playback ends', async () => {
    const fetchMock = stubFetch('clip')
    await previewVoice({
      provider: 'openai', voice: 'nova', model: 'tts-1', speed: 1.2, pitch: 0.9, key: 'key-1', text: 'Проверка',
    })
    const [route, init] = requestOf(fetchMock)
    expect(route).toBe('/api/media/speak')
    expect(jsonBodyOf(init)).toEqual({
      text: 'Проверка', lang: 'ru-RU', provider: 'openai', voice: 'nova', model: 'tts-1', speed: 1.2, pitch: 0.9,
    })
    expect(played).toEqual(['blob:clip'])
    // Nothing is released while the clip is still playing.
    expect(revoked).toEqual([])
    // Ending the clip releases it.
    for (const listener of listeners) listener()
    expect(revoked).toEqual(['blob:clip'])
  })

  it('releases the clip immediately when the runtime refuses to play it', async () => {
    playRejects = true
    stubFetch('clip')
    await expect(previewVoice({
      provider: 'system', voice: '', model: '', speed: 1, pitch: 1, key: '', text: 'Проверка',
    })).rejects.toThrow('autoplay refused')
    expect(revoked).toEqual(['blob:clip'])
  })

  it('rejects before creating a clip when the gateway refuses', async () => {
    stubFetch('nope', 429)
    await expect(previewVoice({
      provider: 'openai', voice: 'nova', model: '', speed: 1, pitch: 1, key: 'key-1', text: 'Проверка',
    })).rejects.toThrow('preview HTTP 429')
    expect(played).toEqual([])
  })
})

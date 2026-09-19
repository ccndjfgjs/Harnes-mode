/**
 * media-gateway speech surface: the keyless Google path, the configured
 * service path, and the renderer-supplied endpoint overrides that finally let
 * the endpoints and keys typed into Voice Settings reach the network.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  chunkForSpeech, googleSpeechUrl, listVoices, realtimeTarget, realtimeUpstreamUrl, realtimeVoice, speak,
  speechRequest, speechTarget, voices,
} from '../src/index.ts'

/**
 * Read the JSON body a stubbed `fetch` was handed.
 *
 * The gateway always sends a string body, but `RequestInit.body` is typed as
 * `BodyInit`, so the narrowing is explicit rather than a `String()` coercion —
 * which would silently turn a non-string body into `[object Object]` and hide
 * a real change in what the gateway puts on the wire.
 * @param init - the request init the gateway passed to fetch.
 * @returns the parsed body.
 */
function jsonBodyOf(init: RequestInit): Record<string, unknown> {
  const body = init.body
  return JSON.parse(typeof body === 'string' ? body : '{}') as Record<string, unknown>
}

/** One captured response, standing in for the HTTP seat the route writes to. */
class FakeResponse {
  status = 0
  readonly headers: Record<string, string> = {}
  private readonly chunks: Buffer[] = []

  writeHead(status: number, headers?: Record<string, string | number>): this {
    this.status = status
    for (const [key, value] of Object.entries(headers ?? {})) this.headers[key.toLowerCase()] = String(value)
    return this
  }

  end(body?: Buffer | string): this {
    if (body !== undefined) this.chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8'))
    return this
  }

  /** The whole body as a buffer. */
  body(): Buffer {
    return Buffer.concat(this.chunks)
  }

  /** The body parsed as JSON. */
  json(): unknown {
    return JSON.parse(this.body().toString('utf8')) as unknown
  }
}

/**
 * Build one inbound request over a JSON body.
 * @param body - value to serialize (a raw string is sent verbatim).
 * @param headers - extra headers, e.g. the renderer endpoint overrides.
 * @returns the request stand-in.
 */
function fakeRequest(body: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
  return {
    method: 'POST',
    url: '/api/media/speak',
    headers: { 'content-length': String(payload.length), ...headers },
    async *[Symbol.asyncIterator]() { yield payload },
  } as unknown as IncomingMessage
}

/** Run the speak route over one request. */
async function runSpeak(body: unknown, headers: Record<string, string> = {}): Promise<FakeResponse> {
  const response = new FakeResponse()
  await speak(fakeRequest(body, headers), response as unknown as ServerResponse)
  return response
}

/** Run the voice-catalog route over one request. */
async function runVoices(body: unknown, headers: Record<string, string> = {}): Promise<FakeResponse> {
  const response = new FakeResponse()
  await voices(fakeRequest(body, headers), response as unknown as ServerResponse)
  return response
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.DSH_TTS_URL
  delete process.env.DSH_TTS_API_KEY
  delete process.env.DSH_REALTIME_URL
})

/** Every speech field a body may omit, at the value the gateway falls back to. */
const SPEECH_DEFAULTS = { provider: 'custom', voice: '', model: '', speed: 1, pitch: 1 }

describe('speechRequest', () => {
  it('reads text and defaults the language and voice fields', () => {
    expect(speechRequest({ text: '  привет  ' })).toEqual({ text: 'привет', lang: 'ru-RU', ...SPEECH_DEFAULTS })
  })

  it('keeps an explicit language', () => {
    expect(speechRequest({ text: 'hi', lang: ' en-US ' })).toEqual({ text: 'hi', lang: 'en-US', ...SPEECH_DEFAULTS })
  })

  it('reads the provider, voice, model, and pacing', () => {
    const request = speechRequest({ text: 'hi', provider: 'openai', voice: 'nova', model: 'tts-1-hd', speed: 1.5, pitch: 0.8 })
    expect(request).toEqual({
      text: 'hi', lang: 'ru-RU', provider: 'openai', voice: 'nova', model: 'tts-1-hd', speed: 1.5, pitch: 0.8,
    })
  })

  it('clamps pacing outside the allowed range', () => {
    const request = speechRequest({ text: 'hi', speed: 9, pitch: 0 })
    expect(request?.speed).toBe(2)
    expect(request?.pitch).toBe(0.5)
  })

  it('ignores a non-string provider rather than failing', () => {
    expect(speechRequest({ text: 'hi', provider: 42 })?.provider).toBe('custom')
  })

  it('rejects anything without usable text', () => {
    expect(speechRequest(null)).toBeUndefined()
    expect(speechRequest('text')).toBeUndefined()
    expect(speechRequest({})).toBeUndefined()
    expect(speechRequest({ text: 42 })).toBeUndefined()
    expect(speechRequest({ text: '   ' })).toBeUndefined()
  })

  it('truncates an over-long draft instead of rejecting it', () => {
    expect(speechRequest({ text: 'а'.repeat(5000) })?.text).toHaveLength(1200)
  })
})

describe('chunkForSpeech', () => {
  it('answers nothing for blank text', () => {
    expect(chunkForSpeech('   ')).toEqual([])
  })

  it('keeps short text in one piece', () => {
    expect(chunkForSpeech('Новая сессия')).toEqual(['Новая сессия'])
  })

  it('splits long text on whitespace under the endpoint cap', () => {
    const pieces = chunkForSpeech(Array.from({ length: 120 }, (_unused, index) => `слово${String(index)}`).join(' '))
    expect(pieces.length).toBeGreaterThan(1)
    for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(180)
    expect(pieces.join(' ')).toBe(Array.from({ length: 120 }, (_unused, index) => `слово${String(index)}`).join(' '))
  })

  it('hard-splits a single word past the cap', () => {
    const pieces = chunkForSpeech('х'.repeat(400))
    expect(pieces.map(piece => piece.length)).toEqual([180, 180, 40])
  })

  it('flushes the pending piece before an over-long word', () => {
    const pieces = chunkForSpeech(`начало ${'я'.repeat(200)} конец`)
    expect(pieces[0]).toBe('начало')
    expect(pieces.slice(1).join('')).toContain('конец')
  })
})

describe('googleSpeechUrl', () => {
  it('sends the primary subtag and an encoded query', () => {
    const url = new URL(googleSpeechUrl('привет мир', 'ru-RU'))
    expect(url.origin + url.pathname).toBe('https://translate.google.com/translate_tts')
    expect(url.searchParams.get('tl')).toBe('ru')
    expect(url.searchParams.get('q')).toBe('привет мир')
    expect(url.searchParams.get('client')).toBe('tw-ob')
  })

  it('falls back to Russian when the tag has no primary subtag', () => {
    expect(new URL(googleSpeechUrl('текст', '')).searchParams.get('tl')).toBe('ru')
  })
})

describe('speechTarget', () => {
  it('puts an API key in the query for a Google API host', () => {
    const target = speechTarget('https://texttospeech.googleapis.com/v1/text:synthesize', 'secret')
    expect(new URL(target.url).searchParams.get('key')).toBe('secret')
    expect(target.headers).toEqual({ 'content-type': 'application/json' })
  })

  it('keeps an API key already present in the query', () => {
    const target = speechTarget('https://texttospeech.googleapis.com/v1/text:synthesize?key=kept', 'ignored')
    expect(new URL(target.url).searchParams.get('key')).toBe('kept')
  })

  it('sends a bearer header to every other service', () => {
    const target = speechTarget('https://voice.example.com/say', 'secret')
    expect(target.url).toBe('https://voice.example.com/say')
    expect(target.headers.authorization).toBe('Bearer secret')
  })

  it('omits the credential when none is configured', () => {
    expect(speechTarget('https://voice.example.com/say', undefined).headers.authorization).toBeUndefined()
    expect(new URL(speechTarget('https://texttospeech.googleapis.com/v1/x', undefined).url).searchParams.has('key')).toBe(false)
  })

  it('honours a provider that names its own credential style', () => {
    expect(speechTarget('https://api.elevenlabs.io/v1/voices', 'secret', 'header').headers['xi-api-key']).toBe('secret')
    expect(new URL(speechTarget('https://voice.example.com/say', 'secret', 'query').url).searchParams.get('key')).toBe('secret')
    expect(speechTarget('https://voice.example.com/say', 'secret', 'none').headers.authorization).toBeUndefined()
  })
})

describe('realtimeVoice', () => {
  it('reads the provider and voice the renderer named', () => {
    const req = { url: '/api/media/realtime?url=wss%3A%2F%2Fv.example.com&provider=openai&voice=alloy' } as unknown as IncomingMessage
    expect(realtimeVoice(req)).toEqual({ provider: 'openai', voice: 'alloy' })
  })

  it('answers empty fields when the call named no voice', () => {
    expect(realtimeVoice({ url: '/api/media/realtime' } as unknown as IncomingMessage)).toEqual({ provider: '', voice: '' })
  })
})

describe('realtimeUpstreamUrl', () => {
  it('carries the chosen voice on to the upstream handshake', () => {
    const url = realtimeUpstreamUrl('wss://voice.example.com', { provider: 'openai', voice: 'alloy' })
    const parsed = new URL(url)
    expect(parsed.searchParams.get('provider')).toBe('openai')
    expect(parsed.searchParams.get('voice')).toBe('alloy')
  })

  it('leaves the address alone when no voice was named', () => {
    expect(realtimeUpstreamUrl('wss://voice.example.com', { provider: '', voice: '' })).toBe('wss://voice.example.com')
  })

  it('dials an unusable address unchanged instead of refusing the call', () => {
    expect(realtimeUpstreamUrl('not a url', { provider: 'openai', voice: 'alloy' })).toBe('not a url')
  })
})

describe('listVoices', () => {
  it('answers nothing for a provider whose catalog the client already holds', async () => {
    expect(await listVoices('openai', 'secret')).toEqual([])
    expect(await listVoices('custom', 'secret')).toEqual([])
  })

  it('normalizes a Google Cloud catalog', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({
      voices: [{ name: 'ru-RU-Wavenet-D', languageCodes: ['ru-RU'] }, { languageCodes: ['ru-RU'] }, 'junk'],
    }), { headers: { 'content-type': 'application/json' } })))
    expect(await listVoices('google-cloud', 'secret')).toEqual([
      { id: 'ru-RU-Wavenet-D', label: 'ru-RU-Wavenet-D', lang: 'ru-RU' },
    ])
  })

  it('normalizes an ElevenLabs catalog and falls back to the id as the name', async () => {
    const seen: Record<string, string>[] = []
    vi.stubGlobal('fetch', (_input: string, init: RequestInit) => {
      seen.push(init.headers as Record<string, string>)
      return Promise.resolve(new Response(JSON.stringify({
        voices: [{ voice_id: 'abc', name: 'Радуга' }, { voice_id: 'def' }],
      }), { headers: { 'content-type': 'application/json' } }))
    })
    expect(await listVoices('elevenlabs', 'secret')).toEqual([
      { id: 'abc', label: 'Радуга', lang: '' },
      { id: 'def', label: 'def', lang: '' },
    ])
    expect(seen[0]?.['xi-api-key']).toBe('secret')
  })

  it('reports a refused catalog', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('denied', { status: 401 })))
    await expect(listVoices('elevenlabs', 'secret')).rejects.toThrow('Voice catalog answered HTTP 401')
  })

  it('answers nothing when the catalog payload carries no list', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' },
    })))
    expect(await listVoices('google-cloud', undefined)).toEqual([])
  })
})

describe('realtimeTarget', () => {
  it('prefers the signaling server the renderer named', () => {
    const req = { url: '/api/media/realtime?url=wss%3A%2F%2Fvoice.example.com' } as unknown as IncomingMessage
    expect(realtimeTarget(req)).toBe('wss://voice.example.com')
  })

  it('falls back to the deployment default', () => {
    process.env.DSH_REALTIME_URL = 'wss://env.example.com'
    expect(realtimeTarget({ url: '/api/media/realtime' } as unknown as IncomingMessage)).toBe('wss://env.example.com')
  })

  it('answers nothing when neither source names a server', () => {
    expect(realtimeTarget({ url: '/api/media/realtime?url=%20' } as unknown as IncomingMessage)).toBeUndefined()
  })
})

describe('speak route', () => {
  it('rejects a body that is not JSON', async () => {
    const response = await runSpeak('not json')
    expect(response.status).toBe(400)
    expect(response.json()).toEqual({ error: 'speech request must be JSON' })
  })

  it('rejects a body without text', async () => {
    const response = await runSpeak({})
    expect(response.status).toBe(400)
    expect(response.json()).toEqual({ error: 'speech request needs non-empty text' })
  })

  it('speaks through the keyless Google engine by default', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', (input: string) => {
      calls.push(input)
      return Promise.resolve(new Response(Buffer.from([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } }))
    })
    const response = await runSpeak({ text: 'привет', lang: 'ru-RU' })
    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toBe('audio/mpeg')
    expect(response.body()).toEqual(Buffer.from([1, 2, 3]))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('translate.google.com')
  })

  it('concatenates one Google frame per chunk', async () => {
    let calls = 0
    vi.stubGlobal('fetch', () => {
      calls += 1
      return Promise.resolve(new Response(Buffer.from([calls]), { headers: { 'content-type': 'audio/mpeg' } }))
    })
    const response = await runSpeak({ text: 'х'.repeat(400) })
    expect(calls).toBe(3)
    expect(response.body()).toEqual(Buffer.from([1, 2, 3]))
  })

  it('reports a refused Google call', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('nope', { status: 429 })))
    const response = await runSpeak({ text: 'привет' })
    expect(response.status).toBe(502)
    expect(response.json()).toEqual({ error: 'Google speech answered HTTP 429' })
  })

  it('speaks through the endpoint the renderer configured', async () => {
    const seen: { url: string; body: unknown; authorization: string | undefined }[] = []
    vi.stubGlobal('fetch', (input: string, init: RequestInit) => {
      seen.push({
        url: input,
        body: jsonBodyOf(init),
        authorization: (init.headers as Record<string, string>).authorization,
      })
      return Promise.resolve(new Response(JSON.stringify({ audioContent: Buffer.from('голос').toString('base64') }), {
        headers: { 'content-type': 'application/json' },
      }))
    })
    const response = await runSpeak({ text: 'привет', lang: 'ru-RU' }, {
      'x-dsh-media-url': 'https://voice.example.com/say',
      'x-dsh-media-key': 'secret',
    })
    expect(response.status).toBe(200)
    expect(response.body().toString('utf8')).toBe('голос')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe('https://voice.example.com/say')
    expect(seen[0]?.authorization).toBe('Bearer secret')
    expect(seen[0]?.body).toMatchObject({ text: 'привет', lang: 'ru-RU', input: { text: 'привет' } })
  })

  it('prefers the deployment endpoint when the renderer named none', async () => {
    process.env.DSH_TTS_URL = 'https://env.example.com/say'
    process.env.DSH_TTS_API_KEY = 'env-key'
    const urls: string[] = []
    vi.stubGlobal('fetch', (input: string) => {
      urls.push(input)
      return Promise.resolve(new Response(Buffer.from([7]), { headers: { 'content-type': 'audio/mpeg' } }))
    })
    const response = await runSpeak({ text: 'привет' })
    expect(response.status).toBe(200)
    expect(urls).toEqual(['https://env.example.com/say'])
  })

  it('reports an upstream that answered without audio', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' },
    })))
    const response = await runSpeak({ text: 'привет' }, { 'x-dsh-media-url': 'https://voice.example.com/say' })
    expect(response.status).toBe(502)
    expect(response.json()).toEqual({ error: 'Speech service answered without audio' })
  })

  it('reports a refused speech service', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('denied', { status: 401 })))
    const response = await runSpeak({ text: 'привет' }, { 'x-dsh-media-url': 'https://voice.example.com/say' })
    expect(response.status).toBe(502)
    expect(response.json()).toEqual({ error: 'Speech service answered HTTP 401' })
  })

  it('reports a transport failure without leaking the exception', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('socket hang up')))
    const response = await runSpeak({ text: 'привет' })
    expect(response.status).toBe(502)
    expect(response.json()).toEqual({ error: 'socket hang up' })
  })

  it('rejects an oversized body', async () => {
    const response = await runSpeak({ text: 'x'.repeat(200_000) })
    expect(response.status).toBe(400)
  })

  it('passes a non-JSON upstream clip straight through', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(Buffer.from([9, 9]), { headers: {} })))
    const response = await runSpeak({ text: 'привет' }, { 'x-dsh-media-url': 'https://voice.example.com/say' })
    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toBe('audio/mpeg')
    expect(response.body()).toEqual(Buffer.from([9, 9]))
  })

  it('reports an upstream JSON payload that is not an object', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('null', { headers: { 'content-type': 'application/json' } })))
    const response = await runSpeak({ text: 'привет' }, { 'x-dsh-media-url': 'https://voice.example.com/say' })
    expect(response.status).toBe(502)
  })

  it('uses the provider default endpoint when the renderer named none', async () => {
    const seen: { url: string; body: Record<string, unknown> }[] = []
    vi.stubGlobal('fetch', (input: string, init: RequestInit) => {
      seen.push({ url: input, body: jsonBodyOf(init) })
      return Promise.resolve(new Response(Buffer.from([1]), { headers: { 'content-type': 'audio/mpeg' } }))
    })
    const response = await runSpeak({ text: 'привет', provider: 'openai', voice: 'nova' }, { 'x-dsh-media-key': 'secret' })
    expect(response.status).toBe(200)
    expect(seen[0]?.url).toBe('https://api.openai.com/v1/audio/speech')
    expect(seen[0]?.body).toEqual({
      model: 'tts-1', input: 'привет', voice: 'nova', speed: 1, response_format: 'mp3',
    })
  })

  it('names the voice in the Google Cloud body and keys the query', async () => {
    const seen: { url: string; body: Record<string, unknown> }[] = []
    vi.stubGlobal('fetch', (input: string, init: RequestInit) => {
      seen.push({ url: input, body: jsonBodyOf(init) })
      return Promise.resolve(new Response(JSON.stringify({ audioContent: Buffer.from('голос').toString('base64') }), {
        headers: { 'content-type': 'application/json' },
      }))
    })
    const response = await runSpeak(
      { text: 'привет', provider: 'google-cloud', voice: 'ru-RU-Wavenet-D', speed: 1.2, pitch: 0.9 },
      { 'x-dsh-media-key': 'secret' },
    )
    expect(response.status).toBe(200)
    expect(new URL(seen[0]?.url ?? '').searchParams.get('key')).toBe('secret')
    expect(seen[0]?.body).toEqual({
      input: { text: 'привет' },
      voice: { languageCode: 'ru-RU', name: 'ru-RU-Wavenet-D' },
      audioConfig: { audioEncoding: 'MP3', speakingRate: 1.2, pitch: 0.9 },
    })
  })

  it('puts the voice in the path for a provider that expects it there', async () => {
    const seen: { url: string; key: string | undefined }[] = []
    vi.stubGlobal('fetch', (input: string, init: RequestInit) => {
      seen.push({ url: input, key: (init.headers as Record<string, string>)['xi-api-key'] })
      return Promise.resolve(new Response(Buffer.from([5]), { headers: { 'content-type': 'audio/mpeg' } }))
    })
    const response = await runSpeak({ text: 'привет', provider: 'elevenlabs', voice: 'abc123' }, { 'x-dsh-media-key': 'secret' })
    expect(response.status).toBe(200)
    expect(seen[0]?.url).toBe('https://api.elevenlabs.io/v1/text-to-speech/abc123')
    expect(seen[0]?.key).toBe('secret')
  })

  it('keeps the generic body for a service without an adapter', async () => {
    const seen: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', (_input: string, init: RequestInit) => {
      seen.push(jsonBodyOf(init))
      return Promise.resolve(new Response(Buffer.from([1]), { headers: { 'content-type': 'audio/mpeg' } }))
    })
    await runSpeak({ text: 'привет', provider: 'custom', voice: 'свой-голос' }, { 'x-dsh-media-url': 'https://voice.example.com/say' })
    expect(seen[0]).toMatchObject({ text: 'привет', voice: { languageCode: 'ru-RU', name: 'свой-голос' } })
  })

  it('answers the voice catalog the settings page asked for', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({
      voices: [{ voice_id: 'abc', name: 'Радуга' }],
    }), { headers: { 'content-type': 'application/json' } })))
    const response = await runVoices({ provider: 'elevenlabs' }, { 'x-dsh-media-key': 'secret' })
    expect(response.status).toBe(200)
    expect(response.json()).toEqual({ voices: [{ id: 'abc', label: 'Радуга', lang: '' }] })
  })

  it('refuses a voice catalog request without a provider', async () => {
    expect((await runVoices({})).status).toBe(400)
    expect((await runVoices({ provider: '   ' })).status).toBe(400)
  })

  it('rejects a voice catalog request that is not JSON', async () => {
    expect((await runVoices('not json')).status).toBe(400)
  })

  it('reports a refused voice catalog', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('denied', { status: 401 })))
    const response = await runVoices({ provider: 'elevenlabs' })
    expect(response.status).toBe(502)
  })
})

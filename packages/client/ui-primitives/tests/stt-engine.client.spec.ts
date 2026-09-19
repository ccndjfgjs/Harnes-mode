// @vitest-environment jsdom
// Speech recognition as a seam: two engines, one contract. The transport is
// replaced here, so every refusal an engine can meet is exercised without a
// recognizer, a service, or a network.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LOCAL_STT_ROUTE, NOTHING_TO_RECOGNIZE_CODE, NothingToRecognizeError, SERVICE_STT_ROUTE,
  STT_DEFAULT_LANG, STT_ENGINE_IDS, SttError, createLocalSttEngine, createServiceSttEngine,
  createSttEngine, isSttEngineId, requireSttEngine, resolveSttEngineKind,
} from '../src/voice/stt-engine.ts'
import type { SttEngineOptions } from '../src/voice/stt-engine.ts'
import { VOICE_KEY_HEADER, VOICE_URL_HEADER } from '../src/voice-endpoint.ts'

/** One clip of the shape a capture hands over. */
const clip = new Blob([new Uint8Array(16)], { type: 'audio/wav' })

/** A clock that advances on every read, so a duration is never zero by accident. */
function tickingClock(): () => number {
  let value = 0
  return () => {
    value += 10
    return value
  }
}

/** Options with a replaced transport and clock. */
function options(send: typeof fetch, service?: SttEngineOptions['service']): SttEngineOptions {
  return { fetch: send, now: tickingClock(), ...service === undefined ? {} : { service } }
}

/** A transport that answers nothing; these cases never reach it. */
function transport(): typeof fetch {
  return vi.fn() as unknown as typeof fetch
}

/** A JSON response with the given status. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/**
 * The route and init the engine handed to the transport.
 *
 * The transport is a zero-argument fake, so the recorded call tuple is typed
 * empty; reading it through one place keeps every assertion about what the
 * engine sent honest, and fails loudly if it sent nothing at all.
 * @param send - the recording transport.
 * @param index - which call to read.
 * @returns the route and the request init.
 */
function callOf(send: ReturnType<typeof vi.fn>, index = 0): [string, RequestInit] {
  const call = send.mock.calls[index] as unknown as [string, RequestInit] | undefined
  if (call === undefined) throw new Error('the transport was never called')
  return call
}

describe('isSttEngineId', () => {
  it('accepts every offered engine', () => {
    for (const id of STT_ENGINE_IDS) expect(isSttEngineId(id)).toBe(true)
  })

  it('refuses anything else', () => {
    expect(isSttEngineId('whisper')).toBe(false)
    expect(isSttEngineId(7)).toBe(false)
    expect(isSttEngineId(undefined)).toBe(false)
  })

  it('lists the engines in the order the settings card shows them', () => {
    expect(STT_ENGINE_IDS).toEqual(['auto', 'local', 'service'])
  })

  it('names a default locale for recognition', () => {
    expect(STT_DEFAULT_LANG).toBe('ru-RU')
  })
})

describe('resolveSttEngineKind', () => {
  it('takes the machine’s own recognizer when it is named outright', () => {
    expect(resolveSttEngineKind('local', false)).toBe('local')
    expect(resolveSttEngineKind('local', true)).toBe('local')
  })

  it('takes a configured service when it is named outright', () => {
    expect(resolveSttEngineKind('service', true)).toBe('service')
  })

  it('refuses a service that was never configured', () => {
    expect(resolveSttEngineKind('service', false)).toBeUndefined()
  })

  it('prefers a configured service under auto, because configuring one was an instruction', () => {
    expect(resolveSttEngineKind('auto', true)).toBe('service')
  })

  it('falls back to the machine’s own recognizer under auto', () => {
    expect(resolveSttEngineKind('auto', false)).toBe('local')
  })
})

describe('createSttEngine', () => {
  it('builds the engine that was chosen', () => {
    const configured = (): { url: string, key: string } => ({ url: 'https://stt.example.com', key: 'k' })
    expect(createSttEngine('local', options(vi.fn(), configured))?.kind).toBe('local')
    expect(createSttEngine('service', options(vi.fn(), configured))?.kind).toBe('service')
    expect(createSttEngine('auto', options(vi.fn(), configured))?.kind).toBe('service')
  })

  it('answers nothing when the chosen engine cannot run', () => {
    const nothing = (): { url: string, key: string } => ({ url: '', key: '' })
    expect(createSttEngine('service', options(vi.fn(), nothing))).toBeUndefined()
    expect(createSttEngine('auto', options(vi.fn(), nothing))?.kind).toBe('local')
  })
})

describe('the local engine', () => {
  it('reports itself available wherever a transport exists', () => {
    expect(createLocalSttEngine(options(vi.fn())).isAvailable()).toBe(true)
  })

  it('posts the clip to the local route and reads the text back', async () => {
    const send = vi.fn(async () => jsonResponse({ text: '  привет  ' }))
    const engine = createLocalSttEngine(options(send as unknown as typeof fetch))
    const result = await engine.transcribe({ clip, lang: 'ru-RU' })
    expect(result).toEqual({ text: 'привет', engine: 'local', durationMs: 10 })
    const [route, init] = callOf(send)
    expect(route).toBe(`${LOCAL_STT_ROUTE}?lang=ru-RU`)
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['content-type']).toBe('audio/wav')
    expect(init.body).toBe(clip)
  })

  it('encodes the locale into the route', async () => {
    const send = vi.fn(async () => jsonResponse({ text: 'ok' }))
    await createLocalSttEngine(options(send as unknown as typeof fetch)).transcribe({ clip, lang: 'en GB' })
    expect(String(callOf(send)[0])).toBe(`${LOCAL_STT_ROUTE}?lang=en%20GB`)
  })

  it('carries the cancellation signal when one is given', async () => {
    const send = vi.fn(async () => jsonResponse({ text: 'ok' }))
    const signal = new AbortController().signal
    await createLocalSttEngine(options(send as unknown as typeof fetch)).transcribe({ clip, lang: 'ru-RU', signal })
    expect(callOf(send)[1].signal).toBe(signal)
  })

  it('leaves the signal out when there is none', async () => {
    const send = vi.fn(async () => jsonResponse({ text: 'ok' }))
    await createLocalSttEngine(options(send as unknown as typeof fetch)).transcribe({ clip, lang: 'ru-RU' })
    expect(callOf(send)[1].signal).toBeUndefined()
  })
})

describe('the service engine', () => {
  it('reports itself unavailable until an endpoint is stored', () => {
    const nothing = (): { url: string, key: string } => ({ url: '', key: '' })
    expect(createServiceSttEngine(options(vi.fn(), nothing)).isAvailable()).toBe(false)
    const configured = (): { url: string, key: string } => ({ url: 'https://stt.example.com', key: '' })
    expect(createServiceSttEngine(options(vi.fn(), configured)).isAvailable()).toBe(true)
  })

  it('refuses to recognize when nothing is configured', async () => {
    const nothing = (): { url: string, key: string } => ({ url: '', key: '' })
    const engine = createServiceSttEngine(options(vi.fn(), nothing))
    await expect(engine.transcribe({ clip, lang: 'ru-RU' })).rejects.toMatchObject({
      name: 'SttError', reason: 'unavailable',
    })
  })

  it('forwards the clip as multipart with the endpoint and key as headers', async () => {
    const send = vi.fn(async () => jsonResponse({ text: 'ответ' }))
    const configured = (): { url: string, key: string } => ({ url: 'https://stt.example.com', key: 'secret' })
    const engine = createServiceSttEngine(options(send as unknown as typeof fetch, configured))
    const result = await engine.transcribe({ clip, lang: 'ru-RU' })
    expect(result).toEqual({ text: 'ответ', engine: 'service', durationMs: 10 })
    const [route, init] = callOf(send)
    expect(route).toBe(SERVICE_STT_ROUTE)
    const headers = init.headers as Record<string, string>
    expect(headers[VOICE_URL_HEADER]).toBe('https://stt.example.com')
    expect(headers[VOICE_KEY_HEADER]).toBe('secret')
    const body = init.body as FormData
    expect(body.get('audio')).toBeInstanceOf(Blob)
  })

  it('sends no key header when the service needs none', async () => {
    const send = vi.fn(async () => jsonResponse({ text: 'ok' }))
    const configured = (): { url: string, key: string } => ({ url: 'https://stt.example.com', key: '' })
    await createServiceSttEngine(options(send as unknown as typeof fetch, configured)).transcribe({ clip, lang: 'ru-RU' })
    expect(callOf(send)[1].headers).not.toHaveProperty(VOICE_KEY_HEADER)
  })

  it('reads the stored settings when no service is injected', async () => {
    localStorage.setItem('dsh.voice.settings', JSON.stringify({ sttUrl: 'https://stored.example.com', sttKey: 'stored' }))
    const send = vi.fn(async () => jsonResponse({ text: 'ok' }))
    const engine = createServiceSttEngine({ fetch: send as unknown as typeof fetch })
    expect(engine.isAvailable()).toBe(true)
    await engine.transcribe({ clip, lang: 'ru-RU' })
    expect(callOf(send)[1].headers).toMatchObject({
      [VOICE_URL_HEADER]: 'https://stored.example.com',
      [VOICE_KEY_HEADER]: 'stored',
    })
    localStorage.clear()
  })
})

describe('reading an engine response', () => {
  /** Recognize one clip through the local engine with the given response. */
  async function localWith(response: Response): Promise<string> {
    const engine = createLocalSttEngine(options(vi.fn(async () => response) as unknown as typeof fetch))
    return (await engine.transcribe({ clip, lang: 'ru-RU' })).text
  }

  it('accepts a text nested under data', async () => {
    expect(await localWith(jsonResponse({ data: { text: ' вложенный ' } }))).toBe('вложенный')
  })

  it('accepts a bare string body', async () => {
    expect(await localWith(jsonResponse('просто текст'))).toBe('просто текст')
  })

  it('reports an envelope with no text', async () => {
    await expect(localWith(jsonResponse({ segments: [] }))).rejects.toMatchObject({ reason: 'no-text' })
  })

  it('reports a nested envelope with no text', async () => {
    await expect(localWith(jsonResponse({ data: { segments: [] } }))).rejects.toMatchObject({ reason: 'no-text' })
  })

  it('reports a body that is not JSON at all', async () => {
    await expect(localWith(new Response('not json', { status: 200 }))).rejects.toMatchObject({ reason: 'no-text' })
  })

  it('reports a service that is not configured as unavailable', async () => {
    await expect(localWith(jsonResponse({ error: 'DSH_STT_URL is not configured' }, 503))).rejects.toMatchObject({
      reason: 'unavailable', message: 'DSH_STT_URL is not configured',
    })
  })

  it('carries the upstream message of a refusal', async () => {
    await expect(localWith(jsonResponse({ error: 'bad key' }, 401))).rejects.toMatchObject({
      reason: 'refused', message: 'bad key',
    })
  })

  it('falls back to the raw body when a refusal is not JSON', async () => {
    await expect(localWith(new Response('gateway exploded', { status: 502 }))).rejects.toMatchObject({
      reason: 'refused', message: 'gateway exploded',
    })
  })

  it('falls back to the status when a refusal says nothing', async () => {
    await expect(localWith(new Response('', { status: 500 }))).rejects.toMatchObject({
      reason: 'refused', message: 'HTTP 500',
    })
  })

  it('falls back to the status when a refusal body cannot be read', async () => {
    const unreadable = {
      status: 500,
      ok: false,
      text: async () => { throw new Error('stream closed') },
    } as unknown as Response
    await expect(localWith(unreadable)).rejects.toMatchObject({ reason: 'refused', message: 'HTTP 500' })
  })

  it('trims a long non-JSON refusal so a log stays readable', async () => {
    const long = 'x'.repeat(400)
    await expect(localWith(new Response(long, { status: 502 }))).rejects.toMatchObject({
      reason: 'refused', message: 'x'.repeat(200),
    })
  })

  it('reports an unreadable success body as no text', async () => {
    const unreadable = {
      status: 200,
      ok: true,
      json: async () => { throw new Error('broken payload') },
    } as unknown as Response
    await expect(localWith(unreadable)).rejects.toMatchObject({ reason: 'no-text', message: 'broken payload' })
  })
})

describe('a failing transport', () => {
  /** Recognize through an engine whose transport throws. */
  async function failing(reason: unknown): Promise<unknown> {
    const send = vi.fn(async () => { throw reason })
    const engine = createLocalSttEngine(options(send as unknown as typeof fetch))
    try {
      await engine.transcribe({ clip, lang: 'ru-RU' })
      return undefined
    } catch (failure) {
      return failure
    }
  }

  it('reports a network failure with its cause', async () => {
    expect(await failing(new Error('offline'))).toMatchObject({ reason: 'network', message: 'offline' })
  })

  it('reports a non-Error cause as text', async () => {
    expect(await failing('socket died')).toMatchObject({ reason: 'network', message: 'socket died' })
  })

  it('reports an abort as an interruption rather than a failure', async () => {
    const aborted = new Error('cancelled')
    aborted.name = 'AbortError'
    expect(await failing(aborted)).toMatchObject({ reason: 'aborted' })
  })

  it('passes an already-typed failure straight through', async () => {
    const typed = new SttError('unavailable', 'no recognizer installed')
    expect(await failing(typed)).toBe(typed)
  })
})

describe('a refusal that says nothing useful', () => {
  /** Recognize one clip through the local engine with the given response. */
  async function localWith(response: Response): Promise<string> {
    const engine = createLocalSttEngine(options(vi.fn(async () => response) as unknown as typeof fetch))
    return (await engine.transcribe({ clip, lang: 'ru-RU' })).text
  }

  it('falls back to the status when a refusal reports an empty message', async () => {
    await expect(localWith(jsonResponse({ error: '' }, 500))).rejects.toMatchObject({
      reason: 'refused', message: 'HTTP 500',
    })
  })

  it('falls back to the raw body when a refusal is JSON but not an object', async () => {
    await expect(localWith(new Response('"nope"', { status: 502 }))).rejects.toMatchObject({
      reason: 'refused', message: '"nope"',
    })
  })

  it('falls back to the raw body when a refusal is JSON null', async () => {
    await expect(localWith(new Response('null', { status: 502 }))).rejects.toMatchObject({
      reason: 'refused', message: 'null',
    })
  })

  it('reports a success body that is null', async () => {
    await expect(localWith(jsonResponse(null))).rejects.toMatchObject({ reason: 'no-text' })
  })

  it('reports an unreadable body whose failure is not an Error', async () => {
    const unreadable = {
      status: 200,
      ok: true,
      json: async () => { throw 'flat refusal' },
    } as unknown as Response
    await expect(localWith(unreadable)).rejects.toMatchObject({ reason: 'no-text', message: 'flat refusal' })
  })
})

describe('the engines as the app builds them', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('reaches the machine’s own recognizer through the runtime transport', async () => {
    const send = vi.fn(async () => jsonResponse({ text: 'через браузер' }))
    vi.stubGlobal('fetch', send)
    const engine = createLocalSttEngine()
    expect(engine.isAvailable()).toBe(true)
    const result = await engine.transcribe({ clip, lang: 'ru-RU' })
    expect(result.text).toBe('через браузер')
    expect(result.engine).toBe('local')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('reaches the configured service through the runtime transport', async () => {
    localStorage.setItem('dsh.voice.settings', JSON.stringify({ sttUrl: 'https://stt.example.com', sttKey: 'k' }))
    const send = vi.fn(async () => jsonResponse({ text: 'через сервис' }))
    vi.stubGlobal('fetch', send)
    const engine = createServiceSttEngine()
    expect(engine.isAvailable()).toBe(true)
    const result = await engine.transcribe({ clip, lang: 'ru-RU' })
    expect(result).toEqual({ text: 'через сервис', engine: 'service', durationMs: expect.any(Number) as number })
    expect(callOf(send)[1].headers).toMatchObject({
      [VOICE_URL_HEADER]: 'https://stt.example.com',
      [VOICE_KEY_HEADER]: 'k',
    })
  })

  it('reads the stored settings when choosing an engine on its own', () => {
    localStorage.setItem('dsh.voice.settings', JSON.stringify({ sttUrl: 'https://stt.example.com' }))
    expect(createSttEngine('auto')?.kind).toBe('service')
    expect(createSttEngine('local')?.kind).toBe('local')
  })

  it('carries the cancellation signal to the configured service', async () => {
    const send = vi.fn(async () => jsonResponse({ text: 'ok' }))
    const configured = (): { url: string, key: string } => ({ url: 'https://stt.example.com', key: '' })
    const signal = new AbortController().signal
    await createServiceSttEngine(options(send as unknown as typeof fetch, configured))
      .transcribe({ clip, lang: 'ru-RU', signal })
    expect(callOf(send)[1].signal).toBe(signal)
  })

  it('reports a configured service that cannot be reached', async () => {
    const send = vi.fn(async () => { throw new Error('host is down') })
    const configured = (): { url: string, key: string } => ({ url: 'https://stt.example.com', key: '' })
    await expect(createServiceSttEngine(options(send as unknown as typeof fetch, configured))
      .transcribe({ clip, lang: 'ru-RU' })).rejects.toMatchObject({ reason: 'network', message: 'host is down' })
  })
})

describe('the nothing-to-recognize failure', () => {
  it('is caught by its own type, so a caller can offer the repair', () => {
    const failure = new NothingToRecognizeError()
    expect(failure).toBeInstanceOf(NothingToRecognizeError)
    // Still an SttError with the reason it has always carried: existing
    // handling that only knows the base class must keep working.
    expect(failure).toBeInstanceOf(SttError)
    expect(failure.reason).toBe('unavailable')
    expect(failure.name).toBe('NothingToRecognizeError')
  })

  it('names the setting and the action a person should take', () => {
    const failure = new NothingToRecognizeError()
    expect(failure.details.setting).toBe('Голос')
    expect(failure.details.action).toBe('выберите распознавание на этом компьютере или укажите сервис')
  })

  it('logs the agreed JSON document', () => {
    const failure = new NothingToRecognizeError()
    expect(failure.toJSON()).toEqual({
      error: NOTHING_TO_RECOGNIZE_CODE,
      details: {
        setting: 'Голос',
        action: 'выберите распознавание на этом компьютере или укажите сервис',
      },
    })
    // Serialized the way a log would write it, which is the shape a reader
    // searches for.
    expect(JSON.parse(JSON.stringify(failure))).toEqual(failure.toJSON())
  })

  it('lets a caller supply its own action, for a site that knows more', () => {
    const failure = new NothingToRecognizeError('запустите распознаватель по адресу http://127.0.0.1:8000')
    expect(failure.toJSON().details.action).toContain('127.0.0.1:8000')
    expect(failure.toJSON().error).toBe(NOTHING_TO_RECOGNIZE_CODE)
  })

  it('is what the engine builder throws when the chosen engine cannot run', () => {
    const unconfigured = (): { url: string, key: string } => ({ url: '', key: '' })
    expect(() => requireSttEngine('service', options(transport(), unconfigured)))
      .toThrow(NothingToRecognizeError)
  })

  it('returns the engine when the chosen one can run', () => {
    const configured = (): { url: string, key: string } => ({ url: 'https://stt.example.com', key: '' })
    const engine = requireSttEngine('service', options(transport(), configured))
    expect(engine.kind).toBe('service')
  })
})

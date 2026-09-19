/**
 * media-gateway local recognition: the machine's own recognizer reached
 * without a configured service, the clip adapted to the multipart upload an
 * OpenAI-compatible local server expects, and the honest refusal when nothing
 * is listening.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { transcribeLocally } from '../src/index.ts'

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
 * Build one inbound clip request.
 * @param bytes - the recorded clip.
 * @param headers - extra headers, e.g. the clip's content type.
 * @returns the request stand-in.
 */
function fakeRequest(bytes: number[], headers: Record<string, string> = {}): IncomingMessage {
  const payload = Buffer.from(new Uint8Array(bytes))
  return {
    method: 'POST',
    url: '/api/voice/transcribe',
    headers: { 'content-length': String(payload.length), 'content-type': 'audio/wav', ...headers },
    async *[Symbol.asyncIterator]() { yield payload },
  } as unknown as IncomingMessage
}

/**
 * Run the local recognition route over one clip.
 * @param bytes - the recorded clip.
 * @param headers - extra headers.
 * @returns the captured response.
 */
async function run(bytes: number[], headers: Record<string, string> = {}): Promise<FakeResponse> {
  const response = new FakeResponse()
  await transcribeLocally(fakeRequest(bytes, headers), response as unknown as ServerResponse)
  return response
}

/** An upstream answer carrying recognized text. */
function recognition(text: string, status = 200): Response {
  return new Response(JSON.stringify({ text }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** The multipart body the route put on the wire. */
function formOf(init: RequestInit): FormData {
  return init.body as FormData
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.DSH_LOCAL_STT_URL
  delete process.env.DSH_LOCAL_STT_API_KEY
  delete process.env.DSH_LOCAL_STT_MODEL
})

describe('transcribeLocally', () => {
  it('reaches the recognizer every local speech server runs by default', async () => {
    const send = vi.fn(async (_url: string, _init?: RequestInit) => recognition('привет'))
    vi.stubGlobal('fetch', send)
    const response = await run([1, 2, 3])
    expect(send.mock.calls[0]?.[0]).toBe('http://127.0.0.1:8000/v1/audio/transcriptions')
    expect(response.json()).toEqual({ text: 'привет' })
  })

  it('offers the clip as the multipart upload a local server expects', async () => {
    const send = vi.fn(async (_url: string, _init?: RequestInit) => recognition('привет'))
    vi.stubGlobal('fetch', send)
    await run([1, 2, 3])
    const form = formOf(send.mock.calls[0]?.[1] as RequestInit)
    const clip = form.get('file')
    expect(clip).toBeInstanceOf(Blob)
    // Compared as bytes, not as text: the fixture records the samples 1, 2, 3,
    // and decoding them as characters would only prove that the decoder ran.
    expect([...new Uint8Array(await (clip as Blob).arrayBuffer())]).toEqual([1, 2, 3])
  })

  it('carries the clip’s own content type onto the upload', async () => {
    const send = vi.fn(async (_url: string, _init?: RequestInit) => recognition('привет'))
    vi.stubGlobal('fetch', send)
    await run([1], { 'content-type': 'audio/webm' })
    const clip = formOf(send.mock.calls[0]?.[1] as RequestInit).get('file') as Blob
    expect(clip.type).toBe('audio/webm')
  })

  it('asks for a named model only when the deployment names one', async () => {
    const send = vi.fn(async (_url: string, _init?: RequestInit) => recognition('привет'))
    vi.stubGlobal('fetch', send)
    await run([1])
    expect(formOf(send.mock.calls[0]?.[1] as RequestInit).get('model')).toBeNull()

    process.env.DSH_LOCAL_STT_MODEL = 'large-v3'
    await run([1])
    expect(formOf(send.mock.calls[1]?.[1] as RequestInit).get('model')).toBe('large-v3')
  })

  it('ignores an empty model name rather than sending a blank one', async () => {
    const send = vi.fn(async (_url: string, _init?: RequestInit) => recognition('привет'))
    vi.stubGlobal('fetch', send)
    process.env.DSH_LOCAL_STT_MODEL = ''
    await run([1])
    expect(formOf(send.mock.calls[0]?.[1] as RequestInit).get('model')).toBeNull()
  })

  it('honours a recognizer that listens somewhere else', async () => {
    const send = vi.fn(async (_url: string, _init?: RequestInit) => recognition('привет'))
    vi.stubGlobal('fetch', send)
    process.env.DSH_LOCAL_STT_URL = 'http://127.0.0.1:9999/v1/audio/transcriptions'
    await run([1])
    expect(send.mock.calls[0]?.[0]).toBe('http://127.0.0.1:9999/v1/audio/transcriptions')
  })

  it('sends a credential only when the recognizer needs one', async () => {
    const send = vi.fn(async (_url: string, _init?: RequestInit) => recognition('привет'))
    vi.stubGlobal('fetch', send)
    await run([1])
    expect((send.mock.calls[0]?.[1] as RequestInit).headers).toEqual({})

    process.env.DSH_LOCAL_STT_API_KEY = 'secret'
    await run([1])
    expect((send.mock.calls[1]?.[1] as RequestInit).headers).toEqual({ authorization: 'Bearer secret' })
  })

  it('logs the structured failure when nothing is listening', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, _init?: RequestInit) => { throw new Error('ECONNREFUSED') }))
    const response = await run([1])
    expect(response.status).toBe(503)
    // The same token and shape the renderer uses for this failure, so one
    // search in the journal finds both halves of the wire.
    expect(response.json()).toEqual({
      error: 'nothing_to_recognize',
      details: {
        setting: 'Голос',
        action: 'запустите распознаватель по адресу http://127.0.0.1:8000/v1/audio/transcriptions или укажите сервис',
      },
    })
  })

  it('passes an upstream refusal through with its own status', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, _init?: RequestInit) => new Response('{"error":"bad model"}', {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })))
    const response = await run([1])
    expect(response.status).toBe(400)
    expect(response.json()).toEqual({ error: 'bad model' })
  })

  it('assumes JSON when the recognizer names no content type', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, _init?: RequestInit) => {
      const upstream = new Response('{"text":"ok"}', { status: 200 })
      // A string body makes the runtime invent `text/plain`; the case under
      // test is the one where the header is genuinely absent, so it is removed
      // rather than assumed away.
      upstream.headers.delete('content-type')
      return upstream
    }))
    const response = await run([1])
    expect(response.headers['content-type']).toBe('application/json')
  })

  it('refuses a clip larger than one upload', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, _init?: RequestInit) => recognition('привет')))
    const response = new FakeResponse()
    const huge = { 'content-length': String(26 * 1024 * 1024) }
    await expect(transcribeLocally(
      fakeRequest([1], huge),
      response as unknown as ServerResponse,
    )).rejects.toThrow('too large')
  })
})

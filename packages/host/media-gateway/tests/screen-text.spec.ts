/**
 * media-gateway screen-text surface: the OCR prompt forwarded to the vision
 * service, the normalized `{ text }` reply, and the guards that keep a
 * keyless or malformed request from reaching the network.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readScreenText, textOfVisionReply } from '../src/index.ts'

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

  /** The whole body as text. */
  text(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

/** An inbound request carrying one JSON body. */
function fakeRequest(body: string, contentType = 'application/json'): IncomingMessage {
  const chunks = [Buffer.from(body, 'utf8')]
  return {
    headers: { 'content-type': contentType },
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) yield chunk
    },
    on: (event: string, handler: () => void) => {
      if (event === 'end') handler()
      return undefined as never
    },
  } as unknown as IncomingMessage
}

const frameBody = JSON.stringify({ mimeType: 'image/jpeg', imageBase64: 'AAAA' })

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('textOfVisionReply', () => {
  it('reads each of the usual content fields', () => {
    expect(textOfVisionReply(JSON.stringify({ text: 'a' }))).toBe('a')
    expect(textOfVisionReply(JSON.stringify({ content: 'b' }))).toBe('b')
    expect(textOfVisionReply(JSON.stringify({ result: 'c' }))).toBe('c')
    expect(textOfVisionReply(JSON.stringify({ output: 'd' }))).toBe('d')
  })

  it('accepts a bare JSON string and a non-JSON body', () => {
    expect(textOfVisionReply(JSON.stringify('plain'))).toBe('plain')
    expect(textOfVisionReply('not json at all')).toBe('not json at all')
  })

  it('answers an empty string when the reply carries no usable text', () => {
    expect(textOfVisionReply(JSON.stringify({ text: 7 }))).toBe('')
    expect(textOfVisionReply(JSON.stringify({ other: 'x' }))).toBe('')
    expect(textOfVisionReply(JSON.stringify(null))).toBe('')
  })
})

describe('readScreenText route', () => {
  it('refuses the request without a configured vision endpoint', async () => {
    vi.stubEnv('DSH_VISION_URL', undefined)
    const res = new FakeResponse()
    await readScreenText(fakeRequest(frameBody), res as unknown as ServerResponse)
    expect(res.status).toBe(503)
    expect(res.text()).toContain('DSH_VISION_URL')
  })

  it('rejects a body that is not JSON', async () => {
    vi.stubEnv('DSH_VISION_URL', 'https://vision.test/ocr')
    const res = new FakeResponse()
    await readScreenText(fakeRequest(frameBody, 'text/plain'), res as unknown as ServerResponse)
    expect(res.status).toBe(415)
  })

  it('rejects a frame with no image payload', async () => {
    vi.stubEnv('DSH_VISION_URL', 'https://vision.test/ocr')
    const res = new FakeResponse()
    await readScreenText(fakeRequest(JSON.stringify({ mimeType: 'image/jpeg' })), res as unknown as ServerResponse)
    expect(res.status).toBe(400)
    expect(res.text()).toContain('imageBase64')
  })

  it('forwards the frame with an extraction prompt and normalizes the reply', async () => {
    vi.stubEnv('DSH_VISION_URL', 'https://vision.test/ocr')
    const upstream = vi.fn(async (_url: string, _init?: RequestInit) => new Response(
      JSON.stringify({ text: 'const x = 1' }), { status: 200 },
    ))
    vi.stubGlobal('fetch', upstream)
    const res = new FakeResponse()
    await readScreenText(fakeRequest(frameBody), res as unknown as ServerResponse)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.text())).toEqual({ text: 'const x = 1' })
    const sent = jsonBodyOf(upstream.mock.calls[0]?.[1] ?? {})
    expect(sent.imageBase64).toBe('AAAA')
    expect(sent.mimeType).toBe('image/jpeg')
    // The prompt is the server's, not the client's: the browser only sends the frame.
    expect(String(sent.prompt)).toContain('текст')
  })

  it('passes an upstream failure through untouched', async () => {
    vi.stubEnv('DSH_VISION_URL', 'https://vision.test/ocr')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"boom"}', { status: 502 })))
    const res = new FakeResponse()
    await readScreenText(fakeRequest(frameBody), res as unknown as ServerResponse)
    expect(res.status).toBe(502)
    expect(res.text()).toContain('boom')
  })
})

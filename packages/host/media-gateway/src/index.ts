import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'

const MAX_AUDIO_BYTES = 25 * 1024 * 1024
const MAX_FRAME_BYTES = 12 * 1024 * 1024
const MAX_SPEECH_BYTES = 64 * 1024
/** Longest text one speech request may carry; longer drafts are truncated, not rejected. */
const MAX_SPEECH_CHARS = 1200
const REALTIME_PATH = '/api/media/realtime'
const SPEAK_PATH = '/api/media/speak'
/**
 * Recognition route served by the machine's own recognizer.
 *
 * Kept apart from `/api/media/transcribe` because the two answer to different
 * authorities: that route forwards to whatever service the *user* configured,
 * while this one always targets the recognizer running on this machine, so
 * speech recognition works with nothing configured at all. The desktop app
 * depends on that difference — a packaged build carries no browser recognizer,
 * so a machine-local engine is the only one that works there.
 */
const LOCAL_STT_PATH = '/api/voice/transcribe'
/**
 * Stable machine token for "there is no recognizer to drive".
 *
 * Repeated here rather than imported: this gateway is a host package and the
 * constant lives in the renderer's own primitives leaf, which a host package
 * cannot reach. The two halves of the wire contract are therefore kept in step
 * by hand — the client's copy is `NOTHING_TO_RECOGNIZE_CODE` in
 * `packages/client/ui-primitives/src/voice/stt-engine.ts`, and a change to
 * either one has to change both.
 */
const NOTHING_TO_RECOGNIZE_CODE = 'nothing_to_recognize'
/** The Voice page a person opens to repair it; matches the client's wording. */
const NOTHING_TO_RECOGNIZE_SETTING = 'Голос'
/**
 * Where a machine-local recognizer is expected to listen.
 *
 * Every OpenAI-compatible local speech server — including the faster-whisper
 * one this app is built around — serves transcriptions here by default.
 * Operators running theirs elsewhere set DSH_LOCAL_STT_URL.
 */
const LOCAL_STT_DEFAULT_URL = 'http://127.0.0.1:8000/v1/audio/transcriptions'
/** Field name an OpenAI-compatible recognizer expects the clip under. */
const LOCAL_STT_FIELD = 'file'
/** Filename the clip is offered under; the recognizer reads the bytes, not the name. */
const LOCAL_STT_FILENAME = 'voice.wav'
/** Google's public speech endpoint rejects requests past roughly 200 characters. */
const GOOGLE_TTS_CHUNK = 180
const DEFAULT_SPEECH_LANG = 'ru-RU'
/**
 * Renderer-supplied endpoint overrides. The Voice Settings page keeps its
 * endpoints and keys in the browser, so the renderer hands them to this
 * gateway per request; the DSH_* environment stays the deployment-wide
 * fallback for operators who configure the host instead of the UI.
 */
const URL_HEADER = 'x-dsh-media-url'
const KEY_HEADER = 'x-dsh-media-key'
/** Google's public speech endpoint answers only to a browser-looking caller. */
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
/** Voice list route: the renderer asks the gateway instead of calling providers itself. */
const VOICES_PATH = '/api/media/voices'
/** Longest speech rate multiplier a request may carry. */
const SPEECH_SPEED_MAX = 2
/** Lowest speech rate multiplier a request may carry. */
const SPEECH_SPEED_MIN = 0.5
/** Longest pitch multiplier a request may carry. */
const SPEECH_PITCH_MAX = 2
/** Lowest pitch multiplier a request may carry. */
const SPEECH_PITCH_MIN = 0.5

/** Credential styles a provider may expect; mirrors the client's VoiceAuthStyle. */
type VoiceAuthStyle = 'none' | 'bearer' | 'query' | 'header'

/** Voice and pacing one speech request carries. */
type SpeechVoice = {
  readonly provider: string
  readonly voice: string
  readonly model: string
  readonly speed: number
  readonly pitch: number
}

/** What one provider's synthesis request looks like on the wire. */
type SpeechAdapter = {
  /** Where the credential goes. */
  readonly auth: VoiceAuthStyle
  /** Endpoint used when neither the renderer nor the deployment names one. */
  readonly url: string
  /** Whether the voice id belongs in the path rather than the body. */
  readonly voiceInPath: boolean
  /** Build the request body. */
  readonly build: (text: string, lang: string, voice: SpeechVoice) => Record<string, unknown>
}

/**
 * Request shapes per provider. A provider absent from this table keeps the
 * generic "flat text plus Google Cloud nesting" body, which is what a plain
 * URL-and-key service (`custom`) has always received.
 */
const SPEECH_ADAPTERS: Record<string, SpeechAdapter> = {
  openai: {
    auth: 'bearer',
    url: 'https://api.openai.com/v1/audio/speech',
    voiceInPath: false,
    build: (text, _lang, voice) => ({
      model: voice.model === '' ? 'tts-1' : voice.model,
      input: text,
      voice: voice.voice === '' ? 'alloy' : voice.voice,
      speed: voice.speed,
      response_format: 'mp3',
    }),
  },
  'google-cloud': {
    auth: 'query',
    url: 'https://texttospeech.googleapis.com/v1/text:synthesize',
    voiceInPath: false,
    build: (text, lang, voice) => ({
      input: { text },
      voice: { languageCode: lang, ...voice.voice === '' ? {} : { name: voice.voice } },
      audioConfig: { audioEncoding: 'MP3', speakingRate: voice.speed, pitch: voice.pitch },
    }),
  },
  elevenlabs: {
    auth: 'header',
    url: 'https://api.elevenlabs.io/v1/text-to-speech',
    voiceInPath: true,
    build: (text, _lang, voice) => ({
      text,
      model_id: voice.model === '' ? 'eleven_multilingual_v2' : voice.model,
    }),
  },
}

/**
 * Look one provider's request shape up.
 * @param provider - provider id the renderer named.
 * @returns the adapter, or undefined for a provider without a dedicated shape.
 */
function speechAdapter(provider: string): SpeechAdapter | undefined {
  return SPEECH_ADAPTERS[provider]
}

/**
 * Put the voice id in the path when the provider expects it there.
 * @param url - the resolved endpoint.
 * @param adapter - the provider's adapter, when it has one.
 * @param voice - the chosen voice, or '' for the provider default.
 * @returns the URL to call.
 */
function withVoicePath(url: string, adapter: SpeechAdapter | undefined, voice: string): string {
  if (adapter?.voiceInPath !== true || voice === '') return url
  return url.endsWith(`/${voice}`) ? url : `${url.replace(/\/+$/, '')}/${voice}`
}

/**
 * Build the request body for one provider: its own shape when the provider has
 * an adapter, otherwise the generic body that serves a plain speech service.
 * @param adapter - the provider's adapter, when it has one.
 * @param text - text to speak.
 * @param lang - BCP 47 tag.
 * @param voice - voice and pacing the renderer asked for.
 * @returns the JSON body.
 */
function speechPayload(
  adapter: SpeechAdapter | undefined,
  text: string,
  lang: string,
  voice: SpeechVoice,
): Record<string, unknown> {
  if (adapter !== undefined) return adapter.build(text, lang, voice)
  return {
    text,
    lang,
    input: { text },
    voice: { languageCode: lang, ...voice.voice === '' ? {} : { name: voice.voice } },
    audioConfig: { encoding: 'MP3', speakingRate: voice.speed, pitch: voice.pitch },
  }
}

type MediaSettings = {
  sttUrl?: string
  sttApiKey?: string
  ttsUrl?: string
  ttsApiKey?: string
  visionUrl?: string
  visionApiKey?: string
  realtimeUrl?: string
  realtimeApiKey?: string
}

/** One resolved upstream: where to call and with which credential. */
type Endpoint = {
  readonly url: string | undefined
  readonly apiKey: string | undefined
}

/** One synthesized clip ready to hand back to the renderer. */
type AudioClip = {
  readonly contentType: string
  readonly body: Buffer
}

function settings(): MediaSettings {
  const values = {
    sttUrl: process.env.DSH_STT_URL,
    sttApiKey: process.env.DSH_STT_API_KEY,
    ttsUrl: process.env.DSH_TTS_URL,
    ttsApiKey: process.env.DSH_TTS_API_KEY,
    visionUrl: process.env.DSH_VISION_URL,
    visionApiKey: process.env.DSH_VISION_API_KEY,
    realtimeUrl: process.env.DSH_REALTIME_URL,
    realtimeApiKey: process.env.DSH_REALTIME_API_KEY,
  }
  const defined = Object.entries(values).filter(([, value]) => value !== undefined)
  return Object.fromEntries(defined)
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body).toString(),
  }
  res.writeHead(status, headers)
  res.end(body)
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0)
  if (declared > limit) throw new Error('media request is too large')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += data.length
    if (size > limit) throw new Error('media request is too large')
    chunks.push(data)
  }
  return Buffer.concat(chunks)
}

function authHeaders(apiKey: string | undefined): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {}
}

/**
 * Read one non-empty header value.
 * @param req - inbound request.
 * @param name - lower-case header name.
 * @returns the trimmed value, or undefined when absent or blank.
 */
function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name]
  const value = Array.isArray(raw) ? raw[0] : raw
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Resolve which upstream a request targets: the renderer's own endpoint when it
 * sent one, otherwise the deployment's environment default. Without this the
 * endpoints and keys typed into Voice Settings never reach the network.
 * @param req - inbound request carrying optional override headers.
 * @param url - environment default URL.
 * @param apiKey - environment default credential.
 * @returns the endpoint to call.
 */
function endpointOf(req: IncomingMessage, url: string | undefined, apiKey: string | undefined): Endpoint {
  return {
    url: headerValue(req, URL_HEADER) ?? url,
    apiKey: headerValue(req, KEY_HEADER) ?? apiKey,
  }
}

async function transcribe(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { url, apiKey } = endpointOf(req, settings().sttUrl, settings().sttApiKey)
  if (url === undefined) {
    sendJson(res, 503, { error: 'DSH_STT_URL is not configured' })
    return
  }
  const body = await readBody(req, MAX_AUDIO_BYTES)
  const upstream = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': req.headers['content-type'] ?? 'application/octet-stream',
      ...authHeaders(apiKey),
    },
    body: body as unknown as BodyInit,
  })
  const text = await upstream.text()
  res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
  res.end(text)
}

/**
 * Recognize one clip with the recognizer running on this machine.
 *
 * The clip arrives as a raw WAVE body — that is the shape the voice module
 * records — and is re-offered to the recognizer as the multipart upload every
 * OpenAI-compatible local server expects. That adaptation lives here rather
 * than in the renderer so the recognizer's own API is this gateway's business:
 * swapping faster-whisper for another local server changes this function and
 * nothing that records audio.
 *
 * A recognizer that is not running is reported as such, naming the address
 * that was tried. It is a separate program the person installs, so silence
 * would leave them guessing whether the fault was the clip, the microphone, or
 * the missing engine.
 * @param req - the inbound clip request.
 * @param res - the response to write.
 */
export async function transcribeLocally(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = process.env.DSH_LOCAL_STT_URL ?? LOCAL_STT_DEFAULT_URL
  const apiKey = process.env.DSH_LOCAL_STT_API_KEY
  const body = await readBody(req, MAX_AUDIO_BYTES)
  const form = new FormData()
  form.append(
    LOCAL_STT_FIELD,
    // Copied through a plain view: a Buffer's backing store is typed loosely
    // enough that Blob rejects it, and a clip is at most one upload in size.
    new Blob([new Uint8Array(body)], { type: req.headers['content-type'] ?? 'audio/wav' }),
    LOCAL_STT_FILENAME,
  )
  const model = process.env.DSH_LOCAL_STT_MODEL
  if (model !== undefined && model !== '') form.append('model', model)
  let upstream: Response
  try {
    upstream = await fetch(url, { method: 'POST', headers: authHeaders(apiKey), body: form })
  } catch {
    // The recognizer is not running. Reported in the same structured shape the
    // client uses for this failure, so a journal reader finds every "nothing to
    // recognize" by its token instead of by matching prose that differs between
    // the renderer and this gateway.
    sendJson(res, 503, {
      error: NOTHING_TO_RECOGNIZE_CODE,
      details: { setting: NOTHING_TO_RECOGNIZE_SETTING, action: `запустите распознаватель по адресу ${url} или укажите сервис` },
    })
    return
  }
  const text = await upstream.text()
  res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
  res.end(text)
}

async function analyzeScreen(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { url, apiKey } = endpointOf(req, settings().visionUrl, settings().visionApiKey)
  if (url === undefined) {
    sendJson(res, 503, { error: 'DSH_VISION_URL is not configured' })
    return
  }
  const body = await readBody(req, MAX_FRAME_BYTES)
  const contentType = req.headers['content-type'] ?? ''
  if (!contentType.startsWith('application/json')) {
    sendJson(res, 415, { error: 'screen analysis requires application/json' })
    return
  }
  const upstream = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(apiKey) },
    body: body as unknown as BodyInit,
  })
  const text = await upstream.text()
  res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
  res.end(text)
}

/**
 * Prompt sent with a frame when the client wants the words on screen rather
 * than a description of it. Kept here so the client never invents the prompt
 * and the two paths (?analyze? vs ?text?) stay distinguishable upstream.
 */
const SCREEN_TEXT_PROMPT
  = 'Извлеки весь читаемый текст с изображения экрана. Верни только текст, без пояснений и без обрамления.'

/**
 * Read the text off one screen frame through the configured vision endpoint.
 *
 * The upstream service is a vision model, so "OCR" is a prompt rather than a
 * separate engine: the frame is forwarded with an extraction prompt and the
 * reply is normalized into `{ text }` so the client has one shape to read.
 * @param req - the inbound frame request.
 * @param res - the response to write.
 */
export async function readScreenText(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { url, apiKey } = endpointOf(req, settings().visionUrl, settings().visionApiKey)
  if (url === undefined) {
    sendJson(res, 503, { error: 'DSH_VISION_URL is not configured' })
    return
  }
  const body = await readBody(req, MAX_FRAME_BYTES)
  const contentType = req.headers['content-type'] ?? ''
  if (!contentType.startsWith('application/json')) {
    sendJson(res, 415, { error: 'screen text requires application/json' })
    return
  }
  let frame: Record<string, unknown>
  try {
    frame = JSON.parse(body.toString('utf8')) as Record<string, unknown>
  } catch {
    sendJson(res, 400, { error: 'screen text requires a JSON body' })
    return
  }
  if (typeof frame.imageBase64 !== 'string' || frame.imageBase64 === '') {
    sendJson(res, 400, { error: 'screen text requires imageBase64' })
    return
  }
  const upstream = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(apiKey) },
    body: JSON.stringify({
      mimeType: typeof frame.mimeType === 'string' ? frame.mimeType : 'image/jpeg',
      imageBase64: frame.imageBase64,
      prompt: SCREEN_TEXT_PROMPT,
    }),
  })
  const raw = await upstream.text()
  if (!upstream.ok) {
    res.writeHead(upstream.status, { 'content-type': 'application/json' })
    res.end(raw)
    return
  }
  // The service answers with whatever shape it likes; the client only reads
  // { text }, so normalize the common reply fields here instead of making the
  // browser guess between "text", "content", and a bare string.
  sendJson(res, 200, { text: textOfVisionReply(raw) })
}

/**
 * Pull the text out of a vision reply, tolerating either a plain string or a
 * JSON object carrying the usual content fields.
 * @param raw - the upstream response body.
 * @returns the extracted text, or an empty string when none is present.
 */
export function textOfVisionReply(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed === 'string') return parsed
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>
      for (const key of ['text', 'content', 'result', 'output']) {
        if (typeof record[key] === 'string') return record[key] as string
      }
    }
  } catch {
    // Not JSON: the service answered with the text directly.
    return raw
  }
  return ''
}

/** One speech request read off the wire. */
type SpeechRequest = {
  readonly text: string
  readonly lang: string
  readonly provider: string
  readonly voice: string
  readonly model: string
  readonly speed: number
  readonly pitch: number
}

/**
 * Read one trimmed string field off a parsed body.
 * @param record - parsed body.
 * @param field - field to read.
 * @returns the trimmed value, or '' when absent or not a string.
 */
function textField(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Clamp one numeric field into its allowed range.
 * @param value - value read off the body.
 * @param min - lowest allowed value.
 * @param max - highest allowed value.
 * @returns the clamped number, or 1 when the field carries no number.
 */
function pace(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1
  return Math.min(max, Math.max(min, value))
}

/**
 * Validate a speech request body.
 * @param body - parsed JSON body.
 * @returns the request, or undefined when it carries no usable text.
 */
export function speechRequest(body: unknown): SpeechRequest | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const record = body as Record<string, unknown>
  if (typeof record.text !== 'string') return undefined
  const text = record.text.trim()
  if (text === '') return undefined
  const lang = typeof record.lang === 'string' && record.lang.trim() !== ''
    ? record.lang.trim()
    : DEFAULT_SPEECH_LANG
  const provider = textField(record, 'provider')
  return {
    text: text.slice(0, MAX_SPEECH_CHARS),
    lang,
    provider: provider === '' ? 'custom' : provider,
    voice: textField(record, 'voice'),
    model: textField(record, 'model'),
    speed: pace(record.speed, SPEECH_SPEED_MIN, SPEECH_SPEED_MAX),
    pitch: pace(record.pitch, SPEECH_PITCH_MIN, SPEECH_PITCH_MAX),
  }
}

/**
 * Split text into pieces the public Google speech endpoint accepts. Breaks on
 * whitespace so no word is cut, and hard-splits a single over-long word.
 * @param text - already-trimmed text.
 * @returns the ordered pieces, none longer than the endpoint's cap.
 */
export function chunkForSpeech(text: string): string[] {
  const pieces: string[] = []
  let current = ''
  for (const word of text.split(/\s+/)) {
    if (word === '') continue
    let rest = word
    while (rest.length > GOOGLE_TTS_CHUNK) {
      if (current !== '') {
        pieces.push(current)
        current = ''
      }
      pieces.push(rest.slice(0, GOOGLE_TTS_CHUNK))
      rest = rest.slice(GOOGLE_TTS_CHUNK)
    }
    const candidate = current === '' ? rest : `${current} ${rest}`
    if (candidate.length > GOOGLE_TTS_CHUNK) {
      pieces.push(current)
      current = rest
    } else {
      current = candidate
    }
  }
  if (current !== '') pieces.push(current)
  return pieces
}

/**
 * Build one keyless Google Translate speech URL. This is the "no key" voice
 * path: the same engine a browser uses, reached from the host so no CORS
 * negotiation is involved.
 * @param text - one piece of text within the endpoint's cap.
 * @param lang - BCP 47 tag; only the primary subtag is sent.
 * @returns the absolute URL.
 */
export function googleSpeechUrl(text: string, lang: string): string {
  const [primary = ''] = lang.split('-')
  const query = new URLSearchParams({ ie: 'UTF-8', client: 'tw-ob', tl: primary === '' ? 'ru' : primary, q: text })
  return `https://translate.google.com/translate_tts?${query.toString()}`
}

/**
 * Synthesize through Google's keyless endpoint, one request per piece and the
 * MP3 frames concatenated into a single stream the renderer can play.
 * @param text - text to speak.
 * @param lang - BCP 47 tag.
 * @returns the concatenated clip.
 * @throws {Error} when Google refuses a piece.
 */
async function synthesizeGoogle(text: string, lang: string): Promise<AudioClip> {
  const frames: Buffer[] = []
  for (const piece of chunkForSpeech(text)) {
    const upstream = await fetch(googleSpeechUrl(piece, lang), {
      headers: { 'user-agent': BROWSER_USER_AGENT, 'accept': 'audio/mpeg,*/*' },
    })
    if (!upstream.ok) throw new Error(`Google speech answered HTTP ${upstream.status}`)
    frames.push(Buffer.from(await upstream.arrayBuffer()))
  }
  return { contentType: 'audio/mpeg', body: Buffer.concat(frames) }
}

/**
 * Ask a Google Cloud endpoint for its API-key query parameter rather than a
 * bearer header: API keys are only accepted in the query string there, while
 * every other TTS service in the wild uses the Authorization header.
 * @param url - the configured endpoint.
 * @param apiKey - the configured key.
 * @param auth - the provider's credential style, when it has a dedicated adapter.
 * @returns the URL to call and the headers to send.
 */
export function speechTarget(
  url: string,
  apiKey: string | undefined,
  auth?: VoiceAuthStyle,
): { url: string; headers: Record<string, string> } {
  const target = new URL(url)
  const isGoogleApi = target.hostname.endsWith('googleapis.com')
  const style: VoiceAuthStyle = auth ?? (isGoogleApi ? 'query' : 'bearer')
  if (style === 'query' && apiKey !== undefined && !target.searchParams.has('key')) {
    target.searchParams.set('key', apiKey)
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (style === 'bearer' && apiKey !== undefined) headers.authorization = `Bearer ${apiKey}`
  // ElevenLabs reads its credential from a dedicated header rather than the
  // Authorization pair; keeping the name here saves a second adapter field.
  if (style === 'header' && apiKey !== undefined) headers['xi-api-key'] = apiKey
  return { url: target.toString(), headers }
}

/**
 * Read one clip out of an upstream speech response. Cloud TTS services answer
 * JSON carrying base64 audio; plain speech services answer audio bytes.
 * @param upstream - the upstream response.
 * @returns the clip, or undefined when the payload carries no audio.
 */
async function clipOf(upstream: Response): Promise<AudioClip | undefined> {
  const contentType = upstream.headers.get('content-type') ?? ''
  if (!contentType.includes('json')) {
    return { contentType: contentType === '' ? 'audio/mpeg' : contentType, body: Buffer.from(await upstream.arrayBuffer()) }
  }
  const payload: unknown = await upstream.json()
  if (typeof payload !== 'object' || payload === null) return undefined
  const encoded = (payload as { audioContent?: unknown }).audioContent
  if (typeof encoded !== 'string' || encoded === '') return undefined
  return { contentType: 'audio/mpeg', body: Buffer.from(encoded, 'base64') }
}

/**
 * Synthesize through the endpoint the user configured. The body follows the
 * provider's own shape when it has an adapter, and the generic "flat text plus
 * Google Cloud nesting" shape otherwise, so one request serves either style of
 * service.
 * @param url - the configured endpoint.
 * @param apiKey - the configured credential.
 * @param request - the validated speech request, carrying provider and voice.
 * @returns the clip.
 * @throws {Error} when the upstream refuses or answers without audio.
 */
async function synthesizeRemote(url: string, apiKey: string | undefined, request: SpeechRequest): Promise<AudioClip> {
  const adapter = speechAdapter(request.provider)
  const target = speechTarget(withVoicePath(url, adapter, request.voice), apiKey, adapter?.auth)
  const upstream = await fetch(target.url, {
    method: 'POST',
    headers: target.headers,
    body: JSON.stringify(speechPayload(adapter, request.text, request.lang, request)),
  })
  if (!upstream.ok) throw new Error(`Speech service answered HTTP ${upstream.status}`)
  const clip = await clipOf(upstream)
  if (clip === undefined) throw new Error('Speech service answered without audio')
  return clip
}

/**
 * Speak one text: the configured service when there is one, otherwise Google's
 * keyless engine. Answers audio bytes so the renderer plays them directly.
 * @param req - inbound JSON request carrying text and an optional language.
 * @param res - response receiving the clip.
 */
export async function speak(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown
  try {
    body = JSON.parse((await readBody(req, MAX_SPEECH_BYTES)).toString('utf8')) as unknown
  } catch {
    sendJson(res, 400, { error: 'speech request must be JSON' })
    return
  }
  const request = speechRequest(body)
  if (request === undefined) {
    sendJson(res, 400, { error: 'speech request needs non-empty text' })
    return
  }
  const { url, apiKey } = endpointOf(req, settings().ttsUrl, settings().ttsApiKey)
  // A named provider carries its own endpoint, so a request that names one
  // needs no URL typed into Voice Settings at all.
  const resolved = url ?? speechAdapter(request.provider)?.url
  try {
    const clip = resolved === undefined
      ? await synthesizeGoogle(request.text, request.lang)
      : await synthesizeRemote(resolved, apiKey, request)
    res.writeHead(200, { 'content-type': clip.contentType, 'content-length': clip.body.length.toString() })
    res.end(clip.body)
  } catch (error) {
    sendJson(res, 502, { error: error instanceof Error ? error.message : 'speech synthesis failed' })
  }
}

/** One voice offered by a provider, normalized for the settings page. */
type VoiceEntry = {
  readonly id: string
  readonly label: string
  readonly lang: string
}

/** How to read one provider's voice catalog. */
type VoiceCatalog = {
  /** Catalog endpoint. */
  readonly url: string
  /** Where the credential goes. */
  readonly auth: VoiceAuthStyle
  /** Normalize the upstream payload into entries, tolerating any shape. */
  readonly read: (payload: unknown) => VoiceEntry[]
}

/** Pull one string field out of an arbitrary record. */
function stringOf(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  return typeof value === 'string' ? value : ''
}

/**
 * Providers whose catalog is fetched at runtime. A provider absent from this
 * table either ships a static catalog the client already holds (system,
 * openai) or has no catalog at all (google, custom).
 */
const VOICE_CATALOGS: Record<string, VoiceCatalog> = {
  'google-cloud': {
    url: 'https://texttospeech.googleapis.com/v1/voices',
    auth: 'query',
    read: (payload) => {
      const voices = (payload as { voices?: unknown }).voices
      if (!Array.isArray(voices)) return []
      return voices.flatMap((item) => {
        if (typeof item !== 'object' || item === null) return []
        const record = item as Record<string, unknown>
        const id = stringOf(record, 'name')
        if (id === '') return []
        const codes = record.languageCodes
        const lang = Array.isArray(codes) && typeof codes[0] === 'string' ? codes[0] : ''
        return [{ id, label: id, lang }]
      })
    },
  },
  elevenlabs: {
    url: 'https://api.elevenlabs.io/v1/voices',
    auth: 'header',
    read: (payload) => {
      const voices = (payload as { voices?: unknown }).voices
      if (!Array.isArray(voices)) return []
      return voices.flatMap((item) => {
        if (typeof item !== 'object' || item === null) return []
        const record = item as Record<string, unknown>
        const id = stringOf(record, 'voice_id')
        if (id === '') return []
        const label = stringOf(record, 'name')
        return [{ id, label: label === '' ? id : label, lang: '' }]
      })
    },
  },
}

/**
 * Ask one provider for its voice catalog. Providers without a runtime catalog
 * answer an empty list rather than an error: the client already holds their
 * static list, so "nothing to fetch" is not a failure.
 * @param provider - provider id the renderer named.
 * @param apiKey - credential to send.
 * @returns the normalized entries.
 * @throws {Error} when the provider refuses or the transport fails.
 */
export async function listVoices(provider: string, apiKey: string | undefined): Promise<VoiceEntry[]> {
  const catalog = VOICE_CATALOGS[provider]
  if (catalog === undefined) return []
  const target = speechTarget(catalog.url, apiKey, catalog.auth)
  const upstream = await fetch(target.url, { headers: target.headers })
  if (!upstream.ok) throw new Error(`Voice catalog answered HTTP ${upstream.status}`)
  return catalog.read(await upstream.json() as unknown)
}

/**
 * Serve the voice catalog the settings page asks for, so the browser never
 * calls a provider directly and the credential stays out of the page.
 * @param req - inbound JSON request carrying the provider id.
 * @param res - response receiving the entries.
 */
export async function voices(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown
  try {
    body = JSON.parse((await readBody(req, MAX_SPEECH_BYTES)).toString('utf8')) as unknown
  } catch {
    sendJson(res, 400, { error: 'voice request must be JSON' })
    return
  }
  if (typeof body !== 'object' || body === null) {
    sendJson(res, 400, { error: 'voice request needs a provider' })
    return
  }
  const provider = textField(body as Record<string, unknown>, 'provider')
  if (provider === '') {
    sendJson(res, 400, { error: 'voice request needs a provider' })
    return
  }
  const apiKey = headerValue(req, KEY_HEADER) ?? settings().ttsApiKey
  try {
    sendJson(res, 200, { voices: await listVoices(provider, apiKey) })
  } catch (error) {
    sendJson(res, 502, { error: error instanceof Error ? error.message : 'voice catalog failed' })
  }
}

/**
 * Read the voice a call asked for. A browser cannot set headers on a WebSocket
 * handshake, so the renderer hands the provider and voice over the query string
 * the same way it already hands over the signaling server.
 * @param req - the upgrade request.
 * @returns the provider id and voice id, each '' when absent.
 */
export function realtimeVoice(req: IncomingMessage): { provider: string; voice: string } {
  const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '')
  return {
    provider: query.get('provider')?.trim() ?? '',
    voice: query.get('voice')?.trim() ?? '',
  }
}

/**
 * Carry the requested voice on to the upstream handshake.
 * @param url - the resolved signaling server.
 * @param voice - provider and voice the renderer asked for.
 * @returns the URL to dial, unchanged when no voice was named or it is unusable.
 */
export function realtimeUpstreamUrl(url: string, voice: { provider: string; voice: string }): string {
  if (voice.provider === '' && voice.voice === '') return url
  try {
    const target = new URL(url)
    if (voice.provider !== '') target.searchParams.set('provider', voice.provider)
    if (voice.voice !== '') target.searchParams.set('voice', voice.voice)
    return target.toString()
  } catch {
    // An unparseable server address is the caller's problem, not ours: dial it
    // unchanged rather than refusing the call over a voice hint.
    return url
  }
}

function rejectUpgrade(socket: Duplex, status: number): void {
  const reason = status === 401 ? 'Unauthorized' : 'Forbidden'
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}

function relayRealtime(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  ctx: Context,
  upstreamUrl: string,
  apiKey?: string,
): void {
  const server = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })
  server.handleUpgrade(req, socket, head, (client) => {
    const upstream = new WebSocket(upstreamUrl, apiKey ? { headers: authHeaders(apiKey) } : undefined)
    const close = (): void => {
      if (client.readyState < WebSocket.CLOSING) client.close()
      if (upstream.readyState < WebSocket.CLOSING) upstream.close()
      server.close()
    }
    client.on('message', (data) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data)
    })
    upstream.on('message', (data) => {
      if (client.readyState === WebSocket.OPEN) client.send(data)
    })
    client.on('close', close)
    upstream.on('close', close)
    client.on('error', (error) => {
      ctx.logger.warn(error)
    })
    upstream.on('error', (error) => {
      ctx.logger.warn(error)
      close()
    })
  })
}

/**
 * Read the signaling target for one realtime upgrade. A browser cannot set
 * headers on a WebSocket handshake, so the renderer hands its configured
 * signaling server over the query string instead.
 * @param req - the upgrade request.
 * @returns the URL to dial, or undefined when neither source names one.
 */
export function realtimeTarget(req: IncomingMessage): string | undefined {
  const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '')
  const fromQuery = query.get('url')?.trim()
  if (fromQuery !== undefined && fromQuery !== '') return fromQuery
  return settings().realtimeUrl
}

/**
 * Build one exact POST route behind the shared method + trust/auth fence.
 * @param path - absolute route path.
 * @param requestRejection - connection fence returning a status or undefined.
 * @param run - authenticated body handler.
 * @returns the route registration.
 */
function postRoute(
  path: string,
  requestRejection: (req: IncomingMessage) => number | undefined,
  run: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): WebRoute {
  return {
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405)
        res.end()
        return
      }
      const rejection = requestRejection(req)
      if (rejection !== undefined) {
        res.writeHead(rejection)
        res.end()
        return
      }
      await run(req, res)
    },
  }
}

/** Register authenticated STT, speech, screen-analysis, and realtime media routes in the Harness web server. */
export function apply(ctx: Context): void {
  ctx.inject(['connection', 'webServer'], (webCtx) => {
    const fence = (req: IncomingMessage): number | undefined => webCtx.connection.requestRejection(req)
    const unregister = [
      webCtx.webServer.register(postRoute('/api/media/transcribe', fence, transcribe)),
      webCtx.webServer.register(postRoute(LOCAL_STT_PATH, fence, transcribeLocally)),
      webCtx.webServer.register(postRoute(SPEAK_PATH, fence, speak)),
      webCtx.webServer.register(postRoute(VOICES_PATH, fence, voices)),
      webCtx.webServer.register(postRoute('/api/media/screen/analyze', fence, analyzeScreen)),
      webCtx.webServer.register(postRoute('/api/media/screen/text', fence, readScreenText)),
    ]
    const upgrade: WebUpgradeRoute = {
      path: REALTIME_PATH,
      handler: (req, socket, head) => {
        const rejection = webCtx.connection.requestRejection(req)
        if (rejection !== undefined) {
          rejectUpgrade(socket, rejection)
          return
        }
        const url = realtimeTarget(req)
        if (!url) {
          rejectUpgrade(socket, 503)
          return
        }
        relayRealtime(req, socket, head, webCtx, realtimeUpstreamUrl(url, realtimeVoice(req)), settings().realtimeApiKey)
      },
    }
    const unregisterUpgrade = webCtx.webServer.registerUpgrade(upgrade)
    ctx.effect(() => (): void => {
      for (const dispose of unregister) dispose()
      unregisterUpgrade()
    }, 'media-gateway routes')
  })
}

export const inject = ['connection', 'webServer']

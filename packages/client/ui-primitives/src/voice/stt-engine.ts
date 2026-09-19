/**
 * Speech recognition: the hearing half of the voice module, expressed as a seam
 * rather than as one engine.
 *
 * The module above this file never learns which recognizer ran. It hands over a
 * finished clip and receives text, so swapping faster-whisper for an external
 * service — or for a recognizer that does not exist yet — is a change here and
 * nowhere else.
 *
 * Both shipped engines are reached through the host, never directly:
 *
 *  - `local` runs the machine's own recognizer (faster-whisper) and needs no
 *    endpoint, no key, and no network. This is the engine the desktop app is
 *    built around, because the browser's own recognizer is unavailable there by
 *    design (a packaged build carries no Google speech key).
 *  - `service` forwards the clip to whatever speech service the user configured
 *    in Voice Settings. It reuses the media gateway's existing transcribe route
 *    and the same multipart shape the dictation button already sends, so a
 *    service that works for dictation works here unchanged.
 *
 * A clip, not a live stream: this seam takes audio in and answers text out. The
 * browser's Web Speech recognizer is deliberately *not* an engine here — it
 * never exposes the audio it heard, so it cannot be swapped for a clip-based
 * engine and would break the seam's contract.
 *
 * A dependency-free leaf (like speech-recognition.ts), so any client package
 * may import it without bundle-purity edges.
 */

import { VOICE_KEY_HEADER, VOICE_URL_HEADER, readVoiceEndpoints } from '../voice-endpoint.ts'
import type { VoiceEndpoint } from '../voice-endpoint.ts'

/** Host route that runs the machine's own recognizer. */
export const LOCAL_STT_ROUTE = '/api/voice/transcribe'

/** Host route that forwards a clip to the configured speech service. */
export const SERVICE_STT_ROUTE = '/api/media/transcribe'

/** Locale every utterance is recognized in, matching the media gateway default. */
export const STT_DEFAULT_LANG = 'ru-RU'

/** Which recognizer an engine drives. */
export type SttEngineKind =
  /** The machine's own recognizer, reached through the host. */
  | 'local'
  /** The speech service the user configured in Voice Settings. */
  | 'service'

/** What the user chose, before the available engines are consulted. */
export type SttEngineId =
  /** Configured service first, the machine's own recognizer otherwise. */
  | 'auto'
  /** The machine's own recognizer, whatever is configured. */
  | 'local'
  /** The configured service; unusable when none is configured. */
  | 'service'

/** Every selectable engine, in the order the settings card lists them. */
export const STT_ENGINE_IDS: readonly SttEngineId[] = ['auto', 'local', 'service']

/**
 * Whether a value is a selectable engine id.
 * @param value - value to test.
 * @returns true when the value names an engine.
 */
export function isSttEngineId(value: unknown): value is SttEngineId {
  return typeof value === 'string' && (STT_ENGINE_IDS as readonly string[]).includes(value)
}

/** One clip to recognize. */
export interface TranscriptionRequest {
  /** The recorded clip: 16 kHz mono 16-bit WAVE. */
  readonly clip: Blob
  /** BCP 47 locale tag the recognizer should expect. */
  readonly lang: string
  /** Cancels the request when the user interrupts. */
  readonly signal?: AbortSignal | undefined
}

/** What one recognition produced. */
export interface TranscriptionResult {
  /** Recognized text, already trimmed. Empty when the clip held no speech. */
  readonly text: string
  /** Which engine produced it. */
  readonly engine: SttEngineKind
  /** How long the recognition itself took, in milliseconds. */
  readonly durationMs: number
}

/** Why a recognition produced no text. */
export type SttFailureReason =
  /** The transport failed: no route, no host, no network. */
  | 'network'
  /** The engine cannot run here: the host has no local recognizer, or no service is configured. */
  | 'unavailable'
  /** The engine ran and refused: an upstream error, a rejected key, a bad request. */
  | 'refused'
  /** The engine answered, but with nothing this module can read as text. */
  | 'no-text'
  /** The user interrupted; not a failure to report as one. */
  | 'aborted'

/**
 * A recognition failure, carrying the reason the interface can act on and the
 * detail a log can keep. The detail is never shown to the user verbatim: the
 * module maps {@link SttFailureReason} to a translated sentence, so a raw HTTP
 * string never reaches the screen.
 */
export class SttError extends Error {
  /** Why the recognition failed. */
  readonly reason: SttFailureReason

  /**
   * @param reason - why the recognition failed.
   * @param detail - the raw cause, for logs.
   */
  constructor(reason: SttFailureReason, detail: string) {
    super(detail)
    this.name = 'SttError'
    this.reason = reason
  }
}

/**
 * Stable machine token for "there is no recognizer to drive".
 *
 * Part of the error's JSON shape, so a log reader can find every occurrence
 * without matching the translated sentence a person sees.
 */
export const NOTHING_TO_RECOGNIZE_CODE = 'nothing_to_recognize'

/** The setting a person has to open to repair this. */
export const NOTHING_TO_RECOGNIZE_SETTING = 'Голос'

/**
 * The JSON shape of {@link NothingToRecognizeError}.
 *
 * Logged verbatim, which is why the fields are stable English tokens and the
 * two human-facing strings are kept apart under `details`: a log is read by
 * machine first and by a person second, and the two readers want different
 * things from it.
 */
export interface NothingToRecognizeShape {
  /** Machine token: always {@link NOTHING_TO_RECOGNIZE_CODE}. */
  readonly error: typeof NOTHING_TO_RECOGNIZE_CODE
  /** Where to fix it, in words the person can act on. */
  readonly details: {
    /** The page to open. */
    readonly setting: string
    /** What to do once there. */
    readonly action: string
  }
}

/**
 * There is no recognizer the chosen engine can drive.
 *
 * A distinct class rather than a bare {@link SttError}, because it is the one
 * recognition failure a *person* can repair: nothing is broken, the machine has
 * no local recognizer installed or no service is configured, and one choice on
 * the Voice page fixes it. Callers that can offer that repair catch it by type:
 *
 * ```ts
 * try {
 *   await engine.transcribe({ clip, lang })
 * } catch (failure) {
 *   if (failure instanceof NothingToRecognizeError) show(failure.details.action)
 * }
 * ```
 *
 * It extends {@link SttError} so existing `instanceof SttError` handling keeps
 * working — the reason is `unavailable`, which is what it has always been.
 */
export class NothingToRecognizeError extends SttError {
  /** What to do about it, in words the interface can show verbatim. */
  readonly details: NothingToRecognizeShape['details']

  /**
   * @param action - what the person should do on the Voice page, phrased for
   * the screen. Defaults to the wording of the Voice section's own notice, so
   * the log and the interface cannot drift apart.
   */
  constructor(action: string = 'выберите распознавание на этом компьютере или укажите сервис') {
    super('unavailable', `nothing to recognize: ${action}`)
    this.name = 'NothingToRecognizeError'
    this.details = { setting: NOTHING_TO_RECOGNIZE_SETTING, action }
  }

  /**
   * The loggable JSON body for this failure.
   * @returns the stable `{ error, details }` document.
   */
  toJSON(): NothingToRecognizeShape {
    return { error: NOTHING_TO_RECOGNIZE_CODE, details: this.details }
  }
}

/** One recognizer. Callers hold this, never a concrete engine. */
export interface SttEngine {
  /** Which recognizer this is. */
  readonly kind: SttEngineKind
  /** Whether this engine can run in this runtime at all. */
  isAvailable(): boolean
  /**
   * Recognize one clip.
   * @param request - the clip, its locale, and the cancellation signal.
   * @returns the recognized text.
   * @throws {SttError} with a reason the interface can act on.
   */
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>
}

/** Replacements a test may inject instead of the real transport and clock. */
export interface SttEngineOptions {
  /** Transport. Defaults to the runtime's `fetch`. */
  readonly fetch?: typeof fetch
  /** Clock. Defaults to `Date.now`. */
  readonly now?: () => number
  /** Where the configured service lives. Defaults to the stored settings. */
  readonly service?: () => VoiceEndpoint
}

/**
 * Read the configured speech service, tolerating a runtime without storage.
 * @returns the endpoint to forward to, or an empty endpoint when unconfigured.
 */
function storedService(): VoiceEndpoint {
  return readVoiceEndpoints().stt
}

/**
 * Turn a transport failure into the reason the interface shows.
 * @param reason - whatever the transport threw.
 * @returns the abort reason when the user interrupted, a network failure otherwise.
 */
function failureOf(reason: unknown): SttError {
  if (reason instanceof SttError) return reason
  if (reason instanceof Error && reason.name === 'AbortError') return new SttError('aborted', reason.message)
  return new SttError('network', reason instanceof Error ? reason.message : String(reason))
}

/**
 * Read the text out of one engine response.
 *
 * Every OpenAI-compatible recognizer answers `{ text }`; a few wrap it in
 * `{ data: { text } }`. Both are accepted, because rejecting a working service
 * over its envelope would be a bug in this file rather than in the service.
 * @param response - the engine's response.
 * @returns the recognized text.
 * @throws {SttError} when the response is a refusal or carries no text.
 */
async function textOf(response: Response): Promise<string> {
  if (response.status === 503) {
    throw new SttError('unavailable', await detailOf(response))
  }
  if (!response.ok) {
    throw new SttError('refused', await detailOf(response))
  }
  let payload: unknown
  try {
    payload = await response.json() as unknown
  } catch (reason) {
    throw new SttError('no-text', reason instanceof Error ? reason.message : String(reason))
  }
  if (typeof payload === 'string') return payload.trim()
  if (typeof payload === 'object' && payload !== null) {
    const record = payload as Record<string, unknown>
    const direct = record.text
    if (typeof direct === 'string') return direct.trim()
    const nested = record.data
    if (typeof nested === 'object' && nested !== null) {
      const inner = (nested as Record<string, unknown>).text
      if (typeof inner === 'string') return inner.trim()
    }
  }
  throw new SttError('no-text', 'the recognizer answered without a text field')
}

/**
 * Read the refusal message out of a failed response, for the log.
 * @param response - the failed response.
 * @returns the upstream message, or a plain status line when it says nothing.
 */
async function detailOf(response: Response): Promise<string> {
  let body = ''
  try {
    body = await response.text()
  } catch {
    // An unreadable body is not worth a second failure.
  }
  if (body === '') return `HTTP ${response.status}`
  try {
    const parsed = JSON.parse(body) as unknown
    if (typeof parsed === 'object' && parsed !== null) {
      const error = (parsed as Record<string, unknown>).error
      if (typeof error === 'string' && error !== '') return error
      // A well-formed envelope with an empty message says no more than the
      // status does, and the status is the shorter thing to read.
      return `HTTP ${response.status}`
    }
  } catch {
    // Not JSON: the raw body is the best description available.
  }
  return body.slice(0, 200)
}

/**
 * Build the machine's own recognizer, reached through the host.
 *
 * Availability is a capability statement, not a health check: this engine
 * answers true wherever a transport exists, because the host is the one that
 * knows whether the local recognizer is installed, and it says so in its own
 * words on the first attempt. Pretending to know earlier would either disable
 * the engine the desktop app depends on, or invent a promise it cannot keep.
 * @param options - transport, clock, and service overrides for tests.
 * @returns the local engine.
 */
export function createLocalSttEngine(options: SttEngineOptions = {}): SttEngine {
  const send = options.fetch ?? ((...args: Parameters<typeof fetch>): Promise<Response> => fetch(...args))
  const now = options.now ?? ((): number => Date.now())
  return {
    kind: 'local',
    isAvailable: (): boolean => typeof send === 'function',
    async transcribe(request): Promise<TranscriptionResult> {
      const started = now()
      let response: Response
      try {
        response = await send(`${LOCAL_STT_ROUTE}?lang=${encodeURIComponent(request.lang)}`, {
          method: 'POST',
          headers: { 'content-type': 'audio/wav' },
          body: request.clip,
          ...request.signal === undefined ? {} : { signal: request.signal },
        })
      } catch (reason) {
        throw failureOf(reason)
      }
      const text = await textOf(response)
      return { text, engine: 'local', durationMs: now() - started }
    },
  }
}

/**
 * Build the configured-service recognizer.
 *
 * The clip travels as multipart with the same field name the dictation button
 * already uses, and the endpoint and key ride the gateway's override headers, so
 * a key typed into Voice Settings never becomes part of the request body.
 * @param options - transport, clock, and service overrides for tests.
 * @returns the service engine.
 */
export function createServiceSttEngine(options: SttEngineOptions = {}): SttEngine {
  const send = options.fetch ?? ((...args: Parameters<typeof fetch>): Promise<Response> => fetch(...args))
  const now = options.now ?? ((): number => Date.now())
  const service = options.service ?? storedService
  return {
    kind: 'service',
    isAvailable: (): boolean => service().url !== '',
    async transcribe(request): Promise<TranscriptionResult> {
      const endpoint = service()
      if (endpoint.url === '') {
        throw new SttError('unavailable', 'no speech service is configured')
      }
      const body = new FormData()
      body.append('audio', request.clip, 'voice.wav')
      const started = now()
      let response: Response
      try {
        response = await send(SERVICE_STT_ROUTE, {
          method: 'POST',
          headers: {
            [VOICE_URL_HEADER]: endpoint.url,
            ...endpoint.key === '' ? {} : { [VOICE_KEY_HEADER]: endpoint.key },
          },
          body,
          ...request.signal === undefined ? {} : { signal: request.signal },
        })
      } catch (reason) {
        throw failureOf(reason)
      }
      const text = await textOf(response)
      return { text, engine: 'service', durationMs: now() - started }
    },
  }
}

/**
 * Decide which engine one recognition drives.
 *
 * `auto` prefers a configured service, because configuring one is an explicit
 * instruction; the machine's own recognizer is what makes the desktop app work
 * with nothing configured at all. A named engine that cannot run answers
 * undefined, so the caller reports it instead of silently recognizing with
 * something else.
 * @param id - the engine the user chose.
 * @param serviceConfigured - whether an STT endpoint is stored.
 * @returns the engine to drive, or undefined when the chosen one cannot run.
 */
export function resolveSttEngineKind(id: SttEngineId, serviceConfigured: boolean): SttEngineKind | undefined {
  if (id === 'local') return 'local'
  if (id === 'service') return serviceConfigured ? 'service' : undefined
  return serviceConfigured ? 'service' : 'local'
}

/**
 * Build the engine the user chose, consulting what is configured.
 * @param id - the engine the user chose.
 * @param options - transport, clock, and service overrides for tests.
 * @returns the engine to drive, or undefined when the chosen one cannot run.
 */
export function createSttEngine(id: SttEngineId, options: SttEngineOptions = {}): SttEngine | undefined {
  const service = options.service ?? storedService
  const kind = resolveSttEngineKind(id, service().url !== '')
  if (kind === undefined) return undefined
  return kind === 'local' ? createLocalSttEngine(options) : createServiceSttEngine(options)
}

/**
 * Build the chosen engine, refusing loudly when there is nothing to drive.
 *
 * The difference from {@link createSttEngine} is who decides what "nothing to
 * drive" means. That one answers `undefined` and leaves the reporting to its
 * caller, which is right for a preflight check that only needs a yes or no.
 * This one is for the path that has already committed to recognizing a clip:
 * there, a missing recognizer is a failure with a known repair, and the person
 * who just spoke needs to be told which setting to open.
 *
 * The thrown {@link NothingToRecognizeError} carries its own loggable JSON, so
 * the same object serves the screen and the log.
 * @param id - the engine the user chose.
 * @param options - transport, clock, and service overrides for tests.
 * @returns the engine to drive.
 * @throws {NothingToRecognizeError} when the chosen engine cannot run here.
 */
export function requireSttEngine(id: SttEngineId, options: SttEngineOptions = {}): SttEngine {
  const engine = createSttEngine(id, options)
  if (engine === undefined) throw new NothingToRecognizeError()
  return engine
}

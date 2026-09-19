/**
 * Speech recognition: browser-local dictation through the recognition half of
 * the Web Speech API (SpeechRecognition / webkitSpeechRecognition). The engine
 * ships with the browser, so dictation needs no endpoint and no API key; only a
 * missing constructor makes it unavailable, and then every entry point answers
 * undefined instead of driving a dead handle, leaving the caller to render its
 * own unsupported notice. A dependency-free leaf (like speech-synthesis.ts), so
 * any client package may import it without bundle-purity edges.
 */

/** Default recognizer locale, matching the speech-synthesis default. */
const DEFAULT_LANG = 'ru-RU'

/** One recognized chunk handed to the caller. */
export interface RecognitionResult {
  /** Whether the engine committed the chunk; interim chunks are previews. */
  readonly isFinal: boolean
  /** Recognized text of the chunk's best alternative. */
  readonly text: string
}

/** Callbacks driving one recognition run. */
export interface RecognitionOptions {
  /** BCP 47 locale tag for the recognizer. */
  lang?: string
  /** Keep listening across utterances instead of stopping at the first. */
  continuous?: boolean
  /** Report interim (uncommitted) chunks as they arrive. */
  interimResults?: boolean
  /** @param result - one recognized chunk, interim or final. */
  onResult?(result: RecognitionResult): void
  /** @param code - engine error code (e.g. 'not-allowed', 'no-speech'). */
  onError?(code: string): void
  /** The engine stopped listening: after stop(), on silence, or on failure. */
  onEnd?(): void
}

/** One live recognition run. */
export interface RecognitionHandle {
  /** Begin listening; a synchronous engine failure propagates to the caller. */
  start(): void
  /** Stop listening, letting the engine flush its pending final chunk. */
  stop(): void
  /** Stop listening and discard any pending chunk. */
  abort(): void
}

/** One alternative of one result slot. */
interface RecognitionAlternative {
  readonly transcript: string
}

/** One result slot: a final or interim chunk plus its alternatives. */
interface RecognitionChunk {
  readonly isFinal: boolean
  readonly [index: number]: RecognitionAlternative | undefined
}

/** The result list the engine hands to onresult. */
interface RecognitionResultList {
  readonly length: number
  readonly [index: number]: RecognitionChunk | undefined
}

/** The subset of the result event this module reads. */
interface RecognitionEvent {
  readonly resultIndex: number
  readonly results: RecognitionResultList
}

/**
 * Structural face of the engine. lib.dom types the unprefixed name as always
 * present while Chromium keeps the API behind the webkit prefix, so the module
 * probes the global scope instead of trusting either declaration.
 */
interface RecognitionEngine {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  onresult: ((event: RecognitionEvent) => void) | null
  onerror: ((event: { readonly error?: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}

/** Constructor face of the engine. */
type RecognitionConstructor = new () => RecognitionEngine

/**
 * Probe the recognition constructor the runtime actually exposes.
 * @returns the constructor, or undefined outside a capable context.
 */
function recognitionConstructor(): RecognitionConstructor | undefined {
  const scope = globalThis as unknown as {
    SpeechRecognition?: RecognitionConstructor
    webkitSpeechRecognition?: RecognitionConstructor
  }
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition
}

/**
 * Whether the browser can recognize speech without leaving the machine.
 * @returns false outside browsers with the recognition half of the Web Speech API.
 */
export function isSpeechRecognitionAvailable(): boolean {
  return recognitionConstructor() !== undefined
}

/**
 * Start one recognition run. An unavailable engine answers undefined so the
 * caller renders its unsupported notice instead of holding a dead handle.
 * @param options - locale, continuity, and the run's callbacks.
 * @returns the live run, or undefined when the engine is missing.
 */
export function createRecognition(options: RecognitionOptions = {}): RecognitionHandle | undefined {
  const Constructor = recognitionConstructor()
  if (Constructor === undefined) return undefined
  const engine = new Constructor()
  engine.lang = options.lang ?? DEFAULT_LANG
  engine.continuous = options.continuous ?? false
  engine.interimResults = options.interimResults ?? false
  engine.maxAlternatives = 1
  engine.onresult = (event) => {
    const results = event.results
    for (let index = event.resultIndex; index < results.length; index += 1) {
      const chunk = results[index]
      if (chunk === undefined) continue
      const text = chunk[0]?.transcript ?? ''
      if (text === '') continue
      options.onResult?.({ isFinal: chunk.isFinal, text })
    }
  }
  engine.onerror = (event) => { options.onError?.(event.error ?? 'unknown') }
  engine.onend = () => { options.onEnd?.() }
  return {
    start: () => { engine.start() },
    stop: () => { engine.stop() },
    abort: () => { engine.abort() },
  }
}

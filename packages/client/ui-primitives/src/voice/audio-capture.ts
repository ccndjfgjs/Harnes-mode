/**
 * Microphone capture: the bottom layer of the voice module, and the only place
 * that knows what a sample, a stream, or a decoder is.
 *
 * Everything above it deals in "a clip is ready" and "that failed, because …".
 * That boundary is the point of the file: the module's states, its settings, and
 * its UI stay the same whether the audio comes from `getUserMedia`, from a test
 * double, or from some future capture path.
 *
 * Recording goes through the browser's own encoder (`MediaRecorder`) and is then
 * decoded back to samples, because the two consumers want different things: the
 * recognizer wants 16 kHz mono PCM, and producing raw samples by hand would mean
 * an AudioWorklet and a second copy of the sample maths.
 *
 * Capture never starts on its own — a microphone needs a human gesture, and this
 * layer will not pretend otherwise.
 */

import { downmixToMono, durationMsOf, encodeWav16, resampleTo16k, WHISPER_SAMPLE_RATE } from './audio-format.ts'

/** Explicit lifecycle of one capture. */
export type CaptureState =
  /** Nothing recorded, nothing held. */
  | 'idle'
  /** The microphone is open and the recorder is collecting. */
  | 'recording'
  /** Recording stopped; samples are being turned into a clip. */
  | 'encoding'
  /** The last attempt failed; the reason is in the snapshot. */
  | 'failed'

/** One finished recording, ready to be recognized. */
export interface CapturedClip {
  /** 16 kHz mono 16-bit WAVE, the shape a recognizer accepts. */
  readonly blob: Blob
  /** How long the recording lasted. */
  readonly durationMs: number
  /** Rate of the encoded clip; always {@link WHISPER_SAMPLE_RATE}. */
  readonly sampleRate: number
  /** Size of the encoded clip, in bytes. */
  readonly bytes: number
}

/** What a consumer may need to know, in one immutable value. */
export interface AudioCaptureSnapshot {
  /** Current lifecycle state. */
  readonly state: CaptureState
  /** When the current recording started, or undefined while idle. */
  readonly startedAt: number | undefined
  /** Reason for the last failure, or '' when there was none. */
  readonly lastError: string
  /**
   * The failure's stable DOMException name ('NotAllowedError',
   * 'NotFoundError', 'NotReadableError'), or '' when there was none.
   *
   * Exposed so a consumer can tell a refused permission from a missing device
   * without reading the engine's prose, which is localized and reworded
   * between releases.
   */
  readonly lastErrorName: string
}

/** The narrow slice of `MediaRecorder` this layer uses. */
export interface RecorderLike {
  /** Mime type the recorder actually chose. */
  readonly mimeType: string
  /** Begin collecting. */
  start(): void
  /** Stop collecting; `onstop` follows. */
  stop(): void
  /** Fired with each encoded chunk. */
  ondataavailable: ((event: { readonly data: Blob }) => void) | null
  /** Fired once collection has ended. */
  onstop: (() => void) | null
  /** Fired when collection fails. */
  onerror: ((event: unknown) => void) | null
}

/** One decoded recording, as the decoder hands it over. */
export interface DecodedAudio {
  /** Rate the recording was decoded at, in Hz. */
  readonly sampleRate: number
  /** How many channels the recording carries. */
  readonly numberOfChannels: number
  /**
   * Read one channel's samples.
   * @param channel - zero-based channel index.
   * @returns that channel's samples.
   */
  getChannelData(channel: number): Float32Array
}

/** The narrow slice of `AudioContext` this layer uses. */
export interface DecoderLike {
  /**
   * Decode one encoded recording.
   * @param data - the recorded bytes.
   * @returns the decoded channels.
   */
  decodeAudioData(data: ArrayBuffer): Promise<DecodedAudio>
  /** Release the decoder's resources, when it has any. */
  close?(): Promise<void>
}

/** What a caller may replace instead of the browser defaults. */
export interface AudioCaptureOptions {
  /** Ask for a microphone stream. Defaults to `getUserMedia({ audio: true })`. */
  readonly requestStream?: () => Promise<MediaStream>
  /** Build a recorder for that stream. Defaults to `MediaRecorder`. */
  readonly createRecorder?: (stream: MediaStream, mimeType: string) => RecorderLike
  /** Pick the container to record in. Defaults to Opus-in-WebM when supported. */
  readonly pickMimeType?: () => string
  /** Build a decoder for the recorded bytes. Defaults to an `AudioContext`. */
  readonly createDecoder?: () => DecoderLike
  /**
   * How long to wait for a recorder to admit it stopped. Defaults to
   * {@link STOP_TIMEOUT_MS}. A wedged device that never reports its stop would
   * otherwise leave the caller waiting for a clip that will never arrive.
   */
  readonly stopTimeoutMs?: number
  /** Schedules the stop watchdog. Defaults to `setTimeout`. */
  readonly schedule?: (run: () => void, ms: number) => ReturnType<typeof setTimeout>
  /** Cancels the stop watchdog. Defaults to `clearTimeout`. */
  readonly unschedule?: (handle: ReturnType<typeof setTimeout>) => void
  /** Clock. Defaults to `Date.now`. */
  readonly now?: () => number
}

/** One capture. A caller creates it, drives it, and disposes it. */
export interface AudioCapture {
  /** Current lifecycle state. */
  state(): CaptureState
  /** The whole picture of what this capture holds and has done. */
  snapshot(): AudioCaptureSnapshot
  /** Open the microphone and start collecting. */
  start(): Promise<void>
  /**
   * Stop collecting and hand back the clip.
   * @returns the recorded clip, or undefined when nothing usable was recorded.
   */
  stop(): Promise<CapturedClip | undefined>
  /** Abandon the recording and release the microphone without producing a clip. */
  cancel(): void
  /** Release everything and stop notifying. */
  dispose(): void
  /**
   * Watch for state changes.
   * @param listener - called with the new snapshot.
   * @returns a function that stops the watching.
   */
  subscribe(listener: (snapshot: AudioCaptureSnapshot) => void): () => void
}

/** Opus in WebM is what every Chromium-based browser records and decodes back. */
const PREFERRED_MIME = 'audio/webm;codecs=opus'

/** How long a recorder may take to report that it stopped. */
export const STOP_TIMEOUT_MS = 5000

/**
 * Whether this runtime can record a microphone at all.
 *
 * Answered by probing, not by trusting the types: an insecure context and an
 * older WebView both omit parts of the capture surface while `lib.dom` claims
 * they exist.
 * @returns true when a stream and a recorder are both reachable.
 */
export function isAudioCaptureAvailable(): boolean {
  const devices = (globalThis as { navigator?: { mediaDevices?: { getUserMedia?: unknown } } }).navigator?.mediaDevices
  return typeof devices?.getUserMedia === 'function' && typeof MediaRecorder !== 'undefined'
}

/**
 * Default microphone request: one audio track, from the chosen endpoint when
 * one is named.
 *
 * `exact` is deliberate. A soft hint lets the browser silently fall back to
 * the default microphone when the chosen one is unplugged, which would record
 * the wrong device while the settings page still shows the chosen one —
 * a failure nobody can see. With `exact` the request fails loudly instead, and
 * the module reports `capture-failed` with the platform's own reason.
 * @param deviceId - the endpoint to record from, or '' for the system default.
 * @returns the granted stream.
 */
export function defaultRequestStream(deviceId: string = ''): Promise<MediaStream> {
  const devices = (globalThis as {
    navigator?: { mediaDevices?: { getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> } }
  }).navigator?.mediaDevices
  if (devices === undefined) return Promise.reject(new Error('audio capture: no mediaDevices in this runtime'))
  const audio: MediaTrackConstraints | true = deviceId === '' ? true : { deviceId: { exact: deviceId } }
  return devices.getUserMedia({ audio })
}

/**
 * Default recorder factory over the platform `MediaRecorder`.
 * @param stream - the granted microphone stream.
 * @param mimeType - container to record in, or '' to let the browser choose.
 * @returns the recorder handle.
 */
function defaultCreateRecorder(stream: MediaStream, mimeType: string): RecorderLike {
  return new MediaRecorder(stream, mimeType === '' ? undefined : { mimeType }) as unknown as RecorderLike
}

/**
 * Default container choice: Opus-in-WebM when the browser admits to it.
 * @returns the mime type to request, or '' for the browser default.
 */
function defaultPickMimeType(): string {
  return MediaRecorder.isTypeSupported(PREFERRED_MIME) ? PREFERRED_MIME : ''
}

/**
 * Default decoder factory over an `AudioContext`.
 * @returns the decoder handle.
 */
function defaultCreateDecoder(): DecoderLike {
  const Ctor = (globalThis as { AudioContext?: new () => unknown }).AudioContext
  if (Ctor === undefined) throw new Error('audio capture: no AudioContext in this runtime')
  return new Ctor() as DecoderLike
}

/**
 * Create one microphone capture.
 * @param options - replacements for the browser defaults, used by tests.
 * @returns the capture handle.
 */
export function createAudioCapture(options: AudioCaptureOptions = {}): AudioCapture {
  const requestStream = options.requestStream ?? defaultRequestStream
  const createRecorder = options.createRecorder ?? defaultCreateRecorder
  const pickMimeType = options.pickMimeType ?? defaultPickMimeType
  const createDecoder = options.createDecoder ?? defaultCreateDecoder
  const stopTimeoutMs = options.stopTimeoutMs ?? STOP_TIMEOUT_MS
  const schedule = options.schedule ?? ((run, ms): ReturnType<typeof setTimeout> => setTimeout(run, ms))
  const unschedule = options.unschedule ?? ((handle): void => { clearTimeout(handle) })
  const now = options.now ?? ((): number => Date.now())

  const listeners = new Set<(snapshot: AudioCaptureSnapshot) => void>()
  let state: CaptureState = 'idle'
  let startedAt: number | undefined
  let lastError = ''
  let lastErrorName = ''
  let stream: MediaStream | undefined
  let recorder: RecorderLike | undefined
  let chunks: Blob[] = []
  /** Resolves when the live recorder reports that it has stopped. */
  let stopped: Promise<void> = Promise.resolve()
  let settleStopped: (() => void) | undefined
  /** The stop watchdog of the recording in flight, if any. */
  let watchdog: ReturnType<typeof setTimeout> | undefined

  const snapshot = (): AudioCaptureSnapshot => ({ state, startedAt, lastError, lastErrorName })

  /** Publish the current snapshot to every listener. */
  function notify(): void {
    const current = snapshot()
    for (const listener of listeners) listener(current)
  }

  /**
   * Move to a state and tell the listeners.
   * @param next - the state to enter.
   */
  function enter(next: CaptureState): void {
    state = next
    notify()
  }

  /** Release the microphone and forget the recorder. */
  function release(): void {
    if (watchdog !== undefined) {
      unschedule(watchdog)
      watchdog = undefined
    }
    stream?.getTracks().forEach((track) => { track.stop() })
    stream = undefined
    recorder = undefined
    settleStopped = undefined
  }

  /**
   * Report that the recording ended, exactly once, so a waiting stop() resumes.
   *
   * Called on a normal stop and on a recorder error alike: an error that left
   * the waiter hanging would turn a failed recording into a frozen one.
   */
  function reportStopped(): void {
    const settle = settleStopped
    settleStopped = undefined
    settle?.()
  }

  /**
   * Stop on a failure: record the reason, release the device, and say so.
   * @param reason - whatever went wrong.
   */
  function fail(reason: unknown): void {
    // The DOMException NAME is kept alongside the message: the message is the
    // engine's own prose ("Permission denied", or the caller's own wording),
    // while the name ("NotAllowedError") is the stable token the caller
    // branches on — see `lastErrorName`.
    //
    // Read structurally rather than with `instanceof Error`: a DOMException is
    // NOT an Error in every engine (jsdom is one), and `reason.name` is exactly
    // what the platform puts there. The old `instanceof Error` test threw away
    // both the name and the message for a refused microphone, which is what
    // made a refusal indistinguishable from a missing device.
    const named = reason as { name?: unknown; message?: unknown } | null
    lastErrorName = typeof named?.name === 'string' ? named.name : ''
    lastError = typeof named?.message === 'string' ? named.message : String(reason)
    release()
    chunks = []
    startedAt = undefined
    enter('failed')
  }

  /**
   * Decode the recorded chunks into a recognizer-shaped clip.
   * @param recorded - the encoded chunks, in order.
   * @param mimeType - container the recorder used.
   * @returns the 16 kHz mono WAVE clip, or undefined when the recording held
   * no samples at all — a header with no audio behind it is not a clip.
   */
  async function clipOf(recorded: readonly Blob[], mimeType: string): Promise<CapturedClip | undefined> {
    const encoded = new Blob([...recorded], { type: mimeType === '' ? 'audio/webm' : mimeType })
    const decoder = createDecoder()
    try {
      const decoded = await decoder.decodeAudioData(await encoded.arrayBuffer())
      const channels: Float32Array[] = []
      for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
        channels.push(decoded.getChannelData(channel))
      }
      const samples = resampleTo16k(downmixToMono(channels), decoded.sampleRate)
      if (samples.length === 0) return undefined
      const blob = encodeWav16(samples, WHISPER_SAMPLE_RATE)
      return {
        blob,
        durationMs: durationMsOf(samples.length, WHISPER_SAMPLE_RATE),
        sampleRate: WHISPER_SAMPLE_RATE,
        bytes: blob.size,
      }
    } finally {
      await decoder.close?.()
    }
  }

  return {
    state: (): CaptureState => state,
    snapshot,
    subscribe(listener): () => void {
      listeners.add(listener)
      return (): void => { listeners.delete(listener) }
    },
    async start(): Promise<void> {
      if (state === 'recording' || state === 'encoding') return
      lastError = ''
      lastErrorName = ''
      try {
        const requested = await requestStream()
        stream = requested
        const built = createRecorder(requested, pickMimeType())
        recorder = built
        chunks = []
        stopped = new Promise<void>((resolve) => { settleStopped = resolve })
        built.ondataavailable = (event): void => {
          if (event.data.size > 0) chunks.push(event.data)
        }
        built.onstop = (): void => { reportStopped() }
        built.onerror = (event): void => {
          // Reported before the failure so a stop() already waiting resumes
          // and reads the failure rather than hanging on a stop that never came.
          reportStopped()
          fail(event)
        }
        built.start()
        startedAt = now()
        enter('recording')
      } catch (reason) {
        fail(reason)
      }
    },
    async stop(): Promise<CapturedClip | undefined> {
      const active = recorder
      if (state !== 'recording' || active === undefined) return undefined
      const mimeType = active.mimeType
      const ended = stopped
      enter('encoding')
      watchdog = schedule(() => {
        // A device that never admits it stopped is a failure, not a wait.
        reportStopped()
        fail(new Error('the recorder did not report that it stopped'))
      }, stopTimeoutMs)
      try {
        active.stop()
        await ended
        // Read through the snapshot rather than the local variable: a recorder
        // error moves the state from a callback, which the narrowing here
        // cannot see.
        if (snapshot().state === 'failed') return undefined
        const recorded = chunks
        release()
        chunks = []
        startedAt = undefined
        const clip = await clipOf(recorded, mimeType)
        enter('idle')
        return clip
      } catch (reason) {
        fail(reason)
        return undefined
      }
    },
    cancel(): void {
      if (state !== 'recording' && state !== 'encoding') return
      release()
      chunks = []
      startedAt = undefined
      lastError = ''
      lastErrorName = ''
      enter('idle')
    },
    dispose(): void {
      release()
      chunks = []
      startedAt = undefined
      listeners.clear()
      state = 'idle'
    },
  }
}

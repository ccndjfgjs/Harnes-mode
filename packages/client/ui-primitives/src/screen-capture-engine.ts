/**
 * Screen capture: the app-wide subsystem that owns a display broadcast.
 *
 * It is deliberately not part of any component. The chat toolbar is one
 * *consumer* of it, never its owner, so switching chats, closing the panel, or
 * navigating away does not touch the capture: only an explicit command or a
 * system event changes its state. Nothing here imports from a conversation
 * package, and nothing here knows what a draft, a session, or an attachment is.
 *
 * Frames land in a **bounded ring buffer**, not in whatever surface happened to
 * be open. A consumer pulls them when it is ready; with no consumer at all the
 * broadcast keeps running and the buffer keeps the most recent frames. Loss is
 * never silent — every frame dropped by the limits is counted, because a quiet
 * loss looks exactly like "the model cannot see my screen" with no cause.
 *
 * What this file does *not* promise: a broadcast never starts or resumes on its
 * own. The browser requires a human gesture to hand over the screen, so the
 * honest guarantee is "a broadcast that was started keeps running in the
 * background while the app is open".
 *
 * A dependency-free leaf (like speech-synthesis.ts), so any client package may
 * consume the capture without bundle-purity edges.
 */

import { readScreenSettings, type ScreenSettings } from './screen-settings.ts'
import { createWorkerTimer, type FrameTimer } from './screen-timer.ts'

export type { FrameTimer } from './screen-timer.ts'

/** Explicit lifecycle of the capture subsystem. */
export type CaptureState =
  /** Nothing captured, nothing held. */
  | 'idle'
  /** The system picker is open; the outcome is not known yet. */
  | 'starting'
  /** Frames are being sampled on the configured cadence. */
  | 'live'
  /** Frames are wanted but not being taken; the stream is kept. */
  | 'paused'
  /** The stream is being released. */
  | 'stopping'
  /** The last attempt failed; the reason is in the snapshot. */
  | 'failed'

/** One captured frame, already encoded. */
export interface CapturedFrame {
  /** Encoded picture. */
  readonly blob: Blob
  /** Size of the encoded picture, in bytes. */
  readonly bytes: number
  /** Encoded width, in pixels. */
  readonly width: number
  /** Encoded height, in pixels. */
  readonly height: number
  /** When the frame was taken (ms since the epoch). */
  readonly at: number
}

/** Everything a consumer may need to know, in one immutable value. */
export interface ScreenCaptureSnapshot {
  /** Current lifecycle state. */
  readonly state: CaptureState
  /** Frames the buffer holds right now. */
  readonly frames: number
  /** Bytes the buffered frames take. */
  readonly bytes: number
  /** Text read off frames so far, kept within its own limit. */
  readonly text: string
  /** Frames taken since the broadcast started. */
  readonly captured: number
  /** Frames lost to the buffer limits since the broadcast started. */
  readonly evicted: number
  /** Frames declined by the "send on change" gate since the broadcast started. */
  readonly skipped: number
  /** Reason for the last failure, or '' when there was none. */
  readonly lastError: string
  /** When the current broadcast started, or undefined while idle. */
  readonly startedAt: number | undefined
  /** Latest preview picture as a data URL, or undefined when previews are off. */
  readonly preview: string | undefined
}

/** What the engine may be told to use instead of the browser defaults. */
export interface ScreenCaptureOptions {
  /**
   * Ask the system for a display stream. Defaults to `getDisplayMedia` with the
   * constraints the Screen Broadcast settings describe.
   */
  readonly requestStream?: (settings: ScreenSettings) => Promise<MediaStream>
  /**
   * Frame scheduler. Defaults to the off-thread timer, which falls back to a
   * main-thread interval where no worker is available.
   */
  readonly timer?: FrameTimer
  /** Clock. Defaults to `Date.now`. */
  readonly now?: () => number
}

/** The capture subsystem. */
export interface ScreenCaptureEngine {
  /** Current lifecycle state. */
  state(): CaptureState
  /**
   * The display stream the capture holds, or undefined while idle. Exposed
   * read-only so a consumer that needs the live picture itself — a realtime
   * call carrying the screen — can reach it without owning the capture.
   */
  stream(): MediaStream | undefined
  /** The whole picture of what the capture holds and has done. */
  snapshot(): ScreenCaptureSnapshot
  /**
   * Ask the system for a display stream and begin sampling. Requires a human
   * gesture; a rejected request lands in `failed` with the reason recorded.
   */
  start(): Promise<void>
  /** Stop sampling but keep the stream, so resuming needs no new permission. */
  pause(): void
  /** Resume sampling on a paused broadcast. */
  resume(): void
  /** Release the stream and stop sampling. */
  stop(): Promise<void>
  /** Release everything and stop notifying. The one way to end it all. */
  dispose(): void
  /** Take every buffered frame, oldest first. The buffer is left empty. */
  drain(): readonly CapturedFrame[]
  /** Append read-off text, keeping the tail within the text limit. */
  addText(text: string): void
  /** Forget the accumulated text without touching the frames. */
  clearText(): void
  /**
   * Watch the capture. Consumers are a list, not a single handler.
   * @param listener - called with the snapshot on every change.
   * @returns the disposer that removes this listener.
   */
  subscribe(listener: (snapshot: ScreenCaptureSnapshot) => void): () => void
}

/**
 * Build the display-capture request from the stored scope.
 *
 * `ask` leaves every choice to the picker, which is the browser default.
 * `screen` and `window` express a preference the browser may still confirm:
 * the spec lets a picker ignore `displaySurface` for privacy, so this is a hint
 * that removes clicks where the platform honours it, never a guarantee.
 * @param settings - the stored broadcast preferences.
 * @returns the constraints passed to `getDisplayMedia`.
 */
export function displayConstraints(settings: ScreenSettings): DisplayMediaStreamOptions {
  const video: MediaTrackConstraints | boolean = settings.captureScope === 'ask'
    ? true
    : { displaySurface: settings.captureScope }
  return { video, audio: settings.captureAudio }
}

/**
 * Ask the desktop shell to keep the display awake while frames are wanted, and
 * to let it go when they are not. A broadcast that stalls on a sleeping display
 * keeps sending the same black frame, so this is the difference between "the
 * model sees the screen" and "the model sees nothing, quietly".
 *
 * In a plain browser there is no such control and the call is a no-op.
 * @param active - whether frames are currently being taken.
 */
function keepDisplayAwake(active: boolean): void {
  const shell = (globalThis as {
    harnessAPI?: { setScreenBroadcast?: (active: boolean) => void }
  }).harnessAPI
  try {
    shell?.setScreenBroadcast?.(active)
  } catch {
    // A shell that refuses the request must not break the broadcast.
  }
}

/**
 * Create a capture subsystem.
 * @param options - replacements for the browser defaults, used by specs.
 * @returns the engine.
 */
export function createScreenCaptureEngine(options: ScreenCaptureOptions = {}): ScreenCaptureEngine {
  const now = options.now ?? ((): number => Date.now())
  const timer = options.timer ?? createWorkerTimer()

  let state: CaptureState = 'idle'
  let stream: MediaStream | undefined
  let video: HTMLVideoElement | undefined
  let baseline: Uint8ClampedArray | undefined
  let startedAt: number | undefined
  let captured = 0
  let evicted = 0
  let skipped = 0
  let lastError = ''
  let preview: string | undefined

  const frames: CapturedFrame[] = []
  let bytes = 0
  let text = ''
  const listeners = new Set<(snapshot: ScreenCaptureSnapshot) => void>()

  /** The whole picture, built fresh so a consumer cannot mutate the engine. */
  const snapshot = (): ScreenCaptureSnapshot => ({
    state,
    frames: frames.length,
    bytes,
    text,
    captured,
    evicted,
    skipped,
    lastError,
    startedAt,
    preview,
  })

  /** Tell every consumer, and never let one of them break the capture. */
  const notify = (): void => {
    const current = snapshot()
    for (const listener of [...listeners]) {
      try {
        listener(current)
      } catch {
        // A consumer's failure is the consumer's problem: the capture keeps going.
      }
    }
  }

  /** Move to a new state and announce it. */
  const enter = (next: CaptureState): void => {
    state = next
    // The display is held awake exactly while frames are being taken: every
    // state change is the one place that has to keep this true.
    keepDisplayAwake(next === 'live')
    notify()
  }

  /** Record a failure and announce it. */
  const fail = (error: unknown): void => {
    lastError = error instanceof Error ? error.message : String(error)
    enter('failed')
  }

  /**
   * Put one frame in the buffer, dropping the oldest until both limits hold.
   * A frame larger than the whole byte budget is kept rather than discarded:
   * one frame the consumer can use beats an empty buffer.
   * @param frame - the encoded frame.
   */
  const push = (frame: CapturedFrame): void => {
    const limits = readScreenSettings()
    frames.push(frame)
    bytes += frame.bytes
    while (frames.length > limits.bufferFrames || (bytes > limits.bufferBytes && frames.length > 1)) {
      const gone = frames.shift()
      if (gone === undefined) break
      bytes -= gone.bytes
      evicted += 1
    }
  }

  /**
   * Decide whether a scheduled frame is worth taking.
   *
   * A cheap greyscale thumbnail is compared pixel by pixel against the previous
   * accepted frame; the share of moved pixels is the yardstick. The baseline
   * only advances when a frame is actually accepted, so a slow drift
   * accumulates until it crosses the threshold instead of vanishing.
   * @param source - the capture element holding the frame about to be taken.
   * @param threshold - share of changed pixels that counts as a real change.
   * @returns true when the frame differs enough to take.
   */
  const changedEnough = (source: HTMLVideoElement, threshold: number): boolean => {
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 36
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (context === null) return true
    context.drawImage(source, 0, 0, canvas.width, canvas.height)
    const sample = context.getImageData(0, 0, canvas.width, canvas.height).data
    const pixels = new Uint8ClampedArray(canvas.width * canvas.height * 4)
    for (let index = 0; index < pixels.length; index += 4) {
      // Luma-weighted grey keeps the comparison cheap and colour-blind.
      const red = sample[index] ?? 0
      const green = sample[index + 1] ?? 0
      const blue = sample[index + 2] ?? 0
      const grey = (red * 299 + green * 587 + blue * 114) / 1000
      pixels[index] = grey
      pixels[index + 1] = grey
      pixels[index + 2] = grey
      pixels[index + 3] = 255
    }
    const previous = baseline
    baseline = pixels
    if (previous === undefined) return true
    let moved = 0
    for (let index = 0; index < pixels.length; index += 4) {
      if (Math.abs((pixels[index] ?? 0) - (previous[index] ?? 0)) > 12) moved += 1
    }
    return moved / (pixels.length / 4) >= threshold
  }

  /**
   * Encode one frame from a playing capture.
   * @param source - the capture element holding the live frame.
   * @param settings - resolution and compression to encode with.
   * @returns the encoded frame.
   * @throws {Error} when the browser cannot encode the frame.
   */
  const encodeFrame = async (source: HTMLVideoElement, settings: ScreenSettings): Promise<CapturedFrame> => {
    const sourceWidth = source.videoWidth > 0 ? source.videoWidth : 1280
    const sourceHeight = source.videoHeight > 0 ? source.videoHeight : 720
    const scale = Math.min(1, settings.maxEdge / Math.max(sourceWidth, sourceHeight))
    const width = Math.max(1, Math.round(sourceWidth * scale))
    const height = Math.max(1, Math.round(sourceHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    canvas.getContext('2d')?.drawImage(source, 0, 0, width, height)
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', settings.quality)
    })
    if (blob === null) throw new Error('screen capture: the browser could not encode the frame')
    return { blob, bytes: blob.size, width, height, at: now() }
  }

  /**
   * Paint the live capture into a small preview picture, so a consumer can show
   * the broadcast without owning the stream.
   * @param source - the capture element playing the display stream.
   * @returns the preview as a data URL, or undefined when it cannot be painted.
   */
  const paintPreview = (source: HTMLVideoElement): string | undefined => {
    const width = 240
    const ratio = source.videoWidth > 0 && source.videoHeight > 0
      ? source.videoHeight / source.videoWidth
      : 9 / 16
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = Math.max(1, Math.round(width * ratio))
    const context = canvas.getContext('2d')
    if (context === null) return undefined
    context.drawImage(source, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.5)
  }

  /**
   * Take one frame and put it in the buffer.
   * @param silent - whether a failure is a background hiccup instead of a report.
   */
  const sample = async (silent: boolean): Promise<void> => {
    const source = video
    if (source === undefined) return
    const settings = readScreenSettings()
    try {
      // The change gate is consulted on every frame — including the first one —
      // so the comparison baseline advances even though the first frame of a
      // run is always taken.
      if (settings.sendOnChange && !changedEnough(source, settings.changeThreshold) && silent) {
        skipped += 1
        notify()
        return
      }
      const frame = await encodeFrame(source, settings)
      if (settings.showPreview) preview = paintPreview(source)
      push(frame)
      captured += 1
      notify()
    } catch (error) {
      if (!silent) fail(error)
      else lastError = error instanceof Error ? error.message : String(error)
      notify()
    }
  }

  /** Attach the stream to a hidden element that lives outside the interface. */
  const mountVideo = async (source: MediaStream): Promise<void> => {
    const element = document.createElement('video')
    element.srcObject = source
    element.muted = true
    try {
      await element.play()
    } catch {
      // Autoplay refusal on a muted element is unusual; the first sample still
      // reads the element's current frame, so the loop carries on.
    }
    video = element
    baseline = undefined
  }

  /**
   * Release the stream, the element, and the cadence. Buffered frames and
   * accumulated text are deliberately kept: they are the broadcast's product,
   * and a consumer that has not collected them yet must still find them.
   */
  const release = (): void => {
    timer.stop()
    stream?.getTracks().forEach((track) => { track.stop() })
    stream = undefined
    if (video !== undefined) video.srcObject = null
    video = undefined
    baseline = undefined
    preview = undefined
  }

  /** Begin sampling on the configured cadence. */
  const beginLoop = async (settings: ScreenSettings): Promise<void> => {
    // The first frame of a run always goes out; the change gate owns the rest.
    await sample(false)
    if (state !== 'starting' && state !== 'live') return
    timer.start(settings.intervalMs, () => { void sample(true) })
    enter('live')
  }

  /** Stop sampling but keep the stream, so resuming needs no new permission. */
  const pause = (): void => {
    if (state !== 'live') return
    timer.stop()
    enter('paused')
  }

  /** Resume sampling on a paused broadcast. */
  const resume = (): void => {
    if (state !== 'paused' || stream === undefined) return
    timer.start(readScreenSettings().intervalMs, () => { void sample(true) })
    enter('live')
  }

  /**
   * Release the stream and stop sampling. Buffered frames are kept.
   *
   * Not `async`: releasing a stream is synchronous, and the promise in the
   * signature is the interface's contract rather than work being awaited.
   * @returns a promise that is already settled once the stream is released.
   */
  const stop = (): Promise<void> => {
    if (state === 'idle' || state === 'stopping') return Promise.resolve()
    enter('stopping')
    release()
    startedAt = undefined
    enter('idle')
    return Promise.resolve()
  }

  /** Release everything and stop notifying. */
  const dispose = (): void => {
    release()
    keepDisplayAwake(false)
    frames.length = 0
    bytes = 0
    text = ''
    listeners.clear()
    startedAt = undefined
    captured = 0
    evicted = 0
    skipped = 0
    lastError = ''
    state = 'idle'
  }

  /** Ask the system for a stream and begin sampling. */
  const start = async (): Promise<void> => {
    if (state === 'starting' || state === 'live') return
    if (state === 'paused') {
      resume()
      return
    }
    const settings = readScreenSettings()
    enter('starting')
    lastError = ''
    try {
      const request = options.requestStream ?? (async (chosen: ScreenSettings): Promise<MediaStream> => {
        const devices = (globalThis as { navigator?: Navigator }).navigator?.mediaDevices
        if (devices?.getDisplayMedia === undefined) {
          throw new Error('screen capture: this environment cannot share the screen')
        }
        return await devices.getDisplayMedia(displayConstraints(chosen))
      })
      const displayStream = await request(settings)
      stream = displayStream
      startedAt = now()
      captured = 0
      evicted = 0
      skipped = 0
      await mountVideo(displayStream)
      const track = displayStream.getVideoTracks()[0]
      track?.addEventListener('ended', () => {
        // The user pressed the browser's own "Stop sharing" bar, or the capture
        // died. Either way the broadcast is over.
        if (readScreenSettings().stopOnEnded) void stop()
        else fail(new Error('screen capture: the shared screen was released'))
      }, { once: true })
      if (!settings.broadcast) {
        // The one-shot path the setting keeps available: take one frame, then
        // release the stream. The frame stays in the buffer for a consumer.
        await sample(false)
        await stop()
        return
      }
      await beginLoop(settings)
    } catch (error) {
      release()
      fail(error)
    }
  }

  return {
    state: (): CaptureState => state,
    stream: (): MediaStream | undefined => stream,
    snapshot,
    start,
    pause,
    resume,
    stop,
    dispose,

    drain: (): readonly CapturedFrame[] => {
      if (frames.length === 0) return []
      const taken = [...frames]
      frames.length = 0
      bytes = 0
      notify()
      return taken
    },

    addText: (value: string): void => {
      const trimmed = value.trim()
      if (trimmed === '') return
      const joined = text === '' ? trimmed : `${text}\n${trimmed}`
      const limit = readScreenSettings().bufferTextChars
      text = joined.length > limit ? joined.slice(joined.length - limit) : joined
      notify()
    },

    clearText: (): void => {
      if (text === '') return
      text = ''
      notify()
    },

    subscribe: (listener): (() => void) => {
      listeners.add(listener)
      return (): void => { listeners.delete(listener) }
    },
  }
}

/** The app-wide capture, created on first use so any consumer can reach it. */
let shared: ScreenCaptureEngine | undefined

/**
 * The app-wide capture subsystem.
 * @returns the shared engine, created on first call.
 */
export function screenCapture(): ScreenCaptureEngine {
  shared ??= createScreenCaptureEngine()
  return shared
}

/**
 * Bring the capture subsystem up at boot and tear it down on dispose. Starting
 * it here rather than inside a component is what makes the broadcast outlive
 * whichever surface asked for it.
 * @returns the disposer releasing everything the capture holds.
 */
export function installScreenCapture(): () => void {
  const engine = screenCapture()
  return (): void => {
    engine.dispose()
    shared = undefined
  }
}

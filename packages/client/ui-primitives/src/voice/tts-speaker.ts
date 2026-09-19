/**
 * Speech synthesis for the voice module: the speaking half, as a seam.
 *
 * The module never speaks by itself. It hands text to a speaker and waits for
 * the outcome, so what the answer sounds like stays a decision of the installed
 * read-aloud engine — the one that already honours the provider, the service,
 * and the voice chosen in Voice Settings.
 *
 * That indirection is deliberate and load-bearing. Speaking through the system
 * voice directly from here would work on the first run and then break silently:
 * the moment the user picked another service in the settings, the module would
 * keep answering in the machine's voice and nothing would say so. The seam also
 * carries a completion report, which is what lets the module return to
 * listening on its own instead of waiting for another press.
 *
 * Stage one drives the installed engine and plays the whole answer. Chunked
 * playback with early start — the streaming speaker — lands behind this same
 * interface, which is why the interface reports an outcome rather than nothing.
 *
 * A dependency-free leaf, so any client package may import it without
 * bundle-purity edges.
 */

import { getTtsBackend, speakWithBackend } from '../speech-synthesis.ts'
import type { SpeechLifecycle, TtsBackend } from '../speech-synthesis.ts'

/** One thing to say. */
export interface SpeakRequest {
  /** Already-sanitized text. Empty text is nothing to say, not a failure. */
  readonly text: string
  /** BCP 47 locale tag the voice should use. */
  readonly lang: string
  /**
   * Speech rate multiplier, or undefined to let the installed engine use the
   * rate chosen in Voice Settings. A caller that has no opinion about pacing
   * must omit it rather than pass a default, or it would override the setting.
   */
  readonly speed?: number
  /** Pitch multiplier, or undefined for the same reason as {@link speed}. */
  readonly pitch?: number
}

/** How one attempt to speak ended. */
export type SpeakOutcome =
  /** The voice finished the text on its own. */
  | 'spoken'
  /** The user interrupted, or a new request replaced this one. */
  | 'cancelled'
  /** No engine could speak: the runtime has no voice at all. */
  | 'unavailable'
  /** The engine was asked and refused. */
  | 'failed'

/**
 * How long to wait for a voice to admit it started before calling it dead.
 *
 * Long enough that a service delivering its first clip over the network is not
 * declared broken, short enough that a silent engine does not hold the module
 * in "speaking" indefinitely. An interrupted attempt is unaffected: the user
 * can always press again.
 */
export const SPEAK_START_GRACE_MS = 8000

/** Timer handle, spelled through the runtime's own setTimeout so both DOM and Node typings accept it. */
type TimerHandle = ReturnType<typeof setTimeout>

/**
 * Pacing handed to the engine. Left unset when the caller has no opinion, so
 * the rate and pitch chosen in Voice Settings keep applying.
 */
interface PacingOptions {
  /** Speech rate multiplier, or undefined to keep the stored one. */
  rate?: number | undefined
  /** Pitch multiplier, or undefined to keep the stored one. */
  pitch?: number | undefined
  /** BCP 47 locale tag the voice should use. */
  lang: string
  /** Told when the utterance begins, finishes, or fails. */
  onLifecycle: (event: SpeechLifecycle) => void
}

/** Replacements a test may inject instead of the real engine and clock. */
export interface SpeakerOptions {
  /** The engine to speak through. Defaults to the installed read-aloud engine. */
  readonly backend?: () => TtsBackend
  /** How text reaches the engine. Defaults to the app-wide speak entry point. */
  readonly speak?: (text: string, options: PacingOptions) => void
  /** How long to wait for a start event. Defaults to {@link SPEAK_START_GRACE_MS}. */
  readonly graceMs?: number
  /** Schedules the start watchdog. Defaults to `setTimeout`. */
  readonly schedule?: (run: () => void, ms: number) => TimerHandle
  /** Cancels the start watchdog. Defaults to `clearTimeout`. */
  readonly unschedule?: (handle: TimerHandle) => void
}

/** A thing that can say one answer and stop saying it. */
export interface Speaker {
  /** Whether anything can speak in this runtime right now. */
  isAvailable(): boolean
  /**
   * Say one answer, replacing whatever was being said.
   * @param request - the text and the pacing to say it with.
   * @returns how the attempt ended; never rejects, because a failed answer is
   * a state the module reports rather than an exception it must catch.
   */
  speak(request: SpeakRequest): Promise<SpeakOutcome>
  /** Stop the current answer, if any, and settle its attempt as cancelled. */
  cancel(): void
}

/**
 * Build the speaker that drives the installed read-aloud engine.
 * @param options - engine, entry point, and watchdog overrides for tests.
 * @returns the speaker.
 */
export function createInstalledSpeaker(options: SpeakerOptions = {}): Speaker {
  const backend = options.backend ?? getTtsBackend
  const say = options.speak ?? ((text, pacing): void => {
    // Built field by field: an unset pacing must be *absent*, not present and
    // undefined, or the engine would read it as an instruction to use 1.
    speakWithBackend(text, {
      lang: pacing.lang,
      onLifecycle: pacing.onLifecycle,
      ...pacing.rate === undefined ? {} : { rate: pacing.rate },
      ...pacing.pitch === undefined ? {} : { pitch: pacing.pitch },
    })
  })
  const graceMs = options.graceMs ?? SPEAK_START_GRACE_MS
  const schedule = options.schedule ?? ((run, ms): TimerHandle => setTimeout(run, ms))
  const unschedule = options.unschedule ?? ((handle): void => { clearTimeout(handle) })

  /** Counts attempts so a late event from a replaced utterance cannot settle the current one. */
  let generation = 0
  /** Resolver of the attempt still in flight, if any. */
  let settle: ((outcome: SpeakOutcome) => void) | undefined
  /** The start watchdog of the attempt still in flight, if any. */
  let watchdog: TimerHandle | undefined

  /** Stop the watchdog and settle the attempt in flight. */
  function settleCurrent(outcome: SpeakOutcome): void {
    const resolve = settle
    if (resolve === undefined) return
    settle = undefined
    if (watchdog !== undefined) {
      unschedule(watchdog)
      watchdog = undefined
    }
    resolve(outcome)
  }

  /**
   * Settle only when the event belongs to the attempt still current.
   * @param attempt - the generation the event was raised for.
   * @param outcome - how that attempt ended.
   */
  function settleAttempt(attempt: number, outcome: SpeakOutcome): void {
    if (attempt !== generation) return
    settleCurrent(outcome)
  }

  /**
   * Whether anything can speak right now. The engine is asked per call rather
   * than cached, because a browser fills its voice list asynchronously and a
   * backend installed later must be picked up without a restart.
   * @returns true when the installed engine reports itself ready.
   */
  const isAvailable = (): boolean => {
    try {
      return backend().isAvailable()
    } catch {
      return false
    }
  }

  return {
    isAvailable,
    speak(request: SpeakRequest): Promise<SpeakOutcome> {
      generation += 1
      const attempt = generation
      // The attempt being replaced is told it was cancelled, so no caller is
      // left waiting on an answer the engine has already stopped saying.
      settleCurrent('cancelled')
      if (request.text === '') return Promise.resolve('spoken')
      if (!isAvailable()) return Promise.resolve('unavailable')
      return new Promise<SpeakOutcome>((resolve) => {
        settle = resolve
        watchdog = schedule(() => { settleAttempt(attempt, 'unavailable') }, graceMs)
        try {
          say(request.text, {
            rate: request.speed,
            pitch: request.pitch,
            lang: request.lang,
            onLifecycle: (event): void => {
              if (event === 'start') {
                // The voice is audible; the watchdog has nothing left to guard.
                if (watchdog !== undefined) {
                  unschedule(watchdog)
                  watchdog = undefined
                }
                return
              }
              settleAttempt(attempt, event === 'end' ? 'spoken' : 'failed')
            },
          })
        } catch {
          settleAttempt(attempt, 'failed')
        }
      })
    },
    cancel(): void {
      // Settle before cancelling the engine: the engine reports the cancellation
      // as an 'end', and the attempt must not be resolved twice.
      generation += 1
      settleCurrent('cancelled')
      try {
        backend().cancel()
      } catch {
        // A cancel is best effort, like the speech it stops.
      }
    },
  }
}

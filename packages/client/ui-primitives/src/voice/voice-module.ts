/**
 * The voice module: one spoken question, from the microphone to the spoken
 * answer, as an explicit sequence of states.
 *
 * It sits above three seams and below the interface, and it owns nothing else:
 *
 *   microphone → capture → recognizer → Harness → speaker
 *      ▲            ▲           ▲          ▲         ▲
 *      │            │           │          │         │
 *   a person   audio-capture  stt-engine  a turn   tts-speaker
 *
 * Every one of those is handed in. The module holds no microphone, knows no
 * provider, and speaks through nothing of its own, which is what makes a
 * replaced engine a change outside this file. It also never touches the model
 * request itself: it hands text to a turn sink and waits for that turn's
 * answer, so the conversation stays the conversation's business.
 *
 * Stage one is push-to-talk: press, speak, release, and the rest follows
 * without another press. Hands-free listening and speaking over the module's
 * own voice — interrupting it mid-answer — arrive on top of these states rather
 * than in place of them.
 *
 * A dependency-free leaf, so any client package may import it without
 * bundle-purity edges.
 */

import { createAudioCapture, defaultRequestStream, isAudioCaptureAvailable } from './audio-capture.ts'
import type { AudioCapture, AudioCaptureSnapshot, CapturedClip } from './audio-capture.ts'
import { NothingToRecognizeError, SttError } from './stt-engine.ts'
import type { SttEngine, SttEngineKind } from './stt-engine.ts'
import { createInstalledSpeaker } from './tts-speaker.ts'
import type { SpeakOutcome, Speaker } from './tts-speaker.ts'
import { readVoiceModuleSettings } from './voice-module-settings.ts'
import type { VoiceReplyMode } from './voice-module-settings.ts'

/** Where one spoken question currently is. */
export type VoiceModuleState =
  /** Nothing is happening; the next press may start a question. */
  | 'idle'
  /** The microphone is open and the person is speaking. */
  | 'listening'
  /** A clip is in hand and the recognizer is working on it. */
  | 'recognizing'
  /** The recognized text has been handed to Harness. */
  | 'sending'
  /** Harness is working on the turn. */
  | 'thinking'
  /** The answer is being read aloud. */
  | 'speaking'
  /** The last attempt failed in a way the person must know about. */
  | 'error'

/**
 * Why the last attempt ended without an answer.
 *
 * Reported even when the state returns to `idle`, because silence and a missing
 * recognizer are not the same thing to the person who just spoke: one is worth
 * a quiet note, the other needs a sentence explaining what to install.
 */
export type VoiceFailureReason =
  /** This runtime has no microphone capture at all. */
  | 'capture-unavailable'
  /**
   * Windows (or Chromium) refused microphone access.
   *
   * Kept apart from {@link capture-failed} because it is not a fault: the
   * person can grant it in the privacy settings, and the fix is a switch, not
   * a different device. Reporting it as a generic capture failure would send
   * someone hunting for a hardware problem that does not exist.
   */
  | 'capture-denied'
  /** The microphone could not be opened: the chosen device is gone or busy. */
  | 'capture-failed'
  /** The release produced no usable audio. */
  | 'nothing-recorded'
  /** The chosen recognizer cannot run here: nothing local, nothing configured. */
  | 'recognize-unavailable'
  /** The recognizer ran and failed. */
  | 'recognize-failed'
  /** The clip held no speech. */
  | 'nothing-recognized'
  /** Harness refused the text. */
  | 'send-failed'
  /** The turn produced no answer. */
  | 'answer-failed'
  /** The turn never finished. */
  | 'answer-timeout'
  /** The answer could not be read aloud. */
  | 'speak-failed'

/** Everything a consumer may need to know, in one immutable value. */
export interface VoiceModuleSnapshot {
  /** Where the question currently is. */
  readonly state: VoiceModuleState
  /** Text the recognizer produced for the last clip, or '' when it produced none. */
  readonly transcript: string
  /** Answer that was read aloud last, or '' when none was. */
  readonly answer: string
  /** Which recognizer last produced text, or '' when none has. */
  readonly engine: SttEngineKind | ''
  /** Why the last attempt ended short, or '' when it did not. */
  readonly reason: VoiceFailureReason | ''
  /** The raw cause behind {@link reason}, for logs. Never shown verbatim. */
  readonly detail: string
  /** How long the last clip lasted, in milliseconds. */
  readonly clipMs: number
  /** How long the last recognition took, in milliseconds. */
  readonly recognizeMs: number
}

/**
 * The conversation, as the module sees it.
 *
 * One call in and one answer out. A sink that cannot wait for an answer may
 * omit {@link awaitAnswer}; the module then stops after sending, which is the
 * honest behaviour when nobody is listening for the reply.
 */
export interface VoiceTurnSink {
  /**
   * Hand one recognized question to Harness.
   * @param text - the recognized text, already trimmed and non-empty.
   */
  submit(text: string): void
  /**
   * Wait for the answer to the question just submitted.
   * @param signal - aborted when the person interrupts.
   * @returns the answer text.
   */
  awaitAnswer?(signal: AbortSignal): Promise<string>
}

/** What a caller may replace instead of the real devices, engines, and clock. */
export interface VoiceModuleOptions {
  /** The microphone. Defaults to a capture over the real device. */
  readonly capture?: AudioCapture
  /** The recognizer. Omitted when nothing can recognize, which the module reports. */
  readonly stt?: SttEngine
  /** The voice. Defaults to the app's installed read-aloud engine. */
  readonly speaker?: Speaker
  /** The conversation. */
  readonly turn: VoiceTurnSink
  /** Locale the clip is recognized in. Defaults to the recognizer's own default. */
  readonly lang?: string
  /** Whether an answer is voiced, read per answer so a settings change applies at once. */
  readonly replyMode?: () => VoiceReplyMode
  /** How long to wait for an answer before giving up. Defaults to {@link ANSWER_TIMEOUT_MS}. */
  readonly answerTimeoutMs?: number
  /** Schedules the answer watchdog. Defaults to `setTimeout`. */
  readonly schedule?: (run: () => void, ms: number) => ReturnType<typeof setTimeout>
  /** Cancels the answer watchdog. Defaults to `clearTimeout`. */
  readonly unschedule?: (handle: ReturnType<typeof setTimeout>) => void
  /** Clock. Defaults to `Date.now`. */
  readonly now?: () => number
}

/** How long a turn may take before the module stops waiting for its answer. */
export const ANSWER_TIMEOUT_MS = 120000

/** Default locale for recognition, matching the media gateway's own default. */
const DEFAULT_LANG = 'ru-RU'

/** One spoken question. Created by the interface, driven by press and release. */
export interface VoiceModule {
  /** Where the question currently is. */
  state(): VoiceModuleState
  /** The whole picture, in one value. */
  snapshot(): VoiceModuleSnapshot
  /**
   * Watch for state changes.
   * @param listener - called with the new snapshot.
   * @returns a function that stops the watching.
   */
  subscribe(listener: (snapshot: VoiceModuleSnapshot) => void): () => void
  /** Open the microphone and start listening. Ignored unless idle or failed. */
  press(): Promise<void>
  /** Stop listening and carry the question through to its spoken answer. */
  release(): Promise<void>
  /** Abandon the question: stop the microphone, the recognition, and the voice. */
  interrupt(): void
  /** Release everything and stop notifying. */
  dispose(): void
}

/**
 * Build one voice module.
 * @param options - the seams and the conversation to drive.
 * @returns the module.
 */
export function createVoiceModule(options: VoiceModuleOptions): VoiceModule {
  // The chosen microphone is read AT PRESS TIME, not once at build time: the
  // settings page can change it while the app is open, and a capture frozen to
  // the old endpoint would keep recording the wrong device until a reload.
  const capture = options.capture ?? createAudioCapture({
    requestStream: () => defaultRequestStream(readVoiceModuleSettings().inputDeviceId),
  })
  /** A capture handed in is trusted to work: the runtime probe would reject a test double. */
  const injectedCapture = options.capture !== undefined
  const speaker = options.speaker ?? createInstalledSpeaker()
  const turn = options.turn
  const lang = options.lang ?? DEFAULT_LANG
  const replyMode = options.replyMode ?? ((): VoiceReplyMode => readVoiceModuleSettings().replyMode)
  const answerTimeoutMs = options.answerTimeoutMs ?? ANSWER_TIMEOUT_MS
  const schedule = options.schedule ?? ((run, ms): ReturnType<typeof setTimeout> => setTimeout(run, ms))
  const unschedule = options.unschedule ?? ((handle): void => { clearTimeout(handle) })
  const now = options.now ?? ((): number => Date.now())

  const listeners = new Set<(snapshot: VoiceModuleSnapshot) => void>()
  let state: VoiceModuleState = 'idle'
  let transcript = ''
  let answer = ''
  let engine: SttEngineKind | '' = ''
  let reason: VoiceFailureReason | '' = ''
  let detail = ''
  let clipMs = 0
  let recognizeMs = 0
  /** Counts attempts, so a result arriving after an interruption cannot move the state. */
  let generation = 0
  /** Cancels the recognition and the wait for an answer. */
  let controller: AbortController | undefined
  /** The answer watchdog of the attempt in flight. */
  let watchdog: ReturnType<typeof setTimeout> | undefined

  const snapshot = (): VoiceModuleSnapshot => ({
    state, transcript, answer, engine, reason, detail, clipMs, recognizeMs,
  })

  /** Publish the current snapshot to every listener. */
  function notify(): void {
    const current = snapshot()
    for (const listener of listeners) listener(current)
  }

  /**
   * Move to a state and tell the listeners.
   * @param next - the state to enter.
   */
  function enter(next: VoiceModuleState): void {
    state = next
    notify()
  }

  /** Stop the answer watchdog and forget the attempt's cancellation. */
  function clearAttempt(): void {
    if (watchdog !== undefined) {
      unschedule(watchdog)
      watchdog = undefined
    }
    controller = undefined
  }

  /**
   * Close the attempt in flight.
   *
   * Bumping the generation is what makes the rest of that attempt harmless: a
   * recognition, an answer, or a voice callback that arrives afterwards finds
   * itself no longer current and changes nothing. Without this a late result
   * could move a module that had already failed, or voice an answer nobody is
   * waiting for any more.
   */
  function endAttempt(): void {
    generation += 1
    clearAttempt()
  }

  /**
   * End the attempt with a failure the person must know about.
   * @param why - why it failed.
   * @param raw - the raw cause, kept for logs.
   */
  function fail(why: VoiceFailureReason, raw: string): void {
    endAttempt()
    reason = why
    detail = raw
    enter('error')
  }

  /**
   * End the attempt quietly, returning to rest.
   * @param why - why it ended short, or '' when there is nothing to report.
   * @param raw - the raw cause, kept for logs.
   */
  function rest(why: VoiceFailureReason | '', raw = ''): void {
    endAttempt()
    reason = why
    detail = raw
    enter('idle')
  }

  /** Whether the attempt that is running is still the current one. */
  const current = (attempt: number): boolean => attempt === generation

  /**
   * Turn one recognition failure into the reason the interface acts on.
   * @param failure - what the recognizer threw.
   * @returns the reason, or undefined when the person interrupted.
   */
  function reasonOf(failure: unknown): VoiceFailureReason | undefined {
    if (failure instanceof SttError) {
      if (failure.reason === 'aborted') return undefined
      return failure.reason === 'unavailable' ? 'recognize-unavailable' : 'recognize-failed'
    }
    return 'recognize-failed'
  }

  /**
   * The loggable detail for one recognition failure.
   *
   * A {@link NothingToRecognizeError} logs its own JSON, so the log entry for
   * "there is nothing to recognize" has one shape whether the module noticed
   * first or the engine did. Every other failure keeps its plain message: a
   * transport error has no structured form worth inventing.
   * @param failure - what the recognizer threw.
   * @returns the string to keep as the attempt's detail.
   */
  function detailOf(failure: unknown): string {
    if (failure instanceof NothingToRecognizeError) return JSON.stringify(failure.toJSON())
    return failure instanceof Error ? failure.message : String(failure)
  }

  /**
   * Ask the recognizer for the text in one clip.
   * @param attempt - the attempt this recognition belongs to.
   * @param clip - the recorded clip.
   * @returns the recognized text, or undefined when the attempt ended short.
   */
  async function recognize(attempt: number, clip: CapturedClip): Promise<string | undefined> {
    if (options.stt === undefined) {
      // The module has no recognizer at all. Reported through the same typed
      // failure the engine raises, rather than a hand-written sentence, so the
      // log carries one shape of this error no matter which layer noticed.
      const missing = new NothingToRecognizeError()
      fail('recognize-unavailable', JSON.stringify(missing.toJSON()))
      return undefined
    }
    enter('recognizing')
    const started = now()
    try {
      const result = await options.stt.transcribe({
        clip: clip.blob,
        lang,
        // Handed over as it is: an attempt whose cancellation is already gone
        // simply cannot be cancelled, which is the truth at this point.
        signal: controller?.signal,
      })
      if (!current(attempt)) return undefined
      recognizeMs = now() - started
      engine = result.engine
      if (result.text === '') {
        // Silence is not a failure: the person simply said nothing the
        // recognizer could hear, and a red state would overstate that.
        rest('nothing-recognized')
        return undefined
      }
      transcript = result.text
      return result.text
    } catch (failure) {
      if (!current(attempt)) return undefined
      const why = reasonOf(failure)
      if (why === undefined) {
        rest('')
        return undefined
      }
      fail(why, detailOf(failure))
      return undefined
    }
  }

  /**
   * Wait for the answer to the question just sent.
   * @param attempt - the attempt this wait belongs to.
   * @param signal - aborted when the person interrupts.
   * @param wait - the conversation's own wait; the caller has already checked it exists.
   * @returns the answer text, or undefined when the attempt ended short.
   */
  async function hear(
    attempt: number,
    signal: AbortSignal,
    wait: (signal: AbortSignal) => Promise<string>,
  ): Promise<string | undefined> {
    enter('thinking')
    const timer = schedule(() => {
      // No staleness check is needed here: endAttempt() always cancels this
      // watchdog, so a timer that fires belongs to the attempt in flight.
      fail('answer-timeout', 'the turn did not finish in time')
    }, answerTimeoutMs)
    watchdog = timer
    try {
      const text = await wait(signal)
      if (!current(attempt)) return undefined
      return text.trim()
    } catch (failure) {
      if (!current(attempt)) return undefined
      fail('answer-failed', failure instanceof Error ? failure.message : String(failure))
      return undefined
    } finally {
      if (watchdog === timer) {
        unschedule(timer)
        watchdog = undefined
      }
    }
  }

  /**
   * Read one answer aloud.
   * @param attempt - the attempt this answer belongs to.
   * @param text - the answer.
   */
  async function voice(attempt: number, text: string): Promise<void> {
    answer = text
    enter('speaking')
    const outcome: SpeakOutcome = await speaker.speak({ text, lang })
    if (!current(attempt)) return
    if (outcome === 'failed') {
      fail('speak-failed', 'the voice refused to speak the answer')
      return
    }
    rest('')
  }

  return {
    state: (): VoiceModuleState => state,
    snapshot,
    subscribe(listener): () => void {
      listeners.add(listener)
      return (): void => { listeners.delete(listener) }
    },
    async press(): Promise<void> {
      if (state !== 'idle' && state !== 'error') return
      if (!injectedCapture && !isAudioCaptureAvailable()) {
        fail('capture-unavailable', 'this runtime has no microphone capture')
        return
      }
      endAttempt()
      controller = new AbortController()
      reason = ''
      detail = ''
      enter('listening')
      const attempt = generation
      await capture.start()
      if (!current(attempt)) return
      const recorded: AudioCaptureSnapshot = capture.snapshot()
      if (recorded.state === 'failed') {
        // A refusal is told apart from a fault by the stable name, not by the
        // message: "Permission denied" is shown translated and reworded, while
        // `NotAllowedError` is the same string in every build.
        fail(
          recorded.lastErrorName === 'NotAllowedError' ? 'capture-denied' : 'capture-failed',
          recorded.lastError,
        )
      }
    },
    async release(): Promise<void> {
      if (state !== 'listening') return
      const attempt = generation
      const clip = await capture.stop()
      if (!current(attempt)) return
      if (clip === undefined) {
        rest('nothing-recorded')
        return
      }
      clipMs = clip.durationMs
      const text = await recognize(attempt, clip)
      if (text === undefined || !current(attempt)) return
      enter('sending')
      try {
        turn.submit(text)
      } catch (failure) {
        fail('send-failed', failure instanceof Error ? failure.message : String(failure))
        return
      }
      if (replyMode() === 'off') {
        rest('')
        return
      }
      // Called as a method, not captured as a bare reference: `turn` is the
      // caller's own face, and detaching one of its members would drop the
      // receiver it legitimately relies on.
      const wait = turn.awaitAnswer?.bind(turn)
      const signal = controller?.signal
      if (signal === undefined || wait === undefined) {
        rest('')
        return
      }
      const spoken = await hear(attempt, signal, wait)
      if (spoken === undefined || !current(attempt)) return
      if (spoken === '') {
        rest('')
        return
      }
      await voice(attempt, spoken)
    },
    interrupt(): void {
      endAttempt()
      capture.cancel()
      speaker.cancel()
      reason = ''
      detail = ''
      enter('idle')
    },
    dispose(): void {
      endAttempt()
      capture.dispose()
      speaker.cancel()
      listeners.clear()
      state = 'idle'
    },
  }
}

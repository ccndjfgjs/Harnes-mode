/**
 * Speech synthesis: read text and code aloud. The built-in browser voice is
 * the *fallback*, not the default: every read-aloud entry point here routes
 * through the active {@link TtsBackend}, which the app replaces at boot with
 * the engine that honours the provider and voice chosen in Voice Settings
 * (see speech-engine.ts). Keeping the switch in this module is what makes the
 * bypass impossible — a caller that imports `speakText` cannot accidentally
 * speak in the system voice while the user has chosen another one.
 *
 * `speak` and `cancelSpeech` stay raw: they drive the built-in engine alone and
 * are what the default backend and the remote engine's fallback are made of.
 *
 * Silent by construction where speechSynthesis is missing. Callers pass
 * already-sanitized text (see speech-text.ts); this module only drives the
 * utterance lifecycle: cancel-before-speak so a new request never talks over
 * the previous one. A dependency-free leaf (like clipboard.ts), so any client
 * package may import it without bundle-purity edges.
 */

import { readAccessibilitySettings } from './accessibility-settings.ts'
import { describeCodeForSpeech, stripMarkdownForSpeech } from './speech-text.ts'

/** Code reading modes, see describeCodeForSpeech. */
export type CodeSpeechMode = 'brief' | 'line' | 'full'

/**
 * How one utterance lived, reported to a caller that asked to watch it.
 *
 * Exists because a fire-and-forget `speak` cannot tell a caller when the voice
 * stopped: the voice module has to know, so it can return to listening without
 * asking the user to press anything. Reporting stays opt-in — a caller that
 * does not ask never sees an event.
 */
export type SpeechLifecycle =
  /** The voice began producing sound. */
  | 'start'
  /** The utterance finished on its own. */
  | 'end'
  /** The engine refused; nothing was heard. */
  | 'error'

export interface SpeakOptions {
  /** Speech rate multiplier. */
  rate?: number
  /** Voice pitch multiplier. */
  pitch?: number
  /** Volume between 0 and 1. */
  volume?: number
  /** BCP 47 locale tag for the utterance. */
  lang?: string
  /**
   * Watch one utterance through its life. Called at most once per event and
   * never after 'end' or 'error'.
   *
   * Cancelling reports 'end' on the utterance that was cancelled, because the
   * engine has no separate word for it. A caller tracking a single utterance
   * must therefore ignore events arriving after it replaced that utterance.
   * @param event - that the utterance began, finished, or failed.
   */
  onLifecycle?(event: SpeechLifecycle): void
}

/**
 * A thing that can read text aloud. The app-wide read-aloud engine and the
 * built-in browser voice both implement it, so a caller never needs to know
 * which one is installed.
 */
export interface TtsBackend {
  /** Whether the backend can speak now. */
  isAvailable(): boolean
  /** Speak text, cancelling whatever was being said. */
  speak(text: string, options?: SpeakOptions): void
  /** Stop any current speech. */
  cancel(): void
}

const DEFAULT_LANG = 'ru-RU'

/**
 * Whether the browser can speak at all.
 * @returns false outside browsers with the Web Speech API.
 */
export function isSpeechSynthesisAvailable(): boolean {
  return typeof speechSynthesis !== 'undefined'
}

/**
 * Pick the Russian voice when the engine offers one.
 * @param voices - engine voice list.
 * @returns the Russian voice, or undefined to let the engine decide.
 */
export function pickRussianVoice(voices: readonly SpeechSynthesisVoice[]): SpeechSynthesisVoice | undefined {
  return voices.find(voice => voice.lang.toLowerCase().startsWith('ru'))
}

/**
 * Speak text through the built-in engine, cancelling anything currently spoken.
 * Raw on purpose: this is what the default backend drives, and what the remote
 * engine degrades to when the service is unreachable.
 * @param text - already-sanitized text (empty text is a no-op).
 * @param options - rate/pitch/volume/locale overrides.
 */
export function speak(text: string, options: SpeakOptions = {}): void {
  if (text === '' || !isSpeechSynthesisAvailable()) return
  try {
    speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.rate = options.rate ?? 1
    utterance.pitch = options.pitch ?? 1
    utterance.volume = options.volume ?? 1
    utterance.lang = options.lang ?? DEFAULT_LANG
    // Wired before speak() so a synchronous start is not missed.
    const report = options.onLifecycle
    if (report !== undefined) {
      utterance.onstart = (): void => { report('start') }
      utterance.onend = (): void => { report('end') }
      utterance.onerror = (): void => { report('error') }
    }
    const voice = pickRussianVoice(speechSynthesis.getVoices())
    if (voice !== undefined) utterance.voice = voice
    speechSynthesis.speak(utterance)
  } catch {
    // Speech is best-effort feedback: engine failures must never break the flow.
  }
}

/** Stop any current speech, through the built-in engine. */
export function cancelSpeech(): void {
  if (!isSpeechSynthesisAvailable()) return
  try {
    speechSynthesis.cancel()
  } catch {
    // Best effort, see speak().
  }
}

/** The built-in browser voice, as a backend. */
export const webSpeechBackend: TtsBackend = {
  isAvailable: isSpeechSynthesisAvailable,
  speak: (text, options): void => { speak(text, options) },
  cancel: cancelSpeech,
}

/** The backend every read-aloud entry point routes through. */
let activeBackend: TtsBackend = webSpeechBackend

/**
 * Replace the read-aloud backend with the engine that honours the configured
 * provider and voice. Installed once at boot (see installSpeechEngine).
 * @param backend - the new backend, or null to restore the built-in voice.
 */
export function setTtsBackend(backend: TtsBackend | null): void {
  activeBackend = backend ?? webSpeechBackend
}

/**
 * The backend read-aloud currently uses.
 * @returns the installed backend, or the built-in voice when none is installed.
 */
export function getTtsBackend(): TtsBackend {
  return activeBackend
}

/**
 * Speak already-sanitized text through the active backend, replacing whatever
 * was being said.
 * @param text - sanitized text (empty text is a no-op).
 * @param options - pacing the backend may honour.
 */
export function speakWithBackend(text: string, options: SpeakOptions = {}): void {
  if (text === '') return
  if (!activeBackend.isAvailable()) return
  try {
    activeBackend.cancel()
    activeBackend.speak(text, options)
  } catch {
    // Best effort, see speak().
  }
}

/**
 * Describe code lines per the reading mode and speak the result. Empty code
 * is a no-op. Settings-aware: the mode defaults to the Accessibility
 * code-reading preference read lazily at call time, so callers without
 * settings access still honor it; an explicit mode always wins.
 * @param lines - code lines.
 * @param mode - 'brief' announces counts, 'line' reads every line, 'full' reads everything at once.
 * @param options - rate/pitch/volume/locale overrides.
 */
export function speakCode(
  lines: readonly string[],
  mode: CodeSpeechMode = readAccessibilitySettings().codeReading,
  options: SpeakOptions = {},
): void {
  speakWithBackend(describeCodeForSpeech(lines, mode), options)
}

/**
 * Speak running text (an answer, a notice) in the chosen voice, honoring the
 * Accessibility strip-Markdown preference read lazily at call time. Empty text
 * is a no-op.
 * @param text - raw Markdown or plain text.
 * @param options - rate/pitch/volume/locale overrides.
 */
export function speakText(text: string, options: SpeakOptions = {}): void {
  if (text === '') return
  const strip = readAccessibilitySettings().stripMarkdown
  speakWithBackend(strip ? stripMarkdownForSpeech(text) : text, options)
}

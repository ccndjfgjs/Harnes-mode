/**
 * The voice module's own settings: the choices that belong to it and to
 * nothing else.
 *
 * Everything the module needs *about the voice* — the provider, the voice, the
 * model, the speed, the pitch, the endpoints and keys — already has one owner
 * (see voice-endpoint.ts) and is read from there. What is added here is only
 * what the module decides on its own:
 *
 *  - whether an answer is read aloud at all,
 *  - which recognizer hears the question, and
 *  - which microphone records and which endpoint plays it back.
 *
 * The device pair belongs here rather than in the endpoint document because it
 * is a property of *this machine's hardware*, not of the speech service: the
 * same endpoint and key follow a user across machines, but a headset does not.
 *
 * All of them live in the same `dsh.voice.settings` document the Voice Settings
 * page writes, so the page, the module, and the read-aloud engine still share
 * one storage and one meaning. The reader is separate because the *concern* is
 * separate: the module's behaviour is not an endpoint and not a voice.
 *
 * A dependency-free leaf, so any client package may import it without
 * bundle-purity edges.
 */

import { VOICE_SETTINGS_STORAGE_KEY } from '../voice-endpoint.ts'
import { isSttEngineId } from './stt-engine.ts'
import type { SttEngineId } from './stt-engine.ts'

/**
 * What happens to an answer the model produced for a spoken question.
 *
 * `voice-message` is read and preserved but not yet acted on: keeping the
 * answer as a playable voice message needs the voice-message store, which is a
 * later stage. The value is accepted now so a document written by a newer build
 * is understood rather than silently reset — a reader that discards what it
 * does not know would erase the user's choice.
 */
export type VoiceReplyMode =
  /** The answer stays text only; the module stops after sending. */
  | 'off'
  /** The answer is read aloud through the installed voice. */
  | 'speak'
  /** The answer is kept as a playable voice message (later stage; reads as `speak` today). */
  | 'voice-message'

/** Every selectable reply mode, in the order the settings card lists them. */
export const VOICE_REPLY_MODES: readonly VoiceReplyMode[] = ['off', 'speak', 'voice-message']

/** The module's own settings. */
export interface VoiceModuleSettings {
  /** Whether, and how, an answer is voiced. */
  readonly replyMode: VoiceReplyMode
  /** Which recognizer hears the question. */
  readonly sttEngine: SttEngineId
  /**
   * Which microphone to record from, as the platform's own `deviceId`.
   * '' means "the system default" and is the honest default: the id the
   * platform hands out for the default endpoint changes with the hardware, so
   * pinning one at install time would break the moment a headset is unplugged.
   */
  readonly inputDeviceId: string
  /**
   * Which endpoint to play the answer through, as `deviceId`. '' means the
   * system default, for the same reason as {@link inputDeviceId}.
   */
  readonly outputDeviceId: string
}

/** What a fresh installation does: the answer is read aloud, the recognizer is chosen automatically. */
export const DEFAULT_VOICE_MODULE_SETTINGS: VoiceModuleSettings = {
  replyMode: 'speak',
  sttEngine: 'auto',
  inputDeviceId: '',
  outputDeviceId: '',
}

/**
 * Whether a value is a reply mode this build understands.
 * @param value - value to test.
 * @returns true when the value names a reply mode.
 */
export function isVoiceReplyMode(value: unknown): value is VoiceReplyMode {
  return typeof value === 'string' && (VOICE_REPLY_MODES as readonly string[]).includes(value)
}

/**
 * Parse the stored Voice Settings document.
 * @returns the parsed document, or null when nothing usable is stored.
 */
function storedDocument(): unknown {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(VOICE_SETTINGS_STORAGE_KEY)
  } catch {
    return null
  }
  if (raw === null) return null
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

/**
 * Read one trimmed text field out of the stored document.
 * @param record - parsed document, or null when nothing usable is stored.
 * @param field - field to read.
 * @returns the trimmed string, or '' when absent or not a string.
 */
function fieldOf(record: unknown, field: string): string {
  if (typeof record !== 'object' || record === null) return ''
  const value = (record as Record<string, unknown>)[field]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Read the module's settings, validating each field on its own so one damaged
 * field cannot discard the other.
 * @returns the stored settings, or the defaults when nothing usable is stored.
 */
export function readVoiceModuleSettings(): VoiceModuleSettings {
  const record = storedDocument()
  const reply = fieldOf(record, 'voiceReplyMode')
  const engine = fieldOf(record, 'sttEngine')
  return {
    replyMode: isVoiceReplyMode(reply) ? reply : DEFAULT_VOICE_MODULE_SETTINGS.replyMode,
    sttEngine: isSttEngineId(engine) ? engine : DEFAULT_VOICE_MODULE_SETTINGS.sttEngine,
    inputDeviceId: fieldOf(record, 'inputDeviceId'),
    outputDeviceId: fieldOf(record, 'outputDeviceId'),
  }
}

/**
 * Whether the module should voice an answer at all.
 * @param settings - settings to inspect (defaults to the stored document).
 * @returns true unless the reply mode is off.
 */
export function isAnswerVoiced(settings: VoiceModuleSettings = readVoiceModuleSettings()): boolean {
  return settings.replyMode !== 'off'
}

/**
 * Persist the module's settings into the shared document, without disturbing
 * the fields this reader does not own.
 *
 * Read-modify-write over the raw document on purpose: the Voice Settings page
 * stores the endpoints, keys, and voice in the same key, and writing only the
 * fields named here would delete them. The merge direction is therefore "the
 * caller's fields win, everything else is preserved".
 * @param settings - the module settings to store.
 */
export function writeVoiceModuleSettings(settings: VoiceModuleSettings): void {
  const base: Record<string, unknown> = (() => {
    const parsed = storedDocument()
    if (typeof parsed !== 'object' || parsed === null) return {}
    return { ...(parsed as Record<string, unknown>) }
  })()
  try {
    localStorage.setItem(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify({
      ...base,
      voiceReplyMode: settings.replyMode,
      sttEngine: settings.sttEngine,
      inputDeviceId: settings.inputDeviceId,
      outputDeviceId: settings.outputDeviceId,
    }))
  } catch {
    // A refused write (private mode, quota) leaves the module on its previous
    // choice; the page already reflects the pick, so nothing misleads the user.
  }
}

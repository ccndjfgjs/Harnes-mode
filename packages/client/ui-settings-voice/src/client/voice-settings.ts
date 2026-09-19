/**
 * Browser-local voice-service settings: the single persistence behind the
 * Voice Settings page and the composer voice-button preflight check. Keys
 * stay in this browser's localStorage (never in the session log), so a
 * secret typed here never reaches a model request. Includes call/signaling
 * and vision endpoints for voice calls and screen sharing.
 *
 * Local first: the browser's own Web Speech engines (see the speech-synthesis
 * and speech-recognition leaves) cover dictation, voice mode, and screen-frame
 * capture with no endpoint and no key, so the stored endpoints below are an
 * *optional* external service the user may prefer — never a prerequisite. The
 * predicates therefore answer "can this work at all?", which is true when
 * either engine exists.
 */

import {
  DEFAULT_VOICE_SELECTION,
  VOICE_SETTINGS_STORAGE_KEY,
  isSpeechRecognitionAvailable,
  isSpeechSynthesisAvailable,
  readVoiceSelection,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { VoiceSelection } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Storage key for the whole voice-settings document.
 *
 * Re-exported from the primitives leaf rather than repeated here: the settings
 * page, the read-aloud engine, and the voice module all read this one document,
 * and a second literal is a second chance to drift out of step with them.
 */
export { VOICE_SETTINGS_STORAGE_KEY }

/**
 * The voice connections the composer buttons need, plus the provider-and-voice
 * selection the read-aloud and the call drive. The selection half is shared
 * with the engine's own reader (see readVoiceSelection), so the page never
 * keeps a second opinion about which voice is chosen.
 */
export interface VoiceSettings extends VoiceSelection {
  /** Speech-to-text endpoint URL (empty = not configured). */
  sttUrl: string
  /** Speech-to-text API key (empty = not configured). */
  sttKey: string
  /** Text-to-speech endpoint URL (empty = not configured). */
  ttsUrl: string
  /** Text-to-speech API key (empty = not configured). */
  ttsKey: string
  /** WebRTC signaling server for realtime voice calls (WebSocket URL). */
  callSignalingUrl: string
  /** Vision/screen analysis endpoint for screen sharing. */
  visionUrl: string
  /** Vision API key (empty = not configured). */
  visionKey: string
}

/** Blank settings: every service reads as unconnected and the voice is automatic. */
export const EMPTY_VOICE_SETTINGS: VoiceSettings = {
  ...DEFAULT_VOICE_SELECTION,
  sttUrl: '', sttKey: '', ttsUrl: '', ttsKey: '',
  callSignalingUrl: '', visionUrl: '', visionKey: '',
}

/**
 * Read the stored voice settings, tolerating a missing or corrupt document.
 * The selection half comes from the shared reader, so the page and the engine
 * can never disagree about the chosen provider and voice.
 * @returns the stored settings, or blank settings when nothing usable is stored.
 */
export function readVoiceSettings(): VoiceSettings {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(VOICE_SETTINGS_STORAGE_KEY)
  } catch {
    return { ...EMPTY_VOICE_SETTINGS }
  }
  if (raw === null) return { ...EMPTY_VOICE_SETTINGS }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    // A foreign writer corrupted the document: treat it as absent rather than
    // surfacing a parse failure from a settings read.
    return { ...EMPTY_VOICE_SETTINGS }
  }
  if (typeof parsed !== 'object' || parsed === null) return { ...EMPTY_VOICE_SETTINGS }
  const record = parsed as Record<string, unknown>
  const text = (value: unknown): string => (typeof value === 'string' ? value : '')
  return {
    ...readVoiceSelection(),
    sttUrl: text(record.sttUrl).trim(),
    sttKey: text(record.sttKey).trim(),
    ttsUrl: text(record.ttsUrl).trim(),
    ttsKey: text(record.ttsKey).trim(),
    callSignalingUrl: text(record.callSignalingUrl).trim(),
    visionUrl: text(record.visionUrl).trim(),
    visionKey: text(record.visionKey).trim(),
  }
}

/**
 * Read the stored document as a plain record, without interpreting it.
 *
 * Kept separate from {@link readVoiceSettings} because the page is not the only
 * writer: the voice module stores its own fields (`voiceReplyMode`, `sttEngine`,
 * `inputDeviceId`, `outputDeviceId`) in the same document, and a write that
 * rebuilt the record from this page's known fields alone would silently delete
 * them. The raw record is what lets a write put those fields back.
 * @returns the stored object, or an empty record when nothing usable is stored.
 */
function storedRecord(): Record<string, unknown> {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(VOICE_SETTINGS_STORAGE_KEY)
  } catch {
    return {}
  }
  if (raw === null) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) return {}
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * Persist voice settings, merging over the stored document.
 * @param patch - fields to store; every text value is trimmed before writing.
 */
export function writeVoiceSettings(patch: Partial<VoiceSettings>): void {
  const stored = readVoiceSettings()
  /** Trim a patched text field, keeping the stored one when the patch omits it. */
  const text = (value: string | undefined, fallback: string): string =>
    value === undefined ? fallback : value.trim()
  // Built as a whole rather than mutated: the selection half is readonly, so a
  // caller cannot reach into the document and change one field behind the
  // reader's back.
  const next = {
    // Fields this page does not own are carried over verbatim, so saving the
    // provider card cannot erase the module's own settings.
    ...storedRecord(),
    sttUrl: text(patch.sttUrl, stored.sttUrl),
    sttKey: text(patch.sttKey, stored.sttKey),
    ttsUrl: text(patch.ttsUrl, stored.ttsUrl),
    ttsKey: text(patch.ttsKey, stored.ttsKey),
    callSignalingUrl: text(patch.callSignalingUrl, stored.callSignalingUrl),
    visionUrl: text(patch.visionUrl, stored.visionUrl),
    visionKey: text(patch.visionKey, stored.visionKey),
    provider: patch.provider ?? stored.provider,
    ttsVoiceId: text(patch.ttsVoiceId, stored.ttsVoiceId),
    realtimeVoiceId: text(patch.realtimeVoiceId, stored.realtimeVoiceId),
    ttsModel: text(patch.ttsModel, stored.ttsModel),
    ttsSpeed: patch.ttsSpeed ?? stored.ttsSpeed,
    ttsPitch: patch.ttsPitch ?? stored.ttsPitch,
    callVoiceMode: patch.callVoiceMode ?? stored.callVoiceMode,
  }
  try {
    localStorage.setItem(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Private-mode/quota writes fail silently: the page keeps its draft and
    // the preflight check keeps reporting unconnected.
  }
}

/**
 * Whether dictation may start. True when the browser recognizes speech itself
 * (no endpoint, no key) or when an external STT service is stored.
 * @param settings - settings to inspect (defaults to the stored document).
 * @returns true when either engine is usable.
 */
export function isSttConfigured(settings: VoiceSettings = readVoiceSettings()): boolean {
  return isSpeechRecognitionAvailable() || (settings.sttUrl !== '' && settings.sttKey !== '')
}

/**
 * Whether voice mode may start (hearing for the user, speaking for the answer).
 * True when the browser both recognizes and synthesizes speech, or when the
 * external STT and TTS services are stored.
 * @param settings - settings to inspect (defaults to the stored document).
 * @returns true when a usable hearing engine and speaking engine both exist.
 */
export function isVoiceConfigured(settings: VoiceSettings = readVoiceSettings()): boolean {
  const speaks = isSpeechSynthesisAvailable() || (settings.ttsUrl !== '' && settings.ttsKey !== '')
  return isSttConfigured(settings) && speaks
}

/**
 * Whether realtime voice calls may start. True when the browser recognizes
 * speech itself, or when a signaling server is stored.
 * @param settings - settings to inspect (defaults to the stored document).
 * @returns true when either call path is usable.
 */
export function isCallConfigured(settings: VoiceSettings = readVoiceSettings()): boolean {
  return isSpeechRecognitionAvailable() || settings.callSignalingUrl !== ''
}

/**
 * Whether screen frames go to an external vision service. False selects the
 * local path, where a captured frame is attached to the composer instead.
 * @param settings - settings to inspect (defaults to the stored document).
 * @returns true only when vision URL is set.
 */
export function isVisionConfigured(settings: VoiceSettings = readVoiceSettings()): boolean {
  return settings.visionUrl !== ''
}

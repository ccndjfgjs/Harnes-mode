/**
 * Voice-service endpoints: the single reader of the `dsh.voice.settings`
 * document the Voice Settings page owns. Physical home is this leaf
 * (zero dependencies, like accessibility-settings.ts) so the composer
 * preflight, the model seat, and the read-aloud engine all read the same
 * endpoints without a cross-plugin value edge; the settings package keeps
 * writing the document through its own copy of the storage key.
 *
 * The document is browser-local by design: a key typed into Voice Settings
 * stays in this browser and reaches the host only as a per-request override,
 * never through a model request or the session log.
 *
 * Two reads live here: the endpoints (where to call) and the selection (which
 * provider and which voice). They stay separate because the endpoints are the
 * legacy "custom service" pair, while the selection names a provider whose two
 * faces — answers and calls — carry their own voice fields.
 */

import {
  acceptsTtsVoice, isVoiceProviderId, resolveVoice, voiceProvider,
  type VoiceProviderId,
} from './voice-providers.ts'

/**
 * Storage key of the Voice Settings document.
 *
 * Exported because every reader of that document must name the same key: a
 * second copy is a second chance to misspell it, and a misspelled key fails
 * silently — the settings page would save and the engine would read nothing.
 */
export const VOICE_SETTINGS_STORAGE_KEY = 'dsh.voice.settings'

/**
 * Header naming a per-request endpoint override. Lives here, next to the
 * reader that produces the endpoints, because the two are one contract: the
 * host gateway reads exactly this name back. Every client module that forwards
 * to a configured service sends it, so a second copy would be a second chance
 * to spell it differently and silently fall back to the deployment default.
 */
export const VOICE_URL_HEADER = 'x-dsh-media-url'

/** Header naming the credential that belongs to {@link VOICE_URL_HEADER}. */
export const VOICE_KEY_HEADER = 'x-dsh-media-key'

/** One configured service: where to call and with which credential. */
export interface VoiceEndpoint {
  /** Endpoint URL, or '' when the service is not configured. */
  readonly url: string
  /** API key, or '' when the service needs none. */
  readonly key: string
}

/** Every endpoint the composer and the read-aloud may drive. */
export interface VoiceEndpoints {
  /** Speech-to-text service (dictation and call listening). */
  readonly stt: VoiceEndpoint
  /** Text-to-speech service (answers and the Accessibility read-aloud). */
  readonly tts: VoiceEndpoint
  /** Vision service that analyzes captured screen frames. */
  readonly vision: VoiceEndpoint
  /** WebRTC signaling server for realtime calls, or '' when unconfigured. */
  readonly callSignalingUrl: string
}

/** Whether a call reuses the answer voice or carries its own. */
export type CallVoiceMode = 'same' | 'own'

/** Which provider and which voices the user selected. */
export interface VoiceSelection {
  /** Chosen provider; `auto` lets the engine decide per utterance. */
  readonly provider: VoiceProviderId
  /** Voice for answers (the `tts` face), or '' to take the face default. */
  readonly ttsVoiceId: string
  /** Voice for calls (the `realtime` face), or '' to take the face default. */
  readonly realtimeVoiceId: string
  /** Model the provider needs, or '' when it takes none. */
  readonly ttsModel: string
  /** Speech rate multiplier for answers. */
  readonly ttsSpeed: number
  /** Pitch multiplier for answers. */
  readonly ttsPitch: number
  /** Whether a call reuses the answer voice. */
  readonly callVoiceMode: CallVoiceMode
}

/** Lowest selectable speech rate. */
export const VOICE_SPEED_MIN = 0.5

/** Highest selectable speech rate. */
export const VOICE_SPEED_MAX = 2

/** Lowest selectable pitch multiplier. */
export const VOICE_PITCH_MIN = 0.5

/** Highest selectable pitch multiplier. */
export const VOICE_PITCH_MAX = 2

/** Every selection field at its shipped default. */
export const DEFAULT_VOICE_SELECTION: VoiceSelection = {
  provider: 'auto',
  ttsVoiceId: '',
  realtimeVoiceId: '',
  ttsModel: '',
  ttsSpeed: 1,
  ttsPitch: 1,
  callVoiceMode: 'same',
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
 * Parse the stored Voice Settings document. An unreadable or corrupt document
 * answers null — the same as an absent one, because a foreign writer must never
 * make a settings read throw.
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
 * Read every configured voice endpoint, tolerating a missing or corrupt
 * document field by field.
 * @returns the endpoints, each empty when unconfigured.
 */
export function readVoiceEndpoints(): VoiceEndpoints {
  const record = storedDocument()
  const endpoint = (url: string, key: string): VoiceEndpoint => ({
    url: fieldOf(record, url),
    key: fieldOf(record, key),
  })
  return {
    stt: endpoint('sttUrl', 'sttKey'),
    tts: endpoint('ttsUrl', 'ttsKey'),
    vision: endpoint('visionUrl', 'visionKey'),
    callSignalingUrl: fieldOf(record, 'callSignalingUrl'),
  }
}

/**
 * Clamp one numeric field into its allowed range.
 * @param value - stored value.
 * @param min - lowest allowed value.
 * @param max - highest allowed value.
 * @param fallback - default used when the value is not a finite number.
 * @returns the clamped number.
 */
function numberIn(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/**
 * Read the provider-and-voice selection, validating every field on its own so
 * one damaged field cannot discard the rest of the document.
 * @returns the stored selection, or the defaults when nothing usable is stored.
 */
export function readVoiceSelection(): VoiceSelection {
  const record = storedDocument()
  const raw: Record<string, unknown>
    = typeof record === 'object' && record !== null ? record as Record<string, unknown> : {}
  const provider = fieldOf(record, 'provider')
  const mode = fieldOf(record, 'callVoiceMode')
  return {
    provider: isVoiceProviderId(provider) ? provider : DEFAULT_VOICE_SELECTION.provider,
    ttsVoiceId: fieldOf(record, 'ttsVoiceId'),
    realtimeVoiceId: fieldOf(record, 'realtimeVoiceId'),
    ttsModel: fieldOf(record, 'ttsModel'),
    ttsSpeed: numberIn(raw.ttsSpeed, VOICE_SPEED_MIN, VOICE_SPEED_MAX, DEFAULT_VOICE_SELECTION.ttsSpeed),
    ttsPitch: numberIn(raw.ttsPitch, VOICE_PITCH_MIN, VOICE_PITCH_MAX, DEFAULT_VOICE_SELECTION.ttsPitch),
    callVoiceMode: mode === 'own' ? 'own' : DEFAULT_VOICE_SELECTION.callVoiceMode,
  }
}

/** What the user will hear in a call, relative to the voice that reads answers. */
export type CallVoiceFit =
  /** No provider chosen: the call names no voice and the service decides. */
  | 'unset'
  /** The call carries the very voice the answers use. */
  | 'same'
  /** The call carries the voice chosen separately for calls. */
  | 'own'
  /**
   * The answer voice was asked for, but the service does not offer it for
   * calls, so the call's own default applies. Never silent: the settings page
   * says so, and the same decision is reported here.
   */
  | 'substituted'
  /** The service has no call voice at all, so the call cannot carry one. */
  | 'bridged'

/** Which provider and voice a realtime call should ask for. */
export interface CallVoice {
  /** Provider named on the handshake, or '' when the call names none. */
  readonly provider: string
  /** Voice named on the handshake, or '' when the provider default applies. */
  readonly voice: string
  /** What the user will hear, relative to the answer voice. */
  readonly fit: CallVoiceFit
}

/**
 * Decide which voice a realtime call asks for. A call names its voice on the
 * handshake (a browser cannot set headers on a WebSocket), so this is the one
 * place that turns the stored selection into what the call says.
 *
 * The `same` mode is a *checked* fact, not an assumption: a service whose call
 * catalog is known locally and does not contain the answer voice answers
 * 'substituted' rather than letting the call quietly answer in another voice.
 * @param selection - the stored selection (defaults to the stored document).
 * @returns the provider and voice to name, plus what the user will hear.
 */
export function readCallVoice(selection: VoiceSelection = readVoiceSelection()): CallVoice {
  if (selection.provider === 'auto') return { provider: '', voice: '', fit: 'unset' }
  const provider = voiceProvider(selection.provider)
  if (provider === undefined || provider.realtime === undefined) {
    return { provider: '', voice: '', fit: 'bridged' }
  }
  if (selection.callVoiceMode === 'own') {
    return {
      provider: provider.id,
      voice: resolveVoice(provider, 'realtime', selection.realtimeVoiceId),
      fit: 'own',
    }
  }
  const answerVoice = resolveVoice(provider, 'tts', selection.ttsVoiceId)
  if (acceptsTtsVoice(provider, answerVoice) === 'no') {
    return {
      provider: provider.id,
      voice: resolveVoice(provider, 'realtime', ''),
      fit: 'substituted',
    }
  }
  // 'yes', and 'unknown' — a catalog fetched at runtime can only be answered
  // by the service, so the voice is passed through rather than second-guessed.
  return { provider: provider.id, voice: answerVoice, fit: 'same' }
}

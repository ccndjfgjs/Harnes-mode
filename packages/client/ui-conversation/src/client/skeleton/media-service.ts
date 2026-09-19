/**
 * Voice-service preflight for the composer media controls: before any audio
 * leaves the browser, the toolbar asks which engine to drive. The browser's own
 * Web Speech engines answer first — they need nothing stored — so a stored
 * external service is consulted only when the local one is missing. The stored
 * document is read through the shared voice-endpoint leaf, so the composer,
 * the model seat, and the read-aloud engine all resolve the same endpoints.
 */
import {
  isSpeechRecognitionAvailable, isSpeechSynthesisAvailable,
  readAccessibilitySettings, readVoiceEndpoints,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConversationKey } from '../locales.ts'

/** Which side of the voice dialog the caller is about to use. */
export type VoiceServiceKind =
  /** Dictation mic: hearing only, needs a recognizer. */
  | 'stt'
  /** Full voice call: hearing plus answering, needs a recognizer and a voice. */
  | 'voice'

/** Which engine a media control drives. */
export type VoiceEngine =
  /** The browser's own Web Speech engine: no endpoint and no key. */
  | 'local'
  /** A stored external service: the endpoint and key from the Voice Settings page. */
  | 'remote'

/** Preflight outcome: the engine to drive, or the stub-notice locale key. */
export type VoicePreflight =
  | { readonly ready: true; readonly engine: VoiceEngine }
  | { readonly ready: false; readonly noticeKey: Extract<ConversationKey, 'media.service.unconnected'> }

/** The one unconnected notice; a fresh object per call keeps results immutable. */
function unconnected(): VoicePreflight {
  return { ready: false, noticeKey: 'media.service.unconnected' }
}

/**
 * Check the requested voice service before recording or calling.
 * @param kind - 'stt' for the dictation mic, 'voice' for the full call.
 * @returns the engine to drive, or the stub notice key when neither works.
 */
export function checkVoiceService(kind: VoiceServiceKind): VoicePreflight {
  const hears = isSpeechRecognitionAvailable()
  if (kind === 'stt' ? hears : hears && isSpeechSynthesisAvailable()) {
    return { ready: true, engine: 'local' }
  }
  const { stt, tts } = readVoiceEndpoints()
  const sttReady = stt.url !== '' && stt.key !== ''
  if (kind === 'stt') return sttReady ? { ready: true, engine: 'remote' } : unconnected()
  const ttsReady = tts.url !== '' && tts.key !== ''
  return sttReady && ttsReady ? { ready: true, engine: 'remote' } : unconnected()
}

/**
 * Whether a captured screen frame goes to an external vision service. False
 * selects the local path, where the frame is attached to the composer instead.
 * @returns true only when the stored document names a vision endpoint.
 */
export function hasRemoteVision(): boolean {
  return readVoiceEndpoints().vision.url !== ''
}

/**
 * Whether interface sound notifications are on. Absent or corrupt documents
 * mean on (the shipped default), so a fresh profile still hears confirmations.
 * @returns false only when the stored preference explicitly disables sound.
 */
export function isSoundEnabled(): boolean {
  return readAccessibilitySettings().sound
}

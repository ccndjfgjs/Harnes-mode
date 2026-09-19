/**
 * Voice catalog and preview helpers for the Voice Settings page. The browser
 * never calls a provider directly: the gateway owns the request shapes and the
 * endpoint defaults, so a key typed into this page leaves it only as a
 * per-request header and never lands in a model request or the session log.
 */

import { SPEECH_ROUTE } from '@deepseek-ai/dsh-client-ui-primitives'
import type { VoiceDescriptor, VoiceProviderId } from '@deepseek-ai/dsh-client-ui-primitives'

/** Host route that lists one provider's voices. */
export const VOICES_ROUTE = '/api/media/voices'

/** Header the gateway reads the renderer's credential from. */
const KEY_HEADER = 'x-dsh-media-key'

/** Language the preview asks for. */
const PREVIEW_LANG = 'ru-RU'

/**
 * Ask the gateway for a provider's voice catalog. A provider whose list the
 * client already holds answers an empty list rather than an error.
 * @param provider - provider to ask about.
 * @param key - credential to send, or '' when the provider needs none.
 * @param signal - aborts the request when the user asks again.
 * @returns the entries the provider reports.
 * @throws {Error} when the gateway refuses or the transport fails.
 */
export async function fetchVoices(
  provider: VoiceProviderId,
  key: string,
  signal?: AbortSignal,
): Promise<VoiceDescriptor[]> {
  const response = await fetch(VOICES_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...key === '' ? {} : { [KEY_HEADER]: key } },
    body: JSON.stringify({ provider }),
    ...signal === undefined ? {} : { signal },
  })
  if (!response.ok) throw new Error(`voices HTTP ${response.status}`)
  const payload = await response.json() as { voices?: unknown }
  if (!Array.isArray(payload.voices)) return []
  return payload.voices.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return []
    const record = item as Record<string, unknown>
    if (typeof record.id !== 'string' || record.id === '') return []
    return [{
      id: record.id,
      label: typeof record.label === 'string' && record.label !== '' ? record.label : record.id,
      lang: typeof record.lang === 'string' ? record.lang : '',
    }]
  })
}

/** One voice to try out. */
export interface PreviewRequest {
  /** Provider whose adapter shapes the request. */
  readonly provider: VoiceProviderId
  /** Voice to hear, or '' for the provider default. */
  readonly voice: string
  /** Provider model, or '' when none applies. */
  readonly model: string
  /** Speech rate multiplier. */
  readonly speed: number
  /** Pitch multiplier. */
  readonly pitch: number
  /** Credential, or '' when the provider needs none. */
  readonly key: string
  /** Text to speak. */
  readonly text: string
}

/**
 * Speak one short phrase in the chosen voice, so the user hears the selection
 * before saving it. Nothing is stored: the clip is played and released.
 * @param request - what to say, in which voice.
 * @throws {Error} when the gateway refuses or the runtime cannot play audio.
 */
export async function previewVoice(request: PreviewRequest): Promise<void> {
  const response = await fetch(SPEECH_ROUTE, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...request.key === '' ? {} : { [KEY_HEADER]: request.key },
    },
    body: JSON.stringify({
      text: request.text,
      lang: PREVIEW_LANG,
      provider: request.provider,
      voice: request.voice,
      model: request.model,
      speed: request.speed,
      pitch: request.pitch,
    }),
  })
  if (!response.ok) throw new Error(`preview HTTP ${response.status}`)
  const clip = await response.blob()
  const url = URL.createObjectURL(clip)
  const element = new Audio(url)
  // Revoking on 'ended' keeps the clip alive for its whole duration; a browser
  // that refuses autoplay is reported rather than leaving the URL behind.
  element.addEventListener('ended', () => { URL.revokeObjectURL(url) }, { once: true })
  try {
    await element.play()
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  }
}

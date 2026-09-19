/**
 * Voice Settings plugin, browser half: the Voice navigation section holding
 * the STT/TTS connection cards and the read-aloud voice card (service, answer
 * voice, call voice). The page persists to browser-local storage (see
 * voice-settings.ts); the composer voice buttons preflight against the same
 * document before sending any audio.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section'
// entry) into this program so the registration below typechecks.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the renderer-owned slots service.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { VoiceSection } from './VoiceSection.tsx'
import type { VoiceSectionInjected } from './VoiceSection.tsx'
import { en, ru, zh, type VoiceSettingsKey } from './locales.ts'

export { VoiceSection } from './VoiceSection.tsx'
export type { VoiceSectionInjected, VoiceSectionProps } from './VoiceSection.tsx'
export {
  isCallConfigured,
  isVisionConfigured,
  isVoiceConfigured,
  isSttConfigured,
  readVoiceSettings,
  writeVoiceSettings,
} from './voice-settings.ts'
export type { VoiceSettings } from './voice-settings.ts'
export type { VoiceSettingsKey } from './locales.ts'
export { VOICES_ROUTE, fetchVoices, previewVoice } from './voice-catalog.ts'
export type { PreviewRequest } from './voice-catalog.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Voice Settings page copy. */
    'settings.voice': VoiceSettingsKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.voice'

/** Required services: the section slot and the locale registry. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: register dictionaries, then the Voice section once its
 * declarer is up.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ru }), 'ui-settings-voice: dictionaries')

  const t = ctx.locale.bind(NS) as VoiceSectionInjected['t']
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'voice',
    order: 25,
    label: () => t('nav'),
    locale: NS,
    inject: (): VoiceSectionInjected => ({ t }),
  }, VoiceSection))
}

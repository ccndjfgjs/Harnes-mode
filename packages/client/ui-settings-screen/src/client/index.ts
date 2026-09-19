/**
 * Screen Broadcast settings plugin, browser half: the Screen Broadcast
 * navigation section with the broadcast/interval/preview/quality/audio cards.
 * The page persists to browser-local storage (see screen-settings.ts); the
 * composer screen button consumes the stored document.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section'
// entry) into this program so the registration below typechecks.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the renderer-owned slots service.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { ScreenSection } from './ScreenSection.tsx'
import type { ScreenSectionInjected } from './ScreenSection.tsx'
import { en, ru, zh, type ScreenSettingsKey } from './locales.ts'

export { ScreenSection } from './ScreenSection.tsx'
export type { ScreenSectionInjected, ScreenSectionProps } from './ScreenSection.tsx'
export {
  DEFAULT_SCREEN_SETTINGS, MAX_EDGE_CHOICES, PREVIEW_CORNERS,
  SCREEN_SETTINGS_STORAGE_KEY, readScreenSettings, writeScreenSettings,
} from './screen-settings.ts'
export type { ScreenSettings } from './screen-settings.ts'
export type { ScreenSettingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Screen Broadcast page copy. */
    'settings.screen': ScreenSettingsKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.screen'

/** Required services: the section slot and the locale registry. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: register dictionaries, then the Screen Broadcast
 * section once its declarer is up.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ru }), 'ui-settings-screen: dictionaries')

  const t = ctx.locale.bind(NS) as ScreenSectionInjected['t']
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'screen',
    order: 27,
    label: () => t('nav'),
    locale: NS,
    inject: (): ScreenSectionInjected => ({ t }),
  }, ScreenSection))
}

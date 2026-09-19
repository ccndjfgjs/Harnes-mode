/**
 * About Settings plugin, browser half: the About navigation section holding
 * the mod story — mission, differences from the official build, and the
 * accessibility commitments. Read-only page: no persistence behind it.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section'
// entry) into this program so the registration below typechecks.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the renderer-owned slots service.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { AboutSection } from './AboutSection.tsx'
import type { AboutSectionInjected } from './AboutSection.tsx'
import { en, ru, zh, type AboutSettingsKey } from './locales.ts'

export { AboutSection } from './AboutSection.tsx'
export type { AboutSectionInjected, AboutSectionProps } from './AboutSection.tsx'
export type { AboutSettingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The About Settings page copy. */
    'settings.about': AboutSettingsKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.about'

/** Required services: the section slot and the locale registry. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: register dictionaries, then the About section once its
 * declarer is up.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ru }), 'ui-settings-about: dictionaries')

  const t = ctx.locale.bind(NS) as AboutSectionInjected['t']
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'about',
    order: 40,
    label: () => t('nav'),
    locale: NS,
    inject: (): AboutSectionInjected => ({ t }),
  }, AboutSection))
}

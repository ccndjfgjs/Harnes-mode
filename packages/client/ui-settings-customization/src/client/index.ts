/**
 * Customization settings plugin, browser half: the Customization navigation
 * section with theme/font/accent/density/messages/background cards. The page
 * persists to browser-local storage (see customization-settings.ts) and
 * applies on save: root attributes directly, theme/font through the theme
 * service (which stays the live authority for those DOM fields).
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section'
// entry) into this program so the registration below typechecks.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the renderer-owned slots service.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the theme service merge (ctx.theme).
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { CustomizationSection } from './CustomizationSection.tsx'
import type { CustomizationLiveAppearance, CustomizationSectionInjected } from './CustomizationSection.tsx'
import { applyCustomizationSettings } from './apply-customization.ts'
import { readCustomizationSettings } from './customization-settings.ts'
import { en, ru, zh, type CustomizationSettingsKey } from './locales.ts'

export { CustomizationSection } from './CustomizationSection.tsx'
export type {
  CustomizationLiveAppearance, CustomizationSectionInjected, CustomizationSectionProps,
} from './CustomizationSection.tsx'
export { applyCustomizationSettings, retractCustomizationSettings } from './apply-customization.ts'
export { readCustomizationSettings, writeCustomizationSettings } from './customization-settings.ts'
export type { CustomizationSettings, CustomizationTheme } from './customization-settings.ts'
export type { CustomizationSettingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Customization page copy. */
    'settings.customization': CustomizationSettingsKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.customization'

/** Required services: the section slot, the locale registry, and the theme service. */
export const inject = ['slots', 'locale', 'theme']

/**
 * Client plugin body: project the stored root attributes, register
 * dictionaries, then the Customization section once its declarer is up.
 * Theme/font are not pushed at boot: the Host settings scope is the boot
 * authority and the theme service already adopted it.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  try {
    if (typeof document !== 'undefined') applyCustomizationSettings(readCustomizationSettings())
  } catch {
    // Best-effort presentation (missing storage in non-browser runs): the save path applies again.
  }
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ru }), 'ui-settings-customization: dictionaries')

  const t = ctx.locale.bind(NS) as CustomizationSectionInjected['t']
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'customization',
    order: 35,
    label: () => t('nav'),
    locale: NS,
    inject: (): CustomizationSectionInjected => ({
      t,
      getLiveAppearance: () => {
        const snapshot = ctx.theme.getTheme()
        return { theme: snapshot.preference, fontSize: snapshot.fontSize }
      },
      applyLive: ({ theme, fontSize }: CustomizationLiveAppearance) => {
        ctx.theme.setTheme(theme)
        ctx.theme.setFontSize(fontSize)
      },
    }),
  }, CustomizationSection))
}

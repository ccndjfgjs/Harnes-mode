/**
 * Accessibility settings plugin, browser half: the Accessibility navigation
 * section with the reading/sound/font/filter/contrast cards. The page
 * persists to browser-local storage (see accessibility-settings.ts); feature
 * behavior consumes the stored document.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section'
// entry) into this program so the registration below typechecks.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the renderer-owned slots service.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { AccessibilitySection } from './AccessibilitySection.tsx'
import type { AccessibilitySectionInjected } from './AccessibilitySection.tsx'
import { applyAccessibilitySettings } from './apply-accessibility.ts'
import { readAccessibilitySettings } from '@deepseek-ai/dsh-client-ui-primitives'
import { en, ru, zh, type AccessibilitySettingsKey } from './locales.ts'

export { AccessibilitySection } from './AccessibilitySection.tsx'
export type { AccessibilitySectionInjected, AccessibilitySectionProps } from './AccessibilitySection.tsx'
export { readAccessibilitySettings, writeAccessibilitySettings } from '@deepseek-ai/dsh-client-ui-primitives'
export type { AccessibilitySettings } from '@deepseek-ai/dsh-client-ui-primitives'
export type { AccessibilitySettingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Accessibility page copy. */
    'settings.accessibility': AccessibilitySettingsKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.accessibility'

/** Required services: the section slot and the locale registry. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: project the stored font/contrast attributes, register
 * dictionaries, then the Accessibility section once its declarer is up.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  try {
    if (typeof document !== 'undefined') applyAccessibilitySettings(readAccessibilitySettings())
  } catch {
    // Best-effort presentation (missing storage in non-browser runs): the save path applies again.
  }
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ru }), 'ui-settings-accessibility: dictionaries')

  const t = ctx.locale.bind(NS) as AccessibilitySectionInjected['t']
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'accessibility',
    order: 30,
    label: () => t('nav'),
    locale: NS,
    inject: (): AccessibilitySectionInjected => ({ t }),
  }, AccessibilitySection))
}

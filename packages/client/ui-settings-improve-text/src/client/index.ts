/**
 * Improve-text Settings plugin, browser half: the scanner card with the
 * display-only model list, and the voice announce toggle. The page owns no
 * model selection anymore: the button answers on the chat's own model, and
 * this page only shows which routes would answer (badges) and whether the
 * outcome is read aloud.
 *
 * The provider roster comes from the same Host catalog the Models section
 * reads, so a provider present on one page is present on the other.
 * Export discipline: packages/client/AGENTS.md.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section'
// entry) into this program so the registration below typechecks.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the renderer-owned slots service.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the ctx.remote merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { ImproveTextSection } from './ImproveTextSection.tsx'
import type { ImproveTextSectionInjected } from './ImproveTextSection.tsx'
import { createRosterStore, loadRoster } from './roster.ts'
import type { ImproveTextOperations } from './roster.ts'
import { en, ru, zh, type ImproveTextKey } from './locales.ts'

export { ImproveTextSection } from './ImproveTextSection.tsx'
export type { ImproveTextSectionInjected, ImproveTextSectionProps } from './ImproveTextSection.tsx'
export {
  decodeImproveText,
  improveTextOps,
  improveTextView,
  IMPROVE_TEXT_SETTINGS_NAMESPACE,
} from './improve-text-settings.ts'
export type { ImproveTextScope, ImproveTextSettings, ImproveTextView } from './improve-text-settings.ts'
export { createRosterStore, deriveKeyRef, loadRoster, providerUsable } from './roster.ts'
export type {
  ImproveTextOperations, ImproveTextProvider, ImproveTextRosterActions, ImproveTextRosterState,
  ImproveTextRosterStore,
} from './roster.ts'
export type { ImproveTextKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Improve-text Settings page copy. */
    'settings.improve-text': ImproveTextKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.improve-text'

/**
 * Required services: the section slot, the locale registry, and the Remote
 * namespaces the roster reads through. The page writes nothing: the voice
 * toggle lives in this browser's localStorage, so no settings scope is bound.
 */
export const inject = [
  'slots', 'locale', 'remote', 'remote.credentials', 'remote.session',
]

/**
 * Client plugin body: register dictionaries and the roster store, then
 * register the section once its declarer is up.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ru }), 'ui-settings-improve-text: dictionaries')

  const operations: ImproveTextOperations = {
    modelCatalog: async () => {
      const response = await ctx.remote.session.modelCatalog()
      return response.ok
        ? { ok: true, value: response.value }
        : { ok: false, message: response.error.message }
    },
    describeCredential: async (ref) => {
      const response = await ctx.remote.credentials.describe([ref])
      return response.ok ? response.value[ref] : undefined
    },
  }
  const rosterStore = createRosterStore()
  const t = ctx.locale.bind(NS) as ImproveTextSectionInjected['t']

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'improve-text',
    order: 12,
    label: () => t('nav'),
    locale: NS,
    store: rosterStore,
    inject: (): ImproveTextSectionInjected => {
      // The store declaration above binds one instance per entry x scope; the
      // inject factory is where that live instance is reachable, so the load
      // path takes its engine from here rather than owning state of its own.
      const instance = rosterStore.create()
      return {
        t,
        loadRoster: () => { void loadRoster(instance, operations) },
      }
    },
  }, ImproveTextSection))
}

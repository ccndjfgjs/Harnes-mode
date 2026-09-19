/**
 * Accounts Settings plugin, browser half: the Accounts navigation section
 * holding the Authorization card and the per-cloud OAuth 2.0 connect cards,
 * plus the `/cloud` trigger source. The page persists to browser-local
 * storage (see accounts-settings.ts); the source reads the same document, so
 * a just-authorized cloud appears in the Commands menu without a reload.
 * Everything lives in this package so the browser bundle keeps its plugin
 * boundary (cross-plugin value imports never reach the client build).
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section'
// entry) into this program so the registration below typechecks.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the trigger registry's Context merge (ctx.inputTriggers).
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
// Type-only: pulls the renderer-owned slots service.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { InputTriggerServiceContract } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { AccountsSection } from './AccountsSection.tsx'
import type { AccountsSectionInjected } from './AccountsSection.tsx'
import { createCloudSource } from './cloud/cloud-source.ts'
import { en as cloudEn, ru as cloudRu, zh as cloudZh, type CloudKey } from './cloud/cloud-locales.ts'
import { en, ru, zh, type AccountsSettingsKey } from './locales.ts'

export { AccountsSection } from './AccountsSection.tsx'
export type { AccountsSectionInjected, AccountsSectionProps } from './AccountsSection.tsx'
export {
  isAnyAccountConnected,
  isProviderConnected,
  listConnected,
  readAccountsSettings,
  writeProviderSettings,
} from './accounts-settings.ts'
export type {
  AccountProviderId,
  AccountsSettings,
  ConnectedAccount,
  MegaAccountState,
  OAuthAccountState,
  OAuthProviderId,
  ProviderAccountState,
} from './accounts-settings.ts'
export { ACCOUNT_PROVIDER_IDS, buildAuthorizeUrl, createPkcePair, DEFAULT_CLIENT_IDS, exchangeCodeForToken, getAccountsBridge, isOAuthProvider, OAUTH_PROVIDERS } from './providers.ts'
export type { AccountsSettingsKey } from './locales.ts'
export type {
  AccountsOAuthDevice,
  AccountsOAuthDone,
  AccountsOAuthError,
  AccountsOAuthStartResult,
  ElectronAccountsBridge,
  OAuthProviderDescriptor,
  TokenExchangeResult,
} from './providers.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Accounts Settings page copy. */
    'settings.accounts': AccountsSettingsKey
    /** The cloud trigger source copy. */
    'cloud': CloudKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.accounts'

/** Dictionary namespace of the cloud trigger source. */
const CLOUD_NS = 'cloud'

/** Required services: the section slot, the trigger registry, and the locale registry. */
export const inject = ['slots', 'inputTriggers', 'locale']

/**
 * Client plugin body: register dictionaries, then the Accounts section once
 * its declarer is up, plus the `/cloud` trigger source.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ru }), 'ui-settings-accounts: dictionaries')
  ctx.effect(() => ctx.locale.register(CLOUD_NS, { zh: cloudZh, en: cloudEn, ru: cloudRu }), 'ui-settings-accounts: cloud dictionaries')

  const t = ctx.locale.bind(NS) as AccountsSectionInjected['t']
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'accounts',
    order: 26,
    label: () => t('nav'),
    locale: NS,
    inject: (): AccountsSectionInjected => ({ t }),
  }, AccountsSection))

  const cloudT = ctx.locale.bind(CLOUD_NS) as (key: CloudKey) => string
  const source = createCloudSource(cloudT, provider => t(`provider.${provider}`))
  const inputTriggers = ctx.get('inputTriggers') as InputTriggerServiceContract | undefined
  if (inputTriggers === undefined) throw new Error('ui-settings-accounts: trigger registry unavailable')
  ctx.effect(() => inputTriggers.registerSource(source), 'ui-settings-accounts: /cloud source')
}

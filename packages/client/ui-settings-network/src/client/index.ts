/**
 * Network settings plugin, browser half: the Network navigation section with the
 * tunnel card and the server list.
 *
 * The tunnel itself lives in the desktop shell (see v2ray-bridge.ts); this page
 * edits the document the shell reads at startup. In a plain browser the bridge is
 * absent and the section explains that rather than offering dead controls.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section'
// entry) into this program so the registration below typechecks.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the renderer-owned slots service.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { NetworkSection } from './NetworkSection.tsx'
import type { NetworkSectionInjected } from './NetworkSection.tsx'
import { en, ru, zh, type NetworkSettingsKey } from './locales.ts'

export { NetworkSection } from './NetworkSection.tsx'
export type { NetworkSectionInjected, NetworkSectionProps } from './NetworkSection.tsx'
export { v2rayBridge, bridgeErrorMessage } from './v2ray-bridge.ts'
export type { V2RayBridge, V2RayServer, V2RaySettings, V2RayStatus, V2RayTestResult } from './v2ray-bridge.ts'
export type { NetworkSettingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Network page copy. */
    'settings.network': NetworkSettingsKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.network'

/** Required services: the section slot and the locale registry. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: register dictionaries, then the Network section once its
 * declarer is up.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ru }), 'ui-settings-network: dictionaries')

  const t = ctx.locale.bind(NS) as NetworkSectionInjected['t']
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'network',
    order: 28,
    label: () => t('nav'),
    locale: NS,
    inject: (): NetworkSectionInjected => ({ t }),
  }, NetworkSection))
}

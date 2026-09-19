/**
 * The Improve-text page's durable selection, as this package reads and writes
 * it.
 *
 * The namespace is the Host plugin's own (`draft-restructure`), not this
 * page's invention, so the section edits the very document the button reads
 * at call time. Both halves of the pair are written together and an exact
 * empty pair is written as an exact empty pair: that is the value the Host
 * reads as "no choice", and it is what restores the Agent-default fallback.
 */

import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'

/** Settings namespace the Host plugin registers for this button. */
export const IMPROVE_TEXT_SETTINGS_NAMESPACE = 'draft-restructure'

/**
 * The improvement the user configured. Empty strings mean "no choice of its
 * own", which is the state the button answers on the Agent default from.
 */
export interface ImproveTextSettings {
  /** Registered provider route, or '' when nothing is chosen. */
  provider: string
  /** Provider-owned model id, or '' when nothing is chosen. */
  model: string
}

/** Detached reading of the bound scope. */
export interface ImproveTextView extends ImproveTextSettings {
  /** Whether the Host document accepts writes. */
  writable: boolean
  /** Whether a choice is stored (either half present). */
  chosen: boolean
}

/** What this page reads through the bound namespace scope. */
export type ImproveTextScope = SettingsScope<ImproveTextSettings>
/** What this page observes through the bound namespace scope. */
export type ImproveTextSnapshot = SettingsScopeSnapshot<ImproveTextSettings>

const EMPTY: ImproveTextSettings = { provider: '', model: '' }

/**
 * Narrow one wire section to the two fields this page owns. The Host schema
 * resolves missing keys through their defaults, so a section stored by an
 * older build (or hand-edited) still reads as a pair.
 * @param section - the schema-resolved wire value, or undefined before the first read.
 * @returns the detached pair, empty when nothing is stored.
 */
export function decodeImproveText(section: unknown): ImproveTextSettings {
  if (typeof section !== 'object' || section === null || Array.isArray(section)) return { ...EMPTY }
  const record = section as { provider?: unknown; model?: unknown }
  return {
    provider: typeof record.provider === 'string' ? record.provider : '',
    model: typeof record.model === 'string' ? record.model : '',
  }
}

/**
 * Project one scope snapshot into what the page renders.
 * @param snapshot - the bound scope's current snapshot.
 * @returns the pair plus the page's two derived facts.
 */
export function improveTextView(
  snapshot: SettingsScopeSnapshot<ImproveTextSettings>,
): ImproveTextView {
  const value = snapshot.value ?? EMPTY
  return {
    provider: value.provider,
    model: value.model,
    writable: snapshot.writable,
    chosen: value.provider !== '' && value.model !== '',
  }
}

/**
 * The path ops that store one whole choice.
 *
 * A blank half is written as an explicit empty string rather than unset: the
 * two fields are one decision, and a stored `{ provider: 'x' }` left over from
 * a half-finished edit would make the Host refuse the section under its
 * both-or-neither rule. Writing both keeps the document in a state the Host
 * itself validated.
 * @param next - the pair to store; both halves empty clears the choice.
 * @returns ordered path ops for one namespace mutation.
 */
export function improveTextOps(next: ImproveTextSettings): SettingsPathOpView[] {
  return [
    { op: 'set', path: ['provider'], value: next.provider },
    { op: 'set', path: ['model'], value: next.model },
  ]
}

/** The empty pair, for a caller that clears the choice without reading the scope. */
export const EMPTY_IMPROVE_TEXT_SETTINGS: ImproveTextSettings = EMPTY

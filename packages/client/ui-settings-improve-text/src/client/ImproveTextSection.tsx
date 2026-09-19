/**
 * The Improve-text settings page: which provider and model the composer
 * "Improve text" button answers on.
 *
 * The page is a preference editor, not a provider manager. It offers the
 * providers the Host already serves — the same roster the Models page shows —
 * and points at that page for adding one or entering its key. Duplicating the
 * provider form here would let the two pages disagree about what a provider
 * is, which is exactly the failure this shape avoids.
 *
 * An unmade choice is a real state, not an error: the page says plainly that
 * the button is running on the default model, and "Reset to default" returns
 * to it.
 *
 * The two live facts arrive through the framework's own channels — the
 * settings namespace through the bound scope, the provider roster through the
 * declared store — so the component carries no subscription of its own.
 */

import { useState } from 'react'
import type { ChangeEvent, ReactNode } from 'react'
import type { InjectFace, PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ImproveTextKey } from './locales.ts'
import type { ImproveTextProvider } from './roster.ts'
import type { ImproveTextScope } from './improve-text-settings.ts'
import { improveTextOps, improveTextView } from './improve-text-settings.ts'
import type { createRosterStore } from './roster.ts'
import css from './ImproveTextSection.module.css'

/** The roster store handle this section declares at registration. */
type RosterHandle = ReturnType<typeof createRosterStore>

/** Business callbacks injected into the section (locale-bound copy and the scope). */
export interface ImproveTextSectionInjected {
  /** Translate one Improve-text key. */
  t: (key: ImproveTextKey) => string
  /** The bound settings namespace scope (read through its snapshot, written through `mutate`). */
  scope: ImproveTextScope
  /** Load the roster once per session, repeated only on demand. */
  loadRoster: () => void
}

/**
 * Full component props: the section owner share, the store share the
 * declaration derives, and the injected face.
 */
export type ImproveTextSectionProps = PropsRuntime<'settings.section'>
  & PropsRenderSlots<never>
  & PropsStore<RosterHandle>
  & Partial<InjectFace<ImproveTextSectionInjected>>

/**
 * Render the Improve-text settings page.
 * @param props - slot-delivered injected dependencies.
 * @returns the section, or null while the shell has not injected yet.
 */
export function ImproveTextSection(props: ImproveTextSectionProps): ReactNode {
  const { t, scope, useStore, loadRoster } = props
  // The store share is not part of the optional injected face: the engine
  // derives it from the declared handle, so only the injected callbacks are
  // guarded against a shell that has not run yet.
  if (t === undefined || scope === undefined || loadRoster === undefined) return null
  return <Loaded t={t} scope={scope} useStore={useStore} loadRoster={loadRoster} />
}

/** One mounted page, once every injected face is present. */
function Loaded({
  t, scope, useStore, loadRoster,
}: {
  t: (key: ImproveTextKey) => string
  scope: ImproveTextScope
  useStore: PropsStore<RosterHandle>['useStore']
  loadRoster: () => void
}): ReactNode {
  const roster = useStore(snapshot => snapshot)
  // The namespace snapshot is read once per render: the scope is the framework
  // hook's own source, and re-rendering follows the settings invalidation the
  // mirror already subscribes to.
  const settings = improveTextView(scope.getSnapshot())
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [saved, setSaved] = useState(false)
  // The draft is the page's own: the selects must show the field the user is
  // editing before it is written, and a pushed namespace refresh must not yank
  // a picker out from under a choice that is still being made.
  const [draftProvider, setDraftProvider] = useState<string | undefined>(undefined)
  const [draftModel, setDraftModel] = useState<string | undefined>(undefined)

  const provider = draftProvider ?? settings.provider
  const model = draftModel ?? settings.model
  const selected = roster.providers.find(entry => entry.provider === provider)
  const dirty = provider !== settings.provider || model !== settings.model

  if (roster.status === 'idle') loadRoster()

  const commit = (nextProvider: string, nextModel: string): void => {
    setBusy(true)
    setFailure(undefined)
    setSaved(false)
    void scope.mutate(improveTextOps({ provider: nextProvider, model: nextModel }))
      .then(() => {
        setDraftProvider(undefined)
        setDraftModel(undefined)
        setSaved(true)
        // The committed value is what the status line reads, so a fresh roster
        // read keeps the "no key" hint honest about the route just chosen.
        loadRoster()
      })
      .catch((error: unknown) => {
        setFailure(error instanceof Error ? error.message : String(error))
      })
      .finally(() => { setBusy(false) })
  }

  const chooseProvider = (event: ChangeEvent<HTMLSelectElement>): void => {
    setSaved(false)
    // A provider swap clears the model: the old id belongs to the provider
    // being left, and the Host refuses a pair whose halves disagree.
    setDraftProvider(event.target.value)
    setDraftModel('')
  }

  const chooseModel = (event: ChangeEvent<HTMLSelectElement>): void => {
    setSaved(false)
    setDraftModel(event.target.value)
  }

  const disabled = busy || !settings.writable

  return (
    <div className={css.section}>
      <h2 className={css.title}>{t('title')}</h2>
      <p className={css.description}>{t('description')}</p>
      {settings.writable ? null : <p className={css.notice}>{t('readOnly')}</p>}

      {roster.status === 'error'
        ? (
          <div className={css.card}>
            <p className={css.error}>{`${t('loadFailed')}: ${roster.error ?? ''}`}</p>
            <Button variant="outline" onClick={loadRoster}>{t('retry')}</Button>
          </div>
        )
        : null}

      <section className={css.card} aria-label={t('provider.title')}>
        <h3 className={css.cardTitle}>{t('provider.title')}</h3>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('provider.label')}</span>
          <select
            className={css.fieldInput}
            value={provider}
            aria-label={t('provider.label')}
            disabled={disabled || roster.status !== 'ready'}
            onChange={chooseProvider}
          >
            <option value="">{t('provider.none')}</option>
            {roster.providers.map(entry => (
              <option key={entry.provider} value={entry.provider}>
                {entry.usable ? entry.displayName : `${entry.displayName} — ${t('provider.unusable')}`}
              </option>
            ))}
          </select>
        </label>
        <p className={css.hint}>{t('provider.hint')}</p>
        {roster.failures.length === 0
          ? null
          : (
            <ul className={css.failures}>
              {roster.failures.map(item => <li key={item} className={css.hint}>{item}</li>)}
            </ul>
          )}
      </section>

      <section className={css.card} aria-label={t('model.title')}>
        <h3 className={css.cardTitle}>{t('model.title')}</h3>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('model.label')}</span>
          <select
            className={css.fieldInput}
            value={model}
            aria-label={t('model.label')}
            disabled={disabled || selected === undefined}
            onChange={chooseModel}
          >
            <option value="">{selected === undefined ? t('model.empty') : t('provider.none')}</option>
            {selected?.models.map(entry => (
              <option key={entry.id} value={entry.id}>{entry.name}</option>
            ))}
          </select>
        </label>
        <p className={css.hint}>{t('model.hint')}</p>
      </section>

      <section className={css.card} aria-label={t('status.title')}>
        <h3 className={css.cardTitle}>{t('status.title')}</h3>
        <p className={settings.chosen ? css.stateOk : css.hint}>
          {settings.chosen
            ? `${t('status.chosen')}${providerName(roster.providers, settings.provider)} / ${settings.model}`
            : t('status.fallback')}
        </p>
        {settings.chosen && !selectedUsable(roster.providers, settings.provider)
          ? <p className={css.stateWarn}>{t('status.unusable')}</p>
          : null}
      </section>

      {failure === undefined ? null : <p className={css.error}>{failure}</p>}
      {!saved ? null : <p className={css.saved} role="status" aria-live="polite">{t('saved')}</p>}

      <div className={css.actions}>
        <Button variant="outline" disabled={disabled || !dirty} onClick={() => { commit(provider, model) }}>
          {busy ? t('saving') : t('save')}
        </Button>
        <Button
          variant="outline"
          disabled={disabled || !settings.chosen}
          onClick={() => {
            setDraftProvider(undefined)
            setDraftModel(undefined)
            commit('', '')
          }}
        >
          {t('clear')}
        </Button>
      </div>
    </div>
  )
}

/** One provider's display name, falling back to its route id. */
function providerName(providers: readonly ImproveTextProvider[], provider: string): string {
  return providers.find(entry => entry.provider === provider)?.displayName ?? provider
}

/** Whether one provider route can currently answer. */
function selectedUsable(providers: readonly ImproveTextProvider[], provider: string): boolean {
  return providers.find(entry => entry.provider === provider)?.usable === true
}

/**
 * The Improve-text settings page, second edition: the old provider/model
 * picker card is gone (it showed an empty roster and could not save), and the
 * page now holds two honest things — a model scanner with a display-only
 * list, and the voice announce toggle.
 *
 * The scan reads the same Host catalog and credential states the Models page
 * reads and only displays them: every option in the list is disabled, so the
 * dropdown opens for viewing and selects nothing. Badges come from the one
 * shared rule (star = works live, mail = batch only, question = no key).
 *
 * The voice toggle is browser-local (no Host namespace, no save button): the
 * composer button reads it at call time together with the global voice gate.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button, modelSupportBadge, readImproveAnnounce, readImproveReadAloud,
  writeImproveAnnounce, writeImproveReadAloud,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ImproveTextKey } from './locales.ts'
import type { ImproveTextRosterState } from './roster.ts'
import type { createRosterStore } from './roster.ts'
import css from './ImproveTextSection.module.css'

/** The roster store handle this section declares at registration. */
type RosterHandle = ReturnType<typeof createRosterStore>

/** Business callbacks injected into the section (locale-bound copy and the scan). */
export interface ImproveTextSectionInjected {
  /** Translate one Improve-text key. */
  t: (key: ImproveTextKey) => string
  /** Reload the roster from the Host catalog and credential states. */
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
  const { t, useStore, loadRoster } = props
  if (t === undefined || loadRoster === undefined) return null
  return <Loaded t={t} useStore={useStore} loadRoster={loadRoster} />
}

/** One mounted page, once every injected face is present. */
function Loaded({
  t, useStore, loadRoster,
}: {
  t: (key: ImproveTextKey) => string
  useStore: PropsStore<RosterHandle>['useStore']
  loadRoster: () => void
}): ReactNode {
  const roster = useStore((snapshot: ImproveTextRosterState) => snapshot)
  const [announce, setAnnounce] = useState<boolean>(() => readImproveAnnounce())
  const [readAloud, setReadAloud] = useState<boolean>(() => readImproveReadAloud())

  if (roster.status === 'idle') loadRoster()

  const toggleAnnounce = (): void => {
    const next = !announce
    setAnnounce(next)
    writeImproveAnnounce(next)
  }

  const toggleReadAloud = (): void => {
    const next = !readAloud
    setReadAloud(next)
    writeImproveReadAloud(next)
  }

  return (
    <div className={css.section}>
      <h2 className={css.title}>{t('title')}</h2>
      <p className={css.description}>{t('description')}</p>

      <section className={css.card} aria-label={t('scan.title')}>
        <h3 className={css.cardTitle}>{t('scan.title')}</h3>
        {roster.status === 'error'
          ? <p className={css.error}>{`${t('loadFailed')}: ${roster.error ?? ''}`}</p>
          : null}
        <div className={css.actions}>
          <Button
            variant="outline"
            onClick={loadRoster}
            disabled={roster.status === 'loading'}
          >
            {roster.status === 'loading' ? t('scan.scanning') : t('scan.button')}
          </Button>
          {roster.status === 'error'
            ? <Button variant="outline" onClick={loadRoster}>{t('retry')}</Button>
            : null}
        </div>
        {roster.failures.length === 0
          ? null
          : (
            <ul className={css.failures}>
              {roster.failures.map(item => <li key={item} className={css.hint}>{item}</li>)}
            </ul>
          )}
      </section>

      <section className={css.card} aria-label={t('list.label')}>
        <h3 className={css.cardTitle}>{t('list.label')}</h3>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('list.label')}</span>
          <select
            className={css.fieldInput}
            aria-label={t('list.label')}
            value=""
            onChange={() => {}}
          >
            <option value="" disabled>{t('list.placeholder')}</option>
            {roster.providers.map(group => (
              <optgroup key={group.provider} label={group.displayName}>
                {group.models.map(model => (
                  <option key={model.id} value={model.id} disabled>
                    {`${model.name} ${modelSupportBadge(model.id, model.name, group.usable)}`}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <p className={css.hint}>{t('list.hint')}</p>
        {roster.status === 'ready' && roster.providers.length === 0
          ? <p className={css.hint}>{t('list.empty')}</p>
          : null}
      </section>

      <section className={css.card} aria-label={t('voice.title')}>
        <h3 className={css.cardTitle}>{t('voice.title')}</h3>
        <label className={css.option}>
          <input
            type="checkbox"
            checked={announce}
            onChange={toggleAnnounce}
            aria-label={t('voice.label')}
          />
          {t('voice.label')}
        </label>
        <label className={css.option}>
          <input
            type="checkbox"
            checked={readAloud}
            onChange={toggleReadAloud}
            aria-label={t('voice.readAloud')}
          />
          {t('voice.readAloud')}
        </label>
        <p className={css.hint}>{t('voice.hint')}</p>
      </section>
    </div>
  )
}

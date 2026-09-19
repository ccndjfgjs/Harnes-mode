/** The About Settings page: mission, differences from the official build, accessibility. */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AboutSettingsKey } from './locales.ts'
import css from './AboutSection.module.css'

/** Business callbacks injected into the About section (locale-bound copy). */
export interface AboutSectionInjected {
  /** Translate one About Settings key. */
  t: (key: AboutSettingsKey) => string
}

/** Full component props: section owner share plus the injected copy face. */
export type AboutSectionProps = PropsRuntime<'settings.section'> & AboutSectionInjected

/**
 * Render the About Settings template: the mission lead, the comparison with
 * the official build, the accessibility commitments, and the status note.
 * @param props - section owner share plus the injected copy face.
 * @returns the section element tree.
 */
export function AboutSection({ t }: AboutSectionProps) {
  return (
    <div className={css.section}>
      <p className={css.lead}>{t('lead')}</p>
      <section className={css.card} aria-label={t('author.title')}>
        <h3 className={css.cardTitle}>{t('author.title')}</h3>
        <p className={css.author}>{t('author.name')}</p>
      </section>
      <section className={css.card} aria-label={t('diff.title')}>
        <h3 className={css.cardTitle}>{t('diff.title')}</h3>
        <p className={css.body}>{t('diff.body')}</p>
      </section>
      <section className={css.card} aria-label={t('access.title')}>
        <h3 className={css.cardTitle}>{t('access.title')}</h3>
        <ul className={css.list}>
          <li>{t('access.point.voice')}</li>
          <li>{t('access.point.speech')}</li>
          <li>{t('access.point.display')}</li>
        </ul>
      </section>
      <section className={css.card} aria-label={t('status.title')}>
        <h3 className={css.cardTitle}>{t('status.title')}</h3>
        <p className={css.body}>{t('status.body')}</p>
      </section>
    </div>
  )
}

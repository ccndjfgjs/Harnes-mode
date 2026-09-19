/** The Customization page: theme, font, accent, density, message, and background cards. */
import { useState } from 'react'
import clsx from 'clsx'
import {
  IconChevronDownOutline14, IconChevronUpOutline14,
  SettingsRadioOption, SettingsSaveBar,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CustomizationSettingsKey } from './locales.ts'
import type { AccentColor, CustomizationSettings, CustomizationTheme } from './customization-settings.ts'
import {
  CUSTOMIZATION_FONT_SIZE_MAX, CUSTOMIZATION_FONT_SIZE_MIN,
  readCustomizationSettings, writeCustomizationSettings,
} from './customization-settings.ts'
import { applyCustomizationSettings } from './apply-customization.ts'
import css from './CustomizationSection.module.css'

/** Live theme/font snapshot handed to the section by the plugin host. */
export interface CustomizationLiveAppearance {
  /** Theme choice currently active in the theme service. */
  theme: CustomizationTheme
  /** Content font size currently active in the theme service. */
  fontSize: number
}

/** Business callbacks injected into the Customization section. */
export interface CustomizationSectionInjected {
  /** Translate one Customization key. */
  t: (key: CustomizationSettingsKey) => string
  /** Read the live theme/font from the theme service, when the host provides it. */
  getLiveAppearance?: () => CustomizationLiveAppearance | undefined
  /** Push the saved theme/font into the theme service, when the host provides it. */
  applyLive?: (appearance: CustomizationLiveAppearance) => void
}

/** Full component props: section owner share plus the injected copy face. */
export type CustomizationSectionProps = PropsRuntime<'settings.section'> & CustomizationSectionInjected

/**
 * Render the Customization page: option cards persisted to browser-local
 * storage on save and applied immediately (root attributes for
 * accent/density/background, the theme service for theme/font size).
 * @param props - section owner share plus the injected copy face.
 * @returns the section element tree.
 */
export function CustomizationSection({ t, getLiveAppearance, applyLive }: CustomizationSectionProps) {
  const [draft, setDraft] = useState<CustomizationSettings>(() => {
    const stored = readCustomizationSettings()
    // The theme service is the live authority: prefer its snapshot over a
    // possibly stale browser-local document (e.g. changed via General rows).
    const live = getLiveAppearance?.()
    if (live === undefined) return stored
    return { ...stored, theme: live.theme, fontSize: live.fontSize }
  })
  const [saved, setSaved] = useState(false)

  const patch = (patch: Partial<CustomizationSettings>): void => {
    setSaved(false)
    setDraft(previous => ({ ...previous, ...patch }))
  }

  const save = (): void => {
    // The section renders in browsers only, so the document is present;
    // storage writes already fail silently inside writeCustomizationSettings,
    // and the draft passes this package's guards, so nothing here throws.
    writeCustomizationSettings(draft)
    applyCustomizationSettings(draft)
    applyLive?.({ theme: draft.theme, fontSize: draft.fontSize })
    try { window.dispatchEvent(new CustomEvent('dsh-customization-change')) } catch {}
    setSaved(true)
  }

  const accentDot = (value: AccentColor) => (
    <span
      aria-hidden="true"
      className={clsx(
        css.swatch,
        value === 'blue' && css.swatchBlue,
        value === 'green' && css.swatchGreen,
        value === 'purple' && css.swatchPurple,
        value === 'orange' && css.swatchOrange,
      )}
    />
  )

  const accent = (value: AccentColor, label: string) => (
    <SettingsRadioOption
      key={value}
      name="accent"
      value={value}
      label={label}
      checked={draft.accent === value}
      onSelect={() => { patch({ accent: value }) }}
      leading={accentDot(value)}
    />
  )

  return (
    <div className={css.section}>
      <p className={css.description}>{t('description')}</p>
      <section className={css.card} aria-label={t('theme.title')}>
        <h3 className={css.cardTitle}>{t('theme.title')}</h3>
        <div className={css.options} role="radiogroup" aria-label={t('theme.title')}>
          {(['system', 'light', 'dark'] as const).map(value => (
            <SettingsRadioOption
              key={value}
              name="theme"
              value={value}
              label={t(`theme.${value}`)}
              checked={draft.theme === value}
              onSelect={() => { patch({ theme: value }) }}
            />
          ))}
        </div>
      </section>
      <section className={css.card} aria-label={t('font.title')}>
        <h3 className={css.cardTitle}>{t('font.title')}</h3>
        <p className={css.description}>{t('font.description')}</p>
        <div className={css.control}>
          <div className={css.stepper}>
            <span className={css.value}>{draft.fontSize}</span>
            <span className={css.arrows}>
              <button
                type="button"
                className={css.arrow}
                aria-label={t('font.increase')}
                disabled={draft.fontSize >= CUSTOMIZATION_FONT_SIZE_MAX}
                onClick={() => { patch({ fontSize: draft.fontSize + 1 }) }}
              >
                <IconChevronUpOutline14 size={9} />
              </button>
              <button
                type="button"
                className={css.arrow}
                aria-label={t('font.decrease')}
                disabled={draft.fontSize <= CUSTOMIZATION_FONT_SIZE_MIN}
                onClick={() => { patch({ fontSize: draft.fontSize - 1 }) }}
              >
                <IconChevronDownOutline14 size={9} />
              </button>
            </span>
          </div>
          <span className={css.unit}>{t('font.unit')}</span>
        </div>
      </section>
      <section className={css.card} aria-label={t('accent.title')}>
        <h3 className={css.cardTitle}>{t('accent.title')}</h3>
        <div className={css.options} role="radiogroup" aria-label={t('accent.title')}>
          {accent('blue', t('accent.blue'))}
          {accent('green', t('accent.green'))}
          {accent('purple', t('accent.purple'))}
          {accent('orange', t('accent.orange'))}
        </div>
      </section>
      <section className={css.card} aria-label={t('density.title')}>
        <h3 className={css.cardTitle}>{t('density.title')}</h3>
        <div className={css.options} role="radiogroup" aria-label={t('density.title')}>
          {(['compact', 'comfortable', 'spacious'] as const).map(value => (
            <SettingsRadioOption
              key={value}
              name="density"
              value={value}
              label={t(`density.${value}`)}
              checked={draft.density === value}
              onSelect={() => { patch({ density: value }) }}
            />
          ))}
        </div>
      </section>
      <section className={css.card} aria-label={t('messages.title')}>
        <h3 className={css.cardTitle}>{t('messages.title')}</h3>
        <div className={css.options}>
          <label className={css.option}>
            <input type="checkbox" checked={draft.showTimestamps} onChange={(event) => { patch({ showTimestamps: event.target.checked }) }} />
            {t('messages.timestamps')}
          </label>
          <label className={css.option}>
            <input type="checkbox" checked={draft.showAvatars} onChange={(event) => { patch({ showAvatars: event.target.checked }) }} />
            {t('messages.avatars')}
          </label>
          <label className={css.option}>
            <input type="checkbox" checked={draft.wrapCode} onChange={(event) => { patch({ wrapCode: event.target.checked }) }} />
            {t('messages.wrap')}
          </label>
        </div>
      </section>
      <section className={css.card} aria-label={t('brand.title')}>
        <h3 className={css.cardTitle}>{t('brand.title')}</h3>
        <p className={css.description}>{t('brand.description')}</p>
        <div className={css.control}>
          <input
            type="text"
            className={css.input ?? css.control}
            value={draft.brandName}
            placeholder={t('brand.placeholder')}
            maxLength={80}
            onChange={(event) => { patch({ brandName: event.target.value }) }}
            style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-specific-input-major)', color: 'var(--dsw-alias-label-primary)' }}
            aria-label={t('brand.title')}
          />
        </div>
      </section>
      <section className={css.card} aria-label={t('background.title')}>
        <h3 className={css.cardTitle}>{t('background.title')}</h3>
        <div className={css.options} role="radiogroup" aria-label={t('background.title')}>
          {(['default', 'grid', 'dots'] as const).map(value => (
            <SettingsRadioOption
              key={value}
              name="background"
              value={value}
              label={t(`background.${value}`)}
              checked={draft.background === value}
              onSelect={() => { patch({ background: value }) }}
            />
          ))}
        </div>
      </section>
      <SettingsSaveBar saveLabel={t('save')} saved={saved} savedLabel={t('saved')} onSave={save} />
    </div>
  )
}

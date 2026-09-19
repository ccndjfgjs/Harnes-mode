/** The Accessibility page: reading, sound, font, TTS-filter, and contrast cards. */
import { useState } from 'react'
import type { ChangeEvent } from 'react'
import { SettingsRadioOption, SettingsSaveBar } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AccessibilitySettingsKey } from './locales.ts'
import type {
  AccessibilityFont, AccessibilitySettings, CodeReadingMode, ContrastTheme,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { readAccessibilitySettings, speakNavText, writeAccessibilitySettings } from '@deepseek-ai/dsh-client-ui-primitives'
import { applyAccessibilitySettings } from './apply-accessibility.ts'
import css from './AccessibilitySection.module.css'

/** Business callbacks injected into the Accessibility section. */
export interface AccessibilitySectionInjected {
  /** Translate one Accessibility key. */
  t: (key: AccessibilitySettingsKey) => string
}

/** Full component props: section owner share plus the injected copy face. */
export type AccessibilitySectionProps = PropsRuntime<'settings.section'> & AccessibilitySectionInjected

/**
 * Render the Accessibility template: one card per feature group, persisted
 * to browser-local storage on save. Feature behavior (reader verbosity, TTS
 * filtering, themes) consumes the stored document; this page only edits it.
 * @param props - section owner share plus the injected copy face.
 * @returns the section element tree.
 */
export function AccessibilitySection({ t }: AccessibilitySectionProps) {
  const [draft, setDraft] = useState<AccessibilitySettings>(() => readAccessibilitySettings())
  const [saved, setSaved] = useState(false)

  const patch = (patch: Partial<AccessibilitySettings>): void => {
    setSaved(false)
    setDraft(previous => ({ ...previous, ...patch }))
  }

  const toggleStrip = (event: ChangeEvent<HTMLInputElement>): void => {
    patch({ stripMarkdown: event.target.checked })
  }

  const save = (): void => {
    // The section renders in browsers only, so the document is present;
    // storage writes already fail silently inside writeAccessibilitySettings.
    writeAccessibilitySettings(draft)
    applyAccessibilitySettings(draft)
    setSaved(true)
  }

  const code = (value: CodeReadingMode, label: string) => (
    <SettingsRadioOption
      key={value}
      name="code-reading"
      value={value}
      label={label}
      checked={draft.codeReading === value}
      onSelect={() => { patch({ codeReading: value }) }}
    />
  )
  const font = (value: AccessibilityFont, label: string) => (
    <SettingsRadioOption
      key={value}
      name="font"
      value={value}
      label={label}
      checked={draft.font === value}
      onSelect={() => { patch({ font: value }) }}
    />
  )
  const contrast = (value: ContrastTheme, label: string) => (
    <SettingsRadioOption
      key={value}
      name="contrast"
      value={value}
      label={label}
      checked={draft.contrast === value}
      onSelect={() => { patch({ contrast: value }) }}
    />
  )

  return (
    <div className={css.section}>
      <p className={css.description}>{t('description')}</p>
      <section className={css.card} aria-label={t('code.title')}>
        <h3 className={css.cardTitle}>{t('code.title')}</h3>
        <div className={css.options} role="radiogroup" aria-label={t('code.title')}>
          {code('brief', t('code.brief'))}
          {code('line', t('code.line'))}
          {code('full', t('code.full'))}
        </div>
      </section>
      <section className={css.card} aria-label={t('sound.title')}>
        <h3 className={css.cardTitle}>{t('sound.title')}</h3>
        <div className={css.options} role="radiogroup" aria-label={t('sound.title')}>
          <SettingsRadioOption name="sound" value="on" label={t('sound.on')} checked={draft.sound} onSelect={() => { patch({ sound: true }) }} />
          <SettingsRadioOption name="sound" value="off" label={t('sound.off')} checked={!draft.sound} onSelect={() => { patch({ sound: false }) }} />
        </div>
      </section>
      <section className={css.card} aria-label={t('font.title')}>
        <h3 className={css.cardTitle}>{t('font.title')}</h3>
        <div className={css.options} role="radiogroup" aria-label={t('font.title')}>
          {font('atkinson', t('font.atkinson'))}
          {font('mono', t('font.mono'))}
        </div>
      </section>
      <section className={css.card} aria-label={t('markdown.title')}>
        <h3 className={css.cardTitle}>{t('markdown.title')}</h3>
        <label className={css.option}>
          <input type="checkbox" checked={draft.stripMarkdown} onChange={toggleStrip} />
          {t('markdown.strip')}
        </label>
      </section>
      <section className={css.card} aria-label={t('voiceNav.title')}>
        <h3 className={css.cardTitle}>{t('voiceNav.title')}</h3>
        <p className={css.description}>{t('voiceNav.description')}</p>
        <div className={css.options} role="radiogroup" aria-label={t('voiceNav.title')}>
          <SettingsRadioOption name="voice-nav" value="on" label={t('voiceNav.on')} checked={draft.voiceNav} onSelect={() => { patch({ voiceNav: true }) }} />
          <SettingsRadioOption name="voice-nav" value="off" label={t('voiceNav.off')} checked={!draft.voiceNav} onSelect={() => { patch({ voiceNav: false }) }} />
        </div>
        <label className={css.option} style={{ marginTop: 8, opacity: draft.voiceNav ? 1 : 0.5 }}>
          <input
            type="checkbox"
            checked={draft.voiceNavHover}
            disabled={!draft.voiceNav}
            onChange={(event) => {
              const checked = event.target.checked
              patch({ voiceNavHover: checked })
              try { writeAccessibilitySettings({ voiceNavHover: checked }) } catch {}
            }}
          />
          {t('voiceNav.hover')}
        </label>
        <label className={css.option} style={{ marginTop: 4, opacity: draft.voiceNav ? 1 : 0.5 }}>
          <input
            type="checkbox"
            checked={draft.voiceNavArrow}
            disabled={!draft.voiceNav}
            onChange={(event) => {
              const checked = event.target.checked
              patch({ voiceNavArrow: checked })
              try { writeAccessibilitySettings({ voiceNavArrow: checked }) } catch {}
            }}
          />
          {t('voiceNav.arrow')}
        </label>
        <div style={{ marginTop: 8, opacity: draft.voiceNav ? 1 : 0.5 }}>
          <label className={css.option} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
            <span>{t('voiceNav.delayValue').replace('{value}', String(draft.voiceNavDelay))}</span>
            <input
              type="range"
              min={0}
              max={1000}
              step={50}
              value={draft.voiceNavDelay}
              disabled={!draft.voiceNav}
              onChange={(event) => {
                const value = Number(event.target.value)
                patch({ voiceNavDelay: value })
                try { writeAccessibilitySettings({ voiceNavDelay: value }) } catch {}
              }}
              onMouseUp={() => { try { speakNavText(t('voiceNav.delaySpoken').replace('{value}', String(draft.voiceNavDelay))) } catch {} }}
              style={{ width: '100%' }}
              aria-label={t('voiceNav.delay')}
            />
          </label>
          <p className={css.description} style={{ marginTop: 4 }}>{t('voiceNav.delayDesc')}</p>
        </div>
        <div style={{ marginTop: 8, opacity: draft.voiceNav ? 1 : 0.5 }}>
          <span className={css.description}>{t('voiceNav.chatTrigger')}</span>
          <div className={css.options} role="radiogroup" aria-label={t('voiceNav.chatTrigger')} style={{ marginTop: 4 }}>
            <SettingsRadioOption name="voice-nav-chat" value="click" label={t('voiceNav.chatTrigger.click')} checked={draft.voiceNavChatTrigger === 'click'} onSelect={() => { const v = 'click' as const; patch({ voiceNavChatTrigger: v }); try { writeAccessibilitySettings({ voiceNavChatTrigger: v }) } catch {} }} />
            <SettingsRadioOption name="voice-nav-chat" value="hover" label={t('voiceNav.chatTrigger.hover')} checked={draft.voiceNavChatTrigger === 'hover'} onSelect={() => { const v = 'hover' as const; patch({ voiceNavChatTrigger: v }); try { writeAccessibilitySettings({ voiceNavChatTrigger: v }) } catch {} }} />
            <SettingsRadioOption name="voice-nav-chat" value="both" label={t('voiceNav.chatTrigger.both')} checked={draft.voiceNavChatTrigger === 'both'} onSelect={() => { const v = 'both' as const; patch({ voiceNavChatTrigger: v }); try { writeAccessibilitySettings({ voiceNavChatTrigger: v }) } catch {} }} />
          </div>
        </div>
      </section>
      <section className={css.card} aria-label={t('contrast.title')}>
        <h3 className={css.cardTitle}>{t('contrast.title')}</h3>
        <div className={css.options} role="radiogroup" aria-label={t('contrast.title')}>
          {contrast('none', t('contrast.none'))}
          {contrast('bw', t('contrast.bw'))}
          {contrast('yellow', t('contrast.yellow'))}
          {contrast('daltonism', t('contrast.daltonism'))}
        </div>
      </section>
      <SettingsSaveBar saveLabel={t('save')} saved={saved} savedLabel={t('saved')} onSave={save} />
    </div>
  )
}

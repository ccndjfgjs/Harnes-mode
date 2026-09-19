/** The Screen Broadcast page: cadence, preview, quality, audio, and end behavior cards. */
import { useState } from 'react'
import type { ChangeEvent } from 'react'
import { SettingsRadioOption, SettingsSaveBar } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ScreenSettingsKey } from './locales.ts'
import type { ScreenSettings } from './screen-settings.ts'
import {
  BUFFER_BYTES_MAX, BUFFER_BYTES_MIN, BUFFER_FRAMES_MAX, BUFFER_FRAMES_MIN,
  BUFFER_TEXT_MAX, BUFFER_TEXT_MIN,
  CAPTURE_SCOPES, INTERVAL_MAX_MS, INTERVAL_MIN_MS, MAX_EDGE_CHOICES, PREVIEW_CORNERS,
  THRESHOLD_MAX, THRESHOLD_MIN,
  readScreenSettings, writeScreenSettings,
} from './screen-settings.ts'
import css from './ScreenSection.module.css'

/** Business callbacks injected into the Screen Broadcast section. */
export interface ScreenSectionInjected {
  /** Translate one Screen Broadcast key. */
  t: (key: ScreenSettingsKey) => string
}

/** Full component props: section owner share plus the injected copy face. */
export type ScreenSectionProps = PropsRuntime<'settings.section'> & ScreenSectionInjected

/**
 * Render a sensitivity threshold as a percentage the label can carry. The
 * range starts at 0.1%, so whole-number rounding would print "0" across the
 * most sensitive third of the slider; one decimal keeps every step legible.
 * @param threshold - the stored share of changed pixels (0.001-0.2).
 * @returns the percentage text, with a trailing ".0" trimmed.
 */
function thresholdPercent(threshold: number): string {
  const percent = Math.round(threshold * 1000) / 10
  return Number.isInteger(percent) ? String(percent) : percent.toFixed(1)
}

/**
 * Render the Screen Broadcast template: one card per decision, persisted to
 * browser-local storage on save. The composer's screen button consumes the
 * stored document; this page only edits it.
 * @param props - section owner share plus the injected copy face.
 * @returns the section element tree.
 */
export function ScreenSection({ t }: ScreenSectionProps) {
  const [draft, setDraft] = useState<ScreenSettings>(() => readScreenSettings())
  const [saved, setSaved] = useState(false)

  const patch = (next: Partial<ScreenSettings>): void => {
    setSaved(false)
    setDraft(previous => ({ ...previous, ...next }))
  }

  const save = (): void => {
    // The section renders in browsers only, so the document is present;
    // storage writes already fail silently inside writeScreenSettings.
    writeScreenSettings(draft)
    setSaved(true)
  }

  const corner = (value: ScreenSettings['previewCorner'], label: string) => (
    <SettingsRadioOption
      key={value}
      name="screen-preview-corner"
      value={value}
      label={label}
      checked={draft.previewCorner === value}
      onSelect={() => { patch({ previewCorner: value }) }}
    />
  )
  const edge = (value: number, label: string) => (
    <SettingsRadioOption
      key={value}
      name="screen-edge"
      value={String(value)}
      label={label}
      checked={draft.maxEdge === value}
      onSelect={() => { patch({ maxEdge: value }) }}
    />
  )
  const scope = (value: ScreenSettings['captureScope'], label: string) => (
    <SettingsRadioOption
      key={value}
      name="screen-scope"
      value={value}
      label={label}
      checked={draft.captureScope === value}
      onSelect={() => { patch({ captureScope: value }) }}
    />
  )

  return (
    <div className={css.section}>
      <p className={css.description}>{t('description')}</p>
      <section className={css.card} aria-label={t('broadcast.title')}>
        <h3 className={css.cardTitle}>{t('broadcast.title')}</h3>
        <p className={css.description}>{t('broadcast.description')}</p>
        <div className={css.options} role="radiogroup" aria-label={t('broadcast.title')}>
          <SettingsRadioOption
            name="screen-broadcast"
            value="on"
            label={t('broadcast.on')}
            checked={draft.broadcast}
            onSelect={() => { patch({ broadcast: true }) }}
          />
          <SettingsRadioOption
            name="screen-broadcast"
            value="off"
            label={t('broadcast.off')}
            checked={!draft.broadcast}
            onSelect={() => { patch({ broadcast: false }) }}
          />
        </div>
      </section>
      <section className={css.card} aria-label={t('interval.title')}>
        <h3 className={css.cardTitle}>{t('interval.title')}</h3>
        <label className={css.slider}>
          <span>{t('interval.value').replace('{ms}', String(draft.intervalMs))}</span>
          <input
            type="range"
            min={INTERVAL_MIN_MS}
            max={INTERVAL_MAX_MS}
            step={500}
            value={draft.intervalMs}
            disabled={!draft.broadcast}
            aria-label={`${t('interval.title')} \u2014 ${t('interval.value').replace('{ms}', String(draft.intervalMs))}`}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              patch({ intervalMs: Number(event.target.value) })
            }}
          />
        </label>
        <p className={css.description}>{t('interval.description')}</p>
      </section>
      <section className={css.card} aria-label={t('preview.title')}>
        <h3 className={css.cardTitle}>{t('preview.title')}</h3>
        <p className={css.description}>{t('preview.description')}</p>
        <label className={css.option}>
          <input
            type="checkbox"
            checked={draft.showPreview}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              patch({ showPreview: event.target.checked })
            }}
          />
          {t('preview.show')}
        </label>
        <span className={css.subLabel}>{t('preview.corner')}</span>
        <div
          className={css.options}
          role="radiogroup"
          aria-label={t('preview.corner')}
          style={{ opacity: draft.showPreview ? 1 : 0.5 }}
        >
          {PREVIEW_CORNERS.map(value => corner(value, t(`preview.${value}`)))}
        </div>
      </section>
      <section className={css.card} aria-label={t('quality.title')}>
        <h3 className={css.cardTitle}>{t('quality.title')}</h3>
        <span className={css.subLabel}>{t('quality.edge')}</span>
        <div className={css.options} role="radiogroup" aria-label={t('quality.edge')}>
          {MAX_EDGE_CHOICES.map(value => edge(value, t(`quality.edge.${value}`)))}
        </div>
        <label className={css.slider}>
          <span>{t('quality.quality.value').replace('{percent}', String(Math.round(draft.quality * 100)))}</span>
          <input
            type="range"
            min={0.1}
            max={1}
            step={0.02}
            value={draft.quality}
            aria-label={t('quality.quality')}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              patch({ quality: Number(event.target.value) })
            }}
          />
        </label>
        <p className={css.description}>{t('quality.description')}</p>
      </section>
      <section className={css.card} aria-label={t('buffer.title')}>
        <h3 className={css.cardTitle}>{t('buffer.title')}</h3>
        <p className={css.description}>{t('buffer.description')}</p>
        <label className={css.slider}>
          <span>{t('buffer.frames.value').replace('{count}', String(draft.bufferFrames))}</span>
          <input
            type="range"
            min={BUFFER_FRAMES_MIN}
            max={BUFFER_FRAMES_MAX}
            step={1}
            value={draft.bufferFrames}
            aria-label={t('buffer.frames')}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              patch({ bufferFrames: Number(event.target.value) })
            }}
          />
        </label>
        <label className={css.slider}>
          <span>{t('buffer.size.value').replace('{mb}', String(Math.round(draft.bufferBytes / (1024 * 1024))))}</span>
          <input
            type="range"
            min={BUFFER_BYTES_MIN}
            max={BUFFER_BYTES_MAX}
            step={1024 * 1024}
            value={draft.bufferBytes}
            aria-label={t('buffer.size')}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              patch({ bufferBytes: Number(event.target.value) })
            }}
          />
        </label>
        <label className={css.slider}>
          <span>{t('buffer.text.value').replace('{count}', String(draft.bufferTextChars))}</span>
          <input
            type="range"
            min={BUFFER_TEXT_MIN}
            max={BUFFER_TEXT_MAX}
            step={1000}
            value={draft.bufferTextChars}
            aria-label={t('buffer.text')}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              patch({ bufferTextChars: Number(event.target.value) })
            }}
          />
        </label>
      </section>
      <section className={css.card} aria-label={t('smart.title')}>
        <h3 className={css.cardTitle}>{t('smart.title')}</h3>
        <p className={css.description}>{t('smart.description')}</p>
        <label className={css.option}>
          <input
            type="checkbox"
            checked={draft.sendOnChange}
            disabled={!draft.broadcast}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              patch({ sendOnChange: event.target.checked })
            }}
          />
          {t('smart.on')}
        </label>
        <label className={css.slider}>
          <span>
            {t('smart.threshold.value').replace('{percent}', thresholdPercent(draft.changeThreshold))}
          </span>
          <input
            type="range"
            min={THRESHOLD_MIN}
            max={THRESHOLD_MAX}
            step={0.001}
            value={draft.changeThreshold}
            disabled={!draft.broadcast || !draft.sendOnChange}
            aria-label={`${t('smart.threshold')} \u2014 ${t('smart.threshold.value').replace('{percent}', thresholdPercent(draft.changeThreshold))}`}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              patch({ changeThreshold: Number(event.target.value) })
            }}
          />
        </label>
        <p className={css.description}>{t('smart.threshold.description')}</p>
      </section>
      <section className={css.card} aria-label={t('scope.title')}>
        <h3 className={css.cardTitle}>{t('scope.title')}</h3>
        <p className={css.description}>{t('scope.description')}</p>
        <div className={css.options} role="radiogroup" aria-label={t('scope.title')}>
          {CAPTURE_SCOPES.map(value => scope(value, t(`scope.${value}`)))}
        </div>
      </section>
      <section className={css.card} aria-label={t('text.title')}>
        <h3 className={css.cardTitle}>{t('text.title')}</h3>
        <p className={css.description}>{t('text.description')}</p>
        <label className={css.option}>
          <input
            type="checkbox"
            checked={draft.sendText}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              patch({ sendText: event.target.checked })
            }}
          />
          {t('text.on')}
        </label>
      </section>
      <section className={css.card} aria-label={t('audio.title')}>
        <h3 className={css.cardTitle}>{t('audio.title')}</h3>
        <label className={css.option}>
          <input
            type="checkbox"
            checked={draft.captureAudio}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              patch({ captureAudio: event.target.checked })
            }}
          />
          {t('audio.capture')}
        </label>
      </section>
      <section className={css.card} aria-label={t('stop.title')}>
        <h3 className={css.cardTitle}>{t('stop.title')}</h3>
        <label className={css.option}>
          <input
            type="checkbox"
            checked={draft.stopOnEnded}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              patch({ stopOnEnded: event.target.checked })
            }}
          />
          {draft.stopOnEnded ? t('stop.onended') : t('stop.onended.off')}
        </label>
      </section>
      <SettingsSaveBar saveLabel={t('save')} saved={saved} savedLabel={t('saved')} onSave={save} />
    </div>
  )
}

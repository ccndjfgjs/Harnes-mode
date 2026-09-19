/**
 * The read-aloud voice card: which service speaks, which voice answers, and
 * which voice carries a call.
 *
 * The two voice pickers are separate because one provider keeps two different
 * catalogs — so "the same voice everywhere" is checked here (see
 * acceptsTtsVoice) and said out loud when it does not hold, instead of letting
 * the call quietly answer in another voice.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  VOICE_PITCH_MAX, VOICE_PITCH_MIN, VOICE_PROVIDERS, VOICE_SPEED_MAX, VOICE_SPEED_MIN,
  acceptsTtsVoice, resolveTtsModel, resolveVoice, voiceProvider,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { VoiceDescriptor, VoiceProviderId } from '@deepseek-ai/dsh-client-ui-primitives'
import type { VoiceSettingsKey } from './locales.ts'
import type { VoiceSettings } from './voice-settings.ts'
import { fetchVoices, previewVoice } from './voice-catalog.ts'
import css from './VoiceSection.module.css'

/** How the catalog fetch is going. */
type CatalogStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'failed'

/** How the preview is going. */
type PreviewStatus = 'idle' | 'playing' | 'failed'

/** The card's props: the draft it edits plus the page's patch face. */
export interface ProviderCardProps {
  /** Translate one Voice Settings key. */
  t: (key: VoiceSettingsKey) => string
  /** The settings draft the page holds. */
  draft: VoiceSettings
  /** Merge a patch into the draft. */
  patch: (next: Partial<VoiceSettings>) => void
}

/**
 * Render the voice card: service picker, answer voice, call voice source, and
 * the pacing sliders, with a preview that speaks the choice before saving.
 * @param props - the draft and the patch face.
 * @returns the card element tree.
 */
export function ProviderCard({ t, draft, patch }: ProviderCardProps) {
  const provider = voiceProvider(draft.provider)
  const [catalog, setCatalog] = useState<readonly VoiceDescriptor[]>([])
  const [catalogStatus, setCatalogStatus] = useState<CatalogStatus>('idle')
  const [preview, setPreview] = useState<PreviewStatus>('idle')

  // A new service invalidates whatever list the previous one produced.
  useEffect(() => {
    setCatalog([])
    setCatalogStatus('idle')
    setPreview('idle')
  }, [draft.provider])

  const staticTts = provider?.tts?.voices ?? []
  const ttsVoices = staticTts.length > 0 ? staticTts : catalog
  const realtimeVoices = provider?.realtime?.voices ?? []
  // Only a provider whose catalog is not shipped with the app needs a fetch.
  const dynamic = provider?.tts !== undefined && staticTts.length === 0
  const resolved = provider === undefined ? '' : resolveVoice(provider, 'tts', draft.ttsVoiceId)
  const mismatch = provider?.realtime !== undefined
    && draft.callVoiceMode === 'same'
    && acceptsTtsVoice(provider, resolved) === 'no'

  /** Ask the gateway for the service's voice list. */
  const load = useCallback(async (): Promise<void> => {
    if (provider === undefined) return
    setCatalogStatus('loading')
    try {
      const list = await fetchVoices(provider.id, draft.ttsKey)
      setCatalog(list)
      setCatalogStatus(list.length === 0 ? 'empty' : 'ready')
    } catch {
      setCatalogStatus('failed')
    }
  }, [provider, draft.ttsKey])

  /** Speak the chosen voice once, so the selection can be heard before saving. */
  const hear = async (voice: string): Promise<void> => {
    if (provider === undefined) return
    setPreview('playing')
    try {
      await previewVoice({
        provider: provider.id,
        voice,
        // Resolved the same way the read-aloud engine resolves it, so the
        // preview sounds like the answer it is previewing.
        model: resolveTtsModel(provider, draft.ttsModel),
        speed: draft.ttsSpeed,
        pitch: draft.ttsPitch,
        key: draft.ttsKey,
        text: t('provider.preview.phrase'),
      })
      setPreview('idle')
    } catch {
      setPreview('failed')
    }
  }

  const pickProvider = (id: VoiceProviderId): void => {
    // Voices belong to one provider, so a new service starts from its defaults.
    patch({ provider: id, ttsVoiceId: '', realtimeVoiceId: '' })
  }

  return (
    <section className={css.card} aria-label={t('provider.title')}>
      <h3 className={css.cardTitle}>{t('provider.title')}</h3>
      <p className={css.hint}>{t('provider.hint')}</p>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('provider.service')}</span>
        <select
          className={css.fieldInput}
          value={draft.provider}
          onChange={(event) => { pickProvider(event.target.value as VoiceProviderId) }}
        >
          {VOICE_PROVIDERS.map(item => (
            <option key={item.id} value={item.id}>{t(`provider.${item.labelKey}`)}</option>
          ))}
        </select>
      </label>
      {provider?.needsKey === true && <p className={css.hint}>{t('provider.key.hint')}</p>}
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('provider.voice')}</span>
        <select
          className={css.fieldInput}
          value={draft.ttsVoiceId}
          onChange={(event) => { patch({ ttsVoiceId: event.target.value }) }}
        >
          <option value="">{t('provider.voice.default')}</option>
          {ttsVoices.map(voice => <option key={voice.id} value={voice.id}>{voice.label}</option>)}
        </select>
      </label>
      {dynamic && (
        <div className={css.row}>
          <button
            type="button"
            className={css.request}
            disabled={catalogStatus === 'loading'}
            onClick={() => { void load() }}
          >
            {catalogStatus === 'loading' ? t('provider.voices.fetching') : t('provider.voices.fetch')}
          </button>
          <span className={css.status}>
            {catalogStatus === 'empty' && t('provider.voices.none')}
            {catalogStatus === 'failed' && t('provider.voices.failed')}
          </span>
        </div>
      )}
      {provider?.realtime !== undefined && (
        <>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('provider.mode')}</span>
            <select
              className={css.fieldInput}
              value={draft.callVoiceMode}
              onChange={(event) => { patch({ callVoiceMode: event.target.value === 'own' ? 'own' : 'same' }) }}
            >
              <option value="same">{t('provider.mode.same')}</option>
              <option value="own">{t('provider.mode.own')}</option>
            </select>
          </label>
          {draft.callVoiceMode === 'own' && (
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('provider.voice.call')}</span>
              <select
                className={css.fieldInput}
                value={draft.realtimeVoiceId}
                onChange={(event) => { patch({ realtimeVoiceId: event.target.value }) }}
              >
                <option value="">{t('provider.voice.default')}</option>
                {realtimeVoices.map(voice => <option key={voice.id} value={voice.id}>{voice.label}</option>)}
              </select>
            </label>
          )}
        </>
      )}
      {mismatch && <p className={css.warn}>{t('provider.mismatch')}</p>}
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('provider.speed')}</span>
        <input
          className={css.range}
          type="range"
          min={VOICE_SPEED_MIN}
          max={VOICE_SPEED_MAX}
          step={0.1}
          value={draft.ttsSpeed}
          onChange={(event) => { patch({ ttsSpeed: Number(event.target.value) }) }}
        />
      </label>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('provider.pitch')}</span>
        <input
          className={css.range}
          type="range"
          min={VOICE_PITCH_MIN}
          max={VOICE_PITCH_MAX}
          step={0.1}
          value={draft.ttsPitch}
          onChange={(event) => { patch({ ttsPitch: Number(event.target.value) }) }}
        />
      </label>
      <div className={css.row}>
        <button
          type="button"
          className={css.request}
          disabled={preview === 'playing'}
          onClick={() => { void hear(resolved) }}
        >
          {preview === 'playing' ? t('provider.previewing') : t('provider.preview')}
        </button>
        {preview === 'failed' && <span className={css.status}>{t('provider.preview.failed')}</span>}
      </div>
    </section>
  )
}

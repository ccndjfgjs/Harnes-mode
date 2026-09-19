/** The Voice Settings page: STT/TTS, call signaling, vision, SIP, and the live device roster. */
import { useCallback, useEffect, useState } from 'react'
import type { ChangeEvent } from 'react'
import clsx from 'clsx'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  ensureMicrophoneAccess, isMediaDevicesAvailable, listAudioDevices, readMicrophonePermission,
  readVoiceModuleSettings, writeVoiceModuleSettings,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { AudioDevice, CapturePermission } from '@deepseek-ai/dsh-client-ui-primitives'
import type { VoiceSettingsKey } from './locales.ts'
import { ProviderCard } from './ProviderCard.tsx'
import type { VoiceSettings } from './voice-settings.ts'
import {
  isVoiceConfigured,
  readVoiceSettings,
  writeVoiceSettings,
} from './voice-settings.ts'
import css from './VoiceSection.module.css'

/** Business callbacks injected into the Voice section (locale-bound copy). */
export interface VoiceSectionInjected {
  /** Translate one Voice Settings key. */
  t: (key: VoiceSettingsKey) => string
}

/** Full component props: section owner share plus the injected copy face. */
export type VoiceSectionProps = PropsRuntime<'settings.section'> & VoiceSectionInjected

/**
 * One endpoint picker: a labelled select listing the machine's devices, with
 * the system default first.
 *
 * The default is offered as an explicit empty-valued option rather than as a
 * preselected first device, because "whatever Windows is set to" is the right
 * answer for a headset user and is not the same as "the first id in the list".
 * @param props - label, device roster, current choice, change handler, and the
 *   injected copy face.
 * @returns the picker element tree.
 */
function DeviceSelect({
  t, label, roster, value, onChange,
}: {
  t: (key: VoiceSettingsKey) => string
  label: VoiceSettingsKey
  roster: readonly AudioDevice[]
  value: string
  onChange: (deviceId: string) => void
}) {
  return (
    <label className={css.field}>
      <span className={css.fieldLabel}>{t(label)}</span>
      <select
        className={css.fieldInput}
        value={value}
        onChange={(event) => { onChange(event.target.value) }}
      >
        <option value="">{t('devices.system')}</option>
        {roster.map((device, index) => (
          // The id is the value; the label is the name, which stays blank until
          // capture has been granted once — hence the numbered fallback rather
          // than an empty row.
          <option key={device.deviceId === '' ? `${label}-${index}` : device.deviceId} value={device.deviceId}>
            {device.label === '' ? `${t('devices.unnamed')} ${index + 1}` : device.label}
          </option>
        ))}
      </select>
    </label>
  )
}

/**
 * The microphone-and-devices card: the live permission state the OS holds
 * (not a stored checkbox), a button that actually asks for the microphone,
 * and the pickers that choose which endpoint records and which one plays back.
 *
 * The two pickers write into the same `dsh.voice.settings` document the module
 * reads, so a choice made here takes effect on the next turn without a reload.
 * Device labels stay blank until capture is granted once, so a successful ask
 * also names the list — which is why the roster is refreshed after the ask.
 * @param props - the injected copy face.
 * @returns the devices card element tree.
 */
function DevicesCard({ t }: { t: (key: VoiceSettingsKey) => string }) {
  const [permission, setPermission] = useState<CapturePermission>('unknown')
  const [devices, setDevices] = useState<readonly AudioDevice[]>([])
  const [asking, setAsking] = useState(false)
  const [inputId, setInputId] = useState(() => readVoiceModuleSettings().inputDeviceId)
  const [outputId, setOutputId] = useState(() => readVoiceModuleSettings().outputDeviceId)

  const refresh = useCallback(async (): Promise<void> => {
    setPermission(await readMicrophonePermission())
    setDevices(await listAudioDevices())
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const request = async (): Promise<void> => {
    setAsking(true)
    await ensureMicrophoneAccess()
    await refresh()
    setAsking(false)
  }

  /**
   * Remember one endpoint choice.
   *
   * Written straight through, unlike the text fields above: a device is picked
   * from a list of what the machine actually has, so there is no half-typed
   * state to protect and no Save step to forget. The write is read-modify-write
   * over the whole document, so the other choice survives it.
   * @param field - which endpoint changed.
   * @param deviceId - the chosen endpoint, '' for the system default.
   */
  const choose = (field: 'inputDeviceId' | 'outputDeviceId', deviceId: string): void => {
    const next = { ...readVoiceModuleSettings(), [field]: deviceId }
    writeVoiceModuleSettings(next)
    if (field === 'inputDeviceId') setInputId(deviceId)
    else setOutputId(deviceId)
  }

  const mics = devices.filter(device => device.kind === 'audioinput')
  const speakers = devices.filter(device => device.kind === 'audiooutput')
  const stateKey = `devices.state.${permission}` as VoiceSettingsKey

  return (
    <section className={css.card} aria-label={t('devices.title')}>
      <h3 className={css.cardTitle}>{t('devices.title')}</h3>
      <div className={css.deviceStatus}>
        <span>{t('devices.mic.status')}</span>
        <span
          className={clsx(
            css.stateValue,
            permission === 'granted' && css.stateOk,
            permission === 'denied' && css.stateDenied,
          )}
        >
          {t(stateKey)}
        </span>
        <button
          type="button"
          className={css.request}
          disabled={asking || !isMediaDevicesAvailable()}
          onClick={() => { void request() }}
        >
          {asking ? t('devices.requesting') : t('devices.request')}
        </button>
      </div>
      <p className={css.hint}>{t('devices.hint')}</p>
      {devices.length === 0
        ? <p className={css.hint}>{t('devices.none')}</p>
        : (
          <>
            {mics.length > 0 && (
              <DeviceSelect t={t} label="devices.mics.choose" roster={mics} value={inputId} onChange={(id) => { choose('inputDeviceId', id) }} />
            )}
            {speakers.length > 0 && (
              <DeviceSelect t={t} label="devices.speakers.choose" roster={speakers} value={outputId} onChange={(id) => { choose('outputDeviceId', id) }} />
            )}
          </>
        )}
    </section>
  )
}

/**
 * Render the Voice Settings template: endpoint + key fields for the STT and
 * TTS services, the voice card (which service speaks, in which voice, and
 * which voice carries a call), call signaling, vision analysis, SIP phone —
 * all persisted to browser-local storage — plus the devices card, which reads
 * its state live from the OS rather than from the stored document.
 * @param props - section owner share plus the injected copy face.
 * @returns the section element tree.
 */
export function VoiceSection({ t }: VoiceSectionProps) {
  const [draft, setDraft] = useState(() => readVoiceSettings())
  const [saved, setSaved] = useState(false)
  const connected = isVoiceConfigured(draft)

  const edit = (field: keyof typeof draft) => (event: ChangeEvent<HTMLInputElement>): void => {
    setSaved(false)
    setDraft(previous => ({ ...previous, [field]: event.target.value }))
  }

  /** Merge a partial change into the draft, shared with the voice card. */
  const patch = useCallback((next: Partial<VoiceSettings>): void => {
    setSaved(false)
    setDraft(previous => ({ ...previous, ...next }))
  }, [])

  const save = (): void => {
    writeVoiceSettings(draft)
    setSaved(true)
  }

  return (
    <div className={css.section}>
      <p className={css.description}>{t('description')}</p>
      <section className={css.card} aria-label={t('stt.title')}>
        <h3 className={css.cardTitle}>{t('stt.title')}</h3>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('stt.endpoint')}</span>
          <input
            className={css.fieldInput}
            type="url"
            autoComplete="off"
            spellCheck={false}
            placeholder={t('stt.endpoint.placeholder')}
            value={draft.sttUrl}
            onChange={edit('sttUrl')}
          />
        </label>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('stt.key')}</span>
          <input
            className={css.fieldInput}
            type="password"
            autoComplete="new-password"
            placeholder={t('stt.key.placeholder')}
            value={draft.sttKey}
            onChange={edit('sttKey')}
          />
        </label>
      </section>
      <section className={css.card} aria-label={t('tts.title')}>
        <h3 className={css.cardTitle}>{t('tts.title')}</h3>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('tts.endpoint')}</span>
          <input
            className={css.fieldInput}
            type="url"
            autoComplete="off"
            spellCheck={false}
            placeholder={t('tts.endpoint.placeholder')}
            value={draft.ttsUrl}
            onChange={edit('ttsUrl')}
          />
        </label>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('tts.key')}</span>
          <input
            className={css.fieldInput}
            type="password"
            autoComplete="new-password"
            placeholder={t('tts.key.placeholder')}
            value={draft.ttsKey}
            onChange={edit('ttsKey')}
          />
        </label>
      </section>
      <ProviderCard t={t} draft={draft} patch={patch} />
      <section className={css.card} aria-label={t('call.title')}>
        <h3 className={css.cardTitle}>{t('call.title')}</h3>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('call.signaling')}</span>
          <input
            className={css.fieldInput}
            type="url"
            autoComplete="off"
            spellCheck={false}
            placeholder={t('call.signaling.placeholder')}
            value={draft.callSignalingUrl}
            onChange={edit('callSignalingUrl')}
          />
        </label>
      </section>
      <section className={css.card} aria-label={t('vision.title')}>
        <h3 className={css.cardTitle}>{t('vision.title')}</h3>
        <p className={css.hint}>{t('vision.hint')}</p>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('vision.endpoint')}</span>
          <input
            className={css.fieldInput}
            type="url"
            autoComplete="off"
            spellCheck={false}
            placeholder={t('vision.endpoint.placeholder')}
            value={draft.visionUrl}
            onChange={edit('visionUrl')}
          />
        </label>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('vision.key')}</span>
          <input
            className={css.fieldInput}
            type="password"
            autoComplete="new-password"
            placeholder={t('vision.key.placeholder')}
            value={draft.visionKey}
            onChange={edit('visionKey')}
          />
        </label>
      </section>
      <DevicesCard t={t} />
      <div className={css.footer}>
        <button type="button" className={css.save} onClick={save}>
          {t('save')}
        </button>
        <span className={clsx(css.status, connected && css.statusReady)} role="status">
          {saved && connected ? t('saved') : connected ? t('status.connected') : t('status.missing')}
        </span>
      </div>
    </div>
  )
}

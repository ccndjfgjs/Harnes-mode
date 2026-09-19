// @vitest-environment jsdom
// VoiceSection template: renders all connection cards (STT, TTS, the voice
// card, Call, Vision, SIP) plus the live devices card, persists the draft, and
// reports the configured status.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { DEFAULT_VOICE_SELECTION } from '@deepseek-ai/dsh-client-ui-primitives'
import { zh } from '../src/client/locales.ts'
import type { VoiceSettingsKey } from '../src/client/locales.ts'
import { VoiceSection } from '../src/client/VoiceSection.tsx'
import type { VoiceSectionProps } from '../src/client/VoiceSection.tsx'
import { readVoiceSettings } from '../src/client/voice-settings.ts'

afterEach(() => {
  cleanup()
  localStorage.clear()
  const nav = navigator as unknown as Record<string, unknown>
  delete nav.mediaDevices
  delete nav.permissions
})

const t = (key: VoiceSettingsKey): string => zh[key]

function renderSection() {
  return render(<VoiceSection {...{ t } as unknown as VoiceSectionProps} />)
}

/** Stub mediaDevices + permissions the way a granted browser answers. */
function stubGrantedBrowser(): void {
  const nav = navigator as unknown as Record<string, unknown>
  nav.mediaDevices = {
    getUserMedia: () => Promise.resolve({ getTracks: () => [{ stop: () => {} }] }),
    enumerateDevices: () => Promise.resolve([
      { kind: 'audioinput', deviceId: 'mic-1', label: 'Встроенный микрофон' },
      { kind: 'audiooutput', deviceId: 'spk-1', label: 'Динамики' },
    ]),
  }
  nav.permissions = { query: () => Promise.resolve({ state: 'granted' }) }
}

describe('VoiceSection', () => {
  it('renders all connection cards with a missing status', () => {
    const view = renderSection()
    expect(view.getByLabelText(zh['stt.title'])).toBeTruthy()
    expect(view.getByLabelText(zh['tts.title'])).toBeTruthy()
    expect(view.getByLabelText(zh['provider.title'])).toBeTruthy()
    expect(view.getByLabelText(zh['call.title'])).toBeTruthy()
    expect(view.getByLabelText(zh['vision.title'])).toBeTruthy()
    expect(view.getByLabelText(zh['devices.title'])).toBeTruthy()
    expect(view.getByRole('status').textContent).toBe(zh['status.missing'])
  })

  it('carries the voice selection through save alongside the endpoints', () => {
    const view = renderSection()
    const card = within(view.getByLabelText(zh['provider.title']))
    act(() => {
      fireEvent.change(card.getByLabelText(zh['provider.service']), { target: { value: 'openai' } })
    })
    act(() => {
      fireEvent.change(card.getByLabelText(zh['provider.voice']), { target: { value: 'nova' } })
    })
    act(() => {
      fireEvent.click(view.getByRole('button', { name: zh['save'] }))
    })
    const settings = readVoiceSettings()
    expect(settings.provider).toBe('openai')
    expect(settings.ttsVoiceId).toBe('nova')
    // Fields the card never touched keep their stored defaults.
    expect(settings.callVoiceMode).toBe(DEFAULT_VOICE_SELECTION.callVoiceMode)
    expect(settings.ttsSpeed).toBe(DEFAULT_VOICE_SELECTION.ttsSpeed)
  })

  it('saves the draft and flips the status once fully configured (STT+TTS)', () => {
    const view = renderSection()
    const stt = within(view.getByLabelText(zh['stt.title']))
    const tts = within(view.getByLabelText(zh['tts.title']))
    const fill = (
      scope: { getByPlaceholderText: (text: string) => HTMLElement },
      placeholder: string,
      value: string,
    ): void => {
      act(() => {
        fireEvent.change(scope.getByPlaceholderText(placeholder), { target: { value } })
      })
    }
    fill(stt, zh['stt.endpoint.placeholder'], 'https://stt.example')
    fill(stt, zh['stt.key.placeholder'], 'stt-key')
    fill(tts, zh['tts.endpoint.placeholder'], 'https://tts.example')
    fill(tts, zh['tts.key.placeholder'], 'tts-key')
    act(() => {
      fireEvent.click(view.getByRole('button', { name: zh['save'] }))
    })
    const settings = readVoiceSettings()
    expect(settings.sttUrl).toBe('https://stt.example')
    expect(settings.sttKey).toBe('stt-key')
    expect(settings.ttsUrl).toBe('https://tts.example')
    expect(settings.ttsKey).toBe('tts-key')
    expect(view.getByRole('status').textContent).toBe(zh['saved'])
  })

  it('keeps the missing status on a partial save', () => {
    const view = renderSection()
    const stt = within(view.getByLabelText(zh['stt.title']))
    act(() => {
      fireEvent.change(stt.getByPlaceholderText(zh['stt.endpoint.placeholder']), {
        target: { value: 'https://stt.example' },
      })
    })
    act(() => {
      fireEvent.click(view.getByRole('button', { name: zh['save'] }))
    })
    expect(view.getByRole('status').textContent).toBe(zh['status.missing'])
  })

  it('shows the permission state and device roster the OS reports', async () => {
    stubGrantedBrowser()
    const view = renderSection()
    const card = within(view.getByLabelText(zh['devices.title']))
    await waitFor(() => {
      expect(card.getByText(zh['devices.state.granted'])).toBeTruthy()
    })
    // The roster is offered as two pickers, not as a read-only list: each is
    // labelled with its own field name and carries the reported device.
    expect(card.getByLabelText(zh['devices.mics.choose'])).toBeTruthy()
    expect(card.getByLabelText(zh['devices.speakers.choose'])).toBeTruthy()
    expect(card.getByText('Встроенный микрофон')).toBeTruthy()
  })

  it('offers the system default as an explicit choice', async () => {
    stubGrantedBrowser()
    const view = renderSection()
    const card = within(view.getByLabelText(zh['devices.title']))
    await waitFor(() => {
      expect(card.getByText(zh['devices.state.granted'])).toBeTruthy()
    })
    const picker = card.getByLabelText(zh['devices.mics.choose']) as HTMLSelectElement
    expect(picker.value).toBe('')
    const options = Array.from(picker.options).map(option => option.textContent)
    expect(options[0]).toBe(zh['devices.system'])
    expect(options).toContain('Встроенный микрофон')
  })

  it('remembers a chosen microphone in the shared document', async () => {
    stubGrantedBrowser()
    const view = renderSection()
    const card = within(view.getByLabelText(zh['devices.title']))
    await waitFor(() => {
      expect(card.getByText(zh['devices.state.granted'])).toBeTruthy()
    })
    const picker = card.getByLabelText(zh['devices.mics.choose']) as HTMLSelectElement
    await act(async () => {
      fireEvent.change(picker, { target: { value: picker.options[1]?.value ?? '' } })
    })
    const stored = JSON.parse(localStorage.getItem('dsh.voice.settings') ?? '{}') as Record<string, unknown>
    expect(stored.inputDeviceId).toBe(picker.options[1]?.value)
  })

  it('asks for the microphone when the request button is pressed', async () => {
    const nav = navigator as unknown as Record<string, unknown>
    const getUserMedia = vi.fn(() => Promise.resolve({ getTracks: () => [{ stop: () => {} }] }))
    nav.mediaDevices = {
      getUserMedia,
      enumerateDevices: () => Promise.resolve([{ kind: 'audioinput', deviceId: '', label: '' }]),
    }
    nav.permissions = {
      query: () => Promise.resolve({ state: 'prompt' }),
    }
    const view = renderSection()
    const card = within(view.getByLabelText(zh['devices.title']))
    await waitFor(() => {
      expect(card.getByText(zh['devices.state.prompt'])).toBeTruthy()
    })
    // Labels are hidden before the grant: the roster falls back to numbering.
    expect(card.getByText(`${zh['devices.unnamed']} 1`)).toBeTruthy()
    await act(async () => {
      fireEvent.click(card.getByRole('button', { name: zh['devices.request'] }))
    })
    // The probe never names an endpoint: it asks the OS for permission, and
    // the recorder's own request is the one that carries the chosen device.
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true })
  })

  it('disables the request button where capture is unavailable', async () => {
    const view = renderSection()
    const card = within(view.getByLabelText(zh['devices.title']))
    await waitFor(() => {
      expect(card.getByText(zh['devices.state.unknown'])).toBeTruthy()
    })
    expect(card.getByRole<HTMLButtonElement>('button', { name: zh['devices.request'] }).disabled).toBe(true)
    expect(card.getByText(zh['devices.none'])).toBeTruthy()
  })
})

// @vitest-environment jsdom
// ProviderCard: picking a service swaps the voice list, a call voice the
// service does not carry is said out loud instead of silently substituted, and
// the preview speaks the current choice.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { DEFAULT_VOICE_SELECTION } from '@deepseek-ai/dsh-client-ui-primitives'
import { zh } from '../src/client/locales.ts'
import type { VoiceSettingsKey } from '../src/client/locales.ts'
import { ProviderCard } from '../src/client/ProviderCard.tsx'
import type { VoiceSettings } from '../src/client/voice-settings.ts'

/**
 * Read the JSON body a stubbed `fetch` was handed.
 *
 * `RequestInit.body` is typed as `BodyInit`, so the narrowing is explicit
 * rather than a `String()` coercion — which would turn a non-string body into
 * `[object Object]` and hide a real change in what the code puts on the wire.
 * @param init - the request init captured from the stub.
 * @returns the parsed body.
 */
function jsonBodyOf(init: RequestInit): Record<string, unknown> {
  const body = init.body
  return JSON.parse(typeof body === 'string' ? body : '{}') as Record<string, unknown>
}


const t = (key: VoiceSettingsKey): string => zh[key]

/** Playback the card starts, recorded so the spec can assert on the source. */
interface FakeAudio {
  readonly src: string
  play: () => Promise<void>
  addEventListener: (type: string, listener: () => void) => void
}

/** Sources handed to `new Audio(...)` since the last reset. */
let played: string[] = []
/** Whether the fake runtime refuses to start playback. */
let playRejects = false

const originalCreateObjectURL = URL.createObjectURL.bind(URL)
const originalRevokeObjectURL = URL.revokeObjectURL.bind(URL)

beforeEach(() => {
  played = []
  playRejects = false
  vi.stubGlobal('Audio', class implements FakeAudio {
    readonly src: string
    constructor(src: string) {
      this.src = src
      played.push(src)
    }
    play(): Promise<void> {
      if (playRejects) return Promise.reject(new Error('autoplay refused'))
      return Promise.resolve()
    }
    addEventListener(): void { /* the spec never fires 'ended' */ }
  })
  URL.createObjectURL = () => 'blob:clip'
  URL.revokeObjectURL = () => {}
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  URL.createObjectURL = originalCreateObjectURL
  URL.revokeObjectURL = originalRevokeObjectURL
})
/** Render the card over a real draft state, the way the page drives it. */
function renderCard(overrides: Partial<VoiceSettings> = {}) {
  let latest = { ...DEFAULT_VOICE_SELECTION, ...overrides } as VoiceSettings
  function Harness() {
    const [draft, setDraft] = useState<VoiceSettings>(latest)
    latest = draft
    return (
      <ProviderCard
        t={t}
        draft={draft}
        patch={(next) => { setDraft(previous => ({ ...previous, ...next })) }}
      />
    )
  }
  const view = render(<Harness />)
  const card = within(view.getByLabelText(zh['provider.title']))
  return { card, current: (): VoiceSettings => latest }
}

/** Answer a voices request with a fixed catalog. */
function stubVoices(ids: readonly string[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(() => Promise.resolve(new Response(
    JSON.stringify({ voices: ids.map(id => ({ id, label: id.toUpperCase(), lang: 'ru-RU' })) }),
    { status: 200 },
  )))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('ProviderCard', () => {
  it('lists every provider and defaults to the automatic choice', () => {
    const { card } = renderCard()
    const select = card.getByLabelText(zh['provider.service']) as HTMLSelectElement
    expect(select.value).toBe('auto')
    expect(within(select).getAllByRole('option')).toHaveLength(7)
    expect(card.getByText(zh['provider.openai'])).toBeTruthy()
  })

  it('swaps the voice list and clears a voice the new service does not carry', () => {
    const { card, current } = renderCard({ provider: 'openai', ttsVoiceId: 'nova' })
    expect(card.getByLabelText<HTMLInputElement>(zh['provider.voice']).value).toBe('nova')
    act(() => {
      fireEvent.change(card.getByLabelText(zh['provider.service']), { target: { value: 'system' } })
    })
    expect(current().provider).toBe('system')
    expect(current().ttsVoiceId).toBe('')
    // The system voice has no catalog: the picker falls back to "default".
    expect(within(card.getByLabelText(zh['provider.voice'])).getAllByRole('option')).toHaveLength(1)
  })

  it('asks the service for a catalog only where the list is not shipped locally', async () => {
    const fetchMock = stubVoices(['ru-1', 'ru-2'])
    const { card } = renderCard({ provider: 'elevenlabs', ttsKey: 'key-1' })
    expect(card.getByRole('button', { name: zh['provider.voices.fetch'] })).toBeTruthy()
    await act(async () => {
      fireEvent.click(card.getByRole('button', { name: zh['provider.voices.fetch'] }))
    })
    await waitFor(() => {
      expect(within(card.getByLabelText(zh['provider.voice'])).getAllByRole('option')).toHaveLength(3)
    })
    expect(card.getByText('RU-1')).toBeTruthy()
    const [route, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(route).toBe('/api/media/voices')
    expect(init.body).toBe(JSON.stringify({ provider: 'elevenlabs' }))
  })

  it('reports a failed catalog fetch instead of an empty picker', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('nope', { status: 502 }))))
    const { card } = renderCard({ provider: 'elevenlabs' })
    await act(async () => {
      fireEvent.click(card.getByRole('button', { name: zh['provider.voices.fetch'] }))
    })
    await waitFor(() => {
      expect(card.getByText(zh['provider.voices.failed'])).toBeTruthy()
    })
  })

  it('warns when the answer voice is not one the call can use', () => {
    const { card } = renderCard({ provider: 'openai', ttsVoiceId: 'nova', callVoiceMode: 'same' })
    expect(card.getByText(zh['provider.mismatch'])).toBeTruthy()
    // The warning goes away once the call gets its own voice.
    act(() => {
      fireEvent.change(card.getByLabelText(zh['provider.mode']), { target: { value: 'own' } })
    })
    expect(card.queryByText(zh['provider.mismatch'])).toBeNull()
    expect(card.getByLabelText(zh['provider.voice.call'])).toBeTruthy()
  })

  it('stays quiet about a mismatch a provider without a call channel cannot have', () => {
    const { card } = renderCard({ provider: 'google-cloud', ttsVoiceId: 'ru-RU-Wavenet-D' })
    expect(card.queryByText(zh['provider.mismatch'])).toBeNull()
    expect(card.queryByLabelText(zh['provider.mode'])).toBeNull()
  })

  it('speaks the current choice through the gateway', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('clip', { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)
    const { card } = renderCard({ provider: 'openai', ttsVoiceId: 'nova', ttsKey: 'key-1' })
    await act(async () => {
      fireEvent.click(card.getByRole('button', { name: zh['provider.preview'] }))
    })
    const [route, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(route).toBe('/api/media/speak')
    expect(jsonBodyOf(init)).toMatchObject({
      provider: 'openai', voice: 'nova', model: 'tts-1', speed: 1, pitch: 1, text: zh['provider.preview.phrase'],
    })
    expect((init.headers as Record<string, string>)['x-dsh-media-key']).toBe('key-1')
    expect(played).toEqual(['blob:clip'])
  })

  it('reports a refused playback instead of leaving the button stuck', async () => {
    playRejects = true
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('clip', { status: 200 }))))
    const { card } = renderCard({ provider: 'openai' })
    await act(async () => {
      fireEvent.click(card.getByRole('button', { name: zh['provider.preview'] }))
    })
    await waitFor(() => {
      expect(card.getByText(zh['provider.preview.failed'])).toBeTruthy()
    })
    expect(card.getByRole('button', { name: zh['provider.preview'] })).toBeTruthy()
  })

  it('keeps the pacing sliders inside the stored bounds', () => {
    const { card, current } = renderCard()
    const speed = card.getByLabelText(zh['provider.speed']) as HTMLInputElement
    expect(speed.value).toBe('1')
    expect(speed.min).toBe('0.5')
    expect(speed.max).toBe('2')
    act(() => {
      fireEvent.change(speed, { target: { value: '1.5' } })
    })
    expect(current().ttsSpeed).toBe(1.5)
  })
})

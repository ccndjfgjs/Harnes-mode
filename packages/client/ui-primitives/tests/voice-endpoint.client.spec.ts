// @vitest-environment jsdom
// Voice endpoints: the shared reader behind the composer, the model seat, and the read-aloud.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_VOICE_SELECTION, readCallVoice, readVoiceEndpoints, readVoiceSelection,
} from '../src/voice-endpoint.ts'
import type { VoiceSelection } from '../src/voice-endpoint.ts'

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('readVoiceEndpoints', () => {
  it('answers empty endpoints for an absent document', () => {
    expect(readVoiceEndpoints()).toEqual({
      stt: { url: '', key: '' },
      tts: { url: '', key: '' },
      vision: { url: '', key: '' },
      callSignalingUrl: '',
    })
  })

  it('reads and trims every configured endpoint', () => {
    localStorage.setItem('dsh.voice.settings', JSON.stringify({
      sttUrl: ' https://stt.example.com ',
      sttKey: ' stt-key ',
      ttsUrl: 'https://tts.example.com',
      ttsKey: 'tts-key',
      visionUrl: 'https://vision.example.com',
      visionKey: 'vision-key',
      callSignalingUrl: ' wss://voice.example.com ',
    }))
    expect(readVoiceEndpoints()).toEqual({
      stt: { url: 'https://stt.example.com', key: 'stt-key' },
      tts: { url: 'https://tts.example.com', key: 'tts-key' },
      vision: { url: 'https://vision.example.com', key: 'vision-key' },
      callSignalingUrl: 'wss://voice.example.com',
    })
  })

  it('tolerates a corrupt document', () => {
    localStorage.setItem('dsh.voice.settings', '{not json')
    expect(readVoiceEndpoints().stt.url).toBe('')
  })

  it('tolerates a document that is not an object', () => {
    localStorage.setItem('dsh.voice.settings', '"text"')
    expect(readVoiceEndpoints().tts.key).toBe('')
  })

  it('tolerates a field that is not a string', () => {
    localStorage.setItem('dsh.voice.settings', JSON.stringify({ sttUrl: 42, sttKey: null }))
    expect(readVoiceEndpoints().stt).toEqual({ url: '', key: '' })
  })

  it('tolerates a storage that refuses reads', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    expect(readVoiceEndpoints().vision.url).toBe('')
  })
})

describe('readVoiceSelection', () => {
  it('answers the shipped defaults for an absent document', () => {
    expect(readVoiceSelection()).toEqual(DEFAULT_VOICE_SELECTION)
  })

  it('reads the provider, both voices, and the model', () => {
    localStorage.setItem('dsh.voice.settings', JSON.stringify({
      provider: ' openai ',
      ttsVoiceId: ' nova ',
      realtimeVoiceId: ' coral ',
      ttsModel: ' tts-1-hd ',
    }))
    expect(readVoiceSelection()).toEqual({
      provider: 'openai',
      ttsVoiceId: 'nova',
      realtimeVoiceId: 'coral',
      ttsModel: 'tts-1-hd',
      ttsSpeed: 1,
      ttsPitch: 1,
      callVoiceMode: 'same',
    })
  })

  it('reads back the document the Voice Settings page writes', () => {
    // The field name is the whole contract between the page and this reader:
    // a mismatch silently answers 'auto' and the chosen service never reaches
    // the engine. Written as a literal so the shape is pinned here too.
    localStorage.setItem('dsh.voice.settings', JSON.stringify({
      provider: 'elevenlabs',
      ttsVoiceId: 'ru-voice',
      realtimeVoiceId: '',
      ttsModel: 'eleven_multilingual_v2',
      ttsSpeed: 1.2,
      ttsPitch: 0.9,
      callVoiceMode: 'own',
      sttUrl: '', sttKey: '', ttsUrl: '', ttsKey: '',
      callSignalingUrl: '', visionUrl: '', visionKey: '',
    }))
    expect(readVoiceSelection()).toEqual({
      provider: 'elevenlabs',
      ttsVoiceId: 'ru-voice',
      realtimeVoiceId: '',
      ttsModel: 'eleven_multilingual_v2',
      ttsSpeed: 1.2,
      ttsPitch: 0.9,
      callVoiceMode: 'own',
    })
  })

  it('falls back to auto for a provider it does not know', () => {
    localStorage.setItem('dsh.voice.settings', JSON.stringify({ provider: 'nope' }))
    expect(readVoiceSelection().provider).toBe('auto')
    localStorage.setItem('dsh.voice.settings', JSON.stringify({ provider: 42 }))
    expect(readVoiceSelection().provider).toBe('auto')
  })

  it('reads the call voice mode and falls back on anything else', () => {
    localStorage.setItem('dsh.voice.settings', JSON.stringify({ callVoiceMode: 'own' }))
    expect(readVoiceSelection().callVoiceMode).toBe('own')
    localStorage.setItem('dsh.voice.settings', JSON.stringify({ callVoiceMode: 'nonsense' }))
    expect(readVoiceSelection().callVoiceMode).toBe('same')
  })

  it('clamps pacing into the allowed range', () => {
    localStorage.setItem('dsh.voice.settings', JSON.stringify({ ttsSpeed: 9, ttsPitch: 0.1 }))
    const selection = readVoiceSelection()
    expect(selection.ttsSpeed).toBe(2)
    expect(selection.ttsPitch).toBe(0.5)
  })

  it('ignores pacing that is not a number', () => {
    localStorage.setItem('dsh.voice.settings', JSON.stringify({ ttsSpeed: 'fast', ttsPitch: null }))
    const selection = readVoiceSelection()
    expect(selection.ttsSpeed).toBe(1)
    expect(selection.ttsPitch).toBe(1)
  })

  it('tolerates a corrupt document', () => {
    localStorage.setItem('dsh.voice.settings', '{not json')
    expect(readVoiceSelection()).toEqual(DEFAULT_VOICE_SELECTION)
  })

  it('tolerates a storage that refuses reads', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    expect(readVoiceSelection().provider).toBe('auto')
  })
})

describe('readCallVoice', () => {
  /** One selection with the given overrides. */
  const pick = (overrides: Partial<VoiceSelection>): VoiceSelection =>
    ({ ...DEFAULT_VOICE_SELECTION, ...overrides })

  it('names nothing while the provider is automatic', () => {
    expect(readCallVoice(pick({}))).toEqual({ provider: '', voice: '', fit: 'unset' })
  })

  it('carries the answer voice when the service offers it for calls', () => {
    // OpenAI ships both faces and lists 'alloy' in each, so the call can
    // genuinely answer in the very voice that read the answer.
    expect(readCallVoice(pick({ provider: 'openai', ttsVoiceId: 'alloy' })))
      .toEqual({ provider: 'openai', voice: 'alloy', fit: 'same' })
  })

  it('falls back to the call default and says so when the voice does not fit', () => {
    // 'nova' is an answer voice OpenAI's call face does not list.
    expect(readCallVoice(pick({ provider: 'openai', ttsVoiceId: 'nova' })))
      .toEqual({ provider: 'openai', voice: 'alloy', fit: 'substituted' })
  })

  it('takes the separately chosen call voice in own mode', () => {
    expect(readCallVoice(pick({ provider: 'openai', ttsVoiceId: 'nova', callVoiceMode: 'own', realtimeVoiceId: 'coral' })))
      .toEqual({ provider: 'openai', voice: 'coral', fit: 'own' })
  })

  it('uses the call face default in own mode when nothing was chosen', () => {
    expect(readCallVoice(pick({ provider: 'openai', callVoiceMode: 'own' })))
      .toEqual({ provider: 'openai', voice: 'alloy', fit: 'own' })
  })

  it('reports that a service without a call face cannot carry a voice', () => {
    expect(readCallVoice(pick({ provider: 'elevenlabs', ttsVoiceId: 'ru-1' })))
      .toEqual({ provider: '', voice: '', fit: 'bridged' })
  })
})

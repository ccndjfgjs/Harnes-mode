// Provider registry: the shell plus the two faces a voice service exposes.
// The two faces stay apart because one vendor's answer voice and call voice
// come from different catalogs.

import { describe, expect, it } from 'vitest'
import {
  VOICE_PROVIDERS, VOICE_PROVIDER_IDS, acceptsTtsVoice, defaultVoiceOf, hasRealtimeFace, hasTtsFace,
  isVoiceProviderId, resolveTtsModel, resolveVoice, voiceProvider,
} from '../src/voice-providers.ts'

describe('voiceProvider', () => {
  it('lists every id the document may name', () => {
    expect(VOICE_PROVIDERS.map(provider => provider.id)).toEqual([...VOICE_PROVIDER_IDS])
  })

  it('finds a provider by id', () => {
    expect(voiceProvider('openai')?.labelKey).toBe('openai')
    expect(voiceProvider('google-cloud')?.labelKey).toBe('googleCloud')
  })

  it('answers nothing for an unknown id', () => {
    expect(voiceProvider('nope' as never)).toBeUndefined()
  })
})

describe('isVoiceProviderId', () => {
  it('accepts every listed id and rejects anything else', () => {
    for (const id of VOICE_PROVIDER_IDS) expect(isVoiceProviderId(id)).toBe(true)
    expect(isVoiceProviderId('nope')).toBe(false)
    expect(isVoiceProviderId(42)).toBe(false)
    expect(isVoiceProviderId(null)).toBe(false)
  })
})

describe('faces', () => {
  it('reports which faces each provider has', () => {
    const openai = voiceProvider('openai')
    const system = voiceProvider('system')
    const auto = voiceProvider('auto')
    expect(hasTtsFace(openai!)).toBe(true)
    expect(hasRealtimeFace(openai!)).toBe(true)
    expect(hasTtsFace(system!)).toBe(true)
    expect(hasRealtimeFace(system!)).toBe(false)
    expect(hasTtsFace(auto!)).toBe(false)
    expect(hasRealtimeFace(auto!)).toBe(false)
  })

  it('keeps the answer and call catalogs apart', () => {
    const openai = voiceProvider('openai')!
    const tts = openai.tts!.voices.map(voice => voice.id)
    const realtime = openai.realtime!.voices.map(voice => voice.id)
    expect(tts).toContain('fable')
    expect(realtime).not.toContain('fable')
    expect(realtime).toContain('coral')
    expect(tts).not.toContain('coral')
  })

  it('names the credential style each provider expects', () => {
    expect(voiceProvider('openai')?.needsKey).toBe(true)
    expect(voiceProvider('google')?.needsKey).toBe(false)
    expect(voiceProvider('google-cloud')?.auth).toBe('query')
    expect(voiceProvider('elevenlabs')?.auth).toBe('header')
  })
})

describe('acceptsTtsVoice', () => {
  it('accepts a voice the realtime face lists', () => {
    expect(acceptsTtsVoice(voiceProvider('openai')!, 'alloy')).toBe('yes')
  })

  it('refuses a voice the realtime face does not list', () => {
    expect(acceptsTtsVoice(voiceProvider('openai')!, 'fable')).toBe('no')
  })

  it('refuses every voice when the provider has no realtime face', () => {
    expect(acceptsTtsVoice(voiceProvider('elevenlabs')!, 'abc')).toBe('no')
  })

  it('admits it cannot tell when the catalog is fetched at runtime', () => {
    const dynamic = { ...voiceProvider('openai')!, realtime: { defaultVoice: '', voices: [] } }
    expect(acceptsTtsVoice(dynamic, 'alloy')).toBe('unknown')
  })
})

describe('defaultVoiceOf and resolveVoice', () => {
  it('reads the face default', () => {
    const openai = voiceProvider('openai')!
    expect(defaultVoiceOf(openai, 'tts')).toBe('alloy')
    expect(defaultVoiceOf(openai, 'realtime')).toBe('alloy')
  })

  it('answers nothing when the face is absent', () => {
    expect(defaultVoiceOf(voiceProvider('auto')!, 'tts')).toBe('')
    expect(defaultVoiceOf(voiceProvider('auto')!, 'realtime')).toBe('')
  })

  it('prefers the chosen voice over the face default', () => {
    const openai = voiceProvider('openai')!
    expect(resolveVoice(openai, 'tts', 'nova')).toBe('nova')
    expect(resolveVoice(openai, 'tts', '')).toBe('alloy')
  })
})

describe('resolveTtsModel', () => {
  it('prefers the chosen model over the one the face ships', () => {
    const openai = voiceProvider('openai')!
    expect(resolveTtsModel(openai, 'tts-1-hd')).toBe('tts-1-hd')
    expect(resolveTtsModel(openai, '')).toBe('tts-1')
  })

  it('answers nothing where neither source names a model', () => {
    expect(resolveTtsModel(voiceProvider('system'), '')).toBe('')
    // An unknown provider id must not make the caller guess.
    expect(resolveTtsModel(undefined, '')).toBe('')
  })
})

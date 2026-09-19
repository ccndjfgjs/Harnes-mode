// @vitest-environment jsdom
// The voice module's own settings: whether an answer is voiced, which
// recognizer hears the question, and which endpoints record and play back.
// All of them live in the document the settings page owns, so this reader must
// tolerate whatever that page leaves behind — and this writer must not delete
// it.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_VOICE_MODULE_SETTINGS, VOICE_REPLY_MODES, isAnswerVoiced, isVoiceReplyMode,
  readVoiceModuleSettings, writeVoiceModuleSettings,
} from '../src/voice/voice-module-settings.ts'
import type { VoiceModuleSettings } from '../src/voice/voice-module-settings.ts'

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

/** Store one settings document. */
function store(document_: unknown): void {
  localStorage.setItem('dsh.voice.settings', JSON.stringify(document_))
}

describe('readVoiceModuleSettings', () => {
  it('answers the shipped defaults when nothing is stored', () => {
    expect(readVoiceModuleSettings()).toEqual(DEFAULT_VOICE_MODULE_SETTINGS)
  })

  it('ships with the answer read aloud and the recognizer chosen automatically', () => {
    expect(DEFAULT_VOICE_MODULE_SETTINGS).toEqual({ replyMode: 'speak', sttEngine: 'auto', inputDeviceId: '', outputDeviceId: '' })
  })

  it('reads both of its own fields', () => {
    store({ voiceReplyMode: 'off', sttEngine: 'service' })
    expect(readVoiceModuleSettings()).toEqual({ replyMode: 'off', sttEngine: 'service', inputDeviceId: '', outputDeviceId: '' })
  })

  it('trims what it reads', () => {
    store({ voiceReplyMode: ' speak ', sttEngine: ' local ' })
    expect(readVoiceModuleSettings()).toEqual({ replyMode: 'speak', sttEngine: 'local', inputDeviceId: '', outputDeviceId: '' })
  })

  it('understands a reply mode written by a newer build', () => {
    store({ voiceReplyMode: 'voice-message' })
    expect(readVoiceModuleSettings().replyMode).toBe('voice-message')
  })

  it('falls back on an unknown reply mode without discarding the engine', () => {
    store({ voiceReplyMode: 'telepathy', sttEngine: 'local' })
    expect(readVoiceModuleSettings()).toEqual({ replyMode: 'speak', sttEngine: 'local', inputDeviceId: '', outputDeviceId: '' })
  })

  it('falls back on an unknown engine without discarding the reply mode', () => {
    store({ voiceReplyMode: 'off', sttEngine: 'whisper-9000' })
    expect(readVoiceModuleSettings()).toEqual({ replyMode: 'off', sttEngine: 'auto', inputDeviceId: '', outputDeviceId: '' })
  })

  it('ignores fields that are not strings', () => {
    store({ voiceReplyMode: 1, sttEngine: null })
    expect(readVoiceModuleSettings()).toEqual(DEFAULT_VOICE_MODULE_SETTINGS)
  })

  it('tolerates a corrupt document', () => {
    localStorage.setItem('dsh.voice.settings', '{not json')
    expect(readVoiceModuleSettings()).toEqual(DEFAULT_VOICE_MODULE_SETTINGS)
  })

  it('tolerates a document that is not an object', () => {
    localStorage.setItem('dsh.voice.settings', '"text"')
    expect(readVoiceModuleSettings()).toEqual(DEFAULT_VOICE_MODULE_SETTINGS)
  })

  it('tolerates a storage that refuses reads', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    expect(readVoiceModuleSettings()).toEqual(DEFAULT_VOICE_MODULE_SETTINGS)
  })

  it('reads only its own fields, leaving the rest of the document to the shared reader', () => {
    store({ voiceReplyMode: 'off', sttEngine: 'local', ttsVoiceId: 'coral', sttUrl: 'https://stt.example.com' })
    expect(Object.keys(readVoiceModuleSettings()).sort()).toEqual(['inputDeviceId', 'outputDeviceId', 'replyMode', 'sttEngine'])
  })
})

describe('isVoiceReplyMode', () => {
  it('accepts every offered mode', () => {
    for (const mode of VOICE_REPLY_MODES) expect(isVoiceReplyMode(mode)).toBe(true)
  })

  it('offers the three modes the settings card shows', () => {
    expect(VOICE_REPLY_MODES).toEqual(['off', 'speak', 'voice-message'])
  })

  it('refuses anything else', () => {
    expect(isVoiceReplyMode('shout')).toBe(false)
    expect(isVoiceReplyMode(false)).toBe(false)
  })
})

describe('isAnswerVoiced', () => {
  /** Inspect one reply mode. */
  function voiced(mode: VoiceModuleSettings['replyMode']): boolean {
    return isAnswerVoiced({ replyMode: mode, sttEngine: 'auto', inputDeviceId: '', outputDeviceId: '' })
  }

  it('answers nothing to say when the reply mode is off', () => {
    expect(voiced('off')).toBe(false)
  })

  it('voices the answer when it should be read aloud', () => {
    expect(voiced('speak')).toBe(true)
  })

  it('voices the answer when it should become a voice message', () => {
    expect(voiced('voice-message')).toBe(true)
  })

  it('reads the stored document when given nothing', () => {
    store({ voiceReplyMode: 'off' })
    expect(isAnswerVoiced()).toBe(false)
  })
})

describe('device selection', () => {
  it('reads the chosen endpoints', () => {
    store({ inputDeviceId: 'mic-a', outputDeviceId: 'spk-b' })
    expect(readVoiceModuleSettings().inputDeviceId).toBe('mic-a')
    expect(readVoiceModuleSettings().outputDeviceId).toBe('spk-b')
  })

  it('means the system default when nothing is chosen', () => {
    store({ voiceReplyMode: 'off' })
    expect(readVoiceModuleSettings().inputDeviceId).toBe('')
    expect(readVoiceModuleSettings().outputDeviceId).toBe('')
  })

  it('ignores a device id that is not a string', () => {
    store({ inputDeviceId: 42, outputDeviceId: null })
    expect(readVoiceModuleSettings().inputDeviceId).toBe('')
    expect(readVoiceModuleSettings().outputDeviceId).toBe('')
  })
})

describe('writeVoiceModuleSettings', () => {
  it('stores the chosen endpoints', () => {
    writeVoiceModuleSettings({ replyMode: 'off', sttEngine: 'local', inputDeviceId: 'mic-a', outputDeviceId: 'spk-b' })
    expect(readVoiceModuleSettings()).toEqual({
      replyMode: 'off', sttEngine: 'local', inputDeviceId: 'mic-a', outputDeviceId: 'spk-b',
    })
  })

  it('keeps the fields the settings page owns', () => {
    // The page writes endpoints, keys, and the chosen voice into this very
    // document; a module write that replaced it wholesale would delete them.
    store({ ttsVoiceId: 'coral', sttUrl: 'https://stt.example.com', ttsSpeed: 1.5 })
    writeVoiceModuleSettings({ replyMode: 'speak', sttEngine: 'auto', inputDeviceId: 'mic-a', outputDeviceId: '' })
    const raw = JSON.parse(localStorage.getItem('dsh.voice.settings') ?? '{}') as Record<string, unknown>
    expect(raw.ttsVoiceId).toBe('coral')
    expect(raw.sttUrl).toBe('https://stt.example.com')
    expect(raw.ttsSpeed).toBe(1.5)
    expect(raw.inputDeviceId).toBe('mic-a')
  })

  it('tolerates a storage that refuses writes', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    expect(() => {
      writeVoiceModuleSettings({ replyMode: 'off', sttEngine: 'auto', inputDeviceId: '', outputDeviceId: '' })
    }).not.toThrow()
  })
})

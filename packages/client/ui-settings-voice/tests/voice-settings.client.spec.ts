// @vitest-environment jsdom
// Voice-settings store: blank defaults, tolerant reads, trimmed writes, and
// the configured predicates the composer preflight relies on.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EMPTY_VOICE_SETTINGS, isCallConfigured, isSttConfigured,
  isVisionConfigured, isVoiceConfigured, readVoiceSettings,
  VOICE_SETTINGS_STORAGE_KEY, writeVoiceSettings,
} from '../src/client/voice-settings.ts'

afterEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
})

/** Minimal stand-in for the browser recognition constructor. */
class FakeRecognition {
  start(): void {}
  stop(): void {}
  abort(): void {}
}

/** Minimal stand-in for the browser speech-synthesis engine. */
const FAKE_SYNTHESIS = { cancel: () => {}, getVoices: () => [], speak: () => {} }

describe('readVoiceSettings', () => {
  it('reads blank settings when nothing is stored', () => {
    expect(readVoiceSettings()).toEqual(EMPTY_VOICE_SETTINGS)
  })

  it('reads a stored document and trims every field', () => {
    localStorage.setItem(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify({
      sttUrl: ' https://stt.example ', sttKey: ' k ', ttsUrl: '', ttsKey: '',
      callSignalingUrl: '', visionUrl: '', visionKey: '',
      // Left over from the removed inert permission flags: a stored document
      // may still carry them, and the read must simply ignore them.
      micPermission: true, camPermission: true, screenPermission: true,
    }))
    const result = readVoiceSettings()
    expect(result.sttUrl).toBe('https://stt.example')
    expect(result.sttKey).toBe('k')
    expect(result.ttsUrl).toBe('')
    expect(result.ttsKey).toBe('')
    expect('micPermission' in result).toBe(false)
  })

  it('treats a corrupt document as absent', () => {
    localStorage.setItem(VOICE_SETTINGS_STORAGE_KEY, '{nope')
    expect(readVoiceSettings()).toEqual(EMPTY_VOICE_SETTINGS)
  })

  it('treats a non-object document as absent', () => {
    localStorage.setItem(VOICE_SETTINGS_STORAGE_KEY, '"just a string"')
    expect(readVoiceSettings()).toEqual(EMPTY_VOICE_SETTINGS)
  })

  it('treats non-string fields as blank', () => {
    localStorage.setItem(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify({ sttUrl: 42, sttKey: null }))
    expect(readVoiceSettings()).toEqual(EMPTY_VOICE_SETTINGS)
  })
})

describe('writeVoiceSettings', () => {
  it('merges a patch over the stored document', () => {
    writeVoiceSettings({ sttUrl: 'https://stt.example', sttKey: 'k' })
    writeVoiceSettings({ ttsUrl: 'https://tts.example' })
    const result = readVoiceSettings()
    expect(result.sttUrl).toBe('https://stt.example')
    expect(result.sttKey).toBe('k')
    expect(result.ttsUrl).toBe('https://tts.example')
    expect(result.ttsKey).toBe('')
  })
})

describe('configured predicates', () => {
  it('reports STT configured only with both fields', () => {
    expect(isSttConfigured()).toBe(false)
    expect(isSttConfigured({ ...EMPTY_VOICE_SETTINGS, sttUrl: 'https://stt.example' })).toBe(false)
    expect(isSttConfigured({
      ...EMPTY_VOICE_SETTINGS, sttUrl: 'https://stt.example', sttKey: 'k',
    })).toBe(true)
  })

  it('reports full voice configured only with all four fields', () => {
    expect(isVoiceConfigured()).toBe(false)
    expect(isVoiceConfigured({
      ...EMPTY_VOICE_SETTINGS, sttUrl: 'https://stt.example', sttKey: 'k',
    })).toBe(false)
    expect(isVoiceConfigured({
      ...EMPTY_VOICE_SETTINGS,
      sttUrl: 'https://stt.example', sttKey: 'k', ttsUrl: 'https://tts.example', ttsKey: 'k2',
    })).toBe(true)
  })

  it('reports call configured with signaling URL', () => {
    expect(isCallConfigured()).toBe(false)
    expect(isCallConfigured({ ...EMPTY_VOICE_SETTINGS, callSignalingUrl: 'wss://call.example' })).toBe(true)
  })

  it('reports vision configured with vision URL', () => {
    expect(isVisionConfigured()).toBe(false)
    expect(isVisionConfigured({ ...EMPTY_VOICE_SETTINGS, visionUrl: 'https://vision.example' })).toBe(true)
  })

})

describe('browser-local engines', () => {
  it('opens dictation with nothing stored once the browser recognizes speech', () => {
    expect(isSttConfigured()).toBe(false)
    vi.stubGlobal('SpeechRecognition', FakeRecognition)
    expect(isSttConfigured()).toBe(true)
  })

  it('accepts the webkit-prefixed constructor too', () => {
    vi.stubGlobal('webkitSpeechRecognition', FakeRecognition)
    expect(isSttConfigured()).toBe(true)
  })

  it('opens voice mode only when the browser also speaks', () => {
    vi.stubGlobal('SpeechRecognition', FakeRecognition)
    expect(isVoiceConfigured()).toBe(false)
    vi.stubGlobal('speechSynthesis', FAKE_SYNTHESIS)
    expect(isVoiceConfigured()).toBe(true)
  })

  it('opens calls locally without a signaling server', () => {
    expect(isCallConfigured()).toBe(false)
    vi.stubGlobal('SpeechRecognition', FakeRecognition)
    expect(isCallConfigured()).toBe(true)
  })

  it('keeps the external vision path opt-in, so screen capture stays local', () => {
    vi.stubGlobal('SpeechRecognition', FakeRecognition)
    expect(isVisionConfigured()).toBe(false)
    expect(isVisionConfigured({ ...EMPTY_VOICE_SETTINGS, visionUrl: 'https://vision.example' })).toBe(true)
  })

  it('still honors a stored external service when the local engine exists', () => {
    vi.stubGlobal('SpeechRecognition', FakeRecognition)
    expect(isSttConfigured({
      ...EMPTY_VOICE_SETTINGS, sttUrl: 'https://stt.example', sttKey: 'k',
    })).toBe(true)
  })
})

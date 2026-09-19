// @vitest-environment jsdom
// Voice-service preflight and sound preference over the browser-local documents.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkVoiceService, hasRemoteVision, isSoundEnabled } from '../src/client/skeleton/media-service.ts'

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

describe('checkVoiceService', () => {
  it('reports unconnected when nothing is stored', () => {
    expect(checkVoiceService('stt')).toEqual({ ready: false, noticeKey: 'media.service.unconnected' })
    expect(checkVoiceService('voice')).toEqual({ ready: false, noticeKey: 'media.service.unconnected' })
  })

  it('treats a corrupt document as unconnected', () => {
    localStorage.setItem('dsh.voice.settings', '{nope')
    expect(checkVoiceService('stt').ready).toBe(false)
  })

  it('requires only STT for dictation but everything for a call', () => {
    localStorage.setItem('dsh.voice.settings', JSON.stringify({ sttUrl: 'https://stt.example', sttKey: 'k' }))
    expect(checkVoiceService('stt')).toEqual({ ready: true, engine: 'remote' })
    expect(checkVoiceService('voice').ready).toBe(false)
    localStorage.setItem('dsh.voice.settings', JSON.stringify({
      sttUrl: 'https://stt.example', sttKey: 'k', ttsUrl: 'https://tts.example', ttsKey: 'k2',
    }))
    expect(checkVoiceService('voice')).toEqual({ ready: true, engine: 'remote' })
  })

  it('prefers the local engine and needs nothing stored for it', () => {
    vi.stubGlobal('SpeechRecognition', FakeRecognition)
    vi.stubGlobal('speechSynthesis', FAKE_SYNTHESIS)
    expect(checkVoiceService('stt')).toEqual({ ready: true, engine: 'local' })
    expect(checkVoiceService('voice')).toEqual({ ready: true, engine: 'local' })
  })

  it('keeps dictation local while the browser cannot speak', () => {
    vi.stubGlobal('SpeechRecognition', FakeRecognition)
    expect(checkVoiceService('stt')).toEqual({ ready: true, engine: 'local' })
    expect(checkVoiceService('voice').ready).toBe(false)
  })

  it('falls back to the stored service when the local engine is missing', () => {
    vi.stubGlobal('speechSynthesis', FAKE_SYNTHESIS)
    localStorage.setItem('dsh.voice.settings', JSON.stringify({
      sttUrl: 'https://stt.example', sttKey: 'k', ttsUrl: 'https://tts.example', ttsKey: 'k2',
    }))
    expect(checkVoiceService('voice')).toEqual({ ready: true, engine: 'remote' })
  })

  it('lets the local engine ignore a corrupt document', () => {
    localStorage.setItem('dsh.voice.settings', '{nope')
    vi.stubGlobal('SpeechRecognition', FakeRecognition)
    expect(checkVoiceService('stt')).toEqual({ ready: true, engine: 'local' })
  })
})

describe('hasRemoteVision', () => {
  it('is false without a stored vision endpoint', () => {
    expect(hasRemoteVision()).toBe(false)
    localStorage.setItem('dsh.voice.settings', JSON.stringify({ sttUrl: 'https://stt.example' }))
    expect(hasRemoteVision()).toBe(false)
  })

  it('is true once a vision endpoint is stored, and tolerates corruption', () => {
    localStorage.setItem('dsh.voice.settings', JSON.stringify({ visionUrl: 'https://vision.example' }))
    expect(hasRemoteVision()).toBe(true)
    localStorage.setItem('dsh.voice.settings', '{nope')
    expect(hasRemoteVision()).toBe(false)
  })
})

describe('isSoundEnabled', () => {
  it('defaults to on without a stored document', () => {
    expect(isSoundEnabled()).toBe(true)
  })

  it('follows the stored preference and tolerates corruption', () => {
    localStorage.setItem('dsh.accessibility.settings', JSON.stringify({ sound: false }))
    expect(isSoundEnabled()).toBe(false)
    localStorage.setItem('dsh.accessibility.settings', JSON.stringify({ sound: true }))
    expect(isSoundEnabled()).toBe(true)
    localStorage.setItem('dsh.accessibility.settings', '{nope')
    expect(isSoundEnabled()).toBe(true)
  })
})

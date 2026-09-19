// @vitest-environment jsdom
// Voice-over: silent without speechSynthesis, Russian voice with it.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cancelSpeech,
  getTtsBackend,
  isSpeechSynthesisAvailable,
  pickRussianVoice,
  setTtsBackend,
  speak,
  speakCode,
  speakText,
  speakWithBackend,
  webSpeechBackend,
  type SpeechLifecycle,
  type TtsBackend,
} from '../src/speech-synthesis.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
  setTtsBackend(null)
})

class FakeUtterance {
  static instances: FakeUtterance[] = []
  text: string
  rate = 1
  pitch = 1
  volume = 1
  lang = ''
  voice: unknown = undefined
  onstart: (() => void) | null = null
  onend: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(text: string) {
    this.text = text
    FakeUtterance.instances.push(this)
  }
}

/** The one utterance the engine was handed. */
function onlyUtterance(): FakeUtterance {
  const utterance = FakeUtterance.instances[0]
  if (utterance === undefined) throw new Error('nothing was spoken')
  return utterance
}

function stubSpeech(voices: { lang: string }[] = []) {
  FakeUtterance.instances = []
  const cancel = vi.fn()
  const spoken: unknown[] = []
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance)
  vi.stubGlobal('speechSynthesis', {
    cancel,
    getVoices: () => voices,
    speak: (utterance: unknown) => {
      spoken.push(utterance)
    },
  })
  return { cancel, spoken }
}

describe('isSpeechSynthesisAvailable', () => {
  it('is false without the Web Speech API', () => {
    expect(isSpeechSynthesisAvailable()).toBe(false)
  })

  it('is true with the API present', () => {
    stubSpeech()
    expect(isSpeechSynthesisAvailable()).toBe(true)
  })
})

describe('pickRussianVoice', () => {
  it('prefers the Russian voice', () => {
    const voices = [{ lang: 'en-US' }, { lang: 'ru-RU' }] as SpeechSynthesisVoice[]
    expect(pickRussianVoice(voices)?.lang).toBe('ru-RU')
  })

  it('returns undefined when no Russian voice exists', () => {
    const voices = [{ lang: 'en-US' }] as SpeechSynthesisVoice[]
    expect(pickRussianVoice(voices)).toBeUndefined()
  })
})

describe('speak', () => {
  it('is a silent no-op without the API', () => {
    expect(() => {
      speak('hello')
    }).not.toThrow()
  })

  it('ignores empty text', () => {
    stubSpeech()
    speak('')
    expect(FakeUtterance.instances).toHaveLength(0)
  })

  it('cancels previous speech and speaks Russian by default', () => {
    const { cancel, spoken } = stubSpeech([{ lang: 'en-US' }, { lang: 'ru-RU' }])
    speak('hello world')
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(spoken).toHaveLength(1)
    const [utterance] = FakeUtterance.instances
    expect(utterance?.text).toBe('hello world')
    expect(utterance?.lang).toBe('ru-RU')
    expect(utterance?.voice).toEqual({ lang: 'ru-RU' })
    expect(utterance?.rate).toBe(1)
    expect(utterance?.pitch).toBe(1)
    expect(utterance?.volume).toBe(1)
  })

  it('honors rate/pitch/volume/lang overrides', () => {
    stubSpeech()
    speak('test', { rate: 1.5, pitch: 0.8, volume: 0.5, lang: 'en-US' })
    const [utterance] = FakeUtterance.instances
    expect(utterance?.rate).toBe(1.5)
    expect(utterance?.pitch).toBe(0.8)
    expect(utterance?.volume).toBe(0.5)
    expect(utterance?.lang).toBe('en-US')
    expect(utterance?.voice).toBeUndefined()
  })
})

describe('speakCode', () => {
  it('announces line counts in brief mode by default', () => {
    stubSpeech()
    speakCode(['const x = 1', 'const y = 2'])
    expect(FakeUtterance.instances).toHaveLength(1)
    expect(FakeUtterance.instances[0]?.text).toBe('Код, строк: 2')
  })

  it('reads sanitized code in full mode', () => {
    stubSpeech()
    speakCode(['const x = 1'], 'full')
    expect(FakeUtterance.instances[0]?.text).toBe('const x равно 1')
  })

  it('is a no-op for empty code', () => {
    stubSpeech()
    speakCode([])
    expect(FakeUtterance.instances).toHaveLength(0)
  })

  it('defaults to the Accessibility code-reading mode', () => {
    stubSpeech()
    localStorage.setItem('dsh.accessibility.settings', JSON.stringify({ codeReading: 'line' }))
    speakCode(['const x = 1', 'const y = 2'])
    expect(FakeUtterance.instances[0]?.text).toBe('Строка 1: const x равно 1\nСтрока 2: const y равно 2')
  })
})

describe('speakText', () => {
  it('strips Markdown when the preference is on', () => {
    stubSpeech()
    localStorage.setItem('dsh.accessibility.settings', JSON.stringify({ stripMarkdown: true }))
    speakText('**bold** and `code`')
    expect(FakeUtterance.instances[0]?.text).toBe('bold and code')
  })

  it('strips by default with no stored document', () => {
    stubSpeech()
    speakText('**bold**')
    expect(FakeUtterance.instances[0]?.text).toBe('bold')
  })

  it('reads text verbatim when stripping is off', () => {
    stubSpeech()
    localStorage.setItem('dsh.accessibility.settings', JSON.stringify({ stripMarkdown: false }))
    speakText('**bold**')
    expect(FakeUtterance.instances[0]?.text).toBe('**bold**')
  })

  it('is a no-op for empty text', () => {
    stubSpeech()
    speakText('')
    expect(FakeUtterance.instances).toHaveLength(0)
  })
})

describe('the installed backend', () => {
  /** A backend that records what it was asked to say. */
  function recordingBackend(available = true) {
    const said: { text: string; options: unknown }[] = []
    const cancel = vi.fn()
    const backend: TtsBackend = {
      isAvailable: () => available,
      speak: (text, options) => { said.push({ text, options }) },
      cancel,
    }
    setTtsBackend(backend)
    return { backend, said, cancel }
  }

  it('is the built-in voice until something replaces it', () => {
    expect(getTtsBackend()).toBe(webSpeechBackend)
  })

  it('reads an answer aloud, so the chosen provider is never bypassed', () => {
    // The whole point: speakText is the entry point every surface uses, so it
    // must go through the engine that knows the configured provider and voice.
    const { said, cancel } = recordingBackend()
    speakText('**Готово**')
    expect(said).toEqual([{ text: 'Готово', options: {} }])
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('reads code aloud through the same backend', () => {
    const { said } = recordingBackend()
    speakCode(['const x = 1'], 'full')
    expect(said[0]?.text).toBe('const x равно 1')
  })

  it('passes pacing through to the backend', () => {
    const { said } = recordingBackend()
    speakText('текст', { rate: 1.4 })
    expect(said[0]?.options).toEqual({ rate: 1.4 })
  })

  it('stays silent where the backend cannot speak', () => {
    const { said, cancel } = recordingBackend(false)
    speakText('текст')
    expect(said).toEqual([])
    expect(cancel).not.toHaveBeenCalled()
  })

  it('restores the built-in voice when the engine is uninstalled', () => {
    recordingBackend()
    setTtsBackend(null)
    expect(getTtsBackend()).toBe(webSpeechBackend)
  })

  it('survives a backend that throws, because speech is only feedback', () => {
    setTtsBackend({
      isAvailable: () => true,
      speak: () => { throw new Error('engine exploded') },
      cancel: () => {},
    })
    expect(() => { speakWithBackend('текст') }).not.toThrow()
  })

  it('does not cancel when there is nothing to say', () => {
    const { cancel } = recordingBackend()
    speakWithBackend('')
    expect(cancel).not.toHaveBeenCalled()
  })
})

describe('cancelSpeech', () => {
  it('is a silent no-op without the API', () => {
    expect(() => {
      cancelSpeech()
    }).not.toThrow()
  })

  it('cancels current speech', () => {
    const { cancel } = stubSpeech()
    cancelSpeech()
    expect(cancel).toHaveBeenCalledTimes(1)
  })
})

describe('watching one utterance', () => {
  it('reports that the voice began and finished', () => {
    stubSpeech()
    const seen: SpeechLifecycle[] = []
    speak('привет', { onLifecycle: (event) => { seen.push(event) } })
    const utterance = onlyUtterance()
    utterance.onstart?.()
    utterance.onend?.()
    expect(seen).toEqual(['start', 'end'])
  })

  it('reports a refusal', () => {
    stubSpeech()
    const seen: SpeechLifecycle[] = []
    speak('привет', { onLifecycle: (event) => { seen.push(event) } })
    onlyUtterance().onerror?.()
    expect(seen).toEqual(['error'])
  })

  it('wires nothing when nobody is watching', () => {
    stubSpeech()
    speak('привет')
    const utterance = onlyUtterance()
    expect(utterance.onstart).toBeNull()
    expect(utterance.onend).toBeNull()
    expect(utterance.onerror).toBeNull()
  })

  it('watches through the app-wide entry point as well', () => {
    stubSpeech()
    const seen: SpeechLifecycle[] = []
    speakWithBackend('привет', { onLifecycle: (event) => { seen.push(event) } })
    onlyUtterance().onend?.()
    expect(seen).toEqual(['end'])
  })

  it('is silent without the API even when watched', () => {
    const seen: SpeechLifecycle[] = []
    speak('привет', { onLifecycle: (event) => { seen.push(event) } })
    expect(seen).toEqual([])
  })
})

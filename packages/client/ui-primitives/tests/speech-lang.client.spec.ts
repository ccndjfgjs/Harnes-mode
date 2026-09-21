import { describe, expect, it } from 'vitest'
import { resolveSpeechLang } from '../src/speech-synthesis.ts'

describe('resolveSpeechLang', () => {
  it('maps the program languages to speech tags', () => {
    expect(resolveSpeechLang('ru')).toBe('ru-RU')
    expect(resolveSpeechLang('en')).toBe('en-US')
    expect(resolveSpeechLang('zh-CN')).toBe('zh-CN')
    expect(resolveSpeechLang('zh')).toBe('zh-CN')
  })

  it('falls back to Russian for anything unknown', () => {
    expect(resolveSpeechLang('')).toBe('ru-RU')
    expect(resolveSpeechLang('xx')).toBe('ru-RU')
  })
})

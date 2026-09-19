// Speech-text helpers: Markdown stripping and code-reading modes.

import { describe, expect, it } from 'vitest'
import { describeCodeForSpeech, stripMarkdownForSpeech } from '../src/speech-text.ts'

describe('stripMarkdownForSpeech', () => {
  it('returns empty for empty input', () => {
    expect(stripMarkdownForSpeech('')).toBe('')
  })

  it('drops fenced and inline code markers but keeps the code', () => {
    expect(stripMarkdownForSpeech('```js\nconst a = 1\n```')).toBe('const a равно 1')
    expect(stripMarkdownForSpeech('вызов `foo()` здесь')).toBe('вызов foo() здесь')
  })

  it('drops headings, emphasis, links, and tags', () => {
    expect(stripMarkdownForSpeech('# Заголовок')).toBe('Заголовок')
    expect(stripMarkdownForSpeech('**жирно** и *курсив*')).toBe('жирно и курсив')
    expect(stripMarkdownForSpeech('[текст](https://x)')).toBe('текст')
    expect(stripMarkdownForSpeech('a<br>b')).toBe('ab')
  })

  it('reads operators as Russian words, longest match first', () => {
    expect(stripMarkdownForSpeech('a === b')).toBe('a строго равно b')
    expect(stripMarkdownForSpeech('a !== b')).toBe('a не строго равно b')
    expect(stripMarkdownForSpeech('f => f && g || h')).toBe('f стрелка f и g или h')
  })

  it('announces HTML comments and collapses blank lines', () => {
    expect(stripMarkdownForSpeech('<!-- тихо -->\n\n\nтекст')).toBe('комментарий: тихо конец комментария \n\nтекст')
  })
})

describe('describeCodeForSpeech', () => {
  it('returns empty for no lines', () => {
    expect(describeCodeForSpeech([], 'full')).toBe('')
  })

  it('announces only the count in brief mode', () => {
    expect(describeCodeForSpeech(['a = 1', 'b = 2'], 'brief')).toBe('Код, строк: 2')
  })

  it('numbers every line in line mode', () => {
    expect(describeCodeForSpeech(['# Заг', 'a === b'], 'line')).toBe('Строка 1: Заг\nСтрока 2: a строго равно b')
  })

  it('reads everything at once in full mode', () => {
    expect(describeCodeForSpeech(['a = 1', 'b = 2'], 'full')).toBe('a равно 1\nb равно 2')
  })
})

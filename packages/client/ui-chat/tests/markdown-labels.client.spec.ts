// @vitest-environment jsdom
// Chat markdown chrome: fence copy/speak labels and the region-name composer.

import { describe, expect, it } from 'vitest'
import { markdownLabels } from '../src/client/markdown-labels.ts'

function stubT(key: string, params?: Record<string, unknown>): string {
  if (key === 'markdown.code.label') return `Код, строк: ${String(params?.lines)}`
  if (key === 'markdown.code.labelLang') return `Код ${String(params?.lang)}, строк: ${String(params?.lines)}`
  return key
}

describe('markdownLabels', () => {
  it('labels the fence region with and without a language', () => {
    const labels = markdownLabels(stubT)
    expect(labels.code.describeCode?.(undefined, 3)).toBe('Код, строк: 3')
    expect(labels.code.describeCode?.('ts', 1)).toBe('Код ts, строк: 1')
  })

  it('forwards the copy and speak chrome', () => {
    const labels = markdownLabels(stubT)
    expect(labels.code.copyLabel).toBe('copy')
    expect(labels.code.copiedLabel).toBe('copied')
    expect(labels.code.speakLabel).toBe('markdown.code.speak')
    expect(labels.footnotes).toBe('markdown.footnotes')
  })
})

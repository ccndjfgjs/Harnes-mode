// @vitest-environment jsdom
// Accessibility store: defaults, field-by-field tolerance, and merged writes.

import { afterEach, describe, expect, it } from 'vitest'
import {
  ACCESSIBILITY_SETTINGS_STORAGE_KEY, DEFAULT_ACCESSIBILITY_SETTINGS,
  readAccessibilitySettings, writeAccessibilitySettings,
} from '@deepseek-ai/dsh-client-ui-primitives/src/accessibility-settings.ts'

afterEach(() => {
  localStorage.clear()
})

describe('readAccessibilitySettings', () => {
  it('reads defaults when nothing is stored', () => {
    expect(readAccessibilitySettings()).toEqual(DEFAULT_ACCESSIBILITY_SETTINGS)
  })

  it('reads a stored document', () => {
    localStorage.setItem(ACCESSIBILITY_SETTINGS_STORAGE_KEY, JSON.stringify({
      codeReading: 'full', sound: false, font: 'mono', stripMarkdown: false, contrast: 'yellow', voiceNav: true, voiceNavHover: true, voiceNavArrow: true, voiceNavDelay: 300, voiceNavChatTrigger: 'click',
    }))
    expect(readAccessibilitySettings()).toEqual({
      codeReading: 'full', sound: false, font: 'mono', stripMarkdown: false, contrast: 'yellow', voiceNav: true, voiceNavHover: true, voiceNavArrow: true, voiceNavDelay: 300, voiceNavChatTrigger: 'click',
    })
  })

  it('treats a corrupt document as defaults', () => {
    localStorage.setItem(ACCESSIBILITY_SETTINGS_STORAGE_KEY, '{nope')
    expect(readAccessibilitySettings()).toEqual(DEFAULT_ACCESSIBILITY_SETTINGS)
  })

  it('falls back per field instead of resetting the rest', () => {
    localStorage.setItem(ACCESSIBILITY_SETTINGS_STORAGE_KEY, JSON.stringify({
      codeReading: 'line', sound: 'yes', font: 'comic', contrast: 'bw',
    }))
    expect(readAccessibilitySettings()).toEqual({
      ...DEFAULT_ACCESSIBILITY_SETTINGS, codeReading: 'line', contrast: 'bw', voiceNav: false,
    })
  })
})

describe('writeAccessibilitySettings', () => {
  it('merges a patch over the stored document', () => {
    writeAccessibilitySettings({ contrast: 'daltonism' })
    writeAccessibilitySettings({ codeReading: 'full' })
    expect(readAccessibilitySettings()).toEqual({
      ...DEFAULT_ACCESSIBILITY_SETTINGS, contrast: 'daltonism', codeReading: 'full',
    })
  })
})

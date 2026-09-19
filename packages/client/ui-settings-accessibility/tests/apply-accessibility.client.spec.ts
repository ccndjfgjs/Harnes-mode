// @vitest-environment jsdom
// Root applier: font and contrast land on the element, nothing else.

import { describe, expect, it } from 'vitest'
import {
  A11Y_CONTRAST_ATTRIBUTE, A11Y_FONT_ATTRIBUTE,
  applyAccessibilitySettings, retractAccessibilitySettings,
} from '../src/client/apply-accessibility.ts'
import { DEFAULT_ACCESSIBILITY_SETTINGS } from '@deepseek-ai/dsh-client-ui-primitives'

describe('applyAccessibilitySettings', () => {
  it('projects font and contrast onto the element', () => {
    const root = document.createElement('div')
    applyAccessibilitySettings({
      ...DEFAULT_ACCESSIBILITY_SETTINGS, font: 'mono', contrast: 'bw',
    }, root)
    expect(root.getAttribute(A11Y_FONT_ATTRIBUTE)).toBe('mono')
    expect(root.getAttribute(A11Y_CONTRAST_ATTRIBUTE)).toBe('bw')
  })

  it('replaces previous values on re-apply and leaves foreign attributes alone', () => {
    const root = document.createElement('div')
    root.setAttribute('data-foreign', 'keep')
    applyAccessibilitySettings(DEFAULT_ACCESSIBILITY_SETTINGS, root)
    expect(root.getAttribute(A11Y_FONT_ATTRIBUTE)).toBe('atkinson')
    expect(root.getAttribute(A11Y_CONTRAST_ATTRIBUTE)).toBe('none')
    applyAccessibilitySettings({
      ...DEFAULT_ACCESSIBILITY_SETTINGS, font: 'mono', contrast: 'yellow',
    }, root)
    expect(root.getAttribute(A11Y_FONT_ATTRIBUTE)).toBe('mono')
    expect(root.getAttribute(A11Y_CONTRAST_ATTRIBUTE)).toBe('yellow')
    expect(root.getAttribute('data-foreign')).toBe('keep')
  })
})

describe('retractAccessibilitySettings', () => {
  it('removes only the owned attributes', () => {
    const root = document.createElement('div')
    root.setAttribute('data-foreign', 'keep')
    applyAccessibilitySettings(DEFAULT_ACCESSIBILITY_SETTINGS, root)
    retractAccessibilitySettings(root)
    expect(root.hasAttribute(A11Y_FONT_ATTRIBUTE)).toBe(false)
    expect(root.hasAttribute(A11Y_CONTRAST_ATTRIBUTE)).toBe(false)
    expect(root.getAttribute('data-foreign')).toBe('keep')
  })
})

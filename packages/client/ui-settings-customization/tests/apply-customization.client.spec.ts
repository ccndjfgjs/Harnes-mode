// @vitest-environment jsdom
// Root applier: accent/density/background land on the element, nothing else.

import { describe, expect, it } from 'vitest'
import {
  ACCENT_ATTRIBUTE, BACKGROUND_ATTRIBUTE, CODE_WRAP_ATTRIBUTE, DENSITY_ATTRIBUTE,
  applyCustomizationSettings, retractCustomizationSettings,
} from '../src/client/apply-customization.ts'
import { DEFAULT_CUSTOMIZATION_SETTINGS } from '../src/client/customization-settings.ts'

describe('applyCustomizationSettings', () => {
  it('projects accent, density, and background onto the element', () => {
    const root = document.createElement('div')
    applyCustomizationSettings({
      ...DEFAULT_CUSTOMIZATION_SETTINGS, accent: 'purple', density: 'spacious', background: 'dots',
    }, root)
    expect(root.getAttribute(ACCENT_ATTRIBUTE)).toBe('purple')
    expect(root.getAttribute(DENSITY_ATTRIBUTE)).toBe('spacious')
    expect(root.getAttribute(BACKGROUND_ATTRIBUTE)).toBe('dots')
    expect(root.getAttribute(CODE_WRAP_ATTRIBUTE)).toBe('on')
  })

  it('turns code wrapping off when the document disables it', () => {
    const root = document.createElement('div')
    applyCustomizationSettings({ ...DEFAULT_CUSTOMIZATION_SETTINGS, wrapCode: false }, root)
    expect(root.getAttribute(CODE_WRAP_ATTRIBUTE)).toBe('off')
  })

  it('replaces previous values on re-apply and leaves foreign attributes alone', () => {
    const root = document.createElement('div')
    root.setAttribute('data-foreign', 'keep')
    applyCustomizationSettings(DEFAULT_CUSTOMIZATION_SETTINGS, root)
    applyCustomizationSettings({
      ...DEFAULT_CUSTOMIZATION_SETTINGS, accent: 'orange', density: 'compact', background: 'grid',
    }, root)
    expect(root.getAttribute(ACCENT_ATTRIBUTE)).toBe('orange')
    expect(root.getAttribute(DENSITY_ATTRIBUTE)).toBe('compact')
    expect(root.getAttribute(BACKGROUND_ATTRIBUTE)).toBe('grid')
    expect(root.getAttribute('data-foreign')).toBe('keep')
  })
})

describe('retractCustomizationSettings', () => {
  it('removes only the owned attributes', () => {
    const root = document.createElement('div')
    root.setAttribute('data-foreign', 'keep')
    applyCustomizationSettings(DEFAULT_CUSTOMIZATION_SETTINGS, root)
    retractCustomizationSettings(root)
    expect(root.hasAttribute(ACCENT_ATTRIBUTE)).toBe(false)
    expect(root.hasAttribute(DENSITY_ATTRIBUTE)).toBe(false)
    expect(root.hasAttribute(BACKGROUND_ATTRIBUTE)).toBe(false)
    expect(root.hasAttribute(CODE_WRAP_ATTRIBUTE)).toBe(false)
    expect(root.getAttribute('data-foreign')).toBe('keep')
  })
})

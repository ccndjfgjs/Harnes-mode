// @vitest-environment jsdom
// Customization store: defaults, field-by-field tolerance, and merged writes.

import { afterEach, describe, expect, it } from 'vitest'
import {
  CUSTOMIZATION_SETTINGS_STORAGE_KEY, DEFAULT_CUSTOMIZATION_SETTINGS,
  readCustomizationSettings, writeCustomizationSettings,
} from '../src/client/customization-settings.ts'

afterEach(() => {
  localStorage.clear()
})

describe('readCustomizationSettings', () => {
  it('reads defaults when nothing is stored', () => {
    expect(readCustomizationSettings()).toEqual(DEFAULT_CUSTOMIZATION_SETTINGS)
  })

  it('reads a stored document', () => {
    localStorage.setItem(CUSTOMIZATION_SETTINGS_STORAGE_KEY, JSON.stringify({
      accent: 'purple', density: 'spacious', showTimestamps: false,
      showAvatars: false, wrapCode: false, background: 'dots',
      theme: 'dark', fontSize: 16, brandName: 'Acme Harness',
    }))
    expect(readCustomizationSettings()).toEqual({
      accent: 'purple', density: 'spacious', showTimestamps: false,
      showAvatars: false, wrapCode: false, background: 'dots',
      theme: 'dark', fontSize: 16, brandName: 'Acme Harness',
    })
  })

  it('falls back to the default brand name when the stored one is unusable', () => {
    for (const brandName of ['', '   ', 42, 'x'.repeat(81)]) {
      localStorage.setItem(CUSTOMIZATION_SETTINGS_STORAGE_KEY, JSON.stringify({ brandName }))
      expect(readCustomizationSettings().brandName)
        .toBe(DEFAULT_CUSTOMIZATION_SETTINGS.brandName)
    }
  })

  it('stores the brand name trimmed', () => {
    localStorage.setItem(CUSTOMIZATION_SETTINGS_STORAGE_KEY, JSON.stringify({ brandName: '  Acme  ' }))
    expect(readCustomizationSettings().brandName).toBe('Acme')
  })

  it('treats a corrupt document as defaults', () => {
    localStorage.setItem(CUSTOMIZATION_SETTINGS_STORAGE_KEY, '{nope')
    expect(readCustomizationSettings()).toEqual(DEFAULT_CUSTOMIZATION_SETTINGS)
  })

  it('falls back per field instead of resetting the rest', () => {
    localStorage.setItem(CUSTOMIZATION_SETTINGS_STORAGE_KEY, JSON.stringify({
      accent: 'rainbow', density: 'compact', showTimestamps: 'yes', background: 'grid',
      theme: 'midnight', fontSize: 99,
    }))
    expect(readCustomizationSettings()).toEqual({
      ...DEFAULT_CUSTOMIZATION_SETTINGS, density: 'compact', background: 'grid',
    })
  })

  it('rejects fractional and out-of-range font sizes', () => {
    for (const fontSize of [11, 18, 14.5, 'large']) {
      localStorage.setItem(CUSTOMIZATION_SETTINGS_STORAGE_KEY, JSON.stringify({ fontSize }))
      expect(readCustomizationSettings().fontSize).toBe(DEFAULT_CUSTOMIZATION_SETTINGS.fontSize)
    }
    localStorage.setItem(CUSTOMIZATION_SETTINGS_STORAGE_KEY, JSON.stringify({ fontSize: 12 }))
    expect(readCustomizationSettings().fontSize).toBe(12)
  })
})

describe('writeCustomizationSettings', () => {
  it('merges a patch over the stored document', () => {
    writeCustomizationSettings({ accent: 'orange' })
    writeCustomizationSettings({ wrapCode: false })
    expect(readCustomizationSettings()).toEqual({
      ...DEFAULT_CUSTOMIZATION_SETTINGS, accent: 'orange', wrapCode: false,
    })
  })
})

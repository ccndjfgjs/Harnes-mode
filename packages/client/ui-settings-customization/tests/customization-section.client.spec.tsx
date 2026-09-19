// @vitest-environment jsdom
// CustomizationSection: renders all six cards, persists the draft, applies
// the document attributes, and pushes theme/font into the live service.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { zh } from '../src/client/locales.ts'
import type { CustomizationSettingsKey } from '../src/client/locales.ts'
import { retractCustomizationSettings } from '../src/client/apply-customization.ts'
import { CustomizationSection } from '../src/client/CustomizationSection.tsx'
import type { CustomizationSectionInjected, CustomizationSectionProps } from '../src/client/CustomizationSection.tsx'
import { readCustomizationSettings, DEFAULT_CUSTOMIZATION_SETTINGS } from '../src/client/customization-settings.ts'

afterEach(() => {
  cleanup()
  localStorage.clear()
  retractCustomizationSettings()
})

const t = (key: CustomizationSettingsKey): string => zh[key]

function renderSection(injected: Partial<CustomizationSectionInjected> = {}) {
  return render(<CustomizationSection {...{ t, ...injected } as unknown as CustomizationSectionProps} />)
}

describe('CustomizationSection', () => {
  it('renders all seven feature cards', () => {
    const view = renderSection()
    for (const title of [
      zh['theme.title'], zh['font.title'], zh['accent.title'],
      zh['density.title'], zh['messages.title'], zh['brand.title'], zh['background.title'],
    ]) {
      // The card <section> precedes its inner radiogroup in DOM order.
      expect(view.getAllByLabelText(title)[0]?.tagName).toBe('SECTION')
    }
  })

  it('saves the edited brand name and shows the stored one', () => {
    const view = renderSection()
    const input = view.getAllByLabelText(zh['brand.title'])[1] as HTMLInputElement
    expect(input.value).toBe(DEFAULT_CUSTOMIZATION_SETTINGS.brandName)
    act(() => {
      fireEvent.change(input, { target: { value: 'Acme Harness' } })
    })
    act(() => {
      fireEvent.click(view.getByRole('button', { name: zh['save'] }))
    })
    expect(readCustomizationSettings().brandName).toBe('Acme Harness')
  })

  it('saves every group, applies the document, pushes live, and reports the save', () => {
    const applyLive = vi.fn()
    const view = renderSection({ applyLive })
    const theme = within(view.getAllByLabelText(zh['theme.title'])[0]!)
    const font = within(view.getAllByLabelText(zh['font.title'])[0]!)
    const accent = within(view.getAllByLabelText(zh['accent.title'])[0]!)
    const density = within(view.getAllByLabelText(zh['density.title'])[0]!)
    const messages = within(view.getAllByLabelText(zh['messages.title'])[0]!)
    const background = within(view.getAllByLabelText(zh['background.title'])[0]!)
    act(() => {
      fireEvent.click(theme.getByLabelText(zh['theme.dark']))
      fireEvent.click(font.getByLabelText(zh['font.increase']))
      fireEvent.click(accent.getByLabelText(zh['accent.purple']))
      fireEvent.click(density.getByLabelText(zh['density.spacious']))
      fireEvent.click(messages.getByLabelText(zh['messages.timestamps']))
      fireEvent.click(messages.getByLabelText(zh['messages.avatars']))
      fireEvent.click(messages.getByLabelText(zh['messages.wrap']))
      fireEvent.click(background.getByLabelText(zh['background.dots']))
    })
    act(() => {
      fireEvent.click(view.getByRole('button', { name: zh['save'] }))
    })
    expect(readCustomizationSettings()).toEqual({
      accent: 'purple', density: 'spacious', showTimestamps: false,
      showAvatars: false, wrapCode: false, background: 'dots',
      theme: 'dark', fontSize: 15,
      brandName: DEFAULT_CUSTOMIZATION_SETTINGS.brandName,
    })
    expect(applyLive).toHaveBeenCalledWith({ theme: 'dark', fontSize: 15 })
    expect(document.documentElement.getAttribute('data-dsh-accent')).toBe('purple')
    expect(document.documentElement.getAttribute('data-dsh-density')).toBe('spacious')
    expect(document.documentElement.getAttribute('data-dsh-background')).toBe('dots')
    expect(document.documentElement.getAttribute('data-dsh-code-wrap')).toBe('off')
    expect(view.getByRole('status').textContent).toBe(zh['saved'])
  })

  it('steps the font size down and persists it', () => {
    const applyLive = vi.fn()
    const view = renderSection({ applyLive })
    const font = within(view.getAllByLabelText(zh['font.title'])[0]!)
    act(() => {
      fireEvent.click(font.getByLabelText(zh['font.decrease']))
    })
    expect(font.getByText('13')).toBeDefined()
    act(() => {
      fireEvent.click(view.getByRole('button', { name: zh['save'] }))
    })
    expect(readCustomizationSettings().fontSize).toBe(13)
    expect(applyLive).toHaveBeenCalledWith({ theme: 'system', fontSize: 13 })
  })

  it('prefers the live theme service over a stale stored document', () => {
    localStorage.setItem(
      'dsh.customization.settings',
      JSON.stringify({ theme: 'dark', fontSize: 12 }),
    )
    const view = renderSection({ getLiveAppearance: () => ({ theme: 'light', fontSize: 16 }) })
    const font = within(view.getAllByLabelText(zh['font.title'])[0]!)
    const light = view.getAllByLabelText(zh['theme.title'])[0]?.querySelector('input[value="light"]')
    expect(light instanceof HTMLInputElement && light.checked).toBe(true)
    expect(font.getByText('16')).toBeDefined()
    act(() => {
      fireEvent.click(view.getByRole('button', { name: zh['save'] }))
    })
    expect(readCustomizationSettings().theme).toBe('light')
    expect(readCustomizationSettings().fontSize).toBe(16)
  })

  it('saves without a live service attached', () => {
    const view = renderSection()
    act(() => {
      fireEvent.click(view.getByRole('button', { name: zh['save'] }))
    })
    expect(readCustomizationSettings().theme).toBe('system')
    expect(view.getByRole('status').textContent).toBe(zh['saved'])
  })

  it('toggles the background and persists it', () => {
    const view = renderSection()
    const background = within(view.getAllByLabelText(zh['background.title'])[0]!)
    act(() => {
      fireEvent.click(background.getByLabelText(zh['background.grid']))
    })
    act(() => {
      fireEvent.click(view.getByRole('button', { name: zh['save'] }))
    })
    expect(readCustomizationSettings().background).toBe('grid')
  })
})

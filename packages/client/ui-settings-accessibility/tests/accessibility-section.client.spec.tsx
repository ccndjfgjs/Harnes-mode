// @vitest-environment jsdom
// AccessibilitySection template: renders all six feature cards, persists
// the draft, and reports the save.

import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { zh } from '../src/client/locales.ts'
import type { AccessibilitySettingsKey } from '../src/client/locales.ts'
import { AccessibilitySection } from '../src/client/AccessibilitySection.tsx'
import type { AccessibilitySectionProps } from '../src/client/AccessibilitySection.tsx'
import { retractAccessibilitySettings } from '../src/client/apply-accessibility.ts'
import { readAccessibilitySettings } from '@deepseek-ai/dsh-client-ui-primitives/src/accessibility-settings.ts'
import { setTtsBackend, writeAccessibilitySettings } from '@deepseek-ai/dsh-client-ui-primitives'

afterEach(() => {
  cleanup()
  localStorage.clear()
  retractAccessibilitySettings()
})

const t = (key: AccessibilitySettingsKey): string => zh[key]

function renderSection() {
  return render(<AccessibilitySection {...{ t } as unknown as AccessibilitySectionProps} />)
}

describe('AccessibilitySection', () => {
  it('renders all six feature cards', () => {
    const view = renderSection()
    for (const title of [zh['code.title'], zh['sound.title'], zh['font.title'], zh['markdown.title'], zh['voiceNav.title'], zh['contrast.title']]) {
      // The card <section> precedes its inner radiogroup in DOM order.
      expect(view.getAllByLabelText(title)[0]?.tagName).toBe('SECTION')
    }
  })

  it('saves every group and reports the save', () => {
    const view = renderSection()
    const code = within(view.getAllByLabelText(zh['code.title'])[0]!)
    const font = within(view.getAllByLabelText(zh['font.title'])[0]!)
    const markdown = within(view.getAllByLabelText(zh['markdown.title'])[0]!)
    const voiceNav = within(view.getAllByLabelText(zh['voiceNav.title'])[0]!)
    const contrast = within(view.getAllByLabelText(zh['contrast.title'])[0]!)
    act(() => {
      fireEvent.click(code.getByLabelText(zh['code.full']))
      fireEvent.click(font.getByLabelText(zh['font.mono']))
      fireEvent.click(markdown.getByLabelText(zh['markdown.strip']))
      fireEvent.click(voiceNav.getByLabelText(zh['voiceNav.on']))
      fireEvent.click(contrast.getByLabelText(zh['contrast.daltonism']))
    })
    act(() => {
      fireEvent.click(view.getByRole('button', { name: zh['save'] }))
    })
    expect(readAccessibilitySettings()).toEqual({
      codeReading: 'full', sound: true, font: 'mono', stripMarkdown: false, voiceNav: true, voiceNavHover: true, voiceNavArrow: false, voiceNavDelay: 150, voiceNavChatTrigger: 'both', contrast: 'daltonism', speechRate: 1,
    })
    expect(document.documentElement.getAttribute('data-dsh-a11y-font')).toBe('mono')
    expect(document.documentElement.getAttribute('data-dsh-a11y-contrast')).toBe('daltonism')
    expect(view.getByRole('status').textContent).toBe(zh['saved'])
  })

  it('persists the speech rate slider instantly and previews at the new rate', () => {
    const calls: { text: string; options?: unknown }[] = []
    setTtsBackend({
      isAvailable: () => true,
      speak: (text: string, options?: unknown) => { calls.push({ text, options }) },
      cancel: () => {},
    })
    try {
      writeAccessibilitySettings({ voiceNav: true })
      const view = renderSection()
      const voiceNav = within(view.getAllByLabelText(zh['voiceNav.title'])[0]!)
      const slider = voiceNav.getByLabelText(zh['voiceNav.rate']) as HTMLInputElement
      fireEvent.change(slider, { target: { value: '1.5' } })
      expect(readAccessibilitySettings().speechRate).toBe(1.5)
      fireEvent.mouseUp(slider)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.options).toMatchObject({ rate: 1.5 })
    } finally {
      setTtsBackend(null)
    }
  })

  it('toggles sound off and on, persisting each save', () => {
    const view = renderSection()
    const sound = within(view.getAllByLabelText(zh['sound.title'])[0]!)
    act(() => {
      fireEvent.click(sound.getByLabelText(zh['sound.off']))
    })
    act(() => {
      fireEvent.click(view.getByRole('button', { name: zh['save'] }))
    })
    expect(readAccessibilitySettings().sound).toBe(false)
    act(() => {
      fireEvent.click(sound.getByLabelText(zh['sound.on']))
    })
    act(() => {
      fireEvent.click(view.getByRole('button', { name: zh['save'] }))
    })
    expect(readAccessibilitySettings().sound).toBe(true)
  })

  it('toggles voiceNav off and on, persisting each save', () => {
    const view = renderSection()
    const voiceNav = within(view.getAllByLabelText(zh['voiceNav.title'])[0]!)
    act(() => {
      fireEvent.click(voiceNav.getByLabelText(zh['voiceNav.on']))
    })
    act(() => {
      fireEvent.click(view.getByRole('button', { name: zh['save'] }))
    })
    expect(readAccessibilitySettings().voiceNav).toBe(true)
    act(() => {
      fireEvent.click(voiceNav.getByLabelText(zh['voiceNav.off']))
    })
    act(() => {
      fireEvent.click(view.getByRole('button', { name: zh['save'] }))
    })
    expect(readAccessibilitySettings().voiceNav).toBe(false)
  })

  it('toggles voiceNavHover via checkbox (default true, click -> false)', () => {
    const view = renderSection()
    const voiceNav = within(view.getAllByLabelText(zh['voiceNav.title'])[0]!)
    act(() => {
      fireEvent.click(voiceNav.getByLabelText(zh['voiceNav.on']))
    })
    const hover = view.getByLabelText(zh['voiceNav.hover']) as HTMLInputElement
    expect(hover.disabled).toBe(false)
    expect(hover.checked).toBe(true)
    act(() => {
      fireEvent.click(hover)
    })
    expect(hover.checked).toBe(false)
    act(() => {
      fireEvent.click(view.getByRole('button', { name: zh['save'] }))
    })
    expect(readAccessibilitySettings().voiceNavHover).toBe(false)
    // Master off disables hover checkbox
    act(() => {
      fireEvent.click(voiceNav.getByLabelText(zh['voiceNav.off']))
    })
    expect(view.getByLabelText(zh['voiceNav.hover']).hasAttribute('disabled')).toBe(true)
  })
})

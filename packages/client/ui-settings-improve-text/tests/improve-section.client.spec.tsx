// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImproveTextProvider } from '../src/client/roster.ts'
import { ImproveTextSection } from '../src/client/ImproveTextSection.tsx'
import { ru } from '../src/client/locales.ts'
import { IMPROVE_ANNOUNCE_STORAGE_KEY } from '@deepseek-ai/dsh-client-ui-primitives'

const t = (key: keyof typeof ru): string => ru[key]

function providers(): readonly ImproveTextProvider[] {
  return [
    {
      provider: 'openrouter',
      displayName: 'OpenRouter',
      models: [
        { id: 'laguna', name: 'Laguna' },
        { id: 'gemini-batch', name: 'Gemini (batch)' },
      ],
      keyRef: 'OPENROUTER_API_KEY',
      credential: { configured: true },
      usable: true,
    } as unknown as ImproveTextProvider,
    {
      provider: 'nokey-provider',
      displayName: 'NoKey Provider',
      models: [{ id: 'nokey', name: 'NoKey' }],
      keyRef: 'NOKEY_API_KEY',
      credential: { configured: false },
      usable: false,
    } as unknown as ImproveTextProvider,
  ]
}

function props(over: object = {}) {
  return {
    t,
    useStore: (selector: (snapshot: unknown) => unknown) => selector({
      status: 'ready', error: null, providers: providers(), failures: [],
    }),
    loadRoster: vi.fn(),
    ...over,
  } as never
}

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('new Improve-text section', () => {
  it('scan button reloads the roster', () => {
    const loadRoster = vi.fn()
    render(ImproveTextSection(props({ loadRoster })) as never)
    fireEvent.click(screen.getByRole('button', { name: ru['scan.button'] }))
    expect(loadRoster).toHaveBeenCalledTimes(1)
  })

  it('shows a dead list with support badges', () => {
    render(ImproveTextSection(props()) as never)
    const list = screen.getByRole('combobox', { name: ru['list.label'] })
    const options = Array.from(list.querySelectorAll('option')).map(o => ({
      text: o.textContent, disabled: o.disabled,
    }))
    expect(options).toContainEqual({ text: 'Laguna ★', disabled: true })
    expect(options).toContainEqual({ text: 'Gemini (batch) ✉', disabled: true })
    expect(options).toContainEqual({ text: 'NoKey ?', disabled: true })
    expect(options.every(o => o.disabled)).toBe(true)
  })

  it('voice checkbox persists the announce toggle', () => {
    render(ImproveTextSection(props()) as never)
    const box = screen.getByRole('checkbox', { name: ru['voice.label'] }) as HTMLInputElement
    expect(box.checked).toBe(false)
    expect(localStorage.getItem(IMPROVE_ANNOUNCE_STORAGE_KEY)).toBeNull()
    fireEvent.click(box)
    expect(localStorage.getItem(IMPROVE_ANNOUNCE_STORAGE_KEY)).toBe('true')
  })

  it('read-aloud checkbox persists its own toggle', () => {
    expect(ru['voice.readAloud']).toBeTruthy()
    render(ImproveTextSection(props()) as never)
    const box = screen.getByRole('checkbox', { name: ru['voice.readAloud'] as string }) as HTMLInputElement
    expect(box.checked).toBe(false)
    fireEvent.click(box)
    expect(box.checked).toBe(true)
  })

  it('shows a prompt text in the closed dead list', () => {
    render(ImproveTextSection(props()) as never)
    const list = screen.getByRole('combobox', { name: ru['list.label'] }) as HTMLSelectElement
    expect(list.value).toBe('')
    expect(list.options[list.selectedIndex]?.textContent).toBe(ru['list.placeholder'])
    expect(list.options[list.selectedIndex]?.disabled).toBe(true)
  })
})

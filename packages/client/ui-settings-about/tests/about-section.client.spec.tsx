// @vitest-environment jsdom
// AboutSection template: renders the mission lead and all three cards.

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { ru, zh } from '../src/client/locales.ts'
import type { AboutSettingsKey } from '../src/client/locales.ts'
import { AboutSection } from '../src/client/AboutSection.tsx'
import type { AboutSectionProps } from '../src/client/AboutSection.tsx'

afterEach(() => {
  cleanup()
})

const t = (key: AboutSettingsKey): string => zh[key]

function renderSection() {
  return render(<AboutSection {...{ t } as unknown as AboutSectionProps} />)
}

describe('AboutSection', () => {
  it('renders the mission lead and the comparison card', () => {
    const view = renderSection()
    expect(view.getByText(zh['lead'])).toBeTruthy()
    expect(view.getByLabelText(zh['diff.title'])).toBeTruthy()
    expect(view.getByText(zh['diff.body'])).toBeTruthy()
  })

  it('renders the author card', () => {
    const view = renderSection()
    const author = view.getByLabelText(zh['author.title'])
    expect(author.textContent).toContain(zh['author.name'])
    expect(zh['author.name']).toBe('kz dark')
  })

  it('renders the accessibility commitments and the status note', () => {
    const view = renderSection()
    const access = view.getByLabelText(zh['access.title'])
    expect(access.textContent).toContain(zh['access.point.voice'])
    expect(access.textContent).toContain(zh['access.point.speech'])
    expect(access.textContent).toContain(zh['access.point.display'])
    expect(view.getByLabelText(zh['status.title'])).toBeTruthy()
  })

  it('keeps the dictionaries complete across locales', () => {
    expect(Object.keys(ru).sort()).toEqual(Object.keys(zh).sort())
  })
})

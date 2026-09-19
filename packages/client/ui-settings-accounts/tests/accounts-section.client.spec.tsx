// @vitest-environment jsdom
// AccountsSection template: renders the Authorization card plus the four
// connect cards, connects Mega through its form, and disconnects again.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { zh } from '../src/client/locales.ts'
import type { AccountsSettingsKey } from '../src/client/locales.ts'
import { AccountsSection } from '../src/client/AccountsSection.tsx'
import type { AccountsSectionProps } from '../src/client/AccountsSection.tsx'
import { isProviderConnected, readAccountsSettings } from '../src/client/accounts-settings.ts'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

const t = (key: AccountsSettingsKey): string => zh[key]

function renderSection() {
  return render(<AccountsSection {...{ t } as unknown as AccountsSectionProps} />)
}

describe('AccountsSection', () => {
  it('renders the Authorization card and all four provider cards', () => {
    const view = renderSection()
    expect(view.getByLabelText(zh['auth.title'])).toBeTruthy()
    expect(view.getByText(zh['auth.empty'])).toBeTruthy()
    for (const key of ['provider.google-drive', 'provider.gmail', 'provider.github', 'provider.mega'] as const) {
      expect(view.getByLabelText(zh[key])).toBeTruthy()
    }
  })

  it('connects Mega through its form and lists it under Authorization', () => {
    const view = renderSection()
    const mega = within(view.getByLabelText(zh['provider.mega']))
    act(() => {
      fireEvent.change(mega.getByPlaceholderText(zh['mega.login.placeholder']), {
        target: { value: 'user@example.com' },
      })
    })
    act(() => {
      fireEvent.change(mega.getByPlaceholderText(zh['mega.password.placeholder']), {
        target: { value: 'secret' },
      })
    })
    act(() => {
      fireEvent.click(mega.getByRole('button', { name: zh['mega.connect'] }))
    })
    expect(isProviderConnected(readAccountsSettings().providers.mega)).toBe(true)
    const auth = within(view.getByLabelText(zh['auth.title']))
    expect(auth.getByText('Mega — user@example.com')).toBeTruthy()
  })

  it('disconnects a connected cloud from the Authorization card', () => {
    const view = renderSection()
    const mega = within(view.getByLabelText(zh['provider.mega']))
    act(() => {
      fireEvent.change(mega.getByPlaceholderText(zh['mega.login.placeholder']), {
        target: { value: 'user@example.com' },
      })
    })
    act(() => {
      fireEvent.change(mega.getByPlaceholderText(zh['mega.password.placeholder']), {
        target: { value: 'secret' },
      })
    })
    act(() => {
      fireEvent.click(mega.getByRole('button', { name: zh['mega.connect'] }))
    })
    const auth = within(view.getByLabelText(zh['auth.title']))
    act(() => {
      fireEvent.click(auth.getByRole('button', { name: zh['auth.disconnect'] }))
    })
    expect(isProviderConnected(readAccountsSettings().providers.mega)).toBe(false)
    expect(view.getByText(zh['auth.empty'])).toBeTruthy()
  })

  it('answers every click: empty Mega connect shows a validation error', () => {
    const view = renderSection()
    const mega = within(view.getByLabelText(zh['provider.mega']))
    act(() => {
      fireEvent.click(mega.getByRole('button', { name: zh['mega.connect'] }))
    })
    expect(mega.getByRole('alert').textContent).toBe(zh['mega.needLogin'])
    expect(isProviderConnected(readAccountsSettings().providers.mega)).toBe(false)
  })

  it('answers every click: empty Client ID shows a validation error', () => {
    const view = renderSection()
    const github = within(view.getByLabelText(zh['provider.github']))
    act(() => {
      fireEvent.click(github.getByRole('button', { name: zh['oauth.openLogin'] }))
    })
    expect(github.getByRole('alert').textContent).toBe(zh['oauth.needClientId'])
  })

  it('drives the in-app login through the Electron bridge and auto-connects', () => {
    type Done = (done: {
      provider: 'github'
      accountLabel: string
      accessToken: string
      refreshToken: string
      expiresAt: number
    }) => void
    let doneCallback: Done | null = null
    const startMock = vi.fn(() => Promise.resolve({ ok: true as const }))
    const apiWindow = window as unknown as { harnessAPI?: unknown }
    apiWindow.harnessAPI = {
      accountsOAuthStart: startMock,
      accountsOAuthCancel: vi.fn(() => Promise.resolve({ ok: true as const })),
      onAccountsOAuthDone: (callback: Done) => {
        doneCallback = callback
        return () => { doneCallback = null }
      },
      onAccountsOAuthError: () => () => {},
    }
    try {
      const view = renderSection()
      const github = within(view.getByLabelText(zh['provider.github']))
      act(() => {
        fireEvent.change(github.getByPlaceholderText(zh['oauth.clientId.placeholder']), {
          target: { value: 'client-1' },
        })
      })
      act(() => {
        fireEvent.click(github.getByRole('button', { name: zh['oauth.openLogin'] }))
      })
      expect(startMock).toHaveBeenCalledWith({ provider: 'github', clientId: 'client-1' })
      act(() => {
        doneCallback?.({
          provider: 'github',
          accountLabel: 'octocat',
          accessToken: 'token-1',
          refreshToken: '',
          expiresAt: 0,
        })
      })
      expect(isProviderConnected(readAccountsSettings().providers.github)).toBe(true)
      const auth = within(view.getByLabelText(zh['auth.title']))
      expect(auth.getByText('GitHub — octocat')).toBeTruthy()
    } finally {
      delete apiWindow.harnessAPI
    }
  })

  it('shows the device code while GitHub approval is pending', async () => {
    const apiWindow = window as unknown as { harnessAPI?: unknown }
    apiWindow.harnessAPI = {
      accountsOAuthStart: () => Promise.resolve({
        ok: true as const,
        device: { userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', expiresIn: 900 },
      }),
      accountsOAuthCancel: () => Promise.resolve({ ok: true as const }),
      onAccountsOAuthDone: () => () => {},
      onAccountsOAuthError: () => () => {},
    }
    try {
      const view = renderSection()
      const github = within(view.getByLabelText(zh['provider.github']))
      act(() => {
        fireEvent.change(github.getByPlaceholderText(zh['oauth.clientId.placeholder']), {
          target: { value: 'client-1' },
        })
      })
      await act(async () => {
        fireEvent.click(github.getByRole('button', { name: zh['oauth.openLogin'] }))
      })
      expect(github.getByText('在已打开的页面输入代码 WDJB-MJHT')).toBeTruthy()
    } finally {
      delete apiWindow.harnessAPI
    }
  })
})

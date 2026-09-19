// @vitest-environment jsdom
// Accounts persistence: blank defaults, per-provider writes, connected
// checks, and the Authorization listing order.

import { afterEach, describe, expect, it } from 'vitest'
import {
  ACCOUNTS_SETTINGS_STORAGE_KEY,
  isAnyAccountConnected,
  isProviderConnected,
  listConnected,
  readAccountsSettings,
  writeProviderSettings,
} from '../src/client/accounts-settings.ts'

afterEach(() => {
  localStorage.clear()
})

describe('accounts-settings', () => {
  it('reads blank when nothing is stored', () => {
    const settings = readAccountsSettings()
    expect(settings.providers['google-drive'].connected).toBe(false)
    expect(settings.providers.mega.connected).toBe(false)
    expect(listConnected(settings)).toEqual([])
    expect(isAnyAccountConnected(settings)).toBe(false)
  })

  it('tolerates a corrupt document', () => {
    localStorage.setItem(ACCOUNTS_SETTINGS_STORAGE_KEY, '{broken')
    expect(listConnected()).toEqual([])
  })

  it('connects an OAuth provider once a live token is stored', () => {
    writeProviderSettings('github', {
      connected: true,
      accountLabel: 'octocat',
      clientId: 'client-1',
      accessToken: 'token-1',
      refreshToken: '',
      expiresAt: 0,
    })
    const settings = readAccountsSettings()
    expect(isProviderConnected(settings.providers.github)).toBe(true)
    expect(listConnected(settings)).toEqual([{ provider: 'github', accountLabel: 'octocat', expiresAt: 0 }])
    expect(isAnyAccountConnected(settings)).toBe(true)
  })

  it('treats an expired token as disconnected', () => {
    writeProviderSettings('gmail', {
      connected: true,
      accountLabel: 'user@example.com',
      clientId: 'client-1',
      accessToken: 'token-1',
      refreshToken: '',
      expiresAt: Date.now() - 1000,
    })
    expect(isProviderConnected(readAccountsSettings().providers.gmail)).toBe(false)
    expect(listConnected()).toEqual([])
  })

  it('connects Mega on login + password and lists clouds in card order', () => {
    writeProviderSettings('mega', { connected: true, accountLabel: 'user@example.com', login: 'user@example.com', password: 'secret' })
    writeProviderSettings('google-drive', {
      connected: true,
      accountLabel: 'drive@example.com',
      clientId: 'client-1',
      accessToken: 'token-1',
      refreshToken: '',
      expiresAt: 0,
    })
    expect(listConnected().map(item => item.provider)).toEqual(['google-drive', 'mega'])
  })

  it('disconnects by clearing the secrets but keeps the identifiers', () => {
    writeProviderSettings('github', {
      connected: true,
      accountLabel: 'octocat',
      clientId: 'client-1',
      accessToken: 'token-1',
      refreshToken: '',
      expiresAt: 0,
    })
    writeProviderSettings('github', { connected: false, accountLabel: '', accessToken: '', refreshToken: '', expiresAt: 0 })
    const entry = readAccountsSettings().providers.github
    expect(entry.kind).toBe('oauth')
    if (entry.kind === 'oauth') {
      expect(entry.accessToken).toBe('')
      expect(entry.clientId).toBe('client-1')
    }
    expect(isProviderConnected(entry)).toBe(false)
  })
})

// @vitest-environment jsdom
// Provider helpers: authorize-URL shape, PKCE pair shape, and the code
// exchange success/failure paths (fetch is stubbed — no network).

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildAuthorizeUrl,
  createPkcePair,
  DEFAULT_CLIENT_IDS,
  exchangeCodeForToken,
  getAccountsBridge,
  isOAuthProvider,
  OAUTH_PROVIDERS,
} from '../src/client/providers.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('providers', () => {
  it('marks every provider but Mega as OAuth-backed', () => {
    expect(isOAuthProvider('google-drive')).toBe(true)
    expect(isOAuthProvider('gmail')).toBe(true)
    expect(isOAuthProvider('github')).toBe(true)
    expect(isOAuthProvider('mega')).toBe(false)
  })

  it('builds a PKCE S256 authorize URL from the descriptor', () => {
    const url = new URL(buildAuthorizeUrl('github', 'client-1', 'challenge-1', 'github'))
    expect(`${url.origin}${url.pathname}`).toBe(OAUTH_PROVIDERS.github.authUrl)
    expect(url.searchParams.get('client_id')).toBe('client-1')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('code_challenge')).toBe('challenge-1')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('scope')).toBe('repo read:user')
    expect(url.searchParams.get('state')).toBe('github')
  })

  it('creates a verifier/challenge pair', async () => {
    const pair = await createPkcePair()
    expect(pair.verifier.length).toBeGreaterThan(20)
    expect(pair.challenge.length).toBeGreaterThan(20)
    expect(pair.challenge).not.toBe(pair.verifier)
  })

  it('exchanges a code for tokens', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 }),
    })))
    const result = await exchangeCodeForToken('google-drive', 'client-1', 'code-1', 'verifier-1')
    expect(result).toEqual({ accessToken: 'access-1', refreshToken: 'refresh-1', expiresIn: 3600 })
    const [, options] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit]
    expect(options.method).toBe('POST')
    const body = options.body
    if (typeof body !== 'string') throw new Error('expected a urlencoded body')
    expect(body).toContain('code_verifier=verifier-1')
  })

  it('throws when the token endpoint rejects the code', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({}) })))
    await expect(exchangeCodeForToken('github', 'client-1', 'bad-code', 'verifier-1')).rejects.toThrow('400')
  })

  it('ships empty default Client IDs until the developer bakes the app IDs in', () => {
    expect(DEFAULT_CLIENT_IDS).toEqual({ 'google-drive': '', 'gmail': '', 'github': '' })
  })

  it('finds no Electron bridge in the test browser', () => {
    expect(getAccountsBridge()).toBeNull()
  })
})

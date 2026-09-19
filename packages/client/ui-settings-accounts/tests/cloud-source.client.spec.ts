// @vitest-environment jsdom
// Cloud source: top-level buttons, query parsing, drill descent, file picks,
// and the download codec (fetch is stubbed — no network).

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientSessionContext, InputTriggerPick } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { writeProviderSettings } from '../src/client/accounts-settings.ts'
import type { AccountProviderId } from '../src/client/accounts-settings.ts'
import { createCloudSource, downloadFileRef, fileRef, parseCloudQuery } from '../src/client/cloud/cloud-source.ts'
import { zh } from '../src/client/cloud/cloud-locales.ts'
import type { CloudKey } from '../src/client/cloud/cloud-locales.ts'
import { zh as accountsZh } from '../src/client/locales.ts'

afterEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
})

const t = (key: CloudKey): string => zh[key]

/** Provider display names come from the Accounts dictionary, exactly as `apply` wires them. */
const providerName = (provider: AccountProviderId): string => accountsZh[`provider.${provider}`]

const session = { sessionId: 's1' } as ClientSessionContext
const signal = new AbortController().signal

function request(query: string) {
  return { query, quoted: false, position: 'leading' as const, drilled: false, signal }
}

function pick(value: string, action: 'pick' | 'drill' = 'pick'): InputTriggerPick {
  return {
    candidate: { name: 'row', value },
    session,
    position: 'leading',
    via: 'menu',
    action,
    span: { start: 0, end: 6, draftRev: 0 },
  }
}

function connectGithub() {
  writeProviderSettings('github', {
    connected: true, accountLabel: 'octocat', clientId: 'client-1',
    accessToken: 'token-1', refreshToken: '', expiresAt: 0,
  })
}

function driveList(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve('') }
}

describe('parseCloudQuery', () => {
  it('returns null for top-level queries', () => {
    expect(parseCloudQuery('')).toBeNull()
    expect(parseCloudQuery('driv')).toBeNull()
    expect(parseCloudQuery('cloud')).toBeNull()
  })

  it('resolves the cloud, segments, and filter', () => {
    expect(parseCloudQuery('cloud drive/')).toEqual({ provider: 'google-drive', segments: [], filter: '' })
    expect(parseCloudQuery('cloud drive/Documents/re')).toEqual({
      provider: 'google-drive', segments: ['Documents'], filter: 're',
    })
    expect(parseCloudQuery('cloud github octo/app/src/ma')).toEqual({
      provider: 'github', segments: ['octo', 'app', 'src'], filter: 'ma',
    })
  })

  it('returns null for unknown cloud keys', () => {
    expect(parseCloudQuery('cloud dropbox/')).toBeNull()
  })
})

describe('cloud source top level', () => {
  it('shows the connect notice when nothing is authorized', async () => {
    const source = createCloudSource(t, providerName)
    const rows = await source.candidates(session, request(''))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.name).toBe(zh['empty'])
    expect(source.onPick(pick(rows[0]?.value ?? ''))).toBeUndefined()
  })

  it('lists one button per connected cloud and filters by text', async () => {
    connectGithub()
    writeProviderSettings('google-drive', {
      connected: true, accountLabel: 'drive@example.com', clientId: 'client-1',
      accessToken: 'token-1', refreshToken: '', expiresAt: 0,
    })
    const source = createCloudSource(t, providerName)
    const rows = await source.candidates(session, request(''))
    expect(rows.map(row => row.name)).toEqual(['Google Drive', 'GitHub'])
    expect(rows.every(row => row.drill)).toBe(true)
    const filtered = await source.candidates(session, request('git'))
    expect(filtered.map(row => row.name)).toEqual(['GitHub'])
  })
})

describe('cloud source drill and picks', () => {
  it('descends from a cloud button into its file list', async () => {
    connectGithub()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(driveList([{ full_name: 'octo/app' }]))))
    const source = createCloudSource(t, providerName)
    const top = await source.candidates(session, request(''))
    const opened = source.onPick(pick(top[0]?.value ?? ''))
    expect(opened).toEqual({ text: '/cloud github/', continue: true })
    const repos = await source.candidates(session, request('cloud github/'))
    expect(repos.map(row => row.name)).toEqual(['octo/app/'])
    const deeper = source.onPick(pick(repos[0]?.value ?? '', 'drill'))
    expect(deeper).toEqual({ text: '/cloud github/octo/app/', continue: true })
  })

  it('inserts a file reference on a settling pick', async () => {
    connectGithub()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(driveList([
      { path: 'a.py', name: 'a.py', type: 'file', size: 4 },
    ]))))
    const source = createCloudSource(t, providerName)
    const rows = await source.candidates(session, request('cloud github/octo/app/'))
    expect(rows).toHaveLength(1)
    const outcome = source.onPick(pick(rows[0]?.value ?? ''))
    expect(outcome).toMatchObject({
      insert: { source: 'cloud', label: 'a.py', appearance: 'file' },
    })
  })

  it('renders the crumb trail inside a cloud', () => {
    const source = createCloudSource(t, providerName)
    const crumbs = source.header?.(session, { query: 'cloud drive/Documents/', drilled: true })
    expect(crumbs?.map(crumb => crumb.label)).toEqual(['Google Drive', 'Documents'])
    expect(crumbs?.[1]?.current).toBe(true)
    expect(source.header?.(session, { query: '', drilled: false })).toBeUndefined()
  })

  it('shows the coming-soon notice inside Mega', async () => {
    writeProviderSettings('mega', {
      connected: true, accountLabel: 'user@example.com', login: 'user@example.com', password: 'secret',
    })
    const source = createCloudSource(t, providerName)
    const rows = await source.candidates(session, request('cloud mega/'))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.name).toBe(zh['mega.notice'])
  })
})

describe('cloud download codec', () => {
  it('downloads a Drive file through the stored token', async () => {
    writeProviderSettings('google-drive', {
      connected: true, accountLabel: 'drive@example.com', clientId: 'client-1',
      accessToken: 'token-1', refreshToken: '', expiresAt: 0,
    })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve('file text'),
    })))
    const ref = fileRef('google-drive', 'f1', 'notes.txt', { mimeType: 'text/plain' })
    await expect(downloadFileRef(ref, t, signal)).resolves.toBe('file text')
    const [url, options] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/f1?alt=media')
    expect((options.headers as Record<string, string>).Authorization).toBe('Bearer token-1')
  })

  it('rejects foreign references and oversized files', async () => {
    await expect(downloadFileRef('not-json', t, signal)).rejects.toThrow('unknown file reference')
    const big = fileRef('github', 'octo/app/big.bin', 'big.bin', { size: 2_000_000 })
    await expect(downloadFileRef(big, t, signal)).rejects.toThrow('2000000')
  })
})

// @vitest-environment jsdom
// Cloud REST clients: listing shapes, download routing, and readable errors
// (fetch is stubbed — no network).

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  downloadDriveFile,
  downloadGithubFile,
  downloadGmailMessage,
  listDriveFiles,
  listGithubContents,
  listGithubRepos,
  listGmailMessages,
} from '../src/client/cloud/cloud-api.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

const signal = new AbortController().signal

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: () => Promise.resolve(body), text: () => Promise.resolve('') }
}

describe('cloud-api', () => {
  it('lists Drive folders before files with kinds resolved', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({
      files: [
        { id: 'f1', name: 'notes.txt', mimeType: 'text/plain', size: '12' },
        { id: 'd1', name: 'Docs', mimeType: 'application/vnd.google-apps.folder' },
      ],
    }))))
    const items = await listDriveFiles({ accessToken: 'token', folderId: 'root', signal })
    expect(items).toEqual([
      { id: 'f1', name: 'notes.txt', kind: 'file', size: 12, mimeType: 'text/plain' },
      { id: 'd1', name: 'Docs', kind: 'folder', mimeType: 'application/vnd.google-apps.folder' },
    ])
    const [url, options] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit]
    expect(url).toContain('drive/v3/files')
    expect((options.headers as Record<string, string>).Authorization).toBe('Bearer token')
  })

  it('exports Google-native docs as plain text', async () => {
    const text = vi.fn(() => Promise.resolve('hello'))
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text })))
    const body = await downloadDriveFile({
      accessToken: 'token', fileId: 'doc1', mimeType: 'application/vnd.google-apps.document', signal,
    })
    expect(body).toBe('hello')
    const [url] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/export?mimeType=text%2Fplain')
  })

  it('throws a readable Drive error', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ error: { message: 'Invalid Credentials' } }, false, 401))))
    await expect(listDriveFiles({ accessToken: 'bad', folderId: 'root', signal })).rejects.toThrow('Invalid Credentials')
  })

  it('lists GitHub repos as folders and contents with kinds', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/user/repos')) {
        return Promise.resolve(jsonResponse([{ full_name: 'octo/app' }]))
      }
      return Promise.resolve(jsonResponse([
        { path: 'src/main.ts', name: 'main.ts', type: 'file', size: 10 },
        { path: 'src', name: 'src', type: 'dir' },
      ]))
    }))
    expect(await listGithubRepos({ accessToken: 'token', signal })).toEqual([
      { id: 'octo/app', name: 'octo/app', kind: 'folder' },
    ])
    expect(await listGithubContents({ accessToken: 'token', repo: 'octo/app', path: '', signal })).toEqual([
      { id: 'src/main.ts', name: 'main.ts', kind: 'file', size: 10 },
      { id: 'src', name: 'src', kind: 'folder' },
    ])
  })

  it('downloads a GitHub file through the raw media type', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve('print(1)'),
    })))
    const body = await downloadGithubFile({ accessToken: 'token', repo: 'octo/app', path: 'a.py', signal })
    expect(body).toBe('print(1)')
    const [, options] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit]
    expect((options.headers as Record<string, string>).Accept).toBe('application/vnd.github.raw')
  })

  it('lists Gmail messages with subjects and downloads the plain body', async () => {
    const plain = Buffer.from('hello mail', 'utf-8').toString('base64')
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/messages?')) return Promise.resolve(jsonResponse({ messages: [{ id: 'm1' }] }))
      if (url.includes('format=metadata')) {
        return Promise.resolve(jsonResponse({
          payload: { headers: [{ name: 'Subject', value: 'Hi' }, { name: 'From', value: 'a@x.io' }] },
        }))
      }
      return Promise.resolve(jsonResponse({
        payload: { mimeType: 'text/plain', body: { data: plain, size: 10 } },
      }))
    }))
    const items = await listGmailMessages({ accessToken: 'token', query: '', signal })
    expect(items).toEqual([{ id: 'm1', name: 'Hi', kind: 'file', detail: 'a@x.io' }])
    const body = await downloadGmailMessage({ accessToken: 'token', messageId: 'm1', signal })
    expect(body).toBe('hello mail')
  })
})

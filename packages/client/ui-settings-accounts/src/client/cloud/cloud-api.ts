/**
 * Minimal read-only REST clients behind the cloud trigger source: Google
 * Drive file browsing + download, Gmail message search + body, GitHub
 * repo/contents browsing + download. Every call takes the stored OAuth token
 * and an AbortSignal; failures throw readable Errors (the reference codec
 * surfaces them instead of silently downgrading). Mega has no OAuth REST
 * surface here — the source renders a coming-soon notice for it.
 */

const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files'
const GMAIL_BASE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me'
const GITHUB_REPOS_URL = 'https://api.github.com/user/repos'
const GITHUB_CONTENTS_URL = 'https://api.github.com/repos'

/** Drive mime type marking a folder. */
const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder'

/** Largest single download the codec pulls into a prompt (1 MiB). */
export const MAX_CLOUD_DOWNLOAD_BYTES = 1_000_000

/** One row of a cloud listing: a folder to drill into or a file to pick. */
export interface CloudFileItem {
  /** Provider-stable id (Drive file id, GitHub path, Gmail message id). */
  readonly id: string
  /** Display name (file name, repo name, message subject). */
  readonly name: string
  /** Folder rows drill; file rows insert. */
  readonly kind: 'file' | 'folder'
  /** Byte size when the provider reports one. */
  readonly size?: number
  /** Drive mime type (drives the media/export download choice). */
  readonly mimeType?: string
  /** Secondary row text (Gmail sender). */
  readonly detail?: string
}

/** Bearer headers shared by every provider call. */
function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
}

/** Throw a readable Error for a rejected provider response. */
async function throwProviderError(provider: string, response: Response, what: string): Promise<never> {
  let detail = `HTTP ${response.status}`
  try {
    const data = (await response.json()) as {
      message?: unknown
      error_description?: unknown
      error?: unknown
    }
    // Drive nests its reason ({ error: { message } }); others use flat fields.
    const nested = typeof data.error === 'object' && data.error !== null
      ? (data.error as { message?: unknown }).message
      : undefined
    if (typeof data.message === 'string') detail = data.message
    else if (typeof nested === 'string') detail = nested
    else if (typeof data.error_description === 'string') detail = data.error_description
    else if (typeof data.error === 'string') detail = data.error
  } catch {
    // Non-JSON answer: keep the HTTP status.
  }
  throw new Error(`${provider}: ${what} (${detail})`)
}

/**
 * List one Drive folder's children (root when folderId is 'root').
 * @param args - token, folder, abort signal, overridable fetch.
 * @returns folders first, then files, capped at 50 rows.
 */
export async function listDriveFiles(args: {
  accessToken: string
  folderId: string
  signal: AbortSignal
  fetchImpl?: typeof fetch
}): Promise<CloudFileItem[]> {
  const { accessToken, folderId, signal, fetchImpl = fetch } = args
  const params = new URLSearchParams({
    q: `'${folderId}' in parents and trashed = false`,
    orderBy: 'folder,name',
    pageSize: '50',
    fields: 'files(id,name,mimeType,size,modifiedTime)',
  })
  const response = await fetchImpl(`${DRIVE_FILES_URL}?${params.toString()}`, {
    headers: authHeaders(accessToken),
    signal,
  })
  if (!response.ok) await throwProviderError('Google Drive', response, 'cannot list files')
  const data = (await response.json()) as { files?: Array<{ id?: unknown; name?: unknown; mimeType?: unknown; size?: unknown }> }
  const files = Array.isArray(data.files) ? data.files : []
  return files
    .filter(item => typeof item.id === 'string' && typeof item.name === 'string')
    .map(item => ({
      id: item.id as string,
      name: item.name as string,
      kind: item.mimeType === DRIVE_FOLDER_MIME ? 'folder' as const : 'file' as const,
      ...(typeof item.size === 'string' && item.size !== '' ? { size: Number(item.size) } : {}),
      ...(typeof item.mimeType === 'string' ? { mimeType: item.mimeType } : {}),
    }))
}

/**
 * Download one Drive file as text (Google-native docs export as plain text).
 * @param args - token, file id + mime, abort signal, overridable fetch.
 * @returns the file text (may be empty for binary content).
 */
export async function downloadDriveFile(args: {
  accessToken: string
  fileId: string
  mimeType?: string
  signal: AbortSignal
  fetchImpl?: typeof fetch
}): Promise<string> {
  const { accessToken, fileId, mimeType, signal, fetchImpl = fetch } = args
  const googleNative = mimeType !== undefined && mimeType.startsWith('application/vnd.google-apps.')
  const url = googleNative && mimeType !== DRIVE_FOLDER_MIME
    ? `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent('text/plain')}`
    : `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?alt=media`
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal })
  if (!response.ok) await throwProviderError('Google Drive', response, 'cannot download the file')
  return response.text()
}

/**
 * List the token owner's repos (up to 50, recently pushed first).
 * @param args - token, abort signal, overridable fetch.
 */
export async function listGithubRepos(args: {
  accessToken: string
  signal: AbortSignal
  fetchImpl?: typeof fetch
}): Promise<CloudFileItem[]> {
  const { accessToken, signal, fetchImpl = fetch } = args
  const params = new URLSearchParams({ per_page: '50', sort: 'pushed' })
  const response = await fetchImpl(`${GITHUB_REPOS_URL}?${params.toString()}`, {
    headers: { ...authHeaders(accessToken), 'User-Agent': 'deepseek-harness' },
    signal,
  })
  if (!response.ok) await throwProviderError('GitHub', response, 'cannot list repositories')
  const data = (await response.json()) as Array<{ full_name?: unknown }>
  const repos = Array.isArray(data) ? data : []
  return repos
    .filter(repo => typeof repo.full_name === 'string')
    .map(repo => ({ id: repo.full_name as string, name: repo.full_name as string, kind: 'folder' as const }))
}

/**
 * List one repo path's entries (empty path = repo root).
 * @param args - token, repo full name, path, abort signal, overridable fetch.
 */
export async function listGithubContents(args: {
  accessToken: string
  repo: string
  path: string
  signal: AbortSignal
  fetchImpl?: typeof fetch
}): Promise<CloudFileItem[]> {
  const { accessToken, repo, path, signal, fetchImpl = fetch } = args
  const suffix = path === '' ? '' : `/${path.split('/').map(encodeURIComponent).join('/')}`
  const response = await fetchImpl(
    `${GITHUB_CONTENTS_URL}/${repo}/contents${suffix}?per_page=100`,
    { headers: { ...authHeaders(accessToken), 'User-Agent': 'deepseek-harness' }, signal },
  )
  if (!response.ok) await throwProviderError('GitHub', response, 'cannot list the folder')
  const data = (await response.json()) as Array<{ path?: unknown; name?: unknown; type?: unknown; size?: unknown }>
  const entries = Array.isArray(data) ? data : []
  return entries
    .filter(entry => typeof entry.path === 'string' && typeof entry.name === 'string')
    .map(entry => ({
      id: entry.path as string,
      name: entry.name as string,
      kind: entry.type === 'dir' ? 'folder' as const : 'file' as const,
      ...(typeof entry.size === 'number' ? { size: entry.size } : {}),
    }))
}

/**
 * Download one repo file as text through the contents API.
 * @param args - token, repo full name, file path, abort signal, overridable fetch.
 */
export async function downloadGithubFile(args: {
  accessToken: string
  repo: string
  path: string
  signal: AbortSignal
  fetchImpl?: typeof fetch
}): Promise<string> {
  const { accessToken, repo, path, signal, fetchImpl = fetch } = args
  const suffix = path.split('/').map(encodeURIComponent).join('/')
  const response = await fetchImpl(
    `${GITHUB_CONTENTS_URL}/${repo}/contents/${suffix}`,
    { headers: { ...authHeaders(accessToken), Accept: 'application/vnd.github.raw', 'User-Agent': 'deepseek-harness' }, signal },
  )
  if (!response.ok) await throwProviderError('GitHub', response, 'cannot download the file')
  return response.text()
}

/**
 * Search recent messages (empty query = inbox, up to 20).
 * @param args - token, free-text filter, abort signal, overridable fetch.
 */
export async function listGmailMessages(args: {
  accessToken: string
  query: string
  signal: AbortSignal
  fetchImpl?: typeof fetch
}): Promise<CloudFileItem[]> {
  const { accessToken, query, signal, fetchImpl = fetch } = args
  const params = new URLSearchParams({ maxResults: '20', ...(query !== '' ? { q: query } : {}) })
  const response = await fetchImpl(`${GMAIL_BASE_URL}/messages?${params.toString()}`, {
    headers: authHeaders(accessToken),
    signal,
  })
  if (!response.ok) await throwProviderError('Gmail', response, 'cannot list messages')
  const data = (await response.json()) as { messages?: Array<{ id?: unknown }> }
  const messages = Array.isArray(data.messages) ? data.messages : []
  const rows: CloudFileItem[] = []
  for (const message of messages) {
    if (typeof message.id !== 'string') continue
    const meta = await fetchImpl(
      `${GMAIL_BASE_URL}/messages/${encodeURIComponent(message.id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
      { headers: authHeaders(accessToken), signal },
    )
    if (!meta.ok) continue
    const full = (await meta.json()) as { payload?: { headers?: Array<{ name?: unknown; value?: unknown }> } }
    const headers = Array.isArray(full.payload?.headers) ? full.payload.headers : []
    const subject = headers.find(header => header.name === 'Subject')?.value
    const from = headers.find(header => header.name === 'From')?.value
    rows.push({
      id: message.id,
      name: typeof subject === 'string' && subject !== '' ? subject : message.id,
      kind: 'file',
      ...(typeof from === 'string' && from !== '' ? { detail: from } : {}),
    })
  }
  return rows
}

/** Decode one base64url Gmail body part (browser-safe: no node Buffer). */
function decodeBody(data: string): string {
  try {
    const binary = atob(data.replace(/-/g, '+').replace(/_/g, '/'))
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return ''
  }
}

/** Deepest text/plain (else first text/html) body in a Gmail payload. */
function gmailBodyText(payload: {
  mimeType?: unknown
  body?: { data?: unknown; size?: unknown }
  parts?: unknown
}): string {
  const parts = Array.isArray(payload.parts) ? payload.parts as typeof payload[] : []
  for (const part of parts) {
    if (part.mimeType === 'text/plain' && typeof part.body?.data === 'string') {
      return decodeBody(part.body.data)
    }
  }
  for (const part of parts) {
    const nested = gmailBodyText(part)
    if (nested !== '') return nested
  }
  if (payload.mimeType === 'text/html' && typeof payload.body?.data === 'string') {
    return decodeBody(payload.body.data).replace(/<[^>]*>/g, ' ')
  }
  if (typeof payload.body?.data === 'string') return decodeBody(payload.body.data)
  return ''
}

/**
 * Download one message body as text.
 * @param args - token, message id, abort signal, overridable fetch.
 */
export async function downloadGmailMessage(args: {
  accessToken: string
  messageId: string
  signal: AbortSignal
  fetchImpl?: typeof fetch
}): Promise<string> {
  const { accessToken, messageId, signal, fetchImpl = fetch } = args
  const response = await fetchImpl(
    `${GMAIL_BASE_URL}/messages/${encodeURIComponent(messageId)}?format=full`,
    { headers: authHeaders(accessToken), signal },
  )
  if (!response.ok) await throwProviderError('Gmail', response, 'cannot download the message')
  const data = (await response.json()) as { payload?: Parameters<typeof gmailBodyText>[0] }
  if (!data.payload) return ''
  return gmailBodyText(data.payload)
}

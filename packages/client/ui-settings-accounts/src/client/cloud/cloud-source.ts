/**
 * The `/cloud` trigger source: one button per connected cloud at the top
 * level, drill-down file browsing inside a cloud (Tab / row chevron / header
 * crumbs rewrite the token and keep the menu open, mirroring the `@file`
 * descent), and settling picks on files insert structured references whose
 * codec downloads the content for the model at submit time. Lives beside the
 * Authorization cards so the menu reads the same browser-local document the
 * section persists — a just-authorized cloud appears without a reload.
 */
import type {
  InputTriggerCandidate,
  InputTriggerCrumb,
  InputTriggerPick,
  InputTriggerSource,
  PickOutcome,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import {
  isProviderConnected,
  listConnected,
  readAccountsSettings,
  type AccountProviderId,
  type AccountsSettings,
} from '../accounts-settings.ts'
import {
  downloadDriveFile,
  downloadGithubFile,
  downloadGmailMessage,
  listDriveFiles,
  listGithubContents,
  listGithubRepos,
  listGmailMessages,
  MAX_CLOUD_DOWNLOAD_BYTES,
  type CloudFileItem,
} from './cloud-api.ts'
import type { CloudKey } from './cloud-locales.ts'

/** Translate one cloud-namespace key (bound once at registration, like ui-skill). */
export type CloudTranslate = (key: CloudKey) => string

/** Resolves one provider's localized display name; the Accounts dictionary owns those names. */
export type CloudProviderName = (provider: AccountProviderId) => string

/** Short token keys written into the draft (stable across locales). */
const KEY_OF: Record<AccountProviderId, string> = {
  'google-drive': 'drive',
  'gmail': 'gmail',
  'github': 'github',
  'mega': 'mega',
}

/** Reverse lookup of the token keys. */
const PROVIDER_OF: Record<string, AccountProviderId> = {
  'drive': 'google-drive',
  'gmail': 'gmail',
  'github': 'github',
  'mega': 'mega',
}

/** Largest prompt contribution of one cloud file (chars). */
const MAX_SERIALIZED_CHARS = 32_000

/** Drive level cache lifetime (one browser = one account set). */
const DRIVE_CACHE_TTL_MS = 60_000

/** Where the menu currently is inside one cloud (null = top-level buttons). */
export interface CloudPosition {
  /** Resolved cloud. */
  readonly provider: AccountProviderId
  /** Path segments below the cloud root (human-readable names). */
  readonly segments: string[]
  /** Trailing text filtering this level's rows. */
  readonly filter: string
}

/**
 * Parse the live `/`-query into a menu position.
 * @param query - text between the trigger char and the caret.
 * @returns the position, or null for the top-level cloud buttons.
 */
export function parseCloudQuery(query: string): CloudPosition | null {
  const slash = query.indexOf('/')
  const head = slash === -1 ? query : query.slice(0, slash)
  // The provider key ends at whitespace or the slash; trailing head text
  // becomes the first filter piece (hand-typed `cloud drive Doc` keeps working).
  const match = /^cloud\s+(\S+)(?:\s+(.*))?\s*$/u.exec(head.trim())
  if (!match) return null
  const provider = PROVIDER_OF[match[1] ?? '']
  if (provider === undefined) return null
  const headRest = (match[2] ?? '').trim()
  const tail = slash === -1 ? [] : query.slice(slash + 1).split('/')
  const pieces = [...(headRest !== '' ? [headRest] : []), ...tail]
  return {
    provider,
    segments: pieces.slice(0, -1),
    filter: pieces.length === 0 ? '' : pieces[pieces.length - 1] ?? '',
  }
}

/** Draft token descending into one level (`/cloud drive/Documents/`). */
function drillDraft(provider: AccountProviderId, segments: string[]): string {
  const trail = segments.length === 0 ? '' : `${segments.join('/')}/`
  return `/cloud ${KEY_OF[provider]}/${trail}`
}

/** Opaque row payloads (crumb picks route through onPick the same way). */
export type CloudRowValue =
  | { readonly kind: 'cloud'; readonly provider: AccountProviderId }
  | { readonly kind: 'folder'; readonly provider: AccountProviderId; readonly segments: string[] }
  | { readonly kind: 'file'; readonly provider: AccountProviderId; readonly fileId: string; readonly name: string; readonly mimeType?: string; readonly size?: number }
  | { readonly kind: 'notice' }

/** Parse one row payload (rows and crumbs share the codec). */
export function parseRowValue(value: string | undefined): CloudRowValue | undefined {
  if (value === undefined) return undefined
  try {
    return JSON.parse(value) as CloudRowValue
  } catch {
    return undefined
  }
}

/** Case-insensitive substring filter over the row's visible text. */
function matchesFilter(text: string, filter: string): boolean {
  return filter === '' || text.toLowerCase().includes(filter.toLowerCase())
}

/** One cached Drive level: folder-name → id plus the raw rows. */
interface DriveLevel {
  /** Cache timestamp (epoch millis). */
  readonly at: number
  /** Listed rows. */
  readonly items: readonly CloudFileItem[]
}

/** Drive levels by `${provider}:${parentId}` (names resolve through parents). */
const driveLevels = new Map<string, DriveLevel>()

/**
 * One Drive level, cached briefly (candidates re-runs per keystroke).
 * @param accessToken - Drive OAuth token.
 * @param parentId - Drive folder id ('root' at the top).
 * @param signal - superseded on query change / menu close.
 * @returns the level rows.
 */
async function driveLevel(accessToken: string, parentId: string, signal: AbortSignal): Promise<readonly CloudFileItem[]> {
  const key = `drive:${parentId}`
  const hit = driveLevels.get(key)
  if (hit && Date.now() - hit.at < DRIVE_CACHE_TTL_MS) return hit.items
  const items = await listDriveFiles({ accessToken, folderId: parentId, signal })
  if (!signal.aborted) driveLevels.set(key, { at: Date.now(), items })
  return items
}

/**
 * Resolve human-readable Drive segments to a folder id, walking cached levels.
 * @param accessToken - Drive OAuth token.
 * @param segments - folder names below the root.
 * @param signal - superseded on query change / menu close.
 * @returns the folder id, or 'root' when a segment cannot be resolved.
 */
async function resolveDriveFolder(accessToken: string, segments: string[], signal: AbortSignal): Promise<string> {
  let parentId = 'root'
  for (const segment of segments) {
    const level = await driveLevel(accessToken, parentId, signal)
    const folder = level.find(item => item.kind === 'folder' && item.name === segment)
    if (!folder) return 'root'
    parentId = folder.id
  }
  return parentId
}

/**
 * Reference payload carried into the composer for one picked file.
 * @param provider - cloud key.
 * @param fileId - provider-stable file id.
 * @param name - display name.
 * @param extra - mime/size hints for the download choice.
 * @returns the opaque ref string (JSON; the codec parses it back).
 */
export function fileRef(
  provider: AccountProviderId,
  fileId: string,
  name: string,
  extra?: { mimeType?: string; size?: number },
): string {
  return JSON.stringify({ v: 1, p: KEY_OF[provider], id: fileId, name, ...extra })
}

/** Parsed file reference (undefined when the ref is foreign or corrupt). */
interface ParsedFileRef {
  readonly provider: AccountProviderId
  readonly fileId: string
  readonly name: string
  readonly mimeType?: string
  readonly size?: number
}

/**
 * Parse a file reference back.
 * @param ref - opaque ref string from the insert.
 * @returns the parsed ref, or undefined for foreign/corrupt values.
 */
export function parseFileRef(ref: string): ParsedFileRef | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(ref) as unknown
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  const provider = PROVIDER_OF[typeof record.p === 'string' ? record.p : '']
  if (provider === undefined || typeof record.id !== 'string') return undefined
  return {
    provider,
    fileId: record.id,
    name: typeof record.name === 'string' ? record.name : record.id,
    ...(typeof record.mimeType === 'string' ? { mimeType: record.mimeType } : {}),
    ...(typeof record.size === 'number' ? { size: record.size } : {}),
  }
}

/**
 * Create the `/cloud` trigger source.
 * @param t - cloud-namespace translator bound at registration.
 * @returns the source for `inputTriggers.registerSource`.
 */
export function createCloudSource(t: CloudTranslate, providerName: CloudProviderName): InputTriggerSource {
  /** Top-level cloud buttons (or the connect notice when empty). */
  function topRows(settings: AccountsSettings, filter: string): InputTriggerCandidate[] {
    const connected = listConnected(settings)
    if (connected.length === 0) {
      return [{
        name: t('empty'),
        description: t('empty.hint'),
        icon: 'folder',
        value: JSON.stringify({ kind: 'notice' } satisfies CloudRowValue),
      }]
    }
    return connected
      .filter(item => matchesFilter(`${providerName(item.provider)} ${item.accountLabel}`, filter))
      .map(item => ({
        name: providerName(item.provider),
        description: item.accountLabel,
        icon: 'folder' as const,
        section: t('crumbs.root'),
        value: JSON.stringify({ kind: 'cloud', provider: item.provider } satisfies CloudRowValue),
        drill: true,
      }))
  }

  /** Rows of one folder row (Drive/GitHub); folders drill, files insert. */
  function levelRows(
    provider: AccountProviderId,
    segments: string[],
    items: readonly CloudFileItem[],
    filter: string,
  ): InputTriggerCandidate[] {
    return items
      .filter(item => matchesFilter(item.name, filter))
      .slice(0, 50)
      .map((item) => {
        if (item.kind === 'folder') {
          const child = [...segments, item.name]
          return {
            name: `${item.name}/`,
            icon: 'folder' as const,
            value: JSON.stringify({ kind: 'folder', provider, segments: child } satisfies CloudRowValue),
            drill: true,
          }
        }
        // GitHub content paths are repo-relative: pin the repo into the id.
        const fileId = provider === 'github' && segments.length >= 2
          ? [...segments.slice(0, 2), item.id].join('/')
          : item.id
        const value: CloudRowValue = {
          kind: 'file',
          provider,
          fileId,
          name: item.name,
          ...(item.mimeType !== undefined ? { mimeType: item.mimeType } : {}),
          ...(item.size !== undefined ? { size: item.size } : {}),
        }
        return {
          name: item.name,
          ...(item.detail !== undefined ? { description: item.detail } : {}),
          icon: 'file' as const,
          value: JSON.stringify(value),
        }
      })
  }

  /** List one cloud level (throws readable errors for the notice row). */
  async function listLevel(
    accessToken: string,
    provider: AccountProviderId,
    segments: string[],
    signal: AbortSignal,
  ): Promise<readonly CloudFileItem[]> {
    if (provider === 'gmail') return listGmailMessages({ accessToken, query: '', signal })
    if (provider === 'github') {
      if (segments.length < 2) return listGithubRepos({ accessToken, signal })
      const [owner, repo, ...rest] = segments
      return listGithubContents({ accessToken, repo: `${owner}/${repo}`, path: rest.join('/'), signal })
    }
    const folderId = await resolveDriveFolder(accessToken, segments, signal)
    return driveLevel(accessToken, folderId, signal)
  }

  return {
    trigger: '/',
    name: 'cloud',
    order: 1,
    async candidates(_session, { query, signal }) {
      const settings = readAccountsSettings()
      const position = parseCloudQuery(query)
      if (position === null) {
        const filter = query.replace(/^cloud\b\s*/u, '')
        return topRows(settings, filter)
      }
      const { provider, segments, filter } = position
      if (provider === 'mega') {
        return [{
          name: t('mega.notice'),
          description: t('mega.hint'),
          icon: 'folder',
          value: JSON.stringify({ kind: 'notice' } satisfies CloudRowValue),
        }]
      }
      const entry = settings.providers[provider]
      if (entry.kind !== 'oauth' || !isProviderConnected(entry)) {
        return [{
          name: t('load.error'),
          description: t('empty.hint'),
          icon: 'file',
          value: JSON.stringify({ kind: 'notice' } satisfies CloudRowValue),
        }]
      }
      const accessToken = entry.accessToken
      if (provider === 'gmail') {
        try {
          const items = await listGmailMessages({ accessToken, query: filter, signal })
          if (signal.aborted) return []
          return levelRows(provider, segments, items, '')
        } catch (error) {
          if (signal.aborted) return []
          return [{
            name: t('load.error'),
            description: error instanceof Error ? error.message : String(error),
            icon: 'file',
            value: JSON.stringify({ kind: 'notice' } satisfies CloudRowValue),
          }]
        }
      }
      try {
        const items = await listLevel(accessToken, provider, segments, signal)
        if (signal.aborted) return []
        if (provider === 'github' && segments.length < 2) {
          const needle = [...segments, filter].join('/').toLowerCase()
          return levelRows(provider, segments, items.filter(item => item.id.toLowerCase().includes(needle)).slice(0, 50), '')
        }
        return levelRows(provider, segments, items, filter)
      } catch (error) {
        if (signal.aborted) return []
        return [{
          name: t('load.error'),
          description: error instanceof Error ? error.message : String(error),
          icon: 'file',
          value: JSON.stringify({ kind: 'notice' } satisfies CloudRowValue),
        }]
      }
    },
    header(_session, req) {
      const position = parseCloudQuery(req.query)
      if (position === null) return undefined
      const { provider, segments } = position
      const crumbs: InputTriggerCrumb[] = [{
        label: providerName(provider),
        value: JSON.stringify({ kind: 'cloud', provider } satisfies CloudRowValue),
      }]
      segments.forEach((segment, index) => {
        crumbs.push({
          label: segment,
          value: JSON.stringify({ kind: 'folder', provider, segments: segments.slice(0, index + 1) } satisfies CloudRowValue),
          ...(index === segments.length - 1 ? { current: true } : {}),
        })
      })
      return crumbs
    },
    onPick(pick: InputTriggerPick): PickOutcome {
      const value = parseRowValue(pick.candidate.value)
      if (value === undefined || value.kind === 'notice') return undefined
      if (value.kind === 'cloud') return { text: drillDraft(value.provider, []), continue: true }
      if (value.kind === 'folder') return { text: drillDraft(value.provider, value.segments), continue: true }
      const ref = fileRef(value.provider, value.fileId, value.name, {
        ...(value.mimeType !== undefined ? { mimeType: value.mimeType } : {}),
        ...(value.size !== undefined ? { size: value.size } : {}),
      })
      return {
        insert: {
          source: 'cloud',
          ref,
          label: value.name,
          appearance: 'file',
          clipboardText: `cloud:${KEY_OF[value.provider]}/${value.name}`,
        },
      }
    },
    codec: {
      clipboardText: ref => ref,
      serialize: async (ref, signal) => downloadFileRef(ref, t, signal),
    },
  }
}

/**
 * Download one inserted cloud file for the model prompt.
 * @param ref - opaque file reference from the insert.
 * @param t - cloud-namespace translator.
 * @param signal - attempt-scoped abort (the submit attempt signal).
 * @returns the file text, truncated with a marker when long.
 * @throws a readable error (blocks the send — never a silent downgrade).
 */
export async function downloadFileRef(ref: string, t: CloudTranslate, signal: AbortSignal): Promise<string> {
  const parsed = parseFileRef(ref)
  if (parsed === undefined) throw new Error('cloud: unknown file reference')
  if (parsed.size !== undefined && parsed.size > MAX_CLOUD_DOWNLOAD_BYTES) {
    throw new Error(t('file.tooLarge').replace('{size}', String(parsed.size)))
  }
  const settings = readAccountsSettings()
  const entry = settings.providers[parsed.provider]
  if (entry.kind !== 'oauth' || !isProviderConnected(entry)) {
    throw new Error('cloud: disconnected — reconnect in Settings → Accounts')
  }
  const accessToken = entry.accessToken
  let text: string
  if (parsed.provider === 'gmail') {
    text = await downloadGmailMessage({ accessToken, messageId: parsed.fileId, signal })
  } else if (parsed.provider === 'github') {
    const parts = parsed.fileId.split('/')
    const repo = parts.slice(0, 2).join('/')
    const path = parts.slice(2).join('/')
    text = await downloadGithubFile({ accessToken, repo, path, signal })
  } else {
    text = await downloadDriveFile({
      accessToken,
      fileId: parsed.fileId,
      ...(parsed.mimeType !== undefined ? { mimeType: parsed.mimeType } : {}),
      signal,
    })
  }
  if (signal.aborted) throw new Error('aborted')
  if (text.length > MAX_SERIALIZED_CHARS) return text.slice(0, MAX_SERIALIZED_CHARS) + t('file.truncated')
  return text
}

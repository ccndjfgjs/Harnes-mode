/**
 * Browser-local cloud-account settings: the single persistence behind the
 * Accounts Settings page and the Authorization card. Tokens stay in this
 * browser's localStorage (never in the session log), so a secret typed here
 * never reaches a model request. The Commands cloud-file tab (P3) reuses
 * `listConnected` to render one button per connected cloud.
 */

/** Storage key for the whole accounts document. */
export const ACCOUNTS_SETTINGS_STORAGE_KEY = 'dsh.accounts.settings'

/** Providers authenticating through OAuth 2.0. */
export type OAuthProviderId = 'google-drive' | 'gmail' | 'github'

/** Every provider the Accounts section renders. */
export type AccountProviderId = OAuthProviderId | 'mega'

/** Stored state of one OAuth-backed provider card. */
export interface OAuthAccountState {
  /** Discriminator for the card kind. */
  kind: 'oauth'
  /** Whether the provider counts as authorized. */
  connected: boolean
  /** Email/login shown in the Authorization card. */
  accountLabel: string
  /** OAuth application client id typed in the card. */
  clientId: string
  /** Bearer token for API calls (empty = not authorized). */
  accessToken: string
  /** Refresh token when the provider issues one (may be empty). */
  refreshToken: string
  /** Token deadline as epoch millis (0 = unknown). */
  expiresAt: number
}

/** Stored state of the Mega card (email + password, no OAuth surface). */
export interface MegaAccountState {
  /** Discriminator for the card kind. */
  kind: 'password'
  /** Whether the provider counts as authorized. */
  connected: boolean
  /** Email shown in the Authorization card. */
  accountLabel: string
  /** Mega login (email). */
  login: string
  /** Mega password. */
  password: string
}

/** Stored state of one provider card. */
export type ProviderAccountState = OAuthAccountState | MegaAccountState

/** The whole accounts document: one entry per provider. */
export interface AccountsSettings {
  /** Per-provider state keyed by provider id. */
  providers: Record<AccountProviderId, ProviderAccountState>
}

/** Blank OAuth entry: disconnected until a token is saved. */
function blankOAuth(): OAuthAccountState {
  return { kind: 'oauth', connected: false, accountLabel: '', clientId: '', accessToken: '', refreshToken: '', expiresAt: 0 }
}

/** Blank Mega entry: disconnected until login + password are saved. */
function blankMega(): MegaAccountState {
  return { kind: 'password', connected: false, accountLabel: '', login: '', password: '' }
}

/** Blank settings: every provider reads as disconnected. */
export const EMPTY_ACCOUNTS_SETTINGS: AccountsSettings = {
  providers: {
    'google-drive': blankOAuth(),
    'gmail': blankOAuth(),
    'github': blankOAuth(),
    'mega': blankMega(),
  },
}

/**
 * Read the stored accounts document, tolerating a missing or corrupt value.
 * @returns the stored settings, or blank settings when nothing usable is stored.
 */
export function readAccountsSettings(): AccountsSettings {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(ACCOUNTS_SETTINGS_STORAGE_KEY)
  } catch {
    return structuredCloneSettings()
  }
  if (raw === null) return structuredCloneSettings()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    // A foreign writer corrupted the document: treat it as absent rather than
    // surfacing a parse failure from a settings read.
    return structuredCloneSettings()
  }
  if (typeof parsed !== 'object' || parsed === null) return structuredCloneSettings()
  const providers = (parsed as { providers?: unknown }).providers
  if (typeof providers !== 'object' || providers === null) return structuredCloneSettings()
  const record = providers as Record<string, unknown>
  const text = (value: unknown): string => (typeof value === 'string' ? value : '')
  const readOAuth = (value: unknown): OAuthAccountState => {
    const entry = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
    return {
      kind: 'oauth',
      connected: entry.connected === true,
      accountLabel: text(entry.accountLabel).trim(),
      clientId: text(entry.clientId).trim(),
      accessToken: text(entry.accessToken).trim(),
      refreshToken: text(entry.refreshToken).trim(),
      expiresAt: typeof entry.expiresAt === 'number' ? entry.expiresAt : 0,
    }
  }
  return {
    providers: {
      'google-drive': readOAuth(record['google-drive']),
      'gmail': readOAuth(record.gmail),
      'github': readOAuth(record.github),
      'mega': {
        kind: 'password',
        connected: (record.mega as { connected?: unknown } | undefined)?.connected === true,
        accountLabel: text((record.mega as { accountLabel?: unknown } | undefined)?.accountLabel).trim(),
        login: text((record.mega as { login?: unknown } | undefined)?.login).trim(),
        password: text((record.mega as { password?: unknown } | undefined)?.password),
      },
    },
  }
}

/**
 * Persist one provider entry, merging over the stored document.
 * @param id - provider key.
 * @param patch - fields to store.
 */
export function writeProviderSettings(id: AccountProviderId, patch: Partial<ProviderAccountState>): void {
  const next = readAccountsSettings()
  const current = next.providers[id]
  if (current.kind === 'oauth') {
    const update = patch as Partial<OAuthAccountState>
    next.providers[id] = {
      ...current,
      ...(update.connected !== undefined ? { connected: update.connected } : {}),
      ...(update.accountLabel !== undefined ? { accountLabel: update.accountLabel.trim() } : {}),
      ...(update.clientId !== undefined ? { clientId: update.clientId.trim() } : {}),
      ...(update.accessToken !== undefined ? { accessToken: update.accessToken.trim() } : {}),
      ...(update.refreshToken !== undefined ? { refreshToken: update.refreshToken.trim() } : {}),
      ...(update.expiresAt !== undefined ? { expiresAt: update.expiresAt } : {}),
    }
  } else {
    const update = patch as Partial<MegaAccountState>
    next.providers[id] = {
      ...current,
      ...(update.connected !== undefined ? { connected: update.connected } : {}),
      ...(update.accountLabel !== undefined ? { accountLabel: update.accountLabel.trim() } : {}),
      ...(update.login !== undefined ? { login: update.login.trim() } : {}),
      ...(update.password !== undefined ? { password: update.password } : {}),
    }
  }
  try {
    localStorage.setItem(ACCOUNTS_SETTINGS_STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Private-mode/quota writes fail silently: the page keeps its draft and
    // the connected checks keep reporting disconnected.
  }
}

/**
 * Whether one provider counts as authorized.
 * @param state - stored provider entry (defaults to blank = disconnected).
 * @returns true for an OAuth entry holding a live token, or a Mega entry
 * holding login + password.
 */
export function isProviderConnected(state: ProviderAccountState = blankOAuth()): boolean {
  if (!state.connected) return false
  if (state.kind === 'password') return state.login !== '' && state.password !== ''
  if (state.accessToken === '') return false
  return state.expiresAt === 0 || state.expiresAt > Date.now()
}

/** One authorized cloud for the Authorization card and the Commands tab. */
export interface ConnectedAccount {
  /** Provider key. */
  provider: AccountProviderId
  /** Email/login shown next to the provider. */
  accountLabel: string
  /** Token deadline as epoch millis (0 = unknown / password auth). */
  expiresAt: number
}

/**
 * List the authorized clouds in card order.
 * @param settings - settings to inspect (defaults to the stored document).
 * @returns the connected providers with their display labels.
 */
export function listConnected(settings: AccountsSettings = readAccountsSettings()): ConnectedAccount[] {
  const ids: readonly AccountProviderId[] = ['google-drive', 'gmail', 'github', 'mega']
  const connected: ConnectedAccount[] = []
  for (const provider of ids) {
    const state = settings.providers[provider]
    if (!isProviderConnected(state)) continue
    connected.push({
      provider,
      accountLabel: state.accountLabel !== '' ? state.accountLabel : state.kind === 'password' ? state.login : provider,
      expiresAt: state.kind === 'oauth' ? state.expiresAt : 0,
    })
  }
  return connected
}

/**
 * Whether any cloud is authorized.
 * @param settings - settings to inspect (defaults to the stored document).
 * @returns true when at least one provider is connected.
 */
export function isAnyAccountConnected(settings: AccountsSettings = readAccountsSettings()): boolean {
  return listConnected(settings).length > 0
}

/** Fresh blank document (deep copy — the constant stays immutable). */
function structuredCloneSettings(): AccountsSettings {
  return {
    providers: {
      'google-drive': blankOAuth(),
      'gmail': blankOAuth(),
      'github': blankOAuth(),
      'mega': blankMega(),
    },
  }
}

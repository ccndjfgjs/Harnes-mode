/**
 * Cloud provider descriptors for the Accounts section: the OAuth 2.0
 * endpoints and scopes behind each connect card, plus the authorize-URL
 * builder and the code-for-token exchange used by the section.
 * Mega has no OAuth surface, so it authenticates with email + password.
 */
import type { AccountProviderId, OAuthProviderId } from './accounts-settings.ts'

/** Static OAuth 2.0 descriptor of one connect card. */
export interface OAuthProviderDescriptor {
  /** Provider key (matches the stored settings entry). */
  id: OAuthProviderId
  /** Authorization endpoint opened in the browser. */
  authUrl: string
  /** Token endpoint used by the code exchange. */
  tokenUrl: string
  /** Scopes requested on the login page (read-only file access). */
  scopes: readonly string[]
}

/** OAuth descriptors keyed by provider. */
export const OAUTH_PROVIDERS: Record<OAuthProviderId, OAuthProviderDescriptor> = {
  'google-drive': {
    id: 'google-drive',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  },
  'gmail': {
    id: 'gmail',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
  },
  'github': {
    id: 'github',
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scopes: ['repo', 'read:user'],
  },
}

/** Every provider id the Accounts section renders, in card order. */
export const ACCOUNT_PROVIDER_IDS: readonly AccountProviderId[] = ['google-drive', 'gmail', 'github', 'mega']

/**
 * Default OAuth Client IDs baked into the app by its developer (public
 * identifiers — Desktop/device flows need no secret). Empty until the
 * developer registers the OAuth apps and pastes the IDs here; users may also
 * type their own Client ID into each card (persisted per provider).
 */
export const DEFAULT_CLIENT_IDS: Record<OAuthProviderId, string> = {
  'google-drive': '',
  'gmail': '',
  'github': '',
}

/** Tokens delivered by the Electron main process after the in-app login. */
export interface AccountsOAuthDone {
  /** Provider key. */
  provider: OAuthProviderId
  /** Email/login resolved after the exchange (may be empty). */
  accountLabel: string
  /** Bearer token for API calls. */
  accessToken: string
  /** Refresh token when the provider issues one (may be empty). */
  refreshToken: string
  /** Token deadline as epoch millis (0 = unknown). */
  expiresAt: number
}

/** Login failure delivered by the Electron main process. */
export interface AccountsOAuthError {
  /** Provider key. */
  provider: OAuthProviderId
  /** Readable failure reason. */
  message: string
  /** True when the user closed or cancelled the login window. */
  cancelled: boolean
}

/** GitHub device payload returned by the start call. */
export interface AccountsOAuthDevice {
  /** Code the user types on the verification page. */
  userCode: string
  /** Page opened in the in-app login window. */
  verificationUri: string
  /** Code lifetime in seconds. */
  expiresIn: number
}

/** Result of the start call. */
export interface AccountsOAuthStartResult {
  /** Whether the login window is opening. */
  ok: boolean
  /** Failure reason when ok is false. */
  error?: string
  /** Present for the GitHub device flow: the code to display. */
  device?: AccountsOAuthDevice
}

/** Minimal Electron bridge face used by the section. */
export interface ElectronAccountsBridge {
  /** Open the in-app login window and start the provider flow. */
  accountsOAuthStart: (args: { provider: OAuthProviderId; clientId: string }) => Promise<AccountsOAuthStartResult>
  /** Close the login window and stop the flow. */
  accountsOAuthCancel: () => Promise<unknown>
  /** Subscribe to successful logins (returns the unsubscribe). */
  onAccountsOAuthDone: (callback: (done: AccountsOAuthDone) => void) => () => void
  /** Subscribe to login failures (returns the unsubscribe). */
  onAccountsOAuthError: (callback: (error: AccountsOAuthError) => void) => () => void
}

/**
 * The Electron bridge when the section runs inside the app, null in browsers
 * (the section falls back to a popup + manual code paste there).
 * @returns the bridge, or null outside the Electron shell.
 */
export function getAccountsBridge(): ElectronAccountsBridge | null {
  if (typeof window === 'undefined') return null
  const api = (window as unknown as { harnessAPI?: Partial<ElectronAccountsBridge> }).harnessAPI
  if (!api || typeof api.accountsOAuthStart !== 'function') return null
  return api as ElectronAccountsBridge
}

/**
 * Whether the provider authorizes through OAuth 2.0 (Mega uses email + password).
 * @param id - provider key.
 * @returns true for the OAuth-backed providers.
 */
export function isOAuthProvider(id: AccountProviderId): id is OAuthProviderId {
  return id !== 'mega'
}

/**
 * Build the login-page URL for one OAuth provider (PKCE S256 flow, the
 * redirect lands on localhost where the user copies the code back).
 * @param id - OAuth provider key.
 * @param clientId - OAuth application client id typed in the card.
 * @param challenge - PKCE S256 code challenge for the pending exchange.
 * @param state - opaque round-trip state.
 * @returns the authorize URL to open in the browser.
 */
export function buildAuthorizeUrl(
  id: OAuthProviderId,
  clientId: string,
  challenge: string,
  state: string,
): string {
  const descriptor = OAUTH_PROVIDERS[id]
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: 'http://localhost',
    response_type: 'code',
    scope: descriptor.scopes.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  })
  return `${descriptor.authUrl}?${params.toString()}`
}

/**
 * Create one PKCE verifier/challenge pair for the pending code exchange.
 * @returns the plain verifier (kept for the exchange) and its S256 challenge.
 */
export async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  const verifier = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '')
  return { verifier, challenge }
}

/** Token endpoint response shape (OAuth 2.0 code exchange). */
export interface TokenExchangeResult {
  /** Bearer token for API calls. */
  accessToken: string
  /** Refresh token when the provider issues one (may be empty). */
  refreshToken: string
  /** Lifetime in seconds when the provider reports one (0 = unknown). */
  expiresIn: number
}

/**
 * Exchange one authorization code for tokens. Browser CORS policies may
 * reject the token endpoint — callers fall back to manual token paste then.
 * @param id - OAuth provider key.
 * @param clientId - OAuth application client id.
 * @param code - authorization code pasted from the login page.
 * @param verifier - PKCE verifier paired with the authorize URL challenge.
 * @returns the issued tokens.
 * @throws when the endpoint is unreachable or rejects the code.
 */
export async function exchangeCodeForToken(
  id: OAuthProviderId,
  clientId: string,
  code: string,
  verifier: string,
): Promise<TokenExchangeResult> {
  const descriptor = OAUTH_PROVIDERS[id]
  const body = new URLSearchParams({
    client_id: clientId,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: 'http://localhost',
  })
  const response = await fetch(descriptor.tokenUrl, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!response.ok) throw new Error(`token endpoint rejected the code (${response.status})`)
  const data = (await response.json()) as Record<string, unknown>
  const accessToken = typeof data.access_token === 'string' ? data.access_token : ''
  if (accessToken === '') throw new Error('token endpoint returned no access token')
  return {
    accessToken,
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : '',
    expiresIn: typeof data.expires_in === 'number' ? data.expires_in : 0,
  }
}

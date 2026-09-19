/** The Accounts Settings page: OAuth 2.0 cloud cards over browser-local storage. */
import { useEffect, useState } from 'react'
import type { ChangeEvent } from 'react'
import clsx from 'clsx'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AccountsSettingsKey } from './locales.ts'
import {
  isProviderConnected,
  listConnected,
  readAccountsSettings,
  writeProviderSettings,
  type AccountProviderId,
  type AccountsSettings,
  type OAuthProviderId,
} from './accounts-settings.ts'
import {
  ACCOUNT_PROVIDER_IDS,
  DEFAULT_CLIENT_IDS,
  buildAuthorizeUrl,
  createPkcePair,
  exchangeCodeForToken,
  getAccountsBridge,
} from './providers.ts'
import css from './AccountsSection.module.css'

/** Business callbacks injected into the Accounts section (locale-bound copy). */
export interface AccountsSectionInjected {
  /** Translate one Accounts Settings key. */
  t: (key: AccountsSettingsKey) => string
}

/** Full component props: section owner share plus the injected copy face. */
export type AccountsSectionProps = PropsRuntime<'settings.section'> & AccountsSectionInjected

/** sessionStorage key for the pending PKCE verifier of one provider. */
function pkceKey(id: OAuthProviderId): string {
  return `dsh.accounts.pkce.${id}`
}

/** Inline action failure bound to one card. */
interface ActionError {
  /** Card the message belongs to. */
  id: AccountProviderId
  /** Rendered message. */
  text: string
}

/** GitHub device-flow prompt shown while the user approves in the popup. */
interface DevicePrompt {
  /** Card the prompt belongs to. */
  id: OAuthProviderId
  /** Code the user types on the verification page. */
  userCode: string
  /** Page opened in the in-app login window. */
  verificationUri: string
}

/**
 * Render the Accounts Settings template: the Authorization card listing the
 * connected clouds, then one connect card per provider (OAuth 2.0 login for
 * Google Drive, Gmail and GitHub; email + password for Mega). Inside the
 * Electron shell the login page opens in a small in-app window and the main
 * process finishes the flow; in browsers it falls back to a popup plus a
 * manual code paste. Everything persists to browser-local storage.
 * @param props - section owner share plus the injected copy face.
 * @returns the section element tree.
 */
export function AccountsSection({ t }: AccountsSectionProps) {
  const [draft, setDraft] = useState<AccountsSettings>(() => {
    const stored = readAccountsSettings()
    for (const id of ['google-drive', 'gmail', 'github'] as const) {
      const entry = stored.providers[id]
      if (entry.kind === 'oauth' && entry.clientId === '' && DEFAULT_CLIENT_IDS[id] !== '') {
        stored.providers[id] = { ...entry, clientId: DEFAULT_CLIENT_IDS[id] }
      }
    }
    return stored
  })
  const [saved, setSaved] = useState(false)
  const [codes, setCodes] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<AccountProviderId | null>(null)
  const [actionError, setActionError] = useState<ActionError | null>(null)
  const [pendingId, setPendingId] = useState<OAuthProviderId | null>(null)
  const [device, setDevice] = useState<DevicePrompt | null>(null)
  const connected = listConnected(draft)

  // In-app login results from the Electron main process: auto-fill the card
  // and persist, so the user never pastes codes by hand inside the app.
  useEffect(() => {
    const bridge = getAccountsBridge()
    if (!bridge) return undefined
    const offDone = bridge.onAccountsOAuthDone((done) => {
      const stored = readAccountsSettings()
      const entry = stored.providers[done.provider]
      if (entry.kind !== 'oauth') return
      const next = {
        ...entry,
        connected: true,
        accountLabel: done.accountLabel !== '' ? done.accountLabel : entry.accountLabel,
        accessToken: done.accessToken,
        refreshToken: done.refreshToken,
        expiresAt: done.expiresAt,
      }
      writeProviderSettings(done.provider, next)
      setDraft(previous => ({ ...previous, providers: { ...previous.providers, [done.provider]: next } }))
      setPendingId(null)
      setDevice(null)
      setActionError(null)
      setSaved(true)
    })
    const offError = bridge.onAccountsOAuthError((failure) => {
      setPendingId(null)
      setDevice(null)
      if (!failure.cancelled) {
        setActionError({ id: failure.provider, text: t('oauth.failed').replace('{message}', failure.message) })
      }
    })
    return () => {
      offDone()
      offError()
    }
  }, [t])

  const providerName = (id: AccountProviderId): string => t(`provider.${id}`)

  const fail = (id: AccountProviderId, text: string): void => {
    setActionError({ id, text })
  }

  const editOAuth = (id: OAuthProviderId, field: 'clientId' | 'accountLabel' | 'accessToken') =>
    (event: ChangeEvent<HTMLInputElement>): void => {
      const value = event.target.value
      setSaved(false)
      setDraft(previous => ({
        ...previous,
        providers: {
          ...previous.providers,
          [id]: { ...previous.providers[id], [field]: value },
        },
      }))
    }

  const editMega = (field: 'login' | 'password') =>
    (event: ChangeEvent<HTMLInputElement>): void => {
      const value = event.target.value
      setSaved(false)
      setDraft(previous => ({
        ...previous,
        providers: {
          ...previous.providers,
          mega: { ...previous.providers.mega, [field]: value },
        },
      }))
    }

  const editCode = (id: OAuthProviderId) =>
    (event: ChangeEvent<HTMLInputElement>): void => {
      const value = event.target.value
      setCodes(previous => ({ ...previous, [id]: value }))
    }

  const save = (): void => {
    for (const id of ACCOUNT_PROVIDER_IDS) writeProviderSettings(id, draft.providers[id])
    setSaved(true)
  }

  const openLogin = (id: OAuthProviderId) => async (): Promise<void> => {
    const entry = draft.providers[id]
    if (entry.kind !== 'oauth') return
    const clientId = entry.clientId.trim()
    if (clientId === '') {
      fail(id, t('oauth.needClientId'))
      return
    }
    setActionError(null)
    const bridge = getAccountsBridge()
    if (bridge) {
      // Electron shell: the login page opens in a small in-app window and
      // the main process reports back over IPC.
      setPendingId(id)
      setDevice(null)
      try {
        const result = await bridge.accountsOAuthStart({ provider: id, clientId })
        if (!result.ok) {
          setPendingId(null)
          fail(id, t('oauth.failed').replace('{message}', result.error ?? ''))
          return
        }
        if (result.device) {
          setDevice({ id, userCode: result.device.userCode, verificationUri: result.device.verificationUri })
        }
      } catch (error) {
        setPendingId(null)
        fail(id, t('oauth.failed').replace('{message}', error instanceof Error ? error.message : String(error)))
      }
      return
    }
    // Browser fallback: popup plus a manual code paste below.
    const { verifier, challenge } = await createPkcePair()
    try {
      sessionStorage.setItem(pkceKey(id), verifier)
    } catch {
      fail(id, t('oauth.failed').replace('{message}', 'storage'))
      return
    }
    const url = buildAuthorizeUrl(id, clientId, challenge, id)
    let popup: Window | null = null
    try {
      popup = window.open(url, '_blank', 'width=520,height=660')
    } catch {
      popup = null
    }
    if (!popup) fail(id, t('oauth.popupBlocked'))
  }

  const cancelLogin = (id: OAuthProviderId) => (): void => {
    const bridge = getAccountsBridge()
    if (bridge) void bridge.accountsOAuthCancel()
    if (pendingId === id) setPendingId(null)
    if (device?.id === id) setDevice(null)
  }

  const exchange = (id: OAuthProviderId) => async (): Promise<void> => {
    const code = (codes[id] ?? '').trim()
    const entry = draft.providers[id]
    if (entry.kind !== 'oauth') return
    if (entry.clientId.trim() === '') {
      fail(id, t('oauth.needClientId'))
      return
    }
    if (code === '') {
      fail(id, t('oauth.needCode'))
      return
    }
    let verifier: string | null = null
    try {
      verifier = sessionStorage.getItem(pkceKey(id))
    } catch {
      verifier = null
    }
    if (verifier === null) {
      fail(id, t('oauth.failed').replace('{message}', 'session'))
      return
    }
    setBusy(id)
    setActionError(null)
    try {
      const tokens = await exchangeCodeForToken(id, entry.clientId.trim(), code, verifier)
      const next = {
        ...entry,
        connected: true,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresIn > 0 ? Date.now() + tokens.expiresIn * 1000 : 0,
      }
      setDraft(previous => ({ ...previous, providers: { ...previous.providers, [id]: next } }))
      writeProviderSettings(id, next)
      setSaved(true)
      setCodes(previous => ({ ...previous, [id]: '' }))
    } catch (error) {
      fail(id, t('oauth.failed').replace('{message}', error instanceof Error ? error.message : String(error)))
    } finally {
      setBusy(null)
    }
  }

  const saveToken = (id: OAuthProviderId) => (): void => {
    const entry = draft.providers[id]
    if (entry.kind !== 'oauth') return
    if (entry.accessToken.trim() === '') {
      fail(id, t('oauth.needToken'))
      return
    }
    const next = { ...entry, connected: true }
    setDraft(previous => ({ ...previous, providers: { ...previous.providers, [id]: next } }))
    writeProviderSettings(id, next)
    setActionError(null)
    setSaved(true)
  }

  const connectMega = (): void => {
    const entry = draft.providers.mega
    if (entry.kind !== 'password') return
    if (entry.login.trim() === '' || entry.password === '') {
      fail('mega', t('mega.needLogin'))
      return
    }
    const next = { ...entry, accountLabel: entry.login.trim(), connected: true }
    setDraft(previous => ({ ...previous, providers: { ...previous.providers, mega: next } }))
    writeProviderSettings('mega', next)
    setActionError(null)
    setSaved(true)
  }

  const disconnect = (id: AccountProviderId) => (): void => {
    const entry = draft.providers[id]
    const next = entry.kind === 'oauth'
      ? { ...entry, connected: false, accountLabel: '', accessToken: '', refreshToken: '', expiresAt: 0 }
      : { ...entry, connected: false, accountLabel: '', password: '' }
    setDraft(previous => ({ ...previous, providers: { ...previous.providers, [id]: next } }))
    writeProviderSettings(id, next)
    setSaved(false)
  }

  const cardError = (id: AccountProviderId): string | null =>
    actionError?.id === id ? actionError.text : null

  return (
    <div className={css.section}>
      <p className={css.description}>{t('description')}</p>
      <section className={css.card} aria-label={t('auth.title')}>
        <h3 className={css.cardTitle}>{t('auth.title')}</h3>
        {connected.length === 0 && <p className={css.empty}>{t('auth.empty')}</p>}
        {connected.map(item => (
          <div className={css.authRow} key={item.provider}>
            <span className={css.authLabel}>
              {t('auth.row').replace('{provider}', providerName(item.provider)).replace('{account}', item.accountLabel)}
            </span>
            {item.expiresAt > 0 && (
              <span className={css.authExpiry}>
                {t('auth.expires').replace('{date}', new Date(item.expiresAt).toLocaleString())}
              </span>
            )}
            <button type="button" className={css.ghost} onClick={disconnect(item.provider)}>
              {t('auth.disconnect')}
            </button>
          </div>
        ))}
      </section>
      {ACCOUNT_PROVIDER_IDS.map((id) => {
        const entry = draft.providers[id]
        const live = isProviderConnected(entry)
        const error = cardError(id)
        if (entry.kind === 'password') {
          return (
            <section className={css.card} aria-label={providerName(id)} key={id}>
              <h3 className={css.cardTitle}>{providerName(id)}</h3>
              <label className={css.field}>
                <span className={css.fieldLabel}>{t('mega.login')}</span>
                <input
                  className={css.fieldInput}
                  type="email"
                  autoComplete="username"
                  spellCheck={false}
                  placeholder={t('mega.login.placeholder')}
                  value={entry.login}
                  onChange={editMega('login')}
                />
              </label>
              <label className={css.field}>
                <span className={css.fieldLabel}>{t('mega.password')}</span>
                <input
                  className={css.fieldInput}
                  type="password"
                  autoComplete="new-password"
                  placeholder={t('mega.password.placeholder')}
                  value={entry.password}
                  onChange={editMega('password')}
                />
              </label>
              <div className={css.footer}>
                <button type="button" className={css.save} onClick={connectMega}>
                  {t('mega.connect')}
                </button>
                <span className={clsx(css.status, live && css.statusReady)} role="status">
                  {live ? t('mega.connected') : t('mega.missing')}
                </span>
              </div>
              {error !== null && <span className={css.error} role="alert">{error}</span>}
            </section>
          )
        }
        const oauthId = id as OAuthProviderId
        const pending = pendingId === id
        const prompt = device?.id === id ? device : null
        return (
          <section className={css.card} aria-label={providerName(id)} key={id}>
            <h3 className={css.cardTitle}>{providerName(id)}</h3>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('oauth.clientId')}</span>
              <input
                className={css.fieldInput}
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder={t('oauth.clientId.placeholder')}
                value={entry.clientId}
                onChange={editOAuth(oauthId, 'clientId')}
              />
              <span className={css.hint}>{t('oauth.howToClientId')}</span>
            </label>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('oauth.account')}</span>
              <input
                className={css.fieldInput}
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder={t('oauth.account.placeholder')}
                value={entry.accountLabel}
                onChange={editOAuth(oauthId, 'accountLabel')}
              />
            </label>
            <div className={css.row}>
              <button type="button" className={css.secondary} disabled={pending} onClick={() => { void openLogin(oauthId)() }}>
                {t('oauth.openLogin')}
              </button>
              {pending && (
                <>
                  <span className={css.status} role="status">{t('oauth.opening')}</span>
                  <button type="button" className={css.ghost} onClick={cancelLogin(oauthId)}>
                    {t('oauth.cancel')}
                  </button>
                </>
              )}
            </div>
            {prompt !== null && (
              <div className={css.device} role="status">
                <span>{t('oauth.deviceHint').replace('{code}', prompt.userCode)}</span>
                <span className={css.hint}>{prompt.verificationUri}</span>
              </div>
            )}
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('oauth.code')}</span>
              <input
                className={css.fieldInput}
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder={t('oauth.code.placeholder')}
                value={codes[id] ?? ''}
                onChange={editCode(oauthId)}
              />
            </label>
            <div className={css.row}>
              <button type="button" className={css.secondary} disabled={busy !== null} onClick={() => { void exchange(oauthId)() }}>
                {t('oauth.exchange')}
              </button>
            </div>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('oauth.token')}</span>
              <input
                className={css.fieldInput}
                type="password"
                autoComplete="new-password"
                placeholder={t('oauth.token.placeholder')}
                value={entry.accessToken}
                onChange={editOAuth(oauthId, 'accessToken')}
              />
            </label>
            <div className={css.footer}>
              <button type="button" className={css.save} onClick={saveToken(oauthId)}>
                {t('oauth.saveToken')}
              </button>
              <span className={clsx(css.status, live && css.statusReady)} role="status">
                {live ? t('oauth.connected') : t('oauth.missing')}
              </span>
            </div>
            {error !== null && <span className={css.error} role="alert">{error}</span>}
          </section>
        )
      })}
      <div className={css.footer}>
        <button type="button" className={css.save} onClick={save}>
          {t('save')}
        </button>
        {saved && (
          <span className={css.status} role="status">
            {t('saved')}
          </span>
        )}
      </div>
    </div>
  )
}

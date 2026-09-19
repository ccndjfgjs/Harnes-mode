/** The Network page: the V2Ray tunnel, its server list, and its link imports. */
import { useCallback, useEffect, useState } from 'react'
import type { ChangeEvent } from 'react'
import { SettingsRadioOption } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { NetworkSettingsKey } from './locales.ts'
import type { V2RayServer, V2RaySettings, V2RayStatus } from './v2ray-bridge.ts'
import { bridgeErrorMessage, v2rayBridge } from './v2ray-bridge.ts'
import css from './NetworkSection.module.css'

/** Business callbacks injected into the Network section. */
export interface NetworkSectionInjected {
  /** Translate one Network key. */
  t: (key: NetworkSettingsKey) => string
}

/** Full component props: section owner share plus the injected copy face. */
export type NetworkSectionProps = PropsRuntime<'settings.section'> & NetworkSectionInjected

/** Substitute one `{name}` placeholder, the convention this project's dictionaries use. */
function fill(template: string, values: Record<string, string>): string {
  let text = template
  for (const [name, value] of Object.entries(values)) text = text.replace(`{${name}}`, value)
  return text
}

/**
 * Render the Network template.
 *
 * The tunnel belongs to the desktop shell, so the page degrades to an explanation
 * when the bridge is absent instead of offering controls that cannot work.
 *
 * @param props - section owner share plus the injected copy face.
 * @returns the section element tree.
 */
export function NetworkSection({ t }: NetworkSectionProps) {
  const bridge = v2rayBridge()
  const [settings, setSettings] = useState<V2RaySettings | null>(null)
  const [status, setStatus] = useState<V2RayStatus | null>(null)
  const [link, setLink] = useState('')
  const [subscription, setSubscription] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState(false)

  const report = useCallback((text: string, isError = false): void => {
    setMessage(text)
    setFailed(isError)
  }, [])

  const adopt = useCallback((next: V2RaySettings): void => {
    setSettings(next)
    setSubscription(next.subscriptionUrl)
  }, [])

  useEffect(() => {
    if (bridge === null) return
    let live = true
    void Promise.all([bridge.v2raySettings(), bridge.v2rayStatus()]).then(
      ([document, state]) => {
        if (!live) return
        adopt(document)
        setStatus(state)
      },
      (error: unknown) => {
        if (live) report(bridgeErrorMessage(error) ?? t('error.unknown'), true)
      },
    )
    return () => { live = false }
  }, [bridge, adopt, report, t])

  /** Run one bridge action with the shared busy/error handling. */
  const run = useCallback(async (action: () => Promise<string>): Promise<void> => {
    setBusy(true)
    try {
      report(await action())
    } catch (error) {
      report(bridgeErrorMessage(error) ?? t('error.unknown'), true)
    } finally {
      setBusy(false)
    }
  }, [report, t])

  if (bridge === null) {
    return (
      <div className={css.section}>
        <div className={css.notice}>
          <span className={css.noticeTitle}>{t('unavailable.title')}</span>
          <span className={css.noticeText}>{t('unavailable.description')}</span>
        </div>
      </div>
    )
  }

  const servers = settings?.servers ?? []
  const activeId = settings?.activeId ?? ''
  const enabled = settings?.enabled ?? false
  const running = status?.running ?? false
  // Known-missing core: say so before the button is pressed, rather than letting
  // the shell throw and surfacing an IPC failure the user cannot act on.
  const binaryReady = status?.binaryAvailable !== false

  const saveEnabled = (value: boolean): void => {
    void run(async () => {
      adopt(await bridge.v2raySave({ enabled: value }))
      return ''
    })
  }

  const connect = (): void => {
    void run(async () => {
      if (!binaryReady) return t('tunnel.noBinary')
      if (servers.length === 0) return t('tunnel.noServer')
      report(t('tunnel.connecting'))
      const started = await bridge.v2rayStart({})
      setStatus(started)
      report(t('tunnel.testing'))
      const result = await bridge.v2rayTest()
      return fill(t('tunnel.ok'), { target: result.target, ms: String(result.latencyMs) })
    })
  }

  const disconnect = (): void => {
    void run(async () => {
      setStatus(await bridge.v2rayStop())
      return t('tunnel.idle')
    })
  }

  const addLink = (): void => {
    void run(async () => {
      if (link.trim() === '') return t('servers.empty')
      const result = await bridge.v2rayImportLink(link)
      adopt(result.settings)
      setLink('')
      return fill(t('servers.added'), { count: String(result.servers.length) })
    })
  }

  const loadSubscription = (): void => {
    void run(async () => {
      if (subscription.trim() === '') return t('servers.empty')
      const result = await bridge.v2rayImportSubscription(subscription)
      adopt(result.settings)
      return fill(t('servers.loaded'), { count: String(result.servers.length) })
    })
  }

  const selectServer = (id: string): void => {
    void run(async () => {
      adopt(await bridge.v2raySelect(id))
      return ''
    })
  }

  const removeServer = (id: string): void => {
    void run(async () => {
      adopt(await bridge.v2rayRemove(id))
      return ''
    })
  }

  const serverRow = (server: V2RayServer) => (
    <div key={server.id} className={`${css.serverRow}${server.id === activeId ? ` ${css.serverRowActive}` : ''}`}>
      <input
        type="radio"
        name="network-server"
        checked={server.id === activeId}
        aria-label={server.name}
        onChange={() => { selectServer(server.id) }}
      />
      <span className={css.serverText}>
        <span className={css.serverName}>{server.name}</span>
        <span className={css.serverMeta}>
          {`${server.protocol} · ${server.host}:${server.remotePort}${server.security && server.security !== 'none' ? ` · ${server.security}` : ''}`}
        </span>
      </span>
      {server.id === activeId && <span className={css.serverBadge}>{t('servers.selected')}</span>}
      <button
        type="button"
        className={css.removeButton}
        title={t('servers.remove')}
        aria-label={t('servers.remove')}
        disabled={busy}
        onClick={() => { removeServer(server.id) }}
      >
        ×
      </button>
    </div>
  )

  const statusText = running
    ? (status?.httpPort ? `127.0.0.1:${status.httpPort}` : t('tunnel.idle'))
    : t('tunnel.idle')

  return (
    <div className={css.section}>
      <p className={css.description}>{t('description')}</p>

      <div className={css.notice}>
        <span className={css.noticeTitle}>{t('restart.title')}</span>
        <span className={css.noticeText}>{t('restart.description')}</span>
      </div>

      <section className={css.card} aria-label={t('tunnel.title')}>
        <h3 className={css.cardTitle}>{t('tunnel.title')}</h3>
        <p className={css.description}>{t('tunnel.description')}</p>
        <div className={css.options} role="radiogroup" aria-label={t('tunnel.title')}>
          <SettingsRadioOption
            name="network-enabled"
            value="on"
            label={t('tunnel.on')}
            checked={enabled}
            onSelect={() => { saveEnabled(true) }}
          />
          <SettingsRadioOption
            name="network-enabled"
            value="off"
            label={t('tunnel.off')}
            checked={!enabled}
            onSelect={() => { saveEnabled(false) }}
          />
        </div>

        <div className={css.ports}>
          <label className={css.port}>
            <span>{t('tunnel.socksPort')}</span>
            <input
              type="number"
              min={1}
              max={65535}
              value={settings?.socksPort ?? 10808}
              disabled={busy}
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                const value = Number(event.target.value)
                void run(async () => {
                  adopt(await bridge.v2raySave({ socksPort: value }))
                  return ''
                })
              }}
            />
          </label>
          <label className={css.port}>
            <span>{t('tunnel.httpPort')}</span>
            <input
              type="number"
              min={1}
              max={65535}
              value={settings?.httpPort ?? 10809}
              disabled={busy}
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                const value = Number(event.target.value)
                void run(async () => {
                  adopt(await bridge.v2raySave({ httpPort: value }))
                  return ''
                })
              }}
            />
          </label>
        </div>
        <p className={css.description}>{t('tunnel.httpHint')}</p>

        <div className={css.actions}>
          <button type="button" className={css.button} disabled={busy || !binaryReady} onClick={connect}>
            {t('tunnel.connect')}
          </button>
          <button type="button" className={css.button} disabled={busy || !running} onClick={disconnect}>
            {t('tunnel.disconnect')}
          </button>
        </div>
        {status !== null && !status.binaryAvailable && (
          <p className={`${css.status} ${css.statusError}`}>{t('tunnel.noBinary')}</p>
        )}
        {message !== '' && (
          <p className={`${css.status}${failed ? ` ${css.statusError}` : ''}`} role="status">{message}</p>
        )}
        <p className={css.status}>{statusText}</p>
      </section>

      <section className={css.card} aria-label={t('servers.title')}>
        <h3 className={css.cardTitle}>{t('servers.title')}</h3>
        <p className={css.description}>{t('servers.description')}</p>

        <label className={css.field}>
          <span>{t('servers.linkLabel')}</span>
          <textarea
            rows={2}
            value={link}
            placeholder={t('servers.linkPlaceholder')}
            disabled={busy}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => { setLink(event.target.value) }}
          />
        </label>
        <div className={css.actions}>
          <button type="button" className={css.button} disabled={busy} onClick={addLink}>
            {t('servers.add')}
          </button>
        </div>

        <label className={css.field}>
          <span>{t('servers.subLabel')}</span>
          <input
            type="text"
            value={subscription}
            placeholder={t('servers.subPlaceholder')}
            disabled={busy}
            onChange={(event: ChangeEvent<HTMLInputElement>) => { setSubscription(event.target.value) }}
          />
        </label>
        <div className={css.actions}>
          <button type="button" className={css.button} disabled={busy} onClick={loadSubscription}>
            {t('servers.load')}
          </button>
        </div>

        {servers.length === 0
          ? <p className={css.status}>{t('servers.empty')}</p>
          : <div className={css.serverList}>{servers.map(serverRow)}</div>}
      </section>
    </div>
  )
}

/**
 * The desktop shell's V2Ray bridge.
 *
 * The tunnel is owned by the Electron main process, not by the Harness backend:
 * it has to exist *before* the backend spawns, because the backend resolves its
 * proxy from the environment once, at boot. The shell therefore exposes the
 * lifecycle over `window.harnessAPI`, and this module is the only place that
 * reaches for it.
 *
 * In a plain browser the bridge is absent — the section renders an explanation
 * instead of a broken control panel.
 */

/** One server parsed from a share link or a subscription list. */
export interface V2RayServer {
  /** Stable identity derived from the endpoint, used for selection. */
  id: string
  /** Wire protocol the link declared. */
  protocol: 'vless' | 'vmess' | 'trojan' | 'shadowsocks'
  /** Human label from the link's fragment, or host:port. */
  name: string
  /** Endpoint host. */
  host: string
  /** Endpoint port. */
  remotePort: number
  /** VLESS/VMess credential. */
  uuid?: string
  /** Trojan/Shadowsocks credential. */
  password?: string
  /** Transport the server expects. */
  transport?: string
  /** `tls`, `reality`, or `none`. */
  security?: string
}

/** The persisted tunnel document, shared by the launcher window and this page. */
export interface V2RaySettings {
  /** Whether the launcher should bring the tunnel up before spawning the backend. */
  enabled: boolean
  /** Last subscription URL, kept so the field survives a restart. */
  subscriptionUrl: string
  /** Every imported server, in list order. */
  servers: V2RayServer[]
  /** The server the tunnel uses. */
  activeId: string
  /** Local SOCKS port. */
  socksPort: number
  /** Local HTTP port — the one the Harness reads as its proxy. */
  httpPort: number
}

/** Live tunnel state. */
export interface V2RayStatus {
  /** Whether the core process is up. */
  running: boolean
  /** Local SOCKS port while running. */
  socksPort: number | null
  /** Local HTTP port while running. */
  httpPort: number | null
  /** Whether a core binary was found next to the app. */
  binaryAvailable: boolean
}

/** Result of a tunnel self-test. */
export interface V2RayTestResult {
  /** The endpoint the test tunnelled to. */
  target: string
  /** Round trip in milliseconds. */
  latencyMs: number
}

/** The bridge surface the shell exposes. */
export interface V2RayBridge {
  v2rayStatus: () => Promise<V2RayStatus>
  v2rayStart: (settings: Partial<V2RaySettings>) => Promise<V2RayStatus>
  v2rayStop: () => Promise<V2RayStatus>
  v2rayTest: () => Promise<V2RayTestResult>
  v2raySettings: () => Promise<V2RaySettings>
  v2raySave: (patch: Partial<V2RaySettings>) => Promise<V2RaySettings>
  v2rayImportLink: (text: string) => Promise<{ servers: V2RayServer[]; settings: V2RaySettings }>
  v2rayImportSubscription: (url: string) => Promise<{ servers: V2RayServer[]; settings: V2RaySettings }>
  v2raySelect: (id: string) => Promise<V2RaySettings>
  v2rayRemove: (id: string) => Promise<V2RaySettings>
}

/**
 * The shell's bridge, when this page runs inside the desktop app.
 *
 * Read defensively: the same bundle is served to a plain browser, where the
 * preload never ran and only some of these methods may exist on an older shell.
 *
 * @returns the bridge, or null when the page is not inside the desktop shell.
 */
export function v2rayBridge(): V2RayBridge | null {
  const candidate = (globalThis as { harnessAPI?: Partial<V2RayBridge> }).harnessAPI
  if (candidate === undefined) return null
  const required: (keyof V2RayBridge)[] = ['v2rayStatus', 'v2raySettings', 'v2rayImportLink']
  if (required.some(name => typeof candidate[name] !== 'function')) return null
  return candidate as V2RayBridge
}

/**
 * The text a thrown value carries, or an empty string when it carries none.
 *
 * Read structurally rather than with `instanceof`: a rejection crossing the
 * context bridge — and any error thrown from another JavaScript realm — is not an
 * instance of this realm's `Error`. Never `String(value)`, which would stringify
 * an object into `[object Object]` and re-add the very prefix the caller strips.
 *
 * @param error - the caught value.
 * @returns its message, or an empty string.
 */
function messageOf(error: unknown): string {
  if (typeof error === 'string') return error
  if (error !== null && typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return ''
}

/**
 * Turn any thrown value into text the page can show.
 *
 * A rejected `ipcRenderer.invoke` arrives wrapped by Electron — the channel name
 * and the error's own class are prefixed onto the reason the shell actually
 * threw (`Error invoking remote method 'v2ray-start': Error: <reason>`). Showing
 * that verbatim buries the one sentence the user needs, so the wrapper is
 * stripped and only the reason survives.
 *
 * Returns null when the value carries no message at all — the caller supplies the
 * translated fallback, because interface text never lives in this module.
 *
 * @param error - the caught value.
 * @returns the message, or null when there is nothing to show.
 */
export function bridgeErrorMessage(error: unknown): string | null {
  const raw = messageOf(error)
  if (raw === '') return null
  // The class prefix, the IPC wrapper, and the class prefix again — in whichever
  // order they arrived. One pass, anchored at the start.
  const wrapper = /^(?:[A-Za-z]*Error:\s*)?(?:Error invoking remote method '[^']*':\s*)?(?:[A-Za-z]*Error:\s*)?/
  const stripped = raw.replace(wrapper, '').trim()
  return stripped === '' ? raw : stripped
}

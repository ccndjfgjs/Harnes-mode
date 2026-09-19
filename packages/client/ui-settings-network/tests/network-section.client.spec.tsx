// @vitest-environment jsdom
// NetworkSection template: the desktop bridge is optional, so the page is checked
// both without it (an explanation, no dead controls) and with it (the tunnel, the
// server list, and the link imports that fill it).

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { zh } from '../src/client/locales.ts'
import type { NetworkSettingsKey } from '../src/client/locales.ts'
import { NetworkSection } from '../src/client/NetworkSection.tsx'
import type { NetworkSectionProps } from '../src/client/NetworkSection.tsx'
import type { V2RayBridge, V2RayServer, V2RaySettings } from '../src/client/v2ray-bridge.ts'
import { bridgeErrorMessage, v2rayBridge } from '../src/client/v2ray-bridge.ts'

afterEach(() => {
  cleanup()
  delete (globalThis as { harnessAPI?: unknown }).harnessAPI
})

const t = (key: NetworkSettingsKey): string => zh[key]

const VLESS: V2RayServer = {
  id: 'vless-a.example.com-443-12345678',
  protocol: 'vless',
  name: 'Первый сервер',
  host: 'a.example.com',
  remotePort: 443,
  security: 'tls',
}

const TROJAN: V2RayServer = {
  id: 'trojan-b.example.com-443-87654321',
  protocol: 'trojan',
  name: 'Второй сервер',
  host: 'b.example.com',
  remotePort: 443,
  security: 'tls',
}

function settingsWith(servers: V2RayServer[]): V2RaySettings {
  return {
    enabled: true,
    subscriptionUrl: '',
    servers,
    activeId: servers[0]?.id ?? '',
    socksPort: 10808,
    httpPort: 10809,
  }
}

function fakeBridge(overrides: Partial<V2RayBridge> = {}): V2RayBridge {
  return {
    v2rayStatus: vi.fn(async () => ({ running: false, socksPort: null, httpPort: null, binaryAvailable: true })),
    v2rayStart: vi.fn(async () => ({ running: true, socksPort: 10808, httpPort: 10809, binaryAvailable: true })),
    v2rayStop: vi.fn(async () => ({ running: false, socksPort: null, httpPort: null, binaryAvailable: true })),
    v2rayTest: vi.fn(async () => ({ target: 'api.ipify.org:443', latencyMs: 42 })),
    v2raySettings: vi.fn(async () => settingsWith([VLESS])),
    v2raySave: vi.fn(async () => settingsWith([VLESS])),
    v2rayImportLink: vi.fn(async () => ({ servers: [VLESS, TROJAN], settings: settingsWith([VLESS, TROJAN]) })),
    v2rayImportSubscription: vi.fn(async () => ({ servers: [VLESS, TROJAN], settings: settingsWith([VLESS, TROJAN]) })),
    v2raySelect: vi.fn(async () => settingsWith([VLESS, TROJAN])),
    v2rayRemove: vi.fn(async () => settingsWith([])),
    ...overrides,
  }
}

function install(bridge: Partial<V2RayBridge>): V2RayBridge {
  const complete = fakeBridge(bridge)
  ;(globalThis as { harnessAPI?: unknown }).harnessAPI = complete
  return complete
}

function renderSection() {
  return render(<NetworkSection {...{ t } as unknown as NetworkSectionProps} />)
}

describe('v2rayBridge', () => {
  it('is absent in a plain browser', () => {
    expect(v2rayBridge()).toBeNull()
  })

  it('is refused when the shell exposes only part of the surface', () => {
    ;(globalThis as { harnessAPI?: unknown }).harnessAPI = { v2rayStatus: () => {} }
    expect(v2rayBridge()).toBeNull()
  })

  it('is returned when the shell exposes the required methods', () => {
    install({})
    expect(v2rayBridge()).not.toBeNull()
  })
})

describe('NetworkSection without the desktop shell', () => {
  it('explains itself instead of offering controls that cannot work', () => {
    const view = renderSection()
    expect(view.getByText(zh['unavailable.title'])).toBeTruthy()
    expect(view.queryByText(zh['tunnel.title'])).toBeNull()
  })
})

describe('NetworkSection inside the desktop shell', () => {
  it('shows the saved servers and which one is in use', async () => {
    install({ v2raySettings: vi.fn(async () => settingsWith([VLESS, TROJAN])) })
    const view = renderSection()
    await waitFor(() => { expect(view.getByText('Первый сервер')).toBeTruthy() })
    expect(view.getByText('Второй сервер')).toBeTruthy()
    expect(view.getByText(zh['servers.selected'])).toBeTruthy()
  })

  it('warns that the app has to be restarted for the proxy to take effect', async () => {
    install({})
    const view = renderSection()
    expect(view.getByText(zh['restart.title'])).toBeTruthy()
  })

  it('adds a pasted link and reports how many servers arrived', async () => {
    const bridge = install({})
    const view = renderSection()
    await waitFor(() => { expect(bridge.v2raySettings).toHaveBeenCalled() })
    const field = view.getByLabelText(zh['servers.linkLabel'])
    act(() => { fireEvent.change(field, { target: { value: 'vless://x@a.example.com:443#Тест' } }) })
    act(() => { fireEvent.click(view.getByText(zh['servers.add'])) })
    await waitFor(() => {
      expect(bridge.v2rayImportLink).toHaveBeenCalledWith('vless://x@a.example.com:443#Тест')
    })
    await waitFor(() => {
      expect(view.getByRole('status').textContent).toBe(zh['servers.added'].replace('{count}', '2'))
    })
    expect(view.getByText('Второй сервер')).toBeTruthy()
  })

  it('loads a subscription and reports the count', async () => {
    const bridge = install({})
    const view = renderSection()
    await waitFor(() => { expect(bridge.v2raySettings).toHaveBeenCalled() })
    const field = view.getByLabelText(zh['servers.subLabel'])
    act(() => { fireEvent.change(field, { target: { value: 'https://example.com/sub' } }) })
    act(() => { fireEvent.click(view.getByText(zh['servers.load'])) })
    await waitFor(() => {
      expect(bridge.v2rayImportSubscription).toHaveBeenCalledWith('https://example.com/sub')
    })
    await waitFor(() => {
      expect(view.getByRole('status').textContent).toBe(zh['servers.loaded'].replace('{count}', '2'))
    })
  })

  it('reports a bridge failure verbatim rather than swallowing it', async () => {
    install({ v2rayImportLink: vi.fn(async () => { throw new Error('Ссылка не распознана') }) })
    const view = renderSection()
    await waitFor(() => { expect(view.getByText(zh['tunnel.title'])).toBeTruthy() })
    const field = view.getByLabelText(zh['servers.linkLabel'])
    act(() => { fireEvent.change(field, { target: { value: 'мусор' } }) })
    act(() => { fireEvent.click(view.getByText(zh['servers.add'])) })
    await waitFor(() => { expect(view.getByRole('status').textContent).toBe('Ссылка не распознана') })
  })

  it('connects, checks the tunnel and reports the round trip', async () => {
    const bridge = install({})
    const view = renderSection()
    await waitFor(() => { expect(bridge.v2raySettings).toHaveBeenCalled() })
    act(() => { fireEvent.click(view.getByText(zh['tunnel.connect'])) })
    await waitFor(() => {
      expect(view.getByRole('status').textContent)
        .toBe(zh['tunnel.ok'].replace('{target}', 'api.ipify.org:443').replace('{ms}', '42'))
    })
    expect(bridge.v2rayTest).toHaveBeenCalled()
  })

  it('says so when no core binary is present', async () => {
    install({
      v2rayStatus: vi.fn(async () => ({ running: false, socksPort: null, httpPort: null, binaryAvailable: false })),
    })
    const view = renderSection()
    await waitFor(() => { expect(view.getByText(zh['tunnel.noBinary'])).toBeTruthy() })
  })

  it('refuses to start a tunnel it knows cannot run, instead of letting the shell throw', async () => {
    const bridge = install({
      v2rayStatus: vi.fn(async () => ({ running: false, socksPort: null, httpPort: null, binaryAvailable: false })),
    })
    const view = renderSection()
    await waitFor(() => { expect(view.getByText(zh['tunnel.noBinary'])).toBeTruthy() })

    const button = view.getByText(zh['tunnel.connect']) as HTMLButtonElement
    expect(button.disabled).toBe(true)

    // A disabled button can still be reached by keyboard or by a stale render, so the
    // action itself must hold the line rather than relying on the attribute alone.
    act(() => { fireEvent.click(button) })
    await waitFor(() => { expect(bridge.v2rayStart).not.toHaveBeenCalled() })
  })
})

describe('bridgeErrorMessage', () => {
  it('shows the shell\'s reason without Electron\'s IPC wrapper', () => {
    const wrapped = new Error(
      "Error invoking remote method 'v2ray-start': Error: V2Ray не найден. Поместите v2ray.exe в installer/resources/v2ray",
    )
    expect(bridgeErrorMessage(wrapped)).toBe('V2Ray не найден. Поместите v2ray.exe в installer/resources/v2ray')
  })

  it('keeps a plain message as it is', () => {
    expect(bridgeErrorMessage(new Error('Ссылка не распознана'))).toBe('Ссылка не распознана')
  })

  it('reads a rejection from another JavaScript context, which is not an Error here', () => {
    // An error crossing the context bridge (and one thrown from a test) is not an
    // instance of this realm's Error, so `String(value)` would re-add the prefix.
    expect(bridgeErrorMessage({ name: 'Error', message: "Error invoking remote method 'v2ray-start': Error: V2Ray не найден" }))
      .toBe('V2Ray не найден')
    expect(bridgeErrorMessage("Error invoking remote method 'v2ray-test': Error: туннель не отвечает"))
      .toBe('туннель не отвечает')
  })

  it('returns null when there is nothing to show', () => {
    expect(bridgeErrorMessage(new Error(''))).toBeNull()
  })
})

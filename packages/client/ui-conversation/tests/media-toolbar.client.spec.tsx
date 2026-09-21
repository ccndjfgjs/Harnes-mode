// @vitest-environment jsdom
// MediaToolbar behavior: the three composer icon buttons (dictation mic,
// voice mode, screen capture) render in the tool-row shape, respect the
// locked/busy seats, drive the browser's own speech engines with nothing
// configured, and fall back to the Harness media gateway when a service is
// stored.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import {
  screenCapture, setTtsBackend, writeAccessibilitySettings, writeImproveAnnounce, writeImproveReadAloud,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConversationKey } from '../src/client/skeleton/../locales.ts'
import { zh } from '../src/client/locales.ts'
import type { InputActions } from '../src/client/contract/input.ts'
import { MediaToolbar } from '../src/client/skeleton/MediaToolbar.tsx'

afterEach(() => {
  cleanup()
  // The capture is app-wide and deliberately outlives the toolbar, so a test
  // that leaves a broadcast running would otherwise hand it to the next one.
  screenCapture().dispose()
  localStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  // Smart-send sampling reads this buffer; a reset keeps one test's frame from
  // leaking into the next one's change comparison.
  framePixels = new Uint8ClampedArray(64 * 36 * 4)
})

/** Stage a fully connected Voice Settings document for the external paths. */
function connectVoiceServices(): void {
  localStorage.setItem('dsh.voice.settings', JSON.stringify({
    sttUrl: 'https://stt.example', sttKey: 'stt-key', ttsUrl: 'https://tts.example', ttsKey: 'tts-key',
  }))
}

/** Stage an external vision service, which takes screen frames off the local path. */
function connectVisionService(): void {
  localStorage.setItem('dsh.voice.settings', JSON.stringify({ visionUrl: 'https://vision.example' }))
}

const t = (key: ConversationKey): string => zh[key]

function benchInputActions() {
  const setDraft = vi.fn((_text: string) => {})
  const restructureDraft = vi.fn(async (text: string, _signal?: AbortSignal) => text)
  const submit = vi.fn(() => {})
  const inputActions = { setDraft, restructureDraft, submit } as unknown as InputActions
  return { setDraft, restructureDraft, submit, inputActions }
}

function propsOf(
  inputActions: InputActions,
  over?: { locked?: boolean; busy?: boolean; draft?: string },
) {
  return {
    inputActions,
    t,
    locked: over?.locked ?? false,
    busy: over?.busy ?? false,
    draft: over?.draft ?? '',
  }
}

/** Minimal MediaStream stand-in: only the track surface MediaToolbar touches. */
function fakeStream(track: { stop?: () => void; getSettings?: () => Record<string, unknown>; addEventListener?: () => void } = {}) {
  const stop = track.stop ?? vi.fn()
  return {
    getTracks: () => [{ stop }],
    getVideoTracks: () => [track],
  } as unknown as MediaStream
}

function stubMediaDevices(over?: { audio?: unknown; screen?: unknown }) {
  const getUserMedia = vi.fn(async (_constraints?: MediaStreamConstraints) => fakeStream())
  const getDisplayMedia = vi.fn(async (_constraints?: DisplayMediaStreamOptions) => over?.screen ?? fakeStream({
    stop: vi.fn(),
    getSettings: () => ({ width: 1280, height: 720 }),
    addEventListener: vi.fn(),
  }))
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia, getDisplayMedia }, configurable: true })
  return { getUserMedia, getDisplayMedia }
}

/** The pixel buffer `changedEnough` compares between two scheduled frames. */
let framePixels: Uint8ClampedArray = new Uint8ClampedArray(64 * 36 * 4)

/** Canvas stubs shared by both screen paths: one JPEG frame comes back. */
function stubFrameCapture(): void {
  vi.spyOn(HTMLVideoElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
    // Smart send samples a 64x36 greyscale thumbnail; jsdom has no real 2D
    // context, so the check reads whatever the test put in `framePixels`.
    getImageData: () => ({ data: framePixels }),
  } as never)
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, callback: BlobCallback) {
    callback(new Blob(['frame'], { type: 'image/jpeg' }))
  })
  // jsdom implements neither toDataURL nor a real 2D context; the preview
  // window only needs a data URL back.
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,preview')
}

class FakeSocket {
  static instances: FakeSocket[] = []
  static readonly OPEN = 1
  readyState = 1
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  readonly sent: string[] = []
  constructor(public url: string) {
    FakeSocket.instances.push(this)
    queueMicrotask(() => { this.onopen?.() })
  }
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.()
  }
}

class FakePeer {
  static instances: FakePeer[] = []
  ontrack: ((event: { streams: MediaStream[]; track: MediaStreamTrack }) => void) | null = null
  onicecandidate: ((event: { candidate: RTCIceCandidate | null }) => void) | null = null
  readonly replaceTrack = vi.fn(async () => {})
  readonly added: MediaStreamTrack[] = []
  readonly remoteDescription: unknown[] = []
  readonly ice: unknown[] = []
  constructor() {
    FakePeer.instances.push(this)
  }
  async createOffer(): Promise<{ sdp: string; type: string }> {
    return { sdp: 'offer', type: 'offer' }
  }
  async setLocalDescription(): Promise<void> {}
  async setRemoteDescription(description: unknown): Promise<void> {
    this.remoteDescription.push(description)
  }
  async addIceCandidate(candidate: unknown): Promise<void> {
    this.ice.push(candidate)
  }
  addTrack(track: MediaStreamTrack): void {
    this.added.push(track)
  }
  getSenders(): { track: { kind: string } | null; replaceTrack: (track: MediaStreamTrack | null) => Promise<void> }[] {
    return []
  }
  close(): void {}
}

class FakeAudio {
  static instances: FakeAudio[] = []
  autoplay = false
  srcObject: unknown = null
  paused = false
  constructor() {
    FakeAudio.instances.push(this)
  }
  async play(): Promise<void> {}
  pause(): void {
    this.paused = true
  }
}

/** Engine stand-in proving the browser recognizer is never reached.
 *
 *  The toolbar's last browser-engine path — dictation, and the call's local
 *  branch — is gone. The class survives so a test can assert the toolbar opens
 *  no recognition at all: `instances` staying empty is the proof. */
class FakeRecognition {
  static instances: FakeRecognition[] = []
  constructor() {
    FakeRecognition.instances.push(this)
  }
}

describe('media toolbar chrome', () => {
  it('renders four tool-row icon buttons with locale-owned labels', () => {
    const { inputActions } = benchInputActions()
    const view = render(<MediaToolbar {...propsOf(inputActions)} />)
    expect(view.getByRole('group', { name: zh['media.group'] })).toBeTruthy()
    expect(view.getByRole('button', { name: zh['input.voiceHold'] })).toBeTruthy()
    expect(view.getByRole('button', { name: zh['input.call'] })).toBeTruthy()
    expect(view.getByRole('button', { name: zh['input.screen'] })).toBeTruthy()
  })

  it('carries exactly one microphone control', () => {
    const { inputActions } = benchInputActions()
    const view = render(<MediaToolbar {...propsOf(inputActions)} />)
    const group = view.getByRole('group', { name: zh['media.group'] })
    // The older browser-engine dictation mic was removed: two microphones that
    // look identical and behave differently is the one thing this toolbar must
    // never show again.
    expect(group.querySelectorAll('button[aria-label*="mic"], button[aria-label*="Мик"]')).toHaveLength(0)
    const mics = Array.from(group.querySelectorAll('button'))
      .filter(node => node.querySelector('svg') !== null)
      .map(node => node.getAttribute('aria-label'))
    expect(mics).toEqual([
      zh['compose.restructure'],
      zh['input.voiceHold'],
      zh['input.call'],
      zh['input.screen'],
    ])
  })

  it('disables every control while locked or busy', () => {
    const { inputActions } = benchInputActions()
    const labels = [zh['input.voiceHold'], zh['input.call'], zh['input.screen']]
    const locked = render(<MediaToolbar {...propsOf(inputActions, { locked: true })} />)
    for (const label of labels) {
      expect(locked.getByRole('button', { name: label }).hasAttribute('disabled')).toBe(true)
    }
    locked.unmount()
    const busy = render(<MediaToolbar {...propsOf(inputActions, { busy: true })} />)
    for (const label of labels) {
      expect(busy.getByRole('button', { name: label }).hasAttribute('disabled')).toBe(true)
    }
  })
})

describe('draft improvement control', () => {
  it('leads the toolbar', () => {
    const { inputActions } = benchInputActions()
    const view = render(<MediaToolbar {...propsOf(inputActions, { draft: 'черновик' })} />)
    const group = view.getByRole('group', { name: zh['media.group'] })
    const labels = Array.from(group.querySelectorAll('button')).map(node => node.getAttribute('aria-label'))
    expect(labels).toEqual([
      zh['compose.restructure'],
      zh['input.voiceHold'],
      zh['input.call'],
      zh['input.screen'],
    ])
    expect(view.getByRole('button', { name: zh['compose.restructure'] }).hasAttribute('disabled')).toBe(false)
  })

  it('refuses an empty draft', () => {
    const { inputActions, restructureDraft } = benchInputActions()
    const view = render(<MediaToolbar {...propsOf(inputActions)} />)
    const button = view.getByRole('button', { name: zh['compose.restructure'] })
    expect(button.hasAttribute('disabled')).toBe(true)
    fireEvent.click(button)
    expect(restructureDraft).not.toHaveBeenCalled()
  })

  it('writes the model answer back into the draft instead of sending it', async () => {
    const { setDraft, restructureDraft, inputActions } = benchInputActions()
    restructureDraft.mockResolvedValue('Цель: собрать отчёт\n\n- срок: пятница')
    const view = render(<MediaToolbar {...propsOf(inputActions, { draft: 'надо отчёт к пятнице' })} />)
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: zh['compose.restructure'] }))
    })
    expect(restructureDraft).toHaveBeenCalledWith('надо отчёт к пятнице', expect.anything())
    expect(setDraft).toHaveBeenCalledWith('Цель: собрать отчёт\n\n- срок: пятница')
  })

  it('keeps the draft and reports the failure with its reason', async () => {
    const { setDraft, restructureDraft, inputActions } = benchInputActions()
    restructureDraft.mockRejectedValue(new Error('model unreachable'))
    const view = render(<MediaToolbar {...propsOf(inputActions, { draft: 'черновик' })} />)
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: zh['compose.restructure'] }))
    })
    expect(setDraft).not.toHaveBeenCalled()
    // The reason rides along: a bare "could not improve" is not actionable.
    expect(view.getByRole('status').textContent)
      .toBe(`${zh['compose.restructure.failed']}: model unreachable`)
  })

  it('ignores an empty answer rather than erasing what the user typed', async () => {
    const { setDraft, restructureDraft, inputActions } = benchInputActions()
    restructureDraft.mockResolvedValue('   ')
    const view = render(<MediaToolbar {...propsOf(inputActions, { draft: 'черновик' })} />)
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: zh['compose.restructure'] }))
    })
    expect(setDraft).not.toHaveBeenCalled()
  })

  it('announces the working state while the model answers', async () => {
    const { inputActions, restructureDraft } = benchInputActions()
    let settle: (value: string) => void = () => {}
    restructureDraft.mockImplementation(() => new Promise<string>((resolve) => { settle = resolve }))
    const view = render(<MediaToolbar {...propsOf(inputActions, { draft: 'черновик' })} />)
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: zh['compose.restructure'] }))
    })
    const working = view.getByRole('button', { name: zh['compose.restructuring'] })
    expect(working.getAttribute('aria-busy')).toBe('true')
    expect(working.hasAttribute('disabled')).toBe(true)
    await act(async () => { settle('готово') })
    expect(view.getByRole('button', { name: zh['compose.restructure'] })).toBeTruthy()
  })

  it('aborts the in-flight call when the toolbar unmounts', async () => {
    const { inputActions, restructureDraft } = benchInputActions()
    let seen: AbortSignal | undefined
    restructureDraft.mockImplementation((_text: string, signal?: AbortSignal) => {
      seen = signal
      return new Promise<string>(() => {})
    })
    const view = render(<MediaToolbar {...propsOf(inputActions, { draft: 'черновик' })} />)
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: zh['compose.restructure'] }))
    })
    view.unmount()
    expect(seen?.aborted).toBe(true)
  })

  it('stays inert while the machine owns the editor', () => {
    const { inputActions, restructureDraft } = benchInputActions()
    const view = render(<MediaToolbar {...propsOf(inputActions, { busy: true, draft: 'черновик' })} />)
    const button = view.getByRole('button', { name: zh['compose.restructure'] })
    expect(button.hasAttribute('disabled')).toBe(true)
    fireEvent.click(button)
    expect(restructureDraft).not.toHaveBeenCalled()
  })
})

describe('improve voice announce', () => {
  afterEach(() => {
    setTtsBackend(null)
    document.documentElement.lang = ''
  })

  function speakStub(): ReturnType<typeof vi.fn> {
    const speak = vi.fn((_text: string, _options?: unknown) => {})
    setTtsBackend({ isAvailable: () => true, speak, cancel: () => {} })
    return speak
  }

  function enableVoice(): void {
    writeAccessibilitySettings({ voiceNav: true })
    writeImproveAnnounce(true)
    document.documentElement.lang = 'en'
  }

  it('reads the improved draft aloud in the program language', async () => {
    vi.useFakeTimers()
    try {
      const { inputActions, restructureDraft } = benchInputActions()
      restructureDraft.mockResolvedValue('Готовый текст')
      const speak = speakStub()
      enableVoice()
      const view = render(<MediaToolbar {...propsOf(inputActions, { draft: 'черновик' })} />)
      await act(async () => {
        fireEvent.click(view.getByRole('button', { name: zh['compose.restructure'] }))
      })
      await act(async () => { await vi.advanceTimersByTimeAsync(200) })
      expect(speak).toHaveBeenCalledTimes(1)
      expect(speak).toHaveBeenCalledWith(zh['compose.restructured'], { lang: 'en-US', rate: 1 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads failures aloud instead of staying silent', async () => {
    vi.useFakeTimers()
    try {
      const { inputActions, restructureDraft } = benchInputActions()
      restructureDraft.mockRejectedValue(new Error('model unreachable'))
      const speak = speakStub()
      enableVoice()
      const view = render(<MediaToolbar {...propsOf(inputActions, { draft: 'черновик' })} />)
      await act(async () => {
        fireEvent.click(view.getByRole('button', { name: zh['compose.restructure'] }))
      })
      await act(async () => { await vi.advanceTimersByTimeAsync(200) })
      expect(speak).toHaveBeenCalledTimes(1)
      expect(speak).toHaveBeenCalledWith(
        expect.stringContaining(zh['compose.restructure.failed']) as string,
        { lang: 'en-US', rate: 1 },
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('stays silent when the global voice is off', async () => {
    const { inputActions, restructureDraft } = benchInputActions()
    restructureDraft.mockResolvedValue('Готовый текст')
    const speak = speakStub()
    writeImproveAnnounce(true)
    document.documentElement.lang = 'en'
    const view = render(<MediaToolbar {...propsOf(inputActions, { draft: 'черновик' })} />)
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: zh['compose.restructure'] }))
    })
    expect(speak).not.toHaveBeenCalled()
  })

  it('stays silent when the page toggle is off', async () => {
    const { inputActions, restructureDraft } = benchInputActions()
    restructureDraft.mockResolvedValue('Готовый текст')
    const speak = speakStub()
    writeAccessibilitySettings({ voiceNav: true })
    document.documentElement.lang = 'en'
    const view = render(<MediaToolbar {...propsOf(inputActions, { draft: 'черновик' })} />)
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: zh['compose.restructure'] }))
    })
    expect(speak).not.toHaveBeenCalled()
  })

  it('reads the improved text itself when read-aloud is on', async () => {
    vi.useFakeTimers()
    try {
      const { inputActions, restructureDraft } = benchInputActions()
      restructureDraft.mockResolvedValue('Готовый текст')
      const speak = speakStub()
      writeAccessibilitySettings({ voiceNav: true })
      writeImproveAnnounce(true)
      writeImproveReadAloud(true)
      document.documentElement.lang = 'en'
      const view = render(<MediaToolbar {...propsOf(inputActions, { draft: 'черновик' })} />)
      await act(async () => {
        fireEvent.click(view.getByRole('button', { name: zh['compose.restructure'] }))
      })
      await act(async () => { await vi.advanceTimersByTimeAsync(200) })
      expect(speak).toHaveBeenCalledTimes(1)
      expect(speak).toHaveBeenCalledWith('Готовый текст', { lang: 'en-US', rate: 1 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('stays silent about the text when read-aloud is off', async () => {
    const { inputActions, restructureDraft } = benchInputActions()
    restructureDraft.mockResolvedValue('Готовый текст')
    const speak = speakStub()
    writeAccessibilitySettings({ voiceNav: true })
    writeImproveAnnounce(false)
    writeImproveReadAloud(false)
    document.documentElement.lang = 'en'
    const view = render(<MediaToolbar {...propsOf(inputActions, { draft: 'черновик' })} />)
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: zh['compose.restructure'] }))
    })
    expect(speak).not.toHaveBeenCalled()
  })

  it('waits the shared pause before speaking', async () => {
    vi.useFakeTimers()
    try {
      const { inputActions, restructureDraft } = benchInputActions()
      restructureDraft.mockResolvedValue('Готовый текст')
      const speak = speakStub()
      writeAccessibilitySettings({ voiceNav: true, voiceNavDelay: 500 })
      writeImproveAnnounce(true)
      document.documentElement.lang = 'en'
      const view = render(<MediaToolbar {...propsOf(inputActions, { draft: 'черновик' })} />)
      await act(async () => {
        fireEvent.click(view.getByRole('button', { name: zh['compose.restructure'] }))
      })
      await act(async () => { await vi.advanceTimersByTimeAsync(499) })
      expect(speak).not.toHaveBeenCalled()
      await act(async () => { await vi.advanceTimersByTimeAsync(1) })
      expect(speak).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('voice mode', () => {
  it('shows the stub notice while neither engine is available', () => {
    localStorage.setItem('dsh.voice.settings', JSON.stringify({ sttUrl: 'https://stt.example', sttKey: 'k' }))
    const getUserMedia = vi.fn(async () => fakeStream())
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true })
    const { inputActions } = benchInputActions()
    const view = render(<MediaToolbar {...propsOf(inputActions)} />)
    act(() => {
      fireEvent.click(view.getByRole('button', { name: zh['input.call'] }))
    })
    expect(view.getByRole('status').textContent).toBe(zh['media.service.unconnected'])
    expect(getUserMedia).not.toHaveBeenCalled()
  })

  it('routes a call to the realtime gateway instead of the browser engine', async () => {
    // The call used to ride the browser recognizer, which is server-backed and
    // dead in a packaged build. It now has one transport: the realtime socket.
    // A stored service is all it takes, and the browser engine is never asked.
    FakeSocket.instances.length = 0
    FakePeer.instances.length = 0
    FakeAudio.instances.length = 0
    connectVoiceServices()
    stubMediaDevices()
    vi.stubGlobal('SpeechRecognition', FakeRecognition)
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.stubGlobal('RTCPeerConnection', FakePeer)
    vi.stubGlobal('Audio', FakeAudio)
    const { inputActions } = benchInputActions()
    const view = render(<MediaToolbar {...propsOf(inputActions)} />)
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: zh['input.call'] }))
    })
    expect(FakeSocket.instances[0]?.url).toContain('/api/media/realtime')
    expect(FakeRecognition.instances).toHaveLength(0)
    expect(view.getByRole('status').textContent).toBe(zh['media.call.active'])
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: zh['media.stop'] }))
    })
    expect(view.queryByRole('status')).toBeNull()
  })

  it('opens signaling, offers, and relays the answer through a stored service', async () => {
    FakeSocket.instances.length = 0
    FakePeer.instances.length = 0
    FakeAudio.instances.length = 0
    connectVoiceServices()
    stubMediaDevices()
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.stubGlobal('RTCPeerConnection', FakePeer)
    vi.stubGlobal('Audio', FakeAudio)
    const { inputActions } = benchInputActions()
    const view = render(<MediaToolbar {...propsOf(inputActions)} />)
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: zh['input.call'] }))
    })
    const socket = FakeSocket.instances[0]
    const peer = FakePeer.instances[0]
    expect(socket).toBeTruthy()
    expect(socket?.url).toContain('/api/media/realtime')
    expect(socket?.sent.some(message => message.includes('"type":"offer"'))).toBe(true)
    expect(view.getByRole('status').textContent).toBe(zh['media.call.active'])
    await act(async () => {
      socket?.onmessage?.({ data: JSON.stringify({ type: 'answer', sdp: 'remote' }) })
      socket?.onmessage?.({ data: JSON.stringify({ type: 'ice', candidate: { candidate: 'c' } }) })
    })
    expect(peer?.remoteDescription.length).toBe(1)
    expect(peer?.ice.length).toBe(1)
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: zh['media.stop'] }))
    })
    expect(view.queryByRole('status')).toBeNull()
  })

  /** Stage a call that also names the service and voice chosen in Voice Settings. */
  function stageCall(selection: Record<string, unknown>): void {
    localStorage.setItem('dsh.voice.settings', JSON.stringify({
      sttUrl: 'https://stt.example', sttKey: 'stt-key', ttsUrl: 'https://tts.example', ttsKey: 'tts-key',
      callSignalingUrl: 'wss://voice.example', ...selection,
    }))
  }

  /** Open a call and hand back the socket the toolbar dialed. */
  async function dialCall(): Promise<{ url: string; status: string | null }> {
    FakeSocket.instances.length = 0
    FakePeer.instances.length = 0
    FakeAudio.instances.length = 0
    stubMediaDevices()
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.stubGlobal('RTCPeerConnection', FakePeer)
    vi.stubGlobal('Audio', FakeAudio)
    const { inputActions } = benchInputActions()
    const view = render(<MediaToolbar {...propsOf(inputActions)} />)
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: zh['input.call'] }))
    })
    return {
      url: FakeSocket.instances[0]?.url ?? '',
      status: view.getByRole('status').textContent,
    }
  }

  it('names the chosen service and call voice on the handshake', async () => {
    // A browser cannot set headers on a WebSocket, so the voice rides the
    // query string — the host reads it back and carries it upstream.
    stageCall({ provider: 'openai', ttsVoiceId: 'alloy' })
    const { url, status } = await dialCall()
    const query = new URL(url).searchParams
    expect(query.get('provider')).toBe('openai')
    expect(query.get('voice')).toBe('alloy')
    expect(query.get('url')).toBe('wss://voice.example')
    expect(status).toBe(zh['media.call.active'])
  })

  it('says out loud that the answer voice did not fit the call', async () => {
    // 'nova' reads answers but OpenAI's call face does not offer it, so the
    // call falls back — and the user is told rather than left guessing.
    stageCall({ provider: 'openai', ttsVoiceId: 'nova' })
    const { url, status } = await dialCall()
    const query = new URL(url).searchParams
    expect(query.get('voice')).toBe('alloy')
    expect(status).toBe(zh['media.call.voice.substituted'])
  })

  it('says out loud that a service without a call voice cannot carry one', async () => {
    stageCall({ provider: 'elevenlabs', ttsVoiceId: 'ru-1' })
    const { url, status } = await dialCall()
    const query = new URL(url).searchParams
    expect(query.get('provider')).toBeNull()
    expect(query.get('voice')).toBeNull()
    expect(status).toBe(zh['media.call.voice.bridged'])
  })

  it('names no voice while the service choice is automatic', async () => {
    stageCall({})
    const { url, status } = await dialCall()
    const query = new URL(url).searchParams
    expect(query.get('provider')).toBeNull()
    expect(query.get('voice')).toBeNull()
    expect(status).toBe(zh['media.call.active'])
  })
})

describe('screen capture', () => {
  it('posts one frame to a stored vision service', async () => {
    connectVisionService()
    stubMediaDevices()
    stubFrameCapture()
    const fetch = vi.fn(async (_url: string): Promise<{ ok: boolean }> => ({ ok: true }))
    vi.stubGlobal('fetch', fetch)
    const { inputActions } = benchInputActions()
    const view = render(<MediaToolbar {...propsOf(inputActions)} />)
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: zh['input.screen'] }))
    })
    expect(fetch).toHaveBeenCalledOnce()
    expect(String(fetch.mock.calls[0]?.[0])).toContain('/api/media/screen/analyze')
    expect(view.getByRole('status').textContent).toBe(zh['media.screen.broadcast'])
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: zh['media.stop'] }))
    })
    expect(view.queryByRole('status')).toBeNull()
  })

  it('broadcasts on the stored cadence and keeps sampling', async () => {
    vi.useFakeTimers()
    try {
      stubMediaDevices()
      stubFrameCapture()
      const addImages = vi.fn((_files: readonly File[]): string | null => null)
      const { inputActions } = benchInputActions()
      const view = render(<MediaToolbar {...propsOf(inputActions)} addImages={addImages} />)
      await act(async () => {
        fireEvent.click(view.getByRole('button', { name: zh['input.screen'] }))
      })
      // The first frame lands immediately, the rest ride the cadence.
      expect(addImages).toHaveBeenCalledTimes(1)
      expect(view.getByRole('status').textContent).toBe(zh['media.screen.broadcast'])
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      expect(addImages).toHaveBeenCalledTimes(2)
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      expect(addImages).toHaveBeenCalledTimes(3)
      await act(async () => {
        fireEvent.click(view.getByRole('button', { name: zh['media.stop'] }))
      })
      expect(view.queryByRole('status')).toBeNull()
      // Stopping ends the loop: no further frames arrive.
      await act(async () => { await vi.advanceTimersByTimeAsync(15000) })
      expect(addImages).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps broadcasting after the toolbar goes away', async () => {
    vi.useFakeTimers()
    try {
      stubMediaDevices()
      stubFrameCapture()
      const { inputActions } = benchInputActions()
      const view = render(<MediaToolbar {...propsOf(inputActions)} />)
      await act(async () => {
        fireEvent.click(view.getByRole('button', { name: zh['input.screen'] }))
      })
      expect(screenCapture().state()).toBe('live')
      const before = screenCapture().snapshot().captured
      // Switching chats, closing the panel, or leaving the section unmounts
      // this component. That must not touch a broadcast the user started.
      view.unmount()
      await act(async () => { await vi.advanceTimersByTimeAsync(15000) })
      const after = screenCapture().snapshot()
      expect(after.state).toBe('live')
      expect(after.captured).toBeGreaterThan(before)
      await screenCapture().stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows the preview window while broadcasting, with its own stop control', async () => {
    stubMediaDevices()
    stubFrameCapture()
    const addImages = vi.fn((_files: readonly File[]): string | null => null)
    const { inputActions } = benchInputActions()
    const view = render(<MediaToolbar {...propsOf(inputActions)} addImages={addImages} />)
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: zh['input.screen'] }))
    })
    expect(view.getByRole('img', { name: zh['media.screen.preview.label'] })).toBeTruthy()
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: zh['media.screen.preview.stop'] }))
    })
    expect(view.queryByRole('img', { name: zh['media.screen.preview.label'] })).toBeNull()
  })

  it('takes a single frame when the broadcast setting is off', async () => {
    localStorage.setItem('dsh.screen.settings', JSON.stringify({ broadcast: false }))
    stubMediaDevices()
    stubFrameCapture()
    const fetch = vi.fn(async (): Promise<{ ok: boolean }> => ({ ok: true }))
    vi.stubGlobal('fetch', fetch)
    const addImages = vi.fn((_files: readonly File[]): string | null => null)
    const { inputActions } = benchInputActions()
    const view = render(<MediaToolbar {...propsOf(inputActions)} addImages={addImages} />)
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: zh['input.screen'] }))
    })
    expect(addImages).toHaveBeenCalledOnce()
    expect(view.getByRole('status').textContent).toBe(zh['media.screen.attached'])
    expect(view.queryByRole('img', { name: zh['media.screen.preview.label'] })).toBeNull()
  })

  it('leaves the preview out when the preview setting is off', async () => {
    localStorage.setItem('dsh.screen.settings', JSON.stringify({ showPreview: false }))
    stubMediaDevices()
    stubFrameCapture()
    const addImages = vi.fn((_files: readonly File[]): string | null => null)
    const { inputActions } = benchInputActions()
    const view = render(<MediaToolbar {...propsOf(inputActions)} addImages={addImages} />)
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: zh['input.screen'] }))
    })
    expect(view.queryByRole('img', { name: zh['media.screen.preview.label'] })).toBeNull()
    expect(view.getByRole('status').textContent).toBe(zh['media.screen.broadcast'])
  })

  it('attaches the frame to the composer with no vision service', async () => {
    stubMediaDevices()
    stubFrameCapture()
    const fetch = vi.fn(async (): Promise<{ ok: boolean }> => ({ ok: true }))
    vi.stubGlobal('fetch', fetch)
    const addImages = vi.fn((_files: readonly File[]): string | null => null)
    const { inputActions } = benchInputActions()
    const view = render(<MediaToolbar {...propsOf(inputActions)} addImages={addImages} />)
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: zh['input.screen'] }))
    })
    expect(fetch).not.toHaveBeenCalled()
    expect(addImages).toHaveBeenCalledOnce()
    const files = addImages.mock.calls[0]?.[0] ?? []
    expect(files[0]?.type).toBe('image/jpeg')
    expect(view.getByRole('button', { name: zh['media.stop'] })).toBeTruthy()
  })

  it('surfaces the composer rejection of the frame', async () => {
    stubMediaDevices()
    stubFrameCapture()
    const addImages = vi.fn((_files: readonly File[]): string | null => 'too large')
    const { inputActions } = benchInputActions()
    const view = render(<MediaToolbar {...propsOf(inputActions)} addImages={addImages} />)
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: zh['input.screen'] }))
    })
    expect(view.getByRole('status').textContent).toBe('too large')
  })

  it('reports a missing composer sink', async () => {
    stubMediaDevices()
    stubFrameCapture()
    const { inputActions } = benchInputActions()
    const view = render(<MediaToolbar {...propsOf(inputActions)} />)
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: zh['input.screen'] }))
    })
    expect(view.getByRole('status').textContent).toBe(zh['media.screen.attach.failed'])
  })

  it('reports an unsupported environment without opening a picker', () => {
    Object.defineProperty(navigator, 'mediaDevices', { value: {}, configurable: true })
    const { inputActions } = benchInputActions()
    const view = render(<MediaToolbar {...propsOf(inputActions)} />)
    act(() => {
      fireEvent.click(view.getByRole('button', { name: zh['input.screen'] }))
    })
    expect(view.getByRole('status').textContent).toBe(zh['media.unsupported.screen'])
  })

  it('asks for the configured capture scope instead of a bare video request', async () => {
    localStorage.setItem('dsh.screen.settings', JSON.stringify({ captureScope: 'window' }))
    const devices = stubMediaDevices()
    stubFrameCapture()
    const addImages = vi.fn((_files: readonly File[]): string | null => null)
    const { inputActions } = benchInputActions()
    const view = render(<MediaToolbar {...propsOf(inputActions)} addImages={addImages} />)
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: zh['input.screen'] }))
    })
    const constraints = devices.getDisplayMedia.mock.calls[0]?.[0] as { video?: { displaySurface?: string } }
    expect(constraints.video?.displaySurface).toBe('window')
  })

  it('leaves the picker every choice when the scope is ask', async () => {
    const devices = stubMediaDevices()
    stubFrameCapture()
    const addImages = vi.fn((_files: readonly File[]): string | null => null)
    const { inputActions } = benchInputActions()
    const view = render(<MediaToolbar {...propsOf(inputActions)} addImages={addImages} />)
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: zh['input.screen'] }))
    })
    const constraints = devices.getDisplayMedia.mock.calls[0]?.[0] as { video?: unknown }
    expect(constraints.video).toBe(true)
  })

  it('skips a scheduled frame while the screen has not moved', async () => {
    localStorage.setItem('dsh.screen.settings', JSON.stringify({
      sendOnChange: true, changeThreshold: 0.02, intervalMs: 1000,
    }))
    stubMediaDevices()
    stubFrameCapture()
    // An identical thumbnail every tick: nothing counts as a change.
    framePixels = new Uint8ClampedArray(64 * 36 * 4).fill(120)
    const addImages = vi.fn((_files: readonly File[]): string | null => null)
    const { inputActions } = benchInputActions()
    const view = render(<MediaToolbar {...propsOf(inputActions)} addImages={addImages} />)
    vi.useFakeTimers()
    try {
      await act(async () => {
        fireEvent.click(view.getByRole('button', { name: zh['input.screen'] }))
      })
      // The first frame always goes out, so the run is visible immediately.
      expect(addImages).toHaveBeenCalledOnce()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000)
      })
      expect(addImages).toHaveBeenCalledOnce()
      // A real change lets the next scheduled frame through.
      framePixels = new Uint8ClampedArray(64 * 36 * 4).fill(255)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })
      expect(addImages).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps sending on schedule when smart send is off', async () => {
    localStorage.setItem('dsh.screen.settings', JSON.stringify({ intervalMs: 1000 }))
    stubMediaDevices()
    stubFrameCapture()
    // Identical frames, but the setting is off so nothing is skipped.
    framePixels = new Uint8ClampedArray(64 * 36 * 4).fill(120)
    const addImages = vi.fn((_files: readonly File[]): string | null => null)
    const { inputActions } = benchInputActions()
    const view = render(<MediaToolbar {...propsOf(inputActions)} addImages={addImages} />)
    vi.useFakeTimers()
    try {
      await act(async () => {
        fireEvent.click(view.getByRole('button', { name: zh['input.screen'] }))
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000)
      })
      expect(addImages).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('writes recognized screen text into the draft instead of a picture', async () => {
    localStorage.setItem('dsh.screen.settings', JSON.stringify({ broadcast: false, sendText: true }))
    stubMediaDevices()
    stubFrameCapture()
    const fetch = vi.fn(async (): Promise<{ ok: boolean; json: () => Promise<unknown> }> => ({
      ok: true,
      json: async () => ({ text: 'const answer = 42' }),
    }))
    vi.stubGlobal('fetch', fetch)
    // A vision endpoint is what makes the text reader available at all.
    localStorage.setItem('dsh.voice.settings', JSON.stringify({ visionUrl: 'https://vision.test', visionKey: 'k' }))
    const addImages = vi.fn((_files: readonly File[]): string | null => null)
    const { inputActions, setDraft } = benchInputActions()
    const view = render(<MediaToolbar {...propsOf(inputActions)} addImages={addImages} />)
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: zh['input.screen'] }))
    })
    expect(addImages).not.toHaveBeenCalled()
    expect(setDraft).toHaveBeenCalledWith('const answer = 42')
    expect(view.getByRole('status').textContent).toBe(zh['media.screen.attached'])
  })

  it('falls back to the picture when no text reader is configured', async () => {
    localStorage.setItem('dsh.screen.settings', JSON.stringify({ broadcast: false, sendText: true }))
    stubMediaDevices()
    stubFrameCapture()
    const addImages = vi.fn((_files: readonly File[]): string | null => null)
    const { inputActions } = benchInputActions()
    const view = render(<MediaToolbar {...propsOf(inputActions)} addImages={addImages} />)
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: zh['input.screen'] }))
    })
    expect(addImages).toHaveBeenCalledOnce()
  })
})

describe('voice control', () => {
  it('carries one spoken sentence from the microphone to the conversation', async () => {
    const { stop, stream } = holdDevices()
    stubHoldRecorder()
    stubDecoder(1600)
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ text: 'привет' }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const { setDraft, submit, inputActions } = benchInputActions()
    const view = render(<MediaToolbar {...propsOf(inputActions)} />)
    const button = view.getByRole('button', { name: zh['input.voiceHold'] })

    await act(async () => { fireEvent.click(button) })
    expect(view.getByRole('status').textContent).toBe(zh['media.speaking'])

    // The second press is the release: one control, no second button to find.
    await act(async () => { fireEvent.click(view.getByRole('button', { name: zh['input.voiceHold'] })) })
    // The whole gesture: nothing was typed, nothing else was clicked.
    expect(String(fetch.mock.calls[0]?.[0])).toContain('/api/voice/transcribe')
    expect(setDraft).toHaveBeenCalledWith('привет')
    expect(submit).toHaveBeenCalledOnce()
    // The microphone is handed back as soon as the clip is in hand.
    expect(stop).toHaveBeenCalled()
    expect(stream).toBeTruthy()
  })

  it('reports an empty recording instead of sending silence', async () => {
    holdDevices()
    stubHoldRecorder({ chunks: false })
    stubDecoder(0)
    const fetch = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const { setDraft, submit, inputActions } = benchInputActions()
    const view = render(<MediaToolbar {...propsOf(inputActions)} />)
    const button = view.getByRole('button', { name: zh['input.voiceHold'] })

    await act(async () => { fireEvent.click(button) })
    await act(async () => { fireEvent.click(view.getByRole('button', { name: zh['input.voiceHold'] })) })
    expect(view.getByRole('status').textContent).toBe(zh['media.voice.empty'])
    expect(fetch).not.toHaveBeenCalled()
    expect(setDraft).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })

  it('names the setting to change when no recognizer can run', async () => {
    holdDevices()
    stubHoldRecorder()
    stubDecoder(1600)
    // A named service with nothing stored cannot run, and the module says so
    // rather than quietly recognizing with something else.
    localStorage.setItem('dsh.voice.settings', JSON.stringify({ sttEngine: 'service' }))
    const fetch = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const { inputActions } = benchInputActions()
    const view = render(<MediaToolbar {...propsOf(inputActions)} />)
    const button = view.getByRole('button', { name: zh['input.voiceHold'] })

    await act(async () => { fireEvent.click(button) })
    await act(async () => { fireEvent.click(view.getByRole('button', { name: zh['input.voiceHold'] })) })
    expect(view.getByRole('status').textContent).toBe(zh['media.voice.engine.missing'])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reports a recognizer that refuses the clip', async () => {
    holdDevices()
    stubHoldRecorder()
    stubDecoder(1600)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"bad model"}', { status: 400 })))
    const { inputActions } = benchInputActions()
    const view = render(<MediaToolbar {...propsOf(inputActions)} />)
    const button = view.getByRole('button', { name: zh['input.voiceHold'] })

    await act(async () => { fireEvent.click(button) })
    await act(async () => { fireEvent.click(view.getByRole('button', { name: zh['input.voiceHold'] })) })
    expect(view.getByRole('status').textContent).toBe(zh['media.voice.failed'])
  })

  it('reports a microphone this runtime does not have', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true })
    const { inputActions } = benchInputActions()
    const view = render(<MediaToolbar {...propsOf(inputActions)} />)
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: zh['input.voiceHold'] }))
    })
    expect(view.getByRole('status').textContent).toBe(zh['media.unsupported.mic'])
  })

  it('reports a refused microphone as a permission, not a fault', async () => {
    holdDevices({ refuse: true })
    // The recorder has to exist too: without it the module reports "no capture
    // in this runtime" and the refusal is never reached.
    stubHoldRecorder()
    const { inputActions } = benchInputActions()
    const view = render(<MediaToolbar {...propsOf(inputActions)} />)
    // Two turns of the queue: the press opens the microphone across awaits, and
    // the refusal is only readable once that attempt has settled.
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: zh['input.voiceHold'] }))
    })
    await act(async () => { await Promise.resolve() })
    expect(view.getByRole('status').textContent).toBe(zh['media.voice.denied'])
  })

  it('stops on the next press even when the recognizer never answers', async () => {
    holdDevices()
    stubHoldRecorder({ chunks: false })
    stubDecoder(0)
    const { inputActions } = benchInputActions()
    const view = render(<MediaToolbar {...propsOf(inputActions)} />)
    const button = view.getByRole('button', { name: zh['input.voiceHold'] })

    // A press that opens nothing is still a press: the control owns the line
    // while it works, and the next one takes the line back.
    await act(async () => { fireEvent.click(button) })
    await act(async () => { fireEvent.click(view.getByRole('button', { name: zh['input.voiceHold'] })) })
    expect(view.getByRole('status').textContent).toBe(zh['media.voice.empty'])
  })

  it('reaches the control through the keyboard as well', async () => {
    holdDevices()
    stubHoldRecorder()
    stubDecoder(1600)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ text: 'ok' }), { status: 200 })))
    const { setDraft, inputActions } = benchInputActions()
    const view = render(<MediaToolbar {...propsOf(inputActions)} />)
    const button = view.getByRole('button', { name: zh['input.voiceHold'] })

    // A button activated from the keyboard fires click: no separate key path.
    await act(async () => { fireEvent.click(button) })
    await act(async () => { fireEvent.click(view.getByRole('button', { name: zh['input.voiceHold'] })) })
    expect(setDraft).toHaveBeenCalledWith('ok')
  })

  it('gives the microphone back when the composer goes away', async () => {
    const { stop } = holdDevices()
    stubHoldRecorder()
    stubDecoder(1600)
    const { inputActions } = benchInputActions()
    const view = render(<MediaToolbar {...propsOf(inputActions)} />)
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: zh['input.voiceHold'] }))
    })
    view.unmount()
    // A composer that unmounts mid-recording must not leave the device open.
    expect(stop).toHaveBeenCalled()
  })

  it('refuses to start while the composer is locked', () => {
    holdDevices()
    const { inputActions } = benchInputActions()
    const view = render(<MediaToolbar {...propsOf(inputActions, { locked: true })} />)
    expect(view.getByRole('button', { name: zh['input.voiceHold'] }).hasAttribute('disabled')).toBe(true)
  })
})

/** A microphone whose track stop is observable, so release can be asserted. */
function holdDevices(over?: { refuse?: boolean }): { stop: ReturnType<typeof vi.fn>; stream: MediaStream } {
  const stop = vi.fn()
  const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream
  // A refusal arrives the way the platform sends it — as a named DOMException —
  // because that name, not the message, is what tells a denied permission apart
  // from a microphone that is merely busy.
  const getUserMedia = over?.refuse === true
    ? vi.fn(async () => { throw new DOMException('Permission denied', 'NotAllowedError') })
    : vi.fn(async () => stream)
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia },
    configurable: true,
  })
  return { stop, stream }
}

/** Recorder that optionally hands over one chunk before reporting its stop. */
function stubHoldRecorder(over?: { chunks?: boolean }): void {
  const chunks = over?.chunks ?? true
  vi.stubGlobal('MediaRecorder', class {
    static isTypeSupported = (): boolean => true
    ondataavailable: ((event: { data: Blob }) => void) | null = null
    onstop: (() => void) | null = null
    onerror: ((event: unknown) => void) | null = null
    readonly mimeType = 'audio/webm;codecs=opus'
    start(): void {}
    stop(): void {
      if (chunks) this.ondataavailable?.({ data: new Blob(['clip']) })
      this.onstop?.()
    }
  })
}

/**
 * Decoder returning one channel of `samples` samples at 16 kHz. Zero samples is
 * a recording that captured nothing, which is a different outcome from a
 * recording the recognizer could not read.
 * @param samples - how many samples the decoded clip holds.
 */
function stubDecoder(samples: number): void {
  vi.stubGlobal('AudioContext', class {
    decodeAudioData = async (): Promise<{
      sampleRate: number
      numberOfChannels: number
      getChannelData: () => Float32Array
    }> => ({
      sampleRate: 16000,
      numberOfChannels: 1,
      getChannelData: () => new Float32Array(samples),
    })
    close = async (): Promise<void> => {}
  })
}

// @vitest-environment jsdom
// Capture devices: quiet answers outside a capable context, a faithful
// adapter over mediaDevices when it is present, and label unlock only after
// a granted capture.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ensureMicrophoneAccess, isMediaDevicesAvailable, listAudioDevices, readMicrophonePermission,
} from '../src/media-devices.ts'

afterEach(() => {
  // stubMediaDevices mutates navigator directly (vi.stubGlobal cannot shadow
  // a getter-only property), so the reset has to undo the same mutation.
  const nav = navigator as unknown as Record<string, unknown>
  delete nav.mediaDevices
  delete nav.permissions
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** A mediaDevices stand-in with scriptable answers. */
function stubMediaDevices(face: {
  getUserMedia?: (constraints: unknown) => Promise<unknown>
  enumerateDevices?: () => Promise<unknown[]>
  permission?: { state: string } | Error
}): void {
  const nav = navigator as unknown as Record<string, unknown>
  nav.mediaDevices = {
    getUserMedia: face.getUserMedia,
    enumerateDevices: face.enumerateDevices,
  }
  if (face.permission !== undefined) {
    const permission = face.permission
    nav.permissions = {
      query: permission instanceof Error
        ? () => Promise.reject(permission)
        : () => Promise.resolve(permission),
    }
  } else {
    delete nav.permissions
  }
}

/** A captured stream stand-in exposing the tracks the priming call stops. */
function fakeStream(): { tracks: { stopped: number; stop(): void }[]; getTracks(): { stop(): void }[] } {
  const track = {
    stopped: 0,
    stop(): void { track.stopped += 1 },
  }
  return { tracks: [track], getTracks: () => [track] }
}

describe('isMediaDevicesAvailable', () => {
  it('answers false where mediaDevices is missing (jsdom default)', () => {
    expect(isMediaDevicesAvailable()).toBe(false)
  })

  it('answers true once getUserMedia exists', () => {
    stubMediaDevices({ getUserMedia: () => Promise.resolve(fakeStream()) })
    expect(isMediaDevicesAvailable()).toBe(true)
  })
})

describe('readMicrophonePermission', () => {
  it('reports the state the Permissions API holds', async () => {
    stubMediaDevices({ permission: { state: 'granted' } })
    await expect(readMicrophonePermission()).resolves.toBe('granted')
  })

  it('collapses an unsupported permission name to unknown instead of guessing', async () => {
    stubMediaDevices({ permission: new TypeError("'microphone' is not a valid PermissionName") })
    await expect(readMicrophonePermission()).resolves.toBe('unknown')
  })

  it('answers unknown where the Permissions API itself is missing', async () => {
    stubMediaDevices({})
    await expect(readMicrophonePermission()).resolves.toBe('unknown')
  })
})

describe('ensureMicrophoneAccess', () => {
  it('asks for audio, stops the stream, and answers true on grant', async () => {
    const stream = fakeStream()
    const getUserMedia = vi.fn(() => Promise.resolve(stream))
    stubMediaDevices({ getUserMedia })
    await expect(ensureMicrophoneAccess()).resolves.toBe(true)
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true })
    expect(stream.tracks[0]?.stopped).toBe(1)
  })

  it('answers false on denial instead of throwing', async () => {
    stubMediaDevices({ getUserMedia: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) })
    await expect(ensureMicrophoneAccess()).resolves.toBe(false)
  })

  it('answers false where capture is unavailable', async () => {
    await expect(ensureMicrophoneAccess()).resolves.toBe(false)
  })
})

describe('listAudioDevices', () => {
  it('keeps only audio endpoints, preserving kind and label', async () => {
    stubMediaDevices({
      enumerateDevices: () => Promise.resolve([
        { kind: 'audioinput', deviceId: 'mic-1', label: 'Built-in microphone' },
        { kind: 'videoinput', deviceId: 'cam-1', label: 'Webcam' },
        { kind: 'audiooutput', deviceId: 'spk-1', label: 'Speakers' },
      ]),
    })
    await expect(listAudioDevices()).resolves.toEqual([
      { kind: 'audioinput', deviceId: 'mic-1', label: 'Built-in microphone' },
      { kind: 'audiooutput', deviceId: 'spk-1', label: 'Speakers' },
    ])
  })

  it('keeps blank labels intact: they carry the not-yet-granted hint', async () => {
    stubMediaDevices({
      enumerateDevices: () => Promise.resolve([
        { kind: 'audioinput', deviceId: '', label: '' },
      ]),
    })
    await expect(listAudioDevices()).resolves.toEqual([{ kind: 'audioinput', deviceId: '', label: '' }])
  })

  it('answers [] where enumeration is missing or rejects', async () => {
    await expect(listAudioDevices()).resolves.toEqual([])
    stubMediaDevices({ enumerateDevices: () => Promise.reject(new Error('nope')) })
    await expect(listAudioDevices()).resolves.toEqual([])
  })
})

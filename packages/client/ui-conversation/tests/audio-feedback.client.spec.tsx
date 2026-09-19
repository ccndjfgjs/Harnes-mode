// @vitest-environment jsdom
// Interface tones: silent without Web Audio, exact sweeps with it.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { playErrorTone, playSendTone, playSuccessTone, playTone, playTurnEndTone } from '../src/client/skeleton/audio-feedback.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

class FakeParam {
  readonly calls: { at: number; value: number }[] = []
  setValueAtTime(value: number, at: number): void {
    this.calls.push({ at, value })
  }
  exponentialRampToValueAtTime(value: number, at: number): void {
    this.calls.push({ at, value })
  }
  linearRampToValueAtTime(value: number, at: number): void {
    this.calls.push({ at, value })
  }
}

class FakeOscillator {
  readonly frequency: FakeParam
  type = ''
  started = false
  stopped = false
  constructor() {
    this.frequency = new FakeParam()
  }
  connect(): void {}
  start(): void {
    this.started = true
  }
  stop(): void {
    this.stopped = true
  }
}

class FakeGain {
  readonly gain: FakeParam
  constructor() {
    this.gain = new FakeParam()
  }
  connect(): void {}
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  state = 'running'
  currentTime = 0
  readonly destination = {}
  oscillator: FakeOscillator | null = null
  gain: FakeGain | null = null
  constructor() {
    FakeAudioContext.instances.push(this)
  }
  resume(): Promise<void> {
    return Promise.resolve()
  }
  createOscillator(): FakeOscillator {
    this.oscillator = new FakeOscillator()
    return this.oscillator
  }
  createGain(): FakeGain {
    this.gain = new FakeGain()
    return this.gain
  }
}

describe('playSendTone', () => {
  it('plays a short rising submission blip', () => {
    FakeAudioContext.instances.length = 0
    vi.stubGlobal('AudioContext', FakeAudioContext)
    playSendTone()
    const [oscillator] = FakeAudioContext.instances.map(context => context.oscillator!)
    if (oscillator === undefined) throw new Error('expected one tone oscillator')
    expect(oscillator.frequency.calls.map(call => call.value)).toEqual([520, 660])
  })
})

describe('playTurnEndTone', () => {
  it('chimes completed and warns error, silent otherwise', () => {
    FakeAudioContext.instances.length = 0
    vi.stubGlobal('AudioContext', FakeAudioContext)
    playTurnEndTone('completed')
    playTurnEndTone('error')
    playTurnEndTone('aborted')
    playTurnEndTone('max-tokens')
    playTurnEndTone('interrupted')
    expect(FakeAudioContext.instances).toHaveLength(2)
    const [success, error] = FakeAudioContext.instances.map(context => context.oscillator!)
    if (success === undefined || error === undefined) throw new Error('expected two tone oscillators')
    expect(success.frequency.calls.map(call => call.value)).toEqual([800, 1200])
    expect(error.frequency.calls.map(call => call.value)).toEqual([200, 150])
  })
})

describe('playTone', () => {
  it('stays silent without Web Audio and never throws', () => {
    expect(() => {
      playTone({ from: 440 })
      playSuccessTone()
      playErrorTone()
    }).not.toThrow()
  })

  it('sweeps success upward and error downward with an envelope', () => {
    FakeAudioContext.instances.length = 0
    vi.stubGlobal('AudioContext', FakeAudioContext)
    playSuccessTone()
    playErrorTone()
    expect(FakeAudioContext.instances).toHaveLength(2)
    const [success, error] = FakeAudioContext.instances.map(context => context.oscillator!)
    if (success === undefined || error === undefined) throw new Error('expected two tone oscillators')
    expect(success.frequency.calls.map(call => call.value)).toEqual([800, 1200])
    expect(error.frequency.calls.map(call => call.value)).toEqual([200, 150])
    for (const oscillator of [success, error]) {
      expect(oscillator.started).toBe(true)
      expect(oscillator.stopped).toBe(true)
    }
    const gain = FakeAudioContext.instances[0]?.gain?.gain.calls.map(call => call.value) ?? []
    expect(gain[0]).toBe(0)
    expect(Math.max(...gain)).toBeLessThanOrEqual(1)
  })
})

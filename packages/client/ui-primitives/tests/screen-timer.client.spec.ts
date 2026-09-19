// @vitest-environment jsdom
// Frame cadence: the off-thread timer, its honest fallback to the main thread,
// and the resource it must not leak.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createIntervalTimer, createWorkerTimer } from '../src/screen-timer.ts'

/** A worker stand-in that records what it was told and can be made to tick. */
class FakeWorker {
  /** Every worker built during a test, in creation order. */
  static readonly built: FakeWorker[] = []
  /** Messages the timer posted, in order. */
  readonly posted: unknown[] = []
  /** Whether the timer terminated this worker. */
  terminated = false
  onmessage: ((event: MessageEvent) => void) | undefined

  constructor(readonly url: string) {
    FakeWorker.built.push(this)
  }

  postMessage(data: unknown): void {
    this.posted.push(data)
  }

  terminate(): void {
    this.terminated = true
  }

  /** Deliver one tick, as the real worker body would. */
  tick(): void {
    this.onmessage?.({ data: 'tick' } as MessageEvent)
  }
}

const createdUrls: string[] = []
const revokedUrls: string[] = []

function stubObjectUrls(): void {
  URL.createObjectURL = ((): string => {
    const url = `blob:fake/${createdUrls.length}`
    createdUrls.push(url)
    return url
  })
  URL.revokeObjectURL = ((url: string): void => { revokedUrls.push(url) })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  FakeWorker.built.length = 0
  createdUrls.length = 0
  revokedUrls.length = 0
})

describe('createIntervalTimer', () => {
  it('ticks on the interval until it is stopped', () => {
    vi.useFakeTimers()
    const tick = vi.fn()
    const timer = createIntervalTimer()
    timer.start(1000, tick)
    vi.advanceTimersByTime(3000)
    expect(tick).toHaveBeenCalledTimes(3)
    timer.stop()
    vi.advanceTimersByTime(5000)
    expect(tick).toHaveBeenCalledTimes(3)
  })

  it('restarts on a second start instead of stacking intervals', () => {
    vi.useFakeTimers()
    const first = vi.fn()
    const second = vi.fn()
    const timer = createIntervalTimer()
    timer.start(1000, first)
    timer.start(1000, second)
    vi.advanceTimersByTime(1000)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('tolerates a stop with nothing running', () => {
    expect(() => { createIntervalTimer().stop() }).not.toThrow()
  })
})

describe('createWorkerTimer', () => {
  it('runs the cadence in a worker when the environment offers one', () => {
    stubObjectUrls()
    vi.stubGlobal('Worker', FakeWorker)
    const tick = vi.fn()
    const timer = createWorkerTimer()
    timer.start(2000, tick)
    const worker = FakeWorker.built[0]
    expect(worker?.posted).toEqual([{ kind: 'start', intervalMs: 2000 }])
    // The tick arrives by message, not by a main-thread timer.
    worker?.tick()
    expect(tick).toHaveBeenCalledTimes(1)
    timer.stop()
  })

  it('falls back to the main thread where no worker exists', () => {
    vi.useFakeTimers()
    vi.stubGlobal('Worker', undefined)
    const tick = vi.fn()
    const timer = createWorkerTimer()
    timer.start(1000, tick)
    vi.advanceTimersByTime(2000)
    // A missing worker must not mean a dead cadence.
    expect(tick).toHaveBeenCalledTimes(2)
    timer.stop()
  })

  it('falls back when the platform refuses to build a worker', () => {
    vi.useFakeTimers()
    stubObjectUrls()
    vi.stubGlobal('Worker', function RefusingWorker(): never {
      throw new Error('worker refused by policy')
    })
    const tick = vi.fn()
    const timer = createWorkerTimer()
    expect(() => { timer.start(1000, tick) }).not.toThrow()
    vi.advanceTimersByTime(1000)
    expect(tick).toHaveBeenCalledTimes(1)
    timer.stop()
  })

  it('falls back when the object URL itself cannot be made', () => {
    vi.useFakeTimers()
    vi.stubGlobal('Worker', FakeWorker)
    URL.createObjectURL = ((): string => {
      throw new Error('no blob urls here')
    })
    const tick = vi.fn()
    const timer = createWorkerTimer()
    expect(() => { timer.start(1000, tick) }).not.toThrow()
    vi.advanceTimersByTime(1000)
    expect(tick).toHaveBeenCalledTimes(1)
    expect(FakeWorker.built).toHaveLength(0)
    timer.stop()
  })

  it('terminates the worker and releases its source on stop', () => {
    stubObjectUrls()
    vi.stubGlobal('Worker', FakeWorker)
    const timer = createWorkerTimer()
    timer.start(1000, vi.fn())
    const worker = FakeWorker.built[0]!
    timer.stop()
    expect(worker.terminated).toBe(true)
    expect(revokedUrls).toEqual([worker.url])
  })

  it('builds a fresh worker after a stop, so no cadence is left behind', () => {
    stubObjectUrls()
    vi.stubGlobal('Worker', FakeWorker)
    const timer = createWorkerTimer()
    timer.start(1000, vi.fn())
    timer.stop()
    timer.start(1000, vi.fn())
    expect(FakeWorker.built).toHaveLength(2)
    expect(FakeWorker.built[0]?.terminated).toBe(true)
    expect(FakeWorker.built[1]?.terminated).toBe(false)
    timer.stop()
  })

  it('stops a fallback interval once a worker becomes unnecessary', () => {
    vi.useFakeTimers()
    vi.stubGlobal('Worker', undefined)
    const tick = vi.fn()
    const timer = createWorkerTimer()
    timer.start(1000, tick)
    vi.advanceTimersByTime(1000)
    expect(tick).toHaveBeenCalledTimes(1)
    timer.stop()
    vi.advanceTimersByTime(5000)
    expect(tick).toHaveBeenCalledTimes(1)
  })

  it('tolerates a stop with nothing running', () => {
    vi.stubGlobal('Worker', undefined)
    expect(() => { createWorkerTimer().stop() }).not.toThrow()
  })
})

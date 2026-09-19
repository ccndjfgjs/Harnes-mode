/**
 * Frame cadence for the screen capture: how a tick gets scheduled, and what
 * happens when the platform will not give us a worker.
 *
 * Two reasons the tick does not simply live on the interface thread:
 *
 * - a busy main thread (a long render, a large parse) delays its timers, so a
 *   broadcast would silently stretch its cadence exactly while the machine is
 *   working hardest;
 * - a hidden page throttles main-thread timers aggressively.
 *
 * A dedicated worker lifts the first cause entirely and the second one wherever
 * the platform honours it. The Electron shell additionally disables background
 * throttling for the window (see `electron/main.js`), which is the part that
 * makes the cadence hold while the app is minimised.
 *
 * The worker is built from an inline source rather than a separate bundle
 * entry: no build-configuration change, nothing to keep in sync, and no import
 * edge between the leaf and the bundler.
 *
 * A dependency-free leaf (like speech-synthesis.ts), so any client package may
 * consume the capture without bundle-purity edges.
 */

/** How the engine schedules frame ticks. */
export interface FrameTimer {
  /**
   * Begin ticking.
   * @param intervalMs - milliseconds between ticks.
   * @param onTick - called once per tick.
   */
  start(intervalMs: number, onTick: () => void): void
  /** Stop ticking. Safe to call when not running. */
  stop(): void
}

/**
 * The worker body: one interval, restarted on every `start` message.
 *
 * It is a string because a worker cannot be built from a module the bundler
 * already owns without adding a second entry point. Kept to plain ES5-free
 * JavaScript with no imports, so it runs in any worker scope.
 */
const WORKER_SOURCE = [
  'let handle',
  'self.onmessage = (event) => {',
  '  const data = event.data',
  '  if (handle !== undefined) { clearInterval(handle); handle = undefined }',
  '  if (data && data.kind === "start") {',
  '    handle = setInterval(() => { self.postMessage("tick") }, data.intervalMs)',
  '  }',
  '}',
].join('\n')

/** The main-thread frame scheduler. */
export function createIntervalTimer(): FrameTimer {
  let handle: ReturnType<typeof setInterval> | undefined
  return {
    start: (intervalMs, onTick): void => {
      if (handle !== undefined) clearInterval(handle)
      handle = setInterval(onTick, intervalMs)
    },
    stop: (): void => {
      if (handle === undefined) return
      clearInterval(handle)
      handle = undefined
    },
  }
}

/**
 * The off-thread frame scheduler, falling back to the main thread when the
 * environment has no worker or refuses to build one.
 *
 * The worker is terminated on `stop`, so no worker outlives the broadcast it
 * was ticking for; the next `start` builds a fresh one. Nothing here throws: a
 * refused worker must degrade the cadence, never break the capture.
 * @returns the scheduler.
 */
export function createWorkerTimer(): FrameTimer {
  let worker: Worker | undefined
  let objectUrl: string | undefined
  let fallback: FrameTimer | undefined
  let onTick: (() => void) | undefined

  /** Terminate the worker and release its source URL. */
  const drop = (): void => {
    if (worker !== undefined) {
      worker.terminate()
      worker = undefined
    }
    if (objectUrl === undefined) return
    try {
      URL.revokeObjectURL(objectUrl)
    } catch {
      // An engine that has already released the URL is not a problem.
    }
    objectUrl = undefined
  }

  /**
   * Build the worker, or answer undefined when this environment cannot.
   * @returns the worker, or undefined.
   */
  const make = (): Worker | undefined => {
    const WorkerConstructor = (globalThis as { Worker?: typeof Worker }).Worker
    if (WorkerConstructor === undefined) return undefined
    try {
      objectUrl = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }))
      const created = new WorkerConstructor(objectUrl)
      created.onmessage = (): void => { onTick?.() }
      return created
    } catch {
      // A refused blob worker (policy, sandbox, engine gap) is expected on some
      // platforms; the fallback below is the whole answer.
      drop()
      return undefined
    }
  }

  return {
    start: (intervalMs, tick): void => {
      onTick = tick
      if (worker === undefined) worker = make()
      if (worker === undefined) {
        // Honest fallback rather than a silent no-op: the cadence still runs,
        // it just runs on the interface thread.
        fallback ??= createIntervalTimer()
        fallback.start(intervalMs, (): void => { onTick?.() })
        return
      }
      worker.postMessage({ kind: 'start', intervalMs })
    },
    stop: (): void => {
      if (fallback !== undefined) {
        fallback.stop()
        fallback = undefined
      }
      drop()
    },
  }
}

/**
 * Interface sound feedback: short synthesized tones played for submission
 * and turn outcomes as well as voice-flow results. Silent by construction
 * outside capable browsers: no AudioContext means no sound, never an
 * exception. Volume stays low so tones never fight a screen reader. Callers
 * gate on isSoundEnabled(): this module never reads settings itself.
 */

export interface ToneOptions {
  /** Start frequency in Hz. */
  from: number
  /** End frequency in Hz (a sweep when different from the start). */
  to?: number
  /** Tone length in milliseconds. */
  durationMs?: number
  /** Gain between 0 and 1. */
  volume?: number
}

const DEFAULT_DURATION_MS = 150
const DEFAULT_VOLUME = 0.25

/**
 * Play one enveloped oscillator tone, creating the AudioContext lazily on
 * the calling (user-gesture) stack so autoplay policies stay satisfied.
 * @param options - tone shape.
 */
export function playTone(options: ToneOptions): void {
  if (typeof AudioContext === 'undefined') return
  const durationMs = options.durationMs ?? DEFAULT_DURATION_MS
  const volume = Math.max(0, Math.min(1, options.volume ?? DEFAULT_VOLUME))
  const to = options.to ?? options.from
  try {
    const context = new AudioContext()
    if (context.state === 'suspended') void context.resume()
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(options.from, context.currentTime)
    if (to !== options.from) {
      oscillator.frequency.exponentialRampToValueAtTime(to, context.currentTime + durationMs / 1000)
    }
    gain.gain.setValueAtTime(0, context.currentTime)
    gain.gain.linearRampToValueAtTime(volume, context.currentTime + 0.01)
    gain.gain.linearRampToValueAtTime(0, context.currentTime + durationMs / 1000)
    oscillator.start(context.currentTime)
    oscillator.stop(context.currentTime + durationMs / 1000)
  } catch {
    // Audio is best-effort feedback: a blocked context must never break the flow.
  }
}

/** Play the success tone (rising 800→1200 Hz). */
export function playSuccessTone(): void {
  playTone({ from: 800, to: 1200, durationMs: 150 })
}

/** Play the error tone (falling 200→150 Hz). */
export function playErrorTone(): void {
  playTone({ from: 200, to: 150, durationMs: 200 })
}

/** Play the submission blip (short rising 520→660 Hz): the draft left the composer. */
export function playSendTone(): void {
  playTone({ from: 520, to: 660, durationMs: 90 })
}

/**
 * Sound one turn/end by its reason: a chime for a completed answer, the
 * error tone for a failed turn, silence for user-stopped, truncated, and
 * other non-terminal outcomes. Live tail only — callers must not invoke
 * this while replaying history.
 * @param kind - the turn/end reason kind.
 */
export function playTurnEndTone(kind: string): void {
  if (kind === 'completed') playSuccessTone()
  else if (kind === 'error') playErrorTone()
}

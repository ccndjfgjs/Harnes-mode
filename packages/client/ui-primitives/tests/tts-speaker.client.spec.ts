// @vitest-environment jsdom
// The speaker seam: one answer, one outcome. What matters here is that a caller
// always learns how the attempt ended — spoken, cancelled, unavailable, or
// failed — because that is what lets the voice module return to listening.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { setTtsBackend } from '../src/speech-synthesis.ts'
import type { SpeechLifecycle, TtsBackend } from '../src/speech-synthesis.ts'
import { SPEAK_START_GRACE_MS, createInstalledSpeaker } from '../src/voice/tts-speaker.ts'
import type { SpeakerOptions } from '../src/voice/tts-speaker.ts'

afterEach(() => {
  setTtsBackend(null)
  vi.restoreAllMocks()
})

/** A backend that admits to being available and records what it was asked to say. */
function fakeBackend(available = true): TtsBackend & { spoken: string[] } {
  const spoken: string[] = []
  return {
    spoken,
    isAvailable: () => available,
    speak: (text: string): void => { spoken.push(text) },
    cancel: vi.fn(),
  }
}

/** A watchdog the spec fires by hand, so no test waits on real time. */
function fakeTimers(): {
  schedule: NonNullable<SpeakerOptions['schedule']>
  unschedule: NonNullable<SpeakerOptions['unschedule']>
  fire: () => void
  pending: () => number
} {
  const waiting: (() => void)[] = []
  return {
    schedule: (run) => {
      waiting.push(run)
      return waiting.length as unknown as ReturnType<typeof setTimeout>
    },
    // Disarmed by replacing the run, so a later fire() proves the watchdog was
    // actually called off rather than merely forgotten.
    unschedule: (handle) => { waiting[Number(handle) - 1] = () => {} },
    fire: () => { waiting.shift()?.() },
    pending: () => waiting.length,
  }
}

/** Pacing the engine was handed for one utterance. */
interface Pacing {
  rate?: number | undefined
  pitch?: number | undefined
  lang: string
  onLifecycle: (event: SpeechLifecycle) => void
}

/** A speaker wired to fakes, plus the handles a test drives it with. */
function makeSpeaker(available = true): {
  speaker: ReturnType<typeof createInstalledSpeaker>
  backend: TtsBackend & { spoken: string[] }
  say: ReturnType<typeof vi.fn>
  timers: ReturnType<typeof fakeTimers>
  pacing: (call?: number) => Pacing
} {
  const backend = fakeBackend(available)
  const say = vi.fn()
  const timers = fakeTimers()
  const speaker = createInstalledSpeaker({
    backend: () => backend,
    speak: say,
    schedule: timers.schedule,
    unschedule: timers.unschedule,
    graceMs: 20,
  })
  return {
    speaker,
    backend,
    say,
    timers,
    pacing: (call = 0): Pacing => say.mock.calls[call]?.[1] as Pacing,
  }
}

describe('createInstalledSpeaker', () => {
  it('reports what the installed engine reports', () => {
    expect(createInstalledSpeaker({ backend: () => fakeBackend() }).isAvailable()).toBe(true)
    expect(createInstalledSpeaker({ backend: () => fakeBackend(false) }).isAvailable()).toBe(false)
  })

  it('treats an engine that throws when asked as unavailable', () => {
    const speaker = createInstalledSpeaker({ backend: () => { throw new Error('no engine') } })
    expect(speaker.isAvailable()).toBe(false)
  })

  it('has nothing to say for empty text, and says so without an engine', async () => {
    const { speaker, say } = makeSpeaker()
    expect(await speaker.speak({ text: '', lang: 'ru-RU' })).toBe('spoken')
    expect(say).not.toHaveBeenCalled()
  })

  it('reports unavailable without asking an engine that is not there', async () => {
    const { speaker, say } = makeSpeaker(false)
    expect(await speaker.speak({ text: 'привет', lang: 'ru-RU' })).toBe('unavailable')
    expect(say).not.toHaveBeenCalled()
  })

  it('passes the text and locale, and leaves pacing unset', async () => {
    const { speaker, say, pacing, timers } = makeSpeaker()
    const attempt = speaker.speak({ text: 'привет', lang: 'ru-RU' })
    expect(say.mock.calls[0]?.[0]).toBe('привет')
    expect(pacing().lang).toBe('ru-RU')
    // No opinion about pacing: the rate chosen in Voice Settings must stand.
    expect(pacing().rate).toBeUndefined()
    expect(pacing().pitch).toBeUndefined()
    timers.fire()
    expect(await attempt).toBe('unavailable')
  })

  it('passes pacing through when the caller has an opinion', async () => {
    const { speaker, pacing, timers } = makeSpeaker()
    const attempt = speaker.speak({ text: 'привет', lang: 'ru-RU', speed: 1.5, pitch: 0.8 })
    expect(pacing()).toMatchObject({ rate: 1.5, pitch: 0.8 })
    timers.fire()
    await attempt
  })

  it('answers spoken once the voice finishes', async () => {
    const { speaker, pacing } = makeSpeaker()
    const attempt = speaker.speak({ text: 'привет', lang: 'ru-RU' })
    pacing().onLifecycle('start')
    pacing().onLifecycle('end')
    expect(await attempt).toBe('spoken')
  })

  it('answers failed when the engine refuses', async () => {
    const { speaker, pacing } = makeSpeaker()
    const attempt = speaker.speak({ text: 'привет', lang: 'ru-RU' })
    pacing().onLifecycle('error')
    expect(await attempt).toBe('failed')
  })

  it('answers failed when the engine throws while being asked', async () => {
    const speaker = createInstalledSpeaker({
      backend: () => fakeBackend(),
      speak: () => { throw new Error('engine exploded') },
    })
    expect(await speaker.speak({ text: 'привет', lang: 'ru-RU' })).toBe('failed')
  })

  it('gives up on an engine that never admits it started', async () => {
    const { speaker, timers } = makeSpeaker()
    const attempt = speaker.speak({ text: 'привет', lang: 'ru-RU' })
    expect(timers.pending()).toBe(1)
    timers.fire()
    expect(await attempt).toBe('unavailable')
  })

  it('stops guarding the attempt once the voice is audible', async () => {
    const { speaker, pacing, timers } = makeSpeaker()
    const attempt = speaker.speak({ text: 'привет', lang: 'ru-RU' })
    pacing().onLifecycle('start')
    // The watchdog was called off, so firing it can no longer kill the attempt.
    timers.fire()
    pacing().onLifecycle('end')
    expect(await attempt).toBe('spoken')
  })

  it('settles the replaced attempt when a new one starts', async () => {
    const { speaker, pacing } = makeSpeaker()
    const first = speaker.speak({ text: 'первый', lang: 'ru-RU' })
    const second = speaker.speak({ text: 'второй', lang: 'ru-RU' })
    expect(await first).toBe('cancelled')
    pacing(1).onLifecycle('end')
    expect(await second).toBe('spoken')
  })

  it('ignores a late event from an attempt that was replaced', async () => {
    const { speaker, pacing } = makeSpeaker()
    const first = speaker.speak({ text: 'первый', lang: 'ru-RU' })
    const second = speaker.speak({ text: 'второй', lang: 'ru-RU' })
    // The engine finishes the utterance nobody is waiting for any more; the
    // attempt still in flight must not be settled by it.
    pacing(0).onLifecycle('end')
    expect(await first).toBe('cancelled')
    pacing(1).onLifecycle('end')
    expect(await second).toBe('spoken')
  })

  it('cancels the engine and settles the attempt as cancelled', async () => {
    const { speaker, backend } = makeSpeaker()
    const attempt = speaker.speak({ text: 'привет', lang: 'ru-RU' })
    speaker.cancel()
    expect(await attempt).toBe('cancelled')
    expect(backend.cancel).toHaveBeenCalledTimes(1)
  })

  it('does not settle an attempt twice when the engine reports the cancel', async () => {
    const { speaker, pacing } = makeSpeaker()
    const attempt = speaker.speak({ text: 'привет', lang: 'ru-RU' })
    speaker.cancel()
    // The engine's own cancel reports an end; the attempt is already settled.
    pacing().onLifecycle('end')
    expect(await attempt).toBe('cancelled')
  })

  it('survives an engine that throws while being cancelled', () => {
    const speaker = createInstalledSpeaker({
      backend: () => ({ ...fakeBackend(), cancel: () => { throw new Error('stuck') } }),
      speak: () => {},
    })
    expect(() => { speaker.cancel() }).not.toThrow()
  })

  it('cancelling nothing is harmless', () => {
    const speaker = createInstalledSpeaker({ backend: () => fakeBackend(), speak: () => {} })
    expect(() => { speaker.cancel() }).not.toThrow()
  })

  it('waits no longer than the shipped grace by default', () => {
    expect(SPEAK_START_GRACE_MS).toBe(8000)
  })
})

describe('the shipped entry point', () => {
  it('speaks through the engine the app installed', async () => {
    const backend = fakeBackend()
    setTtsBackend(backend)
    const speaker = createInstalledSpeaker()
    const attempt = speaker.speak({ text: 'привет', lang: 'ru-RU', speed: 1.2, pitch: 1.1 })
    expect(backend.spoken).toEqual(['привет'])
    speaker.cancel()
    expect(await attempt).toBe('cancelled')
  })

  it('reads the installed engine on every call, so a later install applies', () => {
    setTtsBackend(fakeBackend(false))
    const speaker = createInstalledSpeaker()
    expect(speaker.isAvailable()).toBe(false)
    setTtsBackend(fakeBackend(true))
    expect(speaker.isAvailable()).toBe(true)
  })
})

describe('an engine that answers late', () => {
  it('survives a start that arrives after the attempt was given up on', async () => {
    const { speaker, pacing, timers } = makeSpeaker()
    const attempt = speaker.speak({ text: 'привет', lang: 'ru-RU' })
    timers.fire()
    expect(await attempt).toBe('unavailable')
    // The voice finally speaks, after nobody is waiting any more.
    expect(() => { pacing().onLifecycle('start') }).not.toThrow()
    expect(() => { pacing().onLifecycle('end') }).not.toThrow()
  })

  it('leaves pacing out entirely when the caller has no opinion', async () => {
    const backend = fakeBackend()
    setTtsBackend(backend)
    const speaker = createInstalledSpeaker()
    const attempt = speaker.speak({ text: 'привет', lang: 'ru-RU' })
    expect(backend.spoken).toEqual(['привет'])
    speaker.cancel()
    expect(await attempt).toBe('cancelled')
  })
})

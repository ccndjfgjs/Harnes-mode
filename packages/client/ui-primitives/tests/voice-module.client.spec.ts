// @vitest-environment jsdom
// The voice module: press, speak, release, and the rest follows. Every device
// and engine is replaced here, so what is under test is the sequence of states
// and the way a failure or an interruption lands — not any real audio.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { NothingToRecognizeError, SttError } from '../src/voice/stt-engine.ts'
import type { SttEngine } from '../src/voice/stt-engine.ts'
import type { Speaker, SpeakOutcome } from '../src/voice/tts-speaker.ts'
import type { AudioCapture, CaptureState, CapturedClip } from '../src/voice/audio-capture.ts'
import { ANSWER_TIMEOUT_MS, createVoiceModule } from '../src/voice/voice-module.ts'
import type { VoiceModuleOptions, VoiceModuleState } from '../src/voice/voice-module.ts'

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

/** One recorded clip of the shape a capture produces. */
const clip: CapturedClip = {
  blob: new Blob([new Uint8Array(64)], { type: 'audio/wav' }),
  durationMs: 1200,
  sampleRate: 16000,
  bytes: 64,
}

/** A capture the spec drives, including a failing start. */
interface FakeCapture extends AudioCapture {
  /** How many times the microphone was opened. */
  opens: number
  /** How many times the microphone was abandoned. */
  cancels: number
  /** How many times everything was released. */
  disposals: number
}

/** Build a capture that hands back the given clip, or refuses the first start. */
function makeCapture(
  options: { clip?: CapturedClip | undefined; startFails?: string; startFailsAs?: string } = {},
): FakeCapture {
  let state: CaptureState = 'idle'
  let lastError = ''
  let lastErrorName = ''
  let failed = false
  const handle: FakeCapture = {
    opens: 0,
    cancels: 0,
    disposals: 0,
    state: () => state,
    snapshot: () => ({ state, startedAt: undefined, lastError, lastErrorName }),
    subscribe: () => () => {},
    async start(): Promise<void> {
      handle.opens += 1
      if (options.startFails === undefined || failed) {
        state = 'recording'
        return
      }
      // A refusal that repeated itself would make a retry untestable.
      failed = true
      lastError = options.startFails
      lastErrorName = options.startFailsAs ?? ''
      state = 'failed'
    },
    async stop(): Promise<CapturedClip | undefined> {
      state = 'idle'
      return options.clip
    },
    cancel(): void {
      handle.cancels += 1
      state = 'idle'
    },
    dispose(): void {
      handle.disposals += 1
      state = 'idle'
    },
  }
  return handle
}

/**
 * Let every promise already queued run.
 *
 * The module moves between states across awaits, so a test that looks at an
 * intermediate state has to let the microtask queue drain first; asserting
 * synchronously would only ever see the state the press started in.
 * @returns a promise resolved after the queue has drained.
 */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve()
}

/** A recognizer that answers with the given text. */
function makeStt(text = 'привет'): SttEngine & { calls: number } {
  const engine: SttEngine & { calls: number } = {
    calls: 0,
    kind: 'local',
    isAvailable: () => true,
    async transcribe() {
      engine.calls += 1
      return { text, engine: 'local', durationMs: 250 }
    },
  }
  return engine
}

/** A recognizer that refuses with the given failure. */
function refusingStt(failure: unknown): SttEngine {
  return {
    kind: 'service',
    isAvailable: () => true,
    transcribe: async () => { throw failure },
  }
}

/** A speaker that answers with the given outcome. */
function makeSpeaker(outcome: SpeakOutcome = 'spoken'): Speaker & { said: string[], cancels: number } {
  const handle = {
    said: [] as string[],
    cancels: 0,
    isAvailable: () => true,
    async speak(request: { text: string }): Promise<SpeakOutcome> {
      handle.said.push(request.text)
      return outcome
    },
    cancel(): void { handle.cancels += 1 },
  }
  return handle
}

/** A watchdog the spec fires by hand. */
function fakeTimers(): {
  schedule: NonNullable<VoiceModuleOptions['schedule']>
  unschedule: NonNullable<VoiceModuleOptions['unschedule']>
  fire: () => void
  pending: () => number
} {
  const waiting: (() => void)[] = []
  return {
    schedule: (run) => {
      waiting.push(run)
      return waiting.length as unknown as ReturnType<typeof setTimeout>
    },
    unschedule: (handle) => { waiting[Number(handle) - 1] = () => {} },
    fire: () => { waiting.shift()?.() },
    pending: () => waiting.length,
  }
}

/** Everything one module under test was built with. */
function makeModule(overrides: Partial<VoiceModuleOptions> = {}): {
  module: ReturnType<typeof createVoiceModule>
  capture: FakeCapture
  stt: ReturnType<typeof makeStt>
  speaker: ReturnType<typeof makeSpeaker>
  submit: ReturnType<typeof vi.fn>
  awaitAnswer: ReturnType<typeof vi.fn>
  timers: ReturnType<typeof fakeTimers>
  states: VoiceModuleState[]
} {
  const capture = makeCapture({ clip })
  const stt = makeStt()
  const speaker = makeSpeaker()
  const submit = vi.fn()
  const awaitAnswer = vi.fn(async () => 'ответ')
  const timers = fakeTimers()
  // A clock that advances on every read, so a measured duration is never
  // accidentally zero and the snapshot can be asserted exactly.
  let clock = 0
  const module = createVoiceModule({
    capture,
    stt,
    speaker,
    turn: { submit, awaitAnswer },
    replyMode: () => 'speak',
    schedule: timers.schedule,
    unschedule: timers.unschedule,
    now: () => { clock += 10; return clock },
    ...overrides,
  })
  const states: VoiceModuleState[] = []
  module.subscribe((snapshot) => { states.push(snapshot.state) })
  return { module, capture, stt, speaker, submit, awaitAnswer, timers, states }
}

describe('a fresh module', () => {
  it('rests with nothing recorded and nothing to report', () => {
    const { module } = makeModule()
    expect(module.state()).toBe('idle')
    expect(module.snapshot()).toEqual({
      state: 'idle', transcript: '', answer: '', engine: '', reason: '', detail: '', clipMs: 0, recognizeMs: 0,
    })
  })

  it('waits no longer than the shipped limit for an answer', () => {
    expect(ANSWER_TIMEOUT_MS).toBe(120000)
  })
})

describe('pressing', () => {
  it('opens the microphone and starts listening', async () => {
    const { module, capture, states } = makeModule()
    await module.press()
    expect(module.state()).toBe('listening')
    expect(capture.opens).toBe(1)
    expect(states).toEqual(['listening'])
  })

  it('ignores a second press while already listening', async () => {
    const { module, capture } = makeModule()
    await module.press()
    await module.press()
    expect(capture.opens).toBe(1)
  })

  it('reports a runtime with no microphone at all', async () => {
    const module = createVoiceModule({ turn: { submit: vi.fn() }, replyMode: () => 'speak' })
    await module.press()
    expect(module.state()).toBe('error')
    expect(module.snapshot().reason).toBe('capture-unavailable')
  })

  it('reports a microphone the platform refused', async () => {
    const capture = makeCapture({ startFails: 'permission denied', startFailsAs: 'NotAllowedError' })
    const module = createVoiceModule({ capture, turn: { submit: vi.fn() }, replyMode: () => 'speak' })
    await module.press()
    expect(module.state()).toBe('error')
    // Told apart from a broken device: the repair is a Windows switch.
    expect(module.snapshot().reason).toBe('capture-denied')
    expect(module.snapshot().detail).toBe('permission denied')
  })

  it('reports a microphone that was refused for another reason as a fault', async () => {
    const capture = makeCapture({ startFails: 'device busy', startFailsAs: 'NotReadableError' })
    const module = createVoiceModule({ capture, turn: { submit: vi.fn() }, replyMode: () => 'speak' })
    await module.press()
    expect(module.state()).toBe('error')
    expect(module.snapshot().reason).toBe('capture-failed')
  })

  it('reports a failure with no stable name as a fault', async () => {
    const capture = makeCapture({ startFails: 'permission denied' })
    const module = createVoiceModule({ capture, turn: { submit: vi.fn() }, replyMode: () => 'speak' })
    await module.press()
    expect(module.snapshot().reason).toBe('capture-failed')
  })

  it('may be tried again after a failure', async () => {
    const capture = makeCapture({ startFails: 'permission denied' })
    const module = createVoiceModule({ capture, turn: { submit: vi.fn() }, replyMode: () => 'speak' })
    await module.press()
    expect(module.state()).toBe('error')
    await module.press()
    expect(module.state()).toBe('listening')
    expect(module.snapshot().reason).toBe('')
  })
})

describe('releasing', () => {
  it('carries the question from the microphone to the spoken answer', async () => {
    const { module, stt, speaker, submit, states } = makeModule()
    await module.press()
    await module.release()
    expect(states).toEqual(['listening', 'recognizing', 'sending', 'thinking', 'speaking', 'idle'])
    expect(stt.calls).toBe(1)
    expect(submit).toHaveBeenCalledWith('привет')
    expect(speaker.said).toEqual(['ответ'])
    expect(module.snapshot()).toMatchObject({
      state: 'idle', transcript: 'привет', answer: 'ответ', engine: 'local', clipMs: 1200, recognizeMs: 10, reason: '',
    })
  })

  it('does nothing when the microphone was never opened', async () => {
    const { module, stt } = makeModule()
    await module.release()
    expect(module.state()).toBe('idle')
    expect(stt.calls).toBe(0)
  })

  it('reports a release that captured nothing', async () => {
    const { module, stt } = makeModule({ capture: makeCapture({ clip: undefined }) })
    await module.press()
    await module.release()
    expect(module.state()).toBe('idle')
    expect(module.snapshot().reason).toBe('nothing-recorded')
    expect(stt.calls).toBe(0)
  })

  it('reports a runtime where nothing can recognize', async () => {
    // Built directly rather than through the shared factory: "no recognizer" is
    // an absence, not an override, and an absent seam is what this pins.
    const capture = makeCapture({ clip })
    const module = createVoiceModule({ capture, turn: { submit: vi.fn() }, replyMode: () => 'speak' })
    await module.press()
    await module.release()
    expect(module.state()).toBe('error')
    expect(module.snapshot().reason).toBe('recognize-unavailable')
  })

  it('keeps the loggable JSON when the module itself found no recognizer', async () => {
    const capture = makeCapture({ clip })
    const module = createVoiceModule({ capture, turn: { submit: vi.fn() }, replyMode: () => 'speak' })
    await module.press()
    await module.release()
    // The detail is the JSON a journal reader searches for, not a prose line:
    // the same shape the engine raises and the gateway answers with.
    expect(JSON.parse(module.snapshot().detail)).toEqual({
      error: 'nothing_to_recognize',
      details: {
        setting: 'Голос',
        action: 'выберите распознавание на этом компьютере или укажите сервис',
      },
    })
  })

  it('keeps the loggable JSON when the recognizer raised it', async () => {
    const raised = new NothingToRecognizeError()
    const { module } = makeModule({ stt: refusingStt(raised) })
    await module.press()
    await module.release()
    expect(module.snapshot().reason).toBe('recognize-unavailable')
    const logged = JSON.parse(module.snapshot().detail) as { error: string }
    expect(logged.error).toBe('nothing_to_recognize')
  })

  it('reports a recognizer that is not installed as unavailable', async () => {
    const { module } = makeModule({ stt: refusingStt(new SttError('unavailable', 'no local recognizer')) })
    await module.press()
    await module.release()
    expect(module.state()).toBe('error')
    expect(module.snapshot().reason).toBe('recognize-unavailable')
    expect(module.snapshot().detail).toBe('no local recognizer')
  })

  it('reports a recognizer that refused', async () => {
    const { module } = makeModule({ stt: refusingStt(new SttError('refused', 'bad key')) })
    await module.press()
    await module.release()
    expect(module.state()).toBe('error')
    expect(module.snapshot().reason).toBe('recognize-failed')
    expect(module.snapshot().detail).toBe('bad key')
  })

  it('treats an interrupted recognition as no failure at all', async () => {
    const { module } = makeModule({ stt: refusingStt(new SttError('aborted', 'cancelled')) })
    await module.press()
    await module.release()
    expect(module.state()).toBe('idle')
    expect(module.snapshot().reason).toBe('')
  })

  it('reports an untyped recognizer failure', async () => {
    const { module } = makeModule({ stt: refusingStt(new Error('socket closed')) })
    await module.press()
    await module.release()
    expect(module.snapshot().reason).toBe('recognize-failed')
    expect(module.snapshot().detail).toBe('socket closed')
  })

  it('reports a failure that is not an Error as text', async () => {
    const { module } = makeModule({ stt: refusingStt('flat refusal') })
    await module.press()
    await module.release()
    expect(module.snapshot().detail).toBe('flat refusal')
  })

  it('treats a clip with no speech as silence, not as a failure', async () => {
    const { module, submit } = makeModule({ stt: makeStt('') })
    await module.press()
    await module.release()
    expect(module.state()).toBe('idle')
    expect(module.snapshot().reason).toBe('nothing-recognized')
    expect(submit).not.toHaveBeenCalled()
  })

  it('reports a conversation that refuses the text', async () => {
    const submit = vi.fn(() => { throw new Error('session is closed') })
    const { module } = makeModule({ turn: { submit, awaitAnswer: vi.fn() } })
    await module.press()
    await module.release()
    expect(module.state()).toBe('error')
    expect(module.snapshot().reason).toBe('send-failed')
    expect(module.snapshot().detail).toBe('session is closed')
  })

  it('reports a conversation failure that is not an Error as text', async () => {
    const { module } = makeModule({ turn: { submit: () => { throw 'nope' } } })
    await module.press()
    await module.release()
    expect(module.snapshot().detail).toBe('nope')
  })

  it('stops after sending when the reply mode is off', async () => {
    const { module, speaker, submit } = makeModule({ replyMode: () => 'off' })
    await module.press()
    await module.release()
    expect(submit).toHaveBeenCalledWith('привет')
    expect(speaker.said).toEqual([])
    expect(module.state()).toBe('idle')
  })

  it('stops after sending when nobody waits for an answer', async () => {
    const { module, speaker } = makeModule({ turn: { submit: vi.fn() } })
    await module.press()
    await module.release()
    expect(speaker.said).toEqual([])
    expect(module.state()).toBe('idle')
  })

  it('says nothing when the turn produced no answer', async () => {
    const { module, speaker } = makeModule({ turn: { submit: vi.fn(), awaitAnswer: async () => '   ' } })
    await module.press()
    await module.release()
    expect(speaker.said).toEqual([])
    expect(module.state()).toBe('idle')
    expect(module.snapshot().reason).toBe('')
  })

  it('reports a turn that failed', async () => {
    const awaitAnswer = async (): Promise<string> => { throw new Error('model unreachable') }
    const { module, speaker } = makeModule({ turn: { submit: vi.fn(), awaitAnswer } })
    await module.press()
    await module.release()
    expect(module.state()).toBe('error')
    expect(module.snapshot().reason).toBe('answer-failed')
    expect(module.snapshot().detail).toBe('model unreachable')
    expect(speaker.said).toEqual([])
  })

  it('reports a turn failure that is not an Error as text', async () => {
    const awaitAnswer = async (): Promise<string> => { throw 'timeout' }
    const { module } = makeModule({ turn: { submit: vi.fn(), awaitAnswer } })
    await module.press()
    await module.release()
    expect(module.snapshot().detail).toBe('timeout')
  })

  it('gives up on a turn that never finishes, and ignores its late answer', async () => {
    let answerLater: ((text: string) => void) | undefined
    const awaitAnswer = (): Promise<string> => new Promise((resolve) => { answerLater = resolve })
    const { module, speaker, timers } = makeModule({ turn: { submit: vi.fn(), awaitAnswer } })
    await module.press()
    const running = module.release()
    await settle()
    expect(module.state()).toBe('thinking')
    expect(timers.pending()).toBe(1)
    timers.fire()
    expect(module.state()).toBe('error')
    expect(module.snapshot().reason).toBe('answer-timeout')
    answerLater?.('слишком поздно')
    await running
    expect(speaker.said).toEqual([])
    expect(module.state()).toBe('error')
  })

  it('reports an answer that could not be read aloud', async () => {
    const { module } = makeModule({ speaker: makeSpeaker('failed') })
    await module.press()
    await module.release()
    expect(module.state()).toBe('error')
    expect(module.snapshot().reason).toBe('speak-failed')
  })

  it('accepts an answer the engine reports as unavailable without failing', async () => {
    const { module } = makeModule({ speaker: makeSpeaker('unavailable') })
    await module.press()
    await module.release()
    expect(module.state()).toBe('idle')
    expect(module.snapshot().reason).toBe('')
  })
})

describe('interrupting', () => {
  it('abandons the microphone and the voice', async () => {
    const { module, capture, speaker } = makeModule()
    await module.press()
    module.interrupt()
    expect(module.state()).toBe('idle')
    expect(capture.cancels).toBe(1)
    expect(speaker.cancels).toBe(1)
    expect(module.snapshot().reason).toBe('')
  })

  it('ignores a recognition that arrives after the interruption', async () => {
    let recognizeLater: ((text: string) => void) | undefined
    const stt: SttEngine = {
      kind: 'local',
      isAvailable: () => true,
      transcribe: (): Promise<{ text: string, engine: 'local', durationMs: number }> =>
        new Promise((resolve) => {
          recognizeLater = (text) => { resolve({ text, engine: 'local', durationMs: 1 }) }
        }),
    }
    const { module, submit } = makeModule({ stt })
    await module.press()
    const running = module.release()
    await settle()
    module.interrupt()
    recognizeLater?.('опоздал')
    await running
    expect(module.state()).toBe('idle')
    expect(submit).not.toHaveBeenCalled()
  })

  it('ignores a spoken answer that finishes after the interruption', async () => {
    let speakLater: ((outcome: SpeakOutcome) => void) | undefined
    const speaker: Speaker = {
      isAvailable: () => true,
      speak: (): Promise<SpeakOutcome> => new Promise((resolve) => { speakLater = resolve }),
      cancel: vi.fn(),
    }
    const { module } = makeModule({ speaker })
    await module.press()
    const running = module.release()
    await settle()
    expect(module.state()).toBe('speaking')
    module.interrupt()
    speakLater?.('spoken')
    await running
    expect(module.state()).toBe('idle')
    expect(module.snapshot().reason).toBe('')
  })
})

describe('disposing', () => {
  it('releases the microphone, silences the voice, and stops notifying', async () => {
    const { module, capture, speaker, states } = makeModule()
    const before = states.length
    module.dispose()
    expect(capture.disposals).toBe(1)
    expect(speaker.cancels).toBe(1)
    expect(module.state()).toBe('idle')
    expect(states.length).toBe(before)
  })

  it('stops notifying a listener that unsubscribed', async () => {
    const { module } = makeModule()
    const listener = vi.fn()
    const unsubscribe = module.subscribe(listener)
    await module.press()
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    module.interrupt()
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('the microphone the module builds for itself', () => {
  it('reports that this runtime cannot record', async () => {
    const module = createVoiceModule({ turn: { submit: vi.fn() } })
    await module.press()
    expect(module.snapshot().reason).toBe('capture-unavailable')
  })

  it('silences the voice it built for itself', () => {
    const module = createVoiceModule({ turn: { submit: vi.fn() } })
    expect(() => { module.interrupt() }).not.toThrow()
  })
})

describe('the seams the module builds for itself', () => {
  it('reads the reply mode, the clock, and the timers from the app when none are given', async () => {
    const capture = makeCapture({ clip })
    const stt = makeStt('через свои настройки')
    const speaker = makeSpeaker()
    const submit = vi.fn()
    // Only the conversation is supplied: the reply mode comes from the stored
    // settings, the clock from the runtime, and the watchdog from setTimeout.
    const module = createVoiceModule({ capture, stt, speaker, turn: { submit, awaitAnswer: async () => 'ответ' } })
    expect(module.snapshot().reason).toBe('')
    await module.press()
    await module.release()
    expect(submit).toHaveBeenCalledWith('через свои настройки')
    expect(speaker.said).toEqual(['ответ'])
    expect(module.state()).toBe('idle')
  })

  it('stays silent when the stored settings say so', async () => {
    localStorage.setItem('dsh.voice.settings', JSON.stringify({ voiceReplyMode: 'off' }))
    const capture = makeCapture({ clip })
    const speaker = makeSpeaker()
    const submit = vi.fn()
    const module = createVoiceModule({
      capture, stt: makeStt(), speaker, turn: { submit, awaitAnswer: async () => 'ответ' },
    })
    await module.press()
    await module.release()
    expect(submit).toHaveBeenCalledTimes(1)
    expect(speaker.said).toEqual([])
    localStorage.clear()
  })
})

describe('a capture that finishes late', () => {
  /** A capture whose start and stop finish only when the spec says so. */
  function deferredCapture(): {
    capture: AudioCapture
    open: () => void
    close: () => void
  } {
    let openStart: (() => void) | undefined
    let openStop: (() => void) | undefined
    return {
      capture: {
        state: () => 'idle',
        snapshot: () => ({ state: 'idle', startedAt: undefined, lastError: '', lastErrorName: '' }),
        subscribe: () => () => {},
        start: (): Promise<void> => new Promise((resolve) => { openStart = resolve }),
        stop: (): Promise<CapturedClip | undefined> => new Promise((resolve) => { openStop = () => { resolve(clip) } }),
        cancel: (): void => {},
        dispose: (): void => {},
      },
      open: () => { openStart?.() },
      close: () => { openStop?.() },
    }
  }

  it('ignores a microphone that opened after the interruption', async () => {
    const deferred = deferredCapture()
    const { module } = makeModule({ capture: deferred.capture })
    const pressing = module.press()
    module.interrupt()
    deferred.open()
    await pressing
    expect(module.state()).toBe('idle')
  })

  it('ignores a clip that arrived after the interruption', async () => {
    const deferred = deferredCapture()
    const { module, submit } = makeModule({ capture: deferred.capture })
    const pressing = module.press()
    deferred.open()
    await pressing
    expect(module.state()).toBe('listening')
    const releasing = module.release()
    module.interrupt()
    deferred.close()
    await releasing
    expect(module.state()).toBe('idle')
    expect(submit).not.toHaveBeenCalled()
  })
})

describe('a failure that arrives after the interruption', () => {
  it('ignores a recognition that failed late', async () => {
    let refuse: ((reason: unknown) => void) | undefined
    const stt: SttEngine = {
      kind: 'local',
      isAvailable: () => true,
      transcribe: (): Promise<never> => new Promise((_resolve, reject) => {
        refuse = (reason) => { reject(reason) }
      }),
    }
    const { module } = makeModule({ stt })
    await module.press()
    const running = module.release()
    await settle()
    module.interrupt()
    refuse?.(new Error('socket closed'))
    await running
    expect(module.state()).toBe('idle')
    expect(module.snapshot().reason).toBe('')
  })

  it('ignores a turn that failed late', async () => {
    let refuse: ((reason: unknown) => void) | undefined
    const awaitAnswer = (): Promise<string> => new Promise((_resolve, reject) => {
      refuse = (reason) => { reject(reason) }
    })
    const { module } = makeModule({ turn: { submit: vi.fn(), awaitAnswer } })
    await module.press()
    const running = module.release()
    await settle()
    expect(module.state()).toBe('thinking')
    module.interrupt()
    refuse?.(new Error('model gone'))
    await running
    expect(module.state()).toBe('idle')
    expect(module.snapshot().reason).toBe('')
  })
})

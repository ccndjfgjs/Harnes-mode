// @vitest-environment jsdom
// Audio formatting: the pure half of "microphone → WAV". No device, no browser
// state — every branch here is arithmetic that a recognizer depends on.

import { describe, expect, it } from 'vitest'
import {
  WHISPER_SAMPLE_RATE, downmixToMono, durationMsOf, encodeWav16, resampleTo16k, toRecognizerWav,
} from '../src/voice/audio-format.ts'

/** Read one ASCII tag out of a WAVE header. */
function tagOf(view: DataView, offset: number): string {
  let text = ''
  for (let index = 0; index < 4; index += 1) text += String.fromCharCode(view.getUint8(offset + index))
  return text
}

describe('downmixToMono', () => {
  it('answers nothing for no channels', () => {
    expect(downmixToMono([]).length).toBe(0)
  })

  it('returns the single channel untouched', () => {
    const only = new Float32Array([0.1, 0.2])
    expect(downmixToMono([only])).toBe(only)
  })

  it('averages two channels rather than dropping one', () => {
    const left = new Float32Array([1, 0])
    const right = new Float32Array([0, 1])
    expect(Array.from(downmixToMono([left, right]))).toEqual([0.5, 0.5])
  })

  it('tolerates a short channel by treating the missing sample as silence', () => {
    const long = new Float32Array([1, 1])
    const short = new Float32Array([1])
    expect(Array.from(downmixToMono([long, short]))).toEqual([1, 0.5])
  })
})

describe('resampleTo16k', () => {
  it('returns the input untouched when it is already at the target rate', () => {
    const samples = new Float32Array([0.1, 0.2])
    expect(resampleTo16k(samples, WHISPER_SAMPLE_RATE)).toBe(samples)
  })

  it('answers nothing for an unusable rate', () => {
    expect(resampleTo16k(new Float32Array([1]), 0).length).toBe(0)
  })

  it('answers nothing for an empty input', () => {
    expect(resampleTo16k(new Float32Array(0), 48000).length).toBe(0)
  })

  it('halves a 32 kHz input by interpolating between samples', () => {
    const output = resampleTo16k(new Float32Array([0, 1, 0, 1]), 32000)
    expect(output.length).toBe(2)
    expect(Array.from(output)).toEqual([0, 0])
  })

  it('doubles an 8 kHz input', () => {
    const output = resampleTo16k(new Float32Array([0, 1]), 8000)
    expect(output.length).toBe(4)
    expect(output[0]).toBe(0)
    expect(output[3]).toBeCloseTo(1, 5)
  })

  it('keeps at least one sample for a rate far above the target', () => {
    expect(resampleTo16k(new Float32Array([0.5]), 192000).length).toBe(1)
  })
})

describe('encodeWav16', () => {
  it('writes a canonical 16-bit mono header', async () => {
    const blob = encodeWav16(new Float32Array([0, 0]), 16000)
    const view = new DataView(await blob.arrayBuffer())
    expect(tagOf(view, 0)).toBe('RIFF')
    expect(view.getUint32(4, true)).toBe(44 - 8 + 4)
    expect(tagOf(view, 8)).toBe('WAVE')
    expect(tagOf(view, 12)).toBe('fmt ')
    expect(view.getUint32(16, true)).toBe(16)
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(16000)
    expect(view.getUint32(28, true)).toBe(32000)
    expect(view.getUint16(32, true)).toBe(2)
    expect(view.getUint16(34, true)).toBe(16)
    expect(tagOf(view, 36)).toBe('data')
    expect(view.getUint32(40, true)).toBe(4)
  })

  it('names the clip audio/wav', () => {
    expect(encodeWav16(new Float32Array(0), 16000).type).toBe('audio/wav')
  })

  it('keeps the two ends of the range at full scale', async () => {
    const view = new DataView(await encodeWav16(new Float32Array([1, -1]), 16000).arrayBuffer())
    expect(view.getInt16(44, true)).toBe(0x7fff)
    expect(view.getInt16(46, true)).toBe(-0x8000)
  })

  it('clips a loud sample instead of wrapping it to the opposite sign', async () => {
    const view = new DataView(await encodeWav16(new Float32Array([2, -2]), 16000).arrayBuffer())
    expect(view.getInt16(44, true)).toBe(0x7fff)
    expect(view.getInt16(46, true)).toBe(-0x8000)
  })

  it('scales a quiet sample by the positive full-scale factor', async () => {
    const view = new DataView(await encodeWav16(new Float32Array([0.5]), 16000).arrayBuffer())
    expect(view.getInt16(44, true)).toBe(Math.trunc(0.5 * 0x7fff))
  })
})

describe('toRecognizerWav', () => {
  it('turns a stereo 48 kHz recording into the shape a recognizer accepts', async () => {
    const left = new Float32Array(48000).fill(0.25)
    const right = new Float32Array(48000).fill(0.75)
    const blob = toRecognizerWav([left, right], 48000)
    const view = new DataView(await blob.arrayBuffer())
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(WHISPER_SAMPLE_RATE)
    // One second of audio, averaged across the two channels.
    expect(view.getUint32(40, true)).toBe(16000 * 2)
    expect(view.getInt16(44, true)).toBe(Math.trunc(0.5 * 0x7fff))
  })
})

describe('durationMsOf', () => {
  it('converts a sample count into milliseconds', () => {
    expect(durationMsOf(16000, 16000)).toBe(1000)
    expect(durationMsOf(8000, 16000)).toBe(500)
  })

  it('answers zero for an unusable rate', () => {
    expect(durationMsOf(16000, 0)).toBe(0)
  })
})

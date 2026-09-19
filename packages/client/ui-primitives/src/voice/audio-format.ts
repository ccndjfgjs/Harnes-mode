/**
 * Audio formatting for the voice module: the pure part of "microphone → WAV".
 *
 * These functions hold no browser state and touch no device, so they are the
 * one place where the sample maths lives and the one place a test can pin it
 * down exactly. The capture engine next door owns the microphone; this leaf
 * owns what the captured samples turn into.
 *
 * Whisper-class recognizers expect 16 kHz mono 16-bit PCM, so every path that
 * feeds recognition ends at {@link encodeWav16}: browsers hand over their own
 * rate (usually 48 kHz) and often two channels, and the recognizer rejects
 * anything else.
 */

/** Sample rate every local recognizer is fed. */
export const WHISPER_SAMPLE_RATE = 16000

/** Bytes per sample in the 16-bit PCM output. */
const BYTES_PER_SAMPLE = 2

/** Header size of a canonical WAVE file with a 16-byte `fmt ` chunk. */
const WAV_HEADER_BYTES = 44

/**
 * Write one ASCII tag into a data view.
 * @param view - target view.
 * @param offset - byte offset of the tag.
 * @param tag - exactly four characters.
 */
function writeTag(view: DataView, offset: number, tag: string): void {
  for (let index = 0; index < tag.length; index += 1) {
    view.setUint8(offset + index, tag.charCodeAt(index))
  }
}

/**
 * Mix any number of channels into one, averaging them.
 *
 * A recognizer takes mono only; dropping the extra channels would silently lose
 * whatever was panned to them, so they are averaged instead.
 * @param channels - decoded channels, all the same length.
 * @returns one channel of that length, or an empty buffer when there are none.
 */
export function downmixToMono(channels: readonly Float32Array[]): Float32Array {
  const first = channels[0]
  if (first === undefined) return new Float32Array(0)
  if (channels.length === 1) return first
  const output = new Float32Array(first.length)
  for (let index = 0; index < first.length; index += 1) {
    let sum = 0
    for (const channel of channels) sum += channel[index] ?? 0
    output[index] = sum / channels.length
  }
  return output
}

/**
 * Resample one channel to the recognizer's rate by linear interpolation.
 *
 * Linear interpolation is deliberate: the microphone feed is speech, not music,
 * and a resampler with a longer kernel would cost latency the module cannot
 * spend. An input already at the target rate is returned untouched.
 * @param input - one channel of samples.
 * @param inputRate - the rate those samples were captured at, in Hz.
 * @returns samples at {@link WHISPER_SAMPLE_RATE}.
 */
export function resampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === WHISPER_SAMPLE_RATE) return input
  if (inputRate <= 0 || input.length === 0) return new Float32Array(0)
  const ratio = inputRate / WHISPER_SAMPLE_RATE
  const length = Math.max(1, Math.round(input.length / ratio))
  const output = new Float32Array(length)
  const last = input.length - 1
  for (let index = 0; index < length; index += 1) {
    const position = index * ratio
    // Both indexes are clamped into the buffer, so the two reads are total. The
    // casts state that: an out-of-range read cannot happen here, and inventing a
    // silence for it would hide a rounding bug rather than report one.
    const left = Math.min(Math.floor(position), last)
    const right = Math.min(left + 1, last)
    const weight = position - left
    const from = input[left] as number
    const to = input[right] as number
    output[index] = from + (to - from) * weight
  }
  return output
}

/**
 * Encode one channel as a 16-bit PCM mono WAVE file.
 *
 * Samples are clamped rather than wrapped: a clipped loud passage should sound
 * clipped, not turn into noise of the opposite sign.
 * @param samples - one channel of samples in the -1..1 range.
 * @param sampleRate - the rate those samples are at, in Hz.
 * @returns a `audio/wav` blob ready to send or store.
 */
export function encodeWav16(samples: Float32Array, sampleRate: number): Blob {
  const dataBytes = samples.length * BYTES_PER_SAMPLE
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes)
  const view = new DataView(buffer)
  writeTag(view, 0, 'RIFF')
  view.setUint32(4, WAV_HEADER_BYTES - 8 + dataBytes, true)
  writeTag(view, 8, 'WAVE')
  writeTag(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true)
  view.setUint16(32, BYTES_PER_SAMPLE, true)
  view.setUint16(34, 16, true)
  writeTag(view, 36, 'data')
  view.setUint32(40, dataBytes, true)
  for (let index = 0; index < samples.length; index += 1) {
    // Dense Float32Array: every index below length is present, so the cast is a
    // statement about the buffer rather than a hope.
    const sample = Math.max(-1, Math.min(1, samples[index] as number))
    view.setInt16(WAV_HEADER_BYTES + index * BYTES_PER_SAMPLE, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true)
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

/**
 * Turn one decoded recording into the exact audio a recognizer wants.
 *
 * The whole path in one call, so no caller has to remember the order of
 * downmix, resample, and encode.
 * @param channels - decoded channels, all the same length.
 * @param inputRate - the rate those channels were decoded at, in Hz.
 * @returns a 16 kHz mono 16-bit WAVE blob.
 */
export function toRecognizerWav(channels: readonly Float32Array[], inputRate: number): Blob {
  const mono = downmixToMono(channels)
  return encodeWav16(resampleTo16k(mono, inputRate), WHISPER_SAMPLE_RATE)
}

/**
 * How long a buffer of samples lasts.
 * @param sampleCount - number of samples.
 * @param sampleRate - the rate those samples are at, in Hz.
 * @returns duration in milliseconds, or 0 when the rate is unusable.
 */
export function durationMsOf(sampleCount: number, sampleRate: number): number {
  if (sampleRate <= 0) return 0
  return Math.round((sampleCount / sampleRate) * 1000)
}

/**
 * Read-aloud engine for the Accessibility voice: speaks through the provider
 * the user selected, through the legacy configured service, through Google's
 * keyless engine when there is none, and through the browser's own voice when
 * it can actually pronounce the answer.
 *
 * The built-in Web Speech engine is genuinely local, but its Russian voice is
 * not guaranteed: a packaged desktop build ships no Google voice, so on a
 * machine without a Russian system voice it reads Russian text with whatever
 * voice it has. Preferring the built-in engine unconditionally is therefore
 * what makes the read-aloud unusable in the desktop app, so the engine is
 * chosen per utterance: a selected provider or a configured service always
 * wins, the built-in voice wins only when it offers a Russian voice, and Google
 * answers otherwise. A remote failure falls back to the built-in voice, so a
 * broken or unreachable service degrades instead of going silent.
 *
 * The plan carries the answer voice, model, rate, and pitch, so the chosen
 * voice reaches the host with every utterance rather than being decided there.
 *
 * A dependency-free leaf (like speech-synthesis.ts), so any client package may
 * import it without bundle-purity edges.
 */

import { cancelSpeech, isSpeechSynthesisAvailable, pickRussianVoice, setTtsBackend, speak } from './speech-synthesis.ts'
import type { SpeakOptions, SpeechLifecycle, TtsBackend } from './speech-synthesis.ts'
import { VOICE_KEY_HEADER, VOICE_URL_HEADER, readVoiceEndpoints, readVoiceSelection } from './voice-endpoint.ts'
import type { VoiceEndpoint } from './voice-endpoint.ts'
import { resolveTtsModel, resolveVoice, voiceProvider, type VoiceProviderId } from './voice-providers.ts'
import { readVoiceModuleSettings } from './voice/voice-module-settings.ts'

/** Host route that synthesizes one clip; the renderer never calls a TTS host directly. */
export const SPEECH_ROUTE = '/api/media/speak'

/** Language the read-aloud asks for. */
const SPEECH_LANG = 'ru-RU'

/** Which engine one utterance drives. */
export type SpeechEngineChoice =
  /** The text-to-speech service the user configured in Voice Settings. */
  | 'service'
  /** The browser's own voice, used only when it has a Russian voice. */
  | 'browser'
  /** Google's keyless engine, reached through the host route. */
  | 'google'
  /** The provider the user selected by name. */
  | 'provider'

/** Everything one utterance needs: which engine, which voice, how fast. */
export interface SpeechPlan {
  /** Engine to drive. */
  readonly engine: SpeechEngineChoice
  /** Provider the host should shape the request for. */
  readonly provider: VoiceProviderId
  /** Answer voice to ask for, or '' to let the provider decide. */
  readonly voice: string
  /** Provider model, or '' when none applies. */
  readonly model: string
  /** Speech rate multiplier. */
  readonly speed: number
  /** Pitch multiplier. */
  readonly pitch: number
}

/**
 * Whether the built-in engine offers a Russian voice. The voice list fills
 * asynchronously in some engines, so this is consulted per utterance rather
 * than cached at boot.
 * @returns true only when a Russian voice is actually listed.
 */
function hasRussianVoice(): boolean {
  if (!isSpeechSynthesisAvailable()) return false
  try {
    return pickRussianVoice(speechSynthesis.getVoices()) !== undefined
  } catch {
    return false
  }
}

/**
 * Choose the engine for one utterance under the `auto` provider.
 * @returns 'service' when an endpoint is configured, 'browser' when the
 * built-in voice can pronounce Russian, 'google' otherwise.
 */
export function chooseSpeechEngine(): SpeechEngineChoice {
  if (readVoiceEndpoints().tts.url !== '') return 'service'
  return hasRussianVoice() ? 'browser' : 'google'
}

/**
 * Decide everything one utterance needs. An explicitly selected provider wins;
 * `auto` keeps the shipped order (configured service, built-in Russian voice,
 * Google's keyless engine).
 * @returns the plan the engine drives.
 */
export function planSpeech(): SpeechPlan {
  const selection = readVoiceSelection()
  const chosen = voiceProvider(selection.provider)
  let engine: SpeechEngineChoice
  let provider: VoiceProviderId
  if (selection.provider === 'auto') {
    engine = chooseSpeechEngine()
    // The legacy endpoint pair is what a configured service means, so voice
    // resolution reads the provider that owns a plain URL-and-key service.
    provider = engine === 'service' ? 'custom' : engine === 'google' ? 'google' : 'system'
  } else {
    provider = selection.provider
    // A provider without a synthesis face cannot answer; the built-in voice is
    // the only honest engine left.
    /* v8 ignore next -- every selectable provider but `auto` carries a synthesis face, and `auto` never reaches this branch. */
    if (chosen?.tts === undefined) engine = 'browser'
    else if (provider === 'google') engine = 'google'
    else if (provider === 'system') engine = 'browser'
    else engine = 'provider'
  }
  const face = voiceProvider(provider)
  const model = resolveTtsModel(face, selection.ttsModel)
  return {
    engine,
    provider,
    /* v8 ignore next -- the provider resolved above always has a face, so there is no empty-voice arm to take. */
    voice: face === undefined ? '' : resolveVoice(face, 'tts', selection.ttsVoiceId),
    model,
    speed: selection.ttsSpeed,
    pitch: selection.ttsPitch,
  }
}

/**
 * Build the endpoint override headers for one request.
 * @param endpoint - the configured service, or undefined for the provider default.
 * @returns headers naming the service, empty on the keyless path.
 */
function endpointHeaders(endpoint: VoiceEndpoint | undefined): Record<string, string> {
  if (endpoint === undefined || endpoint.url === '') return {}
  return {
    [VOICE_URL_HEADER]: endpoint.url,
    ...endpoint.key === '' ? {} : { [VOICE_KEY_HEADER]: endpoint.key },
  }
}

/**
 * Ask the host to synthesize one clip.
 * @param plan - the utterance plan, carrying provider, voice, and pacing.
 * @param text - text to speak.
 * @param endpoint - the configured service, or undefined for the provider default.
 * @param signal - aborts the request when a new utterance starts.
 * @returns the audio clip.
 * @throws {Error} when the host refuses or the transport fails.
 */
async function requestSpeech(
  plan: SpeechPlan,
  text: string,
  endpoint: VoiceEndpoint | undefined,
  signal: AbortSignal,
): Promise<Blob> {
  const response = await fetch(SPEECH_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...endpointHeaders(endpoint) },
    body: JSON.stringify({
      text,
      lang: SPEECH_LANG,
      provider: plan.provider,
      voice: plan.voice,
      model: plan.model,
      speed: plan.speed,
      pitch: plan.pitch,
    }),
    signal,
  })
  if (!response.ok) throw new Error(`speech HTTP ${response.status}`)
  return await response.blob()
}

/**
 * Mint a playable URL for one clip.
 * @param blob - the synthesized clip.
 * @returns the object URL.
 * @throws {Error} when the runtime has no object URLs.
 */
function createObjectUrl(blob: Blob): string {
  const create = (globalThis as { URL?: { createObjectURL?: (blob: Blob) => string } }).URL?.createObjectURL
  if (create === undefined) throw new Error('object URLs are unavailable')
  return create(blob)
}

/**
 * Release a previously minted object URL.
 * @param url - the object URL to release.
 */
function releaseObjectUrl(url: string): void {
  ;(globalThis as { URL?: { revokeObjectURL?: (url: string) => void } }).URL?.revokeObjectURL?.(url)
}

/**
 * Route an element to one audio output endpoint, when the runtime allows it.
 *
 * `setSinkId` is not universally present (and is refused outright in some
 * embedded contexts), so this is a best-effort step: a runtime without it, or
 * one that rejects the id, keeps playing through the system default. The
 * rejection is swallowed on purpose — failing to move the sound is not failing
 * to speak, and the caller has no way to recover from it either way.
 * @param element - the playing element.
 * @param deviceId - the endpoint to use, or '' for the system default.
 */
function routeToOutput(element: HTMLAudioElement, deviceId: string): void {
  if (deviceId === '') return
  const sinkable = element as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }
  if (typeof sinkable.setSinkId !== 'function') return
  void sinkable.setSinkId(deviceId).catch(() => {
    // The runtime refused this endpoint; the system default still plays it.
  })
}

/**
 * Start playing one clip.
 *
 * The report is always wired, never conditional: the caller above always has
 * a watcher to forward to, and it is a no-op when nobody asked to watch. Wiring
 * it conditionally would only add a branch that can never be taken.
 * @param source - the clip URL.
 * @param rate - playback rate; 1 keeps the clip as synthesized.
 * @param report - told when the clip starts, ends, or fails to play.
 * @returns the playing element, so the next utterance can stop it.
 * @throws {Error} when the runtime has no audio element.
 */
function startPlayback(source: string, rate: number, report: (event: SpeechLifecycle) => void): HTMLAudioElement {
  const AudioCtor = (globalThis as { Audio?: new (source?: string) => HTMLAudioElement }).Audio
  if (AudioCtor === undefined) throw new Error('audio playback is unavailable')
  const element = new AudioCtor(source)
  element.playbackRate = rate
  // The chosen output is read per utterance, so changing it in the settings
  // applies to the next answer rather than after a reload.
  routeToOutput(element, readVoiceModuleSettings().outputDeviceId)
  element.onplaying = (): void => { report('start') }
  element.onended = (): void => { report('end') }
  element.onerror = (): void => { report('error') }
  void element.play().catch(() => {
    // Autoplay refusal is not a synthesis failure: the clip stays silent.
  })
  return element
}

/**
 * Build the read-aloud engine.
 * @returns a backend that speaks through the selected provider, the configured
 * service, Google, or the built-in voice, and that stops cleanly on cancel.
 */
export function createSpeechEngine(): TtsBackend {
  let controller: AbortController | undefined
  let clip: HTMLAudioElement | undefined
  let clipUrl: string | undefined
  /** Watcher of the utterance that is still current, if any. */
  let lifecycle: ((event: SpeechLifecycle) => void) | undefined

  /**
   * Report one event to the current utterance's watcher.
   *
   * The watcher is forgotten only once the utterance is over: a start is the
   * middle of an utterance's life, not the end of it, so forgetting it there
   * would swallow the very completion the caller is waiting for.
   * @param event - how the utterance ended, or that it began.
   */
  const finish = (event: SpeechLifecycle): void => {
    const report = lifecycle
    if (event !== 'start') lifecycle = undefined
    report?.(event)
  }

  /** Stop the remote clip and any built-in utterance. */
  const cancel = (): void => {
    controller?.abort()
    controller = undefined
    clip?.pause()
    clip = undefined
    if (clipUrl !== undefined) releaseObjectUrl(clipUrl)
    clipUrl = undefined
    cancelSpeech()
    // pause() fires no 'ended', so the watcher is told here: a cancelled
    // utterance must settle rather than leave its caller waiting for a
    // completion that will never arrive.
    finish('end')
  }

  /** Play one synthesized clip, replacing whatever was playing. */
  const play = (blob: Blob, rate: number, report: (event: SpeechLifecycle) => void): void => {
    if (clipUrl !== undefined) releaseObjectUrl(clipUrl)
    clipUrl = createObjectUrl(blob)
    clip = startPlayback(clipUrl, rate, report)
  }

  /** Speak through the host route, degrading to the built-in voice. */
  const speakRemotely = (plan: SpeechPlan, text: string, endpoint: VoiceEndpoint | undefined): void => {
    const current = new AbortController()
    controller = current
    // The keyless Google path bakes no pacing into the clip (its endpoint
    // takes text and lang only), so the stored speed is applied at playback.
    // Adapter providers bake it in — applying it again here would double it.
    const keyless = (plan.provider === 'google' || plan.provider === 'custom')
      && (endpoint?.url ?? '') === ''
    void requestSpeech(plan, text, endpoint, current.signal)
      .then((blob) => {
        // A cancel while the clip was in flight settles the utterance here.
        if (current.signal.aborted) return
        play(blob, keyless ? plan.speed : 1, (event) => { finish(event) })
      })
      .catch(() => {
        // A cancel is not a failure; a real failure degrades to the built-in voice.
        if (!current.signal.aborted) speak(text, { rate: plan.speed, pitch: plan.pitch, onLifecycle: (event) => { finish(event) } })
        else finish('end')
      })
  }

  return {
    isAvailable: () => true,
    speak: (text: string, options?: SpeakOptions): void => {
      const plan = planSpeech()
      // A new utterance replaces the previous one; the replaced caller is told
      // it ended, exactly as the engine's own cancel-before-speak does.
      finish('end')
      lifecycle = options?.onLifecycle
      const rate = options?.rate ?? plan.speed
      const pitch = options?.pitch ?? plan.pitch
      if (plan.engine === 'browser') {
        speak(text, { rate, pitch, onLifecycle: (event) => { finish(event) } })
        return
      }
      // The legacy pair only describes the plain URL-and-key service; a named
      // provider carries no endpoint and lets the host adapter resolve its own.
      const endpoint = plan.provider === 'custom' || plan.provider === 'google'
        ? readVoiceEndpoints().tts
        : undefined
      speakRemotely(plan, text, endpoint)
    },
    cancel,
  }
}

/**
 * Install the read-aloud engine for the whole app.
 * @returns the disposer restoring the built-in backend.
 */
export function installSpeechEngine(): () => void {
  const engine = createSpeechEngine()
  setTtsBackend(engine)
  return (): void => {
    engine.cancel()
    setTtsBackend(null)
  }
}

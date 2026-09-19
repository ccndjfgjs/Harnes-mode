import { useEffect, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import clsx from 'clsx'
import {
  IconCallOutline16, IconMicOutline16, IconScreenOutline16, IconSparkle16, Tooltip,
  cancelSpeech, createSttEngine, createVoiceModule, readCallVoice,
  readScreenSettings, readVoiceEndpoints, readVoiceModuleSettings, screenCapture,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  ScreenCaptureSnapshot, VoiceEndpoint, VoiceFailureReason, VoiceModule,
  VoiceModuleSnapshot, VoiceModuleState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InputActions } from '../contract/input.ts'
import type { ConversationKey } from '../locales.ts'
import { playErrorTone, playSuccessTone } from './audio-feedback.ts'
import { checkVoiceService, hasRemoteVision, isSoundEnabled } from './media-service.ts'
import css from './MediaToolbar.module.css'

interface MediaToolbarProps {
  inputActions: InputActions
  t: (key: ConversationKey) => string
  /** Mirrors the composer's locked seat: no session, removed, blocked, or offline parent. */
  locked: boolean
  /** Mirrors adjudicating/submitting: the draft is read-only while the machine runs. */
  busy: boolean
  /** The live draft text, so the improve control can hand it to the model. */
  draft: string
  /**
   * Attach captured files to the composer draft. Absent outside a session
   * shell, which only removes the local screen-capture sink.
   */
  addImages?: ((files: readonly File[]) => string | null) | undefined
}

/** Capture surface the runtime may expose; lib.dom types it as always present. */
interface DeviceMediaFace {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>
  getDisplayMedia?: (constraints: DisplayMediaStreamOptions) => Promise<MediaStream>
}

/**
 * Probe the capture surface the runtime actually exposes. lib.dom types
 * mediaDevices as always present, but insecure contexts and older WebViews
 * omit it or parts of it — probe instead of trusting the types.
 * @returns the capture face, or undefined outside a capable context.
 */
function deviceMedia(): DeviceMediaFace | undefined {
  return (navigator as unknown as { mediaDevices?: DeviceMediaFace }).mediaDevices
}

/**
 * Build the per-request endpoint override headers the host gateway uses.
 * @param endpoint - the configured service.
 * @returns headers naming the service, empty when unconfigured.
 */
function mediaHeaders(endpoint: VoiceEndpoint): Record<string, string> {
  if (endpoint.url === '') return {}
  return {
    'x-dsh-media-url': endpoint.url,
    ...endpoint.key === '' ? {} : { 'x-dsh-media-key': endpoint.key },
  }
}

type MediaStatus = 'idle' | 'calling' | 'sharing'

/**
 * What the push-to-talk control says while it is busy.
 *
 * Only the three states stage one can reach answer with words: the module stops
 * after sending, so "waiting for the answer" and "reading it aloud" are not
 * states it enters yet. They join this mapping when the module owns the answer
 * as well, which is why the fall-through is a real answer rather than a gap.
 * @param state - the voice module's state.
 * @returns the locale key of the notice, or undefined when the control is quiet.
 */
function holdNoticeKey(state: VoiceModuleState): ConversationKey | undefined {
  if (state === 'listening') return 'media.speaking'
  if (state === 'recognizing') return 'media.voice.recognizing'
  if (state === 'sending') return 'media.voice.sending'
  return undefined
}

/**
 * Map the voice module's own failure to the notice the person can act on.
 *
 * The ones that deserve their own words are the ones a person would otherwise
 * misread: an empty recording looks like a broken microphone, a missing engine
 * looks like a broken app, unrecognized speech looks like a refusal to listen,
 * and a refused permission looks like a hardware fault — when the repair is one
 * switch in the Windows privacy settings. Everything else is a plain failure.
 * @param reason - why the module's last attempt ended short.
 * @returns the locale key of the notice to show.
 */
function holdFailureKey(reason: VoiceFailureReason): ConversationKey {
  if (reason === 'capture-unavailable') return 'media.unsupported.mic'
  if (reason === 'capture-denied') return 'media.voice.denied'
  if (reason === 'nothing-recorded') return 'media.voice.empty'
  if (reason === 'recognize-unavailable') return 'media.voice.engine.missing'
  if (reason === 'nothing-recognized') return 'media.voice.noText'
  return 'media.voice.failed'
}

/**
 * What the push-to-talk control is saying, if anything.
 *
 * A failure outlives the state that reported it: the module returns to rest
 * after "nothing was recorded", and the person still needs to read why their
 * sentence went nowhere. So the reason is consulted first and the busy-state
 * wording only after it.
 * @param snapshot - the module's latest snapshot.
 * @param t - dictionary reader.
 * @returns the sentence to show, or '' when the control is quiet.
 */
function holdNoticeOf(snapshot: VoiceModuleSnapshot, t: (key: ConversationKey) => string): string {
  if (snapshot.reason !== '') return t(holdFailureKey(snapshot.reason))
  const key = holdNoticeKey(snapshot.state)
  return key === undefined ? '' : t(key)
}

/** Composer media controls: one voice control, the realtime call, and screen
 *  capture, plus the leading "improve the draft" control that hands the typed
 *  text to the model and writes the answer back into the composer.
 *  Always mounted with the resident composer bar; every permission request
 *  stays behind an explicit click. Visuals reuse the tool-row icon-button
 *  shape (28px circle) so the controls sit naturally beside send.
 *
 *  The voice control is the push-to-talk module, not a browser recognizer:
 *  Chromium's Web Speech engine is *server-backed*, so a packaged desktop build
 *  carries no credentials for it and it refuses every attempt. The module uses
 *  the machine's own recognizer instead, which is what makes the desktop
 *  application work with nothing configured. It replaced a second microphone
 *  button that looked identical and behaved differently — one microphone, one
 *  behaviour (see media-service.ts for the call's remaining preflight). */
export function MediaToolbar({ inputActions, t, locked, busy, draft, addImages }: MediaToolbarProps) {
  const [status, setStatus] = useState<MediaStatus>('idle')
  const [notice, setNotice] = useState('')
  const [preview, setPreview] = useState<string | null>(null)
  // The single voice control subscribes to the module's snapshot, so the button
  // state, its aria-pressed value, and the notice line all come from one source.
  const [hold, setHold] = useState<VoiceModuleSnapshot | undefined>(undefined)
  const voice = useRef<VoiceModule | undefined>(undefined)
  // Draft improvement is its own axis: it never touches the capture state, and
  // the in-flight call is aborted when the toolbar unmounts.
  const [improving, setImproving] = useState(false)
  const improveAbort = useRef<AbortController | undefined>(undefined)
  const microphone = useRef<MediaStream | undefined>(undefined)
  const callSocket = useRef<WebSocket | undefined>(undefined)
  const peer = useRef<RTCPeerConnection | undefined>(undefined)
  const remoteAudio = useRef<HTMLAudioElement | undefined>(undefined)
  // The screen broadcast is an app-wide subsystem, not a child of this toolbar
  // (see screen-capture-engine). This component starts it, watches it, and
  // takes frames from it; unmounting only stops watching.
  const capture = screenCapture()
  /** Latest consumer reaction, kept in a ref so subscribing happens once. */
  const react = useRef<(snapshot: ScreenCaptureSnapshot) => void>(() => {})

  useEffect(() => {
    const unsubscribe = capture.subscribe((snapshot) => { react.current(snapshot) })
    // Unsubscribing is the whole cleanup: switching chats, closing this panel,
    // or leaving the section must not end a broadcast the user started.
    return unsubscribe
  }, [capture])

  useEffect(() => () => {
    improveAbort.current?.abort()
    stopVoiceRun()
    // The module holds a microphone, a recognizer, and a voice; unmounting the
    // composer must give all three back rather than leave a recording running.
    voice.current?.dispose()
    voice.current = undefined
  }, [])

  // Button presses must not steal the caret from the Lexical editor.
  const keepFocus = (e: MouseEvent<HTMLButtonElement>): void => { e.preventDefault() }

  /** Start or end the realtime voice call.
   *
   *  The call has one transport: the realtime WebSocket the host gateway
   *  proxies. It no longer borrows the browser recognizer — that engine is
   *  server-backed and unavailable in a packaged desktop build, and a call
   *  built on it fails on every attempt there. `checkVoiceService('voice')`
   *  still screens the request so an unconfigured machine gets a sentence
   *  instead of a socket that closes silently. */
  async function toggleCall(): Promise<void> {
    if (status === 'calling') { stopVoiceRun(); return }
    const preflight = checkVoiceService('voice')
    if (!preflight.ready) { setNotice(t(preflight.noticeKey)); return }
    await startRemoteCall()
  }

  /** Open the signaling socket and negotiate one realtime audio call. */
  async function startRemoteCall(): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const { callSignalingUrl } = readVoiceEndpoints()
      // A browser cannot set headers on a WebSocket handshake, so the chosen
      // service and call voice ride the query string, exactly like the server
      // address does. The host reads them back and carries them upstream.
      const voice = readCallVoice()
      const query = new URLSearchParams()
      if (callSignalingUrl !== '') query.set('url', callSignalingUrl)
      if (voice.provider !== '') query.set('provider', voice.provider)
      if (voice.voice !== '') query.set('voice', voice.voice)
      const search = query.toString()
      // A call that cannot carry the chosen voice says so instead of letting
      // the user wonder why the voice changed mid-conversation.
      const voiceNotice = voice.fit === 'substituted'
        ? t('media.call.voice.substituted')
        : voice.fit === 'bridged' ? t('media.call.voice.bridged') : undefined
      const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/media/realtime${search === '' ? '' : `?${search}`}`)
      const connection = new RTCPeerConnection()
      peer.current = connection
      callSocket.current = socket
      microphone.current = stream
      stream.getTracks().forEach((track) => { connection.addTrack(track, stream) })
      connection.ontrack = (event) => {
        const audio = remoteAudio.current ?? new Audio()
        audio.autoplay = true
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track])
        remoteAudio.current = audio
        void audio.play().catch(() => { setNotice(t('media.call.active')) })
      }
      connection.onicecandidate = (event) => {
        if (event.candidate && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'ice', candidate: event.candidate }))
        }
      }
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as { type?: string; sdp?: string; candidate?: RTCIceCandidateInit }
        if (message.type === 'answer' && message.sdp !== undefined) {
          void connection.setRemoteDescription({ type: 'answer', sdp: message.sdp })
        }
        if (message.type === 'ice' && message.candidate !== undefined) {
          void connection.addIceCandidate(message.candidate)
        }
      }
      socket.onclose = () => { stopVoiceRun() }
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => { resolve() }
        socket.onerror = () => { reject(new Error(t('media.call.unreachable'))) }
      })
      const offer = await connection.createOffer()
      await connection.setLocalDescription(offer)
      socket.send(JSON.stringify({ type: 'offer', sdp: offer.sdp }))
      setStatus('calling')
      setNotice(voiceNotice ?? t('media.call.active'))
    } catch (error) {
      stopVoiceRun()
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Read the text off a captured frame, so the model can receive words
   * instead of an image. Uses the vision endpoint when one is configured;
   * without one there is no local text reader, so the caller keeps the image.
   * @param blob - the captured frame.
   * @returns the recognized text, or null when no reader is available.
   */
  async function readFrameText(blob: Blob): Promise<string | null> {
    if (!hasRemoteVision()) return null
    const response = await fetch('/api/media/screen/text', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...mediaHeaders(readVoiceEndpoints().vision) },
      body: JSON.stringify({ mimeType: 'image/jpeg', imageBase64: await blobToBase64(blob) }),
    })
    if (!response.ok) throw new Error(`Vision HTTP ${response.status}`)
    const payload = await response.json() as { text?: unknown }
    return typeof payload.text === 'string' ? payload.text : null
  }

  /** Start the broadcast, or end it when one is already running. */
  async function toggleScreen(): Promise<void> {
    const running = capture.state()
    if (running === 'live' || running === 'paused') { stopScreen(); return }
    // The engine reports *what* failed; the copy that says it lives here, with
    // the dictionaries.
    if (deviceMedia()?.getDisplayMedia === undefined) {
      setNotice(t('media.unsupported.screen'))
      return
    }
    await capture.start()
    // When a realtime call is live, the screen track joins it so the model
    // receives the video stream. The capture still owns the stream; the call
    // only borrows the track.
    const connection = peer.current
    const display = capture.stream()
    const video = display?.getVideoTracks()[0]
    if (connection !== undefined && display !== undefined && video !== undefined && status === 'calling') {
      const sender = connection.getSenders().find(item => item.track?.kind === 'video')
      if (sender !== undefined) await sender.replaceTrack(video)
      else connection.addTrack(video, display)
    }
  }

  /**
   * Send one frame to the configured vision endpoint and keep the capture
   * streaming, so the endpoint sees the live screen rather than one still.
   * @param blob - the frame to analyze.
   */
  async function analyzeFrame(blob: Blob): Promise<void> {
    const response = await fetch('/api/media/screen/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...mediaHeaders(readVoiceEndpoints().vision) },
      body: JSON.stringify({ mimeType: 'image/jpeg', imageBase64: await blobToBase64(blob), prompt: 'Проанализируй текущий экран' }),
    })
    if (!response.ok) throw new Error(`Vision HTTP ${response.status}`)
  }

  /**
   * Hand one frame to the composer as an attachment, so the model sees the
   * screen on the next send without any vision service.
   * @param blob - the captured frame.
   */
  function attachFrame(blob: Blob): void {
    const attach = addImages
    if (attach === undefined) {
      setNotice(t('media.screen.attach.failed'))
      if (isSoundEnabled()) playErrorTone()
      return
    }
    const failure = attach([new File([blob], 'screen.jpg', { type: 'image/jpeg' })])
    // A rejected frame is always worth saying out loud: the user just handed
    // the composer a picture it refused, and a silent broadcast would look
    // like the screen is being seen when it is not.
    if (failure !== null) {
      setNotice(failure)
      if (isSoundEnabled()) playErrorTone()
      return
    }
    if (!readScreenSettings().broadcast) {
      setNotice(t('media.screen.attached'))
      if (isSoundEnabled()) playSuccessTone()
    }
  }

  /**
   * Turn whatever the capture has collected into whatever the model receives:
   * text read off the screen, an analysis request, or a composer attachment.
   * Pulled rather than pushed, so a burst of frames costs one round trip.
   */
  async function collectFrames(): Promise<void> {
    const frames = capture.drain()
    const latest = frames[frames.length - 1]
    if (latest === undefined) return
    const settings = readScreenSettings()
    try {
      if (settings.sendText) {
        const text = await readFrameText(latest.blob)
        // No reader configured: fall back to the picture rather than sending
        // nothing, since the user asked for the screen to be visible.
        if (text !== null) {
          capture.addText(text)
          inputActions.setDraft(capture.snapshot().text)
          if (!settings.broadcast) setNotice(t('media.screen.attached'))
          return
        }
      }
      if (hasRemoteVision()) await analyzeFrame(latest.blob)
      else attachFrame(latest.blob)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
      if (isSoundEnabled()) playErrorTone()
    }
  }

  /**
   * React to the capture: mirror its status and preview here, and collect the
   * frames it produced. Kept as a plain function so the subscription effect
   * never has to be torn down and rebuilt.
   * @param snapshot - the capture's current state.
   */
  react.current = (snapshot: ScreenCaptureSnapshot): void => {
    setPreview(snapshot.preview ?? null)
    if (snapshot.state === 'live') {
      setStatus('sharing')
      // The first frame owns the notice: an error it reported must survive the
      // broadcast announcement, so the announcement only fills a silent slot.
      setNotice(previous => (previous === '' ? t('media.screen.broadcast') : previous))
    } else if (snapshot.state === 'failed') {
      setStatus('idle')
      // The technical reason stays in the snapshot; the user gets a sentence
      // in their own language rather than a raw engine string.
      setNotice(t('media.screen.start.failed'))
      if (isSoundEnabled()) playErrorTone()
    } else if (snapshot.state === 'idle') {
      setStatus(previous => (previous === 'sharing' ? 'idle' : previous))
    }
    if (snapshot.frames > 0) void collectFrames()
  }

  /** End the broadcast, and take the screen track back out of a live call. */
  function stopScreen(): void {
    const connection = peer.current
    const videoSender = connection?.getSenders().find(item => item.track?.kind === 'video')
    if (videoSender !== undefined) void videoSender.replaceTrack(null)
    void capture.stop()
    setStatus(peer.current !== undefined ? 'calling' : 'idle')
    setNotice('')
  }

  /**
   * End the voice run this toolbar owns: the call, and any speech it started.
   * The screen broadcast is deliberately absent — it belongs to the capture
   * subsystem and survives this component going away. The push-to-talk module
   * is absent too: it owns its own microphone and recognizer, and `dispose()`
   * in the unmount effect is the one place that gives them back.
   */
  function stopVoiceRun(): void {
    cancelSpeech()
    microphone.current?.getTracks().forEach((track) => { track.stop() })
    callSocket.current?.close()
    peer.current?.close()
    if (remoteAudio.current !== undefined) {
      remoteAudio.current.pause()
      remoteAudio.current.srcObject = null
    }
    microphone.current = undefined
    callSocket.current = undefined
    peer.current = undefined
    remoteAudio.current = undefined
    setStatus('idle')
    setNotice('')
  }

  /**
   * The push-to-talk module, built on first use and kept for the session.
   *
   * The sink sends, and `awaitAnswer` hands back the answer that follows —
   * together they are the whole "speak, then hear the reply" loop. The answer
   * is deliberately NOT read from the transcript: the turn tail that renders
   * it is built from the log after the turn ends, so it looks identical when
   * an old session is reopened, and a reader wired there would read the whole
   * archive aloud. `awaitAnswer` is settled by the live event feed instead, so
   * only an answer arriving now is ever spoken.
   *
   * The recognizer comes from the stored choice. `auto` prefers a configured
   * service and otherwise falls back to this machine's own recognizer — which
   * is what makes the desktop application work with nothing configured.
   * @returns the module.
   */
  function voiceModule(): VoiceModule {
    const existing = voice.current
    if (existing !== undefined) return existing
    const stt = createSttEngine(readVoiceModuleSettings().sttEngine)
    const created = createVoiceModule({
      // Spread rather than `stt: undefined`: an absent recognizer is how the
      // module learns to report `recognize-unavailable`, and an explicit
      // undefined is not the same thing to the compiler.
      ...stt === undefined ? {} : { stt },
      turn: {
        submit: (text) => {
          inputActions.setDraft(text)
          inputActions.submit()
        },
        // Registered through the input face, whose wait settles only on a live
        // answer — the module's own timeout still bounds this, so a turn that
        // never answers surfaces as `answer-timeout` rather than a stuck state.
        awaitAnswer: signal => inputActions.awaitAnswer(signal),
      },
      replyMode: () => readVoiceModuleSettings().replyMode,
    })
    created.subscribe((snapshot) => { setHold(snapshot) })
    voice.current = created
    return created
  }

  /** Toggle the single voice control: one press starts, the next stops. */
  function toggleHold(): void {
    const module = voiceModule()
    if (hold !== undefined && hold.state !== 'idle' && hold.state !== 'error') {
      void module.release()
      return
    }
    void module.press()
  }

  const callActive = status === 'calling'
  const screenActive = status === 'sharing'
  // 'error' is not "busy": the module has stopped and the next press may start
  // again, so the control must not look like something is still running.
  const holdActive = hold !== undefined && hold.state !== 'idle' && hold.state !== 'error'
  const holdMessage = hold === undefined ? '' : holdNoticeOf(hold, t)
  // Push-to-talk owns the line while it has something to say; the other
  // controls' notice returns as soon as it falls quiet again.
  const message = holdMessage === '' ? notice : holdMessage
  const callLabel = callActive ? t('media.stop') : t('input.call')
  const screenLabel = screenActive ? t('media.stop') : t('input.screen')
  const improveLabel = improving ? t('compose.restructuring') : t('compose.restructure')
  const frozen = locked || busy
  // An empty draft has nothing to improve, and a frozen machine owns the
  // editor: both keep the control inert rather than opening a doomed call.
  const improveDisabled = frozen || improving || draft.trim() === ''

  /** Hand the current draft to the model and write the answer back in place.
   *  The draft is replaced only on a real answer: a refusal, a cancel, or an
   *  empty result leaves the user's own text untouched, and nothing is sent. */
  async function improveDraft(): Promise<void> {
    if (improveDisabled) return
    const controller = new AbortController()
    improveAbort.current = controller
    setImproving(true)
    setNotice('')
    try {
      const improved = await inputActions.restructureDraft(draft, controller.signal)
      if (improved.trim() !== '') inputActions.setDraft(improved)
    } catch (error) {
      // Aborting is how unmount ends the call: not a failure to report. A real
      // failure keeps its reason: the voice controls below surface the message
      // the same way, and a bare "could not improve" leaves nothing to act on.
      if (!controller.signal.aborted) {
        setNotice(`${t('compose.restructure.failed')}: ${error instanceof Error ? error.message : String(error)}`)
      }
    } finally {
      if (improveAbort.current === controller) improveAbort.current = undefined
      setImproving(false)
    }
  }

  return (
    <span className={css.toolbar} role="group" aria-label={t('media.group')}>
      <Tooltip label={improveLabel} side="top" delayMs={500}>
        <button
          type="button"
          className={clsx(css.btn, improving && css.recording)}
          aria-label={improveLabel}
          aria-busy={improving}
          disabled={improveDisabled}
          onMouseDown={keepFocus}
          onClick={() => { void improveDraft() }}
        >
          <IconSparkle16 size={14} />
        </button>
      </Tooltip>
      <Tooltip label={t('input.voiceHold')} side="top" delayMs={500}>
        <button
          type="button"
          className={clsx(css.btn, holdActive && css.btnActive, holdActive && css.recording)}
          aria-label={t('input.voiceHold')}
          aria-pressed={holdActive}
          disabled={frozen || callActive || screenActive}
          onMouseDown={keepFocus}
          onClick={() => { toggleHold() }}
        >
          <IconMicOutline16 size={14} />
        </button>
      </Tooltip>
      <Tooltip label={callLabel} side="top" delayMs={500}>
        <button
          type="button"
          className={clsx(css.btn, callActive && css.btnActive)}
          aria-label={callLabel}
          aria-pressed={callActive}
          disabled={frozen || holdActive || screenActive}
          onMouseDown={keepFocus}
          onClick={() => { void toggleCall() }}
        >
          <IconCallOutline16 size={14} />
        </button>
      </Tooltip>
      <Tooltip label={screenLabel} side="top" delayMs={500}>
        <button
          type="button"
          className={clsx(css.btn, screenActive && css.btnActive)}
          aria-label={screenLabel}
          aria-pressed={screenActive}
          disabled={frozen || holdActive}
          onMouseDown={keepFocus}
          onClick={() => { void toggleScreen() }}
        >
          <IconScreenOutline16 size={14} />
        </button>
      </Tooltip>
      {message === '' ? null : <span className={css.notice} role="status" aria-live="polite">{message}</span>}
      {preview === null ? null : (
        <span className={clsx(css.preview, css[`corner-${readScreenSettings().previewCorner}`])}>
          <img className={css.previewFrame} src={preview} alt={t('media.screen.preview.label')} />
          <button
            type="button"
            className={css.previewStop}
            onMouseDown={keepFocus}
            onClick={() => { stopScreen() }}
          >
            {t('media.screen.preview.stop')}
          </button>
        </span>
      )}
    </span>
  )
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer()
  let binary = ''
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

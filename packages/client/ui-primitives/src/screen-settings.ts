/**
 * Screen-broadcast preferences: the reader half of the `dsh.screen.settings`
 * document the Screen Broadcast page owns. Physical home is this leaf module
 * (zero dependencies) so the composer screen button reads the cadence,
 * preview, and quality settings without a cross-plugin value edge; the
 * settings package keeps writing the document through its own copy of the
 * storage key and re-exports this API.
 *
 * Every field is validated on read, so one damaged field cannot discard the
 * rest of the document, and a missing document means the shipped defaults.
 */

/** Storage key of the Screen Broadcast document. */
export const SCREEN_SETTINGS_STORAGE_KEY = 'dsh.screen.settings'

/** Lowest selectable interval between two sampled frames, in milliseconds. */
export const SCREEN_INTERVAL_MIN_MS = 1000

/** Highest selectable interval between two sampled frames, in milliseconds. */
export const SCREEN_INTERVAL_MAX_MS = 30000

/** Allowed longest edge of a sampled frame, in pixels. */
export const SCREEN_MAX_EDGE_CHOICES = [854, 1280, 1920] as const

/** Which corner the preview window sits in. */
export type ScreenPreviewCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

/** Every preview corner, in reading order. */
export const SCREEN_PREVIEW_CORNERS: readonly ScreenPreviewCorner[]
  = ['top-left', 'top-right', 'bottom-left', 'bottom-right']

/**
 * What the capture asks the system to share.
 *
 * - `ask` — let the picker decide, every single time (the browser default);
 * - `screen` — ask for the whole display, skipping the picker where allowed;
 * - `window` — ask for a single window, skipping the picker where allowed.
 */
export type ScreenCaptureScope = 'ask' | 'screen' | 'window'

/** Every capture scope, in reading order. */
export const SCREEN_CAPTURE_SCOPES: readonly ScreenCaptureScope[] = ['ask', 'screen', 'window']

/** Lowest selectable change threshold, as a share of changed pixels (0–1). */
export const SCREEN_THRESHOLD_MIN = 0.001

/** Highest selectable change threshold, as a share of changed pixels (0–1). */
export const SCREEN_THRESHOLD_MAX = 0.2

/** Fewest frames the capture buffer keeps. */
export const SCREEN_BUFFER_FRAMES_MIN = 1

/** Most frames the capture buffer keeps. */
export const SCREEN_BUFFER_FRAMES_MAX = 64

/** Smallest capture buffer, in bytes. */
export const SCREEN_BUFFER_BYTES_MIN = 1024 * 1024

/** Largest capture buffer, in bytes. */
export const SCREEN_BUFFER_BYTES_MAX = 128 * 1024 * 1024

/** Fewest characters of read-off text the capture buffer keeps. */
export const SCREEN_BUFFER_TEXT_MIN = 1000

/** Most characters of read-off text the capture buffer keeps. */
export const SCREEN_BUFFER_TEXT_MAX = 200_000

/** The screen-broadcast preferences. */
export interface ScreenSettings {
  /** Broadcast continuously instead of taking one frame per press. */
  broadcast: boolean
  /** Milliseconds between two sampled frames. */
  intervalMs: number
  /** Echo the captured screen back in a floating preview window. */
  showPreview: boolean
  /** Which corner the preview window sits in. */
  previewCorner: ScreenPreviewCorner
  /** Longest edge of a sampled frame, in pixels. */
  maxEdge: number
  /** JPEG quality of a sampled frame, 0.1–1. */
  quality: number
  /** Ask the capture for system audio alongside the picture. */
  captureAudio: boolean
  /** End the broadcast quietly when the capture is stopped outside the app. */
  stopOnEnded: boolean
  /** Skip a scheduled frame when the screen barely changed since the last one. */
  sendOnChange: boolean
  /** Share of changed pixels that counts as "the screen moved", 0.001–0.2. */
  changeThreshold: number
  /** What the capture asks the system to share. */
  captureScope: ScreenCaptureScope
  /** Send the text read off the frame instead of the picture itself. */
  sendText: boolean
  /** How many of the most recent frames the capture buffer keeps. */
  bufferFrames: number
  /** How many bytes of frames the capture buffer keeps in total. */
  bufferBytes: number
  /** How many characters of read-off text the capture buffer keeps. */
  bufferTextChars: number
}

/** Every screen-broadcast preference at its shipped default. */
export const DEFAULT_SCREEN_SETTINGS: ScreenSettings = {
  broadcast: true,
  intervalMs: 5000,
  showPreview: true,
  previewCorner: 'bottom-right',
  maxEdge: 1280,
  quality: 0.82,
  captureAudio: false,
  stopOnEnded: true,
  sendOnChange: false,
  changeThreshold: 0.02,
  captureScope: 'ask',
  sendText: false,
  bufferFrames: 8,
  bufferBytes: 24 * 1024 * 1024,
  bufferTextChars: 20_000,
}

/**
 * Clamp one numeric field into its allowed range.
 * @param value - stored value.
 * @param min - lowest allowed value.
 * @param max - highest allowed value.
 * @param fallback - default used when the value is not a finite number.
 * @returns the clamped number.
 */
function numberIn(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/**
 * Read one member out of a closed set.
 * @param value - stored value.
 * @param allowed - the closed set.
 * @param fallback - default used when the value is not a member.
 * @returns the member, or the fallback.
 */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? value as T
    : fallback
}

/**
 * Read one frame width out of the offered resolutions.
 * @param value - stored value.
 * @returns the resolution, or the default one.
 */
function edgeOf(value: unknown): number {
  return typeof value === 'number' && (SCREEN_MAX_EDGE_CHOICES as readonly number[]).includes(value)
    ? value
    : DEFAULT_SCREEN_SETTINGS.maxEdge
}

/**
 * Read the stored screen-broadcast settings, tolerating a missing or corrupt
 * document and validating every field on its own.
 * @returns the stored settings, or the defaults when nothing usable is stored.
 */
export function readScreenSettings(): ScreenSettings {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(SCREEN_SETTINGS_STORAGE_KEY)
  } catch {
    return { ...DEFAULT_SCREEN_SETTINGS }
  }
  if (raw === null) return { ...DEFAULT_SCREEN_SETTINGS }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    // A foreign writer corrupted the document: treat it as absent rather than
    // surfacing a parse failure from a settings read.
    return { ...DEFAULT_SCREEN_SETTINGS }
  }
  if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_SCREEN_SETTINGS }
  const record = parsed as Record<string, unknown>
  const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback)
  return {
    broadcast: bool(record.broadcast, DEFAULT_SCREEN_SETTINGS.broadcast),
    intervalMs: numberIn(
      record.intervalMs, SCREEN_INTERVAL_MIN_MS, SCREEN_INTERVAL_MAX_MS, DEFAULT_SCREEN_SETTINGS.intervalMs,
    ),
    showPreview: bool(record.showPreview, DEFAULT_SCREEN_SETTINGS.showPreview),
    previewCorner: oneOf(record.previewCorner, SCREEN_PREVIEW_CORNERS, DEFAULT_SCREEN_SETTINGS.previewCorner),
    maxEdge: edgeOf(record.maxEdge),
    quality: numberIn(record.quality, 0.1, 1, DEFAULT_SCREEN_SETTINGS.quality),
    captureAudio: bool(record.captureAudio, DEFAULT_SCREEN_SETTINGS.captureAudio),
    stopOnEnded: bool(record.stopOnEnded, DEFAULT_SCREEN_SETTINGS.stopOnEnded),
    sendOnChange: bool(record.sendOnChange, DEFAULT_SCREEN_SETTINGS.sendOnChange),
    changeThreshold: numberIn(
      record.changeThreshold,
      SCREEN_THRESHOLD_MIN,
      SCREEN_THRESHOLD_MAX,
      DEFAULT_SCREEN_SETTINGS.changeThreshold,
    ),
    captureScope: oneOf(record.captureScope, SCREEN_CAPTURE_SCOPES, DEFAULT_SCREEN_SETTINGS.captureScope),
    sendText: bool(record.sendText, DEFAULT_SCREEN_SETTINGS.sendText),
    bufferFrames: Math.round(numberIn(
      record.bufferFrames,
      SCREEN_BUFFER_FRAMES_MIN,
      SCREEN_BUFFER_FRAMES_MAX,
      DEFAULT_SCREEN_SETTINGS.bufferFrames,
    )),
    bufferBytes: numberIn(
      record.bufferBytes, SCREEN_BUFFER_BYTES_MIN, SCREEN_BUFFER_BYTES_MAX, DEFAULT_SCREEN_SETTINGS.bufferBytes,
    ),
    bufferTextChars: Math.round(numberIn(
      record.bufferTextChars,
      SCREEN_BUFFER_TEXT_MIN,
      SCREEN_BUFFER_TEXT_MAX,
      DEFAULT_SCREEN_SETTINGS.bufferTextChars,
    )),
  }
}

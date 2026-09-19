/**
 * Screen-broadcast settings page re-export. The document itself lives in the
 * `ui-primitives` leaf (screen-settings.ts), so the composer screen button can
 * read the same cadence and quality without a cross-plugin value edge; this
 * module is the page-facing face of that document, adding the validated writer.
 */

import {
  DEFAULT_SCREEN_SETTINGS,
  SCREEN_BUFFER_BYTES_MAX,
  SCREEN_BUFFER_BYTES_MIN,
  SCREEN_BUFFER_FRAMES_MAX,
  SCREEN_BUFFER_FRAMES_MIN,
  SCREEN_BUFFER_TEXT_MAX,
  SCREEN_BUFFER_TEXT_MIN,
  SCREEN_CAPTURE_SCOPES,
  SCREEN_INTERVAL_MAX_MS,
  SCREEN_INTERVAL_MIN_MS,
  SCREEN_MAX_EDGE_CHOICES,
  SCREEN_PREVIEW_CORNERS,
  SCREEN_SETTINGS_STORAGE_KEY,
  SCREEN_THRESHOLD_MAX,
  SCREEN_THRESHOLD_MIN,
  readScreenSettings,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  ScreenCaptureScope, ScreenPreviewCorner, ScreenSettings,
} from '@deepseek-ai/dsh-client-ui-primitives'

export {
  DEFAULT_SCREEN_SETTINGS,
  SCREEN_BUFFER_BYTES_MAX as BUFFER_BYTES_MAX,
  SCREEN_BUFFER_BYTES_MIN as BUFFER_BYTES_MIN,
  SCREEN_BUFFER_FRAMES_MAX as BUFFER_FRAMES_MAX,
  SCREEN_BUFFER_FRAMES_MIN as BUFFER_FRAMES_MIN,
  SCREEN_BUFFER_TEXT_MAX as BUFFER_TEXT_MAX,
  SCREEN_BUFFER_TEXT_MIN as BUFFER_TEXT_MIN,
  SCREEN_CAPTURE_SCOPES as CAPTURE_SCOPES,
  SCREEN_INTERVAL_MAX_MS as INTERVAL_MAX_MS,
  SCREEN_INTERVAL_MIN_MS as INTERVAL_MIN_MS,
  SCREEN_MAX_EDGE_CHOICES as MAX_EDGE_CHOICES,
  SCREEN_PREVIEW_CORNERS as PREVIEW_CORNERS,
  SCREEN_SETTINGS_STORAGE_KEY,
  SCREEN_THRESHOLD_MAX as THRESHOLD_MAX,
  SCREEN_THRESHOLD_MIN as THRESHOLD_MIN,
  readScreenSettings,
}
export type { ScreenCaptureScope, ScreenPreviewCorner, ScreenSettings }

/**
 * Clamp one numeric field into its allowed range.
 * @param value - value to store.
 * @param min - lowest allowed value.
 * @param max - highest allowed value.
 * @param fallback - value used when the input is not a finite number.
 * @returns the clamped number.
 */
function clamp(value: number, min: number, max: number, fallback: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : fallback))
}

/**
 * Persist screen settings, merging over the stored document. Every value is
 * validated exactly as the reader validates it, so a write can never store a
 * document the reader would have to sanitize.
 * @param patch - fields to store.
 */
export function writeScreenSettings(patch: Partial<ScreenSettings>): void {
  const next: ScreenSettings = { ...readScreenSettings() }
  if (patch.broadcast !== undefined) next.broadcast = patch.broadcast
  if (patch.intervalMs !== undefined) {
    next.intervalMs = clamp(patch.intervalMs, SCREEN_INTERVAL_MIN_MS, SCREEN_INTERVAL_MAX_MS, DEFAULT_SCREEN_SETTINGS.intervalMs)
  }
  if (patch.showPreview !== undefined) next.showPreview = patch.showPreview
  if (patch.previewCorner !== undefined && SCREEN_PREVIEW_CORNERS.includes(patch.previewCorner)) {
    next.previewCorner = patch.previewCorner
  }
  if (patch.maxEdge !== undefined && (SCREEN_MAX_EDGE_CHOICES as readonly number[]).includes(patch.maxEdge)) {
    next.maxEdge = patch.maxEdge
  }
  if (patch.quality !== undefined) {
    next.quality = clamp(patch.quality, 0.1, 1, DEFAULT_SCREEN_SETTINGS.quality)
  }
  if (patch.captureAudio !== undefined) next.captureAudio = patch.captureAudio
  if (patch.stopOnEnded !== undefined) next.stopOnEnded = patch.stopOnEnded
  if (patch.sendOnChange !== undefined) next.sendOnChange = patch.sendOnChange
  if (patch.changeThreshold !== undefined) {
    next.changeThreshold = clamp(
      patch.changeThreshold, SCREEN_THRESHOLD_MIN, SCREEN_THRESHOLD_MAX, DEFAULT_SCREEN_SETTINGS.changeThreshold,
    )
  }
  if (patch.captureScope !== undefined && SCREEN_CAPTURE_SCOPES.includes(patch.captureScope)) {
    next.captureScope = patch.captureScope
  }
  if (patch.sendText !== undefined) next.sendText = patch.sendText
  if (patch.bufferFrames !== undefined) {
    next.bufferFrames = Math.round(clamp(
      patch.bufferFrames,
      SCREEN_BUFFER_FRAMES_MIN,
      SCREEN_BUFFER_FRAMES_MAX,
      DEFAULT_SCREEN_SETTINGS.bufferFrames,
    ))
  }
  if (patch.bufferBytes !== undefined) {
    next.bufferBytes = clamp(
      patch.bufferBytes,
      SCREEN_BUFFER_BYTES_MIN,
      SCREEN_BUFFER_BYTES_MAX,
      DEFAULT_SCREEN_SETTINGS.bufferBytes,
    )
  }
  if (patch.bufferTextChars !== undefined) {
    next.bufferTextChars = Math.round(clamp(
      patch.bufferTextChars,
      SCREEN_BUFFER_TEXT_MIN,
      SCREEN_BUFFER_TEXT_MAX,
      DEFAULT_SCREEN_SETTINGS.bufferTextChars,
    ))
  }
  try {
    localStorage.setItem(SCREEN_SETTINGS_STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Private-mode/quota writes fail silently: the page keeps its draft and
    // the composer falls back to the shipped defaults.
  }
}

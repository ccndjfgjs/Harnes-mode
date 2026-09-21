/**
 * Improve-text voice announce toggle: browser-local on/off switch for reading
 * the Improve-text button's outcome aloud. Stored in this browser's
 * localStorage (like the voice and accessibility settings), so it needs no
 * Host namespace and survives restarts on this machine. Lives in primitives
 * because both the settings card and the composer button read it, and feature
 * plugins must not import each other's values.
 */

/** localStorage key carrying the announce toggle. */
export const IMPROVE_ANNOUNCE_STORAGE_KEY = 'dsh.improve-text.announce'

/**
 * Whether the Improve-text button should read its outcome aloud.
 * @returns the stored toggle, off when nothing usable is stored.
 */
export function readImproveAnnounce(): boolean {
  try {
    return localStorage.getItem(IMPROVE_ANNOUNCE_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

/**
 * Store the announce toggle.
 * @param value - true to read outcomes aloud, false to stay silent.
 */
export function writeImproveAnnounce(value: boolean): void {
  try {
    localStorage.setItem(IMPROVE_ANNOUNCE_STORAGE_KEY, value ? 'true' : 'false')
  } catch {
    // Voice feedback must never break the settings flow.
  }
}

/** localStorage key carrying the read-aloud toggle. */
export const IMPROVE_READ_ALOUD_STORAGE_KEY = 'dsh.improve-text.read-aloud'

/**
 * Whether the Improve-text button should read the improved draft itself aloud.
 * @returns the stored toggle, off when nothing usable is stored.
 */
export function readImproveReadAloud(): boolean {
  try {
    return localStorage.getItem(IMPROVE_READ_ALOUD_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

/**
 * Store the read-aloud toggle.
 * @param value - true to read improved drafts aloud, false to stay silent.
 */
export function writeImproveReadAloud(value: boolean): void {
  try {
    localStorage.setItem(IMPROVE_READ_ALOUD_STORAGE_KEY, value ? 'true' : 'false')
  } catch {
    // Voice feedback must never break the settings flow.
  }
}

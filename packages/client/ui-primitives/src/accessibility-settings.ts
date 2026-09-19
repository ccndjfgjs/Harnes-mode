/**
 * Browser-local accessibility settings: the single persistence behind the
 * Accessibility page. Physical home is this leaf module (zero dependencies)
 * so feature code in any client package can read the document without
 * dragging a project-reference cycle; the Accessibility page below is its
 * only writer, and the accessibility package barrel re-exports this API.
 */

/** Storage key for the whole accessibility document. */
export const ACCESSIBILITY_SETTINGS_STORAGE_KEY = 'dsh.accessibility.settings'

/** How much of a code block the reader announces. */
export type CodeReadingMode = 'brief' | 'line' | 'full'

/** Interface and code typeface choice. */
export type AccessibilityFont = 'atkinson' | 'mono'

/** High-contrast theme choice. */
export type ContrastTheme = 'none' | 'bw' | 'yellow' | 'daltonism'

/** The accessibility preferences. */
export interface AccessibilitySettings {
  /** Code reading mode. */
  codeReading: CodeReadingMode
  /** Event sound notifications. */
  sound: boolean
  /** Interface and code font. */
  font: AccessibilityFont
  /** Strip Markdown symbols before speech synthesis. */
  stripMarkdown: boolean
  /** High-contrast theme. */
  contrast: ContrastTheme
  /** Voice navigation: speak menu/tab names on focus/click. */
  voiceNav: boolean
  /** Speak menu items on mouse hover (only when voiceNav is on). */
  voiceNavHover: boolean
  /** Arrow-key navigation: highlight and speak the focused control. */
  voiceNavArrow: boolean
  /** Delay (ms) before the next utterance — throttles rapid hover/arrow speech. */
  voiceNavDelay: number
  /** How the empty chat placeholder is voiced: click, hover, or both. */
  voiceNavChatTrigger: VoiceNavChatTrigger
}

/** How the empty chat placeholder is triggered. */
export type VoiceNavChatTrigger = 'click' | 'hover' | 'both'

/** Default preferences: brief reading, sound on, legible font, no overrides. */
export const DEFAULT_ACCESSIBILITY_SETTINGS: AccessibilitySettings = {
  codeReading: 'brief',
  sound: true,
  font: 'atkinson',
  stripMarkdown: true,
  contrast: 'none',
  voiceNav: false,
  voiceNavHover: true,
  voiceNavArrow: false,
  voiceNavDelay: 150,
  voiceNavChatTrigger: 'both',
}

/**
 * Whether a value is one of the allowed code-reading modes.
 * @param value - unknown stored value.
 * @returns true only for a known mode literal.
 */
function isCodeReadingMode(value: unknown): value is CodeReadingMode {
  return value === 'brief' || value === 'line' || value === 'full'
}

/**
 * Whether a value is one of the allowed font choices.
 * @param value - unknown stored value.
 * @returns true only for a known font literal.
 */
function isFont(value: unknown): value is AccessibilityFont {
  return value === 'atkinson' || value === 'mono'
}

/**
 * Whether a value is one of the allowed contrast themes.
 * @param value - unknown stored value.
 * @returns true only for a known theme literal.
 */
function isContrast(value: unknown): value is ContrastTheme {
  return value === 'none' || value === 'bw' || value === 'yellow' || value === 'daltonism'
}

function isVoiceNavChatTrigger(value: unknown): value is VoiceNavChatTrigger {
  return value === 'click' || value === 'hover' || value === 'both'
}

/**
 * Read the stored accessibility settings, tolerating a missing or corrupt
 * document field by field (one bad field never resets the rest).
 * @returns the stored settings completed with defaults.
 */
export function readAccessibilitySettings(): AccessibilitySettings {
  let record: Record<string, unknown> = {}
  try {
    const raw = localStorage.getItem(ACCESSIBILITY_SETTINGS_STORAGE_KEY)
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null) record = parsed as Record<string, unknown>
    }
  } catch {
    // A foreign writer corrupted the document: fall through with defaults
    // rather than surfacing a parse failure from a settings read.
  }
  return {
    codeReading: isCodeReadingMode(record.codeReading) ? record.codeReading : DEFAULT_ACCESSIBILITY_SETTINGS.codeReading,
    sound: typeof record.sound === 'boolean' ? record.sound : DEFAULT_ACCESSIBILITY_SETTINGS.sound,
    font: isFont(record.font) ? record.font : DEFAULT_ACCESSIBILITY_SETTINGS.font,
    stripMarkdown: typeof record.stripMarkdown === 'boolean'
      ? record.stripMarkdown
      : DEFAULT_ACCESSIBILITY_SETTINGS.stripMarkdown,
    contrast: isContrast(record.contrast) ? record.contrast : DEFAULT_ACCESSIBILITY_SETTINGS.contrast,
    voiceNav: typeof record.voiceNav === 'boolean' ? record.voiceNav : DEFAULT_ACCESSIBILITY_SETTINGS.voiceNav,
    voiceNavHover: typeof record.voiceNavHover === 'boolean' ? record.voiceNavHover : DEFAULT_ACCESSIBILITY_SETTINGS.voiceNavHover,
    voiceNavArrow: typeof record.voiceNavArrow === 'boolean' ? record.voiceNavArrow : DEFAULT_ACCESSIBILITY_SETTINGS.voiceNavArrow,
    voiceNavDelay: typeof record.voiceNavDelay === 'number' && Number.isFinite(record.voiceNavDelay)
      ? Math.min(1000, Math.max(0, Math.round(record.voiceNavDelay)))
      : DEFAULT_ACCESSIBILITY_SETTINGS.voiceNavDelay,
    voiceNavChatTrigger: isVoiceNavChatTrigger(record.voiceNavChatTrigger)
      ? record.voiceNavChatTrigger
      : DEFAULT_ACCESSIBILITY_SETTINGS.voiceNavChatTrigger,
  }
}

/**
 * Persist accessibility settings, merging over the stored document.
 * @param patch - fields to store.
 */
export function writeAccessibilitySettings(patch: Partial<AccessibilitySettings>): void {
  const next: AccessibilitySettings = { ...readAccessibilitySettings(), ...patch }
  try {
    localStorage.setItem(ACCESSIBILITY_SETTINGS_STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Private-mode/quota writes fail silently: the page keeps its draft.
  }
}

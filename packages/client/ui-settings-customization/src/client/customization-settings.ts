/**
 * Browser-local customization settings: the single persistence behind the
 * Customization page. Accent/density/background project onto the document
 * through apply-customization.ts; theme/fontSize mirror the theme feature's
 * durable preference and are pushed into the theme service on save (the
 * theme service stays the live authority and owns the DOM presentation).
 */

/** Storage key for the whole customization document. */
export const CUSTOMIZATION_SETTINGS_STORAGE_KEY = 'dsh.customization.settings'

/** Accent color choice. */
export type AccentColor = 'blue' | 'green' | 'purple' | 'orange'

/** Interface density choice. */
export type Density = 'compact' | 'comfortable' | 'spacious'

/** Chat background choice. */
export type ChatBackground = 'default' | 'grid' | 'dots'

/**
 * Theme choice. Mirrors the theme feature's ThemePreference
 * (see ui-theme theme-settings.ts); kept local so this page never takes a
 * value dependency on the theme package — the service call takes a string.
 */
export type CustomizationTheme = 'system' | 'light' | 'dark'

/** Smallest accepted content font size in px (mirrors the theme feature). */
export const CUSTOMIZATION_FONT_SIZE_MIN = 12

/** Largest accepted content font size in px (mirrors the theme feature). */
export const CUSTOMIZATION_FONT_SIZE_MAX = 17

/** Content font size when the document has no override (px). */
export const DEFAULT_CUSTOMIZATION_FONT_SIZE = 14

/** The customization preferences. */
export interface CustomizationSettings {
  /** Accent color. */
  accent: AccentColor
  /** Interface density. */
  density: Density
  /** Show message timestamps. */
  showTimestamps: boolean
  /** Show participant avatars. */
  showAvatars: boolean
  /** Wrap long code lines. */
  wrapCode: boolean
  /** Chat background. */
  background: ChatBackground
  /** Theme choice, pushed into the theme service on save. */
  theme: CustomizationTheme
  /** Conversation content font size in px, pushed into the theme service on save. */
  fontSize: number
  /** Custom brand text shown in the sidebar header. */
  brandName: string
}

/** Default preferences: calm blue, comfortable density, everything visible. */
export const DEFAULT_CUSTOMIZATION_SETTINGS: CustomizationSettings = {
  accent: 'blue',
  density: 'comfortable',
  showTimestamps: true,
  showAvatars: true,
  wrapCode: true,
  background: 'default',
  theme: 'system',
  fontSize: DEFAULT_CUSTOMIZATION_FONT_SIZE,
  brandName: 'harness Absolution',
}

/**
 * Whether a value is one of the allowed accent colors.
 * @param value - unknown stored value.
 * @returns true only for a known accent literal.
 */
function isAccent(value: unknown): value is AccentColor {
  return value === 'blue' || value === 'green' || value === 'purple' || value === 'orange'
}

/**
 * Whether a value is one of the allowed densities.
 * @param value - unknown stored value.
 * @returns true only for a known density literal.
 */
function isDensity(value: unknown): value is Density {
  return value === 'compact' || value === 'comfortable' || value === 'spacious'
}

/**
 * Whether a value is one of the allowed chat backgrounds.
 * @param value - unknown stored value.
 * @returns true only for a known background literal.
 */
function isBackground(value: unknown): value is ChatBackground {
  return value === 'default' || value === 'grid' || value === 'dots'
}

/**
 * Whether a value is one of the allowed theme choices.
 * @param value - unknown stored value.
 * @returns true only for a known theme literal.
 */
function isCustomizationTheme(value: unknown): value is CustomizationTheme {
  return value === 'system' || value === 'light' || value === 'dark'
}

/**
 * Whether a value is an accepted content font size.
 * @param value - unknown stored value.
 * @returns true only for an integer px within the accepted range.
 */
function isCustomizationFontSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
    && value >= CUSTOMIZATION_FONT_SIZE_MIN && value <= CUSTOMIZATION_FONT_SIZE_MAX
}

/**
 * Whether a value is a valid brand name.
 * @param value - unknown stored value.
 * @returns true only for a non-empty trimmed string within limit.
 */
function isBrandName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 80
}

/**
 * Read the stored customization settings, tolerating a missing or corrupt
 * document field by field (one bad field never resets the rest).
 * @returns the stored settings completed with defaults.
 */
export function readCustomizationSettings(): CustomizationSettings {
  let record: Record<string, unknown> = {}
  try {
    const raw = localStorage.getItem(CUSTOMIZATION_SETTINGS_STORAGE_KEY)
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null) record = parsed as Record<string, unknown>
    }
  } catch {
    // A foreign writer corrupted the document: fall through with defaults
    // rather than surfacing a parse failure from a settings read.
  }
  return {
    accent: isAccent(record.accent) ? record.accent : DEFAULT_CUSTOMIZATION_SETTINGS.accent,
    density: isDensity(record.density) ? record.density : DEFAULT_CUSTOMIZATION_SETTINGS.density,
    showTimestamps: typeof record.showTimestamps === 'boolean'
      ? record.showTimestamps
      : DEFAULT_CUSTOMIZATION_SETTINGS.showTimestamps,
    showAvatars: typeof record.showAvatars === 'boolean'
      ? record.showAvatars
      : DEFAULT_CUSTOMIZATION_SETTINGS.showAvatars,
    wrapCode: typeof record.wrapCode === 'boolean'
      ? record.wrapCode
      : DEFAULT_CUSTOMIZATION_SETTINGS.wrapCode,
    background: isBackground(record.background) ? record.background : DEFAULT_CUSTOMIZATION_SETTINGS.background,
    theme: isCustomizationTheme(record.theme) ? record.theme : DEFAULT_CUSTOMIZATION_SETTINGS.theme,
    fontSize: isCustomizationFontSize(record.fontSize) ? record.fontSize : DEFAULT_CUSTOMIZATION_SETTINGS.fontSize,
    brandName: isBrandName(record.brandName) ? (record.brandName as string).trim() : DEFAULT_CUSTOMIZATION_SETTINGS.brandName,
  }
}

/**
 * Persist customization settings, merging over the stored document.
 * @param patch - fields to store.
 */
export function writeCustomizationSettings(patch: Partial<CustomizationSettings>): void {
  const next: CustomizationSettings = { ...readCustomizationSettings(), ...patch }
  try {
    localStorage.setItem(CUSTOMIZATION_SETTINGS_STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Private-mode/quota writes fail silently: the page keeps its draft.
  }
}

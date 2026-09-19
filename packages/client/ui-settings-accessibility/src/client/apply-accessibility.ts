/**
 * Document applier for the browser-local accessibility document: projects
 * the interface font and the high-contrast theme onto data attributes of the
 * document root so stylesheets can react without React involvement. Only
 * presentation fields live here — sound/stripMarkdown/codeReading are read
 * lazily by their feature code and need no DOM projection.
 */
import type { AccessibilitySettings } from '@deepseek-ai/dsh-client-ui-primitives'

/** Root attribute carrying the interface/code typeface choice. */
export const A11Y_FONT_ATTRIBUTE = 'data-dsh-a11y-font'

/** Root attribute carrying the high-contrast theme choice. */
export const A11Y_CONTRAST_ATTRIBUTE = 'data-dsh-a11y-contrast'

/**
 * Project the document's font/contrast onto the root element. Pure DOM
 * writes of owned attributes; foreign attributes are untouched. Both
 * attributes are always written (the stylesheet only overrides
 * non-defaults), so an older document without these fields still converges
 * once read through the tolerant reader.
 * @param settings - the accessibility document (usually readAccessibilitySettings()).
 * @param root - element receiving the attributes (defaults to document.documentElement).
 */
export function applyAccessibilitySettings(settings: AccessibilitySettings, root?: Element): void {
  const target = root ?? document.documentElement
  target.setAttribute(A11Y_FONT_ATTRIBUTE, settings.font)
  target.setAttribute(A11Y_CONTRAST_ATTRIBUTE, settings.contrast)
}

/**
 * Retract the attributes this applier owns.
 * @param root - element carrying the attributes (defaults to document.documentElement).
 */
export function retractAccessibilitySettings(root?: Element): void {
  const target = root ?? document.documentElement
  target.removeAttribute(A11Y_FONT_ATTRIBUTE)
  target.removeAttribute(A11Y_CONTRAST_ATTRIBUTE)
}

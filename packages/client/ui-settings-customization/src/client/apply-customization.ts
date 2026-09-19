/**
 * Document applier for the browser-local customization document: projects
 * accent/density/background/code-wrap onto data attributes of the document
 * root so stylesheets can react without React involvement. Theme and font
 * size are deliberately NOT written here — the theme service owns those DOM
 * fields (see ui-layout's ThemePresenter); the Customization page pushes
 * them through ctx.theme on save instead.
 */
import type { CustomizationSettings } from './customization-settings.ts'

/** Root attribute carrying the accent choice. */
export const ACCENT_ATTRIBUTE = 'data-dsh-accent'

/** Root attribute carrying the density choice. */
export const DENSITY_ATTRIBUTE = 'data-dsh-density'

/** Root attribute carrying the chat background choice. */
export const BACKGROUND_ATTRIBUTE = 'data-dsh-background'

/**
 * Root attribute carrying the code-wrap choice ('on' wraps long lines,
 * 'off' keeps one line per row with horizontal scroll). Always written —
 * the code-block stylesheet only overrides for 'off', so earlier documents
 * without the attribute keep today's wrapping behavior.
 */
export const CODE_WRAP_ATTRIBUTE = 'data-dsh-code-wrap'

/**
 * Project the document's accent/density/background/code-wrap onto the root
 * element. Pure DOM writes of owned attributes; foreign attributes are
 * untouched.
 * @param settings - the customization document (usually readCustomizationSettings()).
 * @param root - element receiving the attributes (defaults to document.documentElement).
 */
export function applyCustomizationSettings(settings: CustomizationSettings, root?: Element): void {
  const target = root ?? document.documentElement
  target.setAttribute(ACCENT_ATTRIBUTE, settings.accent)
  target.setAttribute(DENSITY_ATTRIBUTE, settings.density)
  target.setAttribute(BACKGROUND_ATTRIBUTE, settings.background)
  target.setAttribute(CODE_WRAP_ATTRIBUTE, settings.wrapCode ? 'on' : 'off')
}

/**
 * Retract the attributes this applier owns.
 * @param root - element carrying the attributes (defaults to document.documentElement).
 */
export function retractCustomizationSettings(root?: Element): void {
  const target = root ?? document.documentElement
  target.removeAttribute(ACCENT_ATTRIBUTE)
  target.removeAttribute(DENSITY_ATTRIBUTE)
  target.removeAttribute(BACKGROUND_ATTRIBUTE)
  target.removeAttribute(CODE_WRAP_ATTRIBUTE)
}

/**
 * Voice navigation helper: speak menu/tab labels on focus/click.
 * Leaf module (zero React) so any client package may import it without
 * bundle-purity edges. Handles queue (cancel-before-speak), enabled gate,
 * and aria-label > textContent priority.
 *
 * The backend switch itself lives in speech-synthesis.ts, together with every
 * other read-aloud entry point, so navigation and answers can never end up
 * speaking through different engines.
 */

import { readAccessibilitySettings, readSpeechDelayMs, type VoiceNavChatTrigger } from './accessibility-settings.ts'
import { getTtsBackend } from './speech-synthesis.ts'
import { stripMarkdownForSpeech } from './speech-text.ts'

/**
 * Extract speakable text from an element: aria-label wins over textContent.
 * @param element - target element.
 * @returns trimmed text or empty string.
 */
export function getSpeakableNavText(element: Element): string {
  const aria = element.getAttribute('aria-label')
  if (aria !== null && aria.trim() !== '') return aria.trim()
  const text = element.textContent
  if (text !== null) return text.trim()
  return ''
}

/**
 * Whether voice navigation is enabled (lazy read of accessibility settings).
 * @returns true if the user turned on voice nav.
 */
export function isVoiceNavEnabled(): boolean {
  try {
    return readAccessibilitySettings().voiceNav === true
  } catch {
    return false
  }
}

/**
 * Whether hover voicing is enabled (master + sub-toggle).
 * @returns true only when both voiceNav and voiceNavHover are on.
 */
export function isVoiceNavHoverEnabled(): boolean {
  try {
    const settings = readAccessibilitySettings()
    return settings.voiceNav === true && settings.voiceNavHover === true
  } catch {
    return false
  }
}

/**
 * Whether arrow-key navigation is enabled (master + sub-toggle).
 * @returns true only when both voiceNav and voiceNavArrow are on.
 */
export function isVoiceNavArrowEnabled(): boolean {
  try {
    const settings = readAccessibilitySettings()
    return settings.voiceNav === true && settings.voiceNavArrow === true
  } catch {
    return false
  }
}

/**
 * How the empty chat placeholder is triggered (click/hover/both).
 * @returns the stored trigger, defaulting to 'both' when global is off.
 */
export function getVoiceNavChatTrigger(): VoiceNavChatTrigger {
  try {
    return readAccessibilitySettings().voiceNavChatTrigger
  } catch {
    return 'both'
  }
}

/** Last spoken label, for double-fire suppression (direct call + delegated listener). */
let lastSpokenText = ''
/** Timestamp (ms) of the last spoken label. */
let lastSpokenAt = 0

/** Read the user-tuned delay (ms) between utterances; falls back to 150. */
function getVoiceNavDelay(): number {
  return readSpeechDelayMs()
}

/**
 * Speak navigation label with queue handling.
 * Respects the global voiceNav toggle; forces cancel-before-speak.
 * Repeating the same label within a short window is a no-op, so a direct
 * component call and the global delegation listener never stutter.
 * @param rawText - raw label text (already extracted from element).
 */
export function speakNavText(rawText: string): void {
  if (!isVoiceNavEnabled()) return
  const text = rawText.trim()
  if (text === '') return
  const backend = getTtsBackend()
  if (!backend.isAvailable()) return
  try {
    // Strip markdown symbols so "## Settings" reads as "Settings".
    const clean = stripMarkdownForSpeech(text)
    const toSpeak = clean !== '' ? clean : text
    if (toSpeak === '') return
    const now = Date.now()
    const delay = getVoiceNavDelay()
    if (toSpeak === lastSpokenText && now - lastSpokenAt < Math.max(delay, 150)) return
    lastSpokenText = toSpeak
    lastSpokenAt = now
    backend.cancel()
    backend.speak(toSpeak, { rate: readAccessibilitySettings().speechRate })
  } catch {
    // Best effort: speech must never break navigation.
  }
}

/**
 * Speak the label of an element (aria-label > textContent).
 * @param element - target element.
 */
export function speakNavElement(element: Element): void {
  speakNavText(getSpeakableNavText(element))
}

/** Roles + plain buttons/links spoken by voice navigation (covers sidebar "Новая сессия", workspace pickers, etc.). */
export const VOICE_NAV_ACTIONABLE_SELECTOR = '[role="tab"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [role="treeitem"], button:not([disabled]), a[href]'

/** Broader hover selector: any button/link that can have an accessible name (covers composer toolbar, message actions). */
export const VOICE_NAV_HOVER_SELECTOR = 'button, a, [role="button"], [role="tab"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [role="treeitem"], [aria-label]'

/**
 * Create delegated handlers for a nav container (role="tablist"/"menu").
 * Use on a container with capture: <nav onFocusCapture={handlers.onFocus} onClickCapture={handlers.onClick}>.
 * Handlers are no-ops when voiceNav is off.
 * @returns focus and click handlers.
 */
export function createVoiceNavHandlers(): {
  onFocus: (event: FocusEvent) => void
  onClick: (event: MouseEvent) => void
} {
  const handle = (event: Event): void => {
    if (!isVoiceNavEnabled()) return
    const target = event.target
    if (!(target instanceof Element)) return
    // Closest actionable: button/tab/menuitem inside the container.
    const actionable = target.closest('[role="tab"], [role="menuitem"], button, a')
    const el = actionable ?? target
    speakNavElement(el)
  }
  return {
    onFocus: handle as (event: FocusEvent) => void,
    onClick: handle as (event: MouseEvent) => void,
  }
}

/** Focusable selector for arrow navigation (toolbar/message actions). */
export const FOCUSABLE_SELECTOR = 'button:not([disabled]), a[href], [tabindex="0"]:not([disabled]), [role="tab"]:not([aria-disabled="true"]), [role="menuitem"]:not([aria-disabled="true"]), [role="option"]:not([aria-disabled="true"])'

/** Any tablist (settings nav, model picker, etc.) — must not hijack scroll when arrow-nav is off. */
const SETTINGS_NAV_SELECTOR = '[role="tablist"]'

/**
 * Install arrow-key navigation for voice mode: when focus is on a button inside
 * a toolbar/listbox/tablist, ArrowLeft/Right (Up/Down for vertical) moves focus
 * to the next item, highlights it and speaks it.
 * @param root - document to listen on.
 * @returns cleanup.
 */
export function installVoiceNavArrowDelegation(root?: Document | Element): () => void {
  const target = root ?? (typeof document !== 'undefined' ? document : undefined)
  if (target === undefined) return () => {}
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!isVoiceNavArrowEnabled()) return
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
    const active = document.activeElement
    if (!(active instanceof HTMLElement)) return
    // Don't hijack when typing in an editable.
    if (active.closest('[contenteditable="true"], input, textarea, [role="textbox"]') !== null) return
    // In a vertical settings nav, let the browser scroll if no toolbar grouping.
    const settingsNav = active.closest(SETTINGS_NAV_SELECTOR)
    if (settingsNav !== null && !active.matches(FOCUSABLE_SELECTOR)) return
    // If focus is not on a control, seed it to the first item in the nearest group
    // so the first Arrow press is useful everywhere (empty composer chrome, etc.).
    const focusable = active.matches(FOCUSABLE_SELECTOR) ? active : null
    let group: Element | null = focusable?.closest(
      '[data-composer-card], [role="toolbar"], [role="tablist"], [role="menu"], [role="listbox"], [data-action-group], .actions',
    ) ?? null
    if (focusable === null) {
      // Try to find a toolbar near the active element, or the settings nav.
      group = active.closest('[data-composer-card], [role="toolbar"], [role="menu"], [role="listbox"]')
        ?? document.querySelector(SETTINGS_NAV_SELECTOR)
        ?? document.querySelector('[data-composer-card]')
      if (group === null) return
      const first = group.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
      if (first === null) return
      event.preventDefault()
      first.focus()
      try {
        first.setAttribute('data-voice-arrow-active', 'true')
        window.setTimeout(() => { first.removeAttribute('data-voice-arrow-active') }, 1200)
      } catch {}
      speakNavElement(first)
      return
    }
    if (group === null) group = focusable.parentElement
    if (group === null) return
    // Don't hijack vertical scroll in a scrollable list when not in that list.
    if (settingsNav === null && group.closest(SETTINGS_NAV_SELECTOR) === null && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      const scrollable = group.closest('[data-conversation-scroll], [class*="scroll"]')
      if (scrollable !== null && scrollable.scrollHeight > scrollable.clientHeight) {
        // Let the scroll happen; still speak the next logical item after scroll?
        // Keep native scroll, don't preventDefault.
        return
      }
    }
    const items = Array.from(group.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      .filter(el => el.offsetParent !== null || el.getClientRects().length > 0)
    // Fallback: also collect siblings in same flex row if group query was too broad.
    const pool = items.length >= 2
      ? items
      : Array.from((focusable.parentElement ?? group).querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    const idx = pool.indexOf(focusable)
    if (idx === -1 || pool.length < 2) return
    let nextIdx = idx
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIdx = (idx + 1) % pool.length
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIdx = (idx - 1 + pool.length) % pool.length
    else if (event.key === 'Home') nextIdx = 0
    else if (event.key === 'End') nextIdx = pool.length - 1
    if (nextIdx === idx) return
    event.preventDefault()
    const next = pool[nextIdx]
    if (next === undefined) return
    next.focus()
    // Visual highlight: data attribute for CSS hook.
    try {
      pool.forEach((el) => { el.removeAttribute('data-voice-arrow-active') })
      next.setAttribute('data-voice-arrow-active', 'true')
      window.setTimeout(() => { next.removeAttribute('data-voice-arrow-active') }, 1200)
    } catch {}
    speakNavElement(next)
  }
  target.addEventListener('keydown', onKeyDown as EventListener, true)
  return () => { target.removeEventListener('keydown', onKeyDown as EventListener, true) }
}

/**
 * Install app-wide voice navigation: one document-level listener speaks
 * every tab / menu item / listbox option on focus or click, so no menu
 * needs its own wiring (settings nav, model picker, command palettes,
 * slash-menus, future context menus). No-ops when voiceNav is off.
 * Capture phase, so component-level stopPropagation never mutes it.
 * Hover voicing is gated by the voiceNavHover sub-toggle.
 * @param root - document or element to listen on (defaults to the document).
 * @returns cleanup uninstalling listeners.
 */
export function installVoiceNavDelegation(root?: Document | Element): () => void {
  const target = root ?? (typeof document !== 'undefined' ? document : undefined)
  if (target === undefined) return () => {}
  const speakPlaceholderIf = (el: Element): boolean => {
    // Only the small composer editor itself voices its placeholder — the large
    // black background and empty viewArea are silent (user request).
    const ph = el.closest('[data-placeholder], [aria-label][data-phase]')
    if (ph !== null) {
      const text = ph.getAttribute('data-placeholder') ?? ph.getAttribute('aria-label') ?? ''
      if (text.trim() !== '') { speakNavText(text); return true }
    }
    return false
  }

  const handleFocusIn = (event: Event): void => {
    if (!isVoiceNavEnabled()) return
    const eventTarget = event.target
    if (!(eventTarget instanceof Element)) return
    // Titlebar window controls are hover-only; focus would spam on restore
    if (eventTarget.closest('#harness-injected-titlebar, #titlebar') !== null) return
    // Focus should never voice the placeholder on launch / new session.
    const actionable = eventTarget.closest(VOICE_NAV_ACTIONABLE_SELECTOR)
    if (actionable === null) return
    const label = actionable.getAttribute('aria-label') ?? ''
    if (actionable.id === 'btnClose' || label === 'Закрыть' || label === 'Close') return
    speakNavElement(actionable)
  }
  const handleClick = (event: Event): void => {
    if (!isVoiceNavEnabled()) return
    const eventTarget = event.target
    if (!(eventTarget instanceof Element)) return
    // Titlebar window controls are voiced via window status, not button label on click
    if (eventTarget.closest('#harness-injected-titlebar, #titlebar') !== null) return
    const trigger = getVoiceNavChatTrigger()
    if ((trigger === 'click' || trigger === 'both') && speakPlaceholderIf(eventTarget)) return
    const actionable = eventTarget.closest(VOICE_NAV_ACTIONABLE_SELECTOR)
    if (actionable === null) return
    speakNavElement(actionable)
  }
  const handleHover = (event: Event): void => {
    if (!isVoiceNavHoverEnabled()) return
    // Throttle hover by user delay so fast mouse moves don't spam.
    const now = Date.now()
    const delay = getVoiceNavDelay()
    if (now - lastSpokenAt < delay) return
    const eventTarget = event.target
    if (!(eventTarget instanceof Element)) return
    const trigger = getVoiceNavChatTrigger()
    if ((trigger === 'hover' || trigger === 'both') && speakPlaceholderIf(eventTarget)) return
    const actionable = eventTarget.closest(VOICE_NAV_HOVER_SELECTOR)
    if (actionable === null) return
    // Close button is intentionally silent (user request)
    const label = actionable.getAttribute('aria-label') ?? ''
    if (actionable.id === 'btnClose' || label === 'Закрыть' || label === 'Close') return
    // Only speak if the element actually has a name (aria-label or text).
    if (getSpeakableNavText(actionable) === '') return
    speakNavElement(actionable)
  }
  const onFocusIn = (event: Event): void => { handleFocusIn(event) }
  const onClick = (event: Event): void => { handleClick(event) }
  const onMouseOver = (event: Event): void => { handleHover(event) }
  target.addEventListener('focusin', onFocusIn, true)
  target.addEventListener('click', onClick, true)
  target.addEventListener('mouseover', onMouseOver, true)
  return () => {
    target.removeEventListener('focusin', onFocusIn, true)
    target.removeEventListener('click', onClick, true)
    target.removeEventListener('mouseover', onMouseOver, true)
  }
}

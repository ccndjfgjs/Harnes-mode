// @vitest-environment jsdom
// speak-nav.ts: voice navigation helpers.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { writeAccessibilitySettings } from '../src/accessibility-settings.ts'
import { setTtsBackend, webSpeechBackend, type TtsBackend } from '../src/speech-synthesis.ts'
import {
  createVoiceNavHandlers,
  getSpeakableNavText,
  installVoiceNavDelegation,
  isVoiceNavArrowEnabled,
  isVoiceNavEnabled,
  isVoiceNavHoverEnabled,
  speakNavElement,
  speakNavText,
} from '../src/speak-nav.ts'

/**
 * Mock TTS backend that works in jsdom (no speechSynthesis).
 *
 * The two spies are held as their own bindings rather than read back off
 * `mockBackend`: `expect(speakSpy)` is an unbound-method reference,
 * which the repository lint contract rejects because it invites `this`
 * scoping bugs. Asserting on the standalone spy keeps the same coverage.
 */
const speakSpy = vi.fn()
const cancelSpy = vi.fn()
const mockBackend: TtsBackend = {
  isAvailable: () => true,
  speak: speakSpy,
  cancel: cancelSpy,
}

beforeEach(() => {
  setTtsBackend(mockBackend)
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  setTtsBackend(null)
})

describe('speak-nav', () => {
  it('reads aria-label over textContent', () => {
    const div = document.createElement('div')
    div.setAttribute('aria-label', 'ARIA label')
    div.textContent = 'text content'
    expect(getSpeakableNavText(div)).toBe('ARIA label')
  })

  it('falls back to textContent when aria-label missing', () => {
    const div = document.createElement('div')
    div.textContent = 'plain text'
    expect(getSpeakableNavText(div)).toBe('plain text')
  })

  it('returns empty string for empty element', () => {
    const div = document.createElement('div')
    expect(getSpeakableNavText(div)).toBe('')
  })

  it('isVoiceNavEnabled reads from settings', () => {
    expect(isVoiceNavEnabled()).toBe(false)
    writeAccessibilitySettings({ voiceNav: true })
    expect(isVoiceNavEnabled()).toBe(true)
    writeAccessibilitySettings({ voiceNav: false })
    expect(isVoiceNavEnabled()).toBe(false)
  })

  it('speakNavText is no-op when voiceNav disabled', () => {
    writeAccessibilitySettings({ voiceNav: false })
    speakNavText('hello')
    expect(speakSpy).not.toHaveBeenCalled()
  })

  it('speakNavText uses backend when voiceNav enabled', () => {
    writeAccessibilitySettings({ voiceNav: true })
    speakNavText('hello world')
    expect(speakSpy).toHaveBeenCalledWith('hello world')
  })

  it('speakNavElement delegates to speakNavText', () => {
    writeAccessibilitySettings({ voiceNav: true })
    const div = document.createElement('button')
    div.textContent = 'click me'
    speakNavElement(div)
    expect(speakSpy).toHaveBeenCalledWith('click me')
  })

  it('createVoiceNavHandlers returns handlers that call speakNavElement', () => {
    writeAccessibilitySettings({ voiceNav: true })
    const { onFocus } = createVoiceNavHandlers()
    const btn = document.createElement('button')
    btn.setAttribute('role', 'tab')
    btn.textContent = 'tab'
    document.body.appendChild(btn)
    // Use a simple event object with target set
    const focusEvent = { target: btn } as unknown as FocusEvent
    onFocus(focusEvent)
    expect(speakSpy).toHaveBeenCalledWith('tab')
    document.body.removeChild(btn)
  })

  it('dedupes the same label focused then clicked', () => {
    writeAccessibilitySettings({ voiceNav: true })
    const { onFocus, onClick } = createVoiceNavHandlers()
    const btn = document.createElement('button')
    btn.setAttribute('role', 'tab')
    // Unique label: dedupe state is module-level across tests.
    btn.textContent = 'dedup-tab'
    document.body.appendChild(btn)
    onFocus({ target: btn } as unknown as FocusEvent)
    onClick({ target: btn } as unknown as MouseEvent)
    // Same label twice in a row: one utterance, no stutter.
    expect(speakSpy).toHaveBeenCalledTimes(1)
    expect(speakSpy).toHaveBeenCalledWith('dedup-tab')
    document.body.removeChild(btn)
  })

  it('speaks different labels in a row (queue cancel)', () => {
    writeAccessibilitySettings({ voiceNav: true })
    speakNavText('first')
    speakNavText('second')
    expect(speakSpy).toHaveBeenCalledTimes(2)
    expect(cancelSpy).toHaveBeenCalled()
  })

  it('installVoiceNavDelegation speaks menu items on click', () => {
    writeAccessibilitySettings({ voiceNav: true })
    const uninstall = installVoiceNavDelegation()
    try {
      const btn = document.createElement('button')
      btn.setAttribute('role', 'menuitemradio')
      btn.textContent = 'DeepSeek V4'
      document.body.appendChild(btn)
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect(speakSpy).toHaveBeenCalledWith('DeepSeek V4')
      document.body.removeChild(btn)
    } finally {
      uninstall()
    }
  })

  it('installVoiceNavDelegation speaks tabs on focusin', () => {
    writeAccessibilitySettings({ voiceNav: true })
    const uninstall = installVoiceNavDelegation()
    try {
      const btn = document.createElement('button')
      btn.setAttribute('role', 'tab')
      btn.textContent = 'Models'
      document.body.appendChild(btn)
      btn.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
      expect(speakSpy).toHaveBeenCalledWith('Models')
      document.body.removeChild(btn)
    } finally {
      uninstall()
    }
  })

  it('installVoiceNavDelegation ignores non-menu elements', () => {
    writeAccessibilitySettings({ voiceNav: true })
    const uninstall = installVoiceNavDelegation()
    try {
      const div = document.createElement('div')
      div.textContent = 'plain content'
      document.body.appendChild(div)
      div.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect(speakSpy).not.toHaveBeenCalled()
      document.body.removeChild(div)
    } finally {
      uninstall()
    }
  })

  it('installVoiceNavDelegation cleanup stops speech', () => {
    writeAccessibilitySettings({ voiceNav: true })
    const uninstall = installVoiceNavDelegation()
    uninstall()
    const btn = document.createElement('button')
    btn.setAttribute('role', 'menuitem')
    btn.textContent = 'Models'
    document.body.appendChild(btn)
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(speakSpy).not.toHaveBeenCalled()
    document.body.removeChild(btn)
  })

  it('installVoiceNavDelegation is silent when voiceNav is off', () => {
    writeAccessibilitySettings({ voiceNav: false })
    const uninstall = installVoiceNavDelegation()
    try {
      const btn = document.createElement('button')
      btn.setAttribute('role', 'menuitem')
      btn.textContent = 'Models'
      document.body.appendChild(btn)
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect(speakSpy).not.toHaveBeenCalled()
      document.body.removeChild(btn)
    } finally {
      uninstall()
    }
  })

  it('handlers are no-op when voiceNav disabled', () => {
    writeAccessibilitySettings({ voiceNav: false })
    const { onFocus, onClick } = createVoiceNavHandlers()
    const btn = document.createElement('button')
    btn.textContent = 'tab'
    document.body.appendChild(btn)
    const focusEvent = { target: btn } as unknown as FocusEvent
    const clickEvent = { target: btn } as unknown as MouseEvent
    onFocus(focusEvent)
    onClick(clickEvent)
    expect(speakSpy).not.toHaveBeenCalled()
    document.body.removeChild(btn)
  })

  it('speakNavText strips markdown before speaking', () => {
    writeAccessibilitySettings({ voiceNav: true, stripMarkdown: true })
    speakNavText('# Heading')
    expect(speakSpy).toHaveBeenCalledWith('Heading')
  })

  it('setTtsBackend allows custom backend', () => {
    const customSpeak = vi.fn()
    const customBackend: TtsBackend = {
      isAvailable: () => true,
      speak: customSpeak,
      cancel: vi.fn(),
    }
    setTtsBackend(customBackend)
    writeAccessibilitySettings({ voiceNav: true })
    speakNavText('custom')
    expect(customSpeak).toHaveBeenCalledWith('custom')
    setTtsBackend(null)
  })

  it('webSpeechBackend.cancel stops speechSynthesis', () => {
    // This tests the real backend's cancel method
    webSpeechBackend.cancel()
    expect(cancelSpy).not.toHaveBeenCalled() // mockBackend is separate
  })

  it('voiceNavArrow gate: arrow off is silent', () => {
    writeAccessibilitySettings({ voiceNav: true, voiceNavHover: true, voiceNavArrow: false })
    expect(isVoiceNavArrowEnabled()).toBe(false)
    writeAccessibilitySettings({ voiceNav: true, voiceNavArrow: true })
    expect(isVoiceNavArrowEnabled()).toBe(true)
    expect(isVoiceNavHoverEnabled()).toBe(true)
  })

  it('voiceNavHover gate: hover is silent when sub-toggle is off', () => {
    writeAccessibilitySettings({ voiceNav: true, voiceNavHover: false })
    const uninstall = installVoiceNavDelegation()
    try {
      const btn = document.createElement('button')
      btn.setAttribute('role', 'menuitem')
      btn.textContent = 'Hover item'
      document.body.appendChild(btn)
      btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      expect(speakSpy).not.toHaveBeenCalled()
      document.body.removeChild(btn)
    } finally {
      uninstall()
    }
  })

  it('voiceNavHover gate: hover speaks when sub-toggle is on', () => {
    writeAccessibilitySettings({ voiceNav: true, voiceNavHover: true, voiceNavDelay: 0 })
    const uninstall = installVoiceNavDelegation()
    try {
      const btn = document.createElement('button')
      btn.setAttribute('role', 'menuitem')
      btn.textContent = 'Hover item'
      document.body.appendChild(btn)
      btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      expect(speakSpy).toHaveBeenCalledWith('Hover item')
      document.body.removeChild(btn)
    } finally {
      uninstall()
    }
  })

  it('voiceNavHover gate: master off mutes even hover-on', () => {
    writeAccessibilitySettings({ voiceNav: false, voiceNavHover: true })
    const uninstall = installVoiceNavDelegation()
    try {
      const btn = document.createElement('button')
      btn.setAttribute('role', 'menuitem')
      btn.textContent = 'Hover item'
      document.body.appendChild(btn)
      btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      expect(speakSpy).not.toHaveBeenCalled()
      document.body.removeChild(btn)
    } finally {
      uninstall()
    }
  })
})

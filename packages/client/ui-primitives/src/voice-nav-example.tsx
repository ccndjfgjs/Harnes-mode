/**
 * Voice-navigation menu example: shows how to use the TTS utility
 * with correct ARIA and queue handling. This file is documentation-only;
 * not exported from the package barrel to avoid bundle bloat.
 *
 * Every label arrives as a prop: product copy is locale-owned, so an
 * example never embeds display text of its own.
 */
import { useCallback } from 'react'
import { Menu, type MenuEntry } from './Menu.tsx'
import type { TtsBackend } from './speech-synthesis.ts'
import { getSpeakableNavText, speakNavElement, speakNavText } from './speak-nav.ts'

/** Example 1: Menu with built-in voice nav (recommended). */
export function VoiceNavMenuExample({ items, triggerLabel }: {
  readonly items: readonly MenuEntry[]
  readonly triggerLabel: string
}) {
  return (
    // Menu already handles onFocus/onClick → speakNavElement internally
    // when accessibilitySettings.voiceNav is on (aria-label > textContent,
    // speechSynthesis.cancel() before speak). No extra code needed.
    <Menu open anchor={<button type="button">{triggerLabel}</button>} items={items} onSelect={() => {}} onClose={() => {}} />
  )
}

/** Example 2: Custom tablist with delegated handlers (tabs, sidebar). */
export function VoiceNavTabsExample({ tabs, listLabel }: {
  readonly tabs: readonly { readonly id: string; readonly label: string }[]
  readonly listLabel: string
}) {
  const onFocus = useCallback((event: React.FocusEvent<HTMLElement>) => {
    speakNavElement(event.currentTarget)
  }, [])
  const onClick = useCallback((event: React.MouseEvent<HTMLElement>) => {
    speakNavElement(event.currentTarget)
  }, [])

  return (
    <div role="tablist" aria-label={listLabel}>
      {tabs.map(tab => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={false}
          aria-label={tab.label}
          onFocus={onFocus}
          onClick={onClick}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}

/** Example 3: Plugging an external TTS API via abstraction. */
export function setupExternalTts(api: { speak(text: string): void; cancel(): void }): void {
  const backend: TtsBackend = {
    isAvailable: () => true,
    speak: (text: string) => { api.speak(getSpeakableNavText(document.createElement('div')) || text) },
    cancel: () => { api.cancel() },
  }
  // Replace Web Speech API with your provider:
  // import { setTtsBackend } from '@deepseek-ai/dsh-client-ui-primitives'
  // setTtsBackend(backend)
  void backend
  void speakNavText
}

/**
 * Integration steps:
 * 1. Enable the toggle in Settings → Accessibility → voice navigation (voiceNav).
 *    Stored in localStorage['dsh.accessibility.settings'].voiceNav.
 * 2. Import speak-nav.ts (leaf, no deps) in any menu/tab component.
 * 3. Add onFocus + onClick → speakNavElement(event.currentTarget) (or use createVoiceNavHandlers()
 *    for delegated containers). Text resolves as aria-label ?? textContent, strips Markdown.
 * 4. Queue: speak() does speechSynthesis.cancel() before speak(), so rapid clicks never overlap.
 * 5. ARIA: ensure containers have role="tablist"/"menu" and items have role="tab"/"menuitem".
 * 6. Labels: pass locale-owned strings in as props; never hardcode display text here.
 */

// @vitest-environment jsdom
/** Accessibility section registration: nav identity, locale-owned label, and teardown. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { AccessibilitySection, apply, inject } from '@deepseek-ai/dsh-client-ui-settings-accessibility/client'
import type { AccessibilitySectionInjected } from '../src/client/AccessibilitySection.tsx'
import { retractAccessibilitySettings } from '../src/client/apply-accessibility.ts'
import {
  ACCESSIBILITY_SETTINGS_STORAGE_KEY,
} from '@deepseek-ai/dsh-client-ui-primitives/src/accessibility-settings.ts'

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const remote = new TestRemote(ctx, {
    settings: {
      describe: vi.fn(() => Promise.resolve({ ok: true as const, value: { writable: true, hasDocument: true, namespaces: [] } })),
      openSettingsDocument: vi.fn(() => Promise.resolve({ ok: true as const, value: { opened: true as const } })),
    },
  })
  remote.$host = { home: undefined, isLoopback: true }
  ctx.provide('connection', {
    state: { getSnapshot: () => 'connected', subscribe: () => () => {} },
    reconnect: () => {},
  } as never)
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale }
}

/** Declare the shell's section slot the way ui-settings' entry does. */
function declare(slots: SlotRegistry): void {
  slots.register(
    {
      name: 'root',
      children: { 'settings.section': { kind: 'list', scope: 'root' } },
    } as never,
    () => null,
  )
}

function accessibilityEntry(slots: SlotRegistry) {
  return slots.entries('settings.section').find(e => e.component === AccessibilitySection)
}

afterEach(() => {
  localStorage.clear()
  retractAccessibilitySettings()
})

describe('ui-settings-accessibility apply', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('projects the stored font and contrast onto the document root at boot', async () => {
    localStorage.setItem(ACCESSIBILITY_SETTINGS_STORAGE_KEY, JSON.stringify({
      font: 'mono', contrast: 'bw',
    }))
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(document.documentElement.getAttribute('data-dsh-a11y-font')).toBe('mono')
    expect(document.documentElement.getAttribute('data-dsh-a11y-contrast')).toBe('bw')
  })

  it('skips the document projection without a document', async () => {
    const b = await bench()
    declare(b.slots)
    vi.stubGlobal('document', undefined)
    try {
      await b.ctx.plugin({ inject: [...inject], apply }).await()
    } finally {
      vi.unstubAllGlobals()
    }
    expect(document.documentElement.hasAttribute('data-dsh-a11y-font')).toBe(false)
  })

  it('survives unreadable storage at boot', async () => {
    const b = await bench()
    declare(b.slots)
    vi.stubGlobal('localStorage', undefined)
    try {
      await b.ctx.plugin({ inject: [...inject], apply }).await()
    } finally {
      vi.unstubAllGlobals()
    }
    expect(document.documentElement.getAttribute('data-dsh-a11y-font')).toBe('atkinson')
  })

  it('registers the accessibility section after the voice section', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = accessibilityEntry(b.slots)!
    expect(entry.options).toMatchObject({ id: 'accessibility', order: 30 })
    expect(entry.locale).toBe('settings.accessibility')
    expect(resolveSlotLabel(entry.options.label)).toBe('无障碍设置')
    b.locale.setLocale('en')
    expect(resolveSlotLabel(entry.options.label)).toBe('Accessibility')
    b.locale.setLocale('zh')
  })

  it('injects the locale seat into the section', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = accessibilityEntry(b.slots)!
    const injected = (entry.inject as unknown as () => AccessibilitySectionInjected)()
    expect(injected.t('nav')).toBe('无障碍设置')
  })

  it('registers the zh/en dictionaries and frees the seat on teardown', async () => {
    const b = await bench()
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.locale.bind('settings.accessibility')('nav')).toBe('无障碍设置')
    expect(b.locale.bind('settings.accessibility')('code.full')).toBe('完整')
    b.locale.setLocale('en')
    expect(b.locale.bind('settings.accessibility')('nav')).toBe('Accessibility')
    b.locale.setLocale('zh')
    await fiber.dispose()
    expect(b.slots.entries('settings.section')).toEqual([])
  })
})

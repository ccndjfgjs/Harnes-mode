// @vitest-environment jsdom
/** Customization section registration: nav identity, locale-owned label, and teardown. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-settings-customization/client'
import { retractCustomizationSettings } from '../src/client/apply-customization.ts'
import {
  CUSTOMIZATION_SETTINGS_STORAGE_KEY,
} from '../src/client/customization-settings.ts'
import { CustomizationSection } from '../src/client/CustomizationSection.tsx'
import type { CustomizationSectionInjected } from '../src/client/CustomizationSection.tsx'

afterEach(() => {
  localStorage.clear()
  retractCustomizationSettings()
})

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const theme = {
    getTheme: () => ({ preference: 'system', fontSize: 14 }),
    setTheme: vi.fn(),
    setFontSize: vi.fn(),
  }
  ctx.provide('theme', theme)
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
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, theme }
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

function customizationEntry(slots: SlotRegistry) {
  return slots.entries('settings.section').find(e => e.component === CustomizationSection)
}

describe('ui-settings-customization apply', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'theme'])
  })

  it('projects the stored attributes onto the document root at boot', async () => {
    localStorage.setItem(CUSTOMIZATION_SETTINGS_STORAGE_KEY, JSON.stringify({
      accent: 'green', density: 'compact', background: 'grid',
    }))
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(document.documentElement.getAttribute('data-dsh-accent')).toBe('green')
    expect(document.documentElement.getAttribute('data-dsh-density')).toBe('compact')
    expect(document.documentElement.getAttribute('data-dsh-background')).toBe('grid')
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
    expect(document.documentElement.hasAttribute('data-dsh-accent')).toBe(false)
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
    expect(document.documentElement.getAttribute('data-dsh-accent')).toBe('blue')
  })

  it('bridges the live theme service through the section injection', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = customizationEntry(b.slots)!
    const injected = (entry.inject as unknown as () => CustomizationSectionInjected)()
    expect(injected.getLiveAppearance?.()).toEqual({ theme: 'system', fontSize: 14 })
    injected.applyLive?.({ theme: 'dark', fontSize: 16 })
    expect(b.theme.setTheme).toHaveBeenCalledWith('dark')
    expect(b.theme.setFontSize).toHaveBeenCalledWith(16)
  })

  it('registers the customization section last', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = customizationEntry(b.slots)!
    expect(entry.options).toMatchObject({ id: 'customization', order: 35 })
    expect(entry.locale).toBe('settings.customization')
    expect(resolveSlotLabel(entry.options.label)).toBe('个性化设置')
    b.locale.setLocale('en')
    expect(resolveSlotLabel(entry.options.label)).toBe('Customization')
    b.locale.setLocale('zh')
  })

  it('registers the zh/en dictionaries and frees the seat on teardown', async () => {
    const b = await bench()
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.locale.bind('settings.customization')('nav')).toBe('个性化设置')
    expect(b.locale.bind('settings.customization')('density.spacious')).toBe('宽松')
    b.locale.setLocale('en')
    expect(b.locale.bind('settings.customization')('nav')).toBe('Customization')
    b.locale.setLocale('zh')
    await fiber.dispose()
    expect(b.slots.entries('settings.section')).toEqual([])
  })
})

/** About section registration: nav identity, locale-owned label, and teardown. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-settings-about/client'
import { AboutSection } from '../src/client/AboutSection.tsx'

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

function aboutEntry(slots: SlotRegistry) {
  return slots.entries('settings.section').find(e => e.component === AboutSection)
}

describe('ui-settings-about apply', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('registers the about section last', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = aboutEntry(b.slots)!
    expect(entry.options).toMatchObject({ id: 'about', order: 40 })
    expect(entry.locale).toBe('settings.about')
    expect(resolveSlotLabel(entry.options.label)).toBe('关于开发者')
    b.locale.setLocale('ru')
    expect(resolveSlotLabel(entry.options.label)).toBe('О разработчике')
    b.locale.setLocale('en')
    expect(resolveSlotLabel(entry.options.label)).toBe('About')
    b.locale.setLocale('zh')
  })

  it('registers the zh/en/ru dictionaries and frees the seat on teardown', async () => {
    const b = await bench()
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.locale.bind('settings.about')('nav')).toBe('关于开发者')
    expect(b.locale.bind('settings.about')('access.title')).toContain('无障碍')
    b.locale.setLocale('ru')
    expect(b.locale.bind('settings.about')('nav')).toBe('О разработчике')
    b.locale.setLocale('zh')
    await fiber.dispose()
    expect(b.slots.entries('settings.section')).toEqual([])
  })
})

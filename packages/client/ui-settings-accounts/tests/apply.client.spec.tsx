/** Accounts section registration: nav identity, locale-owned label, and teardown. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-settings-accounts/client'
import { AccountsSection } from '../src/client/AccountsSection.tsx'

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const sources: InputTriggerSource[] = []
  ctx.provide('inputTriggers', {
    registerSource: (source: InputTriggerSource) => {
      sources.push(source)
      return () => {
        const at = sources.indexOf(source)
        if (at >= 0) sources.splice(at, 1)
      }
    },
  })
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
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, sources }
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

function accountsEntry(slots: SlotRegistry) {
  return slots.entries('settings.section').find(e => e.component === AccountsSection)
}

describe('ui-settings-accounts apply', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'inputTriggers', 'locale'])
  })

  it('registers the /cloud trigger source beside the section', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const source = b.sources.find(entry => entry.name === 'cloud')
    expect(source?.trigger).toBe('/')
  })

  it('registers the accounts section after voice', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = accountsEntry(b.slots)!
    expect(entry.options).toMatchObject({ id: 'accounts', order: 26 })
    expect(entry.locale).toBe('settings.accounts')
    expect(resolveSlotLabel(entry.options.label)).toBe('账户')
    b.locale.setLocale('ru')
    expect(resolveSlotLabel(entry.options.label)).toBe('Аккаунт')
    b.locale.setLocale('en')
    expect(resolveSlotLabel(entry.options.label)).toBe('Accounts')
    b.locale.setLocale('zh')
  })

  it('registers the zh/en/ru dictionaries and frees the seat on teardown', async () => {
    const b = await bench()
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.locale.bind('settings.accounts')('nav')).toBe('账户')
    expect(b.locale.bind('settings.accounts')('auth.empty')).toContain('账户')
    b.locale.setLocale('ru')
    expect(b.locale.bind('settings.accounts')('nav')).toBe('Аккаунт')
    b.locale.setLocale('zh')
    await fiber.dispose()
    expect(b.slots.entries('settings.section')).toEqual([])
  })
})

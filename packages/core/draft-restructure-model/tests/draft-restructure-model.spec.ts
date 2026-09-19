/**
 * Draft-restructure model settings layered over a real settings provider.
 *
 * The section has one behaviour the Agent default does not: "not configured"
 * is a first-class state rather than an error, because an absent choice means
 * "follow the Agent". These tests pin that state, the atomic provider/model
 * pair, and the fallback back to the composition entry.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  DRAFT_RESTRUCTURE_MODEL_SETTINGS_NAMESPACE,
  DraftRestructureModelConfig,
} from '../src/index.ts'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'

/** The smallest real provider: one in-memory document, always writable. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

async function boot(entry: { provider?: string; model?: string } = {}): Promise<{
  ctx: Context
  settingsFiber: Context['fiber']
  model: DraftRestructureModelConfig
}> {
  const ctx = new Context()
  const settingsFiber = ctx.plugin(MemorySettings)
  await settingsFiber.await()
  await ctx.plugin(DraftRestructureModelConfig, entry)
  return { ctx, settingsFiber, model: ctx.draftRestructureModel }
}

describe('DraftRestructureModelConfig', () => {
  it('starts unconfigured, so the button follows the Agent default', async () => {
    const bench = await boot()
    expect(bench.model.currentSelection()).toBeUndefined()
    expect(bench.model.currentRoute()).toBeUndefined()
    await bench.ctx.fiber.dispose()
  })

  it('reads the user layer over the composition entry', async () => {
    const bench = await boot({ provider: 'entry-provider', model: 'entry-model' })
    await bench.settingsFiber.ctx.settings.replace(DRAFT_RESTRUCTURE_MODEL_SETTINGS_NAMESPACE, {
      provider: 'chosen-provider',
      model: 'chosen-model',
    })
    expect(bench.model.currentSelection()).toEqual({
      provider: 'chosen-provider', model: 'chosen-model',
    })
    await bench.ctx.fiber.dispose()
  })

  // The pair is atomic on purpose: naming a provider without its model would
  // address a route that cannot exist, and falling back silently would hide a
  // form bug behind working behaviour.
  it('refuses a half-written pair at the composition entry', async () => {
    await expect(boot({ provider: 'only-provider' })).rejects.toThrow(/both a provider and a model/)
  })

  it('refuses a half-written pair written through settings', async () => {
    const bench = await boot()
    await expect(bench.settingsFiber.ctx.settings.replace(DRAFT_RESTRUCTURE_MODEL_SETTINGS_NAMESPACE, {
      provider: 'only-provider',
      model: '',
    })).rejects.toThrow(/both a provider and a model/)
    expect(bench.model.currentSelection()).toBeUndefined()
    await bench.ctx.fiber.dispose()
  })

  it('returns to unconfigured when the stored pair is cleared', async () => {
    const bench = await boot({ provider: 'entry-provider', model: 'entry-model' })
    await bench.settingsFiber.ctx.settings.replace(DRAFT_RESTRUCTURE_MODEL_SETTINGS_NAMESPACE, {
      provider: '', model: '',
    })
    expect(bench.model.currentSelection()).toBeUndefined()
    await bench.ctx.fiber.dispose()
  })

  it('keeps the composition entry when the settings provider detaches', async () => {
    const bench = await boot({ provider: 'entry-provider', model: 'entry-model' })
    expect(bench.model.currentRoute()).toEqual({ provider: 'entry-provider', model: 'entry-model' })
    await bench.settingsFiber.dispose()
    expect(bench.model.currentRoute()).toEqual({ provider: 'entry-provider', model: 'entry-model' })
    await bench.ctx.fiber.dispose()
  })

  it('works with no settings provider mounted at all', async () => {
    const ctx = new Context()
    await ctx.plugin(DraftRestructureModelConfig, { provider: 'p', model: 'm' })
    expect(ctx.draftRestructureModel.currentRoute()).toEqual({ provider: 'p', model: 'm' })
    await ctx.fiber.dispose()
  })
})

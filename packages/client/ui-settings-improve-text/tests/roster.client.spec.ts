/**
 * The Improve-text page roster: one catalog read joined with credential
 * states, and the two pure folds that decide what a row means.
 *
 * The important property is what the page does NOT do — it never re-declares
 * a provider. A provider shows up here exactly when the Host serves it, which
 * is the same fact the Models page reads, so "choose an existing provider"
 * cannot drift between the two pages.
 */

import { describe, expect, it, vi } from 'vitest'
import type { CredentialInfo, ModelCatalog, ModelCatalogModel } from '@deepseek-ai/dsh-api-remotes/client'
import {
  createRosterStore,
  deriveKeyRef,
  loadRoster,
  providerUsable,
} from '../src/client/roster.ts'
import type { ImproveTextOperations } from '../src/client/roster.ts'

const MODELS: readonly ModelCatalogModel[] = [
  { id: 'fast', name: 'Fast' },
  { id: 'deep', name: 'Deep' },
]

function catalog(groups: ModelCatalog['groups'], failures: ModelCatalog['failures'] = []): ModelCatalog {
  return {
    default: { provider: '', model: '' },
    routableProviders: groups.map(group => group.id),
    groups,
    failures,
  }
}

function configured(): CredentialInfo {
  return { configured: true } as CredentialInfo
}

function missing(): CredentialInfo {
  return { configured: false } as CredentialInfo
}

/** A live instance plus the operations calling it, for one scripted load. */
function bench(operations: ImproveTextOperations) {
  const store = createRosterStore()
  const instance = store.create()
  return { instance, run: () => loadRoster(instance, operations) }
}

describe('deriveKeyRef', () => {
  it('upper-cases a plain route id', () => {
    expect(deriveKeyRef('anthropic')).toBe('ANTHROPIC_API_KEY')
  })

  it('maps punctuation to underscores, as the credential store does', () => {
    expect(deriveKeyRef('minimax-cn')).toBe('MINIMAX_CN_API_KEY')
    expect(deriveKeyRef('pi.ai/gateway')).toBe('PI_AI_GATEWAY_API_KEY')
  })
})

describe('providerUsable', () => {
  it('needs both a disclosed model and a configured key', () => {
    expect(providerUsable(MODELS, configured())).toBe(true)
    expect(providerUsable(MODELS, missing())).toBe(false)
    // A provider with a key but no models cannot answer a request either.
    expect(providerUsable([], configured())).toBe(false)
  })

  it('treats an unread credential as unusable rather than usable', () => {
    expect(providerUsable(MODELS, undefined)).toBe(false)
  })
})

describe('loadRoster', () => {
  it('offers every catalog provider with its credential and usability', async () => {
    const describeCredential = vi.fn((ref: string) => Promise.resolve(
      ref === 'OPENAI_API_KEY' ? missing() : configured(),
    ))
    const operations: ImproveTextOperations = {
      modelCatalog: () => Promise.resolve({
        ok: true,
        value: catalog([
          { id: 'deepseek-official', name: 'DeepSeek', models: MODELS },
          { id: 'openai', name: 'OpenAI', models: MODELS },
        ]),
      }),
      describeCredential,
    }
    const { instance, run } = bench(operations)
    await run()

    const snapshot = instance.getSnapshot()
    expect(snapshot.status).toBe('ready')
    expect(snapshot.providers.map(row => row.provider)).toEqual(['deepseek-official', 'openai'])
    expect(snapshot.providers.every(row => row.usable)).toBe(false)
    expect(snapshot.providers[1]?.usable).toBe(false)
    // The provider list is the Host's order, never re-sorted here.
    expect(snapshot.providers[0]?.displayName).toBe('DeepSeek')
    expect(describeCredential).toHaveBeenCalledWith('DEEPSEEK_OFFICIAL_API_KEY')
  })

  it('keeps an unusable provider in the list rather than hiding it', async () => {
    const operations: ImproveTextOperations = {
      modelCatalog: () => Promise.resolve({
        ok: true,
        value: catalog([{ id: 'ghost', name: 'Ghost', models: [] }]),
      }),
      describeCredential: () => Promise.resolve(configured()),
    }
    const { instance, run } = bench(operations)
    await run()
    expect(instance.getSnapshot().providers.map(row => row.provider)).toEqual(['ghost'])
    expect(instance.getSnapshot().providers[0]?.usable).toBe(false)
  })

  it('reports per-provider catalog failures beside a usable list', async () => {
    const operations: ImproveTextOperations = {
      modelCatalog: () => Promise.resolve({
        ok: true,
        value: catalog(
          [{ id: 'openai', name: 'OpenAI', models: MODELS }],
          [{ id: 'broken', name: 'broken', message: 'timed out' }],
        ),
      }),
      describeCredential: () => Promise.resolve(configured()),
    }
    const { instance, run } = bench(operations)
    await run()
    const snapshot = instance.getSnapshot()
    expect(snapshot.status).toBe('ready')
    expect(snapshot.providers[0]?.usable).toBe(true)
    expect(snapshot.failures).toEqual(['broken: timed out'])
  })

  it('reports a whole-load failure and empties the list', async () => {
    const operations: ImproveTextOperations = {
      modelCatalog: () => Promise.resolve({ ok: false, message: 'no catalog' }),
      describeCredential: () => Promise.resolve(undefined),
    }
    const { instance, run } = bench(operations)
    await run()
    const snapshot = instance.getSnapshot()
    expect(snapshot.status).toBe('error')
    expect(snapshot.error).toBe('no catalog')
    expect(snapshot.providers).toEqual([])
  })

  it('leaves an unknown credential state on the row', async () => {
    const operations: ImproveTextOperations = {
      modelCatalog: () => Promise.resolve({
        ok: true,
        value: catalog([{ id: 'openai', name: 'OpenAI', models: MODELS }]),
      }),
      describeCredential: () => Promise.resolve(undefined),
    }
    const { instance, run } = bench(operations)
    await run()
    expect(instance.getSnapshot().providers[0]?.credential).toBeUndefined()
    expect(instance.getSnapshot().providers[0]?.usable).toBe(false)
  })
})

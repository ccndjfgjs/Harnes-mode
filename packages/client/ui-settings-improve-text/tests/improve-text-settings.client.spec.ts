/**
 * The Improve-text page's own translation of the stored section: decode,
 * project, and the write ops.
 *
 * The load-bearing rule is the write shape. The two halves are one decision,
 * and the Host refuses a section that names a provider without its model, so
 * both are always written — a half-written document would make the Host reject
 * the very section this page produces.
 */

import { describe, expect, it } from 'vitest'
import {
  decodeImproveText,
  EMPTY_IMPROVE_TEXT_SETTINGS,
  IMPROVE_TEXT_SETTINGS_NAMESPACE,
  improveTextOps,
  improveTextView,
} from '../src/client/improve-text-settings.ts'

describe('namespace', () => {
  it('is the Host plugin namespace, not a page-local name', () => {
    expect(IMPROVE_TEXT_SETTINGS_NAMESPACE).toBe('draft-restructure')
  })
})

describe('decodeImproveText', () => {
  it('reads a stored pair', () => {
    expect(decodeImproveText({ provider: 'openai', model: 'gpt-x' }))
      .toEqual({ provider: 'openai', model: 'gpt-x' })
  })

  it('answers empty for anything that is not a section object', () => {
    for (const value of [undefined, null, 'text', 7, [], true]) {
      expect(decodeImproveText(value)).toEqual({ provider: '', model: '' })
    }
  })

  it('drops a non-string half rather than passing it through', () => {
    expect(decodeImproveText({ provider: 'openai', model: 42 }))
      .toEqual({ provider: 'openai', model: '' })
  })

  it('fills a missing half from the empty default', () => {
    expect(decodeImproveText({ provider: 'openai' })).toEqual({ provider: 'openai', model: '' })
    expect(decodeImproveText({})).toEqual({ provider: '', model: '' })
  })
})

describe('improveTextView', () => {
  /** The smallest snapshot the projection reads: a value, a mode, and writability. */
  const snapshot = (value: unknown, writable = true) => ({
    status: 'ready',
    value,
    base: undefined,
    user: undefined,
    revision: 0,
    writable,
    mode: 'host',
  } as Parameters<typeof improveTextView>[0])

  it('marks a complete pair as chosen', () => {
    expect(improveTextView(snapshot({ provider: 'p', model: 'm' })))
      .toEqual({ provider: 'p', model: 'm', writable: true, chosen: true })
  })

  it('marks an empty document as not chosen, so the page can say it follows the Agent', () => {
    expect(improveTextView(snapshot({ provider: '', model: '' })).chosen).toBe(false)
  })

  it('does not call a half-filled document chosen', () => {
    expect(improveTextView(snapshot({ provider: 'p', model: '' })).chosen).toBe(false)
    expect(improveTextView(snapshot({ provider: '', model: 'm' })).chosen).toBe(false)
  })

  it('carries read-only through without inventing a value', () => {
    expect(improveTextView(snapshot({ provider: 'p', model: 'm' }, false)).writable).toBe(false)
  })
})

describe('improveTextOps', () => {
  it('writes both halves, provider first', () => {
    expect(improveTextOps({ provider: 'openai', model: 'gpt-x' })).toEqual([
      { op: 'set', path: ['provider'], value: 'openai' },
      { op: 'set', path: ['model'], value: 'gpt-x' },
    ])
  })

  // Clearing writes two explicit empty strings rather than unsetting: an
  // unset leaves whatever the previous write put there, and a leftover single
  // half is exactly the section the Host refuses.
  it('clears by writing an explicit empty pair', () => {
    expect(improveTextOps(EMPTY_IMPROVE_TEXT_SETTINGS)).toEqual([
      { op: 'set', path: ['provider'], value: '' },
      { op: 'set', path: ['model'], value: '' },
    ])
  })
})

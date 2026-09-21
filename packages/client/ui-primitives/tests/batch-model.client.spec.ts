import { describe, expect, it } from 'vitest'
import { isBatchOnlyModel, modelSupportBadge } from '../src/batch-model.ts'

describe('batch-only model detection', () => {
  it('flags the OpenRouter :batch suffix', () => {
    expect(isBatchOnlyModel('google/gemini-3.6-flash:batch')).toBe(true)
  })

  it('flags the (batch) display-name marker', () => {
    expect(isBatchOnlyModel('fable-5', 'Anthropic: Claude Fable 5 (batch)')).toBe(true)
  })

  it('ignores letter case', () => {
    expect(isBatchOnlyModel('google/gemini-3.6-flash:BATCH')).toBe(true)
    expect(isBatchOnlyModel('fable-5', 'Anthropic: Claude Fable 5 (Batch)')).toBe(true)
  })

  it('passes ordinary models', () => {
    expect(isBatchOnlyModel('poolside/laguna-s-2.1:free')).toBe(false)
    expect(isBatchOnlyModel('claude-sonnet-5')).toBe(false)
    expect(isBatchOnlyModel('')).toBe(false)
  })

  it('requires the suffix at the very end of the id', () => {
    expect(isBatchOnlyModel('model-batch-eu')).toBe(false)
  })
})

describe('improve-text support badge', () => {
  it('marks batch-only models with the mail badge', () => {
    expect(modelSupportBadge('google/gemini-3.6-flash:batch')).toBe('✉')
    expect(modelSupportBadge('fable-5', 'Anthropic: Claude Fable 5 (batch)')).toBe('✉')
  })

  it('marks batch-only models with mail even when a key is configured', () => {
    expect(modelSupportBadge('google/gemini-3.6-flash:batch', '', true)).toBe('✉')
  })

  it('marks realtime models with the star', () => {
    expect(modelSupportBadge('poolside/laguna-s-2.1:free')).toBe('★')
    expect(modelSupportBadge('claude-sonnet-5')).toBe('★')
  })

  it('marks realtime models without a key with a question', () => {
    expect(modelSupportBadge('poolside/laguna-s-2.1:free', '', false)).toBe('?')
    expect(modelSupportBadge('claude-sonnet-5', '', false)).toBe('?')
  })
})

// Draft restructuring: one auxiliary model call reached from the composer.
// The call is not a turn — nothing is admitted to any Session log — so these
// tests own the whole contract: input guards, the request the model sees, how
// the answer is projected back into composer text, and every failure surface.

import { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import {
  DRAFT_RESTRUCTURE_MAX_CHARS,
  DraftRestructure,
  draftRestructureRoute,
  restructuredText,
} from '../src/draft-restructure.ts'

/** One scripted model answer, delivered as the chunks an adapter would emit. */
function answer(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

interface BenchOptions {
  readonly selection?: { provider: string; model: string; reasoningEffort?: string }
  readonly chunks?: StreamChunk[]
  readonly fail?: unknown
  /** The button's own selection, mounted as `draftRestructureModel` when present. */
  readonly chosen?: { provider: string; model: string } | undefined
  /** Provider ids the registry serves; `undefined` keeps the fixture route routable. */
  readonly providers?: string[]
}

/** A Context carrying only the services the call reaches. */
function bench(over: BenchOptions = {}) {
  const ctx = new Context()
  const stream = vi.fn((_options: GenerateOptions) => {
    if (over.fail !== undefined) {
      return (async function* (): AsyncGenerator<StreamChunk> { throw over.fail })()
    }
    const chunks = over.chunks ?? answer('переписанный текст')
    return (async function* (): AsyncGenerator<StreamChunk> {
      for (const chunk of chunks) yield chunk
    })()
  })
  const selection = over.selection ?? { provider: 'fixture', model: 'fixture-model' }
  ctx.provide('llm', {
    stream,
    listProviders: () => (over.providers ?? [selection.provider]).map(id => ({ id })),
  } as never)
  ctx.provide('agentDefaultModel', { currentSelection: () => selection } as never)
  if (over.chosen !== undefined) {
    ctx.provide('draftRestructureModel', { currentRoute: () => over.chosen } as never)
  }
  return { ctx, stream, restructure: new DraftRestructure(ctx) }
}

const signal = (): AbortSignal => new AbortController().signal

describe('restructuredText', () => {
  it('joins text blocks and drops non-text ones', () => {
    expect(restructuredText([
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: 'первая ' },
      { type: 'text', text: 'вторая' },
    ])).toBe('первая вторая')
  })

  it('strips a fence that wraps the whole answer', () => {
    expect(restructuredText([{ type: 'text', text: '```markdown\n# План\n- шаг\n```' }])).toBe('# План\n- шаг')
  })

  it('leaves an inner fence alone', () => {
    const text = 'Как вставить код:\n\n```sh\npnpm build\n```\n\nи всё.'
    expect(restructuredText([{ type: 'text', text }])).toBe(text)
  })

  it('answers empty when nothing textual streamed', () => {
    expect(restructuredText([{ type: 'reasoning', text: 'thinking' }])).toBe('')
  })
})

describe('draftRestructureRoute', () => {
  const fallback = { provider: 'agent', model: 'agent-model' }

  it('prefers the button selection while its provider is routable', () => {
    expect(draftRestructureRoute(
      { provider: 'chosen', model: 'chosen-model' },
      ['chosen', 'agent'],
      fallback,
    )).toEqual({ provider: 'chosen', model: 'chosen-model' })
  })

  it('falls back when the chosen provider left the composition', () => {
    expect(draftRestructureRoute(
      { provider: 'gone', model: 'chosen-model' },
      ['agent'],
      fallback,
    )).toEqual({ provider: 'agent', model: 'agent-model' })
  })

  it('falls back when the button has no selection of its own', () => {
    expect(draftRestructureRoute(undefined, ['agent'], fallback))
      .toEqual({ provider: 'agent', model: 'agent-model' })
  })

  it('carries the button effort through and drops an absent one', () => {
    expect(draftRestructureRoute(
      { provider: 'chosen', model: 'm', reasoningEffort: ReasoningEffortId('high') },
      ['chosen'],
      fallback,
    )).toEqual({ provider: 'chosen', model: 'm', reasoningEffort: 'high' })
    expect(draftRestructureRoute({ provider: 'chosen', model: 'm' }, ['chosen'], fallback))
      .toEqual({ provider: 'chosen', model: 'm' })
  })

  it('answers undefined when neither layer has a complete route', () => {
    expect(draftRestructureRoute(undefined, [], { provider: '', model: '' })).toBeUndefined()
    // A half-written default is not a route either: addressing it would fail
    // deep inside the adapter instead of at the setting that caused it.
    expect(draftRestructureRoute(undefined, [], { provider: 'agent', model: '' })).toBeUndefined()
  })
})

describe('draft restructuring', () => {
  it('refuses an empty draft before reaching the model', async () => {
    const { restructure, stream } = bench()
    await expect(restructure.restructure({ text: '   \n ' }, signal()))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })
    expect(stream).not.toHaveBeenCalled()
  })

  it('refuses a draft past the length bound', async () => {
    const { restructure, stream } = bench()
    await expect(restructure.restructure({ text: 'x'.repeat(DRAFT_RESTRUCTURE_MAX_CHARS + 1) }, signal()))
      .rejects.toMatchObject({ code: 'gateway/bad-request', message: expect.stringContaining('longer than') as string })
    expect(stream).not.toHaveBeenCalled()
  })

  it('refuses when no model is configured', async () => {
    const { restructure, stream } = bench({ selection: { provider: '', model: '' } })
    await expect(restructure.restructure({ text: 'черновик' }, signal()))
      .rejects.toMatchObject({ code: 'gateway/internal' })
    expect(stream).not.toHaveBeenCalled()
  })

  it('asks the configured model for the draft and returns the trimmed answer', async () => {
    const { restructure, stream } = bench({ chunks: answer('  Готовый текст  ') })
    const value = await restructure.restructure({ text: '  черновик  ' }, signal())
    expect(value).toEqual({ text: 'Готовый текст' })
    const options = stream.mock.calls[0]?.[0] as GenerateOptions
    expect(options.provider).toBe('fixture')
    expect(options.model).toBe('fixture-model')
    expect(options.system).toContain('SAME language')
    expect(options.messages).toHaveLength(1)
    const message = options.messages[0]
    expect(message?.role).toBe('user')
    expect(message?.content).toEqual([{ type: 'text', text: 'черновик' }])
  })

  it('forwards the selected reasoning effort when the model declares one', async () => {
    const { restructure, stream } = bench({
      selection: { provider: 'fixture', model: 'fixture-model', reasoningEffort: 'high' },
    })
    await restructure.restructure({ text: 'черновик' }, signal())
    expect((stream.mock.calls[0]?.[0] as GenerateOptions).reasoningEffort).toBe('high')
  })

  // The two layers are read in a fixed order: a page that chose a model must
  // not be silently overridden by the Agent default, and a deployment that
  // never opened the page must keep answering exactly as it did before.
  it('runs on the button selection rather than the Agent default', async () => {
    const { restructure, stream } = bench({
      chosen: { provider: 'fixture', model: 'chosen-model' },
    })
    await restructure.restructure({ text: 'черновик' }, signal())
    expect(stream.mock.calls[0]?.[0]).toMatchObject({ provider: 'fixture', model: 'chosen-model' })
  })

  it('falls back to the Agent default when the chosen provider is gone', async () => {
    const { restructure, stream } = bench({
      chosen: { provider: 'gone', model: 'chosen-model' },
      providers: ['fixture'],
      selection: { provider: 'fixture', model: 'fixture-model' },
    })
    await restructure.restructure({ text: 'черновик' }, signal())
    expect(stream.mock.calls[0]?.[0]).toMatchObject({ provider: 'fixture', model: 'fixture-model' })
  })

  it('reports an adapter failure as a gateway failure carrying its chain', async () => {
    const { restructure } = bench({ fail: new Error('provider exploded') })
    await expect(restructure.restructure({ text: 'черновик' }, signal()))
      .rejects.toMatchObject({ code: 'gateway/internal', message: expect.stringContaining('provider exploded') as string })
  })

  it('names the failing route when the adapter call fails', async () => {
    const { restructure } = bench({ fail: new Error('provider exploded') })
    await expect(restructure.restructure({ text: 'черновик' }, signal()))
      .rejects.toMatchObject({
        code: 'gateway/internal',
        message: expect.stringContaining('"fixture/fixture-model"') as string,
      })
  })

  it('reports an answer with no text at all', async () => {
    const { restructure } = bench({ chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })
    await expect(restructure.restructure({ text: 'черновик' }, signal()))
      .rejects.toMatchObject({ code: 'gateway/internal', message: expect.stringContaining('no text') as string })
  })

  // A provider failure can arrive as the terminal finish instead of a throw.
  // Reading only the blocks would answer "no text" and bury the reason.
  it('reports a provider failure carried by the finish chunk', async () => {
    const { restructure } = bench({
      chunks: [{
        type: 'finish',
        reason: { kind: 'error', failure: { message: 'insufficient balance', code: 'PAYMENT_REQUIRED' } },
      }],
    })
    await expect(restructure.restructure({ text: 'черновик' }, signal()))
      .rejects.toMatchObject({
        code: 'gateway/internal',
        message: expect.stringContaining('insufficient balance') as string,
      })
  })

  it('names the failing route when the finish chunk carries the failure', async () => {
    const { restructure } = bench({
      chunks: [{
        type: 'finish',
        reason: { kind: 'error', failure: { message: 'batch only', code: 'NOT_FOUND' } },
      }],
    })
    await expect(restructure.restructure({ text: 'черновик' }, signal()))
      .rejects.toMatchObject({
        code: 'gateway/internal',
        message: expect.stringContaining('"fixture/fixture-model"') as string,
      })
  })

  it('reports an aborted finish as a failure carrying its reason', async () => {
    const { restructure } = bench({
      chunks: [{
        type: 'finish',
        reason: { kind: 'aborted', failure: { message: 'stream idle timeout', code: 'STREAM_IDLE_TIMEOUT' } },
      }],
    })
    await expect(restructure.restructure({ text: 'черновик' }, signal()))
      .rejects.toMatchObject({
        code: 'gateway/internal',
        message: expect.stringContaining('stream idle timeout') as string,
      })
  })

  it('reports a token-capped finish as truncation, not as an empty answer', async () => {
    const { restructure } = bench({ chunks: [{ type: 'finish', reason: { kind: 'max-tokens' } }] })
    await expect(restructure.restructure({ text: 'черновик' }, signal()))
      .rejects.toMatchObject({
        code: 'gateway/internal',
        message: expect.stringContaining('token cap') as string,
      })
  })
})

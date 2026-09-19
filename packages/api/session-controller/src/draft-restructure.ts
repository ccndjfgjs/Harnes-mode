/**
 * Composer draft restructuring: one auxiliary model call that turns a rough
 * draft into a well-formed request, handed straight back to the composer.
 *
 * This is deliberately NOT a prompt. Nothing is admitted to any Session log,
 * no Agent is resumed, and no turn is opened: the caller replaces its own
 * draft in place. That is why the request carries text instead of a Session
 * identity — the transformation is stateless, and the model sees only the
 * draft, so the provider's prefix cache stays untouched.
 *
 * WHICH model answers is a deployment choice with two layers, and the order
 * matters: the button's own selection (`draft-restructure`, chosen on its own
 * settings page) wins, and only when the user has not chosen one does the
 * Agent-default model answer. The fallback is what keeps a deployment that
 * never opens the page behaving exactly as it did before that page existed.
 *
 * @module @deepseek-ai/dsh-api-session-controller/draft-restructure
 */

import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage, errorChain, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
// Binds `ctx.draftRestructureModel` to its declared service type. The service is
// read through `ctx.get()` below so a composition that never mounted the
// settings plugin still restructures drafts; without this the read is `any` and
// the argument type the route helper expects is lost.
import type {} from '@deepseek-ai/dsh-draft-restructure-model'
import type { ModelSelection } from './types.ts'
import type { DraftRestructureRequest, DraftRestructureValue } from './types.ts'

/**
 * Instruction the model receives. It asks for three things at once, because
 * the composer button is one gesture: tidy the wording, give the request a
 * shape, and fill in the details a competent assistant would otherwise have
 * to ask for. The language rule matters — the draft may be Russian while the
 * model's own default is English, and answering in the wrong language would
 * destroy the user's text rather than improve it.
 */
const RESTRUCTURE_SYSTEM = [
  'You rewrite a short draft that a user typed into a chat composer, so the assistant that receives it can act immediately.',
  '',
  'Rules:',
  '1. Answer in the SAME language as the draft. Never translate it.',
  '2. Keep every fact, name, path, number and code fragment the draft states. Never invent facts, files, or requirements the draft does not support.',
  '3. Make the wording clear and tidy, and give the request a readable structure (for example a short goal line, then the concrete points as a list) when the draft contains more than one idea.',
  '4. Add the context that is obviously implied but unstated: what the goal is, what the expected result looks like, and the constraints that follow from the draft itself. Keep additions modest — a few lines, not a specification.',
  '5. Output ONLY the rewritten draft. No preamble, no explanation of your changes, no markdown code fences around the whole answer, no commentary.',
].join('\n')

/** Upper bound on a draft this call accepts; longer drafts are refused rather than truncated. */
export const DRAFT_RESTRUCTURE_MAX_CHARS = 8000

/** Output budget: enough for a restructured draft with added detail, far short of an essay. */
const DRAFT_RESTRUCTURE_MAX_TOKENS = 4096

/** Model-produced wrapping this projection strips, so the composer never gains stray fences. */
const FENCE_RE = /^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/

/**
 * The model's answer as composer text: a whole-answer code fence removed (the
 * fence is the model's habit, not the user's content) and surrounding blank
 * lines trimmed. Fences inside the draft are left alone — only a fence that
 * wraps the entire answer is a wrapper.
 * @param blocks - assembled response blocks, in stream order.
 * @returns the joined text blocks, unwrapped.
 */
export function restructuredText(blocks: readonly ContentBlock[]): string {
  const joined = blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
  const unwrapped = FENCE_RE.exec(joined)?.[1] ?? joined
  return unwrapped.trim()
}

/**
 * The route this call runs on, given the button's own selection and the
 * Agent default.
 *
 * The button's own route is used only while it is still routable: a provider
 * can leave the composition between the write and this call, and asking the
 * adapter for a route it no longer serves fails deep inside the stream with a
 * message about an unknown provider rather than about the setting that caused
 * it. Falling back instead is the same posture as "not configured" — the
 * button keeps working, on a route the Host is known to have.
 * @param chosen - the button's selection, or undefined when it has none.
 * @param routable - provider routes the registry currently serves.
 * @param fallback - the Agent default, used when nothing else applies.
 * @returns the provider, model, and optional effort to address, or undefined
 *   when neither layer has a complete route.
 */
export function draftRestructureRoute(
  chosen: { readonly provider: string; readonly model: string; readonly reasoningEffort?: ReasoningEffortId } | undefined,
  routable: readonly string[],
  fallback: ModelSelection,
): ModelSelection | undefined {
  // `ModelSelection` carries the effort as a plain string while `GenerateOptions`
  // wants the branded id; the caller re-brands it, because this function's
  // answer is the route rather than the whole request.
  if (chosen !== undefined && routable.includes(chosen.provider)) {
    return {
      provider: chosen.provider,
      model: chosen.model,
      ...chosen.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: String(chosen.reasoningEffort) },
    }
  }
  if (fallback.provider === '' || fallback.model === '') return undefined
  return {
    provider: fallback.provider,
    model: fallback.model,
    ...fallback.reasoningEffort === undefined ? {} : { reasoningEffort: fallback.reasoningEffort },
  }
}

/** One draft-restructuring call over the selected model. */
export class DraftRestructure {
  /**
   * @param ctx - Host context carrying the LLM seam, the Agent default, and
   * the button's own model selection.
   */
  constructor(private readonly ctx: Context) {}

  /**
   * Restructure one composer draft with the selected model.
   * @param request - the draft exactly as the composer holds it.
   * @param signal - caller cancellation, forwarded to the adapter.
   * @returns the replacement draft.
   * @throws {RemoteError} when the draft is unusable, no model is configured, or the call fails.
   */
  async restructure(request: DraftRestructureRequest, signal: AbortSignal): Promise<DraftRestructureValue> {
    const draft = request.text.trim()
    if (draft === '') {
      throw new RemoteError('gateway/bad-request', 'restructuring needs a non-empty draft', {})
    }
    if (draft.length > DRAFT_RESTRUCTURE_MAX_CHARS) {
      throw new RemoteError(
        'gateway/bad-request',
        `draft is longer than ${DRAFT_RESTRUCTURE_MAX_CHARS} characters`,
        {},
      )
    }
    // The button's own selection is read through the optional service so the
    // module still works in a composition that never mounted its settings
    // plugin — the same posture the Agent default takes for its own provider.
    const chosen = this.ctx.get('draftRestructureModel')?.currentRoute()
    const route = draftRestructureRoute(
      chosen,
      this.ctx.llm.listProviders().map(provider => provider.id),
      this.ctx.agentDefaultModel.currentSelection(),
    )
    if (route === undefined) {
      throw new RemoteError('gateway/internal', 'no model is configured to restructure the draft', {})
    }
    const messages: Message[] = [
      createUserMessage({
        content: [{ type: 'text', text: draft }],
        source: { kind: 'plugin', plugin: 'dsh-composer-restructure' },
      }),
    ]
    const options: GenerateOptions = {
      provider: route.provider,
      model: route.model,
      ...route.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) },
      messages,
      system: RESTRUCTURE_SYSTEM,
      maxTokens: DRAFT_RESTRUCTURE_MAX_TOKENS,
      signal,
    }
    const assembler = new BlockAssembler()
    try {
      for await (const chunk of this.ctx.llm.stream(options)) assembler.push(chunk)
    } catch (error) {
      throw new RemoteError('gateway/internal', `draft restructuring failed: ${errorChain(error)}`, {})
    }
    // A provider failure does not always throw: it can arrive as the terminal
    // finish chunk. Reading only the blocks would report "no text" and hide the
    // reason the user has to act on, so the finish is checked first — the same
    // fail-closed reading the summarizer and the title generator use.
    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      throw new RemoteError('gateway/internal', `draft restructuring failed: ${finish.failure.message}`, {})
    }
    if (finish.kind === 'max-tokens') {
      throw new RemoteError('gateway/internal', 'draft restructuring reached its token cap before producing text', {})
    }
    const text = restructuredText(assembler.blocks())
    if (text === '') {
      throw new RemoteError('gateway/internal', 'draft restructuring produced no text', {})
    }
    return { text }
  }
}

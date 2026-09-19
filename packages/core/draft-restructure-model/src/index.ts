/**
 * Model selection the composer draft-restructure button ("Улучшить текст")
 * uses, owned separately from the Agent default.
 *
 * The button is an auxiliary call: it rewrites one draft and hands the text
 * straight back, opening no turn and admitting nothing to a Session log. A
 * deployment may therefore want a different — usually cheaper or faster —
 * route for it than the one that answers the chat, which is why this is its
 * own namespace rather than a second reader of `agent-default-model`.
 *
 * An EMPTY selection is the default posture and means "not configured": the
 * consumer falls back to the Agent default, so a deployment that never opens
 * the settings page keeps behaving exactly as it did before this existed.
 *
 * @module @deepseek-ai/dsh-draft-restructure-model
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Model the composer draft-restructure button uses, when one is chosen. */
    draftRestructureModel: DraftRestructureModelConfig
  }
}

/** Settings namespace carrying the draft-restructure model selection. */
export const DRAFT_RESTRUCTURE_MODEL_SETTINGS_NAMESPACE = 'draft-restructure'

/** Stored and composed draft-restructure model selection. */
export interface DraftRestructureModelSettings {
  /** Registered provider route; '' means "not configured" and falls back. */
  provider: string
  /** Provider-owned model id; '' means "not configured" and falls back. */
  model: string
  /** Adapter-owned reasoning effort, or provider/default behavior when absent. */
  reasoningEffort?: string
}

/** Schema of the draft-restructure model settings section. */
export const DRAFT_RESTRUCTURE_MODEL_SETTINGS_SCHEMA: z<DraftRestructureModelSettings> = z.object({
  provider: z.string().default(''),
  model: z.string().default(''),
  reasoningEffort: z.string(),
})

/** Composition entry: the deployment default, empty meaning "follow the Agent". */
export interface Config {
  /** Initial provider route inherited when the user document does not override it. */
  provider?: string
  /** Initial model id inherited when the user document does not override it. */
  model?: string
}

/** One resolved draft-restructure route. */
export interface DraftRestructureSelection {
  /** Registered provider route. */
  readonly provider: string
  /** Provider-owned model id. */
  readonly model: string
  /** Adapter-owned reasoning effort, when one is pinned. */
  readonly reasoningEffort?: ReasoningEffortId
}

/**
 * Owns the draft-restructure model selection independently of any Host or
 * transport. The composition entry remains usable without a settings
 * provider; when one is mounted, its user layer is read live.
 *
 * Both halves of the selection are stored, never one: a provider swap leaves
 * the old model id behind, so a half-written pair would ask a new provider for
 * a model it does not serve. A pair where only one half is filled is therefore
 * refused at this boundary rather than silently falling back, which would hide
 * a form bug behind working behavior.
 */
export class DraftRestructureModelConfig extends Service {
  static Config: z<Config> = z.object({
    provider: z.string(),
    model: z.string(),
  })

  private source: () => DraftRestructureModelSettings

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'draftRestructureModel')
    const entry: DraftRestructureModelSettings = {
      provider: config.provider ?? '',
      model: config.model ?? '',
    }
    this.validate(entry)
    this.source = () => entry
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.installSection(
        ctx,
        DRAFT_RESTRUCTURE_MODEL_SETTINGS_NAMESPACE,
        DRAFT_RESTRUCTURE_MODEL_SETTINGS_SCHEMA,
        entry,
        {
          setSource: (current) => { this.source = current },
          validate: (value) => { this.validate(value) },
          // Every consumer reads through currentSelection() at call time, so no
          // registration-level fact needs rebuilding when the document changes.
          onChange: () => {},
        },
      )
    })
  }

  /**
   * Read the configured route, or undefined while the user has not chosen one.
   * The undefined answer is what carries "fall back to the Agent default" to
   * the consumer; an empty string never reaches it.
   * @returns a detached route, or undefined when this button has no model of its own.
   */
  currentSelection(): DraftRestructureSelection | undefined {
    const current = this.source()
    if (current.provider === '' || current.model === '') return undefined
    return {
      provider: current.provider,
      model: current.model,
      ...current.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: ReasoningEffortId(current.reasoningEffort) },
    }
  }

  /**
   * The exact route this selection addresses, for a caller that must check the
   * route is still registered before using it.
   * @returns the provider and model ids, or undefined when nothing is chosen.
   */
  currentRoute(): { readonly provider: string; readonly model: string } | undefined {
    const current = this.source()
    if (current.provider === '' || current.model === '') return undefined
    return { provider: current.provider, model: current.model }
  }

  /**
   * Reject a half-filled or malformed selection before it is persisted. The
   * pair is atomic: naming a provider without its model would address a route
   * that does not exist.
   * @param value - the schema-resolved candidate section.
   * @throws {Error} when exactly one half of the pair is filled.
   */
  private validate(value: DraftRestructureModelSettings): void {
    const namedProvider = value.provider.trim().length > 0
    const namedModel = value.model.trim().length > 0
    if (namedProvider !== namedModel) {
      throw new Error(
        'draft-restructure requires both a provider and a model, or neither: '
        + `got provider "${value.provider}" and model "${value.model}"`,
      )
    }
  }
}

export const name = 'draft-restructure-model'
export default DraftRestructureModelConfig

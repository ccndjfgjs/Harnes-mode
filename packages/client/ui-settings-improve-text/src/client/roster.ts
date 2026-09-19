/**
 * The provider and model roster this page offers, read from the same Host
 * facts the Models page reads: the Host-generation model catalog (which
 * carries every routable provider and its models) and the credential states
 * their keys resolve to.
 *
 * The page deliberately does NOT re-declare providers or own a second editing
 * form. A provider becomes available to this button exactly when it is
 * available to the chat, because both read one registry — which is what makes
 * "choose an existing provider" mean the same thing on both pages.
 */

import type { CredentialInfo, ModelCatalog, ModelCatalogModel } from '@deepseek-ai/dsh-api-remotes/client'
import type { EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import { defineStore } from '@deepseek-ai/dsh-client-store'

/** One provider this page can offer the button. */
export interface ImproveTextProvider {
  /** Registered provider route id. */
  readonly provider: string
  /** Human-facing provider name, as the Host names it. */
  readonly displayName: string
  /** Models the provider disclosed, in its own order. */
  readonly models: readonly ModelCatalogModel[]
  /** Credential reference this page derives for the route's key. */
  readonly keyRef: string
  /** Credential state once described; undefined while unknown. */
  readonly credential: CredentialInfo | undefined
  /** Whether the route can answer at all (a model list and a configured key). */
  readonly usable: boolean
}

/** Page snapshot. */
export interface ImproveTextRosterState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Whole-load failure text. */
  error: string | null
  /** Providers in the Host's own order. */
  providers: readonly ImproveTextProvider[]
  /** Providers whose catalog lookup failed, with the Host's diagnostic. */
  failures: readonly string[]
}

/**
 * The write set the page performs on its roster, as draft mutators.
 *
 * Declared as a type alias rather than an interface: the store engine's
 * declaration constraint is satisfied by an object type with named members,
 * while an interface would additionally demand a string index signature that
 * no concrete action set has.
 */
export type ImproveTextRosterActions = {
  /** Mark a load as started. */
  loading: (draft: ImproveTextRosterState) => void
  /** Install a settled roster. */
  ready: (
    draft: ImproveTextRosterState,
    providers: readonly ImproveTextProvider[],
    failures: readonly string[],
  ) => void
  /** Install a whole-load failure. */
  failed: (draft: ImproveTextRosterState, message: string) => void
}

/**
 * Derive the conventional credential reference for a provider route, matching
 * the derivation the credential store itself uses.
 * @param provider - provider route id (e.g. `anthropic`, `minimax-cn`).
 * @returns the derived reference name (e.g. `MINIMAX_CN_API_KEY`).
 */
export function deriveKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/**
 * Whether one provider row can serve the button: it must have disclosed at
 * least one model, and its key must be confirmed configured. A provider whose
 * key state could not be read is offered but marked unusable rather than
 * hidden — hiding it would make a page the user just visited look emptier than
 * the Models page beside it.
 * @param models - models the provider disclosed.
 * @param credential - the credential state, or undefined while unknown.
 * @returns whether this route can answer a request now.
 */
export function providerUsable(
  models: readonly ModelCatalogModel[],
  credential: CredentialInfo | undefined,
): boolean {
  return models.length > 0 && credential?.configured === true
}

/** The Host reads this page performs, bound to the plugin's own Remote namespaces. */
export interface ImproveTextOperations {
  /**
   * Read the Host-generation model catalog.
   * @returns the catalog, or the refusal message.
   */
  modelCatalog(): Promise<{ ok: true; value: ModelCatalog } | { ok: false; message: string }>
  /**
   * Read one credential reference's state.
   * @param ref - credential reference name.
   * @returns the state, or undefined when unknown or refused.
   */
  describeCredential(ref: string): Promise<CredentialInfo | undefined>
}

/** The roster store handle, whose engine the load path writes through. */
export type ImproveTextRosterStore = EngineStoreHandle<ImproveTextRosterState, ImproveTextRosterActions>

/**
 * Declare the page's roster store. The declaration is made here so the section
 * registration can name it and the renderer can bind its `useStore` hook; all
 * writes go through the returned engine on the load path below.
 * @returns the store handle declared at the section's registration.
 */
export function createRosterStore(): EngineStoreHandle<ImproveTextRosterState, ImproveTextRosterActions> {
  return defineStore({
    init: (): ImproveTextRosterState => ({ status: 'idle', error: null, providers: [], failures: [] }),
    actions: {
      loading: (draft: ImproveTextRosterState) => {
        draft.status = 'loading'
        draft.error = null
      },
      ready: (
        draft: ImproveTextRosterState,
        providers: readonly ImproveTextProvider[],
        failures: readonly string[],
      ) => {
        draft.status = 'ready'
        draft.error = null
        draft.providers = [...providers]
        draft.failures = [...failures]
      },
      failed: (draft: ImproveTextRosterState, message: string) => {
        draft.status = 'error'
        draft.error = message
        draft.providers = []
        draft.failures = []
      },
    },
  })
}

/**
 * The live instance one section entry renders from. The engine's own `create`
 * is the framework's seat; the load path takes the instance it is handed.
 */
export type ImproveTextRosterInstance = ReturnType<ImproveTextRosterStore['create']>

/**
 * Load the roster into one live instance.
 *
 * One catalog read per load, not per interaction: the roster is small, the
 * catalog is already cached Host-side, and reading it per open of the provider
 * select would put a network round trip between the user and their own list.
 * @param instance - the live instance bound for this section entry.
 * @param operations - the Host operations, bound in the plugin body.
 * @returns fulfillment after the snapshot settles.
 */
export async function loadRoster(
  instance: ImproveTextRosterInstance,
  operations: ImproveTextOperations,
): Promise<void> {
  instance.actions.loading()
  const catalog = await operations.modelCatalog()
  if (!catalog.ok) {
    instance.actions.failed(catalog.message)
    return
  }
  const providers = await Promise.all(catalog.value.groups.map(async (group) => {
    const keyRef = deriveKeyRef(group.id)
    const credential = await operations.describeCredential(keyRef)
    return {
      provider: group.id,
      displayName: group.name,
      models: group.models,
      keyRef,
      credential,
      usable: providerUsable(group.models, credential),
    }
  }))
  instance.actions.ready(
    providers,
    catalog.value.failures.map(failure => `${failure.name}: ${failure.message}`),
  )
}

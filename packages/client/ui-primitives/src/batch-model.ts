/**
 * Batch-only model detection: one naming convention in one place.
 *
 * A batch-only model (today: the OpenRouter `:batch` suffix) exists but
 * refuses live chat calls at the gateway, so every realtime surface — the
 * chat, the Improve-text button — must label it instead of offering it
 * silently. Provider-specific suffixes beyond `:batch` extend
 * BATCH_ONLY_SUFFIXES; callers never match names themselves.
 */

/** Model-id suffixes that mark batch-only routes (compared case-insensitively). */
const BATCH_ONLY_SUFFIXES = [':batch']

/** Display-name marker some providers print instead of renaming the id. */
const BATCH_ONLY_NAME_MARKERS = ['(batch)']

/**
 * Whether one model addresses a batch-only route: either its id carries a
 * known batch-only suffix or its display name carries the batch marker.
 * @param modelId - provider-owned model id, any letter case.
 * @param modelName - human-facing display name, when the caller has one.
 * @returns true when either signal marks the route batch-only.
 */
export function isBatchOnlyModel(modelId: string, modelName = ''): boolean {
  const id = modelId.toLowerCase()
  if (BATCH_ONLY_SUFFIXES.some(suffix => id.endsWith(suffix))) return true
  const name = modelName.toLowerCase()
  return BATCH_ONLY_NAME_MARKERS.some(marker => name.includes(marker))
}

/** Badge shown after a model name: star = works live, mail = batch only, question = no key. */
export type ModelSupportBadge = '★' | '✉' | '?'

/**
 * The Improve-text support badge for one model.
 * @param modelId - provider-owned model id.
 * @param modelName - human-facing display name, when the caller has one.
 * @param usable - whether the route has models disclosed and a key configured.
 *   Unknown callers leave it true and get the two-state answer; the Improve
 *   scanner passes the roster's verdict and gets the question mark.
 * @returns '✉' for batch-only routes, '?' for keyless realtime routes, '★' otherwise.
 */
export function modelSupportBadge(modelId: string, modelName = '', usable = true): ModelSupportBadge {
  if (isBatchOnlyModel(modelId, modelName)) return '✉'
  return usable ? '★' : '?'
}

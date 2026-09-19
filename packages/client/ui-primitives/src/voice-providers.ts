/**
 * Voice providers: the description of one voice service — its shell (identity
 * and credential style) plus two independent faces, `tts` (synthesizing
 * answers) and `realtime` (the live voice of a call).
 *
 * The two faces are separate on purpose: one vendor's answer voice and call
 * voice come from different catalogs, so a single "voice" field would let a
 * call answer in a voice the user never chose. Because of that the stored
 * document carries two voice fields, and "the same voice everywhere" is a
 * checked fact (see acceptsTtsVoice) rather than an assumption.
 *
 * Physical home is this leaf (zero dependencies, like voice-endpoint.ts) so the
 * Voice Settings page, the composer preflight, and the read-aloud engine all
 * describe providers from the same place. The host gateway keeps its own
 * request-shaping table keyed by the same `id` values: the client owns "which
 * service, which voice", the host owns "what bytes go on the wire".
 */

/** Every provider id the settings document may name, `auto` included. */
export const VOICE_PROVIDER_IDS = [
  'auto', 'system', 'google', 'google-cloud', 'openai', 'elevenlabs', 'custom',
] as const

/** One selectable provider id. */
export type VoiceProviderId = typeof VOICE_PROVIDER_IDS[number]

/** Locale key suffix a provider's display name is read from. */
export type VoiceProviderLabelKey =
  | 'auto' | 'system' | 'google' | 'googleCloud' | 'openai' | 'elevenlabs' | 'custom'

/** How the host hands a credential to the provider; the exact header name is the host adapter's business. */
export type VoiceAuthStyle = 'none' | 'bearer' | 'query' | 'header'

/** One voice a face can be asked for. */
export interface VoiceDescriptor {
  /** Identifier sent to the provider. */
  readonly id: string
  /** Name shown to the user. */
  readonly label: string
  /** BCP 47 tag the voice speaks. */
  readonly lang: string
}

/** The answer voice: what the read-aloud and the call bridge drive. */
export interface TtsFace {
  /** Voice used when the user has not chosen one. */
  readonly defaultVoice: string
  /** Model the provider needs, or '' when it takes none. */
  readonly model: string
  /**
   * Voices the provider ships statically. Empty means the catalog is fetched
   * from the service at runtime, so nothing can be checked locally.
   */
  readonly voices: readonly VoiceDescriptor[]
}

/** The call voice: the provider's own realtime channel. */
export interface RealtimeFace {
  /** Voice used when the user has not chosen one. */
  readonly defaultVoice: string
  /** Statically known voices; empty means the catalog is fetched at runtime. */
  readonly voices: readonly VoiceDescriptor[]
}

/** One voice provider. */
export interface VoiceProvider {
  /** Stable id shared with the host gateway's adapter table. */
  readonly id: VoiceProviderId
  /** Locale key suffix: the settings page renders `provider.<labelKey>`. */
  readonly labelKey: VoiceProviderLabelKey
  /** Whether this provider needs a credential at all. */
  readonly needsKey: boolean
  /** How the credential travels upstream. */
  readonly auth: VoiceAuthStyle
  /** Host-side endpoint the gateway calls by default, or '' when there is none. */
  readonly defaultUrl: string
  /** The answer voice, or undefined when the provider cannot synthesize. */
  readonly tts: TtsFace | undefined
  /** The call voice, or undefined when the provider has no realtime channel. */
  readonly realtime: RealtimeFace | undefined
}

/** Whether a chosen answer voice may be reused for a call. */
export type VoiceCompatibility =
  /** The realtime face lists this voice. */
  | 'yes'
  /** The realtime face exists and does not list this voice. */
  | 'no'
  /** A catalog is not known locally, so only the service can answer. */
  | 'unknown'

/** OpenAI's answer voices. */
const OPENAI_TTS_VOICES: readonly VoiceDescriptor[] = [
  { id: 'alloy', label: 'Alloy', lang: 'ru-RU' },
  { id: 'echo', label: 'Echo', lang: 'ru-RU' },
  { id: 'fable', label: 'Fable', lang: 'ru-RU' },
  { id: 'onyx', label: 'Onyx', lang: 'ru-RU' },
  { id: 'nova', label: 'Nova', lang: 'ru-RU' },
  { id: 'shimmer', label: 'Shimmer', lang: 'ru-RU' },
]

/** OpenAI's realtime voices — deliberately not the same set as the answer voices. */
const OPENAI_REALTIME_VOICES: readonly VoiceDescriptor[] = [
  { id: 'alloy', label: 'Alloy', lang: 'ru-RU' },
  { id: 'echo', label: 'Echo', lang: 'ru-RU' },
  { id: 'shimmer', label: 'Shimmer', lang: 'ru-RU' },
  { id: 'coral', label: 'Coral', lang: 'ru-RU' },
  { id: 'sage', label: 'Sage', lang: 'ru-RU' },
  { id: 'verse', label: 'Verse', lang: 'ru-RU' },
]

/** Every built-in provider, in the order the settings page lists them. */
export const VOICE_PROVIDERS: readonly VoiceProvider[] = [
  {
    id: 'auto',
    labelKey: 'auto',
    needsKey: false,
    auth: 'none',
    defaultUrl: '',
    tts: undefined,
    realtime: undefined,
  },
  {
    id: 'system',
    labelKey: 'system',
    needsKey: false,
    auth: 'none',
    defaultUrl: '',
    tts: { defaultVoice: '', model: '', voices: [] },
    realtime: undefined,
  },
  {
    id: 'google',
    labelKey: 'google',
    needsKey: false,
    auth: 'none',
    defaultUrl: 'https://translate.google.com/translate_tts',
    tts: { defaultVoice: '', model: '', voices: [] },
    realtime: undefined,
  },
  {
    id: 'google-cloud',
    labelKey: 'googleCloud',
    needsKey: true,
    auth: 'query',
    defaultUrl: 'https://texttospeech.googleapis.com/v1/text:synthesize',
    tts: { defaultVoice: 'ru-RU-Wavenet-D', model: '', voices: [] },
    realtime: undefined,
  },
  {
    id: 'openai',
    labelKey: 'openai',
    needsKey: true,
    auth: 'bearer',
    defaultUrl: 'https://api.openai.com/v1/audio/speech',
    tts: { defaultVoice: 'alloy', model: 'tts-1', voices: OPENAI_TTS_VOICES },
    realtime: { defaultVoice: 'alloy', voices: OPENAI_REALTIME_VOICES },
  },
  {
    id: 'elevenlabs',
    labelKey: 'elevenlabs',
    needsKey: true,
    auth: 'header',
    defaultUrl: 'https://api.elevenlabs.io/v1/text-to-speech',
    tts: { defaultVoice: '', model: 'eleven_multilingual_v2', voices: [] },
    realtime: undefined,
  },
  {
    id: 'custom',
    labelKey: 'custom',
    needsKey: true,
    auth: 'bearer',
    defaultUrl: '',
    tts: { defaultVoice: '', model: '', voices: [] },
    realtime: undefined,
  },
]

/**
 * Whether a stored value names a known provider.
 * @param value - value read out of the settings document.
 * @returns true only for a member of {@link VOICE_PROVIDER_IDS}.
 */
export function isVoiceProviderId(value: unknown): value is VoiceProviderId {
  return typeof value === 'string' && (VOICE_PROVIDER_IDS as readonly string[]).includes(value)
}

/**
 * Look one provider up by id.
 * @param id - provider id.
 * @returns the provider, or undefined when the id is unknown.
 */
export function voiceProvider(id: VoiceProviderId): VoiceProvider | undefined {
  return VOICE_PROVIDERS.find(provider => provider.id === id)
}

/**
 * Whether a provider can synthesize an answer.
 * @param provider - provider to inspect.
 * @returns true when the `tts` face exists.
 */
export function hasTtsFace(provider: VoiceProvider): boolean {
  return provider.tts !== undefined
}

/**
 * Whether a provider can carry a call in its own voice.
 * @param provider - provider to inspect.
 * @returns true when the `realtime` face exists.
 */
export function hasRealtimeFace(provider: VoiceProvider): boolean {
  return provider.realtime !== undefined
}

/**
 * Decide whether the chosen answer voice may be reused for a call. The answer
 * is only as strong as the local knowledge: a provider whose realtime catalog
 * is fetched at runtime answers 'unknown', and the caller must ask the service
 * instead of guessing.
 * @param provider - provider to inspect.
 * @param voice - the answer voice the user chose.
 * @returns 'yes' when listed, 'no' when the face exists and does not list it,
 * 'unknown' when the catalog is not known locally.
 */
export function acceptsTtsVoice(provider: VoiceProvider, voice: string): VoiceCompatibility {
  const face = provider.realtime
  if (face === undefined) return 'no'
  if (face.voices.length === 0) return 'unknown'
  return face.voices.some(item => item.id === voice) ? 'yes' : 'no'
}

/**
 * The voice a face falls back to when the user chose none.
 * @param provider - provider to inspect.
 * @param face - which face to read.
 * @returns the default voice id, or '' when the face or its default is absent.
 */
export function defaultVoiceOf(provider: VoiceProvider, face: 'tts' | 'realtime'): string {
  const chosen = face === 'tts' ? provider.tts : provider.realtime
  return chosen?.defaultVoice ?? ''
}

/**
 * Resolve the voice id a request should carry, preferring the user's choice
 * over the face default.
 * @param provider - provider to inspect.
 * @param face - which face to resolve for.
 * @param chosen - the voice stored in the settings document, or '' for none.
 * @returns the voice id to send, possibly '' when neither source names one.
 */
export function resolveVoice(provider: VoiceProvider, face: 'tts' | 'realtime', chosen: string): string {
  if (chosen !== '') return chosen
  return defaultVoiceOf(provider, face)
}

/**
 * Resolve the model a synthesis request should carry, preferring the user's
 * choice over the one the provider face ships. Shared by the read-aloud engine
 * and the settings preview so a preview cannot sound different from the answer
 * it is previewing.
 * @param provider - provider to inspect, or undefined for an unknown id.
 * @param chosen - the model stored in the settings document, or '' for none.
 * @returns the model id to send, possibly '' when neither source names one.
 */
export function resolveTtsModel(provider: VoiceProvider | undefined, chosen: string): string {
  if (chosen !== '') return chosen
  return provider?.tts?.model ?? ''
}

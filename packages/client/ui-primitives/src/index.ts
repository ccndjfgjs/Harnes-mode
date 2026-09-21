/**
 * Cordis-free React primitives styled only through `--dsw-*` tokens.
 */

export { StateDot } from './StateDot.tsx'
export type { StateDotState } from './StateDot.tsx'
export { DisclosureRow } from './DisclosureRow.tsx'
export type { DisclosureRowProps } from './DisclosureRow.tsx'
export { Button } from './Button.tsx'
export type { ButtonVariant } from './Button.tsx'
export { Pill } from './Pill.tsx'
export { Input } from './Input.tsx'
export { Menu } from './Menu.tsx'
export type { MenuEntry, MenuItem, MenuSeparator, MenuLabel } from './Menu.tsx'
export { useAnchoredMaxHeight } from './useAnchoredMaxHeight.ts'
export { useAnchoredPosition } from './useAnchoredPosition.ts'
export type { AnchoredPositionOptions } from './useAnchoredPosition.ts'
export { useDismissOnOutsidePointer } from './useDismissOnOutsidePointer.ts'
export { HoverCard } from './HoverCard.tsx'
export { Modal } from './Modal.tsx'
export { OnboardingSurface } from './OnboardingSurface.tsx'
export { RiskConfirmation } from './RiskConfirmation.tsx'
export type { RiskConfirmationProps } from './RiskConfirmation.tsx'
export { ConnectionIndicator } from './ConnectionIndicator.tsx'
export type { ConnectionIndicatorState } from './ConnectionIndicator.tsx'
export { FishLogo, FISH_LOGO_PATH, FISH_LOGO_VIEWBOX } from './FishLogo.tsx'
export { BrandWordmark } from './BrandWordmark.tsx'
export type { BrandWordmarkProps } from './BrandWordmark.tsx'
export { ReferenceIcon } from './ReferenceIcon.tsx'
export type { ReferenceIconKind, ReferenceIconProps } from './ReferenceIcon.tsx'
export { projectUserText } from './user-text.tsx'
export { Tooltip } from './Tooltip.tsx'
export type { TooltipSide } from './Tooltip.tsx'
export { SettingsRadioOption, SettingsSaveBar } from './SettingsOptions.tsx'
export { Toast } from './Toast.tsx'
export { writeClipboard } from './clipboard.ts'
export { isBatchOnlyModel, modelSupportBadge } from './batch-model.ts'
export type { ModelSupportBadge } from './batch-model.ts'
export { IMPROVE_ANNOUNCE_STORAGE_KEY, IMPROVE_READ_ALOUD_STORAGE_KEY, readImproveAnnounce, readImproveReadAloud, writeImproveAnnounce, writeImproveReadAloud } from './improve-announce.ts'
export {
  cancelSpeech, getTtsBackend, isSpeechSynthesisAvailable, pickRussianVoice, resolveSpeechLang,
  setTtsBackend, speak, speakCode, speakText, speakWithBackend, webSpeechBackend,
} from './speech-synthesis.ts'
export type { CodeSpeechMode, SpeakOptions, SpeechLifecycle, TtsBackend } from './speech-synthesis.ts'
export { createRecognition, isSpeechRecognitionAvailable } from './speech-recognition.ts'
export type { RecognitionHandle, RecognitionOptions, RecognitionResult } from './speech-recognition.ts'
export {
  ensureMicrophoneAccess, isMediaDevicesAvailable, listAudioDevices, readMicrophonePermission,
} from './media-devices.ts'
export type { AudioDevice, CapturePermission } from './media-devices.ts'
export {
  SPEECH_ROUTE, chooseSpeechEngine, createSpeechEngine, installSpeechEngine, planSpeech,
} from './speech-engine.ts'
export type { SpeechEngineChoice, SpeechPlan } from './speech-engine.ts'
export { readCallVoice, readVoiceEndpoints, readVoiceSelection } from './voice-endpoint.ts'
export type {
  CallVoice, CallVoiceFit, CallVoiceMode, VoiceEndpoint, VoiceEndpoints, VoiceSelection,
} from './voice-endpoint.ts'
export {
  DEFAULT_VOICE_SELECTION, VOICE_KEY_HEADER, VOICE_PITCH_MAX, VOICE_PITCH_MIN,
  VOICE_SETTINGS_STORAGE_KEY, VOICE_SPEED_MAX, VOICE_SPEED_MIN, VOICE_URL_HEADER,
} from './voice-endpoint.ts'
export {
  LOCAL_STT_ROUTE, NOTHING_TO_RECOGNIZE_CODE, NOTHING_TO_RECOGNIZE_SETTING,
  NothingToRecognizeError, SERVICE_STT_ROUTE, STT_DEFAULT_LANG, STT_ENGINE_IDS, SttError,
  createLocalSttEngine, createServiceSttEngine, createSttEngine, isSttEngineId,
  requireSttEngine, resolveSttEngineKind,
} from './voice/stt-engine.ts'
export type {
  NothingToRecognizeShape, SttEngine, SttEngineId, SttEngineKind, SttEngineOptions,
  SttFailureReason, TranscriptionRequest, TranscriptionResult,
} from './voice/stt-engine.ts'
export { SPEAK_START_GRACE_MS, createInstalledSpeaker } from './voice/tts-speaker.ts'
export type { SpeakOutcome, SpeakRequest, Speaker, SpeakerOptions } from './voice/tts-speaker.ts'
export {
  DEFAULT_VOICE_MODULE_SETTINGS, VOICE_REPLY_MODES, isAnswerVoiced, isVoiceReplyMode,
  readVoiceModuleSettings, writeVoiceModuleSettings,
} from './voice/voice-module-settings.ts'
export type { VoiceModuleSettings, VoiceReplyMode } from './voice/voice-module-settings.ts'
export { ANSWER_TIMEOUT_MS, createVoiceModule } from './voice/voice-module.ts'
export type {
  VoiceFailureReason, VoiceModule, VoiceModuleOptions, VoiceModuleSnapshot, VoiceModuleState,
  VoiceTurnSink,
} from './voice/voice-module.ts'
export {
  createAudioCapture, isAudioCaptureAvailable,
} from './voice/audio-capture.ts'
export type {
  AudioCapture, AudioCaptureOptions, AudioCaptureSnapshot, CapturedClip,
} from './voice/audio-capture.ts'
export {
  VOICE_PROVIDERS, VOICE_PROVIDER_IDS, acceptsTtsVoice, defaultVoiceOf, hasRealtimeFace, hasTtsFace,
  isVoiceProviderId, resolveTtsModel, resolveVoice, voiceProvider,
} from './voice-providers.ts'
export type {
  RealtimeFace, TtsFace, VoiceAuthStyle, VoiceCompatibility, VoiceDescriptor, VoiceProvider,
  VoiceProviderId, VoiceProviderLabelKey,
} from './voice-providers.ts'
export {
  DEFAULT_SCREEN_SETTINGS, SCREEN_BUFFER_BYTES_MAX, SCREEN_BUFFER_BYTES_MIN, SCREEN_BUFFER_FRAMES_MAX,
  SCREEN_BUFFER_FRAMES_MIN, SCREEN_BUFFER_TEXT_MAX, SCREEN_BUFFER_TEXT_MIN, SCREEN_CAPTURE_SCOPES,
  SCREEN_INTERVAL_MAX_MS, SCREEN_INTERVAL_MIN_MS, SCREEN_MAX_EDGE_CHOICES, SCREEN_PREVIEW_CORNERS,
  SCREEN_SETTINGS_STORAGE_KEY, SCREEN_THRESHOLD_MAX, SCREEN_THRESHOLD_MIN,
  readScreenSettings,
} from './screen-settings.ts'
export type { ScreenCaptureScope, ScreenPreviewCorner, ScreenSettings } from './screen-settings.ts'
export {
  createScreenCaptureEngine, displayConstraints, installScreenCapture, screenCapture,
} from './screen-capture-engine.ts'
export type {
  CaptureState, CapturedFrame, ScreenCaptureEngine, ScreenCaptureOptions, ScreenCaptureSnapshot,
} from './screen-capture-engine.ts'
export { createIntervalTimer, createWorkerTimer } from './screen-timer.ts'
export type { FrameTimer } from './screen-timer.ts'
export { describeCodeForSpeech, stripMarkdownForSpeech } from './speech-text.ts'
export {
  FOCUSABLE_SELECTOR, VOICE_NAV_ACTIONABLE_SELECTOR, VOICE_NAV_HOVER_SELECTOR, createVoiceNavHandlers,
  getSpeakableNavText, getVoiceNavChatTrigger, installVoiceNavArrowDelegation, installVoiceNavDelegation,
  isVoiceNavArrowEnabled, isVoiceNavEnabled, isVoiceNavHoverEnabled, speakNavElement, speakNavText,
} from './speak-nav.ts'
export {
  ACCESSIBILITY_SETTINGS_STORAGE_KEY, DEFAULT_ACCESSIBILITY_SETTINGS,
  readAccessibilitySettings, readSpeechDelayMs, writeAccessibilitySettings,
} from './accessibility-settings.ts'
export type {
  AccessibilityFont, AccessibilitySettings, CodeReadingMode, ContrastTheme, VoiceNavChatTrigger,
} from './accessibility-settings.ts'
export { relativeTime } from './relative-time.ts'
export type { RelativeTime, RelativeTimeUnit } from './relative-time.ts'
export { JsonTree } from './JsonTree.tsx'
export type { JsonTreeProps, JsonTreeLabels } from './JsonTree.tsx'
export { TerminalBlock, DEFAULT_TERMINAL_MAX_LINES } from './TerminalBlock.tsx'
export type { TerminalBlockProps, TerminalBlockLabels } from './TerminalBlock.tsx'
export { ReadBlock, DEFAULT_READ_MAX_LINES } from './ReadBlock.tsx'
export type { ReadBlockProps, ReadBlockLine, ReadBlockLabels } from './ReadBlock.tsx'
export { DiffBlock, DEFAULT_DIFF_MAX_LINES, diffTotals } from './DiffBlock.tsx'
export type { DiffBlockProps, DiffHunk, DiffBlockLabels } from './DiffBlock.tsx'
export { SearchBlock, DEFAULT_SEARCH_MAX_LINES } from './SearchBlock.tsx'
export type {
  SearchBlockProps, SearchMatchesBlockProps, SearchPathsBlockProps, SearchFileGroup, SearchBlockLineMatch,
  SearchBlockLabels,
} from './SearchBlock.tsx'
export { WebBlock } from './WebBlock.tsx'
export type {
  WebBlockProps, WebSearchBlockProps, WebFetchBlockProps, WebSourceView, WebBlockLabels,
} from './WebBlock.tsx'
export { CodeBlock } from './markdown/CodeBlock.tsx'
export type { CodeBlockProps } from './markdown/CodeBlock.tsx'
export { JsonBlock } from './markdown/JsonBlock.tsx'
export { MarkdownText } from './markdown/MarkdownText.tsx'
export type { MarkdownCodeLabels, MarkdownFileMentions, MarkdownLabels } from './markdown/MarkdownText.tsx'
export { MessageText } from './markdown/MessageText.tsx'
export { extractMarkdownPlainText } from './markdown/plain-text.ts'
export type { MarkdownPlainTextMode, MarkdownPlainTextOptions } from './markdown/plain-text.ts'
export * from './icons/index.tsx'

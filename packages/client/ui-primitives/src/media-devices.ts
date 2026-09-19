/**
 * Capture devices: microphone permission and audio-device enumeration through
 * navigator.mediaDevices. The Web Speech engines ask for the microphone
 * themselves, but only while a run starts — there is no way to ask ahead of
 * time, and no way to list what the machine actually has: enumerateDevices
 * answers with blank labels until capture is granted at least once. This leaf
 * owns both gaps, so the settings page can show a real permission state and a
 * real device roster instead of stored checkboxes that never touched the OS.
 * Dependency-free (like speech-recognition.ts), so any client package may
 * import it without bundle-purity edges. Every entry point degrades to a
 * quiet answer outside a capable context (jsdom has no mediaDevices at all).
 */

/** The state the Permissions API reports for one capture class. */
export type CapturePermission = 'granted' | 'denied' | 'prompt' | 'unknown'

/** One audio endpoint the machine exposes. */
export interface AudioDevice {
  /** The stable id getUserMedia accepts as `deviceId`, '' when hidden. */
  readonly deviceId: string
  /** Whether this endpoint records ('audioinput') or plays ('audiooutput'). */
  readonly kind: 'audioinput' | 'audiooutput'
  /**
   * The human-readable name, '' while capture is not granted: the spec hides
   * labels until then, so a blank label is a permission hint, not a bug.
   */
  readonly label: string
}

/**
 * Structural face of the mediaDevices entry points this module reads. The
 * standard marks mediaDevices as always present, but insecure contexts and
 * jsdom expose navigator without it, so the module probes instead of trusting
 * the declaration.
 */
interface MediaDevicesFace {
  getUserMedia?(constraints: MediaStreamConstraints): Promise<MediaStream>
  enumerateDevices?(): Promise<MediaDeviceInfo[]>
}

/** Probe the mediaDevices object the runtime actually exposes. */
function mediaDevices(): MediaDevicesFace | undefined {
  return (navigator as unknown as { mediaDevices?: MediaDevicesFace }).mediaDevices
}

/**
 * Whether capture devices can be asked about at all.
 * @returns false outside browsers exposing navigator.mediaDevices.getUserMedia.
 */
export function isMediaDevicesAvailable(): boolean {
  return typeof mediaDevices()?.getUserMedia === 'function'
}

/**
 * Read the current microphone permission without prompting. The Permissions
 * API has no 'microphone' name on every engine (Safari answers with a TypeError),
 * so a failed query collapses to 'unknown' rather than a guessed state.
 * @returns the stored state, or 'unknown' where it cannot be read.
 */
export async function readMicrophonePermission(): Promise<CapturePermission> {
  const permissions = (navigator as unknown as { permissions?: Permissions }).permissions
  if (permissions === undefined || typeof permissions.query !== 'function') return 'unknown'
  try {
    const status = await permissions.query({ name: 'microphone' as PermissionName })
    return status.state
  } catch {
    return 'unknown'
  }
}

/**
 * Ask for the microphone now, turning the engine's own mid-run prompt into an
 * explicit, explainable moment: the browser shows its permission affordance
 * here, and a granted run also unlocks the device labels enumerateDevices
 * hides. The stream is stopped immediately — this primes, it never records.
 * @returns true when capture is usable after the call, false on denial or an
 *   incapable context.
 */
export async function ensureMicrophoneAccess(): Promise<boolean> {
  const devices = mediaDevices()
  if (devices === undefined || typeof devices.getUserMedia !== 'function') return false
  try {
    const stream = await devices.getUserMedia({ audio: true })
    stream.getTracks().forEach((track) => { track.stop() })
    return true
  } catch {
    return false
  }
}

/**
 * List the machine's audio inputs and outputs. Labels arrive blank while
 * capture has never been granted; callers that need names should run
 * ensureMicrophoneAccess() first, then list again.
 * @returns the audio endpoints, or [] where enumeration is unavailable.
 */
export async function listAudioDevices(): Promise<AudioDevice[]> {
  const devices = mediaDevices()
  if (devices === undefined || typeof devices.enumerateDevices !== 'function') return []
  try {
    const all = await devices.enumerateDevices()
    return all
      .filter((device) => device.kind === 'audioinput' || device.kind === 'audiooutput')
      .map((device) => ({
        deviceId: device.deviceId,
        kind: device.kind as AudioDevice['kind'],
        label: device.label,
      }))
  } catch {
    return []
  }
}

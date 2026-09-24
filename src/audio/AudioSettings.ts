/** Independent normalized channel controls for the one real flight-audio graph. */
export interface AudioMix {
  readonly musicVolume: number;
  readonly sfxVolume: number;
}

export const AUDIO_MIX_STORAGE_KEY = 'void-explorer:audio:mix:v1';

/** Music-forward defaults leave genuine drive effects present without masking the score. */
export const DEFAULT_AUDIO_MIX: Readonly<AudioMix> = Object.freeze({
  musicVolume: 0.85,
  sfxVolume: 0.60,
});

function normalizeChannel(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback;
}

/** Normalize each actual channel independently; invalid values never corrupt its sibling. */
export function normalizeAudioMix(value: unknown): AudioMix {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return DEFAULT_AUDIO_MIX;
  }

  const channels = value as Partial<Record<keyof AudioMix, unknown>>;
  return {
    musicVolume: normalizeChannel(channels.musicVolume, DEFAULT_AUDIO_MIX.musicVolume),
    sfxVolume: normalizeChannel(channels.sfxVolume, DEFAULT_AUDIO_MIX.sfxVolume),
  };
}

/** Corrupt, absent, or obsolete saved preferences safely restore the actual defaults. */
export function parseStoredAudioMix(value: string | null | undefined): AudioMix {
  if (typeof value !== 'string' || value.length === 0) return DEFAULT_AUDIO_MIX;

  try {
    return normalizeAudioMix(JSON.parse(value) as unknown);
  } catch {
    return DEFAULT_AUDIO_MIX;
  }
}

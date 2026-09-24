/** Professionally recorded score distributed by its composer under CC BY 4.0. */
export const SPACE_MUSIC_TRACK = Object.freeze({
  title: 'Aphelion',
  artist: 'Scott Buckley',
  url: '/audio/aphelion.mp3',
  license: 'CC BY 4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  artistUrl: 'https://www.scottbuckley.com.au/',
  attribution: "'Aphelion' by Scott Buckley - released under CC-BY 4.0. www.scottbuckley.com.au",
});

export interface SpaceMusicOptions {
  /** Retained for compatibility with the existing universe-aware audio factory. */
  readonly seed?: string | number;
  /** Allows deterministic lifecycle tests without constructing a browser audio element. */
  readonly createMediaElement?: () => HTMLAudioElement;
}

/** Plays the licensed recording through the existing caller-owned Web Audio graph. */
export class SpaceMusic {
  readonly track = SPACE_MUSIC_TRACK;
  readonly media: HTMLAudioElement;

  private readonly context: AudioContext;
  private readonly source: MediaElementAudioSourceNode;
  private readonly gain: GainNode;
  private started = false;
  private disposed = false;

  constructor(context: AudioContext, output: AudioNode, options: SpaceMusicOptions = {}) {
    this.context = context;
    this.media = options.createMediaElement?.() ?? new Audio();
    this.media.src = SPACE_MUSIC_TRACK.url;
    this.media.preload = 'auto';
    this.media.loop = true;
    this.gain = context.createGain();
    this.gain.gain.value = 0.7;
    this.source = context.createMediaElementSource(this.media);
    this.source.connect(this.gain);
    this.gain.connect(output);
  }

  get playing(): boolean {
    return this.started && !this.disposed;
  }

  get activeVoices(): number {
    return this.playing ? 1 : 0;
  }

  /** Called synchronously by FlightAudio inside the real activating user gesture. */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    try {
      const playback = this.media.play();
      if (playback && typeof playback.catch === 'function') {
        void playback.catch(() => {
          if (!this.disposed) this.started = false;
        });
      }
    } catch {
      this.started = false;
    }
  }

  /** The recorded media element owns its transport; no oscillator scheduler is needed. */
  update(_audioTimeSeconds?: number): void {}

  setIntensity(value: number): void {
    if (this.disposed || !Number.isFinite(value)) return;
    const intensity = Math.max(0, Math.min(1, value));
    this.gain.gain.setTargetAtTime(0.62 + intensity * 0.16, this.context.currentTime, 0.35);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.media.pause();
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    this.source.disconnect();
    this.gain.disconnect();
    this.media.removeAttribute('src');
    this.media.load();
    // FlightAudio alone owns and closes the shared AudioContext.
  }
}

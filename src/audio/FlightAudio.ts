import { normalizeAudioMix, type AudioMix } from './AudioSettings';

export type FlightAudioMode = 'cruise' | 'boost' | 'pulse' | 'hyperdrive';

export interface FlightAudioSnapshot {
  readonly throttle: number;
  readonly speedMetersPerSecond: number;
  readonly mode: FlightAudioMode;
  readonly phase?: string;
  readonly spoolProgress?: number;
  readonly travelProgress?: number;
  readonly landed: boolean;
  /** A paused game menu silences ship effects without stopping the music transport. */
  readonly paused?: boolean;
  readonly atmosphereDensity?: number;
  readonly cockpit?: boolean;
  readonly altitudeMeters?: number;
  /** Real surface/occupancy lifecycle, separate from faster-than-light phase. */
  readonly surfacePhase?: string;
  readonly surfaceThrust?: number;
  readonly surfaceEventSerial?: number;
  readonly touchdownImpulseMetersPerSecond?: number;
  readonly occupancyPhase?: string;
  readonly occupancyEventSerial?: number;
  readonly outside?: boolean;
  readonly walkingSpeedMetersPerSecond?: number;
  readonly grounded?: boolean;
}

export interface FlightAudioMusic {
  readonly playing?: boolean;
  readonly activeVoices?: number;
  start(): void;
  update(audioTimeSeconds?: number): void;
  stop(): void;
  dispose(): void;
  setIntensity?(value: number): void;
}

type AudioVisibilityTarget = Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>;

export interface FlightAudioOptions {
  readonly musicFactory?: (context: AudioContext, output: GainNode) => FlightAudioMusic;
  readonly createContext?: () => AudioContext;
  readonly visibilityTarget?: AudioVisibilityTarget;
  readonly volume?: number;
  readonly muted?: boolean;
  readonly musicVolume?: number;
  readonly sfxVolume?: number;
}

interface FlightAudioGraph {
  readonly context: AudioContext;
  readonly compressor: DynamicsCompressorNode;
  readonly master: GainNode;
  readonly musicBus: GainNode;
  readonly effectsBus: GainNode;
  readonly engine: GainNode;
  readonly engineFilter: BiquadFilterNode;
  readonly hiss: GainNode;
  readonly hissFilter: BiquadFilterNode;
  readonly cabin: GainNode;
  readonly oscillators: readonly OscillatorNode[];
  readonly noise: AudioBufferSourceNode;
  readonly nodes: readonly AudioNode[];
}

const MAXIMUM_TRANSIENT_VOICES = 4;
const MAXIMUM_MUSIC_BUS_GAIN = 0.64;
const MAXIMUM_EFFECTS_BUS_GAIN = 0.64;
const SURFACE_DRIVE_REFERENCE_METERS_PER_SECOND = 1_800_000;

function finite(value: number | undefined, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function ease(value: number): number {
  const bounded = clamp(value);
  return bounded * bounded * (3 - 2 * bounded);
}

function target(parameter: AudioParam, value: number, time: number, response = 0.095): void {
  parameter.setTargetAtTime(value, time, Math.max(0.008, response));
}

function resolveAudioContextFactory(): (() => AudioContext) | undefined {
  const constructors = globalThis as typeof globalThis & {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const Context = constructors.AudioContext ?? constructors.webkitAudioContext;
  return Context ? () => new Context() : undefined;
}

/**
 * One gesture-activated audio graph for actual spacecraft motion and original music.
 *
 * Nothing is created until activate() runs synchronously inside a real key/pointer
 * handler. All continuous sources are long-lived; update() changes only bounded
 * AudioParam targets and lets the same audio-clock-driven music transport advance.
 */
export class FlightAudio {
  private readonly options: FlightAudioOptions;
  private readonly contextFactory: (() => AudioContext) | undefined;
  private readonly visibilityTarget: AudioVisibilityTarget | undefined;
  private readonly outputVolume: number;
  private readonly transientVoices = new Set<OscillatorNode>();
  private graph: FlightAudioGraph | undefined;
  private music: FlightAudioMusic | undefined;
  private userActivated = false;
  private disposed = false;
  private mutedState: boolean;
  private pausedState = false;
  private mix: AudioMix;
  private suspendedWhileHidden = false;
  private previousMode: FlightAudioMode | undefined;
  private previousPhase: string | undefined;
  private previousLanded: boolean | undefined;
  private previousSurfaceEventSerial: number | undefined;
  private previousOccupancyEventSerial: number | undefined;
  private footstepDistanceMeters = 0;
  private currentEngineGain = 0;

  constructor(options: FlightAudioOptions = {}) {
    this.options = options;
    this.contextFactory = options.createContext ?? resolveAudioContextFactory();
    this.visibilityTarget = options.visibilityTarget ??
      (typeof document === 'undefined' ? undefined : document);
    this.outputVolume = clamp(finite(options.volume, 0.72));
    this.mutedState = options.muted === true;
    this.mix = normalizeAudioMix({
      musicVolume: options.musicVolume,
      sfxVolume: options.sfxVolume,
    });
  }

  get active(): boolean {
    return this.userActivated && !this.disposed && this.graph?.context.state === 'running';
  }

  get muted(): boolean {
    return this.mutedState;
  }

  get musicVolume(): number {
    return this.mix.musicVolume;
  }

  get sfxVolume(): number {
    return this.mix.sfxVolume;
  }

  get supported(): boolean {
    return this.contextFactory !== undefined;
  }

  get contextState(): string {
    return this.graph?.context.state ?? (this.disposed ? 'closed' : 'idle');
  }

  get musicActive(): boolean {
    return this.active && !this.mutedState && this.mix.musicVolume > 0 &&
      (this.music?.playing ?? Boolean(this.music));
  }

  get activeVoices(): number {
    if (!this.active || this.mutedState) return 0;
    return (this.graph?.oscillators.length ?? 0) +
      (this.graph ? 1 : 0) +
      this.transientVoices.size +
      Math.max(0, finite(this.music?.activeVoices));
  }

  get engineGain(): number {
    return this.active && !this.mutedState
      ? this.currentEngineGain * this.mix.sfxVolume * MAXIMUM_EFFECTS_BUS_GAIN
      : 0;
  }

  /** Adjust only existing channel gains; this never activates, resumes, or unmutes audio. */
  setMix(values: AudioMix): AudioMix {
    const next = normalizeAudioMix(values);
    const previous = this.mix;
    if (next.musicVolume === previous.musicVolume && next.sfxVolume === previous.sfxVolume) {
      return previous;
    }

    this.mix = next;
    if (this.graph && !this.disposed) {
      const now = this.graph.context.currentTime;
      if (next.musicVolume !== previous.musicVolume) {
        target(this.graph.musicBus.gain, next.musicVolume * MAXIMUM_MUSIC_BUS_GAIN, now, 0.075);
      }
      if (next.sfxVolume !== previous.sfxVolume) {
        target(this.graph.effectsBus.gain, next.sfxVolume * MAXIMUM_EFFECTS_BUS_GAIN, now, 0.075);
      }
    }
    return this.mix;
  }

  /** Must be called directly from a genuine pointer or keyboard gesture. */
  activate(): Promise<boolean> {
    if (this.disposed || !this.contextFactory) return Promise.resolve(false);

    let createdContext: AudioContext | undefined;
    try {
      if (!this.graph) {
        const context = this.contextFactory();
        createdContext = context;
        this.graph = this.createGraph(context);
        this.userActivated = true;
        this.visibilityTarget?.addEventListener('visibilitychange', this.onVisibilityChange);
        if (this.options.musicFactory) {
          this.music = this.options.musicFactory(context, this.graph.musicBus);
          this.music.start();
        }
      }

      // Creating AND resuming happen before any await/microtask: Chromium and
      // Safari both require these calls while the trusted gesture is still live.
      const resume = this.graph.context.state === 'suspended'
        ? this.graph.context.resume()
        : Promise.resolve();
      return Promise.resolve(resume)
        .then(() => !this.disposed && this.graph?.context.state === 'running')
        .catch(() => false);
    } catch {
      this.visibilityTarget?.removeEventListener('visibilitychange', this.onVisibilityChange);
      this.music?.stop();
      this.music?.dispose();
      this.music = undefined;
      const graphOwnedContext = this.graph?.context === createdContext;
      this.releaseGraph();
      if (createdContext && !graphOwnedContext && createdContext.state !== 'closed') {
        void createdContext.close().catch(() => {});
      }
      this.userActivated = false;
      return Promise.resolve(false);
    }
  }

  update(snapshot: FlightAudioSnapshot, deltaSeconds = 1 / 60): void {
    if (this.disposed) return;
    const paused = snapshot.paused === true;
    this.pausedState = paused;
    const graph = this.graph;
    if (!graph || graph.context.state === 'closed') {
      if (paused) {
        this.consumeEventIdentities(snapshot);
        this.footstepDistanceMeters = 0;
        this.currentEngineGain = 0;
      }
      return;
    }
    // A paused, suspended graph can still receive silent gain targets and
    // consume real events. This never resumes it or creates an audio context.
    if (graph.context.state !== 'running' && !paused) return;

    const now = graph.context.currentTime;
    const throttle = clamp(Math.abs(finite(snapshot.throttle)));
    const physicalSpeed = Math.max(0, finite(snapshot.speedMetersPerSecond));
    const speed = clamp(
      Math.log1p(Math.min(physicalSpeed, SURFACE_DRIVE_REFERENCE_METERS_PER_SECOND)) /
        Math.log1p(SURFACE_DRIVE_REFERENCE_METERS_PER_SECOND),
    );
    const atmosphere = clamp(finite(snapshot.atmosphereDensity));
    const spool = clamp(finite(snapshot.spoolProgress));
    const boost = snapshot.mode === 'boost' ? 1 : 0;
    const guided = snapshot.mode === 'pulse' || snapshot.mode === 'hyperdrive';
    const hyper = snapshot.mode === 'hyperdrive' ? 1 : 0;
    const surfaceThrust = clamp(finite(snapshot.surfaceThrust));
    const outsideAttenuation = snapshot.outside ? 0.26 : 1;
    const thrust = snapshot.landed
      ? surfaceThrust
      : clamp(throttle * 0.61 + speed * 0.29 + boost * 0.11 + spool * 0.19);
    const shapedThrust = ease(Math.max(thrust, surfaceThrust));
    const response = Math.max(0.035, Math.min(0.14, finite(deltaSeconds, 1 / 60) * 3.2));

    this.currentEngineGain = paused ? 0 : (snapshot.landed && surfaceThrust === 0
      ? 0.002
      : 0.013 + shapedThrust * 0.17 + boost * 0.026 + spool * 0.022) * outsideAttenuation;
    target(graph.engine.gain, this.currentEngineGain, now, response);
    target(graph.engineFilter.frequency,
      (240 + shapedThrust * 1_480 + boost * 420 + atmosphere * 310) *
        (snapshot.cockpit ? 0.76 : 1),
      now, response * 1.4);
    target(graph.oscillators[0]!.frequency,
      44 + shapedThrust * 66 + speed * 17 + spool * (hyper ? 82 : 46),
      now, response * 1.25);
    target(graph.oscillators[1]!.frequency,
      87 + shapedThrust * 112 + boost * 34 + spool * (hyper ? 114 : 67),
      now, response);
    target(graph.oscillators[2]!.frequency,
      28 + shapedThrust * 31 + (guided ? 15 : 0),
      now, response * 1.6);

    // The faint fire is an actual thrust response; atmospheric wind exists only
    // where the receiver is genuinely inside a body-centered atmosphere.
    const blueFireHiss = snapshot.landed && surfaceThrust === 0
      ? 0.0005
      : (0.004 + shapedThrust * (0.068 + atmosphere * 0.055) + boost * 0.018) * outsideAttenuation;
    target(graph.hiss.gain, paused ? 0 : blueFireHiss, now, response * 1.1);
    target(graph.hissFilter.frequency,
      1_050 + shapedThrust * 2_650 + atmosphere * 1_150 + hyper * 280,
      now, response * 1.4);
    const cabinGain = snapshot.outside
      ? atmosphere * 0.009
      : 0.005 + (snapshot.cockpit ? 0.007 : 0.002) + atmosphere * speed * 0.012;
    target(graph.cabin.gain, paused ? 0 : cabinGain, now, 0.19);

    if (this.previousMode !== undefined) {
      if (snapshot.surfaceEventSerial === undefined && snapshot.landed && this.previousLanded === false) {
        this.playTransition(184, 82, 0.2, 0.085, 'triangle');
      } else if (snapshot.surfaceEventSerial === undefined && !snapshot.landed && this.previousLanded === true) {
        this.playTransition(78, 166, 0.25, 0.075, 'triangle');
      } else if (snapshot.mode !== this.previousMode) {
        if (snapshot.mode === 'boost') {
          this.playTransition(96, 238, 0.19, 0.077, 'sawtooth');
        } else if (snapshot.mode === 'hyperdrive') {
          this.playTransition(112, 412, 0.52, 0.11, 'sawtooth');
        } else if (snapshot.mode === 'pulse') {
          this.playTransition(140, 344, 0.37, 0.086, 'triangle');
        } else if (this.previousMode === 'pulse' || this.previousMode === 'hyperdrive') {
          this.playTransition(310, 126, 0.32, 0.084, 'sine');
        }
      } else if (snapshot.phase === 'spooling' && this.previousPhase !== 'spooling') {
        this.playTransition(114, hyper ? 396 : 288, hyper ? 0.46 : 0.32, 0.072, 'triangle');
      }
    }

    // A serial belongs to the simulation event, not the rendered frame. A
    // paused menu, low frame rate, or restore must not repeat a gear impact.
    if (snapshot.surfaceEventSerial !== undefined) {
      if (this.previousSurfaceEventSerial !== undefined &&
        snapshot.surfaceEventSerial !== this.previousSurfaceEventSerial) {
        if (snapshot.surfacePhase === 'touchdown-settle') {
          const impact = clamp(finite(snapshot.touchdownImpulseMetersPerSecond) / 5);
          this.playTransition(142 + impact * 38, 48, 0.24, 0.052 + impact * 0.026, 'triangle');
        } else if (snapshot.surfacePhase === 'landing-armed') {
          this.playTransition(228, 104, 0.3, 0.037, 'triangle');
        } else if (snapshot.surfacePhase === 'takeoff-spool') {
          this.playTransition(64, 188, 0.48, 0.055, 'sine');
        } else if (snapshot.surfacePhase === 'takeoff-climb') {
          this.playTransition(102, 286, 0.25, 0.047, 'triangle');
        }
      }
    }
    if (snapshot.occupancyEventSerial !== undefined) {
      if (this.previousOccupancyEventSerial !== undefined &&
        snapshot.occupancyEventSerial !== this.previousOccupancyEventSerial &&
        (snapshot.occupancyPhase === 'egressing' || snapshot.occupancyPhase === 'boarding')) {
        const boarding = snapshot.occupancyPhase === 'boarding';
        this.playTransition(boarding ? 96 : 184, boarding ? 184 : 96, 0.32, 0.034, 'triangle');
      }
    }
    if (!paused && snapshot.outside && snapshot.grounded) {
      this.footstepDistanceMeters += Math.min(8, Math.max(0, finite(snapshot.walkingSpeedMetersPerSecond))) *
        Math.min(0.05, Math.max(0, finite(deltaSeconds, 1 / 60)));
      if (this.footstepDistanceMeters >= 1.55) {
        this.footstepDistanceMeters %= 1.55;
        this.playTransition(94, 47, 0.085, 0.025, 'triangle');
      }
    } else {
      this.footstepDistanceMeters = 0;
    }

    this.consumeEventIdentities(snapshot);
    this.music?.setIntensity?.(snapshot.landed
      ? 0.2
      : clamp(0.32 + shapedThrust * 0.36 + (guided ? 0.2 : 0)));
    if (!this.mutedState && graph.context.state === 'running') this.music?.update(now);
  }

  setMuted(muted: boolean): boolean {
    this.mutedState = muted === true;
    if (this.graph && !this.disposed) {
      target(this.graph.master.gain,
        this.mutedState ? 0 : this.outputVolume,
        this.graph.context.currentTime,
        this.mutedState ? 0.025 : 0.08);
      if (!this.mutedState && this.userActivated && !this.visibilityTarget?.hidden &&
        this.graph.context.state === 'suspended') {
        void this.graph.context.resume().catch(() => {});
      }
    }
    return this.mutedState;
  }

  toggleMute(): boolean {
    return this.setMuted(!this.mutedState);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.visibilityTarget?.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.music?.stop();
    this.music?.dispose();
    this.music = undefined;
    this.releaseGraph();
    this.userActivated = false;
    this.currentEngineGain = 0;
  }

  private readonly onVisibilityChange = (): void => {
    const context = this.graph?.context;
    if (!context || this.disposed || !this.userActivated) return;
    if (this.visibilityTarget?.hidden) {
      if (context.state !== 'running') return;
      this.suspendedWhileHidden = true;
      void context.suspend().catch(() => {});
      return;
    }
    if (this.suspendedWhileHidden && !this.mutedState && context.state === 'suspended') {
      this.suspendedWhileHidden = false;
      void context.resume().catch(() => {});
    }
  };

  private consumeEventIdentities(snapshot: FlightAudioSnapshot): void {
    this.previousMode = snapshot.mode;
    this.previousPhase = snapshot.phase;
    this.previousLanded = snapshot.landed;
    if (snapshot.surfaceEventSerial !== undefined) {
      this.previousSurfaceEventSerial = snapshot.surfaceEventSerial;
    }
    if (snapshot.occupancyEventSerial !== undefined) {
      this.previousOccupancyEventSerial = snapshot.occupancyEventSerial;
    }
  }

  private createGraph(context: AudioContext): FlightAudioGraph {
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -20;
    compressor.knee.value = 17;
    compressor.ratio.value = 3.4;
    compressor.attack.value = 0.008;
    compressor.release.value = 0.19;

    const master = context.createGain();
    master.gain.value = this.mutedState ? 0 : this.outputVolume;
    const musicBus = context.createGain();
    musicBus.gain.value = this.mix.musicVolume * MAXIMUM_MUSIC_BUS_GAIN;
    const effectsBus = context.createGain();
    effectsBus.gain.value = this.mix.sfxVolume * MAXIMUM_EFFECTS_BUS_GAIN;
    musicBus.connect(compressor);
    effectsBus.connect(compressor);
    compressor.connect(master);
    master.connect(context.destination);

    const engine = context.createGain();
    engine.gain.value = this.pausedState ? 0 : 0.002;
    const engineFilter = context.createBiquadFilter();
    engineFilter.type = 'lowpass';
    engineFilter.frequency.value = 290;
    engineFilter.Q.value = 0.72;
    engineFilter.connect(engine);
    engine.connect(effectsBus);

    const fundamental = context.createOscillator();
    fundamental.type = 'triangle';
    fundamental.frequency.value = 44;
    const harmonic = context.createOscillator();
    harmonic.type = 'sawtooth';
    harmonic.frequency.value = 87;
    const sub = context.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = 28;
    const fundamentalMix = context.createGain();
    fundamentalMix.gain.value = 0.58;
    const harmonicMix = context.createGain();
    harmonicMix.gain.value = 0.15;
    const subMix = context.createGain();
    subMix.gain.value = 0.37;
    fundamental.connect(fundamentalMix);
    harmonic.connect(harmonicMix);
    sub.connect(subMix);
    fundamentalMix.connect(engineFilter);
    harmonicMix.connect(engineFilter);
    subMix.connect(engineFilter);

    const noise = context.createBufferSource();
    const sampleRate = Math.max(8_000, finite(context.sampleRate, 44_100));
    const frameCount = Math.max(512, Math.round(sampleRate * 0.42));
    const buffer = context.createBuffer(1, frameCount, sampleRate);
    const channel = buffer.getChannelData(0);
    let seed = 0x9e37_79b9;
    let previous = 0;
    for (let index = 0; index < channel.length; index += 1) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      const white = ((seed >>> 0) / 0xffff_ffff) * 2 - 1;
      previous = previous * 0.26 + white * 0.74;
      channel[index] = previous * 0.34;
    }
    noise.buffer = buffer;
    noise.loop = true;

    const hissFilter = context.createBiquadFilter();
    hissFilter.type = 'bandpass';
    hissFilter.frequency.value = 1_050;
    hissFilter.Q.value = 0.8;
    const hiss = context.createGain();
    hiss.gain.value = this.pausedState ? 0 : 0.0005;
    noise.connect(hissFilter);
    hissFilter.connect(hiss);
    hiss.connect(effectsBus);

    const cabinFilter = context.createBiquadFilter();
    cabinFilter.type = 'lowpass';
    cabinFilter.frequency.value = 310;
    const cabin = context.createGain();
    cabin.gain.value = this.pausedState ? 0 : 0.004;
    noise.connect(cabinFilter);
    cabinFilter.connect(cabin);
    cabin.connect(effectsBus);

    const oscillators = [fundamental, harmonic, sub];
    for (const oscillator of oscillators) oscillator.start();
    noise.start();

    return {
      context, compressor, master, musicBus, effectsBus, engine, engineFilter,
      hiss, hissFilter, cabin, oscillators, noise,
      nodes: [
        fundamental, harmonic, sub, fundamentalMix, harmonicMix, subMix,
        engineFilter, engine, noise, hissFilter, hiss, cabinFilter, cabin,
        musicBus, effectsBus, compressor, master,
      ],
    };
  }

  private playTransition(
    fromFrequency: number,
    toFrequency: number,
    durationSeconds: number,
    amplitude: number,
    waveform: OscillatorType,
  ): void {
    const graph = this.graph;
    if (!graph || this.pausedState || this.mutedState || this.mix.sfxVolume === 0 ||
      this.transientVoices.size >= MAXIMUM_TRANSIENT_VOICES) return;
    try {
      const time = graph.context.currentTime;
      const oscillator = graph.context.createOscillator();
      const gain = graph.context.createGain();
      oscillator.type = waveform;
      oscillator.frequency.setValueAtTime(fromFrequency, time);
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, toFrequency), time + durationSeconds);
      gain.gain.setValueAtTime(0.0001, time);
      gain.gain.linearRampToValueAtTime(amplitude, time + Math.min(0.038, durationSeconds * 0.2));
      gain.gain.exponentialRampToValueAtTime(0.0001, time + durationSeconds);
      oscillator.connect(gain);
      gain.connect(graph.effectsBus);
      this.transientVoices.add(oscillator);
      oscillator.onended = () => {
        this.transientVoices.delete(oscillator);
        oscillator.disconnect();
        gain.disconnect();
      };
      oscillator.start(time);
      oscillator.stop(time + durationSeconds + 0.025);
    } catch {
      // Missing optional automation primitives never silence the actual drive.
    }
  }

  private releaseGraph(): void {
    const graph = this.graph;
    if (!graph) return;
    for (const voice of this.transientVoices) {
      try { voice.stop(); } catch { /* A naturally ended voice is already silent. */ }
      try { voice.disconnect(); } catch { /* Disconnected voices are harmless. */ }
    }
    this.transientVoices.clear();
    for (const source of [...graph.oscillators, graph.noise]) {
      try { source.stop(); } catch { /* Closing twice must remain deterministic. */ }
    }
    for (const node of graph.nodes) {
      try { node.disconnect(); } catch { /* Some browsers disconnect descendants first. */ }
    }
    if (graph.context.state !== 'closed') {
      void graph.context.close().catch(() => {});
    }
    this.graph = undefined;
  }
}

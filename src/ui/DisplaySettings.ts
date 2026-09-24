import type { AudioMix } from '../audio/AudioSettings';
import type { GraphicsQuality, RenderQualityTier } from '../render/GraphicsQuality';
import type { NeonPhosphorMode } from '../render/post/NeonPhosphor';

export interface DisplaySettingsValues {
  graphicsQuality: GraphicsQuality;
  look: NeonPhosphorMode;
}

export interface DisplaySettingsState extends DisplaySettingsValues, AudioMix {
  effectiveQuality: RenderQualityTier;
  backend: string;
}

export interface DisplaySettingsOptions {
  readonly onApply: (values: DisplaySettingsValues) => string | undefined;
  readonly onAudioMixChange?: (values: AudioMix) => void;
  readonly onOpenChange?: (open: boolean) => void;
}

/** A presentation-only, native accessible dialog; the caller owns real rendering. */
export class DisplaySettings {
  readonly root: HTMLDialogElement;

  private readonly options: DisplaySettingsOptions;
  private readonly form: HTMLFormElement;
  private readonly applyButton: HTMLButtonElement;
  private readonly error: HTMLElement;
  private state: DisplaySettingsState | undefined;
  private previouslyFocused: HTMLElement | undefined;
  private disposed = false;

  constructor(parent: HTMLElement, options: DisplaySettingsOptions) {
    this.options = options;
    this.root = document.createElement('dialog');
    this.root.className = 'display-settings';
    this.root.dataset.displaySettings = '';
    this.root.setAttribute('aria-labelledby', 'display-settings-title');
    this.root.setAttribute('aria-describedby', 'display-settings-description');
    this.root.innerHTML = `
      <form class="display-settings-form">
        <header class="display-settings-header">
          <div><span class="display-settings-kicker">VESSEL CONFIGURATION</span><h2 id="display-settings-title">Settings</h2></div>
          <button class="display-settings-close" type="button" data-display-action="close" aria-label="Close settings">×</button>
        </header>
        <p class="display-settings-description" id="display-settings-description">Adjust graphics, presentation, and sound without changing your expedition.</p>

        <fieldset class="display-settings-section">
          <legend>Graphics quality</legend>
          <label class="display-settings-option"><input type="radio" name="graphics-quality" value="high" /><span><strong>High</strong><small>Up to 1,920 × 1,200 · 4× MSAA + SMAA</small></span></label>
          <label class="display-settings-option"><input type="radio" name="graphics-quality" value="low" /><span><strong>Low</strong><small>Up to 960 × 600 · native MSAA · reduced effects</small></span></label>
        </fieldset>

        <fieldset class="display-settings-section">
          <legend>Screen appearance</legend>
          <div class="display-settings-looks">
            <label class="display-settings-look"><input type="radio" name="display-look" value="authentic" /><span>Authentic</span></label>
            <label class="display-settings-look"><input type="radio" name="display-look" value="clean" /><span>Clean</span></label>
            <label class="display-settings-look"><input type="radio" name="display-look" value="subtle" /><span>Subtle</span></label>
            <label class="display-settings-look"><input type="radio" name="display-look" value="off" /><span>Off</span></label>
          </div>
          <p class="display-settings-look-note">Authentic preserves the expedition’s original neon-phosphor finish.</p>
        </fieldset>

        <fieldset class="display-settings-section display-settings-audio">
          <legend>Sound</legend>
          <label class="display-settings-volume" for="display-settings-music">
            <span>Music</span><output data-audio-volume="music" for="display-settings-music">85%</output>
          </label>
          <input class="display-settings-range" id="display-settings-music" type="range" name="music-volume" min="0" max="100" step="1" value="85" />
          <label class="display-settings-volume" for="display-settings-sfx">
            <span>Sound effects</span><output data-audio-volume="sfx" for="display-settings-sfx">60%</output>
          </label>
          <input class="display-settings-range" id="display-settings-sfx" type="range" name="sfx-volume" min="0" max="100" step="1" value="60" />
          <p class="display-settings-audio-note">Sound changes are saved immediately.</p>
        </fieldset>

        <p class="display-settings-backend" data-display="backend"></p>
        <p class="display-settings-compatibility" data-display="compatibility" role="status" hidden></p>
        <p class="display-settings-error" data-display="error" role="alert" hidden></p>

        <footer class="display-settings-footer">
          <button class="display-settings-cancel" type="button" data-display-action="cancel">Cancel</button>
          <button class="display-settings-apply" type="submit" data-display-action="apply">Apply</button>
        </footer>
      </form>
    `;
    this.form = this.root.querySelector<HTMLFormElement>('form')!;
    this.applyButton = this.root.querySelector<HTMLButtonElement>('[data-display-action="apply"]')!;
    this.error = this.root.querySelector<HTMLElement>('[data-display="error"]')!;
    this.root.addEventListener('keydown', this.onKeyDown);
    this.root.addEventListener('cancel', this.onCancel);
    this.root.addEventListener('click', this.onClick);
    this.form.addEventListener('input', this.onAudioInput);
    this.form.addEventListener('change', this.onChange);
    this.form.addEventListener('submit', this.onSubmit);
    parent.append(this.root);
  }

  get isOpen(): boolean {
    return this.root.open;
  }

  open(state: DisplaySettingsState): void {
    if (this.disposed) return;
    this.state = { ...state };
    this.previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
    const quality = this.root.querySelector<HTMLInputElement>(
      `input[name="graphics-quality"][value="${state.graphicsQuality}"]`,
    );
    const look = this.root.querySelector<HTMLInputElement>(
      `input[name="display-look"][value="${state.look}"]`,
    );
    if (quality) quality.checked = true;
    if (look) look.checked = true;
    this.setAudioMix(state);
    this.error.hidden = true;
    this.error.textContent = '';
    this.refresh();
    if (!this.root.open) {
      if (typeof this.root.showModal === 'function') this.root.showModal();
      else this.root.setAttribute('open', '');
      this.options.onOpenChange?.(true);
    }
    (quality ?? this.applyButton).focus({ preventScroll: true });
  }

  close(): void {
    if (!this.root.open) return;
    if (typeof this.root.close === 'function') this.root.close();
    else this.root.removeAttribute('open');
    this.options.onOpenChange?.(false);
    if (this.previouslyFocused?.isConnected) this.previouslyFocused.focus({ preventScroll: true });
    if (document.activeElement instanceof HTMLElement && this.root.contains(document.activeElement)) {
      document.activeElement.blur();
    }
    this.previouslyFocused = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.close();
    this.disposed = true;
    this.root.removeEventListener('keydown', this.onKeyDown);
    this.root.removeEventListener('cancel', this.onCancel);
    this.root.removeEventListener('click', this.onClick);
    this.form.removeEventListener('input', this.onAudioInput);
    this.form.removeEventListener('change', this.onChange);
    this.form.removeEventListener('submit', this.onSubmit);
    this.root.remove();
  }

  private values(): DisplaySettingsValues {
    return {
      graphicsQuality: this.root.querySelector<HTMLInputElement>(
        'input[name="graphics-quality"]:checked',
      )?.value as GraphicsQuality,
      look: this.root.querySelector<HTMLInputElement>(
        'input[name="display-look"]:checked',
      )?.value as NeonPhosphorMode,
    };
  }

  private refresh(): void {
    if (!this.state) return;
    const values = this.values();
    const backend = this.root.querySelector<HTMLElement>('[data-display="backend"]')!;
    const compatibility = this.root.querySelector<HTMLElement>('[data-display="compatibility"]')!;
    backend.textContent = `Active renderer: ${this.state.backend.toUpperCase()} · ${
      this.state.effectiveQuality === 'high' ? 'High' : 'Compatibility'
    } quality`;
    const limited = values.graphicsQuality === 'high' && (
      (this.state.graphicsQuality === 'high' && this.state.effectiveQuality === 'fallback') ||
      /webgl/i.test(this.state.backend)
    );
    compatibility.hidden = !limited;
    compatibility.textContent = limited
      ? `${this.state.backend.toUpperCase()} currently uses compatibility rendering even when High is selected.`
      : '';
    this.applyButton.textContent = values.graphicsQuality !== this.state.graphicsQuality
      ? 'Save and reload'
      : 'Apply';
  }

  private setAudioMix(mix: AudioMix): void {
    const music = Math.round(Math.max(0, Math.min(1, mix.musicVolume)) * 100);
    const effects = Math.round(Math.max(0, Math.min(1, mix.sfxVolume)) * 100);
    this.root.querySelector<HTMLInputElement>('input[name="music-volume"]')!.value = String(music);
    this.root.querySelector<HTMLInputElement>('input[name="sfx-volume"]')!.value = String(effects);
    this.root.querySelector<HTMLOutputElement>('[data-audio-volume="music"]')!.value = `${music}%`;
    this.root.querySelector<HTMLOutputElement>('[data-audio-volume="sfx"]')!.value = `${effects}%`;
  }

  private readonly onAudioInput = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.name !== 'music-volume' && target.name !== 'sfx-volume') return;
    const mix: AudioMix = {
      musicVolume: Number(this.root.querySelector<HTMLInputElement>('input[name="music-volume"]')!.value) / 100,
      sfxVolume: Number(this.root.querySelector<HTMLInputElement>('input[name="sfx-volume"]')!.value) / 100,
    };
    this.setAudioMix(mix);
    if (this.state) this.state = { ...this.state, ...mix };
    this.options.onAudioMixChange?.(mix);
  };

  private readonly onChange = (): void => {
    this.error.hidden = true;
    this.error.textContent = '';
    this.refresh();
  };

  private readonly onSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    if (!this.state) return;
    const error = this.options.onApply(this.values());
    if (error) {
      this.error.textContent = error;
      this.error.hidden = false;
      return;
    }
    this.close();
  };

  private readonly onCancel = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    this.close();
  };

  private readonly onClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (target === this.root || target.closest('[data-display-action="close"], [data-display-action="cancel"]')) {
      event.preventDefault();
      event.stopPropagation();
      this.close();
    }
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.root.open) return;
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
    }
  };
}

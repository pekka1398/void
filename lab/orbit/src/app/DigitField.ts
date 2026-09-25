/**
 * A fixed-width number whose digits are scrolled individually: the wheel
 * over a digit adds or subtracts that digit's place value, so one field
 * covers every scale without a step setting. Clicking turns it into a text
 * box for typing a value; Enter or leaving it commits, Escape cancels.
 */
export interface DigitFormat {
  /** Characters to show; each digit carries the place value it stands for. */
  render(value: number): { text: string; place: number | null }[];
  /** Typed text to a value, or null when it does not parse. */
  parse(text: string): number | null;
  /** Text offered for typing. */
  editText(value: number): string;
  /** Removes representation noise, e.g. 3120.0099999 from adding 0.01 steps. */
  normalize(value: number): number;
  min: number;
  max: number;
}

export class DigitField {
  readonly element: HTMLSpanElement;
  private readonly format: DigitFormat;
  private readonly onChange: (value: number) => void;
  private readonly input: HTMLInputElement;
  private readonly digits: HTMLSpanElement;
  private value = 0;
  private enabled = true;

  constructor(format: DigitFormat, onChange: (value: number) => void) {
    this.format = format;
    this.onChange = onChange;
    this.element = document.createElement('span');
    this.element.className = 'digits';
    this.digits = document.createElement('span');
    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.style.display = 'none';
    this.element.append(this.digits, this.input);
    this.element.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!this.enabled || this.editing) return;
      const place = Number((e.target as HTMLElement).dataset.place);
      if (!Number.isFinite(place)) return;
      this.commit(this.value + (e.deltaY < 0 ? place : -place));
    }, { passive: false });
    this.digits.addEventListener('click', () => {
      if (!this.enabled) return;
      this.input.value = this.format.editText(this.value);
      this.input.style.width = `${Math.max(8, this.input.value.length + 2)}ch`;
      this.digits.style.display = 'none';
      this.input.style.display = '';
      this.input.focus();
      this.input.select();
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.finishTyping(true);
      if (e.key === 'Escape') this.finishTyping(false);
    });
    this.input.addEventListener('blur', () => this.finishTyping(true));
  }

  private finishTyping(accept: boolean): void {
    if (this.input.style.display === 'none') return;
    const parsed = accept ? this.format.parse(this.input.value.trim()) : null;
    this.input.style.display = 'none';
    this.digits.style.display = '';
    if (document.activeElement === this.input) this.input.blur();
    // Text that does not parse is a typing slip: keep the old value.
    if (parsed !== null) this.commit(parsed);
  }

  get editing(): boolean {
    return this.input.style.display !== 'none';
  }

  /** Show a value from outside; ignored while the user is typing. */
  set(value: number): void {
    if (!Number.isFinite(value)) throw new RangeError(`DigitField.set(${value})`);
    if (this.editing) return;
    this.value = value;
    const parts = this.format.render(value);
    const children = this.digits.children;
    const sameShape = children.length === parts.length
      && parts.every((p, i) => (children[i]!.tagName === 'B') === (p.place !== null));
    if (!sameShape) {
      this.digits.innerHTML = parts.map((p) => (p.place === null ? `<i>${p.text}</i>` : `<b data-place="${p.place}">${p.text}</b>`)).join('');
      return;
    }
    // Update in place so the digit under the mouse keeps its element and hover.
    parts.forEach((p, i) => {
      const child = children[i] as HTMLElement;
      if (child.textContent !== p.text) child.textContent = p.text;
      if (p.place !== null && child.dataset.place !== String(p.place)) child.dataset.place = String(p.place);
    });
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.element.classList.toggle('disabled', !enabled);
  }

  private commit(value: number): void {
    const clamped = this.format.normalize(Math.min(this.format.max, Math.max(this.format.min, value)));
    this.set(clamped);
    this.onChange(clamped);
  }
}

const DAY = 86_400;

/**
 * ddd hh:mm:ss; each unit is one scroll target. Typed text: "2d 3:04:05", "3:04:05",
 * "4:05", or a number with a unit: "2.5d", "3h", "10m", "30s".
 */
export function durationFormat(min: number, max: number): DigitFormat {
  return {
    min, max,
    normalize: (value) => value,
    render(value) {
      const s = Math.round(value);
      const d = Math.floor(s / DAY);
      const h = Math.floor((s % DAY) / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = s % 60;
      // One scroll target per unit: the wheel steps a whole day, hour, minute or second.
      return [
        { text: String(d).padStart(3, '0'), place: DAY }, { text: 'd ', place: null },
        { text: String(h).padStart(2, '0'), place: 3600 }, { text: ':', place: null },
        { text: String(m).padStart(2, '0'), place: 60 }, { text: ':', place: null },
        { text: String(sec).padStart(2, '0'), place: 1 },
      ];
    },
    parse(text) {
      const unit = /^(\d+(?:\.\d+)?)\s*([dhms])$/i.exec(text);
      if (unit) {
        const scale = { d: DAY, h: 3600, m: 60, s: 1 }[unit[2]!.toLowerCase() as 'd' | 'h' | 'm' | 's'];
        return Number(unit[1]) * scale;
      }
      const clock = /^(?:(\d+)\s*d\s*)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/i.exec(text);
      if (!clock) return null;
      return Number(clock[1] ?? 0) * DAY + Number(clock[2] ?? 0) * 3600 + Number(clock[3]) * 60 + Number(clock[4]);
    },
    editText(value) {
      const s = Math.round(value);
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${Math.floor(s / DAY)}d ${pad(Math.floor((s % DAY) / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
    },
  };
}

/**
 * Speed shown as km/s with two scroll targets, e.g. +3.120: the wheel over
 * the whole kilometres steps 1 km/s, over the metres 1 m/s. A typed fraction
 * of a metre per second follows as further km/s decimals, not scrollable. Typed text is m/s
 * unless it ends in km/s: "3120", "3120.45 m/s", "3.12 km/s".
 */
export function speedFormat(maxMetersPerSecond: number): DigitFormat {
  return {
    min: -maxMetersPerSecond, max: maxMetersPerSecond,
    normalize: (value) => Number(value.toFixed(2)),
    render(value) {
      const v = Math.abs(Number(value.toFixed(2)));
      const km = Math.floor(v / 1000);
      const meters = Number((v - km * 1000).toFixed(2));
      const whole = Math.floor(meters);
      // Hundredths of m/s continue the km/s decimals: 3.120 then 45 reads 3.12045 km/s.
      const fraction = (meters - whole).toFixed(2).slice(2).replace(/0$/, '').replace(/^0$/, '');
      const parts: { text: string; place: number | null }[] = [
        { text: value < 0 ? '−' : '+', place: null },
        { text: String(km), place: 1000 }, { text: '.', place: null },
        { text: String(whole).padStart(3, '0'), place: 1 },
      ];
      if (fraction !== '') parts.push({ text: fraction, place: null });
      return parts;
    },
    parse(text) {
      const match = /^([+\-−]?\d+(?:\.\d+)?)\s*(km\/s|m\/s)?$/i.exec(text);
      if (!match) return null;
      const number = Number(match[1]!.replace('−', '-'));
      return match[2]?.toLowerCase() === 'km/s' ? number * 1000 : number;
    },
    editText(value) {
      return `${Number(value.toFixed(2))} m/s`;
    },
  };
}

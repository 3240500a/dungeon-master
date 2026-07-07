import type { App } from '../../core/app.js';

/**
 * Звуковые заглушки на WebAudio (без ассетов): короткие бипы на игровые события.
 * Подписан на шину, поэтому не связан с конкретными сценами. Тихий по умолчанию.
 * Позже заменяется на реальные сэмплы.
 */
export class SfxController {
  private ctx: AudioContext | null = null;

  constructor(app: App) {
    if (typeof window === 'undefined' || !('AudioContext' in window)) return;
    // Инициализация звука по первому жесту (политика автоплей браузеров).
    const resume = () => {
      this.ctx ??= new AudioContext();
      void this.ctx.resume();
    };
    window.addEventListener('pointerdown', resume, { once: false });

    app.bus.on('monster:died', () => this.beep(160, 0.09, 'square'));
    app.bus.on('player:damaged', () => this.beep(110, 0.08, 'sawtooth'));
    app.bus.on('item:picked', () => this.beep(880, 0.06, 'triangle'));
    app.bus.on('gold:changed', () => this.beep(660, 0.03, 'sine', 0.02));
    app.bus.on('player:levelup', () => this.chime([523, 659, 784]));
  }

  private beep(freq: number, dur: number, type: OscillatorType, gainMax = 0.05): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(gainMax, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + dur);
  }

  private chime(freqs: number[]): void {
    freqs.forEach((f, i) => setTimeout(() => this.beep(f, 0.14, 'sine', 0.06), i * 90));
  }
}

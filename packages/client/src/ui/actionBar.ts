import type { App } from '../core/app.js';
import { buildBindBar } from './bindBar.js';

/**
 * HUD-панель биндов (D2): крупные ЛКМ/ПКМ + 3 доп.слота внизу по центру. Живёт вместе
 * с UIScene (только в городе/подземелье). rAF обновляет оверлеи кулдаунов из сессии.
 */
export class ActionBar {
  private root: HTMLDivElement;
  private bar: ReturnType<typeof buildBindBar>;
  private raf = 0;
  private unsub: () => void;

  constructor(app: App, parent: HTMLElement) {
    this.root = document.createElement('div');
    // pointer-events:none у контейнера — клики мимо слотов проходят на игру; сами
    // слоты (pointer-events:auto) кликабельны и не бьют сквозь себя.
    this.root.style.cssText =
      'position:fixed;left:50%;bottom:12px;transform:translateX(-50%);z-index:45;pointer-events:none';
    this.bar = buildBindBar(app);
    this.root.append(this.bar.el);
    parent.append(this.root);
    this.unsub = app.bus.on('state:changed', () => this.bar.rebuild());
    const loop = (): void => { this.bar.refresh(); this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.unsub();
    this.root.remove();
  }
}

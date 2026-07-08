import type { App } from '../core/app.js';
import { beltCapacity, syncBeltLength } from '../modules/consumables/index.js';

/** Пьёт зелье из слота пояса i через сервер (авторитетно). */
function drinkBelt(app: App, i: number): boolean {
  const item = app.state?.save.belt[i];
  if (!item) return false;
  app.sendCmd({ cmd: 'useConsumable', uid: item.uid });
  return true;
}

const POTION_GLYPH = '🧪';

/**
 * HUD-пояс расходников (D2): N быстрых слотов слева внизу по ёмкости надетого пояса.
 * Клавиши 1-4 или клик по слоту — выпить; счётчик показывает, сколько таких зелий
 * в наличии. Пустой слот пополняется автоматически при использовании (см. consumables).
 */
export class BeltBar {
  private root: HTMLDivElement;
  private unsub: () => void;
  private onKey: (e: KeyboardEvent) => void;

  constructor(app: App, parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.style.cssText =
      'position:fixed;left:12px;bottom:12px;z-index:45;display:flex;gap:8px;pointer-events:auto';
    parent.append(this.root);

    const rebuild = (): void => this.render(app);
    rebuild();
    this.unsub = app.bus.on('state:changed', rebuild);

    this.onKey = (e: KeyboardEvent): void => {
      if (e.repeat) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const n = ['Digit1', 'Digit2', 'Digit3', 'Digit4'].indexOf(e.code);
      if (n < 0 || n >= beltCapacity(app)) return;
      if (drinkBelt(app, n)) e.preventDefault();
    };
    window.addEventListener('keydown', this.onKey);
  }

  private render(app: App): void {
    this.root.innerHTML = '';
    const state = app.state;
    if (!state) return;
    syncBeltLength(app);
    const cap = beltCapacity(app);
    for (let i = 0; i < cap; i++) {
      const item = state.save.belt[i];
      const box = document.createElement('div');
      box.style.cssText =
        `position:relative;width:52px;height:52px;border-radius:10px;background:#0f131a;` +
        `border:2px solid ${item ? '#8aa84a' : '#3e4756'};display:flex;align-items:center;` +
        `justify-content:center;font-size:24px;cursor:pointer;user-select:none`;
      box.textContent = item ? POTION_GLYPH : '';
      box.title = item ? `${item.name} — клавиша ${i + 1}` : `Пустой слот пояса (${i + 1})`;

      const key = document.createElement('div');
      key.style.cssText = 'position:absolute;left:3px;top:1px;font-size:11px;color:#8f897c';
      key.textContent = String(i + 1);
      box.append(key);

      if (item) {
        const count = state.save.inventory.filter((it) => it.baseId === item.baseId).length + 1;
        const c = document.createElement('div');
        c.style.cssText = 'position:absolute;right:4px;bottom:2px;font-size:12px;color:#e6ddc9;text-shadow:0 0 3px #000';
        c.textContent = String(count);
        box.append(c);
      }

      box.addEventListener('click', (e) => { e.stopPropagation(); drinkBelt(app, i); });
      this.root.append(box);
    }
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKey);
    this.unsub();
    this.root.remove();
  }
}

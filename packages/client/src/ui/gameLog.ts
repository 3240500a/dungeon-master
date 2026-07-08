import type { LogKind } from '@dm/shared';
import type { App } from '../core/app.js';

const KIND_COLOR: Record<LogKind, string> = {
  'dmg-out': '#e6ddc9',
  'dmg-in': '#c85a48',
  kill: '#dca94b',
  xp: '#8aa84a',
  gold: '#dca94b',
  loot: '#7fa8d0',
  system: '#8f897c',
};

const MAX_LINES = 200;

/**
 * Игровой лог/чат (системные сообщения): урон нанесён/получен, убийства, опыт, золото,
 * лут. DOM-панель снизу-слева со скроллом — копит историю, авто-прокрутка вниз, если
 * пользователь не отлистал вверх. Слушает `log:message` на шине.
 */
export class GameLog {
  private box: HTMLDivElement;

  constructor(app: App, root: HTMLElement) {
    this.box = document.createElement('div');
    this.box.style.cssText =
      'position:fixed;left:12px;bottom:30px;width:360px;height:168px;overflow-y:auto;' +
      'background:rgba(14,17,23,0.6);border:0.5px solid #2b323f;border-radius:8px;' +
      'padding:6px 9px;font-size:12px;line-height:1.45;z-index:40;' +
      'font-family:system-ui,sans-serif;color:#d8d0bf;scrollbar-width:thin;pointer-events:auto';
    root.appendChild(this.box);
    app.bus.on('log:message', ({ text, kind }) => this.push(text, kind));
  }

  private push(text: string, kind: LogKind): void {
    const nearBottom = this.box.scrollHeight - this.box.scrollTop - this.box.clientHeight < 40;
    const line = document.createElement('div');
    line.style.color = KIND_COLOR[kind];
    line.textContent = text;
    this.box.appendChild(line);
    while (this.box.childElementCount > MAX_LINES) this.box.firstElementChild!.remove();
    if (nearBottom) this.box.scrollTop = this.box.scrollHeight;
  }
}

import type { App } from '../core/app.js';
import { hideTooltip } from './kit.js';

/** Панель — самодостаточный кусок UI, рисующий себя в переданный контейнер. */
export interface Panel {
  title: string;
  render(body: HTMLElement): void;
  dispose?(): void;
}

export type PanelFactory = (app: App, ui: DomUi) => Panel;

interface OpenWindow {
  win: HTMLElement;
  body: HTMLElement;
  titleEl: HTMLElement;
  panel: Panel;
}

/**
 * ⭐ R4-36: ПОЛОСА `z-index` ОКОН — [Z_BASE, Z_MAX]. Выше неё живут голосование (88), экраны входа — плашка, лобби,
 * «Продолжить» (90) — и окно смерти (96). Раньше каждый клик в окне поднимал его на единицу без потолка: три десятка
 * кликов по инвентарю — и окно поверх лобби, с живыми кнопками в сессию, которой нет. Кончилась полоса — открытые окна
 * нумеруются заново снизу, порядок тот же.
 */
const Z_BASE = 60;
const Z_MAX = 80;

/**
 * ⭐ R7-11: ОКНА ОБЪЕКТОВ ГОРОДА — лавка, кузница, мастер прокачки, сундук, алтарь забега. Открываются только подходом к
 * объекту в городе ([E]; горячих клавиш у них нет), а команды лавки, кузницы и сундука сервер исполняет только в городе
 * (`server/net/guard.ts`). Хост повёл пати в подземелье (или на арену), пока у кого-то была открыта кузница, — окно жило
 * в подземелье, и каждый его клик получал «Это доступно только в городе» и шёл в телеметрию чита
 * (`dm_cmd_out_of_place_total`), которую честный клиент зажигать не должен. Уход из города (`area:entered`) их закрывает;
 * окна горячих клавиш (инвентарь, скилы, персонаж, квесты, карта забега) работают везде и остаются.
 */
export const TOWN_PANELS: readonly string[] = ['shop', 'forge', 'master', 'stash', 'difficulty'];

/**
 * Менеджер НЕСКОЛЬКИХ плавающих окон поверх canvas (не модальных): инвентарь,
 * скиллы, магазин и т.п. можно держать открытыми одновременно, перетаскивать за
 * заголовок, закрывать независимо. Игра под окнами не блокируется. Открытые окна
 * перерисовываются на `state:changed`/`gold:changed`.
 */
export class DomUi {
  private app: App;
  private root: HTMLElement;
  private factories = new Map<string, PanelFactory>();
  private open = new Map<string, OpenWindow>();
  private zTop = Z_BASE;
  private cascade = 0;

  constructor(app: App, root: HTMLElement) {
    this.app = app;
    this.root = root;
    this.bindKeys();
    // ⭐ R6-25: вне мира (экраны входа, вход в аккаунт, выбор героя) окно не открывается — [E] у NPC под лобби открывал
    // кузницу под экраном входа с кнопками в сессию, которой нет.
    app.bus.on('ui:open', (p) => { if (app.inWorld) this.toggle(p.panel); });
    app.bus.on('ui:closeAll', () => this.closeAll());   // R4-36: связь потеряна — окна прошлой сессии прочь
    app.bus.on('area:entered', (p) => { if (p.area !== 'town') for (const name of TOWN_PANELS) this.close(name); });   // R7-11
    app.bus.on('state:changed', () => this.refresh());
    app.bus.on('gold:changed', () => this.refresh());
  }

  register(name: string, factory: PanelFactory): void {
    this.factories.set(name, factory);
  }

  isOpen(name?: string): boolean {
    return name ? this.open.has(name) : this.open.size > 0;
  }

  toggle(name: string): void {
    if (this.open.has(name)) this.close(name);
    else this.openPanel(name);
  }

  openPanel(name: string): void {
    if (this.open.has(name)) {
      this.bringToFront(this.open.get(name)!.win);
      return;
    }
    const factory = this.factories.get(name);
    if (!factory) return;
    const panel = factory(this.app, this);
    const { win, body, titleEl } = this.buildWindow(name, panel.title);
    this.root.appendChild(win);
    const entry: OpenWindow = { win, body, titleEl, panel };
    this.open.set(name, entry);
    this.renderInto(entry);
    this.bringToFront(win);
  }

  close(name: string): void {
    const entry = this.open.get(name);
    if (!entry) return;
    hideTooltip(); // чтобы всплывашка не зависла, если курсор был над строкой окна
    entry.panel.dispose?.();
    entry.win.remove();
    this.open.delete(name);
  }

  closeAll(): void {
    for (const name of [...this.open.keys()]) this.close(name);
  }

  /** Перерисовывает тело всех открытых окон (после изменения состояния). */
  refresh(): void {
    for (const entry of this.open.values()) {
      entry.titleEl.textContent = entry.panel.title;
      this.renderInto(entry);
    }
  }

  private renderInto(entry: OpenWindow): void {
    hideTooltip(); // старый якорь исчезнет при перерисовке — подсказку прячем
    entry.body.innerHTML = '';
    entry.panel.render(entry.body);
  }

  private buildWindow(name: string, title: string): OpenWindow & { win: HTMLElement } {
    const win = document.createElement('div');
    Object.assign(win.style, {
      position: 'absolute',
      left: `${40 + (this.cascade % 6) * 36}px`,
      top: `${48 + (this.cascade % 6) * 36}px`,
      minWidth: '360px',
      maxWidth: '900px', // вмещает сундук 20 клеток × CELL(40) ≈ 885px без гориз. скролла
      maxHeight: '84vh',
      display: 'flex',
      flexDirection: 'column',
      background: '#171b24',
      border: '1px solid #2b323f',
      borderRadius: '10px',
      color: '#e6ddc9',
      boxShadow: '0 12px 40px rgba(0,0,0,0.55)',
      pointerEvents: 'auto',
    } satisfies Partial<CSSStyleDeclaration>);
    this.cascade++;
    win.dataset.dmwindow = '1';
    win.addEventListener('pointerdown', () => this.bringToFront(win));

    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '10px 14px',
      borderBottom: '1px solid #2b323f',
      cursor: 'move',
      userSelect: 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    const titleEl = document.createElement('strong');
    titleEl.textContent = title;
    const close = document.createElement('button');
    close.textContent = '✕';
    Object.assign(close.style, {
      background: 'transparent',
      color: '#c4bca8',
      border: 'none',
      cursor: 'pointer',
      fontSize: '18px',
    } satisfies Partial<CSSStyleDeclaration>);
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      this.close(name);
    });
    header.append(titleEl, close);
    this.makeDraggable(win, header);

    const body = document.createElement('div');
    body.style.padding = '14px';
    body.style.overflow = 'auto';

    win.append(header, body);
    return { win, body, titleEl, panel: null as unknown as Panel };
  }

  private makeDraggable(win: HTMLElement, handle: HTMLElement): void {
    let dragging = false;
    let ox = 0;
    let oy = 0;
    handle.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;
      dragging = true;
      ox = e.clientX - win.offsetLeft;
      oy = e.clientY - win.offsetTop;
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      win.style.left = `${Math.max(0, e.clientX - ox)}px`;
      win.style.top = `${Math.max(0, e.clientY - oy)}px`;
    });
    const stop = (e: PointerEvent) => {
      dragging = false;
      try { handle.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    };
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  }

  private bringToFront(win: HTMLElement): void {
    if (win.style.zIndex === String(this.zTop)) return;   // уже сверху — клик внутри окна полосу не тратит
    if (this.zTop >= Z_MAX) {
      // R4-36: полоса кончилась — прочие открытые окна снизу по порядку, нажатое — над ними.
      const rest = [...this.open.values()].map((e) => e.win).filter((w) => w !== win)
        .sort((a, b) => Number(a.style.zIndex) - Number(b.style.zIndex));
      this.zTop = Z_BASE;
      for (const w of rest) w.style.zIndex = String(++this.zTop);
    }
    win.style.zIndex = String(++this.zTop);
  }

  private bindKeys(): void {
    const map: Record<string, string> = {
      KeyI: 'inventory',
      KeyK: 'skills',
      KeyC: 'character',
      KeyJ: 'quests',
      KeyM: 'runmap',
    };
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') {
        // Esc закрывает последнее открытое окно.
        const last = [...this.open.keys()].pop();
        if (last) this.close(last);
        return;
      }
      const panel = map[e.code];
      // R6-25: хоткеи окон — только в мире (Esc выше закрывает и вне его).
      if (panel && this.factories.has(panel) && this.app.inWorld) {
        // Не перехватываем, если фокус в поле ввода (редактор и т.п.).
        const t = e.target as HTMLElement;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
        e.preventDefault();
        this.toggle(panel);
      }
    });
  }
}

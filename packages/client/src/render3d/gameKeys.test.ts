import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gameKeyDown, gameKeyUp } from './gameKeys.js';
import { mountSettings } from './settings3d.js';

/**
 * ⭐ R11-16: ГАЛКА И ПОЛЗУНОК НАСТРОЕК (⚙) В ФОКУСЕ — НЕ ПОЛЕ ВВОДА. Игрок в подземелье открыл ⚙, щёлкнул «Тени от факелов» или
 * потянул ползунок разрешения и вернулся в бой, не кликнув по канвасу: элемент остался в фокусе, а клавиши игры веб-3D отсекали
 * ЛЮБОЙ `<input>` как набор текста — WASD не доходили (герой стоял), пробел не отменялся и переключал галку посреди боя вместо
 * рывка. Отсекать надо только НАБОР (`isTextEntry`: текст, пароль, поиск…) — ник, пароль и имя героя по-прежнему не игра.
 *
 * DOM-окружения в проекте нет (тесты идут в node) — заглушка ровно того, чем пользуется панель настроек; браузер — модель: пробел
 * на галке в фокусе жмёт её, если нажатие не отменено (Chromium — по `keydown`, Firefox — по `keyup`: отменять нужно оба).
 */
class El {
  children: El[] = []; style: Record<string, string> = {}; textContent = ''; title = '';
  type = ''; checked = false; value = ''; min = ''; max = ''; step = ''; disabled = false;
  private on = new Map<string, (() => void)[]>();
  readonly tagName: string;
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  append(...c: El[]): void { this.children.push(...c); }
  appendChild(c: El): El { this.children.push(c); return c; }
  addEventListener(t: string, f: () => void): void { this.on.set(t, [...(this.on.get(t) ?? []), f]); }
  fire(t: string): void { for (const f of this.on.get(t) ?? []) f(); }
  all(): El[] { return this.children.flatMap((c) => [c, ...c.all()]); }
}

const G = globalThis as unknown as { document?: unknown };
const store = new Map<string, string>();
let torch: boolean[];
beforeEach(() => {
  store.clear(); torch = [];
  G.document = { createElement: (t: string) => new El(t), createTextNode: (s: string) => Object.assign(new El('#text'), { textContent: s }) };
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
});
afterEach(() => { vi.unstubAllGlobals(); delete G.document; });

/** Настоящая панель ⚙ веб-3D: её галки, ползунок разрешения и список разрешения теней. */
function settings() {
  const root = new El('div');
  mountSettings(root as unknown as HTMLElement, { onTorchShadows: (on) => torch.push(on) });
  const inputs = root.all().filter((e) => e.tagName === 'INPUT');
  const checkboxes = inputs.filter((e) => e.type === 'checkbox');
  const torchRow = root.all().find((e) => e.tagName === 'LABEL' && e.children.some((c) => c.textContent.startsWith('Тени от факелов')))!;
  const torchCb = torchRow.children.find((c) => c.tagName === 'INPUT' && c.type === 'checkbox')!;
  return { checkboxes, torchCb, slider: inputs.find((e) => e.type === 'range')!, select: root.all().find((e) => e.tagName === 'SELECT')! };
}

type Ev = { code: string; defaultPrevented: boolean; preventDefault(): void };
const ev = (code: string): Ev => { const e: Ev = { code, defaultPrevented: false, preventDefault: () => { e.defaultPrevented = true; } }; return e; };
/** Нажать и отпустить клавишу, пока в фокусе `focus` (`null` — канвас/тело страницы). Браузер жмёт галку пробелом, если не отменили. */
function tap(keys: Set<string>, code: string, focus: El | null, hold = false): { down: Ev; up: Ev | null; held: boolean } {
  const down = ev(code);
  gameKeyDown(down as unknown as KeyboardEvent, focus as unknown as Element, keys);
  const held = keys.has(code);
  if (hold) return { down, up: null, held };
  const up = ev(code);
  gameKeyUp(up as unknown as KeyboardEvent, focus as unknown as Element, keys);
  if (code === 'Space' && focus?.type === 'checkbox' && !(down.defaultPrevented && up.defaultPrevented)) { focus.checked = !focus.checked; focus.fire('change'); }
  return { down, up, held };
}

describe('⭐ R11-16: клавиши игры веб-3D при галке или ползунке настроек в фокусе', () => {
  it('⭐ галка «Тени от факелов» в фокусе: WASD — игре, пробел — рывок, а не переключение галки', () => {
    const { torchCb: cb } = settings();
    const keys = new Set<string>();
    for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) tap(keys, code, cb, true);
    expect([...keys], 'было: ни одной — герой стоял').toEqual(['KeyW', 'KeyA', 'KeyS', 'KeyD']);
    const was = cb.checked;
    const { down, up, held } = tap(keys, 'Space', cb);
    expect(held, 'пробел дошёл до игры (рывок)').toBe(true);
    expect([down.defaultPrevented, up!.defaultPrevented], 'было: пробел не отменялся').toEqual([true, true]);
    expect(cb.checked, 'было: галка переключалась посреди боя').toBe(was);
    expect(torch, 'тени от факелов не трогали').toEqual([]);
    expect(store.size, 'настройки не записаны').toBe(0);
  });

  it('любая галка панели (и «Разрешение: авто») в фокусе: пробел — рывок, галка на месте', () => {
    const { checkboxes } = settings();
    expect(checkboxes.length).toBeGreaterThanOrEqual(9);   // 8 строк + «Разрешение: авто»
    for (const cb of checkboxes) {
      const keys = new Set<string>();
      const was = cb.checked;
      expect(tap(keys, 'Space', cb).held).toBe(true);
      expect(cb.checked).toBe(was);
    }
    expect(store.size).toBe(0);
  });

  it('ползунок разрешения и список теней в фокусе — клавиши игре', () => {
    const { slider, select } = settings();
    for (const focus of [slider, select]) {
      const keys = new Set<string>();
      tap(keys, 'KeyD', focus, true);
      tap(keys, 'ShiftLeft', focus, true);
      expect([...keys], focus.tagName).toEqual(['KeyD', 'ShiftLeft']);
    }
  });

  it('набор в поле (ник, пароль, имя героя) — не игра: клавиша не зажата и не отменена (пробел печатается)', () => {
    const keys = new Set<string>();
    for (const type of ['text', 'password', '']) {
      const field = Object.assign(new El('input'), { type });
      const { down, up } = tap(keys, 'Space', field);
      tap(keys, 'KeyW', field, true);
      expect(keys.size, type).toBe(0);
      expect([down.defaultPrevented, up!.defaultPrevented], type).toEqual([false, false]);
    }
    const area = new El('textarea');
    tap(keys, 'KeyA', area, true);
    expect(keys.size).toBe(0);
  });

  it('отпускание — всегда: зажатая в игре клавиша, отпущенная уже в поле, не залипает', () => {
    const keys = new Set<string>();
    tap(keys, 'KeyW', null, true);
    expect(keys.has('KeyW')).toBe(true);
    gameKeyUp(ev('KeyW') as unknown as KeyboardEvent, Object.assign(new El('input'), { type: 'text' }) as unknown as Element, keys);
    expect(keys.has('KeyW')).toBe(false);
  });

  it('вне полей как было: Tab и Alt отменены (фокус не уходит, меню окна не открывается), буквы — нет', () => {
    const keys = new Set<string>();
    for (const code of ['Tab', 'AltLeft', 'AltRight', 'Space']) expect(tap(keys, code, null, true).down.defaultPrevented, code).toBe(true);
    expect(tap(keys, 'KeyQ', null, true).down.defaultPrevented).toBe(false);
  });

  it('веб-3D слушает клавиши игры этими обработчиками (своей проверки «любой input — поле» нет)', () => {
    const HERE = dirname(fileURLToPath(import.meta.url));
    const SRC = readFileSync(join(HERE, 'online3d.ts'), 'utf8');
    expect(SRC).toMatch(/addEventListener\('keydown', \(e\) => gameKeyDown\(e, document\.activeElement, keys\)\);/);
    expect(SRC).toMatch(/addEventListener\('keyup', \(e\) => gameKeyUp\(e, document\.activeElement, keys\)\);/);
    expect(SRC, 'было: `t instanceof HTMLInputElement` — любой input').not.toMatch(/instanceof HTMLInputElement|tagName === 'INPUT'/);
    // Те же клавиши страницы (F3 отладки, пояс 1–4, хоткеи окон) — то же правило «поля».
    for (const f of ['debug3d.ts', join('..', 'ui', 'beltBar.ts'), join('..', 'ui', 'domUi.ts')]) {
      const s = readFileSync(join(HERE, f), 'utf8');
      expect(s, `${f}: «поле» решает isTextEntry`).not.toMatch(/instanceof HTMLInputElement|tagName === 'INPUT'/);
      expect(s, f).toMatch(/isTextEntry\(/);
    }
  });
});

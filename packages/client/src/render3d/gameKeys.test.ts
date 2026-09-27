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
 * на галке в фокусе жмёт её, если нажатие не отменено (Chromium — по `keydown`, Firefox — по `keyup`: отменять нужно оба);
 * стрелки листают ползунок и закрытый список, цифра/буква — поиск по началу пункта списка (`browserKey`, R12-15).
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
let resScale: number[];
let shadowRes: number[];
beforeEach(() => {
  store.clear(); torch = []; resScale = []; shadowRes = [];
  G.document = { createElement: (t: string) => new El(t), createTextNode: (s: string) => Object.assign(new El('#text'), { textContent: s }) };
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
});
afterEach(() => { vi.unstubAllGlobals(); delete G.document; });

/** Настоящая панель ⚙ веб-3D: её галки, ползунок разрешения и список разрешения теней. */
function settings() {
  const root = new El('div');
  mountSettings(root as unknown as HTMLElement, {
    onTorchShadows: (on) => torch.push(on), onResScale: (v) => resScale.push(v), onShadowRes: (px) => shadowRes.push(px),
  });
  const inputs = root.all().filter((e) => e.tagName === 'INPUT');
  const checkboxes = inputs.filter((e) => e.type === 'checkbox');
  const torchRow = root.all().find((e) => e.tagName === 'LABEL' && e.children.some((c) => c.textContent.startsWith('Тени от факелов')))!;
  const torchCb = torchRow.children.find((c) => c.tagName === 'INPUT' && c.type === 'checkbox')!;
  return { checkboxes, torchCb, slider: inputs.find((e) => e.type === 'range')!, select: root.all().find((e) => e.tagName === 'SELECT')! };
}

type Ev = { code: string; defaultPrevented: boolean; preventDefault(): void };
const ev = (code: string): Ev => { const e: Ev = { code, defaultPrevented: false, preventDefault: () => { e.defaultPrevented = true; } }; return e; };
/**
 * Действие браузера по НЕОТМЕНЁННОМУ нажатию на элементе в фокусе (Chromium, Windows): стрелки листают ползунок и закрытый
 * `<select>`, цифра или буква — поиск по началу пункта списка (раскладка — латиница, как `code`). Значение сменилось — `input`/`change`.
 */
function browserKey(focus: El | null, code: string): void {
  if (!focus || focus.disabled) return;
  const dir = code === 'ArrowUp' || code === 'ArrowRight' ? 1 : code === 'ArrowDown' || code === 'ArrowLeft' ? -1 : 0;
  if (focus.tagName === 'INPUT' && focus.type === 'range') {
    const v = Math.min(Number(focus.max), Math.max(Number(focus.min), Number(focus.value) + dir * Number(focus.step)));
    if (!dir || String(v) === focus.value) return;
    focus.value = String(v); focus.fire('input'); focus.fire('change');
  }
  if (focus.tagName === 'SELECT') {
    const opts = focus.children.filter((c) => c.tagName === 'OPTION');
    const i = opts.findIndex((o) => o.value === focus.value);
    const ch = /^(?:Digit|Key)(.)$/.exec(code)?.[1]?.toLowerCase();
    const after = [...opts.slice(i + 1), ...opts.slice(0, i + 1)];   // поиск — со следующего пункта по кругу
    const j = dir ? Math.min(opts.length - 1, Math.max(0, i - dir))    // ↓/→ — следующий пункт, ↑/← — предыдущий
      : ch ? opts.indexOf(after.find((o) => o.textContent.toLowerCase().startsWith(ch)) ?? opts[i]!) : i;
    if (j === i) return;
    focus.value = opts[j]!.value; focus.fire('change');
  }
}

/** Нажать и отпустить клавишу, пока в фокусе `focus` (`null` — канвас/тело страницы). Браузер жмёт галку пробелом, если не отменили. */
function tap(keys: Set<string>, code: string, focus: El | null, hold = false): { down: Ev; up: Ev | null; held: boolean } {
  const down = ev(code);
  gameKeyDown(down as unknown as KeyboardEvent, focus as unknown as Element, keys);
  if (!down.defaultPrevented) browserKey(focus, code);
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

  /** ⚙ с ручным разрешением (галка «Разрешение: авто» снята — ползунок доступен): так игрок его и тянет. */
  const MANUAL = JSON.stringify({ resAuto: false, resScale: 1, shadowRes: 1024 });
  const ARROWS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

  it('⭐ R12-15: ползунок разрешения в фокусе — стрелки ведут героя и не листают разрешение посреди боя', () => {
    store.set('dm3d_settings', MANUAL);
    const { slider } = settings();
    expect(slider.disabled).toBe(false);
    const was = slider.value;
    for (const code of ARROWS) {
      const keys = new Set<string>();
      for (let rep = 0; rep < 3; rep++) {   // зажатая стрелка — повторы keydown
        const { down, held } = tap(keys, code, slider, true);
        expect(held, `${code}: герой идёт`).toBe(true);
        expect(down.defaultPrevented, `${code}: было — не отменялась`).toBe(true);
      }
      gameKeyUp(ev(code) as unknown as KeyboardEvent, slider as unknown as Element, keys);
    }
    expect(slider.value, 'было: каждая стрелка — шаг ползунка').toBe(was);
    expect(resScale, 'было: onResScale → setPixelRatio посреди боя').toEqual([]);
    expect(store.get('dm3d_settings'), 'настройки не перезаписаны').toBe(MANUAL);
    // Модель живая: неотменённая стрелка ползунок листает — ровно то, что было.
    browserKey(slider, 'ArrowUp');
    expect(slider.value).not.toBe(was);
  });

  it('⭐ R12-15: список «Разрешение теней» в фокусе — стрелки и пояс 1–4 (пустой слот) не меняют тени', () => {
    store.set('dm3d_settings', MANUAL);
    const { select } = settings();
    const was = select.value;
    for (const code of [...ARROWS, 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE']) {
      const keys = new Set<string>();
      const { down, held } = tap(keys, code, select);
      expect(held, code).toBe(true);
      expect(down.defaultPrevented, `${code}: было — не отменялась`).toBe(true);
    }
    expect(select.value, 'было: ↓ → 2048, «2» — поиском 256/2048').toBe(was);
    expect(shadowRes, 'было: onShadowRes пересоздавал все теневые карты').toEqual([]);
    expect(store.get('dm3d_settings')).toBe(MANUAL);
    browserKey(select, 'Digit2');   // модель живая: неотменённая «2» список листает
    expect(select.value).not.toBe(was);
  });

  it('R12-15, сторож: КАЖДАЯ клавиша, которую читает игра веб-3D (ход, действия, пояс), при элементе ⚙ в фокусе отменена', () => {
    const HERE = dirname(fileURLToPath(import.meta.url));
    const read = (f: string): string => readFileSync(join(HERE, f), 'utf8');
    const codes = new Set<string>();
    for (const f of ['online3d.ts', 'playerInput.ts']) for (const m of read(f).matchAll(/keys\.has\('(\w+)'\)/g)) codes.add(m[1]!);
    for (const m of read(join('..', 'ui', 'beltBar.ts')).matchAll(/'(Digit\d)'/g)) codes.add(m[1]!);
    expect(codes.size, 'WASD, стрелки, пробел, Shift×2, Q, E, Alt×2, 1–4').toBeGreaterThanOrEqual(19);
    store.set('dm3d_settings', MANUAL);
    const { slider, select, torchCb } = settings();
    for (const focus of [slider, select, torchCb]) {
      for (const code of codes) expect(tap(new Set(), code, focus, true).down.defaultPrevented, `${focus.tagName}/${focus.type}: ${code}`).toBe(true);
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
    const name = Object.assign(new El('input'), { type: 'text' });
    expect(tap(keys, 'ArrowLeft', name, true).down.defaultPrevented, 'стрелка в поле двигает курсор').toBe(false);
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
    // R12-15: стрелки и цифры отменяются только при элементе ⚙ в фокусе — канвасу и странице они как были.
    for (const code of ['ArrowUp', 'Digit1']) expect(tap(keys, code, null, true).down.defaultPrevented, code).toBe(false);
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

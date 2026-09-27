import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { ConfigRegistry, parseTownCommand, stashDims } from '@dm/shared';
import { beginHold, clearHeld, dropCell, getHeld, type HeldFrom } from './heldItem.js';

/**
 * ⭐ R2-35: БРОШЕННЫЙ ПРЕДМЕТ — ЛИБО ЦЕЛИКОМ В СЕТКЕ, ЛИБО КОМАНДЫ НЕТ. Строгая схема сервера (`parseTownCommand`)
 * считает клетку < 0 «неверной командой»: сервер пишет в лог «невалидная команда … от <героя>» и растит
 * `dm_cmd_invalid_total` — честный игрок, бросивший вещь, взятую за правый край, у левого края сетки, выглядел бы
 * читером. Веб проверял это в двух местах своими строками, Unity не проверял вовсе; теперь правило одно
 * (`dropCell`), и Unity сверяет свой порт с ним по эталону (`town/__golden__/unity_town.json`).
 */
const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const bag = reg.get('balance').inventory;
const GRIDS = [{ cols: bag.cols, rows: bag.rows }, stashDims(reg)];
const SIZES = [[1, 1], [1, 2], [2, 2], [2, 3], [1, 4], [2, 4]] as const;

describe('⭐ R2-35: dropCell — куда ляжет держимый предмет', () => {
  it('случай из находки: 2×3, взят за правый столбец, брошен в столбец 0 — команды нет (x = −1 сервер счёл бы читом)', () => {
    expect(dropCell({ gridW: 2, gridH: 3 }, 1, 0, 0, 0, GRIDS[0]!)).toBeNull();
    expect(parseTownCommand({ cmd: 'moveItem', uid: 'u', x: -1, y: 0 }).ok, 'без проверки ушла бы невалидная команда').toBe(false);
    expect(parseTownCommand({ cmd: 'stashMove', uid: 'u', dst: 0, x: -1, y: 0 }).ok).toBe(false);
  });

  it('⭐ свойство: во всех сетках, размерах, точках захвата и клетках — либо null, либо команда проходит схему и вещь влезает', () => {
    let sent = 0, held = 0;
    for (const dims of GRIDS) for (const [w, h] of SIZES) {
      for (let gx = 0; gx < w; gx++) for (let gy = 0; gy < h; gy++) {
        for (let col = 0; col < dims.cols; col++) for (let row = 0; row < dims.rows; row++) {
          const at = dropCell({ gridW: w, gridH: h }, gx, gy, col, row, dims);
          const raw = { x: col - gx, y: row - gy };
          if (!at) {
            held++;
            // Отказ — только там, где вещь правда не легла бы целиком.
            expect(raw.x < 0 || raw.y < 0 || raw.x + w > dims.cols || raw.y + h > dims.rows).toBe(true);
            continue;
          }
          sent++;
          expect(at).toEqual(raw);
          expect(at.x + w <= dims.cols && at.y + h <= dims.rows).toBe(true);
          for (const cmd of [{ cmd: 'moveItem', uid: 'u', ...at }, { cmd: 'stashMove', uid: 'u', dst: 'inv', ...at }, { cmd: 'stashMove', uid: 'u', dst: 1, ...at }]) {
            expect(parseTownCommand(cmd).ok, JSON.stringify(cmd)).toBe(true);
          }
        }
      }
    }
    expect(sent).toBeGreaterThan(1000);
    expect(held, 'края сетки — есть и отказы').toBeGreaterThan(100);
  });
});

/**
 * ⭐ R9-09: КЛИК ПО ХОЛСТУ ИНТЕРФЕЙСА — НЕ ВЫБРОС. В городе кузница открывает и инвентарь: игрок берёт оружие на
 * курсор (чтобы положить на верстак), переключает кузницу на «⚒ Ковка» и тянет мышью 3D-стенд сборки, как зовёт
 * подпись. Стенд — `<canvas>` WebGL в окне DomUi; клик всплывал до `window`, а `onWorldClick` считал «миром» ЛЮБОЙ
 * холст и слал `drop`: вещь молча падала под ноги — её мог унести напарник (дроп общий), а смена области
 * (`enterFloor`: `w.drops = []`) стирала. Мир теперь — только помеченная поверхность игры (`[data-dm-world]`).
 *
 * DOM — заглушка (как в `net/netDriver.test.ts`), но поверхности мира собраны из НАСТОЯЩЕЙ разметки страниц
 * (`index.html` — 2D, `game3d.html` — веб-3D): сотрут метку — упадут контрольные случаи.
 */
describe('⭐ R9-09: клик по холсту интерфейса (3D-стенд кузницы) — не выброс', () => {
  /** Узел DOM: `closest` с настоящей семантикой для простых селекторов (`#id`, `[attr]`, тег, список через запятую). */
  class El {
    style: Record<string, string> = {}; textContent = ''; parent: El | null = null;
    constructor(public tagName: string, public attrs: Record<string, string> = {}) { }
    append(...cs: El[]): El { for (const c of cs) c.parent = this; return this; }
    remove(): void { }
    closest(sel: string): El | null {
      const parts = sel.split(',').map((s) => s.trim());
      for (const p of parts) if (!/^(#[\w-]+|\[[\w-]+\]|[a-z]+)$/i.test(p)) throw new Error(`заглушка не знает селектор «${p}»`);
      const hit = (e: El, p: string): boolean =>
        p.startsWith('#') ? e.attrs.id === p.slice(1) : p.startsWith('[') ? p.slice(1, -1) in e.attrs : e.tagName === p.toUpperCase();
      for (let e: El | null = this; e; e = e.parent) if (parts.some((p) => hit(e!, p))) return e;
      return null;
    }
  }
  /** Элемент из настоящей разметки страницы клиента: тег и атрибуты открывающего тега с этим `id`. */
  const fromPage = (file: string, id: string): El => {
    const html = readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
    const tag = html.match(new RegExp(`<(\\w+)\\b[^>]*\\bid="${id}"[^>]*>`));
    if (!tag) throw new Error(`${file}: нет #${id}`);
    const attrs: Record<string, string> = {};
    for (const m of tag[0].slice(tag[1]!.length + 1, -1).matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attrs[m[1]!] = m[2] ?? '';
    return new El(tag[1]!.toUpperCase(), attrs);
  };

  const G = globalThis as unknown as { document?: unknown; window?: unknown };
  let winClick: ((e: unknown) => void)[] = [];
  let sent: { cmd: string; uid?: string }[] = [];
  const app = { sendCmd: (c: { cmd: string; uid?: string }) => { sent.push(c); return 1; }, bus: { emit: () => { } } };
  const ITEM = { uid: 'sword-1', name: 'Меч', gridW: 1, gridH: 3, rarity: 'rare', kind: 'weapon', slot: 'weapon' };
  beforeEach(() => {
    winClick = []; sent = [];
    G.document = { createElement: (t: string) => new El(t.toUpperCase()), body: { appendChild: () => { } } };
    G.window = {
      addEventListener: (t: string, cb: (e: unknown) => void) => { if (t === 'click') winClick.push(cb); },
      removeEventListener: (t: string, cb: (e: unknown) => void) => { if (t === 'click') winClick = winClick.filter((f) => f !== cb); },
    };
  });
  afterEach(() => { clearHeld(); delete G.document; delete G.window; });

  const hold = (from: HeldFrom): void => beginHold(app as never, ITEM as never, 0, 0, from);
  /** DOM-`click`, всплывший до `window` (тянуть стенд мышью — тоже клик: pointerdown/up на одном холсте). */
  const click = (target: El): void => { for (const cb of [...winClick]) cb({ target }); };
  /** `#ui-root` → окно DomUi кузницы (`data-dmwindow`) → стенд `renderer.domElement`; и миникарта веб-3D вне окон. */
  const ui = (): { stand: El; minimap: El } => {
    const root = new El('DIV', { id: 'ui-root' });
    const win = new El('DIV', { 'data-dmwindow': '1' });
    const stand = new El('CANVAS');
    const wrap = new El('DIV');
    const minimap = new El('CANVAS');
    root.append(win, wrap); win.append(stand); wrap.append(minimap);
    return { stand, minimap };
  };

  it('⭐ случай из находки: предмет из инвентаря, клик по 3D-стенду в окне кузницы — ни `drop`, ни потери курсора', () => {
    const { stand, minimap } = ui();
    hold('inv');
    click(stand);
    expect(sent, 'было: [{cmd:"drop",uid:"sword-1"}] — вещь падала на землю').toEqual([]);
    expect(getHeld()?.item.uid, 'предмет всё ещё на курсоре — его можно положить на верстак').toBe('sword-1');
    click(minimap);
    expect(sent, 'любой холст интерфейса — не мир').toEqual([]);
    expect(getHeld()).not.toBeNull();
  });

  it('из сундука клик по стенду — не отмена взятия (предмет остаётся на курсоре)', () => {
    hold({ tab: 0 });
    click(ui().stand);
    expect(sent).toEqual([]);
    expect(getHeld(), 'было: клик по стенду снимал предмет с курсора').not.toBeNull();
  });

  it('контроль 2D: клик по холсту Phaser внутри `#game` (разметка `index.html`) — `drop`, как прежде', () => {
    const game = fromPage('index.html', 'game');
    const canvas = new El('CANVAS');
    game.append(canvas);
    ui();
    hold('inv');
    click(canvas);
    expect(sent).toEqual([{ cmd: 'drop', uid: 'sword-1' }]);
    expect(getHeld()).toBeNull();
  });

  it('контроль веб-3D: клик по холсту мира `canvas#app` (разметка `game3d.html`) — `drop`; из сундука — отмена взятия', () => {
    const world = fromPage('game3d.html', 'app');
    expect(world.tagName).toBe('CANVAS');
    hold('inv');
    click(world);
    expect(sent).toEqual([{ cmd: 'drop', uid: 'sword-1' }]);
    expect(getHeld()).toBeNull();
    hold({ tab: 1 });
    click(world);
    expect(sent, 'из сундука в мир не бросаем').toHaveLength(1);
    expect(getHeld()).toBeNull();
  });
});

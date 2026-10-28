import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../../config/registry.js';
import { defaultConfigData } from '../../config/defaults.js';
import { generateRunPlan, defaultRunConfig } from './generateRunPlan.js';
import { waypointWarnings, WAYPOINT_FLOOR_ROLE } from './waypointData.js';
import { isWaypoint, openWaypoints } from '../../formulas/power.js';

/**
 * ⭐⭐ 14.10 (Г3, В7): СТОРОЖ ДАННЫХ — БИОМ БЕЗ rest-ЭТАЖА = СПУСК БЕЗ ЕДИНОЙ МЕТКИ.
 *
 * ⚠ ЗАЧЕМ ТЕСТ, КОГДА ЕСТЬ СХЕМА. Схема конфига про это ничего не знает: `floors` — просто список, роль `rest` ничем
 * не обязательна, и выключить `crypt-rest` тумблером — одна галка в редакторе. Генератор при этом МОЛЧА перестаёт
 * ставить привалы (`generateRunPlan`: `restAvail = avail.has('rest')`), и бесконечный спуск идёт без портала в город
 * у узла и без каденции метки. Заметить это можно было бы только спустившись.
 *
 * ⚠ ЧТО ИМЕННО СТЕРЕЖЁТСЯ (три зуба, не один):
 *  1) живые данные чисты — у каждого ВКЛЮЧЁННОГО биома есть включённый этаж-привал (сегодня он есть у всех четырёх);
 *  2) мутация «снять привал у crypt» валит сторож — и ПОСЛЕДСТВИЕ замерено тем же тестом: генератор не ставит ни
 *     одного `rest` на 20 этажах подряд, хотя чистая арифметика метки (`isWaypoint`) по-прежнему говорит «метка»;
 *  3) членство в шаблоне — тоже ворота: привал, не входящий во включённый шаблон, в нём не родится.
 *
 * ⚠ ЧЕГО ЭТОТ ТЕСТ НЕ ПРОВЕРЯЕТ: самого ПОРТАЛА на метке. Его держит `Room` (В4: доливает портал к точке входа, если
 * генератор привал не поставил) — сторож там же, в `server/net/room.g3waypoint.test.ts`, на живой комнате.
 */
type Tables = Record<string, unknown>;
type FloorRow = { id: string; role: string; biomeId: string; enabled?: boolean; templates?: string[] };
type IdRow = { id: string; name?: string; enabled?: boolean };

const files = (): Tables => structuredClone(defaultConfigData) as Tables;
/** Реестр из таблиц. `cross: false` — правки ниже ломают данные нарочно, а судим мы не кросс-правила. */
const regOf = (t: Tables): ConfigRegistry => { const r = new ConfigRegistry(); r.loadAll(t, { cross: false }); return r; };
const warnOf = (t: Tables) => waypointWarnings(t['biomes'] as IdRow[], t['floors'] as FloorRow[]);

/** Роли узлов 20 этажей подряд от 1-го — ровно то, что увидит игрок, спускаясь ногами. */
function rolesOf(reg: ConfigRegistry, biomeId: string): string[] {
  const cfg = { ...defaultRunConfig(reg, 4242), biomeId };
  const plan = generateRunPlan(reg, cfg, undefined, { from: 1, to: 20 });
  return [...new Set(plan.nodes.filter((n) => n.lane === 0).sort((a, b) => a.depth - b.depth).map((n) => n.type))];
}

describe('⭐⭐ Г3 (В7): данные — у каждого включённого биома обязан быть этаж-привал', () => {
  it('живой конфиг чист: привал есть у каждого включённого биома и входит в каждый включённый шаблон', () => {
    const t = files();
    const biomes = (t['biomes'] as IdRow[]).filter((b) => b.enabled !== false);
    const floors = t['floors'] as FloorRow[];
    const rest = floors.filter((f) => f.enabled !== false && f.role === WAYPOINT_FLOOR_ROLE);
    // Замер в вывод: что именно считается привалом в живых данных (и у каких биомов).
    console.log('[В7] этажи-привалы:', rest.map((f) => `${f.id}→${f.biomeId}`).join(', '));
    console.log('[В7] включённые биомы:', biomes.map((b) => b.id).join(', '), '· всего биомов', (t['biomes'] as IdRow[]).length);
    expect(warnOf(t), 'живые данные не должны давать предупреждений о метках').toEqual([]);
    for (const b of biomes) {
      expect(rest.some((f) => f.biomeId === b.id), `у включённого биома ${b.id} нет этажа-привала`).toBe(true);
    }
  });

  it('⚠⚠ Г8-4: мутация «у crypt нет привала» — сторож валится, но МЕТКИ ОСТАЮТСЯ (меняется этаж под ними)', () => {
    const t = files();
    const before = regOf(t);
    expect(rolesOf(before, 'crypt'), 'на целых данных привал на 20 этажах есть').toContain('rest');

    // Та самая одна галка в редакторе.
    (t['floors'] as FloorRow[]).forEach((f) => { if (f.id === 'crypt-rest') f.enabled = false; });
    const warns = warnOf(t);
    expect(warns.length, 'сторож обязан заметить снятый привал').toBe(1);
    expect(warns[0]).toMatchObject({ section: 'biomes', id: 'crypt' });
    expect(warns[0]!.msg, 'текст называет роль и последствие').toContain(WAYPOINT_FLOOR_ROLE);
    // ⚠⚠ ПОСЛЕДСТВИЕ ПОМЕНЯЛОСЬ С Г8-4. Прежде здесь ждали «БЕЗ ЕДИНОЙ МЕТКИ»: генератор спрашивал у биома, есть
    // ли этаж-привал, и молча отменял метку. Владелец потребовал, чтобы таблица решала всё, — поэтому метка
    // ОСТАЁТСЯ, а предупреждение теперь про ВИД этажа под ней.
    expect(warns[0]!.msg).toContain('без комнаты-привала');
    expect(warns[0]!.msg).not.toContain('БЕЗ ЕДИНОЙ МЕТКИ');

    const after = regOf(t);
    expect(rolesOf(after, 'crypt'), '⭐ Г8-4: привалы на местах круга стоят и без rest-этажа').toContain('rest');
    // ⚠ А чистая арифметика метки про биом не спрашивает (это шов глубины, один на сервер/алтарь/Unity): она
    // по-прежнему зовёт глубину 3 меткой, и старт там сервер разрешит. Выход назад на такой метке держит `Room` (В4).
    // ⭐ Г8-3: места порталов полосы (список) вместо прежнего единого шага — арифметика та же, адресация другая.
    const access = (t['balance'] as { dungeonAccess: { portalsAt: number[]; contentCycle: number } }).dungeonAccess;
    const first = access.portalsAt[0]!;
    expect(isWaypoint(first, access.portalsAt, access.contentCycle), 'арифметика метки от биома не зависит — и это осознанно').toBe(true);
    expect(openWaypoints({ normal: first }, 'normal', access.portalsAt, access.contentCycle), 'и старт на ней остаётся открыт').toContain(first);
  });

  /**
   * ⭐⭐ Г8-4 (15.10): ВМЕСТО ШАБЛОННОГО ЗУБА — БОССОВЫЙ. Прежде сторож ловил «привал есть, но не входит в текущий
   * шаблон»; членство этажей в шаблонах снято совсем — именно оно съело боссов крипты в «Короткой вылазке»
   * (`crypt-boss` состоял в двух шаблонах из трёх). Зато появилось новое молчание, которого раньше не было в
   * сторожах вовсе: биом БЕЗ боссовой арены. Узел-босс на своём месте круга встанет, но на обычном этаже — то есть
   * без боссовой комнаты и без самого босса.
   */
  it('⚠⚠ Г8-4: мутация «у биома нет боссовой арены» — узел босса остаётся, но предупреждение про отсутствие БОССА', () => {
    const t = files();
    expect(warnOf(t), 'целые данные — молчание').toEqual([]);
    (t['floors'] as FloorRow[]).forEach((f) => { if (f.role === 'boss') f.enabled = false; });
    const warns = warnOf(t);
    const onBiomes = (t['biomes'] as IdRow[]).filter((b) => b.enabled !== false).length;
    expect(warns.length, 'по предупреждению на каждый включённый биом').toBe(onBiomes);
    expect(warns[0]!.msg).toContain('БЕЗ САМОГО БОССА');
    expect(warns[0]!.msg).toContain('boss');
    // А узлы-боссы на местах круга при этом НИКУДА НЕ ДЕЛИСЬ — это и есть правило владельца.
    expect(rolesOf(regOf(t), 'crypt'), 'боссовый узел остаётся').toContain('boss');
  });

  it('выключенный биом (и выключенный шаблон) не спрашивают — он в забег не попадает', () => {
    const t = files();
    (t['floors'] as FloorRow[]).forEach((f) => { if (f.role === WAYPOINT_FLOOR_ROLE) f.enabled = false; });
    const all = warnOf(t).length;
    (t['biomes'] as IdRow[]).forEach((b) => { b.enabled = false; });
    expect(all, 'пока биомы включены — предупреждения есть').toBeGreaterThan(0);
    expect(warnOf(t), 'все биомы выключены — спрашивать не с кого').toEqual([]);
  });
});

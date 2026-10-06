import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { defaultConfigData } from '../config/defaults.js';
import { upgradeStoredOverride } from '../config/storedOverride.js';
import { configSchemas } from '../config/schemas.js';
import { newCharacterSave } from './newCharacter.js';
import { materialItem, availableMaterials } from './materials.js';
import { sanitizeStash, emptyStash } from './stashActions.js';
import { forgeUpgrade, forgeSalvage, PRICE_CHANGED } from './townActions.js';
import { forgeExchange } from './exchange.js';
import {
  RETIRED_FAMILIES, liveMaterialId, migrateRetiredInSave, migrateRetiredInStash, retiredSuccessor,
} from './retiredMaterials.js';
import { meltReturn, craftWeapon, fullJournal } from '../formulas/craft.js';
import { parseTownCommand } from '../session/netSchemas.js';
import { runSessionSim } from '../session/runner.js';
import { DEFAULT_BUILD } from '../sim/types.js';
import type { Item } from '../types/items.js';
import type { SaveState } from '../types/save.js';
import type { AccountStash } from '../types/stash.js';

/**
 * ⭐ СНЯТИЕ «ПЛЕЧ» И «ФОКУСА» (06.10): сырьё, лежащее у игроков, переезжает в тот же сорт Дерева и Прибора — без потерь и сколько угодно раз
 * (`economy/retiredMaterials.ts`); оверрайды конфига в базе приводятся (`upgradeStoredOverride`); согласие старой вкладки со старыми id —
 * чистый отказ, а не исключение.
 */
const reg = new ConfigRegistry();
reg.loadAll();
const defs = reg.get('craft-materials');
const STACK = reg.get('balance').inventory.materialStack;
const nameOf = (id: string): string => defs.find((m) => m.id === id)!.name;
/** Стек сырья СТАРОГО id (как лежал в сейве до снятия): имя — прежнее, таблицы для него больше нет. */
const oldStack = (id: string, n: number, x: number, name = `старое ${id}`): Item => ({ ...materialItem({ id, name, family: id.replace(/-\d+$/, ''), tier: Number(id.slice(-1)) }, n, `m-${id}-${x}`), pos: { x, y: 0 } });
const stack = (id: string, n: number, x: number): Item => ({ ...materialItem(defs.find((m) => m.id === id)!, n, `m-${id}-${x}`), pos: { x, y: 0 } });
/** Всё сырьё героя и сундука одним словарём — для сверки «без потерь». */
const units = (save: SaveState, stash?: AccountStash): Record<string, number> => {
  const out = availableMaterials(save.inventory, stash?.materials ?? {});
  for (const [id, n] of Object.entries(save.materials ?? {})) out[id] = (out[id] ?? 0) + n;
  for (const tab of stash?.tabs ?? []) for (const [id, n] of Object.entries(availableMaterials(tab, {}))) out[id] = (out[id] ?? 0) + n;
  return out;
};
/** Тот же словарь, переписанный в id преемников, — каким он обязан стать после переезда. */
const remapped = (w: Record<string, number>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [id, n] of Object.entries(w)) out[liveMaterialId(id)] = (out[liveMaterialId(id)] ?? 0) + n;
  return out;
};

function oldSave(): SaveState {
  const save = newCharacterSave(reg, reg.get('classes')[0]!.id, 'Старый', 'char-old');
  save.inventory = [
    oldStack('stave-2', 150, 0), stack('wood-2', 120, 1), oldStack('focus-5', 3, 2), oldStack('stave-1', 500, 3),
    stack('iron-1', 7, 4),
  ];
  save.materials = { 'stave-4': 5, 'wood-4': 2, 'focus-1': 1 };
  return save;
}

describe('⭐ переезд сырья снятых семей: сейв героя', () => {
  it('преемник того же сорта; стеки сливаются в пределах стека; лишнее не пропадает; имена — по таблице', () => {
    expect(RETIRED_FAMILIES).toEqual({ stave: 'wood', focus: 'trim' });
    expect(retiredSuccessor('stave-3')).toBe('wood-3');
    expect(retiredSuccessor('focus-5')).toBe('trim-5');
    expect(retiredSuccessor('iron-3')).toBeUndefined();
    expect(retiredSuccessor('ench-essence')).toBeUndefined();
    const save = oldSave();
    const before = remapped(units(save));
    expect(migrateRetiredInSave(save, defs, STACK)).toBe(true);
    expect(units(save), 'ни одна единица не пропала').toEqual(before);
    const wood2 = save.inventory.filter((i) => i.materialId === 'wood-2');
    expect(wood2.map((i) => i.count), 'стеки 150 + 120 → 200 + 70').toEqual([200, 70]);
    for (const it of save.inventory) {
      expect(it.materialId && retiredSuccessor(it.materialId), `${it.materialId}: старого id в сумке нет`).toBeFalsy();
      expect(it.baseId, 'база стека — тот же id').toBe(it.materialId);
      expect(it.name, 'имя — из таблицы сырья').toBe(nameOf(it.materialId!));
    }
    expect(save.inventory.find((i) => i.materialId === 'trim-5')?.count).toBe(3);
    // Стек длиннее предела (сейв старше лимита стека) — не режется и не теряется.
    expect(save.inventory.find((i) => i.materialId === 'wood-1')?.count).toBe(500);
    expect(save.materials, 'старый кошелёк героя — суммой в преемника').toEqual({ 'wood-4': 7, 'trim-1': 1 });
  });

  it('⚠ три стека в один (живая проверка 06.10): опустевшие убираются, а не остаются ×0', () => {
    const save = newCharacterSave(reg, reg.get('classes')[0]!.id, 'Три стека', 'char-three');
    save.inventory = [oldStack('stave-2', 7, 0), oldStack('stave-2', 5, 1), stack('wood-2', 10, 2), stack('iron-1', 3, 3)];
    expect(migrateRetiredInSave(save, defs, STACK)).toBe(true);
    expect(save.inventory.map((i) => `${i.materialId}×${i.count}`)).toEqual(['wood-2×22', 'iron-1×3']);
    expect(migrateRetiredInSave(save, defs, STACK), 'второй проход — ничего').toBe(false);
  });

  it('⭐ дважды — то же: второй проход ничего не находит', () => {
    const save = oldSave();
    migrateRetiredInSave(save, defs, STACK);
    const once = JSON.stringify(save);
    expect(migrateRetiredInSave(save, defs, STACK)).toBe(false);
    expect(JSON.stringify(save)).toBe(once);
  });

  it('⭐ скованная вещь: оплата ковки — по строке на гнездо (переплавка возвращает долю ПО СТРОКЕ, как до переезда)', () => {
    const save = newCharacterSave(reg, reg.get('classes')[0]!.id, 'Кузнец', 'char-smith');
    const input = {
      weaponClass: 'bow', hands: 2,
      parts: { strike: { id: 'bw-lb-english', step: 3 }, grip: { id: 'bw-gr-plain', step: 3 }, bind: { id: 'bw-st-flax', step: 3 }, head: { id: 'bw-tp-flex', step: 3 } },
    };
    const pv = craftWeapon(reg, input, { journal: fullJournal(reg) });
    const item: Item = pv.ok ? structuredClone(pv.item!) : ({ uid: 'x', baseId: 'long-bow', name: 'лук', rarity: 'normal', itemLevel: 1, requirements: {}, affixes: [], baseStats: [], gridW: 1, gridH: 1 } as Item);
    // Как лежала вещь, скованная до снятия: рога и концы — Плечи.
    item.craftPaid = [{ id: 'stave-3', n: 17 }, { id: 'wood-3', n: 9 }, { id: 'cloth-3', n: 9 }, { id: 'stave-3', n: 9 }];
    save.equipment.weapon = item;
    const want = meltReturn(reg, { ...item, craftPaid: item.craftPaid.map((l) => ({ ...l, id: liveMaterialId(l.id) })) });
    migrateRetiredInSave(save, defs, STACK);
    expect(save.equipment.weapon!.craftPaid).toEqual([{ id: 'wood-3', n: 17 }, { id: 'wood-3', n: 9 }, { id: 'cloth-3', n: 9 }, { id: 'wood-3', n: 9 }]);
    expect(meltReturn(reg, save.equipment.weapon!)).toEqual(want);
    expect(migrateRetiredInSave(save, defs, STACK), 'второй проход — ничего').toBe(false);
  });

  it('сим со старым сейвом (вкладка сима, `sim-cli --char`) — переезд на входе, прогон идёт', () => {
    const save = oldSave();
    const rep = runSessionSim(reg, { classId: save.classId, difficultyId: 'normal', seed: 5, targetLevel: 2, maxHours: 0.02, dt: 1 / 30, townTripSec: 45, build: DEFAULT_BUILD, save });
    expect(rep).toBeTruthy();
    expect(save.inventory.some((i) => i.materialId === 'stave-2'), 'сим работает с копией — исходный сейв не тронут').toBe(true);
  });
});

describe('⭐ переезд сырья снятых семей: сундук аккаунта', () => {
  const oldStash = (): AccountStash => {
    const st = emptyStash(reg);
    st.materials = { 'stave-4': 10, 'wood-4': 1, 'focus-2': 3, 'iron-1': 4 };
    st.tabs[0]!.push(oldStack('focus-3', 12, 0), stack('trim-3', 195, 1));
    const forged: Item = { uid: 'forged-1', baseId: 'long-bow', name: 'лук', rarity: 'normal', itemLevel: 1, requirements: {}, affixes: [], baseStats: [],
      gridW: 1, gridH: 3, pos: { x: 5, y: 0 }, parts: { strike: { id: 'bw-lb-english', step: 2 }, grip: { id: 'bw-gr-plain', step: 2 }, bind: { id: 'bw-st-flax', step: 2 }, head: { id: 'bw-tp-flex', step: 2 } },
      craftPaid: [{ id: 'stave-2', n: 16 }, { id: 'focus-2', n: 8 }] } as Item;
    st.tabs[1]!.push(forged);
    return st;
  };

  it('кошелёк и вкладки: преемник, без потерь; `sanitizeStash` (каждое чтение сундука сервером) — дважды то же', () => {
    const st = oldStash();
    const save = newCharacterSave(reg, reg.get('classes')[0]!.id, 'Пустой', 'char-empty');
    save.inventory = [];
    const before = remapped(units(save, st));
    sanitizeStash(reg, st);
    expect(units(save, st)).toEqual(before);
    expect(st.materials).toEqual({ 'wood-4': 11, 'trim-2': 3, 'iron-1': 4 });
    expect(st.tabs[0]!.map((i) => [i.materialId, i.count]), 'стек вкладки слит с соседним до предела').toEqual([['trim-3', 200], ['trim-3', 7]]);
    expect(st.tabs[1]![0]!.craftPaid).toEqual([{ id: 'wood-2', n: 16 }, { id: 'trim-2', n: 8 }]);
    const once = JSON.stringify(st);
    sanitizeStash(reg, st);
    expect(JSON.stringify(st), 'второе чтение — то же').toBe(once);
    expect(migrateRetiredInStash(st, defs, STACK)).toBe(false);
  });
});

describe('⭐ согласие старой вкладки со старыми id — чистый отказ, не исключение', () => {
  it('провод пропускает (это id по форме), ядро отказывает «Цена изменилась…» и ничего не трогает', () => {
    const save = newCharacterSave(reg, reg.get('classes')[0]!.id, 'Вкладка', 'char-tab');
    save.gold = 100_000;
    const st = emptyStash(reg);
    st.materials = Object.fromEntries(defs.filter((m) => m.enabled).map((m) => [m.id, 500]));
    const item = save.equipment.weapon ? structuredClone(save.equipment.weapon) : undefined;
    expect(item).toBeDefined();
    item!.uid = 'up-1'; item!.pos = { x: 0, y: 0 };
    save.inventory = [item!];
    const snap = JSON.stringify([save, st]);
    // Подъём: старая карточка показала Плечи.
    const up = { cmd: 'forgeUpgrade', uid: 'up-1', maxGold: 100_000, maxMaterials: { 'stave-2': 3, 'stave-1': 21 } } as const;
    expect(parseTownCommand(up).ok).toBe(true);
    const r1 = forgeUpgrade(reg, save, 'up-1', st.materials, up.maxGold, up.maxMaterials);
    expect(r1.ok).toBe(false);
    expect(r1.reason?.startsWith(PRICE_CHANGED), r1.reason).toBe(true);
    // Разбор: старая вилка обещала Плечи.
    const r2 = forgeSalvage(reg, save, st, 'up-1', { int: (a) => a, chance: () => false }, { 'stave-1': 1 });
    expect(r2.ok).toBe(false);
    expect(r2.reason?.startsWith(PRICE_CHANGED), r2.reason).toBe(true);
    // Обмен из снятого id: такого сырья у кузнеца нет.
    const ex = { cmd: 'forgeExchange', from: 'stave-3', to: 'iron', n: 9, maxGold: 999, maxMaterials: { 'stave-3': 9 }, minYield: { 'iron-3': 6 } } as const;
    expect(parseTownCommand(ex).ok).toBe(true);
    const r3 = forgeExchange(reg, save, st, ex.from, ex.to, ex.n, ex.maxGold, ex.maxMaterials, ex.minYield);
    expect(r3).toEqual({ ok: false, reason: 'Кузнец не знает такого сырья' });
    // Обмен в снятую семью — её больше нет.
    const r4 = forgeExchange(reg, save, st, 'iron-3', 'stave', 9, 999, { 'iron-3': 9 }, { 'stave-3': 6 });
    expect(r4.ok).toBe(false);
    expect(JSON.stringify([save, st]), 'отказ — до траты').toBe(snap);
  });
});

describe('⭐ оверрайды конфига в базе, сохранённые до снятия, — приводятся (сервер стартует без ручных шагов)', () => {
  const file = defaultConfigData as Record<string, unknown>;
  const clone = <T>(k: string): T => structuredClone(file[k]) as T;
  type Row = Record<string, unknown>;
  /** Таблицы такими, какими их сохранял редактор ДО 06.10. */
  const oldTables = (): Record<string, unknown> => {
    const mats = clone<Row[]>('craft-materials');
    const at = mats.findIndex((m) => m.family === 'hide');
    const retired: Row[] = [];
    for (const fam of ['stave', 'focus']) for (let g = 1; g <= 5; g++) retired.push({ id: `${fam}-${g}`, enabled: true, name: `${fam} ${g}`, family: fam, tier: g, usedFor: 'weapon', icon: '', note: '', sellPrice: [1, 2, 5, 10, 15][g - 1] });
    mats.splice(at, 0, ...retired);
    const anat = clone<Row[]>('weapon-anatomy');
    const set = (cls: string, slot: string, fam: string): void => { ((anat.find((a) => a.id === cls)!)[slot] as Row).family = fam; };
    set('bow', 'strike', 'stave'); set('bow', 'head', 'stave'); set('crossbow', 'strike', 'stave'); set('wand', 'strike', 'focus'); set('staff', 'strike', 'focus');
    const parts = clone<Row[]>('weapon-parts');
    for (const p of parts) if (p.slot === 'head' && (p.classes as string[]).includes('bow')) p.family = '';
    const rules = clone<Row[]>('salvage-rules');
    const rule = (id: string): Row => rules.find((r) => r.id === id)!;
    (rule('a-quilted').yields as Row[]).push({ materialId: 'stave-1', min: 0, max: 1 });
    (rule('a-leather').yields as Row[]).push({ materialId: 'stave-1', min: 0, max: 1 });
    ((rule('jewelry-ring').yields as Row[])[1]!).materialId = 'focus-1';
    ((rule('jewelry-amulet').yields as Row[])[0]!).materialId = 'focus-1';
    const gear = clone<Row[]>('monster-gear');
    const g = (id: string): Row[] => gear.find((r) => r.id === id)!.salvageTo as Row[];
    g('u-bow')[1]!.materialId = 'stave-1';
    g('u-crossbow')[3]!.materialId = 'stave-1';
    g('u-staff-weak')[2]!.materialId = 'focus-1';
    g('u-wand')[2]!.materialId = 'focus-1';
    return { 'craft-materials': mats, 'weapon-anatomy': anat, 'weapon-parts': parts, 'salvage-rules': rules, 'monster-gear': gear };
  };

  it('каждая таблица приводится ровно к правилу файла, вслух; второй проход — ничего', () => {
    const old = oldTables();
    for (const [key, value] of Object.entries(old)) {
      expect(configSchemas[key as keyof typeof configSchemas].safeParse(value).success, `${key}: старая таблица проходит схему — без приведения она легла бы как есть`).toBe(true);
      const once = upgradeStoredOverride(key, value);
      expect(once.fixes.length, key).toBeGreaterThan(0);
      expect(JSON.stringify(once.value), `${key}: строки снятых семей`).not.toMatch(/"(stave|focus)(-\d)?"/);
      // Ровно файл (таблицы выше — копия файла со «старыми» правками): ничего лишнего не тронуто.
      expect(configSchemas[key as keyof typeof configSchemas].parse(once.value), key).toEqual(configSchemas[key as keyof typeof configSchemas].parse(file[key]));
      expect(old[key], `${key}: исходное значение не тронуто`).toEqual(oldTables()[key]);
      const twice = upgradeStoredOverride(key, once.value);
      expect(twice.fixes, `${key}: второй проход`).toEqual([]);
    }
  });

  it('концы лука: таблица деталей СО СВОЕЙ семьёй у концов (хозяин поставил деревянные явно) — не трогается', () => {
    const parts = clone<Row[]>('weapon-parts');
    for (const p of parts) if (p.slot === 'head' && (p.classes as string[]).includes('bow')) p.family = 'wood';
    expect(upgradeStoredOverride('weapon-parts', parts).fixes).toEqual([]);
  });

  it('живой реестр поверх приведённых оверрайдов: нет ни одного снятого id, лук куётся из Дерева', () => {
    const live = new ConfigRegistry();
    live.loadAll();
    const old = oldTables();
    live.reload(Object.fromEntries(Object.entries(old).map(([k, v]) => [k, upgradeStoredOverride(k, v).value])));
    expect(live.get('craft-materials').some((m) => m.family === 'stave' || m.family === 'focus')).toBe(false);
    expect(live.get('weapon-anatomy').find((a) => a.id === 'bow')!.strike.family).toBe('wood');
    expect(live.get('weapon-anatomy').find((a) => a.id === 'crossbow')!.strike.family).toBe('iron');
    expect(live.get('weapon-anatomy').find((a) => a.id === 'staff')!.strike.family).toBe('trim');
  });
});

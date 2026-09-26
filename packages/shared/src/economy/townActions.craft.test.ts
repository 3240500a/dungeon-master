import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { defaultConfigData } from '../config/defaults.js';
import {
  CRAFT_NONCES_KEEP, affixSlotsFillable, affixSlotsFor, craftSalvageYield, craftWeapon, emptyJournal, enchantCost, enchantItem,
  fullJournal, keyVariantsByBase, meltReturn, partsOf, salvageIntoJournal, variantsFor, type CraftInput, type CraftJournal,
} from '../formulas/craft.js';
import { CRAFT_SLOT_LIST, keySlotOf, type CraftSlot } from '../formulas/craftType.js';
import { generateItem, rollAffixes } from '../formulas/itemgen.js';
import { createRng } from '../formulas/rng.js';
import { canSalvage, type SalvageRng } from '../formulas/salvage.js';
import {
  canSalvageItem, craftAction, enchantAction, fieldSalvage, forgeGold, forgeReroll, forgeSalvage, salvageRange, salvageWorth, salvageYield,
} from './townActions.js';
import { carriedMaterials, materialItem } from './materials.js';
import { emptyStash } from './stashActions.js';
import type { AccountStash } from '../types/stash.js';
import type { CraftParts, Item } from '../types/items.js';
import type { SaveState } from '../types/save.js';

/**
 * ⭐ КОВКА НА СЕРВЕРЕ — ЧИСТОЕ ЯДРО ДЕЙСТВИЙ (К1). Главный закон: каждый отказ случается ДО траты,
 * и сейв с сундуком после него совпадают с исходными байт в байт (`frozen`). Любое «чуть-чуть
 * списали, потом отказали» — дыра: игрок платит за ничто или, хуже, получает что-то даром.
 */

type Data = Record<string, unknown> & typeof defaultConfigData;
function regWith(patch: (d: Data) => void = () => {}): ConfigRegistry {
  const d = structuredClone(defaultConfigData) as Data;
  patch(d);
  const r = new ConfigRegistry();
  r.loadAll(d);
  return r;
}
const rows = <T>(d: Data, key: string): T[] => d[key] as T[];
/** С К2 (D18) в конфиге включены все 40 материалов; тесты держат это явно, чтобы не зависеть от правки данных. */
const allMaterials = (d: Data): void => { for (const m of rows<{ enabled: boolean }>(d, 'craft-materials')) m.enabled = true; };
const reg = regWith(allMaterials);
/** Дизайнер выключил семью в редакторе («ещё не в игре»): прибор — его носит каждый меч. */
const live = regWith((d) => { for (const m of rows<{ enabled: boolean; family: string }>(d, 'craft-materials')) m.enabled = m.family !== 'trim'; });

const INF = 500;
const fullWallet = (r = reg): Record<string, number> => Object.fromEntries(r.get('craft-materials').map((m) => [m.id, INF]));
const mkSave = (gold = 1_000_000, inventory: Item[] = []): SaveState => ({ gold, inventory } as unknown as SaveState);
const mkStash = (journal: CraftJournal = fullJournal(reg), materials = fullWallet()): AccountStash =>
  ({ ...emptyStash(reg), materials, forgeJournal: journal });
/** Снимок сейва и сундука: отказ обязан оставить их байт в байт. */
const frozen = (save: SaveState, stash: AccountStash): string => JSON.stringify([save, stash]);
const NONCE = 'nonce-0001';
let nonceN = 0;
const nextNonce = (): string => `n-${String(++nonceN).padStart(6, '0')}`;

/** Сборка семейства: в каждом гнезде первая форма, чьё окно берёт ступень `step`. */
function inputAt(r: ConfigRegistry, cls: string, hands: number, step: number): CraftInput {
  const keySlot = keySlotOf(r, cls);
  const group = keyVariantsByBase(r, cls, hands).find((g) => g.variants.some((p) => p.stepMin <= step && step <= p.stepMax))!;
  const parts = {} as CraftParts;
  for (const slot of CRAFT_SLOT_LIST) {
    const pool = slot === keySlot ? group.variants : variantsFor(r, cls, slot, hands);
    const p = pool.find((v) => v.stepMin <= step && step <= v.stepMax)!;
    parts[slot] = { id: p.id, step };
  }
  return { weaponClass: cls, hands, parts };
}
const INPUT = inputAt(reg, 'sword', 1, 2);

/** Журнал, в котором открыто ровно то, из чего собрана заявка, и потолок ступени `tierHi`. */
function journalFor(input: CraftInput, tierHi: number, mythic = 0): CraftJournal {
  const pv = craftWeapon(reg, input);
  return {
    ...emptyJournal(), bases: [pv.type!.baseId!], variants: CRAFT_SLOT_LIST.map((s) => input.parts[s].id), tierHi, mythic,
  };
}

function expectRefused(r: { ok: boolean; reason?: string }, before: string, save: SaveState, stash: AccountStash, re?: RegExp): void {
  expect(r.ok, 'должен быть отказ').toBe(false);
  expect(r.reason, 'отказ объясняет себя').toBeTruthy();
  if (re) expect(r.reason).toMatch(re);
  expect(frozen(save, stash), `отказ «${r.reason}» изменил сейв или сундук`).toBe(before);
}

// ── Ковка ─────────────────────────────────────────────────────────────────────────────────────────

describe('⭐ craftAction — ковка по заявке', () => {
  it('скованная вещь = craftWeapon с тем же броском; списано ровно по цене; вещь в сумке, бросок настоящий', () => {
    const save = mkSave(), stash = mkStash();
    const pv = craftWeapon(reg, INPUT, { journal: fullJournal(reg), materialsOn: true, rng: createRng(42) });
    expect(pv.ok, pv.reason).toBe(true);
    const r = craftAction(reg, save, stash, NONCE, INPUT, createRng(42));
    expect(r.ok, r.reason).toBe(true);
    const got = save.inventory.find((i) => i.uid === r.uid)!;
    expect(got, 'вещь легла в сумку').toBeDefined();
    expect(got.pos, 'у вещи есть место в сетке').toBeTruthy();
    expect({ ...got, uid: '', pos: null }).toEqual({ ...pv.item!, uid: '', pos: null });
    expect(got.rollPreview, 'не предпросмотр с вилкой').toBeUndefined();
    expect(got.parts).toEqual(INPUT.parts);
    expect(save.gold).toBe(1_000_000 - pv.cost!.gold);
    for (const [id, n] of Object.entries(pv.cost!.materials)) expect(stash.materials![id], id).toBe(INF - n);
    const untouched = reg.get('craft-materials').filter((m) => !(m.id in pv.cost!.materials));
    for (const m of untouched) expect(stash.materials![m.id], m.id).toBe(INF);
  });

  it('заявка пересобирается из {id, step}: вещь несёт чистые детали, а не присланный объект', () => {
    const save = mkSave(), stash = mkStash();
    const sent = structuredClone(INPUT);
    const r = craftAction(reg, save, stash, NONCE, sent, createRng(1));
    expect(r.ok, r.reason).toBe(true);
    const got = save.inventory.find((i) => i.uid === r.uid)!;
    sent.parts.strike.step = 5;                        // клиент поменял свой объект после отправки
    expect(got.parts!.strike.step).toBe(INPUT.parts.strike.step);
  });

  it('⭐ повтор ключа — прежний uid, НИЧЕГО не скуётся и не спишется (даже с другой заявкой)', () => {
    const save = mkSave(), stash = mkStash();
    const r1 = craftAction(reg, save, stash, NONCE, INPUT, createRng(1));
    expect(r1.ok).toBe(true);
    const before = frozen(save, stash);
    const r2 = craftAction(reg, save, stash, NONCE, INPUT, createRng(2));
    expect(r2).toEqual({ ok: true, uid: r1.uid });
    const r3 = craftAction(reg, save, stash, NONCE, inputAt(reg, 'axe', 1, 1), createRng(3));
    expect(r3).toEqual({ ok: true, uid: r1.uid });
    expect(frozen(save, stash), 'вторая вещь не родилась, второй раз не списано').toBe(before);
    expect(save.inventory.filter((i) => i.parts)).toHaveLength(1);
  });

  it('ключ пишется вместе с вещью; хранится не больше 32 последних, новый — в конце', () => {
    const save = mkSave(), stash = mkStash();
    stash.craftNonces = Array.from({ length: CRAFT_NONCES_KEEP }, (_, i) => ({ n: `old-${String(i).padStart(6, '0')}`, uid: `u${i}` }));
    const r = craftAction(reg, save, stash, NONCE, INPUT, createRng(1));
    expect(r.ok).toBe(true);
    expect(stash.craftNonces).toHaveLength(CRAFT_NONCES_KEEP);
    expect(stash.craftNonces!.at(-1)).toEqual({ n: NONCE, uid: r.uid });
    expect(stash.craftNonces!.some((e) => e.n === 'old-000000'), 'самый старый вытеснен').toBe(false);
  });

  it('⚠ кривой ключ — отказ до всего', () => {
    for (const bad of [undefined, null, 12345678, '', 'short', 'x'.repeat(65), 'пробел внутри', 'a/b/c/d/e/f', 'semi;colon', { n: 'x' }]) {
      const save = mkSave(), stash = mkStash();
      const before = frozen(save, stash);
      expectRefused(craftAction(reg, save, stash, bad, INPUT, createRng(1)), before, save, stash);
    }
  });

  it('кодекс «сковал» ведёт ЯДРО; флаг разработчика открывает ворота, но в журнал не пишется', () => {
    const save = mkSave(), stash = mkStash(emptyJournal());
    const before = frozen(save, stash);
    expectRefused(craftAction(reg, save, stash, nextNonce(), INPUT, createRng(1)), before, save, stash, /не открыт/);
    const r = craftAction(reg, save, stash, nextNonce(), INPUT, createRng(1), { fullJournal: true });
    expect(r.ok, r.reason).toBe(true);
    const typeId = craftWeapon(reg, INPUT).type!.typeId;
    expect(typeId, 'у эталонной сборки есть исторический тип').toBeTruthy();
    expect(stash.forgeJournal!.typesForged).toEqual([typeId]);
    expect(stash.forgeJournal!.bases, 'полный журнал в аккаунт не утёк').toEqual([]);
    expect(stash.forgeJournal!.variants).toEqual([]);
    // Второй раз тот же тип — без повтора.
    expect(craftAction(reg, save, stash, nextNonce(), INPUT, createRng(2), { fullJournal: true }).ok).toBe(true);
    expect(stash.forgeJournal!.typesForged).toEqual([typeId]);
  });

  it('⭐ сырьё сперва из сумки, потом из сундука', () => {
    const pv = craftWeapon(reg, INPUT);
    const [id, need] = Object.entries(pv.cost!.materials)[0]!;
    const def = reg.get('craft-materials').find((m) => m.id === id)!;
    const stack = { ...materialItem(def, 5, 'stack-1'), pos: { x: 9, y: 5 } };
    const save = mkSave(1_000_000, [stack]), stash = mkStash();
    expect(craftAction(reg, save, stash, NONCE, INPUT, createRng(1)).ok).toBe(true);
    expect(save.inventory.some((i) => i.uid === 'stack-1'), 'стек в сумке израсходован первым').toBe(false);
    expect(stash.materials![id]).toBe(INF - (need - 5));
  });

  it('место меряется ПОСЛЕ списания: стек, уходящий в ковку, освобождает клетку', () => {
    const pv = craftWeapon(reg, INPUT);
    const { gridW, gridH } = pv.item!;
    expect(gridW).toBe(1);
    const [id, need] = Object.entries(pv.cost!.materials)[0]!;
    const def = reg.get('craft-materials').find((m) => m.id === id)!;
    const dims = reg.get('balance').inventory;
    // Всё занято, кроме столбца 9 рядов 0..gridH-1; в его верхней клетке — стек ровно под ковку.
    const bag = (count: number): Item[] => {
      const out: Item[] = [];
      for (let y = 0; y < dims.rows; y++) for (let x = 0; x < dims.cols; x++) {
        if (x === dims.cols - 1 && y < gridH) continue;
        out.push({ uid: `j${x}-${y}`, baseId: 'junk', name: 'хлам', rarity: 'normal', itemLevel: 1, requirements: {}, affixes: [], baseStats: [], gridW: 1, gridH: 1, pos: { x, y } });
      }
      out.push({ ...materialItem(def, count, 'the-stack'), pos: { x: dims.cols - 1, y: 0 } });
      return out;
    };
    const ok = mkSave(1_000_000, bag(need)), okStash = mkStash();
    expect(craftAction(reg, ok, okStash, NONCE, INPUT, createRng(1)).ok, 'стек ушёл целиком — клетка свободна').toBe(true);
    const full = mkSave(1_000_000, bag(need + 1)), fullStash = mkStash();
    const before = frozen(full, fullStash);
    expectRefused(craftAction(reg, full, fullStash, NONCE, INPUT, createRng(1)), before, full, fullStash, /места/);
  });

  it('сумка полна — отказ, ничего не списано', () => {
    const dims = reg.get('balance').inventory;
    const junk: Item[] = [];
    for (let y = 0; y < dims.rows; y++) for (let x = 0; x < dims.cols; x++) {
      junk.push({ uid: `j${x}-${y}`, baseId: 'junk', name: 'хлам', rarity: 'normal', itemLevel: 1, requirements: {}, affixes: [], baseStats: [], gridW: 1, gridH: 1, pos: { x, y } });
    }
    const save = mkSave(1_000_000, junk), stash = mkStash();
    const before = frozen(save, stash);
    expectRefused(craftAction(reg, save, stash, NONCE, INPUT, createRng(1)), before, save, stash, /места/);
  });

  it('⚠ не хватает КАЖДОГО из материалов по отдельности — отказ, названо чего', () => {
    const pv = craftWeapon(reg, INPUT);
    for (const [id, need] of Object.entries(pv.cost!.materials)) {
      const save = mkSave(), stash = mkStash(fullJournal(reg), { ...fullWallet(), [id]: need - 1 });
      const before = frozen(save, stash);
      const name = reg.get('craft-materials').find((m) => m.id === id)!.name;
      expectRefused(craftAction(reg, save, stash, NONCE, INPUT, createRng(1)), before, save, stash, new RegExp(name));
    }
  });

  it('⚠ не хватает золота — отказ; золото NaN — тоже отказ, а не «сравнение ложно, значит хватает»', () => {
    const pv = craftWeapon(reg, INPUT);
    for (const gold of [pv.cost!.gold - 1, Number.NaN, -1]) {
      const save = mkSave(gold), stash = mkStash();
      const before = frozen(save, stash);
      expectRefused(craftAction(reg, save, stash, NONCE, INPUT, createRng(1)), before, save, stash, /золота/);
    }
  });

  it('⚠ материал ещё не в игре — отказ по умолчанию (как на сервере); песочнице — можно', () => {
    const input = inputAt(live, 'sword', 1, 2);
    const save = mkSave(), stash: AccountStash = { ...emptyStash(live), materials: fullWallet(live), forgeJournal: fullJournal(live) };
    const before = frozen(save, stash);
    expectRefused(craftAction(live, save, stash, NONCE, input, createRng(1)), before, save, stash, /не в игре/);
    expect(craftAction(live, save, stash, NONCE, input, createRng(1), { allowDisabledMaterials: true }).ok).toBe(true);
  });

  it('⚠ детали: неизвестная, чужого класса, чужого гнезда, выключенная, ступень вне окна', () => {
    const axeStrike = variantsFor(reg, 'axe', 'strike', 1)[0]!.id;
    const gripId = INPUT.parts.grip.id;
    const narrow = variantsFor(reg, 'sword', 'strike', 1).find((p) => p.stepMax < 5)!;
    const cases: [string, CraftInput, RegExp][] = [
      ['неизвестная', { ...INPUT, parts: { ...INPUT.parts, strike: { id: 'no-such-part', step: 2 } } }, /Нет такой детали/],
      ['чужого класса', { ...INPUT, parts: { ...INPUT.parts, strike: { id: axeStrike, step: 2 } } }, /не подходит|не для/],
      ['чужого гнезда', { ...INPUT, parts: { ...INPUT.parts, strike: { id: gripId, step: 2 } } }, /не для этого гнезда/],
      ['ступень вне окна', { ...INPUT, parts: { ...INPUT.parts, strike: { id: narrow.id, step: narrow.stepMax + 1 } } }, /куётся только/],
      ['не то семейство', { ...INPUT, hands: 2 }, /не подходит|не задаёт/],
      ['нет класса', { ...INPUT, weaponClass: 'lightsaber' }, /не знает|Нет такой/],
    ];
    for (const [label, input, re] of cases) {
      const save = mkSave(), stash = mkStash();
      const before = frozen(save, stash);
      const r = craftAction(reg, save, stash, NONCE, input, createRng(1));
      expect(r.ok, label).toBe(false);
      expectRefused(r, before, save, stash, re);
    }
    const off = regWith((d) => {
      allMaterials(d);
      const p = rows<{ id: string; enabled: boolean }>(d, 'weapon-parts').find((x) => x.id === INPUT.parts.head.id)!;
      p.enabled = false;
    });
    const save = mkSave(), stash = mkStash();
    const before = frozen(save, stash);
    expectRefused(craftAction(off, save, stash, NONCE, INPUT, createRng(1)), before, save, stash, /Нет такой детали/);
  });

  it('⚠ ворота журнала: база, деталь, потолок ступени, мифики', () => {
    const t2 = craftWeapon(reg, INPUT).tier!;
    const probe = (j: CraftJournal, input: CraftInput, re: RegExp): void => {
      const save = mkSave(), stash = mkStash(j);
      const before = frozen(save, stash);
      expectRefused(craftAction(reg, save, stash, NONCE, input, createRng(1)), before, save, stash, re);
    };
    probe({ ...journalFor(INPUT, 6, 99), bases: [] }, INPUT, /не открыт/);
    probe({ ...journalFor(INPUT, 6, 99), variants: journalFor(INPUT, 6).variants.slice(1) }, INPUT, /не открыта/);
    probe(journalFor(INPUT, t2 - 1, 99), INPUT, /не работал со ступенью/);
    // Мифик: ступень t6 при поднятом потолке, но разобрано меньше `mythicSalvages`.
    const top = inputAt(reg, 'sword', 1, 5);
    const pvTop = craftWeapon(reg, top);
    expect(pvTop.tier, 'сборка из ступени 5 даёт t6').toBe(6);
    const need = reg.get('balance').craft.journal.mythicSalvages;
    probe(journalFor(top, 6, need - 1), top, /Мифическую/);
    // И при всех воротах открытыми — куётся.
    const save = mkSave(), stash = mkStash(journalFor(top, 6, need));
    expect(craftAction(reg, save, stash, NONCE, top, createRng(1)).ok).toBe(true);
  });

  it('⚠ кривая заявка: лишние ключи, не те типы, не четыре гнезда, доводка вне списка', () => {
    const finishN = reg.get('balance').craft.finish.length;
    const withPick = (slot: CraftSlot, pick: unknown): unknown => ({ ...INPUT, parts: { ...INPUT.parts, [slot]: pick } });
    const bad: [string, unknown][] = [
      ['null', null], ['массив', [INPUT]], ['строка', 'sword'], ['число', 7],
      ['лишний ключ заявки', { ...INPUT, affixCap: { prefix: 3, suffix: 3 } }],
      ['лишний ключ детали', withPick('strike', { ...INPUT.parts.strike, damageMult: 9 })],
      ['пятое гнездо', { ...INPUT, parts: { ...INPUT.parts, extra: INPUT.parts.head } }],
      ['три гнезда', { ...INPUT, parts: { strike: INPUT.parts.strike, grip: INPUT.parts.grip, bind: INPUT.parts.bind } }],
      ['детали массивом', { ...INPUT, parts: CRAFT_SLOT_LIST.map((s) => INPUT.parts[s]) }],
      ['id не строка', withPick('grip', { id: 5, step: 2 })],
      ['id пустой', withPick('grip', { id: '', step: 2 })],
      ['ступень дробная', withPick('grip', { id: INPUT.parts.grip.id, step: 2.5 })],
      ['ступень строкой', withPick('grip', { id: INPUT.parts.grip.id, step: '2' })],
      ['ступень 0', withPick('grip', { id: INPUT.parts.grip.id, step: 0 })],
      ['ступень 6', withPick('grip', { id: INPUT.parts.grip.id, step: 6 })],
      ['ступень NaN', withPick('grip', { id: INPUT.parts.grip.id, step: Number.NaN })],
      ['ступень ∞', withPick('grip', { id: INPUT.parts.grip.id, step: Infinity })],
      ['хват 3', { ...INPUT, hands: 3 }], ['хват строкой', { ...INPUT, hands: '1' }], ['хват 1.5', { ...INPUT, hands: 1.5 }],
      ['класс не строка', { ...INPUT, weaponClass: 1 }], ['класс длинный', { ...INPUT, weaponClass: 's'.repeat(65) }],
      ['доводка −1', { ...INPUT, finish: -1 }], ['доводка дробная', { ...INPUT, finish: 1.5 }],
      ['доводка за списком', { ...INPUT, finish: finishN }], ['доводка 99', { ...INPUT, finish: 99 }],
      ['доводка строкой', { ...INPUT, finish: '1' }], ['доводка null', { ...INPUT, finish: null }],
      ['__proto__ в заявке', JSON.parse(`{"weaponClass":"sword","hands":1,"parts":${JSON.stringify(INPUT.parts)},"__proto__":{"finish":3}}`)],
      ['__proto__ в деталях', { ...INPUT, parts: JSON.parse(`{${CRAFT_SLOT_LIST.map((s) => `"${s}":${JSON.stringify(INPUT.parts[s])}`).join(',')},"__proto__":{}}`) }],
    ];
    for (const [label, input] of bad) {
      const save = mkSave(), stash = mkStash();
      const before = frozen(save, stash);
      const r = craftAction(reg, save, stash, NONCE, input, createRng(1));
      expect(r.ok, label).toBe(false);
      expectRefused(r, before, save, stash);
    }
  });

  it('⭐ ФАЗЗ: тысячи заявок из настоящих и чужих деталей — ни одного исключения, отказ всегда байт в байт, успех платит ровно цену', () => {
    const rng = createRng(777);
    const classes = [...new Set(reg.get('weapon-anatomy').map((a) => a.id))];
    const allParts = reg.get('weapon-parts').map((p) => p.id);
    const junk: unknown[] = [undefined, null, 0, -1, 2.5, '', 'x', [], {}, { id: 'sw-a-x' }, Number.NaN, true];
    let ok = 0, refused = 0;
    for (let n = 0; n < 3000; n++) {
      const cls = rng.chance(0.9) ? rng.pick(classes) : rng.pick(junk);
      const hands = rng.chance(0.9) ? rng.int(1, 2) : rng.pick(junk);
      const parts: Record<string, unknown> = {};
      for (const slot of CRAFT_SLOT_LIST) {
        const own = typeof cls === 'string' ? variantsFor(reg, cls, slot, typeof hands === 'number' ? hands : 1) : [];
        const roll = rng.next();
        parts[slot] = roll < 0.75 && own.length ? { id: rng.pick(own).id, step: rng.int(1, 5) }
          : roll < 0.9 ? { id: rng.pick(allParts), step: rng.int(0, 6) }
          : rng.pick(junk);
      }
      if (rng.chance(0.05)) delete parts[rng.pick(CRAFT_SLOT_LIST)];
      const input: Record<string, unknown> = { weaponClass: cls, hands, parts };
      if (rng.chance(0.3)) input.finish = rng.chance(0.8) ? rng.int(-1, 5) : rng.pick(junk);
      if (rng.chance(0.03)) input.cheat = 1;
      const save = mkSave(rng.chance(0.2) ? rng.int(0, 2000) : 1_000_000);
      const stash = mkStash(rng.chance(0.3) ? emptyJournal() : fullJournal(reg));
      const before = frozen(save, stash);
      let r: { ok: boolean; reason?: string; uid?: string } = { ok: false };
      expect(() => { r = craftAction(reg, save, stash, nextNonce(), input, createRng(n + 1)); }, JSON.stringify(input)).not.toThrow();
      if (!r.ok) { refused++; expect(frozen(save, stash), `${r.reason} ${JSON.stringify(input)}`).toBe(before); continue; }
      ok++;
      const pv = craftWeapon(reg, input as unknown as CraftInput);
      const got = save.inventory.find((i) => i.uid === r.uid)!;
      expect(got.parts).toEqual(input.parts);
      expect(save.gold).toBe(JSON.parse(before)[0].gold - pv.cost!.gold);
      for (const [id, need] of Object.entries(pv.cost!.materials)) expect(stash.materials![id]).toBe(INF - need);
    }
    expect(ok, 'фазз доходит до успешной ковки').toBeGreaterThan(100);
    expect(refused).toBeGreaterThan(500);
  });

  it('доводка по индексу: верхняя строка платит СВОЕЙ ценой, а не прижатой', () => {
    const top = reg.get('balance').craft.finish.length - 1;
    const input = { ...INPUT, finish: top };
    const pv = craftWeapon(reg, input);
    const save = mkSave(), stash = mkStash();
    expect(craftAction(reg, save, stash, NONCE, input, createRng(1)).ok).toBe(true);
    expect(save.gold).toBe(1_000_000 - pv.cost!.gold);
    expect(pv.cost!.finish?.index).toBe(top);
  });
});

// ── Зачарование ──────────────────────────────────────────────────────────────────────────────────

/** Скованная обычная вещь в сумке (через само действие — как в игре). */
function forged(r: ConfigRegistry = reg, input: CraftInput = inputAt(reg, 'sword', 1, 4)): { save: SaveState; item: Item } {
  const save = mkSave(1_000_000);
  const stash: AccountStash = { ...emptyStash(r), materials: fullWallet(r), forgeJournal: fullJournal(r) };
  const res = craftAction(r, save, stash, nextNonce(), input, createRng(9));
  expect(res.ok, res.reason).toBe(true);
  return { save, item: save.inventory.find((i) => i.uid === res.uid)! };
}
const noStash = emptyStash(reg);

describe('⭐ enchantAction — зачарование скованной', () => {
  it('до редкого: ровно объявленная форма, цена ровно enchantCost, тот же uid и место', () => {
    const { save, item } = forged();
    const cost = enchantCost(reg, item, 'rare');
    const gold0 = save.gold;
    const r = enchantAction(reg, save, item.uid, 'rare', createRng(3));
    expect(r.ok, r.reason).toBe(true);
    const got = save.inventory.find((i) => i.uid === item.uid)!;
    expect(got.rarity).toBe('rare');
    expect(got.pos).toEqual(item.pos);
    expect(save.gold).toBe(gold0 - cost);
    const kinds = new Map(got.affixes.map((a) => [a.affixId, a.kind]));
    const p = [...kinds.values()].filter((k) => k === 'prefix').length;
    expect({ p, s: kinds.size - p }).toEqual({ p: item.affixCap!.prefix, s: item.affixCap!.suffix });
  });

  it('⚠ только скованная, обычная, в сумке; редкость — только magic/rare', () => {
    const { save, item } = forged();
    const found = generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'),
      { dropBias: 1, itemLevel: 20, baseId: 'long-sword', tiers: reg.get('item-tiers'), rarities: reg.get('rarities'), forceRarity: 'normal' }, createRng(5));
    save.inventory.push({ ...found, pos: { x: 5, y: 0 } });
    const before = frozen(save, noStash);
    for (const [uid, rarity, re] of [
      [found.uid, 'rare', /только скованную/], ['нет-такой', 'rare', /не в инвентаре/],
      [item.uid, 'unique', /магической или редкой/], [item.uid, 'normal', /магической или редкой/], [item.uid, 'legendary', /магической или редкой/],
    ] as const) {
      expectRefused(enchantAction(reg, save, uid, rarity, createRng(1)), before, save, noStash, re);
    }
    expectRefused(enchantAction(reg, save, item.uid, undefined as unknown as string, createRng(1)), before, save, noStash);
    // Уже зачарованная — второй раз нельзя (в том числе «перекатить» зачарованием).
    expect(enchantAction(reg, save, item.uid, 'magic', createRng(1)).ok).toBe(true);
    const after = frozen(save, noStash);
    expectRefused(enchantAction(reg, save, item.uid, 'rare', createRng(1)), after, save, noStash, /уже зачарована/);
    // Надетая — не в сумке.
    const eq = forged();
    const worn = eq.save.inventory.splice(eq.save.inventory.findIndex((i) => i.uid === eq.item.uid), 1)[0]!;
    (eq.save as unknown as { equipment: Record<string, Item> }).equipment = { weapon: worn };
    const b2 = frozen(eq.save, noStash);
    expectRefused(enchantAction(reg, eq.save, worn.uid, 'rare', createRng(1)), b2, eq.save, noStash, /не в инвентаре/);
  });

  it('⚠ золота на рубль меньше цены — отказ до броска', () => {
    const { save, item } = forged();
    save.gold = enchantCost(reg, item, 'rare') - 1;
    const before = frozen(save, noStash);
    expectRefused(enchantAction(reg, save, item.uid, 'rare', createRng(1)), before, save, noStash, /золота/);
  });

  it('⭐ пул не наберёт оплаченную форму — отказ ДО оплаты (§17), хотя бросок недобрал бы молча', () => {
    const noSuffix = regWith((d) => { allMaterials(d); for (const a of rows<{ kind: string; enabled: boolean }>(d, 'affixes')) if (a.kind === 'suffix') a.enabled = false; });
    const { save, item } = forged(noSuffix);
    expect(item.affixCap!.suffix, 'форма просит суффиксы').toBeGreaterThan(0);
    // Без проверки игрок заплатил бы за P+S слотов, а получил бы только префиксы.
    const silently = enchantItem(noSuffix, item, 'rare', createRng(1))!;
    expect(new Set(silently.affixes.map((a) => a.affixId)).size).toBeLessThan(item.affixCap!.prefix + item.affixCap!.suffix);
    const before = frozen(save, noStash);
    expectRefused(enchantAction(noSuffix, save, item.uid, 'rare', createRng(1)), before, save, noStash, /не хватит свойств/);
  });

  it('⚠ базы нет в конфиге — явный отказ, а не «вещь как была» за деньги', () => {
    const { save, item } = forged();
    const i = save.inventory.findIndex((x) => x.uid === item.uid);
    save.inventory[i] = { ...item, baseId: 'no-such-base' };
    const before = frozen(save, noStash);
    expectRefused(enchantAction(reg, save, item.uid, 'rare', createRng(1)), before, save, noStash, /не знает/);
    expect(enchantItem(reg, save.inventory[i]!, 'rare', createRng(1)), 'ядро сигналит отказ').toBeNull();
  });
});

describe('affixSlotsFillable — «пул наберёт форму при любом броске»', () => {
  const tpl = reg.get('affixes')[0]!;
  const mk = (id: string, kind: 'prefix' | 'suffix', group?: string): typeof tpl =>
    ({ ...tpl, id, kind, group: group ?? '', appliesTo: [], exclude: [], weight: 1, tagWeights: [], onMagic: true, onRare: true, enabled: true, stat: 'minDamage', modKind: 'flat', tiers: [{ min: 1, max: 2, ilvl: 1 }], mods: undefined, proc: undefined });
  const slots = (P: number, S: number, total: number): { minAffixes: number; maxAffixes: number; maxPrefix: number; maxSuffix: number } =>
    ({ minAffixes: total, maxAffixes: total, maxPrefix: P, maxSuffix: S });
  const fills = (pool: (typeof tpl)[], s: ReturnType<typeof slots>, seed: number): number =>
    new Set(rollAffixes(pool, { kind: 'weapon' }, 'rare', s, 99, createRng(seed)).map((a) => a.affixId)).size;

  it('смешанная группа съедает сторону: префикс из группы выносит и единственный суффикс', () => {
    const pool = [mk('a', 'prefix', 'g'), mk('b', 'suffix', 'g'), mk('c', 'prefix')];
    expect(affixSlotsFillable(pool, slots(1, 1, 2))).toBe(false);
    // И это не теория: бросок действительно недобирает.
    const got = Array.from({ length: 200 }, (_, i) => fills(pool, slots(1, 1, 2), i + 1));
    expect(Math.min(...got)).toBe(1);
    expect(affixSlotsFillable([...pool, mk('d', 'suffix')], slots(1, 1, 2))).toBe(true);
  });

  it('пустой пул и нулевая форма', () => {
    expect(affixSlotsFillable([], slots(0, 0, 0))).toBe(true);
    expect(affixSlotsFillable([], slots(1, 0, 1))).toBe(false);
    expect(affixSlotsFillable([mk('a', 'prefix')], slots(0, 1, 1))).toBe(false);
  });

  it('⭐ НАДЁЖНОСТЬ: «наберёт» → бросок набирает при любом сиде (случайные пулы с группами)', () => {
    const rng = createRng(2024);
    let checked = 0;
    for (let n = 0; n < 400; n++) {
      const size = rng.int(0, 8);
      const pool = Array.from({ length: size }, (_, i) =>
        mk(`x${i}`, rng.chance(0.5) ? 'prefix' : 'suffix', rng.chance(0.5) ? `g${rng.int(1, 3)}` : undefined));
      const P = rng.int(0, 3), S = rng.int(0, 3);
      const s = slots(P, S, rng.int(0, P + S));
      if (!affixSlotsFillable(pool, s)) continue;
      checked++;
      for (let seed = 1; seed <= 60; seed++) expect(fills(pool, s, seed), JSON.stringify({ pool: pool.map((a) => [a.id, a.kind, a.group]), s, seed })).toBe(s.maxAffixes);
    }
    expect(checked, 'проверка не пустая').toBeGreaterThan(100);
  });

  it('на настоящем пуле любая скованная форма любого класса наберётся', () => {
    for (const cls of ['sword', 'axe', 'mace', 'bow', 'wand', 'staff']) {
      const { item } = forged(reg, inputAt(reg, cls, cls === 'bow' || cls === 'staff' ? 2 : 1, 3));
      for (const rarity of ['magic', 'rare'] as const) {
        const rDef = reg.get('rarities').find((r) => r.id === rarity);
        const s = affixSlotsFor(rDef, item.affixCap);
        expect(enchantAction(reg, { gold: 1e9, inventory: [structuredClone(item)] } as unknown as SaveState, item.uid, rarity, createRng(1)).ok, `${cls} ${rarity} ${JSON.stringify(s)}`).toBe(true);
      }
    }
  });
});

describe('D15: перекатка скованной держит форму и не поднимает редкость', () => {
  it('редкая: ровно форма; магическая: не больше формы и не выше магической', () => {
    for (const rarity of ['rare', 'magic'] as const) {
      const { save, item } = forged();
      expect(enchantAction(reg, save, item.uid, rarity, createRng(2)).ok).toBe(true);
      const cap = item.affixCap!;
      for (let i = 0; i < 3; i++) {
        expect(forgeReroll(reg, save, item.uid, createRng(70 + i)).ok).toBe(true);
        const it = save.inventory.find((x) => x.uid === item.uid)!;
        expect(it.rarity).toBe(rarity);
        const kinds = new Map(it.affixes.map((a) => [a.affixId, a.kind]));
        const p = [...kinds.values()].filter((k) => k === 'prefix').length;
        const s = kinds.size - p;
        expect(p).toBeLessThanOrEqual(cap.prefix);
        expect(s).toBeLessThanOrEqual(cap.suffix);
        if (rarity === 'rare') expect({ p, s }).toEqual({ p: cap.prefix, s: cap.suffix });
        else expect(p + s).toBeLessThanOrEqual(2);
      }
    }
  });

  it('⚠ пул не наберёт форму — перекатка отказывает до платы', () => {
    const noSuffix = regWith((d) => { allMaterials(d); for (const a of rows<{ kind: string; enabled: boolean }>(d, 'affixes')) if (a.kind === 'suffix') a.enabled = false; });
    const { save, item } = forged(noSuffix);
    const i = save.inventory.findIndex((x) => x.uid === item.uid);
    save.inventory[i] = { ...item, rarity: 'rare' };
    const before = frozen(save, noStash);
    expectRefused(forgeReroll(noSuffix, save, item.uid, createRng(1)), before, save, noStash, /не хватит свойств/);
  });
});

describe('⚠ R2-13: у обычной и уникальной перекатывать нечего — отказ ДО платы', () => {
  it('скованная обычная (такой выходит КАЖДАЯ ковка): отказ байт в байт, и зачарованная потом получает все перекатки', () => {
    const { save, item } = forged();
    expect(item.rarity).toBe('normal');
    const before = frozen(save, noStash);
    // Было: 264 золота за ноль аффиксов и минус одна из трёх перекаток, которую зачарованная вещь потом наследовала.
    expectRefused(forgeReroll(reg, save, item.uid, createRng(1)), before, save, noStash, /нечего перекатывать/);
    expect(enchantAction(reg, save, item.uid, 'rare', createRng(2)).ok).toBe(true);
    let n = 0;
    while (n < 10 && forgeReroll(reg, save, item.uid, createRng(10 + n)).ok) n++;
    expect(n).toBe(reg.get('balance').forgePrices.rerollLimit);
  });

  it('найденная обычная (стартовое оружие) — отказ; уникальная — отказ, и её свойства целы', () => {
    for (const [rarity, re] of [['normal', /нечего перекатывать/], ['unique', /Уникальные/]] as const) {
      const it = foundSword(rarity, 5);
      expect(it.rarity).toBe(rarity);
      const save = mkSave(1_000_000, [it]);
      const before = frozen(save, noStash);
      expectRefused(forgeReroll(reg, save, it.uid, createRng(1)), before, save, noStash, re);
    }
  });

  it('магическая и редкая найденные перекатываются по-прежнему', () => {
    for (const rarity of ['magic', 'rare'] as const) {
      const it = foundSword(rarity, 5);
      const save = mkSave(1_000_000, [it]);
      expect(forgeReroll(reg, save, it.uid, createRng(1)).ok, rarity).toBe(true);
      expect(save.inventory[0]!.affixes.length, rarity).toBeGreaterThan(0);
    }
  });
});

describe('⚠ R2-10 / R2-23: форма свойств в цене — платят за ту форму, которую КАТАЮТ', () => {
  /** Скованная обычная вещь нужной формы на ступени `step`: перебор обвязок (форму задаёт она, §6). */
  function forgedForm(step: number, form: string): Item {
    for (const bind of variantsFor(reg, 'sword', 'bind', 1)) {
      if (bind.stepMin > step || step > bind.stepMax) continue;
      const base = inputAt(reg, 'sword', 1, step);
      const input = { ...base, parts: { ...base.parts, bind: { id: bind.id, step } } };
      const pv = craftWeapon(reg, input);
      if (pv.ok && `${pv.item!.affixCap!.prefix}+${pv.item!.affixCap!.suffix}` === form) return forged(reg, input).item;
    }
    throw new Error(`нет обвязки с формой ${form} на ступени ${step}`);
  }
  const paidFor = (save: SaveState, act: () => { ok: boolean; reason?: string }): number => {
    const g0 = save.gold;
    const r = act();
    expect(r.ok, r.reason).toBe(true);
    return g0 - save.gold;
  };

  for (const [step, form, tier] of [[4, '3+2', 't5'], [3, '2+2', 't3']] as const) {
    it(`R2-10: ${form} на ${tier}, зачарованная до редкой, — перекатка не дешевле самого зачарования`, () => {
      const item = forgedForm(step, form);
      expect(item.tier).toBe(tier);
      const save = mkSave(10_000_000, [item]);
      const enchant = enchantCost(reg, item, 'rare');
      expect(paidFor(save, () => enchantAction(reg, save, item.uid, 'rare', createRng(3)))).toBe(enchant);
      // Было: 1 958 за полный набор 3+2 против 9 743 за зачарование — три броска формы со скидкой 80 %.
      for (let i = 0; i < reg.get('balance').forgePrices.rerollLimit; i++) {
        expect(paidFor(save, () => forgeReroll(reg, save, item.uid, createRng(40 + i))), `перекатка ${i + 1}`).toBeGreaterThanOrEqual(enchant);
      }
    });
  }

  it('R2-23: 3+2 на t5 до МАГИЧЕСКОЙ катает 1+1 — и платит как 1+1 той же ступени, а не ×5.97', () => {
    const item = forgedForm(4, '3+2');
    const asOneOne = { ...item, affixCap: { prefix: 1, suffix: 1 } };
    const want = enchantCost(reg, asOneOne, 'magic');
    expect(enchantCost(reg, item, 'magic')).toBe(want);
    // Редкая катает ровно 3+2 — её цена по-прежнему с множителем формы.
    expect(enchantCost(reg, item, 'rare')).toBeGreaterThan(enchantCost(reg, asOneOne, 'rare') * 5);
    const save = mkSave(10_000_000, [item]);
    expect(paidFor(save, () => enchantAction(reg, save, item.uid, 'magic', createRng(3)))).toBe(want);
    const magic = save.inventory[0]!;
    expect(magic.affixes.length).toBeLessThanOrEqual(2);
    // Перекатка магической — тоже по форме 1+1: так же, как у магической вещи формы 1+1.
    expect(paidFor(save, () => forgeReroll(reg, save, item.uid, createRng(5))))
      .toBe(forgeGold(reg, { ...magic, affixCap: { prefix: 1, suffix: 1 } }, 'reroll'));
  });
});

// ── Разбор ───────────────────────────────────────────────────────────────────────────────────────

const foundSword = (rarity: Item['rarity'] = 'normal', seed = 11): Item => ({
  ...generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'),
    { dropBias: 1, itemLevel: 30, baseId: 'long-sword', tiers: reg.get('item-tiers'), rarities: reg.get('rarities'), forceRarity: rarity, origin: 'drop' }, createRng(seed)),
  pos: { x: 0, y: 0 },
});
const bagUnits = (inv: readonly Item[]): Record<string, number> => carriedMaterials(inv);
const sum = (m: Record<string, number>): number => Object.values(m).reduce((a, b) => a + b, 0);
/** Бросок «всегда максимум»: полевые доли округляются вверх — детерминированно. */
const MAX: SalvageRng = { int: (_a, b) => b, chance: () => true };

describe('⭐ forgeSalvage — разбор у кузнеца (D6)', () => {
  it('найденное оружие: сырьё ровно из его деталей + открытие в журнале, строками для окна', () => {
    const it = foundSword();
    const save = mkSave(0, [it]), stash = emptyStash(reg);
    const want = craftSalvageYield(reg, it);
    const parts = partsOf(reg, it)!;
    const r = forgeSalvage(reg, save, stash, it.uid, createRng(1));
    expect(r.ok, r.reason).toBe(true);
    expect(save.inventory.some((i) => i.uid === it.uid)).toBe(false);
    expect(bagUnits(save.inventory)).toEqual(want);
    const j = stash.forgeJournal!;
    expect(j.bases).toEqual(['long-sword']);
    expect([...j.variants].sort()).toEqual([...new Set(CRAFT_SLOT_LIST.map((s) => parts[s].id))].sort());
    expect(j).toEqual(salvageIntoJournal(reg, emptyJournal(), it).journal);
    expect(r.unlocked!.some((s) => s.startsWith('Тип «'))).toBe(true);
    expect(r.unlocked!.filter((s) => s.startsWith('Деталь «')).length).toBeGreaterThanOrEqual(1);
    // Повторный разбор такой же вещи нового не открывает — но сырьё даёт.
    const again = foundSword('normal', 11);
    save.inventory.push({ ...again, uid: it.uid + '-2', foundParts: parts });
    const r2 = forgeSalvage(reg, save, stash, it.uid + '-2', createRng(1));
    expect(r2.ok).toBe(true);
    expect(r2.unlocked!.some((s) => s.startsWith('Деталь «') || s.startsWith('Тип «'))).toBe(false);
  });

  it('⭐ скованное — ПЕРЕПЛАВКА: ровно meltReturn, журнал не тронут, открытий нет', () => {
    const { save, item } = forged();
    expect(enchantAction(reg, save, item.uid, 'rare', createRng(1)).ok).toBe(true);
    const rare = save.inventory.find((i) => i.uid === item.uid)!;
    const stash = emptyStash(reg);
    const journal0 = JSON.stringify(stash.forgeJournal);
    const bag0 = bagUnits(save.inventory);
    const r = forgeSalvage(reg, save, stash, item.uid, createRng(1));
    expect(r.ok, r.reason).toBe(true);
    expect(r.unlocked).toBeUndefined();
    const gained = Object.fromEntries(Object.entries(bagUnits(save.inventory)).map(([id, n]) => [id, n - (bag0[id] ?? 0)]).filter(([, n]) => (n as number) > 0));
    expect(gained, 'зачарованная до редкой отдаёт то же, что обычная: редкость не в счёт').toEqual(meltReturn(reg, rare));
    expect(JSON.stringify(stash.forgeJournal)).toBe(journal0);
  });

  it('⚠ скованное не ходит путём «по редкости» — и формулы это держат сами', () => {
    const { item } = forged();
    const rules = reg.get('salvage-rules'), tuning = reg.get('balance').salvage;
    expect(canSalvage({ ...item, rarity: 'rare' }, 'sword', rules, tuning, false).ok).toBe(false);
    expect(canSalvageItem(reg, item, false).ok, 'кнопка кузницы при этом доступна: переплавка').toBe(true);
    const range = salvageRange(reg, item, false).range;
    expect(Object.fromEntries(Object.entries(range).map(([id, r]) => [id, r.max]))).toEqual(meltReturn(reg, item));
    for (const r of Object.values(range)) expect(r.min).toBe(r.max);
  });

  it('деталь выключили ПОСЛЕ ковки — вещь всё равно переплавляется', () => {
    const { item } = forged();
    const off = regWith((d) => {
      allMaterials(d);
      for (const p of rows<{ id: string; enabled: boolean }>(d, 'weapon-parts')) if (p.id === item.parts!.strike.id) p.enabled = false;
    });
    expect(meltReturn(off, item)).toEqual(meltReturn(reg, item));
    const save = mkSave(0, [item]), stash = emptyStash(off);
    expect(forgeSalvage(off, save, stash, item.uid, createRng(1)).ok).toBe(true);
  });

  it('⚠ уникальное — отказ; чужой uid — отказ; всё байт в байт', () => {
    const u = { ...foundSword(), uid: 'uniq', rarity: 'unique' as const };
    const save = mkSave(0, [u]), stash = emptyStash(reg);
    const before = frozen(save, stash);
    expectRefused(forgeSalvage(reg, save, stash, 'uniq', createRng(1)), before, save, stash, /Уникальные/);
    expectRefused(forgeSalvage(reg, save, stash, 'нет', createRng(1)), before, save, stash, /не в инвентаре/);
    expectRefused(fieldSalvage(reg, save, 'uniq', createRng(1)), before, save, stash, /Уникальные/);
  });

  it('⭐ не влезло в сумку — в кошелёк сундука; ни единицы не потеряно', () => {
    const tight = regWith((d) => { allMaterials(d); (d.balance as { inventory: { materialStack: number } }).inventory.materialStack = 1; });
    const it = foundSword();
    const want = craftSalvageYield(tight, it);
    expect(sum(want), 'сырья больше, чем клеток под мечом').toBeGreaterThan(it.gridW * it.gridH);
    const dims = tight.get('balance').inventory;
    const junk: Item[] = [];
    for (let y = 0; y < dims.rows; y++) for (let x = 0; x < dims.cols; x++) {
      if (x < it.gridW && y < it.gridH) continue;       // клетки под мечом
      junk.push({ uid: `j${x}-${y}`, baseId: 'junk', name: 'хлам', rarity: 'normal', itemLevel: 1, requirements: {}, affixes: [], baseStats: [], gridW: 1, gridH: 1, pos: { x, y } });
    }
    const save = mkSave(0, [it, ...junk]), stash = emptyStash(tight);
    expect(forgeSalvage(tight, save, stash, it.uid, createRng(1)).ok).toBe(true);
    const inBag = bagUnits(save.inventory);
    for (const [id, n] of Object.entries(want)) expect((inBag[id] ?? 0) + (stash.materials![id] ?? 0), id).toBe(n);
    expect(sum(stash.materials!), 'часть ушла в сундук').toBeGreaterThan(0);
  });

  it('броня — прежним правилом по редкости, журнал не тронут', () => {
    const armorBase = reg.get('items.base').find((b) => b.kind === 'armor' && b.enabled !== false)!;
    const arm = { ...generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'),
      { dropBias: 1, itemLevel: 10, baseId: armorBase.id, tiers: reg.get('item-tiers'), rarities: reg.get('rarities'), forceRarity: 'normal' }, createRng(3)), pos: { x: 0, y: 0 } };
    const save = mkSave(0, [arm]), stash = emptyStash(reg);
    const j0 = JSON.stringify(stash.forgeJournal);
    const r = forgeSalvage(reg, save, stash, arm.uid, createRng(1));
    expect(r.ok, r.reason).toBe(true);
    expect(r.unlocked).toBeUndefined();
    expect(sum(bagUnits(save.inventory))).toBeGreaterThan(0);
    expect(JSON.stringify(stash.forgeJournal)).toBe(j0);
  });
});

describe('⭐ fieldSalvage — разбор в поле (D6)', () => {
  it('оружие: доля деталей, журнала нет вовсе (сундук в поле не участвует)', () => {
    const it = foundSword();
    const save = mkSave(0, [it]);
    const full = craftSalvageYield(reg, it);
    const share = reg.get('balance').salvage.fieldYield;
    expect(fieldSalvage(reg, save, it.uid, MAX).ok).toBe(true);
    const got = bagUnits(save.inventory);
    for (const [id, n] of Object.entries(full)) expect(got[id] ?? 0, id).toBe(Math.ceil(n * share - 1e-9));
    expect(sum(got)).toBeLessThan(sum(full));
  });

  it('скованное в поле: доля переплавки', () => {
    const { save, item } = forged();
    const melt = meltReturn(reg, item);
    const share = reg.get('balance').salvage.fieldYield;
    const bag0 = bagUnits(save.inventory);
    expect(fieldSalvage(reg, save, item.uid, MAX).ok).toBe(true);
    const got = bagUnits(save.inventory);
    for (const [id, n] of Object.entries(melt)) expect((got[id] ?? 0) - (bag0[id] ?? 0), id).toBe(Math.ceil(n * share - 1e-9));
  });

  it('⚠ сумка не вместит сырьё — отказ ДО разбора, вещь цела', () => {
    const tight = regWith((d) => { allMaterials(d); (d.balance as { inventory: { materialStack: number } }).inventory.materialStack = 1; });
    const it = { ...foundSword(), gridW: 1, gridH: 1 };
    const dims = tight.get('balance').inventory;
    const junk: Item[] = [];
    for (let y = 0; y < dims.rows; y++) for (let x = 0; x < dims.cols; x++) {
      if (x === 0 && y === 0) continue;
      junk.push({ uid: `j${x}-${y}`, baseId: 'junk', name: 'хлам', rarity: 'normal', itemLevel: 1, requirements: {}, affixes: [], baseStats: [], gridW: 1, gridH: 1, pos: { x, y } });
    }
    const save = mkSave(0, [it, ...junk]);
    const before = frozen(save, noStash);
    expectRefused(fieldSalvage(tight, save, it.uid, MAX), before, save, noStash, /Сумка полна/);
  });
});

describe('⚠ R2-28: выключенный материал разбор НЕ выдаёт — ни по деталям, ни переплавкой', () => {
  /** Дизайнер придержал верх лестницы («булат — позже»): ступени 4–5 выключены. */
  const hiOff = regWith((d) => { for (const m of rows<{ enabled: boolean; tier: number }>(d, 'craft-materials')) m.enabled = m.tier < 4; });
  const off = new Set(hiOff.get('craft-materials').filter((m) => !m.enabled).map((m) => m.id));
  const mats = hiOff.get('craft-materials');
  const deep = (baseId: string, seed: number): Item => ({
    ...generateItem(hiOff.get('items.base'), hiOff.get('affixes'), hiOff.get('uniques'),
      { dropBias: 1, itemLevel: 85, tierLevel: 85, baseId, tiers: hiOff.get('item-tiers'), rarities: hiOff.get('rarities'), forceRarity: 'normal', origin: 'drop' }, createRng(seed)),
    pos: { x: 0, y: 0 },
  });
  const disabledIn = (m: Record<string, number>): string[] => Object.keys(m).filter((id) => off.has(id));
  const worth = (m: Record<string, number>): number => Math.ceil(Object.entries(m).reduce((s, [id, n]) => s + n * (mats.find((x) => x.id === id)?.sellPrice ?? 0), 0));

  it('найденное оружие t5/t6: вилка, разбор у кузнеца и в поле — только включённое; цена сырья — по нему же', () => {
    let checked = 0;
    for (const baseId of ['long-sword', 'war-axe', 'short-bow', 'flame-staff']) {
      if (!hiOff.get('items.base').some((b) => b.id === baseId)) continue;
      for (let seed = 1; seed <= 4; seed++) {
        const it = deep(baseId, seed);
        const parts = partsOf(hiOff, it);
        if (!parts || !CRAFT_SLOT_LIST.some((s) => parts[s].step >= 4)) continue;
        const raw = craftSalvageYield(hiOff, it);
        expect(disabledIn(raw).length, `${baseId}: детали из выключенных ступеней — проверка не пустая`).toBeGreaterThan(0);
        const hi = salvageYield(hiOff, it, MAX, false);
        expect(hi.ok, hi.reason).toBe(true);
        expect(disabledIn(hi.gains), `${baseId} вилка`).toEqual([]);
        expect(salvageWorth(hiOff, it), `${baseId}: цена сырья = цена того, что реально выдаст разбор`).toBe(worth(hi.gains));
        // Ступень спускается до ближайшей включённой той же семьи — единиц не меньше и не больше.
        const sum = (m: Record<string, number>): number => Object.values(m).reduce((a, b) => a + b, 0);
        expect(sum(hi.gains)).toBe(sum(raw));
        const save = mkSave(0, [it]), stash = emptyStash(hiOff);
        expect(forgeSalvage(hiOff, save, stash, it.uid, MAX).ok).toBe(true);
        expect(disabledIn(bagUnits(save.inventory)), `${baseId} у кузнеца`).toEqual([]);
        expect(disabledIn(stash.materials ?? {})).toEqual([]);
        const fsave = mkSave(0, [deep(baseId, seed)]);
        expect(fieldSalvage(hiOff, fsave, fsave.inventory[0]!.uid, MAX).ok).toBe(true);
        expect(disabledIn(bagUnits(fsave.inventory)), `${baseId} в поле`).toEqual([]);
        checked++;
      }
    }
    expect(checked, 'нашлись вещи с деталями верхних ступеней').toBeGreaterThan(0);
  });

  it('скованное ДО выключения переплавляется — без выключенного сырья, у кузнеца и в поле', () => {
    const { item } = forged(reg, inputAt(reg, 'sword', 1, 5));
    expect(disabledIn(meltReturn(hiOff, item)).length, 'вещь из булата — проверка не пустая').toBeGreaterThan(0);
    const range = salvageRange(hiOff, item, false);
    expect(range.ok).toBe(true);
    expect(disabledIn(Object.fromEntries(Object.entries(range.range).map(([id, r]) => [id, r.max])))).toEqual([]);
    const save = mkSave(0, [item]), stash = emptyStash(hiOff);
    expect(forgeSalvage(hiOff, save, stash, item.uid, MAX).ok).toBe(true);
    expect(disabledIn(bagUnits(save.inventory))).toEqual([]);
    const fsave = mkSave(0, [structuredClone(item)]);
    expect(fieldSalvage(hiOff, fsave, item.uid, MAX).ok).toBe(true);
    expect(disabledIn(bagUnits(fsave.inventory))).toEqual([]);
  });
});

describe('⚠ R1-12: переплавка возвращает долю ЗАПЛАЧЕННОГО, а не нынешней цены', () => {
  type Tuning = { craft: { cost: { units: Record<string, number> }; formMult: Record<string, number> } };
  /** Дизайнер ПОСЛЕ ковки поднял цену в редакторе: единицы гнёзд ×3, множители формы ×2 (§13 ждёт перекалибровки). */
  const pricier = regWith((d) => {
    allMaterials(d);
    const c = (d.balance as unknown as Tuning).craft;
    for (const s of Object.keys(c.cost.units)) c.cost.units[s]! *= 3;
    for (const f of Object.keys(c.formMult)) c.formMult[f]! *= 2;
  });
  /** Широкая обвязка: форма ёмкости с M > 1, чтобы правка множителя формы тоже была видна. */
  const wide = ((): CraftInput => {
    for (const bind of variantsFor(reg, 'sword', 'bind', 1)) {
      const input = { ...INPUT, parts: { ...INPUT.parts, bind: { id: bind.id, step: INPUT.parts.bind.step } } };
      const pv = craftWeapon(reg, input);
      if (pv.ok && pv.cost!.mult > 1) return input;
    }
    throw new Error('нет формы с M > 1');
  })();
  const diff = (a: Record<string, number>, b: Record<string, number>): Record<string, number> =>
    Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((id) => [id, (b[id] ?? 0) - (a[id] ?? 0)]).filter(([, n]) => n !== 0));

  function meltAfterRetune(enchant?: 'magic' | 'rare'): { paid: Record<string, number>; got: Record<string, number> } {
    const save = mkSave(1_000_000);
    const stash: AccountStash = { ...emptyStash(reg), materials: fullWallet(reg), forgeJournal: fullJournal(reg) };
    const w0 = { ...stash.materials! };
    const r = craftAction(reg, save, stash, nextNonce(), wide, createRng(9));
    expect(r.ok, r.reason).toBe(true);
    const paid = Object.fromEntries(Object.entries(diff(stash.materials!, w0)));   // сколько ушло из кошелька
    if (enchant) expect(enchantAction(reg, save, r.uid!, enchant, createRng(3)).ok).toBe(true);
    const bag0 = bagUnits(save.inventory), w1 = { ...stash.materials! };
    const m = forgeSalvage(pricier, save, stash, r.uid!, createRng(1));
    expect(m.ok, m.reason).toBe(true);
    const bagGot = diff(bag0, bagUnits(save.inventory)), walletGot = diff(w1, stash.materials!);
    const got: Record<string, number> = {};
    for (const src of [bagGot, walletGot]) for (const [id, n] of Object.entries(src)) got[id] = (got[id] ?? 0) + n;
    return { paid, got };
  }

  for (const enchant of [undefined, 'magic', 'rare'] as const) {
    it(`⭐ цену подняли после ковки${enchant ? ` (вещь зачарована до ${enchant})` : ''}: каждый материал возвращается МЕНЬШЕ заплаченного`, () => {
      const { paid, got } = meltAfterRetune(enchant);
      expect(Object.keys(got).length, 'переплавка что-то вернула').toBeGreaterThan(0);
      for (const [id, n] of Object.entries(got)) expect(n, `${id}: заплачено ${paid[id] ?? 0}`).toBeLessThan(paid[id] ?? 0);
    });
  }

  it('при той же цене — ровно прежняя доля: 60 % каждой строки цены, с округлением вниз', () => {
    const pv = craftWeapon(reg, wide);
    const want: Record<string, number> = {};
    const share = reg.get('balance').craft.melt.share;
    for (const l of pv.cost!.lines) { const n = Math.floor(l.n * share); if (n > 0) want[l.id] = (want[l.id] ?? 0) + n; }
    const { item } = forged(reg, wide);
    expect(meltReturn(reg, item)).toEqual(want);
    expect(meltReturn(pricier, item), 'правка цены после ковки переплавку не двигает').toEqual(want);
  });
});

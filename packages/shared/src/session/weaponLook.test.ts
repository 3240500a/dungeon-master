import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { craftWeapon, keyVariantsByBase, partsOf, shapeFoundWeapon, variantsFor, type CraftInput } from '../formulas/craft.js';
import { CRAFT_SLOT_LIST, keySlotOf } from '../formulas/craftType.js';
import { generateItem } from '../formulas/itemgen.js';
import { createRng } from '../formulas/rng.js';
import { newBotSave } from '../sim/playerBot.js';
import type { CraftParts, Item } from '../types/items.js';
import type { SaveState } from '../types/save.js';
import type { PlayerEntity } from '../world/state.js';
import type { PeerInfo } from './netTypes.js';
import { peerInfoOf } from './serialize.js';
import { weaponLookOf, weaponLookSig } from './weapon3d.js';

/**
 * ⭐ ДРУГИЕ ИГРОКИ ВИДЯТ СКОВАННОЕ (D22, К6). Кадр `peerInfo` несёт вид оружия — базу и четыре детали
 * по рукам — и НИЧЕГО больше из предмета: ни статов, ни аффиксов, ни uid, ни лишних ключей деталей.
 * Сборка вида не бросает ни на каком сейве (она зовётся на входе и после каждой команды) и не
 * перебирает ступени заново на каждой рассылке.
 */

const reg = new ConfigRegistry();
reg.loadAll();

/** Сборка семейства: в каждом гнезде первая форма, чьё окно берёт ступень `step`. */
function inputAt(cls: string, hands: number, step: number): CraftInput {
  const keySlot = keySlotOf(reg, cls);
  const group = keyVariantsByBase(reg, cls, hands).find((g) => g.variants.some((p) => p.stepMin <= step && step <= p.stepMax))!;
  const parts = {} as CraftParts;
  for (const slot of CRAFT_SLOT_LIST) {
    const pool = slot === keySlot ? group.variants : variantsFor(reg, cls, slot, hands);
    const p = pool.find((v) => v.stepMin <= step && step <= v.stepMax)!;
    parts[slot] = { id: p.id, step };
  }
  return { weaponClass: cls, hands, parts };
}
const forged = (cls = 'sword', hands = 1, step = 3): Item => {
  const pv = craftWeapon(reg, inputAt(cls, hands, step), { rng: createRng(7) });
  expect(pv.ok, pv.reason).toBe(true);
  return pv.item!;
};
/** Найденная вещь «с пола», как её рождает генератор (старый сейв: без замороженных деталей). */
const dropped = (baseId: string, seed = 11, rarity: Item['rarity'] = 'normal'): Item =>
  generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'),
    { dropBias: 1, itemLevel: 30, baseId, tiers: reg.get('item-tiers'), rarities: reg.get('rarities'), forceRarity: rarity }, createRng(seed));
const shield = (): Item => dropped(reg.get('items.base').find((b) => b.kind === 'shield' && b.enabled !== false)!.id);

function player(equipment: SaveState['equipment'], name = 'Bot'): PlayerEntity {
  const save = { ...newBotSave(reg, 'warrior'), name, equipment };
  return { id: 'p_0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', save, maxHp: 118, radius: 14 } as unknown as PlayerEntity;
}
const onlyIdStep = (parts: CraftParts): CraftParts =>
  Object.fromEntries(CRAFT_SLOT_LIST.map((s) => [s, { id: parts[s].id, step: parts[s].step }])) as unknown as CraftParts;

describe('weaponLook: из чего сделано оружие в руках (D22)', () => {
  it('скованное: база и детали ровно из вещи, больше ни одного поля', () => {
    const it0 = forged('sword', 1, 3);
    const pi = peerInfoOf(player({ weapon: it0 }), reg);
    expect(pi.weaponLook).toEqual({ main: { baseId: it0.baseId, parts: onlyIdStep(it0.parts!) } });
    // Ни uid, ни статов, ни аффиксов: ключи руки и деталей — строго по списку.
    expect(Object.keys(pi.weaponLook!.main!).sort()).toEqual(['baseId', 'parts']);
    expect(Object.keys(pi.weaponLook!.main!.parts).sort()).toEqual([...CRAFT_SLOT_LIST].sort());
    for (const s of CRAFT_SLOT_LIST) expect(Object.keys(pi.weaponLook!.main!.parts[s]).sort()).toEqual(['id', 'step']);
    const json = JSON.stringify(pi.weaponLook);
    for (const leak of [it0.uid, 'affixes', 'baseStats', 'baseRoll', 'origin', 'damageMult']) expect(json).not.toContain(leak);
  });

  it('детали — НОВЫЕ объекты: правка вида не трогает вещь в сейве', () => {
    const it0 = forged();
    const look = weaponLookOf(reg, it0, undefined)!;
    look.main!.parts.strike.step = 5; look.main!.parts.strike.id = 'x';
    expect(it0.parts!.strike.id).not.toBe('x');
  });

  it('найденное с замороженными деталями — они и едут; старая вещь — выведенные, как у разбора', () => {
    const found = shapeFoundWeapon(reg, dropped('long-sword'));
    expect(found.foundParts).toBeTruthy();
    expect(weaponLookOf(reg, found, undefined)?.main?.parts).toEqual(onlyIdStep(found.foundParts!));
    const old = dropped('long-sword', 23);
    expect(old.foundParts).toBeUndefined();
    const derived = partsOf(reg, old)!;
    expect(weaponLookOf(reg, old, undefined)?.main).toEqual({ baseId: old.baseId, parts: onlyIdStep(derived) });
  });

  it('ничего не надето → поля нет вовсе (и в JSON тоже); щит и броня вида не дают', () => {
    const pi = peerInfoOf(player({}), reg);
    expect(pi).not.toHaveProperty('weaponLook');
    expect(JSON.stringify(pi)).not.toContain('weaponLook');
    expect(peerInfoOf(player({ offhand: shield() }), reg)).not.toHaveProperty('weaponLook');
    // Без реестра статика собирается как раньше — без вида.
    expect(peerInfoOf(player({ weapon: forged() }))).not.toHaveProperty('weaponLook');
  });

  it('руки — строго как у weaponKey: щит без вида, дуал — обе, пустая главная — только вторая, двуручное — одна', () => {
    const sword = forged('sword', 1, 3), dagger = forged('dagger', 1, 2), great = forged('sword', 2, 3);
    const sh = peerInfoOf(player({ weapon: sword, offhand: shield() }), reg);
    expect(sh.weaponKey).toBe('sword+shield');
    expect(Object.keys(sh.weaponLook!)).toEqual(['main']);
    const dual = peerInfoOf(player({ weapon: sword, offhand: dagger }), reg);
    expect(dual.weaponKey).toBe('sword+dagger');
    expect(dual.weaponLook?.main?.baseId).toBe(sword.baseId);
    expect(dual.weaponLook?.off?.baseId).toBe(dagger.baseId);
    const offOnly = peerInfoOf(player({ offhand: dagger }), reg);
    expect(offOnly.weaponKey).toBe('none+dagger');
    expect(Object.keys(offOnly.weaponLook!)).toEqual(['off']);
    const two = peerInfoOf(player({ weapon: great }), reg);
    expect(two.weaponKey).toBe('greatsword');
    expect(Object.keys(two.weaponLook!)).toEqual(['main']);
  });

  it('уникальная — без вида (собрана руками, деталей у неё нет)', () => {
    const base = reg.get('uniques').find((u) => reg.get('items.base').find((b) => b.id === u.baseId)?.kind === 'weapon');
    if (!base) return;   // в конфиге нет уникального оружия — проверять нечего
    const uniq = { ...dropped(base.baseId), rarity: 'unique' } as Item;
    expect(weaponLookOf(reg, uniq, undefined)).toBeUndefined();
  });

  it('битые детали руку не дают, лишние ключи срезаются, и ничего не бросает', () => {
    const it0 = forged();
    const withParts = (parts: unknown): Item => ({ ...it0, parts: parts as CraftParts });
    const p = it0.parts!;
    for (const bad of [
      { ...p, strike: { id: p.strike.id, step: 9 } },
      { ...p, strike: { id: p.strike.id, step: 2.5 } },
      { ...p, grip: { id: 42, step: 1 } },
      { ...p, bind: { id: '', step: 1 } },
      { ...p, head: { id: 'x'.repeat(65), step: 1 } },
      { ...p, head: null },
      { strike: p.strike },
      'меч',
      [p.strike, p.grip, p.bind, p.head],
    ]) expect(weaponLookOf(reg, withParts(bad), undefined), JSON.stringify(bad)).toBeUndefined();
    const extra = JSON.parse(`{"strike":{"id":"${p.strike.id}","step":${p.strike.step},"hack":"<img>","__proto__":{"polluted":1}},"grip":${JSON.stringify(p.grip)},"bind":${JSON.stringify(p.bind)},"head":${JSON.stringify(p.head)},"evil":1}`) as unknown;
    const look = weaponLookOf(reg, withParts(extra), undefined)!;
    expect(look.main!.parts).toEqual(onlyIdStep(p));
    expect(JSON.stringify(look)).not.toMatch(/hack|evil|polluted/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // Битая база, чужой вид предмета, реестр, который бросает, — вида нет, исключения нет.
    expect(weaponLookOf(reg, { ...it0, baseId: 'y'.repeat(65) }, undefined)).toBeUndefined();
    expect(weaponLookOf(reg, { ...it0, kind: 'armor' } as Item, undefined)).toBeUndefined();
    const broken = { get: () => { throw new Error('конфиг не загружен'); } } as unknown as ConfigRegistry;
    expect(() => weaponLookOf(broken, dropped('long-sword', 5), undefined)).not.toThrow();
    expect(weaponLookOf(broken, dropped('long-sword', 5), undefined)).toBeUndefined();
  });

  it('выведенные детали старой вещи запоминаются: рассылка после каждой команды не перебирает ступени', () => {
    const olds = Array.from({ length: 8 }, (_, i) => dropped('long-sword', 100 + i));
    const t0 = performance.now();
    const first = olds.map((o) => weaponLookOf(reg, o, undefined));
    const cold = performance.now() - t0;
    const t1 = performance.now();
    for (let k = 0; k < 50; k++) for (let i = 0; i < olds.length; i++) expect(weaponLookOf(reg, olds[i], undefined)).toEqual(first[i]);
    const warm = (performance.now() - t1) / 50;
    // Тёплый проход по восьми вещам — в разы дешевле холодного: вывод не повторялся (замер: ×50–100; без памяти ≈ ×1).
    expect(warm).toBeLessThan(cold / 5);
    // Память — по содержимому вещи, не по объекту: сейв клиента приходит новым JSON каждый раз.
    const clone = JSON.parse(JSON.stringify(olds[0])) as Item;
    expect(weaponLookOf(reg, clone, undefined)).toEqual(first[0]);
    // Другая ступень у той же вещи — другой вывод (ключ памяти её учитывает).
    const tiers = reg.get('item-tiers').filter((t) => t.enabled !== false);
    const other = tiers.find((t) => t.id !== olds[0]!.tier)!;
    expect(weaponLookOf(reg, { ...olds[0]!, tier: other.id }, undefined)?.main?.parts).toEqual(onlyIdStep(partsOf(reg, { ...olds[0]!, tier: other.id })!));
  });

  it('новый конфиг (reload) сбрасывает память вывода', () => {
    const r = new ConfigRegistry(); r.loadAll();
    const old = dropped('long-sword', 77);
    const before = weaponLookOf(r, old, undefined)!;
    r.reload({ 'weapon-parts': structuredClone(r.get('weapon-parts')) });
    expect(weaponLookOf(r, old, undefined)).toEqual(before);   // то же содержимое — тот же вывод, но уже заново
  });
});

describe('weaponLookSig: подпись руки', () => {
  const it0 = forged();
  const hand = weaponLookOf(reg, it0, undefined)!.main!;
  it('не зависит от порядка ключей и зависит от базы, id и ступени каждой детали', () => {
    const reordered = { parts: Object.fromEntries([...CRAFT_SLOT_LIST].reverse().map((s) => [s, { step: hand.parts[s].step, id: hand.parts[s].id }])) as unknown as CraftParts, baseId: hand.baseId };
    expect(weaponLookSig(reordered)).toBe(weaponLookSig(hand));
    const sigs = new Set([weaponLookSig(hand)]);
    sigs.add(weaponLookSig({ ...hand, baseId: hand.baseId + 'x' }));
    for (const s of CRAFT_SLOT_LIST) {
      sigs.add(weaponLookSig({ ...hand, parts: { ...hand.parts, [s]: { ...hand.parts[s], step: hand.parts[s].step === 5 ? 4 : hand.parts[s].step + 1 } } }));
      sigs.add(weaponLookSig({ ...hand, parts: { ...hand.parts, [s]: { ...hand.parts[s], id: hand.parts[s].id + '-b' } } }));
    }
    expect(sigs.size).toBe(2 + CRAFT_SLOT_LIST.length * 2);
  });
  it('нет руки — пустая подпись', () => {
    expect(weaponLookSig(undefined)).toBe('');
  });
});

describe('weaponLook: размер кадра', () => {
  /** Самые длинные id деталей класса — худший случай по байтам. */
  function longest(cls: string, hands: number): Item {
    const item = forged(cls, hands, 3);
    const parts = {} as CraftParts;
    for (const s of CRAFT_SLOT_LIST) {
      const pool = reg.get('weapon-parts').filter((p) => p.slot === s && (p.classes as string[]).includes(cls));
      const id = pool.reduce((a, b) => (b.id.length > a.length ? b.id : a), '');
      parts[s] = { id, step: 5 };
    }
    return { ...item, parts };
  }
  const bytes = (pi: PeerInfo): number => new TextEncoder().encode(JSON.stringify(pi)).length;

  it('игрок с видом оружия — меньше 600 байт JSON (меч+щит, двуручное, дуал)', () => {
    const cases: [string, PeerInfo][] = [
      ['меч+щит', peerInfoOf(player({ weapon: forged('sword', 1, 4), offhand: shield() }, 'Бородач'), reg)],
      ['двуручный меч', peerInfoOf(player({ weapon: forged('sword', 2, 5) }, 'Бородач'), reg)],
      ['дуал меч+кинжал', peerInfoOf(player({ weapon: forged('sword', 1, 3), offhand: forged('dagger', 1, 3) }, 'Бородач'), reg)],
      ['лук', peerInfoOf(player({ weapon: forged('bow', 2, 3) }, 'Бородач'), reg)],
    ];
    for (const [what, pi] of cases) {
      expect(pi.weaponLook, what).toBeTruthy();
      expect(bytes(pi), `${what}: ${JSON.stringify(pi)}`).toBeLessThan(600);
    }
  });

  it('худший случай — дуал на самых длинных id конфига — тоже меньше 600 байт, рука ≤ 260', () => {
    // Замер 26.09: меч+щит 345 Б, двуручное 341, дуал 530, дуал на самых длинных id 559.
    const pi = peerInfoOf(player({ weapon: longest('sword', 1), offhand: longest('dagger', 1) }, 'Бородач'), reg);
    for (const h of [pi.weaponLook!.main!, pi.weaponLook!.off!]) expect(new TextEncoder().encode(JSON.stringify(h)).length).toBeLessThanOrEqual(260);
    expect(bytes(pi)).toBeLessThan(600);
  });
});

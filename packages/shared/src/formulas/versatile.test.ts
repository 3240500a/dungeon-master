import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { itemFromBase } from './itemgen.js';
import { describeItem } from './itemDescribe.js';
import { weaponCard } from './craftCard.js';
import { makePlayerModel, newBotSave } from '../sim/playerBot.js';
import { attackWeaponsOf } from './playerCombat.js';
import { equippedItems } from '../session/derive.js';
import { weapon3dKeyFromEquipment } from '../session/weapon3d.js';
import { equip } from '../economy/townActions.js';
import { DEFAULT_GRIP, asHeld, gripAdjust, isVersatile, oneHandGrip } from './versatile.js';
import { craftWeapon, defaultParts, keyVariantsByBase } from './craft.js';
import { keySlotOf } from './craftType.js';
import { createRng } from './rng.js';
import type { Item } from '../types/items.js';
import type { SaveState } from '../types/save.js';

const reg = new ConfigRegistry();
reg.loadAll();
const GRIP = reg.get('balance').versatile;
const K = { damage: GRIP.oneHandDamage, speed: GRIP.oneHandSpeed };
const ITEM_LABELS = { armorClass: (id: string) => id, weight: (id: string) => id, physSub: (id: string) => id, skill: (id: string) => id, dmgShort: (dt: string) => dt };

const baseOf = (id: string) => reg.get('items.base').find((b) => b.id === id)!;
const make = (id: string): Item => itemFromBase(baseOf(id), reg.get('item-tiers'));
const flat = (it: Item, stat: string): number => it.baseStats.find((m) => m.stat === stat && m.kind === 'flat')?.value ?? 0;
const speedOf = (it: Item): number => {
  let f = 0, inc = 0;
  for (const m of it.baseStats) if (m.stat === 'attackSpeed') { if (m.kind === 'flat') f += m.value; else inc += m.value; }
  return (1 + f) * (1 + inc);
};

/** Герой 30-го уровня с этим оружием и (по желанию) щитом — считаем ДПС настоящей цепочкой панели. */
function dpsWith(weapon: Item, shield?: Item): number {
  const s = newBotSave(reg, 'warrior');
  s.level = 30;
  const a = s.attributes as unknown as Record<string, number>;
  a.strength = (a.strength ?? 0) + 60; a.dexterity = (a.dexterity ?? 0) + 30;
  s.equipment.weapon = weapon;
  if (shield) s.equipment.offhand = shield; else delete s.equipment.offhand;
  const m = makePlayerModel(reg, s);
  const card = weaponCard(reg, { derived: m.derived, attrs: m.attrs, weapon: s.equipment.weapon, scaling: m.scaling, weights: m.weights, attackInterval: m.attackInterval });
  return card.dps;
}

describe('⭐ полуторный хват: двуручное оружие одной рукой (§25)', () => {
  it('умолчание в коде совпадает с конфигом — вызов без ручек не расходится с игрой', () => {
    expect(DEFAULT_GRIP).toEqual(K);
  });

  it('полуторный меч помечен, двуручный и одноручный — нет', () => {
    expect(isVersatile(make('greatsword'))).toBe(true);
    expect(isVersatile(make('claymore'))).toBe(false);
    expect(isVersatile(make('long-sword'))).toBe(false);
  });

  it('хват выводится из второй руки, а не хранится', () => {
    const save = newBotSave(reg, 'warrior');
    save.equipment.weapon = make('greatsword');
    expect(oneHandGrip(save)).toBe(false);
    save.equipment.offhand = make('buckler');
    expect(oneHandGrip(save)).toBe(true);
    save.equipment.weapon = make('claymore');
    expect(oneHandGrip(save)).toBe(false); // настоящий двуручник одной рукой не держат
  });

  it('одной рукой: урон ×0.8, собственная скорость оружия ×0.9, требования те же', () => {
    const two = make('greatsword');
    const one = gripAdjust(two, K);
    expect(flat(one, 'minDamage')).toBe(Math.round(flat(two, 'minDamage') * K.damage));
    expect(flat(one, 'maxDamage')).toBe(Math.round(flat(two, 'maxDamage') * K.damage));
    expect(speedOf(one)).toBeCloseTo(speedOf(two) * K.speed, 5);
    expect(one.requirements).toEqual(two.requirements);   // плата — требования базы, как в Д2
    expect(flat(one, 'blockChance')).toBe(flat(two, 'blockChance'));
  });

  it('оба шва отдают вещь «как её держат»: и бой, и стат-блок панелей', () => {
    const save = newBotSave(reg, 'warrior');
    save.equipment.weapon = make('greatsword');
    const twoHand = attackWeaponsOf(save, K)[0]!;
    expect(flat(twoHand, 'minDamage')).toBe(flat(make('greatsword'), 'minDamage'));
    save.equipment.offhand = make('buckler');
    const oneHand = attackWeaponsOf(save, K)[0]!;
    expect(flat(oneHand, 'minDamage')).toBe(Math.round(flat(twoHand, 'minDamage') * K.damage));
    const weaponInPool = equippedItems(save, K).find((i) => i.uid === save.equipment.weapon!.uid)!;
    expect(speedOf(weaponInPool)).toBeCloseTo(speedOf(twoHand) * K.speed, 5);
    // Вторая рука не трогается: это отдельная вещь, а не хват.
    expect(asHeld(save.equipment.offhand, save, K)).toBe(save.equipment.offhand);
  });

  it('⚠ щит надевается к полуторному, но не к настоящему двуручнику', () => {
    const dims = reg.get('balance').inventory;
    const mk = (weapon: Item): SaveState => {
      const s = newBotSave(reg, 'warrior');
      const a = s.attributes as unknown as Record<string, number>;
      a.strength = (a.strength ?? 0) + 100; a.dexterity = (a.dexterity ?? 0) + 100;
      s.equipment.weapon = weapon;
      s.inventory = [];
      return s;
    };
    const shield = make('buckler');
    const ok = mk(make('greatsword'));
    ok.inventory.push(shield);
    expect(equip(reg, ok, shield.uid).ok, 'полуторный + щит').toBe(true);
    const no = mk(make('claymore'));
    const shield2 = make(shield.baseId);
    no.inventory.push(shield2);
    const r = equip(reg, no, shield2.uid);
    expect(r.ok, 'двуручник + щит').toBe(false);
    expect(r.reason).toContain('двумя руками');
    void dims;
  });

  it('⭐ сторож №1: одной рукой полуторный НЕ сильнее хорошего одноручника, зато дороже по силе', () => {
    // ⚠ Во второй руке именно ЩИТ: второе оружие — это дуал-вилд, другой расчёт и другой разговор.
    const versatileOne = dpsWith(gripAdjust(make('greatsword'), K), make('buckler'));
    const trueOne = dpsWith(make('long-sword'), make('buckler'));
    expect(versatileOne).toBeLessThanOrEqual(trueOne * 1.05);
    const reqSum = (id: string): number => Object.values(baseOf(id).requirements as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(reqSum('greatsword')).toBeGreaterThan(reqSum('long-sword'));
  });

  it('⭐ сторож №2: двумя руками ощутимо выгоднее — иначе одноручный хват съест двуручный', () => {
    const two = dpsWith(make('greatsword'));
    const one = dpsWith(gripAdjust(make('greatsword'), K), make('buckler'));
    // ⚠ 1.10, а не «×0.72 на бумаге»: вклад атрибутов размывает разницу оружия (замер §25).
    expect(two / one).toBeGreaterThanOrEqual(1.10);
    // И лестница вилок цела: настоящий двуручник сильнее полуторного в обеих руках.
    expect(dpsWith(make('claymore'))).toBeGreaterThan(two);
  });

  it('подсказка показывает ОБА урона сразу, у обычного оружия второй строки нет', () => {
    const lines = describeItem(make('greatsword'), ITEM_LABELS).map((l) => l.text);
    const two = make('greatsword'), one = gripAdjust(two, K);
    expect(lines.some((t) => t.startsWith(`Урон: ${flat(two, 'minDamage')}–${flat(two, 'maxDamage')}`))).toBe(true);
    expect(lines.some((t) => t.startsWith(`Одной рукой (со щитом): ${flat(one, 'minDamage')}–${flat(one, 'maxDamage')}`))).toBe(true);
    expect(describeItem(make('claymore'), ITEM_LABELS).some((l) => l.text.startsWith('Одной рукой'))).toBe(false);
  });

  // ⚠ V-B3-01 (фаззер паритета «окно ≡ сервер», сид 11430): у ПРЕДПРОСМОТРА ковки строка «Одной рукой» стояла одним числом —
  // серединой вилки предпросмотра (строка «Урон» над ней — вилкой), и скованная вещь (бросок в вилке) с ним почти не совпадала:
  // окно «20–34», вещь «21–35». Теперь — вилкой по краям тем же правилом, что считает вещь, и каждая скованная в неё попадает.
  it('V-B3-01: предпросмотр ковки полуторного — «Одной рукой» вилкой, и скованная вещь в ней', () => {
    const R = { ...ITEM_LABELS, grip: K };
    const key = keyVariantsByBase(reg, 'sword', 2).find((x) => x.baseId === 'greatsword')!.variants[0]!;
    const oneLine = (it: Item): string => describeItem(it, R).map((l) => l.text).find((t) => t.startsWith('Одной рукой'))!;
    let forged = 0;
    for (const finish of [0, reg.get('balance').craft.finish.length - 1]) {
      for (const step of [1, 3, 5]) {
        const parts = defaultParts(reg, 'sword', 2, step)!;
        parts[keySlotOf(reg, 'sword')] = { id: key.id, step };
        const input = { weaponClass: 'sword', hands: 2, parts, finish };
        const pv = craftWeapon(reg, input);
        if (!pv.ok || !pv.item) continue;   // ступень вне окна базы — не наш случай
        const shown = oneLine(pv.item);
        // Край — «(a–b)» или одно число, если после округления концы совпали (`rangeLabel`).
        const m = /^Одной рукой \(со щитом\): (\(\d+–\d+\)|\d+)–(\(\d+–\d+\)|\d+) · /.exec(shown);
        expect(m, `предпросмотр: «${shown}»`).not.toBeNull();
        const edge = (s: string): [number, number] => { const q = /^\((\d+)–(\d+)\)$/.exec(s); return q ? [Number(q[1]), Number(q[2])] : [Number(s), Number(s)]; };
        const [[a0, a1], [b0, b1]] = [edge(m![1]!), edge(m![2]!)];
        if (step === 5) expect(a1 > a0 || b1 > b0, `на высокой ступени — вилка, а не число: «${shown}»`).toBe(true);
        for (let seed = 1; seed <= 40; seed++) {
          const got = craftWeapon(reg, input, { rng: createRng(seed) });
          const g = /^Одной рукой \(со щитом\): (\d+)–(\d+) · /.exec(oneLine(got.item!))!;
          const [lo, hi] = [Number(g[1]), Number(g[2])];
          expect(lo >= a0 && lo <= a1 && hi >= b0 && hi <= b1, `шаг ${step}, доводка ${finish}, сид ${seed}: вещь ${lo}–${hi}, окно «${shown}»`).toBe(true);
          forged++;
        }
      }
    }
    expect(forged, 'полуторный меч куётся').toBeGreaterThan(0);
  });

  it('анимация берётся по ФАКТИЧЕСКОМУ хвату: со щитом полуторный держат одной рукой', () => {
    const half = make('greatsword'), shield = { kind: 'shield' } as Item;
    expect(weapon3dKeyFromEquipment(half, undefined)).toBe('greatsword');
    expect(weapon3dKeyFromEquipment(half, shield)).toBe('sword+shield');
    expect(weapon3dKeyFromEquipment(make('claymore'), shield)).toBe('greatsword');
  });
});

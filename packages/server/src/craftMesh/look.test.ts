import { describe, it, expect } from 'vitest';
import { ConfigRegistry, defaultParts, weaponLookSig, type WeaponLookHand } from '@dm/shared';
import { LOOK_TEXT_MAX, checkLook, parseLook } from './look.js';

/**
 * U6b: ВИД В ЗАПРОСЕ МОДЕЛИ. На проводе — подпись руки (`weaponLookSig`), только каноническая; годность — ровно то, что сервер сам
 * рассылает пирам (`weaponLookOf`): деталь существует, в своём гнезде, подходит классу и хвату, ступень 1…5. Выключенная деталь и
 * ступень вне окна материалов — годны (вещь носит их и после правки конфига, веб такую рисует).
 */
const reg = new ConfigRegistry();
reg.loadAll();
const swordBase = reg.get('items.base').find((b) => b.kind === 'weapon' && b.weaponClass === 'sword' && (b.hands ?? 1) === 1)!;
const hand = (): WeaponLookHand => ({ baseId: swordBase.id, parts: defaultParts(reg, 'sword', 1, 3)! });

describe('parseLook — подпись вида с провода', () => {
  it('подпись руки разбирается обратно в ту же руку', () => {
    const h = hand();
    const r = parseLook(weaponLookSig(h));
    expect(r).toEqual({ ok: true, hand: h, sig: weaponLookSig(h) });
  });

  it('не строка, пусто, слишком длинно — отказ с причиной', () => {
    expect(parseLook(undefined).ok).toBe(false);
    expect(parseLook('').ok).toBe(false);
    expect(parseLook('a'.repeat(LOOK_TEXT_MAX + 1))).toMatchObject({ ok: false, reason: expect.stringMatching(/длинный/) });
  });

  it('не база и четыре детали, кривой id, кривая ступень — отказ', () => {
    const sig = weaponLookSig(hand());
    expect(parseLook(sig.split('|').slice(0, 4).join('|')).ok, 'трёх деталей мало').toBe(false);
    expect(parseLook(`${sig}|x:1`).ok, 'пятая деталь лишняя').toBe(false);
    expect(parseLook(sig.replace(/:3/, ':0')).ok, 'ступень 0').toBe(false);
    expect(parseLook(sig.replace(/:3/, ':10')).ok, 'ступень 10').toBe(false);
    expect(parseLook(sig.replace(/:3/, ':x')).ok, 'ступень не число').toBe(false);
    expect(parseLook(sig.replace(/\|[^|:]+:/, '|:')).ok, 'пустой id').toBe(false);
    expect(parseLook(sig.replace(/\|[^|:]+:/, '|a b:')).ok, 'пробел в id').toBe(false);
    expect(parseLook(sig.replace(/^[^|]+/, '../x')).ok, 'путь вместо базы').toBe(false);
  });

  it('⭐ только каноническая запись: у одного вида — один адрес (и одна запись кэша)', () => {
    const sig = weaponLookSig(hand());
    expect(parseLook(sig.replace(/:3/, ':03')).ok, 'ступень с ведущим нулём').toBe(false);
  });
});

describe('checkLook — годен ли вид конфигу', () => {
  it('годный вид даёт класс и хват базы', () => {
    expect(checkLook(reg, hand())).toEqual({ ok: true, weaponClass: 'sword', hands: 1 });
  });

  it('неизвестная база, не оружие, неизвестная деталь — отказ', () => {
    expect(checkLook(reg, { ...hand(), baseId: 'nope' }).ok).toBe(false);
    const armor = reg.get('items.base').find((b) => b.kind !== 'weapon')!;
    expect(checkLook(reg, { ...hand(), baseId: armor.id }).ok, 'броня — не оружие').toBe(false);
    const h = hand();
    h.parts.grip = { id: 'no-such-part', step: 2 };
    expect(checkLook(reg, h)).toMatchObject({ ok: false, reason: expect.stringMatching(/Нет такой детали/) });
  });

  it('деталь не своего гнезда или чужого класса — отказ', () => {
    const h = hand();
    h.parts.grip = { ...h.parts.strike };
    expect(checkLook(reg, h).ok, 'клинок в гнезде рукояти').toBe(false);
    const axePart = reg.get('weapon-parts').find((p) => p.slot === 'strike' && !(p.classes as string[]).includes('sword'))!;
    const h2 = hand();
    h2.parts.strike = { id: axePart.id, step: 3 };
    expect(checkLook(reg, h2).ok, 'ударная часть другого класса').toBe(false);
  });

  it('⭐ выключенная деталь и ступень вне окна материалов — годны: так вещь носит их после правки конфига', () => {
    const h = hand();
    const parts = reg.get('weapon-parts').map((p) => (p.id === h.parts.grip.id ? { ...p, enabled: false, stepMin: 4, stepMax: 5 } : p));
    const r2 = new ConfigRegistry();
    r2.loadAll();
    r2.reload({ 'weapon-parts': parts }, { cross: false });
    h.parts.grip.step = 1;
    expect(checkLook(r2, h)).toEqual({ ok: true, weaponClass: 'sword', hands: 1 });
  });
});

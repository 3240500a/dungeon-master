import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { trophyBaseFor, trophyScore, type TrophyCandidate } from './trophy.js';

/**
 * ⭐ Смысл всей затеи: у монстров свой маленький пул снаряжения, у игрока свой большой, и падать
 * с трупа обязана вещь, которую игрок МОЖЕТ НАДЕТЬ. Тесты стерегут именно это — что для каждой
 * из 22 записей снаряжения находится осмысленная замена, а не «что-нибудь».
 */

const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
/** Детерминированный выбор среди равных — тест не должен зависеть от везения. */
const first = { int: (lo: number) => lo };

describe('трофей: снаряжение монстра → база игрока', () => {
  it('класс перевешивает всё остальное: топор становится топором', () => {
    const bases = reg.get('items.base');
    const axe = reg.get('monster-gear').find((g) => g.id === 'u-axe1h')!;
    const got = bases.find((b) => b.id === trophyBaseFor(axe, bases, first))!;
    expect(got.kind).toBe('weapon');
    expect(got.kind === 'weapon' && got.weaponClass).toBe('axe');
    expect(got.kind === 'weapon' && got.hands).toBe(1);
  });

  it('двуручное остаётся двуручным', () => {
    const bases = reg.get('items.base');
    const axe2 = reg.get('monster-gear').find((g) => g.id === 'u-axe2h')!;
    const got = bases.find((b) => b.id === trophyBaseFor(axe2, bases, first))!;
    expect(got.kind === 'weapon' && got.weaponClass).toBe('axe');
    expect(got.kind === 'weapon' && got.hands).toBe(2);
  });

  it('броня сходится по классу И слоту: ржавый койф → шлем-кольчуга', () => {
    const bases = reg.get('items.base');
    const coif = reg.get('monster-gear').find((g) => g.id === 'u-coif')!;
    const got = bases.find((b) => b.id === trophyBaseFor(coif, bases, first))!;
    expect(got.kind).toBe('armor');
    expect(got.kind === 'armor' && got.armorClass).toBe('chain');
    expect('slot' in got && got.slot).toBe('helm');
  });

  it('броня монстра БЕЗ слота — это нагрудник', () => {
    const bases = reg.get('items.base');
    const mail = reg.get('monster-gear').find((g) => g.id === 'u-chain')!;
    const got = bases.find((b) => b.id === trophyBaseFor(mail, bases, first))!;
    expect('slot' in got && got.slot).toBe('chest');
    expect(got.kind === 'armor' && got.armorClass).toBe('chain');
  });

  it('⭐ точного соответствия нет — берём ПОХОЖЕЕ, а не случайное', () => {
    // Метательный топор зомби дальнобойный, а дальнобойных топоров у игрока нет вовсе.
    const bases = reg.get('items.base');
    const thrown = reg.get('monster-gear').find((g) => g.id === 'u-throwaxe')!;
    const got = bases.find((b) => b.id === trophyBaseFor(thrown, bases, first))!;
    expect(got.kind === 'weapon' && got.weaponClass).toBe('axe'); // класс сохранён
    expect(got.kind === 'weapon' && got.hands).toBe(1);           // и число рук тоже
  });

  it('⚠ вид вещи не подменяется никогда: броня не станет оружием', () => {
    const onlyWeapons: TrophyCandidate[] = [{ id: 'w', kind: 'weapon', weaponClass: 'sword' }];
    const mail = reg.get('monster-gear').find((g) => g.id === 'u-chain')!;
    expect(trophyBaseFor(mail, onlyWeapons, first)).toBeUndefined();
  });

  it('явная замена в конфиге перебивает автоподбор', () => {
    const bases = reg.get('items.base');
    const target = bases.find((b) => b.kind === 'weapon')!;
    const src = { kind: 'weapon', weaponClass: 'sword', hands: 1, trophyBase: target.id };
    expect(trophyBaseFor(src, bases, first)).toBe(target.id);
    // ...но только если такая база вообще есть — иначе молча подберём похожее
    expect(trophyBaseFor({ ...src, trophyBase: 'нет-такой' }, bases, first)).not.toBe('нет-такой');
  });

  it('выключенная база в трофеи не попадает', () => {
    const cands: TrophyCandidate[] = [
      { id: 'off', kind: 'weapon', weaponClass: 'axe', hands: 1, enabled: false },
      { id: 'on', kind: 'weapon', weaponClass: 'sword', hands: 1 },
    ];
    expect(trophyBaseFor({ kind: 'weapon', weaponClass: 'axe', hands: 1 }, cands, first)).toBe('on');
  });

  it('⭐ КАЖДОЙ из записей снаряжения монстров есть замена среди вещей игрока', () => {
    const bases = reg.get('items.base');
    for (const g of reg.get('monster-gear')) {
      const id = trophyBaseFor(g, bases, first);
      expect(id, `${g.id} (${g.name}) — нечего уронить с трупа`).toBeTruthy();
      const b = bases.find((x) => x.id === id)!;
      expect(b.kind, `${g.id} → вид не совпал`).toBe(g.kind);
      expect('slot' in b && b.slot, `${g.id} → вещь без слота, надеть нельзя`).toBeTruthy();
    }
  });

  it('счёт сходства: одинаковый класс важнее одинакового числа рук', () => {
    const src = { kind: 'weapon', weaponClass: 'axe', hands: 2 };
    const sameClass = trophyScore(src, { id: 'a', kind: 'weapon', weaponClass: 'axe', hands: 1 });
    const sameHands = trophyScore(src, { id: 'b', kind: 'weapon', weaponClass: 'sword', hands: 2 });
    expect(sameClass).toBeGreaterThan(sameHands);
  });
});

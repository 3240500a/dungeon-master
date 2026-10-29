import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { weapon3dKeyFromEquipment } from '@dm/shared';
import { attachWeapons } from './weapon3d.js';
import { weaponHandMasses } from './weaponMass.js';
import { loadGrip, weaponChain } from './poseRuntime.js';
import { buildHumanoid } from './humanoid.js';

/**
 * ⭐⭐ ЩИТ БЕЗ ОРУЖИЯ — ПОЛНОЦЕННОЕ СОСТОЯНИЕ, А НЕ «ОРУЖИЯ НЕТ».
 *
 * Три жалобы, и все три — про один и тот же слот второй руки:
 *  • «настроил хват щита на idle со щитом без оружия — в игре с мечом щит висит криво»;
 *  • «в игре снимаешь оружие — щит тоже пропадает с модели, а должен остаться»;
 *  • «без оружия со щитом бить надо правой рукой и без ничего».
 */
describe('щит без оружия', () => {
  const shield = { kind: 'shield' as const, weaponClass: undefined, hands: 1 };
  const sword = { kind: 'weapon' as const, weaponClass: 'sword' as const, hands: 1 };

  it('⭐⭐ СНЯЛ ОРУЖИЕ, ЩИТ ОСТАЛСЯ — ключ `none+shield`, а не «ключа нет»', () => {
    // ⚠ Мутация «вернуть `null` при пустой главной руке» валит это: клиент подставит КЛАСС-ДЕФОЛТ,
    // то есть нарисует оружие, которого на игроке нет, и потеряет щит, который есть.
    expect(weapon3dKeyFromEquipment(undefined, shield)).toBe('none+shield');
    expect(weapon3dKeyFromEquipment(sword, shield)).toBe('sword+shield');
    expect(weapon3dKeyFromEquipment(undefined, undefined), 'пусто в обеих руках — класс-дефолт').toBe(null);
  });

  it('⭐ УДАР БЕЗ ОРУЖИЯ — безоружный: цепочка ведёт к `none`', () => {
    expect(weaponChain('none+shield')).toContain('none');
  });

  it('⭐⭐ СЛОТЫ НЕ СЪЕЗЖАЮТ: щит при пустой главной руке остаётся ВТОРЫМ', () => {
    // ⚠ Мутация «не создавать группу пустой руке» валит это — и ровно из-за неё хват щита
    // записывался как `main`, а в паре «меч+щит» тот же щит был уже `off`.
    const h = buildHumanoid({});
    const g = attachWeapons(h, 'none+shield');
    expect(g.length, 'слотов всегда два у ключа вида a+b').toBe(2);
    expect(g[1]!.parent, '⚠ щит не на левой кисти').toBe(h.bones.get('LeftHand'));
    expect(g[0]!.children.length, 'пустая рука ничего не рисует').toBe(0);
    const g2 = attachWeapons(h, 'sword+shield');
    expect(g2[1]!.parent, 'в паре щит там же — на левой').toBe(h.bones.get('LeftHand'));
  });

  it('⚠ ПУСТАЯ РУКА НИЧЕГО НЕ ВЕСИТ', () => {
    // ⚠ Мутация «дефолт 6 для неизвестного» валит это: правую руку тянул бы фантомный груз.
    expect(weaponHandMasses('none+shield')[0]).toBe(0);
    expect(weaponHandMasses('none+shield')[1], 'щит весит').toBeGreaterThan(0);
    expect(weaponHandMasses('sword+shield')[0], 'меч весит').toBeGreaterThan(0);
  });

  describe('хват наследуется по руке', () => {
    const store: Record<string, string> = {};
    beforeEach(() => {
      for (const k of Object.keys(store)) delete store[k];
      (globalThis as unknown as { localStorage: Storage }).localStorage = {
        getItem: (k: string) => store[k] ?? null, setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0,
      } as Storage;
    });
    afterEach(() => { delete (globalThis as unknown as { localStorage?: Storage }).localStorage; });
    const G = (v: number): { p: [number, number, number]; r: [number, number, number] } => ({ p: [v, 0, 0], r: [v, 0, 0] });

    it('⭐⭐ ХВАТ ЩИТА, НАСТРОЕННЫЙ БЕЗ ОРУЖИЯ, ЕДЕТ К МЕЧУ', () => {
      // ⚠ Мутация «искать хват только по точному ключу» валит это — так и было: настройка на
      // `none+shield` не находилась на `sword+shield`, и щит висел криво.
      store['pe_grip'] = JSON.stringify({ w: { sword: { main: G(1) }, 'none+shield': { off: G(2) } } });
      const [m, o] = loadGrip('w', 'sword+shield');
      expect(m?.p[0], '⚠ потерялся хват меча').toBe(1);
      expect(o?.p[0], '⚠ ХВАТ ЩИТА НЕ ПРИЕХАЛ').toBe(2);
    });

    it('⚠ ЛЕГАСИ: щит, записанный в слот `main` (когда пустая рука слот не занимала), читается', () => {
      // Так лежат уже сделанные настройки — терять их нельзя.
      store['pe_grip'] = JSON.stringify({ w: { 'none+shield': { main: G(3) } } });
      expect(loadGrip('w', 'sword+shield')[1]?.p[0]).toBe(3);
    });

    it('⭐ точная настройка на пару БЬЁТ наследование', () => {
      store['pe_grip'] = JSON.stringify({ w: { 'none+shield': { off: G(2) }, 'sword+shield': { off: G(9) } } });
      expect(loadGrip('w', 'sword+shield')[1]?.p[0]).toBe(9);
    });

    it('нет настроек — оба слота пустые, остаётся дефолт типа оружия', () => {
      expect(loadGrip('w', 'sword+shield')).toEqual([null, null]);
    });
  });
});

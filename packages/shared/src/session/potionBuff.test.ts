import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { itemFromBaseId } from '../formulas/itemgen.js';
import { consumableLines } from '../formulas/itemDescribe.js';
import { respecSkills } from '../economy/townActions.js';
import { Cell, makeGrid, cellToWorld } from '../world/grid.js';
import { newBotSave } from '../sim/playerBot.js';
import type { Item } from '../types/items.js';
import { GameSession, type PlayerInput } from './session.js';

/**
 * ⚠ C-11 (бафф-зелья): СЕРВЕР ПРИМЕНЯЕТ `use.buffMods`. Схема расходника принимает `buffMods` + `buffDurationSec`, редактор их
 * предлагает, подсказка обещает «Бафф на N сек», офлайн-клиент их применял (`potionBuffs`) — а авторитетный сервер нет: `drink`
 * отдавал только мгновенный эффект (`applyConsumable`). Зелье-бафф не выпивалось никогда (пояс молчит, команда — «Нет эффекта»,
 * мёртвый груз в сумке), а зелье «лечение + бафф» лечило и тратилось без баффа.
 *
 * Теперь бафф зелья — временный бафф героя `pot:<база>` (тот же таймер `skillBuffs`, что у баффов скилов и печатей вставок `ins:`):
 * моды — из определения базы в конфиге (живая правка редактора), длительность — оттуда же; повтор освежает бафф до полной
 * длительности, бафф и так полный — «нет эффекта», зелье цело. Сброс скилов его не снимает (это не скил), смерть — снимает.
 * (Скрытое: в поставке нет ни одного зелья с `buffMods`; его включит первая же правка редактора.)
 */

const idle: PlayerInput = { move: { x: 0, y: 0 }, facing: 0, attack: false, cast: null, interact: false };
const WARD = 'test-ward-potion';   // только бафф: броня +100 на 30 с
const MEND = 'test-mend-potion';   // лечение 50 + бафф: броня +40 на 10 с

const REG = (() => {
  const r = new ConfigRegistry();
  r.loadAll();
  const tpl = r.get('items.base').find((b) => b.id === 'healing-potion')!;
  const pot = (id: string, use: Record<string, unknown>) => ({ ...structuredClone(tpl), id, name: id, use: { heal: 0, healPct: 0, mana: 0, manaPct: 0, cure: false, ...use } });
  r.reload({
    'items.base': [
      ...r.get('items.base'),
      pot(WARD, { buffMods: [{ stat: 'armor', kind: 'flat', value: 100 }], buffDurationSec: 30 }),
      pot(MEND, { heal: 50, buffMods: [{ stat: 'armor', kind: 'flat', value: 40 }], buffDurationSec: 10 }),
    ],
  });
  return r;
})();

function setup() {
  const r = REG;
  const bases = r.get('items.base');
  const potion = (id: string): Item => itemFromBaseId(bases, id, undefined, 'shop')!;
  const s = new GameSession(r, 31, 'normal');
  const save = newBotSave(r, 'warrior');
  save.equipment.belt = itemFromBaseId(bases, 'leather-belt', r.get('item-tiers'), 'drop')!;
  save.belt = [potion(WARD), potion(MEND), null, null];
  const p = s.addPlayer('p1', save);
  s.enterFloor(1, { grid: makeGrid(12, 12, Cell.Floor), spawn: cellToWorld(5, 5), monsters: [] });
  s.tick(1 / 30, { p1: idle });
  const armor = (): number => s.snapshotOf('p1')!.derived.armor;
  return { r, s, p, save, potion, armor, armor0: armor() };
}
const ticks = (s: GameSession, n: number, input: PlayerInput = idle): void => { for (let i = 0; i < n; i++) s.tick(1 / 30, { p1: input }); };

describe('⚠ C-11: бафф-зелья — сервер вешает `use.buffMods`', () => {
  it('⭐ пояс: зелье-бафф при полном здоровье выпивается; броня +100 на 30 с, потом спадает', () => {
    const { s, p, save, armor, armor0 } = setup();
    expect(p.hp, 'здоровье полное').toBe(s.snapshotOf('p1')!.derived.maxHp);
    s.tick(1 / 30, { p1: { ...idle, useBelt: 0 } });
    expect(save.belt[0], 'зелье-бафф выпито').toBeNull();
    s.tick(1 / 30, { p1: idle });
    expect(armor(), 'бафф на броне').toBeCloseTo(armor0 + 100, 9);
    ticks(s, 28 * 30);
    expect(armor(), 'на 29-й секунде ещё держится').toBeCloseTo(armor0 + 100, 9);
    ticks(s, 2 * 30);
    expect(armor(), 'спал').toBeCloseTo(armor0, 9);
  });

  it('⭐ команда (`drink`): бафф полный — «нет эффекта», зелье цело; бафф тает — освежает до полного, не сверху', () => {
    const { s, p, potion } = setup();
    const ward = potion(WARD);
    expect(s.drink('p1', ward.use!, ward.baseId), 'выпито').toBe(true);
    expect(s.drink('p1', ward.use!, ward.baseId), 'бафф и так полный — нет эффекта').toBe(false);
    ticks(s, 30);
    expect(p.skillBuffs[`pot:${WARD}`]).toBeCloseTo(29, 6);
    expect(s.drink('p1', ward.use!, ward.baseId), 'бафф тает — освежает').toBe(true);
    expect(p.skillBuffs[`pot:${WARD}`], 'до полной длительности, не 29 + 30').toBe(30);
  });

  it('⭐ лечение + бафф: раненый — лечит и вешает бафф; на полном здоровье выпивается ради баффа', () => {
    const w = setup();
    w.p.hp = 10;
    w.s.tick(1 / 30, { p1: { ...idle, useBelt: 1 } });
    expect(w.save.belt[1], 'выпито').toBeNull();
    expect(w.p.hp, 'подлечило').toBeGreaterThan(10);
    w.s.tick(1 / 30, { p1: idle });
    expect(w.armor(), 'и бафф повешен (было: лечило без баффа)').toBeCloseTo(w.armor0 + 40, 9);
    const v = setup();
    v.s.tick(1 / 30, { p1: { ...idle, useBelt: 1 } });
    expect(v.save.belt[1], 'на полном здоровье — ради баффа').toBeNull();
    v.s.tick(1 / 30, { p1: idle });
    expect(v.armor()).toBeCloseTo(v.armor0 + 40, 9);
  });

  it('бафф зелья — не скил: сброс скилов его не снимает; смерть — снимает', () => {
    const { r, s, p, save, armor, armor0 } = setup();
    save.skills['b-class-warrior-a5'] = 1; save.gold = 1_000_000;
    s.tick(1 / 30, { p1: { ...idle, useBelt: 0 } });
    expect(respecSkills(r, save).ok, 'сброс прошёл').toBe(true);
    ticks(s, 3);
    expect(armor(), 'сброс скилов бафф зелья не трогает (`dropUnlearned`)').toBeCloseTo(armor0 + 100, 9);
    p.hp = 0; p.alive = false;
    s.respawnPlayer('p1');
    s.tick(1 / 30, { p1: idle });
    expect(p.skillBuffs, 'возрождение после смерти снимает бафф').toEqual({});
    expect(armor()).toBeCloseTo(armor0, 9);
  });

  it('подсказка обещает то, что даёт сервер', () => {
    const { potion } = setup();
    expect(consumableLines(potion(WARD))).toContain('Бафф на 30 сек');
  });
});

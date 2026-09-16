import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { createRng } from '../formulas/rng.js';
import { generateMonster } from '../formulas/monstergen.js';
import { Cell, makeGrid, cellToWorld, type Grid } from '../world/grid.js';
import { newBotSave } from '../sim/playerBot.js';
import { itemFromBaseId } from '../formulas/itemgen.js';
import { GameSession, type PlayerInput, type SessionEvent } from './session.js';
import type { AttackActive } from '../types/skills.js';

/**
 * ⭐⭐ `hits` — ЭТО СКОЛЬКО РАЗ ВЗМАХНУТЬ, А `speed` — КАК БЫСТРО КАЖДЫЙ ВЗМАХ.
 *
 * Жалоба автора про «Град ударов» (3 удара, скорость ×2): «он бьёт один раз и три урона, и ещё
 * вдвое быстрее одного простого — это очень мощно». Замер это подтвердил дословно: ОДИН свинг
 * (значит одна анимация), ТРИ урона в ОДНОМ кадре (и все три — копии одного броска, пакет-то
 * строился один), и окно всей способности 500 мс против 1000 мс у обычного удара.
 *
 * Правило теперь такое: один взмах длится `1 / (скорость атаки × speed)`, вся серия — `hits` таких
 * взмахов подряд, у каждого свой свинг (анимация+звук), свой замах и свой полноценный удар.
 */
const NODE = 'b-sword1h-a1';                                   // «Град ударов» — мечевая атака-серия
const idle: PlayerInput = { move: { x: 0, y: 0 }, facing: 0, attack: false, cast: null, interact: false };

function openField(cols: number, rows: number): Grid {
  const g = makeGrid(cols, rows, Cell.Floor);
  for (let x = 0; x < cols; x++) { g[0]![x] = Cell.Wall; g[rows - 1]![x] = Cell.Wall; }
  for (let y = 0; y < rows; y++) { g[y]![0] = Cell.Wall; g[y]![cols - 1] = Cell.Wall; }
  return g;
}

/** Настроить узел-серию под тест (конфиг живой — так же правят балансные тесты соседних механик). */
function tune(r: ConfigRegistry, patch: Partial<AttackActive>): void {
  const a = r.get('skill-tree').nodes.find((n) => n.id === NODE)!.effect.active as AttackActive;
  Object.assign(a, patch);
}

interface Shot { swings: number[]; hits: number[]; dmg: number[] }

/** Один каст скилла (или базовые атаки при `node = null`) и таймлайн событий, сек от старта. */
function cast(r: ConfigRegistry, node: string | null, secs: number, seed = 7, stunAt = -1): Shot {
  const s = new GameSession(r, seed, 'normal');
  const save = newBotSave(r, 'warrior');
  if (node) save.skills[node] = 1;
  save.equipment.weapon = itemFromBaseId(r.get('items.base'), 'short-sword', r.get('item-tiers'))!;
  const p = s.addPlayer('p1', save);
  p.stamina = 1e6; p.mana = 1e6;                               // ресурс не должен мешать мерить тайминг
  const def = generateMonster(r.get('monsters'), r.get('monster-gear'), r.get('monster-affixes'),
    { baseId: r.get('biomes')[0]!.monsterPool[0]!, depth: 1 }, createRng(4));
  def.hp = 1e9; def.armor = 0;
  const m = cellToWorld(7, 6);
  s.enterFloor(1, { grid: openField(20, 12), spawn: cellToWorld(6, 6), monsters: [{ def, x: m.x, y: m.y }] });
  const facing = Math.atan2(m.y - p.pos.y, m.x - p.pos.x);
  const out: Shot = { swings: [], hits: [], dmg: [] };
  const dt = 1 / 60;
  for (let i = 0; i < Math.round(secs / dt); i++) {
    const t = i * dt;
    if (stunAt >= 0 && Math.abs(t - stunAt) < dt / 2) p.stunTimer = 1;
    const ev: SessionEvent[] = s.tick(dt, { p1: { ...idle, facing, cast: node, attack: !node } });
    for (const e of ev) {
      if (e.type === 'swing' && e.playerId === 'p1') out.swings.push(t + dt);
      if (e.type === 'hit' && e.by === 'p1' && e.target === 'monster') { out.hits.push(t + dt); out.dmg.push(e.amount); }
    }
  }
  return out;
}

function reg(): ConfigRegistry { const r = new ConfigRegistry(); r.loadAll(); return r; }

describe('серия ударов скилла (`hits`)', () => {
  it('⭐⭐ ТРИ УДАРА — ЭТО ТРИ ВЗМАХА, РАЗНЕСЁННЫЕ ПО ВРЕМЕНИ, а не три урона в одном кадре', () => {
    // ⚠ Мутация «вернуть цикл `for (h < hits) meleeSwing` в `weaponAttack`» валит это: свинг остаётся
    // один (одна анимация), а три урона садятся на один и тот же кадр.
    const r = reg();
    const sh = cast(r, NODE, 1.4);                             // ровно одна серия: 3 × 0.5 с
    expect(sh.swings.length, '⚠ сколько ударов написано — столько свингов и должно быть').toBe(3);
    expect(sh.hits.length).toBe(3);
    const gaps = sh.hits.slice(1).map((t, i) => t - sh.hits[i]!);
    for (const g of gaps) expect(g, '⚠ удары слиплись в один кадр').toBeGreaterThan(0.1);
  });

  it('⭐ СКОРОСТЬ — У КАЖДОГО ВЗМАХА: шаг серии = 1/(скорость атаки × speed), серия = hits × шаг', () => {
    // ⚠ Мутация «`p.attackCd = stepSec` без × hits» валит это: серия ещё идёт, а лок уже снят.
    const r = reg();
    tune(r, { hits: 3, speed: 2, cooldown: 0 });
    const sh = cast(r, NODE, 4);
    const step = 1 / 2;                                        // скорость атаки воина 1 ур. = 1.0
    expect(sh.swings[1]! - sh.swings[0]!, 'шаг между взмахами').toBeCloseTo(step, 2);
    expect(sh.swings[2]! - sh.swings[1]!).toBeCloseTo(step, 2);
    // Следующее применение стартует только после ВСЕЙ серии (общий attack-лок), а не после первого взмаха.
    // Допуск — один кадр: гейт лока тикает вычитанием dt, и на нецелом числе кадров срабатывает на кадр позже.
    expect(Math.abs(sh.swings[3]! - sh.swings[0]! - 3 * step), 'серия занимает hits × шаг').toBeLessThan(1 / 60 + 1e-6);
  });

  it('⚠ ОДИНОЧНЫЙ УДАР (hits=1) ВЕДЁТ СЕБЯ КАК РАНЬШЕ: один свинг, окно = 1/(скорость × speed)', () => {
    const r = reg();
    tune(r, { hits: 1, speed: 2, cooldown: 0 });
    const sh = cast(r, NODE, 2);
    expect(sh.hits.length, 'на каждый свинг ровно один удар').toBe(sh.swings.length);
    expect(Math.abs(sh.swings[1]! - sh.swings[0]! - 0.5), 'окно одиночного удара').toBeLessThan(1 / 60 + 1e-6);
  });

  it('⚠ СТАН ПОСРЕДИ СЕРИИ ОБРЫВАЕТ ОСТАТОК — серия живёт внутри замаха и гибнет вместе с ним', () => {
    const r = reg();
    tune(r, { hits: 3, speed: 2, cooldown: 0 });
    const sh = cast(r, NODE, 1.2, 7, 0.6);                     // стан после первого удара
    expect(sh.hits.length, '⚠ скилл дострелил из-под стана').toBe(1);
  });

  it('⚠ ЦЕНА СПИСЫВАЕТСЯ ОДИН РАЗ ЗА ПРИМЕНЕНИЕ, а не за взмах', () => {
    const r = reg();
    tune(r, { hits: 3, speed: 2, cooldown: 0, manaCost: 7 });
    const s = new GameSession(r, 7, 'normal');
    const save = newBotSave(r, 'warrior');
    save.skills[NODE] = 1;
    save.equipment.weapon = itemFromBaseId(r.get('items.base'), 'short-sword', r.get('item-tiers'))!;
    const p = s.addPlayer('p1', save);
    s.enterFloor(1, { grid: openField(20, 12), spawn: cellToWorld(6, 6), monsters: [] });
    p.stamina = 20;
    const before = p.stamina;
    for (let i = 0; i < 60; i++) s.tick(1 / 60, { p1: { ...idle, cast: i === 0 ? NODE : null } });
    // Регена за секунду прибавится, поэтому сравниваем с «списали больше одной цены».
    expect(before - p.stamina, '⚠ ресурс уходил за каждый взмах').toBeLessThan(7 * 1.5);
  });

  it('⚠ ВЗМАХ СЕРИИ ПОМЕЧЕН `chain` — клиенту не перезапускать заливку-откат слота', () => {
    // Откат льётся с ПЕРВОГО взмаха; без пометки заливка дёргалась бы назад на каждом следующем.
    const r = reg();
    tune(r, { hits: 3, speed: 2, cooldown: 0 });
    const s = new GameSession(r, 7, 'normal');
    const save = newBotSave(r, 'warrior');
    save.skills[NODE] = 1;
    save.equipment.weapon = itemFromBaseId(r.get('items.base'), 'short-sword', r.get('item-tiers'))!;
    const p = s.addPlayer('p1', save);
    p.stamina = 1e6;
    s.enterFloor(1, { grid: openField(20, 12), spawn: cellToWorld(6, 6), monsters: [] });
    const chain: boolean[] = [];
    for (let i = 0; i < 84; i++) {
      for (const e of s.tick(1 / 60, { p1: { ...idle, cast: i === 0 ? NODE : null } })) {
        if (e.type === 'swing' && e.playerId === 'p1') chain.push(!!e.chain);
      }
    }
    expect(chain, '⚠ первый взмах — новое применение, остальные — продолжение').toEqual([false, true, true]);
  });

  it('⚠ ПРОКИ ВСТАВОК БЬЮТ ОДИН РАЗ ЗА ПРИМЕНЕНИЕ, а не на каждый взмах серии', () => {
    // «При использовании расходится волна холода» — это ПРИ ИСПОЛЬЗОВАНИИ, а не при каждом взмахе:
    // цена и откат вставки списываются один раз. ⚠ Мутация «`withProcs` всегда true» валит это.
    const r = reg();
    tune(r, { hits: 3, speed: 2, cooldown: 0 });
    const donor = r.get('skill-tree').nodes.find((n) => n.effect.grantsInsert === 'ins-cold-wave')!;
    const s = new GameSession(r, 7, 'normal', { rewards: false });
    const save = newBotSave(r, 'warrior');
    save.skills[NODE] = 20; save.skills[donor.id] = 1;         // ранг 20 = все гнёзда открыты
    save.sockets = { [NODE]: ['ins-cold-wave'] };
    save.equipment.weapon = itemFromBaseId(r.get('items.base'), 'short-sword', r.get('item-tiers'))!;
    const p = s.addPlayer('p1', save);
    const def = generateMonster(r.get('monsters'), r.get('monster-gear'), r.get('monster-affixes'),
      { baseId: r.get('biomes')[0]!.monsterPool[0]!, depth: 1 }, createRng(4));
    def.hp = 1e9; def.armor = 0;
    const m = cellToWorld(7, 6);
    s.enterFloor(1, { grid: openField(20, 12), spawn: cellToWorld(6, 6), monsters: [{ def, x: m.x, y: m.y }] });
    const facing = Math.atan2(m.y - p.pos.y, m.x - p.pos.x);
    let casts = 0, wave = 0, swings = 0;
    for (let i = 0; i < 60 * 12; i++) {
      p.stamina = 1e6; p.mana = 1e6;
      const before = p.windup;
      for (const e of s.tick(1 / 60, { p1: { ...idle, facing, cast: NODE } })) {
        if (e.type === 'swing' && e.playerId === 'p1') { swings++; if (!before) casts++; }   // свинг без активного замаха = НОВОЕ применение
        // Вся волна конвертируется в холод (`convertPct: 1`), удары серии — физические.
        if (e.type === 'hit' && e.by === 'p1' && (e.byType.cold ?? 0) > 0) wave++;
      }
    }
    expect(casts, 'применений за 12 с').toBeGreaterThan(3);
    expect(swings, 'взмахов ровно втрое больше применений').toBe(casts * 3);
    expect(wave, '⚠ волна не сработала вовсе — тест проверял бы пустоту').toBeGreaterThan(0);
    expect(wave, '⚠ волна ударила больше раз, чем было применений').toBeLessThanOrEqual(casts);
  });

  it('⭐ У КАЖДОГО ВЗМАХА СВОЙ БРОСОК УРОНА — раньше три удара были копиями одного пакета', () => {
    const r = reg();
    tune(r, { hits: 3, speed: 2, cooldown: 0 });
    let varied = false;
    for (let seed = 1; seed <= 12 && !varied; seed++) {
      const d = cast(r, NODE, 2, seed).dmg.filter((x) => x > 0);
      if (d.length >= 2 && new Set(d).size > 1) varied = true;
    }
    expect(varied, '⚠ все удары серии дают одно и то же число — пакет строится один на всю серию').toBe(true);
  });
});

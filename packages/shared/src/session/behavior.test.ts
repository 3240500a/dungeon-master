import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { createRng } from '../formulas/rng.js';
import { generateMonster } from '../formulas/monstergen.js';
import { makeMonsterEntity } from '../world/state.js';
import { stepMonsterAi } from './ai.js';
import { behaviorFor, DEFAULT_BEHAVIOR } from './behavior.js';
import { Cell, makeGrid, cellToWorld, type Grid } from '../world/grid.js';
import { newBotSave } from '../sim/playerBot.js';
import { itemFromBaseId } from '../formulas/itemgen.js';
import { GameSession, type PlayerInput, type FloorLayout } from './session.js';

const r = (() => { const c = new ConfigRegistry(); c.loadAll(); return c; })();
const behaviors = r.get('monster-behaviors');
const mrng = createRng(1);
const monster = (baseId: string) =>
  makeMonsterEntity(1, generateMonster(r.get('monsters'), r.get('monster-gear'), r.get('monster-affixes'), { baseId, depth: 1 }, mrng), { x: 100, y: 100 }, 0);

describe('behaviorFor (резолвер профиля по фракции)', () => {
  it('возвращает профиль своей фракции; дефолт для неизвестной', () => {
    expect(behaviorFor('demon', behaviors).faction).toBe('demon');
    expect(behaviorFor('beast', behaviors).fleeHpPct).toBeGreaterThan(0); // звери отступают
    expect(behaviorFor('undead', behaviors).fleeHpPct).toBe(0);           // нежить fearless
    expect(behaviorFor('xxx', behaviors)).toBe(DEFAULT_BEHAVIOR);
  });
});

describe('LoS-гейт дальней атаки (блок A: не стрелять сквозь стену)', () => {
  it('стрелок, сагренный по слуху без LoS — НЕ стреляет; при LoS — стреляет', () => {
    const b = behaviorFor('undead', behaviors);
    const target = { x: 180, y: 100 }; // dist 80 (в пределах слуха 90 → агро) прямо перед монстром
    const roll = (los: boolean): 'attack' | 'shoot' | null => {
      const m = monster('zombie-archer'); m.facing = 0; m.attackCd = 0;
      return stepMonsterAi(m, target, b, los, 1, 1 / 30);
    };
    expect(roll(false)).not.toBe('shoot'); // сагрен слухом, но стены → не палит вслепую
    expect(roll(true)).toBe('shoot');      // видит → стреляет
  });
});

describe('flee (порог отхода fleeHpPct)', () => {
  it('мили с fleeHpPct>0 при низком HP отступает ОТ цели', () => {
    const b = behaviorFor('demon', behaviors); // fleeHpPct 0.35
    const m = monster('zombie'); // melee-chaser
    m.facing = 0; m.hp = m.maxHp * 0.1; // 10% < 35% → отход
    stepMonsterAi(m, { x: 130, y: 100 }, b, true, 1, 1 / 30); // цель справа (dist 30)
    expect(m.vel.x).toBeLessThan(0); // скорость направлена ОТ цели (влево)
  });

  it('fearless-мили (нежить, fleeHpPct=0) при низком HP всё равно идёт К цели', () => {
    const b = behaviorFor('undead', behaviors);
    const m = monster('zombie'); m.facing = 0; m.hp = m.maxHp * 0.05;
    stepMonsterAi(m, { x: 300, y: 100 }, b, true, 1, 1 / 30); // цель далеко справа
    expect(m.vel.x).toBeGreaterThan(0); // прёт вперёд (не отступает)
  });
});

describe('патфайндинг (блок B: обход стены)', () => {
  it('монстр за стеной с проходом переходит на сторону игрока (не застревает)', () => {
    const s = new GameSession(r, 7, 'normal');
    s.addPlayer('p1', newBotSave(r, 'warrior'));
    const cols = 18, rows = 14, wallX = 9;
    const g: Grid = makeGrid(cols, rows, Cell.Floor);
    for (let x = 0; x < cols; x++) { g[0]![x] = Cell.Wall; g[rows - 1]![x] = Cell.Wall; }
    for (let y = 0; y < rows; y++) { g[y]![0] = Cell.Wall; g[y]![cols - 1] = Cell.Wall; }
    for (let y = 1; y <= 4; y++) g[y]![wallX] = Cell.Wall; // короткая стена сверху, проход снизу
    const spawn = cellToWorld(7, 2);       // игрок слева от стены
    const mAt = cellToWorld(11, 2);        // монстр справа — прямой путь перекрыт
    const def = generateMonster(r.get('monsters'), r.get('monster-gear'), r.get('monster-affixes'), { baseId: 'zombie', depth: 1 }, createRng(3));
    s.enterFloor(1, { grid: g, spawn, monsters: [{ def, x: mAt.x, y: mAt.y }] } as FloorLayout);
    const m = s.world.monsters[0]!;   // держим ССЫЛКУ: монстр может погибнуть и вычеркнуться из w.monsters (линг трупа) — объект живёт, pos заморожен на месте смерти
    // игрок стоит и машет (шум держит агро); монстр обходит стену через нижний проход
    const swing: PlayerInput = { move: { x: 0, y: 0 }, facing: 0, attack: true, cast: null, interact: false };
    for (let i = 0; i < 400; i++) s.tick(1 / 30, { p1: swing });
    expect(m.pos.x).toBeLessThan(cellToWorld(wallX, 2).x); // перешёл на сторону игрока (жив или уже труп на этой стороне)
  });

  /**
   * ⚠ R10-02: ДИАГОНАЛЬНЫЙ ШОВ — комнаты касаются только углом (4,4)↔(5,5), обе боковые клетки — стены, а в обход ведёт
   * коридор. Видимость сквозь угол проходила (Bresenham не смотрел боковых клеток), тело — нет: монстр видел героя, шёл напрямую
   * и застревал у угла в 38 px — дальше своего удара (30), а герой бил его через угол (52 px). ЗАМЕР до правки: 68 ударов героя
   * за 120 с на настоящем этаже, у монстра ни одного. Теперь через шов не видно никому: герой не бьёт, монстр идёт в обход.
   */
  it('⭐ R10-02: у диагонального шва герой не бьёт через угол, а монстр обходит коридором и достаёт его', () => {
    const g: Grid = makeGrid(12, 10, Cell.Wall);
    const carve = (x0: number, y0: number, x1: number, y1: number): void => {
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) g[y]![x] = Cell.Floor;
    };
    carve(1, 1, 4, 4);   // комната героя
    carve(5, 5, 8, 8);   // комната монстра: с комнатой героя — только угол (4,4)↔(5,5)
    carve(5, 2, 9, 2);   // обход: коридор поверху…
    carve(9, 3, 9, 5);   // …и вниз, в комнату монстра
    const corner = { x: 5 * 32, y: 5 * 32 };
    const heroAt = { x: corner.x - 15, y: corner.y - 15 };   // вжат в угол шва со своей стороны
    const monAt = cellToWorld(6, 6);
    const def = generateMonster(r.get('monsters'), r.get('monster-gear'), r.get('monster-affixes'), { baseId: 'zombie', depth: 1 }, createRng(3));
    def.hp *= 60;   // не умрёт, дойдя: считаем, кто кого достаёт, а не кто победил
    const s = new GameSession(r, 7, 'normal');
    s.addPlayer('p1', newBotSave(r, 'warrior'));
    s.enterFloor(1, { grid: g, spawn: heroAt, monsters: [{ def, x: monAt.x, y: monAt.y }] } as FloorLayout);
    const p = s.world.players.p1!;
    const m = s.world.monsters[0]!;
    m.alertTimer = 5;   // заметил героя
    const farSide = (): boolean => Math.floor(m.pos.x / 32) >= 5 && Math.floor(m.pos.y / 32) >= 5;
    let heroHitsAcross = 0, monsterSwings = 0;
    for (let i = 0; i < 30 * 30 && monsterSwings === 0; i++) {
      p.pos = { ...heroAt };   // герой держит угол
      const facing = Math.atan2(m.pos.y - p.pos.y, m.pos.x - p.pos.x);
      const across = farSide();
      for (const e of s.tick(1 / 30, { p1: { move: { x: 0, y: 0 }, facing, attack: true, cast: null, interact: false } })) {
        if (e.type === 'hit' && e.target === 'monster' && e.hit && across) heroHitsAcross++;
        if (e.type === 'hit' && e.target === 'player') monsterSwings++;
      }
    }
    expect(heroHitsAcross, 'удары героя через шов').toBe(0);
    expect(monsterSwings, 'монстр обошёл коридором и дотянулся').toBeGreaterThan(0);
    expect(farSide(), 'бьёт со стороны героя, а не через угол').toBe(false);
  });

  /**
   * ⚠ R10-02 (страховка): видимость считается по клеткам, а тело — круг. С НАСТОЯЩЕГО этажа (crypt-halls, шов (29,9)↔(30,10)):
   * обходя шов, монстр выходит в клетку над стеной, откуда герой «виден» (линия клеток идёт поверху), и прёт напрямую — а круг
   * цепляет угол стены и сползает в клетку ниже, где видимости уже нет, и путь ведёт обратно наверх. Монстр дрожал на границе
   * клеток в 62 px от героя две минуты. Теперь погоня, которая не сдвигает монстра, сама переходит на путь в обход.
   */
  it('⭐ R10-02: у угла стены монстр не дрожит на границе клеток, а доходит до героя', () => {
    // Карман героя (3,2) из того этажа: стена справа (4,2) и снизу (3,3), шов в (4,3); сверху — открытый ряд 1.
    const g: Grid = makeGrid(7, 5, Cell.Wall);
    for (const [x, y] of [[1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [1, 2], [2, 2], [3, 2], [5, 2], [1, 3], [2, 3], [4, 3], [5, 3]] as const) g[y]![x] = Cell.Floor;
    const heroAt = { x: 4 * 32 - 15, y: 3 * 32 - 15 };   // вжат в угол шва
    const monAt = cellToWorld(4, 3);
    const def = generateMonster(r.get('monsters'), r.get('monster-gear'), r.get('monster-affixes'), { baseId: 'zombie', depth: 1 }, createRng(3));
    def.hp *= 60;
    const s = new GameSession(r, 7, 'normal');
    s.addPlayer('p1', newBotSave(r, 'warrior'));
    s.enterFloor(1, { grid: g, spawn: heroAt, monsters: [{ def, x: monAt.x, y: monAt.y }] } as FloorLayout);
    const p = s.world.players.p1!;
    const m = s.world.monsters[0]!;
    m.alertTimer = 5;
    let monsterSwings = 0;
    for (let i = 0; i < 30 * 30 && monsterSwings === 0; i++) {
      p.pos = { ...heroAt };
      const facing = Math.atan2(m.pos.y - p.pos.y, m.pos.x - p.pos.x);
      for (const e of s.tick(1 / 30, { p1: { move: { x: 0, y: 0 }, facing, attack: true, cast: null, interact: false } })) {
        if (e.type === 'hit' && e.target === 'player') monsterSwings++;
      }
    }
    expect(monsterSwings, `монстр дошёл и ударил (стоит в ${Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y).toFixed(1)} px)`).toBeGreaterThan(0);
  });

  /**
   * ⚠ R10-02 (страховка, тот же класс без всякого шва): с настоящего этажа (rift-rest). Герой (радиус 14) вжат в угол
   * коридора, уник (радиус 15) идёт к нему по коридору точно по оси — и на полпикселя не влезает под угол стены над проходом:
   * круг цепляет её, скользить некуда (скорость — ровно по оси), а видимость по клеткам чистая. Уник стоял в 64.5 px, копьё
   * героя (52 × 1.8) било его безнаказанно: 22 такие точки из 800 случайных углов настоящих этажей до сторожа, 0 — после.
   */
  it('⭐ R10-02: уник, не влезающий под угол коридора, обходит — копьё героя из угла не бьёт безнаказанно', () => {
    const g: Grid = makeGrid(9, 6, Cell.Wall);
    for (let x = 1; x <= 7; x++) for (let y = 2; y <= 4; y++) g[y]![x] = Cell.Floor;   // коридор героя
    g[1]![4] = Cell.Floor; g[1]![5] = Cell.Floor;                                       // проход сверху; (6,1) — угол стены
    const heroAt = { x: 8 * 32 - 14.5, y: 2 * 32 + 14.5 };   // вжат в верхний правый угол клетки (7,2)
    const monAt = cellToWorld(4, 1);
    const def = generateMonster(r.get('monsters'), r.get('monster-gear'), r.get('monster-affixes'), { baseId: 'zombie', depth: 1 }, createRng(3));
    def.hp *= 200;
    def.rarity = 'unique';   // радиус 15
    const save = newBotSave(r, 'warrior');
    save.attributes = { strength: 300, dexterity: 300, intelligence: 50, vitality: 300 };
    save.equipment.weapon = itemFromBaseId(r.get('items.base'), 'short-spear', r.get('item-tiers'), 'start')!;
    const s = new GameSession(r, 7, 'normal');
    s.addPlayer('p1', save);
    s.enterFloor(1, { grid: g, spawn: heroAt, monsters: [{ def, x: monAt.x, y: monAt.y }] } as FloorLayout);
    const p = s.world.players.p1!;
    const m = s.world.monsters[0]!;
    expect(m.radius).toBe(15);
    m.alertTimer = 5;
    let heroHits = 0, monsterSwings = 0;
    for (let i = 0; i < 30 * 20 && monsterSwings === 0; i++) {
      p.pos = { ...heroAt }; p.hp = p.maxHp;
      const facing = Math.atan2(m.pos.y - p.pos.y, m.pos.x - p.pos.x);
      for (const e of s.tick(1 / 30, { p1: { move: { x: 0, y: 0 }, facing, attack: true, cast: null, interact: false } })) {
        if (e.type === 'hit' && e.target === 'monster' && e.hit) heroHits++;
        if (e.type === 'hit' && e.target === 'player') monsterSwings++;
      }
    }
    expect(monsterSwings, `уник дошёл и ударил (стоит в ${Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y).toFixed(1)} px, ударов героя ${heroHits})`).toBeGreaterThan(0);
  });

  it('R10-02: честная погоня обхода не включает — ни в поле за убегающим героем, ни у цели, по которой бьёт', () => {
    const g: Grid = makeGrid(40, 30, Cell.Floor);
    for (let x = 0; x < 40; x++) { g[0]![x] = Cell.Wall; g[29]![x] = Cell.Wall; }
    for (let y = 0; y < 30; y++) { g[y]![0] = Cell.Wall; g[y]![39] = Cell.Wall; }
    const def = generateMonster(r.get('monsters'), r.get('monster-gear'), r.get('monster-affixes'), { baseId: 'zombie', depth: 1 }, createRng(3));
    def.hp *= 60;
    const s = new GameSession(r, 7, 'normal');
    s.addPlayer('p1', newBotSave(r, 'warrior'));
    const heroAt = cellToWorld(20, 15);
    const monAt = cellToWorld(10, 15);
    s.enterFloor(1, { grid: g, spawn: heroAt, monsters: [{ def, x: monAt.x, y: monAt.y }] } as FloorLayout);
    const p = s.world.players.p1!;
    const m = s.world.monsters[0]!;
    m.alertTimer = 5;
    let detours = 0, swings = 0;
    for (let i = 0; i < 30 * 12; i++) {
      // 6 с герой уходит по кругу (монстр гонится), потом стоит и бьёт в ответ.
      const moving = i < 30 * 6;
      const a = i / 40;
      const facing = Math.atan2(m.pos.y - p.pos.y, m.pos.x - p.pos.x);
      for (const e of s.tick(1 / 30, { p1: { move: moving ? { x: Math.cos(a), y: Math.sin(a) } : { x: 0, y: 0 }, facing, attack: !moving, cast: null, interact: false } })) {
        if (e.type === 'hit' && e.target === 'player') swings++;
      }
      if (m.detour > 0) detours++;
    }
    expect(swings, 'погоня дошла до удара').toBeGreaterThan(0);
    expect(detours, 'обход не включался ни разу').toBe(0);
  });
});

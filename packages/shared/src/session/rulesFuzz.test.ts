import { describe, it, expect, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { ConfigRegistry } from '../config/registry.js';
import { createRng } from '../formulas/rng.js';
import { generateMonster } from '../formulas/monstergen.js';
import { itemFromBaseId } from '../formulas/itemgen.js';
import { newCharacterSave, fitToClass } from '../economy/newCharacter.js';
import { equip, unequip, respecSkills, socketClear, socketInsert } from '../economy/townActions.js';
import { addToInventory } from '../inventory/grid.js';
import { Cell, TILE, makeGrid, cellToWorld, type Grid } from '../world/grid.js';
import { moveWithCollision } from '../world/movement.js';
import { spawnPacksEl } from '../dungeon/floor.js';
import type { SaveState } from '../types/save.js';
import type { PlayerEntity } from '../world/state.js';
import { GameSession, type PlayerInput, type SessionEvent } from './session.js';
import { playerSnapshot, type PlayerSnapshot } from './derive.js';
import { effectivePool, reservedFrac } from './toggles.js';

/**
 * ⭐ B2: ФАЗЗЕР ПРАВИЛ ИГРЫ. Вместо ручного обзора — случайные цепочки НАСТОЯЩЕГО ввода и команд над настоящим `GameSession`
 * (этажи генератора забега и компактная арена, 1–3 героя со скилами, вставками и снаряжением, монстры из пулов) с инвариантами
 * правил после КАЖДОГО тика: движение (скорость, стены, двери, шов), урон (дальность, дуга, видимость, оружие, снаряжение замаха),
 * темп (лок удара, откаты, серии), скилы и ресурсы (невыученное не срабатывает, цена списана, пулы в рамках), взаимодействие и
 * добыча (радиус, видимость, чужое, двери, дюп), прокачка (опыт только за убийство, очки по таблице), ничего не бросает.
 * Модель и инварианты — `fuzz/rulesFuzz.ts`.
 *
 * Умолчание — постоянный набор сидов (быстро, в полном прогоне). Больше: `DM_FUZZ_SEEDS=2000` (сколько цепочек),
 * `DM_FUZZ_FROM` (первый сид), `DM_FUZZ_LEN` (шагов в цепочке), `DM_FUZZ_OUT` (JSON-сводка нарушений в файл),
 * `DM_FUZZ_PROFILE=combat|world` (перевес боя или команд мира), `DM_FUZZ_ALL=1` (печатать и известные).
 * Нарушение печатается сидом и СЖАТОЙ цепочкой (`shrink`): выброшено всё, без чего оно не воспроизводится.
 */

// uid вещей — счётчиком, а не временем и `Math.random` (`uuidv7`): повтор цепочки при сжатии обязан собрать тот же мир.
const uid = vi.hoisted(() => ({ n: 0 }));
vi.mock('../formulas/uuid.js', async (orig) => {
  const real = await orig<typeof import('../formulas/uuid.js')>();
  return { ...real, uuidv7: (): string => `00000000-0000-7000-8000-${(++uid.n).toString(16).padStart(12, '0')}` };
});

const { OP_WEIGHTS, genOps, runOps, shrink, violationKey } = await import('./fuzz/rulesFuzz.js');
type Op = import('./fuzz/rulesFuzz.js').Op;
type OpKind = import('./fuzz/rulesFuzz.js').OpKind;
type RunOut = import('./fuzz/rulesFuzz.js').RunOut;
type World = import('./fuzz/rulesFuzz.js').FuzzWorld;

const env = (k: string, d: number): number => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? Math.floor(v) : d; };
const SEEDS = env('DM_FUZZ_SEEDS', 30);
const FROM = env('DM_FUZZ_FROM', 1);
const LEN = env('DM_FUZZ_LEN', 80);
/**
 * Профили (`DM_FUZZ_PROFILE`): `combat` — тики чаще (бой, [E], пояс, рывки), `world` — команды мира и смены посреди замаха,
 * `pvp` — арены с PvP и пати от двух героев, `floor` — этажи генератора забега почти без арен, `pillars` — арены с колоннами
 * в линии огня (C-10: снаряды и преграды декора, закрывающие обзор), `levelup` — арены, все герои на пороге уровня (R15-10:
 * левелап поверх аур, стоек и баффов).
 */
const PROFILES: Record<string, { weights?: Partial<Record<OpKind, number>>; world?: import('./fuzz/rulesFuzz.js').FuzzHooks['world'] }> = {
  combat: { weights: { ...OP_WEIGHTS, tick: 80 } },
  world: { weights: { ...OP_WEIGHTS, equip: 12, unequip: 6, socket: 8, respecSkills: 6, allocSkill: 5, chest: 8, lever: 8, pickup: 10, hold: 5, drop: 5 } },
  pvp: { weights: { ...OP_WEIGHTS, tick: 60, revive: 4 }, world: { arena: 0.95, pvp: 0.8, minHeroes: 2 } },
  floor: { world: { arena: 0.1 } },
  pillars: { weights: { ...OP_WEIGHTS, tick: 60 }, world: { arena: 1, pillars: 1 } },
  levelup: { weights: { ...OP_WEIGHTS, tick: 60 }, world: { arena: 1, levelup: true } },
};
const PROFILE = PROFILES[process.env.DM_FUZZ_PROFILE ?? ''] ?? {};
const WEIGHTS = PROFILE.weights ?? OP_WEIGHTS;
const hooks = { resetUids: (): void => { uid.n = 0; }, ...(PROFILE.world ? { world: PROFILE.world } : {}) };

/**
 * ИЗВЕСТНЫЕ НАРУШЕНИЯ — найдены фаззером, ждут правки ядра (шаг «исправить»). Ключ — `инвариант:код:шаг` (`violationKey`) по
 * образцу, значение — id нарушения в отчёте (у каждого — своё воспроизведение `it.fails` ниже). После правки строку убрать и
 * `it.fails` сделать `it`: фаззер снова стережёт этот ключ.
 */
const KNOWN: [RegExp, string][] = [
  // Пусто: V-RF-01…06 поправлены в ядре (их воспроизведения ниже — обычные `it`, сторожа правок).
];
const knownId = (key: string): string | undefined => KNOWN.find(([re]) => re.test(key))?.[1];
const REPORT_KNOWN = !!process.env.DM_FUZZ_ALL;

/** Воспроизведение известного нарушения: `it.fails`, пока не поправлено; `DM_FUZZ_SHOW_KNOWN=1` — обычный `it` (показать, как падает). */
const itKnown = process.env.DM_FUZZ_SHOW_KNOWN ? it : it.fails;

interface Hit { seed: number; ops: Op[]; out: RunOut }

function report(key: string, h: Hit): string {
  const f = h.out.found!;
  return [
    `✗ ${key} — сид ${h.seed}, шагов в сжатой цепочке: ${h.ops.length}`,
    `  ${f.v.inv}/${f.v.code}: ${f.v.msg}`,
    `  цепочка: ${JSON.stringify(h.ops)}`,
    ...f.log.map((l) => `    ${l}`),
  ].join('\n');
}

/**
 * У СТОРОЖА ЕСТЬ ЗУБЫ: в сессию подкладывается «баг» — и фаззер обязан поймать его ТЕМ инвариантом, что его стережёт. Иначе
 * зелёный прогон значил бы только «проверки ничего не видят». `install` подменяет метод экземпляра ДО наблюдателя (его обёртки
 * снаружи и видят подмену как поведение ядра), `afterTick` правит мир после тика.
 */
type Any = Record<string, (...a: never[]) => unknown>;
const patch = (w: World, name: string, make: (orig: (...a: unknown[]) => unknown) => (...a: unknown[]) => unknown): void => {
  const S = w.s as unknown as Any;
  const orig = (S[name] as (...a: unknown[]) => unknown).bind(w.s);
  S[name] = make(orig) as (...a: never[]) => unknown;
};
const BUGS: { name: string; want: RegExp; hooks: Partial<import('./fuzz/rulesFuzz.js').FuzzHooks> }[] = [
  {
    name: 'шаг длиннее скорости', want: /^I1:speed:/,
    hooks: { install: (w) => patch(w, 'stepPlayerInput', (o) => (...a) => { const r = o(...a); const p = a[0] as { pos: { x: number }; vel: { x: number } }; if (p.vel.x > 0) p.pos.x += 3; return r; }) },
  },
  {
    name: 'сквозь стену: телепорт в другую область', want: /^I1:(region|in-wall):/,
    hooks: {
      afterTick: (w) => {
        const p = Object.values(w.s.world.players)[0]!;
        const here = w.regions.at(p.pos);
        for (let y = 1; y < w.s.world.grid.length - 1; y++) for (let x = 1; x < (w.s.world.grid[0]?.length ?? 0) - 1; x++) {
          const at = { x: x * 32 + 16, y: y * 32 + 16 };
          const rg = w.regions.at(at);
          if (rg >= 0 && rg !== here) { p.pos = at; return; }
        }
      },
    },
  },
  { name: 'удар сквозь стену (видимость всегда есть)', want: /^I2:\w+-los:/, hooks: { install: (w) => patch(w, 'hasLos', () => () => true) } },
  {
    // C-10: полёт снарядов не видит преград декора (как было до правки: подшаг смотрел только сетку).
    name: 'снаряд сквозь колонну, закрывающую обзор', want: /^(I2|M2):proj-los:/,
    hooks: {
      world: { arena: 1, pillars: 1 },
      install: (w) => patch(w, 'stepProjectiles', (o) => (...a) => {
        const W = w.s.world, ob = W.obstacles;
        W.obstacles = [];
        try { return o(...a); } finally { W.obstacles = ob; }
      }),
    },
  },
  {
    name: 'взмах вдвое длиннее', want: /^I2:melee-(range|mult):/,
    hooks: { install: (w) => patch(w, 'meleeSwing', (o) => (...a) => { const b = [...a]; b[5] = ((b[5] as number | undefined) ?? 1) * 2; return o(...b); }) },
  },
  { name: 'откат не держится', want: /^I3:/, hooks: { afterTick: (w) => { for (const p of Object.values(w.s.world.players)) { p.attackCd = 0; p.skillCd = {}; } } } },
  {
    name: 'каст невыученного', want: /^I4:unlearned-cast:/,
    hooks: {
      install: (w) => patch(w, 'castSkill', (o) => (...a) => {
        const p = a[0] as { save: { skills: Record<string, number> } }; const id = a[2] as string;
        const had = p.save.skills[id]; p.save.skills[id] = Math.max(1, had ?? 0);
        try { return o(...a); } finally { if (had === undefined) delete p.save.skills[id]; else p.save.skills[id] = had; }
      }),
    },
  },
  // C-11: бафф колбы не вешается (как было: сервер отдавал только мгновенный эффект) — и бафф без колбы.
  { name: 'колба с баффом без баффа', want: /^I5:potion-buff-lost:/, hooks: { install: (w) => patch(w, 'drinkBuff', () => () => false) } },
  {
    name: 'бафф зелья даром', want: /^I5:potion-buff-free:/,
    hooks: { afterTick: (w) => { for (const p of Object.values(w.s.world.players)) if (p.alive) p.skillBuffs['pot:fuzz-haste-potion'] = 6; } },
  },
  { name: 'мана из ниоткуда', want: /^I6:mana-(max|reserve):/, hooks: { afterTick: (w) => { for (const p of Object.values(w.s.world.players)) if (p.alive) p.mana += 500; } } },
  {
    // R15-10: левелап лечит голым сейвом и кладёт его в снимок тика (как было: без аур, стоек и баффов).
    name: 'левелап без аур и стоек', want: /^I6:levelup-(heal|snap):/,
    hooks: {
      world: { levelup: true, arena: 1 },
      install: (w) => patch(w, 'awardXp', (o) => (...a) => {
        const p = a[0] as PlayerEntity;
        const lv = p.save.level;
        const out = o(...a);
        if (p.alive && p.save.level > lv) {
          const snap = playerSnapshot(p.save, w.reg);
          p.hp = snap.derived.maxHp;
          (w.s as unknown as { snaps: Map<string, PlayerSnapshot> }).snaps.set(p.id, snap);
        }
        return out;
      }),
    },
  },
  { name: 'опыт без убийства', want: /^I6:(xp|level|points)/, hooks: { afterTick: (w) => { for (const p of Object.values(w.s.world.players)) p.save.xp += 1; } } },
  { name: 'подбор издалека', want: /^I5:pickup-(range|los):/, hooks: { install: (w) => patch(w, 'within', () => () => true) } },
  { name: 'дверь открылась сама', want: /^I5:door-open:/, hooks: { afterTick: (w) => { const d = w.s.world.doors[0]; const c = d?.cells[0]; if (c) w.s.world.grid[c.cy]![c.cx] = 0; } } },
];

describe('⭐ B2: у сторожа правил есть зубы — подложенный баг ловится своим инвариантом', () => {
  for (const b of BUGS) {
    it(b.name, () => {
      const got = new Set<string>();
      for (let seed = 1; seed <= 40 && ![...got].some((k) => b.want.test(k)); seed++) {
        const out = runOps(seed, genOps(seed, 60, { ...OP_WEIGHTS, tick: 60, pickup: 10, lever: 10 }), { ...hooks, ...b.hooks }, undefined, (k) => !b.want.test(k));
        if (out.found) got.add(violationKey(out.found));
      }
      expect([...got].some((k) => b.want.test(k)), `ждали ${b.want}, поймано: ${[...got].join(', ') || 'ничего'}`).toBe(true);
    }, 120_000);
  }
});

describe('⭐ B2: фаззер правил — инварианты после каждого тика', () => {
  it(`${SEEDS} цепочек по ${LEN} шагов (сиды ${FROM}…${FROM + SEEDS - 1}): ни одного нарушения, кроме известных`, () => {
    const found = new Map<string, Hit>();
    const initHits = new Map<string, { seed: number; msg: string }>();
    const cover: Record<string, number> = {};
    const stats: Record<string, { ok: number; no: number }> = {};
    let ticks = 0;
    for (let seed = FROM; seed < FROM + SEEDS; seed++) {
      const ops = genOps(seed, LEN, WEIGHTS);
      // Нарушение останавливает цепочку — повторяем её мимо уже найденных ключей: частое не заслоняет редкие.
      const skip = new Set(found.keys());
      for (let pass = 0; pass < 8; pass++) {
        const out = runOps(seed, ops, hooks, undefined, (k) => skip.has(k) || (!REPORT_KNOWN && !!knownId(k)));
        if (pass === 0) {
          ticks += out.ticks;
          for (const v of out.init) { const k = `${v.inv}:${v.code}:init`; if (!initHits.has(k) && (REPORT_KNOWN || !knownId(k))) initHits.set(k, { seed, msg: v.msg }); }
          for (const [k, n] of Object.entries(out.cover)) cover[k] = (cover[k] ?? 0) + n;
          for (const [k, v] of Object.entries(out.stats)) { const t = (stats[k] ??= { ok: 0, no: 0 }); t.ok += v.ok; t.no += v.no; }
        }
        if (!out.found) break;
        const key = violationKey(out.found);
        const had = found.get(key);
        if (!had || out.found.at < had.out.found!.at) found.set(key, { seed, ops, out });
        skip.add(key);
      }
    }
    const shrunk = new Map<string, Hit>();
    for (const [key, h] of found) {
      const s = shrink(h.seed, h.ops, key, hooks);
      shrunk.set(key, { seed: h.seed, ops: s.ops, out: s.out.found ? s.out : h.out });
    }
    const lines = [
      ...[...initHits].map(([k, h]) => `✗ ${k} — стартовое состояние сида ${h.seed}\n  ${h.msg}`),
      ...[...shrunk].map(([k, h]) => report(k, h)),
    ];
    if (lines.length) console.log(lines.join('\n\n'));
    if (process.env.DM_FUZZ_VERBOSE) {
      console.log(`тиков: ${ticks}`);
      console.log(Object.entries(cover).sort().map(([k, n]) => `${k}=${n}`).join('  '));
      console.log(Object.entries(stats).sort().map(([k, v]) => `${k} ок ${v.ok} отказ ${v.no}`).join(' | '));
    }
    if (process.env.DM_FUZZ_OUT) {
      writeFileSync(process.env.DM_FUZZ_OUT, JSON.stringify({
        from: FROM, seeds: SEEDS, len: LEN, ticks, cover, stats,
        init: [...initHits].map(([k, h]) => ({ key: k, ...h })),
        found: [...shrunk].map(([k, h]) => ({ key: k, seed: h.seed, ops: h.ops, v: h.out.found!.v, log: h.out.found!.log })),
      }, null, 1));
    }
    // Фаззер стережёт не пустоту: бой, касты, подбор и сундуки действительно случаются.
    if (SEEDS >= 12) {
      for (const k of ['attack', 'cast', 'ev-hit', 'ev-monster-died', 'pick-auto', 'chest', 'belt-buff'] as const) expect(cover[k] ?? 0, `«${k}» за прогон`).toBeGreaterThan(0);
    }
    const unknown = [...initHits.keys(), ...shrunk.keys()].filter((k) => !knownId(k));
    expect(unknown, lines.join('\n\n')).toEqual([]);
  }, Math.max(300_000, SEEDS * LEN * 60));
});

/**
 * ⚠ C-10: КОЛОННЫ В ЛИНИИ ОГНЯ — свой профиль мира: только арены, на пути от входа героев вглубь комнаты 1–3 преграды, почти все
 * закрывают обзор. Снаряд сквозь такую колонну (подшаг смотрел только сетку) общий профиль не видел ни разу за сотни цепочек:
 * случайные преграды попадают под выстрел редко. Этот — в первых же (зубы — «снаряд сквозь колонну» выше).
 */
describe('⚠ C-10: фаззер правил — колонны в линии огня', () => {
  it('16 цепочек по 80 шагов: ни одного нарушения; снаряды у колонн летали и попадали', () => {
    const hits: string[] = [];
    const cover: Record<string, number> = {};
    for (let seed = 1; seed <= 16; seed++) {
      const out = runOps(seed, genOps(seed, 80, PROFILES.pillars!.weights), { ...hooks, world: PROFILES.pillars!.world }, undefined, (k) => !REPORT_KNOWN && !!knownId(k));
      if (out.found) hits.push(`✗ ${violationKey(out.found)} — сид ${seed}: ${out.found.v.msg}\n    ${out.found.log.slice(-8).join('\n    ')}`);
      for (const [k, n] of Object.entries(out.cover)) cover[k] = (cover[k] ?? 0) + n;
    }
    expect(hits, hits.join('\n\n')).toEqual([]);
    expect(cover['proj-pillar'] ?? 0, 'снаряды у колонн').toBeGreaterThan(0);
    expect(cover['hit-proj'] ?? 0, 'снаряды попадали').toBeGreaterThan(0);
  }, 120_000);
});

/**
 * ⚠ R15-10: ЛЕВЕЛАП В БОЮ — свой профиль мира: только арены, все герои на пороге уровня. В общем профиле убийств мало, и левелап
 * с включённой аурой/стойкой/баффом случался раз на сотни цепочек: полное лечение голым сейвом (герой в стойке +15 % к жизни вставал
 * на ~87 %, снимок тика терял ауры и стойки) сторож не видел. Этот — в первых же (зубы — «левелап без аур и стоек» выше).
 */
describe('⚠ R15-10: фаззер правил — левелап в бою', () => {
  it('16 цепочек по 80 шагов: ни одного нарушения; левелап поверх аур/стоек/баффов случался', () => {
    const hits: string[] = [];
    const cover: Record<string, number> = {};
    for (let seed = 1; seed <= 16; seed++) {
      const out = runOps(seed, genOps(seed, 80, PROFILES.levelup!.weights), { ...hooks, world: PROFILES.levelup!.world }, undefined, (k) => !REPORT_KNOWN && !!knownId(k));
      if (out.found) hits.push(`✗ ${violationKey(out.found)} — сид ${seed}: ${out.found.v.msg}\n    ${out.found.log.slice(-8).join('\n    ')}`);
      for (const [k, n] of Object.entries(out.cover)) cover[k] = (cover[k] ?? 0) + n;
    }
    expect(hits, hits.join('\n\n')).toEqual([]);
    expect(cover['levelup-mods'] ?? 0, 'левелап с аурой/стойкой/баффом').toBeGreaterThan(0);
  }, 120_000);

  // ⭐ Перепрогон R15 (профиль levelup, сид 7650274; сжато фаззером). МОДЕЛЬ ФАЗЗЕРА: левелап в том тике, где истекает бафф зелья жизни
  // (осталось 4e-15 с), лечит до максимума С баффом — он ещё на герое (R15-10), — а к концу тика бафф истёк: здоровье и мана на тик выше и
  // начального, и конечного максимума, следующий тик их подрезает (как любой истёкший бафф). Максимум тика — и тот, что был в миг левелапа.
  it('перепрогон R15: левелап в тик, где истекает бафф зелья, — не «выше максимума»', () => {
    const ops = [
      { k: 'unequip', h: 2, s: 1704321804 }, { k: 'tick', h: 2, s: 1556017917 }, { k: 'tick', h: 0, s: 1038034840 },
      { k: 'tick', h: 0, s: 1311675429 }, { k: 'tick', h: 1, s: 337817274 }, { k: 'tick', h: 0, s: 1166014481 },
    ] as Op[];
    const out = runOps(7650274, ops, { resetUids: hooks.resetUids, world: PROFILES.levelup!.world });
    expect(out.found ? `${violationKey(out.found)}: ${out.found.v.msg}` : null).toBeNull();
  });
});

/**
 * НАЙДЕННОЕ ФАЗЗЕРОМ ПРАВИЛ — МИНИМАЛЬНЫЕ ВОСПРОИЗВЕДЕНИЯ (id — как в отчёте). Каждое утверждает ПРАВИЛЬНОЕ поведение; поправленное —
 * обычный `it` (сторож правки), ещё не поправленное — `itKnown` (`it.fails`) со строкой в `KNOWN`.
 */
describe('B2: нарушения правил, найденные фаззером (сторожа правок ядра)', () => {
  const reg = new ConfigRegistry();
  reg.loadAll();
  const idle: PlayerInput = { move: { x: 0, y: 0 }, facing: 0, attack: false, cast: null, interact: false };
  /** Открытое поле с бордюром-стеной. */
  const field = (cols: number, rows: number): Grid => {
    const g = makeGrid(cols, rows, Cell.Floor);
    for (let x = 0; x < cols; x++) { g[0]![x] = Cell.Wall; g[rows - 1]![x] = Cell.Wall; }
    for (let y = 0; y < rows; y++) { g[y]![0] = Cell.Wall; g[y]![cols - 1] = Cell.Wall; }
    return g;
  };
  /** Монстр-манекен: `hp`, без брони, уклонения и урона (не мешает и не убивает). */
  const dummy = (hp: number) => {
    const def = generateMonster(reg.get('monsters'), reg.get('monster-gear'), reg.get('monster-affixes'), { baseId: reg.get('biomes')[0]!.monsterPool[0]!, depth: 1 }, createRng(5));
    def.hp = hp; def.armor = 0; def.evade = 0; def.minDamage = 0; def.maxDamage = 0; def.accuracy = 0; def.xp = 50;
    return def;
  };
  /** Герой класса в оружии базы `weaponId` (требования — по руке, как стартовый комплект). */
  const hero = (classId: string, weaponId: string, tag: string): SaveState => {
    const s = newCharacterSave(reg, classId, 'Ф', tag);
    if (s.equipment.weapon) unequip(reg, s, 'weapon');
    const w = fitToClass(itemFromBaseId(reg.get('items.base'), weaponId, reg.get('item-tiers'), 'drop')!, s.attributes);
    addToInventory(s.inventory, w, reg.get('balance').inventory);
    expect(equip(reg, s, w.uid).ok, `надеть ${weaponId}`).toBe(true);
    s.level = 5;
    s.gold = 1_000_000;
    return s;
  };

  // I6:mana-reserve. Мана «за убийство» (`killMonster`: `min(maxMana, …)`) и вампиризм маны (`hitMonster`: `min(d.maxMana, …)`) кладут
  // до ПОЛНОГО пула, мимо резерва аур. Реген подрезает её только на следующем тике — и каст первого шага того тика платит маной выше
  // резерва. Зелье маны это уже чинило (C-14: до эффективного потолка), удар — нет.
  it('V-RF-01: мана за убийство не наливается выше резерва ауры', () => {
    const s = new GameSession(reg, 21, 'normal');
    const save = hero('archer', 'short-bow', 'v-rf-01');
    save.skills['b-aura-a1'] = 1;   // аура резервирует 25% маны
    save.equipment.weapon!.affixes.push({ affixId: 'test', kind: 'suffix', modifier: { stat: 'manaOnKill', kind: 'flat', value: 40 } });
    const p = s.addPlayer('p1', save);
    const at = cellToWorld(12, 6);
    s.enterFloor(1, { grid: field(20, 12), spawn: cellToWorld(5, 6), monsters: [{ def: dummy(1), x: at.x, y: at.y }] });
    s.tick(1 / 30, { p1: { ...idle, cast: 'b-aura-a1' } });
    expect(p.toggles, 'аура включена').toEqual(['b-aura-a1']);
    let killed = false;
    for (let i = 0; i < 300 && !killed; i++) {
      const ev = s.tick(1 / 30, { p1: { ...idle, attack: true, facing: 0 } });
      killed = ev.some((e) => e.type === 'monster-died' && e.by === 'p1');
    }
    expect(killed, 'стрела убила манекен').toBe(true);
    const max = s.snapshotOf('p1')!.derived.maxMana;
    expect(p.mana, 'мана не выше резерва ауры').toBeLessThanOrEqual(effectivePool(max, reservedFrac(reg, p.toggles, 'mana')) + 1e-6);
  });

  // I4:unlearned-fires. Сброс скилов (`respecSkills` — команда «везде», между тиками) не трогает идущий замах: `dropUnlearned` чистит
  // тоглы и баффы, а замах (и вся серия взмахов) доживает и бьёт узлом ранга 0. Подпись замаха (R6-02) — снаряжение и тоглы, скилы в неё
  // не входят. Очки при этом уже возвращены.
  it('V-RF-02: сброс скилов посреди замаха — замах не бьёт', () => {
    const s = new GameSession(reg, 22, 'normal');
    const save = hero('warrior', 'short-sword', 'v-rf-02');
    save.skills['b-sword1h-a1'] = 1;   // «Град ударов»: 3 взмаха мечом
    const p = s.addPlayer('p1', save);
    const at = cellToWorld(7, 6);
    s.enterFloor(1, { grid: field(20, 12), spawn: cellToWorld(6, 6), monsters: [{ def: dummy(1e6), x: at.x, y: at.y }] });
    const ev0 = s.tick(1 / 30, { p1: { ...idle, cast: 'b-sword1h-a1', facing: 0 } });
    expect(ev0.some((e) => e.type === 'swing' && e.ability === 'b-sword1h-a1'), 'замах начат').toBe(true);
    expect(respecSkills(reg, save).ok, 'сброс прошёл').toBe(true);
    const hits: SessionEvent[] = [];
    for (let i = 0; i < 60; i++) hits.push(...s.tick(1 / 30, { p1: idle }).filter((e) => e.type === 'hit' && e.by === 'p1'));
    expect(save.skills['b-sword1h-a1'] ?? 0, 'скил сброшен').toBe(0);
    expect(hits.length, 'сброшенный скил не бьёт').toBe(0);
    expect(p.windup, 'замах снят').toBeNull();
  });

  // I5:refusal-mutates:socket. `socketTarget` (общая проверка «вставить/вынуть») добивает `save.sockets[узел]` пустыми гнёздами ДО проверок
  // вставки: отказ «Вставка не открыта в дереве», «Этой вставке здесь не место», «уже стоит в другом гнезде», «Гнездо и так пусто» меняет
  // сейв (как V-B2-01 у пояса).
  it('V-RF-03: отказ «вставить/вынуть» не трогает сейв', () => {
    const s = newCharacterSave(reg, 'mage', 'Ф', 'v-rf-03');
    s.level = 5;
    s.skills['b-fire-a1'] = 1;   // одно гнездо открыто
    const before = JSON.stringify(s);
    const r1 = socketClear(reg, s, 'b-fire-a1', 0);
    expect(r1.ok).toBe(false);
    expect(JSON.stringify(s), `отказ «${r1.reason}» изменил сейв`).toBe(before);
    const locked = reg.get('skill-inserts').find((i) => i.enabled !== false)!;
    const r2 = socketInsert(reg, s, 'b-fire-a1', 0, locked.id);
    expect(r2.ok).toBe(false);
    expect(JSON.stringify(s), `отказ «${r2.reason}» изменил сейв`).toBe(before);
  });

  // I6:xp-dead. Награда убийцы не смотрит, жив ли он: стрела/бумеранг в полёте (`projectileHit` берёт хозяина из мира и живым, и мёртвым)
  // и статус хозяина (`dotOwner`) засчитывают убийство трупу — опыт, а на левелапе ещё и полное здоровье трупу (`awardXp`: hp = max при
  // alive = false). R5-06 прямо называет «опыт мёртвому альту» неправильной наградой — но решил её только для ушедших из комнаты.
  it('V-RF-04: убийство после смерти героя не даёт ему опыта', () => {
    const s = new GameSession(reg, 23, 'normal');
    const save = hero('archer', 'short-bow', 'v-rf-04');
    const p = s.addPlayer('p1', save);
    const at = cellToWorld(16, 6);
    s.enterFloor(1, { grid: field(20, 12), spawn: cellToWorld(3, 6), monsters: [{ def: dummy(1), x: at.x, y: at.y }] });
    for (let i = 0; i < 60 && s.world.projectiles.length === 0; i++) s.tick(1 / 30, { p1: { ...idle, attack: true, facing: 0 } });
    expect(s.world.projectiles.length, 'стрела в полёте').toBeGreaterThan(0);
    p.hp = 0; p.alive = false;   // гибель — как в `hitPlayer`
    const xp0 = save.xp;
    const ev: SessionEvent[] = [];
    for (let i = 0; i < 90 && s.monstersAlive > 0; i++) ev.push(...s.tick(1 / 30, {}));
    expect(ev.some((e) => e.type === 'monster-died'), 'стрела убила манекен').toBe(true);
    expect(save.xp, 'мёртвый опыта не получает').toBe(xp0);
    expect(ev.find((e) => e.type === 'monster-died')?.by, 'убийство не засчитано павшему («Уничтожить N»)').toBeUndefined();
    expect(p.hp, 'труп не лечится').toBe(0);
  });

  // V-RF-04 (то же правило, другой путь): шипы (`hitTakenEffects.reflectPct`) добивали монстра, пока смертельно раненый ещё числился
  // живым, — «жизнь за убийство» поднимала его с нуля: бесплатное воскрешение. Смерть теперь решается ДО отражения. (Шипов в
  // конфиге сегодня нет — отражение подкладывается подменой.)
  it('V-RF-04: шипы добили монстра смертельным ударом — павший не лечится и не получает опыта', () => {
    const s = new GameSession(reg, 24, 'normal');
    const save = hero('warrior', 'short-sword', 'v-rf-04b');
    save.equipment.weapon!.affixes.push({ affixId: 'test', kind: 'suffix', modifier: { stat: 'lifeOnKill', kind: 'flat', value: 500 } });
    const p = s.addPlayer('p1', save);
    (s as unknown as { hitTakenEffects: () => unknown }).hitTakenEffects = () => ({ reduction: 0, reflectPct: 1, reflectElement: 'physical' });
    const def = dummy(1);
    def.minDamage = 400; def.maxDamage = 400; def.accuracy = 1e6;
    const at = cellToWorld(7, 6);
    s.enterFloor(1, { grid: field(20, 12), spawn: cellToWorld(6, 6), monsters: [{ def, x: at.x, y: at.y }] });
    const ev: SessionEvent[] = [];
    for (let i = 0; i < 300 && p.alive; i++) { ev.push(...s.tick(1 / 30, { p1: idle })); if (p.alive) p.hp = Math.min(p.hp, 5); }
    expect(ev.some((e) => e.type === 'player-died'), 'удар монстра смертелен').toBe(true);
    expect(ev.some((e) => e.type === 'monster-died'), 'шипы добили монстра').toBe(true);
    expect(p.alive, 'павший остаётся павшим').toBe(false);
    expect(p.hp, 'и без здоровья').toBe(0);
    expect(ev.some((e) => e.type === 'xp' && e.playerId === 'p1'), 'опыта павшему нет').toBe(false);
  });

  // I1:speed-wallsnap / I1:overlap-obstacle (СКРЫТОЕ: в `objects` сегодня нет ни одного преграждающего объекта). Выталкивание из преграды
  // декора (`pushOutObstacle`, после тайл-разрешения в `stepOnce`) может загнать круг в стену на доли пикселя; на следующем шаге охват оси
  // (`top/bot` по y−r…y+r) задевает строку стены — столбец считается закрытым, и x «прилипает» к грани (`(col+1)·TILE + r`): рывок до
  // клетки ПРОТИВ ввода. У преграды вплотную к стене (настенный реквизит, `placeWallProps`) герой дёргается туда-обратно, не проходя.
  it('V-RF-05 (скрытое): преграда у стены не загоняет круг в стену и не отбрасывает против хода', () => {
    const g = makeGrid(20, 10, Cell.Floor);
    for (let x = 0; x < 20; x++) g[0]![x] = Cell.Wall;
    const obst = [{ x: 368, y: 48, shape: 'circle' as const, r: 13.3 }];
    let at = { x: 420, y: 46 };
    for (let i = 0; i < 60; i++) {
      const n = moveWithCollision(at, { x: -21.6, y: -20.8 }, 14, g, 1 / 30, obst);
      expect(n.y - 14, `шаг ${i}: круг в стене`).toBeGreaterThanOrEqual(TILE - 1e-9);
      expect(n.x, `шаг ${i}: отброс против хода`).toBeLessThanOrEqual(at.x + 1e-9);
      at = n;
    }
  });

  // I5:belt-noeffect (большой прогон после правок, сид 590): мана, подрезанная регеном к потолку прошлого тика, лежала ниже нынешнего
  // на 4·10⁻¹³ (снимок статов пересчитан, стойка включена) — зелье маны уходило за «+0». «Не полон» — с допуском на шум.
  it('V-RF-06: зелье у потолка (шум плавающей точки) не тратится', () => {
    const s = new GameSession(reg, 25, 'normal');
    const save = hero('mage', 'short-sword', 'v-rf-06');
    const p = s.addPlayer('p1', save);
    s.enterFloor(1, { grid: field(12, 8), spawn: cellToWorld(4, 4), monsters: [] });
    s.tick(1 / 30, { p1: idle });
    const max = s.snapshotOf('p1')!.derived.maxMana;
    const potion = itemFromBaseId(reg.get('items.base'), 'mana-potion', reg.get('item-tiers'), 'drop')!;
    save.belt[0] = potion;
    p.mana = max - 4e-13;
    s.tick(1 / 30, { p1: { ...idle, useBelt: 0 } });
    expect(save.belt[0], 'колба цела').toBe(potion);
    p.mana = max - 30;
    s.tick(1 / 30, { p1: { ...idle, useBelt: 0 } });
    expect(save.belt[0], 'ниже потолка — выпита').toBeNull();
    expect(p.mana).toBeGreaterThan(max - 30);
  });

  // V-RF-05 (монстр): заселённый прямо на преграду у закрытой двери выдавливался толчком, не видевшим стен, — в дверь. Толчок теперь
  // гасится гранью клетки, как шаг.
  it('V-RF-05 (скрытое): толчок из преграды не вдавливает в закрытую дверь', () => {
    const g = makeGrid(12, 8, Cell.Floor);
    for (let y = 0; y < 8; y++) g[y]![6] = Cell.Door;
    const obst = [{ x: 6 * TILE - 4, y: 3.5 * TILE, shape: 'circle' as const, r: 12 }];
    for (const start of [{ x: 6 * TILE - 4, y: 3.5 * TILE }, { x: 6 * TILE - 14, y: 3.5 * TILE + 1 }]) {
      const n = moveWithCollision(start, { x: 0, y: 0 }, 14, g, 1 / 30, obst);
      expect(n.x + 14, `${JSON.stringify(start)}: круг в двери`).toBeLessThanOrEqual(6 * TILE + 1e-9);
    }
  });

  // V-RF-05 (заселение): `spawnPacksEl` не обходил преграды декора (сундук обходит, R9-16) — монстр вставал в колонну. Клетка под
  // преградой — ближайшая свободная той же комнаты, БЕЗ броска: без преграждающего декора заселение то же до монстра.
  it('V-RF-05 (скрытое): заселение обходит преграды декора; без них — те же монстры', () => {
    const r2 = new ConfigRegistry();
    r2.loadAll();
    const pillar = { ...structuredClone(r2.get('objects')[0]!), id: 'test-pillar', role: 'prop', blocks: true, collider: { shape: 'circle' as const, r: 0.45 } };
    r2.reload({ objects: [...r2.get('objects'), pillar] });
    const grid = makeGrid(20, 20, Cell.Floor);
    const room = { x: 2, y: 2, w: 10, h: 10, type: 'large' as const };
    // Колонны на каждой второй клетке комнаты: свободные есть, но случайная клетка почти наверняка под колонной.
    const decor = [];
    for (let cy = room.y + 1; cy < room.y + room.h - 1; cy++) for (let cx = room.x + 1; cx < room.x + room.w - 1; cx++) {
      if ((cx + cy) % 2 === 0) decor.push({ ...cellToWorld(cx, cy), kind: 'obj' as const, objectId: 'test-pillar', rot: 0, footprint: { w: 1, h: 1 } });
    }
    const pool = r2.get('biomes')[0]!.monsterPool;
    const lay = (d: unknown[]) => ({ grid, rooms: [room], decor: d }) as unknown as Parameters<typeof spawnPacksEl>[1];
    const withPillars = spawnPacksEl(r2, lay(decor), 1, 'normal', createRng(9), 10, pool, 2);
    const bare = spawnPacksEl(r2, lay([]), 1, 'normal', createRng(9), 10, pool, 2);
    const inert = spawnPacksEl(reg, lay(decor), 1, 'normal', createRng(9), 10, pool, 2);   // тот же декор, но объекта-преграды нет
    expect(withPillars.length).toBeGreaterThan(0);
    for (const m of withPillars) {
      const c = { cx: Math.floor(m.x / TILE), cy: Math.floor(m.y / TILE) };
      expect((c.cx + c.cy) % 2, `монстр ${m.def.id} на колонне (${c.cx},${c.cy})`).toBe(1);
    }
    expect(withPillars.map((m) => m.def.id), 'поток бросков тот же — те же монстры').toEqual(bare.map((m) => m.def.id));
    expect(inert.map((m) => [m.x, m.y]), 'без преграждающего декора — те же клетки').toEqual(bare.map((m) => [m.x, m.y]));
  });

  // АРТЕФАКТ СТЕНДА (прогон после прохода правок 2): после V-RF-05 толчок из преграды идёт по тайлам, и круг у стены остаётся чуть внутри
  // преграды — следующий толчок выносит его и без шага. Оглушённый (шаг 0) сдвигался на 2.8e-6 px, а допуск у преграды был ровно 1e-6:
  // сторож считал это бегом в стане. Теперь к допуску прибавлена глубина, на которой круг начал тик внутри преграды (`obstacleDepth`).
  it('стенд: оглушённый у преграды — толчок остатка проникновения не «бег в стане»', () => {
    const ops = [
      { k: 'tick', h: 1, s: 1690970429 }, { k: 'pickup', h: 0, s: 245931161 }, { k: 'stun', h: 0, s: 972098847 }, { k: 'tick', h: 2, s: 1691638619 },
      { k: 'tick', h: 1, s: 632284918 }, { k: 'tick', h: 0, s: 399957761 }, { k: 'tick', h: 1, s: 1496295355 }, { k: 'stun', h: 1, s: 1779302638 },
      { k: 'tick', h: 1, s: 1471917063 },
    ] as unknown as Op[];
    const out = runOps(500650, ops, hooks);
    expect(out.found ? `${violationKey(out.found)}: ${out.found.v.msg}` : null).toBeNull();
  });
});

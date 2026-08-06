import type { ConfigRegistry } from '../config/registry.js';
import type { SaveState } from '../types/save.js';
import type { ScaledMonster } from '../types/world.js';
import type { PlayerEntity } from '../world/state.js';
import { townLayout } from '../dungeon/town.js';
import { GameSession } from './session.js';
import { BotController } from './bot.js';

/**
 * Реальный микро-бой на настоящем `GameSession` — источник истины для TTK.
 * Кидаем игрока (из `SaveState`) + N монстров в открытую комнату, ведём бой ботом
 * (`BotController` — то же поведение, что в полном забеге) и меряем удары-до-смерти,
 * TTK, входящий/исходящий DPS. Сессия в режиме `sustain:true, economy:false`:
 * лич/проки/on-kill/overload РАБОТАЮТ (реальная мощь и угроза), но золото/XP/дроп и
 * левелап-хил ВЫКЛючены (иначе левелап посреди боя вылечил бы игрока и испортил TTK).
 *
 * В отличие от закрытой формулы `calc.ts:monsterTtk`, здесь честно учитываются DoT/статусы,
 * реальные формы скиллов (веер/нова/дэш/пирс), стамина/мана, замах/каст-тайм, ИИ монстра,
 * геометрия/дальность/LoS и реактивные мастерства — всё, что делает настоящий бой.
 */
export interface MicroFightOpts {
  save: SaveState;
  /** Уже отскейленные монстры (как в игре); обычно один — цель TTK. */
  monsters: ScaledMonster[];
  seed: number;
  /** Шаг тика, сек. По умолчанию 1/30 — как серверный тик. */
  dt?: number;
  /** Потолок сим-времени боя, сек (анти-залипание/кайт-в-бесконечность). */
  timeCapSec?: number;
  /** Дистанция спавна монстров от игрока, px (бот сам подходит в радиус). */
  distancePx?: number;
  difficultyId?: string;
}

export interface MicroMonsterResult {
  id: number;
  killed: boolean;
  /** Число попавших (не блок/промах) ударов игрока по этому мобу до его смерти. */
  hits: number;
  /** Сим-время от старта до смерти моба, сек (undefined если не убит). */
  ttkSec?: number;
  dmgDealt: number;
}

export interface MicroFightResult {
  killedAll: boolean;
  playerDied: boolean;
  /** Сим-время до конца боя (все мертвы / игрок умер / таймаут), сек. */
  timeSec: number;
  /** Среднее ударов-до-смерти по УБИТЫМ мобам (то самое «5-6 ударов»). */
  hitsToKillAvg: number;
  /** Среднее TTK по убитым мобам, сек. */
  ttkAvgSec: number;
  /** Исходящий DPS игрока (весь урон по мобам / timeSec). */
  dpsOut: number;
  /** Входящий DPS в игрока (весь полученный урон / timeSec). */
  dpsIn: number;
  /** Остаток HP игрока в конце, доля 0..1. */
  endHpFrac: number;
  perMonster: MicroMonsterResult[];
}

const PID = 'p1';

/** Открытая комната-арена под микро-бой: стены по краю, игрок в центре, мобы дугой рядом. */
function arena(save: SaveState, monsters: ScaledMonster[], distancePx: number) {
  const { grid, spawn } = townLayout(41, 41); // ~1312px, центр ≈ (656,656) — мобы влезают с запасом
  const n = Math.max(1, monsters.length);
  const spread = Math.PI / 3; // мобы в переднем секторе ±30°
  const spawns = monsters.map((def, i) => {
    const a = n === 1 ? 0 : -spread / 2 + (spread * i) / (n - 1);
    return { def, x: spawn.x + Math.cos(a) * distancePx, y: spawn.y + Math.sin(a) * distancePx };
  });
  return { grid, spawn, monsters: spawns };
}

/** Один прогон микро-боя (один сид). */
export function simulateMicroFight(reg: ConfigRegistry, opts: MicroFightOpts): MicroFightResult {
  const dt = opts.dt ?? 1 / 30;
  const timeCap = opts.timeCapSec ?? 30;
  const distance = opts.distancePx ?? 96;
  const difficultyId = opts.difficultyId ?? 'normal';

  const session = new GameSession(reg, opts.seed, difficultyId, { sustain: true, economy: false });
  const p: PlayerEntity = session.addPlayer(PID, opts.save);
  const bot = new BotController(reg);
  bot.syncHotbar(opts.save);
  session.enterFloor(1, arena(opts.save, opts.monsters, distance));

  // Пер-моб учёт по реальным id, присвоенным в enterFloor.
  const per = new Map<number, MicroMonsterResult>();
  for (const m of session.world.monsters) per.set(m.id, { id: m.id, killed: false, hits: 0, dmgDealt: 0 });

  let t = 0;
  let dmgOut = 0;
  let dmgIn = 0;
  while (session.monstersAlive > 0 && p.alive && t < timeCap) {
    const events = session.tick(dt, { [PID]: bot.input(session.world, p) });
    t += dt;
    for (const e of events) {
      if (e.type === 'hit' && e.target === 'monster' && e.by === PID && e.hit && !e.blocked && e.amount > 0) {
        const r = per.get(e.id as number);
        if (r) { r.hits++; r.dmgDealt += e.amount; }
        dmgOut += e.amount;
      } else if (e.type === 'hit' && e.target === 'player' && e.hit && !e.blocked) {
        dmgIn += e.amount;
      } else if (e.type === 'monster-died') {
        const r = per.get(e.id);
        if (r && !r.killed) { r.killed = true; r.ttkSec = t; }
      }
    }
  }

  const perMonster = [...per.values()];
  const killedList = perMonster.filter((r) => r.killed);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);
  const maxHp = session.snapshotOf(PID)?.derived.maxHp ?? Math.max(1, p.hp);
  return {
    killedAll: session.monstersAlive === 0,
    playerDied: !p.alive,
    timeSec: t,
    hitsToKillAvg: avg(killedList.map((r) => r.hits)),
    ttkAvgSec: avg(killedList.map((r) => r.ttkSec!)),
    dpsOut: t > 0 ? dmgOut / t : 0,
    dpsIn: t > 0 ? dmgIn / t : 0,
    endHpFrac: Math.max(0, Math.min(1, p.hp / Math.max(1, maxHp))),
    perMonster,
  };
}

export interface MicroFightStats {
  runs: number;
  killRate: number;      // доля прогонов, где все мобы убиты
  deathRate: number;     // доля прогонов, где игрок умер
  hitsToKill: { mean: number; p10: number; p50: number; p90: number };
  ttkSec: { mean: number; p10: number; p50: number; p90: number };
  dpsOutMean: number;
}

function pct(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i]!;
}

function dist(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const mean = s.length ? s.reduce((a, v) => a + v, 0) / s.length : 0;
  return { mean, p10: pct(s, 0.1), p50: pct(s, 0.5), p90: pct(s, 0.9) };
}

/**
 * Монте-Карло: гоняет микро-бой на N сидах (детерминированно от `baseSeed`) и сводит
 * распределение ударов-до-смерти/TTK + kill/death-rate. Учитывает только УБИТЫХ мобов
 * для hits/ttk (промахи-таймауты не занижают среднее числом «0 ударов»).
 */
export function microFightStats(reg: ConfigRegistry, opts: Omit<MicroFightOpts, 'seed'>, runs = 30, baseSeed = 1): MicroFightStats {
  const hits: number[] = [];
  const ttks: number[] = [];
  let killed = 0;
  let died = 0;
  let dpsOutSum = 0;
  for (let i = 0; i < runs; i++) {
    const r = simulateMicroFight(reg, { ...opts, seed: (baseSeed + i * 7919) >>> 0 });
    if (r.killedAll) killed++;
    if (r.playerDied) died++;
    dpsOutSum += r.dpsOut;
    for (const m of r.perMonster) if (m.killed) { hits.push(m.hits); ttks.push(m.ttkSec!); }
  }
  return {
    runs,
    killRate: runs ? killed / runs : 0,
    deathRate: runs ? died / runs : 0,
    hitsToKill: dist(hits),
    ttkSec: dist(ttks),
    dpsOutMean: runs ? dpsOutSum / runs : 0,
  };
}

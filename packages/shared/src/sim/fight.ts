import { resolveAttack } from '../formulas/combat.js';
import { monsterCombatStats, buildMonsterPacket } from '../formulas/monstergen.js';
import { buildAttackPacket } from '../formulas/playerCombat.js';
import { emptyPacket } from '../types/combat.js';
import type { Rng } from '../formulas/rng.js';
import type { CombatStats, DamagePacket } from '../types/combat.js';
import type { ScaledMonster } from '../types/world.js';
import type { PlayerModel } from './playerBot.js';
import type { FightResult, FightStats } from './types.js';

/**
 * АБСТРАКТНЫЙ бой (быстрая аппроксимация): зовёт настоящую `resolveAttack`, но упрощает скиллы и
 * игнорирует DoT/статусы/ИИ/геометрию. НИЗВЕДЁН до быстрого превью — эталон TTK/забега это реальный
 * `session/microFight.ts` + `session/runner.ts` (настоящий GameSession). Согласие «формула ≈ движок»
 * держит `sim/crosscheck.test.ts`. Для точных чисел баланса используй реальный движок, не это.
 */
const DT = 0.1; // шаг тика, сек
const MAX_SEC = 120; // если за столько не убил — «стена» (стейлмейт)
const MANA_PER_MAGIC_HIT = 0; // базовый удар маг. оружием бесплатен (как balance.melee.basicManaCost=0)

interface MonState {
  m: ScaledMonster;
  hp: number;
  cd: number;
  stats: CombatStats;
}

/**
 * Тик-бой: игрок против пачки. Игрок бьёт по КД (дуал-вилд чередует руки, magic
 * тратит ману), фокус по цели с наименьшим HP; монстры бьют по своим КД (худший
 * случай — все в контакте); HP/мана регенятся. Победа — все мертвы; поражение —
 * HP≤0; таймаут MAX_SEC — «не смог убить». Весь урон через resolveAttack.
 */
export function simulateFight(
  model: PlayerModel,
  monsters: ScaledMonster[],
  rng: Rng,
  opts: { startHp?: number; startMana?: number; maxSec?: number } = {},
): FightResult {
  const maxSec = opts.maxSec ?? MAX_SEC;
  const mon: MonState[] = monsters.map((m) => ({
    // Стартовый КД — случайная фаза в пределах интервала (монстры уже «в замахе»
    // при сближении), иначе в коротких боях они не успевают ударить ни разу.
    m, hp: m.hp, cd: rng.float(0, 1 / Math.max(0.2, m.attackSpeed)), stats: monsterCombatStats(m),
  }));
  let hp = opts.startHp ?? model.maxHp;
  let mana = opts.startMana ?? model.maxMana;
  let pcd = model.attackInterval;
  // КД скиллов на этот бой (не мутируем модель); стартовый разброс, чтобы не было
  // альфа-страйка «все скиллы в один тик».
  const skCd = model.skills.map(() => rng.float(0, 0.5));
  let swing = 0;
  let t = 0;
  let dmgOut = 0;
  let dmgIn = 0;
  let killed = 0;
  let xp = 0;

  // Применяет удар игрока по монстру через resolveAttack (учёт брони/резистов/крита).
  // dmgOut считаем без овер-килла, чтобы DPS был осмысленным (AoE не «пробивает» мертвых).
  const hitMon = (s: MonState, packet: DamagePacket): void => {
    const res = resolveAttack(model.combat, s.stats, packet, rng);
    if (res.hit && !res.blocked) {
      dmgOut += Math.min(Math.max(0, s.hp), res.total);
      s.hp -= res.total;
      if (s.hp <= 0) { killed += 1; xp += s.m.xp; }
    }
  };

  while (t < maxSec) {
    const alive = mon.filter((s) => s.hp > 0);
    if (alive.length === 0 || hp <= 0) break;

    // Базовая атака по готовности (фокус по слабейшему).
    pcd -= DT;
    if (pcd <= 0) {
      pcd += model.attackInterval;
      const weapon = model.weapons[swing % model.weapons.length];
      swing += 1;
      const isMagic = weapon?.damageKind === 'magical';
      if (!isMagic || mana >= MANA_PER_MAGIC_HIT) {
        if (isMagic) mana -= MANA_PER_MAGIC_HIT;
        const target = alive.reduce((a, b) => (b.hp < a.hp ? b : a));
        hitMon(target, buildAttackPacket(model.derived, model.attrs, weapon, model.scaling, model.weights, rng));
      }
    }

    // Касты скиллов по КД: AoE — по всей пачке, одиночные — веером по слабейшим.
    for (let si = 0; si < model.skills.length; si++) {
      const sk = model.skills[si]!;
      const cd = (skCd[si] ?? 0) - DT;
      if (cd > 0 || mana < sk.manaCost) { skCd[si] = cd; continue; }
      skCd[si] = cd + sk.cooldown;
      mana -= sk.manaCost;
      const packet = emptyPacket();
      packet[sk.element] += sk.magnitude;
      if (sk.aoe) {
        for (const s of mon) if (s.hp > 0) hitMon(s, packet);
      } else {
        const targets = mon.filter((s) => s.hp > 0).sort((a, b) => a.hp - b.hp).slice(0, sk.projectiles);
        for (const s of targets) hitMon(s, packet);
      }
    }

    // Удары монстров: кайт уводит часть ударов мили-мобов мимо (стрелки бьют всё равно).
    for (const s of alive) {
      s.cd -= DT;
      if (s.cd <= 0) {
        s.cd += 1 / Math.max(0.2, s.m.attackSpeed);
        if (s.m.ai !== 'ranged-kiter' && rng.next() < model.kiteDodge) continue;
        const res = resolveAttack(s.stats, model.combat, buildMonsterPacket(s.m, rng), rng);
        if (res.hit && !res.blocked) { hp -= res.total; dmgIn += res.total; }
      }
    }

    hp = Math.min(model.maxHp, hp + model.hpRegen * DT);
    mana = Math.min(model.maxMana, mana + model.manaRegen * DT);
    t += DT;
  }

  const win = mon.every((s) => s.hp <= 0);
  return {
    win,
    timeSec: t,
    playerHpFrac: Math.max(0, hp) / Math.max(1, model.maxHp),
    endHp: Math.max(0, hp),
    endMana: Math.max(0, mana),
    dpsOut: t > 0 ? dmgOut / t : 0,
    dpsIn: t > 0 ? dmgIn / t : 0,
    monstersKilled: killed,
    xp,
  };
}

/** Монте-Карло: N боёв с пере-генерацией пачки каждую итерацию → агрегат. */
export function simulateFights(
  makeMonsters: (rng: Rng) => ScaledMonster[],
  model: PlayerModel,
  iterations: number,
  rng: Rng,
): FightStats {
  let wins = 0, timeSum = 0, hpSum = 0, hpN = 0, dpsOut = 0, dpsIn = 0;
  for (let i = 0; i < iterations; i++) {
    const r = simulateFight(model, makeMonsters(rng), rng);
    if (r.win) { wins += 1; hpSum += r.playerHpFrac; hpN += 1; }
    timeSum += r.timeSec;
    dpsOut += r.dpsOut;
    dpsIn += r.dpsIn;
  }
  const n = Math.max(1, iterations);
  return {
    winRate: wins / n,
    avgTimeSec: timeSum / n,
    avgHpFracOnWin: hpN ? hpSum / hpN : 0,
    avgDpsOut: dpsOut / n,
    avgDpsIn: dpsIn / n,
    iterations,
  };
}

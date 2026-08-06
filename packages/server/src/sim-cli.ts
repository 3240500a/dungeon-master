import { ConfigRegistry, runSim, runSessionSim, microFightStats, sweepHitsToKill, generateMonster, createRng, newBotSave, DEFAULT_BUILD, type ScenarioKind, type SimSettings, type RunReport, type SaveState, type BotTier, type BotStyle } from '@dm/shared';
import { getCharacter } from './db/db.js';

/**
 * Безголовый запуск симулятора баланса: `npm run sim -- --scenario=progression ...`.
 * Печатает таблицы в консоль. Те же чистые функции, что и вкладка редактора.
 */

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)=(.*)$/.exec(a) ?? /^--([^=]+)$/.exec(a);
  if (m) args.set(m[1]!, m[2] ?? 'true');
}
const str = (k: string, d: string): string => args.get(k) ?? d;
const num = (k: string, d: number): number => (args.has(k) ? Number(args.get(k)) : d);
const bool = (k: string, d: boolean): boolean => (args.has(k) ? args.get(k) !== 'false' : d);

const reg = new ConfigRegistry();
reg.loadAll();

const classId = str('class', reg.get('classes')[0]!.id);

// Настоящий сим на GameSession (бот играет как игрок). `--scenario=run`.
if (str('scenario', 'progression') === 'run') {
  const t = Date.now();
  const rep = runSessionSim(reg, {
    classId,
    difficultyId: str('diff', 'normal'),
    seed: num('seed', 12345),
    targetLevel: num('target', 30),
    maxHours: num('hours', 6),
    dt: num('dt', 1 / 30),
    townTripSec: num('town', 45),
    botTier: str('tier', 'rotation') as BotTier,
    botStyle: str('style', 'balanced') as BotStyle,
    build: {
      ...DEFAULT_BUILD,
      vitalityShare: num('vit', DEFAULT_BUILD.vitalityShare),
      variance: num('variance', DEFAULT_BUILD.variance),
      offenseBias: num('bias', DEFAULT_BUILD.offenseBias),
      useSkills: bool('skills', DEFAULT_BUILD.useSkills),
    },
  });
  printRunReport(rep, Date.now() - t);
  process.exit(0);
}

// Свип уровень×монстр → удары-до-смерти (CSV). `--scenario=sweep --lmin=5 --lmax=85 --lstep=10 --mon=zombie,...`.
if (str('scenario', 'progression') === 'sweep') {
  const lmin = num('lmin', 5), lmax = num('lmax', 85), lstep = num('lstep', 10);
  const levels: number[] = []; for (let l = lmin; l <= lmax; l += lstep) levels.push(l);
  const monsterIds = args.has('mon') ? str('mon', '').split(',') : reg.get('monsters').filter((m) => m.enabled !== false).map((m) => m.id);
  const t = Date.now();
  const cells = sweepHitsToKill(reg, {
    classId, levels, monsterIds, tier: str('tier', 'rotation') as BotTier, style: str('style', 'balanced') as BotStyle,
    runs: num('runs', 8), seed: num('seed', 1), depthOffset: num('depthoff', 0), rarity: str('rarity', 'normal') as 'normal',
  });
  console.error(`# sweep ${classId} · ${levels.length}ур × ${monsterIds.length}моб × ${num('runs', 8)} прогонов = ${cells.length} ячеек (${Date.now() - t}ms)`);
  console.log('level,monster,hitsToKill,ttkSec,killRatePct,deathRatePct,dpsOut');
  for (const c of cells) console.log(`${c.level},${c.monsterId},${c.hitsToKill.toFixed(2)},${c.ttkSec.toFixed(2)},${Math.round(c.killRate * 100)},${Math.round(c.deathRate * 100)},${Math.round(c.dpsOut)}`);
  process.exit(0);
}

// TTK реального билда на настоящем GameSession. `--scenario=ttk --char=<id> --mon=<baseId>`.
// Без --char строит бот-сейв уровня --level. Отвечает на «делает ли мой билд 5-6 ударов на моба».
if (str('scenario', 'progression') === 'ttk') {
  const charId = str('char', '');
  let save: SaveState;
  if (charId) {
    const ch = getCharacter(charId);
    if (!ch) { console.error(`Персонаж ${charId} не найден в БД`); process.exit(1); }
    save = ch.data;
  } else {
    save = newBotSave(reg, classId);
    save.level = num('level', 30);
  }
  const monBaseId = str('mon', reg.get('monsters')[0]!.id);
  const rarity = str('rarity', 'normal') as 'normal' | 'magic' | 'rare' | 'unique';
  const mon = generateMonster(reg.get('monsters'), reg.get('monster-gear'), reg.get('monster-affixes'),
    { baseId: monBaseId, depth: Math.max(0, save.level - 1), mderive: reg.get('monster-derive'), itemAffixes: reg.get('monster-item-affixes'), rarities: reg.get('rarities'), rarity, monsterRarity: reg.get('monster-rarity'), monsterUniques: reg.get('monster-uniques') },
    createRng(1));
  const t = Date.now();
  const s = microFightStats(reg, { save, monsters: [mon] }, num('runs', 30), num('seed', 1));
  const dp = (x: number) => x.toFixed(1);
  console.log(`\n=== TTK · ${save.name} (ур.${save.level} ${save.classId}) vs ${mon.name} · ${rarity} (${Date.now() - t}ms) ===`);
  console.log(`Ударов до смерти: ${dp(s.hitsToKill.mean)}  (p10 ${dp(s.hitsToKill.p10)} … p90 ${dp(s.hitsToKill.p90)})`);
  console.log(`TTK, сек:         ${dp(s.ttkSec.mean)}  (p10 ${dp(s.ttkSec.p10)} … p90 ${dp(s.ttkSec.p90)})`);
  console.log(`Убил / погиб:     ${Math.round(s.killRate * 100)}% / ${Math.round(s.deathRate * 100)}%   · исх.DPS ${Math.round(s.dpsOutMean)}`);
  process.exit(0);
}

function printRunReport(r: RunReport, ms: number): void {
  const b = r.finalBuild;
  console.log(`\n=== RUN · класс ${r.classId} · тир ${r.difficultyId} · сид ${r.seed} (${ms}ms) ===`);
  console.log(`Итог: ур.${b.level} (мощь ${b.power}) за ${r.totalHours} ч игрового времени · глубже всего ${r.deepestFloor} · этажей зачищено ${r.floorsCompleted}`);
  console.log(`Убито ${r.kills} · смертей ${r.deaths} · золото ${r.goldEarned} · предметов найдено ${r.itemsFound}`);
  console.log(`Темп: ${r.killsPerHour} убийств/ч · ${r.xpPerHour} XP/ч · ${r.lootPerHour} предм/ч`);
  console.log(`\n— Финальный билд —`);
  console.log(`  Атрибуты: ${JSON.stringify(b.attributes)}  (эфф. ${JSON.stringify(b.effectiveAttributes)})`);
  const d = b.derived;
  console.log(`  HP ${d.maxHp} · мана ${d.maxMana} · броня ${d.armor} · уворот ${d.evade} · крит ${d.critChance}% · ск.атк ${d.attackSpeed} · ур/удар ~${d.avgHit}`);
  console.log(`  Активок: ${b.skills.length} · пассив-узлов: ${b.passiveNodes} (рангов ${b.passiveRanks})`);
  console.log(`  Экипировка:`);
  for (const e of b.equipment) {
    const tags = [e.attackType, e.damageKind, e.armorClass, e.weight, e.physSub].filter(Boolean).join('/');
    console.log(`    ${e.slot.padEnd(8)} ${e.name} [${e.rarity}${tags ? ' ' + tags : ''}]${e.affixes.length ? '  ' + e.affixes.join(', ') : ''}`);
  }
  console.log(`\n— Кривая (часы→уровень→этаж→мощь) —`);
  for (const c of r.levelCurve) console.log(`  ${(c.timeSec / 3600).toFixed(2).padStart(5)}ч  ур.${String(c.level).padStart(2)}  этаж ${String(c.floor).padStart(2)}  мощь ${c.power}`);
  console.log('');
}

const settings: SimSettings = {
  scenario: str('scenario', 'progression') as ScenarioKind,
  classId,
  difficultyId: str('diff', 'normal'),
  level: num('level', 20),
  floor: num('floor', 1),
  targetLevel: num('target', 40),
  maxHours: num('hours', 60),
  iterations: num('iters', 30),
  seed: num('seed', 12345),
  floorOverheadSec: num('overhead', 25),
  build: {
    ...DEFAULT_BUILD,
    vitalityShare: num('vit', DEFAULT_BUILD.vitalityShare),
    variance: num('variance', DEFAULT_BUILD.variance),
    offenseBias: num('bias', DEFAULT_BUILD.offenseBias),
    useSkills: bool('skills', DEFAULT_BUILD.useSkills),
  },
};

const t0 = Date.now();
const out = runSim(reg, settings);
const ms = Date.now() - t0;

const f2 = (n: number): string => n.toFixed(2);
const pct = (n: number): string => `${Math.round(n * 100)}%`;

console.log(`\n=== SIM ${settings.scenario} · класс ${classId} · тир ${settings.difficultyId} · сид ${settings.seed} (${ms}ms) ===`);

if (out.fight) {
  const f = out.fight;
  console.log(`Игрок ур.${f.playerLevel} (мощь ${f.power}) vs монстры ур.${f.challengeLevel}, итераций ${f.iterations}`);
  console.log(`  Победы:   ${pct(f.winRate)}`);
  console.log(`  Время:    ${f2(f.avgTimeSec)} с`);
  console.log(`  HP в конце (победы): ${pct(f.avgHpFracOnWin)}`);
  console.log(`  DPS исх/вх: ${f2(f.avgDpsOut)} / ${f2(f.avgDpsIn)}`);
}

if (out.floor) {
  const f = out.floor;
  console.log(`Этаж ${settings.floor} (вызов ур.${f.challengeLevel}), игрок ур.${settings.level}, итераций ${f.iterations}`);
  console.log(`  Зачистка: ${pct(f.clearRate)} · смерти: ${pct(f.deathRate)}`);
  console.log(`  Время:    ${f2(f.avgTimeSec)} с · пачек ${f2(f.avgPacks)}`);
  console.log(`  XP/золото/дроп: ${Math.round(f.avgXp)} / ${Math.round(f.avgGold)} / ${f2(f.avgDrops)}`);
  console.log(`  Мин. HP на этаже: ${pct(f.avgMinHpFrac)}`);
}

if (out.progression) {
  const p = out.progression;
  console.log(`Достигнут ур.${p.reachedLevel} за ${f2(p.totalHours)} ч · смертей ${p.deaths} · стена: ${p.wallFloor ?? '—'}`);
  console.log(`\n  ур | часы  | этаж | мощь`);
  console.log(`  ---+-------+------+-----`);
  for (const c of p.curve) {
    console.log(`  ${String(c.level).padStart(2)} | ${f2(c.hours).padStart(5)} | ${String(c.floor).padStart(4)} | ${c.power}`);
  }
  // Часы между вехами уровней — где прокачка «встаёт».
  if (p.curve.length > 1) {
    console.log(`\n  Часы на уровень (последние):`);
    const tail = p.curve.slice(-6);
    for (let i = 1; i < tail.length; i++) {
      console.log(`    ур.${tail[i - 1]!.level}→${tail[i]!.level}: ${f2(tail[i]!.hours - tail[i - 1]!.hours)} ч`);
    }
  }
}

console.log('');

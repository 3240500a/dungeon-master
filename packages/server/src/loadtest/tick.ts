import {
  ConfigRegistry, GameSession, generateRunPlan, generateFloor, decorSpecsFor, obstaclesFromDecor,
  resolveMonsterPool, spawnPacksEl, createRng, effectiveLevel, serializeWorld, newCharacterSave,
  townLayout, type PlayerInput, type RunConfig,
} from '@dm/shared';

/**
 * Бенч БОЕВОГО ядра без сети: реальные `generateFloor` + `spawnPacksEl` + `GameSession.tick`
 * + `serializeWorld` + сериализация кадра. Меряет ровно то, что крутится в `Room.step`.
 *
 *   npm run bench:tick
 *   npm run bench:tick -- --ticks=200000 --players=4
 *
 * Зачем в репозитории: это регрессионный гейт для задач Ф0.11 (дорогая математика в горячих
 * циклах) и всей Ф1 (бинарная дельта вместо JSON). Правка должна двигать `мкс/тик` вниз,
 * а `Б/кадр` — вниз на порядок; иначе она ничего не дала.
 */
const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)=(.*)$/.exec(a);
  if (m) args.set(m[1]!, m[2]!);
}
const num = (k: string, d: number): number => (args.has(k) ? Number(args.get(k)) : d);
const str = (k: string, d: string): string => args.get(k) ?? d;

const TICKS = num('ticks', 100_000);
const PLAYERS = num('players', 1);
const NODE_IDX = num('node', 3);
const TEMPLATE = str('template', 'dungeon-standard');
const TICK_DT = 1 / 30;

const reg = new ConfigRegistry();
reg.loadAll();

/** Тот же путь, что `Room.enterNode`: граф забега → узел → этаж → декор → пул монстров → заселение. */
function buildFloor(): { session: GameSession; inputs: Record<string, PlayerInput>; monsters: number; cols: number; rows: number } {
  const biome = reg.get('biomes').filter((b) => b.enabled !== false)[0] ?? reg.get('biomes')[0]!;
  const runCfg: RunConfig = { templateId: TEMPLATE, biomeId: biome.id, tier: 'normal', seed: 12345, modifiers: [] };
  const plan = generateRunPlan(reg, runCfg);
  const node = plan.nodes[Math.min(NODE_IDX, plan.nodes.length - 1)]!;
  const decorSpecs = decorSpecsFor(reg.get('objects'), reg.get('models'), biome.id);
  const layout = generateFloor(node.floorSpec, reg.get('room-prefabs'), decorSpecs);
  const obstacles = obstaclesFromDecor(layout.decor, new Map(decorSpecs.map((s) => [s.id, s])));
  const pool = resolveMonsterPool(biome, node.depth);

  const session = new GameSession(reg, 999, 'normal', { rewards: true });
  const town = townLayout();
  session.enterFloor(0, { grid: town.grid, spawn: town.spawn, monsters: [] });

  const inputs: Record<string, PlayerInput> = {};
  for (let i = 0; i < PLAYERS; i++) {
    const save = newCharacterSave(reg, reg.get('classes')[0]!.id, `bot${i}`, `c${i}`);
    save.level = 30;
    save.xp = reg.get('balance').xpTable[30] ?? 0;
    session.addPlayer(`p${i}`, save);
    inputs[`p${i}`] = { move: { x: 0.6, y: 0.4 }, facing: 0.7, attack: true, cast: null, interact: false };
  }

  const el = effectiveLevel(session.world.players['p0']!.save, reg.get('balance').power).total;
  const rng = createRng((node.floorSpec.seed >>> 0) || 1);
  const monsters = spawnPacksEl(reg, layout, node.depth, 'normal', rng, el, pool, node.floorSpec.packDensity, node.floorSpec.floorId);
  session.enterFloor(node.depth, {
    grid: layout.grid, spawn: layout.spawn, exits: layout.exits, monsters, obstacles,
    doors: layout.doors, levers: layout.levers, biomeId: biome.id,
  });
  // Монстры бессмертны: иначе длинный прогон зачистит этаж и будет мерить пустую комнату.
  for (const m of session.world.monsters) { m.def = { ...m.def, hp: 1e9 }; m.hp = 1e9; m.maxHp = 1e9; }

  return { session, inputs, monsters: monsters.length, cols: layout.grid[0]!.length, rows: layout.grid.length };
}

const { session, inputs, monsters, cols, rows } = buildFloor();
const itemsBase = reg.get('items.base');

for (let i = 0; i < 2000; i++) session.tick(TICK_DT, inputs); // прогрев JIT

let tickNs = 0;
let frameNs = 0;
let bytes = 0;
for (let i = 0; i < TICKS; i++) {
  const t0 = process.hrtime.bigint();
  session.tick(TICK_DT, inputs);
  const t1 = process.hrtime.bigint();
  const msg = JSON.stringify({ t: 'snapshot', snap: serializeWorld(session.world, itemsBase) });
  const t2 = process.hrtime.bigint();
  tickNs += Number(t1 - t0);
  frameNs += Number(t2 - t1);
  bytes += msg.length;
}

const tickUs = tickNs / TICKS / 1000;
const frameUs = frameNs / TICKS / 1000;
const perRoom = tickUs + frameUs;
console.log(`
Бенч ядра · ${cols}×${rows}, монстров ${monsters}, игроков ${PLAYERS}, ${TICKS} тиков
  tick               ${tickUs.toFixed(3)} мкс
  сборка кадра       ${frameUs.toFixed(3)} мкс
  итого на комнату   ${perRoom.toFixed(3)} мкс/тик
  кадр               ${(bytes / TICKS).toFixed(0)} Б  (${(bytes / TICKS / 1024).toFixed(2)} КБ)
  бюджет 30 Гц       ${((perRoom / 1000) / (1000 / 30) * 100).toFixed(2)} % ядра на комнату → ~${Math.floor((1000 / 30) / (perRoom / 1000))} комнат/ядро`);

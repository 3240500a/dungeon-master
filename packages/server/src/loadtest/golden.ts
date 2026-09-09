import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  ConfigRegistry, GameSession, serializeWorld, SnapshotDelta, worldChecksum,
  encodeWorldFrame, snapshotToDelta, WIRE_FULL, WIRE_DELTA,
  newBotSave, generateMonster, createRng, Cell, makeGrid, cellToWorld,
  type Grid, type PlayerInput,
} from '@dm/shared';

/**
 * Эталонные кадры для чужих реализаций декодера (фаза С2 стенда).
 *
 * ЗАЧЕМ. Стенд на Rust хочет быть «зрячим»: разбирать двоичный кадр, накладывать дельту
 * и сверять контрольную сумму — тогда он ловит порчу протокола, а не только считает байты.
 * Но у порта есть неприятное свойство: если он ошибётся, расхождение будет выглядеть как
 * баг СЕРВЕРА. Значит порт обязан быть доказуемо равен оригиналу до того, как ему поверят.
 *
 * Отсюда эталон: здесь настоящий движок гоняет настоящую комнату и записывает точную
 * последовательность кадров — те же байты, что уходят в сеть, — вместе с ожидаемой суммой
 * и составом мира на каждом шаге. Порт обязан пройти её байт в байт.
 *
 * ЧТО ИМЕННО ПРОВЕРЯЕТСЯ СУММОЙ. В неё входят не все поля (мана, выносливость, радиус,
 * состояние ИИ, дебаффы и предметы дропа в ней не участвуют). Но разобрать их всё равно
 * придётся: они лежат в потоке между нужными, и любая ошибка в их длине сдвигает чтение —
 * остаток кадра рассыпается, и сумма не сойдётся. Поэтому сверка суммы транзитивно
 * проверяет разбор целиком.
 *
 *   npm run golden:wire            — перезаписать tools/dmload/tests/golden.json
 *   npm run golden:wire -- --ticks=600
 */

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)=(.*)$/.exec(a);
  if (m) args.set(m[1]!, m[2]!);
}
const TICKS = Number(args.get('ticks') ?? 400);
/** Через сколько тиков сервер шлёт полный кадр вместо дельты — как в комнате. */
const FULL_EVERY = Number(args.get('fullEvery') ?? 60);

/** Открытое поле со стенами по краю — та же арена, что в тестах сессии. */
function field(cols: number, rows: number): Grid {
  const g = makeGrid(cols, rows, Cell.Floor);
  for (let x = 0; x < cols; x++) { g[0]![x] = Cell.Wall; g[rows - 1]![x] = Cell.Wall; }
  for (let y = 0; y < rows; y++) { g[y]![0] = Cell.Wall; g[y]![cols - 1] = Cell.Wall; }
  return g;
}

function makeSession(): { s: GameSession; inputs: Record<string, PlayerInput> } {
  const r = new ConfigRegistry();
  r.loadAll();
  const s = new GameSession(r, 12345, 'normal', { rewards: true });
  const grid = field(30, 20);
  s.enterFloor(0, { grid, spawn: cellToWorld(4, 4), monsters: [] });
  // Двое: пати даёт и второго игрока в кадре, и разные классы (маг стреляет — будут снаряды).
  s.addPlayer('p1', newBotSave(r, 'warrior'));
  s.addPlayer('p2', newBotSave(r, 'mage'));
  const rng = createRng(7);
  const monsters = Array.from({ length: 8 }, (_, i) => {
    const def = generateMonster(r.get('monsters'), r.get('monster-gear'), r.get('monster-affixes'),
      { baseId: r.get('biomes')[0]!.monsterPool[0]!, depth: 1 }, rng);
    const at = cellToWorld(6 + (i % 4) * 2, 6 + Math.floor(i / 4) * 2);
    return { def, x: at.x, y: at.y };
  });
  s.enterFloor(1, { grid, spawn: cellToWorld(4, 4), monsters });
  return {
    s,
    inputs: {
      p1: { move: { x: 0.7, y: 0.3 }, facing: 0.4, attack: true, cast: null, interact: false },
      p2: { move: { x: -0.5, y: 0.8 }, facing: 2.1, attack: true, cast: null, interact: false },
    },
  };
}

interface GoldenFrame {
  /** Кадр ровно теми байтами, какими уходит в сеть. */
  hex: string;
  kind: number;
  tick: number;
  /** Контрольная сумма из кадра — её обязан воспроизвести порт по своей реконструкции. */
  sum: number;
  /** Состав мира после применения — чтобы расхождение можно было локализовать, а не только увидеть. */
  players: number;
  monsters: number;
  projectiles: number;
  drops: number;
}

const { s, inputs } = makeSession();
const delta = new SnapshotDelta();
const frames: GoldenFrame[] = [];
let withProj = 0;
let withDrops = 0;
let fulls = 0;

for (let tick = 1; tick <= TICKS; tick++) {
  s.tick(1 / 30, inputs);
  const snap = serializeWorld(s.world);
  const sum = worldChecksum(snap);
  const full = tick === 1 || tick % FULL_EVERY === 0;
  const buf = full
    ? encodeWorldFrame({ kind: WIRE_FULL, delta: snapshotToDelta(snap), sum })
    : encodeWorldFrame({ kind: WIRE_DELTA, delta: delta.next(snap)!, sum });
  if (full) { delta.prime(snap); fulls++; }

  frames.push({
    hex: Buffer.from(buf).toString('hex'),
    kind: full ? WIRE_FULL : WIRE_DELTA,
    tick: snap.tick,
    sum,
    players: snap.players.length,
    monsters: snap.monsters.length,
    projectiles: snap.projectiles.length,
    drops: snap.drops.length,
  });
  if (snap.projectiles.length) withProj++;
  if (snap.drops.length) withDrops++;
}

// Без снарядов и дропов эталон не проверяет два из четырёх списков кадра. Молчаливо выпустить
// такой набор — значит выдать зелёный порт, который на живом сервере рассыплется.
if (!withProj) throw new Error('в эталоне нет ни одного кадра со снарядами — сценарий не покрывает ru/rd');
if (!withDrops) throw new Error('в эталоне нет ни одного кадра с дропами — сценарий не покрывает du/dd');

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../tools/dmload/tests/golden.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({
  note: 'Сгенерировано npm run golden:wire. Правится только перезапуском генератора.',
  ticks: TICKS,
  fullEvery: FULL_EVERY,
  frames,
}, null, 1));

const bytes = frames.reduce((a, f) => a + f.hex.length / 2, 0);
console.log(`эталон: ${frames.length} кадров (${fulls} полных), ${(bytes / 1024).toFixed(1)} КБ`);
console.log(`  со снарядами ${withProj}, с дропами ${withDrops}`);
console.log(`  → ${out}`);

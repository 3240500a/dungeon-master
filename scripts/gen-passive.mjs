// Генератор большого пассивного дерева (3 кластера, 4 кольца, нотабли, кистоуны).
// Глубокие ранги + рост цены по рангу (в игре, balance.passiveRankCostGrowth).
// Пишет packages/shared/src/config/data/skills-passive.json.
// Запуск: node scripts/gen-passive.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const out = join(dirname(fileURLToPath(import.meta.url)), '..',
  'packages/shared/src/config/data/skills-passive.json');

const SPOKES = 7;
const R = [130, 235, 340, 445];
const RING_COST = [50, 80, 120, 170];
const RING_RANK = [8, 8, 5, 3];

const clusters = [
  {
    key: 'str', name: 'Сила и тело', cx: 0, cy: -520, offset: -Math.PI / 2,
    small: [
      ['strength', 'flat', 3, 'Сила'], ['maxHp', 'flat', 20, 'Здоровье'],
      ['armor', 'flat', 8, 'Броня'], ['maxDamage', 'flat', 2, 'Урон'], ['vitality', 'flat', 3, 'Живучесть'],
    ],
    notables: [
      ['Несокрушимость', 'maxHp', 'increased', 0.12, '+12% к здоровью'],
      ['Крепость', 'armor', 'increased', 0.15, '+15% к броне'],
      ['Богатырь', 'strength', 'flat', 20, '+20 к силе'],
      ['Ветеран', 'maxHp', 'flat', 40, '+40 к здоровью'],
    ],
    keys: [
      ['Титан', 'maxHp', 'increased', 0.25, '+25% к здоровью'],
      ['Бастион', 'armor', 'increased', 0.3, '+30% к броне'],
    ],
  },
  {
    key: 'dex', name: 'Ловкость', cx: 470, cy: 300, offset: Math.PI / 6,
    small: [
      ['dexterity', 'flat', 3, 'Ловкость'], ['critChance', 'flat', 0.02, 'Крит'],
      ['attackSpeed', 'increased', 0.03, 'Скор. атаки'], ['accuracy', 'flat', 0.02, 'Меткость'], ['maxDamage', 'flat', 2, 'Урон'],
    ],
    notables: [
      ['Смертельная точность', 'critChance', 'flat', 0.08, '+8% к криту'],
      ['Вихрь', 'attackSpeed', 'increased', 0.12, '+12% к скор. атаки'],
      ['Тень', 'dexterity', 'flat', 20, '+20 к ловкости'],
      ['Снайпер', 'accuracy', 'flat', 0.1, '+10% к меткости'],
    ],
    keys: [
      ['Убийца', 'critChance', 'flat', 0.15, '+15% к криту'],
      ['Берсерк', 'attackSpeed', 'increased', 0.25, '+25% к скор. атаки'],
    ],
  },
  {
    key: 'int', name: 'Интеллект', cx: -470, cy: 300, offset: (5 * Math.PI) / 6,
    small: [
      ['intelligence', 'flat', 3, 'Интеллект'], ['maxMana', 'flat', 25, 'Мана'],
      ['manaRegen', 'flat', 0.3, 'Реген маны'], ['critMultiplier', 'flat', 0.1, 'Множ. крита'], ['intelligence', 'flat', 2, 'Интеллект'],
    ],
    notables: [
      ['Океан маны', 'maxMana', 'increased', 0.2, '+20% к мане'],
      ['Чародейство', 'critMultiplier', 'flat', 0.3, '+0.3 к множ. крита'],
      ['Архимаг', 'intelligence', 'flat', 20, '+20 к интеллекту'],
      ['Медитация', 'manaRegen', 'flat', 1, '+1 реген маны'],
    ],
    keys: [
      ['Вечный источник', 'maxMana', 'increased', 0.35, '+35% к мане'],
      ['Аннигилятор', 'critMultiplier', 'flat', 0.6, '+0.6 к множ. крита'],
    ],
  },
];

const nodes = [];
const edges = [];
const entryNodes = [];

function mod(stat, kind, value) { return { stat, kind, value }; }
function pos(cx, cy, r, ang) { return { x: Math.round(cx + r * Math.cos(ang)), y: Math.round(cy + r * Math.sin(ang)) }; }

for (const c of clusters) {
  const entryId = `p-${c.key}`;
  entryNodes.push(entryId);
  nodes.push({
    id: entryId, kind: 'passive', notable: false,
    name: `${c.name} (вход)`, description: `Начало ветки «${c.name}».`,
    cost: { type: 'gold', amount: 40 }, requires: [], maxRank: 1, levelReq: 1,
    effect: { modifiers: [mod(c.small[0][0], c.small[0][1], c.small[0][2])] },
    ...pos(c.cx, c.cy, 0, 0),
  });

  const ringIds = [[], [], [], []];
  for (let s = 0; s < SPOKES; s++) {
    const ang = c.offset + (s / SPOKES) * Math.PI * 2;
    for (let r = 0; r < R.length; r++) {
      const sm = c.small[(s + r) % c.small.length];
      const id = `p-${c.key}-r${r}-${s}`;
      ringIds[r].push(id);
      const pretty = sm[1] === 'increased' || ['critChance', 'accuracy'].includes(sm[0])
        ? `+${Math.round(sm[2] * 100)}%` : `+${sm[2]}`;
      nodes.push({
        id, kind: 'passive', notable: false,
        name: `${sm[3]} ${pretty}`, description: `Малый узел: ${pretty} к «${sm[3]}» за ранг.`,
        cost: { type: 'gold', amount: RING_COST[r] }, requires: [], maxRank: RING_RANK[r], levelReq: 1,
        effect: { modifiers: [mod(sm[0], sm[1], sm[2])] },
        ...pos(c.cx, c.cy, R[r], ang),
      });
    }
    edges.push([entryId, ringIds[0][s]]);
    edges.push([ringIds[0][s], ringIds[1][s]]);
    edges.push([ringIds[1][s], ringIds[2][s]]);
    edges.push([ringIds[2][s], ringIds[3][s]]);
  }
  // Петли по кольцам 1 и 2.
  for (const rr of [1, 2]) {
    for (let s = 0; s < SPOKES; s++) edges.push([ringIds[rr][s], ringIds[rr][(s + 1) % SPOKES]]);
  }

  // Нотабли на внешнем кольце.
  c.notables.forEach((nt, i) => {
    const s = (i * 2) % SPOKES;
    const ang = c.offset + ((s + 0.5) / SPOKES) * Math.PI * 2;
    const id = `p-${c.key}-note-${i}`;
    nodes.push({
      id, kind: 'passive', notable: true, name: nt[0], description: nt[4],
      cost: { type: 'gold', amount: 300 }, requires: [], maxRank: 1, levelReq: 1,
      effect: { modifiers: [mod(nt[1], nt[2], nt[3])] },
      ...pos(c.cx, c.cy, R[2] + 35, ang),
    });
    edges.push([ringIds[3][s], id]);
    edges.push([ringIds[3][(s + 1) % SPOKES], id]);
  });

  // Кистоуны глубже всех.
  c.keys.forEach((ks, i) => {
    const s = (i * 3 + 1) % SPOKES;
    const ang = c.offset + ((s + 0.5) / SPOKES) * Math.PI * 2;
    const id = `p-${c.key}-key-${i}`;
    nodes.push({
      id, kind: 'passive', notable: true, name: `★ ${ks[0]}`, description: ks[4],
      cost: { type: 'gold', amount: 600 }, requires: [], maxRank: 1, levelReq: 1,
      effect: { modifiers: [mod(ks[1], ks[2], ks[3])] },
      ...pos(c.cx, c.cy, R[3] + 60, ang),
    });
    edges.push([ringIds[3][s], id]);
  });
}

// Мосты между кластерами (единый связный граф).
edges.push(['p-str-r3-3', 'p-int-r3-0']);
edges.push(['p-dex-r3-3', 'p-str-r3-4']);
edges.push(['p-int-r3-3', 'p-dex-r3-0']);

const tree = { entryNodes, edges, nodes };
writeFileSync(out, JSON.stringify(tree, null, 2) + '\n');
console.log(`Пассивных узлов: ${nodes.length}, рёбер: ${edges.length} → ${out}`);

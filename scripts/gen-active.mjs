// Генератор активных деревьев скиллов: 3 класса × 3 ветки × ~10 узлов, ярусами.
// Гейт по уровню персонажа + prereq. Смесь активных способностей и «мастерств»
// (пассивные модификаторы за очки скиллов). Пишет skills-active.json.
// Запуск: node scripts/gen-active.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const out = join(dirname(fileURLToPath(import.meta.url)), '..',
  'packages/shared/src/config/data/skills-active.json');

// Ярусы: [levelReq]. Индекс = tier.
const TIER_LVL = [1, 6, 12, 18, 24];
const AB_RANK = 20;   // ранги активных способностей
const M_RANK = 20;    // ранги мастерств

// [abilityId, mana, cooldown, name]; [stat, kind, perRank, label]
const CLASSES = {
  warrior: {
    fury: {
      name: 'Ярость',
      ab: [['cleave', 5, 0.8, 'Рассечение'], ['whirlwind', 12, 1.4, 'Вихрь'], ['rend', 8, 4, 'Кровотечение']],
      m: [['maxDamage', 'flat', 2, 'Урон'], ['critChance', 'flat', 0.008, 'Крит'], ['attackSpeed', 'increased', 0.015, 'Скор. атаки'], ['strength', 'flat', 2, 'Сила']],
    },
    guard: {
      name: 'Оборона',
      ab: [['taunt', 8, 6, 'Провокация'], ['shield-wall', 10, 10, 'Стена щитов'], ['iron-skin', 12, 15, 'Железная кожа']],
      m: [['armor', 'flat', 5, 'Броня'], ['maxHp', 'flat', 12, 'Здоровье'], ['evade', 'flat', 3, 'Уклонение'], ['vitality', 'flat', 2, 'Живучесть']],
    },
    warcry: {
      name: 'Боевые кличи',
      ab: [['battle-shout', 10, 10, 'Боевой клич'], ['war-horn', 14, 14, 'Боевой рог'], ['rally', 12, 12, 'Сплочение']],
      m: [['strength', 'flat', 2, 'Сила'], ['moveSpeed', 'increased', 0.01, 'Скор. движ.'], ['hpRegen', 'flat', 0.2, 'Реген HP'], ['resFire', 'flat', 0.02, 'Сопр. огню']],
    },
  },
  mage: {
    fire: {
      name: 'Огонь',
      ab: [['firebolt', 6, 0.5, 'Огненный шар'], ['fireball', 12, 1.2, 'Взрыв огня'], ['meteor', 20, 6, 'Метеор']],
      m: [['maxDamage', 'flat', 2, 'Урон'], ['critChance', 'flat', 0.008, 'Крит'], ['resFire', 'flat', 0.02, 'Сопр. огню'], ['intelligence', 'flat', 2, 'Интеллект']],
    },
    frost: {
      name: 'Лёд',
      ab: [['frost-nova', 14, 6, 'Ледяная нова'], ['ice-shard', 8, 0.6, 'Ледяная стрела'], ['blizzard', 22, 8, 'Метель']],
      m: [['maxMana', 'flat', 10, 'Мана'], ['critMultiplier', 'flat', 0.03, 'Множ. крита'], ['resCold', 'flat', 0.02, 'Сопр. холоду'], ['manaRegen', 'flat', 0.2, 'Реген маны']],
    },
    arcane: {
      name: 'Тайная магия',
      ab: [['blink', 12, 5, 'Скачок'], ['arcane-orb', 10, 1, 'Тайная сфера'], ['teleport', 16, 8, 'Телепорт']],
      m: [['maxMana', 'flat', 10, 'Мана'], ['manaRegen', 'flat', 0.2, 'Реген маны'], ['intelligence', 'flat', 2, 'Интеллект'], ['accuracy', 'flat', 0.01, 'Меткость']],
    },
  },
  archer: {
    precision: {
      name: 'Точность',
      ab: [['multishot', 8, 0.9, 'Мультивыстрел'], ['piercing-shot', 10, 1.2, 'Пронзающий выстрел'], ['rain-of-arrows', 18, 6, 'Ливень стрел']],
      m: [['dexterity', 'flat', 2, 'Ловкость'], ['critChance', 'flat', 0.008, 'Крит'], ['accuracy', 'flat', 0.01, 'Меткость'], ['maxDamage', 'flat', 2, 'Урон']],
    },
    trap: {
      name: 'Ловушки',
      ab: [['caltrops', 10, 7, 'Шипы'], ['fire-trap', 12, 8, 'Огненная ловушка'], ['blade-trap', 16, 10, 'Клинковая ловушка']],
      m: [['maxDamage', 'flat', 2, 'Урон'], ['critChance', 'flat', 0.008, 'Крит'], ['resPoison', 'flat', 0.02, 'Сопр. яду'], ['dexterity', 'flat', 2, 'Ловкость']],
    },
    beast: {
      name: 'Зверь',
      ab: [['summon-wolf', 20, 20, 'Призыв волка'], ['spirit-hawk', 16, 14, 'Дух ястреба'], ['bear-charge', 14, 8, 'Рывок медведя']],
      m: [['maxHp', 'flat', 12, 'Здоровье'], ['dexterity', 'flat', 2, 'Ловкость'], ['moveSpeed', 'increased', 0.01, 'Скор. движ.'], ['hpRegen', 'flat', 0.2, 'Реген HP']],
    },
  },
};

function activeNode(id, branchId, tier, ab, x) {
  const [abilityId, mana, cd, name] = ab;
  return {
    id, kind: 'active', branchId, name, description: `Активный скилл: ${name}.`,
    cost: { type: 'points', amount: 1 }, requires: [], maxRank: AB_RANK,
    levelReq: TIER_LVL[tier], effect: { active: { abilityId, manaCost: mana, cooldown: cd } },
    x, y: tier,
  };
}
function masteryNode(id, branchId, tier, m, x) {
  const [stat, kind, value, label] = m;
  const pretty = kind === 'increased' || ['critChance', 'blockChance', 'accuracy', 'resFire', 'resCold', 'resLightning', 'resPoison'].includes(stat)
    ? `+${Math.round(value * 100)}% ${label}` : `+${value} ${label}`;
  return {
    id, kind: 'active', branchId, name: `Мастерство: ${label}`,
    description: `${pretty} за ранг.`,
    cost: { type: 'points', amount: 1 }, requires: [], maxRank: M_RANK,
    levelReq: TIER_LVL[tier], effect: { modifiers: [{ stat, kind, value }] },
    x, y: tier,
  };
}

const trees = [];
for (const [classId, branches] of Object.entries(CLASSES)) {
  const nodes = [];
  const branchDefs = Object.entries(branches);
  branchDefs.forEach(([branchId, def], bi) => {
    const p = (k) => `a-${classId}-${branchId}-${k}`;
    const col = bi * 3;
    // Схема узлов ветки: [key, tier, kind, sourceIndex, requires]
    const layout = [
      ['t0', 0, 'ab', 0, []],
      ['m1', 1, 'm', 0, ['t0']],
      ['m2', 1, 'm', 1, ['t0']],
      ['a1', 2, 'ab', 1, ['m1']],
      ['m3', 2, 'm', 2, ['m2']],
      ['m4', 3, 'm', 3, ['a1']],
      ['a2', 3, 'ab', 2, ['m3']],
      ['m5', 4, 'm', 0, ['m4']],
      ['cap', 4, 'm', 1, ['a2']],
      ['m6', 4, 'm', 2, ['m5']],
    ];
    for (const [key, tier, type, si, req] of layout) {
      const node = type === 'ab'
        ? activeNode(p(key), branchId, tier, def.ab[si], col)
        : masteryNode(p(key), branchId, tier, def.m[si], col + 1);
      node.requires = req.map(p);
      nodes.push(node);
    }
  });
  trees.push({
    classId,
    branches: branchDefs.map(([id, def]) => ({ id, name: def.name })),
    nodes,
  });
}

writeFileSync(out, JSON.stringify(trees, null, 2) + '\n');
const total = trees.reduce((s, t) => s + t.nodes.length, 0);
console.log(`Записано активных деревьев: ${trees.length}, узлов всего: ${total} → ${out}`);

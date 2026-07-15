// Генератор активных деревьев (v3): 6 классов × 3 ветки × 10 узлов (t0/a1/a2 активы + мастерства).
// Способности — в НОВОЙ модели (category attack/cast/curse/buff/aura/stance + поля). Заступник
// (zastupnik) НЕ трогаем — берём его дерево из существующего JSON как есть.
// Пишет skills-active.json. Запуск: node scripts/gen-active.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const out = join(dirname(fileURLToPath(import.meta.url)), '..',
  'packages/shared/src/config/data/skills-active.json');

const TIER_LVL = [1, 6, 12, 18, 24];   // levelReq по ярусам (индекс = tier)
const AB_RANK = 20, M_RANK = 20;

// ── Билдеры способностей (минимальные объекты; дефолты схемы дополнят остальное) ──
// ailment: явный вид статуса (kind) — рана/увечье/кровь/поджиг/озноб/шок/яд/заморозка.
const ail = (kind, chance, mag, durationMs, maxStacks = 4, mag2) =>
  (mag2 === undefined ? { kind, chance, mag, maxStacks, durationMs } : { kind, chance, mag, mag2, maxStacks, durationMs });
const atk = (id, name, mana, cd, o = {}) => ({ name, a: { category: 'attack', abilityId: id, manaCost: mana, cooldown: cd, ...o } });
const cst = (id, name, mana, cd, shape, o = {}) => ({ name, a: { category: 'cast', abilityId: id, manaCost: mana, cooldown: cd, shape, ...o } });
const crs = (id, name, mana, cd, o = {}) => ({ name, a: { category: 'curse', abilityId: id, manaCost: mana, cooldown: cd, ...o } });
const buf = (id, name, mana, cd, dur, mods) => ({ name, a: { category: 'buff', abilityId: id, manaCost: mana, cooldown: cd, durationSec: dur, buffMods: mods } });
const aur = (id, name, res, mods) => ({ name, a: { category: 'aura', abilityId: id, manaCost: 0, cooldown: 0, toggleGroup: 'aura', reservePct: res, buffMods: mods } });
const stn = (id, name, res, mods) => ({ name, a: { category: 'stance', abilityId: id, manaCost: 0, cooldown: 0, toggleGroup: 'stance', reservePct: res, buffMods: mods } });
const m = (stat, kind, value, label) => [stat, kind, value, label];

const CLASSES = {
  // ── Волкодав — копьё/топор/щит, Сила+Живуч ──
  warrior: {
    druzhina: { name: 'Дружина', ab: [
      atk('lunge', 'Пронзающий выпад', 5, 0.8, { weaponTypes: ['melee'], damageMult: 1.3, pierce: true, arcMult: 0.7, rangeMult: 1.3, ailment: ail('wound', 0.5, 0.06, 3000, 4, 0.1) }),
      atk('cleave-axe', 'Секира', 8, 1.2, { weaponTypes: ['melee'], damageMult: 1.4, arcMult: 1.5, ailment: ail('sunder', 0.6, 0.05, 4000, 5) }),
      atk('steel-whirl', 'Вихрь стали', 12, 2.0, { weaponTypes: ['melee'], damageMult: 1.1, arcMult: 2.6, rangeMult: 1.1, ailment: ail('bleed', 0.5, 4, 3000, 5) }),
    ], m: [m('physPct', 'flat', 0.02, 'Физ. урон'), m('attackSpeed', 'increased', 0.015, 'Скор. атаки'), m('critChance', 'flat', 0.008, 'Крит'), m('strength', 'flat', 2, 'Сила')] },
    natisk: { name: 'Натиск', ab: [
      cst('charge', 'Рывок', 8, 5, 'dash', { weaponTypes: ['melee'], damageMult: 1.0, dashDist: 190 }),
      buf('warcry', 'Боевой клич', 10, 12, 8, [{ stat: 'attackSpeed', kind: 'increased', value: 0.2 }, { stat: 'moveSpeed', kind: 'increased', value: 0.15 }]),
      buf('unbreakable', 'Несокрушимость', 12, 16, 8, [{ stat: 'interruptResist', kind: 'flat', value: 0.5 }, { stat: 'armor', kind: 'increased', value: 0.4 }]),
    ], m: [m('maxHp', 'flat', 12, 'Здоровье'), m('interruptResist', 'flat', 0.03, 'Стойкость'), m('moveSpeed', 'increased', 0.01, 'Скор. движ.'), m('strength', 'flat', 2, 'Сила')] },
    oborona: { name: 'Оборона', ab: [
      crs('taunt', 'Провокация', 8, 6, { radius: 220, taunt: true }),
      stn('shield-wall', 'Стена щитов', 0.2, [{ stat: 'blockChance', kind: 'increased', value: 0.4 }, { stat: 'armor', kind: 'increased', value: 0.3 }, { stat: 'moveSpeed', kind: 'increased', value: -0.1 }]),
      buf('riposte', 'Ответный удар', 10, 12, 8, [{ stat: 'blockChance', kind: 'increased', value: 0.25 }, { stat: 'physPct', kind: 'flat', value: 0.2 }]),
    ], m: [m('armor', 'increased', 0.03, 'Броня'), m('blockChance', 'increased', 0.02, 'Блок'), m('maxHp', 'flat', 12, 'Здоровье'), m('vitality', 'flat', 2, 'Живучесть')] },
  },
  // ── Заклинатель — посох/жезл, Инт+Живуч ──
  mage: {
    fire: { name: 'Огонь', ab: [
      atk('firebolt', 'Огненный шар', 6, 0.5, { weaponTypes: ['magic'], damageMult: 1.2, element: 'fire', ailment: ail('burn', 0.4, 5, 3000, 4) }),
      cst('fireblast', 'Взрыв пламени', 12, 1.4, 'nova', { element: 'fire', convertPct: 0.85, damageMult: 1.4, radius: 150, ailment: ail('burn', 0.6, 6, 3000, 5) }),
      cst('meteor', 'Метеор', 20, 6, 'meteor', { element: 'fire', convertPct: 0.85, damageMult: 2.2, radius: 150, ailment: ail('burn', 0.8, 8, 4000, 5) }),
    ], m: [m('firePct', 'flat', 0.025, 'Урон огнём'), m('castSpeed', 'increased', 0.02, 'Скор. каста'), m('maxMana', 'flat', 10, 'Мана'), m('intelligence', 'flat', 2, 'Интеллект')] },
    storm: { name: 'Молния', ab: [
      atk('lightning-bolt', 'Молния', 6, 0.5, { weaponTypes: ['magic'], damageMult: 1.2, element: 'lightning', ailment: ail('shock', 0.4, 0.08, 3000, 4) }),
      cst('chain-lightning', 'Цепная молния', 12, 1.6, 'boomerang', { element: 'lightning', convertPct: 0.85, damageMult: 1.3, ailment: ail('shock', 0.5, 0.1, 3000, 5) }),
      cst('thunderstorm', 'Гроза', 18, 5, 'ground', { element: 'lightning', convertPct: 0.85, damageMult: 1.6, radius: 150, ailment: ail('shock', 0.6, 0.1, 3000, 5) }),
    ], m: [m('lightningPct', 'flat', 0.025, 'Урон молнией'), m('critMultiplier', 'flat', 0.03, 'Множ. крита'), m('castSpeed', 'increased', 0.02, 'Скор. каста'), m('intelligence', 'flat', 2, 'Интеллект')] },
    frost: { name: 'Лёд', ab: [
      atk('ice-shard', 'Ледяная стрела', 6, 0.5, { weaponTypes: ['magic'], damageMult: 1.2, element: 'cold', ailment: ail('freeze', 0.4, 0.15, 2500, 4, 0.05) }),
      cst('frost-nova', 'Ледяная нова', 14, 5, 'nova', { element: 'cold', convertPct: 0.85, damageMult: 1.3, radius: 150, ailment: ail('freeze', 0.7, 0.2, 2500, 5, 0.15) }),
      cst('blizzard', 'Метель', 20, 7, 'ground', { element: 'cold', convertPct: 0.85, damageMult: 1.6, radius: 160, ailment: ail('freeze', 0.6, 0.18, 2500, 5, 0.1) }),
    ], m: [m('coldPct', 'flat', 0.025, 'Урон холодом'), m('maxMana', 'flat', 10, 'Мана'), m('manaRegen', 'flat', 0.2, 'Реген маны'), m('intelligence', 'flat', 2, 'Интеллект')] },
  },
  // ── Ловчая — лук, Ловк+Инт ──
  archer: {
    precision: { name: 'Меткость', ab: [
      atk('multishot', 'Мультивыстрел', 8, 0.9, { weaponTypes: ['ranged'], damageMult: 0.7, count: 3, spread: 0.35 }),
      atk('piercing-shot', 'Пронзающая стрела', 10, 1.2, { weaponTypes: ['ranged'], damageMult: 1.6, pierce: true }),
      cst('rain-of-arrows', 'Ливень стрел', 18, 6, 'ground', { damageMult: 1.4, radius: 150 }),
    ], m: [m('critChance', 'flat', 0.008, 'Крит'), m('attackSpeed', 'increased', 0.015, 'Скор. атаки'), m('accuracy', 'flat', 0.01, 'Меткость'), m('dexterity', 'flat', 2, 'Ловкость')] },
    nets: { name: 'Сети', ab: [
      crs('net', 'Сеть', 10, 7, { radius: 180, ailment: ail('freeze', 0.9, 0.1, 2500, 5, 0.3) }),
      cst('fire-trap', 'Огненная ловушка', 12, 8, 'ground', { element: 'fire', convertPct: 0.7, damageMult: 1.3, radius: 120, ailment: ail('burn', 0.8, 6, 3000, 5) }),
      cst('caltrops', 'Шипы', 10, 7, 'ground', { damageMult: 0.8, radius: 130, ailment: ail('freeze', 0.7, 0.2, 3000, 5) }),
    ], m: [m('ailmentPct', 'flat', 0.03, 'Наложение статусов'), m('critChance', 'flat', 0.008, 'Крит'), m('resPoison', 'flat', 0.02, 'Сопр. яду'), m('dexterity', 'flat', 2, 'Ловкость')] },
    elements: { name: 'Стихии', ab: [
      atk('elemental-shot', 'Стихийный выстрел', 8, 0.8, { weaponTypes: ['ranged'], damageMult: 1.1, element: 'cold', ailment: ail('freeze', 0.4, 0.15, 2500, 4, 0.05) }),
      cst('natures-wrath', 'Гнев природы', 16, 5, 'nova', { element: 'poison', convertPct: 0.7, damageMult: 1.3, radius: 150, ailment: ail('poison', 0.6, 4, 4000, 5) }),
      buf('forest-blessing', 'Благословение леса', 12, 14, 10, [{ stat: 'resFire', kind: 'flat', value: 0.15 }, { stat: 'resCold', kind: 'flat', value: 0.15 }, { stat: 'accuracy', kind: 'increased', value: 0.2 }]),
    ], m: [m('firePct', 'flat', 0.02, 'Урон огнём'), m('coldPct', 'flat', 0.02, 'Урон холодом'), m('accuracy', 'flat', 0.01, 'Меткость'), m('intelligence', 'flat', 2, 'Интеллект')] },
  },
  // ── Вьюга — меч+щит / 2H топор, Сила+Ловк ──
  vyuga: {
    valkyrie: { name: 'Валькирия', ab: [
      atk('thunder-strike', 'Удар грома', 6, 0.9, { weaponTypes: ['melee'], damageMult: 1.3, element: 'lightning', ailment: ail('shock', 0.5, 0.08, 3000, 4) }),
      buf('storm-shield', 'Щит бури', 10, 12, 8, [{ stat: 'blockChance', kind: 'increased', value: 0.3 }, { stat: 'lightningPct', kind: 'flat', value: 0.15 }]),
      cst('odins-spear', 'Копьё Одина', 14, 4, 'boomerang', { element: 'lightning', convertPct: 0.6, damageMult: 1.5, ailment: ail('shock', 0.6, 0.1, 3000, 5) }),
    ], m: [m('physPct', 'flat', 0.02, 'Физ. урон'), m('blockChance', 'increased', 0.02, 'Блок'), m('lightningPct', 'flat', 0.02, 'Урон молнией'), m('strength', 'flat', 2, 'Сила')] },
    northspirit: { name: 'Дух севера', ab: [
      atk('ice-blade', 'Ледяной клинок', 6, 0.9, { weaponTypes: ['melee'], damageMult: 1.2, element: 'cold', ailment: ail('freeze', 0.5, 0.15, 2500, 4, 0.05) }),
      atk('bloodletting', 'Кровопускание', 8, 1.2, { weaponTypes: ['melee'], damageMult: 1.3, ailment: ail('bleed', 0.6, 5, 3000, 5) }),
      cst('frost-whirl', 'Морозный вихрь', 14, 5, 'nova', { element: 'cold', convertPct: 0.6, damageMult: 1.3, radius: 140, ailment: ail('freeze', 0.7, 0.2, 2500, 5, 0.15) }),
    ], m: [m('coldPct', 'flat', 0.02, 'Урон холодом'), m('critChance', 'flat', 0.008, 'Крит'), m('evade', 'increased', 0.02, 'Уклонение'), m('dexterity', 'flat', 2, 'Ловкость')] },
    fury: { name: 'Ярость', ab: [
      atk('cleaving-blow', 'Рассекающий удар', 6, 1.0, { weaponTypes: ['melee'], damageMult: 1.4, arcMult: 1.6 }),
      buf('blade-dance', 'Танец клинков', 10, 12, 8, [{ stat: 'evade', kind: 'increased', value: 0.3 }, { stat: 'attackSpeed', kind: 'increased', value: 0.2 }]),
      stn('berserk', 'Берсерк', 0.2, [{ stat: 'physPct', kind: 'flat', value: 0.25 }, { stat: 'attackSpeed', kind: 'increased', value: 0.15 }, { stat: 'armor', kind: 'increased', value: -0.3 }]),
    ], m: [m('physPct', 'flat', 0.02, 'Физ. урон'), m('attackSpeed', 'increased', 0.015, 'Скор. атаки'), m('critChance', 'flat', 0.008, 'Крит'), m('strength', 'flat', 2, 'Сила')] },
  },
  // ── Вольный стрелок — арбалет, Ловк+Живуч ──
  arbalest: {
    veteran: { name: 'Ветеран', ab: [
      atk('heavy-bolt', 'Тяжёлый болт', 7, 1.1, { weaponTypes: ['ranged'], damageMult: 1.8, pierce: true }),
      buf('take-aim', 'Прицельный выстрел', 8, 10, 6, [{ stat: 'critChance', kind: 'increased', value: 0.5 }, { stat: 'accuracy', kind: 'increased', value: 0.3 }]),
      cst('explosive-bolt', 'Разрывной болт', 14, 5, 'meteor', { element: 'fire', convertPct: 0.5, damageMult: 1.6, radius: 130, ailment: ail('burn', 0.6, 6, 3000, 5) }),
    ], m: [m('critChance', 'flat', 0.008, 'Крит'), m('critMultiplier', 'flat', 0.03, 'Множ. крита'), m('accuracy', 'flat', 0.01, 'Меткость'), m('dexterity', 'flat', 2, 'Ловкость')] },
    merc: { name: 'Наёмник', ab: [
      atk('spread-shot', 'Веерный выстрел', 9, 0.9, { weaponTypes: ['ranged'], damageMult: 0.6, count: 5, spread: 0.5 }),
      cst('volley', 'Залп', 16, 6, 'ground', { damageMult: 1.3, radius: 160 }),
      cst('retreat', 'Отход', 8, 6, 'leap', { weaponTypes: ['ranged'], damageMult: 0.5, dashDist: 200 }),
    ], m: [m('attackSpeed', 'increased', 0.015, 'Скор. атаки'), m('moveSpeed', 'increased', 0.01, 'Скор. движ.'), m('maxDamage', 'flat', 2, 'Урон'), m('dexterity', 'flat', 2, 'Ловкость')] },
    tricks: { name: 'Уловки', ab: [
      buf('smoke-bomb', 'Дымовая шашка', 8, 12, 6, [{ stat: 'evade', kind: 'increased', value: 0.6 }]),
      cst('caltrops-arb', 'Колючки', 10, 7, 'ground', { damageMult: 0.7, radius: 130, ailment: ail('freeze', 0.7, 0.2, 3000, 5) }),
      crs('blinding-powder', 'Ослепляющий порошок', 10, 8, { radius: 170, ailment: ail('bleed', 0.8, 2, 4000, 5) }),
    ], m: [m('maxHp', 'flat', 12, 'Здоровье'), m('evade', 'increased', 0.02, 'Уклонение'), m('resFire', 'flat', 0.02, 'Сопр. огню'), m('vitality', 'flat', 2, 'Живучесть')] },
  },
  // ── Ворожея — кинжал, Инт+Ловк ──
  vorozheya: {
    charms: { name: 'Чары', ab: [
      buf('fire-charm', 'Огненные чары', 8, 12, 12, [{ stat: 'firePct', kind: 'flat', value: 0.2 }, { stat: 'addFire', kind: 'flat', value: 4 }]),
      aur('elemental-aura', 'Стихийная аура', 0.25, [{ stat: 'firePct', kind: 'flat', value: 0.08 }, { stat: 'coldPct', kind: 'flat', value: 0.08 }, { stat: 'lightningPct', kind: 'flat', value: 0.08 }]),
      buf('thorn-mantle', 'Терновая мантия', 10, 14, 10, [{ stat: 'armor', kind: 'increased', value: 0.2 }, { stat: 'blockChance', kind: 'increased', value: 0.1 }]),
    ], m: [m('castSpeed', 'increased', 0.02, 'Скор. каста'), m('ailmentPct', 'flat', 0.03, 'Наложение статусов'), m('maxMana', 'flat', 10, 'Мана'), m('intelligence', 'flat', 2, 'Интеллект')] },
    hex: { name: 'Порча', ab: [
      crs('weakness', 'Проклятие слабости', 8, 8, { radius: 200, ailment: ail('wound', 0.8, 0.08, 4000, 5, 0.1) }),
      crs('armor-break', 'Порча брони', 10, 8, { radius: 200, ailment: ail('sunder', 0.8, 0.06, 4000, 5) }),
      crs('mass-hex', 'Массовое проклятие', 16, 12, { radius: 240, ailment: ail('shock', 0.7, 0.1, 4000, 5) }),
    ], m: [m('ailmentPct', 'flat', 0.03, 'Наложение статусов'), m('castSpeed', 'increased', 0.02, 'Скор. каста'), m('intelligence', 'flat', 2, 'Интеллект'), m('maxMana', 'flat', 10, 'Мана')] },
    poison: { name: 'Яд', ab: [
      atk('venom-blade', 'Отравленный клинок', 5, 0.7, { weaponTypes: ['melee'], damageMult: 1.1, element: 'poison', ailment: ail('poison', 0.7, 4, 4000, 6) }),
      cst('poison-cloud', 'Ядовитое облако', 14, 6, 'ground', { element: 'poison', convertPct: 0.7, damageMult: 1.1, radius: 150, ailment: ail('poison', 0.9, 5, 4000, 6) }),
      crs('decay', 'Разложение', 10, 8, { radius: 180, ailment: ail('poison', 0.9, 6, 5000, 8) }),
    ], m: [m('poisonPct', 'flat', 0.025, 'Урон ядом'), m('ailmentPct', 'flat', 0.03, 'Наложение статусов'), m('critChance', 'flat', 0.008, 'Крит'), m('dexterity', 'flat', 2, 'Ловкость')] },
  },
};

function activeNode(id, branchId, tier, ability, x) {
  return {
    id, kind: 'active', branchId, name: ability.name, description: `Активный скилл: ${ability.name}.`,
    cost: { type: 'points', amount: 1 }, requires: [], maxRank: AB_RANK,
    levelReq: TIER_LVL[tier], effect: { active: ability.a }, x, y: tier,
  };
}
function masteryNode(id, branchId, tier, mm, x) {
  const [stat, kind, value, label] = mm;
  const pretty = kind === 'increased' || ['critChance', 'blockChance', 'accuracy', 'interruptResist', 'resFire', 'resCold', 'resLightning', 'resPoison', 'physPct', 'firePct', 'coldPct', 'lightningPct', 'poisonPct', 'damagePct', 'ailmentPct'].includes(stat)
    ? `+${Math.round(value * 1000) / 10}% ${label}` : `+${value} ${label}`;
  return {
    id, kind: 'active', branchId, name: `Мастерство: ${label}`, description: `${pretty} за ранг.`,
    cost: { type: 'points', amount: 1 }, requires: [], maxRank: M_RANK,
    levelReq: TIER_LVL[tier], effect: { modifiers: [{ stat, kind, value }] }, x, y: tier,
  };
}

const trees = [];
for (const [classId, branches] of Object.entries(CLASSES)) {
  const nodes = [];
  const branchDefs = Object.entries(branches);
  branchDefs.forEach(([branchId, def], bi) => {
    const p = (k) => `a-${classId}-${branchId}-${k}`;
    const col = bi * 3;
    const layout = [
      ['t0', 0, 'ab', 0, []], ['m1', 1, 'm', 0, ['t0']], ['m2', 1, 'm', 1, ['t0']],
      ['a1', 2, 'ab', 1, ['m1']], ['m3', 2, 'm', 2, ['m2']], ['m4', 3, 'm', 3, ['a1']],
      ['a2', 3, 'ab', 2, ['m3']], ['m5', 4, 'm', 0, ['m4']], ['cap', 4, 'm', 1, ['a2']], ['m6', 4, 'm', 2, ['m5']],
    ];
    for (const [key, tier, type, si, req] of layout) {
      const node = type === 'ab'
        ? activeNode(p(key), branchId, tier, def.ab[si], col)
        : masteryNode(p(key), branchId, tier, def.m[si], col + 1);
      node.requires = req.map(p);
      nodes.push(node);
    }
  });
  trees.push({ classId, branches: branchDefs.map(([id, def]) => ({ id, name: def.name })), nodes });
}

// Заступник — не трогаем: берём его дерево из существующего файла как есть.
try {
  const existing = JSON.parse(readFileSync(out, 'utf8'));
  const zast = existing.find((t) => t.classId === 'zastupnik');
  if (zast) trees.push(zast);
} catch { /* нет файла — пропускаем */ }

writeFileSync(out, JSON.stringify(trees, null, 2) + '\n');
const total = trees.reduce((s, t) => s + t.nodes.length, 0);
console.log(`Активных деревьев: ${trees.length}, узлов всего: ${total} (Заступник сохранён) → ${out}`);

// Генератор пассивного древа v4 — ВЕЕР ветвей от каждого входа (PoE2-style).
// 4 входа-атрибута у центра (↑Сила ←Ловкость →Живучесть ↓Интеллект); от каждого веером
// расходятся несколько тематических АРТЕРИЙ (18 всего). Каждая артерия — линия с РОМБАМИ
// (развилка на 2: ◄лево/►право дают РАЗНЫЕ статы → выбор пути), нотаблем и (сигнатурная)
// кейстоном. Внутри веера соседние артерии сшиты ПЕРЕМЫЧКАМИ (выбор маршрута под билд), а
// соседние веера — ПЕРЕХОДАМИ в диагональных зазорах (по 3 на стык, для гибридов). Бонусы —
// только проценты (без плоских атрибутов), малые, множатся на ранг. Гейт входов по классу —
// в classes.json (passiveEntries). Пишет skills-passive.json. Запуск: node scripts/gen-passive.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const out = join(dirname(fileURLToPath(import.meta.url)), '..',
  'packages/shared/src/config/data/skills-passive.json');

const R0 = 60;      // радиус входа от центра
const LSTEP = 34;   // прирост радиуса на «уровень» артерии

const ENT = { str: -90, dex: 180, vit: 0, int: 90 };  // направление веера (град): ↑ ← → ↓
const ENT_NAME = { str: 'Сила', dex: 'Ловкость', vit: 'Живучесть', int: 'Интеллект' };

// Тема артерии — упорядоченный набор [stat, kind, value(доля), подпись]. Узлы берут её по кругу;
// в ромбе ◄лево и ►право получают СОСЕДНИЕ (разные) элементы темы.
const T = {
  bulwark: [['armor', 'increased', 0.03, 'броня'], ['maxHp', 'increased', 0.03, 'здоровье'], ['blockChance', 'increased', 0.02, 'блок']],
  crush: [['interruptResist', 'flat', 0.03, 'стойкость к прерыв.'], ['ailmentPct', 'flat', 0.03, 'наложение статусов'], ['physPct', 'flat', 0.018, 'физ. урон']],
  phys: [['physPct', 'flat', 0.02, 'физ. урон'], ['physPct', 'flat', 0.025, 'физ. урон'], ['damagePct', 'flat', 0.012, 'урон']],
  holyfire: [['firePct', 'flat', 0.025, 'урон огнём'], ['physPct', 'flat', 0.018, 'физ. урон'], ['damagePct', 'flat', 0.012, 'урон']],
  swift: [['attackSpeed', 'increased', 0.02, 'скор. атаки'], ['moveSpeed', 'increased', 0.015, 'скор. движения'], ['attackSpeed', 'increased', 0.025, 'скор. атаки']],
  agile: [['evade', 'increased', 0.03, 'уклонение'], ['moveSpeed', 'increased', 0.015, 'скор. движения'], ['attackSpeed', 'increased', 0.018, 'скор. атаки']],
  precision: [['critChance', 'increased', 0.03, 'шанс крита'], ['critMultiplier', 'increased', 0.03, 'множ. крита'], ['accuracy', 'increased', 0.03, 'меткость']],
  pierce: [['physPct', 'flat', 0.02, 'физ. урон'], ['accuracy', 'increased', 0.03, 'меткость'], ['critChance', 'increased', 0.03, 'шанс крита']],
  regen: [['hpRegen', 'increased', 0.05, 'реген HP'], ['manaRegen', 'increased', 0.05, 'реген маны'], ['maxHp', 'increased', 0.025, 'здоровье']],
  life: [['maxHp', 'increased', 0.03, 'здоровье'], ['hpRegen', 'increased', 0.05, 'реген HP'], ['maxHp', 'increased', 0.025, 'здоровье']],
  barrier: [['armor', 'increased', 0.03, 'броня'], ['blockChance', 'increased', 0.02, 'блок'], ['interruptResist', 'flat', 0.025, 'стойкость к прерыв.']],
  resist: [['resFire', 'flat', 0.02, 'сопр. огню'], ['resCold', 'flat', 0.02, 'сопр. холоду'], ['resLightning', 'flat', 0.02, 'сопр. молнии'], ['resPoison', 'flat', 0.02, 'сопр. яду']],
  mana: [['maxMana', 'increased', 0.03, 'мана'], ['manaRegen', 'increased', 0.05, 'реген маны'], ['castSpeed', 'increased', 0.02, 'скор. каста']],
  poison: [['poisonPct', 'flat', 0.025, 'урон ядом'], ['ailmentPct', 'flat', 0.03, 'наложение статусов'], ['damagePct', 'flat', 0.012, 'урон']],
  lightning: [['lightningPct', 'flat', 0.025, 'урон молнией'], ['castSpeed', 'increased', 0.02, 'скор. каста'], ['damagePct', 'flat', 0.012, 'урон']],
  cold: [['coldPct', 'flat', 0.025, 'урон холодом'], ['castSpeed', 'increased', 0.02, 'скор. каста'], ['damagePct', 'flat', 0.012, 'урон']],
  fire: [['firePct', 'flat', 0.025, 'урон огнём'], ['castSpeed', 'increased', 0.02, 'скор. каста'], ['damagePct', 'flat', 0.012, 'урон']],
  hex: [['ailmentPct', 'flat', 0.03, 'наложение статусов'], ['castSpeed', 'increased', 0.02, 'скор. каста'], ['firePct', 'flat', 0.018, 'урон огнём']],
};

const KEY = {
  'str-heavy': { name: 'Берсерк', mods: [['physPct', 'flat', 0.15], ['attackSpeed', 'increased', 0.10], ['armor', 'increased', -0.15]] },
  'dex-precision': { name: 'Идеальный удар', mods: [['critChance', 'increased', 0.12], ['critMultiplier', 'increased', 0.15], ['maxHp', 'increased', -0.10]] },
  'vit-barrier': { name: 'Несокрушимый', mods: [['maxHp', 'increased', 0.15], ['armor', 'increased', 0.15], ['moveSpeed', 'increased', -0.10]] },
  'int-lightning': { name: 'Перегрузка', mods: [['damagePct', 'flat', 0.08], ['castSpeed', 'increased', 0.12], ['maxMana', 'increased', -0.15]] },
};

const NOTE = {
  bulwark: 'Несокрушимость', crush: 'Тяжёлая длань', phys: 'Разрушение', holyfire: 'Кара Света',
  swift: 'Шквал', agile: 'Танцующий клинок', precision: 'Смертельная точность', pierce: 'Пробойник',
  regen: 'Второе дыхание', life: 'Живучесть', barrier: 'Латная воля', resist: 'Стихийный оплот',
  mana: 'Поток маны', poison: 'Зараза', lightning: 'Гроза', cold: 'Ледяное касание', fire: 'Пиромания', hex: 'Скорая порча',
};

// Веера: у каждого входа несколько артерий (угол = смещение от направления входа). sig → кейстон.
const ARTERIES = [
  { entry: 'str', key: 'bulwark', ang: -128, theme: 'bulwark' }, { entry: 'str', key: 'crush', ang: -104, theme: 'crush' }, { entry: 'str', key: 'heavy', ang: -76, theme: 'phys', sig: true }, { entry: 'str', key: 'holyfire', ang: -52, theme: 'holyfire' },
  { entry: 'vit', key: 'regen', ang: -35, theme: 'regen' }, { entry: 'vit', key: 'life', ang: -11, theme: 'life' }, { entry: 'vit', key: 'barrier', ang: 14, theme: 'barrier', sig: true }, { entry: 'vit', key: 'resist', ang: 38, theme: 'resist' },
  { entry: 'int', key: 'mana', ang: 52, theme: 'mana' }, { entry: 'int', key: 'poison', ang: 69, theme: 'poison' }, { entry: 'int', key: 'lightning', ang: 86, theme: 'lightning', sig: true }, { entry: 'int', key: 'cold', ang: 103, theme: 'cold' }, { entry: 'int', key: 'fire', ang: 120, theme: 'fire' }, { entry: 'int', key: 'hex', ang: 138, theme: 'hex' },
  { entry: 'dex', key: 'pierce', ang: 156, theme: 'pierce' }, { entry: 'dex', key: 'agile', ang: 178, theme: 'agile' }, { entry: 'dex', key: 'precision', ang: 202, theme: 'precision', sig: true }, { entry: 'dex', key: 'swift', ang: 224, theme: 'swift' },
];

const DIAMONDS = 3;   // ромбов на артерию

const nodes = [];
const edges = [];
const entryNodes = [];

const rad = (d) => (d * Math.PI) / 180;
const pol = (deg, r) => [Math.round(Math.cos(rad(deg)) * r), Math.round(Math.sin(rad(deg)) * r)];
const pct = (v) => `${Math.round(v * 1000) / 10}%`;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const entPos = (e) => pol(ENT[e], R0);
const fromE = (eP, ang, r, off = 0) => [Math.round(eP[0] + Math.cos(rad(ang)) * r + Math.cos(rad(ang + 90)) * off), Math.round(eP[1] + Math.sin(rad(ang)) * r + Math.sin(rad(ang + 90)) * off)];
const mod = (stat, kind, value) => ({ stat, kind, value });

function smallNode(id, el, level, pos) {
  nodes.push({
    id, kind: 'passive', notable: false, name: `${cap(el[3])} ${pct(el[2])}`,
    description: `Малый узел: ${pct(el[2])} к «${el[3]}» за ранг.`,
    cost: { type: 'gold', amount: 100 + level * 10 }, requires: [], maxRank: level < 5 ? 4 : 3, levelReq: 1,
    effect: { modifiers: [mod(el[0], el[1], el[2])] }, x: pos[0], y: pos[1],
  });
}
function noteNode(id, theme, name, pos) {
  const t = T[theme]; const a = t[0]; let b = t[1];
  if (b[0] === a[0]) b = t[2] ?? t[0];
  const mods = [mod(a[0], a[1], a[2] * 2.2), mod(b[0], b[1], b[2] * 2.2)];
  nodes.push({
    id, kind: 'passive', notable: true, name,
    description: mods.map((m) => `+${pct(m.value)} к «${labelOf(m.stat)}»`).join(', ') + '.',
    cost: { type: 'gold', amount: 600 }, requires: [], maxRank: 1, levelReq: 1,
    effect: { modifiers: mods }, x: pos[0], y: pos[1],
  });
}
function keyNode(id, ks, pos) {
  const mods = ks.mods.map(([s, k, v]) => mod(s, k, v));
  nodes.push({
    id, kind: 'passive', notable: true, name: `★ ${ks.name}`,
    description: `Кейстон: ${mods.map((m) => `${m.value < 0 ? '−' : '+'}${pct(Math.abs(m.value))} к «${labelOf(m.stat)}»`).join(', ')}.`,
    cost: { type: 'gold', amount: 1500 }, requires: [], maxRank: 1, levelReq: 1,
    effect: { modifiers: mods }, x: pos[0], y: pos[1],
  });
}
const LABELS = { physPct: 'физ. урон', firePct: 'урон огнём', coldPct: 'урон холодом', lightningPct: 'урон молнией', poisonPct: 'урон ядом', damagePct: 'урон', ailmentPct: 'наложение статусов', attackSpeed: 'скор. атаки', castSpeed: 'скор. каста', critChance: 'шанс крита', critMultiplier: 'множ. крита', moveSpeed: 'скор. движения', accuracy: 'меткость', armor: 'броня', evade: 'уклонение', blockChance: 'блок', interruptResist: 'стойкость к прерыв.', maxHp: 'здоровье', maxMana: 'мана', hpRegen: 'реген HP', manaRegen: 'реген маны', resFire: 'сопр. огню', resCold: 'сопр. холоду', resLightning: 'сопр. молнии', resPoison: 'сопр. яду' };
const labelOf = (s) => LABELS[s] ?? s;

// Растит одну артерию веером от входа. Возвращает id merge-узлов ромбов (для перемычек/переходов).
function growArtery(art) {
  const eP = entPos(art.entry);
  const theme = T[art.theme];
  const id = (suf) => `p-${art.entry}-${art.key}-${suf}`;
  let ti = 0;                 // индекс темы (◄/► берут соседние → разные статы)
  const pick = () => theme[(ti++) % theme.length];
  let level = 0;
  const entryId = `p-${art.entry}`;
  // стебель n0, n1
  const n0 = id('n0'); smallNode(n0, pick(), level, fromE(eP, art.ang, R0 - 26 + level * LSTEP)); edges.push([entryId, n0]); level++;
  let splitId = id('n1'); smallNode(splitId, pick(), level, fromE(eP, art.ang, R0 - 26 + level * LSTEP)); edges.push([n0, splitId]); level++;
  const merges = [];
  for (let dm = 0; dm < DIAMONDS; dm++) {
    const rBase = R0 - 26 + level * LSTEP;
    const l1 = id(`d${dm}l1`), r1 = id(`d${dm}r1`), l2 = id(`d${dm}l2`), r2 = id(`d${dm}r2`), mg = id(`d${dm}m`);
    smallNode(l1, pick(), level, fromE(eP, art.ang, rBase, 20));       // ◄ лево
    smallNode(r1, pick(), level, fromE(eP, art.ang, rBase, -20));      // ► право (другой стат)
    smallNode(l2, pick(), level + 1, fromE(eP, art.ang, rBase + LSTEP, 12));
    smallNode(r2, pick(), level + 1, fromE(eP, art.ang, rBase + LSTEP, -12));
    smallNode(mg, pick(), level + 2, fromE(eP, art.ang, rBase + LSTEP * 2, 0));
    edges.push([splitId, l1], [splitId, r1], [l1, l2], [r1, r2], [l2, mg], [r2, mg]);
    merges.push(mg);
    splitId = mg; level += 3;
  }
  // нотабль в конце + кейстон у сигнатурной
  const noteId = id('note');
  noteNode(noteId, art.theme, NOTE[art.theme], fromE(eP, art.ang, R0 - 26 + level * LSTEP));
  edges.push([splitId, noteId]); level++;
  if (art.sig) {
    const kId = id('key');
    keyNode(kId, KEY[`${art.entry}-${art.key}`], fromE(eP, art.ang, R0 - 26 + level * LSTEP));
    edges.push([noteId, kId]);
  }
  art._merges = merges;
}

// Входы
for (const e of Object.keys(ENT)) {
  const p = entPos(e); const first = T[ARTERIES.find((a) => a.entry === e).theme][0];
  entryNodes.push(`p-${e}`);
  nodes.push({
    id: `p-${e}`, kind: 'passive', notable: false, name: `${ENT_NAME[e]} (вход)`,
    description: `Начало веера ветвей атрибута «${ENT_NAME[e]}».`,
    cost: { type: 'gold', amount: 160 }, requires: [], maxRank: 1, levelReq: 1,
    effect: { modifiers: [mod(first[0], first[1], first[2])] }, x: p[0], y: p[1],
  });
}

for (const art of ARTERIES) growArtery(art);

// Перемычки ВНУТРИ веера: соседние артерии одного входа сшиты на 1-м и 2-м ромбе.
const byEntry = {};
for (const a of ARTERIES) (byEntry[a.entry] ??= []).push(a);
for (const e of Object.keys(byEntry)) {
  const g = byEntry[e].sort((a, b) => a.ang - b.ang);
  for (let i = 0; i + 1 < g.length; i++) { edges.push([g[i]._merges[0], g[i + 1]._merges[0]]); edges.push([g[i]._merges[1], g[i + 1]._merges[1]]); }
}

// Переходы между соседними веерами (в зазорах, по 3 на стык — merge-узлы 3 ромбов).
const find = (e, key) => ARTERIES.find((a) => a.entry === e && a.key === key);
const CROSS = [['str', 'holyfire', 'vit', 'regen'], ['vit', 'resist', 'int', 'mana'], ['int', 'hex', 'dex', 'pierce'], ['dex', 'swift', 'str', 'bulwark']];
for (const [e1, k1, e2, k2] of CROSS) {
  const a = find(e1, k1), b = find(e2, k2);
  for (let i = 0; i < DIAMONDS; i++) edges.push([a._merges[i], b._merges[i]]);
}

const tree = { entryNodes, edges, nodes };
writeFileSync(out, JSON.stringify(tree, null, 2) + '\n');
const nt = nodes.filter((n) => n.notable).length;
console.log(`Пассивных узлов: ${nodes.length} (нотаблей/кейстонов: ${nt}), рёбер: ${edges.length}, артерий: ${ARTERIES.length} → ${out}`);

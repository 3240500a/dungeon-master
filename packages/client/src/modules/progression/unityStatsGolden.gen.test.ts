/**
 * ПРОДЮСЕР И СТОРОЖ эталона СТАТОВ ГЕРОЯ ДЛЯ UNITY (разбор U5/U6): производные статы целиком (`GameState.derived` с провайдерами
 * `App` — гир, класс брони, мастерства, древо скилов, ауры и стойки), свои и итоговые атрибуты, резерв пулов, полоса опыта (`xpProgress`),
 * HUD 3D (`hud3d`: полосы с резервом, «(−N)», инфо-строка «этаж · сложность · вызов ур.»), блок атрибутов мастера (`derivedBlock`), ЛИСТ
 * ПЕРСОНАЖА целиком (`characterPanel`: шапка, полосы, ауры, мощь, атрибуты своё/гир, урон ЛКМ/ПКМ/хотбара с ДПС и разбивкой, статусы
 * удара, защита, сопротивления и выдержка, «Статусы», «Прочее», подсказки), карточка оружия и таблица «в руках → скую» окна ковки
 * (`cardWith`, `compareTable` — с вилкой до ковки), предпросмотр верстака (`benchTarget` → `diffStrings` строк без аффиксов) и древо
 * скилов (`renderSkillTree`: ветки своего класса, ромбы-вставки, подсказки, подписи веток).
 *
 * ⭐ Окна — НАСТОЯЩИЕ: рисуются в node на поддельном DOM (`unityGoldenDom.testkit.ts`) с настоящим `App` без сети и `GameState`, эталон
 * снимается с их вывода — копий правил здесь почти нет. Копия — только строка `baseLines` верстака (сторожится строкой исходника).
 *
 * Эталон: `__golden__/unity_stats.json` → Unity `Assets/DM/UI/Tests/unity_stats_golden.json` (`tools/unity-check/golden_sync.py`),
 * проверка — `StatsCheck`. Перезапись: `npx vitest run packages/client/src/modules/progression/unityStatsGolden.gen.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  CRAFT_SLOT_LIST, ConfigRegistry, baseTierRange, craftWeapon, createRng, defaultParts, familiesOf, fullJournal, generateItem, insertFits, itemFromBaseId,
  newCharacterSave, shapeFoundWeapon, upgradedItem, xpProgress,
  type CraftInput, type Item, type SaveState,
} from '@dm/shared';
import { installFakeDom, tipOf, textOf, dom, FakeEl, type FakeText } from './unityGoldenDom.testkit.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(join(HERE, rel), 'utf8');
const BENCH = read('../town/forgeBench.ts');
/** Строки исходников, повторённые ниже копией. Нет строки — правило веба поменялось: обновить копию, эталон и порт Unity. */
const SRC: [string, string][] = [
  [BENCH, 'itemDescLines(item).filter((l) => !l.affix).map((l) => l.text);'],
  [BENCH, "info.append(mk('div', `font-size:11px;color:${COLORS.dim};margin-top:2px`, benchTargetLabel(app.config, item, target)));"],
  [BENCH, ": mk('div', `font-size:12px;color:${COLORS.dim};margin-top:8px`, 'Кузнец эту вещь не меняет.'));"],
];

// ── поддельный DOM — ДО модулей окон (kit вешает слушатель окна при загрузке) ──
installFakeDom();
const { App } = await import('../../core/app.js');
const { GameState } = await import('../../core/gameState.js');
const { characterPanel, masterPanel } = await import('./panels.js');
const { compareTable, cardWith } = await import('../town/craftPanel.js');
const { benchTarget, benchTargetLabel, diffStrings } = await import('../town/forgeActions.js');
const { itemDescLines } = await import('../inventory/itemView.js');
const { renderSkillTree, resetSkillTreeView } = await import('../skills/skillTreeView.js');
const { mountHud3d } = await import('../../render3d/hud3d.js');

type AppT = InstanceType<typeof App>;
type GS = InstanceType<typeof GameState>;

const app: AppT = new App({ offline: true });
const reg: ConfigRegistry = app.config;
const bal = reg.get('balance');
const sortedTiers = [...reg.get('item-tiers')].sort((a, b) => a.minItemLevel - b.minItemLevel);

/** Вещь базы `baseId` на ступени окна (`at`: 0 — низ, 1 — верх), редкость — как просили; оружие — с деталями находки. */
function gen(baseId: string, rarity: 'normal' | 'magic' | 'rare' | 'unique', at: number, seed: number): Item {
  const base = reg.get('items.base').find((b) => b.id === baseId)!;
  const { lo, hi } = baseTierRange(reg, base);
  const t = sortedTiers[Math.round(lo + (hi - lo) * at)]!;
  const it = generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'), {
    dropBias: 1, itemLevel: t.minItemLevel + 2, tierLevel: t.minItemLevel + 2, baseId, tiers: reg.get('item-tiers'), rarities: reg.get('rarities'),
    forceRarity: rarity, maxReqTotal: bal.maxTotalRequirement, baseRoll: bal.loot.baseRoll, origin: 'drop',
  }, createRng(seed));
  const shaped = base.kind === 'weapon' ? shapeFoundWeapon(reg, it) : it;
  return { ...shaped, uid: `u-${baseId}-${seed}`, pos: null };
}
const baseIds = (pred: (b: ReturnType<ConfigRegistry['get']> extends never ? never : any) => boolean): string[] =>
  reg.get('items.base').filter((b) => b.enabled !== false && pred(b)).map((b) => b.id);

/** Узлы древа: первые `n` по ветке (вход и дальше по рёбрам), ранг `r`. */
function branchNodes(tree: 'skill-tree' | 'mastery-tree', branch: string, n: number): string[] {
  const t = reg.get(tree) as { nodes: { id: string; branchId?: string }[]; edges: [string, string][]; entryNodes?: string[] };
  const inBranch = new Set(t.nodes.filter((x) => x.branchId === branch).map((x) => x.id));
  const start = (t.entryNodes ?? []).find((e) => inBranch.has(e)) ?? [...inBranch][0]!;
  const out = [start], seen = new Set(out);
  for (let i = 0; i < out.length && out.length < n; i++) {
    for (const [a, b] of t.edges) {
      const o = a === out[i] ? b : b === out[i] ? a : null;
      if (o && inBranch.has(o) && !seen.has(o)) { seen.add(o); out.push(o); if (out.length >= n) break; }
    }
  }
  return out;
}
const allocate = (o: Record<string, number>, ids: string[], r: number): void => { for (const id of ids) o[id] = r; };

interface Case {
  name: string; save: SaveState; toggles: string[]; hp: number; mana: number; stamina: number;
  lastTarget?: { name: string; accuracy: number; evade: number };
  area: 'town' | 'dungeon'; depth: number; difficultyId: string; challengeLevel: number | null;
  pending?: Partial<Record<'strength' | 'dexterity' | 'intelligence' | 'vitality', number>>;
  /** Таблицы конфига этого случая поверх общего (Unity накладывает то же). */
  patch?: Record<string, unknown>;
}

/** Гнёзда узла: ранг узла `rank`, вставки по порядку — те, что подходят носителю и ещё не заняли тип; доноры — ранг 3. */
function socket(s: SaveState, nodeId: string, rank: number, ids: string[]): void {
  s.skills[nodeId] = rank;
  const active = reg.get('skill-tree').nodes.find((n) => n.id === nodeId)?.effect.active;
  if (!active) return;
  const types = new Set<string>();
  const put: string[] = [];
  for (const id of ids) {
    const ins = reg.get('skill-inserts').find((i) => i.id === id && i.enabled !== false);
    if (!ins || types.has(ins.type) || !insertFits(ins, active)) continue;
    types.add(ins.type); put.push(id);
    for (const n of reg.get('skill-tree').nodes) if (n.effect.grantsInsert === id) s.skills[n.id] = 3;
  }
  s.sockets = { ...(s.sockets ?? {}), [nodeId]: put };
}
/** Таблицы конфига по умолчанию — каждый случай ставит свои поверх (`patch`) и возвращает прежние. */
const BASE_TABLES: Record<string, unknown> = {};

function makeCases(): Case[] {
  const out: Case[] = [];
  let seed = 11;
  // 1) свежий воин: стартовый комплект, город
  {
    const s = newCharacterSave(reg, 'warrior', 'Тест', 'c-1');
    out.push({ name: 'warrior-fresh', save: s, toggles: [], hp: 1e9, mana: 1e9, stamina: 1e9, area: 'town', depth: 0, difficultyId: 'normal', challengeLevel: null });
  }
  // 2) воин в гире: щит, тяжёлая броня, древо меча и щита, мастерства, аура и стойка, подземелье с вызовом от сервера, последний монстр
  {
    const s = newCharacterSave(reg, 'warrior', 'Гром', 'c-2');
    s.level = 22; s.xp = Math.round(bal.xpTable[22]! + (bal.xpTable[23]! - bal.xpTable[22]!) * 0.37); s.gold = 1234;
    s.attributes = { strength: 80, dexterity: 30, intelligence: 14, vitality: 60 };
    s.unspentAttributePoints = 7; s.unspentSkillPoints = 2; s.unspentMasteryPoints = 1;
    const sword = baseIds((b) => b.kind === 'weapon' && b.weaponClass === 'sword' && (b.hands ?? 1) === 1)[0]!;
    s.equipment.weapon = gen(sword, 'rare', 0.5, seed++);
    const shield = baseIds((b) => b.kind === 'shield')[0];
    if (shield) s.equipment.offhand = gen(shield, 'magic', 0.5, seed++);
    for (const slot of ['helm', 'chest', 'gloves', 'boots', 'belt', 'ring', 'amulet'] as const) {
      const id = baseIds((b) => b.kind !== 'weapon' && b.kind !== 'consumable' && (b as { slot?: string }).slot === slot).slice(-1)[0];
      if (id) s.equipment[slot] = gen(id, seed % 2 ? 'magic' : 'rare', 0.7, seed++);
    }
    allocate(s.skills, branchNodes('skill-tree', 'b-sword1h', 6), 3);
    allocate(s.skills, branchNodes('skill-tree', 'b-shield', 3), 2);
    allocate(s.skills, branchNodes('skill-tree', 'b-aura', 2), 1);
    allocate(s.skills, branchNodes('skill-tree', 'b-stance', 2), 2);
    allocate(s.skills, branchNodes('skill-tree', 'b-class-warrior', 3), 1);
    const mt = reg.get('mastery-tree') as { nodes: { id: string }[] };
    allocate(s.masteries, mt.nodes.slice(0, 9).map((n) => n.id), 2);
    const tree = reg.get('skill-tree');
    const act = (cat: string): string | undefined => Object.keys(s.skills).find((id) => tree.nodes.find((n) => n.id === id)?.effect.active?.category === cat);
    s.mouseRight = act('attack') ?? null;
    s.hotbar = [act('stance') ?? null, act('aura') ?? null, null];
    // у атаки ПКМ — вставки ширины, зазубрин и стихии (вторая цена — маной)
    if (s.mouseRight) socket(s, s.mouseRight, 12, ['ins-wide-arc', 'ins-serrated', 'ins-frost-edge', 'ins-flurry']);
    const toggles = [act('aura'), act('stance')].filter((x): x is string => !!x);
    out.push({
      name: 'warrior-geared', save: s, toggles, hp: 140, mana: 30, stamina: 55, lastTarget: { name: 'Скелет-лучник', accuracy: 64, evade: 41 },
      area: 'dungeon', depth: 4, difficultyId: 'nightmare', challengeLevel: 27,
    });
    // 2b) тот же — сервер без вызова (своя мера), неизвестная сложность → умолчание
    out.push({ ...out[out.length - 1]!, name: 'warrior-nocl', challengeLevel: null, difficultyId: 'no-such-tier', depth: 3, lastTarget: undefined });
    // 2c) набор очков в буфере листа (+Δ зелёным)
    out.push({ ...out[out.length - 2]!, name: 'warrior-pending', pending: { strength: 3, vitality: 4 } });
  }
  // 3) маг: посох, огонь и холод с вставками в гнёздах, аура маны
  {
    const s = newCharacterSave(reg, 'mage', 'Искра', 'c-3');
    s.level = 15; s.xp = bal.xpTable[15]! + 10; s.gold = 77;
    s.attributes = { strength: 15, dexterity: 18, intelligence: 70, vitality: 30 };
    const staff = baseIds((b) => b.kind === 'weapon' && b.weaponClass === 'staff')[0]!;
    s.equipment.weapon = gen(staff, 'rare', 0.4, seed++);
    allocate(s.skills, branchNodes('skill-tree', 'b-fire', 8), 4);
    allocate(s.skills, branchNodes('skill-tree', 'b-cold', 6), 3);
    allocate(s.skills, branchNodes('skill-tree', 'b-curse', 2), 1);
    allocate(s.skills, branchNodes('skill-tree', 'b-aura', 3), 2);
    const tree = reg.get('skill-tree');
    const casts = Object.keys(s.skills).filter((id) => tree.nodes.find((n) => n.id === id)?.effect.active?.category === 'cast');
    const curse = Object.keys(s.skills).find((id) => tree.nodes.find((n) => n.id === id)?.effect.active?.category === 'curse');
    const aura = Object.keys(s.skills).find((id) => tree.nodes.find((n) => n.id === id)?.effect.active?.category === 'aura');
    s.mouseLeft = 'attack'; s.mouseRight = casts[0] ?? null; s.hotbar = [casts[1] ?? null, curse ?? null, aura ?? null];
    // вставки: огненные — в первый каст (что влезет)
    // вставки, что ВСТАНУТ (подходят носителю, разные типы, донор вложен): у первого каста — урон, статус и компаньон; второму — пусто
    if (casts[0]) socket(s, casts[0], 13, ['ins-flame-edge', 'ins-kindling', 'ins-heavy-blow', 'ins-arc-burst']);
    if (casts[1]) socket(s, casts[1], 6, ['ins-frost-edge', 'ins-thrift']);
    out.push({ name: 'mage', save: s, toggles: aura ? [aura] : [], hp: 60, mana: 200, stamina: 10, area: 'dungeon', depth: 1, difficultyId: 'normal', challengeLevel: 15,
      lastTarget: { name: 'Зомби', accuracy: 30, evade: 12 } });
  }
  // 4) вьюга: два одноручных (дуал), лёгкая броня
  {
    const s = newCharacterSave(reg, 'vyuga', 'Двойка', 'c-4');
    s.level = 9; s.attributes = { strength: 30, dexterity: 40, intelligence: 10, vitality: 25 };
    const sw = baseIds((b) => b.kind === 'weapon' && b.weaponClass === 'sword' && (b.hands ?? 1) === 1)[0]!;
    s.equipment.weapon = gen(sw, 'magic', 0.2, seed++);
    s.equipment.offhand = { ...gen(sw, 'normal', 0.2, seed++), slot: 'weapon' };
    allocate(s.skills, branchNodes('skill-tree', 'b-dual', 4), 2);
    allocate(s.skills, branchNodes('skill-tree', 'b-armor-light', 3), 2);
    out.push({ name: 'vyuga-dual', save: s, toggles: [], hp: 90, mana: 20, stamina: 80, area: 'town', depth: 0, difficultyId: 'normal', challengeLevel: null });
  }
  // 5) лучник без оружия (снял) и с низким HP; 6) арбалетчик
  {
    const s = newCharacterSave(reg, 'archer', 'Пусто', 'c-5');
    delete s.equipment.weapon;
    out.push({ name: 'archer-bare', save: s, toggles: [], hp: 3, mana: 5, stamina: 0, area: 'dungeon', depth: 2, difficultyId: 'normal', challengeLevel: null });
    const a = newCharacterSave(reg, 'arbalest', 'Болт', 'c-6');
    a.level = 30; a.attributes = { strength: 45, dexterity: 90, intelligence: 12, vitality: 50 };
    allocate(a.skills, branchNodes('skill-tree', 'b-crossbow', 7), 3);
    out.push({ name: 'arbalest', save: a, toggles: [], hp: 1e9, mana: 1e9, stamina: 1e9, area: 'dungeon', depth: 9, difficultyId: 'hell', challengeLevel: 70 });
  }
  // 8) капы: латы во все слоты на конфиге, где класс брони режет бег и держит ошеломление сверх потолков (−45 % бега, −40 % атаки, 60 % выдержки)
  {
    const s = newCharacterSave(reg, 'zastupnik', 'Латы', 'c-caps');
    s.level = 12; s.attributes = { strength: 90, dexterity: 20, intelligence: 10, vitality: 70 };
    for (const slot of ['helm', 'chest', 'gloves', 'boots', 'belt'] as const) {
      const id = baseIds((b) => b.kind === 'armor' && (b as { slot?: string }).slot === slot)[0];
      if (id) s.equipment[slot] = { ...gen(id, 'normal', 0.3, seed++), armorClass: 'plate' };
    }
    const plate = reg.get('armor-classes').map((a) => (a.id === 'plate' ? { ...a, move: -0.2, atk: -0.15, poise: { ...a.poise, daze: 0.2, wound: 0.15 } } : a));
    out.push({ name: 'caps', save: s, toggles: [], hp: 1e9, mana: 1e9, stamina: 1e9, area: 'town', depth: 0, difficultyId: 'normal', challengeLevel: null, patch: { 'armor-classes': plate } });
  }
  // 7) заступник, ворожея — свои классовые ветки в древе
  for (const cls of ['zastupnik', 'vorozheya']) {
    const s = newCharacterSave(reg, cls, cls, `c-${cls}`);
    allocate(s.skills, branchNodes('skill-tree', `b-class-${cls}`, 4), 1);
    out.push({ name: cls, save: s, toggles: [], hp: 1e9, mana: 1e9, stamina: 1e9, area: 'town', depth: 0, difficultyId: 'normal', challengeLevel: null });
  }
  return out;
}

/** Поставить сейв в `App` (сеттер подключает провайдеры, как в игре) и состояние кадра. */
function enter(c: Case): GS {
  const keys = new Set([...Object.keys(BASE_TABLES), ...Object.keys(c.patch ?? {})]);
  for (const k of keys) if (!(k in BASE_TABLES)) BASE_TABLES[k] = reg.get(k as never);
  const tables = Object.fromEntries([...keys].map((k) => [k, c.patch?.[k] ?? BASE_TABLES[k]]));
  if (keys.size) reg.reload(tables as never, { cross: false });
  const gs = new GameState(structuredClone(c.save));
  app.state = gs;
  gs.toggles = [...c.toggles];
  const d = gs.derived();
  gs.hp = Math.min(c.hp, d.maxHp); gs.mana = Math.min(c.mana, d.maxMana); gs.stamina = Math.min(c.stamina, d.maxStamina);
  gs.area = c.area; gs.depth = c.depth; gs.difficultyId = c.difficultyId; gs.challengeLevel = c.challengeLevel;
  app.lastTarget = c.lastTarget;
  return gs;
}

// ── снятие вывода окон ──────────────────────────────────────────────────────────────────────────────
/**
 * Строка окна: листовые тексты по порядку («ячейки»), полоса — `▮ширина`; кнопки — мимо (кроме подписи действий листа); подсказка — если
 * есть. Так же Unity сериализует свою модель (`StatsCheck`).
 */
interface Row { cells: string[]; tip?: string }
function cells(el: FakeEl, acc: string[] = []): string[] {
  if (el.tagName === 'button') return acc;
  if (el.html !== undefined) { const t = textOf(el); if (t) acc.push(t); return acc; }
  const kids = el.childNodes;
  if (!kids.length) { if (el.style.width !== undefined && el.style.height !== undefined) acc.push(`▮${String(el.style.width)}`); return acc; }
  if (kids.every((k) => !(k instanceof FakeEl))) { const t = textOf(el); if (t) acc.push(t); return acc; }
  for (const k of kids) { if (k instanceof FakeEl) cells(k, acc); else { const t = (k as FakeText).textContent.trim(); if (t) acc.push(t); } }
  return acc;
}
function row(el: FakeEl): Row {
  const r: Row = { cells: cells(el) };
  const tip = tipOf(el);
  if (tip !== null) r.tip = tip;
  return r;
}

/** Лист персонажа: блоки тела окна — заголовок блока (`h4`) и строки; шапка, полосы, ауры и мощь — блоками без заголовка. */
function sheetOf(c: Case): { title?: string; rows: Row[] }[] {
  enter(c);
  let body = new FakeEl('div');
  const ui = { refresh: (): void => { body = new FakeEl('div'); panel.render(body as unknown as HTMLElement); } };
  const panel = characterPanel(app, ui as never);
  panel.render(body as unknown as HTMLElement);
  for (const [attr, n] of Object.entries(c.pending ?? {})) {
    // «+» строки атрибута — пятая строка блока атрибутов по порядку; жмём n раз
    for (let i = 0; i < (n ?? 0); i++) {
      const label = ({ strength: 'Сила', dexterity: 'Ловкость', intelligence: 'Интеллект', vitality: 'Живучесть' } as Record<string, string>)[attr]!;
      const r = body.all().find((e) => e.tagName === 'div' && e.children[0]?.tagName === 'span' && textOf(e.children[0]) === label && e.all().some((x) => x.tagName === 'button'))!;
      const plus = r.all().filter((x) => x.tagName === 'button').find((b) => textOf(b) === '+')!;
      plus.click();
    }
  }
  const blocks: { title?: string; rows: Row[] }[] = [];
  for (const ch of body.children) {
    const h = ch.children[0];
    if (h?.tagName === 'h4') { blocks.push({ title: textOf(h), rows: ch.children.slice(1).map(row).filter((r) => r.cells.length) }); continue; }
    if (ch.children.length && ch.children.every((k) => k.children.length >= 2 && k.children[0]!.tagName === 'div')) {   // полосы
      blocks.push({ rows: ch.children.map(row) }); continue;
    }
    if (ch.html === undefined && ch.children.length > 1 && ch.children[0]!.tagName === 'div' && textOf(ch.children[0]) === 'Активные ауры/стойки') {
      blocks.push({ title: textOf(ch.children[0]), rows: ch.children.slice(1).map(row) }); continue;
    }
    blocks.push({ rows: [row(ch)].filter((r) => r.cells.length) });
  }
  return blocks;
}

/** Мастер → «Атрибуты»: блок деривов (`derivedBlock`) текстом. */
function masterOf(c: Case): string {
  enter(c);
  const panel = masterPanel(app, undefined as never);
  let body = new FakeEl('div');
  panel.render(body as unknown as HTMLElement);
  const tab = body.all().find((e) => e.tagName === 'button' && textOf(e) === 'Атрибуты')!;
  tab.click();
  body = new FakeEl('div');
  panel.render(body as unknown as HTMLElement);
  const d = body.all().find((e) => e.html !== undefined && e.html.includes('Уровень:'))!;
  return textOf(d);
}

/** HUD 3D: полосы (ширина заливки и зон резерва), числа и инфо-строка. */
function hudOf(c: Case): Record<string, unknown> {
  enter(c);
  const mkBar = (id: string): FakeEl => { const track = new FakeEl('div'); const fill = new FakeEl('div'); fill.id = id; track.appendChild(fill); return fill; };
  const hp = mkBar('hp'), mana = mkBar('mana'), stam = mkBar('stam'), xp = mkBar('xp');
  const info = new FakeEl('div'); info.id = 'info';
  const hud = mountHud3d(app);
  hud.update();
  const reserveOf = (fill: FakeEl): string => String(fill.parentElement!.children.find((k) => k !== fill && k.style.right === '0')?.style.width ?? '');
  const textOn = (fill: FakeEl): string => textOf(fill.parentElement!.children.find((k) => k !== fill && k.style.inset === '0') ?? null);
  return {
    hp: String(hp.style.width), mana: String(mana.style.width), stam: String(stam.style.width), xp: String(xp.style.width),
    manaReserve: reserveOf(mana), stamReserve: reserveOf(stam),
    hpText: textOn(hp), manaText: textOn(mana), stamText: textOn(stam), info: textOf(info),
  };
}

/** Таблица «в руках → скую»: строки ячейками; цвет третьей (требование не закрыто) и четвёртой (разница). */
function tableOf(t: FakeEl): { cells: string[]; c3?: string; c4?: string }[] {
  return t.children.map((tr) => {
    const r: { cells: string[]; c3?: string; c4?: string } = { cells: tr.children.map((td) => textOf(td)) };
    const c3 = tr.children[2]?.style.color, c4 = tr.children[3]?.style.color;
    if (c3) r.c3 = String(c3);
    if (c4) r.c4 = String(c4);
    return r;
  });
}

/** Древо скилов героя: узлы (форма, размер, цвета, подсказка), рёбра (цвет, толщина), подписи веток, шапка. */
function treeOf(c: Case): Record<string, unknown> {
  enter(c);
  resetSkillTreeView();
  const body = new FakeEl('div');
  renderSkillTree(app, body as unknown as HTMLElement);
  const nodes = body.all().filter((e) => e.tagName === 'rect' || e.tagName === 'polygon').map((e) => {
    const shape = e.tagName === 'polygon' ? 'diamond' : 'rect';
    let x: number, y: number, size: number;
    if (shape === 'rect') { size = Number(e.attrs.width); x = Number(e.attrs.x) + size / 2; y = Number(e.attrs.y) + size / 2; }
    else { const p = e.attrs.points!.split(' ').map((q) => q.split(',').map(Number)); x = p[0]![0]!; y = p[1]![1]!; size = (p[2]![1]! - p[0]![1]!); }
    return { x, y, shape, size, fill: e.attrs.fill, stroke: e.attrs.stroke, sw: Number(e.attrs['stroke-width']), rx: e.attrs.rx !== undefined ? Number(e.attrs.rx) : undefined, tip: tipOf(e) };
  });
  const edges = body.all().filter((e) => e.tagName === 'line').map((e) => ({
    x1: Number(e.attrs.x1), y1: Number(e.attrs.y1), x2: Number(e.attrs.x2), y2: Number(e.attrs.y2), stroke: e.attrs.stroke, sw: Number(e.attrs['stroke-width']), op: Number(e.attrs['stroke-opacity']),
  }));
  const labels = body.all().filter((e) => e.tagName === 'text').map((e) => ({ x: Number(e.attrs.x), y: Number(e.attrs.y), anchor: e.attrs['text-anchor'], fill: e.attrs.fill, text: textOf(e) }));
  const header = textOf(body.children[0]!);
  return { nodes, edges, labels, header };
}

describe('эталон статов героя для Unity', () => {
  it('строки исходников, повторённые копией, на месте', () => {
    for (const [src, line] of SRC) expect(src.includes(line), line).toBe(true);
  });

  it('пишет __golden__/unity_stats.json', () => {
    const cases = makeCases();
    // ── деривы ──
    const derive = cases.map((c) => {
      const gs = enter(c);
      return {
        derived: gs.derived(), effective: gs.effectiveAttributes(), permanent: gs.permanentAttributes(),
        reserveMana: gs.reservedManaFracProvider(), reserveStamina: gs.reservedStaminaFracProvider(),
      };
    });
    // ── полоса опыта ──
    const xt = bal.xpTable;
    const xp: { level: number; xp: number; table?: number[]; out: ReturnType<typeof xpProgress> }[] = [];
    const tables: (number[] | undefined)[] = [undefined, [0, 0, 100, 100, 300], [0, 0, 50]];
    for (const table of tables) {
      const t = table ?? xt;
      for (const [level, x] of [[1, 0], [1, 50], [2, 0], [2, 97], [2, 300], [3, 424], [3, 10], [5, 2273], [t.length - 2, 1e7], [t.length - 1, 1e9], [t.length + 3, 5], [0, 0]] as [number, number][]) {
        xp.push({ level, xp: x, ...(table ? { table } : {}), out: xpProgress(level, x, t) });
      }
    }
    xp.push({ level: 4, xp: Number.NaN, out: xpProgress(4, Number.NaN, xt) });
    // ── HUD, мастер, лист ──
    const hud = cases.map(hudOf);
    const master = cases.map(masterOf);
    const sheet = cases.map(sheetOf);
    // ── карточки и таблица ковки ──
    const j = fullJournal(reg);
    const looks: { c: number; input: CraftInput; crafted: boolean }[] = [];
    for (const [ci, cls, step] of [[1, 'sword', 3], [1, 'axe', 2], [2, 'staff', 4], [3, 'sword', 1], [4, 'bow', 2], [5, 'crossbow', 5], [0, 'mace', 3]] as [number, string, number][]) {
      for (const hands of familiesOf(reg, cls)) {
        const parts = defaultParts(reg, cls, hands, step);
        if (parts) looks.push({ c: ci, input: { weaponClass: cls, hands, parts, finish: 0 }, crafted: hands === 2 });
      }
    }
    const compare = looks.map(({ c, input, crafted }) => {
      const gs = enter(cases[c]!);
      const pv = craftWeapon(reg, input, { journal: j, materialsOn: true });
      const shown = pv.item;
      if (!shown) return { case: c, input, ok: false };
      const now = gs.save.equipment.weapon;
      const a = cardWith(reg, gs.save, now), b = cardWith(reg, gs.save, shown);
      const edge = (at: 'lo' | 'hi'): ReturnType<typeof cardWith> | undefined => {
        const it = craftWeapon(reg, input, { journal: j, materialsOn: true, at }).item;
        return it ? cardWith(reg, gs.save, it) : undefined;
      };
      const lo = crafted ? undefined : edge('lo'), hi = crafted ? undefined : edge('hi');
      const t = compareTable(a, b, now?.name ?? 'без оружия', shown.name, gs.save, lo && hi ? { lo, hi } : undefined) as unknown as FakeEl;
      return { case: c, input, ok: true, crafted, item: shown, cards: { a, b, ...(lo && hi ? { lo, hi } : {}) }, rows: tableOf(t) };
    });
    // ── верстак: что станет с вещью ──
    const benchItems: Item[] = [];
    let seed = 501;
    for (const base of reg.get('items.base').filter((b) => b.enabled !== false && b.kind !== 'consumable')) {
      for (const at of [0, 0.5, 1]) {
        const it = gen(base.id, (['normal', 'magic', 'rare', 'unique'] as const)[seed % 4]!, at, seed++);
        benchItems.push(it);
        if (seed % 3 === 0) benchItems.push({ ...it, uid: `${it.uid}-b`, broken: true });
        if (seed % 5 === 0) { const old: Item = { ...it, uid: `${it.uid}-t` }; delete old.tier; benchItems.push(old); }
        if (seed % 7 === 0 && it.foundParts) { const old: Item = { ...it, uid: `${it.uid}-p` }; delete old.foundParts; benchItems.push(old); }
      }
    }
    // найденное оружие на КАЖДОЙ ступени окна базы: подъём деталей под ступень (те же варианты — или замена держака и обвязки с сидом вещи)
    for (const base of reg.get('items.base').filter((b) => b.enabled !== false && b.kind === 'weapon')) {
      const { lo, hi } = baseTierRange(reg, base);
      for (let t = lo; t <= hi; t++) {
        for (const r of ['normal', 'magic'] as const) {
          const it = gen(base.id, r, hi > lo ? (t - lo) / (hi - lo) : 0, seed++);
          if (it.foundParts) benchItems.push(it);
        }
      }
    }
    for (const cls of ['sword', 'axe', 'staff']) {
      const parts = defaultParts(reg, cls, familiesOf(reg, cls)[0]!, 2);
      const pv = parts ? craftWeapon(reg, { weaponClass: cls, hands: familiesOf(reg, cls)[0]!, parts }, { rng: createRng(3) }) : null;
      if (pv?.item) benchItems.push({ ...pv.item, uid: `crafted-${cls}` });
    }
    const potion = itemFromBaseId(reg.get('items.base'), 'healing-potion', undefined, 'shop');
    if (potion) benchItems.push({ ...potion, uid: 'potion' });
    const baseLines = (item: Item): string[] => itemDescLines(item).filter((l) => !l.affix).map((l) => l.text);
    const bench = benchItems.map((item) => {
      const target = benchTarget(reg, item);
      const up = upgradedItem(reg, item);
      return {
        item, label: benchTargetLabel(reg, item, target),
        rows: target ? diffStrings(baseLines(item), baseLines(target)) : [],
        target: target ?? null, upgraded: up ?? null,
      };
    });
    // ── древо скилов ──
    const tree = cases.filter((c) => ['warrior-geared', 'mage', 'vyuga-dual', 'zastupnik', 'vorozheya', 'archer-bare'].includes(c.name)).map((c) => ({ case: cases.indexOf(c), ...treeOf(c) }));

    const golden = {
      note: 'Генерит packages/client/src/modules/progression/unityStatsGolden.gen.test.ts — не править руками',
      config: Object.fromEntries(['balance', 'classes', 'items.base', 'item-tiers', 'affixes', 'armor-classes', 'weapon-weights', 'skill-tree', 'mastery-tree',
        'skill-inserts', 'skill-insert-types', 'debuffs', 'phys-subtypes', 'magic-subtypes', 'damage-kinds', 'difficulties', 'weapon-parts', 'weapon-anatomy',
        'weapon-types', 'craft-materials', 'salvage-rules', 'rarities', 'uniques'].map((k) => [k, reg.get(k as never)])),
      cases: cases.map((c) => ({ ...c, save: c.save })),
      derive, xp, hud, master, sheet, compare, bench, tree,
    };
    mkdirSync(join(HERE, '__golden__'), { recursive: true });
    // Рождённое часами (uuidv7 у `newCharacterSave`/`itemFromBaseId`, `createdAt` сейва) — постоянным по порядку появления: эталон не должен
    // меняться от прогона к прогону (правила статов их не читают — StatsCheck это и подтверждает, сверяя на заменённых).
    const uids = new Map<string, string>();
    const stable = (k: string, v: unknown): unknown => {
      if (typeof v === 'number' && !Number.isFinite(v)) return null;
      if (k === 'createdAt' && typeof v === 'number') return 0;
      if (k !== 'uid' || typeof v !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(v)) return v;
      if (!uids.has(v)) uids.set(v, `u-${uids.size}`);
      return uids.get(v);
    };
    writeFileSync(join(HERE, '__golden__', 'unity_stats.json'), `${JSON.stringify(golden, stable, 1)}\n`);
    expect(compare.filter((x) => x.ok).length).toBeGreaterThan(5);
    expect(bench.filter((b) => b.rows.length).length).toBeGreaterThan(20);
    void dom; void CRAFT_SLOT_LIST;
  });
});

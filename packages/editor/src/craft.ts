import {
  ConfigRegistry, newBotSave, xpForLevel, generateItem, generateMonster, createRng, simulateMicroFight,
  craftWeapon, craftMissing, enchantCost, enchantItem, fullJournal, emptyJournal,
  type CraftJournal, type Item, type SaveState, type StatModifier,
} from '@dm/shared';
import type { App } from '@dm/client/core/app.js';
import { craftWindow, cardWith, type CraftHost, type CraftWindowState, initialCraftState } from '@dm/client/modules/town/craftPanel.js';
import { makeHarness } from './gameHarness.js';
import { renderCraftGrid } from './craftGrid.js';
import { renderCraftCatalog } from './craftCatalog.js';
import { weaponPreview3d } from './craftPreview3d.js';

/**
 * Вкладка «🔨 Ковка» — ПРОТОТИП ковки оружия из деталей (docs/CRAFT_WEAPONS.md) на настоящих данных.
 *
 * ⭐ В центре — ИГРОВАЯ панель `craftWindow` (client/modules/town/craftPanel.ts), та же, что встанет
 * в кузницу города. Вокруг неё — песочница: герой, сырьё, журнал и проверки, которых в игре не будет:
 * настоящий бой (`simulateMicroFight`), сравнение с найденными вещами, сетка баланса, каталог.
 * Ядро одно (`@dm/shared` — craft.ts / craftCard.ts), поэтому «врезать в игру» значит сменить
 * хозяина окна, а не переписать логику.
 *
 * ⚠ Скованные вещи живут только здесь, в памяти страницы. Игру вкладка не трогает ни строкой.
 */

export type HeroPreset = 'str' | 'dex' | 'hybrid' | 'int';
const PRESET_NAME: Record<HeroPreset, string> = { str: 'чистая сила', dex: 'чистая ловкость', hybrid: 'гибрид сила+ловк.', int: 'интеллект' };

/** Песочница переживает перерисовку — это состояние вкладки, а не страницы. */
export interface CraftSandbox {
  tab: 'forge' | 'grid' | 'catalog';
  heroClass: string;
  level: number;
  preset: HeroPreset;
  /** Доп. бонусы героя — чтобы проверять ось ДПС в конверте билдов (§4). */
  bonusDmg: number;
  bonusSpd: number;
  infinite: boolean;
  wallet: Record<string, number>;
  gold: number;
  fullJournal: boolean;
  journal: CraftJournal;
  showDisabled: boolean;
  /** Песочные правки данных — предложения ГДД, которых ещё нет в игре. */
  blockLadder: boolean;
  rangedEdge: boolean;
  monsterId: string;
  pack: number;
  win: CraftWindowState | null;
  fight: FightRow[] | null;
  drop: DropCmp | null;
  drops: Item[];
  log: string[];
  seed: number;
}

export const sandbox: CraftSandbox = {
  tab: 'forge', heroClass: '', level: 40, preset: 'hybrid', bonusDmg: 0.45, bonusSpd: 0.15,
  infinite: true, wallet: {}, gold: 5000, fullJournal: true, journal: emptyJournal(), showDisabled: true,
  blockLadder: false, rangedEdge: false, monsterId: '', pack: 3,
  win: null, fight: null, drop: null, drops: [], log: [], seed: 1,
};

export interface FightRow { label: string; dps: number; dpsIn: number; hitsPerSec: number; ttk: number; killRate: number }
export interface DropCmp { n: number; median: number; p83: number; crafted: number; percentile: number; rarity: string }

const h = (tag: string, css: string, html = ''): HTMLElement => { const e = document.createElement(tag); e.style.cssText = css; if (html) e.innerHTML = html; return e; };
const INP = 'padding:4px 7px;background:#0f0f16;color:#e8e8f0;border:1px solid #2c2c3a;border-radius:4px;font-size:12px';
const BTN = 'padding:5px 10px;cursor:pointer;border-radius:5px;border:1px solid #3a3a4c;background:#1c1c26;color:#e8e8f0;font-size:12px';

// Блок по классам — предложение ГДД §7.2 (включается галкой, в игре его нет).
const BLOCK_LADDER: Record<string, number> = { sword: 0.08, spear: 0.06, halberd: 0.05, staff: 0.05, dagger: 0.04, mace: 0.04, axe: 0.03, crossbow: 0.03, wand: 0.03, bow: 0 };

/**
 * Данные песочницы: копия конфига плюс включённые галками правки. Правки живут ТОЛЬКО здесь —
 * чтобы спорное число можно было проверить до того, как оно ляжет в игру.
 */
export function sandboxData(data: Record<string, unknown>, sb: CraftSandbox): Record<string, unknown> {
  const d = structuredClone(data);
  const bases = d['items.base'] as { kind: string; weaponClass?: string; attackType?: string; physSub?: string; baseStats: StatModifier[] }[];
  if (sb.blockLadder) {
    for (const b of bases) {
      if (b.kind !== 'weapon' || !b.weaponClass) continue;
      b.baseStats = b.baseStats.filter((m) => m.stat !== 'blockChance');
      const v = BLOCK_LADDER[b.weaponClass] ?? 0;
      if (v > 0) b.baseStats.push({ stat: 'blockChance', kind: 'flat', value: v } as StatModifier);
    }
  }
  if (sb.rangedEdge) for (const b of bases) if (b.kind === 'weapon' && b.attackType === 'ranged' && !b.physSub && (b.weaponClass === 'bow' || b.weaponClass === 'crossbow')) b.physSub = 'piercing';
  return d;
}

/** Герой песочницы: класс, уровень, очки атрибутов по пресету, бонусы урона/скорости. */
export function sandboxHero(reg: ConfigRegistry, sb: CraftSandbox): SaveState {
  const s = newBotSave(reg, sb.heroClass);
  const bal = reg.get('balance');
  s.level = sb.level;
  s.xp = xpForLevel(sb.level, bal.xpTable);
  const pts = bal.attributePointsPerLevel * Math.max(0, sb.level - 1);
  const split: Record<HeroPreset, [string, number][]> = {
    str: [['strength', 0.7], ['vitality', 0.3]],
    dex: [['dexterity', 0.7], ['vitality', 0.3]],
    hybrid: [['strength', 0.35], ['dexterity', 0.35], ['vitality', 0.3]],
    int: [['intelligence', 0.7], ['vitality', 0.3]],
  };
  const attrs = s.attributes as unknown as Record<string, number>;
  let left = pts;
  for (const [k, share] of split[sb.preset]) { const n = Math.floor(pts * share); attrs[k] = (attrs[k] ?? 0) + n; left -= n; }
  attrs.vitality = (attrs.vitality ?? 0) + left;
  // Бонусы — синтетическим амулетом: ложатся тем же путём, что любая экипировка.
  if (sb.bonusDmg || sb.bonusSpd) {
    s.equipment.amulet = {
      uid: 'sandbox-bonus', baseId: 'sandbox', kind: 'jewelry', name: 'Песочница: бонусы билда', slot: 'amulet',
      rarity: 'normal', itemLevel: 1, requirements: {}, affixes: [], gridW: 1, gridH: 1, pos: null,
      baseStats: [
        { stat: 'damagePct', kind: 'flat', value: sb.bonusDmg },
        { stat: 'attackSpeed', kind: 'increased', value: sb.bonusSpd },
      ] as StatModifier[],
    };
  }
  return s;
}

const INF = 99999;
function infiniteWallet(reg: ConfigRegistry): Record<string, number> {
  return Object.fromEntries(reg.get('craft-materials').map((m) => [m.id, INF]));
}

let harness: App | null = null;
let hkey = '';
let heroSave: SaveState | null = null;

/** Хозяин окна ковки в песочнице: ковка локально ТЕМ ЖЕ ядром, что потом позовёт сервер. */
function sandboxHost(reg: ConfigRegistry, sb: CraftSandbox, save: SaveState): CraftHost {
  const host: CraftHost = {
    wallet: () => (sb.infinite ? infiniteWallet(reg) : sb.wallet),
    gold: () => (sb.infinite ? 9_999_999 : sb.gold),
    journal: () => (sb.fullJournal ? fullJournal(reg) : sb.journal),
    save: () => save,
    allowDisabledMaterials: sb.showDisabled,
    craft: (input) => {
      const pv = craftWeapon(reg, input, { journal: host.journal(), materialsOn: !sb.showDisabled });
      if (!pv.ok || !pv.item || !pv.cost) return { ok: false, reason: pv.reason };
      const lack = craftMissing(host.wallet(), host.gold(), pv.cost);
      const lackIds = Object.keys(lack.materials);
      if (lackIds.length || lack.gold > 0) {
        const name = (id: string): string => reg.get('craft-materials').find((m) => m.id === id)?.name ?? id;
        return { ok: false, reason: `не хватает: ${[...lackIds.map((id) => `${name(id)} ×${lack.materials[id]}`), ...(lack.gold ? [`${lack.gold} золота`] : [])].join(', ')}` };
      }
      if (!sb.infinite) {
        for (const [id, n] of Object.entries(pv.cost.materials)) sb.wallet[id] = (sb.wallet[id] ?? 0) - n;
        sb.gold -= pv.cost.gold;
      }
      // Кодекс: скованный исторический тип отмечается в журнале песочницы.
      if (pv.type?.typeId && !sb.journal.typesForged.includes(pv.type.typeId)) sb.journal.typesForged.push(pv.type.typeId);
      sb.drop = null; sb.fight = null;
      return { ok: true, item: pv.item };
    },
    enchant: (item, rarity) => {
      const cost = enchantCost(reg, item, rarity);
      if (host.gold() < cost) return { ok: false, reason: `не хватает ${cost - host.gold()} золота` };
      if (!sb.infinite) sb.gold -= cost;
      sb.drop = null; sb.fight = null;
      return { ok: true, item: enchantItem(reg, item, rarity, createRng(sb.seed++)) };
    },
    equip: (item) => { save.equipment.weapon = item; sb.fight = null; },
  };
  return host;
}

// ── Настоящий бой ────────────────────────────────────────────────────────────────────────────────

/**
 * ⭐ ЧЕСТНАЯ ПРОВЕРКА: настоящий `GameSession` против пачки монстров полукругом. Считает то, чего
 * закрытая формула не видит: промахи и блоки, статусы и их стаки, сколько целей задевает взмах,
 * ИИ монстра. Бот — `basic`: только базовые удары, чтобы сравнивались ОРУЖИЯ, а не скиллы.
 */
export function fightCheck(reg: ConfigRegistry, save: SaveState, weapon: Item | undefined, monsterId: string, pack: number, runs = 12): Omit<FightRow, 'label'> {
  const s = structuredClone(save);
  if (weapon) s.equipment.weapon = weapon;
  const mons = Array.from({ length: pack }, (_, i) => generateMonster(reg.get('monsters'), reg.get('monster-gear'), reg.get('monster-affixes'), {
    baseId: monsterId, depth: Math.max(0, save.level - 1), mderive: reg.get('monster-derive'), itemAffixes: reg.get('monster-item-affixes'),
    rarities: reg.get('rarities'), rarity: 'normal', monsterRarity: reg.get('monster-rarity'), monsterUniques: reg.get('monster-uniques'),
  }, createRng(i + 1)));
  let dps = 0, dpsIn = 0, hps = 0, ttk = 0, kills = 0;
  for (let r = 0; r < runs; r++) {
    const res = simulateMicroFight(reg, { save: structuredClone(s), monsters: structuredClone(mons), seed: 1000 + r, tier: 'basic', timeCapSec: 40, distancePx: 70 });
    dps += res.dpsOut; dpsIn += res.dpsIn;
    hps += res.timeSec > 0 ? res.perMonster.reduce((a, m) => a + m.hits, 0) / res.timeSec : 0;
    ttk += res.timeSec;
    if (res.killedAll) kills++;
  }
  return { dps: dps / runs, dpsIn: dpsIn / runs, hitsPerSec: hps / runs, ttk: ttk / runs, killRate: kills / runs };
}

/** Где скованная вещь стоит среди 200 найденных той же базы, ступени и редкости — по ДПС формулы. */
function dropCompare(reg: ConfigRegistry, save: SaveState, crafted: Item): DropCmp {
  const tier = reg.get('item-tiers').find((t) => t.id === crafted.tier);
  const rarity = crafted.rarity === 'normal' ? 'rare' : crafted.rarity;
  const rng = createRng(4242);
  const dps: number[] = [];
  for (let i = 0; i < 200; i++) {
    const it = generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'), {
      dropBias: 1, itemLevel: tier?.minItemLevel ?? 1, tierLevel: tier?.minItemLevel ?? 1, baseId: crafted.baseId,
      tiers: reg.get('item-tiers'), rarities: reg.get('rarities'), forceRarity: rarity, maxReqTotal: reg.get('balance').maxTotalRequirement,
    }, rng);
    dps.push(cardWith(reg, save, it).dps);
  }
  dps.sort((a, b) => a - b);
  const c = cardWith(reg, save, crafted).dps;
  const below = dps.filter((x) => x < c).length;
  return { n: dps.length, median: dps[100]!, p83: dps[166]!, crafted: c, percentile: Math.round((100 * below) / dps.length), rarity };
}

// ── Страница ─────────────────────────────────────────────────────────────────────────────────────

export function renderCraftPage(page: HTMLElement, data: Record<string, unknown>): void {
  page.innerHTML = '';
  const sb = sandbox;
  const baseReg = new ConfigRegistry(); baseReg.loadAll(data);
  if (!sb.heroClass || !baseReg.get('classes').some((c) => c.id === sb.heroClass)) sb.heroClass = baseReg.get('classes')[0]?.id ?? '';
  if (!sb.monsterId) sb.monsterId = baseReg.get('monsters')[0]?.id ?? '';

  const sdata = sandboxData(data, sb);
  const key = JSON.stringify([sb.heroClass, sb.level, sb.preset, sb.bonusDmg, sb.bonusSpd, sb.blockLadder, sb.rangedEdge]);
  if (!harness || key !== hkey) {
    const reg0 = new ConfigRegistry(); reg0.loadAll(sdata);
    const keepWeapon = heroSave?.equipment.weapon;
    heroSave = sandboxHero(reg0, sb);
    // Надетое скованное переживает смену пресета — иначе сравнение «в руках» сбрасывалось бы на старт.
    if (keepWeapon && keepWeapon.parts) heroSave.equipment.weapon = keepWeapon;
    harness = makeHarness(sdata, heroSave, () => renderCraftPage(page, data));
    heroSave.gold = sb.gold; // мост раздувает золото — нам нужен кошелёк песочницы
    hkey = key;
    sb.fight = null; sb.drop = null;
  }
  const app = harness;
  const reg = app.config;
  const save = heroSave!;
  if (!sb.win) sb.win = initialCraftState(reg, 'sword');

  const rerender = (): void => renderCraftPage(page, data);

  // ── Шапка и вкладки ──
  const head = h('div', 'display:flex;align-items:baseline;gap:14px;margin-bottom:10px;flex-wrap:wrap');
  head.append(h('h2', 'margin:0;font-size:20px', '🔨 Ковка оружия — прототип'));
  head.append(h('span', 'color:#9aa;font-size:12px', 'Игровая панель на настоящих данных. Скованное живёт только здесь — игру вкладка не трогает. Документ: docs/CRAFT_WEAPONS.md'));
  page.append(head);
  const tabs = h('div', 'display:flex;gap:6px;margin-bottom:12px');
  for (const [id, label] of [['forge', '⚒ Ковка'], ['grid', '▦ Сетка баланса'], ['catalog', '📖 Каталог и разбор']] as const) {
    const b = h('button', `${BTN};${sb.tab === id ? 'border-color:#e39a3c;color:#e39a3c;background:#26221a' : ''}`, label);
    b.addEventListener('click', () => { sb.tab = id; rerender(); });
    tabs.append(b);
  }
  page.append(tabs);

  const cols = h('div', 'display:grid;grid-template-columns:270px minmax(0,1fr);gap:14px;align-items:start');
  page.append(cols);
  cols.append(sandboxPanel(reg, sb, save, rerender));
  const main = h('div', 'min-width:0');
  cols.append(main);

  if (sb.tab === 'grid') { renderCraftGrid(main, reg, sb, save); return; }
  if (sb.tab === 'catalog') { renderCraftCatalog(main, reg, sb, rerender); return; }

  const host = sandboxHost(reg, sb, save);
  const forgeRow = h('div', 'display:grid;grid-template-columns:minmax(0,1fr) 250px;gap:12px;align-items:start');
  const winBox = h('div', 'background:#171b24;border:1px solid #2b323f;border-radius:8px;padding:12px;min-width:0');
  winBox.append(craftWindow(app, host, sb.win, rerender));
  forgeRow.append(winBox);
  // 3D-превью сборки (П6): процедурный меш с параметрами деталей и цветом материала.
  const side = h('div', 'display:flex;flex-direction:column;gap:10px');
  side.append(weaponPreview3d(reg, sb.win));
  forgeRow.append(side);
  main.append(forgeRow);
  main.append(checksPanel(reg, sb, save, rerender));
}

/** Левая колонка: герой, сырьё, журнал, песочные правки. */
function sandboxPanel(reg: ConfigRegistry, sb: CraftSandbox, save: SaveState, rerender: () => void): HTMLElement {
  const box = h('div', 'background:#15151d;border:1px solid #2c2c3a;border-radius:8px;padding:10px;font-size:12px;display:flex;flex-direction:column;gap:10px');
  const sec = (t: string): HTMLElement => { const s = h('div', 'display:flex;flex-direction:column;gap:5px'); s.append(h('div', 'color:#e39a3c;font-weight:600;letter-spacing:.04em', t)); box.append(s); return s; };
  const field = (parent: HTMLElement, label: string, el: HTMLElement): void => {
    const r = h('label', 'display:grid;grid-template-columns:84px minmax(0,1fr);gap:6px;align-items:center'); r.append(h('span', 'color:#9aa', label), el); parent.append(r);
  };
  const check = (parent: HTMLElement, label: string, on: boolean, set: (v: boolean) => void, hint = ''): void => {
    const r = h('label', 'display:flex;gap:6px;align-items:flex-start;cursor:pointer');
    const c = document.createElement('input'); c.type = 'checkbox'; c.checked = on;
    c.addEventListener('change', () => { set(c.checked); rerender(); });
    r.append(c, h('span', '', `${label}${hint ? `<br><span style="color:#777;font-size:11px">${hint}</span>` : ''}`)); parent.append(r);
  };

  const hero = sec('Герой');
  const cls = document.createElement('select'); cls.style.cssText = INP;
  for (const c of reg.get('classes')) { const o = document.createElement('option'); o.value = c.id; o.textContent = c.name; o.selected = c.id === sb.heroClass; cls.append(o); }
  cls.addEventListener('change', () => { sb.heroClass = cls.value; rerender(); });
  field(hero, 'Класс', cls);
  const lvl = document.createElement('input'); lvl.type = 'number'; lvl.min = '1'; lvl.max = '99'; lvl.value = String(sb.level); lvl.style.cssText = INP;
  lvl.addEventListener('change', () => { sb.level = Math.max(1, Math.min(99, Number(lvl.value) || 1)); rerender(); });
  field(hero, 'Уровень', lvl);
  const pr = document.createElement('select'); pr.style.cssText = INP;
  for (const [id, n] of Object.entries(PRESET_NAME)) { const o = document.createElement('option'); o.value = id; o.textContent = n; o.selected = id === sb.preset; pr.append(o); }
  pr.addEventListener('change', () => { sb.preset = pr.value as HeroPreset; rerender(); });
  field(hero, 'Атрибуты', pr);
  const slider = (label: string, val: number, set: (v: number) => void, max: number): void => {
    const wrap = h('div', 'display:flex;gap:6px;align-items:center');
    const s = document.createElement('input'); s.type = 'range'; s.min = '0'; s.max = String(max); s.step = '0.05'; s.value = String(val); s.style.cssText = 'flex:1;min-width:0';
    const v = h('span', 'width:38px;flex:none;text-align:right;font-family:monospace', `+${Math.round(val * 100)}%`);
    s.addEventListener('input', () => { v.textContent = `+${Math.round(Number(s.value) * 100)}%`; });
    s.addEventListener('change', () => { set(Number(s.value)); rerender(); });
    wrap.append(s, v); field(hero, label, wrap);
  };
  slider('Бонус урона', sb.bonusDmg, (v) => { sb.bonusDmg = v; }, 1.5);
  slider('Бонус скорости', sb.bonusSpd, (v) => { sb.bonusSpd = v; }, 0.6);
  const a = save.attributes;
  hero.append(h('div', 'color:#777;font-size:11px', `Сила ${a.strength} · Ловк. ${a.dexterity} · Инт. ${a.intelligence} · Жив. ${a.vitality}<br>В руках: ${save.equipment.weapon?.name ?? '—'}`));

  const res = sec('Сырьё и журнал');
  check(res, 'Сырьё и золото бесконечны', sb.infinite, (v) => { sb.infinite = v; });
  if (!sb.infinite) {
    const n = Object.values(sb.wallet).reduce((s, x) => s + Math.max(0, x), 0);
    res.append(h('div', 'color:#9aa', `В кошельке: ${n} ед. сырья · ${sb.gold} золота`));
    const row = h('div', 'display:flex;gap:6px;flex-wrap:wrap');
    const give = h('button', BTN, '+50 каждого'); give.addEventListener('click', () => { for (const m of reg.get('craft-materials')) sb.wallet[m.id] = (sb.wallet[m.id] ?? 0) + 50; sb.gold += 5000; rerender(); });
    const clr = h('button', BTN, 'Очистить'); clr.addEventListener('click', () => { sb.wallet = {}; sb.gold = 0; rerender(); });
    row.append(give, clr); res.append(row);
  }
  check(res, 'Журнал: всё открыто', sb.fullJournal, (v) => { sb.fullJournal = v; }, 'выключи — и открывать типы и детали придётся разбором (вкладка «Каталог»)');
  check(res, 'Материалы, которых ещё нет в игре', sb.showDisabled, (v) => { sb.showDisabled = v; }, 'ступени 4–5 и семьи stave/trim/focus выключены в конфиге до разбора по тиру (§10.9)');

  const ov = sec('Песочные правки данных');
  check(ov, 'Лестница блока по классам', sb.blockLadder, (v) => { sb.blockLadder = v; }, 'предложение §7.2: блок у всех ближних баз. В игре его нет — сегодня блок у 6 баз из 50');
  check(ov, 'Грань «колющий» стрелковому', sb.rangedEdge, (v) => { sb.rangedEdge = v; }, 'у луков и арбалетов нет грани, и укусу оголовья нечем торговать (§7.1)');
  return box;
}

/** Под окном: настоящий бой и сравнение с найденными. */
function checksPanel(reg: ConfigRegistry, sb: CraftSandbox, save: SaveState, rerender: () => void): HTMLElement {
  const box = h('div', 'margin-top:12px;display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px');
  const card = (title: string): HTMLElement => { const c = h('div', 'background:#15151d;border:1px solid #2c2c3a;border-radius:8px;padding:10px;font-size:12px'); c.append(h('div', 'color:#e39a3c;font-weight:600;margin-bottom:6px', title)); box.append(c); return c; };
  const crafted = sb.win?.crafted ?? null;

  // ⚔ Бой
  const fight = card('⚔ Настоящий бой — GameSession против пачки');
  const row = h('div', 'display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:6px');
  const mon = document.createElement('select'); mon.style.cssText = INP;
  for (const m of reg.get('monsters')) { const o = document.createElement('option'); o.value = m.id; o.textContent = m.name; o.selected = m.id === sb.monsterId; mon.append(o); }
  mon.addEventListener('change', () => { sb.monsterId = mon.value; sb.fight = null; rerender(); });
  const pk = document.createElement('select'); pk.style.cssText = INP;
  for (const n of [1, 3, 5]) { const o = document.createElement('option'); o.value = String(n); o.textContent = `×${n}`; o.selected = n === sb.pack; pk.append(o); }
  pk.addEventListener('change', () => { sb.pack = Number(pk.value); sb.fight = null; rerender(); });
  const go = h('button', `${BTN};border-color:#e39a3c`, crafted ? 'Проверить: в руках против скованного' : 'Скуй вещь, чтобы сравнить');
  (go as HTMLButtonElement).disabled = !crafted;
  go.addEventListener('click', () => {
    go.textContent = 'считаю…';
    setTimeout(() => {
      const now = save.equipment.weapon;
      sb.fight = [
        { label: now?.name ?? 'без оружия', ...fightCheck(reg, save, now, sb.monsterId, sb.pack) },
        { label: crafted!.name, ...fightCheck(reg, save, crafted!, sb.monsterId, sb.pack) },
      ];
      rerender();
    }, 20);
  });
  row.append(mon, pk, go);
  fight.append(row);
  if (sb.fight) {
    const t = h('table', 'width:100%;border-collapse:collapse;font-family:monospace;font-size:12px');
    t.innerHTML = `<tr style="color:#888"><td></td><td style="text-align:right">ДПС</td><td style="text-align:right">попаданий/с</td><td style="text-align:right">бой, с</td><td style="text-align:right">вход. урон/с</td></tr>` +
      sb.fight.map((f, i) => `<tr style="color:${i ? '#e39a3c' : '#ddd'}"><td style="font-family:sans-serif;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${f.label}</td><td style="text-align:right">${f.dps.toFixed(1)}</td><td style="text-align:right">${f.hitsPerSec.toFixed(2)}</td><td style="text-align:right">${f.ttk.toFixed(1)}</td><td style="text-align:right">${f.dpsIn.toFixed(1)}</td></tr>`).join('');
    fight.append(t);
    const [a, b] = sb.fight;
    if (a && b && a.dps > 0) fight.append(h('div', `margin-top:6px;color:${Math.abs(b.dps / a.dps - 1) <= 0.08 ? '#8aa84a' : '#e39a3c'}`, `ДПС в бою: ${b.dps >= a.dps ? '+' : ''}${((b.dps / a.dps - 1) * 100).toFixed(1)} % · попаданий: ${b.hitsPerSec >= a.hitsPerSec ? '+' : ''}${((b.hitsPerSec / Math.max(1e-9, a.hitsPerSec) - 1) * 100).toFixed(1)} %`));
    fight.append(h('div', 'color:#777;font-size:11px;margin-top:4px', '12 прогонов, бот только базовыми ударами — сравниваются оружия, а не скиллы. Статусы, промахи, блоки и число задетых целей учтены.'));
  }

  // 📊 Против дропа
  const drop = card('📊 Против найденных — 200 вещей той же базы и ступени');
  const b2 = h('button', BTN, crafted ? 'Сравнить' : 'Скуй вещь, чтобы сравнить');
  (b2 as HTMLButtonElement).disabled = !crafted;
  b2.addEventListener('click', () => { b2.textContent = 'считаю…'; setTimeout(() => { sb.drop = dropCompare(reg, save, crafted!); rerender(); }, 20); });
  drop.append(b2);
  if (sb.drop) {
    const d = sb.drop;
    drop.append(h('div', 'margin-top:6px;line-height:1.6', `Найденных ${d.rarity === 'rare' ? 'редких' : 'магических'}: ${d.n}. ДПС: медиана <b>${d.median.toFixed(1)}</b>, верхние 17 % — от <b>${d.p83.toFixed(1)}</b>.<br>Скованная: <b style="color:#e39a3c">${d.crafted.toFixed(1)}</b> → <b>${d.percentile}-й перцентиль</b>.`));
    if (crafted?.rarity === 'normal') drop.append(h('div', 'color:#dca94b;font-size:11px;margin-top:4px', '⚠ Скованная ещё обычная — сравнение нечестное: зачаруй её до редкого.'));
    else drop.append(h('div', `font-size:11px;margin-top:4px;color:${d.percentile <= 95 ? '#8aa84a' : '#c85a48'}`, d.percentile <= 95 ? 'Правило Р1 держится: скованная не выше лучшего дропа.' : '⚠ Скованная выше почти всего дропа — проверь, не нарушено ли Р1.'));
  }
  return box;
}

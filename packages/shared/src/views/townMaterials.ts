/**
 * ⭐ ВИД «СЫРЬЁ» — вкладка «Ресурсы» сундука, полоса сырья под верстаком кузницы и подсказка стопки сырья в сумке, СЕРВЕРОМ.
 *
 * Заменяет C# `DmTown.BuildMaterialsView` / `DmTown.MaterialNote` (Assets/DM/UI/DmTownSalvage.cs) — их Unity считала сама по своему порту.
 * Источник — веб `client/modules/inventory/materialsModel.ts` (`materialsModel`, `materialNote`) + подписи вкладки `stashPanel.ts`; здесь
 * та же модель целиком на функциях @dm/shared (`carriedMaterials`, `craftTiers`, `gradeRoman`), без своей формулы.
 *
 * Выход — JSON с ключами ровно публичных полей C# `DmTown.MaterialsView` / `MatHead` / `MatRow` / `MatCell` (Newtonsoft, умолчания).
 */
import type { ConfigRegistry } from '../config/registry.js';
import type { Item } from '../types/index.js';
import { carriedMaterials } from '../economy/materials.js';
import { gradeRoman } from '../economy/salvagePreview.js';
import { craftTiers, MATERIAL_STEPS } from '../formulas/craft.js';
import { CRAFT_SLOT_LIST } from '../formulas/craftType.js';
import { ESSENCE_FAMILY, ESSENCE_ID } from '../formulas/salvage.js';
import { cfgRowText, tr } from '../i18n/tr.js';

/** Металлическая шкала сортов I–V: от тёмной стали к светлому серебру. V — полужирным. */
export const GRADE_HEX: readonly string[] = ['#6f767d', '#8f979f', '#b0b8bf', '#d2d8dd', '#f1f4f6'];
/** Цвет эссенции — сиреневый, которого нет ни у одной редкости. */
export const ESSENCE_HEX = '#a58bdc';
/** Строка-правило под складом и верстаком. */
export const SALVAGE_RULE = 'Разбор: сырьё — по ступени вещи, эссенция — по редкости, детали — в каталог (у кузнеца)';
/** Имя семьи для игрока: в конфиге у неё только id. */
export const FAMILY_LABEL: Readonly<Record<string, string>> = {
  get iron() { return tr('srv:family.iron', 'Железо'); },
  get wood() { return tr('srv:family.wood', 'Дерево'); },
  get cloth() { return tr('srv:family.cloth', 'Ткань'); },
  get hide() { return tr('srv:family.hide', 'Кожа'); },
  get plate() { return tr('srv:family.plate', 'Пластины'); },
  get trim() { return tr('srv:family.trim', 'Прибор'); },
};

/** Имя семьи (`FAMILY_LABEL`, нет — id). */
export const familyLabel = (family: string): string => FAMILY_LABEL[family] ?? family;
/** Цвет сорта 1..5 (за краями — ближний край шкалы). */
export function gradeHex(grade: number): string {
  return GRADE_HEX[Math.max(1, Math.min(GRADE_HEX.length, Math.floor(grade))) - 1]!;
}
/** «I сорт» … «V сорт». */
export const gradeLabel = (grade: number): string => tr('srv:materials.grade', '{grade} сорт', { grade: gradeRoman(grade) });

/** С каких ступеней вещей идёт сорт — по рецепту разбора (`balance.salvage.recipeByTier`); выключенные ступени не называем. */
export function gradeSources(reg: ConfigRegistry, grade: number): { name: string; strikeOnly: boolean }[] {
  const rows = reg.get('balance').salvage.recipeByTier;
  const out: { name: string; strikeOnly: boolean }[] = [];
  for (const [i, t] of craftTiers(reg).entries()) {
    if (t.enabled === false) continue;
    const row = rows[Math.min(i, rows.length - 1)] ?? [];
    const rest = row.slice(1).includes(grade);
    if (rest || row[0] === grade) out.push({ name: cfgRowText(reg, 'item-tiers', t) || t.id, strikeOnly: !rest });
  }
  return out;
}

/** Подпись под столбцом: «Убогий, Старый · тела монстров», «Старый (боевая часть), Крепкий». */
export function gradeSourceText(reg: ConfigRegistry, grade: number): string {
  const tiers = gradeSources(reg, grade).map((s) => (s.strikeOnly ? tr('srv:materials.strikeOnly', '{name} (боевая часть)', { name: s.name }) : s.name)).join(', ');
  return grade === 1 ? (tiers ? tr('srv:materials.gradeSourcesMonsters', '{tiers} · тела монстров', { tiers }) : tr('srv:materials.monsters', 'тела монстров')) : tiers || '—';
}

/** Семьи сырья, которые тратит ковка: семья гнезда анатомии и своя семья детали. */
export function forgeFamilies(reg: ConfigRegistry): Set<string> {
  const out = new Set<string>();
  for (const a of reg.get('weapon-anatomy')) {
    if (a.enabled === false) continue;
    for (const slot of CRAFT_SLOT_LIST) if (a[slot]?.family) out.add(a[slot].family);
  }
  for (const p of reg.get('weapon-parts')) if (p.enabled !== false && p.family) out.add(p.family);
  return out;
}

/**
 * C# `DmTown.MatCell`. ⭐ i18n (07.11, хвосты Ф1): `tipBag` — номер строки «В сумке N — часть потеряешь при смерти» в `tip` (−1 — её нет):
 * окно сундука красило её зелёным по началу «В сумке » (`StashPanel.TipText`), а на другом языке начало другое.
 */
export interface MatCell { id: string; name: string; grade: number; stash: number; hand: number; have: boolean; color: string; bold: boolean; tip: string[]; tipBag: number }
/** C# `DmTown.MatHead`. */
export interface MatHead { grade: number; label: string; sub: string; color: string; bold: boolean }
/** C# `DmTown.MatRow`: клетка `null` — такого сорта у семьи нет (выключен): столбцы не съезжают. */
export interface MatRow { family: string; label: string; cells: (MatCell | null)[] }
/** C# `DmTown.MaterialsView` — вкладка «Ресурсы» целиком (модель склада + подписи вкладки). */
export interface MaterialsView {
  tab: string;
  deposit: string;
  rule: string;
  /** Сырья в сумке всего (кнопка «Сдать всё сырьё» гаснет на нуле). */
  carried: number;
  heads: MatHead[];
  rows: MatRow[];
  essence: MatCell | null;
}

type MatDef = { id: string; name: string; family: string; tier: number; sellPrice: number };

/** Строки подсказки и номер строки «В сумке …» в них (`MatCell.tipBag`; −1 — нет). */
interface CellTip { lines: string[]; bag: number }

/** `holdings` — строки «В сундуке / В сумке» (подсказке стопки в сумке они не нужны: `materialNote`). */
function cellTip(reg: ConfigRegistry, d: MatDef, stash: number, hand: number, forge: boolean, holdings = true): CellTip {
  const s = reg.get('balance').salvage;
  const g = d.tier;
  const src = gradeSources(reg, g).map((x) => (x.strikeOnly ? tr('srv:materials.strikeOnlyQuoted', '«{name}» (боевая часть)', { name: x.name }) : `«${x.name}»`)).join(', ');
  const found = g > s.nonFindMaxGrade ? tr('srv:materials.foundWord', 'найденных ') : '';
  const lines = [
    cfgRowText(reg, 'craft-materials', d),
    `${familyLabel(d.family)} · ${gradeLabel(g)}`,
    tr('srv:materials.from', 'Откуда: {from}{monsters}', { from: src ? tr('srv:materials.fromSalvage', 'разбор {found}вещей {src}', { found, src }) : tr('srv:materials.fromNone', 'разбор его не даёт'), monsters: g === 1 ? tr('srv:materials.fromMonsters', '; тела монстров') : '' }),
  ];
  if (g > s.nonFindMaxGrade) lines.push(tr('srv:materials.nonFindCap', 'Купленные вещи и вещи прежней версии дают не выше {nonFindMaxGrade} сорта', { nonFindMaxGrade: gradeRoman(s.nonFindMaxGrade) }));
  const tiers = gradeSources(reg, g).map((x) => `«${x.name}»`).join(', ');
  lines.push(tr('srv:materials.to', 'Куда: {to}{tiers}', { to: forge ? tr('srv:materials.toForge', 'ковка, подъём и починка') : tr('srv:materials.toUpgrade', 'подъём и починка (ковкой не используется)'), tiers: tiers ? tr('srv:materials.toTiers', ' — ступени {tiers}', { tiers }) : '' }));
  if (g === 1) lines.push(tr('srv:materials.gradeOneUse', 'Расходник любого подъёма и починки'));
  if (holdings) lines.push(tr('srv:materials.inStash', 'В сундуке {stash}', { stash }));
  let bag = -1;
  if (holdings && hand > 0) { bag = lines.length; lines.push(tr('srv:materials.inBag', 'В сумке {hand} — часть потеряешь при смерти', { hand })); }
  lines.push(saleLine(d.sellPrice));
  return { lines, bag };
}

function essenceAbout(reg: ConfigRegistry): string[] {
  const s = reg.get('balance').salvage;
  const e = s.essence as Record<string, number>;
  return [
    tr('srv:materials.essenceFrom', 'Откуда: разбор у кузнеца найденных вещей и наград — магическая {magic}, редкая {rare}; в поле — {field} %', { magic: e.magic ?? 0, rare: e.rare ?? 0, field: Math.round(s.fieldYield * 100) }),
    tr('srv:materials.essenceNone', 'Купленное, стартовое, вещи прежней версии и переплавка эссенции не дают'),
    tr('srv:materials.essenceTo', 'Куда: зачарование скованной вещи и перекатка свойств'),
  ];
}

const saleLine = (price: number): string => (price > 0 ? tr('srv:materials.sale', 'Продажа: {price} за штуку', { price }) : tr('srv:materials.noSale', 'Не продаётся'));

function essenceTip(reg: ConfigRegistry, d: { name: string; sellPrice: number }, stash: number, hand: number): CellTip {
  const lines = [cfgRowText(reg, 'craft-materials', d), tr('srv:materials.essenceKind', 'Не сырьё — валюта чар'), ...essenceAbout(reg), tr('srv:materials.inStash', 'В сундуке {stash}', { stash })];
  let bag = -1;
  if (hand > 0) { bag = lines.length; lines.push(tr('srv:materials.inBag', 'В сумке {hand} — часть потеряешь при смерти', { hand })); }
  lines.push(saleLine(d.sellPrice));
  return { lines, bag };
}

/**
 * ⭐ ВКЛАДКА «РЕСУРСЫ» (`materialsModel` + подписи вкладки): строка — семья, столбец — сорт I–V, эссенция — плашкой. Все включённые
 * материалы конфига. `stashWallet` — кошелёк сундука аккаунта (`AccountStash.materials`), `inventory` — сумка героя.
 * Заменяет C# `DmTown.BuildMaterialsView` (StashPanel.cs, ForgePanel.MaterialsStrip).
 */
export function materialsView(reg: ConfigRegistry, stashWallet: Record<string, number> | null | undefined, inventory: readonly Item[]): MaterialsView {
  const wallet = stashWallet ?? {};
  const carriedMap = carriedMaterials(inventory);
  const carried = Object.values(carriedMap).reduce((x, y) => x + y, 0);
  const all = reg.get('craft-materials').filter((d) => d.enabled);
  const defs = all.filter((d) => d.family !== ESSENCE_FAMILY);
  const forge = forgeFamilies(reg);
  const families: string[] = [];
  for (const d of defs) if (!families.includes(d.family)) families.push(d.family);
  const steps = Math.min(MATERIAL_STEPS, Math.max(0, ...defs.map((d) => d.tier)));
  const grades = Array.from({ length: steps }, (_, i) => i + 1);
  const cell = (d: (typeof defs)[number]): MatCell => {
    const stash = Math.max(0, wallet[d.id] ?? 0);
    const hand = carriedMap[d.id] ?? 0;
    const tip = cellTip(reg, d, stash, hand, forge.has(d.family));
    return {
      id: d.id, name: cfgRowText(reg, 'craft-materials', d), grade: d.tier, stash, hand, have: stash + hand > 0, color: gradeHex(d.tier), bold: d.tier >= MATERIAL_STEPS,
      tip: tip.lines, tipBag: tip.bag,
    };
  };
  const ess = all.find((d) => d.id === ESSENCE_ID);
  return {
    tab: carried > 0 ? tr('srv:materials.title', 'Ресурсы (+{carried})', { carried }) : tr('srv:materials.titleEmpty', 'Ресурсы'),
    deposit: carried > 0 ? tr('srv:materials.depositAll', 'Сдать всё сырьё ({carried})', { carried }) : tr('srv:materials.depositNone', 'В сумке сырья нет'),
    rule: tr('srv:materials.salvageRule', SALVAGE_RULE),
    carried,
    heads: grades.map((g) => ({ grade: g, label: gradeLabel(g), sub: gradeSourceText(reg, g), color: gradeHex(g), bold: g >= MATERIAL_STEPS })),
    rows: families.map((fam) => ({
      family: fam,
      label: familyLabel(fam),
      cells: grades.map((g) => { const d = defs.find((x) => x.family === fam && x.tier === g); return d ? cell(d) : null; }),
    })),
    essence: ess ? (() => {
      const stash = Math.max(0, wallet[ess.id] ?? 0);
      const hand = carriedMap[ess.id] ?? 0;
      const tip = essenceTip(reg, ess, stash, hand);
      return { id: ess.id, name: cfgRowText(reg, 'craft-materials', ess), grade: ess.tier, stash, hand, have: stash + hand > 0, color: ESSENCE_HEX, bold: false, tip: tip.lines, tipBag: tip.bag };
    })() : null,
  };
}

/** Подсказка стопки сырья в сумке (C# `DmTown.MaterialNote`): цвет сорта (эссенция — сиреневый) и строки; не сырьё — `null`. */
export interface MaterialNote { color: string; lines: string[] }
export function materialNote(reg: ConfigRegistry, item: Pick<Item, 'kind' | 'materialId'>): MaterialNote | null {
  if (item.kind !== 'material' || !item.materialId) return null;
  const d = reg.get('craft-materials').find((m) => m.id === item.materialId);
  if (!d) return null;
  if (d.family === ESSENCE_FAMILY) return { color: ESSENCE_HEX, lines: [...essenceAbout(reg), saleLine(d.sellPrice)] };
  // ⭐ i18n Ф2 (ревизия 06.11): строки «В сундуке / В сумке» не собираются вовсе (`holdings: false`), а не вырезаются по русскому началу —
  // на переводе фильтр по тексту их бы пропустил
  const tip = cellTip(reg, d, 0, 0, forgeFamilies(reg).has(d.family), false).lines;
  return { color: gradeHex(d.tier), lines: tip.slice(1) };
}

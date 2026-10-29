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

/** Металлическая шкала сортов I–V: от тёмной стали к светлому серебру. V — полужирным. */
export const GRADE_HEX: readonly string[] = ['#6f767d', '#8f979f', '#b0b8bf', '#d2d8dd', '#f1f4f6'];
/** Цвет эссенции — сиреневый, которого нет ни у одной редкости. */
export const ESSENCE_HEX = '#a58bdc';
/** Строка-правило под складом и верстаком. */
export const SALVAGE_RULE = 'Разбор: сырьё — по ступени вещи, эссенция — по редкости, детали — в каталог (у кузнеца)';
/** Имя семьи для игрока: в конфиге у неё только id. */
export const FAMILY_LABEL: Readonly<Record<string, string>> = {
  iron: 'Железо', wood: 'Дерево', cloth: 'Ткань', hide: 'Кожа', plate: 'Пластины', trim: 'Прибор',
};

/** Имя семьи (`FAMILY_LABEL`, нет — id). */
export const familyLabel = (family: string): string => FAMILY_LABEL[family] ?? family;
/** Цвет сорта 1..5 (за краями — ближний край шкалы). */
export function gradeHex(grade: number): string {
  return GRADE_HEX[Math.max(1, Math.min(GRADE_HEX.length, Math.floor(grade))) - 1]!;
}
/** «I сорт» … «V сорт». */
export const gradeLabel = (grade: number): string => `${gradeRoman(grade)} сорт`;

/** С каких ступеней вещей идёт сорт — по рецепту разбора (`balance.salvage.recipeByTier`); выключенные ступени не называем. */
export function gradeSources(reg: ConfigRegistry, grade: number): { name: string; strikeOnly: boolean }[] {
  const rows = reg.get('balance').salvage.recipeByTier;
  const out: { name: string; strikeOnly: boolean }[] = [];
  for (const [i, t] of craftTiers(reg).entries()) {
    if (t.enabled === false) continue;
    const row = rows[Math.min(i, rows.length - 1)] ?? [];
    const rest = row.slice(1).includes(grade);
    if (rest || row[0] === grade) out.push({ name: t.name || t.id, strikeOnly: !rest });
  }
  return out;
}

/** Подпись под столбцом: «Убогий, Старый · тела монстров», «Старый (боевая часть), Крепкий». */
export function gradeSourceText(reg: ConfigRegistry, grade: number): string {
  const tiers = gradeSources(reg, grade).map((s) => (s.strikeOnly ? `${s.name} (боевая часть)` : s.name)).join(', ');
  return grade === 1 ? (tiers ? `${tiers} · тела монстров` : 'тела монстров') : tiers || '—';
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

/** C# `DmTown.MatCell`. */
export interface MatCell { id: string; name: string; grade: number; stash: number; hand: number; have: boolean; color: string; bold: boolean; tip: string[] }
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

function cellTip(reg: ConfigRegistry, d: MatDef, stash: number, hand: number, forge: boolean): string[] {
  const s = reg.get('balance').salvage;
  const g = d.tier;
  const src = gradeSources(reg, g).map((x) => (x.strikeOnly ? `«${x.name}» (боевая часть)` : `«${x.name}»`)).join(', ');
  const found = g > s.nonFindMaxGrade ? 'найденных ' : '';
  const lines = [
    d.name,
    `${familyLabel(d.family)} · ${gradeLabel(g)}`,
    `Откуда: ${src ? `разбор ${found}вещей ${src}` : 'разбор его не даёт'}${g === 1 ? '; тела монстров' : ''}`,
  ];
  if (g > s.nonFindMaxGrade) lines.push(`Купленные вещи и вещи прежней версии дают не выше ${gradeRoman(s.nonFindMaxGrade)} сорта`);
  const tiers = gradeSources(reg, g).map((x) => `«${x.name}»`).join(', ');
  lines.push(`Куда: ${forge ? 'ковка, подъём и починка' : 'подъём и починка (ковкой не используется)'}${tiers ? ` — ступени ${tiers}` : ''}`);
  if (g === 1) lines.push('Расходник любого подъёма и починки');
  lines.push(`В сундуке ${stash}`);
  if (hand > 0) lines.push(`В сумке ${hand} — часть потеряешь при смерти`);
  lines.push(saleLine(d.sellPrice));
  return lines;
}

function essenceAbout(reg: ConfigRegistry): string[] {
  const s = reg.get('balance').salvage;
  const e = s.essence as Record<string, number>;
  return [
    `Откуда: разбор у кузнеца найденных вещей и наград — магическая ${e.magic ?? 0}, редкая ${e.rare ?? 0}; в поле — ${Math.round(s.fieldYield * 100)} %`,
    'Купленное, стартовое, вещи прежней версии и переплавка эссенции не дают',
    'Куда: зачарование скованной вещи и перекатка свойств',
  ];
}

const saleLine = (price: number): string => (price > 0 ? `Продажа: ${price} за штуку` : 'Не продаётся');

function essenceTip(reg: ConfigRegistry, d: { name: string; sellPrice: number }, stash: number, hand: number): string[] {
  const lines = [d.name, 'Не сырьё — валюта чар', ...essenceAbout(reg), `В сундуке ${stash}`];
  if (hand > 0) lines.push(`В сумке ${hand} — часть потеряешь при смерти`);
  lines.push(saleLine(d.sellPrice));
  return lines;
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
    return {
      id: d.id, name: d.name, grade: d.tier, stash, hand, have: stash + hand > 0, color: gradeHex(d.tier), bold: d.tier >= MATERIAL_STEPS,
      tip: cellTip(reg, d, stash, hand, forge.has(d.family)),
    };
  };
  const ess = all.find((d) => d.id === ESSENCE_ID);
  return {
    tab: carried > 0 ? `Ресурсы (+${carried})` : 'Ресурсы',
    deposit: carried > 0 ? `Сдать всё сырьё (${carried})` : 'В сумке сырья нет',
    rule: SALVAGE_RULE,
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
      return { id: ess.id, name: ess.name, grade: ess.tier, stash, hand, have: stash + hand > 0, color: ESSENCE_HEX, bold: false, tip: essenceTip(reg, ess, stash, hand) };
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
  const tip = cellTip(reg, d, 0, 0, forgeFamilies(reg).has(d.family));
  return { color: gradeHex(d.tier), lines: tip.filter((l, i) => i > 0 && !/^В (сундуке|сумке) /.test(l)) };
}

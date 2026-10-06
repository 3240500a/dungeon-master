import {
  CRAFT_SLOT_LIST, ESSENCE_FAMILY, ESSENCE_ID, MATERIAL_STEPS, carriedMaterials, craftTiers, gradeRoman,
  type ConfigRegistry, type Item,
} from '@dm/shared';

/**
 * ⭐ СКЛАД СЫРЬЯ — ЧИСТАЯ МОДЕЛЬ без единой строки DOM (предложение «Разбор, сырьё и чары» §15.1). Вкладка «Ресурсы» сундука
 * (`materialsView.ts`), полоса сырья верстака кузницы (`forgeBench.ts`) и подсказка стопки сырья в сумке рисуют ЭТО; Unity повторяет
 * то же по эталону `unity_panels.json` (раздел `materials`, генератор `unityPanelsGolden.gen.test.ts` зовёт эту функцию, а не копию).
 *
 * Раскладка: строка — семья (из чего вещь), столбец — СОРТ I–V. Сорт = ступень вещи, с которой сырьё пришло, по рецепту разбора
 * (`balance.salvage.recipeByTier`): Убогая вещь даёт I, Мифическая — V; редкость на сорт не влияет — она даёт эссенцию. Поэтому:
 * - подписи столбцов — «I сорт … V сорт», а под ними мелко — С КАКИХ ВЕЩЕЙ сорт идёт, выведенные из того же рецепта (правка рецепта в
 *   редакторе меняет и подпись — разойтись они не могут);
 * - цвета — одноцветная металлическая шкала: ни цветов редкостей (иначе «жёлтая вещь → жёлтое сырьё»), ни меди, ни красного
 *   (красный читается как «не хватает»);
 * - ЭССЕНЦИЯ — отдельной плашкой под сеткой, не строкой в ней: в сетке её прочли бы как сырьё I сорта.
 * ⚠ Было: столбцы «обычные / магические / редкие / ступень 4 / ступень 5» в цветах редкостей — игрок читал их как «редкость вещи → сорт».
 */

/** Металлическая шкала сортов I–V: от тёмной стали к светлому серебру. V — полужирным. */
export const GRADE_HEX: readonly string[] = ['#6f767d', '#8f979f', '#b0b8bf', '#d2d8dd', '#f1f4f6'];
/** Цвет эссенции — сиреневый, которого нет ни у одной редкости. */
export const ESSENCE_HEX = '#a58bdc';
/** Строка-правило под складом и верстаком: откуда что берётся при разборе. */
export const SALVAGE_RULE = 'Разбор: сырьё — по ступени вещи, эссенция — по редкости, детали — в каталог (у кузнеца)';

/** Человеческое имя семьи: в конфиге у неё только id. */
export const FAMILY_LABEL: Record<string, string> = {
  iron: 'Железо',
  wood: 'Дерево',
  cloth: 'Ткань',
  hide: 'Кожа',
  plate: 'Пластины',
  stave: 'Плечи',
  trim: 'Прибор',
  focus: 'Фокус',
};

/** Цвет сорта 1..5 (за краями — ближний край шкалы). */
export function gradeHex(grade: number): string {
  return GRADE_HEX[Math.max(1, Math.min(GRADE_HEX.length, Math.floor(grade))) - 1]!;
}

/** «I сорт» … «V сорт». */
export const gradeLabel = (grade: number): string => `${gradeRoman(grade)} сорт`;

/**
 * С КАКИХ СТУПЕНЕЙ ВЕЩЕЙ ИДЁТ СОРТ — по рецепту разбора. Ступень — во всю вещь (сорт стоит в держаке, обвязке или оголовье: его даёт и
 * броня — у неё нижний сорт строки) или только «боевой частью» (сорт стоит лишь в ударной части оружия: t1 — II, t4 — IV).
 * Выключенные ступени не называем: таких вещей в игре не родится.
 */
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
  // Тела монстров дают только I сорт (§10) — у первого столбца это второй источник.
  return grade === 1 ? (tiers ? `${tiers} · тела монстров` : 'тела монстров') : tiers || '—';
}

/** Семьи сырья, которые тратит ковка: семья гнезда анатомии и своя семья детали (`partFamily`). Остальное идёт только в подъём и починку. */
export function forgeFamilies(reg: ConfigRegistry): Set<string> {
  const out = new Set<string>();
  for (const a of reg.get('weapon-anatomy')) {
    if (a.enabled === false) continue;
    for (const slot of CRAFT_SLOT_LIST) if (a[slot]?.family) out.add(a[slot].family);
  }
  for (const p of reg.get('weapon-parts')) if (p.enabled !== false && p.family) out.add(p.family);
  return out;
}

/** Клетка склада: материал сорта, сколько в сундуке и в сумке, цвет и подсказка строками (первая — заголовок). */
export interface MaterialCell {
  id: string;
  name: string;
  grade: number;
  stash: number;
  hand: number;
  have: boolean;
  color: string;
  bold: boolean;
  tip: string[];
}
export interface MaterialsModel {
  /** Столбцы — сорта: подпись, «с каких вещей», цвет. */
  heads: { grade: number; label: string; sub: string; color: string; bold: boolean }[];
  /** Строки — семьи; клетка `null` — такого сорта у семьи нет (выключен в редакторе): столбцы не съезжают. */
  rows: { family: string; label: string; cells: (MaterialCell | null)[] }[];
  /** Плашка эссенции под сеткой; нет в конфиге (выключена) — `null`. */
  essence: MaterialCell | null;
  /** Строка-правило склада. */
  rule: string;
}

/**
 * ⭐ ПОДСКАЗКА СЫРЬЯ — строками: имя, «семья · сорт», откуда, (для сортов выше потолка не-находок — чьи вещи его не дают), куда, сколько
 * где лежит, цена продажи. Та же для клетки склада и для стопки в сумке (`materialNote`).
 */
function cellTip(reg: ConfigRegistry, d: { id: string; name: string; family: string; tier: number; sellPrice: number }, stash: number, hand: number, forge: boolean): string[] {
  const s = reg.get('balance').salvage;
  const g = d.tier;
  const src = gradeSources(reg, g).map((x) => (x.strikeOnly ? `«${x.name}» (боевая часть)` : `«${x.name}»`)).join(', ');
  const found = g > s.nonFindMaxGrade ? 'найденных ' : '';
  const lines = [
    d.name,
    `${FAMILY_LABEL[d.family] ?? d.family} · ${gradeLabel(g)}`,
    `Откуда: ${src ? `разбор ${found}вещей ${src}` : 'разбор его не даёт'}${g === 1 ? '; тела монстров' : ''}`,
  ];
  if (g > s.nonFindMaxGrade) lines.push(`Купленные вещи и вещи прежней версии дают не выше ${gradeRoman(s.nonFindMaxGrade)} сорта`);
  const tiers = gradeSources(reg, g).map((x) => `«${x.name}»`).join(', ');
  lines.push(`Куда: ${forge ? 'ковка, подъём и починка' : 'подъём и починка (ковкой не используется)'}${tiers ? ` — ступени ${tiers}` : ''}`);
  if (g === 1) lines.push('Расходник любого подъёма и починки');
  lines.push(`В сундуке ${stash}`);
  if (hand > 0) lines.push(`В сумке ${hand} — часть потеряешь при смерти`);
  lines.push(d.sellPrice > 0 ? `Продажа: ${d.sellPrice} за штуку` : 'Не продаётся');
  return lines;
}

/** Откуда эссенция (разбор у кузнеца найденных магических и редких, в поле — доля), чьи вещи её не дают и куда идёт (чары). */
function essenceAbout(reg: ConfigRegistry): string[] {
  const s = reg.get('balance').salvage;
  const e = s.essence as Record<string, number>;
  return [
    `Откуда: разбор у кузнеца найденных вещей и наград — магическая ${e.magic ?? 0}, редкая ${e.rare ?? 0}; в поле — ${Math.round(s.fieldYield * 100)} %`,
    'Купленное, стартовое, вещи прежней версии и переплавка эссенции не дают',
    'Куда: зачарование скованной вещи и перекатка свойств',
  ];
}

/** Цена продажи строкой — общая для сырья и эссенции. */
const saleLine = (price: number): string => (price > 0 ? `Продажа: ${price} за штуку` : 'Не продаётся');

/** Подсказка плашки эссенции склада: имя, «не сырьё — валюта чар» (плашка стоит под сеткой сырья), откуда, куда, где лежит, цена. */
function essenceTip(reg: ConfigRegistry, d: { name: string; sellPrice: number }, stash: number, hand: number): string[] {
  const lines = [d.name, 'Не сырьё — валюта чар', ...essenceAbout(reg), `В сундуке ${stash}`];
  if (hand > 0) lines.push(`В сумке ${hand} — часть потеряешь при смерти`);
  lines.push(saleLine(d.sellPrice));
  return lines;
}

/**
 * Модель склада: `stashWallet` — кошелёк СУНДУКА аккаунта, `inventory` — сумка героя (несомое показывается рядом: оно под угрозой смерти).
 * ⚠ Рисуем ВСЕ включённые материалы конфига, а не только имеющиеся: склад с пустыми ячейками показывает, что вообще бывает и чего
 * не хватает.
 */
export function materialsModel(reg: ConfigRegistry, stashWallet: Record<string, number>, inventory: readonly Item[]): MaterialsModel {
  const carried = carriedMaterials(inventory);
  const all = reg.get('craft-materials').filter((d) => d.enabled);
  const defs = all.filter((d) => d.family !== ESSENCE_FAMILY);
  const forge = forgeFamilies(reg);
  // Порядок семей — как они впервые встречаются в конфиге: склад не должен прыгать между открытиями.
  const families: string[] = [];
  for (const d of defs) if (!families.includes(d.family)) families.push(d.family);
  const steps = Math.min(MATERIAL_STEPS, Math.max(0, ...defs.map((d) => d.tier)));
  const grades = Array.from({ length: steps }, (_, i) => i + 1);
  const cell = (d: (typeof defs)[number]): MaterialCell => {
    const stash = Math.max(0, stashWallet[d.id] ?? 0);
    const hand = carried[d.id] ?? 0;
    return {
      id: d.id, name: d.name, grade: d.tier, stash, hand, have: stash + hand > 0, color: gradeHex(d.tier), bold: d.tier >= MATERIAL_STEPS,
      tip: cellTip(reg, d, stash, hand, forge.has(d.family)),
    };
  };
  const ess = all.find((d) => d.id === ESSENCE_ID);
  return {
    heads: grades.map((g) => ({ grade: g, label: gradeLabel(g), sub: gradeSourceText(reg, g), color: gradeHex(g), bold: g >= MATERIAL_STEPS })),
    rows: families.map((fam) => ({
      family: fam,
      label: FAMILY_LABEL[fam] ?? fam,
      // Первый включённый материал сорта (выключенные копии конфиг держит рядом — их не показываем).
      cells: grades.map((g) => { const d = defs.find((x) => x.family === fam && x.tier === g); return d ? cell(d) : null; }),
    })),
    essence: ess ? (() => {
      const stash = Math.max(0, stashWallet[ess.id] ?? 0);
      const hand = carried[ess.id] ?? 0;
      return { id: ess.id, name: ess.name, grade: ess.tier, stash, hand, have: stash + hand > 0, color: ESSENCE_HEX, bold: false, tip: essenceTip(reg, ess, stash, hand) };
    })() : null,
    rule: SALVAGE_RULE,
  };
}

/**
 * Подсказка СТОПКИ сырья в сумке (§15.4): «семья · сорт», откуда, куда, цена — та же, что у клетки склада; цвет имени — цвет сорта.
 * Эссенция — откуда, куда, цена; вид («Валюта чар · в стеке N») говорит первая строка `describeItem` над этими
 * строками. ⚠ Было: там стояло «Сырьё · в стеке N», а здесь — «Не сырьё — валюта чар»: подсказка одной стопки спорила сама с собой.
 * Не сырьё или материала нет в конфиге — `null`.
 */
export function materialNote(reg: ConfigRegistry, item: Pick<Item, 'kind' | 'materialId'>): { color: string; lines: string[] } | null {
  if (item.kind !== 'material' || !item.materialId) return null;
  const d = reg.get('craft-materials').find((m) => m.id === item.materialId);
  if (!d) return null;
  if (d.family === ESSENCE_FAMILY) return { color: ESSENCE_HEX, lines: [...essenceAbout(reg), saleLine(d.sellPrice)] };
  const tip = cellTip(reg, d, 0, 0, forgeFamilies(reg).has(d.family));
  return { color: gradeHex(d.tier), lines: tip.filter((l, i) => i > 0 && !/^В (сундуке|сумке) /.test(l)) };
}

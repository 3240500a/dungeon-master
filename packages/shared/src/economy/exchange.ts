import type { ConfigRegistry } from '../config/registry.js';
import type { SaveState } from '../types/save.js';
import type { AccountStash } from '../types/stash.js';
import { ESSENCE_FAMILY } from '../formulas/salvage.js';
import { MATERIAL_STEPS, materialId } from '../formulas/craft.js';
import { addToWallet, availableMaterials, canAffordBoth, spendBoth } from './materials.js';
import { describeCost, materialsRaised, priceRaised, PRICE_CHANGED, type ActionResult } from './townActions.js';
import { gradeRoman } from './salvagePreview.js';

/**
 * ⭐ ОБМЕН СЫРЬЯ У КУЗНЕЦА («Обмен», решение владельца 06.10): отдаёшь сырьё семьи F — получаешь ТОТ ЖЕ сорт семьи F′. Курс
 * `forgePrices.exchange.give → get` (3 → 2, вниз) и золото за КАЖДУЮ полученную единицу по сорту (`goldPerUnit`: I 5 · II 12 · III 30 ·
 * IV 60 · V 120). Две задачи разом: сток золота на глубине (бот копил +12…23 тыс. золота в час) и мостик для узких семей — лук, арбалет,
 * жезл и посох на t6 ковались в 2–3 раза дольше ближнего боя, потому что их семья удара шла с двух классов из десяти.
 *
 * Правила (одни для окна и сервера — окно рисует ЭТОТ расчёт):
 * - сорт не меняется никогда: правило «V только с находок t6» обмен не обходит;
 * - эссенция не меняется ни туда, ни обратно (это валюта чар, а не сырьё); в выключенное сырьё не меняют (`enabled: false` — «не в игре»);
 *   из выключенного — можно: это запас игрока, лежащий с прежних правил;
 * - берётся СПЕРВА из сумки, потом из сундука (`spendBoth`); полученное — в кошелёк сундука (не в сумку: сумка не должна переполняться
 *   у кузнеца, и сундук при смерти не теряется);
 * - отдаётся ровно столько, сколько нужно на полученное: `get = ⌊n·get/give⌋`, `spend = ⌈get·give/get⌉ ≤ n` — остаток деления не сгорает;
 * - ⭐ «обменял и продал» НЕ ВЫГОДНО ПРИ ЛЮБОМ КОНФИГЕ: золото за единицу не меньше цены её продажи (`max(1, goldPerUnit, sellPrice)`),
 *   поэтому продажа полученного не возвращает даже уплаченного золота, а отданное сырьё ушло (сторож `exchange.test.ts`, фаззер экономики).
 *   Обмен туда-обратно теряет треть за круг и платит дважды — петли нет.
 */

export interface ExchangeQuote {
  ok: boolean;
  reason?: string;
  /** Что отдаётся (id материала) и во что (id того же сорта другой семьи; пусто — семья не годна). */
  from: string;
  to: string;
  grade: number;
  /** Сколько просили отдать / сколько реально уйдёт (не больше просимого) / сколько придёт. */
  give: number;
  spend: number;
  get: number;
  /** Золото за обмен и цена одной полученной единицы. */
  gold: number;
  unitGold: number;
}

/** Ручка обмена из конфига (`balance.forgePrices.exchange`). */
export function exchangeTuning(reg: ConfigRegistry): { enabled: boolean; give: number; get: number; goldPerUnit: readonly number[] } {
  return reg.get('balance').forgePrices.exchange;
}

/** Сколько придёт за `n` отданных и сколько из них реально уйдёт (остаток деления остаётся у игрока). */
export function exchangeYield(reg: ConfigRegistry, n: number): { get: number; spend: number } {
  const k = exchangeTuning(reg);
  const give = Math.max(1, Math.floor(k.give)), take = Math.max(1, Math.floor(k.get));
  const m = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  const get = Math.floor((m * take) / give);
  return { get, spend: get > 0 ? Math.min(m, Math.ceil((get * give) / take)) : 0 };
}

/** Наименьшее «отдать», за которое придёт хоть одна единица. */
export const exchangeMinGive = (reg: ConfigRegistry): number => {
  const k = exchangeTuning(reg);
  return Math.max(1, Math.ceil(Math.max(1, Math.floor(k.give)) / Math.max(1, Math.floor(k.get))));
};

/** Золото за ОДНУ полученную единицу сорта `grade` в `toId`: ручка сорта, но не меньше цены продажи единицы и не меньше 1. */
export function exchangeUnitGold(reg: ConfigRegistry, grade: number, toId: string): number {
  const table = exchangeTuning(reg).goldPerUnit;
  const g = Math.max(1, Math.min(MATERIAL_STEPS, Math.floor(grade)));
  const own = table[Math.min(g, table.length) - 1] ?? 0;
  const sell = reg.get('craft-materials').find((m) => m.id === toId)?.sellPrice ?? 0;
  return Math.max(1, Math.floor(own), Math.floor(sell));
}

/** Сырьё, которое можно отдать: известное конфигу, не эссенция. */
export function exchangeSource(reg: ConfigRegistry, fromId: string): { ok: boolean; reason?: string; family?: string; grade?: number; name?: string } {
  const def = reg.get('craft-materials').find((m) => m.id === fromId);
  if (!def) return { ok: false, reason: 'Кузнец не знает такого сырья' };
  if (def.family === ESSENCE_FAMILY) return { ok: false, reason: 'Эссенцию не меняют — это валюта чар' };
  return { ok: true, family: def.family, grade: def.tier, name: def.name };
}

/**
 * Во что можно обменять `fromId`: каждая ДРУГАЯ семья сырья с этим сортом в конфиге — с причиной, если нельзя (выключено). Порядок — как
 * семьи стоят в конфиге (как строки склада). Эссенции среди целей нет никогда.
 */
export function exchangeTargets(reg: ConfigRegistry, fromId: string): { family: string; id: string; name: string; ok: boolean; reason?: string }[] {
  const src = exchangeSource(reg, fromId);
  if (!src.ok) return [];
  const mats = reg.get('craft-materials');
  const out: { family: string; id: string; name: string; ok: boolean; reason?: string }[] = [];
  const seen = new Set<string>();
  for (const m of mats) {
    if (m.family === ESSENCE_FAMILY || m.family === src.family || seen.has(m.family)) continue;
    seen.add(m.family);
    const id = materialId(m.family, src.grade!);
    const def = mats.find((x) => x.id === id);
    if (!def) { out.push({ family: m.family, id, name: id, ok: false, reason: `у семьи нет ${gradeRoman(src.grade!)} сорта` }); continue; }
    out.push(def.enabled ? { family: m.family, id, name: def.name, ok: true } : { family: m.family, id, name: def.name, ok: false, reason: `«${def.name}» ещё не в игре` });
  }
  return out;
}

/**
 * ⭐ РАСЧЁТ ОБМЕНА — один для окна и сервера: что уйдёт, что придёт, сколько золота и почему нельзя. Наличие сырья и золота — здесь же
 * (`have` — сумка + сундук, `gold` — золото героя): окно гасит кнопку тем же ответом, каким откажет сервер.
 */
export function exchangeQuote(
  reg: ConfigRegistry, fromId: string, toFamily: string, n: number, have?: Record<string, number>, gold?: number,
): ExchangeQuote {
  const base: ExchangeQuote = { ok: false, from: fromId, to: '', grade: 0, give: Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0, spend: 0, get: 0, gold: 0, unitGold: 0 };
  const k = exchangeTuning(reg);
  if (!k.enabled) return { ...base, reason: 'Кузнец сейчас не меняет сырьё' };
  const src = exchangeSource(reg, fromId);
  if (!src.ok) return { ...base, reason: src.reason };
  base.grade = src.grade!;
  if (toFamily === src.family) return { ...base, reason: 'Выбери другую семью — та же не меняется' };
  const target = exchangeTargets(reg, fromId).find((t) => t.family === toFamily);
  if (!target) return { ...base, reason: toFamily === ESSENCE_FAMILY ? 'Эссенцию не меняют — это валюта чар' : 'Нет такой семьи сырья' };
  base.to = target.id;
  if (!target.ok) return { ...base, reason: `Нельзя: ${target.reason}` };
  const { get, spend } = exchangeYield(reg, base.give);
  const unitGold = exchangeUnitGold(reg, src.grade!, target.id);
  const q: ExchangeQuote = { ...base, spend, get, unitGold, gold: get * unitGold };
  if (get <= 0) return { ...q, reason: `Мало: курс ${k.give} → ${k.get} — отдай хотя бы ${exchangeMinGive(reg)}` };
  if (have && (have[fromId] ?? 0) < spend) return { ...q, reason: `Не хватает: ${src.name} ${spend} (есть ${have[fromId] ?? 0})` };
  if (gold !== undefined && gold < q.gold) return { ...q, reason: `Недостаточно золота: нужно ${q.gold} (есть ${gold})` };
  return { ...q, ok: true };
}

/** Согласие на ВЫХОД обмена (`minYield` карточки): придёт меньше показанного или не то — отказ «Цена изменилась…». */
function exchangeYieldDropped(reg: ConfigRegistry, q: ExchangeQuote, minYield: Record<string, number> | undefined): ActionResult | null {
  if (minYield === undefined) return null;
  const broken = !minYield || typeof minYield !== 'object' || Array.isArray(minYield)
    || Object.entries(minYield).some(([id, n]) => typeof n !== 'number' || !Number.isFinite(n) || n < 0
      || n > (id === q.to ? q.get : 0));
  return broken ? { ok: false, reason: `${PRICE_CHANGED}: обмен даст ${describeCost(reg, { [q.to]: q.get })}` } : null;
}

/**
 * ⭐ ОБМЕН — АВТОРИТЕТНО (сервер: команда `forgeExchange`, сейв и сундук одной транзакцией). Согласие — как у прочей кузницы: `maxGold`
 * (золото карточки), `maxMaterials` (сколько карточка обещала взять; у сервера нет поля — «ни на какое сырьё», `serverMaterialsConsent`),
 * `minYield` (сколько обещала дать). Все отказы — ДО траты.
 */
export function forgeExchange(
  reg: ConfigRegistry, save: SaveState, stash: AccountStash, fromId: string, toFamily: string, n: number,
  maxGold?: number, maxMaterials?: Record<string, number>, minYield?: Record<string, number>,
): ActionResult & { summary?: string } {
  // Кошелёк сундука заводится только на успехе: отказ не трогает ничего (и пустого поля не дописывает).
  const wallet = stash.materials ?? {};
  const q = exchangeQuote(reg, fromId, toFamily, n);
  // Согласие — до наличия: старое окно (другая цена, другой курс) получает «Цена изменилась…» и перечитывает конфиг, а не «не хватает».
  if (q.to && q.get > 0) {
    const raised = priceRaised(q.gold, maxGold) ?? materialsRaised(reg, { [q.from]: q.spend }, maxMaterials) ?? exchangeYieldDropped(reg, q, minYield);
    if (raised) return raised;
  }
  if (!q.ok) return { ok: false, reason: q.reason };
  if (save.gold < q.gold) return { ok: false, reason: `Недостаточно золота: нужно ${q.gold} (есть ${save.gold})` };
  const cost = { [q.from]: q.spend };
  if (!canAffordBoth(save.inventory, wallet, cost)) {
    const have = availableMaterials(save.inventory, wallet)[q.from] ?? 0;
    return { ok: false, reason: `Не хватает: ${describeCost(reg, cost)} (есть ${have})` };
  }
  save.gold -= q.gold;
  spendBoth(save.inventory, wallet, cost);
  addToWallet(wallet, { [q.to]: q.get });
  stash.materials = wallet;
  return { ok: true, summary: `Обмен: отдано ${describeCost(reg, cost)} → получено ${describeCost(reg, { [q.to]: q.get })} (в сундук) · ${q.gold} золота` };
}

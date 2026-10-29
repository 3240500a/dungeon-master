/**
 * ⭐ ВИД «⇄ ОБМЕН» КУЗНИЦЫ — сервером: что можно отдать (стопки сумки и сундука), во что (другие семьи того же сорта, выключенные — с
 * причиной), сколько уйдёт и придёт, почём, почему нельзя и КОМАНДА С СОГЛАСИЕМ (`maxGold`, `maxMaterials`, `minYield`).
 *
 * Заменяет C# `DmTown.ExchangeModel` / `DefaultGive` и ядро под ними (`ExchangeTuning`, `ExchangeYield`, `ExchangeMinGive`, `ExchangeUnitGold`,
 * `ExchangeSource`, `ExchangeTargets`, `ExchangeQuote` — DmTownExchange.cs). Источник — веб `client/modules/town/forgeExchange.ts`; расчёт —
 * `exchangeQuote` @dm/shared, тот же, которым сервер исполняет `forgeExchange`: команда вида = факт.
 * Выход — ключи C# `DmTown.ExchangeView` / `ExchangeSourceRow` / `ExchangeTargetRow` / `ExchangeLine` / `ExchangeQuoteR`.
 */
import type { ConfigRegistry } from '../config/registry.js';
import type { Item, SaveState } from '../types/index.js';
import { availableMaterials, carriedMaterials } from '../economy/materials.js';
import {
  exchangeMinGive, exchangeQuote, exchangeTargets, exchangeTuning, exchangeUnitGold, type ExchangeQuote,
} from '../economy/exchange.js';
import { gradeRoman } from '../economy/salvagePreview.js';
import { ESSENCE_FAMILY } from '../formulas/salvage.js';
import { familyLabel, gradeHex } from './townMaterials.js';
import type { StashView } from './townItem.js';

/**
 * Выбор игрока (ВХОД КЛИЕНТА — состояние окна): что отдаёт (id), во что (семья), сколько просит отдать. ⭐ `n` не задано (`undefined`) —
 * «только что выбрал стопку»: сервер ставит начальное (`exchangeDefaultGive` — шаг курса или всё, что есть; C# `DmTown.DefaultGive`).
 */
export interface ExchangeSel { from: string | null; to: string | null; n?: number | null }

export interface ExchangeSourceRow {
  id: string; name: string; family: string; familyLabel: string; grade: number; gradeLabel: string;
  have: number; bag: number; stash: number; color: string; selected: boolean;
}
export interface ExchangeTargetRow { family: string; label: string; id: string; name: string; have: number; ok: boolean; reason?: string; selected: boolean }
export interface ExchangeLine { label: string; text: string; state: 'ok' | 'miss' | 'gain' | 'dim' | 'warn' }
export interface ExchangeCommand {
  cmd: 'forgeExchange'; from: string; to: string; n: number; maxGold: number; maxMaterials: Record<string, number>; minYield: Record<string, number>;
}
export interface ExchangeView {
  closed?: string;
  rate: string;
  goldLine: string;
  sources: ExchangeSourceRow[];
  targets: ExchangeTargetRow[];
  n: number; step: number; max: number; min: number;
  quote: ExchangeQuote | null;
  lines: ExchangeLine[];
  canSend: boolean;
  reason?: string;
  command?: ExchangeCommand;
}

/** Начальное «сколько отдать» для только что выбранной стопки: шаг курса, если хватает, иначе всё, что есть. */
export function exchangeDefaultGive(reg: ConfigRegistry, have: number): number {
  const step = exchangeTuning(reg).give;
  return have >= step ? step : have;
}

/**
 * Модель вкладки по сумке, кошельку сундука и золоту. Выбор, ставший негодным (стопка кончилась, семья выключена), снимается: окно
 * показывает, что есть сейчас.
 */
export function exchangeModel(
  reg: ConfigRegistry, inventory: readonly Item[], stashWallet: Record<string, number>, gold: number, sel: ExchangeSel,
): ExchangeView {
  const k = exchangeTuning(reg);
  const g = k.goldPerUnit;
  const rate = `Курс: ${k.give} → ${k.get} того же сорта (остаток не берётся)`;
  const goldLine = `Золото за каждую полученную единицу: ${g.map((v, i) => `${gradeRoman(i + 1)} ${v}`).join(' · ')}`;
  const empty: ExchangeView = { rate, goldLine, sources: [], targets: [], n: 0, step: k.give, max: 0, min: exchangeMinGive(reg), quote: null, lines: [], canSend: false };
  if (!k.enabled) return { ...empty, closed: 'Кузнец сейчас не меняет сырьё' };

  const have = availableMaterials(inventory, stashWallet);
  const bag = carriedMaterials(inventory);
  const defs = reg.get('craft-materials');
  const order = new Map<string, number>();
  for (const d of defs) if (!order.has(d.family)) order.set(d.family, order.size);
  const sources: ExchangeSourceRow[] = defs
    .filter((d) => d.family !== ESSENCE_FAMILY && (have[d.id] ?? 0) > 0)
    .sort((a, b) => (order.get(a.family)! - order.get(b.family)!) || a.tier - b.tier)
    .map((d) => ({
      id: d.id, name: d.name, family: d.family, familyLabel: familyLabel(d.family), grade: d.tier, gradeLabel: `${gradeRoman(d.tier)} сорт`,
      have: have[d.id] ?? 0, bag: bag[d.id] ?? 0, stash: Math.max(0, stashWallet[d.id] ?? 0), color: gradeHex(d.tier), selected: d.id === sel.from,
    }));
  const src = sources.find((s) => s.selected);
  if (!src) return { ...empty, sources, reason: sources.length ? 'Выбери, что отдаёшь' : 'Сырья нет — его дают разбор у кузнеца и тела монстров' };
  const targets: ExchangeTargetRow[] = exchangeTargets(reg, src.id).map((t) => ({
    family: t.family, label: familyLabel(t.family), id: t.id, name: t.name, have: have[t.id] ?? 0, ok: t.ok, ...(t.reason !== undefined ? { reason: t.reason } : {}),
    selected: t.ok && t.family === sel.to,
  }));
  const max = src.have;
  const want = sel.n === undefined ? exchangeDefaultGive(reg, src.have) : (sel.n as number);
  const n = Math.max(0, Math.min(max, Number.isFinite(want) ? Math.floor(want) : 0));
  const tgt = targets.find((t) => t.selected);
  const base = { ...empty, sources, targets, n, max };
  if (!tgt) return { ...base, reason: targets.some((t) => t.ok) ? 'Выбери, во что меняешь' : 'Менять не во что: у других семей нет этого сорта в игре' };
  const q = exchangeQuote(reg, src.id, tgt.family, n, have, gold);
  const unit = exchangeUnitGold(reg, src.grade, tgt.id);
  const lines: ExchangeLine[] = [
    { label: 'Отдашь', text: `${src.name} ${q.spend} (есть ${src.have}${src.bag ? `, в сумке ${src.bag} — берётся первой` : ''})${q.spend < n ? ` · ${n - q.spend} останется — меньше курса` : ''}`, state: q.spend > 0 && src.have >= q.spend ? 'ok' : 'dim' },
    { label: 'Получишь', text: q.get > 0 ? `${tgt.name} ${q.get} (есть ${tgt.have}) — в сундук` : `${tgt.name} 0`, state: q.get > 0 ? 'gain' : 'dim' },
    { label: 'Золото', text: `${q.gold} (${unit} за единицу · есть ${gold})`, state: gold >= q.gold ? 'ok' : 'miss' },
  ];
  const command: ExchangeCommand | undefined = q.get > 0 && q.to
    ? { cmd: 'forgeExchange', from: src.id, to: tgt.family, n: q.spend, maxGold: q.gold, maxMaterials: { [src.id]: q.spend }, minYield: { [q.to]: q.get } }
    : undefined;
  return { ...base, quote: q, lines, canSend: q.ok && !!command, ...(q.ok ? {} : { reason: q.reason }), ...(command ? { command } : {}) };
}

/** ⭐ ВКЛАДКА «⇄ ОБМЕН» для героя: сумка и золото — сейв, кошелёк — сундук аккаунта (нет сундука — только сумка, как у C# без кадра). */
export function exchangeView(reg: ConfigRegistry, save: SaveState, stash: StashView, sel: ExchangeSel): ExchangeView {
  return exchangeModel(reg, save.inventory, stash?.materials ?? {}, save.gold, sel);
}

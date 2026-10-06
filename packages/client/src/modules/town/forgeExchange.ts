import {
  ESSENCE_FAMILY, availableMaterials, carriedMaterials, exchangeMinGive, exchangeQuote, exchangeTargets, exchangeTuning, exchangeUnitGold,
  gradeRoman, type ConfigRegistry, type ExchangeQuote, type Item, type TownCommand,
} from '@dm/shared';
import { FAMILY_LABEL, gradeHex } from '../inventory/materialsModel.js';

/**
 * ⭐ ВКЛАДКА «⇄ ОБМЕН» КУЗНИЦЫ — ЧИСТАЯ МОДЕЛЬ без DOM (рисует `forgeExchangeView.ts`). Что можно отдать (стопки сумки и сундука), во что
 * (другие семьи того же сорта, выключенные — с причиной), сколько уйдёт и придёт, почём, почему нельзя и команда с согласием. Расчёт —
 * ТОТ ЖЕ `exchangeQuote`, которым отказывает сервер (`forgeExchange`): карточка не может обещать другое.
 */

/** Выбор игрока: что отдаёт (id), во что (семья), сколько просит отдать. Живёт в окне кузницы (переживает перерисовку). */
export interface ExchangeSel { from: string | null; to: string | null; n: number }

export interface ExchangeSourceRow {
  id: string; name: string; family: string; familyLabel: string; grade: number; gradeLabel: string;
  have: number; bag: number; stash: number; color: string; selected: boolean;
}
export interface ExchangeTargetRow { family: string; label: string; id: string; name: string; have: number; ok: boolean; reason?: string; selected: boolean }
export interface ExchangeLine { label: string; text: string; state: 'ok' | 'miss' | 'gain' | 'dim' | 'warn' }

export interface ExchangeModel {
  /** Обмен выключен в конфиге — причина (вкладка не рисует выбор). */
  closed?: string;
  /** «3 → 2» и золото за единицу по сортам — шапка вкладки. */
  rate: string;
  goldLine: string;
  sources: ExchangeSourceRow[];
  targets: ExchangeTargetRow[];
  /** Сколько просит отдать (зажато в 0…есть), шаг кнопок, «всё», наименьшее разумное. */
  n: number; step: number; max: number; min: number;
  quote: ExchangeQuote | null;
  lines: ExchangeLine[];
  canSend: boolean;
  /** Почему кнопка погашена (или что сделать дальше). */
  reason?: string;
  /** Команда с согласием (`maxGold`, `maxMaterials`, `minYield`) — ровно расчёт карточки. */
  command?: Extract<TownCommand, { cmd: 'forgeExchange' }>;
}

/** Имя семьи для игрока. */
const famLabel = (f: string): string => FAMILY_LABEL[f] ?? f;

/**
 * Модель вкладки. `inventory` — сумка героя, `stashWallet` — кошелёк сундука, `gold` — золото героя. Выбор, ставший негодным (стопка
 * кончилась, семья выключена), снимается: окно показывает, что есть сейчас, а не что было.
 */
export function exchangeModel(
  reg: ConfigRegistry, inventory: readonly Item[], stashWallet: Record<string, number>, gold: number, sel: ExchangeSel,
): ExchangeModel {
  const k = exchangeTuning(reg);
  const g = k.goldPerUnit;
  const rate = `Курс: ${k.give} → ${k.get} того же сорта (остаток не берётся)`;
  const goldLine = `Золото за каждую полученную единицу: ${g.map((v, i) => `${gradeRoman(i + 1)} ${v}`).join(' · ')}`;
  const empty: ExchangeModel = { rate, goldLine, sources: [], targets: [], n: 0, step: k.give, max: 0, min: exchangeMinGive(reg), quote: null, lines: [], canSend: false };
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
      id: d.id, name: d.name, family: d.family, familyLabel: famLabel(d.family), grade: d.tier, gradeLabel: `${gradeRoman(d.tier)} сорт`,
      have: have[d.id] ?? 0, bag: bag[d.id] ?? 0, stash: Math.max(0, stashWallet[d.id] ?? 0), color: gradeHex(d.tier), selected: d.id === sel.from,
    }));
  const src = sources.find((s) => s.selected);
  if (!src) {
    return { ...empty, sources, reason: sources.length ? 'Выбери, что отдаёшь' : 'Сырья нет — его дают разбор у кузнеца и тела монстров' };
  }
  const targets: ExchangeTargetRow[] = exchangeTargets(reg, src.id).map((t) => ({
    family: t.family, label: famLabel(t.family), id: t.id, name: t.name, have: have[t.id] ?? 0, ok: t.ok, reason: t.reason,
    selected: t.ok && t.family === sel.to,
  }));
  const max = src.have;
  const n = Math.max(0, Math.min(max, Number.isFinite(sel.n) ? Math.floor(sel.n) : 0));
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
  const command: ExchangeModel['command'] = q.get > 0 && q.to
    ? { cmd: 'forgeExchange', from: src.id, to: tgt.family, n: q.spend, maxGold: q.gold, maxMaterials: { [src.id]: q.spend }, minYield: { [q.to]: q.get } }
    : undefined;
  return { ...base, quote: q, lines, canSend: q.ok && !!command, reason: q.ok ? undefined : q.reason, ...(command ? { command } : {}) };
}

/** Начальное «сколько отдать» для только что выбранной стопки: шаг курса, если хватает, иначе всё, что есть. */
export function defaultGive(reg: ConfigRegistry, have: number): number {
  const step = exchangeTuning(reg).give;
  return have >= step ? step : have;
}

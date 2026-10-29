import type { ConfigRegistry } from '../config/registry.js';
import type { SaveState } from '../types/save.js';
import type { AccountStash } from '../types/stash.js';
import { liveModStats } from '../dungeon/run/runModEffects.js';
import {
  SEAL_REFORGE_BIOME, SEAL_REFORGE_DEEP, SEAL_REFORGE_FEW, SEAL_REFORGE_GOLD, SEAL_REFORGE_OFF, SEAL_REFORGE_TOP, SEAL_REROLL_ALONE,
  SEAL_REROLL_OFF, carriedSealsAll, liveSealDefs, parseSealKey, sealBiomeKey, sealDef, sealLive, sealNextTier, sealReforgeRules,
  sealRerollCost, sealRerollRules, sealTierDef, sealTierMul, sealTiers, sealsEnabled, type SealGains,
} from '../economy/seals.js';
import { cfgTextOf, isNum, ordinal, type CfgText, type RunViewOptions } from './runCommon.js';

/**
 * ⭐⭐ С-views (29.10): ВКЛАДКА КУЗНИЦЫ «🔮 Печати» (перековка 3→1 и перекат вида) — модель считает СЕРВЕР.
 *
 * Порт `SealReforge.Model` (Unity `Assets/DM/UI/SealReforge.cs`) поверх ТЕХ ЖЕ правил, что исполняет `townActions.sealReforge` →
 * `canReforgeSeals`/`reforgeSeals` и `sealReroll` → `canRerollSeal`. Ключи результата — поля C# `ReforgeModelView` / `ReforgeCard` /
 * `RerollCard`. Модель не зависит от выбора игрока: сервер шлёт её целиком (на открытие вкладки и после каждой смены сейва/сундука).
 *
 * ⭐⭐ И ГЛАВНОЕ — ВЫБОР ПЕЧАТЕЙ ПОД КАРТОЧКУ `sameTier` ДЕЛАЕТ СЕРВЕР (`runReforgeTake`). Сегодня Unity сам набирает «три любые
 * одной ступени» (`SealReforgeView.Take`) и шлёт готовую связку `seals`; в авторитетной схеме клиент шлёт только КЛЮЧ КАРТОЧКИ
 * (`card`), а какие именно печати сгорят, решает сервер по живому сейву и сундуку.
 */

/** Тексты вкладки — C# константы `SealReforge.*` (отказы — общие с ядром, `SEAL_REFORGE_*`). */
export const RUN_REFORGE_TEXT = {
  title: 'Перековка печатей',
  apply: 'Перековать',
  off: SEAL_REFORGE_OFF,
  empty: 'Печатей нет. Они падают с элиты, редких, из сундуков и с боссов.',
  noStash: '⚠ Сундук не загрузился — перековка видит только сумку.',
  source: 'Печати берутся из сумки и из сундука.',
  noteKind: 'Три печати одного вида и ступени → одна того же вида ступенью выше.',
  noteTier: 'Три печати одной ступени → одна СЛУЧАЙНОГО вида ступенью выше: вид решает кузнец.',
  few: SEAL_REFORGE_FEW,
  top: SEAL_REFORGE_TOP,
  deep: SEAL_REFORGE_DEEP,
  gold: SEAL_REFORGE_GOLD,
  biome: SEAL_REFORGE_BIOME,
  rerollApply: 'Перекатить',
  rerollOff: SEAL_REROLL_OFF,
  rerollNote: 'Перекат: одна печать → другой ВИД той же ступени, за золото. Сила не меняется.',
  rerollAlone: SEAL_REROLL_ALONE,
} as const;

/** C# `ReforgeCard`. */
export interface RunReforgeCard {
  key: string; keys: string[]; name: string; result: string | null; reason: string | null;
  carried: number; need: number; can: boolean;
}
/** C# `RerollCard`. */
export interface RunRerollCard { key: string; name: string; reason: string | null; carried: number; gold: number; can: boolean }
/** C# `ReforgeModelView`. */
export interface RunReforgeModel {
  note: string; need: number; off: boolean; cards: RunReforgeCard[];
  rerollOff: boolean; rerollNote: string | null; rerolls: RunRerollCard[];
}

function reforgeOn(reg: ConfigRegistry): boolean {
  return sealsEnabled(reg) && sealReforgeRules(reg).enabled !== false;
}
function rerollOn(reg: ConfigRegistry): boolean {
  return sealsEnabled(reg) && sealRerollRules(reg).enabled !== false;
}

/** Рекорд героя — ЛУЧШИЙ по тирам (тот же счёт, что у `townActions.sealReforge`). */
function bestRecord(save: SaveState): number {
  let best = 0;
  for (const d of Object.values(save.difficultyProgress ?? {})) if (isNum(d) && Number.isFinite(d)) best = Math.max(best, Math.floor(d));
  return best;
}

function tabsOf(stash: AccountStash | null | undefined): AccountStash['tabs'] | undefined {
  return stash?.tabs ?? undefined;
}

function sealTitle(reg: ConfigRegistry, tx: CfgText, sealId: string, tierId: string, defName: string): string {
  const t = sealTierDef(reg, tierId);
  const name = tx('seals', [sealId], 'name', defName) ?? defName;
  return t ? `${name} ${tx('balance', ['seals', 'tiers', t.id], 'name', t.name) ?? t.name}` : name;
}

/**
 * Что выйдет и почему нельзя. ⚠ ПОРЯДОК — КАК У СЕРВЕРА (`canReforgeSeals`): конец лестницы → ворота рекорда → нехватка →
 * пошлина. Окно Unity проверяло нехватку РАНЬШЕ ворот, и при «мало печатей И мелкий рекорд» называло другую причину, чем ответил бы
 * сервер; вид говорит словами сервера.
 */
function fill(reg: ConfigRegistry, tx: CfgText, card: RunReforgeCard, tierId: string, have: number, gold: number, record: number): void {
  const rules = sealReforgeRules(reg);
  const next = sealNextTier(reg, tierId);
  if (!next) { card.reason = SEAL_REFORGE_TOP; card.result = null; return; }
  card.result = `→ ${tx('balance', ['seals', 'tiers', next.id], 'name', next.name) ?? next.name}`;
  if (rules.gateByRecord !== false && next.minDepth > record) { card.reason = SEAL_REFORGE_DEEP; return; }
  if (have < card.need) { card.reason = `${SEAL_REFORGE_FEW}: нужно ${card.need}`; return; }
  if (gold < rules.goldCost) { card.reason = SEAL_REFORGE_GOLD; return; }
  card.can = true;
}

/** Ключ карточки `sameTier`: «ступень|привязка» (привязка — `sealBiomeKey`, пусто — общие). */
export function runReforgeTierCardKey(tierId: string, biomeKey: string): string {
  return `${tierId}|${biomeKey}`;
}

/**
 * ⭐⭐ МОДЕЛЬ ВКЛАДКИ (C# `SealReforge.Model`). Сервер: `runReforgeView(this.cfg, save, stash)`; `stash = null` — сундук не
 * прочитался (как у кузницы: тогда запас — только сумка, и `runReforgeHead` скажет это строкой).
 */
export function runReforgeView(reg: ConfigRegistry, save: SaveState, stash: AccountStash | null | undefined, opts?: RunViewOptions): RunReforgeModel {
  const tx = cfgTextOf(reg, opts);
  const rules = sealReforgeRules(reg);
  const v: RunReforgeModel = {
    note: '', need: rules.need, off: !reforgeOn(reg), cards: [], rerollOff: false, rerollNote: null, rerolls: [],
  };
  v.note = v.off ? RUN_REFORGE_TEXT.off : rules.mode === 'sameTier' ? RUN_REFORGE_TEXT.noteTier : RUN_REFORGE_TEXT.noteKind;
  if (v.off) return v;   // ⚠ как в C#: при выключенной перековке и перекат не описывается (поля по умолчанию)

  const carried = carriedSealsAll(save.inventory ?? [], tabsOf(stash));
  const live = liveModStats(reg);
  const gold = isNum(save.gold) ? Math.floor(save.gold) : 0;
  const record = bestRecord(save);

  if (rules.mode === 'sameTier') {
    // По карточке на СТУПЕНЬ И ПРИВЯЗКУ: смешивать привязки ядро не даёт (`SEAL_REFORGE_BIOME`), и окно их не предлагает.
    for (const tier of sealTiers(reg)) {
      const byBiome = new Map<string, { keys: string[]; have: number }>();
      for (const [key, n] of Object.entries(carried)) {
        const parsed = parseSealKey(key);
        if (!parsed || parsed.tierId !== tier.id) continue;
        const def = sealDef(reg, parsed.sealId);
        if (!def || !sealLive(reg, def, live)) continue;
        const bk = sealBiomeKey(def);
        const g = byBiome.get(bk) ?? { keys: [], have: 0 };
        g.keys.push(key);
        g.have += n;
        byBiome.set(bk, g);
      }
      for (const [bk, g] of byBiome) {
        if (g.have <= 0) continue;
        const tn = tx('balance', ['seals', 'tiers', tier.id], 'name', tier.name) ?? tier.name;
        const card: RunReforgeCard = {
          key: runReforgeTierCardKey(tier.id, bk), keys: g.keys, name: bk.length === 0 ? `Любые печати ${tn}` : `Печати ${tn} (${bk})`,
          result: null, reason: null, carried: g.have, need: v.need, can: false,
        };
        fill(reg, tx, card, tier.id, g.have, gold, record);
        v.cards.push(card);
      }
    }
  } else {
    // По карточке на ПАРУ «вид + ступень»: перековка целевая.
    for (const [key, n] of Object.entries(carried)) {
      const parsed = parseSealKey(key);
      if (!parsed) continue;
      const def = sealDef(reg, parsed.sealId);
      if (!def || !sealLive(reg, def, live) || sealTierMul(reg, parsed.tierId) <= 0) continue;
      const card: RunReforgeCard = {
        key, keys: [key], name: sealTitle(reg, tx, def.id, parsed.tierId, def.name),
        result: null, reason: null, carried: n, need: v.need, can: false,
      };
      fill(reg, tx, card, parsed.tierId, n, gold, record);
      v.cards.push(card);
    }
  }
  v.cards.sort((a, b) => ordinal(a.name, b.name));
  if (v.cards.length === 0) v.note = RUN_REFORGE_TEXT.empty;

  // ⭐ Ф5-6′: перекат — по карточке на пару «вид + ступень».
  v.rerollOff = !rerollOn(reg);
  v.rerollNote = v.rerollOff ? RUN_REFORGE_TEXT.rerollOff : RUN_REFORGE_TEXT.rerollNote;
  if (!v.rerollOff) {
    const differs = sealRerollRules(reg).differs !== false;
    const pool = liveSealDefs(reg);
    for (const [key, n] of Object.entries(carried)) {
      const parsed = parseSealKey(key);
      if (!parsed) continue;
      const def = sealDef(reg, parsed.sealId);
      if (!def || !sealLive(reg, def, live) || sealTierMul(reg, parsed.tierId) <= 0) continue;
      const card: RunRerollCard = {
        key, name: sealTitle(reg, tx, def.id, parsed.tierId, def.name), reason: null, carried: n,
        gold: sealRerollCost(reg, parsed.tierId), can: false,
      };
      const bk = sealBiomeKey(def);
      const others = pool.filter((d) => d.id !== def.id && sealBiomeKey(d) === bk).length;
      if (differs && others === 0) card.reason = SEAL_REROLL_ALONE;
      else if (gold < card.gold) card.reason = SEAL_REFORGE_GOLD;
      else card.can = true;
      v.rerolls.push(card);
    }
  }
  v.rerolls.sort((a, b) => ordinal(a.name, b.name));
  return v;
}

/**
 * Строки шапки вкладки, которые `SealReforgeView.Draw` считал сам: пошлина (`SealReforge.GoldCost(cfg)`) и источник запаса
 * (`dm.Stash == null`). Модель C# их не несёт — им нужны два новых поля DTO (`fee`, `source`, см. отчёт), а до того их можно
 * класть в кадр рядом с моделью.
 */
export function runReforgeHead(reg: ConfigRegistry, view: RunReforgeModel, stashLoaded: boolean): { fee: string | null; source: string | null } {
  const cost = sealReforgeRules(reg).goldCost;
  return {
    fee: cost > 0 ? `Пошлина кузнеца: ${cost} золота` : null,
    source: !stashLoaded ? RUN_REFORGE_TEXT.noStash : !view.off && view.cards.length > 0 ? RUN_REFORGE_TEXT.source : null,
  };
}

/**
 * ⭐⭐ КАКИЕ ПЕЧАТИ СЖЕЧЬ ПОД КАРТОЧКУ — РЕШАЕТ СЕРВЕР (замена `SealReforgeView.Take` Unity).
 *
 * `card` — ключ карточки из модели: «вид@ступень» при `sameKind`, «ступень|привязка» при `sameTier`. Набирает РОВНО `need`
 * штук по живым сейву и сундуку и возвращает связку для `reforgeSeals`; не набирается (нет такой карточки, мало печатей,
 * режим сменился) — `null`, и сервер отвечает `SEAL_REFORGE_FEW`/`SEAL_REFORGE_MIX` как сегодня.
 *
 * Правило набора — то же, что было у клиента, чтобы исход для игрока не изменился: ключи в порядке карточки (порядок запаса:
 * сначала то, что лежит в СУМКЕ, затем сундук — так и `spendSealsBoth` тратит сумку первой), из каждого ключа — сколько есть,
 * пока не набрано `need`. Детерминированно: один и тот же сейв — одна и та же связка.
 */
export function runReforgeTake(reg: ConfigRegistry, save: SaveState, stash: AccountStash | null | undefined, card: string): SealGains | null {
  if (!reforgeOn(reg) || typeof card !== 'string') return null;
  const rules = sealReforgeRules(reg);
  const carried = carriedSealsAll(save.inventory ?? [], tabsOf(stash));
  const live = liveModStats(reg);
  let keys: string[];
  if (rules.mode === 'sameTier') {
    const bar = card.indexOf('|');
    if (bar <= 0) return null;
    const tierId = card.slice(0, bar);
    const bk = card.slice(bar + 1);
    keys = [];
    for (const key of Object.keys(carried)) {
      const parsed = parseSealKey(key);
      if (!parsed || parsed.tierId !== tierId) continue;
      const def = sealDef(reg, parsed.sealId);
      if (!def || !sealLive(reg, def, live) || sealBiomeKey(def) !== bk) continue;
      keys.push(key);
    }
  } else {
    const parsed = parseSealKey(card);
    const def = parsed ? sealDef(reg, parsed.sealId) : undefined;
    if (!parsed || !def || !sealLive(reg, def, live) || sealTierMul(reg, parsed.tierId) <= 0) return null;
    keys = [card];
  }
  const out: SealGains = {};
  let left = rules.need;
  for (const k of keys) {
    if (left <= 0) break;
    const have = carried[k] ?? 0;
    if (have <= 0) continue;
    const take = Math.min(have, left);
    out[k] = take;
    left -= take;
  }
  return left === 0 ? out : null;
}

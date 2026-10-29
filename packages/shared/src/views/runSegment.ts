import type { ConfigRegistry } from '../config/registry.js';
import type { Seal } from '../config/schemas.js';
import type { SaveState } from '../types/save.js';
import { isWaypoint, nextWaypointAfter } from '../formulas/power.js';
import { liveModStats, runModCount } from '../dungeon/run/runModEffects.js';
import {
  carriedSeals, parseSealKey, sealBuffs, sealDef, sealFitsBiome, sealLive, sealSlots, sealTierDef, sealTierMul, type SealGains,
} from '../economy/seals.js';
import { cfgTextOf, csFixed, csRound, isNum, ordinal, str, type CfgText, type RunViewOptions } from './runCommon.js';

/**
 * ⭐⭐ С-views (29.10): АЛТАРЬ ОТРЕЗКА НА ЭТАЖЕ-МЕТКЕ — модель считает СЕРВЕР.
 *
 * Порт `Altar.SegmentModel` (Unity `Assets/DM/UI/Altar.cs`). Числа — не копии: границы отрезка `isWaypoint`/`nextWaypointAfter`,
 * гнёзда `sealSlots`, живость `sealLive`, свод `sealBuffs`, счёт событий `runModCount` — ровно те функции, которыми потом
 * платит и применяет `Room.altarPick`. Ключи результата — поля C# `SegmentModelView` / `SealCard`.
 *
 * ⚠ ВХОДЫ, КОТОРЫХ СЕРВЕР НЕ ЗНАЕТ САМ: только `picked` — связка, которую игрок набирает «+/−» в открытом окне (до «Применить»).
 * Её присылает клиент запросом предпросмотра; всё прочее (глубина, биом, тир, право настройки, оплаченный отрезок) — факты комнаты.
 */

/** Тексты алтаря отрезка — C# константы `Altar.Segment*`. */
export const RUN_SEGMENT_TEXT = {
  title: 'Алтарь отрезка',
  apply: 'Применить на отрезок',
  asIs: 'Идти как есть',
  noMods: 'Печатей в сумке нет — отрезок пойдёт как есть. Печати падают с элиты, редких, из сундуков и с боссов.',
  free: 'Заход на алтарь бесплатен: можно идти как есть, печать тратится только на вставку.',
  slots: 'Гнёзда',
  summary: 'Что станет на отрезке',
  hint: 'Это алтарь отрезка. Вставь печать — следующие этажи станут опаснее И богаче. Можно и не вставлять.',
  hintId: 'altar',
  paid: 'Оплаченное не отменяется: связка действует до следующей метки.',
  notMine: 'Отрезок настраивает тот, кто начал забег.',
  noAltar: 'Здесь алтаря нет.',
  note: 'Выбранное действует ДО СЛЕДУЮЩЕЙ МЕТКИ, а не на весь забег.',
} as const;

/** C# `SealCard`. */
export interface RunSealCard {
  key: string; name: string; danger: string | null; reward: string | null; desc: string | null;
  carried: number; picked: number;
}

/** C# `SegmentModelView`. */
export interface RunSegmentModel {
  line: string; note: string | null; hint: string | null; paid: boolean; notMine: boolean;
  seals: RunSealCard[]; summary: string[];
  from: number; to: number; slots: number; used: number;
}

/** Факты комнаты для алтаря отрезка — всё, что сервер знает сам. */
export interface RunSegmentFacts {
  /** Глубина этажа (сервер: `Room.depth`; Unity читал `floor.depth`). */
  depth: number;
  /** Биом этажа (сервер: `session.world.biomeId`; Unity — `floor.biomeId`). Нет — печати с привязкой к биому «чужие». */
  biomeId?: string | null;
  /** Тир забега (сервер: `Room.difficultyId`; Unity — `DmClient.TierId`): гнёзда — по рекорду ЭТОГО тира. */
  tierId?: string | null;
  /**
   * Вправе ли этот герой настраивать отрезок (сервер: `Room.mayTuneSegment(pid)`). ⚠ Правило сервера шире правила окна Unity:
   * ушёл начавший забег — настраивают оставшиеся. Нет поля — правило окна Unity по сейву (`run.starter` ≠ `charId`).
   */
  mayTune?: boolean;
  /** Оплаченный отрезок комнаты (сервер: `Room.segment`). Нет поля — `save.run.segment` (у пати он один и тот же). */
  segment?: { from: number; seals: Record<string, number> } | null;
}

/** Строка стороны карточки: число — из свода ОДНОЙ этой печати (C# `SideLine`). */
function sideLine(
  reg: ConfigRegistry, names: ReadonlyMap<string, string>, side: Seal['danger'] | Seal['reward'], mul: number, label: string,
  alone: Readonly<Record<string, number>>,
): string | null {
  const stat = side?.stat;
  if (!stat || !isNum(side.value)) return null;
  const name = names.get(stat) ?? stat;
  const got = alone[stat] ?? 1 + side.value * mul;
  const row = reg.get('run-mod-stats').find((s) => s.id === stat);
  if (row?.unit === 'count') return `${label}: ${name} +${runModCount(got, row.perUnit)}`;
  // ⚠ `(int)Math.Round(...)` C# — округление К ЧЁТНОМУ (`csRound`), а не JS `Math.round`.
  return `${label}: ${name} +${csRound((got - 1) * 100)} %`;
}

/** Имя печати со ступенью (C# `SealName`). */
function sealTitle(reg: ConfigRegistry, tx: CfgText, def: Seal, tierId: string): string {
  const t = sealTierDef(reg, tierId);
  const name = tx('seals', [def.id], 'name', def.name) ?? def.name;
  return t ? `${name} ${tx('balance', ['seals', 'tiers', t.id], 'name', t.name) ?? t.name}` : name;
}

/**
 * Связка словами для уже оплаченного отрезка (C# `BundleLine`): «Кишащий I ×3, Стойкие II» по алфавиту; пусто — «ничего».
 * ⚠ Не `sealBundleLine` ядра: у того нет сортировки и другое слово пустоты, а окно Unity называло связку так.
 */
export function runSealBundleLine(reg: ConfigRegistry, seals: Readonly<Record<string, unknown>>, opts?: RunViewOptions): string {
  const tx = cfgTextOf(reg, opts);
  const parts: string[] = [];
  for (const [key, v] of Object.entries(seals)) {
    const parsed = parseSealKey(key);
    if (!parsed) continue;
    const def = sealDef(reg, parsed.sealId);
    if (!def) continue;
    const n = isNum(v) ? Math.trunc(v) : 1;
    parts.push(sealTitle(reg, tx, def, parsed.tierId) + (n > 1 ? ` ×${n}` : ''));
  }
  parts.sort(ordinal);
  return parts.length > 0 ? parts.join(', ') : 'ничего';
}

/**
 * ⭐⭐ МОДЕЛЬ АЛТАРЯ ОТРЕЗКА (C# `Altar.SegmentModel`). Сервер: `runSegmentView(this.cfg, p.save, { depth: this.depth,
 * biomeId: world.biomeId, tierId: this.difficultyId, mayTune: this.mayTuneSegment(pid), segment: this.segment }, picks)`.
 */
export function runSegmentView(
  reg: ConfigRegistry, save: SaveState, facts: RunSegmentFacts, picked?: Readonly<SealGains> | null, opts?: RunViewOptions,
): RunSegmentModel {
  const tx = cfgTextOf(reg, opts);
  const v: RunSegmentModel = {
    line: '', note: null, hint: null, paid: false, notMine: false, seals: [], summary: [], from: 0, to: 0, slots: 0, used: 0,
  };
  const depth = isNum(facts.depth) ? Math.floor(facts.depth) : 0;
  const access = reg.get('balance').dungeonAccess;
  if (!isWaypoint(depth, access.portalsAt, access.contentCycle)) { v.line = RUN_SEGMENT_TEXT.noAltar; return v; }
  v.from = depth + 1;
  v.to = nextWaypointAfter(depth, access.portalsAt, access.contentCycle);
  v.line = `Отрезок: этажи ${v.from}–${v.to} (до следующей метки)`;
  v.note = RUN_SEGMENT_TEXT.note;
  // ⭐ Ф6: первый заход объясняет. Отметку «видел» ставит сервер (`Room.altarPick` пишет `save.seen`).
  if (!(save.seen ?? []).includes(RUN_SEGMENT_TEXT.hintId)) v.hint = RUN_SEGMENT_TEXT.hint;
  // ⭐⭐ Право настройки — у начавшего забег; факт комнаты (`mayTune`) важнее сейва: ушёл владелец — решают оставшиеся.
  const starter = str(save.run?.starter), mine = str(save.charId);
  const notMine = facts.mayTune !== undefined ? !facts.mayTune : starter !== null && mine !== null && starter !== mine;
  if (notMine) {
    v.notMine = true;
    v.note = RUN_SEGMENT_TEXT.notMine;
    return v;
  }
  const paid = facts.segment !== undefined ? facts.segment : save.run?.segment;
  if (paid && isNum(paid.from) && paid.from === v.from && paid.seals && typeof paid.seals === 'object' && Object.keys(paid.seals).length > 0) {
    v.paid = true;
    v.line = `Отрезок ${v.from}–${v.to} уже настроен: ${runSealBundleLine(reg, paid.seals, opts)}`;
    v.note = RUN_SEGMENT_TEXT.paid;
    return v;
  }
  const tierId = facts.tierId ?? null;
  const rec = tierId !== null ? save.difficultyProgress?.[tierId] : undefined;
  v.slots = sealSlots(reg, isNum(rec) ? Math.floor(rec) : 0);

  const carried = carriedSeals(save.inventory ?? []);
  const live = liveModStats(reg);
  const names = new Map<string, string>();
  for (const s of reg.get('run-mod-stats')) names.set(s.id, tx('run-mod-stats', [s.id], 'name', s.name || s.id) || s.id);
  const biome = facts.biomeId ?? undefined;
  const pick: SealGains = { ...(picked ?? {}) };
  let alien = 0;
  for (const [key, n] of Object.entries(carried)) {
    const parsed = parseSealKey(key);
    if (!parsed) continue;
    const def = sealDef(reg, parsed.sealId);
    const mul = sealTierMul(reg, parsed.tierId);
    if (!def || mul <= 0 || !sealLive(reg, def, live)) continue;   // мёртвый вид — не предлагаем
    if (!sealFitsBiome(def, biome)) { alien += n; continue; }
    const got = pick[key] ?? 0;
    const solo = sealBuffs(reg, { [key]: 1 }, biome) as Readonly<Record<string, number>>;
    v.used += got;
    v.seals.push({
      key,
      name: sealTitle(reg, tx, def, parsed.tierId),
      danger: sideLine(reg, names, def.danger, mul, 'Опаснее', solo),
      reward: sideLine(reg, names, def.reward, mul, 'Богаче', solo),
      desc: tx('seals', [def.id], 'desc', def.desc),
      carried: n,
      picked: got,
    });
  }
  v.seals.sort((a, b) => ordinal(a.name, b.name));
  if (alien > 0) v.note = `${v.note === null ? '' : v.note + ' '}Печатей другого биома в сумке: ${alien} — здесь они не действуют.`;
  // Свод — ТЕМИ ЖЕ числами, что применит сервер (потолки по статам, допуск связки, биом этажа).
  const buffs = sealBuffs(reg, pick, biome) as Readonly<Record<string, number>>;
  const rows = new Map(reg.get('run-mod-stats').map((s) => [s.id as string, s]));
  for (const [stat, mulv] of Object.entries(buffs)) {
    if (mulv <= 1.0000001) continue;
    const nm = names.get(stat) ?? stat;
    const row = rows.get(stat);
    if (row?.unit === 'count') {
      const k = runModCount(mulv, row.perUnit);
      if (k > 0) v.summary.push(`${nm} +${k}`);
      continue;
    }
    v.summary.push(`${nm} ×${csFixed(mulv, 2)}`);
  }
  v.summary.sort(ordinal);
  return v;
}

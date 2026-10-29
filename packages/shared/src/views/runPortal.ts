import type { ConfigRegistry } from '../config/registry.js';
import type { SaveState } from '../types/save.js';
import {
  WAYPOINT_ENTRY_DEPTH, bandDepth, carriedGear, depthRecordOf, effectiveLevel, floorMonsterLevel, isDifficultyUnlocked, isWaypoint,
  openWaypoints, type PowerBreakdown, type WaypointPlaces,
} from '../formulas/power.js';
import { cfgTextOf, isNum, jsNum, orStr, str, type CfgText, type RunViewOptions } from './runCommon.js';

/**
 * ⭐⭐ С-views (29.10): ОКНО «ПОРТАЛ» ГОРОДА — модель считает СЕРВЕР, Unity её только рисует.
 *
 * Порт `Altar.Model` + `Altar.ChainMap` (Unity `Assets/DM/UI/Altar.cs`), а под ними — НЕ копии, а те же чистые функции, что у
 * сервера: мощь — `effectiveLevel`/`carriedGear`, метки — `openWaypoints`/`isWaypoint`/`bandDepth`, уровень монстров —
 * `floorMonsterLevel`, замок тира — `isDifficultyUnlocked`. Ключи результата — РОВНО имена публичных полей C#-классов
 * (`AltarModel`, `AltarTier`, `AltarChainMap`, `ChainNode`, `ChainLink`, `ChainStrand`, `ChainBoss`, `ChainDivider`, `AltarStart`,
 * `AltarChip`, `PowerBreakdown`), в порядке их объявления: `JToken.ToObject<AltarModel>()` заполняет модель как есть.
 *
 * ⚠ ВЫБОР ИГРОКА (`AltarSel`: биом-чип и узел цепи) живёт, пока окно открыто, — это единственный вход, которого сервер сам не знает.
 * Его присылает клиент (см. `RunPortalSel`), сервер отвечает моделью; кадр «Войти» (`descend`) сервер по-прежнему ЗАЖИМАЕТ сам
 * (`Room.startDepthOf` → `waypointStart`), так что выбор — лишь просьба.
 */

/** Выбор у портала (C# `AltarSel`): биом и стартовая метка. Нет поля — умолчание окна (первый биом, вход). */
export interface RunPortalSel {
  biome?: string | null;
  depth?: number;
}

/** C# `AltarChip`. */
export interface RunAltarChip { id: string | null; name: string | null; title: string | null; active: boolean }

/** C# `ChainNode`. */
export interface RunChainNode {
  depth: number; place: number; x: number; y: number; level: number;
  open: boolean; pick: boolean; entry: boolean;
  label: string; title: string;
}
/** C# `ChainBoss`. */
export interface RunChainBoss { depth: number; x: number; y: number; level: number; rank: string; mark: string; title: string }
/** C# `ChainStrand` (`points` — `List<Vector2Int>`: объекты `{x, y}`). */
export interface RunChainStrand { points: { x: number; y: number }[]; main: boolean }
/** C# `ChainLink`. */
export interface RunChainLink {
  from: number; to: number; strands: RunChainStrand[]; boss: RunChainBoss | null;
  gapText: string | null; gapX: number; gapY: number;
}
/** C# `ChainDivider`. */
export interface RunChainDivider { y: number; circle: number; label: string }
/** C# `AltarChainMap`. */
export interface RunAltarChainMap {
  nodes: RunChainNode[]; links: RunChainLink[]; dividers: RunChainDivider[];
  width: number; height: number; r: number; cycle: number; record: number; openCount: number; pick: number;
  start: string; hidden: string | null; hiddenMarks: number[];
  /** ⭐ С6: подписи скрытых меток (`runHiddenMarkTitle`) — по одной на `hiddenMarks`: своего правила у окна нет. */
  hiddenTitles: string[];
}
/** C# `AltarStart`. */
export interface RunAltarStart { depth: number; line: string; note: string }
/** Кадр спуска (C# `JObject descend/restart`) — порядок ключей как у веба: `t`, `difficultyId`, `startDepth`, `runConfig`. */
export interface RunDescendFrame {
  t: 'descend'; difficultyId: string; startDepth: number;
  runConfig: { biomeId?: string; modifiers: string[] };
}
/** C# `AltarTier`. */
export interface RunAltarTier {
  id: string; name: string; meta: string; line: string; variant: string | null; lockText: string | null;
  unlocked: boolean; descend: RunDescendFrame | null; restart: RunDescendFrame | null;
  map: RunAltarChainMap | null; start: RunAltarStart | null;
}
/** C# `AltarModel`. */
export interface RunAltarModel {
  power: PowerBreakdown;
  head: string;
  biomeNote: string | null;
  biomes: RunAltarChip[];
  templates: RunAltarChip[];
  mods: RunAltarChip[];
  tiers: RunAltarTier[];
}

// ── цепь меток (C# `Altar.ChainMap`, веб `altarMapLayout.altarChainView`) ──────────────────────────
/** Геометрия цепи — C# `Chain*` константы, веб `CHAIN_GEOM`. */
export const RUN_CHAIN_GEOM = { width: 300, stepY: 66, r: 14, amp: 32, pad: 34, samples: 11, maxMarks: 48 } as const;
/** Таблица «синуса» ×100 — замена `Math.sin` ради паритета (целые операции заданы стандартом бит в бит и в JS, и в C#). */
const WAVE = [0, 38, 71, 92, 100, 92, 71, 38, 0, -38, -71, -92, -100, -92, -71, -38] as const;

/** Целый хеш глубины (`ChainHash`): одна глубина — всегда один изгиб. */
export function runChainHash(n: number): number {
  let h = Math.imul(n | 0, 2654435761) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519) >>> 0;
  h ^= h >>> 13;
  return h >>> 0;
}

function bezier(p0: number, c0: number, c1: number, p1: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * c0 + 3 * u * t * t * c1 + t * t * t * p1;
}

/** Знак ранга (`BossRankMark`). */
export function runBossRankMark(rank: string): string {
  return rank === 'act' ? '★' : rank === 'strong' ? '✧✧' : '✦';
}
/** Ранг словами (`BossRankName`). */
export function runBossRankName(rank: string): string {
  return rank === 'act' ? 'актовый босс' : rank === 'strong' ? 'крепкий босс' : 'мини-босс';
}

/**
 * Цепь меток одного тира (C# `Altar.ChainMap`). `marks` — уже посчитанный `openWaypoints`: цепь доступ не решает.
 * `places` — настройка мест порталов КАК ЕСТЬ (`balance.dungeonAccess.portalsAt`), её нормализует `isWaypoint`.
 */
export function runChainMap(
  marks: readonly number[], record: number, places: WaypointPlaces, cycle: number,
  ladder: readonly { at: number; rank?: string }[] | null | undefined, pick: number, levelOf: ((depth: number) => number) | null, widthMax = 3,
): RunAltarChainMap {
  const G = RUN_CHAIN_GEOM;
  const c = cycle > 0 ? Math.floor(cycle) : 1;
  const rec = Math.max(0, Math.floor(record));
  const open = new Set(marks);
  const rankAt = new Map<number, string>();
  for (const x of Array.isArray(ladder) ? ladder : []) if (isNum(x?.at)) rankAt.set(Math.floor(x.at), str(x.rank) ?? 'mini');
  const lanesCap = Math.max(1, Math.min(3, Math.floor(widthMax)));
  const lv = (d: number): number => (levelOf ? levelOf(d) : 0);
  const map: RunAltarChainMap = {
    nodes: [], links: [], dividers: [],
    width: G.width, height: 0, r: G.r, cycle: c, record: rec, openCount: marks.length, pick,
    start: '', hidden: null, hiddenMarks: [], hiddenTitles: [],
  };

  const all = [...marks].sort((a, b) => a - b);
  const skip = Math.max(0, all.length - G.maxMarks);
  for (let i = 0; i < skip; i++) { map.hiddenMarks.push(all[i]!); map.hiddenTitles.push(runHiddenMarkTitle(all[i]!)); }

  const cx = G.width / 2;
  for (let i = skip; i < all.length; i++) {
    const depth = all[i]!;
    const idx = i - skip;
    const wave = WAVE[idx % WAVE.length]!;
    const jitter = (runChainHash(depth) % 41) - 20;
    const x = Math.round(cx + (wave * G.amp * 3) / 400 + (jitter * G.amp) / 100);
    const y = G.pad + idx * G.stepY;
    const level = lv(depth);
    const entry = depth === WAYPOINT_ENTRY_DEPTH;
    const isOpen = open.has(depth);
    map.nodes.push({
      depth, place: bandDepth(depth, c), x, y, level, open: isOpen, pick: depth === pick, entry,
      label: String(depth),
      title: `${entry ? 'Вход' : 'Портал'} — этаж ${depth}, монстры ур. ${level}. `
        + (isOpen ? 'Можно начать отсюда.' : `Закрыт: ваш рекорд ${rec}.`),
    });
  }

  for (let i = 1; i < map.nodes.length; i++) {
    const a = map.nodes[i - 1]!;
    const b = map.nodes[i]!;
    // Босс между метками: при совпадении с порталом уступает БОСС — то же правило, что у генератора (`bossRankAt`).
    let boss: RunChainBoss | null = null;
    for (let d = a.depth + 1; d < b.depth; d++) {
      if (isWaypoint(d, places, c)) continue;
      const rank = rankAt.get(bandDepth(d, c));
      if (rank === undefined) continue;
      const l = lv(d);
      boss = {
        depth: d, x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2), level: l,
        rank, mark: runBossRankMark(rank), title: `${runBossRankName(rank)} — этаж ${d}, монстры ур. ${l}`,
      };
      break;
    }
    const between = b.depth - a.depth - 1;
    const lanes = boss || between <= 0 ? 1 : 1 + (runChainHash(b.depth * 3) % lanesCap);
    const link: RunChainLink = { from: a.depth, to: b.depth, strands: [], boss, gapText: null, gapX: 0, gapY: 0 };
    const mainIdx = (lanes - 1) >> 1;
    for (let l = 0; l < lanes; l++) {
      const spread = 20 + (runChainHash(b.depth + l) % 14);
      const off = Math.round((l - (lanes - 1) / 2) * spread);
      const x1 = a.x, y1 = a.y + G.r, x2 = b.x, y2 = b.y - G.r;
      const c1x = x1 + off, c1y = y1 + Math.round(G.stepY * 0.42);
      const c2x = x2 + off, c2y = y2 - Math.round(G.stepY * 0.42);
      const points: { x: number; y: number }[] = [];
      for (let s = 0; s < G.samples; s++) {
        const t = s / (G.samples - 1);
        points.push({ x: Math.round(bezier(x1, c1x, c2x, x2, t)), y: Math.round(bezier(y1, c1y, c2y, y2, t)) });
      }
      link.strands.push({ points, main: l === mainIdx });
    }
    if (!boss && between > 0) {
      link.gapText = `${between} эт.`;
      link.gapX = Math.round((a.x + b.x) / 2) + 20;
      link.gapY = Math.round((a.y + b.y) / 2);
    }
    map.links.push(link);
    // ⚠ Разделитель — на ЗВЕНЕ, пересекающем границу круга: узла с местом 1 не бывает (первое место круга не портал).
    const cirA = Math.ceil(a.depth / c), cirB = Math.ceil(b.depth / c);
    if (cirB > cirA) map.dividers.push({ y: Math.round((a.y + b.y) / 2), circle: cirB, label: `круг ${cirB}` });
  }

  map.height = map.nodes.length > 0 ? map.nodes[map.nodes.length - 1]!.y + G.pad : G.pad * 2;
  map.start = `Старт: этаж ${pick} · монстры ур. ${lv(pick)}`
    + (map.openCount > 1 ? ` · открыто меток: ${map.openCount}` : ' · других меток пока нет');
  map.hidden = map.hiddenMarks.length > 0
    ? `Выше ещё меток: ${map.hiddenMarks.length} (этажи 1–${map.hiddenMarks[map.hiddenMarks.length - 1]})`
    : null;
  return map;
}

// ── модель окна (C# `Altar.Model`) ──────────────────────────────────────────────────────────────
/** Тексты окна «Портал» — C# константы `Altar.*` (их рисует панель, модель их не несёт). */
export const RUN_PORTAL_TEXT = {
  title: 'Портал',
  arenaButton: '⚔ PvP-арена (дуэль)',
  arenaNote: 'Круглый зал: спавн в разных концах, урон по друг другу, гибель без потерь.',
  biomeSection: 'Куда лететь (биом)',
  restartButton: 'Начать сначала — этаж 1',
  restartNote: 'Спуск с самого верха: первый отрезок без настроек, алтарь ждёт на метке.',
  tiersSection: 'Маршрут — жмите «Войти»',
} as const;

/** Подпись тултипа скрытой метки (тот же текст, что у узла цепи) — Unity `AltarPanel` собирал его сам. */
export function runHiddenMarkTitle(depth: number): string {
  return `Портал — этаж ${depth}. Можно начать отсюда.`;
}

/** Сейв как его читал C#-порт: недостающие поля — пустые (сервер всегда шлёт полный, но вид не должен падать на старом). */
function powerSave(save: SaveState): SaveState {
  return {
    ...save,
    level: isNum(save.level) ? save.level : 0,
    equipment: save.equipment ?? {},
    masteries: save.masteries ?? {},
    inventory: save.inventory ?? [],
    belt: save.belt ?? [],
    attributes: save.attributes ?? ({} as SaveState['attributes']),
  };
}

/**
 * ⭐⭐ МОДЕЛЬ ОКНА «ПОРТАЛ» (C# `Altar.Model`). Сервер: `runPortalView(this.cfg, player.save, sel)`.
 *
 * `sel` — выбор окна (биом и метка), его присылает клиент; правится как в C#: пропавший биом — первый включённый, метка, которой
 * у тира нет, — вход. Модификаторов в портале нет (Ф3), `runConfig.modifiers` всегда пуст.
 */
export function runPortalView(reg: ConfigRegistry, rawSave: SaveState, sel: RunPortalSel = {}, opts?: RunViewOptions): RunAltarModel {
  const tx: CfgText = cfgTextOf(reg, opts);
  const save = powerSave(rawSave);
  const diffs = reg.get('difficulties');
  const balance = reg.get('balance');
  const pw = effectiveLevel(save, balance.power, carriedGear(save), reg.get('item-tiers'));
  const access = balance.dungeonAccess;
  const cycle = Number.isFinite(access.contentCycle) ? Math.max(0, Math.floor(access.contentCycle)) : 0;
  const places: WaypointPlaces = access.portalsAt;
  const m: RunAltarModel = {
    power: { level: pw.level, gearBonus: pw.gearBonus, passiveBonus: pw.passiveBonus, total: pw.total },
    head: `Мощь персонажа: ${pw.total} (ур. ${pw.level} + гир +${pw.gearBonus} + мастерства +${pw.passiveBonus})`,
    biomeNote: null, biomes: [], templates: [], mods: [], tiers: [],
  };

  const biomes = reg.get('biomes').filter((b) => b.enabled !== false);
  let biome = sel.biome ?? null;
  if (biomes.length > 0 && !biomes.some((b) => b.id === biome)) biome = biomes[0]!.id;
  const tag = (b: (typeof biomes)[number]): string | null =>
    orStr(tx('biomes', [b.id], 'tagline', str((b as { tagline?: unknown }).tagline)), tx('biomes', [b.id], 'desc', str((b as { desc?: unknown }).desc)));
  for (const b of biomes) m.biomes.push({ id: b.id, name: tx('biomes', [b.id], 'name', b.name), title: tag(b), active: b.id === biome });
  const cur = biomes.find((b) => b.id === biome);
  m.biomeNote = cur ? tag(cur) : null;

  const progress = save.difficultyProgress ?? {};
  const widthMax = isNum(access.width?.max) ? Math.floor(access.width.max) : 3;
  for (let i = 0; i < diffs.length; i++) {
    const diff = diffs[i]!;
    if (diff.enabled === false) continue;   // индекс i сохраняем — цепочка открытия цела
    const unlocked = isDifficultyUnlocked(diffs, i, progress);
    const prev = i > 0 ? diffs[i - 1] : undefined;
    const tier: RunAltarTier = {
      id: diff.id, name: tx('difficulties', [diff.id], 'name', diff.name) ?? diff.name,
      meta: `золото ×${jsNum(diff.goldMult)} · редкость ×${jsNum(diff.magicFind)}`,
      line: `Монстры на 1-м этаже — ур. ${floorMonsterLevel(diff, 1)}, глубже — сложнее.`,
      variant: null, lockText: null, unlocked, descend: null, restart: null, map: null, start: null,
    };
    if (unlocked) {
      tier.variant = i >= 2 ? 'danger' : 'primary';
      const marks = openWaypoints(progress, diff.id, places, cycle);
      const want = sel.depth ?? WAYPOINT_ENTRY_DEPTH;
      const pick = marks.includes(want) ? want : WAYPOINT_ENTRY_DEPTH;   // выбор от другого тира не переносим
      tier.map = runChainMap(marks, depthRecordOf(progress, diff.id), places, cycle, access.bossLadder, pick, (d) => floorMonsterLevel(diff, d), widthMax);
      const have = progress[diff.id];
      tier.start = {
        depth: pick,
        line: tier.map.start,
        note: '⌂ — портал (отсюда можно начать), ✦/✧✧/★ — мини/крепкий/актовый босс. '
          + `Открыты метки не глубже ВАШЕГО рекорда (${isNum(have) ? jsNum(have) : '0'}). `
          + 'В пати старт зажимается по самому мелкому рекорду — точную глубину назовёт окно голосования.',
      };
      const rc = (): RunDescendFrame['runConfig'] => ({ ...(biome != null ? { biomeId: biome } : {}), modifiers: [] });
      tier.descend = { t: 'descend', difficultyId: diff.id, startDepth: pick, runConfig: rc() };
      tier.restart = { t: 'descend', difficultyId: diff.id, startDepth: WAYPOINT_ENTRY_DEPTH, runConfig: rc() };
    } else {
      const have = progress[prev?.id ?? ''];
      const prevName = prev ? tx('difficulties', [prev.id], 'name', prev.name) : null;
      tier.lockText = `🔒 Пройди этаж ${jsNum(diff.unlockFloor)} на «${prevName ?? '—'}» (сейчас ${isNum(have) ? jsNum(have) : '0'})`;
    }
    m.tiers.push(tier);
  }
  return m;
}

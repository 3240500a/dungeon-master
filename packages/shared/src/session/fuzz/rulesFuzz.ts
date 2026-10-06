import { ConfigRegistry } from '../../config/registry.js';
import { createRng, type Rng } from '../../formulas/rng.js';
import { abilityCooldown, swingHalfWidth } from '../../formulas/combat.js';
import { buffRestFloor, buffUptimeBound, insertGain } from '../../formulas/buffTiming.js';
import { skillWeaponAllowed } from '../../formulas/skills.js';
import { attackWeaponsOf } from '../../formulas/playerCombat.js';
import { asHeld, gripOf } from '../../formulas/versatile.js';
import { generateItem, itemFromBaseId } from '../../formulas/itemgen.js';
import { shapeFoundWeapon } from '../../formulas/craft.js';
import { xpForLevel, levelForXp } from '../../formulas/xp.js';
import { newCharacterSave, fitToClass } from '../../economy/newCharacter.js';
import { allocActive, allocAttr, equip, unequip, respecSkills, socketInsert, socketClear } from '../../economy/townActions.js';
import { addToInventory } from '../../inventory/grid.js';
import { ATTRIBUTES, type StatModifier } from '../../types/attributes.js';
import type { Item, RolledAffix } from '../../types/items.js';
import type { DropPayload } from '../../types/world.js';
import type { SaveState } from '../../types/save.js';
import { generateRunPlan } from '../../dungeon/run/generateRunPlan.js';
import type { RunPlan, RunNode } from '../../dungeon/run/types.js';
import { generateFloor } from '../../dungeon/generateFloor.js';
import { decorSpecsFor, obstaclesFromDecor } from '../../dungeon/decor.js';
import { resolveMonsterPool } from '../../dungeon/floorSpec.js';
import { spawnPacksEl } from '../../dungeon/floor.js';
import type { DungeonLayout } from '../../dungeon/floorCommon.js';
import { townLayout } from '../../dungeon/town.js';
import { Cell, TILE, isBlockedCell, makeGrid, cellToWorld, type Grid } from '../../world/grid.js';
import { hasLineOfSight, sightBlockedByObstacles } from '../../world/lineOfSight.js';
import { moveWithCollision, pushOutObstacle, type Vec2 } from '../../world/movement.js';
import { addDebuffStack, debuffMods } from '../../world/debuffs.js';
import { findPath } from '../../world/pathfind.js';
import { wrapAngle } from '../../world/fastMath.js';
import type { PlayerEntity, MonsterEntity, ProjectileEntity, Obstacle, DropEntity } from '../../world/state.js';
import { GameSession, type PlayerInput, type SessionEvent, type FloorLayout } from '../session.js';
import { playerSnapshot, type PlayerSnapshot } from '../derive.js';
import { activeAbilityOf, effectivePool, reservedFrac, toggleBuffMods } from '../toggles.js';
import { resolveActive, socketsOpen, insertUnlocked, type ResolvedActive } from '../inserts.js';
import { bodyOf, putBody, arenaReturn, arenaAwayBody, keepLaterCooldowns, savedCooldowns, vitalsForSave, type ArenaHome, type HeroBody } from '../heroBody.js';
import { validateInput } from '../netSchemas.js';
import { behaviorFor } from '../behavior.js';

/**
 * ⭐ B2: ФАЗЗЕР ПРАВИЛ ИГРЫ — модель и инварианты (тест: `rulesFuzz.test.ts`).
 *
 * Вместо ручного обзора круг за кругом — случайные цепочки НАСТОЯЩИХ действий над настоящим `GameSession`: этажи из генератора
 * забега (биомы, шаблоны, двери с рычагами, сундуки, декор-преграды) и компактная «арена» (стена с дверью, колонны, диагональный
 * шов, преграды, сундук за дверью, чужая добыча), 1–3 героя разных классов с выученными скилами, вставками, снаряжением (двуруч,
 * пара одноручных, полуторное со щитом, луки, арбалеты, жезлы, посохи, кулаки), монстры из настоящих пулов. Шаги — кадры ввода в
 * рамке сетевой схемы (`validateInput`: вектор любой длины, взгляд любым числом, атака/каст/рывок/[E]/пояс в любом сочетании,
 * каст выученного и НЕвыученного, мусорные id), команды по id с любого расстояния (сундук, рычаг, подбор), зелья, выброс, смена
 * снаряжения/гнёзд/скилов посреди замаха, удержание сейва сервером, спуск на новый этаж.
 *
 * НАБЛЮДЕНИЕ, А НЕ ПРАВКА: наблюдатель (`instrument`) оборачивает приватные методы ЭКЗЕМПЛЯРА сессии (удар, каст, подбор…) —
 * вызывает оригинал с теми же аргументами и записывает, где кто стоял, что оплачено, чем и кого ударили. Поведение не меняется.
 * Числа правил — из конфига (`balance.melee`, `balance.autoPickup`, `balance.dodge`, дерево скилов, вставки) и из констант
 * ядра, которые конфигом не являются (радиусы [E] 48 и сундука/рычага 56, радиус снаряда 16, нова по умолчанию 130).
 *
 * Шаги строятся из сида и от состояния не зависят; конкретику (какой сундук, куда идти, чем бить) шаг выбирает по миру в момент
 * исполнения. Поэтому сжатие (`shrink`) выбрасывает шаги, и оставшиеся остаются осмысленными. Только для тестов.
 *
 * ИНВАРИАНТЫ (после каждого тика и каждой команды):
 *  I1 — движение: смещение за тик ввода не больше скорости × dt (рывок — своей скоростью), центр не в стене, круг не в стене,
 *       не в другую связную область (сквозь стену/закрытую дверь), не через диагональный шов; мёртвый не двигается.
 *  I2 — урон: только в дальности/дуге/видимости удара (мили — по `balance.melee` × оружие × скил; нова, прыжок, рывок, снаряд,
 *       проклятие — своей геометрией), только надетым оружием и с тем снаряжением, с которым начат замах (R6-02); PvP — только на арене;
 *       снаряд (героя и монстра) не пролетает стену, шов и колонну, закрывающую обзор, и бьёт только видимое с места полёта (C-10);
 *       мёртвый доставку не начинает (`dead-attacker`), а погибший внутри своей (прок цели «при получении удара» в PvP) доносит её до
 *       остальных целей — как стрелу в полёте (V-RF-04, ⭐ Z).
 *  I3 — темп: удар/атака-скил не чаще общего лока по формуле скорости, скил — не чаще своего отката; серия — не больше `hits`;
 *       ⚠ R23-05: и откат не длиннее часов героя (`skill-cd-long`: конец — от того тика, где он встал) — в теле после любого перехода, в
 *       сейве ухода (`vitalsForSave`) и в теле входа по коду (`arenaAwayBody`): тело города на время арены стареет временем арены.
 *  I4 — скилы и ресурсы: невыученное (ранг 0), чужого класса и не тем оружием не срабатывает; цена списана и была по карману;
 *       ресурсы не отрицательны; тоглы — только выученные; бафф — не дольше длительности и не поверх отката. ⭐ D4: ОДНО ПРАВИЛО ВРЕМЕНИ
 *       БАФФА (`formulas/buffTiming.ts`) по ЧАСАМ ГЕРОЯ (время, пока он в мире и жив: у ушедшего и павшего время стоит, R4-06) — у узлов древа и у печатей
 *       вставок (`ins:`; зелья `pot:` — расходник, не правило): срабатывание не поверх идущего (`buff-refresh`), не раньше «действие ×
 *       (1 + buffMinRest)» от прошлого (`buff-rest`), и под каждым баффом за весь прогон — не больше «одно действие + 1 / (1 + buffMinRest)
 *       часов героя с первого срабатывания» (`buff-uptime`), через круги на арену (шаг `arena`: тела `session/heroBody.ts`, как у комнаты) и
 *       переподключения (шаг `reconnect`: тело ухода, мир без него, вход по коду).
 *  I5 — взаимодействие и добыча: подбор/сундук/рычаг — в радиусе и видимости, живым, не оглушённым (кроме автоподбора), чужое
 *       не берётся; дверь открывает только её рычаг; добыча не пропадает и не двоится (uid уникальны); золото — ровно поднятое;
 *       сейв под транзакцией тиком не трогается; зелье без эффекта не тратится.
 *  I6 — прокачка и пулы: опыт только за убийство (сумма = опыт монстра), уровень и очки — по таблице; атрибуты/скилы тиком не
 *       меняются; здоровье/мана/выносливость не выше максимума (мана и выносливость — и не выше резерва аур/стоек); левелап лечит
 *       до максимума С аурами/стойками/баффами, и снимок тика до его конца их держит (R15-10); ⭐ R20-07: сумка мёртвого не растёт
 *       (`dead-bag-grew`: ни тиком, ни командой подбора — поднятое мимо броска штрафа смерти).
 *  I7 — ничего не бросает, числа конечны.
 *  M1/M2 — монстры: не сквозь стены/закрытые двери, ближний удар монстра — в досягаемости и видимости; ⚠ R21-06: взрыв конструкта
 *       при смерти — в радиусе (монстр + 48 + герой) и в видимости от монстра (`blast-range`, `blast-los`; профиль мира `constructs` —
 *       вариант конфига, где все монстры — конструкты: в поставке путь скрытый).
 */

// ── Шаги ──────────────────────────────────────────────────────────────────────────────────────────

export type OpKind =
  | 'tick' | 'chest' | 'lever' | 'pickup' | 'drink' | 'drop' | 'equip' | 'unequip' | 'socket' | 'allocSkill'
  | 'respecSkills' | 'allocAttr' | 'hold' | 'revive' | 'descend' | 'stun' | 'arena' | 'reconnect' | 'dot';

/** Шаг цепочки: вид, чей герой (берётся по модулю числа героев), сид его бросков. */
export interface Op { k: OpKind; h: number; s: number }

/**
 * Веса видов шагов. Тик — основной (в нём ввод, бой, [E], пояс, рывки); команды — реже. `stun` — модель оглушения героя: сегодня
 * его не ставит ни один путь игры (только тесты), но правила «оглушённый не…» в ядре есть — вес маленький, нарушение с ним
 * отмечается как скрытое (латентное). ⚠ R21-06: `dot` — модель «статус героя добивает монстра, а герой тем временем отошёл за укрытие
 * рядом с ним» (путь взрыва конструкта за стену); вес — только в профиле `constructs` (ноль здесь не меняет поток шагов других профилей).
 */
export const OP_WEIGHTS: Record<OpKind, number> = {
  tick: 40, chest: 4, lever: 3, pickup: 5, drink: 3, drop: 2, equip: 5, unequip: 2, socket: 3, allocSkill: 2,
  respecSkills: 2, allocAttr: 1, hold: 2, revive: 1, descend: 2, stun: 1, arena: 2, reconnect: 2, dot: 0,
};

/** Цепочка шагов из сида: виды по весам, от состояния не зависит (сжатие это и требует). */
export function genOps(seed: number, len: number, weights: Partial<Record<OpKind, number>> = OP_WEIGHTS): Op[] {
  const r = createRng((seed * 2654435761) >>> 0 || 1);
  const kinds = Object.entries(weights).filter(([, w]) => (w ?? 0) > 0) as [OpKind, number][];
  const total = kinds.reduce((s, [, w]) => s + w, 0);
  const out: Op[] = [];
  for (let i = 0; i < len; i++) {
    let roll = r.next() * total;
    let k = kinds[kinds.length - 1]![0];
    for (const [kind, w] of kinds) { roll -= w; if (roll < 0) { k = kind; break; } }
    out.push({ k, h: r.int(0, 2), s: r.int(1, 2 ** 31 - 1) });
  }
  return out;
}

// ── Общие мелочи ──────────────────────────────────────────────────────────────────────────────────

/** Шаг сервера (`Room.TICK_DT`): мир всегда идёт 1/30 с. */
export const TICK_DT = 1 / 30;
/**
 * Константы ядра, которые не конфиг (session.ts): радиус [E] и клика по дропу, сундука/рычага, снаряда, новы по умолчанию, запас
 * взрыва конструкта сверх радиуса монстра (R21-06).
 */
const PICK_R = 48;
const USE_R = 56;
const PROJ_R = 16;
const NOVA_R = 130;
const BLAST_R = 48;
const EPS = 1e-6;

let REG: ConfigRegistry | undefined;
/**
 * ⚠ C-11 (бафф-зелья): колбы с баффом (`use.buffMods`). В поставке таких нет — ветка скрытая, её включит первая же правка редактора;
 * фаззер держит две свои: «спешка» — только бафф (скорость атаки и бега), «сила» — лечение + бафф (максимум здоровья и маны:
 * истечение подрезает пулы). Выключены (`enabled: false`): ни добыча монстров, ни случайный выбор базы их не берут — поток бросков
 * мира прежний (сиды стендов те же); в пояс и сумку их кладёт только набор героя (`POTIONS`).
 */
export const BUFF_POTIONS = ['fuzz-haste-potion', 'fuzz-vigor-potion'] as const;
/** Реестр один на процесс: фаззер конфиг не правит (правки живьём — у фаззера экономики); свои только бафф-колбы (C-11). */
export function fuzzReg(): ConfigRegistry {
  if (!REG) REG = buildReg();
  return REG;
}

let REG_CONSTRUCTS: ConfigRegistry | undefined;
/**
 * ⚠ R21-06: ВАРИАНТ КОНФИГА «КОНСТРУКТЫ» (профиль мира `constructs`) — все монстры фракции `monster`: её профиль в `monster-behaviors`
 * (поставка) — сигнатура `overload`, взрыв при смерти по героям рядом. В поставке все монстры — нежить, и путь взрыва скрытый: его
 * откроет первый же конструкт редактора. Реестр свой — поток бросков общего профиля прежний (сиды стендов те же).
 */
export function fuzzRegConstructs(): ConfigRegistry {
  if (!REG_CONSTRUCTS) {
    REG_CONSTRUCTS = buildReg();
    REG_CONSTRUCTS.reload({ monsters: REG_CONSTRUCTS.get('monsters').map((m) => ({ ...m, faction: 'monster' })) });
  }
  return REG_CONSTRUCTS;
}

function buildReg(): ConfigRegistry {
  const reg = new ConfigRegistry();
  reg.loadAll();
  const tpl = reg.get('items.base').find((b) => b.id === 'healing-potion')!;
  const pot = (id: string, use: Record<string, unknown>) => ({
    ...structuredClone(tpl), id, name: id, enabled: false, dropWeight: 0,
    use: { heal: 0, healPct: 0, mana: 0, manaPct: 0, cure: false, ...use },
  });
  reg.reload({
    'items.base': [
      ...reg.get('items.base'),
      pot(BUFF_POTIONS[0], { buffMods: [{ stat: 'attackSpeed', kind: 'increased', value: 0.3 }, { stat: 'moveSpeed', kind: 'increased', value: 0.25 }], buffDurationSec: 6 }),
      pot(BUFF_POTIONS[1], { heal: 40, buffMods: [{ stat: 'maxHp', kind: 'flat', value: 60 }, { stat: 'maxMana', kind: 'flat', value: 30 }], buffDurationSec: 4 }),
    ],
  });
  // Скорость по направлению хода (07.10) — выключена: сжатые перепрогоны (R21-06 и др.) записаны по прежним позициям.
  // Потолок скорости сторожа верен и с ней (множитель ≤ 1 по схеме).
  reg.reload({ balance: { ...reg.get('balance'), moveDir: { ...reg.get('balance').moveDir, enabled: false } } });
  return reg;
}

/** Бафф зелья по определению базы в конфиге (C-11) — независимо от ядра: моды и длительность; нет — `undefined`. */
function potionBuffDef(reg: ConfigRegistry, baseId: string): { mods: StatModifier[]; durationSec: number } | undefined {
  const b = reg.get('items.base').find((x) => x.id === baseId);
  const u = b?.kind === 'consumable' ? b.use : undefined;
  return u?.buffMods?.length && (u.buffDurationSec ?? 0) > 0 ? { mods: u.buffMods, durationSec: u.buffDurationSec! } : undefined;
}

const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
const fmt = (p: Vec2): string => `(${p.x.toFixed(1)},${p.y.toFixed(1)})`;
const cellOf = (p: Vec2): { cx: number; cy: number } => ({ cx: Math.floor(p.x / TILE), cy: Math.floor(p.y / TILE) });
const finite = (n: unknown): boolean => typeof n === 'number' && Number.isFinite(n);

/** Связные области проходимых клеток (4-связность; дверь закрыта — стена). Сквозь стену/дверь область не меняется никогда. */
export class Regions {
  readonly cols: number;
  readonly rows: number;
  readonly id: Int32Array;
  constructor(readonly grid: Grid) {
    this.rows = grid.length;
    this.cols = grid[0]?.length ?? 0;
    this.id = new Int32Array(this.cols * this.rows).fill(-1);
    let n = 0;
    const q: number[] = [];
    for (let y = 0; y < this.rows; y++) for (let x = 0; x < this.cols; x++) {
      if (this.id[y * this.cols + x] !== -1 || isBlockedCell(grid, x, y)) continue;
      this.id[y * this.cols + x] = n;
      q.length = 0; q.push(x, y);
      while (q.length) {
        const cy = q.pop()!, cx = q.pop()!;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) continue;
          const k = ny * this.cols + nx;
          if (this.id[k] !== -1 || isBlockedCell(grid, nx, ny)) continue;
          this.id[k] = n; q.push(nx, ny);
        }
      }
      n++;
    }
  }
  /** Область точки; −1 — стена, закрытая дверь или вне карты. */
  at(p: Vec2): number {
    const { cx, cy } = cellOf(p);
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return -1;
    return this.id[cy * this.cols + cx]!;
  }
}

/** Шаг между соседними по диагонали клетками через «шов» (обе боковые — стены): тело его не проходит никогда. */
function sealCrossed(grid: Grid, a: Vec2, b: Vec2): boolean {
  const A = cellOf(a), B = cellOf(b);
  if (Math.abs(A.cx - B.cx) !== 1 || Math.abs(A.cy - B.cy) !== 1) return false;
  return isBlockedCell(grid, B.cx, A.cy) && isBlockedCell(grid, A.cx, B.cy);
}

/** Насколько (px) описанный квадрат круга (так его держит `moveWithCollision`) залез в непроходимые клетки. */
function wallOverlap(grid: Grid, p: Vec2, r: number): number {
  let worst = 0;
  const x0 = Math.floor((p.x - r) / TILE), x1 = Math.floor((p.x + r) / TILE);
  const y0 = Math.floor((p.y - r) / TILE), y1 = Math.floor((p.y + r) / TILE);
  for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
    if (!isBlockedCell(grid, cx, cy)) continue;
    const ox = Math.min(p.x + r, (cx + 1) * TILE) - Math.max(p.x - r, cx * TILE);
    const oy = Math.min(p.y + r, (cy + 1) * TILE) - Math.max(p.y - r, cy * TILE);
    if (ox > 0 && oy > 0) worst = Math.max(worst, Math.min(ox, oy));
  }
  return worst;
}

/**
 * ⭐ V-RF-05: насколько (px) круг в начале тика внутри преград декора. Толчок из преграды идёт разрешением по тайлам, и круг, зажатый между
 * стеной и преградой, остаётся чуть внутри неё — следующий толчок выносит его на эту глубину и без шага (оглушённого, стоящего).
 */
function obstacleDepth(obstacles: readonly Obstacle[], p: Vec2, r: number): number {
  let worst = 0;
  for (const ob of obstacles) { const q = pushOutObstacle(p.x, p.y, r, ob); if (q) worst = Math.max(worst, dist(p, q)); }
  return worst;
}
/**
 * ⭐ Перепрогон Z2 (сид 55190320): проходов выталкивания из декора за подшаг (`stepOnce` в `world/movement.ts` — две релаксации). Стена гасит часть
 * толчка поперёк (V-RF-05), круг остаётся внутри, и второй проход толкает снова — не дальше глубины: за тик сдвиг до двух глубин.
 */
const OBSTACLE_PASSES = 2;

/** Была ли преграда декора у пути a→b (круг выталкивается до грани раздутой формы: у бокса — угол (hw+r)×(hh+r)). */
function obstacleNear(obstacles: readonly Obstacle[], a: Vec2, b: Vec2, r: number): boolean {
  return obstacles.some((ob) => dist(ob, closestOnSeg(ob, a, b)) < (ob.shape === 'box' ? Math.hypot((ob.hw ?? 0) + r, (ob.hh ?? 0) + r) : (ob.r ?? 0) + r) + 2);
}

function closestOnSeg(pt: Vec2, a: Vec2, b: Vec2): Vec2 {
  const abx = b.x - a.x, aby = b.y - a.y;
  const len2 = abx * abx + aby * aby || 1;
  const t = Math.max(0, Math.min(1, ((pt.x - a.x) * abx + (pt.y - a.y) * aby) / len2));
  return { x: a.x + abx * t, y: a.y + aby * t };
}

// ── Мир ───────────────────────────────────────────────────────────────────────────────────────────

export interface Hero { pid: string; account: string; kit: Kit }
type Kit = 'fists' | '1h' | '1h+shield' | 'dual' | 'versatile+shield' | 'versatile' | '2h' | 'bow' | 'crossbow' | 'wand' | 'wand+shield' | 'staff';
const KITS: Kit[] = ['fists', '1h', '1h+shield', 'dual', 'versatile+shield', 'versatile', '2h', 'bow', 'crossbow', 'wand', 'wand+shield', 'staff'];

export interface FuzzWorld {
  seed: number;
  reg: ConfigRegistry;
  s: GameSession;
  heroes: Hero[];
  mode: 'floor' | 'arena' | 'town';
  plan?: RunPlan;
  regions: Regions;
  probe: Probe;
  /** Сколько чего произошло — чтобы видеть, что фаззер стережёт не пустоту. */
  cover: Record<string, number>;
  /** Журнал постройки мира (для отчёта). */
  about: string;
  /** Профиль мира (`FuzzHooks.world`). */
  opts: NonNullable<FuzzHooks['world']>;
  /** ⭐ D4: идёт круг «город → арена → город» (шаг `arena`): тела города героев на входе (как `Room.arenaHome`) и время мира входа. */
  trip?: { at: number; home: Map<string, HeroBody> };
}

const enabledBase = (b: { enabled?: boolean }): boolean => b.enabled !== false;

/** Вещь базы как найденная (ступень и детали — как у находки), требования — по руке герою (`fitToClass`, как стартовый комплект). */
function kitItem(reg: ConfigRegistry, baseId: string, save: SaveState): Item | null {
  const raw = itemFromBaseId(reg.get('items.base'), baseId, reg.get('item-tiers'), 'drop');
  return raw ? fitToClass(shapeFoundWeapon(reg, raw), save.attributes) : null;
}

/** Аффиксы из НАСТОЯЩЕГО пула (статы с вилкой ступени, проки каста) — «нашёл вещь с таким аффиксом». */
function rollAffixes(reg: ConfigRegistry, r: Rng, n: number): RolledAffix[] {
  const pool = reg.get('affixes').filter((a) => a.enabled !== false);
  const out: RolledAffix[] = [];
  for (let i = 0; i < n && pool.length; i++) {
    const a = r.pick(pool) as unknown as { id: string; kind: 'prefix' | 'suffix'; stat?: string; modKind?: StatModifier['kind']; tiers?: { min: number; max: number }[]; proc?: RolledAffix['proc'] };
    if (a.proc) { out.push({ affixId: a.id, kind: a.kind, proc: { ...a.proc } }); continue; }
    const t = a.tiers?.length ? r.pick(a.tiers) : undefined;
    if (!a.stat || !t) continue;
    out.push({ affixId: a.id, kind: a.kind, modifier: { stat: a.stat, kind: a.modKind ?? 'flat', value: r.float(t.min, t.max) } as StatModifier });
  }
  return out;
}

function weaponsWhere(reg: ConfigRegistry, pred: (b: WeaponBase) => boolean): string[] {
  return reg.get('items.base').filter((b) => b.kind === 'weapon' && enabledBase(b) && pred(b as WeaponBase)).map((b) => b.id);
}
type WeaponBase = { id: string; weaponClass?: string; hands?: number; versatile?: boolean; attackType?: string; damageKind?: string };

function kitBases(reg: ConfigRegistry, kit: Kit, r: Rng): { main?: string; off?: string; offTarget?: boolean } {
  const pick = (ids: string[]): string | undefined => (ids.length ? r.pick(ids) : undefined);
  const oneMelee = weaponsWhere(reg, (b) => (b.hands ?? 1) === 1 && b.attackType === 'melee');
  const shield = pick(reg.get('items.base').filter((b) => b.kind === 'shield' && enabledBase(b)).map((b) => b.id));
  switch (kit) {
    case 'fists': return {};
    case '1h': return { main: pick(oneMelee) };
    case '1h+shield': return { main: pick(oneMelee), off: shield };
    case 'dual': return { main: pick(oneMelee), off: pick(oneMelee), offTarget: true };
    case 'versatile+shield': return { main: pick(weaponsWhere(reg, (b) => !!b.versatile)), off: shield };
    case 'versatile': return { main: pick(weaponsWhere(reg, (b) => !!b.versatile)) };
    case '2h': return { main: pick(weaponsWhere(reg, (b) => (b.hands ?? 1) >= 2 && !b.versatile && b.attackType === 'melee')) };
    case 'bow': return { main: pick(weaponsWhere(reg, (b) => b.weaponClass === 'bow')) };
    case 'crossbow': return { main: pick(weaponsWhere(reg, (b) => b.weaponClass === 'crossbow')) };
    case 'wand': return { main: pick(weaponsWhere(reg, (b) => b.weaponClass === 'wand')) };
    case 'wand+shield': return { main: pick(weaponsWhere(reg, (b) => b.weaponClass === 'wand')), off: shield };
    case 'staff': return { main: pick(weaponsWhere(reg, (b) => b.weaponClass === 'staff')) };
  }
}

/** Выучить случайные скилы по правилам (`allocActive`: смежность, уровень, класс, очки), с перевесом к ветке оружия. */
function learnSkills(reg: ConfigRegistry, save: SaveState, r: Rng, prefer: string[]): void {
  const tree = reg.get('skill-tree');
  const branchOf = new Map(tree.branches.map((b) => [b.id, b]));
  for (let guard = 0; guard < 400 && save.unspentSkillPoints > 0; guard++) {
    const cand = tree.nodes.filter((n) => {
      const br = branchOf.get(n.branchId);
      if (br?.classId && br.classId !== save.classId) return false;
      if (save.level < n.levelReq || (save.skills[n.id] ?? 0) >= n.maxRank) return false;
      return (save.skills[n.id] ?? 0) > 0 || tree.entryNodes.includes(n.id)
        || tree.edges.some(([a, b]) => (a === n.id && (save.skills[b] ?? 0) > 0) || (b === n.id && (save.skills[a] ?? 0) > 0));
    });
    if (!cand.length) break;
    const liked = cand.filter((n) => prefer.some((p) => n.branchId.includes(p)) || branchOf.get(n.branchId)?.classId);
    const withActive = (l: typeof cand): typeof cand => { const a = l.filter((n) => n.effect.active); return a.length && r.chance(0.6) ? a : l; };
    const pool = withActive(liked.length && r.chance(0.75) ? liked : cand);
    allocActive(reg, save, r.pick(pool).id);
  }
}

/** Вставить случайные открытые вставки в гнёзда выученных активок (`socketInsert` — все правила вставки). */
function fillSockets(reg: ConfigRegistry, save: SaveState, r: Rng): void {
  const inserts = reg.get('skill-inserts').filter((i) => i.enabled !== false && insertUnlocked(reg, save, i.id));
  if (!inserts.length) return;
  for (const [nodeId, rank] of Object.entries(save.skills)) {
    const open = socketsOpen(reg, rank);
    for (let slot = 0; slot < open; slot++) if (r.chance(0.7)) socketInsert(reg, save, nodeId, slot, r.pick(inserts).id);
  }
}

const POTIONS = ['minor-healing-potion', 'healing-potion', 'mana-potion', 'antidote', ...BUFF_POTIONS];

/** Герой: класс, уровень, атрибуты и скилы по правилам прокачки, набор оружия, броня/бижутерия с настоящими аффиксами, пояс. */
function makeHero(reg: ConfigRegistry, r: Rng, i: number): { save: SaveState; kit: Kit } {
  const bal = reg.get('balance');
  const classes = reg.get('classes').filter((c) => c.enabled !== false);
  const cls = r.pick(classes);
  const save = newCharacterSave(reg, cls.id, `Герой${i}`, `hero-${i}`);
  const L = r.pick([1, 1, 2, 4, 7, 12, 18, 25, 33, 42, 55]);
  const nextXp = xpForLevel(L + 1, bal.xpTable), curXp = xpForLevel(L, bal.xpTable);
  save.level = L;
  // Треть героев — у самого порога уровня: левелап в бою (полное лечение, очки) проверяется не только в теории.
  save.xp = nextXp > curXp ? (r.chance(0.35) ? Math.max(curXp, nextXp - r.int(1, 40)) : curXp + r.int(0, nextXp - curXp - 1)) : curXp;
  save.unspentAttributePoints = (L - 1) * bal.attributePointsPerLevel;
  save.unspentSkillPoints = (L - 1) * bal.skillPointsPerLevel;
  save.unspentMasteryPoints = (L - 1) * bal.masteryPointsPerLevel;
  // ⭐ D2: книга заработанного — та же история (очки уровней выданы при этом конфиге).
  save.earned = { attributePoints: save.unspentAttributePoints, skillPoints: save.unspentSkillPoints, masteryPoints: save.unspentMasteryPoints };
  save.gold = r.int(0, 30000);
  while (save.unspentAttributePoints > 0) allocAttr(save, r.pick(ATTRIBUTES), Math.min(save.unspentAttributePoints, r.int(1, 12)));
  const kit = r.pick(KITS);
  const dims = bal.inventory;
  // Сперва снять стартовое оружие в сумку — набор кладётся вместо него.
  if (save.equipment.weapon) unequip(reg, save, 'weapon');
  const k = kitBases(reg, kit, r);
  const put = (baseId: string | undefined, target?: 'offhand'): void => {
    if (!baseId) return;
    const it = kitItem(reg, baseId, save);
    if (!it) return;
    if (r.chance(0.35)) it.affixes.push(...rollAffixes(reg, r, r.int(1, 2)));
    if (!addToInventory(save.inventory, it, dims)) return;
    equip(reg, save, it.uid, target);
  };
  put(k.main);
  put(k.off, k.offTarget ? 'offhand' : undefined);
  // Броня и бижутерия — из настоящего генератора находок, часть — с аффиксами пула (вампиризм, скорость, проки).
  for (const slot of ['helm', 'chest', 'gloves', 'boots', 'belt', 'ring', 'amulet'] as const) {
    if (!r.chance(0.55) && slot !== 'belt') continue;
    const ids = reg.get('items.base').filter((b) => enabledBase(b) && (b as { slot?: string }).slot === slot).map((b) => b.id);
    if (!ids.length) continue;
    const it = kitItem(reg, r.pick(ids), save);
    if (!it) continue;
    if (r.chance(0.5)) it.affixes.push(...rollAffixes(reg, r, r.int(1, 3)));
    if (!addToInventory(save.inventory, it, dims)) continue;
    equip(reg, save, it.uid);
  }
  // Запасное снаряжение в сумке — для смены посреди замаха.
  for (let n = r.int(1, 3); n > 0; n--) {
    const alt = kitBases(reg, r.pick(KITS), r);
    const id = alt.main ?? alt.off;
    const it = id ? kitItem(reg, id, save) : null;
    if (it) addToInventory(save.inventory, it, dims);
  }
  // Колбы: в пояс (сколько ячеек) и в сумку.
  const cap = save.equipment.belt?.beltSlots ?? 0;
  save.belt = Array.from({ length: cap }, () => (r.chance(0.8) ? itemFromBaseId(reg.get('items.base'), r.pick(POTIONS), undefined, 'shop') : null));
  for (let n = r.int(0, 2); n > 0; n--) { const p = itemFromBaseId(reg.get('items.base'), r.pick(POTIONS), undefined, 'shop'); if (p) addToInventory(save.inventory, p, dims); }
  const prefer = [kit.includes('shield') ? 'shield' : '', kit === 'dual' ? 'dual' : '', save.equipment.weapon?.weaponClass ?? '', 'fire', 'cold', 'lightning', 'poison', 'curse', 'aura', 'stance'].filter(Boolean);
  learnSkills(reg, save, r, prefer);
  fillSockets(reg, save, r);
  return { save, kit };
}

/** Мир из сида: этаж забега (как `Room.enterNode`) или компактная арена; 1–3 героя. */
export function newWorld(seed: number, hooks: FuzzHooks = {}): FuzzWorld {
  const reg = hooks.world?.constructs ? fuzzRegConstructs() : fuzzReg();
  const r = createRng((seed ^ 0x5eed5) >>> 0 || 1);
  const s = new GameSession(reg, seed, r.pick(['normal', 'normal', 'hard']));
  const n = Math.max(hooks.world?.minHeroes ?? 1, r.pick([1, 1, 2, 2, 3]));
  const heroes: Hero[] = [];
  const about: string[] = [];
  for (let i = 0; i < n; i++) {
    const { save, kit } = makeHero(reg, r, i);
    // Профиль `levelup` (R15-10): до уровня — одно очко опыта, первое же убийство его поднимает. Без бросков: поток мира прежний.
    if (hooks.world?.levelup) save.xp = Math.max(save.xp, xpForLevel(save.level + 1, reg.get('balance').xpTable) - 1);
    // Профиль `buffs` (R19-03, ⭐ D4): бафф своего класса (по уровню) — на высшем ранге, и печати вставок на высшем ранге донора — в гнёздах
    // выученных ударов и кастов (у печати свой откат, действие растёт с рангом донора). Без бросков: поток мира прежний.
    if (hooks.world?.buffs) {
      const tree = reg.get('skill-tree');
      const own = tree.nodes.find((nd) => nd.effect.active?.category === 'buff' && save.level >= nd.levelReq && tree.branches.find((b) => b.id === nd.branchId)?.classId === save.classId);
      if (own) save.skills[own.id] = own.maxRank;
      for (const ins of reg.get('skill-inserts')) {
        if (ins.enabled === false || ins.proc?.ability.category !== 'buff') continue;
        const donor = tree.nodes.find((nd) => nd.effect.grantsInsert === ins.id);
        if (!donor) continue;
        save.skills[donor.id] = donor.maxRank;
        for (const [id, rk] of Object.entries(save.skills)) {
          const a = activeAbilityOf(reg, id);
          if (a?.category !== 'attack' && a?.category !== 'cast') continue;
          let put = false;
          for (let slot = 0; slot < socketsOpen(reg, rk) && !put; slot++) put = socketInsert(reg, save, id, slot, ins.id).ok;
          if (put) break;
        }
      }
    }
    // Два первых — один аккаунт (альты), третий — другой: выброшенное чужим аккаунтом не поднять (R2-02).
    const account = i < 2 ? 'acc-a' : 'acc-b';
    const pid = `p${i}`;
    s.addPlayer(pid, save, undefined, account);
    heroes.push({ pid, account, kit });
    const learned = Object.entries(save.skills).filter(([id]) => activeAbilityOf(reg, id)).map(([id, rk]) => `${id}:${rk}`);
    about.push(`${pid} ${save.classId} ур.${save.level} ${kit} [${save.equipment.weapon?.baseId ?? '—'}${save.equipment.offhand ? '+' + save.equipment.offhand.baseId : ''}] активки ${learned.join(' ') || '—'}`);
  }
  const w: FuzzWorld = { seed, reg, s, heroes, mode: 'floor', regions: new Regions([]), probe: undefined as unknown as Probe, cover: {}, about: '', opts: {} };
  hooks.install?.(w);
  w.probe = instrument(w);
  w.opts = hooks.world ?? {};
  enterFloorFor(w, r, r.chance(w.opts.arena ?? 0.5) ? 'arena' : 'floor');
  about.push(w.about);
  w.about = about.join('\n    ');
  return w;
}

/** Уровень пати для заселения — сильнейший герой (как `Room.partyLevel` по уровню). */
const partyLevel = (w: FuzzWorld): number => Math.max(1, ...w.heroes.map((h) => w.s.world.players[h.pid]?.save.level ?? 1));

/** Войти на этаж: `floor` — узел забега (генератор, декор, сундуки, двери+рычаги закрыты), `arena` — компактная, `town` — город. */
function enterFloorFor(w: FuzzWorld, r: Rng, mode: FuzzWorld['mode']): void {
  const reg = w.reg;
  w.mode = mode;
  if (mode === 'town') {
    const t = townLayout();
    w.s.enterFloor(0, { grid: t.grid, spawn: t.spawn, monsters: [] });
    w.about = 'город';
  } else if (mode === 'floor') {
    if (!w.plan || r.chance(0.3)) {
      const biomes = reg.get('biomes').filter(enabledBase);
      const tpls = reg.get('run-templates').filter(enabledBase);
      w.plan = generateRunPlan(reg, { templateId: r.pick(tpls).id, biomeId: r.pick(biomes).id, tier: w.s.world.difficultyId, seed: r.int(1, 2 ** 31 - 1), modifiers: [] });
    }
    const nodes = w.plan.nodes.filter((nd) => nd.type !== 'rest');
    // Этажи с замком (дверь + рычаг) — вдвое чаще: их в забеге мало, а правила двери — в числе главных.
    const locked = nodes.filter((nd) => nd.floorSpec.locked);
    const node: RunNode = locked.length && r.chance(0.5) ? r.pick(locked) : r.pick(nodes);
    const biome = reg.get('biomes').find((b) => b.id === node.biomeId) ?? reg.get('biomes')[0]!;
    const decorSpecs = decorSpecsFor(reg.get('objects'), reg.get('models'), biome.id);
    const layout = generateFloor(node.floorSpec, reg.get('room-prefabs'), decorSpecs, undefined,
      { tiers: reg.get('chests'), perFloor: reg.get('balance').loot.chestsPerFloor });
    const obstacles = obstaclesFromDecor(layout.decor, new Map(decorSpecs.map((d) => [d.id, d])));
    const monsters = spawnPacksEl(reg, layout, node.depth, w.s.world.difficultyId, createRng((node.floorSpec.seed >>> 0) || 1), partyLevel(w),
      resolveMonsterPool(biome, node.depth), node.floorSpec.packDensity, node.floorSpec.floorId);
    w.s.enterFloor(node.depth, {
      grid: layout.grid, spawn: layout.spawn, exits: layout.exits, monsters, obstacles, chests: layout.chests,
      doors: layout.doors, levers: layout.levers, biomeId: biome.id, runNodeId: node.id, runNodeType: node.type,
      floorLevel: monsters.reduce((m, sp) => Math.max(m, sp.def.level), 0), floorModifiers: node.floorSpec.modifiers,
    });
    w.about = `этаж ${node.id} (${node.type}, ${biome.id}, глуб. ${node.depth}${node.floorSpec.locked ? ', замок' : ''}): ${layout.grid[0]?.length}×${layout.grid.length}, монстров ${monsters.length}, сундуков ${layout.chests.length}, дверей ${layout.doors.length}, преград ${obstacles.length}`;
  } else {
    const a = arenaLayout(w, r);
    w.s.enterFloor(a.depth, a.layout);
    for (const d of a.drops) w.s.world.drops.push({ ...d, id: w.s.world.nextId++ } as DropEntity);
    w.about = `арена${a.layout.pvp ? ' PvP' : ''}: монстров ${a.layout.monsters.length}, сундуков ${a.layout.chests?.length ?? 0}, добычи ${a.drops.length}`;
  }
  w.regions = new Regions(w.s.world.grid);
  w.probe.resetFloor();
}

/**
 * АРЕНА: 26×18, перегородка с запертой дверью и рычагом с ближней стороны, колонны, диагональный шов, преграды декора (часть
 * закрывает обзор), сундуки по обе стороны двери, монстры пачками из пула биома (`spawnPacksEl` по двум «комнатам»), добыча на
 * полу — своя, чужого аккаунта, у стены и за стеной. PvP — иногда (при двух героях и больше), как арена комнаты.
 */
function arenaLayout(w: FuzzWorld, r: Rng): { depth: number; layout: FloorLayout; drops: NewDrop[] } {
  const reg = w.reg;
  const cols = 26, rows = 18;
  const grid = makeGrid(cols, rows, Cell.Floor);
  for (let x = 0; x < cols; x++) { grid[0]![x] = Cell.Wall; grid[rows - 1]![x] = Cell.Wall; }
  for (let y = 0; y < rows; y++) { grid[y]![0] = Cell.Wall; grid[y]![cols - 1] = Cell.Wall; }
  const wx = 13;
  for (let y = 1; y < rows - 1; y++) grid[y]![wx] = Cell.Wall;
  const doorCells = [{ cx: wx, cy: 8 }, { cx: wx, cy: 9 }];
  for (const c of doorCells) grid[c.cy]![c.cx] = Cell.Door;
  // Диагональный шов: (4,12) и (5,13) — пол, касаются углом; (5,12) и (4,13) — стены.
  grid[12]![5] = Cell.Wall; grid[13]![4] = Cell.Wall;
  // Колонны и короткая стенка.
  for (let n = r.int(1, 4); n > 0; n--) grid[r.int(2, rows - 3)]![r.chance(0.5) ? r.int(2, wx - 2) : r.int(wx + 2, cols - 3)] = Cell.Pillar;
  if (r.chance(0.5)) for (let x = 3; x < 8; x++) grid[4]![x] = Cell.Wall;
  const spawnCell = { cx: 3, cy: 9 };
  grid[spawnCell.cy]![spawnCell.cx] = Cell.Floor;
  const spawn = cellToWorld(spawnCell.cx, spawnCell.cy);
  const freeCell = (x0: number, x1: number): { x: number; y: number } => {
    for (let t = 0; t < 50; t++) {
      const cx = r.int(x0, x1), cy = r.int(1, rows - 2);
      if (grid[cy]![cx] === Cell.Floor && (Math.abs(cx - spawnCell.cx) + Math.abs(cy - spawnCell.cy) > 2)) return cellToWorld(cx, cy);
    }
    return cellToWorld(x0, 2);
  };
  // Преграды декора: как у генератора — внутри комнаты, на клетку от стен (`placeFloorDecor`, резерв следа); четверть — вплотную к
  // стене, как настенный реквизит (`placeWallProps`). ⚠ Сегодня в `objects` нет ни одного преграждающего объекта (`blocks`) — обе
  // ветки скрытые: их включит первая же правка конфига.
  const obstacles: Obstacle[] = [];
  const clear = (p: { x: number; y: number }): boolean => {
    const c = cellOf(p);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (isBlockedCell(grid, c.cx + dx, c.cy + dy)) return false;
    return true;
  };
  for (let n = r.int(0, 3); n > 0; n--) {
    let at = freeCell(2, cols - 3);
    const wallProp = r.chance(0.25);
    for (let t = 0; t < 20 && !wallProp && !clear(at); t++) at = freeCell(2, cols - 3);
    if (!wallProp && !clear(at)) continue;
    obstacles.push(r.chance(0.5)
      ? { x: at.x, y: at.y, shape: 'circle', r: r.float(6, 14), blocksSight: r.chance(0.5) }
      : { x: at.x, y: at.y, shape: 'box', hw: r.float(4, 12), hh: r.float(4, 12), yaw: r.float(0, Math.PI), blocksSight: r.chance(0.5) });
  }
  // ⚠ C-10: КОЛОННЫ В ЛИНИИ ОГНЯ — преграды на пути от входа героев вглубь ближней комнаты, почти все закрывают обзор: через них чаще
  // всего и летят стрела, жезл, бумеранг и снаряд монстра. Случайные преграды выше попадают под выстрел редко (до правки сторож не
  // видел колонну ни разу за сотни цепочек). Только в профиле `pillars` — без него поток бросков арены прежний (сиды стендов те же).
  if (w.opts.pillars && r.chance(w.opts.pillars)) {
    for (let n = r.int(1, 3); n > 0; n--) {
      const far = freeCell(2, wx - 2), k = r.float(0.3, 0.7);
      const at = { x: spawn.x + (far.x - spawn.x) * k, y: spawn.y + (far.y - spawn.y) * k };
      const round = r.chance(0.5), sight = r.chance(0.85);
      if (!clear(at) || dist(at, spawn) < 2 * TILE) continue;
      obstacles.push(round
        ? { x: at.x, y: at.y, shape: 'circle', r: r.float(6, 14), blocksSight: sight }
        : { x: at.x, y: at.y, shape: 'box', hw: r.float(4, 12), hh: r.float(4, 12), yaw: r.float(0, Math.PI), blocksSight: sight });
    }
  }
  const lever = cellToWorld(wx - 1, 5);
  const tiers = reg.get('chests').filter(enabledBase);
  const chests = [
    { id: 1, ...freeCell(2, wx - 2), tier: r.pick(tiers).id },
    { id: 2, ...freeCell(wx + 2, cols - 3), tier: r.pick(tiers).id },
    // Сундук вплотную к стене с той стороны — ближе 56 px, но за стеной.
    { id: 3, ...cellToWorld(wx + 1, 3), tier: r.pick(tiers).id },
  ];
  const biome = r.pick(reg.get('biomes').filter(enabledBase));
  const depth = r.pick([1, 1, 2, 3, 5, 8]);
  const lay: DungeonLayout = {
    grid, spawn, stairsDown: spawn, exits: [], decor: [], doors: [], levers: [], chests: [],
    rooms: [{ x: 1, y: 1, w: wx - 1, h: rows - 2, type: 'small' }, { x: wx + 1, y: 1, w: cols - wx - 2, h: rows - 2, type: r.pick(['small', 'large'] as const) }],
  } as unknown as DungeonLayout;
  const monsters = spawnPacksEl(reg, lay, depth, w.s.world.difficultyId, createRng(r.int(1, 2 ** 31 - 1)), partyLevel(w), resolveMonsterPool(biome, depth), r.float(0.5, 1.5), '');
  const drops: NewDrop[] = [];
  const bases = reg.get('items.base').filter(enabledBase);
  const loot = (): Item => itemFromBaseId(bases, r.pick(bases).id, reg.get('item-tiers'), 'drop')!;
  for (let n = r.int(1, 5); n > 0; n--) {
    const at = r.chance(0.3) ? cellToWorld(wx + 1, r.int(2, rows - 3)) : r.chance(0.5) ? { x: spawn.x + r.float(-60, 60), y: spawn.y + r.float(-60, 60) } : freeCell(1, cols - 2);
    const c = cellOf(at);
    if (isBlockedCell(grid, c.cx, c.cy)) continue;
    const kind = r.pick(['gold', 'item', 'item', 'materials'] as const);
    if (kind === 'gold') drops.push({ pos: at, kind: 'gold', gold: r.int(1, 200) });
    else if (kind === 'materials') drops.push({ pos: at, kind: 'materials', mats: { [r.pick(reg.get('craft-materials').filter((m) => m.enabled)).id]: r.int(1, 30) } });
    else drops.push({ pos: at, kind: 'item', item: loot(), ...(r.chance(0.3) ? { owner: r.pick(['acc-a', 'acc-b']) } : {}) });
  }
  return {
    depth,
    drops,
    layout: {
      grid, spawn, monsters, obstacles, chests, biomeId: biome.id,
      doors: [{ id: 1, cells: doorCells }], levers: [{ id: 1, x: lever.x, y: lever.y, doorId: 1 }],
      pvp: w.heroes.length >= 2 && r.chance(w.opts.pvp ?? 0.3),
    },
  };
}

/** Добыча на полу арены до входа (id выдаёт мир). */
type NewDrop = { pos: Vec2; owner?: string } & DropPayload;

// ── Наблюдатель ───────────────────────────────────────────────────────────────────────────────────

export interface Violation { inv: string; code: string; msg: string }

/**
 * Контекст доставки урона: откуда и какой геометрией бьют. Стек: проки вызывают доставку изнутри доставки. `alive0` — жив ли бьющий в миг
 * начала доставки (⭐ Z: погибший ВНУТРИ своей доставки — от прока цели «при получении удара» в PvP — доносит её, как стрелу в полёте).
 */
type Ctx =
  | { kind: 'melee'; hero: PlayerEntity; alive0: boolean; origin: Vec2; facing: number; range: number; arc: number; hit: Set<unknown> }
  | { kind: 'nova'; hero: PlayerEntity; alive0: boolean; origin: Vec2; radius: number; hit: Set<unknown> }
  | { kind: 'leap'; hero: PlayerEntity; alive0: boolean; to: Vec2; radius: number }
  | { kind: 'dash'; hero: PlayerEntity; alive0: boolean; from: Vec2; to: Vec2; halfW: number }
  | { kind: 'proj'; hero: PlayerEntity | undefined; pos: Vec2; projId: number }
  | { kind: 'struck'; hero: PlayerEntity; source?: MonsterEntity }
  /** ⚠ R21-06: взрыв конструкта при смерти (`overloadOnDeath`) — доставка МОНСТРА: откуда и каким радиусом. */
  | { kind: 'blast'; m: MonsterEntity; origin: Vec2; radius: number };
/** Что исполняется: базовый удар (ожидаемая рука), скил (оплаченная способность), прок. */
type Exec =
  | { kind: 'basic'; hero: PlayerEntity; hand?: string; fromWindup: boolean }
  | { kind: 'skill'; hero: PlayerEntity; res: ResolvedActive; fromWindup: boolean; nodeId?: string }
  | { kind: 'proc'; hero: PlayerEntity };

interface Track {
  /** Не раньше (мс мира) — следующий удар/атака-скил: лок по формуле скорости, посчитанный независимо от `attackCd` сессии. */
  lockUntil: number;
  /** Не раньше (мс мира) — следующее применение узла. */
  cdUntil: Record<string, number>;
  /** Подпись снаряжения и тоглов на старте замаха (R6-02). */
  castSig?: string;
  castNode?: string;
  /** Идущая серия взмахов: сколько написано и сколько «следующих» уже было. */
  series?: { node: string; hits: number; chains: number };
}

/** ⭐ D4: учёт одного баффа героя по его часам: с какого мига (с), сколько под ним, длиннейшее и кратчайшее действие, прошлое срабатывание. */
interface BuffTrack { t0: number; up: number; dmax: number; dmin: number; last?: number; lastDur?: number }

export interface Probe {
  v: Violation[];
  track: Map<string, Track>;
  /** ⭐ D4: часы героя (с) — время, пока он в мире и жив: у ушедшего (шаг `reconnect`) и павшего время стоит, как его откаты и баффы (R4-06). */
  clock: Map<string, number>;
  /** ⭐ D4: учёт баффов героя (узлы древа, печати `ins:`) — правило времени баффа по часам героя (`buffClock`). */
  buffs: Map<string, Map<string, BuffTrack>>;
  /** ⚠ R23-05: конец каждого отката героя по его часам (с) — с последнего раза, как откат встал в тике (`cdClock`). */
  cdEnd: Map<string, Record<string, number>>;
  /** Кто что поднял (takeDrop) за шаг: id дропа → поднявший. */
  taken: Map<number, string>;
  /** Сундуки, открытые за шаг (id → кто). */
  chests: Map<number, string>;
  /** Герои, которых преграда декора втолкнула в стену (V-RF-05): пока не выбрались, стены у них — следствие той же причины. */
  tainted: Set<string>;
  /**
   * ⭐ Перепрогон R15: максимумы в миг левелапа за тик (с рантайм-модами того мига, R15-10). Бафф, истёкший в том же тике, их не отменяет:
   * левелап налил до них законно, следующий тик подрежет — максимум тика (I6) и они.
   */
  levelMax: Map<string, { hp: number; mana: number; stamina: number; effMana: number; effStam: number }>;
  resetFloor(): void;
  oracle(p: PlayerEntity): PlayerSnapshot;
}

/** Подпись снаряжения и тоглов — как `loadoutSig` ядра (R6-02): с чем начат замах. */
const loadoutSig = (p: PlayerEntity): string =>
  Object.entries(p.save.equipment).filter(([, it]) => it).map(([slot, it]) => `${slot}:${it!.uid}`).sort().join('|')
  + '#' + [...p.toggles].sort().join('|');

/** Рантайм-моды героя: ауры/стойки + баффы (узлы древа, печати вставок `ins:`, зелья `pot:`) — то, что сессия кладёт поверх сейва. */
function runtimeMods(reg: ConfigRegistry, p: PlayerEntity): StatModifier[] {
  const mods = toggleBuffMods(reg, p.toggles);
  for (const id of Object.keys(p.skillBuffs)) {
    if (id.startsWith('ins:')) {
      const ab = reg.get('skill-inserts').find((x) => x.id === id.slice(4))?.proc?.ability;
      if (ab?.category === 'buff') mods.push(...(ab.buffMods ?? []));
      continue;
    }
    if (id.startsWith('pot:')) { mods.push(...(potionBuffDef(reg, id.slice(4))?.mods ?? [])); continue; }
    const a = activeAbilityOf(reg, id);
    if (a && (a.category === 'buff' || a.category === 'aura' || a.category === 'stance')) mods.push(...(a.buffMods ?? []));
  }
  return mods;
}

/** Способность, которую каст ОПЛАЧИВАЕТ: со вставками, магические гаснут без маны (как `affordableRes` ядра). */
function payable(reg: ConfigRegistry, p: PlayerEntity, nodeId: string): ResolvedActive | undefined {
  const full = resolveActive(reg, p.save, nodeId);
  if (!full) return undefined;
  const ex = full.extraCost;
  const pool = (k: 'mana' | 'stamina'): number => (k === 'stamina' ? p.stamina : p.mana);
  if (!ex || pool(ex.pool) >= ex.amount) return full;
  return resolveActive(reg, p.save, nodeId, { omitPools: [ex.pool] }) ?? full;
}

/** Потолок множителя скорости взмаха от условных вставок (`tune.when.speedPer`) — верх, до которого условие может дорасти. */
function condSpeedCap(res: ResolvedActive): number {
  let k = 1;
  for (const { insert, rank } of res.applied) {
    const w = insert.tune?.when;
    if (!w?.speedPer) continue;
    k *= 1 + w.speedPer * (1 + insert.perRank.gain * (Math.max(1, rank) - 1)) * w.maxStacks;
  }
  return k;
}

type AnyFn = (...a: never[]) => unknown;

/**
 * ОБЁРТКИ НАБЛЮДАТЕЛЯ на приватные методы экземпляра. Каждая зовёт оригинал с теми же аргументами и возвращает его результат —
 * поведение сессии не меняется ни на бит (детерминизм повтора и сжатия держится на этом).
 */
function instrument(w: FuzzWorld): Probe {
  const reg = w.reg;
  const S = w.s as unknown as Record<string, AnyFn>;
  const world = w.s.world;
  const bal = reg.get('balance');
  const grip = gripOf(bal.versatile);
  const ctx: Ctx[] = [];
  const exec: Exec[] = [];
  const cache = new Map<string, PlayerSnapshot>();
  const probe: Probe = {
    v: [],
    track: new Map(),
    clock: new Map(),
    buffs: new Map(),
    cdEnd: new Map(),
    taken: new Map(),
    chests: new Map(),
    tainted: new Set(),
    levelMax: new Map(),
    resetFloor(): void { ctx.length = 0; exec.length = 0; projLast.clear(); sight = world.obstacles.filter((o) => o.blocksSight).map((o) => ({ ...o })); },
    oracle(p: PlayerEntity): PlayerSnapshot {
      const eq = Object.entries(p.save.equipment).filter(([, it]) => it).map(([k, it]) => `${k}:${it!.uid}`).join('|');
      const key = `${p.save.classId}#${p.save.level}#${eq}#${JSON.stringify(p.save.attributes)}#${JSON.stringify(p.save.skills)}#${JSON.stringify(p.save.masteries)}#${[...p.toggles].sort().join(',')}#${Object.keys(p.skillBuffs).sort().join(',')}`;
      let snap = cache.get(key);
      if (!snap) { snap = playerSnapshot(p.save, reg, runtimeMods(reg, p)); if (cache.size > 400) cache.clear(); cache.set(key, snap); }
      return snap;
    },
  };
  const V = (inv: string, code: string, msg: string): void => { probe.v.push({ inv, code, msg }); };
  const los = (a: Vec2, b: Vec2): boolean => hasLineOfSight(world.grid, a.x, a.y, b.x, b.y, world.obstacles);
  /**
   * ⚠ C-10: преграды этажа, закрывающие обзор, — СНИМОК на входе (`resetFloor`): за этаж они не меняются, а снимок наблюдателя
   * не зависит от того, что сессия видит в мире посреди шага (зубы сторожа прячут от неё колонну на время полёта снарядов).
   */
  let sight: Obstacle[] = [];
  const projLast = new Map<number, Vec2>();
  const trackOf = (pid: string): Track => { let t = probe.track.get(pid); if (!t) { t = { lockUntil: -Infinity, cdUntil: {} }; probe.track.set(pid, t); } return t; };
  const events = (): SessionEvent[] => (w.s as unknown as { events: SessionEvent[] }).events;
  const wrap = (name: string, make: (orig: (...a: any[]) => any) => (...a: any[]) => any): void => {
    const orig = S[name];
    if (typeof orig !== 'function') throw new Error(`фаззер правил: у сессии нет метода «${name}» — обёртку наблюдателя пора обновить`);
    S[name] = make((orig as (...a: unknown[]) => unknown).bind(w.s)) as AnyFn;
  };
  const heroName = (p: PlayerEntity): string => `${p.id}(${p.save.classId})`;
  const equippedUids = (p: PlayerEntity): Set<string> => new Set(Object.values(p.save.equipment).filter(Boolean).map((it) => it!.uid));

  // I2: попадание по цели — в геометрии текущей доставки.
  const checkHit = (hero: PlayerEntity, target: { pos: Vec2; alive: boolean }, what: string): void => {
    const c = ctx[ctx.length - 1];
    if (!target.alive) V('I2', 'dead-target', `${heroName(hero)} бьёт мёртвую цель ${what}`);
    if (!c) { V('I2', 'no-context', `${heroName(hero)} ударил ${what} вне известной доставки (не взмах, не нова, не снаряд…)`); return; }
    // Взрыв конструкта — доставка монстра: удар героя прямо из него (не из прока полученного удара) — вне известной доставки.
    if (c.kind === 'blast') { V('I2', 'no-context', `${heroName(hero)} ударил ${what} изнутри взрыва монстра ${c.m.id}`); return; }
    if (c.kind !== 'proj' && c.hero !== hero) V('I2', 'wrong-hero', `урон ${what} записан на ${heroName(hero)}, а бьёт ${heroName(c.hero)}`);
    // ⭐ Z: мёртвый не НАЧИНАЕТ доставку (замах, нова, прыжок, рывок трупа — нарушение). Погибший внутри своей — прок цели «при получении
    // удара» (PvP) убил его посреди взмаха — доносит её до остальных целей, как стрелу в полёте и шипы павшего (V-RF-04): взмах начат живым,
    // и кого он заденет, не решает порядок героев в комнате. Награды трупу нет — это держат I6 (`dead-hp`, `xp-dead`).
    if (c.kind !== 'proj' && c.kind !== 'struck' && !c.hero.alive) {
      if (!c.alive0) V('I2', 'dead-attacker', `мёртвый ${heroName(c.hero)} бьёт ${what} (${c.kind})`);
      else w.cover['hit-after-own-death'] = (w.cover['hit-after-own-death'] ?? 0) + 1;
    }
    const t = target.pos;
    w.cover[`hit-${c.kind}`] = (w.cover[`hit-${c.kind}`] ?? 0) + 1;
    // Один взмах/одна нова — по каждой цели не больше одного удара (серия — это разные взмахи, у каждого свой контекст).
    if (c.kind === 'melee' || c.kind === 'nova') {
      if (c.hit.has(target)) V('I2', 'double-hit', `${heroName(hero)}: ${c.kind === 'melee' ? 'один взмах' : 'одна нова'} ударил ${what} дважды`);
      c.hit.add(target);
    }
    switch (c.kind) {
      case 'melee': {
        const d = dist(c.origin, t);
        if (d > c.range + EPS) V('I2', 'melee-range', `${heroName(hero)} взмах достал ${what} на ${d.toFixed(1)} px > дальности ${c.range.toFixed(1)}`);
        const off = Math.abs(wrapAngle(Math.atan2(t.y - c.origin.y, t.x - c.origin.x) - c.facing));
        if (off > c.arc + 1e-9) V('I2', 'melee-arc', `${heroName(hero)} взмах достал ${what} на ${off.toFixed(3)} рад > дуги ${c.arc.toFixed(3)}`);
        if (!los(c.origin, t)) V('I2', 'melee-los', `${heroName(hero)} взмах достал ${what} сквозь стену ${fmt(c.origin)}→${fmt(t)}`);
        break;
      }
      case 'nova': {
        const d = dist(c.origin, t);
        if (d > c.radius + EPS) V('I2', 'nova-range', `${heroName(hero)} нова достала ${what} на ${d.toFixed(1)} > ${c.radius}`);
        if (!los(c.origin, t)) V('I2', 'nova-los', `${heroName(hero)} нова достала ${what} сквозь стену ${fmt(c.origin)}→${fmt(t)}`);
        break;
      }
      case 'leap': {
        const d = dist(c.to, t);
        if (d > c.radius + EPS) V('I2', 'leap-range', `${heroName(hero)} прыжок достал ${what} на ${d.toFixed(1)} от точки приземления > ${c.radius}`);
        if (!los(c.to, t)) V('I2', 'leap-los', `${heroName(hero)} прыжок достал ${what} сквозь стену от ${fmt(c.to)}`);
        break;
      }
      case 'dash': {
        const q = closestOnSeg(t, c.from, c.to);
        const d = dist(q, t);
        if (d > c.halfW + EPS) V('I2', 'dash-range', `${heroName(hero)} рывок достал ${what} на ${d.toFixed(1)} от пути > коридора ${c.halfW.toFixed(1)}`);
        if (!los(q, t)) V('I2', 'dash-los', `${heroName(hero)} рывок достал ${what} сквозь стену от ${fmt(q)}`);
        break;
      }
      case 'proj': {
        const d = dist(c.pos, t);
        if (d >= PROJ_R + EPS) V('I2', 'proj-range', `снаряд ${c.projId} ${heroName(hero)} попал в ${what} на ${d.toFixed(1)} ≥ ${PROJ_R}`);
        // C-10: снаряд бьёт только то, что видно с места, где он летит, — как удар и нова (сетка, шов, колонна).
        if (!hasLineOfSight(world.grid, c.pos.x, c.pos.y, t.x, t.y, sight)) V('I2', 'proj-los', `снаряд ${c.projId} ${heroName(hero)} попал в ${what} сквозь стену/колонну ${fmt(c.pos)}→${fmt(t)}`);
        if (c.hero && c.hero !== hero) V('I2', 'wrong-hero', `снаряд ${c.projId} хозяина ${heroName(c.hero)} записан на ${heroName(hero)}`);
        break;
      }
      case 'struck': V('I2', 'no-context', `${heroName(hero)} ударил ${what} изнутри полученного удара`); break;
    }
  };

  // ── Исполнение ударов: что ожидается (рука, способность) ──
  wrap('executeBasicAttack', (orig) => (p: PlayerEntity, snap: PlayerSnapshot) => {
    const hands = attackWeaponsOf(p.save, grip);
    const hand = hands[p.swingHand % hands.length];
    const fromWindup = inWindup.has(p.id);
    if (fromWindup) checkLoadout(p, 'attack');
    exec.push({ kind: 'basic', hero: p, hand: hand?.uid, fromWindup });
    try { return orig(p, snap); } finally { exec.pop(); }
  });
  wrap('executeResolved', (orig) => (p: PlayerEntity, snap: PlayerSnapshot, res: ResolvedActive, rank: number, withProcs?: boolean) => {
    const fromWindup = inWindup.has(p.id);
    const node = fromWindup && p.windup?.kind === 'skill' ? p.windup.nodeId : castingNode.get(p.id);
    if (fromWindup) checkLoadout(p, node ?? '?');
    // I4: невыученное не срабатывает — и из замаха, начатого до сброса скилов (сброс — команда между тиками).
    if (node && !((p.save.skills[node] ?? 0) > 0)) V('I4', 'unlearned-fires', `${heroName(p)}: «${node}» сработал${fromWindup ? ' из замаха' : ''} с рангом 0 (скил сброшен/не выучен)`);
    const a = res.active;
    if ((a.category === 'attack' || a.category === 'cast' || a.category === 'curse') && !skillWeaponAllowed(a, p.save.equipment.weapon, p.save.equipment.offhand)) {
      V('I4', 'weapon-gate', `${heroName(p)}: «${node ?? a.abilityId}» сработал не тем оружием (${p.save.equipment.weapon?.weaponClass ?? 'кулаки'})`);
    }
    exec.push({ kind: 'skill', hero: p, res, fromWindup, nodeId: node });
    try { return orig(p, snap, res, rank, withProcs); } finally { exec.pop(); }
  });
  wrap('rollHitProcs', (orig) => (p: PlayerEntity, trigger: string) => {
    exec.push({ kind: 'proc', hero: p });
    try { return orig(p, trigger); } finally { exec.pop(); }
  });
  const inWindup = new Set<string>();
  const castingNode = new Map<string, string>();
  wrap('stepWindup', (orig) => (p: PlayerEntity, snap: PlayerSnapshot, dt: number) => {
    inWindup.add(p.id);
    try { return orig(p, snap, dt); } finally { inWindup.delete(p.id); }
  });
  const checkLoadout = (p: PlayerEntity, what: string): void => {
    const t = trackOf(p.id);
    const now = loadoutSig(p);
    if (t.castSig !== undefined && t.castSig !== now) V('I2', 'loadout', `${heroName(p)}: «${what}» ударил из замаха, начатого с другим снаряжением/тоглами (R6-02): было ${t.castSig}, стало ${now}`);
  };

  // ── Доставка урона ──
  wrap('meleeSwing', (orig) => (p: PlayerEntity, packet: unknown, attacker: unknown, weapon: Item | undefined, opts: unknown, rangeMult = 1, arcMult = 1) => {
    const mel = bal.melee;
    const e = exec[exec.length - 1];
    const eq = equippedUids(p);
    if (weapon && !eq.has(weapon.uid)) V('I2', 'melee-weapon', `${heroName(p)} бьёт ненадетым оружием ${weapon.baseId}/${weapon.uid.slice(-6)}`);
    if (weapon) {
      const worn = Object.values(p.save.equipment).find((it) => it?.uid === weapon.uid);
      if (worn && (weapon.reachMult ?? 1) > (worn.reachMult ?? 1) + EPS) V('I2', 'melee-reach-item', `${heroName(p)}: дальность оружия во взмахе ${weapon.reachMult} больше надетого ${worn.reachMult}`);
    }
    if (e?.kind === 'basic') {
      if (rangeMult !== 1 || arcMult !== 1) V('I2', 'melee-mult', `${heroName(p)}: базовый удар с множителями скила ×${rangeMult}/×${arcMult}`);
      if ((weapon?.uid) !== e.hand) V('I2', 'melee-weapon', `${heroName(p)}: базовый удар не той рукой (${weapon?.uid ?? 'кулак'} вместо ${e.hand ?? 'кулака'})`);
    } else if (e?.kind === 'skill' && e.res.active.category === 'attack') {
      const a = e.res.active;
      if (rangeMult > a.rangeMult + EPS || arcMult > a.arcMult + EPS) V('I2', 'melee-mult', `${heroName(p)}: взмах скила шире оплаченного ×${rangeMult}/×${arcMult} против ×${a.rangeMult}/×${a.arcMult}`);
      if (weapon && weapon.uid !== p.save.equipment.weapon?.uid) V('I2', 'melee-weapon', `${heroName(p)}: скил бьёт не основным оружием`);
    }
    ctx.push({ kind: 'melee', hero: p, alive0: p.alive, origin: { ...p.pos }, facing: p.facing, range: mel.baseRange * (weapon?.reachMult ?? 1) * rangeMult, arc: mel.baseArc * (weapon?.arcMult ?? 1) * arcMult, hit: new Set() });
    try { return orig(p, packet, attacker, weapon, opts, rangeMult, arcMult); } finally { ctx.pop(); }
  });
  wrap('skillNova', (orig) => (p: PlayerEntity, packet: unknown, attacker: unknown, active: { radius: number }, opts: unknown) => {
    ctx.push({ kind: 'nova', hero: p, alive0: p.alive, origin: { ...p.pos }, radius: active.radius || NOVA_R, hit: new Set() });
    try { return orig(p, packet, attacker, active, opts); } finally { ctx.pop(); }
  });
  wrap('doLeap', (orig) => (p: PlayerEntity, packet: unknown, attacker: unknown, active: { dashDist: number; radius: number }, rank: number, opts: unknown) => {
    const d = active.dashDist > 0 ? active.dashDist : 150;
    const to = moveWithCollision(p.pos, { x: Math.cos(p.facing) * d, y: Math.sin(p.facing) * d }, p.radius, world.grid, 1, world.obstacles);
    ctx.push({ kind: 'leap', hero: p, alive0: p.alive, to, radius: active.radius > 0 ? active.radius : 60 });
    try { return orig(p, packet, attacker, active, rank, opts); } finally { ctx.pop(); }
  });
  wrap('doDashAttack', (orig) => (p: PlayerEntity, packet: unknown, attacker: unknown, active: { dashDist: number }, rank: number, opts: unknown) => {
    const d = active.dashDist > 0 ? active.dashDist : 130;
    const from = { ...p.pos };
    const to = moveWithCollision(p.pos, { x: Math.cos(p.facing) * d, y: Math.sin(p.facing) * d }, p.radius, world.grid, 1, world.obstacles);
    const wpn = asHeld(p.save.equipment.weapon, p.save, grip);
    const halfW = swingHalfWidth(bal.melee.baseRange * (wpn?.reachMult ?? 1), bal.melee.baseArc * (wpn?.arcMult ?? 1));
    ctx.push({ kind: 'dash', hero: p, alive0: p.alive, from, to, halfW });
    try { return orig(p, packet, attacker, active, rank, opts); } finally { ctx.pop(); }
  });
  wrap('projectileHit', (orig) => (proj: ProjectileEntity) => {
    const last = projLast.get(proj.id);
    const cell = cellOf(proj.pos);
    if (isBlockedCell(world.grid, cell.cx, cell.cy)) V('I2', 'proj-wall', `снаряд ${proj.id} (${proj.owner}) бьёт из стены ${fmt(proj.pos)}`);
    if (last && sealCrossed(world.grid, last, proj.pos)) V('I2', 'proj-wall', `снаряд ${proj.id} прошёл диагональный шов ${fmt(last)}→${fmt(proj.pos)}`);
    // ⚠ C-10: подшаг сквозь преграду декора, закрывающую обзор (колонна), — как сквозь стену: снаряд о неё гаснет (бумеранг — разворот).
    if (last && sightBlockedByObstacles(sight, last.x, last.y, proj.pos.x, proj.pos.y)) V('I2', 'proj-los', `снаряд ${proj.id} (${proj.owner}) пролетел колонну, закрывающую обзор ${fmt(last)}→${fmt(proj.pos)}`);
    if (sight.some((o) => dist(o, proj.pos) < 2 * PROJ_R)) w.cover['proj-pillar'] = (w.cover['proj-pillar'] ?? 0) + 1;
    projLast.set(proj.id, { ...proj.pos });
    const hero = proj.owner === 'player' ? world.players[proj.ownerId as string] : undefined;
    ctx.push({ kind: 'proj', hero, pos: { ...proj.pos }, projId: proj.id });
    try { return orig(proj); } finally { ctx.pop(); }
  });
  wrap('applyCurse', (orig) => (p: PlayerEntity, active: { radius: number }) => {
    const before = new Map(world.monsters.map((m) => [m.id, JSON.stringify(m.debuffs) + '#' + m.alertTimer]));
    const pb = new Map(Object.values(world.players).map((t) => [t.id, JSON.stringify(t.debuffs)]));
    const origin = { ...p.pos };
    const out = orig(p, active);
    for (const m of world.monsters) {
      if (before.get(m.id) === JSON.stringify(m.debuffs) + '#' + m.alertTimer) continue;
      w.cover['hit-curse'] = (w.cover['hit-curse'] ?? 0) + 1;
      const d = dist(origin, m.pos);
      if (d > active.radius + EPS) V('I2', 'curse-range', `${heroName(p)}: проклятие задело монстра ${m.id} на ${d.toFixed(1)} > ${active.radius}`);
      if (!los(origin, m.pos)) V('I2', 'curse-los', `${heroName(p)}: проклятие задело монстра ${m.id} сквозь стену`);
    }
    for (const t of Object.values(world.players)) {
      if (t === p || pb.get(t.id) === JSON.stringify(t.debuffs)) continue;
      if (!world.pvp) V('I2', 'pvp-off', `${heroName(p)}: проклятие повесило статус на героя ${t.id} вне арены`);
      if (dist(origin, t.pos) > active.radius + EPS || !los(origin, t.pos)) V('I2', 'curse-range', `${heroName(p)}: проклятие задело героя ${t.id} вне радиуса/видимости`);
    }
    return out;
  });

  // Приход ресурса изнутри удара (вампиризм, лечение за убийство, левелап) — касту позволено столько «вернуть».
  const gains = new Map<string, number>();
  wrap('hitMonster', (orig) => (killer: PlayerEntity, m: MonsterEntity, packet: unknown, attacker: unknown, opts: unknown) => {
    checkHit(killer, m, `монстра ${m.id}`);
    const b = { mana: killer.mana, stamina: killer.stamina };
    const out = orig(killer, m, packet, attacker, opts);
    gains.set(killer.id, (gains.get(killer.id) ?? 0) + Math.max(0, killer.mana - b.mana) + Math.max(0, killer.stamina - b.stamina));
    return out;
  });
  // I6 (R15-10): левелап лечит до максимума С РАНТАЙМ-МОДАМИ (аура, стойка, бафф, бафф зелья), и снимок тика до его конца — с ними же:
  // по нему идут замах, удар монстра по броне/сопротивлениям/блоку и потолок вампиризма. Голый сейв лечил стойку +15 % к жизни до ~87 %.
  wrap('awardXp', (orig) => (p: PlayerEntity, amount: number) => {
    const n0 = events().length;
    const out = orig(p, amount);
    if (!p.alive || !events().slice(n0).some((e) => e.type === 'levelup' && e.playerId === p.id)) return out;
    const cov = p.toggles.length > 0 || Object.keys(p.skillBuffs).length > 0 ? 'levelup-mods' : 'levelup';
    w.cover[cov] = (w.cover[cov] ?? 0) + 1;
    const o = probe.oracle(p).derived;
    probe.levelMax.set(p.id, {
      hp: o.maxHp, mana: o.maxMana, stamina: o.maxStamina,
      effMana: effectivePool(o.maxMana, reservedFrac(reg, p.toggles, 'mana')), effStam: effectivePool(o.maxStamina, reservedFrac(reg, p.toggles, 'stamina')),
    });
    const on = `тоглы ${p.toggles.join(',') || '—'}, баффы ${Object.keys(p.skillBuffs).join(',') || '—'}`;
    if (!(Math.abs(p.maxHp - o.maxHp) <= EPS) || !(Math.abs(p.hp - o.maxHp) <= EPS)) {
      V('I6', 'levelup-heal', `${heroName(p)}: левелап — здоровье ${p.hp.toFixed(3)}/${p.maxHp.toFixed(3)}, максимум с рантайм-модами ${o.maxHp.toFixed(3)} (${on})`);
    }
    const d = w.s.snapshotOf(p.id)?.derived as unknown as Record<string, unknown> | undefined;
    const off = d ? Object.entries(o).filter(([k, v]) => typeof v === 'number' && !(Math.abs((d[k] as number) - v) <= EPS * Math.max(1, Math.abs(v)))).map(([k]) => k) : ['нет снимка'];
    if (off.length) V('I6', 'levelup-snap', `${heroName(p)}: снимок тика после левелапа — не с рантайм-модами, расходятся ${off.join(', ')} (${on})`);
    return out;
  });
  wrap('hitPlayer', (orig) => (t: PlayerEntity, packet: unknown, attacker: unknown, onHit: unknown, by: string, source?: MonsterEntity) => {
    const hero = world.players[by];
    if (hero) {
      w.cover['hit-pvp'] = (w.cover['hit-pvp'] ?? 0) + 1;
      if (!world.pvp) V('I2', 'pvp-off', `${heroName(hero)} ранил героя ${t.id} вне арены`);
      if (t.spawnImmuneUntil > world.timeMs) V('I2', 'pvp-immune', `${heroName(hero)} ранил героя ${t.id} под спавн-иммунитетом`);
      if (t === hero) V('I2', 'pvp-self', `${heroName(hero)} ранил сам себя`);
      checkHit(hero, t, `героя ${t.id}`);
    } else {
      // C-10: снаряд монстра — тоже только по видимому с места полёта (сетка, шов, колонна).
      const c = ctx[ctx.length - 1];
      if (c?.kind === 'proj' && !hasLineOfSight(world.grid, c.pos.x, c.pos.y, t.pos.x, t.pos.y, sight)) V('M2', 'proj-los', `снаряд ${c.projId} монстра попал в героя ${t.id} сквозь стену/колонну ${fmt(c.pos)}→${fmt(t.pos)}`);
      // ⚠ R21-06: взрыв конструкта — в радиусе (монстр + 48 + герой) и в видимости от монстра, как его ближний удар (M2) и снаряд.
      if (c?.kind === 'blast') {
        w.cover['hit-blast'] = (w.cover['hit-blast'] ?? 0) + 1;
        const d = dist(c.origin, t.pos);
        if (d > c.radius + t.radius + EPS) V('M2', 'blast-range', `взрыв монстра ${c.m.id} (${c.m.def.id}) задел героя ${t.id} с ${d.toFixed(1)} px > ${(c.radius + t.radius).toFixed(1)}`);
        if (!los(c.origin, t.pos)) V('M2', 'blast-los', `взрыв монстра ${c.m.id} (${c.m.def.id}) задел героя ${t.id} сквозь стену/дверь/колонну ${fmt(c.origin)}→${fmt(t.pos)}`);
      }
    }
    ctx.push({ kind: 'struck', hero: t, source });
    try { return orig(t, packet, attacker, onHit, by, source); } finally { ctx.pop(); }
  });
  // ⚠ R21-06: взрыв конструкта при смерти — контекст доставки монстра; покрытие — герои в радиусе, но вне видимости (правило держит их).
  wrap('overloadOnDeath', (orig) => (m: MonsterEntity) => {
    const radius = m.radius + BLAST_R;
    if (behaviorFor(m.def.faction, reg.get('monster-behaviors')).signature === 'overload') {
      w.cover.blast = (w.cover.blast ?? 0) + 1;
      for (const t of Object.values(world.players)) {
        if (t.alive && dist(m.pos, t.pos) <= radius + t.radius && !los(m.pos, t.pos)) w.cover['blast-behind-wall'] = (w.cover['blast-behind-wall'] ?? 0) + 1;
      }
    }
    const up = Object.values(world.players).filter((t) => t.alive);
    ctx.push({ kind: 'blast', m, origin: { ...m.pos }, radius });
    try { return orig(m); } finally {
      ctx.pop();
      // Взрыв убил героя (бывает и того, кто добил): награды убийцы — до взрыва, живому (I6 `dead-hp`, `xp-dead` это держат).
      for (const t of up) if (!t.alive) w.cover['blast-kill'] = (w.cover['blast-kill'] ?? 0) + 1;
    }
  });
  wrap('reflectToMonster', (orig) => (p: PlayerEntity, m: MonsterEntity, amount: number, element: unknown) => {
    const c = ctx[ctx.length - 1];
    if (c?.kind !== 'struck' || c.source !== m) V('I2', 'reflect', `${heroName(p)}: отражение ушло монстру ${m.id}, который его не бил`);
    return orig(p, m, amount, element);
  });
  // M2: ближний удар монстра — в досягаемости (сумма радиусов + запас ядра 8) и видимости.
  wrap('monsterMelee', (orig) => (m: MonsterEntity, t: PlayerEntity) => {
    const reach = m.radius + t.radius + 8;
    const d = dist(m.pos, t.pos);
    if (d > reach + EPS) V('M2', 'melee-reach', `монстр ${m.id} (${m.def.id}) ударил героя ${t.id} с ${d.toFixed(1)} px > ${reach}`);
    if (!los(m.pos, t.pos)) V('M2', 'melee-los', `монстр ${m.id} ударил героя ${t.id} сквозь стену`);
    if (!m.alive) V('M2', 'dead-attacker', `мёртвый монстр ${m.id} ударил`);
    return orig(m, t);
  });

  // ── Ввод: движение за тик ──
  wrap('stepPlayerInput', (orig) => (p: PlayerEntity, snap: PlayerSnapshot, input: PlayerInput | undefined, dt: number) => {
    const pos0 = { ...p.pos };
    const dash0 = p.dash ? { ...p.dash } : null;
    const stun0 = p.stunTimer > 0;
    const vel0 = Math.hypot(p.vel.x, p.vel.y);
    const dodge0 = p.dodgeCd;
    const mm = debuffMods(p.debuffs, reg.get('debuffs')).moveMult;
    const o = probe.oracle(p).derived;
    const out = orig(p, snap, input, dt);
    const d = dist(pos0, p.pos);
    let cap: number;
    let what: string;
    if (dash0 && !stun0) { cap = dash0.speed; what = dash0.lockFacing ? 'уклонение' : 'рывок'; }
    else if (p.dodgeCd > dodge0 + EPS) { cap = Math.max(1, bal.dodge.speed); what = 'уклонение (старт)'; }
    else {
      cap = stun0 ? 0 : o.moveSpeed * Math.min(1, mm) * Math.max(1, o.attackMoveMult);
      if (bal.moveInertia.enabled) cap = Math.max(cap, vel0);
      what = stun0 ? 'оглушён' : 'шаг';
    }
    // Преграды декора выталкивают круг по нормали: к шагу добавляется проникновение (не больше самого шага) — и глубина, на которой круг
    // начал тик внутри преграды (V-RF-05: её выносит и толчок без шага; раньше допуск оглушённому у преграды был ровно ноль).
    const nearObst = obstacleNear(world.obstacles, pos0, p.pos, p.radius);
    const allow = cap * dt * (nearObst ? 2 : 1) + (nearObst ? OBSTACLE_PASSES * obstacleDepth(world.obstacles, pos0, p.radius) : 0) + 1e-6;
    if (d > allow) {
      const code = wallOverlap(world.grid, pos0, p.radius) > 1e-9 ? 'speed-wallsnap' : 'speed';
      const dd = dash0 ? ` рывок{dir ${Math.atan2(dash0.dy, dash0.dx).toFixed(2)} v ${dash0.speed} ост ${dash0.remaining.toFixed(3)}}` : '';
      V('I1', code, `${heroName(p)} ${what}${code === 'speed-wallsnap' ? ' (тик начат кругом в стене)' : ''}: сдвиг ${d.toFixed(3)} px за тик > ${allow.toFixed(3)} (скорость ${cap.toFixed(1)}×${dt.toFixed(4)}${nearObst ? '×2 у преграды' : ''}) ${fmt(pos0)}→${fmt(p.pos)}${dd} стан ${stun0} ввод ${JSON.stringify(input?.move)} dodge ${input?.dodge ?? false}`);
    }
    return out;
  });

  // ── Касты и удары: кто, чем, по карману ли, в откат ли ──
  wrap('tryPlayerAttack', (orig) => (p: PlayerEntity, snap: PlayerSnapshot) => {
    const n0 = events().length;
    const t = trackOf(p.id);
    const before = { cd: p.attackCd, windup: !!p.windup, mana: p.mana, sig: loadoutSig(p), castSig: t.castSig, lockUntil: t.lockUntil };
    const hands = attackWeaponsOf(p.save, grip);
    const o = probe.oracle(p).derived;
    const minCd = 1 / Math.max(0.2, o.attackSpeed * (hands.length > 1 ? 1.2 : 1));
    // Подпись — ДО оригинала: мгновенный удар сверяется с ней же изнутри вызова.
    t.castSig = before.sig;
    const out = orig(p, snap);
    const sw = events().slice(n0).find((e) => e.type === 'swing' && e.playerId === p.id && e.ability === 'attack');
    if (!sw) { t.castSig = before.castSig; return out; }
    w.cover.attack = (w.cover.attack ?? 0) + 1;
    if (before.cd > 0 || before.windup) V('I3', 'attack-lock', `${heroName(p)}: удар при идущем локе/замахе (attackCd ${before.cd.toFixed(3)})`);
    if (world.timeMs < before.lockUntil - 1e-3) V('I3', 'attack-lock', `${heroName(p)}: удар на ${(before.lockUntil - world.timeMs).toFixed(1)} мс раньше конца лока по формуле скорости`);
    if (p.attackCd < minCd - 1e-9) V('I3', 'attack-cd-short', `${heroName(p)}: лок удара ${p.attackCd.toFixed(4)} < формулы ${minCd.toFixed(4)} (скорость ${o.attackSpeed.toFixed(3)})`);
    t.lockUntil = world.timeMs + minCd * 1000;
    t.castNode = 'attack'; t.series = undefined;
    return out;
  });
  wrap('castSkill', (orig) => (p: PlayerEntity, snap: PlayerSnapshot, nodeId: string) => {
    const n0 = events().length;
    const rank = p.save.skills[nodeId] ?? 0;
    const before = { mana: p.mana, stamina: p.stamina, cd: p.skillCd[nodeId] ?? 0, attackCd: p.attackCd, windup: !!p.windup, buff: p.skillBuffs[nodeId] ?? 0, toggles: [...p.toggles].sort().join(','), sig: loadoutSig(p) };
    const res = payable(reg, p, nodeId);
    gains.set(p.id, 0);
    castingNode.set(p.id, nodeId);
    const t = trackOf(p.id);
    const was = { castSig: t.castSig, lockUntil: t.lockUntil, cdUntil: t.cdUntil[nodeId], series: t.series };
    // Подпись и серия — ДО оригинала: мгновенный замах бьёт изнутри вызова и сверяется с ними.
    if (res && (res.active.category === 'attack' || res.active.category === 'cast' || res.active.category === 'curse')) t.castSig = before.sig;
    if (res?.active.category === 'attack') t.series = { node: nodeId, hits: Math.max(1, res.active.hits), chains: 0 };
    let out: unknown;
    try { out = orig(p, snap, nodeId); } finally { castingNode.delete(p.id); }
    const fresh = events().slice(n0);
    const acted = fresh.some((e) => (e.type === 'swing' || e.type === 'cooldown') && e.playerId === p.id && e.ability === nodeId && !(e.type === 'swing' && e.chain));
    const toggled = [...p.toggles].sort().join(',') !== before.toggles;
    if (!acted && !toggled) {
      t.castSig = was.castSig; t.series = was.series;
      // Отказ: ничего не списано и не тронуто.
      if (p.mana < before.mana - EPS || p.stamina < before.stamina - EPS) V('I4', 'refusal-costs', `${heroName(p)}: отказ каста «${nodeId}» списал ресурс`);
      return out;
    }
    w.cover.cast = (w.cover.cast ?? 0) + 1;
    const tree = reg.get('skill-tree');
    const node = tree.nodes.find((n) => n.id === nodeId);
    const br = node ? tree.branches.find((b) => b.id === node.branchId) : undefined;
    if (!(rank > 0)) V('I4', 'unlearned-cast', `${heroName(p)}: каст невыученного «${nodeId}» (ранг ${rank})`);
    if (!node || (br?.classId && br.classId !== p.save.classId)) V('I4', 'foreign-class', `${heroName(p)}: каст узла чужого класса «${nodeId}»`);
    if (!res) { V('I4', 'unlearned-cast', `${heroName(p)}: каст «${nodeId}» без активки`); return out; }
    const a = res.active;
    if (a.category === 'aura' || a.category === 'stance') {
      w.cover.toggle = (w.cover.toggle ?? 0) + 1;
      if (reservedFrac(reg, p.toggles, 'mana') >= 1 || reservedFrac(reg, p.toggles, 'stamina') >= 1) V('I4', 'reserve', `${heroName(p)}: резерв пула ≥ 100%`);
      return out;
    }
    if ((a.category === 'attack' || a.category === 'cast' || a.category === 'curse') && !skillWeaponAllowed(a, p.save.equipment.weapon, p.save.equipment.offhand)) {
      V('I4', 'weapon-gate', `${heroName(p)}: каст «${nodeId}» не тем оружием (${p.save.equipment.weapon?.weaponClass ?? 'кулаки'})`);
    }
    // Цена: по карману до каста и списана (минус то, что вернули удары того же кадра: вампиризм, за убийство).
    const pay = { mana: 0, stamina: 0 };
    pay[a.resource === 'stamina' ? 'stamina' : 'mana'] += a.manaCost;
    if (res.extraCost) pay[res.extraCost.pool] += res.extraCost.amount;
    const leveled = fresh.some((e) => e.type === 'levelup' && e.playerId === p.id);
    for (const k of ['mana', 'stamina'] as const) {
      if (pay[k] <= 0) continue;
      if (before[k] < pay[k] - EPS) V('I4', 'unaffordable', `${heroName(p)}: «${nodeId}» стоит ${pay[k]} ${k}, было ${before[k].toFixed(2)}`);
      const back = gains.get(p.id) ?? 0;
      if (!leveled && p[k] > before[k] - pay[k] + back + 1e-6) V('I4', 'unpaid', `${heroName(p)}: «${nodeId}» стоит ${pay[k]} ${k}, списано ${(before[k] - p[k]).toFixed(3)} (вернули ударом ${back.toFixed(3)})`);
    }
    // Откат узла: не поверх идущего, и не короче формулы (`abilityCooldown` от оплаченной способности и ранга).
    if (before.cd > 0) V('I3', 'skill-cd', `${heroName(p)}: «${nodeId}» при идущем откате ${before.cd.toFixed(3)} с`);
    if (world.timeMs < (was.cdUntil ?? -Infinity) - 1e-3) V('I3', 'skill-cd', `${heroName(p)}: «${nodeId}» на ${((was.cdUntil ?? 0) - world.timeMs).toFixed(1)} мс раньше отката`);
    if (a.cooldown > 0) {
      const want = abilityCooldown(a.cooldown, rank);
      if ((p.skillCd[nodeId] ?? 0) < want - 1e-9) V('I3', 'skill-cd-short', `${heroName(p)}: откат «${nodeId}» ${p.skillCd[nodeId] ?? 0} < ${want}`);
      t.cdUntil[nodeId] = world.timeMs + want * 1000;
    }
    if (a.category === 'buff') {
      w.cover.buff = (w.cover.buff ?? 0) + 1;
      if (before.buff > 0) V('I4', 'buff-refresh', `${heroName(p)}: бафф «${nodeId}» обновлён, пока действует (${before.buff.toFixed(2)} с)`);
      if ((p.skillBuffs[nodeId] ?? 0) > a.durationSec + EPS) V('I4', 'buff-duration', `${heroName(p)}: бафф «${nodeId}» ${p.skillBuffs[nodeId]} с > ${a.durationSec}`);
      // ⭐ D4: отдых после действия и доля времени под баффом — в тике, по часам героя (`buffClock`): и у узлов, и у печатей, через арены
      // и переподключения (R19-03 мерил здесь, по часам мира и только каст узла).
    }
    if (a.category === 'attack') {
      if (before.attackCd > 0 || before.windup) V('I3', 'attack-lock', `${heroName(p)}: атака-скил «${nodeId}» при идущем локе/замахе`);
      if (world.timeMs < was.lockUntil - 1e-3) V('I3', 'attack-lock', `${heroName(p)}: атака-скил «${nodeId}» на ${(was.lockUntil - world.timeMs).toFixed(1)} мс раньше лока`);
      const o = probe.oracle(p).derived;
      const hits = Math.max(1, a.hits);
      const minCd = hits / Math.max(0.2, o.attackSpeed * a.speed * condSpeedCap(res));
      if (p.attackCd < minCd - 1e-9) V('I3', 'attack-cd-short', `${heroName(p)}: лок серии «${nodeId}» ${p.attackCd.toFixed(4)} < ${minCd.toFixed(4)} (${hits} взм.)`);
      t.lockUntil = world.timeMs + minCd * 1000;
    }
    if (a.category === 'cast' || a.category === 'curse') {
      if (before.windup) V('I3', 'windup-overlap', `${heroName(p)}: каст «${nodeId}» поверх идущего замаха`);
    }
    if (a.category === 'attack' || a.category === 'cast' || a.category === 'curse') t.castNode = nodeId;
    else { t.castSig = was.castSig; t.series = was.series; }
    return out;
  });

  // ── Подбор, сундук, рычаг ──
  let pickVia: 'auto' | 'E' | 'id' | undefined;
  wrap('autoPickup', (orig) => (p: PlayerEntity) => { pickVia = 'auto'; try { return orig(p); } finally { pickVia = undefined; } });
  wrap('tryPickup', (orig) => (p: PlayerEntity) => { pickVia = 'E'; try { return orig(p); } finally { pickVia = undefined; } });
  wrap('pickupDropById', (orig) => (pid: string, dropId: number) => { pickVia = 'id'; try { return orig(pid, dropId); } finally { pickVia = undefined; } });
  wrap('takeDrop', (orig) => (p: PlayerEntity, index: number) => {
    const d = world.drops[index];
    const via = pickVia;
    const at = { ...p.pos };
    const out = orig(p, index) as unknown;
    if (!d || !out) return out;
    w.cover[`pick-${via ?? '?'}`] = (w.cover[`pick-${via ?? '?'}`] ?? 0) + 1;
    probe.taken.set(d.id, p.id);
    const R = via === 'auto' ? bal.autoPickup.radius : PICK_R;
    const dd = dist(at, d.pos);
    if (!via) V('I5', 'pickup-path', `${heroName(p)} поднял дроп ${d.id} неизвестным путём`);
    if (dd > R + EPS) V('I5', 'pickup-range', `${heroName(p)} поднял (${via}) дроп ${d.id} с ${dd.toFixed(1)} px > ${R}`);
    if (!los(at, d.pos)) V('I5', 'pickup-los', `${heroName(p)} поднял (${via}) дроп ${d.id} сквозь стену ${fmt(at)}→${fmt(d.pos)}`);
    if ((d.owner !== undefined && d.owner !== p.account) || (d.heldBy !== undefined && d.heldBy !== p.save.charId)) V('I5', 'pickup-foreign', `${heroName(p)} (${p.account}) поднял выброшенное ${d.owner}/${d.heldBy}`);
    if (!p.alive) V('I5', 'pickup-dead', `мёртвый ${heroName(p)} поднял дроп ${d.id} (${via})`);
    if (via !== 'auto' && p.stunTimer > 0) V('I5', 'pickup-stunned', `оглушённый ${heroName(p)} поднял дроп ${d.id} (${via})`);
    if (via === 'auto' && d.kind === 'item' && !bal.autoPickup.rarities.includes(d.item.rarity)) V('I5', 'pickup-auto-item', `${heroName(p)}: автоподбор вещи редкости ${d.item.rarity}`);
    // R1-05 — правило ТИКА (команды того же соединения ждут транзакцию в очереди кадров `RoomManager`, модель их не шлёт).
    if (via !== 'id' && w.s.saveHeld.has(p.id)) V('I5', 'held', `${heroName(p)}: подбор (${via}) при сейве под транзакцией (R1-05)`);
    return out;
  });
  wrap('openChest', (orig) => (pid: string, chestId?: number) => {
    const p = world.players[pid];
    const shut = new Map(world.chests.filter((c) => !c.opened).map((c) => [c.id, c]));
    const at = p ? { ...p.pos } : undefined;
    const nDrops = world.drops.length;
    const out = orig(pid, chestId) as boolean;
    for (const c of world.chests) {
      if (!c.opened || !shut.has(c.id)) continue;
      w.cover.chest = (w.cover.chest ?? 0) + 1;
      probe.chests.set(c.id, pid);
      if (!p || !at) { V('I5', 'chest-nobody', `сундук ${c.id} открыт без героя`); continue; }
      const dd = dist(at, c.pos);
      if (dd > USE_R + EPS) V('I5', 'chest-range', `${heroName(p)} открыл сундук ${c.id} с ${dd.toFixed(1)} px > ${USE_R}`);
      if (!los(at, c.pos)) V('I5', 'chest-los', `${heroName(p)} открыл сундук ${c.id} сквозь стену`);
      if (!p.alive) V('I5', 'chest-dead', `мёртвый ${heroName(p)} открыл сундук ${c.id}`);
      if (p.stunTimer > 0) V('I5', 'chest-stunned', `оглушённый ${heroName(p)} открыл сундук ${c.id}`);
      if (chestId != null && chestId !== c.id) V('I5', 'chest-wrong', `${heroName(p)} просил сундук ${chestId}, открылся ${c.id}`);
      const tier = reg.get('chests').find((t) => t.id === c.tier);
      const got = world.drops.length - nDrops;
      if (tier && (got < tier.itemsMin || got > Math.max(tier.itemsMin, tier.itemsMax))) V('I5', 'chest-count', `сундук ${c.id} (${c.tier}) дал ${got} вещей, вилка ${tier.itemsMin}–${tier.itemsMax}`);
    }
    if (world.chests.filter((c) => c.opened && shut.has(c.id)).length > 1) V('I5', 'chest-many', `одно [E]/команда открыло несколько сундуков`);
    if (out && ![...shut.keys()].some((id) => world.chests.find((c) => c.id === id)?.opened)) V('I5', 'chest-phantom', `openChest вернул «открыт», но ни один сундук не открылся`);
    return out;
  });
  wrap('openLever', (orig) => (pid: string, leverId: number) => {
    const p = world.players[pid];
    const lv = world.levers.find((l) => l.id === leverId);
    const was = lv?.used;
    const at = p ? { ...p.pos } : undefined;
    const grid0 = world.grid.map((row) => row.slice());
    const out = orig(pid, leverId) as number | null;
    let changed = 0;
    for (let y = 0; y < world.grid.length; y++) for (let x = 0; x < (world.grid[y]?.length ?? 0); x++) if (world.grid[y]![x] !== grid0[y]![x]) changed++;
    if (out == null) { if (changed) V('I5', 'lever-refused-opened', `отказ рычага ${leverId} всё же поменял ${changed} клеток`); return out; }
    w.cover.lever = (w.cover.lever ?? 0) + 1;
    if (!p || !lv || !at) { V('I5', 'lever-nobody', `рычаг ${leverId} сработал без героя/рычага`); return out; }
    if (was) V('I5', 'lever-twice', `${heroName(p)}: рычаг ${leverId} дёрнут второй раз`);
    const dd = dist(at, lv.pos);
    if (dd > USE_R + EPS) V('I5', 'lever-range', `${heroName(p)} дёрнул рычаг ${leverId} с ${dd.toFixed(1)} px > ${USE_R}`);
    if (!los(at, lv.pos)) V('I5', 'lever-los', `${heroName(p)} дёрнул рычаг ${leverId} сквозь стену`);
    if (!p.alive) V('I5', 'lever-dead', `мёртвый ${heroName(p)} дёрнул рычаг ${leverId}`);
    if (p.stunTimer > 0) V('I5', 'lever-stunned', `оглушённый ${heroName(p)} дёрнул рычаг ${leverId}`);
    if (out !== lv.doorId) V('I5', 'lever-door', `рычаг ${leverId} открыл дверь ${out}, а его — ${lv.doorId}`);
    const door = world.doors.find((d) => d.id === lv.doorId);
    const own = new Set((door?.cells ?? []).map((c) => `${c.cx},${c.cy}`));
    for (let y = 0; y < world.grid.length; y++) for (let x = 0; x < (world.grid[y]?.length ?? 0); x++) {
      if (world.grid[y]![x] !== grid0[y]![x] && !own.has(`${x},${y}`)) V('I5', 'lever-door', `рычаг ${leverId} поменял клетку ${x},${y} не своей двери`);
    }
    return out;
  });

  // ── Зелье пояса: тратится только с эффектом, живым, не оглушённым, не под транзакцией ──
  wrap('useBeltSlot', (orig) => (p: PlayerEntity, slot: number) => {
    const item = p.save.belt[slot];
    // C-11: бафф колбы (`pot:<база>`) — тоже эффект: освежён до полной длительности своей базы, не выше.
    const potKey = item ? `pot:${item.baseId}` : '';
    const def = item ? potionBuffDef(reg, item.baseId) : undefined;
    const b = { hp: p.hp, mana: p.mana, deb: JSON.stringify(p.debuffs), pot: p.skillBuffs[potKey] ?? 0 };
    const out = orig(p, slot);
    const buffed = (p.skillBuffs[potKey] ?? 0) > b.pot + EPS;
    if (buffed) {
      w.cover['belt-buff'] = (w.cover['belt-buff'] ?? 0) + 1;
      if (!def) V('I5', 'potion-buff', `${heroName(p)}: колба ${item!.baseId} без баффа в конфиге повесила бафф`);
      else if (Math.abs((p.skillBuffs[potKey] ?? 0) - def.durationSec) > EPS) V('I4', 'buff-duration', `${heroName(p)}: бафф колбы ${item!.baseId} ${p.skillBuffs[potKey]} с, а длительность ${def.durationSec}`);
    }
    if (item && p.save.belt[slot] !== item) {
      w.cover.belt = (w.cover.belt ?? 0) + 1;
      const effect = p.hp > b.hp + EPS || p.mana > b.mana + EPS || JSON.stringify(p.debuffs) !== b.deb || buffed;
      if (!effect) V('I5', 'belt-noeffect', `${heroName(p)}: колба ${item.baseId} потрачена без эффекта`);
      if (!p.alive) V('I5', 'belt-dead', `мёртвый ${heroName(p)} выпил колбу`);
      if (p.stunTimer > 0) V('I5', 'belt-stunned', `оглушённый ${heroName(p)} выпил колбу`);
      if (w.s.saveHeld.has(p.id)) V('I5', 'held', `${heroName(p)}: колба пояса при сейве под транзакцией (R1-05)`);
    } else if (p.hp !== b.hp || p.mana !== b.mana || buffed) V('I5', 'belt-free', `${heroName(p)}: колба не потрачена, а эффект есть`);
    // C-11: колба с баффом при неполном баффе обязана подействовать (было: сервер баффа не вешал — «без эффекта» навсегда).
    if (item && def && p.alive && !(p.stunTimer > 0) && b.pot < def.durationSec - 1e-6 && !buffed) V('I5', 'potion-buff-lost', `${heroName(p)}: колба ${item.baseId} не повесила бафф ${def.durationSec} с (был ${b.pot.toFixed(3)})`);
    return out;
  });

  return probe;
}

// ── Ввод ──────────────────────────────────────────────────────────────────────────────────────────

type MoveMode = 'idle' | 'dir' | 'nav' | 'away' | 'jitter';
type NavTarget = 'monster' | 'chest' | 'lever' | 'drop' | 'hero' | 'exit' | 'wall';
interface Intent {
  move: MoveMode; target: NavTarget; dir: number; mag: number;
  face: 'aim' | 'fixed' | 'spin' | 'huge' | 'random'; fixed: number;
  pAttack: number; pCast: number; pDodge: number; pInteract: number; pBelt: number;
  casts: string[];
}

const MAGS = [0, 1e-9, 0.2, 1, 1, 1, 3, 1e6, 1e300];
const HUGE = [1e17, -1e17, 1e300, -1e300, 12345.678, 7 * Math.PI];
const JUNK_CASTS = ['', 'attack', ' ', '__proto__', 'constructor', 'x'.repeat(64), 'b-sword1h-a1 ', 'B-FIRE-A1', 'ins:x', 'b-aura-a1\u200b'];

function castPool(w: FuzzWorld, p: PlayerEntity, r: Rng): string[] {
  const tree = w.reg.get('skill-tree');
  const learned = Object.entries(p.save.skills).filter(([id, rk]) => rk > 0 && activeAbilityOf(w.reg, id)).map(([id]) => id);
  const actives = tree.nodes.filter((n) => n.effect.active).map((n) => n.id);
  const unlearned = actives.filter((id) => !((p.save.skills[id] ?? 0) > 0));
  const out: string[] = [];
  for (const id of learned) out.push(id, id, id);
  for (let i = 0; i < 3 && unlearned.length; i++) out.push(r.pick(unlearned));
  out.push(r.pick(JUNK_CASTS));
  return out;
}

function makeIntent(w: FuzzWorld, p: PlayerEntity, r: Rng, lead: boolean): Intent {
  return {
    move: r.pick<MoveMode>(lead ? ['nav', 'nav', 'nav', 'dir', 'idle', 'away', 'jitter'] : ['nav', 'idle', 'dir', 'jitter']),
    target: r.pick<NavTarget>(['monster', 'monster', 'monster', 'chest', 'lever', 'drop', 'drop', 'hero', 'exit', 'wall']),
    dir: r.float(-Math.PI, Math.PI), mag: r.pick(MAGS),
    face: r.pick(['aim', 'aim', 'aim', 'fixed', 'spin', 'huge', 'random'] as const), fixed: r.float(-Math.PI, Math.PI),
    pAttack: r.pick([0, 0.2, 0.8, 1]), pCast: r.pick([0, 0.1, 0.4, 0.9]), pDodge: r.pick([0, 0, 0.05, 0.3]),
    pInteract: r.pick([0, 0.1, 0.5]), pBelt: r.pick([0, 0, 0.05, 0.3]),
    casts: castPool(w, p, r),
  };
}

function navGoal(w: FuzzWorld, p: PlayerEntity, t: NavTarget, r: Rng): Vec2 | undefined {
  const W = w.s.world;
  const near = <T extends { pos: Vec2 }>(xs: T[]): T | undefined => xs.reduce<T | undefined>((b, x) => (!b || dist(x.pos, p.pos) < dist(b.pos, p.pos) ? x : b), undefined);
  switch (t) {
    case 'monster': return near(W.monsters.filter((m) => m.alive))?.pos;
    case 'chest': return near(W.chests.filter((c) => !c.opened))?.pos;
    case 'lever': return near(W.levers.map((l) => ({ pos: l.pos })))?.pos;
    case 'drop': return near(W.drops)?.pos;
    case 'hero': return near(Object.values(W.players).filter((x) => x !== p))?.pos;
    case 'exit': return W.exits?.[0];
    case 'wall': { const c = cellOf(p.pos); return cellToWorld(c.cx + r.int(-3, 3), c.cy + r.int(-3, 3)); }
  }
}

/** Кадр ввода с провода: сырые числа любой величины → `validateInput` (как `Room` на границе). */
function frame(w: FuzzWorld, p: PlayerEntity, it: Intent, r: Rng, tick: number, path: { at: number; wp?: Vec2 }): PlayerInput {
  let mx = 0, my = 0;
  if (it.move === 'dir') { mx = Math.cos(it.dir) * it.mag; my = Math.sin(it.dir) * it.mag; }
  else if (it.move === 'jitter') { const a = r.float(-Math.PI, Math.PI); const m = r.pick(MAGS); mx = Math.cos(a) * m; my = Math.sin(a) * m; }
  else if (it.move === 'nav' || it.move === 'away') {
    if (!path.wp || tick - path.at >= 8 || dist(path.wp, p.pos) < 8) {
      const goal = navGoal(w, p, it.target, r);
      path.wp = goal ? findPath(w.s.world.grid, p.pos, goal, 3000)[0] ?? goal : undefined;
      path.at = tick;
    }
    if (path.wp) { const s = it.move === 'away' ? -1 : 1; mx = (path.wp.x - p.pos.x) * s; my = (path.wp.y - p.pos.y) * s; const l = Math.hypot(mx, my) || 1; mx = (mx / l) * it.mag; my = (my / l) * it.mag; }
  }
  let facing: number;
  const m = navGoal(w, p, 'monster', r);
  switch (it.face) {
    case 'aim': facing = m ? Math.atan2(m.y - p.pos.y, m.x - p.pos.x) : it.fixed; break;
    case 'fixed': facing = it.fixed; break;
    case 'spin': facing = it.fixed + tick * 0.7; break;
    case 'huge': facing = r.pick(HUGE); break;
    default: facing = r.float(-50, 50);
  }
  const raw: Record<string, unknown> = {
    move: { x: mx, y: my }, facing, attack: r.chance(it.pAttack),
    cast: r.chance(it.pCast) ? r.pick(it.casts) : null, interact: r.chance(it.pInteract),
  };
  if (r.chance(it.pDodge)) raw.dodge = true;
  if (r.chance(it.pBelt)) raw.useBelt = r.int(0, 15);
  return validateInput(JSON.parse(JSON.stringify(raw))) ?? { move: { x: 0, y: 0 }, facing: 0, attack: false, cast: null, interact: false };
}

// ── Снимки до/после ───────────────────────────────────────────────────────────────────────────────

interface HeroPre {
  pos: Vec2; region: number; alive: boolean; hp: number; mana: number; stamina: number;
  xp: number; level: number; ua: number; us: number; um: number; gold: number;
  /** ⭐ D2: книга заработанного (`save.earned`) до шага. */
  earned?: { a: number; s: number; m: number };
  attrs: string; skills: string; masteries: string; equip: string;
  inv: Set<string>; belt: (string | null)[]; held: boolean; heldJson?: string;
  maxHp: number; maxMana: number; maxStam: number; effMana: number; effStam: number;
  /** Таймеры баффов и базы колб пояса (C-11: бафф зелья — только выпитой колбой). */
  buffs: Record<string, number>; beltBase: (string | null)[];
  /** ⚠ R23-05: откаты умений до тика (после перехода, если он был между тиками). */
  cds: Record<string, number>;
}
interface Pre { heroes: Map<string, HeroPre>; monsters: Map<number, { pos: Vec2; region: number; alive: boolean }>; drops: Map<number, DropEntity> }

const heldView = (s: SaveState): string => JSON.stringify({ inv: s.inventory, belt: s.belt, gold: s.gold, eq: s.equipment });

function capture(w: FuzzWorld): Pre {
  const W = w.s.world;
  const heroes = new Map<string, HeroPre>();
  for (const p of Object.values(W.players)) {
    const o = p.alive ? w.probe.oracle(p).derived : undefined;
    const held = w.s.saveHeld.has(p.id);
    heroes.set(p.id, {
      pos: { ...p.pos }, region: w.regions.at(p.pos), alive: p.alive, hp: p.hp, mana: p.mana, stamina: p.stamina,
      xp: p.save.xp, level: p.save.level, ua: p.save.unspentAttributePoints, us: p.save.unspentSkillPoints, um: p.save.unspentMasteryPoints,
      ...(p.save.earned ? { earned: { a: p.save.earned.attributePoints, s: p.save.earned.skillPoints, m: p.save.earned.masteryPoints } } : {}),
      gold: p.save.gold, attrs: JSON.stringify(p.save.attributes), skills: JSON.stringify(p.save.skills), masteries: JSON.stringify(p.save.masteries),
      equip: JSON.stringify(Object.entries(p.save.equipment).map(([k, it]) => [k, it?.uid])),
      inv: new Set(p.save.inventory.map((i) => i.uid)), belt: p.save.belt.map((b) => b?.uid ?? null), held,
      buffs: { ...p.skillBuffs }, beltBase: p.save.belt.map((b) => b?.baseId ?? null), cds: { ...p.skillCd },
      ...(held ? { heldJson: heldView(p.save) } : {}),
      maxHp: o?.maxHp ?? 0, maxMana: o?.maxMana ?? 0, maxStam: o?.maxStamina ?? 0,
      effMana: o ? effectivePool(o.maxMana, reservedFrac(w.reg, p.toggles, 'mana')) : 0,
      effStam: o ? effectivePool(o.maxStamina, reservedFrac(w.reg, p.toggles, 'stamina')) : 0,
    });
  }
  const monsters = new Map(W.monsters.map((m) => [m.id, { pos: { ...m.pos }, region: w.regions.at(m.pos), alive: m.alive }]));
  const drops = new Map(W.drops.map((d) => [d.id, d]));
  return { heroes, monsters, drops };
}

// ── Инварианты после тика ─────────────────────────────────────────────────────────────────────────

/**
 * ⭐ D4: ПРАВИЛО ВРЕМЕНИ БАФФА ПО ЧАСАМ ГЕРОЯ (после тика; герой был в мире и до, и после). Часы идут только, пока он в мире: у ушедшего
 * (шаг `reconnect`) время стоит — и его откаты, и баффы (R4-06), — так что круг «ушёл — вернулся» не прячет повтор раньше отдыха. Срабатывание
 * (остаток вырос: каст узла, прок печати) — не поверх идущего, не раньше «прошлое действие × (1 + buffMinRest)» от прошлого; под баффом с первого
 * срабатывания — не больше «длиннейшее действие + шаг + 1 / (1 + buffMinRest) × часы (с поправкой на квант тика)». Зелья — не правило.
 * ⚠ R21-06: и у ПАВШЕГО время стоит — тик мёртвому не ведёт ни откатов, ни баффов (`tick`: мёртвых пропускает), и бафф, застывший на
 * трупе до возрождения (оно баффы снимает), — не «время под баффом». Часы идут в тике, начатом живым (профиль `constructs`: взрыв и шаг
 * `dot` с героем на последнем издыхании кладут героев с баффом часто — часы трупа копили долю под баффом до ложного `buff-uptime`).
 */
function buffClock(w: FuzzWorld, p: PlayerEntity, b: HeroPre, dt: number, name: string, V: (inv: string, code: string, msg: string) => void): void {
  if (!b.alive) return;
  const m = w.reg.get('balance').buffMinRest;
  const bound = buffUptimeBound(m);
  const t0 = w.probe.clock.get(p.id) ?? 0;
  const t1 = t0 + dt;
  w.probe.clock.set(p.id, t1);
  let mine = w.probe.buffs.get(p.id);
  if (!mine) { mine = new Map(); w.probe.buffs.set(p.id, mine); }
  for (const k of new Set([...Object.keys(b.buffs), ...Object.keys(p.skillBuffs)])) {
    if (k.startsWith('pot:')) continue;
    const before = b.buffs[k] ?? 0, after = p.skillBuffs[k] ?? 0;
    let tr = mine.get(k);
    if (after > before + 1e-6) {
      // Срабатывание: встало на `after + dt` (тик уже снял с него свой шаг).
      const dur = after + dt;
      w.cover[k.startsWith('ins:') ? 'buff-rise-ins' : 'buff-rise'] = (w.cover[k.startsWith('ins:') ? 'buff-rise-ins' : 'buff-rise'] ?? 0) + 1;
      if (before > 1e-9) V('I4', 'buff-refresh', `${name}: бафф «${k}» освежён поверх идущего (${before.toFixed(3)} → ${dur.toFixed(3)} с)`);
      if (tr?.last !== undefined && tr.lastDur !== undefined) {
        const need = buffRestFloor(tr.lastDur, m);
        if (t0 - tr.last < need - 1e-3) V('I4', 'buff-rest', `${name}: бафф «${k}» снова через ${(t0 - tr.last).toFixed(3)} с часов героя — после ${tr.lastDur.toFixed(2)} с действия откат не короче ${need} с`);
      }
      if (!tr) { tr = { t0, up: 0, dmax: dur, dmin: dur }; mine.set(k, tr); }
      tr.last = t0; tr.lastDur = dur; tr.dmax = Math.max(tr.dmax, dur); tr.dmin = Math.min(tr.dmin, dur);
    } else if (!tr && before > 0) {
      // Остаток с прошлого (тело, возвращённое переходом, или бафф до первого тика): не больше одного действия — в запас `dmax`.
      tr = { t0, up: 0, dmax: before, dmin: Math.max(before, dt) };
      mine.set(k, tr);
    }
    if (!tr) continue;
    tr.up += after > 0 ? dt : Math.min(dt, before);
    const T = t1 - tr.t0;
    const allowed = tr.dmax + dt + bound * T * (1 + dt / Math.max(tr.dmin, dt)) + 1e-6;
    if (tr.up > allowed) V('I4', 'buff-uptime', `${name}: под баффом «${k}» ${tr.up.toFixed(2)} с из ${T.toFixed(2)} с часов героя — больше правила (${(100 * bound).toFixed(0)} % + одно действие ${tr.dmax.toFixed(2)} с = ${allowed.toFixed(2)} с)`);
  }
}

/**
 * ⚠ R23-05: ОТКАТ НЕ ДЛИННЕЕ ЧАСОВ ГЕРОЯ (перед `buffClock`: часы — ещё до этого тика). Откат встаёт в тике (каст узла, прок печати) — его конец
 * по часам героя запоминается; дальше в любом теле (арена, город, тело ухода, свежая сущность из сейва) остаток не больше «конец − часы». Короче
 * отката стерегут `skill-cd` и `buff-rest` (D4), а длиннее — этот: тело города на время арены стоит, и сейв с арены (`vitalsForSave`) и запись
 * ушедшего (`arenaAwayBody`) несли его откаты, застывшие на входе, — клич, по времени героя давно готовый, в новой комнате снова в откате.
 * Тело, пришедшее переходом между тиками, меряется остатком ДО тика (`b.cds`); часы идут в тике, начатом живым (мёртвому тик откатов не ведёт).
 */
function cdClock(w: FuzzWorld, p: PlayerEntity, b: HeroPre, dt: number, name: string, V: (inv: string, code: string, msg: string) => void): void {
  const t0 = w.probe.clock.get(p.id) ?? 0;
  const t1 = b.alive ? t0 + dt : t0;
  for (const v of cdLonger(w, p.id, b.cds, name)) V(v.inv, v.code, v.msg);
  let ends = w.probe.cdEnd.get(p.id);
  if (!ends) { ends = {}; w.probe.cdEnd.set(p.id, ends); }
  for (const [k, after] of Object.entries(p.skillCd)) {
    const before = b.cds[k] ?? 0;
    if (after > (b.alive ? before - dt : before) + 1e-6) {
      ends[k] = t1 + after;
      w.cover['cd-rise'] = (w.cover['cd-rise'] ?? 0) + 1;
    }
  }
}

/** ⚠ R23-05: откаты `cds` героя `pid` (в теле или в сейве), которые длиннее его часов сейчас (`cdClock`): конец не вставал вовсе или позже. */
function cdLonger(w: FuzzWorld, pid: string, cds: Readonly<Record<string, number>>, what: string): Violation[] {
  const t = w.probe.clock.get(pid) ?? 0;
  const ends = w.probe.cdEnd.get(pid) ?? {};
  const out: Violation[] = [];
  for (const [k, left] of Object.entries(cds)) {
    if (!(left > 1e-9)) continue;
    const end = ends[k];
    if (end === undefined || left > end - t + 1e-4) {
      out.push({ inv: 'I3', code: 'skill-cd-long', msg: `${what}: откат «${k}» ${left.toFixed(3)} с — длиннее часов героя (${end === undefined ? 'не вставал ни разу' : `кончается через ${(end - t).toFixed(3)} с`})` });
    }
  }
  return out;
}

function tickInvariants(w: FuzzWorld, pre: Pre, ev: SessionEvent[], dt: number): Violation[] {
  const out: Violation[] = [];
  const V = (inv: string, code: string, msg: string): void => { out.push({ inv, code, msg }); };
  const W = w.s.world;
  const reg = w.reg;
  const bal = reg.get('balance');
  for (const p of Object.values(W.players)) {
    const b = pre.heroes.get(p.id);
    if (!b) continue;
    const name = `${p.id}(${p.save.classId})`;
    // I7: числа конечны.
    for (const [k, v] of [['x', p.pos.x], ['y', p.pos.y], ['hp', p.hp], ['mana', p.mana], ['stamina', p.stamina], ['facing', p.facing], ['attackCd', p.attackCd]] as const) {
      if (!finite(v)) V('I7', 'nan', `${name}.${k} = ${v}`);
    }
    // I1: стены, области, шов; мёртвый стоит.
    const reg1 = w.regions.at(p.pos);
    const byObst = obstacleNear(W.obstacles, b.pos, p.pos, p.radius) || w.probe.tainted.has(p.id);
    const tag = byObst ? '-obstacle' : '';
    const why = byObst ? ' (у преграды декора / после неё)' : '';
    if (reg1 < 0) V('I1', `in-wall${tag}`, `${name} центром в стене/двери ${fmt(p.pos)}${why}`);
    else if (b.region >= 0 && reg1 !== b.region) V('I1', `region${tag}`, `${name} перешёл в другую область (сквозь стену/закрытую дверь) ${fmt(b.pos)}→${fmt(p.pos)}${why}`);
    if (sealCrossed(W.grid, b.pos, p.pos)) V('I1', `seal${tag}`, `${name} прошёл диагональный шов ${fmt(b.pos)}→${fmt(p.pos)}${why}`);
    const ov = p.alive ? wallOverlap(W.grid, p.pos, p.radius) : 0;
    if (ov > 1e-6) V('I1', `overlap${tag}`, `${name} кругом в стене на ${ov.toFixed(3)} px ${fmt(p.pos)}${why}`);
    if ((ov > 1e-6 || reg1 < 0) && byObst) w.probe.tainted.add(p.id);
    else if (ov <= 1e-6 && reg1 >= 0) w.probe.tainted.delete(p.id);
    if (!b.alive && dist(b.pos, p.pos) > EPS) V('I1', 'dead-moved', `мёртвый ${name} сдвинулся ${fmt(b.pos)}→${fmt(p.pos)}`);
    // I4: ресурсы не отрицательны.
    if (p.hp < -EPS || p.mana < -EPS || p.stamina < -EPS) V('I4', 'negative', `${name}: hp ${p.hp} mana ${p.mana} stamina ${p.stamina}`);
    // I6: не выше максимума (максимум — на начало тика или на конец: бафф, истёкший в тике, подрежет на следующем; ⭐ перепрогон R15 — и в миг
    // левелапа за тик: он наливает до максимума с баффом, который истечёт к концу того же тика) и резерва.
    if (p.alive) {
      const o = w.probe.oracle(p).derived;
      const lv = w.probe.levelMax.get(p.id);
      const maxHp = Math.max(b.maxHp, o.maxHp, lv?.hp ?? 0), maxMana = Math.max(b.maxMana, o.maxMana, lv?.mana ?? 0), maxStam = Math.max(b.maxStam, o.maxStamina, lv?.stamina ?? 0);
      if (p.hp > maxHp + 1e-6) V('I6', 'hp-max', `${name}: hp ${p.hp.toFixed(3)} > максимума ${maxHp.toFixed(3)}`);
      if (p.mana > maxMana + 1e-6) V('I6', 'mana-max', `${name}: мана ${p.mana.toFixed(3)} > максимума ${maxMana.toFixed(3)}`);
      if (p.stamina > maxStam + 1e-6) V('I6', 'stamina-max', `${name}: выносливость ${p.stamina.toFixed(3)} > максимума ${maxStam.toFixed(3)}`);
      // ⭐ D4 (большой прогон, сид 2588 профиля `buffs`): и максимум НАЧАЛА тика при тоглах КОНЦА — реген тика идёт по снимку начала (с баффом,
      // что истечёт в конце тика) и резерву тогла, переключённого в этом же тике (аура a2 → a1); подрежет следующий тик.
      const effM = Math.max(b.effMana, effectivePool(o.maxMana, reservedFrac(reg, p.toggles, 'mana')), effectivePool(b.maxMana, reservedFrac(reg, p.toggles, 'mana')), lv?.effMana ?? 0);
      const effS = Math.max(b.effStam, effectivePool(o.maxStamina, reservedFrac(reg, p.toggles, 'stamina')), effectivePool(b.maxStam, reservedFrac(reg, p.toggles, 'stamina')), lv?.effStam ?? 0);
      if (p.mana > effM + 1e-6 && p.mana <= maxMana + 1e-6) V('I6', 'mana-reserve', `${name}: мана ${p.mana.toFixed(3)} выше резерва аур ${effM.toFixed(3)} (тоглы ${p.toggles.join(',')})`);
      if (p.stamina > effS + 1e-6 && p.stamina <= maxStam + 1e-6) V('I6', 'stamina-reserve', `${name}: выносливость ${p.stamina.toFixed(3)} выше резерва стоек ${effS.toFixed(3)}`);
      // I4: тоглы — только выученные (сброс вычищает их в начале тика у живого).
      if (b.alive) for (const t of p.toggles) if (!((p.save.skills[t] ?? 0) > 0)) V('I4', 'toggle-unlearned', `${name}: тогл «${t}» держится без ранга`);
      // Тоглы: без повторов, в эксклюзив-группе — один, резерв пула — меньше всего пула.
      if (new Set(p.toggles).size !== p.toggles.length) V('I4', 'toggle-dup', `${name}: тогл включён дважды (${p.toggles.join(',')})`);
      const groups = p.toggles.map((t) => { const a = activeAbilityOf(reg, t); return a && (a.category === 'aura' || a.category === 'stance') ? a.toggleGroup : undefined; }).filter((g): g is string => !!g);
      if (new Set(groups).size !== groups.length) V('I4', 'toggle-group', `${name}: две стойки одной группы (${p.toggles.join(',')})`);
      for (const [k, left] of Object.entries(p.skillBuffs)) {
        if (k.startsWith('ins:')) {
          // ⭐ D4: печать — не дольше своего действия на высшем ранге донора (действие растёт с рангом донора, `insertGain`).
          const ins = reg.get('skill-inserts').find((x) => x.id === k.slice(4));
          const ab = ins?.proc?.ability;
          const top = reg.get('skill-tree').nodes.reduce((mx, nd) => (nd.effect.grantsInsert === ins?.id ? Math.max(mx, nd.maxRank) : mx), 1);
          const dur = ins && ab?.category === 'buff' ? ab.durationSec * insertGain(ins.perRank.gain, top) : undefined;
          if (dur === undefined) V('I4', 'buff-unknown', `${name}: печать «${k}» без прок-баффа в конфиге`);
          else if (left > dur + EPS) V('I4', 'buff-duration', `${name}: печать «${k}» ${left.toFixed(3)} с > ${dur.toFixed(3)}`);
          continue;
        }
        if (k.startsWith('pot:')) {
          const base = k.slice(4), def = potionBuffDef(reg, base);
          if (!def) V('I5', 'potion-buff', `${name}: бафф зелья «${base}» без определения в конфиге`);
          else if (left > def.durationSec + EPS) V('I4', 'buff-duration', `${name}: бафф зелья «${base}» ${left.toFixed(3)} с > ${def.durationSec}`);
          const drank = b.beltBase.some((id, i) => id === base && (p.save.belt[i]?.uid ?? null) !== b.belt[i]);
          if (left > (b.buffs[k] ?? 0) + EPS && !drank) V('I5', 'potion-buff-free', `${name}: бафф зелья «${base}» налит в тике без выпитой колбы`);
          continue;
        }
        if (b.alive && !((p.save.skills[k] ?? 0) > 0)) V('I4', 'buff-unlearned', `${name}: бафф «${k}» держится без ранга`);
        const res = resolveActive(reg, p.save, k);
        const dur = res?.active.category === 'buff' ? res.active.durationSec : undefined;
        if (dur !== undefined && left > dur + EPS) V('I4', 'buff-duration', `${name}: бафф «${k}» ${left.toFixed(3)} с > ${dur}`);
      }
    } else if (p.hp > EPS) {
      V('I6', 'dead-hp', `мёртвый ${name} с hp ${p.hp.toFixed(1)} (${ev.some((e) => e.type === 'levelup' && e.playerId === p.id) ? 'левелап трупа' : 'без левелапа'})`);
    }
    // ⭐ D4: правило времени баффа по часам героя; ⚠ R23-05: и откат не длиннее них.
    cdClock(w, p, b, dt, name, V);
    buffClock(w, p, b, dt, name, V);
    // I6: опыт — только за убийство, ровно опыт монстра; уровень и очки — по таблице.
    const xpEv = ev.filter((e): e is Extract<SessionEvent, { type: 'xp' }> => e.type === 'xp' && e.playerId === p.id);
    const kills = ev.filter((e): e is Extract<SessionEvent, { type: 'monster-died' }> => e.type === 'monster-died' && e.by === p.id).map((e) => e.def.xp).filter((x) => x > 0);
    const gained = xpEv.reduce((s, e) => s + e.amount, 0);
    if (Math.abs(p.save.xp - b.xp - gained) > EPS) V('I6', 'xp', `${name}: опыт ${b.xp}→${p.save.xp}, событий на ${gained}`);
    const kxp = [...kills].sort((a, c) => a - c).join(','), exp = xpEv.map((e) => e.amount).sort((a, c) => a - c).join(',');
    if (kxp !== exp) V('I6', 'xp-source', `${name}: события опыта [${exp}] ≠ опыт убитых им [${kxp}]`);
    if (xpEv.length && !b.alive) V('I6', 'xp-dead', `мёртвый ${name} получил опыт ${gained}`);
    const lvl = p.save.xp !== b.xp ? Math.max(b.level, levelForXp(p.save.xp, bal.xpTable)) : b.level;
    if (p.save.level !== lvl) V('I6', 'level', `${name}: уровень ${b.level}→${p.save.level}, по таблице ${lvl}`);
    const dl = p.save.level - b.level;
    if (p.save.unspentAttributePoints - b.ua !== dl * bal.attributePointsPerLevel || p.save.unspentSkillPoints - b.us !== dl * bal.skillPointsPerLevel || p.save.unspentMasteryPoints - b.um !== dl * bal.masteryPointsPerLevel) {
      V('I6', 'points', `${name}: очки ${b.ua}/${b.us}/${b.um}→${p.save.unspentAttributePoints}/${p.save.unspentSkillPoints}/${p.save.unspentMasteryPoints} при +${dl} ур.`);
    }
    // ⭐ D2: левелап в бою пишет выданное в книгу заработанного — ровно очки уровней по конфигу этого мига; книга не появляется и не пропадает.
    const e = p.save.earned;
    if (!!e !== !!b.earned) V('I6', 'earned', `${name}: книга заработанного ${b.earned ? 'пропала' : 'появилась'} в тике`);
    else if (e && b.earned && (e.attributePoints - b.earned.a !== dl * bal.attributePointsPerLevel || e.skillPoints - b.earned.s !== dl * bal.skillPointsPerLevel || e.masteryPoints - b.earned.m !== dl * bal.masteryPointsPerLevel)) {
      V('I6', 'earned', `${name}: книга ${JSON.stringify(b.earned)}→${JSON.stringify(e)} при +${dl} ур.`);
    }
    if (JSON.stringify(p.save.attributes) !== b.attrs || JSON.stringify(p.save.skills) !== b.skills || JSON.stringify(p.save.masteries) !== b.masteries) V('I6', 'save-drift', `${name}: атрибуты/скилы/мастерства поменялись в тике`);
    if (JSON.stringify(Object.entries(p.save.equipment).map(([k, it]) => [k, it?.uid])) !== b.equip) V('I5', 'equip-drift', `${name}: снаряжение поменялось в тике`);
    // I5: золото — ровно поднятое; сумка — только поднятое; сейв под транзакцией не тронут.
    const goldEv = ev.filter((e): e is Extract<SessionEvent, { type: 'gold' }> => e.type === 'gold' && e.playerId === p.id);
    const goldSum = goldEv.reduce((s, e) => s + e.amount, 0);
    if (p.save.gold - b.gold !== goldSum) V('I5', 'gold', `${name}: золото ${b.gold}→${p.save.gold}, событий на ${goldSum}`);
    for (const e of goldEv) {
      const src = [...pre.drops.values()].find((d) => d.kind === 'gold' && w.probe.taken.get(d.id) === p.id && d.gold === e.amount);
      if (!src) V('I5', 'gold-source', `${name}: золото +${e.amount} без поднятой кучки такого размера`);
    }
    const picked = new Set(ev.filter((e): e is Extract<SessionEvent, { type: 'item-picked' }> => e.type === 'item-picked' && e.playerId === p.id).map((e) => e.item.uid));
    for (const it of p.save.inventory) {
      // I6 (⭐ R20-07): сумка мёртвого не растёт — ни подбором, ни автоподбором (поднятое мимо броска штрафа смерти).
      if (!b.alive && !b.inv.has(it.uid)) V('I6', 'dead-bag-grew', `мёртвый ${name}: в сумке появилась ${it.baseId}/${it.uid.slice(-6)}`);
      if (b.inv.has(it.uid) || picked.has(it.uid) || it.kind === 'material') continue;
      V('I5', 'inv-appeared', `${name}: в сумке появилась ${it.baseId}/${it.uid.slice(-6)} без подбора`);
    }
    const now = new Set(p.save.inventory.map((i) => i.uid));
    for (const uid of b.inv) if (!now.has(uid)) V('I5', 'inv-vanished', `${name}: из сумки пропала вещь ${uid.slice(-6)} в тике`);
    const beltNow = p.save.belt.map((x) => x?.uid ?? null);
    for (let i = 0; i < Math.max(beltNow.length, b.belt.length); i++) {
      if (beltNow[i] !== b.belt[i] && beltNow[i] !== null) V('I5', 'belt-appeared', `${name}: в поясе появилась колба в ячейке ${i}`);
    }
    if (b.held && b.heldJson !== heldView(p.save)) V('I5', 'held', `${name}: сейв под транзакцией (R1-05) изменён тиком (сумка/пояс/золото/снаряжение)`);
  }
  // I5: добыча не пропадает — ушедшее с земли поднято; добыча не в стене.
  const nowDrops = new Map(W.drops.map((d) => [d.id, d]));
  for (const [id, d] of pre.drops) {
    if (nowDrops.has(id)) continue;
    if (!w.probe.taken.has(id)) V('I5', 'drop-lost', `дроп ${id} (${d.kind}) исчез с земли без подбора`);
  }
  // Новая добыча — только со смерти монстра или из открытого сундука, и в той же области (не перелетает стену, R6-26).
  const sources = ev.filter((e) => e.type === 'monster-died' || e.type === 'chest-opened') as { x: number; y: number }[];
  const srcRegions = new Set(sources.map((e) => w.regions.at({ x: e.x, y: e.y })));
  for (const d of W.drops) {
    if (pre.drops.has(d.id)) continue;
    const rg = w.regions.at(d.pos);
    if (rg < 0) V('I5', 'drop-in-wall', `новый дроп ${d.id} (${d.kind}) в стене ${fmt(d.pos)}`);
    else if (srcRegions.size && !srcRegions.has(rg)) V('I5', 'drop-region', `новый дроп ${d.id} лёг в другую область, чем смерть монстра/сундук (перелетел стену) ${fmt(d.pos)}`);
    if (!sources.length) V('I5', 'drop-spawned', `новый дроп ${d.id} без смерти монстра и сундука в тике`);
  }
  // M1: монстры — не сквозь стены/двери, не в стене.
  for (const m of W.monsters) {
    const b = pre.monsters.get(m.id);
    if (!finite(m.pos.x) || !finite(m.pos.y) || !finite(m.hp)) V('I7', 'nan', `монстр ${m.id}: ${fmt(m.pos)} hp ${m.hp}`);
    if (!b || !m.alive) continue;
    const rg = w.regions.at(m.pos);
    // У преграды декора — своя причина (V-RF-05: выталкивание не видит стен; заселение не обходит преграды).
    const tag = obstacleNear(W.obstacles, b.pos, m.pos, m.radius) ? '-obstacle' : '';
    if (rg < 0) V('M1', `in-wall${tag}`, `монстр ${m.id} (${m.def.id}) центром в стене ${fmt(m.pos)}`);
    else if (b.region >= 0 && rg !== b.region) V('M1', `region${tag}`, `монстр ${m.id} (${m.def.id}) перешёл в другую область ${fmt(b.pos)}→${fmt(m.pos)}`);
    if (sealCrossed(W.grid, b.pos, m.pos)) V('M1', `seal${tag}`, `монстр ${m.id} прошёл диагональный шов ${fmt(b.pos)}→${fmt(m.pos)}`);
    if (m.hp > m.maxHp + EPS) V('M1', 'hp-max', `монстр ${m.id}: hp ${m.hp} > ${m.maxHp}`);
  }
  // Снаряды не живут в стенах.
  for (const pr of W.projectiles) {
    if (!finite(pr.pos.x) || !finite(pr.pos.y)) V('I7', 'nan', `снаряд ${pr.id}: ${fmt(pr.pos)}`);
    const c = cellOf(pr.pos);
    if (isBlockedCell(W.grid, c.cx, c.cy)) V('I2', 'proj-wall', `снаряд ${pr.id} (${pr.owner}) живёт в стене ${fmt(pr.pos)}`);
  }
  // I3: серия — не больше написанного числа взмахов.
  for (const e of ev) {
    if (e.type !== 'swing') continue;
    const t = w.probe.track.get(e.playerId);
    if (!e.chain) continue;
    if (!t?.series || t.series.node !== e.ability) { V('I3', 'series', `${e.playerId}: взмах серии «${e.ability}» без начатой серии`); continue; }
    t.series.chains++;
    if (t.series.chains > t.series.hits - 1) V('I3', 'series', `${e.playerId}: «${e.ability}» — ${t.series.chains + 1} взмахов при ${t.series.hits} написанных`);
  }
  void dt;
  return out;
}

/** После любой команды: двери, uid, числа. */
function stateInvariants(w: FuzzWorld): Violation[] {
  const out: Violation[] = [];
  const V = (inv: string, code: string, msg: string): void => { out.push({ inv, code, msg }); };
  const W = w.s.world;
  // Дверь открыта только своим рычагом.
  for (const d of W.doors) {
    const pulled = W.levers.some((l) => l.doorId === d.id && l.used);
    for (const c of d.cells) {
      const v = W.grid[c.cy]?.[c.cx];
      if (!pulled && v !== Cell.Door) V('I5', 'door-open', `дверь ${d.id} открыта (${c.cx},${c.cy}) без рычага`);
      if (pulled && v === Cell.Door) V('I5', 'door-stuck', `рычаг дёрнут, а дверь ${d.id} закрыта (${c.cx},${c.cy})`);
    }
  }
  // Ни одна вещь не лежит в двух местах сразу.
  const seen = new Map<string, string>();
  const note = (it: Item | null | undefined, where: string): void => {
    if (!it) return;
    const had = seen.get(it.uid);
    if (had) V('I5', 'dup-uid', `вещь ${it.baseId}/${it.uid.slice(-8)} и в «${had}», и в «${where}»`);
    else seen.set(it.uid, where);
  };
  for (const d of W.drops) if (d.kind === 'item') note(d.item, `земля#${d.id}`);
  for (const p of Object.values(W.players)) {
    for (const it of p.save.inventory) note(it, `${p.id}:сумка`);
    for (const [k, it] of Object.entries(p.save.equipment)) note(it, `${p.id}:${k}`);
    p.save.belt.forEach((it, i) => note(it, `${p.id}:пояс${i}`));
    if (!finite(p.hp) || !finite(p.mana) || !finite(p.stamina) || !finite(p.pos.x) || !finite(p.pos.y)) V('I7', 'nan', `${p.id}: нечисло в состоянии`);
    if (p.mana < -EPS || p.stamina < -EPS || p.hp < -EPS) V('I4', 'negative', `${p.id}: hp ${p.hp} mana ${p.mana} stamina ${p.stamina}`);
  }
  return out;
}

// ── Исполнение шага ───────────────────────────────────────────────────────────────────────────────

export interface FuzzHooks {
  /** Сброс счётчика uid (детерминизм повтора). */
  resetUids?: () => void;
  /** Только для зубов сторожа: подложить «баг» в сессию ДО наблюдателя (его обёртки окажутся снаружи). */
  install?: (w: FuzzWorld) => void;
  /**
   * Профиль мира: доля арен (0…1), доля PvP на арене, наименьшее число героев, доля арен с колоннами в линии огня (C-10), все герои
   * на пороге уровня (R15-10: левелап поверх аур, стоек и баффов — в общем профиле он редок, убийств мало), бафф своего класса — на
   * высшем ранге и печати вставок на высшем ранге донора (R19-03, ⭐ D4: правило времени баффа — в общем профиле ранги размазаны по
   * дереву, а печати редки), ⚠ R21-06: все монстры — конструкты (`fuzzRegConstructs`: взрыв при смерти; в поставке путь скрытый).
   */
  world?: { arena?: number; pvp?: number; minHeroes?: number; pillars?: number; levelup?: boolean; buffs?: boolean; constructs?: boolean };
  /** Только для зубов сторожа: подложить «баг» после каждого тика. */
  afterTick?: (w: FuzzWorld) => void;
  /** ⭐ D4 (только для зубов сторожа): после возврата героя с арены в город (`arenaReturn`) — подложить «баг» в его тело. */
  afterArenaReturn?: (w: FuzzWorld, p: PlayerEntity, home: HeroBody, dtSec: number) => void;
  /** ⭐ D4 (только для зубов сторожа): после входа героя по коду (шаг `reconnect`). */
  afterReconnect?: (w: FuzzWorld, p: PlayerEntity) => void;
  /** ⭐ R22-04 (только для зубов сторожа): что комната пишет в сейв уходящего героя (`vitalsForSave`, как `Room.noteVitals`). */
  vitalsOf?: typeof vitalsForSave;
  /** ⚠ R23-05 (только для зубов сторожа): запись ушедшего с арены, когда она кончилась без него (`arenaAwayBody`, как `Room.leaveArena`). */
  awayBodyOf?: typeof arenaAwayBody;
}

interface Step { desc: string; ok: boolean; why?: string; ticks: number }

const refuse = (desc: string, why: string): Step => ({ desc, ok: false, why, ticks: 0 });
const pickHero = (w: FuzzWorld, op: Op): { h: Hero; p: PlayerEntity } | undefined => {
  const h = w.heroes[op.h % w.heroes.length];
  const p = h ? w.s.world.players[h.pid] : undefined;
  return h && p ? { h, p } : undefined;
};

/** Исполнить шаг; инварианты тиков копятся в `vs` (первое нарушение — стоп цепочки). */
/**
 * Тики подряд с инвариантами после каждого. Стоп — только на нарушении, которое прогон ПРИМЕТ (`stopOn`): пропущенные (известные)
 * ключи не должны менять ход мира, иначе сжатие по одному ключу разошлось бы с прогоном, где его нашли.
 */
function runTicks(w: FuzzWorld, n: number, build: (i: number) => Record<string, PlayerInput>, vs: Violation[], hooks: FuzzHooks, stopOn: (v: Violation) => boolean, until?: () => boolean): number {
  let i = 0;
  while (i < n) {
    const inputs = build(i);
    const pre = capture(w);
    w.probe.taken.clear(); w.probe.chests.clear(); w.probe.levelMax.clear();
    const ev = w.s.tick(TICK_DT, inputs);
    i++;
    hooks.afterTick?.(w);
    for (const e of ev) w.cover[`ev-${e.type}`] = (w.cover[`ev-${e.type}`] ?? 0) + 1;
    const got = [...w.probe.v.splice(0), ...tickInvariants(w, pre, ev, TICK_DT)];
    vs.push(...got);
    if (got.some(stopOn) || until?.()) break;
  }
  return i;
}

/** Дойти до точки (путь по сетке, как бот), остальные герои стоят; не дальше `max` тиков и до `near` px от цели. */
function walkTo(w: FuzzWorld, pid: string, goal: Vec2, max: number, vs: Violation[], hooks: FuzzHooks, stopOn: (v: Violation) => boolean, near = 30): number {
  const W = w.s.world;
  let wp: Vec2 | undefined;
  let at = -99;
  const idle: PlayerInput = { move: { x: 0, y: 0 }, facing: 0, attack: false, cast: null, interact: false };
  return runTicks(w, max, (i) => {
    const p = W.players[pid]!;
    if (!wp || i - at >= 8 || dist(wp, p.pos) < 8) { wp = findPath(W.grid, p.pos, goal, 3000)[0] ?? goal; at = i; }
    const inputs: Record<string, PlayerInput> = {};
    for (const x of w.heroes) inputs[x.pid] = { ...idle, facing: W.players[x.pid]?.facing ?? 0 };
    inputs[pid] = { ...idle, move: { x: wp.x - p.pos.x, y: wp.y - p.pos.y }, facing: Math.atan2(goal.y - p.pos.y, goal.x - p.pos.x) };
    return inputs;
  }, vs, hooks, stopOn, () => dist(W.players[pid]!.pos, goal) < near || !W.players[pid]!.alive);
}

/**
 * ⚠ R21-06: УКРЫТИЕ У МОНСТРА — клетка пола в области героя (дойти можно), в радиусе взрыва от монстра, но вне его видимости (стена,
 * дверь, шов, колонна, преграда декора, закрывающая обзор). Кандидаты — по всем живым монстрам; нет ни одного — `undefined`.
 */
function coverSpot(w: FuzzWorld, p: PlayerEntity, alive: MonsterEntity[], r: Rng): { m: MonsterEntity; at: Vec2 } | undefined {
  const W = w.s.world;
  const home = w.regions.at(p.pos);
  const out: { m: MonsterEntity; at: Vec2 }[] = [];
  const across: { m: MonsterEntity; at: Vec2 }[] = [];
  for (const m of alive) {
    const reach = m.radius + BLAST_R + p.radius - 4;
    const c = cellOf(m.pos);
    const other = w.regions.at(m.pos) !== home;
    for (let cy = c.cy - 3; cy <= c.cy + 3; cy++) for (let cx = c.cx - 3; cx <= c.cx + 3; cx++) {
      if (isBlockedCell(W.grid, cx, cy)) continue;
      const at = cellToWorld(cx, cy);
      if (w.regions.at(at) !== home || dist(at, m.pos) > reach) continue;
      if (!hasLineOfSight(W.grid, m.pos.x, m.pos.y, at.x, at.y, W.obstacles)) (other ? across : out).push({ m, at });
    }
  }
  // Монстр за стеной/закрытой дверью подойти не может — укрытие у него держится до конца похода: такие — чаще.
  if (across.length && (!out.length || r.chance(0.5))) return r.pick(across);
  return out.length ? r.pick(out) : undefined;
}

/** Сбросить у героя слежку за замахом и локом удара: сущность сменила тело (замаха и серии у нового тела нет, лок — его). */
function newBodyTrack(w: FuzzWorld, pid: string): void {
  const t = w.probe.track.get(pid);
  if (t) { t.lockUntil = -Infinity; t.series = undefined; t.castSig = undefined; t.castNode = undefined; }
}

/**
 * ⭐ D4: ВХОД В АРЕНУ — как `Room.enterArenaFloor`: голосование за арену — из города (не в городе — сперва в город: он оживляет и снимает
 * дебаффы, R4-09), тела города всех, кто в мире (`bodyOf` → `trip.home`), арена, возрождение каждого (`respawnPlayer`: баффы и тоглы сняты,
 * откаты — остаются).
 */
function startTrip(w: FuzzWorld, r: Rng): string {
  const W = w.s.world;
  const via = w.mode === 'town' ? '' : 'через город ';
  if (via) enterFloorFor(w, r, 'town');
  const home = new Map<string, HeroBody>();
  for (const x of w.heroes) { const pl = W.players[x.pid]; if (pl) home.set(x.pid, bodyOf(pl, W.timeMs)); }
  enterFloorFor(w, r, 'arena');
  for (const x of w.heroes) {
    if (!W.players[x.pid]) continue;
    w.s.respawnPlayer(x.pid, { ...W.spawn }, 3000);
    newBodyTrack(w, x.pid);
  }
  w.trip = { at: W.timeMs, home };
  w.cover['arena-trip'] = (w.cover['arena-trip'] ?? 0) + 1;
  return `${via}в арену (тела города — ${home.size}): ${w.about}`;
}

/** ⭐ D4: КОНЕЦ АРЕНЫ — как `Room.enterTown` → `leaveArena`: город, тела города + время боя (`arenaReturn`: откаты — более поздние). */
function endTrip(w: FuzzWorld, r: Rng, hooks: FuzzHooks): string {
  const trip = w.trip!;
  w.trip = undefined;
  enterFloorFor(w, r, 'town');
  const W = w.s.world;
  const dtSec = Math.max(0, W.timeMs - trip.at) / 1000;
  for (const x of w.heroes) {
    const pl = W.players[x.pid];
    const home = trip.home.get(x.pid);
    if (!pl || !home) continue;
    arenaReturn(w.reg, pl, home, dtSec, W.timeMs, !!w.s.snapshotOf(x.pid));
    w.s.refreshSnapshot(x.pid);
    hooks.afterArenaReturn?.(w, pl, home, dtSec);
    newBodyTrack(w, x.pid);
  }
  return `с арены в город (${dtSec.toFixed(1)} с боя)`;
}

function execOp(w: FuzzWorld, op: Op, vs: Violation[], hooks: FuzzHooks, stopOn: (v: Violation) => boolean): Step {
  const r = createRng(op.s);
  const W = w.s.world;
  const hp = pickHero(w, op);
  if (!hp) return refuse('нет героя', 'нет героя');
  const { h, p } = hp;
  const reg = w.reg;
  // Сейв под транзакцией (R1-05): кадры того же соединения стоят в очереди `RoomManager` за ней — команды героя ждут.
  const COMMANDS: OpKind[] = ['chest', 'lever', 'pickup', 'drink', 'drop', 'equip', 'unequip', 'socket', 'allocSkill', 'respecSkills', 'allocAttr'];
  if (w.s.saveHeld.has(h.pid) && COMMANDS.includes(op.k)) return refuse(`${op.k} (${h.pid})`, 'ждёт транзакцию сейва');
  const town = (desc: string, fn: () => { ok: boolean; reason?: string }): Step => {
    const before = JSON.stringify(p.save);
    const res = fn();
    if (!res.ok && JSON.stringify(p.save) !== before) vs.push({ inv: 'I5', code: 'refusal-mutates', msg: `${desc}: отказ «${res.reason}» изменил сейв` });
    return { desc, ok: res.ok, why: res.reason, ticks: 0 };
  };
  switch (op.k) {
    case 'tick': {
      const intents = new Map(w.heroes.map((x) => [x.pid, makeIntent(w, W.players[x.pid]!, r, x.pid === h.pid)]));
      // Поход к сундуку/рычагу/добыче — длиннее: этаж большой, а правила взаимодействия проверяются только рядом.
      const lead = intents.get(h.pid)!;
      const walk = lead.move === 'nav' && (lead.target === 'chest' || lead.target === 'lever' || lead.target === 'drop' || lead.target === 'monster');
      const n = walk && r.chance(0.5) ? r.pick([40, 70, 120]) : r.pick([1, 1, 2, 3, 5, 8, 13, 21, 34]);
      if (walk && lead.target !== 'monster' && r.chance(0.6)) { lead.pInteract = r.pick([0.3, 1]); lead.mag = 1; }
      const paths = new Map(w.heroes.map((x) => [x.pid, { at: -99 } as { at: number; wp?: Vec2 }]));
      const i = runTicks(w, n, (k) => {
        const inputs: Record<string, PlayerInput> = {};
        for (const x of w.heroes) { const pl = W.players[x.pid]; if (pl) inputs[x.pid] = frame(w, pl, intents.get(x.pid)!, r, k, paths.get(x.pid)!); }
        return inputs;
      }, vs, hooks, stopOn);
      const it = intents.get(h.pid)!;
      return { desc: `тик ×${i}: ${h.pid} ${it.move}${it.move === 'nav' || it.move === 'away' ? '→' + it.target : ''} взгляд ${it.face} атака ${it.pAttack} каст ${it.pCast} рывок ${it.pDodge} [E] ${it.pInteract} пояс ${it.pBelt}`, ok: true, ticks: i };
    }
    case 'chest': {
      const shut = W.chests;
      const id = !shut.length || r.chance(0.15) ? r.int(-1, 99) : r.chance(0.7) ? shut.reduce((b, c) => (dist(c.pos, p.pos) < dist(b.pos, p.pos) ? c : b)).id : r.pick(shut).id;
      const useId = r.chance(0.85);
      const goal = W.chests.find((c) => c.id === id)?.pos;
      const ticks = goal && r.chance(0.5) ? walkTo(w, h.pid, goal, 150, vs, hooks, stopOn) : 0;
      if (vs.some(stopOn)) return { desc: `к сундуку #${id} (${h.pid})`, ok: true, ticks };
      let ok = false;
      w.s.collectEvents(() => { ok = w.s.openChest(h.pid, useId ? id : undefined); });
      return { desc: `${ticks ? `дойти (${ticks} т.) и ` : ''}сундук ${useId ? '#' + id : 'ближайший'} (${h.pid})`, ok, why: ok ? undefined : 'не открыт', ticks };
    }
    case 'lever': {
      const id = !W.levers.length || r.chance(0.15) ? r.int(-1, 9) : r.pick(W.levers).id;
      const goal = W.levers.find((l) => l.id === id)?.pos;
      const ticks = goal && r.chance(0.5) ? walkTo(w, h.pid, goal, 150, vs, hooks, stopOn) : 0;
      if (vs.some(stopOn)) return { desc: `к рычагу #${id} (${h.pid})`, ok: true, ticks };
      const out = w.s.openLever(h.pid, id);
      if (out != null) w.regions = new Regions(W.grid);
      return { desc: `${ticks ? `дойти (${ticks} т.) и ` : ''}рычаг #${id} (${h.pid})`, ok: out != null, why: out == null ? 'не сработал' : undefined, ticks };
    }
    case 'pickup': {
      const id = !W.drops.length || r.chance(0.1) ? r.int(-1, 999) : r.chance(0.7) ? W.drops.reduce((b, d) => (dist(d.pos, p.pos) < dist(b.pos, p.pos) ? d : b)).id : r.pick(W.drops).id;
      const goal = W.drops.find((d) => d.id === id)?.pos;
      const ticks = goal && r.chance(0.5) ? walkTo(w, h.pid, goal, 150, vs, hooks, stopOn) : 0;
      if (vs.some(stopOn)) return { desc: `к дропу #${id} (${h.pid})`, ok: true, ticks };
      // Ядро держит правило чужого аккаунта само (`takeDrop`) — команда идёт мимо проверки `Room`, чтобы проверить именно его.
      const dead = !p.alive, bag0 = new Set(p.save.inventory.map((x) => x.uid));
      const got = w.s.pickupDropById(h.pid, id);
      // I6 (⭐ R20-07): мёртвый не поднимает — сумка мёртвого не растёт.
      if (dead && p.save.inventory.some((x) => !bag0.has(x.uid))) vs.push({ inv: 'I6', code: 'dead-bag-grew', msg: `мёртвый ${h.pid}: подбор #${id} положил вещь в сумку` });
      return { desc: `${ticks ? `дойти (${ticks} т.) и ` : ''}подбор #${id} (${h.pid})`, ok: !!got, why: got ? undefined : 'далеко/нет/полон', ticks };
    }
    case 'drink': {
      // Как `Room.useConsumable`: жив, не оглушён, есть снимок; эффект — `session.drink`; расход — только с эффектом.
      const pots = [...p.save.belt.filter((x): x is Item => !!x), ...p.save.inventory.filter((x) => x.use)];
      const it = pots.length && !r.chance(0.1) ? r.pick(pots) : undefined;
      const desc = `зелье ${it?.baseId ?? 'нет'} (${h.pid})`;
      if (!w.s.snapshotOf(h.pid)) return refuse(desc, 'нет снимка');
      if (!p.alive) return refuse(desc, 'мёртв');
      if (p.stunTimer > 0) return refuse(desc, 'оглушён');
      if (!it?.use) return refuse(desc, 'не расходник');
      const snap = w.s.snapshotOf(h.pid)!.derived;
      // C-11: колба с баффом при неполном баффе — действие всегда (было: «Нет эффекта» навсегда, мёртвый груз в сумке).
      const def = potionBuffDef(reg, it.baseId), potWas = p.skillBuffs[`pot:${it.baseId}`] ?? 0;
      const was = { hp: p.hp, mana: p.mana };
      if (!w.s.drink(h.pid, it.use, it.baseId)) {
        if (def && potWas < def.durationSec - 1e-6) vs.push({ inv: 'I5', code: 'potion-buff-lost', msg: `${h.pid}: колба ${it.baseId} — «нет эффекта» при баффе ${potWas.toFixed(3)} из ${def.durationSec} с` });
        return refuse(desc, 'нет эффекта');
      }
      if (def && Math.abs((p.skillBuffs[`pot:${it.baseId}`] ?? 0) - def.durationSec) > EPS) vs.push({ inv: 'I4', code: 'buff-duration', msg: `${h.pid}: бафф колбы ${it.baseId} ${p.skillBuffs[`pot:${it.baseId}`]} с, а длительность ${def.durationSec}` });
      const bi = p.save.belt.findIndex((x) => x?.uid === it.uid);
      if (bi >= 0) p.save.belt[bi] = null;
      else { const ii = p.save.inventory.findIndex((x) => x.uid === it.uid); if (ii >= 0) p.save.inventory.splice(ii, 1); }
      // C-14: мана — до потолка резерва аур; здоровье — до максимума. ⭐ D4: «налило» — выросло этим зельем: выше потолка между тиками герой
      // бывает и без него (снял вещь на +жизнь; тело города вернулось с арены, где он её снял, — подрежет тик, R5-02), и зелье его не лечит.
      const cap = effectivePool(snap.maxMana, reservedFrac(reg, p.toggles, 'mana'));
      if (p.mana > cap + 1e-6 && p.mana > was.mana + 1e-9) vs.push({ inv: 'I6', code: 'mana-reserve', msg: `${h.pid}: зелье налило ману ${p.mana.toFixed(2)} выше резерва ${cap.toFixed(2)}` });
      if (p.hp > snap.maxHp + 1e-6 && p.hp > was.hp + 1e-9) vs.push({ inv: 'I6', code: 'hp-max', msg: `${h.pid}: зелье налило hp ${p.hp.toFixed(2)} > ${snap.maxHp.toFixed(2)}` });
      return { desc, ok: true, ticks: 0 };
    }
    case 'drop': {
      const inv = p.save.inventory;
      const uid = inv.length && !r.chance(0.1) ? r.pick(inv).uid : 'нет-такой';
      const desc = `выбросить ${uid.slice(-6)} (${h.pid})`;
      if (!p.alive) return refuse(desc, 'мёртв');   // как `Room` (R14-05) — отказ до ядра
      const got = w.s.dropToGround(h.pid, uid);
      return { desc, ok: !!got, why: got ? undefined : 'нет предмета', ticks: 0 };
    }
    case 'equip': {
      const gear = p.save.inventory.filter((i) => i.slot);
      const it = gear.length ? r.pick(gear) : undefined;
      const target = it?.slot === 'weapon' && (it.hands ?? 1) === 1 && r.chance(0.4) ? 'offhand' as const : undefined;
      return town(`надеть ${it?.baseId ?? '—'}${target ? '→левая' : ''} (${h.pid}${p.windup ? ', посреди замаха' : ''})`, () => (it ? equip(reg, p.save, it.uid, target) : { ok: false, reason: 'нечего' }));
    }
    case 'unequip': {
      const slots = Object.keys(p.save.equipment);
      const slot = slots.length ? r.pick(slots) : 'weapon';
      return town(`снять ${slot} (${h.pid}${p.windup ? ', посреди замаха' : ''})`, () => unequip(reg, p.save, slot));
    }
    case 'socket': {
      const nodes = Object.keys(p.save.skills).filter((id) => activeAbilityOf(reg, id));
      const node = nodes.length ? r.pick(nodes) : 'b-fire-a1';
      const slot = r.int(0, 3);
      if (r.chance(0.35)) return town(`вынуть ${node}[${slot}] (${h.pid})`, () => socketClear(reg, p.save, node, slot));
      const all = reg.get('skill-inserts');
      const open = all.filter((i) => insertUnlocked(reg, p.save, i.id));
      const ins = open.length && r.chance(0.75) ? open : all;
      const id = ins.length ? r.pick(ins).id : 'x';
      return town(`вставить ${id} в ${node}[${slot}] (${h.pid}${p.windup ? ', посреди замаха' : ''})`, () => socketInsert(reg, p.save, node, slot, id));
    }
    case 'allocSkill': {
      // Очки — только законные (за уровни и сброс): узел любой, выучится ли — решают правила `allocActive`.
      const tree = reg.get('skill-tree');
      const node = r.pick(tree.nodes).id;
      return town(`выучить ${node} (${h.pid})`, () => allocActive(reg, p.save, node));
    }
    case 'respecSkills': return town(`сброс скилов (${h.pid}${p.windup ? ', посреди замаха' : ''})`, () => respecSkills(reg, p.save));
    case 'allocAttr': return town(`атрибут (${h.pid})`, () => allocAttr(p.save, r.pick(ATTRIBUTES), r.int(1, 3)));
    case 'hold': {
      // Сервер держит сейв на время записи в базу (R1-05): тик его не трогает.
      if (w.s.saveHeld.has(h.pid)) w.s.saveHeld.delete(h.pid); else w.s.saveHeld.add(h.pid);
      return { desc: `${w.s.saveHeld.has(h.pid) ? 'держать' : 'отпустить'} сейв (${h.pid})`, ok: true, ticks: 0 };
    }
    case 'revive': {
      // Возрождение на месте бывает только на арене (`Room`: PvP-смерть — респаун с иммунитетом); в забеге — новым узлом.
      if (p.alive || !W.pvp) return refuse(`возрождение (${h.pid})`, p.alive ? 'жив' : 'не арена');
      w.s.respawnPlayer(h.pid, { ...W.spawn }, 3000);
      w.probe.track.delete(h.pid);
      return { desc: `возрождение на арене (${h.pid})`, ok: true, ticks: 0 };
    }
    case 'descend': {
      // ⭐ D4: с арены круга — только в город (как комната: «В город»).
      if (w.trip) return { desc: `спуск: ${endTrip(w, r, hooks)}`, ok: true, ticks: 0 };
      const arena = w.opts.arena ?? 0.6;
      const mode: FuzzWorld['mode'] = w.mode !== 'town' && r.chance(0.25) ? 'town' : r.chance(arena) ? 'arena' : 'floor';
      const dead = w.heroes.filter((x) => !W.players[x.pid]?.alive).map((x) => x.pid);
      enterFloorFor(w, r, mode);
      for (const pid of dead) w.probe.track.delete(pid);
      // Город снимает замах и рывок (`cleanse`, R4-09) — серия там обрывается.
      if (mode === 'town') for (const x of w.heroes) { const t = w.probe.track.get(x.pid); if (t) t.series = undefined; }
      return { desc: `спуск: ${w.about}`, ok: true, ticks: 0 };
    }
    case 'stun': {
      // ⚠ Модель: оглушение героя в игре сегодня не ставит ни один путь (только тесты), правила «оглушённый не…» — есть.
      p.stunTimer = r.float(0.1, 2);
      return { desc: `оглушить ${h.pid} на ${p.stunTimer.toFixed(2)} с (модель)`, ok: true, ticks: 0 };
    }
    case 'dot': {
      // ⚠ R21-06 (модель): яд героя, повешенный раньше, добивает монстра (R5-06 — убийца `dotOwner`), а герой тем временем:
      //  • `cover` — отошёл за укрытие рядом с ним (`coverSpot`: в радиусе взрыва, вне видимости монстра). У конструкта смерть — взрыв:
      //    так он встречает героя за стеной, дверью и колонной — случай, до которого бой вслепую не доходит (за сотни цепочек — ни разу),
      //    а сторож M2 `blast-los` держит именно его;
      //  • `brink` — стоит рядом, на последнем издыхании (здоровье 1): взрыв убивает самого убийцу, и награды убийцы (лечение за убийство,
      //    левелап — полное здоровье) обязаны достаться ему живому, до взрыва, а не трупу после (I6 `dead-hp`, `xp-dead`);
      //  • `any` — где стоял.
      const alive = W.monsters.filter((m) => m.alive);
      if (!alive.length) return refuse(`яд добивает (${h.pid})`, 'нет монстров');
      const mode = r.pick(['cover', 'cover', 'cover', 'brink', 'any'] as const);
      let spot = mode === 'cover' ? coverSpot(w, p, alive, r) : undefined;
      const m = spot?.m ?? (mode === 'brink' ? alive.reduce((b, x) => (dist(x.pos, p.pos) < dist(b.pos, p.pos) ? x : b)) : r.pick(alive));
      let ticks = 0;
      if (spot) w.cover['dot-cover'] = (w.cover['dot-cover'] ?? 0) + 1;
      // Монстр за время похода подходит сам (погоня): дошёл, а укрытия уже нет — новое укрытие у того же монстра, до трёх походов.
      for (let tries = 0; spot && p.alive && m.alive && tries < 3 && !vs.some(stopOn); tries++) {
        ticks += walkTo(w, h.pid, spot.at, 120, vs, hooks, stopOn, 4);
        const behind = dist(m.pos, p.pos) <= m.radius + BLAST_R + p.radius && !hasLineOfSight(W.grid, m.pos.x, m.pos.y, p.pos.x, p.pos.y, W.obstacles);
        if (behind) w.cover['dot-behind'] = (w.cover['dot-behind'] ?? 0) + 1;
        spot = behind || !m.alive ? undefined : coverSpot(w, p, [m], r);
      }
      if (mode === 'brink' && p.alive && !vs.some(stopOn)) {
        ticks += walkTo(w, h.pid, m.pos, 120, vs, hooks, stopOn, m.radius + p.radius + 8);
        if (p.alive) p.hp = Math.min(p.hp, 1);
      }
      const desc = `яд ${h.pid} добивает монстра ${m.id} (${m.def.id}), ${mode}${ticks ? ` (поход ${ticks} т.)` : ''} (модель)`;
      if (vs.some(stopOn)) return { desc, ok: true, ticks };
      if (!m.alive) return { desc, ok: false, why: 'монстр уже пал', ticks };
      addDebuffStack(m.debuffs, { kind: 'poison', chance: 1, maxStacks: 1, durationMs: 1000, mag: (m.hp + 1) / TICK_DT }, W.timeMs);
      (w.s as unknown as { noteDot(m: MonsterEntity, kind: 'poison', by: PlayerEntity): void }).noteDot(m, 'poison', p);
      const idle: PlayerInput = { move: { x: 0, y: 0 }, facing: 0, attack: false, cast: null, interact: false };
      const n = runTicks(w, 3, () => Object.fromEntries(w.heroes.filter((x) => W.players[x.pid]).map((x) => [x.pid, { ...idle, facing: W.players[x.pid]!.facing }])), vs, hooks, stopOn, () => !m.alive);
      return { desc, ok: !m.alive, why: m.alive ? 'выжил' : undefined, ticks: ticks + n };
    }
    case 'arena': {
      // ⭐ D4: круг «город → арена → город» — туда или обратно (как голосования комнаты).
      return { desc: w.trip ? endTrip(w, r, hooks) : startTrip(w, r), ok: true, ticks: 0 };
    }
    case 'reconnect': {
      // ⭐ D4: ПЕРЕПОДКЛЮЧЕНИЕ, как комната: уход (`noteLeft`: тело ухода — `bodyOf`, сущность снята), мир идёт без него (напарники играют),
      // иногда за это время кончается арена (`leaveArena` ушедшему: запись ухода — тело города, откаты — более поздние, `arenaAwayBody`), вход
      // по коду (`takeLeft`: живой или ушедший из подземелья с точкой — `addPlayer` на ней и `putBody`; мёртвый вне подземелья — свежая
      // сущность, откаты — его). Время для ушедшего стоит (R4-06): часы героя (`buffClock`) без него не идут.
      // ⭐ R22-04: и сейв ухода — как комната (`noteVitals` → `vitalsForSave`: пулы живого, откаты — и мёртвого); иногда пати без него меняет
      // этаж (спуск, город — `floorChanged`): мёртвую запись ухода это снимает, и он входит свежей сущностью с откатами ТОЛЬКО из сейва.
      let body: HeroBody = bodyOf(p, W.timeMs);
      // ⚠ R23-05: тело города на арене — с временем, что он бился там до ухода (как `Room.arenaHome` с `leftAt`): оно старит его откаты и баффы.
      const homeBody = w.trip?.home.get(h.pid);
      const home: ArenaHome | undefined = homeBody && { body: homeBody, sec: Math.max(0, W.timeMs - w.trip!.at) / 1000 };
      const vitals = (hooks.vitalsOf ?? vitalsForSave)(p, home, W.timeMs);
      // ⚠ R23-05: откаты сейва ухода — не длиннее часов героя: их читает вход в ДРУГУЮ комнату («Продолжить», к другу по коду, другая нода,
      // рестарт), а не только свежая сущность здесь (раньше: откаты тела города, застывшие на входе в арену).
      vs.push(...cdLonger(w, h.pid, savedCooldowns(vitals, vitals?.at ?? W.timeMs), `${h.pid}: сейв ухода`));
      w.s.removePlayer(h.pid);
      const others = w.heroes.filter((x) => x.pid !== h.pid && W.players[x.pid]);
      const n = r.pick(others.length ? [0, 1, 5, 30, 90] : [0, 1, 30]);
      let ticks = 0;
      if (n) {
        const intents = new Map(others.map((x) => [x.pid, makeIntent(w, W.players[x.pid]!, r, false)]));
        const paths = new Map(others.map((x) => [x.pid, { at: -99 } as { at: number; wp?: Vec2 }]));
        ticks = runTicks(w, n, (k) => {
          const inputs: Record<string, PlayerInput> = {};
          for (const x of others) { const pl = W.players[x.pid]; if (pl) inputs[x.pid] = frame(w, pl, intents.get(x.pid)!, r, k, paths.get(x.pid)!); }
          return inputs;
        }, vs, hooks, stopOn);
      }
      let arenaEnd = '';
      let moved: FuzzWorld['mode'] | undefined;
      if (w.trip && r.chance(0.4)) {
        arenaEnd = `; без него ${endTrip(w, r, hooks)}`;
        if (home) body = (hooks.awayBodyOf ?? arenaAwayBody)(home, body);
      } else if (!w.trip && others.length && r.chance(0.3)) {
        // ⭐ R22-04: пати без него сменила этаж — как шаг `descend` у присутствующих; запись ухода — как `Room.floorChanged`.
        moved = w.mode !== 'town' && r.chance(0.3) ? 'town' : 'floor';
        const dead = others.filter((x) => !W.players[x.pid]?.alive).map((x) => x.pid);
        enterFloorFor(w, r, moved);
        for (const pid of dead) w.probe.track.delete(pid);
        if (moved === 'town') for (const x of others) { const t = w.probe.track.get(x.pid); if (t) t.series = undefined; }
        delete body.pos;
        if (moved === 'town') { body.debuffs = {}; body.stunTimer = 0; }
        arenaEnd = `; без него пати ушла (${moved === 'town' ? 'город' : 'новый этаж'})`;
        w.cover['reconnect-moved'] = (w.cover['reconnect-moved'] ?? 0) + 1;
      }
      const dropped = !!moved && !body.alive;   // мёртвую запись ухода снимает смена этажа
      if (dropped) w.cover['reconnect-dead-moved'] = (w.cover['reconnect-dead-moved'] ?? 0) + 1;
      const usable = !dropped && (body.alive || (w.mode === 'floor' && !!body.pos));
      const back = w.s.addPlayer(h.pid, p.save, usable ? body.pos : undefined, h.account);
      if (usable) putBody(back, body, W.timeMs);
      else {
        // Свежая сущность: откаты — из сейва (время для ушедшего стоит — без вычета) и из записи ухода, если её не сняли.
        keepLaterCooldowns(back.skillCd, savedCooldowns(vitals, vitals?.at ?? W.timeMs));
        if (!dropped) keepLaterCooldowns(back.skillCd, body.skillCd);
        if (dropped) w.probe.track.delete(h.pid);
      }
      hooks.afterReconnect?.(w, back);
      vs.push(...cdLonger(w, h.pid, back.skillCd, `${h.pid}: вход по коду`));   // ⚠ R23-05: и тело входа (запись ушедшего с арены — `arenaAwayBody`)
      newBodyTrack(w, h.pid);
      w.cover.reconnect = (w.cover.reconnect ?? 0) + 1;
      return { desc: `переподключение ${h.pid}: без него ${ticks} т.${arenaEnd}; вход ${usable ? 'с телом ухода' : dropped ? 'свежей сущностью (мёртвого пати оживила сменой этажа)' : 'свежей сущностью (мёртв вне подземелья)'}`, ok: true, ticks };
    }
  }
}

// ── Прогон и сжатие ───────────────────────────────────────────────────────────────────────────────

export interface Found { at: number; op: Op; v: Violation; log: string[] }
export interface RunOut {
  found?: Found;
  /** Нарушения стартового состояния (генератор, заселение) — не шага. */
  init: Violation[];
  steps: number;
  ticks: number;
  log: string[];
  cover: Record<string, number>;
  stats: Record<string, { ok: number; no: number }>;
}

/** Ключ нарушения для дедупа: инвариант, код, вид шага. */
export const violationKey = (f: { op: Op; v: Violation }): string => `${f.v.inv}:${f.v.code}:${f.op.k}`;

/**
 * ПРОГОН ЦЕПОЧКИ: мир из сида, шаги по порядку, инварианты после каждого тика и команды. Первое нарушение — стоп (`only` —
 * ловить только этот ключ; `skip` — эти ключи уже известны, прогон идёт мимо них).
 */
export function runOps(seed: number, ops: readonly Op[], hooks: FuzzHooks = {}, only?: string, skip?: (key: string) => boolean): RunOut {
  hooks.resetUids?.();
  const log: string[] = [];
  const stats: RunOut['stats'] = {};
  let w: FuzzWorld;
  let ticks = 0;
  try {
    w = newWorld(seed, hooks);
  } catch (e) {
    const v: Violation = { inv: 'I7', code: 'crash-init', msg: String((e as Error)?.stack ?? e).slice(0, 800) };
    return { init: [v], steps: 0, ticks: 0, log, cover: {}, stats };
  }
  log.push(`мир: ${w.about}`);
  const init = [...w.probe.v.splice(0), ...stateInvariants(w)];
  // Стартовые позиции: герои и монстры не в стенах.
  for (const p of Object.values(w.s.world.players)) if (w.regions.at(p.pos) < 0) init.push({ inv: 'I1', code: 'in-wall', msg: `герой ${p.id} заспавнен в стене ${fmt(p.pos)}` });
  for (const m of w.s.world.monsters) if (w.regions.at(m.pos) < 0) init.push({ inv: 'M1', code: 'in-wall', msg: `монстр ${m.id} заспавнен в стене ${fmt(m.pos)}` });
  const accept = (op: Op, vs: Violation[]): Violation | undefined => (only ? vs.find((v) => violationKey({ op, v }) === only) : vs.find((v) => !skip?.(violationKey({ op, v }))));
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    const vs: Violation[] = [];
    let st: Step;
    try {
      st = execOp(w, op, vs, hooks, (v) => !!accept(op, [v]));
      vs.push(...w.probe.v.splice(0));
      if (op.k === 'descend') {
        for (const m of w.s.world.monsters) if (w.regions.at(m.pos) < 0) vs.push({ inv: 'M1', code: 'in-wall', msg: `монстр ${m.id} заспавнен в стене ${fmt(m.pos)}` });
      }
      vs.push(...stateInvariants(w));
    } catch (e) {
      const v: Violation = { inv: 'I7', code: 'crash', msg: String((e as Error)?.stack ?? e).slice(0, 800) };
      log.push(`#${i} ${op.k}/${op.h}: ПАДЕНИЕ ${v.msg.split('\n')[0]}`);
      const key = violationKey({ op, v });
      if (only ? key === only : !skip?.(key)) return { found: { at: i, op, v, log }, init, steps: i + 1, ticks, log, cover: w.cover, stats };
      return { init, steps: i + 1, ticks, log, cover: w.cover, stats };
    }
    ticks += st.ticks;
    const s = (stats[op.k] ??= { ok: 0, no: 0 });
    if (st.ok) s.ok++; else s.no++;
    log.push(`#${i} ${op.k}/${op.h}: ${st.desc}${st.ok ? '' : ` → отказ «${st.why}»`}`);
    const hit = accept(op, vs);
    if (hit) return { found: { at: i, op, v: hit, log }, init, steps: i + 1, ticks, log, cover: w.cover, stats };
  }
  return { init, steps: ops.length, ticks, log, cover: w.cover, stats };
}

/**
 * СЖАТИЕ: обрезать после нарушения, затем выбрасывать куски (половины, четверти… по одному), пока нарушение ТОГО ЖЕ ключа
 * воспроизводится. `budget` — предел прогонов.
 */
export function shrink(seed: number, ops: readonly Op[], key: string, hooks: FuzzHooks = {}, budget = 250): { ops: Op[]; out: RunOut } {
  let cur = [...ops];
  let best = runOps(seed, cur, hooks, key);
  if (!best.found) return { ops: cur, out: best };
  cur = cur.slice(0, best.found.at + 1);
  let runs = 1;
  let chunk = Math.max(1, Math.floor(cur.length / 2));
  while (chunk >= 1 && runs < budget) {
    let removed = false;
    for (let at = 0; at < cur.length && runs < budget;) {
      const cand = [...cur.slice(0, at), ...cur.slice(at + chunk)];
      runs++;
      const out = runOps(seed, cand, hooks, key);
      if (out.found) { cur = cand.slice(0, out.found.at + 1); best = out; removed = true; }
      else at += chunk;
    }
    if (!removed) chunk = Math.floor(chunk / 2);
  }
  return { ops: cur, out: best };
}

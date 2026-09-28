import { ConfigRegistry } from '../../config/registry.js';
import { createRng, type Rng } from '../../formulas/rng.js';
import { abilityCooldown, swingHalfWidth } from '../../formulas/combat.js';
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
import { debuffMods } from '../../world/debuffs.js';
import { findPath } from '../../world/pathfind.js';
import { wrapAngle } from '../../world/fastMath.js';
import type { PlayerEntity, MonsterEntity, ProjectileEntity, Obstacle, DropEntity } from '../../world/state.js';
import { GameSession, type PlayerInput, type SessionEvent, type FloorLayout } from '../session.js';
import { playerSnapshot, type PlayerSnapshot } from '../derive.js';
import { activeAbilityOf, effectivePool, reservedFrac, toggleBuffMods } from '../toggles.js';
import { resolveActive, socketsOpen, insertUnlocked, type ResolvedActive } from '../inserts.js';
import { validateInput } from '../netSchemas.js';

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
 *       снаряд (героя и монстра) не пролетает стену, шов и колонну, закрывающую обзор, и бьёт только видимое с места полёта (C-10).
 *  I3 — темп: удар/атака-скил не чаще общего лока по формуле скорости, скил — не чаще своего отката; серия — не больше `hits`.
 *  I4 — скилы и ресурсы: невыученное (ранг 0), чужого класса и не тем оружием не срабатывает; цена списана и была по карману;
 *       ресурсы не отрицательны; тоглы — только выученные; бафф — не дольше длительности и не поверх отката.
 *  I5 — взаимодействие и добыча: подбор/сундук/рычаг — в радиусе и видимости, живым, не оглушённым (кроме автоподбора), чужое
 *       не берётся; дверь открывает только её рычаг; добыча не пропадает и не двоится (uid уникальны); золото — ровно поднятое;
 *       сейв под транзакцией тиком не трогается; зелье без эффекта не тратится.
 *  I6 — прокачка и пулы: опыт только за убийство (сумма = опыт монстра), уровень и очки — по таблице; атрибуты/скилы тиком не
 *       меняются; здоровье/мана/выносливость не выше максимума (мана и выносливость — и не выше резерва аур/стоек).
 *  I7 — ничего не бросает, числа конечны.
 *  M1/M2 — монстры: не сквозь стены/закрытые двери, ближний удар монстра — в досягаемости и видимости.
 */

// ── Шаги ──────────────────────────────────────────────────────────────────────────────────────────

export type OpKind =
  | 'tick' | 'chest' | 'lever' | 'pickup' | 'drink' | 'drop' | 'equip' | 'unequip' | 'socket' | 'allocSkill'
  | 'respecSkills' | 'allocAttr' | 'hold' | 'revive' | 'descend' | 'stun';

/** Шаг цепочки: вид, чей герой (берётся по модулю числа героев), сид его бросков. */
export interface Op { k: OpKind; h: number; s: number }

/**
 * Веса видов шагов. Тик — основной (в нём ввод, бой, [E], пояс, рывки); команды — реже. `stun` — модель оглушения героя: сегодня
 * его не ставит ни один путь игры (только тесты), но правила «оглушённый не…» в ядре есть — вес маленький, нарушение с ним
 * отмечается как скрытое (латентное).
 */
export const OP_WEIGHTS: Record<OpKind, number> = {
  tick: 40, chest: 4, lever: 3, pickup: 5, drink: 3, drop: 2, equip: 5, unequip: 2, socket: 3, allocSkill: 2,
  respecSkills: 2, allocAttr: 1, hold: 2, revive: 1, descend: 2, stun: 1,
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
/** Константы ядра, которые не конфиг (session.ts): радиус [E] и клика по дропу, сундука/рычага, снаряда, новы по умолчанию. */
const PICK_R = 48;
const USE_R = 56;
const PROJ_R = 16;
const NOVA_R = 130;
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
  if (!REG) {
    REG = new ConfigRegistry();
    REG.loadAll();
    const tpl = REG.get('items.base').find((b) => b.id === 'healing-potion')!;
    const pot = (id: string, use: Record<string, unknown>) => ({
      ...structuredClone(tpl), id, name: id, enabled: false, dropWeight: 0,
      use: { heal: 0, healPct: 0, mana: 0, manaPct: 0, cure: false, ...use },
    });
    REG.reload({
      'items.base': [
        ...REG.get('items.base'),
        pot(BUFF_POTIONS[0], { buffMods: [{ stat: 'attackSpeed', kind: 'increased', value: 0.3 }, { stat: 'moveSpeed', kind: 'increased', value: 0.25 }], buffDurationSec: 6 }),
        pot(BUFF_POTIONS[1], { heal: 40, buffMods: [{ stat: 'maxHp', kind: 'flat', value: 60 }, { stat: 'maxMana', kind: 'flat', value: 30 }], buffDurationSec: 4 }),
      ],
    });
  }
  return REG;
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
  const reg = fuzzReg();
  const r = createRng((seed ^ 0x5eed5) >>> 0 || 1);
  const s = new GameSession(reg, seed, r.pick(['normal', 'normal', 'hard']));
  const n = Math.max(hooks.world?.minHeroes ?? 1, r.pick([1, 1, 2, 2, 3]));
  const heroes: Hero[] = [];
  const about: string[] = [];
  for (let i = 0; i < n; i++) {
    const { save, kit } = makeHero(reg, r, i);
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

/** Контекст доставки урона: откуда и какой геометрией бьют. Стек: проки вызывают доставку изнутри доставки. */
type Ctx =
  | { kind: 'melee'; hero: PlayerEntity; origin: Vec2; facing: number; range: number; arc: number; hit: Set<unknown> }
  | { kind: 'nova'; hero: PlayerEntity; origin: Vec2; radius: number; hit: Set<unknown> }
  | { kind: 'leap'; hero: PlayerEntity; to: Vec2; radius: number }
  | { kind: 'dash'; hero: PlayerEntity; from: Vec2; to: Vec2; halfW: number }
  | { kind: 'proj'; hero: PlayerEntity | undefined; pos: Vec2; projId: number }
  | { kind: 'struck'; hero: PlayerEntity; source?: MonsterEntity };
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

export interface Probe {
  v: Violation[];
  track: Map<string, Track>;
  /** Кто что поднял (takeDrop) за шаг: id дропа → поднявший. */
  taken: Map<number, string>;
  /** Сундуки, открытые за шаг (id → кто). */
  chests: Map<number, string>;
  /** Герои, которых преграда декора втолкнула в стену (V-RF-05): пока не выбрались, стены у них — следствие той же причины. */
  tainted: Set<string>;
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
    taken: new Map(),
    chests: new Map(),
    tainted: new Set(),
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
    if (c.kind !== 'proj' && c.hero !== hero) V('I2', 'wrong-hero', `урон ${what} записан на ${heroName(hero)}, а бьёт ${heroName(c.hero)}`);
    if (c.kind !== 'proj' && c.kind !== 'struck' && !c.hero.alive) V('I2', 'dead-attacker', `мёртвый ${heroName(c.hero)} бьёт ${what} (${c.kind})`);
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
    ctx.push({ kind: 'melee', hero: p, origin: { ...p.pos }, facing: p.facing, range: mel.baseRange * (weapon?.reachMult ?? 1) * rangeMult, arc: mel.baseArc * (weapon?.arcMult ?? 1) * arcMult, hit: new Set() });
    try { return orig(p, packet, attacker, weapon, opts, rangeMult, arcMult); } finally { ctx.pop(); }
  });
  wrap('skillNova', (orig) => (p: PlayerEntity, packet: unknown, attacker: unknown, active: { radius: number }, opts: unknown) => {
    ctx.push({ kind: 'nova', hero: p, origin: { ...p.pos }, radius: active.radius || NOVA_R, hit: new Set() });
    try { return orig(p, packet, attacker, active, opts); } finally { ctx.pop(); }
  });
  wrap('doLeap', (orig) => (p: PlayerEntity, packet: unknown, attacker: unknown, active: { dashDist: number; radius: number }, rank: number, opts: unknown) => {
    const d = active.dashDist > 0 ? active.dashDist : 150;
    const to = moveWithCollision(p.pos, { x: Math.cos(p.facing) * d, y: Math.sin(p.facing) * d }, p.radius, world.grid, 1, world.obstacles);
    ctx.push({ kind: 'leap', hero: p, to, radius: active.radius > 0 ? active.radius : 60 });
    try { return orig(p, packet, attacker, active, rank, opts); } finally { ctx.pop(); }
  });
  wrap('doDashAttack', (orig) => (p: PlayerEntity, packet: unknown, attacker: unknown, active: { dashDist: number }, rank: number, opts: unknown) => {
    const d = active.dashDist > 0 ? active.dashDist : 130;
    const from = { ...p.pos };
    const to = moveWithCollision(p.pos, { x: Math.cos(p.facing) * d, y: Math.sin(p.facing) * d }, p.radius, world.grid, 1, world.obstacles);
    const wpn = asHeld(p.save.equipment.weapon, p.save, grip);
    const halfW = swingHalfWidth(bal.melee.baseRange * (wpn?.reachMult ?? 1), bal.melee.baseArc * (wpn?.arcMult ?? 1));
    ctx.push({ kind: 'dash', hero: p, from, to, halfW });
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
    }
    ctx.push({ kind: 'struck', hero: t, source });
    try { return orig(t, packet, attacker, onHit, by, source); } finally { ctx.pop(); }
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
    const allow = cap * dt * (nearObst ? 2 : 1) + (nearObst ? obstacleDepth(world.obstacles, pos0, p.radius) : 0) + 1e-6;
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
  attrs: string; skills: string; masteries: string; equip: string;
  inv: Set<string>; belt: (string | null)[]; held: boolean; heldJson?: string;
  maxHp: number; maxMana: number; maxStam: number; effMana: number; effStam: number;
  /** Таймеры баффов и базы колб пояса (C-11: бафф зелья — только выпитой колбой). */
  buffs: Record<string, number>; beltBase: (string | null)[];
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
      gold: p.save.gold, attrs: JSON.stringify(p.save.attributes), skills: JSON.stringify(p.save.skills), masteries: JSON.stringify(p.save.masteries),
      equip: JSON.stringify(Object.entries(p.save.equipment).map(([k, it]) => [k, it?.uid])),
      inv: new Set(p.save.inventory.map((i) => i.uid)), belt: p.save.belt.map((b) => b?.uid ?? null), held,
      buffs: { ...p.skillBuffs }, beltBase: p.save.belt.map((b) => b?.baseId ?? null),
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
    // I6: не выше максимума (максимум — на начало тика или на конец: бафф, истёкший в тике, подрежет на следующем) и резерва.
    if (p.alive) {
      const o = w.probe.oracle(p).derived;
      const maxHp = Math.max(b.maxHp, o.maxHp), maxMana = Math.max(b.maxMana, o.maxMana), maxStam = Math.max(b.maxStam, o.maxStamina);
      if (p.hp > maxHp + 1e-6) V('I6', 'hp-max', `${name}: hp ${p.hp.toFixed(3)} > максимума ${maxHp.toFixed(3)}`);
      if (p.mana > maxMana + 1e-6) V('I6', 'mana-max', `${name}: мана ${p.mana.toFixed(3)} > максимума ${maxMana.toFixed(3)}`);
      if (p.stamina > maxStam + 1e-6) V('I6', 'stamina-max', `${name}: выносливость ${p.stamina.toFixed(3)} > максимума ${maxStam.toFixed(3)}`);
      const effM = Math.max(b.effMana, effectivePool(o.maxMana, reservedFrac(reg, p.toggles, 'mana')));
      const effS = Math.max(b.effStam, effectivePool(o.maxStamina, reservedFrac(reg, p.toggles, 'stamina')));
      if (p.mana > effM + 1e-6 && p.mana <= maxMana + 1e-6) V('I6', 'mana-reserve', `${name}: мана ${p.mana.toFixed(3)} выше резерва аур ${effM.toFixed(3)} (тоглы ${p.toggles.join(',')})`);
      if (p.stamina > effS + 1e-6 && p.stamina <= maxStam + 1e-6) V('I6', 'stamina-reserve', `${name}: выносливость ${p.stamina.toFixed(3)} выше резерва стоек ${effS.toFixed(3)}`);
      // I4: тоглы — только выученные (сброс вычищает их в начале тика у живого).
      if (b.alive) for (const t of p.toggles) if (!((p.save.skills[t] ?? 0) > 0)) V('I4', 'toggle-unlearned', `${name}: тогл «${t}» держится без ранга`);
      // Тоглы: без повторов, в эксклюзив-группе — один, резерв пула — меньше всего пула.
      if (new Set(p.toggles).size !== p.toggles.length) V('I4', 'toggle-dup', `${name}: тогл включён дважды (${p.toggles.join(',')})`);
      const groups = p.toggles.map((t) => { const a = activeAbilityOf(reg, t); return a && (a.category === 'aura' || a.category === 'stance') ? a.toggleGroup : undefined; }).filter((g): g is string => !!g);
      if (new Set(groups).size !== groups.length) V('I4', 'toggle-group', `${name}: две стойки одной группы (${p.toggles.join(',')})`);
      for (const [k, left] of Object.entries(p.skillBuffs)) {
        if (k.startsWith('ins:')) continue;
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
  /** Профиль мира: доля арен (0…1), доля PvP на арене, наименьшее число героев, доля арен с колоннами в линии огня (C-10). */
  world?: { arena?: number; pvp?: number; minHeroes?: number; pillars?: number };
  /** Только для зубов сторожа: подложить «баг» после каждого тика. */
  afterTick?: (w: FuzzWorld) => void;
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
    w.probe.taken.clear(); w.probe.chests.clear();
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

/** Дойти до точки (путь по сетке, как бот), остальные герои стоят; не дальше `max` тиков. */
function walkTo(w: FuzzWorld, pid: string, goal: Vec2, max: number, vs: Violation[], hooks: FuzzHooks, stopOn: (v: Violation) => boolean): number {
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
  }, vs, hooks, stopOn, () => dist(W.players[pid]!.pos, goal) < 30 || !W.players[pid]!.alive);
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
      const got = w.s.pickupDropById(h.pid, id);
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
      if (!w.s.drink(h.pid, it.use, it.baseId)) {
        if (def && potWas < def.durationSec - 1e-6) vs.push({ inv: 'I5', code: 'potion-buff-lost', msg: `${h.pid}: колба ${it.baseId} — «нет эффекта» при баффе ${potWas.toFixed(3)} из ${def.durationSec} с` });
        return refuse(desc, 'нет эффекта');
      }
      if (def && Math.abs((p.skillBuffs[`pot:${it.baseId}`] ?? 0) - def.durationSec) > EPS) vs.push({ inv: 'I4', code: 'buff-duration', msg: `${h.pid}: бафф колбы ${it.baseId} ${p.skillBuffs[`pot:${it.baseId}`]} с, а длительность ${def.durationSec}` });
      const bi = p.save.belt.findIndex((x) => x?.uid === it.uid);
      if (bi >= 0) p.save.belt[bi] = null;
      else { const ii = p.save.inventory.findIndex((x) => x.uid === it.uid); if (ii >= 0) p.save.inventory.splice(ii, 1); }
      // C-14: мана — до потолка резерва аур; здоровье — до максимума.
      const cap = effectivePool(snap.maxMana, reservedFrac(reg, p.toggles, 'mana'));
      if (p.mana > cap + 1e-6) vs.push({ inv: 'I6', code: 'mana-reserve', msg: `${h.pid}: зелье налило ману ${p.mana.toFixed(2)} выше резерва ${cap.toFixed(2)}` });
      if (p.hp > snap.maxHp + 1e-6) vs.push({ inv: 'I6', code: 'hp-max', msg: `${h.pid}: зелье налило hp ${p.hp.toFixed(2)} > ${snap.maxHp.toFixed(2)}` });
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

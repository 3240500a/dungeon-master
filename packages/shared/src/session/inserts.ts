import type { ConfigRegistry } from '../config/registry.js';
import type { ConfigShapes } from '../config/schemas.js';
import type { SaveState } from '../types/save.js';
import { activeAbilityOf } from './toggles.js';

/**
 * МОДУЛЬНЫЕ АКТИВНЫЕ СКИЛЫ: гнёзда и вставки.
 *
 * ЗАЧЕМ. Выдумывать отдельный скил на каждую идею — самый дорогой способ дать разнообразие,
 * и упирается он в человека, который рисует анимации. Здесь разнообразие берётся из КОМБИНАЦИЙ:
 * у активного узла есть гнёзда (открываются рангом), в них ставятся вставки, открытые в ветках.
 *
 * ЗДЕСЬ ЖИВЁТ ВЕСЬ ШОВ. `resolveActive` возвращает ЭФФЕКТИВНУЮ способность, и всё, что ниже по
 * течению (проверка ресурса, КД, оружия, замах, `executeAbility`), работает на ней без единой
 * правки. Один шов вместо десятка — потому что способность и так уже была данными.
 *
 * ФУНКЦИЯ ЧИСТАЯ И БЕЗ THREE/DOM: её зовут и сервер, и клиент, и редактор (предпросмотр сборки).
 * Именно поэтому дизайнер видит в редакторе РОВНО те же числа, что считает сервер.
 *
 * ГЛАВНЫЙ ИНВАРИАНТ: пустые гнёзда обязаны давать способность БАЙТ-В-БАЙТ прежнюю. На этом стоят
 * все 149 существующих активок — система включается, не трогая ни одной из них.
 */

type ActiveAbility = NonNullable<ConfigShapes['skill-tree']['nodes'][number]['effect']['active']>;
type SkillInsert = ConfigShapes['skill-inserts'][number];
type Offensive = Extract<ActiveAbility, { category: 'attack' | 'cast' }>;

/** Доп. эффект вставки, который выстрелит отдельно от носителя (см. `session.executeAbility`). */
export interface InsertProc {
  insertId: string;
  on: 'cast' | 'hit';
  chance: number;
  ability: ActiveAbility;
}

export interface ResolvedActive {
  /** Способность носителя с наложенными вставками. При пустых гнёздах — ИСХОДНЫЙ объект. */
  active: ActiveAbility;
  /** Отдельные эффекты вставок (волна, разряд, печать). */
  procs: InsertProc[];
  /** Что реально применилось — для подсказок в интерфейсе и предпросмотра в редакторе. */
  applied: SkillInsert[];
}

/**
 * Сколько гнёзд открыто на этом ранге. Пороги — из баланса (`skillSocketRanks`), длина массива
 * задаёт потолок. Ранг 0 (скил не выучен) гнёзд не даёт вовсе.
 */
export function socketsOpen(reg: ConfigRegistry, rank: number): number {
  if (rank <= 0) return 0;
  const ranks = reg.get('balance').skillSocketRanks;
  let n = 0;
  for (const r of ranks) if (rank >= r) n++;
  return n;
}

/** Вставка по id (только включённая — выключенную дизайнером в игру не пускаем). */
export function insertById(reg: ConfigRegistry, id: string): SkillInsert | undefined {
  const ins = reg.get('skill-inserts').find((i) => i.id === id);
  return ins?.enabled === false ? undefined : ins;
}

/**
 * ОТКРЫТА ЛИ ВСТАВКА У ИГРОКА: где-то в дереве есть узел с `grantsInsert` и вложенным рангом.
 * Проверка идёт по дереву, а не по отдельному списку в сейве, — тогда нечего рассинхронизировать
 * и нечего подделать: сброс дерева автоматически закрывает вставки.
 */
export function insertUnlocked(reg: ConfigRegistry, save: SaveState, insertId: string): boolean {
  for (const n of reg.get('skill-tree').nodes) {
    if (n.effect.grantsInsert === insertId && (save.skills[n.id] ?? 0) > 0) return true;
  }
  return false;
}

/**
 * Влезает ли вставка в этого носителя. Пустое ограничение — «куда угодно»; это позволяет заводить
 * универсальные вставки, не перечисляя все категории.
 */
export function insertFits(ins: SkillInsert, active: ActiveAbility, weaponClass?: string): boolean {
  const f = ins.fits;
  if (f.categories?.length && !(f.categories as string[]).includes(active.category)) return false;
  if (f.shapes?.length) {
    if (active.category !== 'cast') return false;
    if (!(f.shapes as string[]).includes(active.shape)) return false;
  }
  // Оружие проверяем, ТОЛЬКО когда оно известно: в редакторе и в подсказках его может не быть,
  // и отказывать там нечестно — реальный отказ выдаст сервер при попытке вставить.
  if (f.weaponClasses?.length && weaponClass && !(f.weaponClasses as string[]).includes(weaponClass)) return false;
  return true;
}

/** Вставки, реально стоящие в гнёздах узла: в пределах открытых гнёзд, включённые, по одной на тип. */
function socketed(reg: ConfigRegistry, save: SaveState, nodeId: string, active: ActiveAbility): SkillInsert[] {
  const ids = save.sockets?.[nodeId];
  if (!ids?.length) return [];
  const open = socketsOpen(reg, save.skills[nodeId] ?? 0);
  const out: SkillInsert[] = [];
  const seenTypes = new Set<string>();
  for (let i = 0; i < Math.min(ids.length, open); i++) {
    const id = ids[i];
    if (!id) continue;
    const ins = insertById(reg, id);
    // Тихо игнорируем негодное, а не падаем: конфиг мог поменяться под уже собранным скилом
    // (дизайнер выключил вставку, срезали ранг). Игрок в этом не виноват — скил просто слабее.
    if (!ins || seenTypes.has(ins.type) || !insertFits(ins, active)) continue;
    if (!insertUnlocked(reg, save, ins.id)) continue;
    seenTypes.add(ins.type);
    out.push(ins);
  }
  return out;
}

/** Число с округлением до сотых — чтобы стоимость и КД не тащили за собой хвост плавающей точки. */
const r2 = (x: number): number => Math.round(x * 100) / 100;

/**
 * Наложить вставки. ЦЕНА СБОРКИ перемножается по всем вставкам: три вставки ≈ ×2.2 к стоимости —
 * голый скил остаётся дешёвым и спамным, собранный бьёт реже и дороже. Без этого «ставь всё»
 * было бы единственной стратегией.
 */
function applyInserts(active: ActiveAbility, list: readonly SkillInsert[]): ActiveAbility {
  const a = structuredClone(active) as ActiveAbility;
  let cost = 1, cd = 1;
  for (const ins of list) {
    cost *= ins.costMult;
    cd *= ins.cooldownMult;
    const t = ins.tune;
    if (!t) continue;
    // Поля контроля и охвата есть у attack/cast, но не у aura/stance/buff — сужаем тип один раз.
    const off = (a.category === 'attack' || a.category === 'cast') ? (a as Offensive) : null;
    if (off) {
      if (t.damageMultMul !== undefined) off.damageMult *= t.damageMultMul;
      if (t.element !== undefined) off.element = t.element;
      if (t.convertPct !== undefined) off.convertPct = t.convertPct;
      if (t.addElementPct !== undefined) off.addElementPct = t.addElementPct;
      if (t.multScope !== undefined) off.multScope = t.multScope;
      if (t.knockbackAdd !== undefined) off.knockback += t.knockbackAdd;
      if (t.stunSecAdd !== undefined) off.stunSec += t.stunSecAdd;
      if (t.knockdownChanceAdd !== undefined) off.knockdownChance = Math.min(1, off.knockdownChance + t.knockdownChanceAdd);
      if (t.ailment !== undefined) off.ailment = structuredClone(t.ailment);
    }
    if (a.category === 'attack') {
      if (t.speedMul !== undefined) a.speed *= t.speedMul;
      if (t.arcMultMul !== undefined) a.arcMult *= t.arcMultMul;
      if (t.rangeMultMul !== undefined) a.rangeMult *= t.rangeMultMul;
      if (t.countAdd !== undefined) a.count = Math.max(1, a.count + t.countAdd);
      if (t.spreadAdd !== undefined) a.spread += t.spreadAdd;
      if (t.hitsAdd !== undefined) a.hits = Math.max(1, a.hits + t.hitsAdd);
      if (t.pierce !== undefined) a.pierce = t.pierce;
    }
    if (a.category === 'cast' && t.radiusMul !== undefined) a.radius *= t.radiusMul;
    if (a.category === 'curse' && t.ailment !== undefined) a.ailment = structuredClone(t.ailment);
  }
  a.manaCost = r2(a.manaCost * cost);
  a.cooldown = r2(a.cooldown * cd);
  return a;
}

/**
 * ГЛАВНАЯ ТОЧКА: способность узла с учётом вставок. `undefined` — у узла нет активки.
 *
 * Пустые гнёзда возвращают ИСХОДНЫЙ объект без клонирования — и дёшево, и служит доказательством
 * инварианта нетронутости (сравнение по ссылке в тесте).
 */
export function resolveActive(reg: ConfigRegistry, save: SaveState, nodeId: string): ResolvedActive | undefined {
  const base = activeAbilityOf(reg, nodeId);
  if (!base) return undefined;
  const list = socketed(reg, save, nodeId, base);
  if (!list.length) return { active: base, procs: [], applied: [] };
  const procs: InsertProc[] = [];
  for (const ins of list) {
    if (ins.proc) procs.push({ insertId: ins.id, on: ins.proc.on, chance: ins.proc.chance, ability: ins.proc.ability });
  }
  return { active: applyInserts(base, list), procs, applied: [...list] };
}

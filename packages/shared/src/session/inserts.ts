import type { ConfigRegistry } from '../config/registry.js';
import type { ConfigShapes } from '../config/schemas.js';
import type { SaveState } from '../types/save.js';
import { activeAbilityOf } from './toggles.js';
import { insertCooldownMult, insertGain } from '../formulas/buffTiming.js';

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

/** Вставка вместе с рангом её узла-донора — ранг определяет силу, а не только доступ. */
export interface AppliedInsert { insert: SkillInsert; rank: number }

/** Пул ресурса. Тот же союз, что у `active.resource`, — имя нужно, чтобы не писать его пять раз. */
export type ResourcePool = 'mana' | 'stamina';

/**
 * ЧЕЙ РЕСУРС ПЛАТИТ ЗА ЭТУ ВСТАВКУ. `carrier` — пул носителя (как было всегда), иначе — свой.
 * Правило: вставка платит своим ресурсом. Огонь в мече берёт ману, даже когда меч бьёт на
 * выносливости. Обратной симметрии нет: физические вставки остаются `carrier`, иначе у мага
 * они стали бы почти бесплатными — выносливость он всё равно не тратит.
 */
export const insertPool = (ins: SkillInsert, carrier: ResourcePool): ResourcePool =>
  (ins.costPool === 'carrier' ? carrier : ins.costPool);

export interface ResolvedActive {
  /** Способность носителя с наложенными вставками. При пустых гнёздах — ИСХОДНЫЙ объект. */
  active: ActiveAbility;
  /**
   * ВТОРАЯ ЦЕНА: надбавка вставок, ушедшая в ЧУЖОЙ пул. Её платят вместе с `active.manaCost`,
   * и именно она делает стихию в мече магией: выносливость не растёт, а мана убывает.
   * Нет магических вставок (или они в пуле носителя) — поля нет вовсе.
   */
  extraCost?: { pool: ResourcePool; amount: number };
  /** Отдельные эффекты вставок (волна, разряд, печать). */
  procs: InsertProc[];
  /** Что реально применилось и с каким рангом — для подсказок и предпросмотра в редакторе. */
  applied: AppliedInsert[];
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
 * РАНГ ВСТАВКИ У ИГРОКА — ранг узла-донора; 0 значит «закрыта».
 *
 * Считается по дереву, а не по отдельному списку в сейве: тогда нечего рассинхронизировать
 * и нечего подделать — сброс дерева автоматически закрывает вставки. Ранг возвращается, а не
 * сводится к «да/нет», потому что от него зависит СИЛА вставки: узел-донор прокачиваемый.
 * Доноров у вставки один (стережёт тест), но на всякий случай берём максимум.
 */
export function insertRank(reg: ConfigRegistry, save: SaveState, insertId: string): number {
  let best = 0;
  for (const n of reg.get('skill-tree').nodes) {
    if (n.effect.grantsInsert === insertId) best = Math.max(best, save.skills[n.id] ?? 0);
  }
  return best;
}

/** Открыта ли вставка вообще. Обёртка над рангом — там, где сила не нужна, а нужен факт доступа. */
export function insertUnlocked(reg: ConfigRegistry, save: SaveState, insertId: string): boolean {
  return insertRank(reg, save, insertId) > 0;
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
function socketed(reg: ConfigRegistry, save: SaveState, nodeId: string, active: ActiveAbility): AppliedInsert[] {
  const ids = save.sockets?.[nodeId];
  if (!ids?.length) return [];
  const open = socketsOpen(reg, save.skills[nodeId] ?? 0);
  const out: AppliedInsert[] = [];
  const seenTypes = new Set<string>();
  for (let i = 0; i < Math.min(ids.length, open); i++) {
    const id = ids[i];
    if (!id) continue;
    const ins = insertById(reg, id);
    // Тихо игнорируем негодное, а не падаем: конфиг мог поменяться под уже собранным скилом
    // (дизайнер выключил вставку, срезали ранг). Игрок в этом не виноват — скил просто слабее.
    if (!ins || seenTypes.has(ins.type) || !insertFits(ins, active)) continue;
    const rank = insertRank(reg, save, ins.id);
    if (rank <= 0) continue;
    seenTypes.add(ins.type);
    out.push({ insert: ins, rank });
  }
  return out;
}

/** Число с округлением до сотых — чтобы стоимость и КД не тащили за собой хвост плавающей точки. */
const r2 = (x: number): number => Math.round(x * 100) / 100;

/**
 * Статус на ранге: растут ШАНС и СИЛА, а вид статуса и число стаков — нет. Стаки штучные, а вид —
 * это «что именно накладываем», и рангом он не становится другим.
 */
function scaleAilment<T extends { chance: number; mag: number; mag2?: number }>(al: T, k: number): T {
  const out = structuredClone(al);
  out.chance = Math.min(1, al.chance * k);
  out.mag = al.mag * k;
  if (out.mag2 !== undefined) out.mag2 = (al.mag2 ?? 0) * k;
  return out;
}

/**
 * СЛИЯНИЕ СТАТУСА ВСТАВКИ СО СТАТУСОМ НОСИТЕЛЯ.
 *
 * Раньше статус вставки просто ЗАМЕЩАЛ носителя — и замер поймал следствие: «Зазубрины»
 * (кровотечение 35%) на «Секущих ранах» (80%) роняли ДПС на 38%, потому что подменяли сильное
 * кровотечение слабым. Вставка не должна делать скил ХУЖЕ: за неё платят гнездом и ценой.
 *
 * Тот же вид статуса — складываем как два независимых источника: `1 − (1−a)(1−b)`. Это честнее
 * и суммы шансов (которая дала бы больше 100%), и максимума (который просто игнорировал бы
 * второй источник). Сила и длительность — по максимуму: два кровотечения не режут глубже, чем
 * более глубокое из них. Другой вид — замена: игрок СОЗНАТЕЛЬНО поменял статус скила.
 */
function mergeAilment<T extends { kind?: string; chance: number; mag: number; mag2?: number; durationMs: number; maxStacks: number }>(
  base: T | undefined, add: T,
): T {
  if (!base || !base.kind || base.kind !== add.kind) return add;
  const out = structuredClone(add);
  out.chance = Math.min(1, 1 - (1 - base.chance) * (1 - add.chance));
  out.mag = Math.max(base.mag, add.mag);
  if (base.mag2 !== undefined || add.mag2 !== undefined) out.mag2 = Math.max(base.mag2 ?? 0, add.mag2 ?? 0);
  out.durationMs = Math.max(base.durationMs, add.durationMs);
  out.maxStacks = Math.max(base.maxStacks, add.maxStacks);
  return out;
}

/**
 * Прибавка вставки на её ранге. Масштаб ОДИН на все поля, но применяется по-разному — см. ниже.
 * Ранг 1 обязан давать РОВНО исходные числа (`k = 1`), иначе поедет весь существующий контент.
 */
const gainAt = (ins: SkillInsert, rank: number): number => insertGain(ins.perRank.gain, rank);   // ⭐ D4: та же формула, что у правила баффа

/**
 * МАСШТАБ ПО РОДУ ПОЛЯ. Множитель растёт своим отклонением от единицы, добавка — просто умножением.
 * Разница не косметическая: `damageMultMul: 0.85` — это ШТРАФ («шире дуга, но слабее удар»), и
 * наивное `v · k` на высоком ранге превратило бы штраф в бонус.
 */
const mulAt = (v: number, k: number): number => 1 + (v - 1) * k;
const addAt = (v: number, k: number): number => v * k;

/**
 * Наложить вставки. ЦЕНА СБОРКИ перемножается по всем вставкам: три вставки ≈ ×2.2 к стоимости —
 * голый скил остаётся дешёвым и спамным, собранный бьёт реже и дороже. Без этого «ставь всё»
 * было бы единственной стратегией.
 *
 * РАНГ узла-донора усиливает прибавку и надбавку к цене, но СНИЖАЕТ надбавку к откату: на высоком
 * ранге вставка почти не удлиняет носителя — иначе качать её было бы наказанием, а не наградой.
 *
 * ⭐ ЦЕНА ВСТАВКИ ПЛОСКАЯ И СКЛАДЫВАЕТСЯ, а не множится на цену носителя. «Пламенное лезвие» стоит
 * 5 маны и в дешёвом скиле, и в дорогом: ценник читается один раз и сравнивать сборки можно глазами.
 * Своя цена идёт в свой пул: совпал с пулом носителя — прибавляется к его цене, нет — становится
 * ВТОРОЙ ценой (`extraCost`).
 */
function applyInserts(
  active: ActiveAbility, list: readonly AppliedInsert[],
): { active: ActiveAbility; extraCost?: { pool: ResourcePool; amount: number } } {
  const a = structuredClone(active) as ActiveAbility;
  const carrier: ResourcePool = active.resource;
  const other: ResourcePool = carrier === 'stamina' ? 'mana' : 'stamina';
  let cost = 0, cd = 1, extra = 0;
  for (const { insert: ins, rank } of list) {
    const k = gainAt(ins, rank);
    const r = Math.max(1, rank) - 1;
    const price = ins.cost * (1 + ins.perRank.cost * r);
    if (insertPool(ins, carrier) === carrier) cost += price;
    else extra += price;
    cd *= insertCooldownMult(ins.cooldownMult, ins.perRank.cooldownDecay, rank);   // ⭐ D4: та же формула, что у правила баффа
    const t = ins.tune;
    if (!t) continue;
    // Поля контроля и охвата есть у attack/cast, но не у aura/stance/buff — сужаем тип один раз.
    const off = (a.category === 'attack' || a.category === 'cast') ? (a as Offensive) : null;
    if (off) {
      if (t.damageMultMul !== undefined) off.damageMult *= mulAt(t.damageMultMul, k);
      // Стихия, охват множителя и вид статуса — ВЫБОР, а не число: рангом не масштабируются.
      if (t.element !== undefined) off.element = t.element;
      if (t.convertPct !== undefined) off.convertPct = Math.min(1, addAt(t.convertPct, k));
      if (t.addElementPct !== undefined) off.addElementPct = addAt(t.addElementPct, k);
      if (t.multScope !== undefined) off.multScope = t.multScope;
      if (t.knockbackAdd !== undefined) off.knockback += addAt(t.knockbackAdd, k);
      if (t.stunSecAdd !== undefined) off.stunSec += addAt(t.stunSecAdd, k);
      if (t.knockdownChanceAdd !== undefined) off.knockdownChance = Math.min(1, off.knockdownChance + addAt(t.knockdownChanceAdd, k));
      if (t.ailment !== undefined) off.ailment = mergeAilment(off.ailment, scaleAilment(t.ailment, k));
    }
    if (a.category === 'attack') {
      if (t.speedMul !== undefined) a.speed *= mulAt(t.speedMul, k);
      if (t.arcMultMul !== undefined) a.arcMult *= mulAt(t.arcMultMul, k);
      if (t.rangeMultMul !== undefined) a.rangeMult *= mulAt(t.rangeMultMul, k);
      // Снаряды и удары ШТУЧНЫЕ: дробный рост здесь бессмыслен, рангом не трогаем.
      if (t.countAdd !== undefined) a.count = Math.max(1, a.count + t.countAdd);
      if (t.spreadAdd !== undefined) a.spread += addAt(t.spreadAdd, k);
      if (t.hitsAdd !== undefined) a.hits = Math.max(1, a.hits + t.hitsAdd);
      if (t.pierce !== undefined) a.pierce = t.pierce;
    }
    if (a.category === 'cast' && t.radiusMul !== undefined) a.radius *= mulAt(t.radiusMul, k);
    if (a.category === 'curse' && t.ailment !== undefined) a.ailment = mergeAilment(a.ailment, scaleAilment(t.ailment, k));
  }
  a.manaCost = r2(Math.max(0, a.manaCost + cost));   // скидка не уводит цену ниже нуля
  a.cooldown = r2(a.cooldown * cd);
  // Скидочная вставка в чужом пуле не должна ВОЗВРАЩАТЬ ресурс из ниоткуда — вторая цена не бывает
  // отрицательной. Скидку имеет смысл давать в своём пуле, там она честно уменьшает цену носителя.
  const amount = r2(Math.max(0, extra));
  return amount > 0 ? { active: a, extraCost: { pool: other, amount } } : { active: a };
}

/** Способность-прок на ранге: урон и радиус — множителями, длительность баффа — тоже. */
function scaleProc(ab: ActiveAbility, k: number): ActiveAbility {
  if (k === 1) return ab;                      // ранг 1 — отдаём как есть, без клона
  const out = structuredClone(ab) as ActiveAbility;
  if (out.category === 'attack' || out.category === 'cast') {
    out.damageMult *= k;
    if (out.ailment) out.ailment = scaleAilment(out.ailment, k);
  }
  if (out.category === 'cast') out.radius *= k;
  if (out.category === 'buff') out.durationSec *= k;
  return out;
}

/** Что исключить из сборки. Сегодня нужен один случай: не хватило маны — магические вставки гаснут. */
export interface ResolveOpts { omitPools?: readonly ResourcePool[] }

/**
 * ГЛАВНАЯ ТОЧКА: способность узла с учётом вставок. `undefined` — у узла нет активки.
 *
 * Пустые гнёзда возвращают ИСХОДНЫЙ объект без клонирования — и дёшево, и служит доказательством
 * инварианта нетронутости (сравнение по ссылке в тесте).
 *
 * `omitPools` собирает ту же способность БЕЗ вставок, которые платят из названного пула. Так сделан
 * откат «нет маны — удар проходит без стихии»: вставка не применяется и не оплачивается, а скил
 * продолжает работать. Иначе мили-персонаж на сухой мане терял бы основную атаку целиком.
 */
export function resolveActive(
  reg: ConfigRegistry, save: SaveState, nodeId: string, opts: ResolveOpts = {},
): ResolvedActive | undefined {
  const base = activeAbilityOf(reg, nodeId);
  if (!base) return undefined;
  let list = socketed(reg, save, nodeId, base);
  if (opts.omitPools?.length) {
    const omit = new Set(opts.omitPools);
    list = list.filter(({ insert }) => !omit.has(insertPool(insert, base.resource)));
  }
  if (!list.length) return { active: base, procs: [], applied: [] };
  const procs: InsertProc[] = [];
  for (const { insert: ins, rank } of list) {
    if (!ins.proc) continue;
    // Урон и радиус доп. эффекта тоже растут с рангом вставки — иначе «Волна холода» на десятом
    // ранге била бы ровно как на первом, и качать её было бы незачем.
    procs.push({ insertId: ins.id, on: ins.proc.on, chance: ins.proc.chance, ability: scaleProc(ins.proc.ability, gainAt(ins, rank)) });
  }
  const { active, extraCost } = applyInserts(base, list);
  return { active, procs, applied: [...list], ...(extraCost ? { extraCost } : {}) };
}

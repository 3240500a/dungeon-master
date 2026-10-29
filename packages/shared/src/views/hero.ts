/**
 * ⭐ ВИДЫ ГЕРОЯ ДЛЯ КЛИЕНТА (сервер авторитетен во всём): числа героя, HUD, блок атрибутов мастера, лист персонажа, древо скилов,
 * карточка оружия и таблица «в руках → скую» — ровно тот JSON, который рисуют окна Unity (модели `DmStats` / `DmSheet` / `DmSkillTree`).
 * Ключи объектов = имена публичных полей C#-моделей (`JToken.ToObject<T>()`, настройки по умолчанию).
 *
 * ⚠ ПРАВИЛА — СЕРВЕРНЫЕ, а не веб-`GameState`: герой — `playerSnapshot` (гир «как держат» — `asHeld` полуторного со щитом, класс брони,
 * мастерства, древо, `skillTreeSetBonus`) + рантайм-моды (ауры и стойки — `toggleBuffMods`, или `runtimeMods` сессии целиком). Удар листа —
 * тем оружием, которым бьёт сервер (`asHeld`). Формулы — оригиналы shared (никаких копий): `deriveStats`/`finalAttributes`, `attackByType`,
 * `resolveActive`, `shapeSkillPacket`, `weaponDebuffs`/`elementDebuffs`, `statusChance`, `armorPoise`, `effectiveLevel`, `xpProgress`,
 * `floorMonsterLevel`, `waypointHint`. Тексты и числа — те же выражения JS, что у веб-окон (`progression/panels.ts`, `render3d/hud3d.ts`),
 * с которых снят эталон `unity_stats.json`; сверка — `hero.test.ts`.
 *
 * Строка листа (`SheetRow`) = `DmSheet.Row`: листовые тексты слева направо (подпись, значение, «+Δ» превью; пустые выпадают), полоса —
 * `▮ширина%`; подсказка — текстом, строки через `\n`, без вёрстки.
 */
import type { ConfigRegistry } from '../config/registry.js';
import type { ConfigShapes } from '../config/schemas.js';
import type { SaveState } from '../types/save.js';
import type { Attribute, Attributes, DerivedStats, HpManaScaling, StatModifier } from '../types/attributes.js';
import { ATTRIBUTES, DEFAULT_HP_MANA_SCALING } from '../types/attributes.js';
import type { DamageType } from '../types/combat.js';
import { DAMAGE_TYPES, emptyPacket } from '../types/combat.js';
import type { Item } from '../types/items.js';
import { playerSnapshot } from '../session/derive.js';
import { activeToggleInfos, reservedFrac, toggleBuffMods } from '../session/toggles.js';
import { resolveActive } from '../session/inserts.js';
import { deriveStats, finalAttributes } from '../formulas/stats.js';
import { passiveTreeModifiers, skillTreeModifiers } from '../formulas/skills.js';
import { xpProgress } from '../formulas/xp.js';
import { attackByType, type TypedRange } from '../formulas/playerCombat.js';
import { asHeld, gripOf } from '../formulas/versatile.js';
import { carriedGear, effectiveLevel, floorMonsterLevel } from '../formulas/power.js';
import { abilityRankMult, meleeGeometry } from '../formulas/combat.js';
import { elementDebuffs, shapeSkillPacket, weaponDebuffs, type SkillDamageShape } from '../formulas/resolveWeapon.js';
import { armorPoise } from '../formulas/resolveArmor.js';
import { PERCENT_STATS, STAT_LABEL } from '../formulas/itemDescribe.js';
import { STATUS_CHANCE_CAP, debuffIcon, debuffLabel, isDotKind, statusChance, type DebuffApply, type DebuffKind } from '../world/debuffs.js';
import { waypointHint } from '../dungeon/run/labels.js';
import { dmgName, elementOf } from './heroText.js';

export * from './heroCard.js';
export * from './heroTree.js';

type SkillNode = ConfigShapes['skill-tree']['nodes'][number];
type ActiveAbility = NonNullable<SkillNode['effect']['active']>;
type ByType = Record<DamageType, TypedRange>;

// ── входы ──────────────────────────────────────────────────────────────────────────────────────────

/** Живые пулы героя (то, что сервер держит в `PlayerEntity`: hp / mana / stamina). */
export interface HeroVitals { hp: number; mana: number; stamina: number }
/** Узел, где стоит герой: город или этаж подземелья (`challengeLevel` — уровень монстров, как его заселил сервер; null — по глубине). */
export interface HeroFloor { area: 'town' | 'dungeon'; depth: number; difficultyId: string; challengeLevel: number | null }
/** Последний атакованный монстр (меткость/уклонение — его боевые статы) = C# `DmSheet.Target`. */
export interface LastTarget { name: string; accuracy: number; evade: number }
/** Набранное в буфер листа, ещё не отправленное (`allocAttr`): превью «+Δ». */
export type PendingAttrs = Partial<Record<Attribute, number>>;

/**
 * Рантайм героя сверх сейва. По умолчанию — моды включённых аур и стоек (`toggleBuffMods(toggles)`). Сервер передаёт `runtimeMods`
 * своей сессии ЦЕЛИКОМ (тоглы + баффы скилов, печатей и зелий, в том же порядке, что у `playerSnapshot` боя) — тогда моды тоглов
 * повторно не добавляются. `hero` — уже посчитанный `heroCalc` (один расчёт на несколько видов за тик).
 */
export interface HeroOpts { runtimeMods?: StatModifier[]; hero?: HeroCalc }

// ── герой ──────────────────────────────────────────────────────────────────────────────────────────

/** Числа героя для клиента = C# `DmStats.Hero` (поля `derived`, `effective`, `permanent`, `reserveMana`, `reserveStamina`). */
export interface HeroNumbers {
  /** Все ключи `DerivedStats`. */
  derived: DerivedStats;
  /** Итоговые атрибуты (со всеми модами — гир, древо, мастерства, ауры). */
  effective: Attributes;
  /** «Свои» атрибуты: база + мастерства + древо скилов (без гира и аур) — то, что останется, если снять всё. */
  permanent: Attributes;
  /** Доля маны в резерве аур (0..0.9). */
  reserveMana: number;
  /** Доля выносливости в резерве стоек (0..0.9). */
  reserveStamina: number;
}

/** Полный расчёт героя (серверный) — вход всех видов. Не для провода: `mods` и `held` нужны только видам. */
export interface HeroCalc extends HeroNumbers {
  /** Все моды героя в порядке сложения (`playerSnapshot.modifiers`). */
  mods: StatModifier[];
  /** Масштаб пулов класса (для превью «+Δ» — те же моды, другие базовые атрибуты). */
  scaling: HpManaScaling;
  /** Оружие основной руки «как его держат» (`asHeld`): им сервер считает базовый удар и скилы. */
  held: Item | undefined;
}

/** Серверный расчёт героя: `playerSnapshot` + рантайм-моды, «свои» атрибуты, резерв пулов. */
export function heroCalc(cfg: ConfigRegistry, save: SaveState, toggles: readonly string[], opts: HeroOpts = {}): HeroCalc {
  if (opts.hero) return opts.hero;
  const runtime = opts.runtimeMods ?? toggleBuffMods(cfg, toggles);
  const snap = playerSnapshot(save, cfg, runtime);
  const own = [...passiveTreeModifiers(cfg.get('mastery-tree'), save.masteries), ...skillTreeModifiers(cfg.get('skill-tree'), save.skills)];
  return {
    derived: snap.derived,
    effective: snap.attrs,
    permanent: finalAttributes(save.attributes, own),
    reserveMana: reservedFrac(cfg, toggles, 'mana'),
    reserveStamina: reservedFrac(cfg, toggles, 'stamina'),
    mods: snap.modifiers,
    scaling: cfg.get('classes').find((c) => c.id === save.classId)?.derived ?? DEFAULT_HP_MANA_SCALING,
    held: asHeld(save.equipment.weapon, save, gripOf(cfg.get('balance').versatile)),
  };
}

/** ⭐ Замена `DmStats.Hero.Of`: деривы, итоговые и «свои» атрибуты, резерв маны и выносливости — по правилам сервера. */
export function heroNumbers(cfg: ConfigRegistry, save: SaveState, toggles: readonly string[], opts: HeroOpts = {}): HeroNumbers {
  const h = heroCalc(cfg, save, toggles, opts);
  return { derived: h.derived, effective: h.effective, permanent: h.permanent, reserveMana: h.reserveMana, reserveStamina: h.reserveStamina };
}

/**
 * ⭐ С-аудит (29.10): КОНУС ВЗМАХА ГЕРОЯ — поле `melee` кадра `hero` (дебаг-слой F3 клиента рисует его, своей формулы у клиента нет).
 * Та же `meleeGeometry`, которой бьёт сервер (`GameSession.meleeSwing`), от оружия первого взмаха базовой атаки — основной руки в хвате
 * (`asHeld`, как `attackWeaponsOf(...)[0]`): `range` — дальность (px мира, от центра героя до центра цели), `halfArc` — ПОЛУугол сектора
 * (рад). Множители скила (`rangeMult`/`arcMult`) — у взмаха скила свои, сюда не входят. Оружие бьёт снарядом (`attackType` не `melee`:
 * лук, посох-болт) — `null`: взмаха нет.
 */
export interface HeroMelee { range: number; halfArc: number }
export function heroMelee(cfg: ConfigRegistry, save: SaveState): HeroMelee | null {
  const bal = cfg.get('balance');
  const weapon = asHeld(save.equipment.weapon, save, gripOf(bal.versatile));
  if ((weapon?.attackType ?? 'melee') !== 'melee') return null;
  return meleeGeometry(bal.melee, weapon);
}

// ── общие подписи ──────────────────────────────────────────────────────────────────────────────────

const R = (v: number): string => String(Math.round(v));
/** Строки блока вёрстки веба: края подрезаны, пустые выпадают. */
const lines = (...ls: (string | undefined | null)[]): string => ls.map((l) => (l ?? '').trim()).filter((l) => l.length > 0).join('\n');

// ── HUD (render3d/hud3d.ts) ────────────────────────────────────────────────────────────────────────

/** = C# `DmSheet.HudModel`: доли заливки 0..1 (ширина полосы веба — `${доля * 100}%`), числа на полосах, инфо-строка. */
export interface HudModel {
  hp: number; mana: number; stam: number; xp: number; manaReserve: number; stamReserve: number;
  hpText: string; manaText: string; stamText: string; info: string;
}
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** Инфо-строка HUD: «Ур. N · город / этаж N · сложность · монстры ур.X · метка · Золото · Очки». */
export function hudInfo(cfg: ConfigRegistry, save: SaveState, floor: HeroFloor): string {
  let loc = 'город';
  if (floor.area === 'dungeon') {
    const diffs = cfg.get('difficulties');
    const diff = diffs.find((x) => x.id === floor.difficultyId) ?? diffs.find((x) => x.id === 'normal') ?? diffs[0]!;
    const cl = floor.challengeLevel ?? floorMonsterLevel(diff, floor.depth);
    const access = cfg.get('balance').dungeonAccess;
    loc = `этаж ${floor.depth} · ${diff.name} · монстры ур.${cl} · ${waypointHint(floor.depth, access.portalsAt, access.contentCycle)}`;
  }
  return `Ур. ${save.level}  ·  ${loc}  ·  Золото ${save.gold}  ·  Очки: атр ${save.unspentAttributePoints} / скилл ${save.unspentSkillPoints}`;
}

/** ⭐ Замена `DmSheet.Hud`: полосы от полного максимума, зоны резерва аур/стоек, «(−N)» у маны, опыт, инфо-строка. */
export function hudView(cfg: ConfigRegistry, save: SaveState, toggles: readonly string[], live: HeroVitals, floor: HeroFloor, opts: HeroOpts = {}): HudModel {
  const h = heroCalc(cfg, save, toggles, opts);
  const d = h.derived;
  const reserved = Math.round(d.maxMana * h.reserveMana);
  return {
    hp: clamp01(live.hp / Math.max(1, d.maxHp)),
    mana: clamp01(live.mana / Math.max(1, d.maxMana)),
    stam: clamp01(live.stamina / Math.max(1, d.maxStamina)),
    xp: clamp01(xpProgress(save.level, save.xp, cfg.get('balance').xpTable).frac / Math.max(1, 1)),
    manaReserve: clamp01(h.reserveMana),
    stamReserve: clamp01(h.reserveStamina),
    hpText: `${R(live.hp)} / ${R(d.maxHp)}`,
    manaText: reserved > 0 ? `${R(live.mana)} / ${R(d.maxMana)} (−${reserved})` : `${R(live.mana)} / ${R(d.maxMana)}`,
    stamText: `${R(live.stamina)} / ${R(d.maxStamina)}`,
    info: hudInfo(cfg, save, floor),
  };
}

// ── мастер → «Атрибуты» (derivedBlock) ─────────────────────────────────────────────────────────────

/** ⭐ Замена `DmSheet.MasterBlock`: уровень и опыт, урон, броня, крит, HP, мана — строки через `\n`. */
export function masterBlock(cfg: ConfigRegistry, save: SaveState, toggles: readonly string[], opts: HeroOpts = {}): string {
  const d = heroCalc(cfg, save, toggles, opts).derived;
  return `Уровень: ${save.level} · Опыт: ${save.xp}\nУрон: ${R(d.minDamage)}–${R(d.maxDamage)} · Броня: ${R(d.armor)} · Крит: ${R(d.critChance * 100)}%\nHP: ${R(d.maxHp)} · Мана: ${R(d.maxMana)}`;
}

// ── лист персонажа (progression/panels.ts characterPanel) ──────────────────────────────────────────

/** = C# `DmSheet.Row`: ячейки слева направо, подсказка (нет — нет поля). */
export interface SheetRow { cells: string[]; tip?: string }
/** = C# `DmSheet.Block`: заголовок (нет — блок без рамки) и строки. */
export interface SheetBlock { title?: string; rows: SheetRow[] }

function row(cells: (string | undefined | null)[], tip?: string): SheetRow {
  const r: SheetRow = { cells: cells.filter((c): c is string => typeof c === 'string' && c.length > 0) };
  if (tip !== undefined) r.tip = tip;
  return r;
}

/** Номер пула листа: 0 — здоровье, 1 — мана, 2 — выносливость. */
export type PoolIndex = 0 | 1 | 2;
const POOL_MAX = ['maxHp', 'maxMana', 'maxStamina'] as const;

/** = C# `DmSheet.PoolText`: «cur / max», у полосы маны/выносливости с резервом — «· резерв N». */
export function poolText(h: HeroNumbers, pool: PoolIndex, cur: number, bar: boolean): string {
  const max = h.derived[POOL_MAX[pool]];
  const s = `${R(cur)} / ${R(max)}`;
  if (!bar || pool === 0) return s;
  const res = Math.round(max * (pool === 1 ? h.reserveMana : h.reserveStamina));
  return res > 0 ? `${s} · резерв ${res}` : s;
}

const RES: [keyof DerivedStats, DamageType][] = [['resFire', 'fire'], ['resCold', 'cold'], ['resLightning', 'lightning'], ['resPoison', 'poison']];
const AILMENT_KINDS: DebuffKind[] = ['wound', 'bleed', 'sunder', 'daze', 'burn', 'poison', 'shock', 'freeze'];
/** Статы со своей строкой в других секциях листа — в «бездомных» бонусах их нет (веб BONUS_EXCLUDE). */
const BONUS_EXCLUDE = new Set<string>([
  'minDamage', 'maxDamage', 'damagePct', 'physPct', 'firePct', 'coldPct', 'lightningPct', 'poisonPct', 'addFire', 'addCold', 'addLightning', 'addPoison',
  'attackSpeed', 'critChance', 'critMultiplier', 'accuracy', 'castSpeed', 'armorPen',
  'armor', 'evade', 'blockChance', 'maxHp', 'maxMana', 'maxStamina', 'hpRegen', 'manaRegen', 'staminaRegen', 'interruptResist',
  'resFire', 'resCold', 'resLightning', 'resPoison', 'strength', 'dexterity', 'intelligence', 'vitality', 'moveSpeed', 'ailmentPct', 'ailmentDurPct',
  ...AILMENT_KINDS.flatMap((k) => [`${k}ChancePct`, `${k}PowerPct`, `${k}DurPct`]),
]);
const ATTR_TIPS: Record<Attribute, string> = {
  strength: 'Урон ближним оружием и требования по силе для экипировки.',
  dexterity: 'Урон дальним оружием, меткость и уклонение.',
  intelligence: 'Урон магией, максимум маны и реген маны.',
  vitality: 'Максимум здоровья и реген HP.',
};
const HOTKEYS = ['Shift', 'Q', 'Alt'];

/** Входы листа сверх героя: последний монстр (шансы попасть/увернуться) и набранное в буфер (превью «+Δ»). */
export interface SheetOpts extends HeroOpts { lastTarget?: LastTarget | null; pending?: PendingAttrs }

/**
 * ⭐ Замена `DmSheet.Sheet`: шапка, полосы (HP / мана / выносливость с резервом / опыт), активные ауры, мощь с разбором, атрибуты (итог,
 * «своя + гир» в подсказке, набранное «+N»), наступление (урон ЛКМ / ПКМ / хотбара с ДПС, разбивкой и статусами), защита, сопротивления и
 * выдержка брони, «Статусы», «Прочее».
 */
export function sheetView(cfg: ConfigRegistry, save: SaveState, toggles: readonly string[], live: HeroVitals, opts: SheetOpts = {}): SheetBlock[] {
  const h = heroCalc(cfg, save, toggles, opts);
  const d = h.derived;
  const dd = d as unknown as Record<string, number>;
  const blocks: SheetBlock[] = [];
  const cls = cfg.get('classes').find((c) => c.id === save.classId);
  const bal = cfg.get('balance');

  const lt = opts.lastTarget ?? null;
  const clampChance = (v: number): number => Math.max(0.05, Math.min(0.95, v));
  const hitPct = lt ? Math.round(clampChance(d.accuracy / (d.accuracy + lt.evade)) * 100) : null;
  const dodgePct = lt ? Math.round((1 - clampChance(lt.accuracy / (lt.accuracy + d.evade))) * 100) : null;

  // превью: набранное в буфер — те же моды, другие базовые атрибуты (ровно `playerSnapshot` сейва с этими атрибутами)
  const pending = (a: Attribute): number => opts.pending?.[a] ?? 0;
  const staged = ATTRIBUTES.reduce((s, a) => s + pending(a), 0);
  const remaining = save.unspentAttributePoints - staged;
  const previewBase = { ...save.attributes } as Attributes;
  for (const a of ATTRIBUTES) previewBase[a] += pending(a);
  const pd = staged > 0 ? deriveStats(previewBase, h.mods, h.scaling, save.level, bal.moveSpeedBase) : d;

  const delta = (cur: number, prev: number, digits = 0, pct = false, suffix = ''): string | undefined => {
    const diff = prev - cur;
    const eps = pct ? 0.005 : digits > 0 ? 0.05 : 0.5;
    if (!(diff > eps)) return undefined;
    const shown = pct ? `${Math.round(diff * 100)}%` : digits > 0 ? diff.toFixed(digits) : String(Math.round(diff));
    return `+${shown}${suffix}`;
  };
  const statRow = (label: string, value: string, tip?: string, dlt?: string): SheetRow => row([label, value, dlt], tip);
  const barWidth = (cur: number, max: number): string => `${Math.max(0, Math.min(100, (max > 0 ? cur / max : 0) * 100))}%`;
  const barLine = (label: string, cur: number, max: number, showFrac: boolean, dlt?: string, right?: string): SheetRow =>
    row([label, right ?? (showFrac ? `${R(cur)} / ${R(max)}` : `${R(cur)}%`), dlt, `▮${barWidth(cur, max)}`]);
  const resRow = (label: string, frac: number, tip: string): SheetRow =>
    row([label, `▮${Math.max(0, Math.min(100, frac * 100))}%`, `${Math.round(frac * 100)}%`], tip);

  // шапка
  blocks.push({ rows: [row([lines(save.name, `${cls?.name ?? save.classId} · Уровень ${save.level}`)])] });

  // полосы
  const xpb = xpProgress(save.level, save.xp, bal.xpTable);
  blocks.push({
    rows: [
      barLine('Здоровье', live.hp, d.maxHp, true, delta(d.maxHp, pd.maxHp), poolText(h, 0, live.hp, true)),
      barLine('Мана', live.mana, d.maxMana, true, delta(d.maxMana, pd.maxMana), poolText(h, 1, live.mana, true)),
      barLine('Выносливость', live.stamina, d.maxStamina, true, delta(d.maxStamina, pd.maxStamina), poolText(h, 2, live.stamina, true)),
      barLine('Опыт', xpb.frac * 100, 100, false, undefined, xpb.max ? 'макс. уровень' : `${xpb.into} / ${xpb.need} · ${Math.round(xpb.frac * 100)}%`),
    ],
  });

  // ауры и стойки
  const auras = activeToggleInfos(cfg, toggles);
  if (auras.length) {
    blocks.push({
      title: 'Активные ауры/стойки',
      rows: auras.map((a) => row([lines(`${a.name}${a.reservePct > 0 ? ` · резерв ${Math.round(a.reservePct * 100)}% маны` : ''}`, a.description)])),
    });
  }

  // мощь — как меряет сервер (надетое + сумка и пояс, ступени вещей)
  const pw = effectiveLevel(save, bal.power, carriedGear(save), cfg.get('item-tiers'));
  blocks.push({
    rows: [row(['Мощь (эфф. уровень)', String(pw.total)],
      'Эффективный уровень персонажа = уровень + гир + мастерства.\n' +
      `Уровень ${pw.level} + гир +${pw.gearBonus} + мастерства +${pw.passiveBonus} = ${pw.total}.\n` +
      'Гир — лучшее в каждый слот из надетого и того, что можешь надеть из сумки.\n' +
      'Задаёт стартовую сложность подземелья при выборе тира.')],
  });

  const mitig = Math.round((d.armor / (d.armor + 30 + 5 * save.level)) * 100);

  // атрибуты
  blocks.push({
    title: `Атрибуты · очков: ${remaining}`,
    rows: ATTRIBUTES.map((key) => {
      const own = h.permanent[key], eff = h.effective[key], gearB = eff - own;
      const split = gearB !== 0 ? `Своя (с мастерствами): ${own} · от гира: ${gearB > 0 ? '+' : ''}${gearB} = ${eff}` : `Своя (с мастерствами): ${own}`;
      return row([STAT_LABEL[key] ?? key, String(eff), pending(key) > 0 ? `+${pending(key)}` : undefined], `${split}\n${ATTR_TIPS[key]}`);
    }),
  });

  // наступление — оружием «как его держат» (им бьёт сервер)
  const off: SheetBlock = { title: 'Наступление', rows: [] };
  const scaling = bal.weaponAttrScaling;
  const weights = cfg.get('weapon-weights');
  const weapon = h.held;
  const byType = attackByType(d, h.effective, weapon, scaling, weights);
  const prevByType = staged > 0 ? attackByType(d, finalAttributes(previewBase, h.mods), weapon, scaling, weights) : byType;
  let dmgMin = 0, dmgMax = 0, pMin = 0, pMax = 0;
  for (const t of DAMAGE_TYPES) { dmgMin += byType[t].min; dmgMax += byType[t].max; pMin += prevByType[t].min; pMax += prevByType[t].max; }
  const atkDps = Math.round(((dmgMin + dmgMax) / 2) * d.attackSpeed);
  const dMinInc = Math.round(pMin) - Math.round(dmgMin), dMaxInc = Math.round(pMax) - Math.round(dmgMax);
  const typeLines = (bt: ByType): string =>
    DAMAGE_TYPES.filter((t) => bt[t].max > 0).map((t) => `■ ${dmgName(cfg, t)}: ${R(bt[t].min)}–${R(bt[t].max)}`).join('\n') || '—';
  const weaponTip = (): string => {
    const attrName = weapon?.damageKind === 'magical' ? 'Интеллекта' : (weapon?.attackType ?? 'melee') === 'ranged' ? 'Ловкости' : 'Силы';
    const pctRows: string[] = [];
    if (d.damagePct) pctRows.push(`весь урон +${R(d.damagePct * 100)}%`);
    for (const [pk, t] of [['physPct', 'physical'], ['firePct', 'fire'], ['coldPct', 'cold'], ['lightningPct', 'lightning'], ['poisonPct', 'poison']] as const) {
      if (d[pk]) pctRows.push(`${dmgName(cfg, t)} +${R(d[pk] * 100)}%`);
    }
    const addRows: string[] = [];
    for (const [ak, t] of [['addFire', 'fire'], ['addCold', 'cold'], ['addLightning', 'lightning'], ['addPoison', 'poison']] as const) {
      if (d[ak]) addRows.push(`■ +${R(d[ak])} ${dmgName(cfg, t)}`);
    }
    const bonus = pctRows.length || addRows.length ? `\nБонусы урона:\n${[...addRows, ...pctRows].join('\n')}` : '';
    return `Урон базовой атаки по типам:\n${typeLines(byType)}\nТип базы — по оружию. Растёт от базы оружия и ${attrName}; стихийные добавки — с аффиксов гира/скиллов.${bonus}`;
  };

  const tree = cfg.get('skill-tree');
  const nodeOf = (id: string): SkillNode | undefined => tree.nodes.find((n) => n.id === id);
  const resolvedOf = (id: string): ReturnType<typeof resolveActive> => resolveActive(cfg, save, id);
  /** Урон скила по типам — `shapeSkillPacket` (шов движка) по низу и по верху вилки базовой атаки. */
  const skillByType = (active: { damageMult: number; convertPct?: number; multScope?: 'base' | 'all'; addElementPct?: number }, rank: number, el: DamageType): ByType => {
    const shape: SkillDamageShape = {
      mult: active.damageMult * abilityRankMult(rank),
      multScope: active.multScope ?? 'base',
      addElementPct: active.addElementPct ?? 0,
      convertPct: active.convertPct ?? 0,
      baseType: (save.equipment.weapon?.damageType ?? 'physical') as DamageType,
      element: el,
    };
    const lo = emptyPacket(), hi = emptyPacket();
    for (const t of DAMAGE_TYPES) { lo[t] = byType[t].min; hi[t] = byType[t].max; }
    shapeSkillPacket(lo, shape);
    shapeSkillPacket(hi, shape);
    const bt = {} as ByType;
    for (const t of DAMAGE_TYPES) bt[t] = { min: lo[t], max: hi[t] };
    return bt;
  };
  /** Статусы удара по ИТОГОВОМУ составу: грань оружия при физ. уроне → явный статус скила → авто-стихии (без дублей). */
  const attackAilments = (binding: string | null): DebuffApply[] => {
    const node = binding && binding !== 'attack' ? nodeOf(binding) : undefined;
    const act = ((binding && binding !== 'attack' ? resolvedOf(binding)?.active : undefined) ?? node?.effect.active) as
      (ActiveAbility & { element?: string; ailment?: { kind?: DebuffKind; chance: number; maxStacks: number; durationMs: number; mag: number; mag2?: number } }) | undefined;
    const actEl = act && (act.category === 'attack' || act.category === 'cast' || act.category === 'curse') ? act.element : undefined;
    const el = (node ? ((actEl ?? elementOf(node)) ?? 'physical') : 'physical') as DamageType;
    const pkt = emptyPacket();
    if (act && (act.category === 'attack' || act.category === 'cast')) {
      const sbt = skillByType(act as unknown as { damageMult: number }, save.skills[binding!] ?? 1, el);
      for (const t of DAMAGE_TYPES) pkt[t] = sbt[t].max;
    } else {
      for (const t of DAMAGE_TYPES) pkt[t] = byType[t]?.max ?? 0;
    }
    const w = save.equipment.weapon;
    const out: DebuffApply[] = w && pkt.physical > 0 ? [...weaponDebuffs(w, cfg.get('phys-subtypes'), cfg.get('debuffs'))] : [];
    if (act && act.ailment) {
      const kind = (act.ailment.kind ?? cfg.get('magic-subtypes').find((x) => x.id === el)?.ailment) as DebuffKind | undefined;
      if (kind) {
        const al = act.ailment;
        out.push({ kind, chance: al.chance, maxStacks: al.maxStacks, durationMs: al.durationMs, mag2: al.mag2, ...(isDotKind(kind) ? { mag: 0, magPerDamage: al.mag } : { mag: al.mag }) });
      }
    }
    const have = new Set<DebuffKind>(out.map((x) => x.kind));
    out.push(...elementDebuffs(pkt, cfg.get('magic-subtypes'), cfg.get('debuffs')).filter((x) => !have.has(x.kind)));
    return out;
  };
  const strengthStr = (b: DebuffApply, pMul: number): string => {
    const pdv = (b.magPerDamage ?? 0) * pMul * 100, m = b.mag * pMul * 100, m2 = (b.mag2 ?? 0) * pMul * 100;
    switch (b.kind) {
      case 'bleed': case 'burn': case 'poison': return `${pdv.toFixed(1)}% урона/сек`;
      case 'wound': return `−${m.toFixed(0)}% урона · −${m2.toFixed(0)}% скор.`;
      case 'sunder': return `+${m.toFixed(0)}% получ. урона`;
      case 'daze': return `−${m.toFixed(0)}% брони · ${m2.toFixed(0)}% стан`;
      case 'shock': return `+${m.toFixed(0)}% получ. урона`;
      case 'freeze': return `−${m.toFixed(0)}% скор. · ${m2.toFixed(0)}% сковать`;
      default: return '';
    }
  };
  const kNum = (k: DebuffKind, suf: string): number => dd[`${k}${suf}`] || 0;
  const debuffsCfg = cfg.get('debuffs');
  const ailmentTip = (binding: string | null): string => {
    const ls = attackAilments(binding).map((b) => {
      const cMul = 1 + d.ailmentPct + kNum(b.kind, 'ChancePct');
      const chance = statusChance(b.chance, cMul);
      const capTag = b.chance * cMul > STATUS_CHANCE_CAP ? ' (потолок)' : '';
      const durS = (b.durationMs * (1 + d.ailmentDurPct + kNum(b.kind, 'DurPct'))) / 1000;
      const pMul = 1 + d.ailmentPct + kNum(b.kind, 'PowerPct');
      return `${debuffIcon(debuffsCfg, b.kind)} ${debuffLabel(debuffsCfg, b.kind)} — шанс ${Math.round(chance * 100)}%${capTag} · ${durS.toFixed(1)}с · ${strengthStr(b, pMul)}${b.maxStacks > 1 ? ` (до ${b.maxStacks} стак.)` : ''}`;
    });
    const wsc = save.equipment.weapon?.stunChance;
    if (wsc) ls.push(`💥 Стан — ${Math.round(wsc * 100)}%`);
    return ls.length ? `\nНакладывает:\n${ls.join('\n')}\n(до сопротивления цели)` : '';
  };
  const dmgRow = (label: string, binding: string | null | undefined): SheetRow => {
    if (binding === 'attack') {
      const dlt = dMaxInc > 0 || dMinInc > 0 ? (dMinInc === dMaxInc ? `+${dMaxInc}` : `+${dMinInc}–${dMaxInc}`) : undefined;
      return row([label, `${R(dmgMin)}–${R(dmgMax)} (ДПС ~${atkDps})`, dlt], weaponTip() + ailmentTip('attack'));
    }
    if (!binding) return row([label, 'не назначено']);
    const node = nodeOf(binding);
    const resd = resolvedOf(binding);
    const active = (resd?.active ?? node?.effect.active) as
      (ActiveAbility & { element?: string; damageMult: number; speed: number; castTimeSec: number }) | undefined;
    if (node && active && (active.category === 'attack' || active.category === 'cast')) {
      const el = ((active.element ?? elementOf(node)) ?? 'physical') as DamageType;
      const sbt = skillByType(active, save.skills[binding] ?? 1, el);
      let sMin = 0, sMax = 0;
      for (const t of DAMAGE_TYPES) { sMin += sbt[t].min; sMax += sbt[t].max; }
      const sdmg = Math.round((sMin + sMax) / 2);
      let sdps: number, rateTip: string;
      if (active.category === 'attack') {
        const r = Math.max(0.2, d.attackSpeed * active.speed);
        sdps = Math.round(sdmg * r); rateTip = `темп ${(1 / r).toFixed(2)} с/удар`;
      } else {
        const ct = active.castTimeSec / Math.max(0.2, d.castSpeed);
        sdps = ct > 0 ? Math.round(sdmg / ct) : sdmg; rateTip = `каст ${ct.toFixed(2)} с`;
      }
      const costTip = `${active.manaCost} ${active.resource === 'stamina' ? 'выносл.' : 'маны'}`
        + (resd?.extraCost ? ` + ${resd.extraCost.amount} ${resd.extraCost.pool === 'mana' ? 'маны' : 'выносл.'}` : '');
      return row([label, `${sdmg} (ДПС ~${sdps})`],
        `${node.name}: урон ${sdmg}, ${rateTip}, ДПС ~${sdps}. Цена ${costTip}.\nУрон по типам:\n${typeLines(sbt)}` + ailmentTip(binding));
    }
    if (node && active) {
      const kind = active.category === 'curse' ? 'проклятие' : active.category === 'aura' ? 'аура' : active.category === 'stance' ? 'стойка' : 'бафф';
      return row([label, '—'], `${node.name}: ${kind} — без прямого урона.`);
    }
    return row([label, '—']);
  };
  off.rows.push(dmgRow('Урон (ЛКМ)', save.mouseLeft));
  off.rows.push(dmgRow('Урон (ПКМ)', save.mouseRight));
  save.hotbar.forEach((b, i) => { if (b) off.rows.push(dmgRow(`Урон (${HOTKEYS[i]})`, b)); });
  off.rows.push(statRow('Скор. атаки', `${d.attackSpeed.toFixed(2)} /с`, 'Число базовых атак в секунду.'));
  off.rows.push(statRow('Шанс крита', `${R(d.critChance * 100)}%`, `Вероятность нанести усиленный удар (×${d.critMultiplier.toFixed(2)}).`));
  off.rows.push(statRow('Множ. крита', `×${d.critMultiplier.toFixed(2)}`, 'Во сколько раз крит-удар сильнее обычного.'));
  off.rows.push(statRow('Меткость', `${R(d.accuracy)}${hitPct != null ? ` · ${hitPct}%` : ''}`,
    'Рейтинг атаки. Шанс попасть = меткость / (меткость + уклонение цели), 5–95%.' +
    (lt ? `\nПо «${lt.name}» (последний): ${hitPct}% попасть.` : '\nАтакуй монстра — покажу реальный шанс по нему.'),
    delta(d.accuracy, pd.accuracy)));
  off.rows.push(statRow('Скор. каста', `×${d.castSpeed.toFixed(2)}`, 'Множитель скорости каста: каст-тайм скиллов делится на неё. Растёт от Интеллекта.'));
  if (d.armorPen > 0) off.rows.push(statRow('Пробой брони', `${R(d.armorPen * 100)}%`, 'Игнорирует эту долю брони цели при ударе.'));
  blocks.push(off);

  // защита
  blocks.push({
    title: 'Защита',
    rows: [
      statRow('Броня', R(d.armor), `Снижает получаемый физический урон. Сейчас: −${mitig}% (armor/(armor+30+5×ур.атакующего)).`),
      statRow('Уклонение', `${R(d.evade)}${dodgePct != null ? ` · ${dodgePct}%` : ''}`,
        'Рейтинг защиты. Снижает шанс врага попасть по тебе (сравнивается с его меткостью).' +
        (lt ? `\nОт «${lt.name}» (последний): ${dodgePct}% увернуться.` : '\nАтакуй монстра — покажу реальный шанс уклонения от него.'),
        delta(d.evade, pd.evade)),
      statRow('Блок', `${R(d.blockChance * 100)}%`, 'Шанс полностью погасить удар (только от оружия/щита). Максимум 75%.'),
      statRow('Здоровье', poolText(h, 0, live.hp, false), 'Текущее / максимум HP. При 0 — смерть.', delta(d.maxHp, pd.maxHp)),
      statRow('Мана', poolText(h, 1, live.mana, false), 'Текущее / максимум маны для магических скиллов (и резерва аур).', delta(d.maxMana, pd.maxMana)),
      statRow('Выносливость', poolText(h, 2, live.stamina, false), 'Текущее / максимум выносливости для боевых скиллов (и резерва стоек).', delta(d.maxStamina, pd.maxStamina)),
      statRow('Реген HP', `${d.hpRegen.toFixed(1)} /с`, `Восстанавливает ${d.hpRegen.toFixed(1)} HP каждую секунду.`, delta(d.hpRegen, pd.hpRegen, 1, false, ' /с')),
      statRow('Реген маны', `${d.manaRegen.toFixed(1)} /с`, `Восстанавливает ${d.manaRegen.toFixed(1)} маны каждую секунду.`, delta(d.manaRegen, pd.manaRegen, 1, false, ' /с')),
      statRow('Реген вынос.', `${d.staminaRegen.toFixed(1)} /с`, `Восстанавливает ${d.staminaRegen.toFixed(1)} выносливости каждую секунду.`, delta(d.staminaRegen, pd.staminaRegen, 1, false, ' /с')),
      ...(d.interruptResist > 0 ? [statRow('Стойк. к прерыв.', `${R(d.interruptResist * 100)}%`, 'Шанс НЕ сбить замах тяжёлого удара при стане/ошеломлении цели.')] : []),
    ],
  });

  // сопротивления и выдержка брони
  const res: SheetBlock = { title: 'Сопротивления', rows: [] };
  for (const [key, el] of RES) {
    const name = dmgName(cfg, el);
    const v = d[key];
    res.rows.push(resRow(name, v, `Снижает урон стихии «${name}» на ${Math.round(v * 100)}%. Максимум — 75%.`));
  }
  res.rows.push(row(['Стойкость к физ. статусам']));
  const gear = Object.values(save.equipment).filter((it): it is Item => !!it);
  for (const k of ['wound', 'bleed', 'sunder', 'daze'] as DebuffKind[]) {
    const poise = armorPoise(gear, k, cfg.get('armor-classes'));
    const lab = debuffLabel(debuffsCfg, k);
    res.rows.push(resRow(`${debuffIcon(debuffsCfg, k)} ${lab}`, poise, `Выдержка от брони: снижает шанс И длительность статуса «${lab}» на ${Math.round(poise * 100)}%. Максимум — 60%.`));
  }
  blocks.push(res);

  // статусы: урон итоговым % по типам, «бездомные» бонусы, наложение статусов
  const ail: SheetBlock = { title: 'Статусы', rows: [] };
  const perPct: Record<DamageType, number> = { physical: d.physPct, fire: d.firePct, cold: d.coldPct, lightning: d.lightningPct, poison: d.poisonPct };
  const addFlat: Record<DamageType, number> = { physical: 0, fire: d.addFire, cold: d.addCold, lightning: d.addLightning, poison: d.addPoison };
  if (d.damagePct) ail.rows.push(statRow('Весь урон', `+${R(d.damagePct * 100)}%`, 'Множитель ко ВСЕМ типам урона (складывается с типовыми ниже).'));
  for (const t of DAMAGE_TYPES) {
    const combined = d.damagePct + perPct[t];
    const parts: string[] = [];
    if (combined) parts.push(`+${R(combined * 100)}%`);
    if (addFlat[t]) parts.push(`+${R(addFlat[t])} плоск.`);
    if (!parts.length) continue;
    const name = dmgName(cfg, t);
    ail.rows.push(statRow(name, parts.join(' · '),
      `Итоговый бонус к урону «${name}»: общий +${R(d.damagePct * 100)}% + типовой +${R(perPct[t] * 100)}%${addFlat[t] ? ` · плоско +${R(addFlat[t])}` : ''}.`));
  }
  const agg = new Map<string, { stat: string; kind: StatModifier['kind']; value: number }>();
  for (const md of h.mods) {
    if (BONUS_EXCLUDE.has(md.stat)) continue;
    const k = `${md.stat}|${md.kind}`;
    const e = agg.get(k);
    if (e) e.value += md.value; else agg.set(k, { stat: md.stat, kind: md.kind, value: md.value });
  }
  for (const e of [...agg.values()].sort((a, b) => a.stat.localeCompare(b.stat))) {
    const isPct = e.kind === 'increased' || PERCENT_STATS.has(e.stat);
    const num = isPct ? Math.round(e.value * 100) : Number.isInteger(e.value) ? e.value : Number(e.value.toFixed(2));
    if (num === 0) continue;
    ail.rows.push(statRow(STAT_LABEL[e.stat] ?? e.stat, `${num > 0 ? '+' : '−'}${Math.abs(num)}${isPct ? '%' : ''}`));
  }
  ail.rows.push(row(['Наложение статусов']));
  ail.rows.push(statRow('Все статусы', `шанс/сила +${R(d.ailmentPct * 100)}%  ·  длит. +${R(d.ailmentDurPct * 100)}%`,
    'Глобальные бонусы к наложению ВСЕХ статусов (шанс, сила, длительность). Складываются с бонусами по видам.'));
  for (const k of AILMENT_KINDS) {
    const c = dd[`${k}ChancePct`]!, p = dd[`${k}PowerPct`]!, du = dd[`${k}DurPct`]!;
    if (!c && !p && !du) continue;
    const parts: string[] = [];
    if (c) parts.push(`шанс +${R(c * 100)}%`);
    if (p) parts.push(`сила +${R(p * 100)}%`);
    if (du) parts.push(`длит. +${R(du * 100)}%`);
    const lab = debuffLabel(debuffsCfg, k);
    ail.rows.push(statRow(lab, parts.join('  ·  '), `Бонусы к наложению статуса «${lab}» (ветки скиллов/гир).`));
  }
  blocks.push(ail);

  // прочее
  blocks.push({
    title: 'Прочее',
    rows: [
      statRow('Скор. движения', R(d.moveSpeed), `Итоговая скорость перемещения (база 120). Бонусы: ${d.moveSpeed >= 120 ? '+' : ''}${R((d.moveSpeed / 120 - 1) * 100)}%.`),
      statRow('Золото', String(save.gold), 'Валюта: магазин, кузница, дерево мастерства.'),
      statRow('Макс. глубина', String(save.maxDepth), 'Самый глубокий достигнутый этаж.'),
    ],
  });
  return blocks;
}

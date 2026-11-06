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
import { cfgRowText, tr } from '../i18n/tr.js';

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
  let loc = tr('srv:hero.hudTown', 'город');
  if (floor.area === 'dungeon') {
    const diffs = cfg.get('difficulties');
    const diff = diffs.find((x) => x.id === floor.difficultyId) ?? diffs.find((x) => x.id === 'normal') ?? diffs[0]!;
    const cl = floor.challengeLevel ?? floorMonsterLevel(diff, floor.depth);
    const access = cfg.get('balance').dungeonAccess;
    loc = tr('srv:hero.hudFloor', 'этаж {depth} · {difficulty} · монстры ур.{cl} · {waypoint}', { depth: floor.depth, difficulty: cfgRowText(cfg, 'difficulties', diff), cl, waypoint: waypointHint(floor.depth, access.portalsAt, access.contentCycle) });
  }
  return tr('srv:hero.hudInfo', 'Ур. {level}  ·  {loc}  ·  Золото {gold}  ·  Очки: атр {attr} / скилл {skill}', { level: save.level, loc, gold: save.gold, attr: save.unspentAttributePoints, skill: save.unspentSkillPoints });
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
  return tr('srv:hero.masterBlock', 'Уровень: {level} · Опыт: {xp}\nУрон: {minDamage}–{maxDamage} · Броня: {armor} · Крит: {critChance}%\nHP: {maxHp} · Мана: {maxMana}', { level: save.level, xp: save.xp, minDamage: R(d.minDamage), maxDamage: R(d.maxDamage), armor: R(d.armor), critChance: R(d.critChance * 100), maxHp: R(d.maxHp), maxMana: R(d.maxMana) });
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
  return res > 0 ? tr('srv:hero.poolReserve', '{s} · резерв {res}', { s, res }) : s;
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
  get strength() { return tr('srv:attrTip.strength', 'Урон ближним оружием и требования по силе для экипировки.'); },
  get dexterity() { return tr('srv:attrTip.dexterity', 'Урон дальним оружием, меткость и уклонение.'); },
  get intelligence() { return tr('srv:attrTip.intelligence', 'Урон магией, максимум маны и реген маны.'); },
  get vitality() { return tr('srv:attrTip.vitality', 'Максимум здоровья и реген HP.'); },
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
  blocks.push({ rows: [row([lines(save.name, tr('srv:hero.headClass', '{cls} · Уровень {level}', { cls: cfgRowText(cfg, 'classes', cls) ?? save.classId, level: save.level }))])] });

  // полосы
  const xpb = xpProgress(save.level, save.xp, bal.xpTable);
  blocks.push({
    rows: [
      barLine(tr('srv:hero.barHp', 'Здоровье'), live.hp, d.maxHp, true, delta(d.maxHp, pd.maxHp), poolText(h, 0, live.hp, true)),
      barLine(tr('srv:hero.barMana', 'Мана'), live.mana, d.maxMana, true, delta(d.maxMana, pd.maxMana), poolText(h, 1, live.mana, true)),
      barLine(tr('srv:hero.barStamina', 'Выносливость'), live.stamina, d.maxStamina, true, delta(d.maxStamina, pd.maxStamina), poolText(h, 2, live.stamina, true)),
      barLine(tr('srv:hero.barXp', 'Опыт'), xpb.frac * 100, 100, false, undefined, xpb.max ? tr('srv:hero.maxLevel', 'макс. уровень') : `${xpb.into} / ${xpb.need} · ${Math.round(xpb.frac * 100)}%`),
    ],
  });

  // ауры и стойки
  const auras = activeToggleInfos(cfg, toggles);
  if (auras.length) {
    blocks.push({
      title: tr('srv:hero.togglesTitle', 'Активные ауры/стойки'),
      rows: auras.map((a) => row([lines(`${a.name}${a.reservePct > 0 ? tr('srv:hero.toggleReserve', ' · резерв {reservePct}% маны', { reservePct: Math.round(a.reservePct * 100) }) : ''}`, a.description)])),
    });
  }

  // мощь — как меряет сервер (надетое + сумка и пояс, ступени вещей)
  const pw = effectiveLevel(save, bal.power, carriedGear(save), cfg.get('item-tiers'));
  blocks.push({
    rows: [row([tr('srv:hero.power', 'Мощь (эфф. уровень)'), String(pw.total)],
      tr('srv:hero.powerTip', 'Эффективный уровень персонажа = уровень + гир + мастерства.\nУровень {level} + гир +{gearBonus} + мастерства +{passiveBonus} = {total}.\nГир — лучшее в каждый слот из надетого и того, что можешь надеть из сумки.\nЗадаёт стартовую сложность подземелья при выборе тира.', { level: pw.level, gearBonus: pw.gearBonus, passiveBonus: pw.passiveBonus, total: pw.total }))],
  });

  const mitig = Math.round((d.armor / (d.armor + 30 + 5 * save.level)) * 100);

  // атрибуты
  blocks.push({
    title: tr('srv:hero.attrsTitle', 'Атрибуты · очков: {remaining}', { remaining }),
    rows: ATTRIBUTES.map((key) => {
      const own = h.permanent[key], eff = h.effective[key], gearB = eff - own;
      const split = gearB !== 0 ? tr('srv:hero.attrSplitGear', 'Своя (с мастерствами): {own} · от гира: {sign}{gearB} = {eff}', { own, sign: gearB > 0 ? '+' : '', gearB, eff }) : tr('srv:hero.attrSplit', 'Своя (с мастерствами): {own}', { own });
      return row([STAT_LABEL[key] ?? key, String(eff), pending(key) > 0 ? `+${pending(key)}` : undefined], `${split}\n${ATTR_TIPS[key]}`);
    }),
  });

  // наступление — оружием «как его держат» (им бьёт сервер)
  const off: SheetBlock = { title: tr('srv:hero.offenseTitle', 'Наступление'), rows: [] };
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
    const attrName = weapon?.damageKind === 'magical' ? tr('srv:hero.attrInt', 'Интеллекта') : (weapon?.attackType ?? 'melee') === 'ranged' ? tr('srv:hero.attrDex', 'Ловкости') : tr('srv:hero.attrStr', 'Силы');
    const pctRows: string[] = [];
    if (d.damagePct) pctRows.push(tr('srv:hero.bonusAll', 'весь урон +{damagePct}%', { damagePct: R(d.damagePct * 100) }));
    for (const [pk, t] of [['physPct', 'physical'], ['firePct', 'fire'], ['coldPct', 'cold'], ['lightningPct', 'lightning'], ['poisonPct', 'poison']] as const) {
      if (d[pk]) pctRows.push(`${dmgName(cfg, t)} +${R(d[pk] * 100)}%`);
    }
    const addRows: string[] = [];
    for (const [ak, t] of [['addFire', 'fire'], ['addCold', 'cold'], ['addLightning', 'lightning'], ['addPoison', 'poison']] as const) {
      if (d[ak]) addRows.push(`■ +${R(d[ak])} ${dmgName(cfg, t)}`);
    }
    const bonus = pctRows.length || addRows.length ? tr('srv:hero.bonusBlock', '\nБонусы урона:\n{v}', { v: [...addRows, ...pctRows].join('\n') }) : '';
    return tr('srv:hero.weaponTip', 'Урон базовой атаки по типам:\n{byType}\nТип базы — по оружию. Растёт от базы оружия и {attrName}; стихийные добавки — с аффиксов гира/скиллов.{bonus}', { byType: typeLines(byType), attrName, bonus });
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
      case 'bleed': case 'burn': case 'poison': return tr('srv:hero.dotPerSec', '{pdv}% урона/сек', { pdv: pdv.toFixed(1) });
      case 'wound': return tr('srv:hero.woundStr', '−{m}% урона · −{m2}% скор.', { m: m.toFixed(0), m2: m2.toFixed(0) });
      case 'sunder': return tr('srv:hero.takenMore', '+{m}% получ. урона', { m: m.toFixed(0) });
      case 'daze': return tr('srv:hero.dazeStr', '−{m}% брони · {m2}% стан', { m: m.toFixed(0), m2: m2.toFixed(0) });
      case 'shock': return tr('srv:hero.takenMore', '+{m}% получ. урона', { m: m.toFixed(0) });
      case 'freeze': return tr('srv:hero.freezeStr', '−{m}% скор. · {m2}% сковать', { m: m.toFixed(0), m2: m2.toFixed(0) });
      default: return '';
    }
  };
  const kNum = (k: DebuffKind, suf: string): number => dd[`${k}${suf}`] || 0;
  const debuffsCfg = cfg.get('debuffs');
  const ailmentTip = (binding: string | null): string => {
    const ls = attackAilments(binding).map((b) => {
      const cMul = 1 + d.ailmentPct + kNum(b.kind, 'ChancePct');
      const chance = statusChance(b.chance, cMul);
      const capTag = b.chance * cMul > STATUS_CHANCE_CAP ? tr('srv:hero.capTag', ' (потолок)') : '';
      const durS = (b.durationMs * (1 + d.ailmentDurPct + kNum(b.kind, 'DurPct'))) / 1000;
      const pMul = 1 + d.ailmentPct + kNum(b.kind, 'PowerPct');
      return tr('srv:hero.ailmentLine', '{icon} {label} — шанс {chance}%{capTag} · {dur}с · {power}{stacks}', { icon: debuffIcon(debuffsCfg, b.kind), label: debuffLabel(debuffsCfg, b.kind), chance: Math.round(chance * 100), capTag, dur: durS.toFixed(1), power: strengthStr(b, pMul), stacks: b.maxStacks > 1 ? tr('srv:hero.stacksUpTo', ' (до {maxStacks} стак.)', { maxStacks: b.maxStacks }) : '' });
    });
    const wsc = save.equipment.weapon?.stunChance;
    if (wsc) ls.push(tr('srv:hero.stunLine', '💥 Стан — {wsc}%', { wsc: Math.round(wsc * 100) }));
    return ls.length ? tr('srv:hero.appliesBlock', '\nНакладывает:\n{ls}\n(до сопротивления цели)', { ls: ls.join('\n') }) : '';
  };
  const dmgRow = (label: string, binding: string | null | undefined): SheetRow => {
    if (binding === 'attack') {
      const dlt = dMaxInc > 0 || dMinInc > 0 ? (dMinInc === dMaxInc ? `+${dMaxInc}` : `+${dMinInc}–${dMaxInc}`) : undefined;
      return row([label, tr('srv:hero.attackValue', '{dmgMin}–{dmgMax} (ДПС ~{atkDps})', { dmgMin: R(dmgMin), dmgMax: R(dmgMax), atkDps }), dlt], weaponTip() + ailmentTip('attack'));
    }
    if (!binding) return row([label, tr('srv:hero.unbound', 'не назначено')]);
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
        sdps = Math.round(sdmg * r); rateTip = tr('srv:hero.tempo', 'темп {v} с/удар', { v: (1 / r).toFixed(2) });
      } else {
        const ct = active.castTimeSec / Math.max(0.2, d.castSpeed);
        sdps = ct > 0 ? Math.round(sdmg / ct) : sdmg; rateTip = tr('srv:hero.castTime', 'каст {ct} с', { ct: ct.toFixed(2) });
      }
      const costTip = `${active.manaCost} ${active.resource === 'stamina' ? tr('srv:hero.stamShort', 'выносл.') : tr('srv:hero.mana', 'маны')}`
        + (resd?.extraCost ? ` + ${resd.extraCost.amount} ${resd.extraCost.pool === 'mana' ? tr('srv:hero.mana', 'маны') : tr('srv:hero.stamShort', 'выносл.')}` : '');
      return row([label, tr('srv:hero.skillValue', '{sdmg} (ДПС ~{sdps})', { sdmg, sdps })],
        tr('srv:hero.skillTip', '{name}: урон {sdmg}, {rateTip}, ДПС ~{sdps}. Цена {costTip}.\nУрон по типам:\n{sbt}', { name: cfgRowText(cfg, 'skill-tree', node), sdmg, rateTip, sdps, costTip, sbt: typeLines(sbt) }) + ailmentTip(binding));
    }
    if (node && active) {
      const kind = active.category === 'curse' ? tr('srv:hero.kindCurse', 'проклятие') : active.category === 'aura' ? tr('srv:hero.kindAura', 'аура') : active.category === 'stance' ? tr('srv:hero.kindStance', 'стойка') : tr('srv:hero.kindBuff', 'бафф');
      return row([label, '—'], tr('srv:hero.noDirectDamage', '{name}: {kind} — без прямого урона.', { name: cfgRowText(cfg, 'skill-tree', node), kind }));
    }
    return row([label, '—']);
  };
  off.rows.push(dmgRow(tr('srv:hero.dmgLmb', 'Урон (ЛКМ)'), save.mouseLeft));
  off.rows.push(dmgRow(tr('srv:hero.dmgRmb', 'Урон (ПКМ)'), save.mouseRight));
  save.hotbar.forEach((b, i) => { if (b) off.rows.push(dmgRow(tr('srv:hero.dmgHotkey', 'Урон ({key})', { key: HOTKEYS[i] }), b)); });
  off.rows.push(statRow(tr('srv:hero.atkSpeed', 'Скор. атаки'), tr('srv:hero.perSecond', '{v} /с', { v: d.attackSpeed.toFixed(2) }), tr('srv:hero.atkSpeedTip', 'Число базовых атак в секунду.')));
  off.rows.push(statRow(tr('srv:hero.crit', 'Шанс крита'), `${R(d.critChance * 100)}%`, tr('srv:hero.critTip', 'Вероятность нанести усиленный удар (×{critMultiplier}).', { critMultiplier: d.critMultiplier.toFixed(2) })));
  off.rows.push(statRow(tr('srv:hero.critMult', 'Множ. крита'), `×${d.critMultiplier.toFixed(2)}`, tr('srv:hero.critMultTip', 'Во сколько раз крит-удар сильнее обычного.')));
  off.rows.push(statRow(tr('srv:hero.accuracy', 'Меткость'), `${R(d.accuracy)}${hitPct != null ? ` · ${hitPct}%` : ''}`,
    tr('srv:hero.accuracyTip', 'Рейтинг атаки. Шанс попасть = меткость / (меткость + уклонение цели), 5–95%.') +
    (lt ? tr('srv:hero.accuracyVs', '\nПо «{name}» (последний): {hitPct}% попасть.', { name: lt.name, hitPct }) : tr('srv:hero.accuracyHint', '\nАтакуй монстра — покажу реальный шанс по нему.')),
    delta(d.accuracy, pd.accuracy)));
  off.rows.push(statRow(tr('srv:hero.castSpeed', 'Скор. каста'), `×${d.castSpeed.toFixed(2)}`, tr('srv:hero.castSpeedTip', 'Множитель скорости каста: каст-тайм скиллов делится на неё. Растёт от Интеллекта.')));
  if (d.armorPen > 0) off.rows.push(statRow(tr('srv:hero.armorPen', 'Пробой брони'), `${R(d.armorPen * 100)}%`, tr('srv:hero.armorPenTip', 'Игнорирует эту долю брони цели при ударе.')));
  blocks.push(off);

  // защита
  blocks.push({
    title: tr('srv:hero.defenseTitle', 'Защита'),
    rows: [
      statRow(tr('srv:hero.armor', 'Броня'), R(d.armor), tr('srv:hero.armorTip', 'Снижает получаемый физический урон. Сейчас: −{mitig}% (armor/(armor+30+5×ур.атакующего)).', { mitig })),
      statRow(tr('srv:hero.evade', 'Уклонение'), `${R(d.evade)}${dodgePct != null ? ` · ${dodgePct}%` : ''}`,
        tr('srv:hero.evadeTip', 'Рейтинг защиты. Снижает шанс врага попасть по тебе (сравнивается с его меткостью).') +
        (lt ? tr('srv:hero.evadeVs', '\nОт «{name}» (последний): {dodgePct}% увернуться.', { name: lt.name, dodgePct }) : tr('srv:hero.evadeHint', '\nАтакуй монстра — покажу реальный шанс уклонения от него.')),
        delta(d.evade, pd.evade)),
      statRow(tr('srv:hero.block', 'Блок'), `${R(d.blockChance * 100)}%`, tr('srv:hero.blockTip', 'Шанс полностью погасить удар (только от оружия/щита). Максимум 75%.')),
      statRow(tr('srv:hero.barHp', 'Здоровье'), poolText(h, 0, live.hp, false), tr('srv:hero.hpTip', 'Текущее / максимум HP. При 0 — смерть.'), delta(d.maxHp, pd.maxHp)),
      statRow(tr('srv:hero.barMana', 'Мана'), poolText(h, 1, live.mana, false), tr('srv:hero.manaTip', 'Текущее / максимум маны для магических скиллов (и резерва аур).'), delta(d.maxMana, pd.maxMana)),
      statRow(tr('srv:hero.barStamina', 'Выносливость'), poolText(h, 2, live.stamina, false), tr('srv:hero.staminaTip', 'Текущее / максимум выносливости для боевых скиллов (и резерва стоек).'), delta(d.maxStamina, pd.maxStamina)),
      statRow(tr('srv:hero.hpRegen', 'Реген HP'), tr('srv:hero.perSecond', '{v} /с', { v: d.hpRegen.toFixed(1) }), tr('srv:hero.hpRegenTip', 'Восстанавливает {hpRegen} HP каждую секунду.', { hpRegen: d.hpRegen.toFixed(1) }), delta(d.hpRegen, pd.hpRegen, 1, false, tr('srv:hero.perSecondSuffix', ' /с'))),
      statRow(tr('srv:hero.manaRegen', 'Реген маны'), tr('srv:hero.perSecond', '{v} /с', { v: d.manaRegen.toFixed(1) }), tr('srv:hero.manaRegenTip', 'Восстанавливает {manaRegen} маны каждую секунду.', { manaRegen: d.manaRegen.toFixed(1) }), delta(d.manaRegen, pd.manaRegen, 1, false, tr('srv:hero.perSecondSuffix', ' /с'))),
      statRow(tr('srv:hero.staminaRegen', 'Реген вынос.'), tr('srv:hero.perSecond', '{v} /с', { v: d.staminaRegen.toFixed(1) }), tr('srv:hero.staminaRegenTip', 'Восстанавливает {staminaRegen} выносливости каждую секунду.', { staminaRegen: d.staminaRegen.toFixed(1) }), delta(d.staminaRegen, pd.staminaRegen, 1, false, tr('srv:hero.perSecondSuffix', ' /с'))),
      ...(d.interruptResist > 0 ? [statRow(tr('srv:hero.interrupt', 'Стойк. к прерыв.'), `${R(d.interruptResist * 100)}%`, tr('srv:hero.interruptTip', 'Шанс НЕ сбить замах тяжёлого удара при стане/ошеломлении цели.'))] : []),
    ],
  });

  // сопротивления и выдержка брони
  const res: SheetBlock = { title: tr('srv:hero.resTitle', 'Сопротивления'), rows: [] };
  for (const [key, el] of RES) {
    const name = dmgName(cfg, el);
    const v = d[key];
    res.rows.push(resRow(name, v, tr('srv:hero.resTip', 'Снижает урон стихии «{name}» на {v}%. Максимум — 75%.', { name, v: Math.round(v * 100) })));
  }
  res.rows.push(row([tr('srv:hero.physPoise', 'Стойкость к физ. статусам')]));
  const gear = Object.values(save.equipment).filter((it): it is Item => !!it);
  for (const k of ['wound', 'bleed', 'sunder', 'daze'] as DebuffKind[]) {
    const poise = armorPoise(gear, k, cfg.get('armor-classes'));
    const lab = debuffLabel(debuffsCfg, k);
    res.rows.push(resRow(`${debuffIcon(debuffsCfg, k)} ${lab}`, poise, tr('srv:hero.poiseTip', 'Выдержка от брони: снижает шанс И длительность статуса «{lab}» на {poise}%. Максимум — 60%.', { lab, poise: Math.round(poise * 100) })));
  }
  blocks.push(res);

  // статусы: урон итоговым % по типам, «бездомные» бонусы, наложение статусов
  const ail: SheetBlock = { title: tr('srv:hero.ailmentsTitle', 'Статусы'), rows: [] };
  const perPct: Record<DamageType, number> = { physical: d.physPct, fire: d.firePct, cold: d.coldPct, lightning: d.lightningPct, poison: d.poisonPct };
  const addFlat: Record<DamageType, number> = { physical: 0, fire: d.addFire, cold: d.addCold, lightning: d.addLightning, poison: d.addPoison };
  if (d.damagePct) ail.rows.push(statRow(tr('srv:hero.allDamage', 'Весь урон'), `+${R(d.damagePct * 100)}%`, tr('srv:hero.allDamageTip', 'Множитель ко ВСЕМ типам урона (складывается с типовыми ниже).')));
  for (const t of DAMAGE_TYPES) {
    const combined = d.damagePct + perPct[t];
    const parts: string[] = [];
    if (combined) parts.push(`+${R(combined * 100)}%`);
    if (addFlat[t]) parts.push(tr('srv:hero.flatBonus', '+{addFlat} плоск.', { addFlat: R(addFlat[t]) }));
    if (!parts.length) continue;
    const name = dmgName(cfg, t);
    ail.rows.push(statRow(name, parts.join(' · '),
      tr('srv:hero.typeBonusTip', 'Итоговый бонус к урону «{name}»: общий +{damagePct}% + типовой +{perPct}%{flat}.', { name, damagePct: R(d.damagePct * 100), perPct: R(perPct[t] * 100), flat: addFlat[t] ? tr('srv:hero.flatPart', ' · плоско +{addFlat}', { addFlat: R(addFlat[t]) }) : '' })));
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
  ail.rows.push(row([tr('srv:hero.ailmentApply', 'Наложение статусов')]));
  ail.rows.push(statRow(tr('srv:hero.allAilments', 'Все статусы'), tr('srv:hero.allAilmentsValue', 'шанс/сила +{ailmentPct}%  ·  длит. +{ailmentDurPct}%', { ailmentPct: R(d.ailmentPct * 100), ailmentDurPct: R(d.ailmentDurPct * 100) }),
    tr('srv:hero.allAilmentsTip', 'Глобальные бонусы к наложению ВСЕХ статусов (шанс, сила, длительность). Складываются с бонусами по видам.')));
  for (const k of AILMENT_KINDS) {
    const c = dd[`${k}ChancePct`]!, p = dd[`${k}PowerPct`]!, du = dd[`${k}DurPct`]!;
    if (!c && !p && !du) continue;
    const parts: string[] = [];
    if (c) parts.push(tr('srv:hero.chancePart', 'шанс +{c}%', { c: R(c * 100) }));
    if (p) parts.push(tr('srv:hero.powerPart', 'сила +{p}%', { p: R(p * 100) }));
    if (du) parts.push(tr('srv:hero.durPart', 'длит. +{du}%', { du: R(du * 100) }));
    const lab = debuffLabel(debuffsCfg, k);
    ail.rows.push(statRow(lab, parts.join('  ·  '), tr('srv:hero.ailmentKindTip', 'Бонусы к наложению статуса «{lab}» (ветки скиллов/гир).', { lab })));
  }
  blocks.push(ail);

  // прочее
  blocks.push({
    title: tr('srv:hero.otherTitle', 'Прочее'),
    rows: [
      statRow(tr('srv:hero.moveSpeed', 'Скор. движения'), R(d.moveSpeed), tr('srv:hero.moveSpeedTip', 'Итоговая скорость перемещения (база 120). Бонусы: {sign}{pct}%.', { sign: d.moveSpeed >= 120 ? '+' : '', pct: R((d.moveSpeed / 120 - 1) * 100) })),
      statRow(tr('srv:hero.gold', 'Золото'), String(save.gold), tr('srv:hero.goldTip', 'Валюта: магазин, кузница, дерево мастерства.')),
      statRow(tr('srv:hero.maxDepth', 'Макс. глубина'), String(save.maxDepth), tr('srv:hero.maxDepthTip', 'Самый глубокий достигнутый этаж.')),
    ],
  });
  return blocks;
}

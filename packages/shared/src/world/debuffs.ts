/**
 * Дебафф-движок боевого ядра (headless, сериализуемый — годится и для сети).
 * Состояние — простые данные на цели; функции чистые. Виды дебаффов по типам
 * физ. урона (см. docs/WEAPONS.md): рана/кровотечение/увечье/ошеломление.
 */

/**
 * Виды дебаффов. Физические (по подтипу оружия) + стихийные (по типу урона):
 * поджиг/отравление — DoT; шок — +получаемый урон; заморозка — замедление + шанс сковать.
 */
export type DebuffKind =
  | 'wound' | 'bleed' | 'sunder' | 'daze'      // физические (подтип оружия)
  | 'burn' | 'poison' | 'shock' | 'freeze';    // стихийные (тип урона)

/** Физические дебаффы (накладываются подтипом оружия). */
export type PhysDebuffKind = Extract<DebuffKind, 'wound' | 'bleed' | 'sunder' | 'daze'>;

export const DEBUFF_LABEL: Record<DebuffKind, string> = {
  wound: 'Рана', bleed: 'Кровотечение', sunder: 'Увечье', daze: 'Ошеломление',
  burn: 'Поджиг', poison: 'Отравление', shock: 'Шок', freeze: 'Заморозка',
};

/** Иконки-эмодзи дебаффов — единый источник для HUD игрока и наводок монстров. */
export const DEBUFF_ICON: Record<DebuffKind, string> = {
  wound: '🩹', bleed: '🩸', sunder: '🪓', daze: '💫',
  burn: '🔥', poison: '☠', shock: '⚡', freeze: '❄',
};

/**
 * Тюн-коэффициенты одного дебаффа (интринсик-механика: пороги/множители). Структурно
 * совпадает с `debuffsSchema.tuning` (config-слой) — тип держим здесь, чтобы движок не
 * зависел от config и не плодил циклов импорта. Смысл поля зависит от вида.
 */
export interface DebuffTuningFields {
  outDamageFloor?: number;
  moveFloor?: number;
  accuracyPerStack?: number;
  accuracyFloor?: number;
  hpRegenMult?: number;
  atkSpeedBase?: number;
  armorFloor?: number;
  atkSpeedFactor?: number;
  atkSpeedFloor?: number;
}

/** Одна запись конфига `debuffs` (см. config/schemas `debuffsSchema`). */
export interface DebuffConfigEntry {
  id: DebuffKind;
  name: string;
  icon: string;
  category: 'physical' | 'elemental';
  desc: string;
  tuning: DebuffTuningFields;
}

/** Весь конфиг состояний (массив, порядок = DebuffKind). Он же — источник tuning для движка. */
export type DebuffsConfig = DebuffConfigEntry[];
/** Псевдоним для сигнатуры движка: `debuffMods(state, tuning)`. */
export type DebuffTuning = DebuffsConfig;

/** Имя дебаффа из конфига (фолбэк — константа DEBUFF_LABEL). */
export function debuffLabel(cfg: DebuffsConfig | undefined, k: DebuffKind): string {
  return cfg?.find((d) => d.id === k)?.name ?? DEBUFF_LABEL[k];
}
/** Иконка дебаффа из конфига (фолбэк — константа DEBUFF_ICON). */
export function debuffIcon(cfg: DebuffsConfig | undefined, k: DebuffKind): string {
  return cfg?.find((d) => d.id === k)?.icon ?? DEBUFF_ICON[k];
}

// Стихия урона → её статус теперь в конфиге damage-types (поле `ailment`), не тут.

export interface ActiveDebuff {
  stacks: number;
  maxStacks: number;
  /** мс-таймстамп истечения (обновляется новым проком). */
  expiresAt: number;
  /** Первичная магнитуда на стак (смысл зависит от вида). */
  mag: number;
  /** Вторичная магнитуда на стак (wound: замедление; daze: шанс стана). */
  mag2: number;
}

/** Активные дебаффы цели (простой объект — сериализуется в снапшот). */
export type DebuffState = { [K in DebuffKind]?: ActiveDebuff };

/** DoT-статусы: сила = доля от урона удара (bleed/burn/poison), не флэт. */
export function isDotKind(k: DebuffKind): boolean { return k === 'bleed' || k === 'burn' || k === 'poison'; }

/** Описание накладываемого дебаффа. `mag` — флэт-сила; `magPerDamage` — доля от урона удара (DoT). */
export interface DebuffApply {
  kind: DebuffKind;
  chance: number;      // 0..1 — шанс наложить стак за удар
  maxStacks: number;
  durationMs: number;
  mag: number;
  mag2?: number;
  /** DoT: доля от нанесённого урона → добавляется к силе при наложении (`mag + magPerDamage×dmg`). */
  magPerDamage?: number;
}

export function newDebuffState(): DebuffState {
  return {};
}

/** Добавляет стак (без ролла шанса — его катает вызывающий). Обновляет магнитуду/таймер. */
export function addDebuffStack(state: DebuffState, a: DebuffApply, now: number): void {
  const cur = state[a.kind];
  if (!cur) {
    state[a.kind] = {
      stacks: 1, maxStacks: a.maxStacks, expiresAt: now + a.durationMs,
      mag: a.mag, mag2: a.mag2 ?? 0,
    };
    return;
  }
  cur.stacks = Math.min(a.maxStacks, cur.stacks + 1);
  cur.maxStacks = a.maxStacks;
  cur.expiresAt = now + a.durationMs;
  cur.mag = a.mag;
  cur.mag2 = a.mag2 ?? cur.mag2;
}

/** Тик: снимает истёкшие дебаффы, возвращает суммарный DoT за интервал dtSec. */
export function tickDebuffs(state: DebuffState, dtSec: number, now: number): number {
  let dot = 0;
  for (const k of Object.keys(state) as DebuffKind[]) {
    const d = state[k];
    if (!d) continue;
    if (now >= d.expiresAt) { delete state[k]; continue; }
    // Урон-по-времени: кровотечение (физ), поджиг (огонь), отравление (яд).
    if (k === 'bleed' || k === 'burn' || k === 'poison') dot += d.stacks * d.mag * dtSec; // mag = DoT/сек/стак
  }
  return dot;
}

/** Суммарные эффекты активных дебаффов на цель. */
export interface DebuffMods {
  /** wound: цель наносит меньше урона. */
  outDamageMult: number;
  /** wound + freeze: цель двигается медленнее. */
  moveMult: number;
  /** sunder + shock: цель получает больше урона. */
  recvDamageMult: number;
  /** sunder: реген HP цели урезан. */
  hpRegenMult: number;
  /** daze: броня цели снижена. */
  armorMult: number;
  /** daze + freeze: цель атакует медленнее. */
  atkSpeedMult: number;
  /** bleed: множитель меткости цели (<1). Процентный, чтобы штраф не зависел от абсолютного рейтинга. */
  accuracyMult: number;
  /** daze: накопленный шанс оглушения за удар. */
  dazeStunChance: number;
  /** freeze: накопленный шанс сковать (обездвижить) за удар. */
  freezeChance: number;
}

/** Читает интринсик-коэффициент дебаффа из tuning-конфига по id с фолбэком на дефолт. */
function tune(
  tuning: DebuffTuning | undefined,
  kind: DebuffKind,
  field: keyof DebuffTuningFields,
  def: number,
): number {
  return tuning?.find((x) => x.id === kind)?.tuning[field] ?? def;
}

/**
 * Суммарные эффекты активных дебаффов на цель. `tuning` — конфиг `debuffs` (интринсик-
 * коэффициенты); без него берутся дефолты, идентичные прежнему хардкоду (поведение не меняется).
 */
export function debuffMods(state: DebuffState, tuning?: DebuffTuning): DebuffMods {
  const w = state.wound, s = state.sunder, d = state.daze, b = state.bleed;
  const sh = state.shock, fr = state.freeze;
  const woundSlow = w ? w.stacks * w.mag2 : 0;
  const freezeSlow = fr ? fr.stacks * fr.mag : 0; // fr.mag = замедление/стак, fr.mag2 = шанс сковать/стак
  const outDamageFloor = tune(tuning, 'wound', 'outDamageFloor', 0.2);
  const moveFloor = tune(tuning, 'wound', 'moveFloor', 0.25);
  const accPerStack = tune(tuning, 'bleed', 'accuracyPerStack', 0.05);
  const accFloor = tune(tuning, 'bleed', 'accuracyFloor', 0.6);
  const sunderRegen = tune(tuning, 'sunder', 'hpRegenMult', 0.5);
  const dazeAtkBase = tune(tuning, 'daze', 'atkSpeedBase', 0.85);
  const dazeArmorFloor = tune(tuning, 'daze', 'armorFloor', 0);
  const freezeAtkFactor = tune(tuning, 'freeze', 'atkSpeedFactor', 0.6);
  const freezeAtkFloor = tune(tuning, 'freeze', 'atkSpeedFloor', 0.4);
  return {
    outDamageMult: w ? Math.max(outDamageFloor, 1 - w.stacks * w.mag) : 1,
    moveMult: Math.max(moveFloor, 1 - woundSlow - freezeSlow),
    recvDamageMult: 1 + (s ? s.stacks * s.mag : 0) + (sh ? sh.stacks * sh.mag : 0),
    hpRegenMult: s ? sunderRegen : 1,
    armorMult: d ? Math.max(dazeArmorFloor, 1 - d.stacks * d.mag) : 1,
    atkSpeedMult: Math.max(freezeAtkFloor, (d ? dazeAtkBase : 1) - freezeSlow * freezeAtkFactor),
    accuracyMult: b ? Math.max(accFloor, 1 - b.stacks * accPerStack) : 1,
    dazeStunChance: d ? d.stacks * d.mag2 : 0,
    freezeChance: fr ? fr.stacks * (fr.mag2 ?? 0) : 0,
  };
}

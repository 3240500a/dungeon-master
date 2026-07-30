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

export function debuffMods(state: DebuffState): DebuffMods {
  const w = state.wound, s = state.sunder, d = state.daze, b = state.bleed;
  const sh = state.shock, fr = state.freeze;
  const woundSlow = w ? w.stacks * w.mag2 : 0;
  const freezeSlow = fr ? fr.stacks * fr.mag : 0; // fr.mag = замедление/стак, fr.mag2 = шанс сковать/стак
  return {
    outDamageMult: w ? Math.max(0.2, 1 - w.stacks * w.mag) : 1,
    moveMult: Math.max(0.25, 1 - woundSlow - freezeSlow),
    recvDamageMult: 1 + (s ? s.stacks * s.mag : 0) + (sh ? sh.stacks * sh.mag : 0),
    hpRegenMult: s ? 0.5 : 1,
    armorMult: d ? Math.max(0, 1 - d.stacks * d.mag) : 1,
    atkSpeedMult: Math.max(0.4, (d ? 0.85 : 1) - freezeSlow * 0.6),
    accuracyMult: b ? Math.max(0.6, 1 - b.stacks * 0.05) : 1,
    dazeStunChance: d ? d.stacks * d.mag2 : 0,
    freezeChance: fr ? fr.stacks * (fr.mag2 ?? 0) : 0,
  };
}

/**
 * Резолверы метаданных каналов урона (имя/цвет/подпись) — из ЖИВЫХ конфигов
 * `damage-kinds` (physical) + `magic-subtypes` (стихии), data-driven. App заполняет
 * карту при старте; до этого — фолбэки. Единый источник для всплывающих чисел,
 * иконок, тултипов (без хардкода/задвоений).
 */
export interface DamageTypeMeta {
  name: string;
  short: string;
  color: string;
  /** Накладываемый статус (burn/freeze/shock/poison) или null (у физического). */
  ailment: string | null;
}

let meta: Record<string, DamageTypeMeta> = {};

export function setDamageTypeMeta(map: Record<string, DamageTypeMeta>): void {
  meta = map;
}

export function dmgColor(id: string): string {
  return meta[id]?.color ?? '#c9c9d4';
}
/** Цвет как число (0xRRGGBB) — для Phaser-текстов/тинтов. */
export function dmgColorNum(id: string): number {
  return parseInt(dmgColor(id).slice(1), 16);
}
export function dmgName(id: string): string {
  return meta[id]?.name ?? id;
}
export function dmgShort(id: string): string {
  return meta[id]?.short ?? id;
}
/** Статус, накладываемый этим типом урона (burn/freeze/…), или null. */
export function dmgAilment(id: string): string | null {
  return meta[id]?.ailment ?? null;
}

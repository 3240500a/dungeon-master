import type { Rarity } from '@dm/shared';

/**
 * Резолверы цвета/имени редкости — из ЖИВОГО конфига `rarities` (data-driven).
 * App заполняет при старте (setRarityMeta); дефолты — резервный фолбэк, чтобы
 * UI-модули (тултипы/панели) оставались Phaser-free и не тянули игру в тесты.
 * Единый источник цветов редкости — без хардкода/задвоений с rarities.json.
 */
export interface RarityMeta {
  name: string;
  color: string;
}

let meta: Record<string, RarityMeta> = {
  normal: { name: 'Обычный', color: '#ffffff' },
  magic: { name: 'Магический', color: '#6a8ad0' },
  rare: { name: 'Редкий', color: '#ffd24b' },
  unique: { name: 'Уникальный', color: '#d08030' },
};

export function setRarityMeta(map: Record<string, RarityMeta>): void {
  meta = map;
}

/** Цвет редкости как hex-строка (#RRGGBB) — для DOM/тултипов. */
export function rarityHex(r: Rarity | string): string {
  return meta[r]?.color ?? '#ffffff';
}
/** Цвет редкости как число (0xRRGGBB) — для Phaser-тинтов/текстов. */
export function rarityColorNum(r: Rarity | string): number {
  return parseInt(rarityHex(r).slice(1), 16);
}
export function rarityName(r: Rarity | string): string {
  return meta[r]?.name ?? String(r);
}

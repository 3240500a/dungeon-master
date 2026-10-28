/** Детерминированный ГПСЧ (mulberry32) — для генерации и воспроизводимых тестов. */
export interface Rng {
  next(): number; // [0, 1)
  int(minInclusive: number, maxInclusive: number): number;
  float(min: number, max: number): number;
  pick<T>(arr: readonly T[]): T;
  chance(p: number): boolean;
}

/**
 * Броски поверх ЛЮБОГО источника чисел [0, 1) — те же `int`/`float`/`pick`/`chance`, что у сидового `createRng`.
 * ⭐ R9-02: сервер кормит сессию комнаты криптоисточником (`sessionRng`), а формулы и сессия не знают, откуда число.
 */
export function rngFrom(next: () => number): Rng {
  return {
    next,
    int: (min, max) => Math.floor(next() * (max - min + 1)) + min,
    float: (min, max) => next() * (max - min) + min,
    pick: (arr) => arr[Math.floor(next() * arr.length)]!,
    chance: (p) => next() < p,
  };
}

export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  return rngFrom((): number => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  });
}

/**
 * ⭐ 17.10: СТРОКА → ЦЕЛОЕ ДЛЯ СИДА (FNV-1a 32 бита). Нужна там, где поток случайности обязан зависеть от
 * ЛИЧНОСТИ (ключ забега, id узла), а не только от чисел: `createRng` берёт число, а личность у нас строковая.
 *
 * ⚠ Это НЕ криптография и не хеш для сравнения — только перемешивание сида. Пустая строка даёт базу FNV.
 */
export function strSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return h >>> 0;
}

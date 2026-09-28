/**
 * ⭐ ИНСТРУМЕНТЫ ФАЗЗЕРА ИНВАРИАНТОВ (тесты сервера, `*.fuzz.test.ts`): детерминированный генератор чисел и сжатие
 * последовательности операций до минимальной, на которой нарушение ещё повторяется.
 *
 * Здесь нет ничего от игры — только то, что нужно любому фаззеру «операции → инварианты»: одинаковый сид даёт одинаковый поток
 * чисел (повтор и сжатие обязаны видеть тот же прогон), а сжатие выбрасывает куски операций, пока нарушение с той же подписью
 * воспроизводится (дельта-отладка: половины, четверти… по одной).
 */

/** Поток чисел в [0, 1) от сида: mulberry32 — быстрый, с полным периодом 2^32, детерминированный. */
export interface FuzzRng {
  /** [0, 1). */
  next(): number;
  /** Целое в [0, n). */
  int(n: number): number;
  /** Истина с вероятностью `p`. */
  chance(p: number): boolean;
  /** Элемент массива (массив не пуст). */
  pick<T>(xs: readonly T[]): T;
  /** Индекс по весам (сумма > 0). */
  weighted(ws: readonly number[]): number;
}

export function fuzzRng(seed: number): FuzzRng {
  let a = (seed >>> 0) || 0x9e3779b9;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number): number => Math.floor(next() * Math.max(1, n));
  return {
    next,
    int,
    chance: (p) => next() < p,
    pick: (xs) => xs[int(xs.length)]!,
    weighted: (ws) => {
      const total = ws.reduce((s, w) => s + Math.max(0, w), 0);
      let r = next() * total;
      for (let i = 0; i < ws.length; i++) { r -= Math.max(0, ws[i]!); if (r < 0) return i; }
      return ws.length - 1;
    },
  };
}

/** Смешать два числа в сид (разные потоки одного прогона не должны совпадать). */
export function mixSeed(a: number, b: number): number {
  let h = (Math.imul(a ^ 0x85ebca6b, 0xc2b2ae35) ^ Math.imul(b + 0x27d4eb2f, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  return (h ^ (h >>> 13)) >>> 0;
}

/**
 * Сжать последовательность: выбрасывать куски (половины, четверти… по одной операции), пока `reproduces` подтверждает то же
 * нарушение. `budget` — потолок прогонов (каждый прогон — целый сценарий с нуля). Возвращает самую короткую найденную.
 */
export async function shrinkOps<T>(ops: readonly T[], reproduces: (ops: T[]) => Promise<boolean>, budget = 300): Promise<{ ops: T[]; runs: number }> {
  let cur = [...ops];
  let runs = 0;
  let chunk = Math.max(1, Math.ceil(cur.length / 2));
  while (chunk >= 1 && runs < budget) {
    let changed = false;
    for (let i = 0; i < cur.length && runs < budget;) {
      const cand = [...cur.slice(0, i), ...cur.slice(i + chunk)];
      runs++;
      if (cand.length < cur.length && await reproduces(cand)) { cur = cand; changed = true; } else i += chunk;
    }
    if (!changed) {
      if (chunk === 1) break;
      chunk = Math.max(1, Math.floor(chunk / 2));
    }
  }
  return { ops: cur, runs };
}

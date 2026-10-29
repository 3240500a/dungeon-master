import { describe, it, expect } from 'vitest';
import { pickAttack, ATTACK_VARY } from './attackPick.js';

/**
 * ⭐⭐ ЗАЖАТАЯ МЫШЬ ОБЯЗАНА ЧЕРЕДОВАТЬ УДАРЫ.
 *
 * Жалоба: «если зажать мышку, он повторяет один и тот же удар». Причина была арифметическая —
 * счётчик пула крутили ДВА источника (свинг сервера и автосцепка по окну комбо), и на пуле из двух
 * ударов «+2 за цикл» это тождество. Плюс счётчик двигался даже когда свинг был подавлен перехватом
 * и клип не запускался вовсе.
 *
 * Поэтому состояние очереди — ПОСЛЕДНИЙ СЫГРАННЫЙ КЛИП, а не номер: сколько бы раз ни спросили и кто
 * бы ни спросил, ответ всегда «следующий после того, что реально играло».
 */
describe('очередь ударов', () => {
  const POOL2 = ['hit_l', 'hit_r'];
  const POOL4 = ['a', 'b', 'c', 'd'];
  const never = (): number => 1;      // rnd, при котором отклонение НИКОГДА не срабатывает
  const always = (): number => 0;     // …и всегда

  /** Прогнать очередь n раз, отдавая каждый ответ обратно как «сыгранный». */
  const run = (pool: string[], n: number, vary = 0, rnd = never): string[] => {
    const out: string[] = [];
    let last: string | null = null;
    for (let i = 0; i < n; i++) { const k = pickAttack(pool, last, vary, rnd); last = pool[k]!; out.push(last); }
    return out;
  };

  it('⭐⭐ ДВА УДАРА ЧЕРЕДУЮТСЯ СТРОГО — ровно то, что было сломано', () => {
    expect(run(POOL2, 6)).toEqual(['hit_l', 'hit_r', 'hit_l', 'hit_r', 'hit_l', 'hit_r']);
  });

  it('⭐⭐ ПОВТОРА ПОДРЯД НЕ БЫВАЕТ НИКОГДА — ни при каком случае', () => {
    // ⚠ Мутация «разрешить выпасть предыдущему» валит это: повтор — ровно то, на что жалуются.
    for (const pool of [POOL2, POOL4]) {
      for (const rnd of [never, always, Math.random]) {
        const seq = run(pool, 400, 1, rnd);
        for (let i = 1; i < seq.length; i++) expect(seq[i], `⚠ ПОВТОР ПОДРЯД: ${seq.slice(i - 2, i + 1).join(' → ')}`).not.toBe(seq[i - 1]);
      }
    }
  });

  it('⭐ ШАНС РАЗНООБРАЗИЯ УВОДИТ С ПОРЯДКА (от трёх ударов)', () => {
    // ⚠ Мутация «игнорировать vary» валит это: цепочка читалась бы как заученная.
    expect(run(POOL4, 8, 0, always), 'шанс 0 — строго по кругу').toEqual(['a', 'b', 'c', 'd', 'a', 'b', 'c', 'd']);
    const varied = run(POOL4, 8, 1, always);
    expect(varied, '⚠ шанс 1 не изменил порядок вовсе').not.toEqual(['a', 'b', 'c', 'd', 'a', 'b', 'c', 'd']);
  });

  it('⚠ НА ПАРЕ УДАРОВ ШАНС НЕ ДЕЙСТВУЕТ — «другой» там может быть только предыдущим', () => {
    // Строгое чередование на двух клипах и есть максимум разнообразия; случайность дала бы повтор.
    expect(run(POOL2, 8, 1, always)).toEqual(run(POOL2, 8, 0, never));
  });

  it('⭐ ВСЕ УДАРЫ ПУЛА УЧАСТВУЮТ — ни один не выпадает из ротации', () => {
    const seq = run(POOL4, 600, ATTACK_VARY, Math.random);
    for (const n of POOL4) expect(seq.filter((x) => x === n).length, `⚠ удар ${n} не играет вовсе`).toBeGreaterThan(50);
  });

  it('⚠ ОДИН И ТОТ ЖЕ ВОПРОС БЕЗ «СЫГРАНО» ДАЁТ ОДИН И ТОТ ЖЕ ОТВЕТ', () => {
    // Ровно случай подавленного свинга: клип не запустился — очередь не двинулась.
    expect(pickAttack(POOL2, 'hit_l', 0, never)).toBe(1);
    expect(pickAttack(POOL2, 'hit_l', 0, never)).toBe(1);
  });

  it('пустой пул — ответа нет', () => { expect(pickAttack([], null, 1, always)).toBe(-1); });
  it('один удар — он и играет', () => { expect(pickAttack(['x'], 'x', 1, always)).toBe(0); });

  it('⚠ НЕЗНАКОМЫЙ «ПОСЛЕДНИЙ» (сменилось оружие/скил) — начинаем с первого, а не падаем', () => {
    expect(pickAttack(POOL2, 'hit_axe_из_другого_пула', 0, never)).toBe(0);
  });

  it('шанс по умолчанию оставляет порядок читаемым', () => {
    expect(ATTACK_VARY).toBeGreaterThan(0);
    expect(ATTACK_VARY, '⚠ больше половины — порядок перестаёт читаться').toBeLessThanOrEqual(0.5);
  });
});

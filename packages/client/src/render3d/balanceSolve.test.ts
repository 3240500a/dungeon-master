import { describe, it, expect } from 'vitest';
import { solveBalance, BAL_TRANSFER, type BalanceProbe } from './balanceSolve.js';

/**
 * ⭐⭐ ПОМОЩЬ БАЛАНСА НЕ ИМЕЕТ ПРАВА ДВИГАТЬ АВТОРСКУЮ ПОЗУ.
 *
 * Жалоба: «правлю позы у загруженной анимации — таз улетает в бок и корёжит позу». Замер в живом
 * редакторе давал −1.74 ед. ЗА КАЖДУЮ ПРАВКУ, накопительно (к пятой правке 8.62 в кости, из них
 * 6.88 уже въелось в саму позу), и «ЦМ минус центр опоры» при этом не менялся вовсе: 4.00 / 4.00 /
 * 4.00 — опора едет вместе с тазом, потому что стопы его дети.
 *
 * Тесты ниже ставят ровно эти два вопроса: помнит ли помощь свой прошлый сдвиг и умеет ли она
 * отличить настоящее улучшение от бега по дорожке.
 */
describe('перенос веса (помощь баланса)', () => {
  /**
   * Мир на одну ось. `ride` — насколько опора едет за тазом: 1 — стопы дети таза и едут с ним
   * (ноги не доре́шиваются), 0 — стопы прибиты (пины держат). ЦМ едет с тазом всегда.
   */
  function world(opts: { com0: number; sup0: number; half: number; ride: number }): BalanceProbe & { hips: number; moves: number } {
    const w = {
      hips: 0, moves: 0,
      com: () => ({ x: opts.com0 + w.hips, z: 0 }),
      sup: () => ({ x0: opts.sup0 + opts.ride * w.hips - opts.half, x1: opts.sup0 + opts.ride * w.hips + opts.half, z0: -3, z1: 3 }),
      move: (dx: number): void => { w.hips += dx; w.moves++; },
    };
    return w;
  }

  it('⭐⭐ ПОВТОР ДАЁТ ТОТ ЖЕ ОТВЕТ — поза не уплывает от правки к правке', () => {
    // ⚠ Мутация «не снимать прошлый сдвиг в начале» валит ровно это: в живом замере таз уезжал
    // на 1.74 за КАЖДУЮ правку и к пятой улетал на 8.62.
    const w = world({ com0: 0, sup0: -4, half: 3, ride: 0 });
    let off = { x: 0, z: 0 };
    const hips: number[] = [];
    for (let i = 0; i < 6; i++) { off = solveBalance(w, 0.6, off); hips.push(+w.hips.toFixed(4)); }
    expect(hips[0], '⚠ помощь обязана что-то сделать на позе, где ЦМ вне опоры').toBeLessThan(-0.5);
    for (const h of hips) expect(h, `⚠ ТАЗ УПЛЫЛ: ${hips.join(' → ')}`).toBeCloseTo(hips[0]!, 6);
  });

  it('⭐⭐ ОПОРА ЕДЕТ С ТАЗОМ — помощь бессильна и НЕ ДВИГАЕТ НИЧЕГО', () => {
    // Живой замер: «ЦМ минус центр опоры» = 4.00 при сдвиге таза 0, 3 и 6 — цель убегает ровно со
    // скоростью погони. ⚠ Мутация «убрать проверку „помогло ли“» валит это: таз уедет впустую.
    const w = world({ com0: 0, sup0: -4, half: 3, ride: 1 });
    const off = solveBalance(w, 0.6, { x: 0, z: 0 });
    expect(off.x, '⚠ помощь сдвинула таз, не улучшив баланс ни на сколько').toBe(0);
    expect(w.hips, '⚠ кость осталась сдвинутой — откат не сработал').toBeCloseTo(0, 9);
  });

  it('стопы прибиты — помощь работает и заводит ЦМ внутрь опоры', () => {
    const w = world({ com0: 0, sup0: -4, half: 3, ride: 0 });
    const gap0 = Math.abs(w.com().x - (w.sup()!.x1 - 0.75));      // до края целевого окна
    const off = solveBalance(w, 0.6, { x: 0, z: 0 });
    expect(off.x, '⚠ помощь не сдвинула таз к опоре').toBeLessThan(-0.5);
    const gap1 = Math.abs(w.com().x - (w.sup()!.x1 - 0.75));
    expect(gap1, '⚠ баланс не улучшился').toBeLessThan(gap0);
    expect(off.x * BAL_TRANSFER, '⚠ перенос считается через долю массы выше таза').toBeLessThan(0);
  });

  it('⚠ ВЫКЛЮЧАТЕЛЬ СНИМАЕТ УЖЕ ПРИМЕНЁННЫЙ СДВИГ, а не только будущий', () => {
    // ⚠ Мутация «ранний выход до ребейза при weightShift = 0» валит это: «баланс: выкл» оставил бы
    // таз там, куда его увела помощь, и поза так и осталась бы кривой.
    const w = world({ com0: 0, sup0: -4, half: 3, ride: 0 });
    const on = solveBalance(w, 0.6, { x: 0, z: 0 });
    expect(w.hips).toBeLessThan(-0.5);
    const off = solveBalance(w, 0, on);
    expect(off).toEqual({ x: 0, z: 0 });
    expect(w.hips, '⚠ выключенная помощь оставила свой сдвиг в кости').toBeCloseTo(0, 9);
  });

  it('ЦМ уже над опорой — помощь не трогает кость вовсе', () => {
    const w = world({ com0: 0, sup0: 0, half: 3, ride: 0 });
    expect(solveBalance(w, 0.6, { x: 0, z: 0 })).toEqual({ x: 0, z: 0 });
    expect(w.moves, '⚠ лишние движения кости на сбалансированной позе').toBe(0);
  });

  it('стоять не на чем (обе стопы в воздухе) — помощь молчит', () => {
    const w = world({ com0: 0, sup0: -4, half: 3, ride: 0 });
    const probe: BalanceProbe = { com: w.com, sup: () => null, move: w.move };
    expect(solveBalance(probe, 0.6, { x: 0, z: 0 })).toEqual({ x: 0, z: 0 });
    expect(w.hips).toBe(0);
  });

  it('потолок считается ЗА ПОЗУ, а не за вызов', () => {
    // ⚠ Именно потому старый код и улетал: `BAL_MAX` ограничивал ОДИН вызов, а вызовов — по числу правок.
    const w = world({ com0: 0, sup0: -60, half: 3, ride: 0 });
    let off = { x: 0, z: 0 };
    for (let i = 0; i < 8; i++) off = solveBalance(w, 1, off);
    expect(Math.abs(w.hips), '⚠ таз ушёл дальше потолка переноса веса').toBeLessThanOrEqual(9 + 1e-9);
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { PoseDriver, GAIT, GAIT_BASE } from './pose.js';

/**
 * ⭐ ОКНО УДЕРЖАНИЯ ПОДОШВЫ ПО ФАЗЕ ПЕРЕНОСА (`ankHoldFrom`/`ankHoldTo`/`ankHoldEase`).
 *
 * Жалоба: «есть ползунок держать стопу — если его выкрутить, то НА ОТРЫВЕ нормально, а ПОТОМ уже
 * не очень; сделай, в какой фазе он должен держать — не весь путь, а часть, от и до».
 *
 * ⚠⚠ РАМПЫ ЖИВУТ СНАРУЖИ ОКНА, не внутри. Внутри `[from, to]` вес РОВНО 1, смягчение — в полосе
 * `ease` перед `from` и после `to`. Только так умолчание `[0, 1]` остаётся прежним поведением
 * БИТ В БИТ при любой плавности. Рампы внутри окна обнулили бы удержание на самом отрыве — то есть
 * вернули бы ровно ту резкость, ради которой ручка и заводится.
 */
describe('окно удержания подошвы', () => {
  const saved: Record<string, number> = {};
  const set = (k: string, v: number): void => {
    const g = GAIT as unknown as Record<string, number>;
    if (!(k in saved)) saved[k] = g[k]!;
    g[k] = v;
  };
  afterEach(() => {
    const g = GAIT as unknown as Record<string, number>;
    for (const k in saved) g[k] = saved[k]!;
    for (const k in saved) delete saved[k];
  });

  /** Прогон бега: угол голеностопа левой ноги + доля переноса, плюс худший скачок НА ОТРЫВЕ. */
  function run(frames = 400): { ank: number[]; swing: boolean[]; liftJump: number } {
    const d = new PoseDriver();
    d.setMove(1);
    let z = 0, prev = 0, wasSwing = false, liftJump = 0;
    const ank: number[] = [], swing: boolean[] = [];
    for (let i = 0; i < frames + 150; i++) {
      z += 90 / 60;
      d.setWorld(0, z, 0, 0, 90);
      d.update(1 / 60);
      const sw = d.swingLegs[0];
      if (i >= 150) {
        ank.push(d.out.ankL); swing.push(sw);
        if (sw && !wasSwing) liftJump = Math.max(liftJump, Math.abs(d.out.ankL - prev));   // кадр ОТРЫВА
      }
      prev = d.out.ankL; wasSwing = sw;
    }
    return { ank, swing, liftJump };
  }

  /** Углы голеностопа ВНУТРИ одного переноса, по долям фазы. */
  function swingProfile(): { early: number; late: number } {
    const { ank, swing } = run();
    let i = 0;
    while (i < swing.length && !(swing[i] && !swing[i - 1])) i++;    // начало переноса
    let j = i; while (j < swing.length && swing[j]) j++;
    const n = j - i;
    expect(n, '⚠ не удалось собрать фазу переноса').toBeGreaterThan(5);
    return { early: Math.abs(ank[i + Math.floor(n * 0.1)]!), late: Math.abs(ank[i + Math.floor(n * 0.85)]!) };
  }

  it('умолчание — окно на ВЕСЬ перенос', () => {
    expect(GAIT_BASE.ankHoldFrom).toBe(0);
    expect(GAIT_BASE.ankHoldTo).toBe(1);
  });

  it('⭐⭐ при умолчании ПЛАВНОСТЬ НИЧЕГО НЕ МЕНЯЕТ — рампы снаружи окна', () => {
    // ⚠ Мутация «рампы внутрь окна» валит именно это: при ease 0.4 начало и конец переноса просели бы.
    set('ankHoldEase', 0); set('ankHoldEaseRun', 0);
    const a = run().ank;
    set('ankHoldEase', 0.4); set('ankHoldEaseRun', 0.4);
    const b = run().ank;
    expect(a.length).toBe(b.length);
    const worst = Math.max(...a.map((v, i) => Math.abs(v - b[i]!)));
    expect(worst, '⚠ плавность действует ВНУТРИ окна — умолчание перестало быть прежним поведением').toBe(0);
  });

  it('⭐ окно режет ХВОСТ: на отрыве держит, к касанию отпускает', () => {
    set('ankLevel', 1); set('ankLevelRun', 1);
    set('toeLift', 0); set('toeLiftRun', 0);          // мерим ЧИСТОЕ удержание: у подъёма носка своя фаза
    const full = swingProfile();
    set('ankHoldTo', 0.4); set('ankHoldToRun', 0.4);
    set('ankHoldEase', 0.2); set('ankHoldEaseRun', 0.2);
    const cut = swingProfile();
    expect(cut.early, '⚠ окно съело удержание НА ОТРЫВЕ — а там оно и нужно')
      .toBeGreaterThan(full.early * 0.9);
    expect(cut.late, '⚠ хвост переноса не отпущен — ручка не действует')
      .toBeLessThan(full.late * 0.5);
  });

  it('⭐ сдвинутое начало окна НЕ ДАЁТ СТУПЕНЬКИ на отрыве', () => {
    // ⚠ Мутация «не умножать ветку опоры на вес окна» валит это: опора кончится ПОЛНЫМ удержанием,
    // а перенос начнётся урезанным — скачок ровно в той точке, которую ручка и чинит.
    set('footPlant', 0.4); set('footPlantRun', 0.4);   // ветка плавного отпускания в опоре активна
    set('toeLift', 0); set('toeLiftRun', 0);
    const base = run().liftJump;                       // окно на весь перенос — эталон «как было»
    set('ankHoldFrom', 0.3); set('ankHoldFromRun', 0.3);
    set('ankHoldEase', 0.2); set('ankHoldEaseRun', 0.2);
    // ⚠ Сравниваем С ЭТАЛОНОМ, а не с магическим числом: важно, что сдвиг окна НЕ ДОБАВИЛ скачка.
    expect(run().liftJump, '⚠ СТУПЕНЬКА НА ОТРЫВЕ: ветка опоры не знает про окно').toBeLessThan(base + 0.03);
  });

  it('плавность 0 — край окна жёсткий (ручка честно выключается)', () => {
    set('ankHoldTo', 0.4); set('ankHoldToRun', 0.4);
    set('ankHoldEase', 0); set('ankHoldEaseRun', 0);
    set('toeLift', 0); set('toeLiftRun', 0);
    const { early, late } = swingProfile();
    expect(early, '⚠ на отрыве удержание обязано остаться').toBeGreaterThan(0.05);
    expect(late, '⚠ за концом окна удержание обязано быть ровно нулевым').toBeLessThan(1e-9);
  });
});

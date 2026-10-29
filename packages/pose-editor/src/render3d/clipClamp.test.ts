import { describe, it, expect } from 'vitest';
import { clampClip, clampBones, clampSummary } from './clipClamp.js';
import type { LimitView } from './humanoidRagdoll.js';
import type { Clip, Pose } from './clipModel.js';

/**
 * ⭐⭐ ПРЕДЕЛЫ СУСТАВОВ НА ИМПОРТЕ — ПО ВЫБРАННЫМ ЧАСТЯМ.
 *
 * Жалоба: «при ударе мечом голову ведёт в сторону, видимо лимитов не хватает». ЗАМЕР клипа
 * `hit_sword_r_01`: на кадре 5 авторено **шея −52.3°** и **голова −38.1°** рыска — вместе около
 * −90° при пределе головы ±40°. Голова уходила от прицела на 14.2°.
 *
 * ⚠ ПРЕДЕЛЫ В ПРОЕКТЕ БЫЛИ, НО ИХ НЕ ПРИМЕНЯЛ НИКТО: редактор клампит только ручной позинг (гизмо,
 * IK), а импорт, проигрывание клипа и рантайм не проверяли ничего.
 *
 * ⚠ ЗАЖИМАЕМ ПО ЧАСТЯМ, А НЕ ВСЁ: предел настроен под физику и ручную правку, и на руках-ногах он
 * вполне может испортить мокап. Выбор — галками в панели импорта.
 */
describe('пределы суставов на импорте', () => {
  /** Узкий предел: рыск (твист вокруг Y) не больше ±0.2 рад. */
  const tight = (): LimitView => ({
    kind: 'swing', group: 'head', canon: 'neck',
    twist: [0, 1, 0], plane: [1, 0, 0], normal: [0, 0, 1],
    planeMin: -2, planeMax: 2, normalMin: -2, normalMax: 2, twistMin: -0.2, twistMax: 0.2,
  });
  const clip = (pose: Pose): Clip => ({
    name: 'hit', character: 'warrior', weapon: 'sword', loop: false,
    keys: [{ t: 0, pose: JSON.parse(JSON.stringify(pose)) as Pose }],
  } as unknown as Clip);

  it('⭐⭐ ПЕРЕБОР ЗАЖИМАЕТСЯ — ровно то, что ловили на мече', () => {
    // ⚠ Мутация «не писать результат обратно в позу» валит это.
    const c = clip({ Neck: [0, -0.9, 0] } as unknown as Pose);
    const rep = clampClip(c, ['head'], () => tight());
    expect(rep.changed, '⚠ перебор не тронут').toBe(1);
    expect(Math.abs(c.keys[0]!.pose['Neck']![1]), '⚠ рыск шеи остался за пределом').toBeLessThanOrEqual(0.21);
    expect(rep.worstBone).toBe('Neck');
    expect(rep.worstDeg, '⚠ отчёт не показывает величину правки').toBeGreaterThan(30);
  });

  it('⭐⭐ ЧТО В ПРЕДЕЛ ВЛЕЗАЕТ — НЕ ТРОГАЕМ ВОВСЕ', () => {
    // Иначе кламп «подправлял» бы каждый кадр и менял авторскую работу без нужды.
    const c = clip({ Neck: [0, 0.1, 0] } as unknown as Pose);
    const rep = clampClip(c, ['head'], () => tight());
    expect(rep.changed).toBe(0);
    expect(c.keys[0]!.pose['Neck']).toEqual([0, 0.1, 0]);
  });

  it('⭐⭐ ЧАСТИ ВЫБИРАЮТСЯ: не выбранное не трогается', () => {
    // ⚠ Мутация «зажимать все кости» валит это — а именно этого автор и просил избежать.
    const c = clip({ Neck: [0, -0.9, 0], LeftUpperArm: [0, -0.9, 0] } as unknown as Pose);
    const rep = clampClip(c, ['head'], () => tight());
    expect(c.keys[0]!.pose['LeftUpperArm'], '⚠ зажали руку, хотя выбрана только голова').toEqual([0, -0.9, 0]);
    expect(rep.byBone['LeftUpperArm']).toBeUndefined();
  });

  it('⚠ ПУСТОЙ ВЫБОР — ПОЛНЫЙ НОЛЬ РАБОТЫ', () => {
    const c = clip({ Neck: [0, -0.9, 0] } as unknown as Pose);
    let asked = 0;
    const rep = clampClip(c, [], () => { asked++; return tight(); });
    expect(rep.changed).toBe(0);
    expect(asked, '⚠ пределы спрашивались при пустом выборе').toBe(0);
    expect(c.keys[0]!.pose['Neck']).toEqual([0, -0.9, 0]);
  });

  it('⚠ НЕТ ПРЕДЕЛА У КОСТИ — НЕ ВЫДУМЫВАЕМ ЕГО', () => {
    const c = clip({ Neck: [0, -0.9, 0] } as unknown as Pose);
    const rep = clampClip(c, ['head'], () => null);
    expect(rep.changed).toBe(0);
    expect(c.keys[0]!.pose['Neck']).toEqual([0, -0.9, 0]);
  });

  it('⭐ ЗАЖИМАЕТСЯ КАЖДЫЙ КАДР, а не только первый', () => {
    const c = {
      name: 'hit', character: 'warrior', weapon: 'sword', loop: false,
      keys: [0, 1, 2].map((i) => ({ t: i * 0.1, pose: { Neck: [0, -0.9, 0] } as unknown as Pose })),
    } as unknown as Clip;
    const rep = clampClip(c, ['head'], () => tight());
    expect(rep.changed, '⚠ зажат не каждый кадр').toBe(3);
    for (const k of c.keys) expect(Math.abs(k.pose['Neck']![1])).toBeLessThanOrEqual(0.21);
  });

  it('состав частей — тот же список, что у маски импорта', () => {
    expect([...clampBones(['head'])].sort()).toEqual(['Head', 'Neck']);
    expect(clampBones([]).size).toBe(0);
    expect(clampBones(['legL']).has('LeftFoot')).toBe(true);
  });

  it('отчёт читаемый и честный, когда правок нет', () => {
    expect(clampSummary({ changed: 0, worstDeg: 0, worstBone: '', byBone: {} })).toContain('ничего не тронули');
    const s = clampSummary({ changed: 4, worstDeg: 41.2, worstBone: 'Neck', byBone: { Neck: 41.2, Head: 8 } });
    expect(s).toContain('4');
    expect(s).toContain('41');
    expect(s).toContain('Neck');
  });
});

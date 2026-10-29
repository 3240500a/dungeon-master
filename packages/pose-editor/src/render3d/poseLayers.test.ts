import { describe, it, expect } from 'vitest';
import { asOffHandPose, composeStance, resolveStancePose, splitHands, isTwoHanded, stancePoseAt, type PoseLayer } from './poseLayers.js';
import type { Pose } from './clipModel.js';
import type { BoneMask } from './boneMask.js';

/**
 * СЛОИ ПОЗЫ: одна безоружная база + аддитивные оверлеи предметов по рукам.
 *
 * Ставка: «меч + щит» не авторится, а СОБИРАЕТСЯ из Δмеч (правая рука) и Δщит (левая). Чтобы на это
 * можно было опереться, нужно одно свойство — наложение дельты предмета на его же базу обязано
 * вернуть авторскую позу предмета ТОЧНО. Иначе «собрано» и «заавторено» разъедутся, и каждый предмет
 * придётся проверять глазами.
 */
const MAIN: BoneMask = { parts: {}, weights: { RightShoulder: 1, RightUpperArm: 1, RightLowerArm: 1, RightHand: 1, UpperChest: 0.25, Chest: 0.15, Spine: 0.08 } };
const OFF: BoneMask = { parts: {}, weights: { LeftShoulder: 1, LeftUpperArm: 1, LeftLowerArm: 1, LeftHand: 1, UpperChest: 0.25, Chest: 0.15, Spine: 0.08 } };
const ALL: BoneMask = { parts: {}, weights: { RightShoulder: 1, RightUpperArm: 1, RightLowerArm: 1, RightHand: 1, LeftShoulder: 1, LeftUpperArm: 1, LeftLowerArm: 1, LeftHand: 1, UpperChest: 1, Chest: 1, Spine: 1 } };

const BASE: Pose = {
  RightUpperArm: [-0.2, 0, 0.3], RightLowerArm: [0, 0.6, 0], RightHand: [0, 0, 0],
  LeftUpperArm: [-0.2, 0, -0.3], LeftLowerArm: [0, -0.6, 0], LeftHand: [0, 0, 0],
  Chest: [0, 0, 0], Spine: [0, 0, 0], UpperChest: [0, 0, 0],
};
const SWORD: Pose = { ...BASE, RightUpperArm: [-0.9, 0.2, 0.5], RightLowerArm: [0, 1.1, 0], Chest: [0, 0.25, 0] };
const SHIELD: Pose = { ...BASE, LeftUpperArm: [-1.1, -0.1, -0.6], LeftLowerArm: [0, -1.4, 0], Chest: [0, -0.15, 0] };

const near = (a: readonly number[], b: readonly number[], eps = 1e-6): void => {
  for (let i = 0; i < 3; i++) expect(Math.abs(a[i]! - b[i]!), `${a} vs ${b}`).toBeLessThan(eps);
};
const layer = (pose: Pose, mask: BoneMask, weight = 1, kind: PoseLayer['kind'] = 'additive'): PoseLayer =>
  ({ pose, base: BASE, mask, weight, kind });

describe('ключи оружия по рукам', () => {
  it('разбор ключа на главную и офф-руку', () => {
    expect(splitHands('sword')).toEqual(['sword', 'none']);
    expect(splitHands('sword+shield')).toEqual(['sword', 'shield']);
    expect(splitHands('axe+dagger')).toEqual(['axe', 'dagger']);
    expect(splitHands('dual'), 'легаси-ключ дуала').toEqual(['sword', 'dagger']);
  });

  it('двуручное опознаётся — у него офф-руки не бывает', () => {
    expect(isTwoHanded('greatsword')).toBe(true);
    expect(isTwoHanded('bow')).toBe(true);
    expect(isTwoHanded('sword')).toBe(false);
    expect(isTwoHanded('shield')).toBe(false);
  });
});

describe('дельта возвращает авторскую позу', () => {
  it('ОДИН предмет на своей базе = авторская поза ТОЧНО', () => {
    // Это фундамент: если не так, «собрано из слоёв» ≠ «заавторено», и на систему нельзя опереться.
    const got = composeStance(BASE, [layer(SWORD, MAIN)]);
    near(got['RightUpperArm']!, SWORD['RightUpperArm']!);
    near(got['RightLowerArm']!, SWORD['RightLowerArm']!);
  });

  it('вес 0 — база нетронута', () => {
    const got = composeStance(BASE, [layer(SWORD, MAIN, 0)]);
    for (const k in BASE) near(got[k]!, BASE[k]!);
  });

  it('вес 0.5 — ровно посередине между базой и авторской', () => {
    const half = composeStance(BASE, [layer(SWORD, MAIN, 0.5)]);
    const full = composeStance(BASE, [layer(SWORD, MAIN, 1)]);
    // Меряем ДЛИНУ отклонения, а не одну ось: у локтя дельта сидит в Y, у плеча в X.
    const dist = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
    for (const k of ['RightUpperArm', 'RightLowerArm'] as const) {
      const d0 = dist(half[k]!, BASE[k]!), d1 = dist(full[k]!, BASE[k]!);
      expect(d0, k).toBeGreaterThan(0);
      expect(d0, k).toBeLessThan(d1);
    }
  });
});

describe('две руки складываются, а не затирают друг друга', () => {
  it('меч + щит: каждая рука получила своё', () => {
    const got = composeStance(BASE, [layer(SWORD, MAIN), layer(SHIELD, OFF)]);
    near(got['RightUpperArm']!, SWORD['RightUpperArm']!);   // правая — как в авторском мече
    near(got['LeftUpperArm']!, SHIELD['LeftUpperArm']!);    // левая — как в авторском щите
  });

  it('порядок слоёв не меняет результат на РАЗНЫХ костях', () => {
    const a = composeStance(BASE, [layer(SWORD, MAIN), layer(SHIELD, OFF)]);
    const b = composeStance(BASE, [layer(SHIELD, OFF), layer(SWORD, MAIN)]);
    near(a['RightUpperArm']!, b['RightUpperArm']!);
    near(a['LeftUpperArm']!, b['LeftUpperArm']!);
  });

  it('на ОБЩЕЙ кости (корпус) вклады складываются, а не побеждает последний', () => {
    // Δмеч даёт груди +0.25 по Y, Δщит −0.15; маска корпуса 0.15 → ожидаем сумму, а не одно из двух.
    const got = composeStance(BASE, [layer(SWORD, MAIN), layer(SHIELD, OFF)]);
    const onlySword = composeStance(BASE, [layer(SWORD, MAIN)]);
    const onlyShield = composeStance(BASE, [layer(SHIELD, OFF)]);
    const sum = (onlySword['Chest']![1] - BASE['Chest']![1]) + (onlyShield['Chest']![1] - BASE['Chest']![1]);
    expect(got['Chest']![1] - BASE['Chest']![1]).toBeCloseTo(sum, 3);
    // И это НЕ равно ни одному из слагаемых — иначе один слой затёр другой.
    expect(got['Chest']![1]).not.toBeCloseTo(onlySword['Chest']![1], 3);
    expect(got['Chest']![1]).not.toBeCloseTo(onlyShield['Chest']![1], 3);
  });

  it('маска держит границу: оверлей офф-руки не трогает кости главной', () => {
    const got = composeStance(BASE, [layer(SHIELD, OFF)]);
    near(got['RightUpperArm']!, BASE['RightUpperArm']!);
    near(got['RightLowerArm']!, BASE['RightLowerArm']!);
  });
});

describe('двуручное — override, а не дельта', () => {
  const GREAT: Pose = { ...BASE, RightUpperArm: [-1.4, 0.3, 0.2], LeftUpperArm: [-1.3, -0.3, -0.2], Chest: [0, 0.4, 0] };

  it('заменяет верх целиком, а не добавляет к базе', () => {
    const got = composeStance(BASE, [{ pose: GREAT, mask: ALL, weight: 1, kind: 'override' }]);
    near(got['RightUpperArm']!, GREAT['RightUpperArm']!);
    near(got['LeftUpperArm']!, GREAT['LeftUpperArm']!);
    near(got['Chest']!, GREAT['Chest']!);
  });

  it('половинный вес — на полпути к цели', () => {
    const got = composeStance(BASE, [{ pose: GREAT, mask: ALL, weight: 0.5, kind: 'override' }]);
    const d = Math.abs(got['RightUpperArm']![0] - BASE['RightUpperArm']![0]);
    const full = Math.abs(GREAT['RightUpperArm']![0] - BASE['RightUpperArm']![0]);
    expect(d).toBeGreaterThan(full * 0.3);
    expect(d).toBeLessThan(full * 0.7);
  });
});

describe('спец-ключи позы', () => {
  it('позиции и скаляры складываются числами, а не кватернионами', () => {
    const b: Pose = { __hipsD: [0, 1, 0], __wpnMainP: [1, 0, 0], Chest: [0, 0, 0] };
    const it: Pose = { __hipsD: [0, 3, 0], __wpnMainP: [3, 0, 0], Chest: [0, 0, 0] };
    const HIPS: BoneMask = { parts: { hips: 1 } };
    const got = composeStance(b, [{ pose: it, base: b, mask: HIPS, weight: 1, kind: 'additive' }]);
    near(got['__hipsD']!, [0, 3, 0]);
    near(got['__wpnMainP']!, [3, 0, 0]);
    const half = composeStance(b, [{ pose: it, base: b, mask: HIPS, weight: 0.5, kind: 'additive' }]);
    near(half['__hipsD']!, [0, 2, 0]);
    near(half['__wpnMainP']!, [2, 0, 0]);
  });

  it('⚠ МАСКА РУКИ ТАЗ НЕ НЕСЁТ: смещение таза стойки предмета остаётся базовым, а хват предмета едет', () => {
    // Иначе каждая рука добавляла смещение таза своей стойки: у `sword+shield` владельца — ровно два смещения одной стойки.
    const b: Pose = { __hipsD: [0, 1, 0], __hipsP: [0, 30, 0], Chest: [0, 0, 0] };
    const it: Pose = { __hipsD: [-1, 3, 0.6], __hipsP: [0, 28, 0], __wpnMain: [0.5, 0, 0], Chest: [0, 0, 0] };
    const got = composeStance(b, [{ pose: it, base: b, mask: MAIN, weight: 1, kind: 'additive' }, { pose: it, base: b, mask: OFF, weight: 1, kind: 'additive' }]);
    near(got['__hipsD']!, [0, 1, 0]);
    near(got['__hipsP']!, [0, 30, 0]);
    near(got['__wpnMain']!, [1, 0, 0]);      // хват — спец-ключ предмета: идёт с каждым слоем, как и прежде
  });

  it('ключ есть только у предмета — дельта считается от нуля, а не падает', () => {
    const got = composeStance({ Chest: [0, 0, 0] }, [{ pose: { __wpnMainP: [1, 2, 3] }, base: { Chest: [0, 0, 0] }, mask: MAIN, weight: 1, kind: 'additive' }]);
    near(got['__wpnMainP']!, [1, 2, 3]);
  });
});

describe('резолвер стойки под экипировку', () => {
  /** Библиотека-заглушка: `idle_<item>` и `combat_idle_<item>` по ключу предмета. */
  const lib = (m: Record<string, Pose>): ((k: 'idle' | 'combat_idle', i: string, t: number) => Pose | null) =>
    (k, i) => m[k + '|' + i] ?? null;

  it('ПАРА, заавторенная на точный ключ, даёт ОБЕ руки одной позой; тело — безоружная база', () => {
    // Правило владельца (06.10): с оружием берётся безоружная стойка, от стойки предмета — только рука, которая его держит.
    const authored: Pose = { ...BASE, RightUpperArm: [-1.2, 0.1, 0.4], LeftUpperArm: [-0.8, -0.2, -0.7], Chest: [0, 0.9, 0], Spine: [0.4, 0, 0] };
    const find = lib({ 'idle|sword+shield': authored, 'idle|none': BASE, 'idle|sword': SWORD, 'idle|shield': SHIELD });
    const got = resolveStancePose(find, 'sword+shield', 0)!;
    near(got['RightUpperArm']!, authored['RightUpperArm']!);   // руки — из пары, а не из `idle_sword` / `idle_shield`
    near(got['LeftUpperArm']!, authored['LeftUpperArm']!);
    expect(got['Chest']![1], 'корпус — малая доля пары, а не она целиком').toBeCloseTo(0.9 * 0.15, 6);
    expect(got['Spine']![0]).toBeCloseTo(0.4 * 0.08, 6);
  });

  it('⭐⭐ ОДИНОЧНЫЙ предмет со своей стойкой: тело — база, рука — стойки предмета', () => {
    const SW: Pose = { ...SWORD, LeftUpperArm: [-1.5, 0.3, -0.9], Spine: [0.5, 0, 0] };   // стойка меча «трогает» и пустую руку, и спину
    const find = lib({ 'idle|none': BASE, 'idle|sword': SW, 'idle|none+shield': SHIELD });
    const got = resolveStancePose(find, 'sword', 0)!;
    near(got['RightUpperArm']!, SW['RightUpperArm']!);
    near(got['LeftUpperArm']!, BASE['LeftUpperArm']!);      // пустая рука — базы
    expect(got['Spine']![0]).toBeCloseTo(0.5 * 0.08, 6);     // спина — малая доля, а не стойка меча
    const sh = resolveStancePose(find, 'none+shield', 0)!;
    near(sh['LeftUpperArm']!, SHIELD['LeftUpperArm']!);
    near(sh['RightUpperArm']!, BASE['RightUpperArm']!);
  });

  it('нет авторской на ключ — собирается из базы и дельт обеих рук', () => {
    // Ровно случай дуала: клип назван `idle_dual`, игра ищет `idle_sword+dagger` и сегодня не находит
    // НИЧЕГО — персонаж остаётся без стойки. Теперь собирается.
    const find = lib({ 'idle|none': BASE, 'idle|sword': SWORD, 'idle|dagger': SHIELD });
    const got = resolveStancePose(find, 'sword+dagger', 0)!;
    expect(got).not.toBeNull();
    near(got['RightUpperArm']!, SWORD['RightUpperArm']!);
    near(got['LeftUpperArm']!, SHIELD['LeftUpperArm']!);
  });

  it('вес предмета = сила подмешивания', () => {
    const find = lib({ 'idle|none': BASE, 'idle|sword': SWORD, 'idle|shield': SHIELD });
    const off = resolveStancePose(find, 'sword+shield', 0, { weight: (i) => (i === 'shield' ? 0 : 1) })!;
    near(off['LeftUpperArm']!, BASE['LeftUpperArm']!);       // щит выкручен в ноль — рука базовая
    near(off['RightUpperArm']!, SWORD['RightUpperArm']!);    // меч не тронут
  });

  it('двуручное владеет верхом целиком и офф-руку игнорирует', () => {
    const GREAT: Pose = { ...BASE, RightUpperArm: [-1.4, 0.3, 0.2], LeftUpperArm: [-1.3, -0.3, -0.2] };
    const find = lib({ 'idle|none': BASE, 'idle|greatsword': GREAT, 'idle|shield': SHIELD });
    const got = resolveStancePose(find, 'greatsword+shield', 0)!;
    near(got['LeftUpperArm']!, GREAT['LeftUpperArm']!);      // левая — от двуручника, а не от щита
  });

  it('боевая стойка блендится по `combat`, нет её — остаётся спокойная', () => {
    const CB: Pose = { ...BASE, Chest: [0, 0.5, 0] };
    const withCb = resolveStancePose(lib({ 'idle|none': BASE, 'combat_idle|none': CB }), 'none', 1)!;
    near(withCb['Chest']!, CB['Chest']!);
    const noCb = resolveStancePose(lib({ 'idle|none': BASE }), 'none', 1)!;
    near(noCb['Chest']!, BASE['Chest']!);
  });

  it('нет безоружной базы — ведём себя как раньше, а не падаем', () => {
    expect(resolveStancePose(lib({ 'idle|sword': SWORD }), 'sword', 0)).toBe(SWORD);
    expect(resolveStancePose(lib({}), 'sword', 0)).toBeNull();
  });

  it('голые руки — чистая база без слоёв', () => {
    const got = resolveStancePose(lib({ 'idle|none': BASE }), 'none', 0)!;
    for (const k in BASE) near(got[k]!, BASE[k]!);
  });
});

describe('хват предмета в офф-руке', () => {
  it('`__wpnMain` предмета переезжает в `__wpnOff` — иначе кинжал заберёт хват меча', () => {
    const dagger: Pose = { ...BASE, __wpnMain: [0.1, 0.2, 0.3], __wpnMainP: [1, 2, 3] };
    const off = asOffHandPose(dagger);
    expect(off['__wpnOff']).toEqual([0.1, 0.2, 0.3]);
    expect(off['__wpnOffP']).toEqual([1, 2, 3]);
    expect(off['__wpnMain']).toBeUndefined();
  });

  it('заавторено сразу как офф — не трогаем', () => {
    const p: Pose = { __wpnOff: [1, 1, 1], __wpnMain: [9, 9, 9] };
    expect(asOffHandPose(p)).toBe(p);
  });

  it('в собранной стойке хват меча остаётся у меча', () => {
    const sword: Pose = { ...SWORD, __wpnMain: [0.5, 0, 0] };
    const dagger: Pose = { ...SHIELD, __wpnMain: [0, 0.9, 0] };
    const find = (k: 'idle' | 'combat_idle', i: string): Pose | null =>
      ({ 'idle|none': BASE, 'idle|sword': sword, 'idle|dagger': dagger } as Record<string, Pose>)[k + '|' + i] ?? null;
    void 0;
    const got = resolveStancePose(find, 'sword+dagger', 0)!;
    near(got['__wpnMain']!, [0.5, 0, 0]);     // главная рука — меч
    near(got['__wpnOff']!, [0, 0.9, 0]);      // офф — кинжал, а не второй меч
  });
});

describe('живая стойка (многокадровый idle)', () => {
  const key = (t: number, y: number): { pose: Pose; t: number } => ({ t, pose: { Chest: [0, y, 0] } });

  it('один кадр — держит его, время ни при чём (как было всегда)', () => {
    const c = { keys: [key(0, 0.5)] };
    for (const t of [0, 1, 7.3]) near(stancePoseAt(c, t)!['Chest']!, [0, 0.5, 0]);
  });

  it('несколько кадров — играет и ЗАЦИКЛИВАЕТСЯ', () => {
    const c = { keys: [key(0, 0), key(1, 1), key(2, 0)] };
    near(stancePoseAt(c, 0)!['Chest']!, [0, 0, 0]);
    near(stancePoseAt(c, 1)!['Chest']!, [0, 1, 0]);
    near(stancePoseAt(c, 2)!['Chest']!, [0, 0, 0], 1e-4);      // конец = начало цикла
    near(stancePoseAt(c, 3)!['Chest']!, [0, 1, 0], 1e-4);      // пошёл второй круг
  });

  it('отрицательное и нечисловое время не ломают цикл', () => {
    const c = { keys: [key(0, 0), key(1, 1), key(2, 0)] };
    expect(stancePoseAt(c, -1)!['Chest']![1]).toBeCloseTo(1, 4);
    near(stancePoseAt(c, NaN)!['Chest']!, [0, 0, 0]);
  });

  it('пустой клип — null, а не падение', () => {
    expect(stancePoseAt({ keys: [] }, 0)).toBeNull();
  });

  it('живая база и статичный предмет складываются: стойка дышит, меч на месте', () => {
    const b0: Pose = { ...BASE, Chest: [0, 0, 0] };
    const b1: Pose = { ...BASE, Chest: [0, 0.4, 0], RightUpperArm: [-0.35, 0, 0.3] };   // вдох двигает и грудь, и плечо
    const breath = { keys: [{ pose: b0, t: 0 }, { pose: b1, t: 1 }, { pose: b0, t: 2 }] };
    const find = (k: 'idle' | 'combat_idle', i: string, t: number): Pose | null => {
      if (k !== 'idle') return null;
      if (i === 'none') return stancePoseAt(breath, t);
      return i === 'sword' ? SWORD : i === 'dagger' ? SHIELD : null;
    };
    // ⚠ Ключ БЕЗ авторской позы — иначе сработает правило «авторская сильнее» и база не понадобится.
    const a = resolveStancePose(find, 'sword+dagger', 0, {}, 0)!;
    const b = resolveStancePose(find, 'sword+dagger', 0, {}, 1)!;
    expect(Math.abs(a['Chest']![1] - b['Chest']![1]), 'база дышит').toBeGreaterThan(0.1);
    // На нуле (референс = живая база) рука выходит ровно авторским мечом…
    near(a['RightUpperArm']!, SWORD['RightUpperArm']!);
    // …а на вдохе дыхание ПРОСТУПАЕТ сквозь оверлей, а не гасится им.
    expect(Math.hypot(b['RightUpperArm']![0] - a['RightUpperArm']![0], b['RightUpperArm']![1] - a['RightUpperArm']![1], b['RightUpperArm']![2] - a['RightUpperArm']![2]),
      'рука с мечом дышит вместе с базой').toBeGreaterThan(0.05);
  });
});

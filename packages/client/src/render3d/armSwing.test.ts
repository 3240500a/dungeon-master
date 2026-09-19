import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as THREE from 'three';
import { buildHumanoid } from './humanoid.js';
import { localStorageContent, emptyGrid, setLocoMixOverride, resetSwingSnapshot, applyShieldOverlay, type PoseContent, type UpperPose } from './poseRuntime.js';
import { BakePlayer } from './bakePlayer.js';   // ⭐ кукла С планировщиком: редактор и запекатель
import { bakeGaitToClip, GAIT_PRESETS } from './clipBake.js';
import { TWO_HANDED } from './poseLayers.js';
import { blendArmKey, swingRefOf, meanPose, clearSwingRefCache } from './armBlend.js';
import { lookupItemSwing, swingDefault, readSwingStore, ARM_BONE_OF, TWO_HANDED_ITEMS, type SwingStore } from './layerWeights.js';
import { makeStand, arcDeg, poseErrorDeg, GROUPS, HARNESS_GX, DEG } from './parityHarness.js';
import { clipPoseAt, type Clip, type Pose } from './clipModel.js';

/**
 * ⭐⭐ МАХ РУК: ЯКОРЬ + АДДИТИВНАЯ ДЕЛЬТА, КЛЮЧ — ПРЕДМЕТ В РУКЕ.
 *
 * Жалоба: «в игре, когда беру меч, почти перестаёт махать руками. Надо, чтобы мах оставался, но не такой сильный,
 * и если в левой руке ничего нет — чтобы она махала нормально. Должна браться анимация бега и подмешиваться каждая
 * рука в зависимости от того, что в ней».
 *
 * Стерегутся ДВЕ разные вещи, и путать их нельзя:
 *  • ОПЕРАТОР (`armBlend`): амплитуда не зависит от того, где стоит якорь, а оба конца точны по построению;
 *  • ОСЬ НАСТРОЙКИ (`pe_swing`): ключ — предмет И рука, поэтому пустая рука машет клипом без единой записи.
 */
const STANCE_MAIN: Pose = {   // «меч в правой»: правая согнута и приподнята, левая — как в безоружной базе
  RightShoulder: [0.05, 0, 0.12], RightUpperArm: [0.25, -0.1, 0.7], RightLowerArm: [0, 1.1, 0], RightHand: [-0.3, 0.2, -0.25],
  LeftShoulder: [0, 0, 0], LeftUpperArm: [0, 0, -0.1], LeftLowerArm: [0, -0.2, 0], LeftHand: [0, 0, 0],
  Chest: [0.1, 0.05, 0], UpperChest: [0.08, -0.04, 0.02],
};
const R = 120;
let lib: Map<string, Clip>;

beforeAll(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: () => null, setItem: () => { /* */ }, removeItem: () => { /* */ }, clear: () => { /* */ }, key: () => null, length: 0,
  } as Storage;
  const h = buildHumanoid({});
  const p = new BakePlayer(h, () => [], localStorageContent('warrior'), 'none', HARNESS_GX, emptyGrid());
  lib = new Map();
  for (const s of GAIT_PRESETS) lib.set(s.name, bakeGaitToClip(p, h, s, { character: 'warrior', weapon: 'none' }).clip);
});
afterAll(() => { delete (globalThis as unknown as { localStorage?: Storage }).localStorage; });
afterEach(() => { setLocoMixOverride(null); resetSwingSnapshot(); clearSwingRefCache(); });

/** Контент со стойкой и заданным составом рук. `hands` — что в какой руке (это и есть ось настройки). */
const content = (hands: { main: string; off: string } | undefined, swing = 0.2): PoseContent => ({
  ...localStorageContent('warrior'),
  charId: 'warrior',
  locoClip: (names: readonly string[]) => { for (const n of names) { const c = lib.get(n); if (c) return c; } return null; },
  resolveUpper: (): UpperPose => ({ swing, pose: STANCE_MAIN, ...(hands ? { hands } : {}) }),
});
const withStore = <T>(st: SwingStore, fn: () => T): T => {
  const was = globalThis.localStorage;
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => (k === 'pe_swing' ? JSON.stringify(st) : null), setItem: () => { /* */ }, removeItem: () => { /* */ }, clear: () => { /* */ }, key: () => null, length: 0,
  } as unknown as Storage;
  resetSwingSnapshot();
  try { return fn(); } finally { (globalThis as unknown as { localStorage: Storage }).localStorage = was; resetSwingSnapshot(); }
};
/** Размах плеча/локтя обеих рук и расхождение с клипом. */
const measure = (c: PoseContent): { L: number; R: number; eL: number; eR: number; err: number } => {
  const st = makeStand({ content: c });
  const fr = st.run({ vz: R, warm: 240, frames: 120 });
  st.dispose();
  return { L: arcDeg(fr, 'LeftUpperArm'), R: arcDeg(fr, 'RightUpperArm'),
    eL: arcDeg(fr, 'LeftLowerArm'), eR: arcDeg(fr, 'RightLowerArm'),
    err: poseErrorDeg(fr, lib.get('run_fwd')!, GROUPS['руки']!).mean };
};

describe('оператор: якорь + аддитивный мах', () => {
  const ref: [number, number, number] = [0.1, 0.2, -0.3];
  const loco: [number, number, number] = [0.9, -0.4, 0.5];
  const stance: [number, number, number] = [-0.6, 0.7, 0.2];
  const q = (v: readonly number[]): THREE.Quaternion => new THREE.Quaternion().setFromEuler(new THREE.Euler(v[0]!, v[1]!, v[2]!, 'XYZ'));

  it('⭐⭐ a=0, k=1 → РОВНО ПОЗА КЛИПА (это и есть «1 в 1 как во вкладке Анимация»)', () => {
    const out = blendArmKey('RightUpperArm', ref, loco, stance, { a: 0, k: 1 })!;
    // ⚠ Порог 1e-3, а не 0: у совпадающих кватернионов `angleTo` даёт 1.7e−6…3.8e−6° (acos возле единицы) плюс
    // круг «эйлер → кватернион → эйлер». На фоне маха 56° это ноль.
    expect(q(out).angleTo(q(loco)) * DEG).toBeLessThan(1e-3);
  });

  it('⭐⭐ a=1, k=0 → РОВНО АВТОРСКАЯ СТОЙКА (оружие держится как настроено)', () => {
    const out = blendArmKey('RightUpperArm', ref, loco, stance, { a: 1, k: 0 })!;
    expect(q(out).angleTo(q(stance)) * DEG).toBeLessThan(1e-3);
  });

  it('⭐⭐ АМПЛИТУДА НЕ ЗАВИСИТ ОТ ЯКОРЯ — то, чего слерп не умел в принципе', () => {
    // Дуга «клип по циклу» моделируется двумя крайними кадрами: считаем угол между результатами при одном `k`,
    // но разных `a`. У слерпа к стойке он падал бы вместе с `a`; у аддитива обязан стоять.
    const lo: [number, number, number] = [0.9, -0.4, 0.5], hi: [number, number, number] = [-0.5, 0.3, -0.2];
    const span = (a: number, k: number): number =>
      q(blendArmKey('RightUpperArm', ref, lo, stance, { a, k })!).angleTo(q(blendArmKey('RightUpperArm', ref, hi, stance, { a, k })!)) * DEG;
    const base = span(0, 1);
    expect(base).toBeGreaterThan(40);
    for (const a of [0, 0.25, 0.5, 0.75, 1]) expect(span(a, 1), `якорь ${a} не имеет права менять амплитуду`).toBeCloseTo(base, 6);
    // …а `k` её масштабирует, и монотонно.
    expect(span(1, 0.5)).toBeLessThan(base * 0.75);
    expect(span(1, 0)).toBeLessThan(1e-6);
  });

  it('⚠ КОРОТКАЯ ДУГА: дельта больше 180° не уводит руку кругом', () => {
    // Нейтраль и клип по разные стороны от полуоборота: без сведения знака `slerp` от тождества пошёл бы длинной дугой.
    const a: [number, number, number] = [0, 170 / DEG, 0], b: [number, number, number] = [0, -170 / DEG, 0];
    const half = blendArmKey('RightUpperArm', a, b, a, { a: 0, k: 0.5 })!;
    // Ровно посередине КОРОТКОЙ дуги (20°) — это ±180°, а не 0°.
    expect(Math.abs(q(half).angleTo(q(a)) * DEG - 10), 'ушли длинной дугой').toBeLessThan(1);
  });

  it('неугловые ключи идут линейно, а не через кватернион', () => {
    const out = blendArmKey('__wpnMainP', [0, 0, 0], [10, 0, 0], [0, 4, 0], { a: 0.5, k: 0.5 })!;
    expect(out[0]).toBeCloseTo(5, 9);    // якорь 0 + мах 0.5·10
    expect(out[1]).toBeCloseTo(2, 9);    // якорь 0.5·4 + маха нет
  });

  it('нейтраль клипа — СРЕДНЕЕ цикла, а не кадр 0; считается лениво и кэшируется', () => {
    const c = lib.get('run_fwd')!;
    const r = swingRefOf(c);
    expect(swingRefOf(c), 'второй вызов — тот же объект (кэш)').toBe(r);
    const samples: Pose[] = [];
    for (let i = 0; i < 60; i++) samples.push(clipPoseAt(c, i / 60));
    const m = meanPose(samples, ['RightUpperArm'])['RightUpperArm']!;
    const got = r['RightUpperArm']!;
    expect(q(got).angleTo(q(m)) * DEG, 'ленивая нейтраль обязана совпасть со средним по плотной выборке').toBeLessThan(1.5);
    // …и она ВНУТРИ дуги, а не на её краю: цикл уходит от неё в обе стороны. ⚠ Проверяется именно это, а не
    // «нейтраль ≠ кадр 0»: у запечённого `run_fwd` кадр 0 случайно лежит в 0.1° от среднего, и такой сторож был бы
    // про конкретный клип, а не про свойство.
    let lo = 0, hi = 0;
    for (let i = 0; i < 60; i++) {
      const v = clipPoseAt(c, i / 60)['RightUpperArm']!;
      const d = q(got).angleTo(q(v)) * DEG;
      // знак — по продольной оси маха (X эйлера плеча): дуга обязана уходить от нейтрали в ОБЕ стороны
      if (v[0] > got[0]) hi = Math.max(hi, d); else lo = Math.max(lo, d);
    }
    expect(Math.min(lo, hi), 'нейтраль на краю дуги — значит это не среднее').toBeGreaterThan(5);
  });
});

describe('ось настройки: ключ — предмет И рука', () => {
  it('⭐⭐ ПУСТАЯ РУКА МАШЕТ КАК В КЛИПЕ, ЗАНЯТАЯ — ПРИГЛУШЕНА. Без единой записи в конфиге', () => {
    const clip = measure(content(undefined));            // рук никто не занял → верх идёт клипом
    const sword = measure(content({ main: 'sword', off: 'none' }));
    expect(clip.L).toBeGreaterThan(40);
    expect(sword.L, '⚠ ПУСТАЯ ЛЕВАЯ ОБЯЗАНА МАХАТЬ КАК В КЛИПЕ').toBeCloseTo(clip.L, 4);
    expect(sword.R, 'а правая с мечом — заметно тише').toBeLessThan(clip.R * 0.8);
    expect(sword.R, '…но НЕ замереть: мах остаётся').toBeGreaterThan(clip.R * 0.3);
  });

  it('⭐ ЩИТ В ЛЕВОЙ ПРИ ПУСТОЙ ПРАВОЙ — зеркальный случай, и он тоже работает сам', () => {
    const clip = measure(content(undefined));
    const sh = measure(content({ main: 'none', off: 'shield' }));
    expect(sh.R, 'пустая правая — как в клипе').toBeCloseTo(clip.R, 4);
    expect(sh.L, 'занятая левая приглушена').toBeLessThan(clip.L * 0.8);
  });

  it('⭐ ЛОКОТЬ ГАСИТСЯ СИЛЬНЕЕ ПЛЕЧА — это и есть ручка меча (замер: из мирового размаха кисти локоть даёт бóльшую часть)', () => {
    const sword = measure(content({ main: 'sword', off: 'none' }));
    const clip = measure(content(undefined));
    expect(sword.eR / clip.eR, 'локоть правой').toBeLessThan(sword.R / clip.R);
  });

  it('двуручное глушит ОБЕ руки, и сильнее одноручного', () => {
    const one = measure(content({ main: 'sword', off: 'none' }));
    const two = measure(content({ main: 'greatsword', off: 'none' }));
    expect(two.R).toBeLessThan(one.R);
    expect(two.L, 'у двуручного занята и вторая рука — а её слой в стойке ОДИН, на главной').toBeLessThan(one.L * 0.9);
  });

  it('⭐ СВОЯ ЗАПИСЬ БЬЁТ УМОЛЧАНИЕ КЛАССА, и правится ОТДЕЛЬНО по рукам', () => {
    const base = measure(content({ main: 'sword', off: 'shield' }));
    const loud = withStore({ warrior: { sword: { run: { arm: { k: 1 }, elbow: { k: 1 } }, walk: { arm: { k: 1 }, elbow: { k: 1 } } } } },
      () => measure(content({ main: 'sword', off: 'shield' })));
    expect(loud.R, 'мечу подняли мах').toBeGreaterThan(base.R * 1.3);
    expect(loud.L, 'щиту — не трогали').toBeCloseTo(base.L, 4);
  });

  it('веса кадра: ходьба↔бег по sb, колонка боя поверх; локоть без записи наследует плечо', () => {
    const st: SwingStore = { warrior: { sword: { walk: { arm: { k: 0.2 } }, run: { arm: { k: 0.8 } }, combat: { run: { arm: { k: 0.1 } } } } } };
    expect(lookupItemSwing(st, 'warrior', 'sword', 0, 0).arm.k).toBeCloseTo(0.2, 9);
    expect(lookupItemSwing(st, 'warrior', 'sword', 1, 0).arm.k).toBeCloseTo(0.8, 9);
    expect(lookupItemSwing(st, 'warrior', 'sword', 0.5, 0).arm.k).toBeCloseTo(0.5, 9);
    expect(lookupItemSwing(st, 'warrior', 'sword', 1, 1).arm.k, 'бой').toBeCloseTo(0.1, 9);
    // ⭐ ЛОКОТЬ БЕЗ СВОЕЙ ЗАПИСИ идёт за плечом В ПРОПОРЦИИ КЛАССА: подняли плечо до 0.8 — локоть 0.8 × (0.4 / 0.6).
    // Слепое наследование убило бы умолчание «локоть тише плеча», а независимость читалась бы поломкой.
    const d = swingDefault('sword');
    expect(lookupItemSwing(st, 'warrior', 'sword', 1, 0).elbow.k).toBeCloseTo(0.8 * (d.elbow.k / d.arm.k), 9);
    expect(lookupItemSwing(null, 'warrior', 'sword', 1, 0).elbow.k, 'без правок — ровно умолчание класса').toBeCloseTo(d.elbow.k, 9);
    expect(lookupItemSwing(st, 'warrior', 'axe', 1, 0), 'чужой предмет — умолчание класса').toEqual(swingDefault('axe'));
    expect(lookupItemSwing(null, 'warrior', 'none', 1, 0), 'пустая рука — клип').toEqual(swingDefault('none'));
    // Монстры берут настройки персонажа-донора.
    expect(lookupItemSwing(st, 'mon_undead', 'sword', 1, 0, 'warrior').arm.k).toBeCloseTo(0.8, 9);
  });

  it('чужой JSON `pe_swing` разбирается без мусора; список двуручных не разошёлся с `poseLayers`', () => {
    expect(readSwingStore({ warrior: { sword: { run: { arm: { k: 3, a: 'x' }, tail: { k: 1 } }, junk: 1 } }, bad: 5 }))
      .toEqual({ warrior: { sword: { run: { arm: { k: 1 } } } } });
    expect([...TWO_HANDED_ITEMS].sort(), '⚠ два списка двуручного разошлись').toEqual([...TWO_HANDED].sort());
  });

  it('кость → рука и часть: восемь костей рук, и ни одной чужой', () => {
    expect(Object.keys(ARM_BONE_OF).sort()).toEqual([...GROUPS['руки']!].sort());
    expect(ARM_BONE_OF['RightLowerArm']).toEqual({ hand: 'main', part: 'elbow' });
    expect(ARM_BONE_OF['LeftHand']).toEqual({ hand: 'off', part: 'wrist' });
    expect(ARM_BONE_OF['Neck'], '⚠ шея не рука: её ведёт свой вес, и по первой букве имени она уехала бы в «правую»').toBeUndefined();
  });

  it('⭐⭐ ВОРОТА ХОДА ГАСЯТ МАХ: стоя рука в авторской стойке при ЛЮБОМ `k`', () => {
    // Пара `{a,k}` описывает руку НА ПОЛНОМ ХОДУ. Стоя локомоции нет вовсе, и рука обязана быть в стойке — иначе
    // стоящий персонаж держит беговую позу, а на остановке щёлкает в неё (замер до правки: 34.4° за кадр, и
    // запечённая стойка `idle` уезжала от авторской на 47°).
    const still = (hands: { main: string; off: string } | undefined, k: number): THREE.Quaternion => {
      const st = withStore(k === 1 ? { warrior: { sword: { run: { arm: { k: 1 } }, walk: { arm: { k: 1 } } } } } : {},
        () => {
          const stand = makeStand({ content: content(hands) });
          stand.run({ vz: 0, warm: 180, frames: 2 });
          const q = stand.human.bones.get('RightUpperArm')!.quaternion.clone();
          stand.dispose();
          return q;
        });
      return st;
    };
    const want = new THREE.Quaternion().setFromEuler(new THREE.Euler(...(STANCE_MAIN['RightUpperArm'] as [number, number, number]), 'XYZ'));
    for (const k of [0, 1]) {
      const got = still({ main: 'sword', off: 'none' }, k);
      expect(got.angleTo(want) * DEG, `стоя при k=${k} рука обязана быть в авторской стойке`).toBeLessThan(0.5);
    }
  });

  it('печать: что видно глазами', () => {
    const rows = ['состав рук                  плечо Л   плечо П   локоть Л  локоть П   руки↔клип'];
    for (const [label, hands] of [
      ['клип (руки свободны)', undefined],
      ['меч в правой', { main: 'sword', off: 'none' }],
      ['меч + щит', { main: 'sword', off: 'shield' }],
      ['щит в левой, правая пуста', { main: 'none', off: 'shield' }],
      ['двуручный', { main: 'greatsword', off: 'none' }],
    ] as const) {
      const m = measure(content(hands));
      rows.push(`${label.padEnd(26)}${m.L.toFixed(1).padStart(7)}°  ${m.R.toFixed(1).padStart(7)}°  ${m.eL.toFixed(1).padStart(7)}°  ${m.eR.toFixed(1).padStart(7)}°  ${m.err.toFixed(2).padStart(7)}°`);
    }
    // eslint-disable-next-line no-console
    console.log('\n' + rows.join('\n') + '\n');
    expect(rows.length).toBeGreaterThan(1);
  }, 300000);
});

describe('щит: поза только на ударе, хват всегда', () => {
  const SHIELD: Pose = {
    LeftHand: [1.2, 0, 0], LeftLowerArm: [0, -1.4, 0], LeftUpperArm: [0.9, 0, -1.1], LeftShoulder: [0.3, 0, 0],
    UpperChest: [0.2, 0, 0], Chest: [0.15, 0, 0], Spine: [0.1, 0, 0],
    __wpnOff: [0.5, 0.6, 0.7], __wpnOffP: [1, 2, 3],
  };
  const mkGroup = (): THREE.Group => { const g = new THREE.Group(); g.userData.baseRot = new THREE.Euler(); g.userData.basePos = new THREE.Vector3(); return g; };

  it('⭐⭐ ВНЕ УДАРА ПОЗА ЩИТА НЕ КЛАДЁТСЯ — она уже в стойке аддитивной дельтой офф-руки', () => {
    // ⚠ СПЯЩАЯ МИНА ДВОЙНОГО ПРИМЕНЕНИЯ: оверлей клал ту же позу ВТОРОЙ раз, поверх всего, весом 0.85 и не зная ни
    // про веса слоёв, ни про мах руки. Левая рука встала бы колом (0.2 × 0.15 ≈ 3 % маха). На живых данных оверлей
    // молчал (ищет клип по ТОЧНОМУ имени конвенции), то есть беда ждала первого клипа, названного по-старому.
    const h = buildHumanoid({});
    const before = new Map([...h.bones].map(([k, b]) => [k, b.quaternion.clone()]));
    const groups = [mkGroup(), mkGroup()];
    applyShieldOverlay(h, groups, SHIELD, 0.85, 0);
    for (const nm of ['LeftHand', 'LeftLowerArm', 'LeftUpperArm', 'Chest']) {
      expect(h.bones.get(nm)!.quaternion.angleTo(before.get(nm)!) * DEG, `${nm} тронута вне удара`).toBeLessThan(1e-6);
    }
    // …а ХВАТ переносится всегда: щит сидит в кулаке как выставлено, что бы ни делала рука.
    expect([groups[1]!.rotation.x, groups[1]!.rotation.y, groups[1]!.rotation.z]).toEqual([0.5, 0.6, 0.7]);
    expect([groups[1]!.position.x, groups[1]!.position.y, groups[1]!.position.z]).toEqual([1, 2, 3]);
  });

  it('⭐ НА УДАРЕ ПОЗА КЛАДЁТСЯ С МАСКОЙ ПО РАССТОЯНИЮ: кисть держит щит, плечо и корпус свободны под мах', () => {
    const h = buildHumanoid({});
    const groups = [mkGroup(), mkGroup()];
    applyShieldOverlay(h, groups, SHIELD, 1, 1);
    const moved = (nm: string): number => h.bones.get(nm)!.quaternion.angleTo(new THREE.Quaternion()) * DEG;
    // Маска: LeftHand 1.0 > LeftLowerArm 0.38 > LeftUpperArm 0.22 > Spine 0.04 — в этом вся работа оверлея.
    expect(moved('LeftHand')).toBeGreaterThan(1);
    expect(moved('LeftHand') / Math.max(0.01, moved('LeftUpperArm')), 'кисть обязана держать сильнее плеча').toBeGreaterThan(1.5);
    expect(moved('Spine'), 'корпус почти свободен').toBeLessThan(moved('LeftLowerArm'));
  });

  it('⭐⭐ ОФФ-РУКА СО ЩИТОМ ПРОДОЛЖАЕТ МАХАТЬ: оверлей её больше не держит', () => {
    // Интеграция: контент отдаёт оверлей (как если бы автор завёл клип под старым именем) — мах офф-руки обязан
    // остаться настроенным, а не сойтись к позе щита.
    const withShield = (hands: { main: string; off: string }): PoseContent => ({
      ...content(hands),
      shieldOverlay: () => ({ pose: SHIELD, mix: 0.85 }),
    });
    const noOverlay = measure(content({ main: 'sword', off: 'shield' }));
    const overlay = measure(withShield({ main: 'sword', off: 'shield' }));
    expect(overlay.L, '⚠ оверлей снова держит офф-руку — мина вернулась').toBeCloseTo(noOverlay.L, 1);
    expect(overlay.R, 'и главную руку он не трогает').toBeCloseTo(noOverlay.R, 1);
  });
});

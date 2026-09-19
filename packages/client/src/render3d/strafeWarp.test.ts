import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as THREE from 'three';

/**
 * ⭐⭐ «СТРАЙФ ВЫГЛЯДИТ КАК ХОД ПОД 45°» — СТОРОЖ НА ЖИВОМ ПЛЕЕРЕ В «ТОЛЬКО КЛИПЫ».
 *
 * Жалоба автора: боковой ход читался диагональю. ЗАМЕР опубликованного воина (рыцарь, 90° @80, прицел вперёд):
 * опорная стопа до фиксации ехала на 65 % скорости тела, ноги шли на +20° от хода, таз стоял на 40° к прицелу,
 * верх груди — на 19°. Три причины сразу: страйфы запечены диагональю (доворот в съёме + утечка флага «назад»),
 * доворот складывал ход только к «вперёд/назад», и бленд на 90° играл 0.54 страйфа + 0.46 «вперёд».
 *
 * Здесь — вся цепочка ровно как у автора: набор снимается ОДНИМ плеером с доворотом ВКЛ (кнопка редактора), потом
 * играется в «только клипах» с доворотом ВКЛ. Сырую опорную стопу (до фиксации) ловим на входе `legGroundIK`.
 */
const hook = vi.hoisted(() => ({ fn: null as null | ((foot: unknown, target: unknown) => void) }));
vi.mock('./footIk.js', async (importOriginal) => {
  const m = await importOriginal<typeof import('./footIk.js')>();
  return { ...m, legGroundIK: (...a: Parameters<typeof m.legGroundIK>) => { if (hook.fn) hook.fn(a[2], a[3]); return m.legGroundIK(...a); } };
});

import { buildHumanoid } from './humanoid.js';
import { localStorageContent, emptyGrid, setLocoMixOverride, type PoseContent } from './poseRuntime.js';
import { BakePlayer } from './bakePlayer.js';   // ⭐ кукла С планировщиком: редактор и запекатель
import { LOCO_BAKE_REV, LOCO_CARDINAL_REV, isLocoClipFresh } from './poseRuntime.js';
import { GAIT } from './gaitKnobs.js';
import { bakeGaitSet } from './clipBake.js';
import type { Clip } from './clipModel.js';

const D = Math.PI / 180, DT = 1 / 60;
const GX = { armDown: 1.35, elbowBend: 0.25 };
const wrapD = (a: number): number => ((a + 540) % 360) - 180;

describe('страйф в «только клипах»: кардинальный набор + четыре сектора доворота', () => {
  const GAIT0 = { ...GAIT };
  let lib: Map<string, Clip>;
  beforeAll(() => {
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: () => null, setItem: () => { /* */ }, removeItem: () => { /* */ }, clear: () => { /* */ }, key: () => null, length: 0,
    } as Storage;
    GAIT.warpOn = 1; GAIT.warpMax = 45;
    const h = buildHumanoid({});
    const p = new BakePlayer(h, () => [], localStorageContent('warrior'), 'none', GX, emptyGrid());
    lib = new Map(bakeGaitSet(p, h, { character: 'warrior', weapon: 'none' }).map((r) => [r.clip.name, r.clip]));
  });
  afterEach(() => { setLocoMixOverride(null); hook.fn = null; });
  afterAll(() => { delete (globalThis as unknown as { localStorage?: Storage }).localStorage; Object.assign(GAIT, GAIT0); });

  const content = (): PoseContent => ({ ...localStorageContent('warrior'), locoClip: (names: readonly string[]) => { for (const n of names) { const c = lib.get(n); if (c) return c; } return null; } });

  interface M { rawPct: number; dirErr: number; drag: number; pelvis: number; chest: number; jump: number; flips: number; pelvisRate: number }
  /** Прогон: `drive(t)` — направление хода (°, от прицела 0) и скорость. Замер с `rec` сек. */
  const measure = (drive: (t: number) => { dir: number; spd: number }, total: number, rec: number): M => {
    const h = buildHumanoid({});
    const p = new BakePlayer(h, () => [], content(), 'none', GX, emptyGrid());
    setLocoMixOverride(1);
    p.setYaw(0); p.snapYaw();
    const LF = h.bones.get('LeftFoot')!, RF = h.bones.get('RightFoot')!, hips = h.bones.get('Hips')!, uc = h.bones.get('UpperChest')!;
    const LEGS = ['LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot', 'RightUpperLeg', 'RightLowerLeg', 'RightFoot'].map((n) => h.bones.get(n)!);
    const cap: ({ raw: THREE.Vector3; tgt: THREE.Vector3 } | null)[] = [null, null];
    hook.fn = (foot, target) => {
      const leg = foot === LF ? 0 : foot === RF ? 1 : -1;
      if (leg >= 0 && !cap[leg]) cap[leg] = { raw: (foot as THREE.Object3D).getWorldPosition(new THREE.Vector3()), tgt: (target as THREE.Vector3).clone() };
    };
    const q = new THREE.Quaternion(), f = new THREE.Vector3();
    const yawOf = (o: THREE.Object3D): number => { o.getWorldQuaternion(q); f.set(0, 0, 1).applyQuaternion(q); return Math.atan2(f.x, f.z) / D; };
    const prev: ({ raw: THREE.Vector3; tgt: THREE.Vector3; wx: number; wz: number } | null)[] = [null, null];
    let rawSum = 0, rawN = 0, ix = 0, iz = 0, spdSum = 0, n = 0, pelvis = 0, chest = 0, jump = 0, flips = 0, pelvisRate = 0;
    const drags: number[] = [];
    let prevQ: THREE.Quaternion[] | null = null, prevSec = -1, prevHips: number | null = null;
    const frames = Math.round(total / DT);
    for (let i = 0; i < frames; i++) {
      const d = drive(i * DT);
      p.setVel(Math.sin(d.dir * D) * d.spd, Math.cos(d.dir * D) * d.spd); p.setYaw(0);
      cap[0] = cap[1] = null;
      p.step(DT);
      h.root.updateMatrixWorld(true);
      const on = i * DT >= rec;
      const qs = LEGS.map((b) => b.quaternion.clone());
      const hy = yawOf(hips);
      if (on) {
        n++; spdSum += d.spd;
        pelvis = Math.max(pelvis, Math.abs(wrapD(hy)));
        chest += Math.abs(wrapD(yawOf(uc)));
        if (prevQ) for (let k = 0; k < qs.length; k++) jump = Math.max(jump, qs[k]!.angleTo(prevQ[k]!) / D);
        if (prevHips !== null) pelvisRate = Math.max(pelvisRate, Math.abs(wrapD(hy - prevHips)));
        if (prevSec >= 0 && p.dirWarpSector !== prevSec) flips++;
      }
      prevQ = qs; prevHips = hy; prevSec = p.dirWarpSector;
      for (let leg = 0; leg < 2; leg++) {
        const c = cap[leg], pv = prev[leg];
        if (c) {
          const wx = c.raw.x + p.posX, wz = c.raw.z + p.posZ;
          if (on && pv) { rawSum += Math.hypot(wx - pv.wx, wz - pv.wz) / DT; rawN++; ix -= c.raw.x - pv.raw.x; iz -= c.raw.z - pv.raw.z; }
          prev[leg] = { raw: c.raw.clone(), tgt: c.tgt.clone(), wx, wz };
        } else {
          if (on && pv) drags.push(Math.hypot(pv.raw.x - pv.tgt.x, pv.raw.z - pv.tgt.z));
          prev[leg] = null;
        }
      }
    }
    const spd = spdSum / Math.max(1, n);
    return {
      rawPct: 100 * rawSum / Math.max(1, rawN) / Math.max(1e-6, spd),
      dirErr: wrapD(Math.atan2(ix, iz) / D - drive(total).dir),
      drag: drags.reduce((a, b) => a + b, 0) / Math.max(1, drags.length),
      pelvis, chest: chest / Math.max(1, n), jump, flips, pelvisRate,
    };
  };
  const steady = (dir: number, spd = 80): M => measure(() => ({ dir, spd }), 6, 2.5);

  it('⭐⭐ НАБОР КАРДИНАЛЬНЫЙ даже с доворотом ВКЛ в съёме: ревизия набора, таз в клипах 0', () => {
    for (const nm of ['walk_strafe_L', 'walk_strafe_R', 'run_strafe_L', 'run_strafe_R']) {
      const c = lib.get(nm)!;
      expect(c.bakeRev, nm).toBe(LOCO_BAKE_REV);   // ⚠ из константы, а не числом: подъём ревизии не должен валить сторож не по делу
      expect(isLocoClipFresh(c), `${nm}: кардинальный`).toBe(true);
      for (const k of c.keys) expect(Math.abs(k.pose['Hips']?.[1] ?? 0), `${nm}: Hips.y`).toBeLessThan(0.02);
    }
  });


  it('⭐⭐ ПОДЪЁМ РЕВИЗИИ ЗАПЕКАТЕЛЯ НЕ ВЫКЛЮЧАЕТ СЕКТОРА НА УЖЕ ЗАПЕЧЁННОМ НАБОРЕ', () => {
    // ⚠ ЭТО УЖЕ СЛУЧАЛОСЬ. `LOCO_BAKE_REV` подняли 2 → 3 (добавились канал опоры и нейтраль маха), и весь
    // ОПУБЛИКОВАННЫЙ набор разом стал «несвежим» — сектора доворота молча выключились, хотя с клипами ничего не
    // произошло и автор ничего не перезапекал. Две разные вещи нельзя мерить одним числом:
    //   `LOCO_CARDINAL_REV` — клип снят БЕЗ впечённого доворота (настоящий гейт: на старых страйфах сектора хуже);
    //   `LOCO_BAKE_REV`     — текущая ревизия запекателя (у её новшеств есть мягкий фолбэк, гейтить нечего).
    const old2 = { name: 'run_strafe_R', character: 'warrior', weapon: 'none', loop: true, keys: [{ t: 0, pose: {} }],
      bakeSpeed: 120, bakeRev: LOCO_CARDINAL_REV } as unknown as Clip;
    expect(isLocoClipFresh(old2), 'кардинальный клип ревизии 2 обязан оставаться свежим для секторов').toBe(true);
    const old1 = { ...old2, bakeRev: 1 } as Clip;
    expect(isLocoClipFresh(old1), 'а вот снятый С ДОВОРОТОМ — нет, и это настоящий гейт').toBe(false);
    expect(LOCO_BAKE_REV, 'ревизия запекателя ушла вперёд кардинальной — иначе разделение бессмысленно').toBeGreaterThanOrEqual(LOCO_CARDINAL_REV);
  });

  it('⭐⭐ ЧИСТЫЙ БОК ±90°: стопа не едет, ноги по ходу, таз и грудь на прицеле', () => {
    // ⚠ Мутация «доворот складывает только к вперёд/назад» (старая складка) валит это: таз на потолке 45°, а на 60°
    // сырое скольжение 23.9 % против 9.2 % вперёд; переброс на 45° не случается вовсе.
    // ЗАМЕР (манекен, умолчания, 80 u/с): сырое скольжение 9.95 % (вперёд 9.16 %), ошибка хода −0.4°, IK 1.41 ед.,
    // таз 0°. Грудь качается и на ходу вперёд (|Δ| 5.5° — мах рук), поэтому мерим ПРИБАВКУ к ходу вперёд.
    const fwd = steady(0);
    for (const dir of [90, -90]) {
      const m = steady(dir);
      expect(m.pelvis, `${dir}°: таз от прицела`).toBeLessThan(1);
      expect(m.chest - fwd.chest, `${dir}°: верх груди от прицела сверх хода вперёд`).toBeLessThan(2);
      expect(m.rawPct, `${dir}°: сырое скольжение опорной стопы, % скорости`).toBeLessThan(15);
      expect(Math.abs(m.dirErr), `${dir}°: ноги идут не туда`).toBeLessThan(3);
      expect(m.drag, `${dir}°: IK тянет стопу`).toBeLessThan(2.5);
    }
  });

  it('⭐ ДИАГОНАЛИ И СПИНОЙ: остаток снимает доворот — скольжение на уровне хода вперёд, грудь на прицеле', () => {
    // ЗАМЕР ДО канала опоры (`bakeRev` 2): вперёд ~6 %, 30 / 60 / 135 / 180° — 9.16 / 9.95 / 9.12 / 9.12 %.
    // ЗАМЕР ПОСЛЕ (`bakeRev` 3, опора из `__swing` клипа, а не из доли `dutyRun`): вперёд 4.82 %, 30° 4.82,
    // 60° 10.40, 135° и 180° по 9.45. Канал сильно улучшил ПРЯМОЙ ход (−20 %) и 30° (−47 %), а диагональ от 60°
    // осталась где была: там скольжение даёт САМ БЛЕНД двух клипов, и каналом это не лечится — нужен набор на
    // восемь направлений либо stride warping. ⚠ Порог тут ОТНОСИТЕЛЬНЫЙ, и прежний зазор `+4` разъехался сам
    // собой ровно потому, что прямой ход стал лучше. Ошибка хода ≤ 0.4°.
    // (⚠ мутация «отворот доворота теми же весами, что скрутка к прицелу» даёт на 135° +13°).
    const fwd = steady(0);
    expect(fwd.rawPct, 'прямой ход: опора из канала клипа держит стопу лучше доли').toBeLessThan(5.5);
    const rows = [`вперёд ${fwd.rawPct.toFixed(2)} %`];
    for (const dir of [30, 60, 135, 180]) {
      const m = steady(dir);
      rows.push(`${dir}° ${m.rawPct.toFixed(2)} %`);
      expect(m.rawPct, `${dir}°: скольжение ${m.rawPct.toFixed(1)} % против ${fwd.rawPct.toFixed(1)} % вперёд`).toBeLessThan(fwd.rawPct + 6);
      expect(Math.abs(m.dirErr), `${dir}°: ноги идут не туда`).toBeLessThan(3);
      expect(m.chest - fwd.chest, `${dir}°: верх груди от прицела сверх хода вперёд`).toBeLessThan(2);
    }
    // eslint-disable-next-line no-console
    console.log('СКОЛЬЖЕНИЕ: ' + rows.join(' · '));
  });

  it('⭐ МГНОВЕННЫЙ РАЗВОРОТ (R90→L90, 0→180): ноги не прыгают сильнее, чем на ровном страйфе', () => {
    // ⚠ Мутация «без кроссфейда колонки» валит это: R90→L90 — скачок ноги 69.1° за кадр против 19.3° на ровном страйфе.
    // ЗАМЕР с кроссфейдом: 19.1° (R90→L90) и 18.3° (0→180) на 120 u/с.
    const base = Math.max(steady(90).jump, steady(180).jump);
    for (const [a, b] of [[90, -90], [0, 180]] as const) {
      const m = measure((t) => ({ dir: t < 3 ? a : b, spd: 120 }), 4.5, 2.95);
      expect(m.jump, `${a}→${b}: скачок ноги ${m.jump.toFixed(1)}° против ${base.toFixed(1)}° на ровном ходу`).toBeLessThan(base + 6);
    }
  });

  it('⭐ ОСТАНОВКА С БОКОВОГО ХОДА И С ХОДА СПИНОЙ: уходящая колонка доигрывает СВОИМ весом бега, ноги не прыгают', () => {
    // ⚠ Мутация «уходящая колонка играет с НЫНЕШНИМ весом бега (`{ ...f.axes, sb: axes.sb }`)»: инерции хода нет,
    // остановка роняет скорость в ноль за кадр, вес бега — тоже, и гаснущий страйф доигрывает как ХОДЬБА.
    // ЗАМЕР (рыцарь knight_06, опубликованный warrior, «только клипы», скачок ноги за кадр, ° — правка / мутация):
    //   вбок 120 → стоп  17.3 / 71.1 · вбок 80 → стоп  21.4 / 46.0 · спиной 120 → стоп  25.2 / 52.2 · влево 120 → стоп  14.7 / 54.6
    // На манекене (этот сторож): вбок 10.9 / 31.9 при ровном ходе 19.4; спиной 11.9 / 28.0 при ровном 12.8.
    for (const [dir, name] of [[90, 'вбок'], [180, 'спиной']] as const) {
      const steadyJump = steady(dir, 120).jump;
      const m = measure((t) => ({ dir, spd: t < 3 ? 120 : 0 }), 4.2, 2.95);
      expect(m.jump, `${name} → стоп: скачок ноги ${m.jump.toFixed(1)}° (на ходу ${steadyJump.toFixed(1)}°)`).toBeLessThan(steadyJump + 5);
    }
  });

  it('⭐ ПЕРЕБРОС СЕКТОРА: медленный проход 20→70→20 — два переброса, таз едет, а не щёлкает; дрожь 45 ± 6° — ни одного', () => {
    const sweep = measure((t) => ({ dir: t < 3 ? 20 : t < 5 ? 20 + 25 * (t - 3) : 70 - 25 * Math.min(2, t - 5), spd: 80 }), 7, 2.5);
    expect(sweep.flips).toBe(2);
    expect(sweep.pelvisRate, 'таз за кадр на перебросе, ° (замер 11.0 при warpSmooth 0.12)').toBeLessThan(14);
    const jitter = measure((t) => ({ dir: 45 + Math.sin(t * 60 * 1.7) * 6, spd: 80 }), 8, 3);
    expect(jitter.flips).toBe(0);
  });
});

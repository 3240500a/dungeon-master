import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { buildHumanoid, type Humanoid } from './humanoid.js';
import { makeBakeRig, parentOfOur, OUR_BONES } from './retarget3d.js';
import { bakeFromSource, type BakeSource } from './clipBaker.js';
import { hipsOffset, type Pose } from './clipModel.js';
import { presetMask, setPartWeight, type BoneMask } from './boneMask.js';
import { LOCO_BAKE_REV } from './poseRuntime.js';

/**
 * ИСТОЧНИК-БЛИЗНЕЦ: скелет из тех же rest-офсетов, что и наш риг. Тогда обратный ретаргет — тождество,
 * и любое расхождение в тесте означает ошибку СБОРКИ КАДРА (маска/таз/заземление/голова), а не ретаргета.
 */
function twinSource(): { root: THREE.Object3D; map: Record<string, string> } {
  const H = buildHumanoid();
  const root = new THREE.Object3D(); root.name = 'SrcRoot';
  const made = new Map<string, THREE.Bone>();
  for (const our of OUR_BONES) {
    const g = H.bones.get(our); if (!g) continue;
    const b = new THREE.Bone(); b.name = 's_' + our; b.position.copy(g.position);
    const p = parentOfOur(our); const pb = p ? made.get(p) : undefined;
    (pb ?? root).add(b); made.set(our, b);
  }
  root.updateMatrixWorld(true);
  const map: Record<string, string> = {};
  for (const our of OUR_BONES) if (made.has(our)) map[our] = 's_' + our;
  return { root, map };
}

function source(anims: THREE.AnimationClip[]): BakeSource {
  const { root, map } = twinSource();
  const bake = makeBakeRig(root, map);
  const snap: { o: THREE.Object3D; q: THREE.Quaternion; p: THREE.Vector3 }[] = [];
  root.traverse((o) => snap.push({ o, q: o.quaternion.clone(), p: o.position.clone() }));
  return {
    fileName: 'twin.fbx', root, loaded: root, animations: anims, boneMap: map, bake, signature: 'twin',
    report: { file: 'twin.fbx', animations: anims.map((a) => ({ name: a.name, dur: a.duration, tracks: a.tracks.length })), bones: snap.length, dupNames: [], mapped: [...OUR_BONES], unmapped: [], fingers: 0, tracks: [], restBefore: { arm: '', leg: '' }, restAfter: { arm: '', leg: '' } },
    restore() { for (const s of snap) { s.o.quaternion.copy(s.q); s.o.position.copy(s.p); } root.updateMatrixWorld(true); },
  };
}
/** Позиционная дорожка на кость источника: `from` → `to` за 1 с. */
const posTrack = (bone: string, from: [number, number, number], to: [number, number, number]): THREE.VectorKeyframeTrack =>
  new THREE.VectorKeyframeTrack(`s_${bone}.position`, [0, 1], [...from, ...to]);
/** Дорожка «туда и обратно» — настоящий перенос веса (равномерная подача была бы травелом). */
const posTrackMid = (bone: string, a: [number, number, number], mid: [number, number, number], b: [number, number, number]): THREE.VectorKeyframeTrack =>
  new THREE.VectorKeyframeTrack(`s_${bone}.position`, [0, 0.5, 1], [...a, ...mid, ...b]);
/** Поворот кости источника вокруг оси на угол (рад) за 1 с (с нуля). */
function quatTrack(bone: string, axis: [number, number, number], rad: number): THREE.QuaternionKeyframeTrack {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...axis).normalize(), rad);
  return new THREE.QuaternionKeyframeTrack(`s_${bone}.quaternion`, [0, 1], [0, 0, 0, 1, q.x, q.y, q.z, q.w]);
}
const clipOf = (tracks: THREE.KeyframeTrack[], name = 'a'): THREE.AnimationClip => new THREE.AnimationClip(name, 1, tracks);
// Базовые опции тестов — БЕЗ опоры стоп: каждый блок проверяет СВОЙ канал, а пины включаются
// адресно в своём блоке (иначе «дальше не пущу» честно укорачивает синтетические сдвиги на 6 юнитов).
const OPTS = { character: 'ch', weapon: 'sword', fps: 10, epsDeg: 0, limbLock: { LF: false, RF: false } } as const;
const lastPose = (keys: { pose: Pose }[]): Pose => keys[keys.length - 1]!.pose;

/** Поставить нашу позу в свежий риг и вернуть его — чтобы мерить мировые величины как в игре. */
function rigWith(p: Pose): Humanoid {
  const H = buildHumanoid();
  for (const nm in p) { if (nm[0] === '_') continue; const b = H.bones.get(nm); if (b) b.rotation.set(p[nm]![0], p[nm]![1], p[nm]![2]); }
  const d = hipsOffset(p, H.hipsRest.y);
  if (d) H.hips.position.set(H.hipsRest.x + d[0], H.hipsRest.y + d[1], H.hipsRest.z + d[2]);
  H.root.updateMatrixWorld(true);
  return H;
}
const footY = (H: Humanoid): number => Math.min(
  H.bones.get('LeftFoot')!.getWorldPosition(new THREE.Vector3()).y,
  H.bones.get('RightFoot')!.getWorldPosition(new THREE.Vector3()).y);

describe('clipBaker — таз: перенос веса берём, травел вычитаем', () => {
  const hipsRest = buildHumanoid().hipsRest.clone();

  it('ВЕРТИКАЛЬ (присед) сохраняется', () => {
    const src = source([clipOf([posTrack('Hips', [hipsRest.x, hipsRest.y, hipsRest.z], [hipsRest.x, hipsRest.y - 3, hipsRest.z])])]);
    const r = bakeFromSource(src, { ...OPTS, ground: false });
    expect(hipsOffset(lastPose(r.clip.keys), hipsRest.y)![1]).toBeCloseTo(-3, 1);
  });

  it('ТРАВЕЛ (едет всё тело — таз и стопы вместе) вычитается ПО ПОСТРОЕНИЮ', () => {
    // Стопы — дети таза, поэтому сдвиг таза уносит их с собой: это и есть «бег, который едет вперёд».
    const src = source([clipOf([posTrack('Hips', [hipsRest.x, hipsRest.y, hipsRest.z], [hipsRest.x, hipsRest.y, hipsRest.z + 50])])]);
    const r = bakeFromSource(src, { ...OPTS, ground: false, hips: 'full' });
    expect(hipsOffset(lastPose(r.clip.keys), hipsRest.y)![2]).toBeCloseTo(0, 3);
  });

  it('ПЕРЕНОС ВЕСА (таз ушёл вперёд и вернулся) — остаётся', () => {
    // ⚠ Именно «туда-обратно»: РАВНОМЕРНАЯ подача таза вперёд — это по определению ТРАВЕЛ, и он снимается.
    const src = source([clipOf([posTrackMid('Hips',
      [hipsRest.x, hipsRest.y, hipsRest.z], [hipsRest.x, hipsRest.y, hipsRest.z + 6], [hipsRest.x, hipsRest.y, hipsRest.z])])]);
    const r = bakeFromSource(src, { ...OPTS, ground: false, hips: 'full' });
    const mid = r.clip.keys[Math.floor(r.clip.keys.length / 2)]!.pose;
    expect(hipsOffset(mid, hipsRest.y)![2]).toBeCloseTo(6, 0);
  });

  it('режим «только вертикаль» горизонталь не пишет, «не брать» — не пишет ничего', () => {
    const H = buildHumanoid();
    const lf = H.bones.get('LeftFoot')!.position, rf = H.bones.get('RightFoot')!.position;
    const tracks = [
      posTrack('Hips', [hipsRest.x, hipsRest.y, hipsRest.z], [hipsRest.x, hipsRest.y - 2, hipsRest.z + 6]),
      posTrack('LeftFoot', [lf.x, lf.y, lf.z], [lf.x, lf.y, lf.z - 6]),
      posTrack('RightFoot', [rf.x, rf.y, rf.z], [rf.x, rf.y, rf.z - 6]),
    ];
    const v = hipsOffset(lastPose(bakeFromSource(source([clipOf(tracks)]), { ...OPTS, ground: false, hips: 'vertical' }).clip.keys), hipsRest.y)!;
    expect(v[1]).toBeCloseTo(-2, 1);
    expect(v[2]).toBeCloseTo(0, 5);
    const n = bakeFromSource(source([clipOf(tracks)]), { ...OPTS, ground: false, hips: 'none' });
    expect(hipsOffset(lastPose(n.clip.keys), hipsRest.y)).toBeNull();
  });
});

describe('clipBaker — заземление', () => {
  const hipsRest = buildHumanoid().hipsRest.clone();
  const sunk = (): BakeSource => source([clipOf([posTrack('Hips', [hipsRest.x, hipsRest.y, hipsRest.z], [hipsRest.x, hipsRest.y - 8, hipsRest.z])])]);

  it('без заземления стопы проваливаются под пол', () => {
    const r = bakeFromSource(sunk(), { ...OPTS, ground: false });
    expect(footY(rigWith(lastPose(r.clip.keys)))).toBeLessThan(0);
  });

  it('с заземлением нижняя стопа стоит на полу НА КАЖДОМ кадре', () => {
    const r = bakeFromSource(sunk(), { ...OPTS, ground: true });
    for (const k of r.clip.keys) expect(footY(rigWith(k.pose))).toBeCloseTo(1.5, 3);   // 1.5 = SOLE
  });
});

describe('clipBaker — голова', () => {
  const fwd = (H: Humanoid): THREE.Vector3 =>
    new THREE.Vector3(0, 0, 1).applyQuaternion(H.bones.get('Head')!.getWorldQuaternion(new THREE.Quaternion()));

  it('«из мокапа» — голова смотрит туда, куда её увёл источник', () => {
    const r = bakeFromSource(source([clipOf([quatTrack('Head', [0, 1, 0], 40 * Math.PI / 180)])]), { ...OPTS, head: 'mocap' });
    const f = fwd(rigWith(lastPose(r.clip.keys)));
    expect(Math.atan2(f.x, f.z) * 180 / Math.PI).toBeCloseTo(40, 0);
  });

  it('«зафиксировать на прицел» — голова смотрит ВПЕРЁД, что бы ни делали источник и корпус', () => {
    const r = bakeFromSource(source([clipOf([
      quatTrack('Head', [0, 1, 0], 40 * Math.PI / 180),          // болтанка головы в мокапе
      quatTrack('Spine', [0, 1, 0], 35 * Math.PI / 180),         // + разворот корпуса
      quatTrack('Chest', [1, 0, 0], 25 * Math.PI / 180),         // + нырок корпуса (свинг удара)
    ])]), { ...OPTS, head: 'aim' });
    for (const k of r.clip.keys) {
      const f = fwd(rigWith(k.pose));
      expect(Math.abs(Math.atan2(f.x, f.z)) * 180 / Math.PI).toBeLessThan(0.5);   // рыск — на прицел
      expect(Math.abs(f.y)).toBeLessThan(0.01);                                    // тангаж — на горизонт
    }
  });

  it('запечённая голова НЕ ДРОЖИТ: покадровый шаг взгляда падает в разы', () => {
    const wobble = clipOf([quatTrack('Head', [1, 1, 0], 50 * Math.PI / 180), quatTrack('Chest', [1, 0, 0], 30 * Math.PI / 180)]);
    const step = (head: 'mocap' | 'aim'): number => {
      const keys = bakeFromSource(source([wobble]), { ...OPTS, head }).clip.keys;
      let worst = 0, prev: THREE.Vector3 | null = null;
      for (const k of keys) { const f = fwd(rigWith(k.pose)); if (prev) worst = Math.max(worst, prev.angleTo(f)); prev = f; }
      return worst * 180 / Math.PI;
    };
    expect(step('aim')).toBeLessThan(step('mocap') / 5);
    expect(step('aim')).toBeLessThan(0.5);
  });

  it('доля шеи: погашенный размах ложится НА ДВА сустава, а не только на голову', () => {
    const src = () => source([clipOf([quatTrack('Chest', [1, 0, 0], 45 * Math.PI / 180)])]);
    const p = lastPose(bakeFromSource(src(), { ...OPTS, head: 'aim' }).clip.keys);
    const neck = new THREE.Quaternion().setFromEuler(new THREE.Euler(p['Neck']![0], p['Neck']![1], p['Neck']![2]));
    expect(neck.angleTo(new THREE.Quaternion()) * 180 / Math.PI).toBeGreaterThan(5);   // шея взяла свою долю
  });

  it('«не брать» — головы в клипе нет вовсе', () => {
    const r = bakeFromSource(source([clipOf([quatTrack('Head', [0, 1, 0], 0.5)])]), { ...OPTS, head: 'none' });
    expect(lastPose(r.clip.keys)['Head']).toBeUndefined();
    expect(lastPose(r.clip.keys)['Neck']).toBeUndefined();
  });
});

describe('clipBaker — маска, обрезка, повторное запекание', () => {
  const armAnim = (): THREE.AnimationClip => clipOf([quatTrack('LeftUpperArm', [0, 0, 1], 0.8), quatTrack('LeftUpperLeg', [1, 0, 0], 0.5)]);

  it('маска «верх»: ноги берутся из БАЗОВОЙ позы, а не из мокапа', () => {
    const base: Pose = { LeftUpperLeg: [0.11, 0, 0] };
    const r = bakeFromSource(source([armAnim()]), { ...OPTS, mask: presetMask('upper'), basePose: base, ground: false });
    const p = lastPose(r.clip.keys);
    expect(p['LeftUpperLeg']![0]).toBeCloseTo(0.11, 5);        // из базовой позы
    expect(Math.abs(p['LeftUpperArm']![2])).toBeGreaterThan(0.5);   // рука — из мокапа
  });

  it('по-костный вес (Blend Mask) смешивает мокап с базой', () => {
    const base: Pose = { LeftUpperArm: [0, 0, 0] };
    const half: BoneMask = { parts: presetMask('upper').parts, weights: { LeftUpperArm: 0.5 } };
    const full = lastPose(bakeFromSource(source([armAnim()]), { ...OPTS, mask: presetMask('upper'), basePose: base, ground: false }).clip.keys);
    const mid = lastPose(bakeFromSource(source([armAnim()]), { ...OPTS, mask: half, basePose: base, ground: false }).clip.keys);
    expect(Math.abs(mid['LeftUpperArm']![2])).toBeCloseTo(Math.abs(full['LeftUpperArm']![2]) / 2, 1);
  });

  it('обрезка по исходнику режет окно семплирования', () => {
    const all = bakeFromSource(source([armAnim()]), { ...OPTS, ground: false });
    const cut = bakeFromSource(source([armAnim()]), { ...OPTS, ground: false, startSec: 0.25, endSec: 0.75 });
    expect(cut.frames).toBeLessThan(all.frames);
    expect(cut.clip.keys[0]!.t).toBe(0);                                              // время съехало к нулю
    expect(Math.abs(lastPose(cut.clip.keys)['LeftUpperArm']![2])).toBeLessThan(Math.abs(lastPose(all.clip.keys)['LeftUpperArm']![2]));
  });

  it('ПОВТОРНОЕ запекание того же источника даёт ТОТ ЖЕ клип (хвост прошлого прогона не течёт)', () => {
    // Регрессия: `enforceTPose` пишет локальные повороты, а микшер перетирает только кости С ДОРОЖКАМИ —
    // без `restore()` второй прогон стартовал бы с последнего кадра первого.
    const src = source([armAnim()]);
    const a = bakeFromSource(src, { ...OPTS, ground: false });
    const b = bakeFromSource(src, { ...OPTS, ground: false });
    expect(JSON.stringify(b.clip.keys)).toBe(JSON.stringify(a.clip.keys));
  });

  it('смена анимации не тащит позу предыдущей', () => {
    const src = source([armAnim(), clipOf([quatTrack('RightUpperArm', [0, 0, 1], 0.6)], 'b')]);
    const first = bakeFromSource(src, { ...OPTS, ground: false, animationIndex: 0 });
    bakeFromSource(src, { ...OPTS, ground: false, animationIndex: 1 });
    const again = bakeFromSource(src, { ...OPTS, ground: false, animationIndex: 0 });
    expect(JSON.stringify(again.clip.keys)).toBe(JSON.stringify(first.clip.keys));
  });
});

describe('clipBaker — вес части, перенос веса и опора стоп', () => {
  const hipsRest = buildHumanoid().hipsRest.clone();
  /**
  * Мокап ПЕРЕНОСА ВЕСА: таз подаётся вперёд-вниз, а стопы В МИРЕ СТОЯТ (в источнике они дети таза,
  * поэтому их локальную позицию приходится отыгрывать назад). Без этого получился бы ТРАВЕЛ —
  * он вычитается по построению, и Z-канала в клипе просто не будет.
  */
  const shift = (): BakeSource => source([clipOf([posTrackMid('Hips',
    [hipsRest.x, hipsRest.y, hipsRest.z], [hipsRest.x, hipsRest.y - 1.5, hipsRest.z + 4], [hipsRest.x, hipsRest.y, hipsRest.z])])]);
  /** Кадр максимума переноса веса — середина клипа. */
  const midPose = (keys: { pose: Pose }[]): Pose => keys[Math.floor(keys.length / 2)]!.pose;
  const footPos = (p: Pose, side: 'Left' | 'Right'): THREE.Vector3 =>
    rigWith(p).bones.get(side + 'Foot')!.getWorldPosition(new THREE.Vector3());
  const hipsZ = (p: Pose): number => hipsOffset(p, hipsRest.y)?.[2] ?? 0;

  it('ТАЗ ЕЗДИТ ПРИ МАСКЕ «ВЕРХ» — раньше канала не было вовсе', () => {
    // Часть маски «таз» — это ПОВОРОТ кости Hips; смещение (`__hipsD`) это ОТДЕЛЬНЫЙ канал.
    const r = bakeFromSource(shift(), { ...OPTS, mask: presetMask('upper'), basePose: {}, ground: false });
    expect(hipsZ(midPose(r.clip.keys))).toBeCloseTo(4, 0);
  });

  it('СИЛА ПЕРЕНОСА ВЕСА линейна, 0 = канала нет', () => {
    const at = (w: number): number => hipsZ(midPose(bakeFromSource(shift(), { ...OPTS, hipsWeight: w, ground: false }).clip.keys));
    expect(at(1)).toBeCloseTo(4, 0);
    expect(at(0.5)).toBeCloseTo(2, 0);
    expect(at(0)).toBeCloseTo(0, 3);
  });

  it('ОПОРА СТОП: таз подался, а стопы стоят (это и есть перенос веса)', () => {
    const free = bakeFromSource(shift(), { ...OPTS, ground: false });
    // Стойка с чуть согнутыми коленями — как любая авторская idle; на прямых ногах слабины нет вовсе.
    const stance: Pose = { LeftUpperLeg: [-0.35, 0, 0], LeftLowerLeg: [0.7, 0, 0], LeftFoot: [-0.35, 0, 0],
      RightUpperLeg: [-0.35, 0, 0], RightLowerLeg: [0.7, 0, 0], RightFoot: [-0.35, 0, 0] };
    const held = bakeFromSource(shift(), { ...OPTS, limbLock: { LF: true, RF: true }, lockWeight: 1, ground: false,
      mask: presetMask('upper'), basePose: stance });                    // ноги из базовой позы → вес ноги 0
    const p0 = footPos(free.clip.keys[0]!.pose, 'Left');
    expect(footPos(midPose(free.clip.keys), 'Left').distanceTo(p0)).toBeGreaterThan(3);   // без опоры уехала за тазом
    expect(footPos(midPose(held.clip.keys), 'Left').distanceTo(footPos(held.clip.keys[0]!.pose, 'Left'))).toBeLessThan(0.3);
    expect(hipsZ(midPose(held.clip.keys))).toBeGreaterThan(3);          // при этом таз всё равно проехал
  });

  it('ИНВАРИАНТ NO-OP: всё из мокапа + вес таза 1 → пины ничего не меняют', () => {
    // Ноги взяты на 100 %, значит смещение таза им «принадлежит» целиком: опорная поза = финальная.
    const a = bakeFromSource(shift(), { ...OPTS, ground: false });
    const b = bakeFromSource(shift(), { ...OPTS, ground: false, limbLock: { LF: true, RF: true } });
    expect(JSON.stringify(b.clip.keys)).toBe(JSON.stringify(a.clip.keys));
  });

  it('ВЕС ЧАСТИ 0.5 даёт позу РОВНО ПОСЕРЕДИНЕ между базовой и мокапом', () => {
    const base: Pose = { RightUpperArm: [0, 0, 0] };
    const anim = (): BakeSource => source([clipOf([quatTrack('RightUpperArm', [0, 0, 1], 1.0)])]);
    const at = (w: number): number => {
      const m = setPartWeight(presetMask('noFingers'), 'armR', w);
      return Math.abs(lastPose(bakeFromSource(anim(), { ...OPTS, mask: m, basePose: base, ground: false }).clip.keys)['RightUpperArm']![2]);
    };
    const full = at(1);
    expect(at(0)).toBeCloseTo(0, 5);
    expect(at(0.5)).toBeCloseTo(full / 2, 1);
    expect(at(1)).toBeCloseTo(full, 5);
  });

  it('срыв опоры и размах таза попадают в статистику (панель их показывает)', () => {
    const r = bakeFromSource(shift(), { ...OPTS, ground: false, limbLock: { LF: true, RF: true } });
    expect(r.stats.hipsRange![2]).toBeGreaterThan(3);
    expect(r.stats.footMiss).toBeLessThan(0.5);
  });
});

describe('clipBaker — опора держит конечность в МИРЕ, а не относительно корпуса (Ф11)', () => {
  const hipsRest = buildHumanoid().hipsRest.clone();
  /** Стойка с согнутыми коленями и опущенными руками — как любая авторская idle. */
  const stance: Pose = {
    LeftUpperLeg: [-0.35, 0, 0], LeftLowerLeg: [0.7, 0, 0], LeftFoot: [-0.35, 0, 0],
    RightUpperLeg: [-0.35, 0, 0], RightLowerLeg: [0.7, 0, 0], RightFoot: [-0.35, 0, 0],
    LeftUpperArm: [0, 0, 0.5], LeftLowerArm: [0, -0.6, 0],
    RightUpperArm: [0, 0, -0.5], RightLowerArm: [0, 0.6, 0],
  };
  const end = (p: Pose, bone: string): THREE.Vector3 =>
    rigWith(p).bones.get(bone)!.getWorldPosition(new THREE.Vector3());
  /** Максимальный ход конца по кадрам клипа. */
  const drift = (keys: { pose: Pose }[], bone: string): number => {
    const p0 = end(keys[0]!.pose, bone);
    return +Math.max(...keys.map((k) => end(k.pose, bone).distanceTo(p0))).toFixed(2);
  };

  it('ЖАЛОБА 1: таз ВРАЩАЕТСЯ из мокапа, а припиненные стопы стоят', () => {
    // Раньше цель пина снималась с позы, куда уже положен мокап-поворот `Hips`, а стопы — его потомки:
    // пин держал стопу ОТНОСИТЕЛЬНО ВРАЩАЮЩЕГОСЯ ТАЗА, то есть она честно ездила по кругу.
    const src = (): BakeSource => source([clipOf([quatTrack('Hips', [0, 1, 0], 0.7)])]);
    const mask = setPartWeight(presetMask('upper'), 'hips', 1);        // таз В МАСКЕ → его поворот в клипе есть
    const O2 = { ...OPTS, mask, basePose: stance, ground: false };
    const free = bakeFromSource(src(), { ...O2, limbLock: { LF: false, RF: false } });
    const held = bakeFromSource(src(), { ...O2, limbLock: { LF: true, RF: true } });
    expect(drift(free.clip.keys, 'LeftFoot')).toBeGreaterThan(2);      // без опоры стопа ездит за тазом
    expect(drift(held.clip.keys, 'LeftFoot')).toBeLessThan(0.3);       // с опорой — стоит
    // и поворот таза при этом НИКУДА не делся — его же и просили
    expect(Math.abs(lastPose(held.clip.keys)['Hips']![1])).toBeGreaterThan(0.5);
  });

  it('ЖАЛОБА 2: вес руки 0 + пин кисти — кисть стоит, пока корпус скручивается', () => {
    const src = (): BakeSource => source([clipOf([quatTrack('Spine', [0, 1, 0], 0.4), quatTrack('Chest', [0, 1, 0], 0.3)])]);
    const mask = setPartWeight(presetMask('noFingers'), 'armR', 0);    // рука ЦЕЛИКОМ из стойки
    const O2 = { ...OPTS, mask, basePose: stance, ground: false };
    const free = bakeFromSource(src(), { ...O2, limbLock: { LF: false, RF: false } });
    const held = bakeFromSource(src(), { ...O2, limbLock: { LF: false, RF: false, RH: true } });
    expect(drift(free.clip.keys, 'RightHand')).toBeGreaterThan(2);     // без пина кисть уезжает со скруткой
    expect(drift(held.clip.keys, 'RightHand')).toBeLessThan(0.4);      // с пином — держится за ручку
  });

  it('ИНВАРИАНТ NO-OP для РУКИ: вес руки 1 → пин кисти ничего не меняет', () => {
    const src = (): BakeSource => source([clipOf([quatTrack('Spine', [0, 1, 0], 0.4), quatTrack('RightUpperArm', [0, 0, 1], 0.8)])]);
    const O2 = { ...OPTS, basePose: stance, ground: false };
    const a = bakeFromSource(src(), { ...O2, limbLock: { LF: false, RF: false } });
    const b = bakeFromSource(src(), { ...O2, limbLock: { LF: false, RF: false, RH: true } });
    expect(JSON.stringify(b.clip.keys)).toBe(JSON.stringify(a.clip.keys));
  });

  it('промежуточный вес руки: чем меньше вес, тем ближе кисть к своей ручке', () => {
    const src = (): BakeSource => source([clipOf([quatTrack('Spine', [0, 1, 0], 0.4), quatTrack('Chest', [0, 1, 0], 0.3)])]);
    const at = (w: number): number => {
      const mask = setPartWeight(presetMask('noFingers'), 'armR', w);
      const r = bakeFromSource(src(), { ...OPTS, mask, basePose: stance, ground: false, limbLock: { LF: false, RF: false, RH: true } });
      return drift(r.clip.keys, 'RightHand');
    };
    expect(at(0)).toBeLessThan(at(0.5));
    expect(at(0.5)).toBeLessThan(at(1));
  });
});

/**
 * ⭐ КОРЕНЬ: ПОВОРОТ МОКАПА (`rootYaw`) — ОБРАТНАЯ КОМПОЗИЦИЯ ИГРЫ (ревью 17.09, `pelvisFrame.ts`).
 *
 * Игра и шарнир редактора кладут таз клипа на курс `старт + __rootY` жёстким поворотом: `Ry(курс)·таз`, X/Z `__hipsD` тоже.
 * Импорт снимает курс ровно обратным ходом. ⚠ Было: курс — слот Y эйлера (разбор XYZ держит его в [−90°, 90°], разворот за
 * 90° отражался и копился не туда) и вычет в том же слоте (с наклоном таза поворот ложился мимо), а перенос веса оставался в
 * мировых осях мокапа.
 */
describe('clipBaker — корень: поворот мокапа снимается обратной композицией игры', () => {
  const hipsRest = buildHumanoid().hipsRest.clone();
  const D = Math.PI / 180, UP = new THREE.Vector3(0, 1, 0);
  const TILT = new THREE.Quaternion().setFromEuler(new THREE.Euler(15 * D, 0, 0));
  const at = (yawDeg: number): THREE.Quaternion => new THREE.Quaternion().setFromAxisAngle(UP, yawDeg * D).multiply(TILT);
  /** Таз мокапа: разворот 0 → 170° с постоянным наклоном вперёд 15°, и перенос веса по МИРОВОЙ X туда-обратно (пик на 90°). */
  const turning = (): BakeSource => {
    const qs = [0, 60, 120, 170].map(at);
    const rot = new THREE.QuaternionKeyframeTrack('s_Hips.quaternion', [0, 1 / 3, 2 / 3, 1], qs.flatMap((q) => [q.x, q.y, q.z, q.w]));
    const pos = posTrackMid('Hips', [hipsRest.x, hipsRest.y, hipsRest.z], [hipsRest.x + 3, hipsRest.y, hipsRest.z], [hipsRest.x, hipsRest.y, hipsRest.z]);
    return source([clipOf([rot, pos])]);
  };
  const yawAtT = (t: number): number => (t <= 2 / 3 ? t * 180 : 120 + (t - 2 / 3) * 150);

  it('⭐ разворот 170° с наклоном таза: `__rootY` накоплен целиком, `Ry(__rootY)·таз клипа` = таз мокапа, в клипе — только наклон', () => {
    const keys = bakeFromSource(turning(), { ...OPTS, ground: false, hips: 'full', rootYaw: true }).clip.keys;
    let worst = 0;
    for (const k of keys) {
      const ry = k.pose['__rootY']![0], h = k.pose['Hips']!;
      expect(ry / D, `t ${k.t}`).toBeCloseTo(yawAtT(k.t), 1);
      const world = new THREE.Quaternion().setFromAxisAngle(UP, ry).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(h[0], h[1], h[2])));
      worst = Math.max(worst, world.angleTo(at(yawAtT(k.t))) / D, new THREE.Quaternion().setFromEuler(new THREE.Euler(h[0], h[1], h[2])).angleTo(TILT) / D);
    }
    expect(keys.at(-1)!.pose['__rootY']![0] / D, 'поворот за 90° не отражён').toBeCloseTo(170, 1);
    expect(worst, 'чтение позы округлено до 1e-3 рад').toBeLessThan(0.2);
  });

  it('перенос веса по мировой X на курсе 90° ложится в клип ВПЕРЁД персонажа (кадр персонажа), а не вбок', () => {
    const keys = bakeFromSource(turning(), { ...OPTS, ground: false, hips: 'full', rootYaw: true }).clip.keys;
    const mid = keys.find((k) => Math.abs(k.t - 0.5) < 1e-6)!;
    const d = hipsOffset(mid.pose, hipsRest.y)!;
    expect(mid.pose['__rootY']![0] / D).toBeCloseTo(90, 1);
    expect(d[2], 'вперёд').toBeCloseTo(3, 2);
    expect(d[0], 'не вбок').toBeCloseTo(0, 2);
    // без корня клип остаётся в осях мокапа, как был: курс в тазу, перенос по X
    const plain = bakeFromSource(turning(), { ...OPTS, ground: false, hips: 'full' }).clip.keys.find((k) => Math.abs(k.t - 0.5) < 1e-6)!;
    expect(hipsOffset(plain.pose, hipsRest.y)![0]).toBeCloseTo(3, 2);
  });

  /**
   * ⚠ НОКДАУН И ПОДЪЁМ: таз ПРОХОДИТ ВЕРТИКАЛЬ при постоянном курсе. Голый `atan2` вектора «вперёд» отражал курс на
   * 180° (см. `pelvisFrame.pelvisHeading`) — и накопитель писал разворот из ниоткуда. Сторож на САМ `__rootY`:
   * `Ry(__rootY)·таз клипа` = таз мокапа держится и с отражением (180° уходят в кость таза), эту беду он не видит.
   */
  it('⭐ падение ничком 0 → 120° при постоянном курсе: `__rootY` остаётся нулём (отражения на 180° нет)', () => {
    const fall = (from: number, to: number): BakeSource => {
      const qs = [from, (from + to) / 2, to].map((pitch) => new THREE.Quaternion().setFromAxisAngle(UP, 20 * D)
        .multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch * D, 0, 0))));
      return source([clipOf([new THREE.QuaternionKeyframeTrack('s_Hips.quaternion', [0, 0.5, 1], qs.flatMap((q) => [q.x, q.y, q.z, q.w]))])]);
    };
    for (const [from, to] of [[0, 120], [120, 0], [0, 95], [0, -120]] as const) {
      const keys = bakeFromSource(fall(from, to), { ...OPTS, ground: false, hips: 'full', rootYaw: true }).clip.keys;
      for (const k of keys) expect(Math.abs(k.pose['__rootY']![0] / D), `наклон ${from} → ${to}°, t ${k.t}`).toBeLessThan(0.5);
    }
  });
});

/**
 * ⚠⚠ ГРАНИЦА КЛИПА. Умолчание `AnimationAction` — `LoopRepeat`, и `setTime(duration)` на нём отдаёт КАДР 0.
 *
 * Беда была МОЛЧАЛИВОЙ и зависела от арифметики: последний семпл упирается ровно в `duration` только когда
 * накопление `t += 1/fps` перелетает длину. На клипе 1 с так ведёт себя РОВНО fps 60 (1.0000000000000013),
 * а 10/30/120 не доходят до 1.0 — поэтому тесты этого файла (fps 10) беду не видели, а мокап на 60 ловил её
 * каждый раз. Последствие: `detrendTravel` строит тренд по линии «первый ↔ последний кадр», они становились
 * ОДНИМ кадром → наклон 0 → перенос персонажа оставался в канале переноса ВЕСА.
 * Замер на Kubold `WalkFwdLoop`: размах таза по Z 54.79 ед (1.71 м травела) и `__rootP` из нулей.
 */
describe('clipBaker — граница клипа: последний семпл это КОНЕЦ, а не начало', () => {
  const hipsRest = buildHumanoid().hipsRest.clone();

  it('⭐⭐ СЕМПЛ РОВНО НА `duration` ДАЁТ ПОЗУ КОНЦА', () => {
    // Время задано явно (`startSec = endSec = dur`) → от накопления `t += dt` тест не зависит вовсе.
    const src = source([clipOf([posTrack('Hips',
      [hipsRest.x, hipsRest.y, hipsRest.z], [hipsRest.x, hipsRest.y - 3, hipsRest.z])])]);
    const r = bakeFromSource(src, { ...OPTS, ground: false, startSec: 1, endSec: 1 });
    expect(r.clip.keys.length).toBe(1);
    expect(hipsOffset(r.clip.keys[0]!.pose, hipsRest.y)![1],
      '⚠ миксер отдал кадр 0 вместо конца: действию вернули `LoopRepeat`').toBeCloseTo(-3, 1);
  });

  it('⭐⭐ ТРАВЕЛ УХОДИТ В `__rootP`, А НЕ В ПЕРЕНОС ВЕСА — на том самом fps 60', () => {
    const src = source([clipOf([posTrack('Hips',
      [hipsRest.x, hipsRest.y, hipsRest.z], [hipsRest.x, hipsRest.y, hipsRest.z + 50])])]);
    const r = bakeFromSource(src, { ...OPTS, fps: 60, ground: false, hips: 'full', rootPos: true });
    const k = r.clip.keys;
    // Меряем СЕРЕДИНУ: на конце заворот делает обе величины нулевыми и по нему беду не отличить.
    const mid = k[k.length >> 1]!;
    expect(mid.t).toBeCloseTo(0.5, 2);
    expect(mid.pose['__rootP']![2], '⚠ перенос персонажа не попал в канал корня').toBeCloseTo(25, 0);
    expect(hipsOffset(mid.pose, hipsRest.y)![2],
      '⚠ травел остался в переносе веса — в игре таз уезжал бы вперёд от стоп').toBeCloseTo(0, 1);
  });
});

/**
 * ⭐⭐ МОКАП-ХОД ОБЯЗАН ПОПАДАТЬ В НАБОР ПОЛНОЦЕННЫМ.
 *
 * Метаданные набора (`bakeSpeed`/`bakeRev`/`upperPure`/`swingRef`) писал ТОЛЬКО процедурный запекатель, и потому
 * любой импортированный ход молча становился легаси: `bakedLocoSpeed` подставляла ему 50.4 / 102 u/с ПО ИМЕНИ,
 * то есть часы клипа шли по чужой скорости. У мокапа скорость есть настоящая — она в травеле источника.
 */
describe('clipBaker — метаданные набора хода', () => {
  const hipsRest = buildHumanoid().hipsRest.clone();
  /** Источник, едущий вперёд на `dz` за 1 с — то же, чем мокап отличается от нашего in-place клипа. */
  const moving = (dz: number): BakeSource => source([clipOf([posTrack('Hips',
    [hipsRest.x, hipsRest.y, hipsRest.z], [hipsRest.x, hipsRest.y, hipsRest.z + dz])])]);
  const LOCO = { ...OPTS, fps: 30, ground: false, hips: 'full', loop: true, locoSet: true } as const;

  it('⭐⭐ СКОРОСТЬ СЪЁМА ЗАМЕРЯЕТСЯ ПО ТРАВЕЛУ, а не берётся из имени', () => {
    // Два источника, отличающиеся ТОЛЬКО пройденным путём, обязаны дать разные числа — иначе «замер» фиктивный.
    expect(bakeFromSource(moving(50), LOCO).clip.bakeSpeed, 'путь 50 ед за 1 с').toBeCloseTo(50, 0);
    expect(bakeFromSource(moving(100), LOCO).clip.bakeSpeed, 'путь 100 ед за 1 с').toBeCloseTo(100, 0);
    expect(bakeFromSource(moving(50), LOCO).stats.locoSpeed, 'то же число видно в панели').toBeCloseTo(50, 0);
  });

  it('⭐ и остальной набор метаданных при этом на месте', () => {
    const c = bakeFromSource(moving(50), LOCO).clip;
    expect(c.bakeRev, 'ревизия набора').toBe(LOCO_BAKE_REV);
    expect(c.upperPure, 'руки пришли из мокапа целиком').toBe(true);
    expect(c.swingRef?.['RightUpperArm'], 'нейтраль маха посчитана').toBeTruthy();
    expect(bakeFromSource(moving(50), { ...LOCO, bakeId: 20260927 }).clip.bakeId).toBe(20260927);
  });

  it('⚠ БЕЗ ГАЛКИ НАБОРА не пишется НИЧЕГО: прежний импорт не должен обрасти полями', () => {
    const c = bakeFromSource(moving(50), { ...LOCO, locoSet: false }).clip;
    expect(c.bakeSpeed).toBeUndefined();
    expect(c.bakeRev).toBeUndefined();
    expect(c.upperPure).toBeUndefined();
    expect(c.swingRef).toBeUndefined();
  });

  it('⭐⭐ НЕЦИКЛИЧНЫЙ ТЕЙК (старт/остановка) поля темпа НЕ получает — там это средняя по разгону', () => {
    const r = bakeFromSource(moving(50), { ...LOCO, loop: false });
    expect(r.clip.bakeSpeed, '⚠ средняя по разгону встала бы в поле темпа цикла').toBeUndefined();
    expect(r.clip.bakeRev).toBeUndefined();
    expect(r.stats.locoSpeed, 'но замер всё равно показан в панели').toBeCloseTo(50, 0);
  });

  it('⚠ СТОЯЩИЙ ИСТОЧНИК скорости не получает — иначе idle встал бы в набор с выдуманным темпом', () => {
    const still = source([clipOf([posTrack('Hips',
      [hipsRest.x, hipsRest.y, hipsRest.z], [hipsRest.x, hipsRest.y - 2, hipsRest.z])])]);   // только присед
    const r = bakeFromSource(still, LOCO);
    expect(r.clip.bakeSpeed, '⚠ вертикаль — не travel').toBeUndefined();
    expect(r.clip.bakeRev).toBeUndefined();
  });

  /**
   * ⚠ ФЛАГ «ЧИСТЫЙ ВЕРХ» — УТВЕРЖДЕНИЕ О ДАННЫХ, а не галочка режима. Взяли руки из базовой позы (то есть из
   * СТОЙКИ) — значит стойка в руках уже есть, и написать `upperPure` значило бы соврать: рантайм применил бы её
   * вторично. На этой грабле проект уже стоял (0.2 × 0.5 = 10 % маха), поэтому флага просто нет, а панель говорит.
   */
  it('⭐⭐ РУКИ НЕ ИЗ МОКАПА → `upperPure` НЕ ПИШЕТСЯ, и панель это показывает', () => {
    const noArms: BoneMask = setPartWeight(setPartWeight(presetMask('noFingers'), 'armL', 0), 'armR', 0);
    const r = bakeFromSource(moving(50), { ...LOCO, mask: noArms, basePose: {} });
    expect(r.clip.bakeSpeed, 'скорость съёма при этом замерена — она про ноги').toBeCloseTo(50, 0);
    expect(r.clip.upperPure, '⚠ флаг чистоты верха соврал бы').toBeUndefined();
    expect(r.stats.upperDirty, 'панель обязана сказать, почему флага нет').toBe(true);
  });
});

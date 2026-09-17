import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  blendTwo, clipPoseAt, clipSegmentAt, clipDur, isAngleKey, easeU, cubicBezier,
  slerpEuler, shortDelta, mirrorSide, flipPose, migrateClip, migratePose,
  EASE_INOUT, hipsOffset, setHipsOffset, normalizeClipHips, carryMarks, type Clip, type Pose, type Keyframe,
} from './clipModel.js';
import { flipClip, mirrorClip } from './poseLibrary.js';

const P = (o: Record<string, [number, number, number]>): Pose => o;
const clip = (keys: Keyframe[]): Clip => ({ name: 'c', character: 'x', weapon: 'sword', loop: false, keys });
const near = (a: number, b: number, eps = 1e-6): void => { expect(Math.abs(a - b)).toBeLessThan(eps); };

describe('clipModel — классификация ключей', () => {
  it('кости — повороты, спец-ключи по списку', () => {
    expect(isAngleKey('LeftUpperArm')).toBe(true);
    expect(isAngleKey('Hips')).toBe(true);
    expect(isAngleKey('__wpnMain')).toBe(true);
    expect(isAngleKey('__wpnOff')).toBe(true);
    expect(isAngleKey('__lgripR')).toBe(true);
    // позиции и скаляры — линейно
    expect(isAngleKey('__wpnMainP')).toBe(false);
    expect(isAngleKey('__lgripP')).toBe(false);
    expect(isAngleKey('__hipsP')).toBe(false);
    expect(isAngleKey('__match')).toBe(false);
    expect(isAngleKey('__pinKp')).toBe(false);
  });
});

describe('clipModel — blendTwo (регресс к прежнему поведению)', () => {
  it('повороты идут slerp\'ом, а не покомпонентным лерпом', () => {
    const a = P({ LeftUpperArm: [0, 0, 0] });
    const b = P({ LeftUpperArm: [Math.PI / 2, Math.PI / 2, 0] });
    const out = blendTwo(a, b, 0.5)['LeftUpperArm']!;
    // эталон: тот же slerp напрямую
    const q = slerpEuler(new THREE.Quaternion(), [0, 0, 0], [Math.PI / 2, Math.PI / 2, 0], 0.5);
    const e = new THREE.Euler().setFromQuaternion(q);
    near(out[0], e.x); near(out[1], e.y); near(out[2], e.z);
    // и это НЕ покомпонентный лерп
    expect(Math.abs(out[1] - Math.PI / 4)).toBeGreaterThan(1e-3);
  });

  it('скаляры и позиции — строго линейно (важно: __pinKp бывает 12000)', () => {
    const a = P({ __pinKp: [4200, 0, 0], __hipsP: [0, 32, 0] });
    const b = P({ __pinKp: [12000, 0, 0], __hipsP: [4, 30, -2] });
    const out = blendTwo(a, b, 0.25);
    near(out['__pinKp']![0], 4200 + (12000 - 4200) * 0.25);
    near(out['__hipsP']![0], 1); near(out['__hipsP']![1], 31.5); near(out['__hipsP']![2], -0.5);
  });

  it('union ключей: кость, которой нет во второй позе, тянется к нулю', () => {
    const out = blendTwo(P({ Spine: [1, 0, 0] }), P({}), 1);
    near(out['Spine']![0], 0);
  });
});

describe('clipModel — кривые интерполяции', () => {
  it('нет interp → фаза не меняется (старые клипы ведут себя как раньше)', () => {
    for (const u of [0, 0.13, 0.5, 0.87, 1]) near(easeU(undefined, u), u);
    for (const u of [0, 0.3, 1]) near(easeU({ pose: {}, t: 0 }, u), u);
    for (const u of [0, 0.3, 1]) near(easeU({ pose: {}, t: 0, interp: 'linear' }, u), u);
    for (const u of [0, 0.3, 1]) near(easeU({ pose: {}, t: 0, interp: 'fixed' }, u), u);
  });

  it('step держит позу ключа до следующего', () => {
    for (const u of [0, 0.5, 0.99]) near(easeU({ pose: {}, t: 0, interp: 'step' }, u), 0);
    near(easeU({ pose: {}, t: 0, interp: 'step' }, 1), 1);   // ровно на следующем ключе — переключение
  });

  it('ease: концы закреплены, симметричная кривая даёт 0.5 в середине, монотонна', () => {
    const k: Keyframe = { pose: {}, t: 0, interp: 'ease', ease: EASE_INOUT };
    near(easeU(k, 0), 0); near(easeU(k, 1), 1);
    near(easeU(k, 0.5), 0.5, 1e-4);
    let prev = -1;
    for (let i = 0; i <= 20; i++) { const v = easeU(k, i / 20); expect(v).toBeGreaterThanOrEqual(prev - 1e-9); prev = v; }
  });

  it('cubicBezier совпадает с CSS ease на контрольных точках', () => {
    // css ease = cubic-bezier(0.25, 0.1, 0.25, 1)
    near(cubicBezier(0.25, 0.1, 0.25, 1, 0), 0);
    near(cubicBezier(0.25, 0.1, 0.25, 1, 1), 1);
    near(cubicBezier(0.25, 0.1, 0.25, 1, 0.5), 0.8024, 2e-3);   // известное значение css ease в середине
  });

  it('вырожденные ручки не роняют солвер (фолбэк-бисекция)', () => {
    for (const u of [0.1, 0.5, 0.9]) {
      const v = cubicBezier(0, 0, 0, 0, u);
      expect(Number.isFinite(v)).toBe(true); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('clipModel — clipPoseAt / clipSegmentAt', () => {
  const c = clip([
    { pose: P({ Spine: [0, 0, 0] }), t: 0 },
    { pose: P({ Spine: [1, 0, 0] }), t: 1 },
    { pose: P({ Spine: [0, 0, 0] }), t: 2 },
  ]);

  it('clipDur = время последнего ключа', () => { near(clipDur(c), 2); });

  it('без interp результат идентичен прямому blendTwo (регресс)', () => {
    const got = clipPoseAt(c, 0.25)['Spine']!;              // время 0.5 → середина первого интервала
    const want = blendTwo(c.keys[0]!.pose, c.keys[1]!.pose, 0.5)['Spine']!;
    near(got[0], want[0]);
  });

  it('выбирает правильный интервал и фазу', () => {
    const s1 = clipSegmentAt(c, 0.5)!; expect(s1.i).toBe(0); near(s1.u, 0.5);
    const s2 = clipSegmentAt(c, 1.75)!; expect(s2.i).toBe(1); near(s2.u, 0.75);
  });

  it('время за пределами клипа зажимается', () => {
    const lo = clipSegmentAt(c, -5)!; expect(lo.i).toBe(0); near(lo.u, 0);
    const hi = clipSegmentAt(c, 99)!; expect(hi.i).toBe(1); near(hi.u, 1);
  });

  it('клип из одного ключа отдаёт его позу', () => {
    const one = clip([{ pose: P({ Spine: [0.7, 0, 0] }), t: 0 }]);
    near(clipPoseAt(one, 0.5)['Spine']![0], 0.7);
  });

  it('пустой клип отдаёт пустую позу', () => { expect(clipPoseAt(clip([]), 0.5)).toEqual({}); });

  it('interp=step на первом ключе держит его позу весь интервал', () => {
    const st = clip([
      { pose: P({ Spine: [0, 0, 0] }), t: 0, interp: 'step' },
      { pose: P({ Spine: [1, 0, 0] }), t: 1 },
    ]);
    near(clipPoseAt(st, 0.99)['Spine']![0], 0);
    near(clipPoseAt(st, 1)['Spine']![0], 1);
  });
});

describe('clipModel — зеркало и переворот', () => {
  const p = P({
    Hips: [0.1, 0.2, 0.3],
    LeftUpperArm: [1, 0.5, -0.25],
    RightUpperArm: [0, 0, 0],
    __hipsP: [3, 32, -1],
    __pinKp: [6000, 0, 0],
  });

  it('mirrorSide копирует левую сторону на правую с отражением y/z', () => {
    const m = mirrorSide(p, 'Left');
    expect(m['RightUpperArm']).toEqual([1, -0.5, 0.25]);
    expect(m['LeftUpperArm']).toEqual([1, 0.5, -0.25]);   // источник не тронут
    expect(m['Hips']).toEqual([0.1, 0.2, 0.3]);           // центральные не трогаем
  });

  it('flipPose меняет стороны местами и отражает центр', () => {
    const f = flipPose(p);
    expect(f['RightUpperArm']).toEqual([1, -0.5, 0.25]);
    expect(f['LeftUpperArm']).toEqual([0, -0, -0]);
    expect(f['Hips']).toEqual([0.1, -0.2, -0.3]);
    expect(f['__hipsP']).toEqual([-3, 32, -1]);            // позиция — зеркало по X
    expect(f['__pinKp']).toEqual([6000, 0, 0]);            // скаляр не трогаем
  });

  it('flipPose дважды = тождество', () => {
    const back = flipPose(flipPose(p));
    for (const k in p) for (let i = 0; i < 3; i++) near(back[k]![i]!, p[k]![i]!);
  });
});

describe('clipModel — миграции', () => {
  it('старый формат (массив поз без времени) → кадры с шагом DEF_GAP', () => {
    const c = migrateClip({ name: 'x', character: 'a', weapon: 'sword', keys: [{ Spine: [0, 0, 0] }, { Spine: [1, 0, 0] }] });
    expect(c.keys.length).toBe(2);
    near(c.keys[0]!.t, 0); near(c.keys[1]!.t, 0.3);
    expect(c.loop).toBe(false);
  });

  it('__hipsY → __hipsP (X/Z нулями), старый ключ удаляется', () => {
    const p: Pose = { __hipsY: [31.5, 0, 0] };
    migratePose(p);
    expect(p['__hipsY']).toBeUndefined();
    expect(p['__hipsP']).toEqual([0, 31.5, 0]);
  });

  it('если __hipsP уже есть — он выигрывает', () => {
    const p: Pose = { __hipsY: [31.5, 0, 0], __hipsP: [2, 30, 1] };
    migratePose(p);
    expect(p['__hipsP']).toEqual([2, 30, 1]);
    expect(p['__hipsY']).toBeUndefined();
  });

  it('новый формат проходит без изменений', () => {
    const c = migrateClip({ name: 'x', character: 'a', weapon: 'sword', loop: true, keys: [{ pose: { Spine: [0, 0, 0] }, t: 0.4 }] });
    near(c.keys[0]!.t, 0.4); expect(c.loop).toBe(true);
  });
});

describe('clipModel — углы', () => {
  it('shortDelta берёт короткую дугу через ±π', () => {
    near(shortDelta(3.0, -3.0), -3.0 - 3.0 + Math.PI * 2);
    near(shortDelta(0, Math.PI / 2), Math.PI / 2);
  });
});

describe('clipModel — офсет таза как ДЕЛЬТА (Ф12)', () => {
  it('дельта читается как есть, легаси-абсолют приводится к дельте по rest тела', () => {
    expect(hipsOffset({ __hipsD: [0, -1.5, 0] })).toEqual([0, -1.5, 0]);
    expect(hipsOffset({ __hipsP: [0, 30.5, 0] }, 32)).toEqual([0, -1.5, 0]);   // тот же присед
    expect(hipsOffset({ __hipsP: [0, 34.5, 0] }, 36)).toEqual([0, -1.5, 0]);   // …на высоком теле — тоже
  });

  it('ГЛАВНОЕ: один и тот же абсолют на разных телах — РАЗНАЯ поза, дельта — одна и та же', () => {
    const abs = { __hipsP: [0, 32, 0] } as Pose;
    expect(hipsOffset(abs, 32)![1]).toBe(0);      // на среднем это ровно стойка
    expect(hipsOffset(abs, 36)![1]).toBe(-4);     // а на высоком — глубокий присед (это и был баг)
  });

  it('кадр без офсета — null, а не нули (иначе таз молча уезжал бы в rest)', () => {
    expect(hipsOffset({ Spine: [0, 0, 0] })).toBeNull();
  });

  it('запись всегда в новом ключе и убирает легаси с этого кадра', () => {
    const p: Pose = { __hipsP: [0, 31, 0] };
    setHipsOffset(p, [1, -2, 3]);
    expect(p['__hipsD']).toEqual([1, -2, 3]);
    expect(p['__hipsP']).toBeUndefined();
  });

  it('нормализация клипа идемпотентна и сообщает, надо ли сохранять', () => {
    const c: Clip = { name: 'c', character: 'a', weapon: 'sword', loop: false, keys: [
      { pose: { __hipsP: [0, 30, 0] }, t: 0 }, { pose: { __hipsD: [0, 1, 0] }, t: 0.3 }, { pose: {}, t: 0.6 },
    ] };
    expect(normalizeClipHips(c, 32)).toBe(true);
    expect(c.keys[0]!.pose['__hipsD']).toEqual([0, -2, 0]);
    expect(c.keys[1]!.pose['__hipsD']).toEqual([0, 1, 0]);    // уже в новой форме — не трогаем
    expect(c.keys[2]!.pose['__hipsD']).toBeUndefined();       // офсета не было — не выдумываем
    expect(normalizeClipHips(c, 32)).toBe(false);             // второй проход ничего не меняет
  });

  it('переворот отражает X у обеих форм ключа', () => {
    expect(flipPose({ __hipsD: [2, 1, 3] })['__hipsD']).toEqual([-2, 1, 3]);
    expect(flipPose({ __hipsP: [2, 32, 3] })['__hipsP']).toEqual([-2, 32, 3]);
  });
});

describe('clipModel — скорость запекания (`bakeSpeed`) переживает всё, что пересобирает клип', () => {
  // ⚠ Потеря поля молчаливая и дорогая: перезапечённый на 120 бег прочитался бы легаси-скоростью 102 — длина цикла −15 %,
  // и в «только клипы» стопы поехали бы. `migrateClip` собирает клип по ЯВНОМУ списку полей — ровно та грабля.
  const run: Clip = { name: 'run_fwd', character: 'warrior', weapon: 'none', loop: true, bakeSpeed: 120,
    keys: [{ t: 0, pose: { LeftUpperLeg: [0.3, 0, 0] } }, { t: 0.4, pose: { LeftUpperLeg: [-0.3, 0, 0] }, marks: [{ type: 'footstep', foot: 'L' }] }, { t: 0.8, pose: { LeftUpperLeg: [0.3, 0, 0] } }] };

  it('⭐ чтение с сервера (JSON → migrateClip) и обратно', () => {
    const back = migrateClip(JSON.parse(JSON.stringify(run)));
    expect(back.bakeSpeed, '⚠ новое поле не дописано в migrateClip').toBe(120);
    expect(JSON.parse(JSON.stringify(back)).bakeSpeed).toBe(120);
  });

  it('старый клип без поля остаётся без поля; битое число не тащится', () => {
    const { bakeSpeed: _drop, ...old } = run; void _drop;
    expect(migrateClip(JSON.parse(JSON.stringify(old))).bakeSpeed).toBeUndefined();
    expect('bakeSpeed' in JSON.parse(JSON.stringify(migrateClip(old))), 'в JSON поле не появляется').toBe(false);
    for (const bad of [0, -1, 'fast', null]) expect(migrateClip({ ...old, bakeSpeed: bad }).bakeSpeed, String(bad)).toBeUndefined();
  });

  it('переворот, зеркало и перенос меток на перезапечённый клип поле не теряют', () => {
    expect(flipClip(run).bakeSpeed).toBe(120);
    expect(mirrorClip(run, 'Left').bakeSpeed).toBe(120);
    // Перенос меток: скорость берётся у НОВОГО клипа (он и есть результат запекания), а не у старой версии.
    const rebaked: Clip = { ...run, bakeSpeed: 40, keys: run.keys.map((k) => ({ t: k.t, pose: k.pose })) };
    expect(carryMarks({ ...run, bakeSpeed: 102 }, rebaked).bakeSpeed).toBe(40);
  });

  it('⭐ РЕВИЗИЯ ЗАПЕКАНИЯ (`bakeRev`) — тот же путь: потеряй её на чтении, и перезапечённый страйф снова «старый»', () => {
    // Рантайм включает сектора доворота только на страйфах с `bakeRev` ≥ 2 (`isLocoClipFresh`), редактор без неё
    // просит «перезапеки». Молчаливая потеря поля в `migrateClip` откатила бы игру на старую складку доворота.
    const fresh: Clip = { ...run, bakeRev: 2 };
    expect(migrateClip(JSON.parse(JSON.stringify(fresh))).bakeRev, '⚠ поле не дописано в migrateClip').toBe(2);
    expect('bakeRev' in JSON.parse(JSON.stringify(migrateClip(run))), 'у старого клипа поле не появляется').toBe(false);
    expect(migrateClip({ ...run, bakeRev: 'x' }).bakeRev).toBeUndefined();
    expect(flipClip(fresh).bakeRev).toBe(2);
    expect(mirrorClip(fresh, 'Left').bakeRev, 'зеркало чистого страйфа — тоже чистый страйф').toBe(2);
    expect(carryMarks(run, { ...fresh, keys: run.keys.map((k) => ({ t: k.t, pose: k.pose })) }).bakeRev, 'метки со старого клипа ревизию не сбивают').toBe(2);
  });

  it('⭐ «ТАЗ ОТКРЫТ» (`hipsOpenDeg` / `hipsOpenW`) переживает чтение, зеркало и перенос меток; битые доли не тащим', () => {
    // Потеряй угол или доли на чтении — рантайм не снимет запечённый отворот, и грудь уедет от прицела на 41 % угла.
    const open: Clip = { ...run, name: 'run_strafe_R_open', bakeRev: 2, hipsOpenDeg: 35, hipsOpenW: [0.2143, 0.3571, 0.4286] };
    const back = migrateClip(JSON.parse(JSON.stringify(open)));
    expect(back.hipsOpenDeg).toBe(35);
    expect(back.hipsOpenW).toEqual([0.2143, 0.3571, 0.4286]);
    expect('hipsOpenDeg' in JSON.parse(JSON.stringify(migrateClip(run))), 'у обычного клипа полей нет').toBe(false);
    expect(migrateClip({ ...open, hipsOpenW: [1, 'x', 0] }).hipsOpenW).toBeUndefined();
    expect(migrateClip({ ...open, hipsOpenW: [1, 0] }).hipsOpenW).toBeUndefined();
    expect(flipClip(open).hipsOpenDeg).toBe(35);
    expect(carryMarks(run, { ...open, keys: run.keys.map((k) => ({ t: k.t, pose: k.pose })) }).hipsOpenW).toEqual(open.hipsOpenW);
  });

  it('⭐ НОМЕР СЪЁМА (`bakeId`) переживает чтение: по нему редактор видит, что набор «таз открыт» снят СТАРОЙ походкой', () => {
    // ⚠ Мутация «не копировать bakeId в migrateClip» снимает единственный признак расхождения наборов, у которых
    // совпал УГОЛ раскрытия: правишь плант-сетку в «ровно», перезапекаешь основной набор — `_open` тихо остаётся старым.
    const stamped: Clip = { ...run, bakeRev: 2, bakeId: 1758000000000 };
    expect(migrateClip(JSON.parse(JSON.stringify(stamped))).bakeId).toBe(1758000000000);
    expect('bakeId' in JSON.parse(JSON.stringify(migrateClip(run))), 'у старого клипа поля нет').toBe(false);
    expect(migrateClip({ ...run, bakeId: 'x' }).bakeId).toBeUndefined();
    expect(flipClip(stamped).bakeId).toBe(1758000000000);
  });
});

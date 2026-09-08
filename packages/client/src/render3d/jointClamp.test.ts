import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as THREE from 'three';
import { clampLocalToLimit, decomposeToLimit, composeFromLimit, setLimitVersion } from './jointClamp.js';

// Этот файл проверяет ИМЕННО v1 (модель «скаляры это поза»). Дефолт в редакторе — v2 (порт FinalIK), у неё другая
// семантика твиста: он меряется относительно ПАРАЛЛЕЛЬНОГО ПЕРЕНОСА, а не разложения по рест-оси, поэтому мерить
// её результат через `decomposeToLimit` бессмысленно. Инварианты v2 — в `jointLimitV2.test.ts`.
beforeAll(() => setLimitVersion(1));
afterAll(() => setLimitVersion(2));
import type { LimitView } from './humanoidRagdoll.js';

// swing-twist клэмп: манекен обязан слушаться пределов. Гизмо рисуется той же параметризацией → совпадает.
const swingView = (o: Partial<LimitView> = {}): LimitView => ({
  kind: 'swing', group: 'arm', canon: 't', twist: [1, 0, 0], plane: [0, 1, 0], normal: [0, 0, 1],
  planeMin: -0.5, planeMax: 0.5, normalMin: -0.4, normalMax: 0.4, twistMin: -0.3, twistMax: 0.3, ...o,
});
const hingeView = (o: Partial<LimitView> = {}): LimitView => ({
  kind: 'hinge', group: 'arm', canon: 't', axis: [1, 0, 0], hingeNormal: [0, -1, 0], min: -1.0, max: 0.1, ...o,
});
const qAxis = (ax: [number, number, number], a: number): THREE.Quaternion => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...ax).normalize(), a);

describe('jointClamp — swing-twist клэмп', () => {
  it('swing за конусом → на границе (rP клэмпнут к planeMax)', () => {
    const v = swingView();
    const c = clampLocalToLimit(qAxis([0, 1, 0], 1.2), v);   // поворот вокруг plane-оси на 1.2 > planeMax 0.5
    const d = decomposeToLimit(c, v);
    expect(d.rP).toBeCloseTo(0.5, 2);
    expect(Math.abs(d.rN)).toBeLessThan(0.02);
  });

  it('swing внутри предела → почти без изменений', () => {
    const v = swingView();
    const q = qAxis([0, 1, 0], 0.3);   // 0.3 < planeMax 0.5
    const c = clampLocalToLimit(q, v);
    expect(c.angleTo(q)).toBeLessThan(0.02);
  });

  it('АСИММЕТРИЯ: −planeMin ограничивает меньше, чем +planeMax', () => {
    const v = swingView({ planeMin: -0.2, planeMax: 1.0 });
    const back = decomposeToLimit(clampLocalToLimit(qAxis([0, 1, 0], -1.5), v), v);   // «назад» — упор на −0.2
    const fwd = decomposeToLimit(clampLocalToLimit(qAxis([0, 1, 0], 1.5), v), v);     // «вперёд» — упор на 1.0
    expect(back.rP).toBeCloseTo(-0.2, 2);
    expect(fwd.rP).toBeCloseTo(1.0, 2);
  });

  it('twist клэмпится к диапазону', () => {
    const v = swingView();
    const d = decomposeToLimit(clampLocalToLimit(qAxis([1, 0, 0], 1.0), v), v);   // твист 1.0 > twistMax 0.3
    expect(d.twist).toBeCloseTo(0.3, 2);
  });

  it('hinge: за пределом → на границе + внеосевой wobble убран', () => {
    const v = hingeView();
    // поворот вокруг оси на −2.0 (< min −1.0) + паразитный наклон вокруг Z
    const q = qAxis([1, 0, 0], -2.0).multiply(qAxis([0, 0, 1], 0.3));
    const c = clampLocalToLimit(q, v);
    const d = decomposeToLimit(c, v);
    expect(d.twist).toBeCloseTo(-1.0, 2);   // угол шарнира на min
    // остаточный поворот только вокруг оси X → нет Z-компоненты
    const e = new THREE.Euler().setFromQuaternion(c, 'XYZ');
    expect(Math.abs(e.z)).toBeLessThan(0.02);
  });
});

// РЕГРЕССИЯ: переход через ±180°. Кватернион отдаёт кратчайший угол ∈ (−π,π], поэтому «дотянули на 181°» читается
// как −179°. Наивный Math.min/max кидал кость к ПРОТИВОПОЛОЖНОМУ упору — локоть из полного сгиба щёлкал в переразгиб.
describe('jointClamp — перекрут через 180° (локоть не выворачивается)', () => {
  const elbow = hingeView({ min: -0.1, max: 2.4 });   // реальный локоть: −5.7°…137.5°
  const bend = (deg: number): number => decomposeToLimit(clampLocalToLimit(qAxis([1, 0, 0], deg * Math.PI / 180), elbow), elbow).twist * 180 / Math.PI;

  it('за максимумом сгиба — упор в max, БЕЗ щелчка на противоположный предел', () => {
    expect(bend(150)).toBeCloseTo(137.5, 0);
    expect(bend(179)).toBeCloseTo(137.5, 0);
    expect(bend(181)).toBeCloseTo(137.5, 0);   // ← был −5.7° (выворот)
    expect(bend(210)).toBeCloseTo(137.5, 0);
  });

  it('переразгиб упирается в min', () => {
    expect(bend(-20)).toBeCloseTo(-5.7, 0);
    expect(bend(-90)).toBeCloseTo(-5.7, 0);
  });

  it('внутри диапазона — угол не трогаем', () => {
    expect(bend(90)).toBeCloseTo(90, 0);
    expect(bend(-3)).toBeCloseTo(-3, 0);
  });

  it('переключение границ — в СЕРЕДИНЕ запретной дуги, а не на ±180°', () => {
    expect(bend(-100)).toBeCloseTo(-5.7, 0);    // ближе к min
    expect(bend(-130)).toBeCloseTo(137.5, 0);   // ближе к max (середина запретной дуги ≈ −114°)
  });
});

// ЛИМИТ — ЧИСТАЯ ФУНКЦИЯ (как в Blender). Здесь БЫЛА память по кости (`lastValid`/`ACC_MARGIN`) и тесты цикла
// «туда-обратно»: она лечила «кручу дальше — перескакивает на противоположный предел» и «вниз 90 / вверх 90 — рука
// уехала». Причина ушла на слой выше: драг кольца больше НЕ раскладывает кватернион, а копит угол ввода сам
// (`jointDof.ringDelta`; точный возврат и упор без перескока проверяются в jointDof.test.ts — «слой гизмо»).
// Здесь остались НЕ-интерактивные писатели (солверы), и для них память вредна: солвер зовёт клэмп по несколько
// раз за один солв, и его итерации мерещились бы накопителю «движениями мыши».
describe('jointClamp — клэмп без памяти: детерминирован и идемпотентен', () => {
  const elbow = hingeView({ min: -0.1, max: 2.4 });                       // −5.7°…137.5°
  const bendOf = (q: THREE.Quaternion): number => decomposeToLimit(q, elbow).twist * 180 / Math.PI;

  it('один и тот же вход — один и тот же выход (скрытого состояния нет)', () => {
    const q = qAxis([1, 0, 0], 300 * Math.PI / 180);
    const a = clampLocalToLimit(q, elbow);
    for (let i = 0; i < 20; i++) expect(bendOf(clampLocalToLimit(q, elbow))).toBeCloseTo(bendOf(a), 9);
  });

  it('повторный клэмп ничего не меняет (идемпотентность — солвер зовёт его в цикле)', () => {
    const once = clampLocalToLimit(qAxis([1, 0, 0], 200 * Math.PI / 180), elbow);
    expect(clampLocalToLimit(once, elbow).angleTo(once)).toBeLessThan(1e-9);
  });

  it('внутри предела клэмп НЕ трогает позу вообще', () => {
    for (const d of [-5, 0, 30, 90, 137]) {
      const q = qAxis([1, 0, 0], d * Math.PI / 180);
      expect(clampLocalToLimit(q, elbow).angleTo(q)).toBeLessThan(1e-6);
    }
  });
});

// ЕДИНАЯ ОБЛАСТЬ С ГИЗМО (регрессия, пойманная ЖИВЬЁМ в редакторе): ИК оставлял плечо в plane = −143°, swing-конус
// такое пускал, а первое же касание кольца зажимало до −97.4° — поза прыгала на 46°. Клэмп и гизмо обязаны жить
// в ОДНОЙ параметризации, иначе солвер паркует кость там, где редактор её не удержит.
describe('jointClamp — область клэмпа = область гизмо', () => {
  const sh = swingView({ twist: [1, 0, 0], plane: [0, 1, 0], normal: [0, 0, 1],
    planeMin: -1.7, planeMax: 1.7, normalMin: -1.9, normalMax: 1.9, twistMin: -1.6, twistMax: 1.6 });

  it('после клэмпа все углы В ПРЕДЕЛАХ и второй клэмп уже не двигает кость', () => {
    for (const [a, b, c] of [[2.6, 0.4, 0.2], [-2.5, 1.2, -2.0], [0.3, 1.4, 2.9], [3.0, -1.3, 1.1]] as [number, number, number][]) {
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(a, b, c, 'XYZ'));
      const c1 = clampLocalToLimit(q, sh), d = decomposeToLimit(c1, sh);
      expect(d.rP).toBeGreaterThanOrEqual(-1.7 - 1e-9); expect(d.rP).toBeLessThanOrEqual(1.7 + 1e-9);
      expect(d.rN).toBeGreaterThanOrEqual(-1.9 - 1e-9); expect(d.rN).toBeLessThanOrEqual(1.9 + 1e-9);
      expect(d.twist).toBeGreaterThanOrEqual(-1.6 - 1e-9); expect(d.twist).toBeLessThanOrEqual(1.6 + 1e-9);
      expect(clampLocalToLimit(c1, sh).angleTo(c1)).toBeLessThan(1e-6);   // 1e-6 рад = 6e-5° — это шум float, не сдвиг
    }
  });
});

// КОЛЬЦО ГИЗМО ПРАВИТ РОВНО ОДНУ СТЕПЕНЬ СВОБОДЫ (жалоба: «кручу по одной оси — крутится по другой»; в позе
// «рука вниз» кольцо сгиба давало +45° твиста из ниоткуда и выкручивало предплечье к голове).
// Причина была в композиции справа (q · R): два swing-поворота вокруг разных осей САМИ рождают твист.
// Лечение — правка компоненты и сборка через composeFromLimit (обратная к decomposeToLimit).
describe('jointClamp — одно кольцо = одна степень свободы', () => {
  const sh = swingView({ twist: [1, 0, 0], plane: [0, 1, 0], normal: [0, 0, 1],
    planeMin: -1.7, planeMax: 1.7, normalMin: -1.9, normalMax: 1.9, twistMin: -1.6, twistMax: 1.6 });
  type Comp = { rP: number; rN: number; twist: number };
  const ring = (q0: THREE.Quaternion, which: keyof Comp, deg: number): Comp => {
    const a = decomposeToLimit(q0, sh) as Comp;
    const b: Comp = { ...a }; b[which] += deg * Math.PI / 180;
    return decomposeToLimit(composeFromLimit(sh, b), sh) as Comp;
  };
  const deg = (r: number): number => r * 180 / Math.PI;
  const armDown = composeFromLimit(sh, { rP: 0, rN: -90 * Math.PI / 180, twist: 0 });

  it('compose(decompose(q)) === q — параметризация замкнута', () => {
    const q = qAxis([0.3, 1, 0.2], 0.9);
    const back = composeFromLimit(sh, decomposeToLimit(q, sh));
    expect(back.angleTo(q)).toBeLessThan(1e-6);
  });

  it('из T-позы каждое кольцо двигает свою компоненту', () => {
    const z = new THREE.Quaternion();
    expect(deg(ring(z, 'rP', 60).rP)).toBeCloseTo(60, 0);
    expect(deg(ring(z, 'rN', 60).rN)).toBeCloseTo(60, 0);
    expect(deg(ring(z, 'twist', 60).twist)).toBeCloseTo(60, 0);
  });

  it('РУКА ВНИЗ: кольцо сгиба НЕ наливает твист (было +45° твиста)', () => {
    const r = ring(armDown, 'rP', 45);
    expect(deg(r.rP)).toBeCloseTo(45, 0);
    expect(deg(r.rN)).toBeCloseTo(-90, 0);      // отведение не поехало
    expect(Math.abs(deg(r.twist))).toBeLessThan(0.5);   // ← твист остаётся нулевым
  });

  it('РУКА ВНИЗ + твист 40°: кольца не трогают чужие компоненты', () => {
    const q = composeFromLimit(sh, { rP: 0, rN: -90 * Math.PI / 180, twist: 40 * Math.PI / 180 });
    const byP = ring(q, 'rP', 45);
    expect(deg(byP.rP)).toBeCloseTo(45, 0);
    expect(deg(byP.twist)).toBeCloseTo(40, 0);  // твист сохранён
    const byN = ring(q, 'rN', 45);
    expect(deg(byN.rN)).toBeCloseTo(-45, 0);
    expect(deg(byN.twist)).toBeCloseTo(40, 0);
  });
});

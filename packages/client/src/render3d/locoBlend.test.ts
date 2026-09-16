import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { buildHumanoid, type Humanoid } from './humanoid.js';
import { PosePlayer, localStorageContent, emptyGrid, type PoseContent } from './poseRuntime.js';
import { GAIT } from './pose.js';
import { locoClipName, blendLocoPose, locoDirWeights, locoPhaseU, stepLocoSection, sectionClipTime, type LocoDir } from './locoBlend.js';
import { bakeGaitToClip, BAKE_MAXSPD } from './clipBake.js';
import { clipSections, type Clip } from './clipModel.js';
import { stitchLocoClip } from './clipImport.js';

/**
 * ПОЛЗУНОК «ПРОЦЕДУРНО ↔ КЛИП» (Ф4).
 *
 * Ставка фазы: планировщик остаётся ЧАСАМИ и опорой даже на единице. Клип сэмплируется его фазой, а
 * не своим таймером — иначе настройки персонажа перестали бы на клип влиять, и «из двух купленных
 * паков неограниченное число вариантов» не получилось бы: пак остался бы ровно тем, чем куплен.
 *
 * И главное требование, на котором стоит всё остальное: НА НУЛЕ — СЕГОДНЯШНЯЯ ПОХОДКА БИТ В БИТ.
 * Без него ползунок нельзя было бы даже показать: любая жалоба на походку стала бы спором о том,
 * не он ли виноват.
 */
const DT = 1 / 60;
const GX = { armDown: 1.35, elbowBend: 0.25 };
const GAIT0 = { ...GAIT };

describe('фаза и выбор клипа', () => {
  it('π на шаг, 2π на цикл: фаза планировщика → время клипа', () => {
    expect(locoPhaseU(0)).toBeCloseTo(0, 12);
    expect(locoPhaseU(Math.PI), 'полшага — середина клипа').toBeCloseTo(0.5, 12);
    expect(locoPhaseU(Math.PI * 2), 'цикл замкнулся').toBeCloseTo(0, 12);
    expect(locoPhaseU(Math.PI * 5), 'фаза копится и не переполняется').toBeCloseTo(0.5, 12);
  });

  it('отрицательная фаза (пятимся) не ломает выборку', () => {
    expect(locoPhaseU(-Math.PI)).toBeCloseTo(0.5, 12);
  });

  /** Вместо позы — просто имя колонки: так видно, ЧТО и с каким весом легло в бленд. */
  const mixNames = (axes: { sb: number; st: number; bt: number }, latRight = true, have: (d: LocoDir, f: boolean) => boolean = () => true): string =>
    blendLocoPose<string>(
      (d, f) => (have(d, f) ? `${f ? 'run' : 'walk'}_${d}` : null),
      axes, latRight,
      (a, b, t) => (t <= 0.001 ? a : t >= 0.999 ? b : `${a}+${b}@${t.toFixed(2)}`),
    ) ?? '—';

  it('⭐⭐ ПОРОГОВ НЕТ: направление и скорость — БЛЕНД по осям планировщика, а не выбор клипа', () => {
    // ⚠ ЗДЕСЬ БЫЛ ПОРОГ («угол ≥ strafeFrom → страйф-клип») и второй по скорости, и его отменил
    // ЗАМЕР дёрганья: у порога скачок позы за кадр 52–61°, и весь он приходился на кадр подмены.
    // Ровно так это решают Blend Space / Blend Tree: несколько клипов с весами, а не один выбранный.
    expect(mixNames({ sb: 0, st: 0, bt: 0 }), 'чистая ходьба вперёд').toBe('walk_fwd');
    expect(mixNames({ sb: 1, st: 0, bt: 0 }), 'чистый бег вперёд').toBe('run_fwd');
    expect(mixNames({ sb: 0.5, st: 0, bt: 0 }), 'середина ходьба/бег — ОБА клипа').toBe('walk_fwd+run_fwd@0.50');
    expect(mixNames({ sb: 1, st: 0.5, bt: 0 }), 'полубок — бег вперёд и бег боком').toBe('run_fwd+run_strafe_R@0.50');
    expect(mixNames({ sb: 1, st: 0, bt: 0.5 }), 'полуспиной').toBe('run_fwd+run_back@0.50');
    expect(mixNames({ sb: 1, st: 1, bt: 0 }), 'чистый страйф — база не читается').toBe('run_strafe_R');
    expect(mixNames({ sb: 1, st: 0.4, bt: 0 }, false), 'сторона — по знаку боковой скорости').toBe('run_fwd+run_strafe_L@0.40');
  });

  it('⭐⭐ ВЕСА НАПРАВЛЕНИЯ — ГЕОМЕТРИЯ ХОДА, БЕЗ МЁРТВОЙ ЗОНЫ (`strafeFrom` клипов не касается)', () => {
    // ⚠ Мутация «брать `st` планировщика» валит это: у него ноль до 45°, и на 20° клип играл чистый бег
    // вперёд, пока тело ехало вбок.
    const deg = (d: number): { st: number; bt: number } => locoDirWeights(Math.cos(d * Math.PI / 180), Math.sin(d * Math.PI / 180));
    expect(deg(0)).toEqual({ st: 0, bt: 0 });
    expect(deg(20).st, 'уже на 20° страйф подмешан').toBeGreaterThan(0.2);
    expect(deg(45).st, 'ровно между — поровну').toBeCloseTo(0.5, 9);
    expect(deg(90).st, 'чистый бок').toBeCloseTo(1, 9);
    // Доля смеси повторяет угол хода: atan(w / (1 − w)) = θ — стопа уходит ровно туда, куда едет тело.
    for (const d of [10, 30, 60, 80]) {
      const w = deg(d).st;
      expect(Math.atan2(w, 1 - w) * 180 / Math.PI, `на ${d}° смесь ведёт стопу не туда`).toBeCloseTo(d, 6);
    }
  });

  it('⚠ ЗАДНЯЯ ПОЛУПЛОСКОСТЬ — через страйф-колонку, и на боку НЕТ ступеньки', () => {
    // Порядок наложения база → страйф → назад: чтобы «вперёд» не просочилось в ход спиной, страйф там = 1,
    // а «назад» берёт долю продольной составляющей. На чистом боку обе стороны дают одно и то же.
    expect(locoDirWeights(-1, 0), 'чистый ход спиной').toEqual({ st: 1, bt: 1 });
    expect(locoDirWeights(-1, 1).bt, 'спиной наискосок — поровну').toBeCloseTo(0.5, 9);
    const front = locoDirWeights(1e-9, 1), back = locoDirWeights(-1e-9, 1);
    expect(front.st).toBeCloseTo(back.st, 6);
    expect(back.bt, 'на боку «назад» уже погас').toBeCloseTo(0, 6);
    expect(locoDirWeights(0, 0), 'стоим — направления нет').toEqual({ st: 0, bt: 0 });
  });

  it('⚠ ПОРЯДОК НАЛОЖЕНИЯ — как у колонок настроек (`locoVal`): база → страйф → назад', () => {
    // Иначе слой клипов и слой настроек спорили бы о том, что сейчас играет.
    expect(mixNames({ sb: 0, st: 0.5, bt: 0.5 })).toBe('walk_fwd+walk_strafe_R@0.50+walk_back@0.50');
  });

  it('⚠ НЕТ КЛИПА — ВЕС ПЕРЕТЕКАЕТ, а не роняет кадр и не подменяет направление', () => {
    // Нет бегового страйфа — колонка играет ходьбовым (у автора другого всё равно нет).
    expect(mixNames({ sb: 1, st: 1, bt: 0 }, true, (d) => d !== 'strafe_R' ? true : false), 'нет страйфа вовсе — остаётся база').toBe('run_fwd');
    expect(mixNames({ sb: 1, st: 1, bt: 0 }, true, (d, f) => !(d === 'strafe_R' && f)), 'есть только ходьбовый страйф').toBe('walk_strafe_R');
    expect(mixNames({ sb: 0.5, st: 0, bt: 0 }, true, () => false), 'нет вообще ничего — null, а не падение').toBe('—');
  });

  it('имена по конвенции плана', () => {
    expect(locoClipName('fwd', false)).toBe('walk_fwd');
    expect(locoClipName('strafe_L', true)).toBe('run_strafe_L');
  });
});

describe('смешивание в рантайме', () => {
  beforeEach(() => {
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: () => null, setItem: () => { /* */ }, removeItem: () => { /* */ }, clear: () => { /* */ }, key: () => null, length: 0,
    } as Storage;
  });
  afterEach(() => {
    delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
    Object.assign(GAIT, GAIT0);
  });

  /** Контент с одним клипом локомоции на все направления — этого хватает, чтобы шов сработал. */
  const withLoco = (clip: Clip): PoseContent => {
    const base = localStorageContent('warrior');
    return { ...base, locoClip: () => clip };
  };

  const run = (content: PoseContent, frames = 120): { bones: number[]; feet: number[] } => {
    const h = buildHumanoid({});
    const p = new PosePlayer(h, () => [], content, 'sword', GX, emptyGrid());
    p.setVel(0, 115); p.setYaw(0);
    for (let i = 0; i < frames; i++) p.step(DT);
    h.root.updateMatrixWorld(true);
    const bones: number[] = [];
    for (const [, b] of [...h.bones].sort((a, b2) => a[0].localeCompare(b2[0]))) bones.push(b.rotation.x, b.rotation.y, b.rotation.z);
    const v = new THREE.Vector3();
    const feet = [h.bones.get('LeftFoot')!.getWorldPosition(v).clone(), h.bones.get('RightFoot')!.getWorldPosition(v).clone()]
      .flatMap((q) => [q.x, q.y, q.z]);
    return { bones, feet };
  };

  it('НА НУЛЕ — БИТ В БИТ сегодняшняя походка, даже когда клип привязан', () => {
    const h = buildHumanoid({});
    const src = bakeGaitToClip(new PosePlayer(h, () => [], localStorageContent('warrior'), 'sword', GX, emptyGrid()), h,
      { name: 'run_fwd', vx: 0, vz: 0.95 }, { character: 'warrior', weapon: 'sword' }).clip;
    GAIT.locoMix = 0;
    const plain = run(localStorageContent('warrior'));
    const bound = run(withLoco(src));
    expect(bound.bones).toEqual(plain.bones);
  });

  it('клипа нет — ползунок молчит, а не роняет кадр', () => {
    GAIT.locoMix = 1;
    const plain = run(localStorageContent('warrior'));
    expect(plain.bones.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('на единице поза МЕНЯЕТСЯ — иначе ползунок был бы декоративным', () => {
    const h = buildHumanoid({});
    // Клип другой скорости: его форма заведомо не совпадает с текущей процедурной.
    const other = bakeGaitToClip(new PosePlayer(h, () => [], localStorageContent('warrior'), 'sword', GX, emptyGrid()), h,
      { name: 'walk_fwd', vx: 0, vz: 0.3 }, { character: 'warrior', weapon: 'sword' }).clip;
    GAIT.locoMix = 0;
    const at0 = run(withLoco(other));
    GAIT.locoMix = 1;
    const at1 = run(withLoco(other));
    let diff = 0;
    for (let i = 0; i < at0.bones.length; i++) diff = Math.max(diff, Math.abs(at0.bones[i]! - at1.bones[i]!));
    expect(diff, 'поза поехала за клипом').toBeGreaterThan(0.05);
  });

  it('ОПОРНАЯ СТОПА ДЕРЖИТСЯ У ПЛАНТА даже на чужом клипе — иначе ползунок кончился бы скольжением', () => {
    const h = buildHumanoid({});
    const other = bakeGaitToClip(new PosePlayer(h, () => [], localStorageContent('warrior'), 'sword', GX, emptyGrid()), h,
      { name: 'walk_fwd', vx: 0, vz: 0.3 }, { character: 'warrior', weapon: 'sword' }).clip;
    const content = withLoco(other);
    const hh = buildHumanoid({});
    const p = new PosePlayer(hh, () => [], content, 'sword', GX, emptyGrid());
    // ⚠ 0.99, А НЕ 1: единица — режим «только клипы», где планировщика нет вовсе и подтягивать стопу
    // не к чему (её держит фиксация). Подтяжка к плантам живёт в СМЕШАННОМ режиме — его и стережём.
    GAIT.locoMix = 0.99;
    let worst = 0, seen = 0;
    const v = new THREE.Vector3();
    p.setVel(0, 115); p.setYaw(0);
    for (let i = 0; i < 200; i++) {
      p.step(DT);
      hh.root.updateMatrixWorld(true);
      for (let leg = 0; leg < 2; leg++) {
        if (p.driver.swingLegs[leg]) continue;
        // Риг локальный, планировщик — в мире: сравниваем в ЕГО системе (плант минус позиция персонажа).
        const f = hh.bones.get(leg === 0 ? 'LeftFoot' : 'RightFoot')!.getWorldPosition(v);
        const t = p.driver.plantTarget(leg);
        if (i > 60) { seen++; worst = Math.max(worst, Math.hypot(f.x - (t[0] - p.posX), f.z - (t[1] - p.posZ))); }
      }
    }
    // Планировщик работает в своих единицах, риг крупнее — идеального нуля тут не бывает. Требование
    // слабее и честнее: опорная стопа НЕ УЛЕТАЕТ от планта, то есть держится в пределах длины шага.
    expect(seen, 'опорные кадры вообще были — иначе проверка пустая').toBeGreaterThan(20);
    expect(worst, `максимальное отставание опорной стопы ${worst.toFixed(1)} за ${seen} кадров`).toBeLessThan(0.5);
  });

  it('НА ПОВОРОТЕ подтяжка обязана идти ПОСЛЕ доворота таза, иначе стопа уезжает с ригом', () => {
    // ⚠ Постоянного угла тут МАЛО, и это выяснилось мутацией: `applyTorsoTwist` ставит тазу рыск
    // АБСОЛЮТНО, поэтому на неизменном курсе он уже стоит правильно ещё с прошлого кадра и порядок
    // ничего не решает. Разница появляется только когда курс МЕНЯЕТСЯ: подтяжка, сделанная до
    // доворота, уезжает вместе с ригом на приращение угла за кадр.
    const h = buildHumanoid({});
    const other = bakeGaitToClip(new PosePlayer(h, () => [], localStorageContent('warrior'), 'sword', GX, emptyGrid()), h,
      { name: 'walk_fwd', vx: 0, vz: 0.3 }, { character: 'warrior', weapon: 'sword' }).clip;
    const hh = buildHumanoid({});
    const p = new PosePlayer(hh, () => [], withLoco(other), 'sword', GX, emptyGrid());
    GAIT.locoMix = 0.99;   // смешанный режим — см. выше: на единице планировщика нет
    const v = new THREE.Vector3(), hip = new THREE.Vector3(), knee = new THREE.Vector3(), tgt = new THREE.Vector3();
    let worst = 0, seen = 0;
    for (let i = 0; i < 260; i++) {
      const yaw = i * 0.02;                       // ~1.2 рад/с — обычный доворот на бегу
      p.setVel(115 * Math.sin(yaw), 115 * Math.cos(yaw)); p.setYaw(yaw);
      p.step(DT);
      hh.root.updateMatrixWorld(true);
      for (let leg = 0; leg < 2; leg++) {
        if (p.driver.swingLegs[leg]) continue;
        const side = leg === 0 ? 'Left' : 'Right';
        const f = hh.bones.get(side + 'Foot')!.getWorldPosition(v);
        const t = p.driver.plantTarget(leg);
        // ⚠ КАДРЫ, ГДЕ ПЛАНТ ФИЗИЧЕСКИ ВНЕ ДОСЯГАЕМОСТИ НОГИ, ПОРЯДОК НЕ СУДЯТ: там IK упирается в длину
        // ноги, и остаток есть при ЛЮБОМ порядке. Появились они, когда запекатель стал снимать по фазе:
        // клип играет в такт, боб таза стоит там, где ему место, и на крайнем выносе поворотного шага
        // плант оказывается на 0.3–0.7 % дальше вытянутой ноги (замер: 3 кадра из ~130, до 0.51).
        hh.bones.get(side + 'UpperLeg')!.getWorldPosition(hip);
        hh.bones.get(side + 'LowerLeg')!.getWorldPosition(knee);
        tgt.set(t[0] - p.posX, f.y, t[1] - p.posZ);
        if (hip.distanceTo(tgt) >= hip.distanceTo(knee) + knee.distanceTo(f)) continue;
        if (i > 120) { seen++; worst = Math.max(worst, Math.hypot(f.x - tgt.x, f.z - tgt.z)); }
      }
    }
    expect(seen, 'опорные кадры на повороте были — иначе проверка пустая').toBeGreaterThan(20);
    expect(worst, `на повороте отставание ${worst.toFixed(2)} за ${seen} кадров`).toBeLessThan(0.5);
  });

  it('под постоянным углом — то же самое', () => {
    // На прямом ходу (yaw = 0) поворот рига единичный, и ошибка порядка не видна ВООБЩЕ. Поэтому
    // отдельный прогон под углом: `applyTorsoTwist` крутит весь риг, и подтяжка, сделанная раньше,
    // уехала бы вместе с поворотом.
    const h = buildHumanoid({});
    const other = bakeGaitToClip(new PosePlayer(h, () => [], localStorageContent('warrior'), 'sword', GX, emptyGrid()), h,
      { name: 'walk_fwd', vx: 0, vz: 0.3 }, { character: 'warrior', weapon: 'sword' }).clip;
    const hh = buildHumanoid({});
    const p = new PosePlayer(hh, () => [], withLoco(other), 'sword', GX, emptyGrid());
    GAIT.locoMix = 0.99;   // смешанный режим — см. выше: на единице планировщика нет
    const yaw = Math.PI / 3;
    p.setVel(115 * Math.sin(yaw), 115 * Math.cos(yaw)); p.setYaw(yaw);
    const v = new THREE.Vector3();
    let worst = 0, seen = 0;
    for (let i = 0; i < 200; i++) {
      p.step(DT);
      hh.root.updateMatrixWorld(true);
      for (let leg = 0; leg < 2; leg++) {
        if (p.driver.swingLegs[leg]) continue;
        const f = hh.bones.get(leg === 0 ? 'LeftFoot' : 'RightFoot')!.getWorldPosition(v);
        const t = p.driver.plantTarget(leg);
        if (i > 90) { seen++; worst = Math.max(worst, Math.hypot(f.x - (t[0] - p.posX), f.z - (t[1] - p.posZ))); }
      }
    }
    expect(seen, 'опорные кадры под углом были — иначе проверка пустая').toBeGreaterThan(20);
    expect(worst, `под углом отставание ${worst.toFixed(1)} за ${seen} кадров`).toBeLessThan(0.5);
  });
});

describe('секции: старт → цикл → остановка одним клипом (Ф5б)', () => {
  const mk = (dur: number, marks: { t: number; type: 'loop_start' | 'loop_end' }[]): Clip => ({
    name: 'run_fwd', character: 'w', weapon: 'none', loop: false,
    keys: [0, dur / 2, dur].map((t) => ({
      t, pose: { Hips: [0, 0, 0] },
      marks: marks.filter((m) => Math.abs(m.t - t) < 1e-6).map((m) => ({ type: m.type })),
    })),
  });

  it('МЕТОК НЕТ — весь клип цикл, то есть ровно прежнее поведение', () => {
    const s = clipSections(mk(2, []));
    expect(s.loopStart).toBe(0);
    expect(s.loopEnd).toBe(2);
    expect(s.hasStart).toBe(false);
    expect(s.hasStop).toBe(false);
  });

  it('метки задают границы', () => {
    const s = clipSections(mk(2, [{ t: 1, type: 'loop_start' }, { t: 2, type: 'loop_end' }]));
    expect(s.loopStart).toBe(1);
    expect(s.hasStart).toBe(true);
    expect(s.hasStop, 'метка на самом конце — остановки нет').toBe(false);
  });

  const sec = { loopStart: 0.5, loopEnd: 1.5, dur: 2, hasStart: true, hasStop: true };

  it('из покоя идём через РАЗГОН, а не сразу в цикл', () => {
    expect(stepLocoSection({ section: 'idle', t: 0 }, true, 1 / 60, sec).section).toBe('start');
  });

  it('разгон доигрывает СВОЁ время и переходит в цикл', () => {
    let st = stepLocoSection({ section: 'idle', t: 0 }, true, 1 / 60, sec);
    for (let i = 0; i < 10 && st.section === 'start'; i++) st = stepLocoSection(st, true, 0.1, sec);
    expect(st.section).toBe('loop');
  });

  it('разгона не заавторено — сразу цикл, а не пустая пауза', () => {
    expect(stepLocoSection({ section: 'idle', t: 0 }, true, 0.1, { ...sec, hasStart: false }).section).toBe('loop');
  });

  it('остановились — доигрываем ХВОСТ и только потом покой', () => {
    let st = stepLocoSection({ section: 'loop', t: 0 }, false, 0.1, sec);
    expect(st.section).toBe('stop');
    for (let i = 0; i < 10 && st.section === 'stop'; i++) st = stepLocoSection(st, false, 0.1, sec);
    expect(st.section).toBe('idle');
  });

  it('остановки не заавторено — из цикла сразу в покой', () => {
    expect(stepLocoSection({ section: 'loop', t: 0 }, false, 0.1, { ...sec, hasStop: false }).section).toBe('idle');
  });

  it('отпустили на разгоне — доигрывать нечего', () => {
    expect(stepLocoSection({ section: 'start', t: 0.1 }, false, 0.1, sec).section).toBe('idle');
  });

  it('передумал на остановке — уходим в РАЗГОН с нуля, а не прыгаем в середину цикла', () => {
    expect(stepLocoSection({ section: 'stop', t: 0.1 }, true, 0.1, sec).section).toBe('start');
  });

  it('ЦИКЛ тянется фазой планировщика, разгон и остановка — своим временем', () => {
    expect(sectionClipTime({ section: 'loop', t: 0 }, 0, sec, 2), 'начало цикла').toBeCloseTo(0.5, 9);
    expect(sectionClipTime({ section: 'loop', t: 0 }, 1, sec, 2), 'конец цикла').toBeCloseTo(1.5, 9);
    expect(sectionClipTime({ section: 'start', t: 0.2 }, 0.9, sec, 2), 'разгон фазу игнорирует').toBeCloseTo(0.2, 9);
    expect(sectionClipTime({ section: 'start', t: 9 }, 0, sec, 2), 'и не вылезает за свою границу').toBeCloseTo(0.5, 9);
    expect(sectionClipTime({ section: 'stop', t: 0.2 }, 0, sec, 2), 'остановка идёт от конца цикла').toBeCloseTo(1.7, 9);
  });

  it('сшивка трёх источников: времена подряд, границы помечены', () => {
    const one = (name: string, dur: number): Clip => ({ name, character: 'w', weapon: 'none', loop: false,
      keys: [{ t: 0, pose: { Hips: [0, 0, 0] } }, { t: dur, pose: { Hips: [0, 0.1, 0] } }] });
    const c = stitchLocoClip(one('start', 0.4), one('loop', 1), one('stop', 0.6), 'run_fwd');
    expect(c.keys[0]!.t).toBe(0);
    expect(c.keys.at(-1)!.t, 'общая длительность — сумма').toBeCloseTo(2, 4);
    const s = clipSections(c);
    expect(s.loopStart, 'цикл начинается там, где кончился разгон').toBeCloseTo(0.4, 4);
    expect(s.loopEnd, 'и кончается там, где началась остановка').toBeCloseTo(1.4, 4);
    expect(s.hasStart && s.hasStop).toBe(true);
  });
});

/**
 * ⭐⭐ ПОВОРОТ НА МЕСТЕ — ГЛАДКИМИ ПРОРЕЖЕННЫМИ КЛЮЧАМИ, КАК ЦИКЛ ПОХОДКИ.
 *
 * До правки повороты запекались ОТДЕЛЬНЫМ путём: покадровая ломаная с допуском 0.5°, нарезанная по сменам опоры.
 * ЗАМЕР (рыцарь, опубликованный воин): 28–47 ключей на клип, 201 на шесть, все линейные — против 11–15 у цикла
 * походки. Теперь это та же подгонка (`clipFit`), только в режиме открытого клипа: 13–19 ключей, 93 на шесть.
 *
 * Стережём четыре вещи, и каждая падает от своей мутации:
 *  1. ЦИКЛ ОСТАЛСЯ БИТ В БИТ (эталон снят кодом до правки — иначе «заодно поправили» походку);
 *  2. КОНЦЫ ОТКРЫТОГО КЛИПА ТОЧНЫЕ (на них стоят `turnYawAt(dur)`, `turnSupportAt(0/dur)` и шов поворота);
 *  3. `__swing` НЕ ГЛАДИТСЯ и его смены остаются ключами (иначе заземление прижмёт не ту ногу и не тогда);
 *  4. КУРС КОРНЯ ВНУТРИ МЕРЫ ОШИБКИ (иначе подгонка молча теряет градусы разворота).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fitSmoothLoop, smoothLoopFrames } from './clipFit.js';
import { clipDur, clipPoseAt, poseErrorDeg, ROOT_YAW, type Clip, type Keyframe, type Pose } from './clipModel.js';
import { SWING_KEY, turnSupportAt, turnYawAt } from './turnInPlace.js';
import { buildHumanoid } from './humanoid.js';
import { PosePlayer, localStorageContent, emptyGrid } from './poseRuntime.js';
import { bakeTurnSet, TURN_PRESETS, SMOOTH_EPS_DEG, SMOOTH_SIGMA_CYCLE } from './clipBake.js';

const GX = { armDown: 1.35, elbowBend: 0.25 };
const clip = (keys: Keyframe[], loop: boolean): Clip => ({ name: 'c', character: 'w', weapon: 'none', loop, keys });

/** Цикл-образец: мах ног, боб таза, вес и ОДНОКАДРОВЫЙ излом стопы — весь набор каналов подгонки. */
const cyc = (ph: number): Pose => ({
  LeftUpperLeg: [0.7 * Math.sin(ph), 0, 0.15 * Math.sin(2 * ph)],
  RightUpperLeg: [-0.7 * Math.sin(ph), 0.1, 0],
  LeftFoot: [ph > 2 && ph < 4 ? -0.45 : 0, 0, 0],
  __hipsD: [0, 0.8 * Math.cos(2 * ph), 0],
  __match: [0.3 + 0.2 * Math.sin(ph), 0, 0],
});
const cycleFrames = (n = 60): Keyframe[] => Array.from({ length: n + 1 }, (_, i) => ({ t: i / n, pose: cyc((2 * Math.PI * (i % n)) / n) }));

/**
 * ⭐ ЭТАЛОН ЦИКЛА, СНЯТЫЙ КОДОМ ДО ПРАВКИ (`fitSmoothLoop` на `cycleFrames(60)`, допуск 2°, σ 1.44 кадра).
 * Сверка СТРОКОЙ, а не «примерно»: правка открытого клипа обязана не сдвинуть цикл ни на бит.
 */
const CYCLE_GOLDEN = '[{"t":0,"pose":{"LeftUpperLeg":[-0.0019876986163484566,-0.00964344790459084,-0.007540458611002745],"RightUpperLeg":[0.0020496669771337423,0.0999999999999999,3.8954839606652636e-18],"LeftFoot":[-0.003440685659191414,0,0],"__hipsD":[0,0.7660085980304382,0],"__match":[0.3,0,0]},"interp":"smooth"},{"t":0.016666666666666666,"pose":{"LeftUpperLeg":[0.07363008535003061,-0.008946999546794655,0.03336701483682214],"RightUpperLeg":[-0.07361566612930406,0.09999999999999992,4.358583452492603e-18],"LeftFoot":[-0.005303529756492093,0,0],"__hipsD":[0,0.744621308640078,0],"__match":[0.32066972092649976,0,0]},"interp":"smooth"},{"t":0.25,"pose":{"LeftUpperLeg":[0.692547950704881,-0.004233469239402284,0.011627218172404013],"RightUpperLeg":[-0.6923271698659692,0.10000000000000006,0],"LeftFoot":[-0.019277133778196884,0,0],"__hipsD":[0,-0.757355857336831,0],"__match":[0.49774251223394816,0,0]},"interp":"smooth"},{"t":0.3,"pose":{"LeftUpperLeg":[0.6578068698414362,0.0036950240971691827,-0.0884113789761221],"RightUpperLeg":[-0.6578853125823425,0.09999999999999998,-1.3947467047976326e-17],"LeftFoot":[-0.06556181469032722,0,0],"__hipsD":[0,-0.6350599301580411,0],"__match":[0.4880643048086705,0,0]},"interp":"smooth"},{"t":0.35,"pose":{"LeftUpperLeg":[0.5615277712368485,-0.0026958888599899673,-0.14322252023753687],"RightUpperLeg":[-0.5614251272090356,0.09999999999999996,-2.789493409595265e-17],"LeftFoot":[-0.3568329732048435,0,0],"__hipsD":[0,-0.21660029262089314,0],"__match":[0.45997705290766,0,0]},"interp":"smooth"},{"t":0.5,"pose":{"LeftUpperLeg":[0.0030352381622618294,0.0019921885409277104,-0.005150326321700162],"RightUpperLeg":[-0.0029660277197459963,0.10000000000000002,9.398195569437174e-18],"LeftFoot":[-0.42945691774884776,0,0],"__hipsD":[0,0.7775089591607697,0],"__match":[0.3000000000000001,0,0]},"interp":"smooth"},{"t":0.6,"pose":{"LeftUpperLeg":[-0.4092652726771548,-0.0023923778824583197,0.14008510730993712],"RightUpperLeg":[0.4093814651475191,0.09999999999999991,0],"LeftFoot":[-0.42801863188122974,0,0],"__hipsD":[0,0.24971771322915545,0],"__match":[0.18376986755762137,0,0]},"interp":"smooth"},{"t":0.6833333333333333,"pose":{"LeftUpperLeg":[-0.6325861644071735,0.0030306554022021203,0.11492045801779677],"RightUpperLeg":[0.6325309690854216,0.09999999999999998,3.1381800857946737e-17],"LeftFoot":[-0.019171527894841594,0,0],"__hipsD":[0,-0.5317167032102348,0],"__match":[0.11935322616584029,0,0]},"interp":"smooth"},{"t":0.75,"pose":{"LeftUpperLeg":[-0.6928250232236429,-0.00412386301625756,-0.017670102842105496],"RightUpperLeg":[0.6925260096833658,0.10000000000000002,2.0921200571964492e-17],"LeftFoot":[-0.006660079460002109,0,0],"__hipsD":[0,-0.7484665990856411,0],"__match":[0.10225748776605185,0,0]},"interp":"smooth"},{"t":1,"pose":{"LeftUpperLeg":[-0.0019876986163484566,-0.00964344790459084,-0.007540458611002745],"RightUpperLeg":[0.0020496669771337423,0.0999999999999999,3.8954839606652636e-18],"LeftFoot":[-0.003440685659191414,0,0],"__hipsD":[0,0.7660085980304382,0],"__match":[0.3,0,0]}}]';

describe('подгонка: цикл не сдвинулся', () => {
  it('⭐⭐ ЦИКЛ — БИТ В БИТ С КОДОМ ДО ПРАВКИ (открытый клип добавлен РЯДОМ, а не вместо)', () => {
    // ⚠ Мутации, которые это валят: «зажим вместо круга у гаусса цикла», «односторонние касательные всегда»,
    // «окно гаусса сужать и в цикле», «последний ключ цикла не копировать из первого».
    const r = fitSmoothLoop(cycleFrames(), { epsDeg: 2, sigmaFrames: 1.44 });
    expect(JSON.stringify(r.keys), '⚠ подгонка цикла изменилась').toBe(CYCLE_GOLDEN);
    // и по умолчанию (без `loop`) это тот же цикл
    expect(JSON.stringify(fitSmoothLoop(cycleFrames(), { epsDeg: 2, sigmaFrames: 1.44, loop: true }).keys)).toBe(CYCLE_GOLDEN);
  });

  it('сглаживание: цикл — по кругу, открытый — сужающимся окном (края как есть)', () => {
    const f = cycleFrames(24);
    const lp = smoothLoopFrames(f, 1.5);
    expect(lp.length, 'у цикла замыкание на месте').toBe(f.length);
    expect(lp[0]!.pose['LeftUpperLeg'], 'шов цикла замкнут').toEqual(lp.at(-1)!.pose['LeftUpperLeg']);
    const op = smoothLoopFrames(f, 1.5, false);
    expect(op.length, 'у открытого замыкания нет — кадры как есть').toBe(f.length);
    // ⚠ Мутация «зажим (повтор крайнего кадра) вместо сужения окна»: край уезжает — у поворота это 8.4° на первом
    // кадре, а он ЗАКРЕПЛЁННЫЙ ключ, и подгонка считала бы этот перекос своей неустранимой ошибкой.
    expect(poseErrorDeg(f[0]!.pose, op[0]!.pose), '⚠ край открытого прохода сдвинут сглаживанием').toBeLessThan(1e-9);
    expect(poseErrorDeg(f.at(-1)!.pose, op.at(-1)!.pose), '⚠ край открытого прохода сдвинут сглаживанием').toBeLessThan(1e-9);
    expect(poseErrorDeg(f[12]!.pose, op[12]!.pose), 'а в середине сглаживание работает').toBeGreaterThan(0.01);
  });
});

describe('подгонка открытого клипа', () => {
  /** Открытый проход: разворот корня S-образным профилем + шаг ноги + смена опоры посередине. */
  const openFrames = (n = 60, deg = 90): Keyframe[] => Array.from({ length: n }, (_, i) => {
    const u = i / (n - 1), s = u < 0.2 ? 0 : u > 0.8 ? 1 : (u - 0.2) / 0.6;
    const e = s * s * (3 - 2 * s);                                   // гладкая ступенька
    const air = u > 0.25 && u < 0.55;
    return { t: +(i / 60).toFixed(4), pose: {
      LeftUpperLeg: [air ? 0.5 * Math.sin((u - 0.25) / 0.3 * Math.PI) : 0, 0, 0],
      RightUpperLeg: [0.05 * e, 0, 0],
      Spine: [0, 0.2 * Math.sin(e * Math.PI), 0],
      __hipsD: [0, 0, 0],
      [ROOT_YAW]: [e * deg * Math.PI / 180, 0, 0],
      [SWING_KEY]: [air ? 1 : 0, 0, 0],
    } };
  });
  const fitOpen = (f: Keyframe[], o: Partial<{ epsDeg: number; sigmaFrames: number; pin: number[] }> = {}): ReturnType<typeof fitSmoothLoop> =>
    fitSmoothLoop(f, { epsDeg: o.epsDeg ?? 2, sigmaFrames: o.sigmaFrames ?? 1.44, loop: false, pin: o.pin ?? swingPins(f) });
  const swingPins = (f: readonly Keyframe[]): number[] => {
    const s = (i: number): string => (f[i]!.pose[SWING_KEY] ?? [0, 0, 0]).join(), out: number[] = [];
    for (let i = 1; i < f.length; i++) if (s(i) !== s(i - 1)) out.push(i - 1, i);
    return out;
  };

  it('⭐⭐ КОНЦЫ ТОЧНЫЕ, а не «примерно»: первый и последний ключ — кадр прохода бит в бит', () => {
    // ⚠ Мутация «не закреплять концы» (МНК подбирает и их) валит это: концы уезжают на доли градуса, а на них
    // стоят `turnYawAt(dur)`, `turnSupportAt(0/dur)` и `hy0` шва поворота.
    const f = openFrames();
    const r = fitOpen(f);
    expect(r.keys[0]!.t).toBe(f[0]!.t);
    expect(r.keys.at(-1)!.t).toBe(f.at(-1)!.t);
    for (const [key, want] of [[0, 0], [r.keys.length - 1, f.length - 1]] as [number, number][]) {
      expect(r.keys[key]!.pose, `ключ ${key} = кадр ${want}`).toEqual(f[want]!.pose);
    }
    expect(r.keys.at(-1)!.interp, 'у последнего ключа интервала нет').toBeUndefined();
    expect(r.keys.slice(0, -1).every((k) => k.interp === 'smooth'), 'все интервалы — сплайн').toBe(true);
  });

  it('⭐ КЛЮЧЕЙ — ГОРСТЬ, и ошибка к сглаженному проходу в допуске ТЕМ ЖЕ проигрывателем', () => {
    const f = openFrames();
    const r = fitOpen(f);
    expect(r.keys.length, `ключей ${r.keys.length} из ${f.length} кадров`).toBeLessThanOrEqual(f.length / 2);
    expect(r.errDeg, 'ошибка к сглаженному проходу').toBeLessThanOrEqual(2 + 1e-6);
    // проигрывателем, а не моделью подгонки
    const c = clip(r.keys, false), dur = clipDur(c);
    let worst = 0;
    for (const k of f) worst = Math.max(worst, poseErrorDeg(k.pose, clipPoseAt(c, k.t / dur), (b) => b === 'Spine' || b === 'RightUpperLeg'));
    expect(worst, 'корпус повторяет проход').toBeLessThan(2);
  });

  it('⭐⭐ `__swing` НЕ ГЛАДИТСЯ, ОСТАЁТСЯ В [0,1] И МЕНЯЕТСЯ ТАМ ЖЕ, ГДЕ В ПРОХОДЕ', () => {
    // ⚠ Мутации: «сгладить `__swing` вместе со всеми» (флаг размазывается, смена уезжает) и «не закреплять
    // смены опоры ключами» (между ключами флаг едет рампой в десяток кадров — заземление меняет ногу заранее).
    const f = openFrames();
    const r = fitOpen(f);
    const c = clip(r.keys, false), dur = clipDur(c);
    const kt = r.keys.map((k) => k.t);
    for (const i of swingPins(f)) expect(kt, `кадр смены опоры ${i} (t=${f[i]!.t}) — ключ`).toContain(f[i]!.t);
    for (const i of swingPins(f)) {
      const got = clipPoseAt(c, f[i]!.t / dur)[SWING_KEY]!, want = f[i]!.pose[SWING_KEY]!;
      for (let j = 0; j < 3; j++) expect(got[j]!, `флаг на кадре ${i}, компонента ${j}`).toBeCloseTo(want[j]!, 9);
    }
    // вдоль всего клипа флаг в [0,1] и меняет сторону ровно на тех же временах (± полкадра)
    const flip = (c2: Clip, get: (t: number) => number): number[] => {
      const out: number[] = []; let prev = get(0);
      for (let t = 1 / 240; t <= dur + 1e-9; t += 1 / 240) { const v = get(Math.min(dur, t)); if ((v < 0.5) !== (prev < 0.5)) out.push(t); prev = v; }
      return out;
    };
    const val = (t: number): number => { const s = clipPoseAt(c, t / dur)[SWING_KEY]![0]; expect(s).toBeGreaterThanOrEqual(-1e-9); expect(s).toBeLessThanOrEqual(1 + 1e-9); return s; };
    const got = flip(c, val);
    const want = swingPins(f).filter((_, i) => i % 2 === 0).map((i) => (f[i]!.t + f[i + 1]!.t) / 2);
    expect(got.length, `смен опоры ${got.length}, в проходе ${want.length}`).toBe(want.length);
    got.forEach((t, i) => expect(Math.abs(t - want[i]!), `смена ${i}: ${t.toFixed(4)} против ${want[i]!.toFixed(4)}`).toBeLessThan(1 / 120));
  });

  it('⭐⭐ КУРС КОРНЯ ВНУТРИ МЕРЫ ОШИБКИ: подгонка не теряет градусы разворота', () => {
    // Проход, где кости почти не двигаются, а корень разворачивается на 90° резкой ступенькой: без члена меры
    // подгонка видит «ничего не происходит», обходится начальными ключами и срезает угол.
    // ⚠ Мутация «убрать член `__rootY` из `fitErrorDeg`»: ЗАМЕР — 23.34° потери курса против 2.01° сейчас
    // (и 4 ключа вместо 7: без члена меры подгонке нечего добирать).
    const n = 60;
    const f: Keyframe[] = Array.from({ length: n }, (_, i) => {
      const u = i / (n - 1), s = Math.min(1, Math.max(0, (u - 0.35) / 0.3)), e = s * s * (3 - 2 * s);
      return { t: +(i / 60).toFixed(4), pose: { Spine: [0, 0, 0], [ROOT_YAW]: [e * Math.PI / 2, 0, 0] } };
    });
    const r = fitSmoothLoop(f, { epsDeg: 2, sigmaFrames: 1.44, loop: false });
    const c = clip(r.keys, false), dur = clipDur(c);
    let worst = 0;
    for (const k of f) worst = Math.max(worst, Math.abs((k.pose[ROOT_YAW]![0] - clipPoseAt(c, k.t / dur)[ROOT_YAW]![0])) * 180 / Math.PI);
    expect(worst, `⚠ подгонка потеряла ${worst.toFixed(2)}° курса`).toBeLessThan(3);
    expect(Math.abs(turnYawAt(c, dur) * 180 / Math.PI - 90), 'конец разворота точен (закреплён)').toBeLessThan(1e-9);
  });
});

describe('запечённые повороты', () => {
  beforeAll(() => {
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: () => null, setItem: () => { /* */ }, removeItem: () => { /* */ }, clear: () => { /* */ }, key: () => null, length: 0,
    } as Storage;
  });
  afterAll(() => { delete (globalThis as unknown as { localStorage?: Storage }).localStorage; });

  it('⭐⭐ КЛЮЧЕЙ ВДВОЕ МЕНЬШЕ ЛОМАНОЙ, интервалы — сплайн, концы и опора не сдвинулись', () => {
    // ЗАМЕР (рыцарь, опубликованный воин): ломаная 28–47 ключей на клип (201 на шесть) → сплайн 13–19 (93).
    // Средняя ошибка к плотному проходу по костям без стоп 0.075–0.156° — как у цикла походки (0.056–0.103°).
    // ⚠ Мутация «ломаная по умолчанию» (`smooth: false`) валит это.
    const h = buildHumanoid({});
    const p = new PosePlayer(h, () => [], localStorageContent('warrior'), 'none', GX, emptyGrid());
    const smooth = bakeTurnSet(p, h, { character: 'warrior', weapon: 'none' });
    const h2 = buildHumanoid({});
    const p2 = new PosePlayer(h2, () => [], localStorageContent('warrior'), 'none', GX, emptyGrid());
    const линия = bakeTurnSet(p2, h2, { character: 'warrior', weapon: 'none', smooth: false });
    const h3 = buildHumanoid({});
    const p3 = new PosePlayer(h3, () => [], localStorageContent('warrior'), 'none', GX, emptyGrid());
    const dense = bakeTurnSet(p3, h3, { character: 'warrior', weapon: 'none', epsDeg: 0, smooth: false });
    let sum = 0, sumLin = 0;
    for (const r of smooth) {
      const lin = линия.find((x) => x.clip.name === r.clip.name)!.clip.keys.length;
      const d = dense.find((x) => x.clip.name === r.clip.name)!.clip;
      sum += r.clip.keys.length; sumLin += lin;
      // ⚠ Порог — «на 40 % меньше», а не «вдвое»: на голом риге (`buildHumanoid({})`) ломаная и так короче, чем на
      // рыцаре с опубликованным воином (26 против 30 у `turn_L_90`), и «вдвое» было бы порогом рига, а не правки.
      expect(r.clip.keys.length * 10, `${r.clip.name}: сплайн ${r.clip.keys.length} ключей против ${lin} у ломаной`).toBeLessThanOrEqual(lin * 6);
      expect(r.clip.keys.slice(0, -1).every((k) => k.interp === 'smooth'), `${r.clip.name}: ⚠ запеклась ломаная`).toBe(true);
      // концы — кадр прохода бит в бит (курс, опора, поза)
      expect(r.clip.keys[0]!.pose, `${r.clip.name}: первый ключ = первый кадр`).toEqual(d.keys[0]!.pose);
      expect(r.clip.keys.at(-1)!.pose, `${r.clip.name}: последний ключ = последний кадр`).toEqual(d.keys.at(-1)!.pose);
      // опора меняется там же, где в плотном проходе (± полкадра)
      const times = (c: Clip): number[] => {
        const dur = clipDur(c) || 1, out: number[] = []; let prev = turnSupportAt(c, 0).join();
        for (let t = 1 / 240; t <= dur + 1e-9; t += 1 / 240) { const s = turnSupportAt(c, Math.min(dur, t)).join(); if (s !== prev) { out.push(t); prev = s; } }
        return out;
      };
      const want = times(d), got = times(r.clip);
      expect(got.length, `${r.clip.name}: смен опоры ${got.length}, в проходе ${want.length}`).toBe(want.length);
      got.forEach((t, i) => expect(Math.abs(t - want[i]!), `${r.clip.name}: смена ${i}`).toBeLessThan(1 / 120));
      // Курс в конце — РОВНО тот, что снял планировщик (концы закреплены), и в пределах номинала, как стерёг
      // `turnInPlace.test.ts` (у доворота мёртвая зона: на голом риге 90° встают на 88.8°).
      const want2 = TURN_PRESETS.find((s) => s.name === r.clip.name)!.deg;
      expect(turnYawAt(r.clip, clipDur(r.clip)), `${r.clip.name}: курс в конце — бит в бит с проходом`).toBe(turnYawAt(d, clipDur(d)));
      expect(Math.abs(turnYawAt(r.clip, clipDur(r.clip)) * 180 / Math.PI - want2), `${r.clip.name}: курс в конце`).toBeLessThan(2);
    }
    expect(sum * 2, `всего ключей: сплайн ${sum}, ломаная ${sumLin}`).toBeLessThanOrEqual(sumLin);   // на всём наборе — вдвое
  }, 60000);

  it('допуск и сглаживание берутся те же, что у цикла походки', () => {
    expect(SMOOTH_EPS_DEG).toBe(2);
    expect(SMOOTH_SIGMA_CYCLE).toBeCloseTo(0.024, 6);
  });
});

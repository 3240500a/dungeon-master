import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as THREE from 'three';
import { buildHumanoid, type Humanoid } from './humanoid.js';
import { PosePlayer, localStorageContent, emptyGrid, setLocoMixOverride, migrateHipsOpen, type PoseContent, type GaitCfg } from './poseRuntime.js';
import { bakeGaitSet, GAIT_PRESETS } from './clipBake.js';
import { clipPoseAt, type Clip } from './clipModel.js';
import { pelvisHeading } from './pelvisFrame.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { GAIT, POSE, STRAFE_R, STRAFE_L, PoseDriver } from './pose.js';

/**
 * ⭐⭐ РЫСК ТАЗА — ТРЕТЬЯ ПЛОСКОСТЬ ТАЗА (19.09, просьба автора: «настраивать страйф с чуть повёрнутым тазом»).
 *
 * Две ручки, и пути у них РАЗНЫЕ:
 *  • `POSE.hipsTurn` — СТАТИЧЕСКИЙ поворот, идёт в КУРС планировщика (`PosePlayer.legsTurn`): низ тела
 *    поворачивается целиком, стопы плантуются в повёрнутом кадре, колени и носки за тазом;
 *  • `POSE.hipsYawSwing` — КАЧАНИЕ за шаг, ТОЛЬКО на кость (`PoseTargets.hipsYaw`): подай его в курс — задрожат
 *    сами цели плантов, и опорная стопа поедет.
 *
 * Сторожит то, на чём рыск таза ломается ТИХО (обе грабли в этом коде уже случались):
 *  1. клип страйфа КАНОНИЧЕСКИЙ — таз повёрнут, встречный отворот в Spine..UpperChest, доли записаны (`hipsYawW`);
 *  2. рыск, сидящий В КОСТИ, к курсу НЕ прибавляется (иначе 35° → 70°), но ВЫЧИТАЕТСЯ из бюджета скрутки и
 *     уходит в отворот — грудь и оружие на прицеле;
 *  3. приложенный угол ИЗМЕРЯЕТСЯ (`pelvisHeading` до/после), а не читается из слота Y эйлера;
 *  4. качание НЕ доезжает до планировщика;
 *  5. отказ съёма по бюджету скрутки считает ПИК (поворот + качание), а не среднее;
 *  6. сторож съёма меряет таз ПО РИГУ и ловит ПЯТЫЙ источник рыска, а не сверяет сумму саму с собой;
 *  7. порядок пресетов в наборе не влияет на содержимое клипов;
 *  8. мёртвый набор `*_strafe_*_open` (режим «таз открыт», снят 19.09) не читается вовсе;
 *  9. миграция `hipsMode` 1 даёт ТОТ ЖЕ угол таза, что старый режим.
 */
const GX = { armDown: 1.35, elbowBend: 0.25 };
const D = Math.PI / 180;
const TURN_RUN = 20 * D, TURN_WALK = 8 * D;
const libs: Record<'plain' | 'yaw', Map<string, Clip>> = { plain: new Map(), yaw: new Map() };

const clearCols = (): void => {
  for (const k of Object.keys(STRAFE_R)) delete STRAFE_R[k];
  for (const k of Object.keys(STRAFE_L)) delete STRAFE_L[k];
};
/** Поворот таза по сторонам: вправо — к ходу (+), влево — к ходу (−). Ровно то, что делало раскрытие. */
const setTurn = (run = TURN_RUN, walk = TURN_WALK, swing = 0): void => {
  STRAFE_R['hipsTurn'] = walk; STRAFE_R['hipsTurnRun'] = run;
  STRAFE_L['hipsTurn'] = -walk; STRAFE_L['hipsTurnRun'] = -run;
  if (swing) { for (const m of [STRAFE_R, STRAFE_L]) { m['hipsYawSwing'] = swing; m['hipsYawSwingRun'] = swing; } }
};

beforeAll(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: () => null, setItem: () => { /* */ }, removeItem: () => { /* */ }, clear: () => { /* */ }, key: () => null, length: 0,
  } as Storage;
  const h = buildHumanoid({});
  const p = new PosePlayer(h, () => [], localStorageContent('warrior'), 'none', GX, emptyGrid());
  const bake = (): Map<string, Clip> =>
    new Map(bakeGaitSet(p, h, { character: 'warrior', weapon: 'none' }, GAIT_PRESETS).map((r) => [r.clip.name, r.clip]));
  GAIT.warpOn = 1; GAIT.warpMax = 45;   // съём обязан от тумблеров НЕ зависеть
  clearCols();
  libs.plain = bake();
  setTurn();
  libs.yaw = bake();
  clearCols();
  GAIT.warpOn = 0;
});
afterAll(() => { delete (globalThis as unknown as { localStorage?: Storage }).localStorage; });
afterEach(() => { setLocoMixOverride(null); clearCols(); POSE.hipsTurn = POSE.hipsTurnRun = POSE.hipsYawSwing = POSE.hipsYawSwingRun = 0; POSE.hipsPitchSwing = POSE.hipsPitchSwingRun = 0; });

/** Средний рыск (°) кости по клипу — ЗАМЕРЕННЫЙ курс композиции, а не слот Y. */
const meanYaw = (c: Clip, bones: readonly string[]): number => {
  const q = new THREE.Quaternion(), e = new THREE.Euler();
  let s = 0; const N = 40;
  for (let i = 0; i < N; i++) {
    const pose = clipPoseAt(c, i / N);
    for (const b of bones) { const v = pose[b]; if (v) s += pelvisHeading(q.setFromEuler(e.set(v[0], v[1], v[2], 'XYZ'))); }
  }
  return s / N / D;
};
const yawOf = (h: Humanoid, bone: string): number => {
  const q = h.bones.get(bone)!.getWorldQuaternion(new THREE.Quaternion());
  const f = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  return Math.atan2(f.x, f.z) / D;
};
const wrapD = (a: number): number => ((a + 540) % 360) - 180;

interface Run { pelvis: number; chest: number; player: PosePlayer; human: Humanoid }
/** Стойка со смешиванием груди (`swing` 0.45 = `pe_sway` воина): без неё разбавление отворота не проверялось бы. */
const run = (lib: Map<string, Clip>, vx: number, o: { mix?: number; aim?: number; frames?: number } = {}): Run => {
  GAIT.warpOn = 1; GAIT.warpMax = 45;
  const base = localStorageContent('warrior');
  const content: PoseContent = {
    ...base,
    locoClip: (names: readonly string[]) => { for (const n of names) { const c = lib.get(n); if (c) return c; } return null; },
    resolveUpper: () => ({ swing: 0.45, pose: { Chest: [0, 0, 0], UpperChest: [0, 0, 0], LeftUpperArm: [0.3, 0, -0.6], RightUpperArm: [0.3, 0, 0.6] } }),
  };
  const aim = o.aim ?? 0;
  const h = buildHumanoid({});
  const p = new PosePlayer(h, () => [], content, 'none', GX, emptyGrid());
  setLocoMixOverride(o.mix ?? 1);
  p.setVel(vx * Math.cos(aim * D), -vx * Math.sin(aim * D)); p.setYaw(aim * D); p.snapYaw();
  const N = o.frames ?? 240;
  let pelvis = 0, chest = 0, n = 0;
  for (let i = 0; i < N; i++) {
    p.step(1 / 60); h.root.updateMatrixWorld(true);
    if (i >= N / 2) { pelvis += wrapD(yawOf(h, 'Hips') - aim); chest += wrapD(yawOf(h, 'UpperChest') - aim); n++; }
  }
  GAIT.warpOn = 0;
  return { pelvis: pelvis / n, chest: chest / n, player: p, human: h };
};

describe('рыск таза: съём', () => {
  it('⭐⭐ КЛИП СТРАЙФА КАНОНИЧЕСКИЙ: таз повёрнут, Spine..UpperChest отвёрнут на минус столько же, доли записаны', () => {
    for (const [name, want] of [['run_strafe_R', 20], ['run_strafe_L', -20], ['walk_strafe_R', 8], ['walk_strafe_L', -8]] as const) {
      const c = libs.yaw.get(name)!;
      expect(c, name).toBeTruthy();
      expect(c.hipsYawW, `${name}: доли отворота записаны — по ним рантайм снимет запечённую скрутку`).toBeTruthy();
      expect(c.hipsYawW!.reduce((a, v) => a + v, 0)).toBeCloseTo(1, 3);
      expect(c.hipsYawDeg, `${name}: подпись угла`).toBeCloseTo(want, 0);
      expect(meanYaw(c, ['Hips']), `${name}: таз повёрнут К ХОДУ`).toBeCloseTo(want, 0);
      expect(Math.abs(meanYaw(c, ['Spine', 'Chest', 'UpperChest']) + want), `${name}: встречный отворот в клипе`).toBeLessThan(2.5);
      expect(Math.abs(meanYaw(c, ['Neck', 'Head'])), `${name}: шея и голова без отворота`).toBeLessThan(1);
    }
    // ⚠ БЕЗ РУЧКИ КЛИП ЧИСТ — и метки нет: иначе рантайм стал бы вычитать из бюджета скрутки то, чего в клипе нет.
    for (const n of ['walk_strafe_R', 'run_strafe_L', 'run_fwd', 'walk_back']) {
      expect(Math.abs(meanYaw(libs.plain.get(n)!, ['Hips'])), n).toBeLessThan(0.5);
      expect(libs.plain.get(n)!.hipsYawW, `${n}: метки нет`).toBeUndefined();
    }
    // Ход вперёд/назад колонкой страйфа не задет — поворот туда не просачивается.
    for (const n of ['run_fwd', 'walk_back']) expect(Math.abs(meanYaw(libs.yaw.get(n)!, ['Hips'])), n).toBeLessThan(0.5);
  });

  it('⭐ ОТКАЗ СЪЁМА ПО БЮДЖЕТУ СКРУТКИ — ПО ПИКУ (поворот + качание), А НЕ ПО СРЕДНЕМУ', () => {
    // ⚠ Мутация «проверять только статический поворот» (как было у раскрытия) пропускает вторую строку:
    // средний рыск там 0, а на пике качания таз уходит за предел, и в клип уходит НЕДОкрученный отворот.
    const h = buildHumanoid({});
    const p = new PosePlayer(h, () => [], localStorageContent('warrior'), 'none', GX, emptyGrid());
    const one = (): void => { bakeGaitSet(p, h, { character: 'warrior', weapon: 'none' }, GAIT_PRESETS.filter((s) => s.name === 'run_strafe_R')); };
    const maxTw = p.twistStates.run.maxTwist / D;
    clearCols();
    setTurn((maxTw + 20) * D, 0);
    expect(() => one(), 'поворот больше бюджета').toThrow(/макс\. скрутка верха/);
    clearCols();
    setTurn(0, 0, (maxTw + 25) * D);   // ⭐ статика 0, а качание на пике вылезает за предел
    expect(() => one(), '⚠ ПИК качания больше бюджета — тоже отказ').toThrow(/макс\. скрутка верха/);
    clearCols();
    setTurn((maxTw - 10) * D, 0);
    expect(() => one(), 'в бюджет влезает — съём идёт').not.toThrow();
  });

  it('⭐⭐ СТОРОЖ СЪЁМА МЕРЯЕТ ТАЗ ПО РИГУ, А НЕ СКЛАДЫВАЕТ ИЗВЕСТНЫЕ СЛАГАЕМЫЕ', () => {
    // ⚠ Мутация «вернуть `pelvisYaw − aimRootYaw` вместо замера `pelvisHeading` по кости» = сумма сверяется сама
    // с собой: качание рыска (оно в КОСТИ, в `pelvisYaw` не входит) уехало бы в клип молча.
    const SRC = readFileSync(path.join(__dirname, 'clipBake.ts'), 'utf8');
    const fn = SRC.slice(SRC.indexOf('function assertPelvis'), SRC.indexOf('const wrapPiLocal'));
    expect(fn, 'левая часть — ЗАМЕР по кости таза').toMatch(/pelvisHeading\(human\.bones\.get\('Hips'\)!\.quaternion\)/);
    expect(fn, 'правая часть перечисляет ВСЕ известные источники').toMatch(/hipsTurnRad \+ player\.hipsYawSwingRad \+ player\.clipHipsYawRad \+ player\.stancePelvisYaw/);
    // И сам замер идёт с КАЖДОГО кадра съёма, а не один раз.
    expect(SRC).toMatch(/assertPelvis\(player, human, 0, spec\.name\);\s*\n\s*assertYawBudget/);
  });

  it('⭐⭐ ПОРЯДОК ПРЕСЕТОВ НЕ ВЛИЯЕТ НА СОДЕРЖИМОЕ КЛИПОВ (`resetGaitState`)', () => {
    // ⚠ БЫЛО (ЗАМЕР 19.09): весь набор гонится через ОДИН плеер, разогрев 2 с фазу планировщика не обнуляет —
    // и правка одной ручки двигала КАЖДЫЙ клип, снятый ПОСЛЕ неё (`run_back` на 22.48°, `walk_strafe_R` на 2.22°,
    // при 0.00° у всего, снятого ДО). Мутация «убрать `resetGaitState` из `bakeGaitWarpFree`» валит это.
    const h = buildHumanoid({});
    const p = new PosePlayer(h, () => [], localStorageContent('warrior'), 'none', GX, emptyGrid());
    const bake = (specs: typeof GAIT_PRESETS): Map<string, Clip> =>
      new Map(bakeGaitSet(p, h, { character: 'warrior', weapon: 'none' }, specs).map((r) => [r.clip.name, r.clip]));
    const straight = bake(GAIT_PRESETS);
    const shuffled = bake([...GAIT_PRESETS].reverse());
    let worst = 0, who = '—';
    const q0 = new THREE.Quaternion(), q1 = new THREE.Quaternion(), e = new THREE.Euler();
    for (const [name, a] of straight) {
      const b = shuffled.get(name)!;
      expect(b, name).toBeTruthy();
      expect(b.keys.length, `${name}: число ключей`).toBe(a.keys.length);
      for (let i = 0; i < 24; i++) {
        const pa = clipPoseAt(a, i / 24), pb = clipPoseAt(b, i / 24);
        for (const bone of Object.keys(pa)) {
          const va = pa[bone]!, vb = pb[bone]; if (!vb || bone[0] === '_') continue;
          const d = q0.setFromEuler(e.set(va[0], va[1], va[2], 'XYZ')).angleTo(q1.setFromEuler(e.set(vb[0], vb[1], vb[2], 'XYZ'))) / D;
          if (d > worst) { worst = d; who = `${name}/${bone}`; }
        }
      }
    }
    // ⚠ Порог 1e-3° — это уровень ШУМА double на 300 кадрах тригонометрии, а не остаток состояния: ЗАМЕР даёт
    // 3.4e-6°, тогда как ДО правки порядок двигал клипы на 22.48° (`run_back`) и 2.22° (`walk_strafe_R`).
    expect(worst, `⚠ порядок съёма влияет на клипы: ${who} расходится на ${worst.toFixed(6)}°`).toBeLessThan(1e-3);
  });
});

describe('рыск таза: рантайм', () => {
  it('⭐⭐ РЫСК ИЗ КЛИПА НЕ СЧИТАЕТСЯ ДВАЖДЫ, А ГРУДЬ ОСТАЁТСЯ НА ПРИЦЕЛЕ', () => {
    // ⚠ Грабля уже случалась: прибавь рыск клипа ещё и к курсу — таз 70° вместо 35°.
    // ⚠ Вторая грабля: не вычти его из бюджета скрутки и не положи в отворот — грудь уедет на весь угол
    //   (Chest/UpperChest смешиваются со стойкой по `pe_sway`, и запечённый отворот разбавляется).
    for (const aim of [0, 137, -100]) {
      const r = run(libs.yaw, 120, { aim });
      expect(r.pelvis, `прицел ${aim}: таз на повороте клипа, а не на удвоенном`).toBeGreaterThan(12);
      expect(r.pelvis, `прицел ${aim}: таз ${r.pelvis.toFixed(1)}° — не удвоен`).toBeLessThan(30);
      expect(Math.abs(r.chest), `прицел ${aim}: грудь мимо прицела на ${r.chest.toFixed(1)}°`).toBeLessThan(6);
    }
    // Контроль: без ручки таз ровный — значит предыдущие числа принесла именно она.
    const flat = run(libs.plain, 120);
    expect(Math.abs(flat.pelvis), 'без ручки таз ровный').toBeLessThan(3);
  });

  it('⭐⭐ НИ ПОВОРОТ, НИ КАЧАНИЕ НЕ ДОЕЗЖАЮТ ДО ПЛАНИРОВЩИКА: планты и ноги БИТ В БИТ', () => {
    // ТРЕБОВАНИЕ АВТОРА (19.09): «сделай так, чтобы поворот таза не влиял на планты и на движение ног».
    // Планировщик гоняется напрямую: его цели — это и есть «куда встанет стопа», а `PoseTargets` — сами ноги.
    const LEGK = ['hipL', 'hipR', 'knL', 'knR', 'hipLatL', 'hipLatR', 'ankL', 'ankR', 'bobY'] as const;
    const trace = (turn: number, swing: number): { rows: number[]; yaw: number; drift: number } => {
      POSE.hipsTurn = POSE.hipsTurnRun = turn; POSE.hipsYawSwing = POSE.hipsYawSwingRun = swing;
      const h = buildHumanoid({});
      const p = new PosePlayer(h, () => [], localStorageContent('warrior'), 'none', GX, emptyGrid());
      setLocoMixOverride(0);                       // ЧИСТАЯ процедурка: клипов в этой пробе нет
      p.setVel(120, 0); p.setYaw(0); p.snapYaw();
      const rows: number[] = []; let yaw = 0, drift = 0;
      const anchor: ([number, number] | null)[] = [null, null];
      for (let i = 0; i < 300; i++) {
        p.step(1 / 60);
        const sw = p.driver.swingLegs;
        for (let L = 0; L < 2; L++) {
          const t = p.driver.plantTarget(L);
          if (sw[L]) anchor[L] = null;
          else if (!anchor[L]) anchor[L] = [t[0], t[1]];
          else if (i >= 150) drift = Math.max(drift, Math.hypot(t[0] - anchor[L]![0], t[1] - anchor[L]![1]));
        }
        // Планты берём ОТНОСИТЕЛЬНО ТЕЛА: абсолютные растут вместе с ходом, и сравнение было бы шумным.
        const a = p.driver.plantTarget(0), b = p.driver.plantTarget(1);
        rows.push(a[0] - p.posX, a[1] - p.posZ, b[0] - p.posX, b[1] - p.posZ);
        const o = p.driver.out as unknown as Record<string, number>;
        for (const k of LEGK) rows.push(o[k]!);
        if (i >= 150) yaw = p.hipsTurnRad;
      }
      return { rows, yaw, drift };
    };
    const base = trace(0, 0);
    const swung = trace(0, 0.25);
    const diff = (a: number[], b: number[]): number => a.reduce((m, v, i) => Math.max(m, Math.abs(v - (b[i] ?? 0))), 0);
    // ⚠ ГЛАВНЫЙ СТОРОЖ КАЧАНИЯ. Мутация «подать качание в курс планировщика» валит обе строки: цель под ОПОРНОЙ
    // стопой начинает ехать каждый кадр (замер мутации — десятки единиц), и курс перестаёт быть нулевым.
    expect(swung.drift, '⚠ цель под опорной стопой поехала — качание доехало до планировщика').toBeLessThan(1e-9);
    expect(base.drift, 'контроль: у ровного таза она тоже стоит').toBeLessThan(1e-9);
    expect(swung.yaw, 'качание в курс не попало').toBe(0);
    /**
     * ⭐⭐ ПОВОРОТ — БИТ В БИТ. Валят эту строку ТРИ мутации, и каждая была живым багом 19.09:
     *  1. вернуть `legsTurn` в курс (`yaw = rootYaw + warp + turn`) — ячейка плант-сетки уезжает на
     *     `поворот/45°`, вес авторской ячейки 1.0000 → 0.2222 при 35° («хелперы двигают с коэффициентом»);
     *  2. вернуть развод `mixYaw` (доли от одного курса, вынос по другому) — шаг уезжает от хода на угол ручки;
     *  3. не вычитать `turnFeet` из фидбэка стоп — планировщик увидит СВОЙ ЖЕ повёрнутый риг, прибьёт плант к
     *     уехавшей стопе и погонится за хвостом (ЗАМЕР мутации на рыцаре: расхождение 0 → 28 ед. за 8 с).
     */
    for (const deg of [8, 20, 35]) {
      const t = trace(deg * D, 0);
      expect(diff(t.rows, base.rows), `⚠ поворот ${deg}° сдвинул планты/ноги — он обязан быть ЧИСТО ВИДИМЫМ`).toBeLessThan(1e-9);
      expect(t.yaw / D, 'ручка отдаёт РОВНО свой угол').toBeCloseTo(deg, 6);
      expect(t.drift, 'и цель под опорной стопой всё равно стоит').toBeLessThan(1e-9);
    }
  });

  it('⭐⭐ НА СЕРЕДИНЕ БЛЕНДА РУЧКА НЕ ПРОВИСАЕТ И НЕ УДВАИВАЕТСЯ', () => {
    // Процедурный поворот гаснет долей клипа, а в клипе тот же угол уже запечён — сумма обязана быть ОДНА и та же
    // на любой доле. ⚠ Мутация «не гасить вовсе» валит верхнюю границу (двойной счёт).
    // ⚠ ЧЕГО ЭТОТ СТОРОЖ НЕ ЛОВИТ И НЕ ДОЛЖЕН: гашение своим `1 − locoW` вместо `1 − mix` даёт НА УСТАНОВИВШЕМСЯ
    // бленде ТЕ ЖЕ числа (проверено мутацией) — отличается ровно кадр отставания НА ПЕРЕХОДЕ. `1 − mix` выбран
    // потому, что этим же числом гасится вся остальная процедурная поза, а не потому, что второй замеренно хуже.
    setTurn();   // те же углы по сторонам, с которыми снят `libs.yaw`: процедурка и клип обязаны совпасть
    for (const mix of [0, 0.25, 0.5, 0.75, 1]) {
      const r = run(libs.yaw, 120, { mix });
      // ЗАМЕР с верным гашением: 20.000 / 19.999 / 19.998 / 19.997 / 19.996 — РОВНАЯ линия, поэтому и допуск узкий.
      expect(Math.abs(r.pelvis), `доля клипа ${mix}: таз ${r.pelvis.toFixed(2)}° при ручке 20°`).toBeGreaterThan(19.5);
      expect(Math.abs(r.pelvis), `доля клипа ${mix}: таз ${r.pelvis.toFixed(2)}° — не удвоен`).toBeLessThan(20.5);
      expect(Math.abs(r.chest), `доля клипа ${mix}: грудь мимо прицела на ${r.chest.toFixed(1)}°`).toBeLessThan(2);
    }
  });

  it('⭐⭐ ХЕЛПЕР ПЛАНТ-СЕТКИ ДВИГАЕТ ПЛАНТ 1:1 НА ОБЕИХ СТОРОНАХ СТРАЙФА — С ПОВОРОТОМ И БЕЗ', () => {
    // ЖАЛОБА (19.09): «двигаю квадратные хелперы, а точки, куда нога ставится, двигаются как будто с
    // коэффициентом». ПРИЧИНА замерена: ячейка сетки ищется по ходу В ОСЯХ ТАЗА, и повёрнутый таз уводил индекс —
    // вес авторской ячейки выходил ровно `1 − поворот/45°` (1.0000 / 0.5556 / 0.2222 при 0 / 20 / 35°).
    // ⚠ ОБХОД СТОП ВЫКЛЮЧЕН (`footClear` 0) НАРОЧНО: он — единственный законный потребитель, который двигает цель
    // не на то, что просили (уводит её ВПЕРЁД, когда стопы сходятся ближе зазора). Мерить надо сам канал
    // настройки, а не анти-столкновение; с авторскими данными оно живое, см. README.
    const DL = 10;
    const probe = (right: boolean, turn: number, bump: boolean): [number, number] => {
      POSE.hipsTurn = POSE.hipsTurnRun = turn; POSE.hipsYawSwing = POSE.hipsYawSwingRun = 0;
      const g = emptyGrid();
      if (bump) g.walk[right ? 2 : 6]!.l[1] = DL;
      const h = buildHumanoid({});
      const p = new PosePlayer(h, () => [], localStorageContent('warrior'), 'none', GX, g);
      setLocoMixOverride(0);
      p.setVel(right ? 40 : -40, 0); p.setYaw(0); p.snapYaw();
      let sx = 0, sz = 0, n = 0, prev = false;
      for (let i = 0; i < 400; i++) {
        p.step(1 / 60);
        const sw = p.driver.swingLegs[0];
        if (sw && !prev && i > 200) { const t = p.driver.plantTarget(0); sx += t[0] - p.posX; sz += t[1] - p.posZ; n++; }
        prev = sw;
      }
      return [sx / Math.max(1, n), sz / Math.max(1, n)];
    };
    const was = GAIT.footClear; GAIT.footClear = 0;
    try {
      for (const right of [true, false]) for (const turn of [0, 20 * D, 35 * D]) {
        const zero = probe(right, turn, false), lat = probe(right, turn, true);
        const dx = lat[0] - zero[0], dz = lat[1] - zero[1];
        const side = right ? 'вправо' : 'влево', deg = (turn / D).toFixed(0);
        expect(Math.hypot(dx, dz) / DL, `${side}, поворот ${deg}°: плант поехал на ${(Math.hypot(dx, dz) / DL).toFixed(4)} от заданного`).toBeCloseTo(1, 3);
        expect(Math.abs(dz), `${side}, поворот ${deg}°: сдвиг ушёл наискосок на ${dz.toFixed(3)}`).toBeLessThan(0.02);
        expect(dx, `${side}: знак бокового сдвига`).toBeGreaterThan(0);
      }
    } finally { GAIT.footClear = was; }
  });

  it('⭐⭐ ШАГ ИДЁТ ВДОЛЬ ХОДА, А НЕ НАИСКОСОК — при любом повороте таза', () => {
    // ЖАЛОБА (19.09): «шаг тоже как-то чуть наискосок происходит». ПРИЧИНА замерена: ход раскладывался на доли в
    // ОДНОМ кадре (`mixYaw`), а вынос собирался в ДРУГОМ (`yaw` с поворотом) — вектор выноса уезжал от хода ровно
    // на угол ручки (ЗАМЕР на рыцаре, чистый бок: 0.00 → 20.00 → 35.00°).
    const reachAng = (turn: number, vx: number, vz: number): number => {
      POSE.hipsTurn = POSE.hipsTurnRun = turn; POSE.hipsYawSwing = POSE.hipsYawSwingRun = 0;
      const wW = GAIT.stanceWidth, wR = GAIT.stanceWidthRun;
      GAIT.stanceWidth = 0; GAIT.stanceWidthRun = 0;
      try {
        const h = buildHumanoid({});
        const p = new PosePlayer(h, () => [], localStorageContent('warrior'), 'none', GX, emptyGrid());
        setLocoMixOverride(0);
        p.setVel(vx, vz); p.setYaw(0); p.snapYaw();
        let sx = 0, sz = 0, n = 0, prev = false;
        for (let i = 0; i < 400; i++) {
          p.step(1 / 60);
          const sw = p.driver.swingLegs[0];
          if (sw && !prev && i > 200) { const t = p.driver.plantTarget(0); sx += t[0] - p.posX; sz += t[1] - p.posZ; n++; }
          prev = sw;
        }
        const travel = Math.atan2(vx, vz), got = Math.atan2(sx / n, sz / n);
        return Math.atan2(Math.sin(got - travel), Math.cos(got - travel)) / D;
      } finally { GAIT.stanceWidth = wW; GAIT.stanceWidthRun = wR; }
    };
    for (const [nm, vx, vz] of [['вбок вправо', 120, 0], ['вбок влево', -120, 0], ['вперёд', 0, 120], ['назад', 0, -120]] as [string, number, number][]) {
      const a0 = reachAng(0, vx, vz);
      for (const deg of [20, 35]) {
        const a = reachAng(deg * D, vx, vz);
        expect(Math.abs(a - a0), `${nm}, поворот ${deg}°: вынос уехал от хода на ${(a - a0).toFixed(3)}°`).toBeLessThan(0.01);
      }
    }
  });

  it('⭐⭐ У КАНАЛА ПОВОРОТА ЕСТЬ ПРЕДЕЛ СКОРОСТИ, И БЕЗ НЕГО РЫВОК РАСТЁТ С ЧАСТОТОЙ КАДРОВ', () => {
    // ⚠ `st` и доли сторон НЕ сглажены по времени: отпустил страйф — скорость падает в ноль за тик и `st` щёлкает
    // в 0; развернулся A↔D — полоса сторон ±3.44° проскакивается за полтора кадра. Без предела ЗАМЕР (±35°,
    // ровно то, что пишет `migrateHipsOpen`): 2254 °/с при 60 Гц и вдвое больше при 144 — то есть рывок РОС с
    // частотой кадров, ровно тот класс беды, который запрещает `torsoJitter.test.ts`. Предел — общий с
    // доворотом (`GAIT.warpRate`): канал один и тот же, рыск таза.
    const peak = (hz: number, rate: number): number => {
      clearCols();
      STRAFE_R['hipsTurn'] = 35 * D; STRAFE_R['hipsTurnRun'] = 35 * D;
      STRAFE_L['hipsTurn'] = -35 * D; STRAFE_L['hipsTurnRun'] = -35 * D;
      const was = GAIT.warpRate; GAIT.warpRate = rate;
      try {
        const dt = 1 / hz;
        const h = buildHumanoid({});
        const p = new PosePlayer(h, () => [], localStorageContent('warrior'), 'none', GX, emptyGrid());
        setLocoMixOverride(0);
        p.setYaw(0); p.snapYaw();
        let prev = 0, mx = 0;
        const flip = Math.round(2.5 * hz);
        for (let i = 0; i < Math.round(5 * hz); i++) {
          p.setVel(i < flip ? 120 : -120, 0); p.step(dt);
          if (i > flip - 10) mx = Math.max(mx, Math.abs(p.hipsTurnRad - prev) / dt);
          prev = p.hipsTurnRad;
        }
        return mx / D;
      } finally { GAIT.warpRate = was; clearCols(); }
    };
    const HZ = [60, 120, 144];
    const capped = HZ.map((hz) => peak(hz, 300));
    HZ.forEach((hz, i) => {
      expect(capped[i], `${hz} Гц: ${capped[i]!.toFixed(0)} °/с при пределе 300`).toBeLessThan(310);
    });
    // ⚠ Мутация «убрать предел» (`warpRate` мимо канала) валит ЭТО.
    const free = [60, 144].map((hz) => peak(hz, 0));
    expect(free[1]! / free[0]!, `без предела пик обязан расти с частотой кадров: ${free.map((v) => v.toFixed(0)).join(' → ')}`).toBeGreaterThan(1.5);
    expect(free[0], 'и сам по себе быть много выше потолка').toBeGreaterThan(1000);
  });

  it('⭐ КАЧАНИЕ РЫСКА ДЕЙСТВИТЕЛЬНО ПРИКЛАДЫВАЕТСЯ, И ЕГО УГОЛ ИЗМЕРЕН, А НЕ ПРОЧИТАН ИЗ СЛОТА Y', () => {
    // ⚠ Мутация «`this.hipsYawNow = tg.hipsYaw`» (чтение слота вместо замера) валит вторую половину: при
    // ненулевом НАКЛОНЕ таза курс композиции `Rx(наклон)·Ry(рыск)·Rz(крен)` слоту Y не равен.
    const mk = (swing: number, pitch: number): PosePlayer => {
      POSE.hipsYawSwing = POSE.hipsYawSwingRun = swing;
      POSE.hipsPitchSwing = POSE.hipsPitchSwingRun = pitch;
      const h = buildHumanoid({});
      const p = new PosePlayer(h, () => [], localStorageContent('warrior'), 'none', GX, emptyGrid());
      setLocoMixOverride(0);
      p.setVel(0, 120); p.setYaw(0); p.snapYaw();
      return p;
    };
    let peak = 0;
    const p0 = mk(0.35, 0);
    for (let i = 0; i < 300; i++) { p0.step(1 / 60); if (i > 150) peak = Math.max(peak, Math.abs(p0.hipsYawSwingRad)); }
    expect(peak / D, 'ручка вообще работает').toBeGreaterThan(5);

    // С НАКЛОНОМ таза замеренный угол ОБЯЗАН разойтись со слотом Y: это и есть та разница, ради которой замер.
    const p1 = mk(0.5, 0.5);
    let seen = 0;
    for (let i = 0; i < 300; i++) { p1.step(1 / 60); if (i > 150) seen = Math.max(seen, Math.abs(p1.hipsYawSwingRad)); }
    expect(seen, 'с наклоном рыск тоже прикладывается').toBeGreaterThan(0);
    // Сам шов замера — в исходнике: два `pelvisHeading` вокруг записи в кость, а не чтение `t.hipsYaw`.
    const SRC = readFileSync(path.join(__dirname, 'poseRuntime.ts'), 'utf8');
    const blk = SRC.slice(SRC.indexOf('hb.rotation.x = t.hipsPitch'), SRC.indexOf('hb.rotation.x = t.hipsPitch') + 500);
    expect(blk, '⚠ приложенный рыск обязан ИЗМЕРЯТЬСЯ').toMatch(/pelvisHeading\(hb\.quaternion\)[\s\S]*pelvisHeading\(_hyQ\)/);
  });

  it('⚠ МЁРТВЫЙ НАБОР `*_strafe_*_open` НЕ ЧИТАЕТСЯ: поза та же, что без него', () => {
    // ⚠ Мутация «вернуть поиск `имя + _open`» валит это: чужой клип с рыском 35° поехал бы в позу.
    const dead = new Map(libs.plain);
    for (const sp of ['walk', 'run']) for (const sd of ['L', 'R']) {
      const src = libs.yaw.get(`${sp}_strafe_${sd}`)!;
      dead.set(`${sp}_strafe_${sd}_open`, { ...src, name: `${sp}_strafe_${sd}_open` });
    }
    const a = run(libs.plain, 120), b = run(dead, 120);
    expect(Math.abs(b.pelvis - a.pelvis), '⚠ мёртвый `_open` попал в позу').toBeLessThan(1e-6);
  });

  it('⭐ НУЛЕВЫЕ РУЧКИ — НИЧЕГО НЕ МЕНЯЮТ: канал рыска не трогает ни позу, ни курс', () => {
    const drive = (swing: number, turn: number): string => {
      POSE.hipsYawSwing = POSE.hipsYawSwingRun = swing; POSE.hipsTurn = POSE.hipsTurnRun = turn;
      const d = new PoseDriver(); let x = 0, z = 0; const out: number[] = [];
      for (let i = 0; i < 300; i++) {
        x += 80 / 60; d.setWorld(x, z, 0, 80, 0);
        const p0 = d.plantTarget(0), p1 = d.plantTarget(1); d.setFeet(p0[0], p0[1], p1[0], p1[1]);
        const o = d.update(1 / 60) as unknown as Record<string, number>;
        out.push(o.hipL!, o.knL!, o.hipLatL!, o.bobY!, o.hipsRoll!, o.hipsPitch!, o.hipsYaw!);
      }
      return out.map((v) => v.toFixed(12)).join(',');
    };
    expect(drive(0, 0), 'ручки в нуле = поведение бит в бит').toBe(drive(0, 0));
    expect(drive(0.2, 0) === drive(0, 0), 'ручка качания ДЕЙСТВИТЕЛЬНО что-то делает').toBe(false);
  });
});

describe('миграция «таз открыт» → поворот таза', () => {
  it('⭐⭐ `hipsMode` 1 даёт ТОТ ЖЕ угол таза после переноса — и в процедурке, и в «только клипы»', () => {
    // Раскрытие было ±угол ПО СТОРОНЕ хода (`openFrac`), поэтому едет в ручку ОБЕИХ сторон со своими знаками.
    const cfg: GaitCfg = { gait: { hipsMode: 1, hipsOpen: 35, hipsOpenWalk: 10 } };
    expect(migrateHipsOpen(cfg), 'миграция сработала').toBe(true);
    expect(cfg.gait!['hipsMode'], 'режим вычищен — второй раз переносить нечего').toBeUndefined();
    expect(cfg.strafeR!['hipsTurnRun']! / D, 'вправо — к ходу').toBeCloseTo(35, 6);
    expect(cfg.strafeL!['hipsTurnRun']! / D, 'влево — к ходу, другой знак').toBeCloseTo(-35, 6);
    expect(cfg.strafeR!['hipsTurn']! / D, 'ходьба').toBeCloseTo(10, 6);
    expect(cfg.strafeL!['hipsTurn']! / D).toBeCloseTo(-10, 6);
    // Идемпотентность и «не затирать настроенное».
    expect(migrateHipsOpen(cfg), 'второй раз переносить нечего').toBe(false);
    const own: GaitCfg = { gait: { hipsMode: 1, hipsOpen: 35, hipsOpenWalk: 10 }, strafeR: { hipsTurnRun: 0.1 } };
    migrateHipsOpen(own);
    expect(own.strafeR!['hipsTurnRun'], '⚠ уже настроенное автор трогать не давал').toBe(0.1);

    // ⭐ РАВЕНСТВО УГЛА. Старое раскрытие 35° на бегу вбок давало таз ≈35° к ходу; после миграции его даёт ручка.
    clearCols();
    for (const [k, v] of Object.entries(cfg.strafeR!)) STRAFE_R[k] = v;
    for (const [k, v] of Object.entries(cfg.strafeL!)) STRAFE_L[k] = v;
    const h = buildHumanoid({});
    const p = new PosePlayer(h, () => [], localStorageContent('warrior'), 'none', GX, emptyGrid());
    setLocoMixOverride(0);
    GAIT.warpOn = 1; GAIT.warpMax = 45;
    p.setVel(120, 0); p.setYaw(0); p.snapYaw();
    let proc = 0;
    for (let i = 0; i < 300; i++) { p.step(1 / 60); if (i > 200) proc = p.hipsTurnRad / D; }
    GAIT.warpOn = 0;
    expect(proc, 'процедурка: таз повёрнут на перенесённый угол').toBeCloseTo(35, 0);

    // «Только клипы»: тот же угол приезжает из клипа, снятого С ЭТОЙ ЖЕ ручкой.
    const h2 = buildHumanoid({});
    const p2 = new PosePlayer(h2, () => [], localStorageContent('warrior'), 'none', GX, emptyGrid());
    const lib = new Map(bakeGaitSet(p2, h2, { character: 'warrior', weapon: 'none' },
      GAIT_PRESETS.filter((s) => /_strafe_|_fwd|_back/.test(s.name))).map((r) => [r.clip.name, r.clip]));
    const r = run(lib, 120);
    expect(r.pelvis, '«только клипы»: тот же угол').toBeGreaterThan(25);
    expect(Math.abs(r.chest), 'грудь на прицеле').toBeLessThan(8);
    clearCols();
  });
});

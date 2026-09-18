import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as THREE from 'three';
import { buildHumanoid, type Humanoid } from './humanoid.js';
import { PosePlayer, localStorageContent, emptyGrid, setLocoMixOverride, type PoseContent } from './poseRuntime.js';
import { bakeGaitSet, GAIT_PRESETS, openStrafePresets } from './clipBake.js';
import { clipPoseAt, type Clip } from './clipModel.js';
import { findLocoClip } from './locoBlend.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { GAIT } from './pose.js';

/**
 * ⭐⭐ ТАЗ НА ХОДЕ БОКОМ: «ровно» (`hipsMode` 0) против «открыт» (`hipsMode` 1, набор `*_strafe_*_open`).
 *
 * Сторожит то, на чём «открыт» ломается тихо:
 *  1. клип `_open` КАНОНИЧЕСКИЙ — таз раскрыт к ходу, отворот в Spine..UpperChest, и съём не зависит от тумблеров редактора
 *     (доворот ВКЛ, `hipsMode` 1 — кардинальный набор всё равно ровный);
 *  2. в НАШЕМ рантайме грудь на прицеле, хотя Chest/UpperChest смешиваются со стойкой по `pe_sway` (без снятия запечённого
 *     отворота грудь уезжала на 41 % угла — замер прототипа 12.3° при 30°);
 *  3. нет клипа ходьбы `_open` (угол ходьбы 0) — ходьба играет кардинальный ЕГО часами (было: циклом бега, 49 % скольжения);
 *  4. переключение «ровно ↔ открыт» мгновенное (без перезапекания) и едет сглаживанием доворота, а не щелчком;
 *  5. пока страйфы не перезапечены (старая складка), «открыт» не включается;
 *  6. планировщик (без «только клипы») показывает раскрытие живьём — то, что снимет кнопка.
 *
 * ⚠ ДВА ПРЕДОХРАНИТЕЛЯ ЗДЕСЬ ОСОЗНАННО ДУБЛИРУЮТ ДРУГ ДРУГА — их мутации сторожа НЕ ловят, и это не дыра:
 *  • `hm` гасится не только режимом, но и `warpSectorsNow` (старые страйфы);
 *  • `wantOpen` в `stepDirWarp` считается только в режиме секторов.
 * Достаточно любого одного: со старой складкой сектор страйфа не возникает вовсе, значит `openFrac` и так 0. Убери
 * ОБА — и «открыт» заиграет поверх старых клипов (это сторож «пока страйфы не перезапечены» уже ловит).
 * Ещё один известный «выживший»: при отсутствующем клипе ходьбы `_open` угол набора считается нулевым (`openClipDeg`),
 * и это влияет ТОЛЬКО на бюджет скрутки — позу и часы в этом случае ведёт кардинальный клип той же скорости.
 */
const GX = { armDown: 1.35, elbowBend: 0.25 };
const D = Math.PI / 180;
const KEYS = ['warpOn', 'warpMax', 'hipsMode', 'hipsOpen', 'hipsOpenWalk'] as const;
const saved: Record<string, number> = {};
const libs: Record<'sq' | 'open' | 'runOnly' | 'stale', Map<string, Clip>> = { sq: new Map(), open: new Map(), runOnly: new Map(), stale: new Map() };

beforeAll(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: () => null, setItem: () => { /* */ }, removeItem: () => { /* */ }, clear: () => { /* */ }, key: () => null, length: 0,
  } as Storage;
  for (const k of KEYS) saved[k] = (GAIT as unknown as Record<string, number>)[k]!;
  GAIT.warpOn = 1; GAIT.warpMax = 45; GAIT.hipsMode = 1;   // съём обязан от тумблеров НЕ зависеть — включаем нарочно
  const h = buildHumanoid({});
  const p = new PosePlayer(h, () => [], localStorageContent('warrior'), 'none', GX, emptyGrid());
  const bake = (specs: Parameters<typeof bakeGaitSet>[3]): Map<string, Clip> =>
    new Map(bakeGaitSet(p, h, { character: 'warrior', weapon: 'none' }, specs).map((r) => [r.clip.name, r.clip]));
  libs.sq = bake(GAIT_PRESETS);
  libs.open = new Map([...libs.sq, ...bake(openStrafePresets(35, 10))]);
  libs.runOnly = new Map([...libs.sq, ...bake(openStrafePresets(35, 0))]);
  libs.stale = new Map([...libs.open].map(([n, c]) => [n, /_strafe_[LR]$/.test(n) ? { ...c, bakeRev: undefined } : c]));
  for (const k of KEYS) (GAIT as unknown as Record<string, number>)[k] = saved[k]!;
});
afterAll(() => { delete (globalThis as unknown as { localStorage?: Storage }).localStorage; });
afterEach(() => { setLocoMixOverride(null); for (const k of KEYS) (GAIT as unknown as Record<string, number>)[k] = saved[k]!; });

const meanY = (c: Clip, bones: readonly string[]): number => {
  let s = 0; const N = 40;
  for (let i = 0; i < N; i++) { const pose = clipPoseAt(c, i / N); for (const b of bones) s += pose[b]?.[1] ?? 0; }
  return s / N / D;
};
const yawOf = (h: Humanoid, bone: string): number => {
  const q = h.bones.get(bone)!.getWorldQuaternion(new THREE.Quaternion());
  const f = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  return Math.atan2(f.x, f.z) / D;
};
interface Run { pelvis: number; chest: number; legs: THREE.Quaternion[][]; pelvisTrace: number[]; jump: number; player: PosePlayer }
const wrapD = (a: number): number => ((a + 540) % 360) - 180;
/** Стойка со смешиванием груди (`swing` 0.45 = `pe_sway` воина): без неё разбавление отворота не проверялось бы. */
const run = (lib: Map<string, Clip>, hm: number, vx: number,
             o: { open?: number; walk?: number; mix?: number; switchAt?: number; from?: number; aim?: number; stopAt?: number } = {}): Run => {
  GAIT.warpOn = 1; GAIT.warpMax = 45; GAIT.hipsMode = o.switchAt !== undefined ? (o.from ?? 0) : hm; GAIT.hipsOpen = o.open ?? 35; GAIT.hipsOpenWalk = o.walk ?? 10;
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
  // Ход задаётся ОТНОСИТЕЛЬНО прицела: мировой курс не должен ни на что влиять (сторож композиции таза).
  const vel = (s: number): void => p.setVel(s * Math.cos(aim * D), -s * Math.sin(aim * D));
  vel(vx); p.setYaw(aim * D); p.snapYaw();
  const pelvisTrace: number[] = [];
  const LEGB = ['LeftUpperLeg', 'LeftLowerLeg', 'RightUpperLeg', 'RightLowerLeg'];
  for (let i = 0; i < 120; i++) { p.step(1 / 60); h.root.updateMatrixWorld(true); pelvisTrace.push(wrapD(yawOf(h, 'Hips') - aim)); }
  if (o.switchAt !== undefined) GAIT.hipsMode = hm;
  let pelvis = 0, chest = 0, jump = 0; const N = 120; const legs: THREE.Quaternion[][] = [];
  let prevQ: THREE.Quaternion[] | null = null;
  for (let i = 0; i < N; i++) {
    if (o.stopAt !== undefined && i === o.stopAt) vel(0);
    p.step(1 / 60); h.root.updateMatrixWorld(true);
    const py = wrapD(yawOf(h, 'Hips') - aim); pelvisTrace.push(py);
    if (i >= (o.switchAt !== undefined ? 30 : 0)) { pelvis += py; chest += wrapD(yawOf(h, 'UpperChest') - aim); }
    const qs = LEGB.map((n) => h.bones.get(n)!.quaternion.clone());
    if (prevQ && (o.stopAt === undefined || i > o.stopAt)) for (let k = 0; k < qs.length; k++) jump = Math.max(jump, qs[k]!.angleTo(prevQ[k]!) / D);
    prevQ = qs;
    legs.push(qs);
  }
  const n = o.switchAt !== undefined ? N - 30 : N;
  return { pelvis: pelvis / n, chest: chest / n, legs, pelvisTrace, jump, player: p };
};

describe('таз на ходе боком: съём', () => {
  it('⭐⭐ КЛИП «ТАЗ ОТКРЫТ» КАНОНИЧЕСКИЙ: Hips.y = угол к ходу, Spine..UpperChest = минус угол, доли записаны', () => {
    for (const [name, sign, deg] of [['run_strafe_R_open', 1, 35], ['run_strafe_L_open', -1, 35], ['walk_strafe_R_open', 1, 10]] as const) {
      const c = libs.open.get(name)!;
      expect(c, name).toBeTruthy();
      expect(c.hipsOpenDeg).toBe(deg);
      expect(c.bakeRev, `${name}: ревизия`).toBe(2);
      expect(c.hipsOpenW!.reduce((a, v) => a + v, 0)).toBeCloseTo(1, 3);
      expect(meanY(c, ['Hips']), `${name}: таз раскрыт К ХОДУ`).toBeCloseTo(sign * deg, 0);
      expect(Math.abs(meanY(c, ['Spine', 'Chest', 'UpperChest']) + sign * deg), `${name}: отворот в клипе`).toBeLessThan(2);
      expect(Math.abs(meanY(c, ['Neck', 'Head'])), `${name}: шея и голова без отворота`).toBeLessThan(1);
    }
    // Кардинальный набор снят с доворотом ВКЛ и «таз открыт» в редакторе — и всё равно ровный (перекрытие доворота на съёме).
    for (const n of ['walk_strafe_R', 'run_strafe_L']) {
      expect(Math.abs(meanY(libs.sq.get(n)!, ['Hips'])), n).toBeLessThan(0.5);
      expect(libs.sq.get(n)!.hipsOpenDeg, n).toBeUndefined();
    }
    expect(libs.runOnly.has('walk_strafe_R_open'), 'угол ходьбы 0 — клипа ходьбы нет').toBe(false);
  });

});

describe('таз на ходе боком: редактор', () => {
  const SRC = readFileSync(path.join(__dirname, 'pose-editor.ts'), 'utf8');
  const fn = (name: string): string => { const i = SRC.indexOf(`function ${name}(`); expect(i, name).toBeGreaterThan(0); return SRC.slice(i, SRC.indexOf('\n}\n', i)); };

  it('⭐ НАБОР `_open` ПЕРЕЗАПЕКАЕТСЯ ВМЕСТЕ С ОСНОВНЫМ — И КОГДА РЕЖИМ ВЫКЛЮЧЕН, лишь бы набор существовал', () => {
    // ⚠ Иначе тихое расхождение: правишь плант-сетку или ползунки бега в «ровно», жмёшь «запечь набор» — кардинальный
    // снят заново, а `_open` остался со старой походкой, и сравнение «ровно» ↔ «открыт» сравнивает РАЗНЫЕ настройки.
    expect(SRC).toMatch(/const withOpen = !!\(GAIT\.warpOn && \(GAIT\.hipsMode \| 0\) === 1\) \|\| openSetExists\(\);/);
    expect(SRC.slice(SRC.indexOf('const openSetExists'), SRC.indexOf('const openSetExists') + 200))
      .toMatch(/openSetPair\('walk'\)\.open \|\| !!openSetPair\('run'\)\.open/);
  });

  it('⭐ РАСХОЖДЕНИЕ НАБОРОВ ВИДНО ПО ДВУМ ПРИЗНАКАМ: угол ползунка И номер съёма `bakeId`', () => {
    const s = fn('openSetStale');
    expect(s, 'угол набора против ползунка').toMatch(/Math\.abs\(\(open\.hipsOpenDeg \?\? 0\) - want\) > 0\.5/);
    expect(s, '⚠ номер съёма: наборы сняты РАЗНЫМИ прогонами — расхождение в ЛЮБУЮ сторону, и молчаливое').toMatch(/sq\.bakeId \?\? 0\) !== \(open\.bakeId \?\? 0\)/);
    // Клип `_open` берётся ТОЛЬКО того же оружия, что разрешённый кардинальный (иначе показывались бы чужие углы).
    expect(fn('openSetPair')).toMatch(/open\.weapon === sq\.weapon && open\.character === sq\.character/);
  });
});

describe('таз на ходе боком: рантайм', () => {
  it('⭐⭐ «ОТКРЫТ» В «ТОЛЬКО КЛИПЫ»: таз раскрыт к ходу на угол клипа, грудь на прицеле — несмотря на смешивание груди со стойкой', () => {
    const a = run(libs.open, 0, 120), b1 = run(libs.open, 1, 120), b1L = run(libs.open, 1, -120);
    expect(Math.abs(a.pelvis), '«ровно»: таз на прицеле').toBeLessThan(2);
    expect(b1.pelvis, '«открыт»: таз раскрыт к +X').toBeGreaterThan(31);
    expect(b1.pelvis).toBeLessThan(39);
    expect(b1L.pelvis, 'и зеркально к −X').toBeLessThan(-31);
    // ⚠ Мутация «не снимать отворот перед стойкой» даёт здесь ~15°: грудь уезжает к ходу вместе с тазом.
    expect(Math.abs(b1.chest), 'грудь (и оружие) на прицеле').toBeLessThan(6);
    expect(Math.abs(b1L.chest)).toBeLessThan(6);
  });

  it('⚠ НЕТ «ОТКРЫТОГО» КЛИПА ХОДЬБЫ — ходьба играет кардинальный его же часами, таз ровно', () => {
    // Мутация «часы/угол берут клип бега, раз ходьбы нет» разводит ноги с «ровно» на десятки градусов за секунду.
    const a = run(libs.runOnly, 0, 40, { walk: 0 }), b1 = run(libs.runOnly, 1, 40, { walk: 0 });
    let worst = 0;
    a.legs.forEach((row, i) => row.forEach((q, k) => { worst = Math.max(worst, q.angleTo(b1.legs[i]![k]!) / D); }));
    expect(worst, 'на ходьбе без «открытого» клипа «открыт» ≡ «ровно»').toBeLessThan(1);
    expect(Math.abs(b1.pelvis)).toBeLessThan(2);
  });

  it('⚠ ЧАСЫ НА СМЕСИ ХОДЬБА↔БЕГ, КОГДА «ОТКРЫТ» ТОЛЬКО БЕГ: ходьба в «открытой» колонке — кардинальным клипом той же скорости', () => {
    // 60 u/с = вес бега 0.5. Мутация «нет клипа `_open` этой скорости — колонка без него» берёт цикл одного бега: часы
    // уходят на ~30 % (стопа едет). Ожидание: цикл = lerp(ходьба × период, бег `_open` × период, 0.5) — как у позы.
    GAIT.warpOn = 1; GAIT.warpMax = 45; GAIT.hipsMode = 1; GAIT.hipsOpen = 35; GAIT.hipsOpenWalk = 0;
    const lib = libs.runOnly;
    const content: PoseContent = { ...localStorageContent('warrior'), locoClip: (names: readonly string[]) => { for (const n of names) { const c = lib.get(n); if (c) return c; } return null; } };
    const h = buildHumanoid({});
    const p = new PosePlayer(h, () => [], content, 'none', GX, emptyGrid());
    setLocoMixOverride(1);
    p.setVel(60, 0); p.setYaw(0); p.snapYaw();
    for (let i = 0; i < 120; i++) p.step(1 / 60);
    const phase = (): number => (p as unknown as { clipPhase: number }).clipPhase;
    const ph0 = phase();
    for (let i = 0; i < 60; i++) p.step(1 / 60);
    const w = lib.get('walk_strafe_R')!, r = lib.get('run_strafe_R_open')!;
    const cyc = (c: Clip): number => c.bakeSpeed! * c.keys[c.keys.length - 1]!.t;
    const want = 2 * Math.PI * 60 / (cyc(w) + (cyc(r) - cyc(w)) * 0.5);
    expect(p.hipsOpenDeg, 'раскрытие действительно в деле (половина угла бега)').toBeGreaterThan(10);
    expect(Math.abs((phase() - ph0) / want - 1), 'темп часов против смеси клипов').toBeLessThan(0.03);
  });

  it('⭐ ПЕРЕКЛЮЧЕНИЕ «РОВНО ↔ ОТКРЫТ» НА ХОДУ: без перезапекания, таз едет сглаживанием в обе стороны, а не щелчком', () => {
    const rate = (tr: number[]): number => { let m = 0; for (let i = 101; i < tr.length; i++) m = Math.max(m, Math.abs(tr[i]! - tr[i - 1]!)); return m; };
    const on = run(libs.open, 1, 120, { switchAt: 0, from: 0 });
    expect(Math.max(...on.pelvisTrace.slice(100, 120).map(Math.abs)), 'до переключения — ровно').toBeLessThan(2);
    expect(on.pelvisTrace.slice(150).reduce((s, v) => s + v, 0) / on.pelvisTrace.slice(150).length, 'после — раскрыт').toBeGreaterThan(31);
    // ⚠ Мутация «доля раскрытия без сглаживания» даёт скачок на весь угол (35°) за кадр.
    expect(rate(on.pelvisTrace), '«ровно → открыт»: таз за кадр, °').toBeLessThan(10);
    const off = run(libs.open, 0, 120, { switchAt: 0, from: 1 });
    expect(off.pelvisTrace.slice(100, 120).reduce((s, v) => s + v, 0) / 20, 'до — раскрыт').toBeGreaterThan(31);
    expect(Math.max(...off.pelvisTrace.slice(170).map(Math.abs)), 'после — ровно').toBeLessThan(2);
    // ⚠ Мутация «клип `_open` ищется только при режиме 1» (угол пропадает раньше доли) — щелчок 35° за кадр, нога 47°.
    expect(rate(off.pelvisTrace), '«открыт → ровно»: таз за кадр, °').toBeLessThan(10);
  });

  it('пока страйфы не перезапечены (старая складка) — «открыт» не включается', () => {
    const r = run(libs.stale, 1, 120);
    expect(r.pelvis, 'старая складка: чистый бок — потолок доворота, раскрытия сверху нет').toBeGreaterThan(40);
    expect(r.pelvis).toBeLessThan(47);
  });

  it('⭐ ПЛАНИРОВЩИК (без «только клипы»): раскрытие живьём с ползунка — таз на угол, грудь на прицеле; «ровно» — таз 0', () => {
    const a = run(new Map(), 0, 120, { mix: 0 }), b = run(new Map(), 1, 120, { mix: 0, open: 30 });
    expect(Math.abs(a.pelvis)).toBeLessThan(2);
    expect(b.pelvis, 'живой угол бега 30°').toBeGreaterThan(27);
    expect(b.pelvis).toBeLessThan(33);
    expect(Math.abs(b.chest), 'грудь на прицеле').toBeLessThan(6);
  });

  it('⚠ ОСТАНОВКА С БОКОВОГО БЕГА: таз закрывается сглаживанием, ноги не прыгают (уходящая колонка — своим весом бега)', () => {
    // ⚠ Мутация «уходящая колонка кроссфейда играет с НЫНЕШНИМ весом бега»: скорость падает в ноль за кадр, вес бега —
    // тоже, и гаснущий бег доигрывает ХОДЬБОЙ. ЗАМЕР (рыцарь, опубликованный warrior, 120 u/с вбок → стоп, правка /
    // мутация): таз 7.6 / 26.9 °/кадр, скачок ноги 18.0 / 45.8° («ровно» 17.3 / 71.1). Манекен — ниже.
    const st = run(libs.open, 1, 120, { stopAt: 20 });
    const rateAfter = (tr: number[], from: number): number => { let m = 0; for (let i = from + 1; i < tr.length; i++) m = Math.max(m, Math.abs(tr[i]! - tr[i - 1]!)); return m; };
    expect(rateAfter(st.pelvisTrace, 141), 'таз за кадр после остановки, °').toBeLessThan(10);
    expect(st.pelvisTrace[st.pelvisTrace.length - 1]!, 'встал — таз закрылся').toBeLessThan(6);
    const moving = run(libs.open, 1, 120).jump;
    expect(st.jump, `скачок ноги на остановке ${st.jump.toFixed(1)}° против ${moving.toFixed(1)}° на ходу`).toBeLessThan(moving + 5);
  });

  it('⭐⭐ МИРОВОЙ КУРС НИ НА ЧТО НЕ ВЛИЯЕТ: прицел 0 / 137 / −100° — таз на тот же угол, грудь на прицеле', () => {
    // ⚠ Игра собирает таз в КАДРЕ ПЕРСОНАЖА (`pelvisFrame.pelvisToWorld`: `Ry(курс)` слева), а рыск клипа `_open`
    // сохраняется. Мутация «сложить раскрытие с курсом ещё раз» (было верно до 17.09, когда курс затирал рыск клипа)
    // даёт ровно вдвое: ЗАМЕР — таз 70.0° вместо 35.0°.
    const base = run(libs.open, 1, 120);
    for (const aim of [137, -100]) {
      const m = run(libs.open, 1, 120, { aim });
      expect(Math.abs(m.pelvis - base.pelvis), `прицел ${aim}°: таз ${m.pelvis.toFixed(2)}° против ${base.pelvis.toFixed(2)}°`).toBeLessThan(0.5);
      expect(Math.abs(m.chest), `прицел ${aim}°: грудь от прицела`).toBeLessThan(6);
    }
  });

  it('⚠ НАКЛОН ТАЗА В КЛИПЕ `_open` НЕ ЛОМАЕТ РАСКРЫТИЕ: угол берётся из клипа, а поза — целиком', () => {
    // Рантайм читает раскрытие клипа из слота Y эйлера (`locoPose.Hips[1]`) — у запечённой походки наклона таза нет.
    // Сторож на случай, если появится (импорт мокапа, ручная правка): кривая композиция вылезет здесь, а не в игре.
    const tilt = new Map(libs.open);
    for (const n of ['run_strafe_R_open', 'run_strafe_L_open']) {
      const c = tilt.get(n)!;
      tilt.set(n, { ...c, keys: c.keys.map((k) => ({ ...k, pose: { ...k.pose, Hips: [0.12, k.pose['Hips']?.[1] ?? 0, 0.05] as [number, number, number] } })) });
    }
    const m = run(tilt, 1, 120);
    expect(m.pelvis, 'таз всё ещё раскрыт к ходу').toBeGreaterThan(28);
    expect(m.pelvis).toBeLessThan(42);
    expect(Math.abs(m.chest), 'грудь на прицеле').toBeLessThan(8);
  });

  it('⭐ НАБОР `_open` ЧУЖОГО ОРУЖИЯ НЕ ПОДХВАТЫВАЕТСЯ: у меча свои страйфы без раскрытия — играет «ровно»', () => {
    // ⚠ `findLocoClip` падает «точное оружие → `none` → любое» НЕЗАВИСИМО для каждого поиска. Без сверки оружия
    // рантайм смешал бы СВОЙ страйф меча с БЕЗОРУЖНЫМ `_open` долей 1 — «открыт» показывал бы чужой стиль.
    GAIT.warpOn = 1; GAIT.warpMax = 45; GAIT.hipsMode = 1; GAIT.hipsOpen = 35; GAIT.hipsOpenWalk = 10;
    const clips: Clip[] = [];
    for (const [n, c] of libs.open) clips.push({ ...c, name: n, character: 'warrior', weapon: 'none' });
    // У меча — СВОИ кардинальные страйфы (копия безоружных) и НИ ОДНОГО `_open`.
    for (const n of ['walk_strafe_L', 'walk_strafe_R', 'run_strafe_L', 'run_strafe_R']) clips.push({ ...libs.sq.get(n)!, name: n, character: 'warrior', weapon: 'sword' });
    const content: PoseContent = {
      ...localStorageContent('warrior'),
      locoClip: (names: readonly string[], w: string) => { for (const n of names) { const c = findLocoClip(clips, n, 'warrior', w); if (c) return c; } return null; },
      resolveUpper: () => ({ swing: 0.45, pose: { Chest: [0, 0, 0], UpperChest: [0, 0, 0] } }),
    };
    const go = (weapon: string): number => {
      const h = buildHumanoid({});
      const p = new PosePlayer(h, () => [], content, weapon, GX, emptyGrid());
      setLocoMixOverride(1);
      p.setVel(120, 0); p.setYaw(0); p.snapYaw();
      let s = 0;
      for (let i = 0; i < 200; i++) { p.step(1 / 60); h.root.updateMatrixWorld(true); if (i >= 120) s += yawOf(h, 'Hips'); }
      return s / 80;
    };
    expect(go('none'), 'безоружный: свой набор `_open` в деле').toBeGreaterThan(31);
    expect(Math.abs(go('sword')), 'меч: своего `_open` нет — «ровно», а не чужой стиль').toBeLessThan(2);
  });

  it('⚠ СМЕШАННЫЙ РЕЖИМ (доля клипа 0.5): «открыт» не ломает ноги — стопы ведёт планировщик, раскрытие живое', () => {
    // Решение ревью: отдельного пути для смеси не заводим. `legsOpen` крутит ноги клипа, но `warpStanceFeet` ставит
    // стопы на цели планировщика. Проверяем, что это не разносит ноги и грудь остаётся на прицеле.
    const a = run(libs.open, 0, 120, { mix: 0.5 }), b = run(libs.open, 1, 120, { mix: 0.5 });
    expect(Math.abs(a.pelvis), '«ровно» в смеси: таз на прицеле').toBeLessThan(3);
    expect(b.pelvis, '«открыт» в смеси: таз раскрыт').toBeGreaterThan(15);
    expect(Math.abs(b.chest), 'грудь на прицеле').toBeLessThan(8);
    expect(b.jump, `скачок ноги в смеси ${b.jump.toFixed(1)}°`).toBeLessThan(a.jump + 12);
  });
});

describe('таз на ходе боком: разбор ревью', () => {
  const SRC = readFileSync(path.join(__dirname, 'pose-editor.ts'), 'utf8');
  /** Тело функции по имени. Без скобки в шаблоне: `specsForBake<T…>` — дженерик. */
  const fn = (name: string): string => { const i = SRC.indexOf(`function ${name}`); expect(i, name).toBeGreaterThan(0); return SRC.slice(i, SRC.indexOf('\n}\n', i)); };
  const btn = (): string => { const i = SRC.indexOf('⚙ запечь набор походки (${picked.length}'); expect(i).toBeGreaterThan(0); return SRC.slice(i, SRC.indexOf('\n  }));\n', i)); };

  it('⭐⭐ НАБОР `_open` ПИШЕТСЯ ПОД ОРУЖИЕМ ХОЗЯИНА КАРДИНАЛЬНОГО СТРАЙФА, а не под выбранным в панели', () => {
    // ⚠ Признают `_open` только рядом со своим кардинальным (`openSetPair`, рантаймовый `findOpen`:
    // `oc.weapon === sq.weapon`), а `findLocoClip` падает «точное оружие → `none` → любое» НЕЗАВИСИМО для каждого
    // поиска. Съём под выбранным оружием у того, кто живёт на БЕЗОРУЖНОМ наборе хода (а это большинство), делал
    // сироту: подпись вечно «набора нет», кнопка ничего не меняет, игра молча играет «ровно».
    // ⚠ Мутация «weapon: выбранное» валит это.
    const b = fn('bakeOpenSet');
    expect(b, 'оружие берётся у разрешённого кардинального страйфа').toMatch(/const owner = sq\?\.weapon \?\? weapon;/);
    expect(b, 'и уезжает в опции съёма').toMatch(/weapon: owner/);
    expect(b, 'группируем по хозяину: ходьба и бег могут жить на разных оружиях').toMatch(/groups\.set\(owner, g\)/);
    // Метки первому `_open` ищутся по паре САМОГО клипа, иначе искали бы в чужом наборе.
    expect(fn('putBaked')).toMatch(/r\.clip\.character, r\.clip\.weapon/);
    // И удаление клипов нулевого угла — тоже под хозяином.
    expect(fn('openDropList')).toMatch(/openSetPair\(sp\)\.sq\?\.weapon \?\? weapon/);
  });

  it('⚠ ОТСУТСТВИЕ КАРДИНАЛЬНОГО НЕ ПРЯЧЕТ САМ `_open` — иначе кнопка жмётся по кругу впустую', () => {
    // Было «нет кардинального → {sq: null, open: null}»: у персонажа без набора хода «открыт» снимал 4 клипа,
    // подпись продолжала писать «набора нет», и каждое переключение запускало новый съём 1–2 с.
    // ⚠ Мутация «if (!sq) return { sq: null, open: null }» валит это.
    const f = fn('openSetPair');
    expect(f, 'поиск `_open` НЕ зависит от наличия кардинального').toMatch(/const open = findLocoClip\(library, `\$\{speed\}_strafe_R_open`/);
    expect(f, 'а проверка «своего» оружия — только когда кардинальный есть').toMatch(/!sq \|\| \(open\.weapon === sq\.weapon/);
    expect(SRC, 'нет кардинального — отдельная жалоба').toMatch(/кардинального набора страйфов нет/);
  });

  it('⭐ ОБА СЪЁМА ВОССТАНАВЛИВАЮТ ПРЕВЬЮ В `finally` и кладут причину отказа в статус', () => {
    // Съём УМЕЕТ отказать: `assertWarp` (чужой таз на кадре) и `assertOpenBudget` (раскрытие больше бюджета скрутки).
    // ⚠ Мутация «locoOn = wasLoco на успешном пути» валит это: превью «Бега» встаёт намертво, статус показывает
    // прежнее «✓ …», причина — только в консоли.
    for (const [name, src] of [['bakeOpenSet', fn('bakeOpenSet')], ['кнопка набора', btn()]] as const) {
      expect(src, `${name}: восстановление превью в finally`).toMatch(/finally \{ locoOn = wasLoco; refreshAll\(\);/);
      expect(src, `${name}: причина отказа видна автору`).toMatch(/catch \(e\) \{ bakeStatus = '⚠ съём не удался: '/);
    }
  });

  it('⚠ ОТЛОЖЕННЫЙ ПЕРЕСЪЁМ ОТМЕНЯЕТСЯ НА СМЕНЕ ПЕРСОНАЖА/ОРУЖИЯ и помнит, кому он был заказан', () => {
    // Колбэк читает ЖИВЫЕ `curCharId`/`weapon`/`GAIT`: подвинул ползунок и за 400 мс переключился — молчаливый съём
    // 0.5–2 с уходил НОВОМУ персонажу (плюс запись в историю и `pe_clips`), у которого режим «ровно».
    // ⚠ Мутация «колбэк без сверки цели» валит это.
    expect(SRC).toMatch(/const forChar = curCharId, forW = weapon;/);
    expect(SRC).toMatch(/if \(curCharId !== forChar \|\| weapon !== forW\) return;/);
    expect(fn('applyChar'), 'смена персонажа снимает таймер').toMatch(/cancelOpenBake\(\);/);
    expect(SRC, 'смена оружия — тоже').toMatch(/function setWeapon\(w: string\): void \{ cancelOpenBake\(\);/);
  });

  it('⚠ `_open` ФИЛЬТРУЕТСЯ ТЕМИ ЖЕ ГАЛКАМИ, что и кардинальный набор', () => {
    // Снял галки со страйфов (правил только повороты) и нажал съём: кардинальные остались старыми, а `_open`
    // перезапеклись со свежим номером — расхождение ровно того класса, ради которого номер и заведён.
    // ⚠ Мутация «openSpecs без фильтра» валит это.
    expect(btn()).toMatch(/\.filter\(\(s\) => bakeList\(\)\.includes\(s\.name\.replace\(\/_open\$\/, ''\)\)\)/);
  });

  it('⚠ АКТИВНАЯ ЯЧЕЙКА ПЛАНТ-СЕТКИ ИДЁТ ПО МИРОВОМУ РЫСКУ ТАЗА, а не по приложенному курсу', () => {
    // ⚠ Мутация «editorRootYaw = player.pelvisYaw» валит это: в «только клипы» + «открыт» раскрытие сидит в рыске
    // самого клипа, и ячейка подсвечивалась на целое раскрытие мимо.
    expect(SRC).toMatch(/editorRootYaw = player\.pelvisYawWorld;/);
  });

  it('⭐ `pelvisYawWorld` = НАСТОЯЩИЙ мировой рыск таза, `pelvisYaw` = приложенный курс (его вычитает запекатель)', () => {
    const r = run(libs.open, 1, 120);
    const p = r.player;
    expect((p.pelvisYawWorld - p.pelvisYaw) / D, 'разница — ровно раскрытие клипа').toBeCloseTo(35, 0);
    expect(Math.abs(p.pelvisYaw) / D, 'приложенный курс раскрытия НЕ несёт').toBeLessThan(2);
    expect(r.pelvisTrace[r.pelvisTrace.length - 1]! - p.pelvisYawWorld / D, 'мировой — то, что видно на скелете').toBeCloseTo(0, 0);
  });

  it('⭐ РАСКРЫТИЕ БОЛЬШЕ БЮДЖЕТА СКРУТКИ — ОТКАЗ В СЪЁМЕ, а не тихо не канонический клип', () => {
    // При `maxTwist` меньше раскрытия отворот упирается в предел, и в клип уходит меньше, чем записано в `hipsOpenW`:
    // чужой движок видит грудь мимо прицела на (раскрытие − maxTwist) × c3, наш рантайм — вдвое больше.
    // ⚠ Мутация «снимать как есть» валит это.
    const h = buildHumanoid({});
    const p = new PosePlayer(h, () => [], localStorageContent('warrior'), 'none', GX, emptyGrid());
    p.twistStates = { stand: { ...p.twistStates.stand }, walk: { ...p.twistStates.walk, maxTwist: 20 * D }, run: { ...p.twistStates.run, maxTwist: 20 * D } };
    expect(() => bakeGaitSet(p, h, { character: 'warrior', weapon: 'none' }, openStrafePresets(35, 0)))
      .toThrow(/раскрытие 35° больше «макс\. скрутка верха» 20°/);
    // 25° влезает в бюджет — съём идёт, и клип канонический.
    const ok = bakeGaitSet(p, h, { character: 'warrior', weapon: 'none' }, openStrafePresets(20, 0));
    expect(ok.length).toBe(2);
    const c = ok.find((x) => x.clip.name === 'run_strafe_R_open')!.clip;
    expect(Math.abs(meanY(c, ['Spine', 'Chest', 'UpperChest']) + 20), 'отворот в клипе — весь угол').toBeLessThan(2);
  });

  it('⚠ РАЗБОР `_open` — ОДИН РАЗ НА КАДР: «открыт» не удваивает сканы библиотеки у каждой куклы', () => {
    // Каждый разбор — ДВА `locoClip`, а тот — линейный скан всей библиотеки; зовут его `openW`/`openR`, `cols`,
    // `pickPose` обеих колонок и весь проход кроссфейда. `GAIT.hipsMode` глобальный: платят монстры и чужие игроки.
    // ⚠ Мутация «разбор без мемо» даёт здесь примерно вдвое больше вызовов, чем в «ровно».
    const count = (hm: number): number => {
      let n = 0;
      const base = localStorageContent('warrior');
      const content: PoseContent = { ...base, locoClip: (names: readonly string[]) => { n++; for (const k of names) { const c = libs.open.get(k); if (c) return c; } return null; } };
      GAIT.warpOn = 1; GAIT.warpMax = 45; GAIT.hipsMode = hm; GAIT.hipsOpen = 35; GAIT.hipsOpenWalk = 10;
      const h = buildHumanoid({});
      const p = new PosePlayer(h, () => [], content, 'none', GX, emptyGrid());
      setLocoMixOverride(1);
      p.setVel(120, 0); p.setYaw(0); p.snapYaw();
      for (let i = 0; i < 60; i++) p.step(1 / 60);   // разогрев: доля раскрытия вышла на режим
      n = 0;
      for (let i = 0; i < 60; i++) p.step(1 / 60);
      return n / 60;
    };
    const flat = count(0), open = count(1);
    expect(open, `поисков по библиотеке за кадр: «ровно» ${flat.toFixed(1)} → «открыт» ${open.toFixed(1)}`).toBeLessThan(flat * 1.5);
  });
});

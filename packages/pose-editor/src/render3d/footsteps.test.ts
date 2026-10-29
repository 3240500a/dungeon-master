import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildHumanoid } from './humanoid.js';
import { localStorageContent, emptyGrid, setLocoMixOverride, type PoseContent } from './poseRuntime.js';
import { BakePlayer } from './bakePlayer.js';   // ⭐ кукла С планировщиком: редактор и запекатель
import { bakeGaitToClip, bakeGaitSet, bakeTurnSet, GAIT_PRESETS, TURN_PRESETS, BAKE_MAXSPD } from './clipBake.js';
import { clipDur, clipPoseAt, carryMarks, loopMarksInRange, marksInRange, type Clip, type Mark, type MarkEvent } from './clipModel.js';
import { soundForMark, earShot, EAR_NEAR, EAR_FAR, STEP_PACE_DEFAULT } from './animSfx.js';
import { GAIT } from './gaitKnobs.js';
import { bakedLocoSpeed } from './locoBlend.js';

/**
 * ⭐⭐ ЗВУК ШАГОВ: «кожаная подошва мягко по каменному полу; метки я расставлю в клипах, а в планировщике
 * пусть работает само — в обоих режимах».
 *
 * Сторожим не синтез (его слышно ушами), а РЕШЕНИЕ «когда и какой ногой шагнули»: оно ломается молча —
 * двойной шаг, потерянный шаг на шве цикла, пачка шагов при смене ведущего клипа.
 */
const GX = { armDown: 1.35, elbowBend: 0.25 };
const R = 0.85 * BAKE_MAXSPD, W = 0.42 * BAKE_MAXSPD;
const P = { Spine: [0, 0, 0] as [number, number, number] };

/** Клип-носитель меток: длительность 1, метки на долях цикла. `carryMarks` переносит их долей на любой клип. */
const marksAt = (marks: { u: number; mark: Mark }[]): Clip => ({
  name: 'm', character: 'warrior', weapon: 'none', loop: true,
  keys: [{ t: 0, pose: P }, ...marks.map((m) => ({ t: m.u, pose: P, marks: [m.mark] })), { t: 1, pose: P }].sort((a, b) => a.t - b.t),
});
const L: Mark = { type: 'footstep', foot: 'L' }, Rf: Mark = { type: 'footstep', foot: 'R' };

describe('шаги: модель меток', () => {
  const c: Clip = {
    name: 'run_fwd', character: 'w', weapon: 'none', loop: true,
    keys: [{ t: 0, pose: P, marks: [L] }, { t: 0.5, pose: P, marks: [Rf] }, { t: 0.9, pose: P, marks: [{ type: 'sfx', sfx: 'шорох' }] }, { t: 1, pose: P }],
  };

  it('⭐ ЦИКЛ ЧЕРЕЗ ШОВ: пройденный отрезок (0.85 → 0.05) даёт хвост цикла и его начало', () => {
    expect(loopMarksInRange(c, 0.2, 0.6, 0, 1).map((e) => e.mark.foot)).toEqual(['R']);
    expect(loopMarksInRange(c, 0.85, 0.05, 0, 1).map((e) => e.mark.type), '⚠ метка на первом кадре цикла потерялась на шве').toEqual(['sfx', 'footstep']);
    expect(loopMarksInRange(c, 0.5, 0.5, 0, 1), 'стоим — фаза не двигалась').toEqual([]);
  });

  it('⭐⭐ ЗА ЦИКЛ КАЖДАЯ МЕТКА ЗВУЧИТ РОВНО РАЗ — на любом шаге кадра, через шов', () => {
    // ⚠ Мутация «начало цикла после шва — не включительно» валит это: левая на t=0 молчала бы всегда.
    for (const dt of [1 / 60, 1 / 23, 0.37]) {
      const seen = new Map<string, number>();
      let t = 0.7;
      for (let k = 0; k < Math.round(5 / dt); k++) {
        const nt = (t + dt) % 1;
        for (const e of loopMarksInRange(c, t, nt, 0, 1)) seen.set(e.mark.foot ?? e.mark.type, (seen.get(e.mark.foot ?? e.mark.type) ?? 0) + 1);
        t = nt;
      }
      const cycles = Math.floor(0.7 + Math.round(5 / dt) * dt) - 0;
      for (const [k, n] of seen) expect(Math.abs(n - cycles), `шаг кадра ${dt.toFixed(3)}: «${k}» прозвучала ${n} раз за ${cycles} циклов`).toBeLessThanOrEqual(1);
      expect(seen.size, `шаг кадра ${dt.toFixed(3)}: звучат все три метки`).toBe(3);
    }
  });

  it('⭐⭐ ПЕРЕЗАПЕКАНИЕ НЕ СТИРАЕТ МЕТКИ: переносятся долей цикла, а движение не меняется ни на градус', () => {
    // Старый клип 0.8 с, левая на 25 %; новый — 1 с и без ключа в этой точке.
    const oldC: Clip = { name: 'walk_fwd', character: 'w', weapon: 'none', loop: true, keys: [{ t: 0, pose: P }, { t: 0.2, pose: P, marks: [L] }, { t: 0.8, pose: P }] };
    const pose = (a: number): Record<string, [number, number, number]> => ({ LeftUpperLeg: [a, 0.1, -a], __hipsD: [0, a * 2, 0] });
    const newC: Clip = { name: 'walk_fwd', character: 'w', weapon: 'none', loop: true, keys: [{ t: 0, pose: pose(0) }, { t: 0.5, pose: pose(0.8) }, { t: 1, pose: pose(0) }] };
    const got = carryMarks(oldC, newC);
    const ev = marksInRange(got, -1e-9, 1);
    expect(ev.map((e) => [e.mark.foot, +e.t.toFixed(4)]), '⚠ метка не на 25 % нового цикла').toEqual([['L', 0.25]]);
    for (let u = 0; u <= 1; u += 0.01) {
      const a = clipPoseAt(newC, u), b = clipPoseAt(got, u);
      for (const k of Object.keys(a)) for (let j = 0; j < 3; j++) expect(Math.abs(a[k]![j]! - b[k]![j]!), `⚠ вставка ключа сдвинула «${k}» на u=${u.toFixed(2)}`).toBeLessThan(1e-6);
    }
    expect(marksInRange(carryMarks(oldC, got), -1e-9, 1).length, '⚠ повторный перенос задвоил метку').toBe(1);
    expect(newC.keys.some((k) => k.marks), '⚠ перенос испортил исходный клип').toBe(false);
    const bare: Clip = { ...oldC, keys: oldC.keys.map((k) => ({ t: k.t, pose: k.pose })) };
    expect(carryMarks(bare, newC), 'меток нет — клип тот же').toBe(newC);
  });

  it('редактор переносит метки при перезапекании набора (иначе ручная разметка живёт до первой правки походки)', () => {
    // ⚠ Запись в библиотеку идёт через `putBaked` — проверяем шов, а не текст на месте: раньше сканировалось
    // 600 символов после `histLib`, и вынос записи в функцию тихо снял бы сторожа.
    // ⚠ ВТОРОГО СЪЁМА БОЛЬШЕ НЕТ: набор «таз открыт» снят 19.09, поворот таза печётся в обычные клипы страйфа.
    const src = fs.readFileSync(path.join(__dirname, 'pose-editor.ts'), 'utf8');
    const h = "histLib('запечь походку'";
    const i = src.indexOf(h);
    expect(i, `в редакторе нет ${h}`).toBeGreaterThan(0);
    expect(src.slice(i, i + 400), `⚠ ${h}: запись клипов мимо putBaked`).toMatch(/putBaked\(/);
    expect(src, '⚠ отдельный съём «таз открыт» обязан быть убран целиком').not.toMatch(/histLib\('запечь «таз открыт»'/);
    const j = src.indexOf('function putBaked(');
    expect(j, 'нет функции putBaked').toBeGreaterThan(0);
    expect(src.slice(j, j + 900), '⚠ перезапекание пишет клип без переноса меток').toMatch(/carryMarks\(/);
  });
});

describe('шаги: звук', () => {
  const ev = (pace?: number, foot: 'L' | 'R' = 'L'): MarkEvent => ({ mark: { type: 'footstep', foot }, phase: 'point', t: 0, ...(pace !== undefined ? { pace } : {}) });

  it('⭐ ГРОМКОСТЬ ОТ ТЕМПА: подшаг на месте тише шага, шаг тише бега', () => {
    // ⚠ Мутация «одна громкость» валит это: поворот на месте топал бы как бег.
    const g = (p: number): number => soundForMark(ev(p))!.gain;
    expect(g(0)).toBeLessThan(g(0.45));
    expect(g(0.45)).toBeLessThan(g(1));
    expect(soundForMark(ev(0.9))!.pace, 'темп доезжает до синтеза: бег звучит суше, без переката').toBeCloseTo(0.9, 6);
    expect(soundForMark(ev())!.pace, 'темп не сообщили (метка в ударе) — обычный шаг').toBe(STEP_PACE_DEFAULT);
    expect(soundForMark(ev(0.5))!.surface).toBe('stone');
  });

  it('⚠ ЛЕВАЯ И ПРАВАЯ ЧУТЬ РАЗНЫЕ, но не на полтона («тик-так»)', () => {
    const l = soundForMark(ev(0.5, 'L'))!.tone!, r = soundForMark(ev(0.5, 'R'))!.tone!;
    expect(l).not.toBe(r);
    expect(Math.abs(l / r - 1)).toBeLessThan(0.1);
  });

  it('⭐ ЧУЖИЕ ШАГИ ГАСНУТ С РАССТОЯНИЕМ: вплотную слышно полностью, за окном — тишина', () => {
    expect(earShot(0, 0)).toBe(1);
    expect(earShot(EAR_NEAR, 0)).toBe(1);
    expect(earShot(EAR_FAR, 0)).toBe(0);
    expect(earShot(0, EAR_FAR * 2)).toBe(0);
    let prev = 1;
    for (let d = EAR_NEAR; d <= EAR_FAR; d += 20) { const v = earShot(d * 0.6, d * 0.8); expect(v).toBeLessThanOrEqual(prev + 1e-12); prev = v; }
  });
});

describe('шаги в рантайме', () => {
  let lib: Map<string, Clip>;
  beforeAll(() => {
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: () => null, setItem: () => { /* */ }, removeItem: () => { /* */ }, clear: () => { /* */ }, key: () => null, length: 0,
    } as Storage;
    const h = buildHumanoid({});
    const p = new BakePlayer(h, () => [], localStorageContent('warrior'), 'none', GX, emptyGrid());
    lib = new Map();
    for (const s of GAIT_PRESETS) lib.set(s.name, bakeGaitToClip(p, h, s, { character: 'warrior', weapon: 'none' }).clip);
    for (const r of bakeTurnSet(p, h, { character: 'warrior', weapon: 'none' })) lib.set(r.clip.name, r.clip);
  });
  afterAll(() => { delete (globalThis as unknown as { localStorage?: Storage }).localStorage; });
  afterEach(() => { setLocoMixOverride(null); });

  const content = (l: Map<string, Clip>): PoseContent => ({ ...localStorageContent('warrior'), locoClip: (names: readonly string[]) => { for (const n of names) { const c = l.get(n); if (c) return c; } return null; } });
  /** Библиотека, где у клипов ходьбы/бега (и поворотов, если `turns`) стоят метки. */
  const marked = (marks: { u: number; mark: Mark }[], turns = false): Map<string, Clip> => {
    const src = marksAt(marks), out = new Map<string, Clip>();
    for (const [n, c] of lib) out.set(n, /^(walk|run)_/.test(n) || (turns && n.startsWith('turn_')) ? carryMarks(src, c) : c);
    return out;
  };
  interface Ev { i: number; foot: string | undefined; type: string; pace: number | undefined; clip: string | undefined; t: number }
  /** Прогон: `drive(i)` задаёт ход на кадре; события копятся с номером кадра. */
  const run = (l: Map<string, Clip>, mix: number, frames: number, drive: (p: BakePlayer, i: number) => void, subscribeAt = 0): { ev: Ev[]; p: BakePlayer; landings: number } => {
    const h = buildHumanoid({});
    const p = new BakePlayer(h, () => [], content(l), 'none', GX, emptyGrid());
    setLocoMixOverride(mix);
    p.setVel(0, 0); p.setYaw(0); p.snapYaw();
    const ev: Ev[] = [];
    let landings = 0, prev = [...p.groundSupport], frame = 0;
    for (let i = 0; i < frames; i++) {
      frame = i;   // ⚠ обработчик читает ТЕКУЩИЙ кадр, а не тот, на котором подписались (`let i` цикла замкнулся бы)
      if (i === subscribeAt) p.onMark = (e) => ev.push({ i: frame, foot: e.mark.foot, type: e.mark.type, pace: e.pace, clip: e.clip?.name, t: e.t });
      drive(p, i);
      p.step(1 / 60);
      const s = p.groundSupport;
      if (i >= subscribeAt + 1) for (const leg of [0, 1]) if (s[leg] && !prev[leg]) landings++;
      prev = [...s];
    }
    return { ev, p, landings };
  };
  const steps = (ev: Ev[]): Ev[] => ev.filter((e) => e.type === 'footstep');
  const alternates = (ev: Ev[]): boolean => steps(ev).every((e, k, a) => k === 0 || e.foot !== a[k - 1]!.foot);

  it('⭐⭐ ПЛАНИРОВЩИК: ШАГ = ПОСТАНОВКА СТОПЫ, ноги чередуются, бег громче шага', () => {
    // ⚠ Мутация «не слушать опору в режиме планировщика» валит это: в режиме StepPlanner шагов не было бы вовсе.
    for (const [spd, name] of [[R, 'бег'], [W, 'шаг']] as const) {
      const r = run(lib, 0, 300, (p) => p.setVel(0, spd), 60);
      const s = steps(r.ev);
      expect(s.length, `${name}: шагов ${s.length} при ${r.landings} постановках стопы`).toBe(r.landings);
      expect(s.length, `${name}: шаги есть`).toBeGreaterThan(4);
      expect(alternates(r.ev), `${name}: ⚠ одна нога дважды подряд`).toBe(true);
      expect(s.every((e) => e.clip === undefined), 'шаг планировщика — не из клипа').toBe(true);
    }
    const pace = (spd: number): number => steps(run(lib, 0, 240, (p) => p.setVel(0, spd), 60).ev)[2]!.pace!;
    expect(pace(R), '⚠ темп не доезжает: бег звучал бы как шаг').toBeGreaterThan(pace(W));
    expect(pace(R)).toBeCloseTo(R / GAIT.speedRun, 2);
  });

  it('⚠ СТОИТ — ТИШИНА; поворот на месте планировщиком — тихие подшаги', () => {
    expect(steps(run(lib, 0, 180, (p) => p.setVel(0, 0), 60).ev), '⚠ шаги на месте без движения').toEqual([]);
    const turn = run(lib, 0, 240, (p, i) => { p.setVel(0, 0); if (i === 60) p.setYaw(Math.PI / 2); }, 30);
    const s = steps(turn.ev);
    expect(s.length, 'подшаги поворота звучат').toBeGreaterThan(0);
    expect(s.every((e) => e.pace === 0), 'на месте — самый тихий темп').toBe(true);
  });

  it('⭐⭐ «ТОЛЬКО КЛИПЫ» БЕЗ МЕТОК — шаги по касаниям клипа, в том же темпе, что у планировщика', () => {
    const clip = run(lib, 1, 420, (p) => p.setVel(0, R), 60), plan = run(lib, 0, 420, (p) => p.setVel(0, R), 60);
    const n = steps(clip.ev).length;
    expect(n, `шагов ${n}, касаний клипа ${clip.landings}`).toBe(clip.landings);
    expect(Math.abs(n - steps(plan.ev).length), `клипы ${n} против ${steps(plan.ev).length} у планировщика`).toBeLessThanOrEqual(1);
    expect(alternates(clip.ev)).toBe(true);
  });

  it('⭐⭐ «ТОЛЬКО КЛИПЫ» С МЕТКАМИ — звучат РОВНО метки автора, касания молчат', () => {
    // Метки нарочно ДАЛЕКО от касаний клипа: задвоение было бы слышно и видно по счёту.
    // ⚠ Мутация «озвучивать касания и у размеченного клипа» валит это: появляются шаги без клипа.
    const r = run(marked([{ u: 0.3, mark: L }, { u: 0.8, mark: Rf }]), 1, 480, (p) => p.setVel(0, R), 60);
    const s = steps(r.ev);
    expect(s.length).toBeGreaterThan(6);
    expect(s.every((e) => e.clip === 'run_fwd'), `⚠ звучит не метка клипа: ${JSON.stringify(s.find((e) => e.clip !== 'run_fwd'))}`).toBe(true);
    const dur = clipDur(lib.get('run_fwd')!);
    for (const e of s) expect(Math.abs(e.t - (e.foot === 'L' ? 0.3 : 0.8) * dur), '⚠ шаг не в точке метки').toBeLessThan(1e-3);
    expect(alternates(r.ev)).toBe(true);
    // Сколько циклов прошло, столько и пар шагов: клип идёт по пройденному пути. Цикл — СКОРОСТЬ ЗАПЕКАНИЯ × период, а не
    // текущая скорость × период: бег снят на 120, а здесь играет на 102 (вес бега 1 уже с 80 u/с) — медленнее.
    const cycles = (R * (480 - 61) / 60) / (bakedLocoSpeed(lib.get('run_fwd')!) * dur);
    expect(Math.abs(s.length - 2 * cycles), `шагов ${s.length} за ${cycles.toFixed(1)} циклов`).toBeLessThanOrEqual(2);
  });

  it('⚠ МЕТКА НА САМОМ НАЧАЛЕ ЦИКЛА звучит раз в цикл — не теряется на шве и не двоится', () => {
    const r = run(marked([{ u: 0, mark: L }]), 1, 480, (p) => p.setVel(0, R), 60);
    const dur = clipDur(lib.get('run_fwd')!), cycles = (R * (480 - 61) / 60) / (bakedLocoSpeed(lib.get('run_fwd')!) * dur);   // цикл — см. тест выше
    expect(Math.abs(steps(r.ev).length - cycles), `левых ${steps(r.ev).length} за ${cycles.toFixed(1)} циклов`).toBeLessThanOrEqual(1);
  });

  it('⭐ СМЕНА ВЕДУЩЕГО КЛИПА ПОСРЕДИ ЦИКЛА — без пропусков и без пачек', () => {
    // Ход под 45° к тазу с дрожью направления: ведущий клип скачет между «вперёд» и «вбок» почти каждый кадр.
    // ⚠ Мутация «на смене ведущего не переводить время через фазу» даёт пропуски — и счёт уходит.
    // ⚠ Тумблер доворота глобальный: возвращаем ТО, ЧТО БЫЛО (было `finally { warpOn = 1 }` — и все тесты ниже в
    // файле шли с доворотом, хотя умолчание 0).
    const was = GAIT.warpOn;
    GAIT.warpOn = 0;
    try {
      const l = marked([{ u: 0.3, mark: L }, { u: 0.8, mark: Rf }]);
      const r = run(l, 1, 600, (p, i) => { const a = (45 + Math.sin(i * 1.7) * 6) * Math.PI / 180; p.setVel(Math.sin(a) * R, Math.cos(a) * R); p.setYaw(0); }, 60);
      const s = steps(r.ev);
      const leads = new Set(s.map((e) => e.clip));
      expect(leads.size, `ведущий клип действительно менялся: ${[...leads].join(', ')}`).toBeGreaterThan(1);
      expect(alternates(r.ev), '⚠ одна нога дважды подряд — пачка на смене ведущего').toBe(true);
      const gaps = s.slice(1).map((e, k) => e.i - s[k]!.i);
      expect(Math.max(...gaps) / Math.min(...gaps), `⚠ разрыв между шагами ${Math.min(...gaps)}…${Math.max(...gaps)} кадров — шаг потерялся`).toBeLessThan(2.2);
    } finally { GAIT.warpOn = was; }
  });

  it('⭐ ДОВОРОТ ВКЛ: ПЕРЕБРОС СЕКТОРА НА 45° (таз «вперёд» ↔ «вбок») — шаги без пропусков и без пачек', () => {
    // С доворотом дрожь 45 ± 6° сектор НЕ перебрасывает (гистерезис), ведущий не меняется — поэтому гоняем ход
    // медленно через границу: 45 ± 20° с периодом 3 с. На каждом перебросе таз едет на ~70°, веса колонок — за ним.
    const was = { on: GAIT.warpOn, max: GAIT.warpMax };
    GAIT.warpOn = 1; GAIT.warpMax = 45;
    try {
      const l = marked([{ u: 0.3, mark: L }, { u: 0.8, mark: Rf }]);
      let flips = 0, sec = -1;
      const r = run(l, 1, 600, (p, i) => {
        const a = (45 + 20 * Math.sin(2 * Math.PI * i / 180)) * Math.PI / 180;
        p.setVel(Math.sin(a) * R, Math.cos(a) * R); p.setYaw(0);
        if (i > 60 && p.dirWarpSector !== sec) { if (sec >= 0) flips++; sec = p.dirWarpSector; }
      }, 60);
      expect(flips, 'сектор действительно перебрасывался').toBeGreaterThanOrEqual(4);
      const s = steps(r.ev);
      expect(new Set(s.map((e) => e.clip)).size, 'ведущий клип менялся').toBeGreaterThan(1);
      expect(alternates(r.ev), '⚠ одна нога дважды подряд — пачка на перебросе сектора').toBe(true);
      const gaps = s.slice(1).map((e, k) => e.i - s[k]!.i);
      expect(Math.max(...gaps) / Math.min(...gaps), `⚠ разрыв между шагами ${Math.min(...gaps)}…${Math.max(...gaps)} кадров`).toBeLessThan(2.2);
    } finally { GAIT.warpOn = was.on; GAIT.warpMax = was.max; }
  });

  it('⚠ МЁРТВЫЙ НАБОР «ТАЗ ОТКРЫТ» (`*_strafe_*_open`) НЕ ЧИТАЕТСЯ ВОВСЕ — ни позой, ни метками', () => {
    // Режим «таз открыт» снят 19.09, но уже запечённые клипы у автора в библиотеке лежат. Рантайм обязан их
    // ПРОСТО НЕ ВИДЕТЬ: имена он берёт из `locoClipNames`, а `findLocoClip` ищет точное совпадение.
    // ⚠ МУТАЦИЯ, которую это ловит: вернуть поиск `имя + '_open'` (или fuzzy-совпадение по префиксу) — и шаги
    // зазвучат с чужого клипа в чужие моменты, а поза уедет на его рыск таза.
    const was = { on: GAIT.warpOn, max: GAIT.warpMax };
    GAIT.warpOn = 1; GAIT.warpMax = 45;
    try {
      const l = marked([{ u: 0.3, mark: L }, { u: 0.8, mark: Rf }]);
      const withDead = new Map(l);
      for (const sp of ['walk', 'run']) for (const sd of ['L', 'R']) {
        const base = l.get(`${sp}_strafe_${sd}`)!;
        // У мёртвого клипа СВОИ метки в ДРУГИХ точках цикла и метка поворота таза — если его прочтут, это будет видно.
        withDead.set(`${sp}_strafe_${sd}_open`, { ...base, name: `${sp}_strafe_${sd}_open`, hipsYawDeg: 35, hipsYawW: [0.25, 0.35, 0.4],
          keys: base.keys.map((k, i) => ({ t: k.t, pose: k.pose, ...(i === 0 ? { marks: [L, Rf] } : {}) })) });
      }
      const ev = steps(run(withDead, 1, 480, (p) => { p.setVel(R, 0); p.setYaw(0); }, 60).ev);
      expect(ev.length, 'шаги вообще есть').toBeGreaterThan(4);
      expect(ev.every((e) => e.clip === 'run_strafe_R'), `⚠ прочитан мёртвый клип: ${JSON.stringify(ev.find((e) => e.clip !== 'run_strafe_R'))}`).toBe(true);
      const dur = clipDur(l.get('run_strafe_R')!);
      for (const e of ev) expect(Math.abs(e.t - (e.foot === 'L' ? 0.3 : 0.8) * dur), '⚠ шаг не в точке метки автора').toBeLessThan(1e-3);
      expect(alternates(ev)).toBe(true);
    } finally { GAIT.warpOn = was.on; GAIT.warpMax = was.max; }
  });

  it('⭐ ПОВОРОТ КЛИПОМ: без меток — касания его канала, с метками — метки', () => {
    const turn = (l: Map<string, Clip>): Ev[] => steps(run(l, 1, 240, (p, i) => { p.setVel(0, 0); if (i === 30) p.setYaw(Math.PI / 2); }, 10).ev);
    const bare = turn(lib);
    expect(bare.length, 'подшаги поворота слышно и без разметки').toBeGreaterThan(1);
    expect(bare.every((e) => e.clip === undefined)).toBe(true);
    const withMarks = turn(marked([{ u: 0.4, mark: L }], true));
    expect(withMarks.map((e) => e.clip), '⚠ звучит не метка поворота').toEqual(['turn_R_90']);
  });

  it('⚠ ДВЕ МЕТКИ ОДНОЙ НОГИ ВПРИТЫК — один шаг', () => {
    const r = run(marked([{ u: 0.3, mark: L }, { u: 0.32, mark: L }, { u: 0.8, mark: Rf }]), 1, 480, (p) => p.setVel(0, R), 60);
    expect(alternates(r.ev), '⚠ дубль шага одной ноги').toBe(true);
  });

  it('⚠ ПРОЧИЕ МЕТКИ КЛИПА БЕГА ТОЖЕ ЗВУЧАТ (шорох брони на шаге)', () => {
    const r = run(marked([{ u: 0.5, mark: { type: 'sfx', sfx: 'шорох брони' } }]), 1, 300, (p) => p.setVel(0, R), 60);
    expect(r.ev.filter((e) => e.type === 'sfx').length).toBeGreaterThan(2);
  });

  it('⚠ ЗАПЕКАНИЕ МОЛЧИТ: сотни кадров съёма за один вызов не звучат пачкой, подписчик после — на месте', () => {
    // ⚠ Мутация «не глушить метки на время съёма» валит это: в редакторе «запечь» выстреливало бы все шаги разом.
    const h = buildHumanoid({});
    const p = new BakePlayer(h, () => [], localStorageContent('warrior'), 'none', GX, emptyGrid());
    let n = 0;
    const sub = (): void => { n++; };
    p.onMark = sub;
    bakeGaitSet(p, h, { character: 'warrior', weapon: 'none' }, GAIT_PRESETS.filter((s) => s.name === 'run_fwd'));
    bakeTurnSet(p, h, { character: 'warrior', weapon: 'none' }, TURN_PRESETS.filter((s) => s.name === 'turn_R_90'));
    expect(n, `⚠ при запекании прозвучало ${n} событий`).toBe(0);
    expect(p.onMark, 'подписчик вернулся после запекания').toBe(sub);
  });

  it('⚠ ПОДПИСАЛИСЬ ПОСРЕДИ БЕГА — никакой пачки «накопленных» шагов', () => {
    for (const mix of [0, 1]) {
      const r = run(lib, mix, 200, (p) => p.setVel(0, R), 150);
      expect(r.ev.filter((e) => e.i === 150).length, `доля ${mix}`).toBeLessThanOrEqual(1);
    }
  });
});

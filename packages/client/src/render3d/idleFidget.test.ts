/** Планировщик редких вставок в покой: расписание, огибающая, прерывание. */
import { describe, it, expect } from 'vitest';
import { makeFidgetState, stepIdleBreak, pickFidget, mulberry32, type FidgetState } from './idleFidget.js';
import { IDLE_BREAK_DEF, readAnimCfg, type FidgetCfg } from './animConfig.js';
import { blendTwo, emptyGrid, type PoseContent, type UpperPose } from './poseRuntime.js';
import { makeStand } from './parityHarness.js';
import type { Pose } from './clipModel.js';

const F = (clip: string, weight = 1, blend = 0.25): FidgetCfg => ({ clip, weight, blend, scope: 'base' });
const POOL = [F('a'), F('b'), F('c')];
const DUR: Record<string, number> = { a: 7.4, b: 12.4, c: 15.8 };
const durOf = (c: string): number => DUR[c] ?? 0;
const DT = 1 / 60;

/** Прогнать N секунд покоя и собрать статистику. */
function run(st: FidgetState, sec: number, calm: () => boolean = () => true, cfg = IDLE_BREAK_DEF): {
  starts: number[]; playing: number; wMax: number; maxStep: number;
} {
  const starts: number[] = []; let playing = 0, wMax = 0, maxStep = 0, prevW = st.w, prev = st.clip;
  for (let i = 0; i < Math.round(sec / DT); i++) {
    stepIdleBreak(st, DT, calm(), cfg, POOL, durOf);
    if (st.clip && !prev) starts.push(i * DT);
    if (st.clip) playing += DT;
    wMax = Math.max(wMax, st.w);
    maxStep = Math.max(maxStep, Math.abs(st.w - prevW));
    prevW = st.w; prev = st.clip;
  }
  return { starts, playing, wMax, maxStep };
}

describe('редкие вставки в покой', () => {
  it('в покое вставки идут РЕДКО и не по будильнику', () => {
    const st = makeFidgetState(12345);
    const r = run(st, 600);                                  // 10 минут простоя
    expect(r.starts.length, `вставок за 10 мин: ${r.starts.length}`).toBeGreaterThanOrEqual(6);
    expect(r.starts.length).toBeLessThanOrEqual(18);
    const gaps = r.starts.slice(1).map((t, i) => t - r.starts[i]!);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
    expect(sd, '⚠ нулевой разброс = будильник, а просили «редко и неожиданно»').toBeGreaterThan(2);
    expect(r.playing / 600, 'доля времени во вставке').toBeLessThan(0.45);
  });

  it('⭐ ПЕРВАЯ вставка ждёт порог, а не стартует сразу', () => {
    const st = makeFidgetState(7);
    const r = run(st, IDLE_BREAK_DEF.after - 1);
    expect(r.starts.length, 'до порога покоя вставок быть не должно').toBe(0);
  });

  it('⭐⭐ СТАЯ НЕ СТАРТУЕТ ХОРОМ: фаза куклы разводит первые вставки', () => {
    const first: number[] = [];
    for (let i = 0; i < 12; i++) {
      const st = makeFidgetState(1000 + i, (i * 1.7) % 20);   // та же фаза, что у дыхания
      first.push(run(st, 200).starts[0] ?? -1);
    }
    const ok = first.filter((t) => t >= 0);
    expect(ok.length, 'все куклы обязаны хоть раз сыграть').toBe(12);
    const window = ok.filter((t) => Math.abs(t - ok[0]!) < 0.5).length;
    expect(window, `в окно 0.5 с попало ${window} из 12`).toBeLessThanOrEqual(4);
  });

  it('⭐ ОГИБАЮЩАЯ НЕПРЕРЫВНА — щелчка на входе и выходе нет', () => {
    const st = makeFidgetState(99);
    const r = run(st, 300);
    expect(r.wMax, 'вставка обязана выйти на полный вес').toBeGreaterThan(0.95);
    // шаг веса за кадр не больше, чем dt/blend — иначе это скачок, а не кроссфейд
    expect(r.maxStep, `макс шаг веса за кадр ${r.maxStep.toFixed(4)}`).toBeLessThanOrEqual(DT / 0.25 + 1e-6);
  });

  it('⚠ ПОТЕРЯЛИ ПОКОЙ — вставка ГАСНЕТ, а не рвётся кадром', () => {
    const st = makeFidgetState(5);
    let calm = true;
    run(st, 300, () => calm);
    // доводим до момента, когда что-то играет
    for (let i = 0; i < 6000 && !(st.clip && st.w > 0.9); i++) stepIdleBreak(st, DT, true, IDLE_BREAK_DEF, POOL, durOf);
    expect(st.clip, 'для проверки нужна играющая вставка').toBeTruthy();
    calm = false;
    const steps: number[] = []; let prev = st.w;
    for (let i = 0; i < 120 && st.clip; i++) { stepIdleBreak(st, DT, false, IDLE_BREAK_DEF, POOL, durOf); steps.push(Math.abs(st.w - prev)); prev = st.w; }
    expect(st.clip, 'через 2 с после потери покоя вставка обязана кончиться').toBeNull();
    expect(Math.max(...steps), 'гашение обязано быть плавным').toBeLessThanOrEqual(DT / 0.25 + 1e-6);
  });

  it('пустой пул и клип без длительности — точный no-op, без исключений', () => {
    const st = makeFidgetState(1);
    for (let i = 0; i < 3000; i++) stepIdleBreak(st, DT, true, IDLE_BREAK_DEF, [], durOf);
    expect(st.clip).toBeNull(); expect(st.w).toBe(0);
    const st2 = makeFidgetState(1);
    for (let i = 0; i < 3000; i++) stepIdleBreak(st2, DT, true, IDLE_BREAK_DEF, [F('нет-такого')], () => 0);
    expect(st2.clip).toBeNull();
  });

  it('выбор по весам уважает вес', () => {
    expect(pickFidget([F('a', 1), F('b', 3)], 0.1)?.clip).toBe('a');
    expect(pickFidget([F('a', 1), F('b', 3)], 0.9)?.clip).toBe('b');
    expect(pickFidget([], 0.5)).toBeNull();
    expect(pickFidget([F('a', 0)], 0.5), 'нулевой вес не выбирается').toBeNull();
  });

  it('ГПСЧ детерминирован: тот же сид — то же расписание', () => {
    const a = run(makeFidgetState(42), 300).starts;
    const b = run(makeFidgetState(42), 300).starts;
    expect(a).toEqual(b);
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
});

describe('разбор конфига вставок', () => {
  const cfg = (raw: unknown): ReturnType<typeof readAnimCfg> => readAnimCfg(raw, 'warrior');

  it('пустой конфиг — пул пуст, умолчания расписания на месте', () => {
    expect(cfg({}).fidgets('idle', ['none'])).toEqual([]);
    expect(cfg({}).idleBreak()).toEqual(IDLE_BREAK_DEF);
  });

  it('⚠ МУСОР в данных не роняет анимацию', () => {
    expect(cfg({ warrior: { base: { fidgets: 5 } } }).fidgets('idle', ['none'])).toEqual([]);
    expect(cfg({ warrior: { base: { fidgets: [1, null, '', { }] } } }).fidgets('idle', ['none'])).toEqual([]);
    expect(cfg({ warrior: { base: { idleBreak: { gapMin: 'ой' } } } }).idleBreak().gapMin).toBe(IDLE_BREAK_DEF.gapMin);
  });

  it('⭐⭐ МЕСТО В ДАННЫХ = УСЛОВИЕ НА ОРУЖИЕ: прокрут меча не играет без меча', () => {
    const raw = { warrior: { base: { fidgets: ['step'] }, items: { sword: { fidgets: ['twirl'] } } } };
    const names = (items: string[]): string[] => cfg(raw).fidgets('idle', items).map((f) => f.clip);
    expect(names(['none', 'none'])).toEqual(['step']);
    expect(names(['axe', 'none']), 'у топора своих нет — только базовые').toEqual(['step']);
    expect(names(['sword', 'shield'])).toEqual(['step', 'twirl']);
  });

  it('боевая ось без своей пачки падает на спокойную', () => {
    const raw = { warrior: { base: { fidgets: ['step'] } } };
    expect(cfg(raw).fidgets('combat_idle', ['none']).map((f) => f.clip)).toEqual(['step']);
    const raw2 = { warrior: { base: { fidgets: ['step'], combatFidgets: ['guard'] } } };
    expect(cfg(raw2).fidgets('combat_idle', ['none']).map((f) => f.clip)).toEqual(['guard']);
  });

  it('короткая форма и объект дают одно и то же, вес и кроссфейд читаются', () => {
    const raw = { warrior: { base: { fidgets: ['a', { clip: 'b', weight: 2, blend: 0.4 }] } } };
    const l = cfg(raw).fidgets('idle', ['none']);
    expect(l[0]).toEqual({ clip: 'a', weight: 1, blend: IDLE_BREAK_DEF.blend, scope: 'base' });
    expect(l[1]).toEqual({ clip: 'b', weight: 2, blend: 0.4, scope: 'base' });
  });

  it('перепутанные gapMin/gapMax не ломают расписание', () => {
    expect(cfg({ warrior: { base: { idleBreak: { gapMin: 50, gapMax: 10 } } } }).idleBreak().gapMax).toBe(50);
  });
});

/** СКВОЗНОЙ сторож: настоящий `PosePlayer` реально играет вставку и она доезжает до позы. */
describe('вставка в живом плеере', () => {
  const FG: Pose = { Chest: [1.0, 0, 0], Neck: [0.9, 0, 0] };
  const STANCE: Pose = { Chest: [0, 0, 0], Neck: [0, 0, 0], Hips: [0, 0, 0] };
  const content = (): PoseContent => ({
    charId: 'warrior',
    resolveUpper: (_w: string, _c?: number, _t?: number, fidget?: { pose: Pose; scope: 'base' | 'item'; w: number } | null): UpperPose => ({
      swing: 0,
      // резолвер здесь не нужен — проверяем ДОЕЗД вставки до контента и её вес
      pose: fidget && fidget.w > 0 ? blendTwo(STANCE, fidget.pose, fidget.w) : STANCE,
    }),
    fidgets: () => [{ clip: 'fg', weight: 1, blend: 0.25, scope: 'base' as const }],
    idleBreak: () => ({ after: 1, gapMin: 2, gapMax: 3, blend: 0.25 }),
    fidgetDur: () => 2,
    fidgetPose: () => FG,
  } as unknown as PoseContent);

  it('⭐⭐ ВЫКЛЮЧЕНЫ ПО УМОЛЧАНИЮ — запекание и старые тесты бит в бит', () => {
    const st = makeStand({ content: content(), grid: emptyGrid(), mix: 1 });
    st.run({ vz: 0, frames: 60 * 12 });
    expect(st.player.fidgetNow, '⚠ без setIdleBreaks вставок быть не должно').toBeNull();
    st.dispose();
  });

  it('⭐ ВКЛЮЧЁННЫЕ — играют, и поза уезжает во вставку', () => {
    const st = makeStand({ content: content(), grid: emptyGrid(), mix: 1 });
    st.player.setIdleBreaks(true);
    let sawPlaying = false, maxChest = 0;
    for (let i = 0; i < 60 * 12; i++) {
      const f = st.run({ vz: 0, frames: 1 });
      if (st.player.fidgetNow) sawPlaying = true;
      maxChest = Math.max(maxChest, Math.abs(f[f.length - 1]!.local.get('Chest')?.x ?? 0));
    }
    st.dispose();
    expect(sawPlaying, 'за 12 с покоя вставка обязана сыграть').toBe(true);
    expect(maxChest, 'поза обязана уехать во вставку').toBeGreaterThan(0.05);
  });

  it('⚠ ПОШЁЛ — вставка гаснет', () => {
    const st = makeStand({ content: content(), grid: emptyGrid(), mix: 1 });
    st.player.setIdleBreaks(true);
    for (let i = 0; i < 60 * 12 && !st.player.fidgetNow; i++) st.run({ vz: 0, frames: 1 });
    expect(st.player.fidgetNow, 'для проверки нужна играющая вставка').toBeTruthy();
    for (let i = 0; i < 60 * 2; i++) st.run({ vz: 120, frames: 1 });
    expect(st.player.fidgetNow, 'на ходу вставка обязана кончиться').toBeNull();
    st.dispose();
  });
});

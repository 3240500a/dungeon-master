import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildHumanoid } from './humanoid.js';
import { localStorageContent, emptyGrid } from './poseRuntime.js';
import { BakePlayer } from './bakePlayer.js';
import { bakeGaitSet, GAIT_PRESETS } from './clipBake.js';
import { migrateClip, type Clip, type Pose } from './clipModel.js';
import { bakedLocoSpeed, clipTempoSpeed } from './locoBlend.js';
import { measureStride, syncClipTempo, STRIDE_REV } from './strideTempo.js';

/**
 * ⭐⭐ ТЕМП ПО ШАГУ: нетронутый клип — темп бит-в-бит; правленый шаг — темп в ту же пропорцию.
 * Жалоба (06.10): укоротил шаг бега вперёд — стопа поехала вперёд, «надо чуть быстрее». Часы шли по скорости съёма.
 */

let walk: Clip, run: Clip;
beforeAll(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: () => null, setItem: () => { /* */ }, removeItem: () => { /* */ }, clear: () => { /* */ }, key: () => null, length: 0,
  } as Storage;
  const h = buildHumanoid({});
  const p = new BakePlayer(h, () => [], localStorageContent('warrior'), 'none', { armDown: 1.35, elbowBend: 0.25 }, emptyGrid());
  const specs = GAIT_PRESETS.filter((s) => s.name === 'walk_fwd' || s.name === 'run_fwd');
  const out = bakeGaitSet(p, h, { character: 'warrior', weapon: 'none', fps: 60, warmSec: 1.2 }, specs);
  walk = out.find((r) => r.clip.name === 'walk_fwd')!.clip;
  run = out.find((r) => r.clip.name === 'run_fwd')!.clip;
});
afterAll(() => { delete (globalThis as unknown as { localStorage?: Storage }).localStorage; });

/** Копия клипа с размахом ног ×k (бедро и голень вокруг X) — «укоротил шаг». */
function scaleLegs(c: Clip, k: number, character = c.character): Clip {
  const legs = ['LeftUpperLeg', 'RightUpperLeg', 'LeftLowerLeg', 'RightLowerLeg'];
  const keys = c.keys.map((kf) => {
    const pose: Pose = JSON.parse(JSON.stringify(kf.pose)) as Pose;
    for (const b of legs) if (pose[b]) pose[b] = [pose[b]![0] * k, pose[b]![1], pose[b]![2]];
    return { ...kf, pose };
  });
  return { ...c, character, keys };
}

describe('замер шага', () => {
  it('⭐ клип планировщика (стопы прибиты ИК) меряется своей скоростью съёма: ходьба 40, бег 120 — в пределах 12 %', () => {
    // Абсолютный оракул есть только тут: клип снят НА ЭТОЙ ЖЕ кукле, стопы стояли. У мокапа так нельзя (ноги куклы
    // не как у источника), поэтому темп берётся ОТНОШЕНИЕМ, а не этим числом.
    const mw = measureStride(walk)!, mr = measureStride(run)!;
    expect(mw / bakedLocoSpeed(walk)).toBeGreaterThan(0.88);
    expect(mw / bakedLocoSpeed(walk)).toBeLessThan(1.12);
    expect(mr / bakedLocoSpeed(run)).toBeGreaterThan(0.88);
    expect(mr / bakedLocoSpeed(run)).toBeLessThan(1.12);
  });
  it('шаг короче — замер меньше; замер детерминирован', () => {
    const m = measureStride(run)!;
    expect(measureStride(scaleLegs(run, 0.7))!).toBeLessThan(m * 0.9);
    expect(measureStride(migrateClip(JSON.parse(JSON.stringify(run))))).toBe(m);
  });
});

describe('syncClipTempo', () => {
  it('⭐⭐ НЕТРОНУТЫЙ клип со скоростью съёма: только точка отсчёта, часы читают bakeSpeed бит-в-бит', () => {
    const c = migrateClip(JSON.parse(JSON.stringify(run)));
    syncClipTempo([c]);
    expect(c.tempoRef).toEqual({ speed: c.bakeSpeed, stride: expect.any(Number), rev: STRIDE_REV });
    expect(c.tempoSpeed).toBeUndefined();
    expect(clipTempoSpeed(c)).toBe(c.bakeSpeed);
    expect(syncClipTempo([c]), 'повтор ничего не меняет').toEqual([]);
  });
  it('⭐⭐ шаг укоротили после съёма — темп реже-чаще в ту же пропорцию', () => {
    const c = migrateClip(JSON.parse(JSON.stringify(run)));
    syncClipTempo([c]);
    const ref = c.tempoRef!;
    const edited = scaleLegs(c, 0.7);
    syncClipTempo([edited]);
    const want = ref.speed * measureStride(edited)! / ref.stride;
    expect(edited.tempoSpeed!).toBeCloseTo(want, 2);
    expect(edited.tempoSpeed!).toBeLessThan(ref.speed * 0.9);
    expect(clipTempoSpeed(edited)).toBe(edited.tempoSpeed);
    expect(bakedLocoSpeed(edited), 'доля опоры по-прежнему от скорости съёма').toBe(c.bakeSpeed);
    // вернули как было — темп снова съёмный, поле ушло
    const back = { ...edited, keys: c.keys };
    syncClipTempo([back]);
    expect(back.tempoSpeed).toBeUndefined();
  });
  it('⭐ клип БЕЗ скорости съёма берёт точку отсчёта у одноимённого клипа другого набора (так у воина бег вперёд)', () => {
    const donor = migrateClip(JSON.parse(JSON.stringify(run)));
    donor.character = 'mocap';
    const own = scaleLegs(donor, 0.7, 'warrior');
    delete own.bakeSpeed; delete own.tempoRef;
    syncClipTempo([donor, own]);
    const got: Clip = own;   // свежая ссылка: после delete TS сузил бы поле до undefined
    expect(got.tempoRef?.from).toBe('mocap');
    expect(got.tempoRef?.speed).toBe(donor.bakeSpeed);
    expect(own.tempoSpeed!).toBeCloseTo(donor.bakeSpeed! * measureStride(own)! / measureStride(donor)!, 1);
    // точная копия донора без скорости — темп донора, а не легаси 102
    const copy = { ...donor, character: 'warrior', keys: donor.keys };
    delete copy.bakeSpeed; delete copy.tempoRef; delete copy.tempoSpeed;
    syncClipTempo([donor, copy]);
    expect(clipTempoSpeed(copy)).toBe(donor.bakeSpeed);
  });
  it('пересъём (другая скорость съёма) сбрасывает отсчёт; ревизия замера не сдвигает темп', () => {
    const c = migrateClip(JSON.parse(JSON.stringify(run)));
    syncClipTempo([c]);
    const e = scaleLegs(c, 0.7); syncClipTempo([e]);
    const t = e.tempoSpeed!;
    // старая ревизия замера: отсчёт пересобран, темп тот же
    e.tempoRef = { ...e.tempoRef!, rev: STRIDE_REV - 1, stride: e.tempoRef!.stride * 1.3 };
    e.tempoSpeed = t;
    syncClipTempo([e]);
    expect(e.tempoRef!.rev).toBe(STRIDE_REV);
    expect(e.tempoSpeed!).toBeCloseTo(t, 2);
    // пересъём
    e.bakeSpeed = 110; syncClipTempo([e]);
    expect(e.tempoRef!.speed).toBe(110);
    expect(e.tempoSpeed).toBeUndefined();
  });
  it('не-ходовые клипы не трогает; migrateClip везёт поля', () => {
    const idle = { ...migrateClip(JSON.parse(JSON.stringify(walk))), name: 'idle_none_relax' };
    syncClipTempo([idle]);
    expect(idle.tempoRef).toBeUndefined();
    const c = migrateClip(JSON.parse(JSON.stringify(run)));
    const e = scaleLegs(c, 0.7); syncClipTempo([c, e]);
    const m = migrateClip(JSON.parse(JSON.stringify(e)));
    expect(m.tempoRef).toEqual(e.tempoRef);
    expect(m.tempoSpeed).toBe(e.tempoSpeed);
  });
});

import { describe, it, expect } from 'vitest';
import { auditChar, auditLocoSet, staleNames, severityOf, REQUIRED_NAMES, REBAKEABLE, CURRENT_BAKE_REV } from './locoSetAudit.js';
import { LOCO_BAKE_RUN_SPD, LOCO_BAKE_WALK_SPD } from './locoBlend.js';
import { SWING_KEY, TURN_NAMES } from './turnInPlace.js';
import { LOCO_CARDINAL_REV } from './poseRuntime.js';
import type { Clip } from './clipModel.js';

/**
 * ПОКРЫТИЕ НАБОРА — сторожа.
 *
 * Панель, которая врёт про состояние контента, хуже отсутствующей: по ней принимают решение «печь или не печь».
 * Поэтому каждый дефект проверяется на входе, где ответ известен заранее, и отдельно — что ИСПРАВНЫЙ набор не даёт
 * ни одного дефекта (иначе панель превращается в шум, который перестают читать).
 */
const good = (name: string, charId = 'warrior'): Clip => {
  const gait = name.startsWith('run_') || name.startsWith('walk_');
  const pose = gait ? { [SWING_KEY]: [0, 1, 0] as [number, number, number] } : {};
  return {
    name, character: charId, weapon: 'none', loop: true, keys: [{ t: 0, pose }, { t: 0.5, pose }],
    ...(gait ? {
      bakeSpeed: name.startsWith('run_') ? LOCO_BAKE_RUN_SPD : LOCO_BAKE_WALK_SPD,
      bakeRev: CURRENT_BAKE_REV, upperPure: true, bakeId: 777,
      swingRef: { RightUpperArm: [0, 0, 0] as [number, number, number] },
    } : {}),
  } as unknown as Clip;
};
const fullSet = (charId = 'warrior'): Clip[] => REQUIRED_NAMES.map((n) => good(n, charId));
const kinds = (c: ReturnType<typeof auditChar>): string[] => [...new Set(c.defects.map((d) => d.kind))].sort();

describe('покрытие набора локомоции', () => {
  it('⭐ ИСПРАВНЫЙ НАБОР НЕ ДАЁТ НИ ОДНОГО ДЕФЕКТА — иначе панель превращается в шум', () => {
    const cov = auditChar(fullSet(), 'warrior');
    expect(cov.defects, JSON.stringify(cov.defects.slice(0, 3))).toEqual([]);
    expect(cov.own).toBe(REQUIRED_NAMES.length);
    expect(cov.borrowed).toBe(0);
    expect(severityOf(cov)).toBe('ok');
    expect(staleNames(cov)).toEqual([]);
  });

  it('⭐ НАБОР СПРАШИВАЕТСЯ РОВНО ТОТ, ЧТО СПРАШИВАЕТ ДВИЖОК: 8 ходовых + стойка + повороты', () => {
    expect(REQUIRED_NAMES).toContain('run_fwd');
    expect(REQUIRED_NAMES).toContain('walk_strafe_L');
    expect(REQUIRED_NAMES).toContain('idle');
    for (const t of TURN_NAMES) expect(REQUIRED_NAMES, `поворот ${t}`).toContain(t);
    expect(REQUIRED_NAMES.length).toBe(8 + 1 + TURN_NAMES.length);
    expect(new Set(REQUIRED_NAMES).size, 'дублей нет').toBe(REQUIRED_NAMES.length);
  });

  it('⭐⭐ НЕТ КЛИПА И НЕТ ДОНОРА — блокер: кукла останется на планировщике', () => {
    const set = fullSet().filter((c) => c.name !== 'run_strafe_L');
    const cov = auditChar(set, 'warrior');
    expect(cov.defects.map((d) => [d.kind, d.name])).toEqual([['missing', 'run_strafe_L']]);
    expect(severityOf(cov)).toBe('block');
    expect(staleNames(cov), 'перезапеканием отсутствие клипа не лечится').toEqual([]);
  });

  it('⭐ МОНСТР БЕЗ СВОИХ КЛИПОВ: всё донорское, и это видно ЯВНО, а не молча', () => {
    const cov = auditChar(fullSet('warrior'), 'mon_undead', 'warrior');
    expect(cov.own).toBe(0);
    expect(cov.borrowed).toBe(REQUIRED_NAMES.length);
    expect(kinds(cov)).toEqual(['fallback']);
    expect(cov.defects[0]!.from).toBe('warrior');
    expect(severityOf(cov), 'чужой набор — не поломка, но и не «всё хорошо»').toBe('info');
  });

  it('свой клип бьёт донорский: где есть свой — «fallback» не пишется', () => {
    const set = [...fullSet('warrior'), good('run_fwd', 'mon_undead')];
    const cov = auditChar(set, 'mon_undead', 'warrior');
    expect(cov.own).toBe(1);
    expect(cov.defects.find((d) => d.name === 'run_fwd')).toBeUndefined();
  });

  it('⭐ ПРОТУХАНИЕ: чужая скорость, старая ревизия, впечённая стойка, нет канала опоры и нейтрали', () => {
    const bad = (patch: Partial<Clip>): ReturnType<typeof auditChar> =>
      auditChar(fullSet().map((c) => (c.name === 'run_fwd' ? { ...c, ...patch } as Clip : c)), 'warrior');
    expect(kinds(bad({ bakeSpeed: 102 }))).toEqual(['stale_speed']);
    expect(kinds(bad({ bakeRev: 1 }))).toEqual(['stale_rev']);
    expect(kinds(bad({ upperPure: undefined }))).toEqual(['dirty_upper']);
    expect(kinds(bad({ keys: [{ t: 0, pose: {} }] as Clip['keys'] }))).toEqual(['no_swing']);
    expect(kinds(bad({ swingRef: undefined }))).toEqual(['no_ref']);
    // ⚠ Кардинальная ревизия и текущая — РАЗНЫЕ: клип ревизии 2 свежий для секторов, но у него нет новых пометок.
    expect(kinds(bad({ bakeRev: LOCO_CARDINAL_REV, upperPure: undefined, swingRef: undefined, keys: [{ t: 0, pose: {} }] as Clip['keys'] })))
      .toEqual(['dirty_upper', 'no_ref', 'no_swing']);
  });

  it('⭐ РАЗНЫЕ ПРОГОНЫ — отдельный дефект: по самим позам этого не видно', () => {
    const cov = auditChar(fullSet().map((c) => (c.name === 'run_back' ? { ...c, bakeId: 999 } as Clip : c)), 'warrior');
    expect(kinds(cov)).toEqual(['split_bake']);
    expect(severityOf(cov)).toBe('warn');
  });

  it('«перезапечь протухшее» берёт ИМЕНА клипов, а не дефекты: у одного клипа их может быть несколько', () => {
    const cov = auditChar(fullSet().map((c) => (c.name === 'run_fwd'
      ? { ...c, upperPure: undefined, swingRef: undefined, keys: [{ t: 0, pose: {} }] as Clip['keys'] } as Clip : c)), 'warrior');
    expect(cov.defects.length, 'три дефекта на одном клипе').toBe(3);
    expect(staleNames(cov), 'а перезапечь надо один раз').toEqual(['run_fwd']);
    for (const d of cov.defects) expect(REBAKEABLE.has(d.kind), d.kind).toBe(true);
  });

  it('стойка и повороты не проверяются на поля клипов ХОДА (их там нет по построению)', () => {
    const cov = auditChar(fullSet(), 'warrior');
    expect(cov.defects.filter((d) => d.name === 'idle' || d.name.startsWith('turn_'))).toEqual([]);
  });

  it('аудит по роcтеру: донор сам себе донором не считается', () => {
    const all = auditLocoSet(fullSet('warrior'), ['warrior', 'mon_undead'], 'warrior');
    expect(all.map((c) => c.charId)).toEqual(['warrior', 'mon_undead']);
    expect(all[0]!.defects, 'у самого донора «играет чужой» быть не может').toEqual([]);
    expect(all[1]!.borrowed).toBe(REQUIRED_NAMES.length);
  });
});

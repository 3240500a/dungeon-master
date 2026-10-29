import { describe, it, expect } from 'vitest';
import { resolvePhysSet, presetBodies, matchPhysPreset, physCost, PHYS_PRESETS, type PhysNode } from './physRig.js';

// Мини-каталог той же формы, что настоящий: таз → торс → голова, и рука через плечо.
const CAT: PhysNode[] = [
  { name: 'Hips', parent: null, chain: [], tier: 'core' },
  { name: 'Torso', parent: 'Hips', chain: ['Spine', 'Chest'], tier: 'core' },
  { name: 'Head', parent: 'Torso', chain: ['Neck', 'Head'], tier: 'core' },
  { name: 'ArmL', parent: 'Torso', chain: ['LeftShoulder', 'LeftUpperArm'], tier: 'core' },
  { name: 'HandL', parent: 'ArmL', chain: ['LeftHand'], tier: 'extra' },
  { name: 'IndexL', parent: 'HandL', chain: ['LeftIndexProximal'], tier: 'opt' },
];
const names = (a: { name: string }[]): string[] => a.map((x) => x.name);

describe('physRig — активный набор', () => {
  it('полный набор = каталог один-в-один, родители индексами', () => {
    const a = resolvePhysSet(CAT, names(CAT));
    expect(names(a)).toEqual(names(CAT));
    expect(a.map((x) => x.parent)).toEqual([-1, 0, 1, 1, 3, 4]);
  });

  it('корень включён ВСЕГДА, даже если его не просили', () => {
    expect(names(resolvePhysSet(CAT, []))).toEqual(['Hips']);
    expect(resolvePhysSet(CAT, [])[0]!.parent).toBe(-1);
  });

  it('выключенный родитель — ребёнок цепляется к ближайшему включённому предку', () => {
    const a = resolvePhysSet(CAT, ['Torso', 'HandL']);          // ArmL выключен
    expect(names(a)).toEqual(['Hips', 'Torso', 'HandL']);
    expect(a[2]!.parent).toBe(1);                                // HandL → Torso
  });

  it('ГЛАВНОЕ: углы выключенного тела СЛИВАЮТСЯ в потомка, а не теряются', () => {
    const a = resolvePhysSet(CAT, ['Head', 'HandL']);            // выключены Torso и ArmL
    expect(a.find((x) => x.name === 'Head')!.chain).toEqual(['Spine', 'Chest', 'Neck', 'Head']);
    expect(a.find((x) => x.name === 'HandL')!.chain).toEqual(['Spine', 'Chest', 'LeftShoulder', 'LeftUpperArm', 'LeftHand']);
  });

  it('слияние идёт через НЕСКОЛЬКО выключенных подряд, порядок родитель→ребёнок сохраняется', () => {
    const a = resolvePhysSet(CAT, ['IndexL']);                   // выключено всё между тазом и фалангой
    expect(names(a)).toEqual(['Hips', 'IndexL']);
    expect(a[1]!.parent).toBe(0);
    expect(a[1]!.chain).toEqual(['Spine', 'Chest', 'LeftShoulder', 'LeftUpperArm', 'LeftHand', 'LeftIndexProximal']);
  });

  it('включённое тело НЕ передаёт свою цепь дальше (иначе поворот считался бы дважды)', () => {
    const a = resolvePhysSet(CAT, ['Torso', 'Head']);
    expect(a.find((x) => x.name === 'Head')!.chain).toEqual(['Neck', 'Head']);
  });

  it('родитель ВСЕГДА раньше ребёнка — это требование Jolt, а не вкусовщина', () => {
    for (const on of [['Torso', 'Head', 'ArmL', 'HandL', 'IndexL'], ['Head'], ['HandL', 'IndexL'], ['ArmL', 'IndexL']]) {
      const a = resolvePhysSet(CAT, on);
      a.forEach((b, i) => expect(b.parent).toBeLessThan(i));
    }
  });

  it('неизвестные имена игнорируются, дубли не плодят тел', () => {
    const a = resolvePhysSet(CAT, ['Torso', 'Torso', 'НетТакого']);
    expect(names(a)).toEqual(['Hips', 'Torso']);
  });
});

describe('physRig — пресеты', () => {
  it('минимум ⊂ базовый ⊂ с пальцами', () => {
    const min = presetBodies(CAT, 'min'), base = presetBodies(CAT, 'base'), full = presetBodies(CAT, 'full');
    expect(min.every((n) => base.includes(n))).toBe(true);
    expect(base.every((n) => full.includes(n))).toBe(true);
    expect(full.length).toBeGreaterThan(base.length);
    expect(base.length).toBeGreaterThan(min.length);
  });

  it('каждый пресет содержит корень — иначе кукла не соберётся', () => {
    for (const pr of PHYS_PRESETS) expect(presetBodies(CAT, pr.id)).toContain('Hips');
  });

  it('неизвестный пресет = базовый, а не пустота', () => {
    expect(presetBodies(CAT, 'нет-такого')).toEqual(presetBodies(CAT, 'base'));
  });

  it('набор опознаётся обратно; произвольный — «свой»', () => {
    expect(matchPhysPreset(CAT, presetBodies(CAT, 'base'))).toBe('base');
    expect(matchPhysPreset(CAT, presetBodies(CAT, 'full'))).toBe('full');
    expect(matchPhysPreset(CAT, ['Hips', 'Head'])).toBe('custom');
  });
});

describe('physRig — стоимость', () => {
  it('констрейнтов на один меньше, чем тел (у корня родителя нет)', () => {
    expect(physCost(resolvePhysSet(CAT, presetBodies(CAT, 'full')))).toEqual({ bodies: 6, constraints: 5 });
    expect(physCost(resolvePhysSet(CAT, []))).toEqual({ bodies: 1, constraints: 0 });
  });
});

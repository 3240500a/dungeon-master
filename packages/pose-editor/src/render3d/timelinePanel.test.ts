import { describe, it, expect } from 'vitest';
import { changedGroups, setKeyTimes, setInterp, scaleKeys, TRACK_GROUPS, INTERP_COLOR } from './timelinePanel.js';
import type { Clip, Keyframe, Pose } from './clipModel.js';

const P = (o: Record<string, [number, number, number]>): Pose => o;
const mk = (keys: Keyframe[]): Clip => ({ name: 'c', character: 'a', weapon: 'sword', loop: false, keys });

describe('timelinePanel — дорожки по группам', () => {
  it('в первом кадре считаются изменёнными все группы, что в нём есть', () => {
    const c = mk([{ pose: P({ Spine: [0.1, 0, 0], LeftUpperArm: [0, 0, 0.2] }), t: 0 }]);
    const g = changedGroups(c, 0);
    expect(g.has('таз/спина')).toBe(true);
    expect(g.has('рука Л')).toBe(true);
    expect(g.has('нога П')).toBe(false);
  });

  it('во втором кадре — только реально изменившиеся группы', () => {
    const c = mk([
      { pose: P({ Spine: [0.1, 0, 0], LeftUpperArm: [0, 0, 0.2], RightUpperLeg: [0, 0, 0] }), t: 0 },
      { pose: P({ Spine: [0.1, 0, 0], LeftUpperArm: [0, 0, 1.4], RightUpperLeg: [0, 0, 0] }), t: 0.3 },
    ]);
    const g = changedGroups(c, 1);
    expect([...g]).toEqual(['рука Л']);
  });

  it('спец-ключи не создают дорожек', () => {
    const c = mk([
      { pose: P({ Spine: [0, 0, 0], __hipsP: [0, 32, 0], __match: [1, 0, 0] }), t: 0 },
      { pose: P({ Spine: [0, 0, 0], __hipsP: [3, 30, 1], __match: [0.5, 0, 0] }), t: 0.3 },
    ]);
    expect(changedGroups(c, 1).size).toBe(0);
  });

  it('пальцы попадают в свою группу «кисть», а не в «рука»', () => {
    const c = mk([
      { pose: P({ LeftIndexProximal: [0, 0, 0] }), t: 0 },
      { pose: P({ LeftIndexProximal: [0, -1.2, 0] }), t: 0.2 },
    ]);
    expect([...changedGroups(c, 1)]).toEqual(['кисть Л']);
  });

  it('группы покрывают весь канон без пересечений', () => {
    const bones = ['Root', 'Hips', 'Spine', 'Head', 'LeftShoulder', 'LeftHand', 'RightHand',
      'LeftThumbProximal', 'RightLittleDistal', 'LeftUpperLeg', 'RightToes'];
    for (const b of bones) {
      const hits = TRACK_GROUPS.filter(([, re]) => re.test(b));
      expect(hits.length, b).toBe(1);
    }
  });
});

describe('timelinePanel — операции над ключами', () => {
  const keys = (): Keyframe[] => [
    { pose: P({ Spine: [0, 0, 0] }), t: 0 },
    { pose: P({ Spine: [1, 0, 0] }), t: 0.3 },
    { pose: P({ Spine: [2, 0, 0] }), t: 0.6 },
  ];

  it('шаг драга меняет время И НЕ СОРТИРУЕТ (порядок наводит редактор на отпускании)', () => {
    const k = keys();
    setKeyTimes([{ key: k[1]!, t: 0.9 }]);
    expect(k.map((x) => x.t)).toEqual([0, 0.9, 0.6]);
    expect(k[1]!.pose['Spine']![0]).toBe(1);      // ключ остался СОБОЙ и на своём месте в массиве
  });

  it('ПРОТАЩИЛ МИМО СОСЕДА: второй шаг драга едет НА ТОТ ЖЕ ключ, а не на чужой', () => {
    // Регрессия ФО: раньше ключи держались по ИНДЕКСУ, а сортировка на каждом шаге переставляла массив под ними.
    const k = keys();
    const dragged = k[1]!;                        // его и тащим весь драг
    setKeyTimes([{ key: dragged, t: 0.9 }]);      // обогнали третий ключ
    setKeyTimes([{ key: dragged, t: 1.2 }]);      // тащим дальше
    expect(dragged.t).toBe(1.2);
    expect(k[2]!.t).toBe(0.6);                    // сосед НЕ сдвинулся
  });

  it('время не уходит в минус', () => {
    const k = keys();
    setKeyTimes([{ key: k[1]!, t: -5 }]);
    expect(k[1]!.t).toBe(0);
  });

  it('перетаскивание нескольких сохраняет их взаимные интервалы', () => {
    const k = keys();
    setKeyTimes([{ key: k[1]!, t: 0.5 }, { key: k[2]!, t: 0.8 }]);
    expect(k.map((x) => x.t)).toEqual([0, 0.5, 0.8]);
  });

  it('форма перехода ставится выделенным и снимает ручки при смене типа', () => {
    const k = keys();
    setInterp(k, [0, 1], 'ease', [0.42, 0, 0.58, 1]);
    expect(k[0]!.interp).toBe('ease'); expect(k[0]!.ease).toEqual([0.42, 0, 0.58, 1]);
    setInterp(k, [0], 'step');
    expect(k[0]!.interp).toBe('step'); expect(k[0]!.ease).toBeUndefined();
    expect(k[2]!.interp).toBeUndefined();        // не выделен — не тронут
  });

  it('масштаб диапазона растягивает вокруг его начала', () => {
    const k = keys();
    scaleKeys(k, [0, 1, 2], 2);
    expect(k.map((x) => x.t)).toEqual([0, 0.6, 1.2]);
  });

  it('масштаб одного ключа — no-op (нечего растягивать)', () => {
    const k = keys();
    scaleKeys(k, [1], 2);
    expect(k.map((x) => x.t)).toEqual([0, 0.3, 0.6]);
  });
});

describe('timelinePanel — цвет формы перехода', () => {
  it('у каждой формы свой цвет, у linear и «нет поля» — одинаковый', () => {
    expect(INTERP_COLOR.linear).toBe(INTERP_COLOR.none);
    expect(new Set([INTERP_COLOR.linear, INTERP_COLOR.ease, INTERP_COLOR.step, INTERP_COLOR.fixed]).size).toBe(4);
  });
});

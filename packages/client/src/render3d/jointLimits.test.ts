import { describe, it, expect } from 'vitest';
import { extraLimitView, EXTRA_JOINTS } from './jointLimits.js';

const DEG = 180 / Math.PI;

/**
 * КЛЮЧИЦА (Ф21.4). Проверяем не «числа как в таблице», а СВОЙСТВА, ради которых таблица заведена:
 * ключица должна быть УЗКОЙ (иначе она работает вторым плечом и корпус не скручивается) и зеркальной.
 *
 * История: физ-риг сливает ключицу с плечом в одно тело (`RETARGET.ArmR = [RightShoulder, RightUpperArm]`),
 * поэтому `limitViewForBone('RightShoulder')` возвращал ПЛЕЧЕВЫЕ диапазоны ±97°/±69°. Замерено:
 * при тяге кисти поперёк тела солвер выкручивал ключицу на 89.5°, а спина оставалась на 0°.
 */
describe('jointLimits — ключица (Ф21.4)', () => {
  it('ключица есть в явной таблице для ОБЕИХ сторон', () => {
    expect(EXTRA_JOINTS['LeftShoulder']).toBeTruthy();
    expect(EXTRA_JOINTS['RightShoulder']).toBeTruthy();
    expect(EXTRA_JOINTS['LeftShoulder']!.canon).toBe('clavicle');
  });

  it('ГЛАВНОЕ: диапазоны АНАТОМИЧНЫЕ, а не плечевые (иначе корпус не подключится)', () => {
    for (const b of ['LeftShoulder', 'RightShoulder']) {
      const v = extraLimitView(b)!;
      expect(v, b).toBeTruthy();
      expect(v.kind).toBe('swing');
      // грудино-ключичный сустав: выведение ~±20°, подъём ~±15°, осевое ~±10°.
      // Плечо для сравнения — ±97° сгиб / ±69° развод: вот его-то ключица и наследовала.
      expect(Math.abs(v.planeMax! * DEG), b).toBeLessThanOrEqual(25);
      expect(Math.abs(v.planeMin! * DEG), b).toBeLessThanOrEqual(25);
      expect(Math.abs(v.normalMax! * DEG), b).toBeLessThanOrEqual(20);
      expect(Math.abs(v.twistMax! * DEG), b).toBeLessThanOrEqual(15);
    }
  });

  it('оси зеркальны: twist вдоль ±X по стороне', () => {
    const l = extraLimitView('LeftShoulder')!, r = extraLimitView('RightShoulder')!;
    expect(l.twist![0]).toBeCloseTo(1, 6);
    expect(r.twist![0]).toBeCloseTo(-1, 6);
    // normal = twist × plane → тоже переворачивается сам, отдельной таблицы правой стороны не нужно
    expect(l.normal![2]).toBeCloseTo(-r.normal![2], 6);
  });

  it('бинд-сдвиг (Ф17) ключицы НЕ трогает — он про фаланги', () => {
    const v = extraLimitView('LeftShoulder')!;
    expect(v.planeMin! * DEG).toBeCloseTo(-20, 6);
    expect(v.planeMax! * DEG).toBeCloseTo(20, 6);
  });

  it('фаланги на месте — ключица их не вытеснила', () => {
    expect(extraLimitView('LeftIndexProximal')).toBeTruthy();
    expect(Object.keys(EXTRA_JOINTS).length).toBe(30 + 2);   // 30 фаланг + 2 ключицы
  });
});

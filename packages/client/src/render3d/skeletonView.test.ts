import { describe, it, expect } from 'vitest';
import { boneWidth, screenRadiusToWorld } from './humanoid.js';

/** Старая формула ширины кости — эталон «тело не должно измениться». */
const oldWidth = (len: number): number => Math.min(3, Math.max(0.8, len * 0.14));

/** РЕАЛЬНЫЕ длины костей тела = расстояние до ПЕРВОГО ребёнка в таблице BONES.
 *  Самая короткая — 4 (шея→голова и ключица→плечо), поэтому порог формулы стоит ровно там. */
const BODY_LENS = [4, 4, 5, 5, 5, 6, 6.08, 11, 13, 14, 15];
const FINGER_LENS = [1.9, 1.7, 1.5, 1.3, 1.2, 1.1, 1.0, 0.9, 0.8];

describe('skeleton — ширина кости (Ф13.2)', () => {
  it('ГЛАВНОЕ: на костях ТЕЛА результат совпадает со старой формулой до знака', () => {
    for (const len of BODY_LENS) expect(boneWidth(len)).toBeCloseTo(oldWidth(len), 12);
  });

  it('порог ровно на len=4: там старый абсолютный пол 0.8 и новый относительный сходятся', () => {
    expect(boneWidth(4)).toBeCloseTo(0.8, 12);
    expect(boneWidth(4.0001)).toBeCloseTo(oldWidth(4.0001), 12);
    expect(boneWidth(3.9)).toBeLessThan(oldWidth(3.9));            // ниже порога — уже тоньше
  });

  it('фаланги худеют: раньше ВСЕ упирались в 0.8, теперь ширина идёт за длиной', () => {
    for (const len of FINGER_LENS) {
      expect(oldWidth(len)).toBe(0.8);                             // старое: одинаковый кубик на любой фаланге
      expect(boneWidth(len)).toBeLessThan(0.8);
    }
    expect(boneWidth(1.7)).toBeCloseTo(0.34, 6);
    expect(boneWidth(0.9)).toBeCloseTo(0.18, 6);
  });

  it('ширина монотонна по длине и никогда не превышает кость', () => {
    let prev = 0;
    for (let len = 0.2; len < 30; len += 0.2) {
      const w = boneWidth(len);
      expect(w).toBeGreaterThanOrEqual(prev - 1e-9);               // монотонно (после потолка — константа)
      expect(w).toBeLessThanOrEqual(Math.max(3, len));             // не толще самой кости
      prev = w;
    }
  });

  it('кость кисти (запястье→большой палец, 2.2) тоже худеет — и это правильно', () => {
    expect(oldWidth(2.198)).toBe(0.8);                             // была толще, чем расстояние до пальца
    expect(boneWidth(2.198)).toBeCloseTo(0.44, 2);
  });

  it('потолок 3 держится на длинных костях', () => { expect(boneWidth(100)).toBe(3); });
});

describe('skeleton — экранный размер сустава (Ф13.1)', () => {
  const FOV = 45, VH = 528;   // камера редактора и типичная высота вьюпорта

  it('при дефолтном кадре 7px дают сегодняшние ~1.6 юнита — вид тела не меняется', () => {
    const r = screenRadiusToWorld(150, FOV, VH, 7);
    expect(r).toBeGreaterThan(1.5);
    expect(r).toBeLessThan(1.8);
  });

  it('линеен по дистанции и по пикселям — вдвое дальше значит вдвое крупнее в мире', () => {
    expect(screenRadiusToWorld(300, FOV, VH, 7)).toBeCloseTo(2 * screenRadiusToWorld(150, FOV, VH, 7), 9);
    expect(screenRadiusToWorld(150, FOV, VH, 14)).toBeCloseTo(2 * screenRadiusToWorld(150, FOV, VH, 7), 9);
  });

  it('ГЛАВНОЕ: подлёт к кисти делает шар мельче ФАЛАНГИ, отлёт оставляет его крупным', () => {
    const near = screenRadiusToWorld(12, FOV, VH, 7);              // камера в 12 юнитах — работаем с пальцами
    expect(near).toBeLessThan(0.9 / 2);                            // мельче половины самой короткой фаланги
    const far = screenRadiusToWorld(300, FOV, VH, 7);
    expect(far).toBeGreaterThan(1.6);                              // издалека — по-прежнему заметен и кликабелен
  });

  it('высокий вьюпорт не раздувает шар (делим на пиксели, а не на кадры)', () => {
    expect(screenRadiusToWorld(150, FOV, 1056, 7)).toBeCloseTo(screenRadiusToWorld(150, FOV, 528, 7) / 2, 9);
  });

  it('вырожденная высота вьюпорта не делит на ноль', () => {
    expect(Number.isFinite(screenRadiusToWorld(150, FOV, 0, 7))).toBe(true);
  });
});

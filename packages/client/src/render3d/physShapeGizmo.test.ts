import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { shapeFrame, dragPos, dragRot, dragSize, modeOf } from './physShapeGizmo.js';

/**
 * ПРАВКА ФИЗ-ТЕЛА ГИЗМО = ТО ЖЕ, ЧТО ПРАВКА ПОЛЗУНКАМИ.
 *
 * Панель и вьюпорт пишут в один и тот же оверрайд (`PHYS_SIZES`), и разойтись они могут ровно на переводе
 * «драг → число»: не в тех осях, не с тем знаком, не в те единицы. Поэтому перевод — чистый, и он здесь.
 */
const deg = (d: number): number => d * Math.PI / 180;
const qAxis = (ax: 'x' | 'y' | 'z', d: number): THREE.Quaternion =>
  new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(ax === 'x' ? 1 : 0, ax === 'y' ? 1 : 0, ax === 'z' ? 1 : 0), deg(d));

describe('рамка формы: +Y всегда ВДОЛЬ тела', () => {
  it('круглые формы уже по Y — рамка их не крутит', () => {
    const f = shapeFrame(new THREE.Quaternion(), new THREE.Quaternion(), 'capsule', 0);
    const along = new THREE.Vector3(0, 1, 0).applyQuaternion(f);
    expect(along.y).toBeCloseTo(1, 6);
  });

  it('⭐ у БОКСА длина лежит на своей полуоси — рамка ведёт на неё +Y (иначе «удлинить» толстит)', () => {
    const along = new THREE.Vector3(0, 1, 0).applyQuaternion(shapeFrame(new THREE.Quaternion(), new THREE.Quaternion(), 'box', 0));
    expect(Math.abs(along.x), 'ось X тела').toBeCloseTo(1, 6);
    const alongZ = new THREE.Vector3(0, 1, 0).applyQuaternion(shapeFrame(new THREE.Quaternion(), new THREE.Quaternion(), 'box', 2));
    expect(Math.abs(alongZ.z)).toBeCloseTo(1, 6);
  });

  it('разворот формы внутри кости учитывается (кость косая — стрелка «вдоль» идёт вдоль тела)', () => {
    const bone = qAxis('y', 90);                       // кость развёрнута в мире
    const shape = qAxis('z', 90);                      // форма развёрнута внутри кости
    const along = new THREE.Vector3(0, 1, 0).applyQuaternion(shapeFrame(bone, shape, 'capsule', 1));
    const want = new THREE.Vector3(0, 1, 0).applyQuaternion(shape).applyQuaternion(bone);
    expect(along.distanceTo(want)).toBeLessThan(1e-6);
  });
});

describe('сдвиг: мировая дельта → `pos` в осях КОСТИ', () => {
  it('кость не повёрнута — дельта ложится как есть', () => {
    expect(dragPos(undefined, new THREE.Vector3(1.5, 0, 0), new THREE.Quaternion())).toEqual([1.5, 0, 0]);
  });

  /**
   * Знак проверен АРИФМЕТИКОЙ, а не на глаз: поворот кости на +90° вокруг Y ведёт её +X в мировой −Z,
   * значит мировой +X — это её +Z. (Первая редакция этого сторожа ждала −Z и была неправа.)
   */
  it('⭐ кость повёрнута на 90° вокруг Y — мировой +X это +Z кости (иначе тело уезжает не туда)', () => {
    const p = dragPos(undefined, new THREE.Vector3(2, 0, 0), qAxis('y', 90));
    expect(p[0]).toBeCloseTo(0, 6);
    expect(p[2]).toBeCloseTo(2, 6);
  });

  it('прибавляется к уже записанному сдвигу, а не заменяет его', () => {
    expect(dragPos([1, 2, 3], new THREE.Vector3(0, 1, 0), new THREE.Quaternion())).toEqual([1, 3, 3]);
  });

  it('округление до сотых — как у ползунка (шаг 0.1), чтобы в конфиг не текли хвосты', () => {
    expect(dragPos(undefined, new THREE.Vector3(0.123456, 0, 0), new THREE.Quaternion())[0]).toBe(0.12);
  });
});

describe('поворот: кватернион ручки → `rot` в осях КОСТИ', () => {
  it('⭐ 30° вокруг X кости — ровно то число, что показал бы ползунок', () => {
    const bone = new THREE.Quaternion();
    const r = dragRot(bone.clone().multiply(qAxis('x', 30)), bone, undefined);
    expect(r[0] * 180 / Math.PI).toBeCloseTo(30, 3);
    expect(r[1]).toBeCloseTo(0, 6); expect(r[2]).toBeCloseTo(0, 6);
  });

  it('⭐⭐ ОСИ КОСТИ, А НЕ МИРА: та же картинка на косой кости даёт то же число', () => {
    const bone = qAxis('y', 37).multiply(qAxis('z', 21));
    const r = dragRot(bone.clone().multiply(qAxis('x', 30)), bone, undefined);
    expect(r[0] * 180 / Math.PI).toBeCloseTo(30, 3);
  });

  it('копится поверх прежнего поворота (два драга по 20° = 40°)', () => {
    const bone = new THREE.Quaternion();
    const first = dragRot(bone.clone().multiply(qAxis('x', 20)), bone, undefined);
    const second = dragRot(bone.clone().multiply(qAxis('x', 20)), bone, first);
    // Допуск — цена округления до 1e-4 рад (0.006°), теми же сотыми долями градуса живёт и ползунок (шаг 1°).
    expect(second[0] * 180 / Math.PI).toBeCloseTo(40, 1);
  });
});

describe('масштаб: вектор ручки (Y — вдоль) → len/w/d', () => {
  it('⭐ бокс: Y это длина, X — ширина, Z — толщина', () => {
    const r = dragSize('box', 4, {}, new THREE.Vector3(1.5, 2, 0.5));
    expect(r.len, 'длина АБСОЛЮТНА — множим текущую полудлину').toBe(8);
    expect(r.w, 'ширина — МНОЖИТЕЛЬ каталожной').toBe(1.5);
    expect(r.d).toBe(0.5);
  });

  it('множители копятся от уже записанных', () => {
    const r = dragSize('box', 4, { w: 1.2, d: 0.5 }, new THREE.Vector3(1.5, 1, 2));
    expect(r.w).toBe(1.8); expect(r.d).toBe(1);
    expect(r.len, 'вдоль не тянули — поле не трогаем вовсе').toBeUndefined();
  });

  it('⭐ круглые: поперечник ОДИН — обе поперечные стрелки ведут в `w`, `d` (сужение) не трогается', () => {
    const r = dragSize('capsule', 5, {}, new THREE.Vector3(1.4, 1, 1.05));
    expect(r.w, 'берётся стрелка, которую тянули дальше').toBe(1.4);
    expect(r.d).toBeUndefined();
    expect(dragSize('taper', 5, {}, new THREE.Vector3(1, 1, 1.6)).d, 'у конуса `d` — СУЖЕНИЕ, гизмо его не считает толщиной').toBeUndefined();
  });

  it('шар длины не имеет — растяжение вдоль не пишется', () => {
    const r = dragSize('sphere', 5, {}, new THREE.Vector3(1, 3, 1));
    expect(r.len).toBeUndefined();
  });

  it('⚠ зажато в те же пределы, что у ползунков: вне их панель показала бы не своё значение', () => {
    const big = dragSize('box', 19, {}, new THREE.Vector3(9, 9, 9));
    expect(big.len).toBe(20); expect(big.w).toBe(2.5); expect(big.d).toBe(2.5);
    const small = dragSize('box', 1, {}, new THREE.Vector3(0.01, 0.01, 0.01));
    expect(small.len).toBe(0.5); expect(small.w).toBe(0.3); expect(small.d).toBe(0.3);
  });
});

describe('режим по клавишам — один разбор на вьюпорт и на подсказку', () => {
  it('пусто — двигаем, Shift — крутим, Alt — масштабируем', () => {
    expect(modeOf({})).toBe('translate');
    expect(modeOf({ shift: true })).toBe('rotate');
    expect(modeOf({ alt: true })).toBe('scale');
  });

  it('⚠ Alt важнее Shift: Shift у гизмо ещё и шаг привязки, и вместе они не должны спорить', () => {
    expect(modeOf({ shift: true, alt: true })).toBe('scale');
  });
});

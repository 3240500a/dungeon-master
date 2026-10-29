import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { makeCamShake } from './camShake.js';
import { shakeForMark } from './animSfx.js';
import { marksInRange, type Clip, type MarkEvent } from './clipModel.js';

/**
 * ⭐ ТРЯСКА КАМЕРЫ ПО МЕТКЕ `camshake` — последняя метка звуко-камерных дорожек, которая ничего не
 * делала. Сила берётся ИЗ МЕТКИ (`num`), чтобы её можно было масштабировать от тяжести удара.
 */
describe('тряска камеры', () => {
  const ev = (mark: Record<string, unknown>): MarkEvent => {
    const c = { keys: [{ t: 0.1, pose: {}, marks: [mark] }] } as unknown as Clip;
    return marksInRange(c, -1e-9, 9)[0]!;
  };

  it('сила берётся из метки', () => {
    expect(shakeForMark(ev({ type: 'camshake', num: 2.5 }))).toBe(2.5);
  });

  it('силы нет — обычный удар (1), а не тишина', () => {
    expect(shakeForMark(ev({ type: 'camshake' }))).toBe(1);
  });

  it('⚠ отрицательная сила — это ноль, а не рывок в другую сторону', () => {
    expect(shakeForMark(ev({ type: 'camshake', num: -3 }))).toBe(0);
  });

  it('прочие метки камеру не трясут', () => {
    for (const t of ['impact', 'swing', 'combo', 'footstep', 'sfx']) expect(shakeForMark(ev({ type: t, dur: 0.2 }))).toBe(0);
  });

  it('⭐ без толчка камера НЕ ТРОГАЕТСЯ вовсе', () => {
    // ⚠ Мутация «двигать всегда» валит это: камера дрожала бы постоянно.
    const sh = makeCamShake(); const cam = new THREE.Object3D();
    cam.position.set(1, 2, 3);
    for (let i = 0; i < 30; i++) sh.apply(cam, 1 / 60);
    expect(cam.position.toArray()).toEqual([1, 2, 3]);
  });

  it('⭐ толчок двигает камеру и ЗАТУХАЕТ', () => {
    const sh = makeCamShake(); const cam = new THREE.Object3D();
    const base = new THREE.Vector3(0, 0, 0);
    sh.hit(1);
    let moved = 0;
    for (let i = 0; i < 12; i++) { cam.position.copy(base); sh.apply(cam, 1 / 60); moved = Math.max(moved, cam.position.distanceTo(base)); }
    expect(moved, '⚠ камера не сдвинулась — тряски нет').toBeGreaterThan(0.1);
    for (let i = 0; i < 120; i++) { cam.position.copy(base); sh.apply(cam, 1 / 60); }
    expect(sh.trauma, '⚠ тряска не затухает — камера дрожит вечно').toBe(0);
    cam.position.copy(base); sh.apply(cam, 1 / 60);
    expect(cam.position.distanceTo(base), '⚠ после затухания камера всё ещё смещена').toBe(0);
  });

  it('⭐⭐ СИЛЬНЫЙ ТОЛЧОК ЗАМЕТНО СИЛЬНЕЕ СЛАБОГО — смещение идёт от КВАДРАТА травмы', () => {
    // ⚠ Мутация «линейно от травмы» валит это: слабые тряски стали бы такими же заметными.
    const peak = (power: number): number => {
      const sh = makeCamShake(); const cam = new THREE.Object3D(); const base = new THREE.Vector3();
      sh.hit(power);
      let m = 0;
      for (let i = 0; i < 20; i++) { cam.position.copy(base); sh.apply(cam, 1 / 60); m = Math.max(m, cam.position.distanceTo(base)); }
      return m;
    };
    const weak = peak(0.4), strong = peak(2);
    // ⚠ ПОРОГ ВЫБРАН ПО МУТАНТУ, А НЕ НА ГЛАЗ: травмы тут 0.14 и 0.70, значит квадрат даёт ×25,
    // а линейная зависимость — всего ×5. Порог 4 пропускал бы линейного мутанта живым.
    expect(strong / Math.max(weak, 1e-6), '⚠ разница силы почти не читается').toBeGreaterThan(12);
  });

  it('⚠ ЦЕПОЧКА УДАРОВ НЕ РАСТРЯСАЕТ КАДР ДО НЕЧИТАЕМОСТИ — травма зажата единицей', () => {
    const sh = makeCamShake();
    for (let i = 0; i < 20; i++) sh.hit(5);
    expect(sh.trauma).toBeLessThanOrEqual(1);
  });
});

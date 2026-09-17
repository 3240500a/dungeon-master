import { describe, it, expect, afterEach } from 'vitest';
import { PoseDriver, GAIT, GAIT_BASE } from './pose.js';

/**
 * ⭐ ПРЕДЕЛ СКОРОСТИ ЦЕЛИ ВЫСОТЫ ТАЗА (`GAIT.bobSlew` / `bobSlewRun`).
 *
 * Жалоба: «рывок головы» в запечённых `run_fwd`/`run_back`/`walk_back`. Голова тут ни при чём — дёргался
 * таз по вертикали: цель `wantY` СТУПЕНЬКОЙ (в полёте — рост стоя, в кадр касания — упор в `pelvisMin`,
 * замер 32.08 → 26.57 за кадр), а лаг первого порядка делал из ступеньки мгновенную смену скорости.
 * Предел превращает ступеньку в рампу. Умолчание 0 = прежнее поведение (golden-вектор не сдвинут).
 */
describe('bobSlew — предел скорости цели высоты таза', () => {
  const saved: Record<string, number> = {};
  const set = (k: string, v: number): void => {
    const g = GAIT as unknown as Record<string, number>;
    if (!(k in saved)) saved[k] = g[k]!;
    g[k] = v;
  };
  afterEach(() => {
    const g = GAIT as unknown as Record<string, number>;
    for (const k in saved) { g[k] = saved[k]!; delete saved[k]; }
  });

  /** Бег по прямой с аналит. фидбэком стоп (как golden): след bobY после разгона. */
  function run(speed: number, frames = 240): number[] {
    const d = new PoseDriver();
    d.setStance(3.6, 0, -3.6, 0, 30);
    let z = 0;
    const trace: number[] = [];
    for (let i = 0; i < frames + 60; i++) {
      z += speed / 60;
      d.setWorld(0, z, 0, 0, speed);
      const fl = d.plantTarget(0), fr = d.plantTarget(1);
      d.setFeet(fl[0], fl[1], fr[0], fr[1]);
      const t = d.update(1 / 60);
      if (i >= 60) trace.push(t.bobY);
    }
    return trace;
  }
  const maxAcc = (y: number[]): number => {
    let m = 0;
    for (let i = 1; i < y.length - 1; i++) m = Math.max(m, Math.abs((y[i + 1]! - 2 * y[i]! + y[i - 1]!) * 3600));
    return m;
  };

  it('умолчания = выкл (0)', () => {
    expect(GAIT_BASE.bobSlew).toBe(0);
    expect(GAIT_BASE.bobSlewRun).toBe(0);
  });

  it('⭐ предел РЕАЛЬНО снимает рывок таза на беге (замер: 1554 → 628 ед/с² при 30)', () => {
    const stiff = maxAcc(run(120));
    set('bobSlewRun', 30);
    const soft = maxAcc(run(120));
    expect(stiff, 'рывка нет и без предела — сторож ничего не проверяет').toBeGreaterThan(1000);
    expect(soft, '⚠ предел не доходит до лага — цель по-прежнему ступенькой').toBeLessThan(stiff * 0.5);
  });

  it('на беге берётся беговая ручка, а не ходьбы (лерп по sb, 120 → sb = 1)', () => {
    const base = run(120);
    set('bobSlew', 30);                           // ходьбы — на sb = 1 вес ноль
    const walkKnob = run(120);
    for (let i = 0; i < base.length; i++) expect(walkKnob[i]).toBe(base[i]);
  });

  /** То же, что `run`, но с произвольной частотой кадров: предел обязан быть в ед/с, а не «на кадр». */
  function runAt(speed: number, fps: number, sec = 4): number[] {
    const d = new PoseDriver();
    d.setStance(3.6, 0, -3.6, 0, 30);
    let z = 0;
    const trace: number[] = [];
    for (let i = 0; i < sec * fps; i++) {
      z += speed / fps;
      d.setWorld(0, z, 0, 0, speed);
      const fl = d.plantTarget(0), fr = d.plantTarget(1);
      d.setFeet(fl[0], fl[1], fr[0], fr[1]);
      trace.push(d.update(1 / fps).bobY);
    }
    return trace;
  }

  it('предел — в ед/с на любой частоте кадров: при мгновенном лаге скорость таза упирается ровно в него', () => {
    // Лаг мгновенный (1e9 → min(1, dt·rate) = 1): таз = цель после предела, и его скорость видна напрямую.
    // Замер: без предела 94.5 ед/с на 60 fps и 202.3 на 144 (ступенька за кадр); с пределом 30 — 30.00 на обеих.
    // Мутация «предел на кадр» (`slew / 60`) даёт на 144 fps 72, «предел только вниз» — ступеньку вверх.
    for (const k of ['bobLagUp', 'bobLagUpRun', 'bobLagDown', 'bobLagDownRun']) set(k, 1e9);
    set('bobSlewRun', 30);
    for (const fps of [60, 144]) {
      const y = runAt(120, fps);
      let up = 0, down = 0;
      for (let i = 1; i < y.length; i++) { const v = (y[i]! - y[i - 1]!) * fps; up = Math.max(up, v); down = Math.max(down, -v); }
      expect(up, `${fps} fps: подъём быстрее предела`).toBeLessThan(30 + 1e-6);
      expect(down, `${fps} fps: просадка быстрее предела`).toBeLessThan(30 + 1e-6);
      expect(Math.min(up, down), `${fps} fps: предел не достигнут — сторож ничего не проверяет`).toBeGreaterThan(29.9);
    }
  });

  it('скорость лага выбирается по направлению к цели ПОСЛЕ предела: при bobLagUp* = 0 таз не поднимается ни на кадр', () => {
    // Таз идёт к `hipWant`, значит и «вверх/вниз» — относительно него. Сравни с сырой `wantY` — и в кадр, когда
    // сырая цель уже ниже таза, а рампа ещё выше, таз поехал бы ВВЕРХ со скоростью просадки. C#-порт — так же.
    set('bobLagUp', 0); set('bobLagUpRun', 0);
    set('bobSlewRun', 30);
    const y = runAt(120, 60);
    let rise = 0;
    for (let i = 1; i < y.length; i++) rise = Math.max(rise, y[i]! - y[i - 1]!);
    expect(rise).toBeLessThan(1e-9);
    expect(Math.min(...y), 'таз не просел вовсе — сторож ничего не проверяет').toBeLessThan(-1);
  });

  it('setStance сбрасывает цель вместе с тазом: стоя таз не «сползает» с чужой высоты', () => {
    // Без сброса цель осталась бы на STAND_Y (27) и поехала бы к стойке рампой — таз провис бы на старте.
    set('bobSlew', 30);
    const d = new PoseDriver();
    d.setStance(3.6, 0, -3.6, 0, 34);
    let worst = 0;
    for (let i = 0; i < 30; i++) {
      d.setWorld(0, 0, 0, 0, 0);
      const t = d.update(1 / 60);
      worst = Math.max(worst, Math.abs(t.bobY - 4));   // bobY = hipY − 30
    }
    expect(worst).toBeLessThan(1e-6);
  });
});

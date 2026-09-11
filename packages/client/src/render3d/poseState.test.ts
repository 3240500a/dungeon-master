import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PosePlayer, localStorageContent, emptyGrid } from './poseRuntime.js';
import { buildHumanoid } from './humanoid.js';
import type { Clip, Pose } from './clipModel.js';

/**
 * СОСТОЯНИЯ С СЕРВЕРА: ОГЛУШЁН И СБИТ С НОГ (Ф1.5).
 *
 * До этого их не видел никто. У монстров `stun` только рисовал иконку над головой, `downed` не читался
 * вообще, а у ИГРОКА поля стана в снапшоте не было — свой стан анимация не замечала в принципе.
 *
 * Теперь ВХОД в состояние запускает клип через тот же слот действия, что и удар: он уже умеет
 * огибающую, кроссфейд и владение низом тела стоя. Клипы привязываются в `pe_anim.states` — по
 * ссылке, как и стойки, поэтому имена могут быть любыми.
 *
 * Главное требование: пока клип не заавторен, НИЧЕГО не происходит и ничего не ломается.
 */
const v = (x: number): [number, number, number] => [x, 0, 0];
const clip = (name: string, arm: number): Clip => ({
  name, character: 'warrior', weapon: 'none', loop: false,
  keys: [{ pose: { RightUpperArm: v(0) } as Pose, t: 0 }, { pose: { RightUpperArm: v(arm) } as Pose, t: 0.3 }, { pose: { RightUpperArm: v(0) } as Pose, t: 0.6 }],
});

const setLS = (clips: Clip[], anim: unknown): void => {
  const data: Record<string, string> = { pe_clips: JSON.stringify(clips), pe_anim: JSON.stringify(anim) };
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => data[k] ?? null, setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0,
  } as Storage;
};

describe('стан и нокдаун доезжают до куклы', () => {
  afterEach(() => { delete (globalThis as unknown as { localStorage?: Storage }).localStorage; });

  const mk = (): PosePlayer =>
    new PosePlayer(buildHumanoid({}), () => [], localStorageContent('warrior'), 'none', { armDown: 1.35, elbowBend: 0.25 }, emptyGrid());

  it('вход в нокдаун запускает свой клип, выход — клип подъёма', () => {
    setLS([clip('knockdown_fall', 1.2), clip('getup', -0.8)], {});
    const p = mk(); p.setYaw(0); p.setVel(0, 0);
    for (let i = 0; i < 60; i++) p.step(1 / 60);

    expect(p.attacking, 'до события слот пуст').toBe(false);
    p.setState(false, true);
    expect(p.attacking, 'упал → играет knockdown_fall').toBe(true);
    expect(p.isDowned).toBe(true);

    for (let i = 0; i < 120 && p.attacking; i++) p.step(1 / 60);
    p.setState(false, false);
    expect(p.attacking, 'встал → играет getup').toBe(true);
    expect(p.isDowned).toBe(false);
  });

  it('оглушение запускает стаггер — но только НА ВХОДЕ, а не каждый кадр', () => {
    setLS([clip('stagger', 0.9)], {});
    const p = mk(); p.setYaw(0); p.setVel(0, 0);
    for (let i = 0; i < 60; i++) p.step(1 / 60);
    p.setState(true, false);
    expect(p.attacking).toBe(true);
    // Досматриваем до конца и держим флаг поднятым — повторно запускаться не должно.
    for (let i = 0; i < 300; i++) { p.setState(true, false); p.step(1 / 60); }
    expect(p.attacking, 'стаггер не перезапускается, пока стан держится').toBe(false);
  });

  it('нокдаун сильнее стана: упал и оглушён — играет падение', () => {
    setLS([clip('knockdown_fall', 1.2), clip('stagger', 0.9)], {});
    const p = mk(); p.setYaw(0); p.setVel(0, 0);
    for (let i = 0; i < 60; i++) p.step(1 / 60);
    p.setState(true, true);
    expect(p.isDowned).toBe(true);
    expect(p.isStunned).toBe(true);
    expect(p.attacking).toBe(true);
  });

  it('КЛИПА НЕТ — ничего не происходит и ничего не падает', () => {
    setLS([], {});
    const p = mk(); p.setYaw(0); p.setVel(0, 0);
    for (let i = 0; i < 60; i++) p.step(1 / 60);
    p.setState(true, true);
    expect(p.attacking, 'слот остался пуст').toBe(false);
    expect(p.isDowned, 'но состояние всё равно запомнено — для будущих узлов графа').toBe(true);
    for (let i = 0; i < 60; i++) p.step(1 / 60);   // кадры идут дальше без ошибок
  });

  it('привязка `pe_anim.states` — имя клипа может быть любым', () => {
    setLS([clip('моё_падение', 1.2)], { warrior: { states: { knockdown_fall: 'моё_падение' } } });
    const p = mk(); p.setYaw(0); p.setVel(0, 0);
    for (let i = 0; i < 60; i++) p.step(1 / 60);
    p.setState(false, true);
    expect(p.attacking, 'нашёлся по привязке, а не по имени состояния').toBe(true);
  });

  it('привязка на несуществующий клип = просто нет клипа', () => {
    setLS([clip('stagger', 0.9)], { warrior: { states: { stagger: 'которого_нет' } } });
    const p = mk(); p.setYaw(0); p.setVel(0, 0);
    for (let i = 0; i < 60; i++) p.step(1 / 60);
    p.setState(true, false);
    expect(p.attacking).toBe(false);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PosePlayer, localStorageContent, emptyGrid } from './poseRuntime.js';
import { buildHumanoid } from './humanoid.js';
import * as THREE from 'three';
import type { Clip, Mark, MarkEvent } from './clipModel.js';

/**
 * ТАЙМ-ВАРП УДАРА: помеченный кадр `impact` обязан прийтись РОВНО на `windupMs` сервера
 * (там наносится урон — `session.stepWindup` → `executeBasicAttack`), а клип целиком — уложиться в `lockMs`.
 * Клип БЕЗ метки обязан играться байт-в-байт как раньше.
 */
describe('удар: тайм-варп под серверный вайндап', () => {
  beforeEach(() => {
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0,
    } as Storage;
  });
  afterEach(() => { delete (globalThis as unknown as { localStorage?: Storage }).localStorage; });

  const mk = (): PosePlayer => new PosePlayer(buildHumanoid({}), () => [], localStorageContent('warrior'), 'sword', { armDown: 1.35, elbowBend: 0.25 }, emptyGrid());
  /** Клип 1.0 с; контакт на 0.6 (как в мокапе — примерно 60 % клипа). */
  const clip = (marks?: Mark[], impactAt = 0.6): Clip => ({
    name: 'hit_sword', character: 'warrior', weapon: 'sword', loop: false,
    keys: [{ pose: {}, t: 0 }, { pose: {}, t: impactAt, marks }, { pose: {}, t: 1 }],
  });
  /** Прогнать удар до конца, вернуть время (сек), когда сработала метка `impact`. */
  function runToImpact(p: PosePlayer, dt = 1 / 240): number | null {
    let t = 0, hit: number | null = null;
    p.onMark = (e: MarkEvent) => { if (e.mark.type === 'impact' && hit === null) hit = t; };
    for (let i = 0; i < 4000 && p.attacking; i++) { p.step(dt); t += dt; }
    return hit;
  }

  it('импакт садится РОВНО на вайндап сервера', () => {
    const p = mk();
    p.triggerAttack(clip([{ type: 'impact' }]), 0.8, 0.28);   // окно 0.8 с, урон на 0.28 с
    expect(runToImpact(p)).toBeCloseTo(0.28, 2);
  });

  it('и весь клип укладывается в окно атаки', () => {
    const p = mk();
    p.triggerAttack(clip([{ type: 'impact' }]), 0.8, 0.28);
    let t = 0; for (let i = 0; i < 4000 && p.attacking; i++) { p.step(1 / 240); t += 1 / 240; }
    expect(t).toBeCloseTo(0.8, 1);
  });

  it('ХВОСТ РАСТЯГИВАЕТСЯ: контакт в мокапе на 60 %, а вайндап сервера — 35 % окна', () => {
    // Именно этот случай ломал прежний `max(1, …)`: после импакта нужно играть МЕДЛЕННЕЕ авторского темпа.
    const p = mk();
    p.triggerAttack(clip([{ type: 'impact' }]), 1.0, 0.35);
    let t = 0, hit: number | null = null;
    p.onMark = (e) => { if (e.mark.type === 'impact' && hit === null) hit = t; };
    for (let i = 0; i < 4000 && p.attacking; i++) { p.step(1 / 240); t += 1 / 240; }
    expect(hit).toBeCloseTo(0.35, 2);                  // урон — точно в момент серверного
    expect(t).toBeCloseTo(1.0, 1);                     // и клип всё равно уложился в окно
  });

  it('без метки — прежнее поведение: ровная скорость max(1, длит/окно)', () => {
    const p = mk();
    p.triggerAttack(clip(), 0.5, 0.2);
    expect(p.atkSpeed).toBeCloseTo(2, 5);              // 1.0 / 0.5
    p.triggerAttack(clip(), 2, 0.7);
    expect(p.atkSpeed).toBe(1);                        // растягивать без метки не начали
  });

  it('без вайндапа (0) метка не включает варп — старый вызов не меняет поведение', () => {
    const p = mk();
    p.triggerAttack(clip([{ type: 'impact' }]), 0.5);
    expect(p.atkSpeed).toBeCloseTo(2, 5);
  });

  it('ТЕЛЕГРАФ МОНСТРА: окна нет, только вайндап — импакт всё равно точен', () => {
    const p = mk();
    p.triggerAttack(clip([{ type: 'impact' }]), 0, 0.45);
    expect(runToImpact(p)).toBeCloseTo(0.45, 2);
  });

  it('ползунок темпа редактора множит скорость, а не затирает расчёт', () => {
    const p = mk();
    p.triggerAttack(clip([{ type: 'impact' }]), 0.8, 0.28);
    p.atkTempo = 2;
    expect(runToImpact(p)).toBeCloseTo(0.14, 2);       // вдвое быстрее — вдвое раньше
    expect(p.atkSpeed).toBeCloseTo(0.6 / 0.28, 5);     // сам расчёт не тронут
  });

  it('коридор скорости [0.35, 8] держит абсурдные тайминги в узде', () => {
    const p = mk();
    p.triggerAttack(clip([{ type: 'impact' }]), 0.05, 0.01);   // окно 50 мс — быстрее 8× не играем
    let t = 0; for (let i = 0; i < 8000 && p.attacking; i++) { p.step(1 / 480); t += 1 / 480; }
    expect(t).toBeGreaterThan(0.1);
  });

  it('ОТРЕЗОК варпится вместе с клипом: взмах не отрывается от анимации', () => {
    const p = mk();
    // Взмах занимает [0.3, 0.6] клипа — то есть кончается ровно на импакте.
    const c = clip([{ type: 'impact' }]);
    c.keys[1]!.marks = [{ type: 'impact' }];
    c.keys[0]!.marks = [{ type: 'swing', dur: 0.6, sfx: 'whoosh', vfx: 'trail' }];
    const ev: { t: number; e: MarkEvent }[] = [];
    let t = 0;
    p.onMark = (e) => ev.push({ t, e });
    p.triggerAttack(c, 0.8, 0.28);
    for (let i = 0; i < 4000 && p.attacking; i++) { p.step(1 / 240); t += 1 / 240; }
    const end = ev.find((x) => x.e.mark.type === 'swing' && x.e.phase === 'end');
    const hit = ev.find((x) => x.e.mark.type === 'impact');
    expect(end).toBeTruthy();
    expect(end!.t).toBeCloseTo(hit!.t, 2);             // конец следа совпал с моментом удара, как и в клипе
  });

  it('каждая метка срабатывает РОВНО ОДИН раз за удар', () => {
    const p = mk();
    const c = clip([{ type: 'impact' }, { type: 'camshake', num: 1.2 }]);
    c.keys[0]!.marks = [{ type: 'swing', dur: 0.4 }];
    const seen: string[] = [];
    p.onMark = (e) => seen.push(e.mark.type + ':' + e.phase);
    p.triggerAttack(c, 0.8, 0.28);
    for (let i = 0; i < 4000 && p.attacking; i++) p.step(1 / 240);
    expect(seen.sort()).toEqual(['camshake:point', 'impact:point', 'swing:begin', 'swing:end']);
  });

  it('без подписчика метки ничего не ломают (обработчиков звука/VFX ещё нет)', () => {
    const p = mk();
    p.triggerAttack(clip([{ type: 'impact', sfx: 'hit', vfx: 'spark' }]), 0.8, 0.28);
    for (let i = 0; i < 4000 && p.attacking; i++) p.step(1 / 240);
    expect(p.attacking).toBe(false);
  });
});

/**
 * ЦЕПОЧКА УДАРОВ (атака зажата). Сервер шлёт свой `swing` на каждый удар — клиент лишь выбирает, с какого
 * участка клипа начать. Разметка участков внутри клипа вместо резки клипов — это Montage Sections из Unreal.
 */
describe('удар: цепочка без возврата в стойку', () => {
  beforeEach(() => {
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0,
    } as Storage;
  });
  afterEach(() => { delete (globalThis as unknown as { localStorage?: Storage }).localStorage; });
  const mk = (): PosePlayer => new PosePlayer(buildHumanoid({}), () => [], localStorageContent('warrior'), 'sword', { armDown: 1.35, elbowBend: 0.25 }, emptyGrid());
  /** Удар idle→замах→удар→idle: концы — стойка, на 0.25 размечен замах, на 0.6 — импакт. */
  const combo = (): Clip => ({
    name: 'hit_sword', character: 'warrior', weapon: 'sword', loop: false, idleEnds: true,
    keys: [
      { pose: {}, t: 0 },
      { pose: {}, t: 0.25, marks: [{ type: 'windup' }] },
      { pose: {}, t: 0.6, marks: [{ type: 'impact' }] },
      { pose: {}, t: 1 },
    ],
  });

  it('первый удар играется С НАЧАЛА (вход из стойки)', () => {
    const p = mk();
    p.triggerAttack(combo(), 0.8, 0.28);
    expect(p.atk.t).toBe(0);
  });

  it('второй удар в цепочке стартует С ЗАМАХА, минуя idle-вход', () => {
    const p = mk();
    p.triggerAttack(combo(), 0.8, 0.28);
    p.step(0.2);
    p.triggerAttack(combo(), 0.8, 0.28);
    expect(p.atk.t).toBeCloseTo(0.25, 5);            // метка `windup`, а не 0
  });

  it('без метки замаха цепочка стартует со ВТОРОГО ключа (первый — стойка)', () => {
    const p = mk();
    const c = combo(); for (const k of c.keys) delete k.marks;
    c.keys[2]!.marks = [{ type: 'impact' }];
    p.triggerAttack(c, 0.8, 0.28); p.step(0.2);
    p.triggerAttack(c, 0.8, 0.28);
    expect(p.atk.t).toBeCloseTo(0.25, 5);
  });

  it('импакт цепного удара ВСЁ РАВНО садится на серверный вайндап', () => {
    const p = mk();
    p.triggerAttack(combo(), 0.8, 0.28);
    p.step(0.2);
    let t = 0, hit: number | null = null;
    p.onMark = (e) => { if (e.mark.type === 'impact' && hit === null) hit = t; };
    p.triggerAttack(combo(), 0.8, 0.28);
    for (let i = 0; i < 4000 && p.attacking; i++) { p.step(1 / 240); t += 1 / 240; }
    expect(hit).toBeCloseTo(0.28, 2);
  });

  it('ПОСЛЕДНИЙ удар доигрывает до конца — то есть возвращается в стойку', () => {
    const p = mk();
    p.triggerAttack(combo(), 0.8, 0.28); p.step(0.2);
    p.triggerAttack(combo(), 0.8, 0.28);              // цепочка оборвалась: третьего свинга нет
    let t = 0;
    for (let i = 0; i < 4000 && p.attacking; i++) { p.step(1 / 240); t += 1 / 240; }
    expect(p.attacking).toBe(false);
    expect(t).toBeGreaterThan(0.3);                   // хвост (удар→стойка) отыгран, а не обрублен
  });

  it('кроссфейд: уходящий удар гаснет за XFADE и не остаётся навсегда', () => {
    const p = mk();
    p.triggerAttack(combo(), 0.8, 0.28); p.step(0.2);
    p.triggerAttack(combo(), 0.8, 0.28);
    const peek = (): unknown => (p as unknown as { fade: unknown }).fade;
    expect(peek()).toBeTruthy();
    for (let i = 0; i < 60; i++) p.step(1 / 240);     // 0.25 с > XFADE 0.12
    expect(peek()).toBeNull();
  });

  it('одиночный удар кроссфейд НЕ создаёт (нечего гасить)', () => {
    const p = mk();
    p.triggerAttack(combo(), 0.8, 0.28);
    expect((p as unknown as { fade: unknown }).fade).toBeNull();
  });
});

/**
 * ТАЗ УДАРА — СЛОЙ ВЕРХА. Клип удара может авторить перенос веса тазом; стоя это мах, ради которого всё
 * и делалось, а на бегу тот же мах ложится ПОВЕРХ боба походки и читается как рывок.
 */
describe('удар: таз не берётся из клипа на бегу', () => {
  beforeEach(() => {
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0,
    } as Storage;
  });
  afterEach(() => { delete (globalThis as unknown as { localStorage?: Storage }).localStorage; });

  /** Удар с ЯВНЫМ переносом веса тазом: 5 юнитов вперёд к середине клипа. */
  const withPelvis = (): Clip => ({
    name: 'hit_axe', character: 'warrior', weapon: 'axe', loop: false, idleEnds: true,
    keys: [
      { pose: { __hipsD: [0, 0, 0] }, t: 0 },
      { pose: { __hipsD: [0, 0, 5] }, t: 0.4 },
      { pose: { __hipsD: [0, 0, 0] }, t: 0.8 },
    ],
  });
  /** Прогнать плеер `n` кадров с заданной скоростью и вернуть мировую позицию таза. */
  function run(vel: number, clip: Clip | null, warm = 60, after = 24): THREE.Vector3 {
    const H = buildHumanoid({});
    const p = new PosePlayer(H, () => [], localStorageContent('warrior'), 'axe', { armDown: 1.35, elbowBend: 0.25 }, emptyGrid());
    p.setVel(0, vel);
    for (let i = 0; i < warm; i++) p.step(1 / 60);        // дать legMag устаканиться
    if (clip) p.triggerAttack(clip, 0.8);
    for (let i = 0; i < after; i++) p.step(1 / 60);        // ~0.4 с — середина клипа, пик переноса веса
    return H.bones.get('Hips')!.getWorldPosition(new THREE.Vector3());
  }

  it('СТОЯ мах таза остаётся — ради него всё и делалось', () => {
    const off = run(0, null), on = run(0, withPelvis());
    expect(on.distanceTo(off)).toBeGreaterThan(2);
  });

  it('НА БЕГУ таза из клипа нет: таз ровно там же, где его поставила походка', () => {
    const off = run(160, null), on = run(160, withPelvis());
    expect(on.distanceTo(off)).toBeLessThan(0.2);
  });

  it('переход монотонный: чем больше ногами владеет гейт, тем меньше таза из клипа', () => {
    // Порог не подбираем: `legMag` насыщается в 1 уже на неспешной ходьбе, поэтому от walk к бегу
    // разница не растёт, а держится на нуле — важно, что она НЕ УВЕЛИЧИВАЕТСЯ и что стоя она есть.
    const d = (v: number): number => run(v, withPelvis()).distanceTo(run(v, null));
    const stand = d(0), walk = d(40), fast = d(160);
    expect(walk).toBeLessThan(stand);
    expect(fast).toBeLessThanOrEqual(walk + 1e-6);
  });

  it('верх удара на бегу играет КАК И БЫЛ (гасится только таз)', () => {
    const armAt = (clip: Clip | null): THREE.Quaternion => {
      const H = buildHumanoid({});
      const p = new PosePlayer(H, () => [], localStorageContent('warrior'), 'axe', { armDown: 1.35, elbowBend: 0.25 }, emptyGrid());
      p.setVel(0, 160);
      for (let i = 0; i < 60; i++) p.step(1 / 60);
      if (clip) p.triggerAttack(clip, 0.8);
      for (let i = 0; i < 24; i++) p.step(1 / 60);
      return H.bones.get('RightUpperArm')!.quaternion.clone();
    };
    const c = withPelvis();
    c.keys[1]!.pose['RightUpperArm'] = [0, 0, 1.2];        // мах рукой в середине удара
    expect(armAt(c).angleTo(armAt(null))).toBeGreaterThan(0.3);
  });
});

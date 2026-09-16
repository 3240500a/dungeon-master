import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as THREE from 'three';
import { buildHumanoid } from './humanoid.js';
import { PosePlayer, localStorageContent, emptyGrid, setLocoMixOverride, type PoseContent } from './poseRuntime.js';
import { bakeGaitToClip, bakeTurnSet, GAIT_PRESETS, BAKE_MAXSPD } from './clipBake.js';
import { bakedLocoSpeed } from './locoBlend.js';
import type { Clip } from './clipModel.js';

/**
 * ⭐⭐ РЕЖИМ «ТОЛЬКО КЛИПЫ» — репетиция клиента без StepPlanner.
 *
 * Вопрос был прямой: «если стоит галка "бег/ходьба клипами", степ-планер точно отключён?» — и ответ был НЕТ.
 * Галка ставила долю клипа в 1, но планировщик по-прежнему обновлялся каждый кадр и оставался часами клипов
 * (фаза), осью ходьба↔бег, опорой стоп (флаги переноса), подтяжкой стоп к своим плантам, весами заземления и
 * подшагами на месте. Клипы были только ФОРМОЙ поверх его работы.
 *
 * Сторож устроен так, чтобы «да» нельзя было подделать: планировщик подменяется ЛОВУШКОЙ, которая падает на
 * любое обращение — чтение, вызов, запись, — и персонаж проживает целый «день»: стоит, идёт, бежит, боком,
 * спиной, наискосок, встаёт, поворачивается на месте, бьёт стоя и на бегу, меняет оружие, входит в бой.
 */
const GX = { armDown: 1.35, elbowBend: 0.25 };
const R = 0.85 * BAKE_MAXSPD, W = 0.42 * BAKE_MAXSPD;
const ARMS = ['LeftUpperArm', 'RightUpperArm', 'LeftLowerArm', 'RightLowerArm'] as const;
const HIT = { name: 'hit_test', character: 'warrior', weapon: 'none', loop: false, keys: [
  { t: 0, pose: { RightUpperArm: [0, 0, 1.2] } }, { t: 0.25, pose: { RightUpperArm: [-1.2, 0, 1.2] } }, { t: 0.5, pose: { RightUpperArm: [0, 0, 1.2] } },
] } as unknown as Clip;

let lib: Map<string, Clip>;
beforeAll(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: () => null, setItem: () => { /* */ }, removeItem: () => { /* */ }, clear: () => { /* */ }, key: () => null, length: 0,
  } as Storage;
  // Набор — ровно как кнопка редактора: 8 клипов хода + стойка + повороты на месте.
  const h = buildHumanoid({});
  const p = new PosePlayer(h, () => [], localStorageContent('warrior'), 'none', GX, emptyGrid());
  lib = new Map();
  for (const s of GAIT_PRESETS) lib.set(s.name, bakeGaitToClip(p, h, s, { character: 'warrior', weapon: 'none' }).clip);
  for (const r of bakeTurnSet(p, h, { character: 'warrior', weapon: 'none' })) lib.set(r.clip.name, r.clip);
});
afterAll(() => { delete (globalThis as unknown as { localStorage?: Storage }).localStorage; });
afterEach(() => { setLocoMixOverride(null); });

const withLib = (base: PoseContent): PoseContent => ({ ...base, locoClip: (names: readonly string[]) => { for (const n of names) { const c = lib.get(n); if (c) return c; } return null; } });
/** Стойка с руками, заведомо НЕ совпадающими с клипом: без неё ветка «рук со стойкой» не проверялась бы вовсе. */
const withStance = (base: PoseContent): PoseContent => ({ ...base, resolveUpper: () => ({ swing: 1, pose: {
  LeftUpperArm: [0.3, 0, -0.6], RightUpperArm: [0.3, 0, 0.6], LeftLowerArm: [0, -0.9, 0], RightLowerArm: [0, 0.9, 0],
} }) });

const make = (content?: PoseContent): { h: ReturnType<typeof buildHumanoid>; p: PosePlayer } => {
  const h = buildHumanoid({});
  const p = new PosePlayer(h, () => [], content ?? withLib(localStorageContent('warrior')), 'none', GX, emptyGrid());
  p.setVel(0, 0); p.setYaw(0); p.snapYaw();
  return { h, p };
};

/** Ловушка вместо планировщика: ЛЮБОЕ обращение записывается и роняет кадр. */
const trap = (p: PosePlayer): { touched: string[]; restore: () => void } => {
  const holder = p as unknown as { driver: unknown };
  const real = holder.driver, touched: string[] = [];
  const hit = (what: string): never => { touched.push(what); throw new Error(`⚠ планировщик тронут в «только клипы»: ${what}`); };
  holder.driver = new Proxy({}, {
    get: (_t, k) => hit(`чтение ${String(k)}`),
    set: (_t, k) => hit(`запись ${String(k)}`),
    has: (_t, k) => hit(`проверка ${String(k)}`),
  });
  return { touched, restore: () => { holder.driver = real; } };
};

const footW = (h: ReturnType<typeof buildHumanoid>, p: PosePlayer, leg: number): { x: number; y: number; z: number } => {
  const f = h.bones.get(leg === 0 ? 'LeftFoot' : 'RightFoot')!.getWorldPosition(new THREE.Vector3());
  return { x: f.x + p.posX, y: f.y, z: f.z + p.posZ };
};

describe('«только клипы»: планировщика нет', () => {
  it('⭐⭐ НИ ОДНОГО ОБРАЩЕНИЯ К ПЛАНИРОВЩИКУ ЗА ЦЕЛЫЙ «ДЕНЬ» — и с первого кадра он даже не создаётся', () => {
    const { p } = make();
    setLocoMixOverride(1);
    const { touched, restore } = trap(p);
    const DAY: { sec: number; at: (i: number) => void }[] = [
      { sec: 1, at: () => p.setVel(0, 0) },                                      // стоит
      { sec: 1, at: () => p.setVel(0, W) },                                      // шагом
      { sec: 1.5, at: () => p.setVel(0, R) },                                    // бегом
      { sec: 1, at: () => p.setVel(R, 0) },                                      // боком вправо
      { sec: 1, at: () => p.setVel(-R, 0) },                                     // боком влево
      { sec: 1, at: () => p.setVel(0, -W) },                                     // спиной
      { sec: 1, at: () => p.setVel(R * 0.7, R * 0.7) },                          // наискосок
      { sec: 1, at: () => p.setVel(0, 0) },                                      // встал
      { sec: 2.5, at: () => p.setYaw(Math.PI / 2) },                             // поворот на месте
      { sec: 1, at: (i) => { if (i === 0) p.triggerAttack(HIT, 0.5, 0.2); } },   // удар стоя
      { sec: 1, at: (i) => { p.setVel(0, R); if (i === 0) p.triggerAttack(HIT, 0.5, 0.2); } },   // удар на бегу
      { sec: 0.5, at: (i) => { if (i === 0) { p.setWeapon('sword'); p.setCombat(true); p.setState(true, false); } } },   // оружие, бой, стан
      { sec: 1, at: (i) => { p.setYaw(i < 30 ? Math.PI : Math.PI / 2); } },     // рывок прицела на бегу
      { sec: 1, at: () => { p.setVel(0, 0); p.snapYaw(); } },                    // телепорт-снап
    ];
    const turns = new Set<string>(), attacks = new Set<string>();
    let contactChanges = 0, prevSup = [true, true];
    for (const ph of DAY) {
      for (let i = 0; i < ph.sec * 60; i++) {
        ph.at(i);
        p.step(1 / 60);
        const sup = p.groundSupport, gw = p.groundWeights, pw = p.plantWeights;   // всё, что читает рендер игры
        if (sup[0] !== prevSup[0] || sup[1] !== prevSup[1]) contactChanges++;
        prevSup = [...sup];
        void gw; void pw;
        if (p.turnClipName) turns.add(p.turnClipName);
        if (p.attackClipName) attacks.add(p.attackClipName);
      }
    }
    restore();
    expect(touched, '⚠ планировщик тронут').toEqual([]);
    expect((p.driver as unknown as { planner: unknown }).planner, '⚠ планировщик создан').toBe(null);
    // …и день прожит по-настоящему, а не простоял: ноги переступали, поворот и удар сыграли.
    expect(contactChanges, 'ноги переступали по клипу').toBeGreaterThan(20);
    expect([...turns], 'поворот на месте сыграл клипом').toContain('turn_R_90');
    expect([...attacks]).toContain('hit_test');
  });

  it('⚠ ГАЛКУ ВКЛЮЧИЛИ НА БЕГУ — С ТОГО ЖЕ КАДРА К ПЛАНИРОВЩИКУ НИ ОДНОГО ОБРАЩЕНИЯ', () => {
    // Переход — самое уязвимое место: ноги ещё «у планировщика» (`legMag` ≈ 1 и гаснет несколько кадров), и всё,
    // что завязано на этот вес, а не на режим, продолжало бы его трогать. ⚠ Мутация «фидбэк стоп без проверки
    // режима» валит это — со старта в «только клипы» она не видна вовсе.
    for (const [vx, vz] of [[0, R], [R, 0], [0, 0]] as const) {
      const { p } = make();
      setLocoMixOverride(0);
      for (let i = 0; i < 120; i++) { p.setVel(vx, vz); p.setYaw(i < 60 ? 0 : 1); p.step(1 / 60); }
      setLocoMixOverride(1);
      const { touched, restore } = trap(p);
      for (let i = 0; i < 120; i++) { p.setVel(vx, vz); p.step(1 / 60); void p.groundSupport; void p.groundWeights; void p.plantWeights; }
      restore();
      expect(touched, `ход (${vx}, ${vz}): ⚠ планировщик тронут после включения галки`).toEqual([]);
    }
  });

  it('⭐⭐ БЕЗ НЕГО ВСЁ ЖИВОЕ: ноги переступают, опорная стопа стоит, стопа отрывается, руки машут', () => {
    // ЗАМЕР (воин, запечённый набор; планировщик — для сравнения): смена опоры в секунду 4.9 (4.8), максимальный
    // уход опорной стопы 0 (0.66), подъём стопы 12.7 (10.8), размах плеча 63° (64°); боком: уход 0.46 (0.76).
    for (const [name, vx, vz, slideMax] of [['бег вперёд', 0, R, 0.3], ['бег спиной', 0, -R, 0.3], ['бег боком', R, 0, 1]] as const) {
      for (const content of [withLib(localStorageContent('warrior')), withStance(withLib(localStorageContent('warrior')))]) {
        const { h, p } = make(content);
        setLocoMixOverride(1);
        const { touched, restore } = trap(p);
        const lock: ({ x: number; z: number } | null)[] = [null, null];
        let changes = 0, slide = 0, prevSup = [true, true];
        const yMin = [1e9, 1e9], yMax = [-1e9, -1e9];
        let armMin = 1e9, armMax = -1e9;
        for (let i = 0; i < 240; i++) {
          p.setVel(vx, vz); p.step(1 / 60);
          h.root.updateMatrixWorld(true);
          if (i < 120) continue;
          const sup = p.groundSupport;
          if (sup[0] !== prevSup[0] || sup[1] !== prevSup[1]) changes++;
          prevSup = [...sup];
          for (let leg = 0; leg < 2; leg++) {
            const f = footW(h, p, leg);
            yMin[leg] = Math.min(yMin[leg]!, f.y); yMax[leg] = Math.max(yMax[leg]!, f.y);
            if (!sup[leg]) { lock[leg] = null; continue; }
            lock[leg] ??= { x: f.x, z: f.z };
            slide = Math.max(slide, Math.hypot(f.x - lock[leg]!.x, f.z - lock[leg]!.z));
          }
          const a = h.bones.get('RightUpperArm')!.rotation.x;               // мах вперёд-назад — вокруг X плеча
          armMin = Math.min(armMin, a); armMax = Math.max(armMax, a);
        }
        restore();
        expect(touched, `${name}: ⚠ планировщик тронут`).toEqual([]);
        expect(changes, `${name}: опора меняется (ноги переступают)`).toBeGreaterThanOrEqual(7);
        expect(slide, `${name}: ⚠ опорная стопа уехала на ${slide.toFixed(2)}`).toBeLessThan(slideMax);
        expect(Math.max(yMax[0]! - yMin[0]!, yMax[1]! - yMin[1]!), `${name}: стопа отрывается`).toBeGreaterThan(5);
        const armDeg = (armMax - armMin) * 180 / Math.PI;
        expect(armDeg, `${name}: ⚠ руки не машут (размах ${armDeg.toFixed(1)}°)`).toBeGreaterThan(20);
      }
    }
  });

  it('⚠ ЧАСЫ КЛИПА ИДУТ В ТАКТ ЗАПЕКАНИЮ: темп шагов — как у планировщика, с которого клип снят', () => {
    // Часы «только клипы» — пройденный путь, делённый на длину цикла (скорость запекания × период). Скорости
    // запекания — одна правда (`bakedLocoSpeed`), и её сверяем с пресетами запекателя…
    for (const s of GAIT_PRESETS) {
      if (s.name === 'idle') continue;
      expect(bakedLocoSpeed(s.name), `${s.name}: ⚠ запекатель и часы разошлись в скорости`).toBeCloseTo(Math.hypot(s.vx, s.vz) * BAKE_MAXSPD, 6);
    }
    // …а сами часы — по темпу смены опоры против живого планировщика на том же ходу.
    // ЗАМЕР: бег 4.91 против 4.82 раз/с. ⚠ Мутация «длина цикла ×1.3» даёт 3.8 и валит это.
    const rate = (mix: number, spd: number): number => {
      const { p } = make();
      setLocoMixOverride(mix);
      let n = 0, prev = [true, true];
      for (let i = 0; i < 480; i++) {
        p.setVel(0, spd); p.step(1 / 60);
        const s = p.groundSupport;
        if (i >= 120 && (s[0] !== prev[0] || s[1] !== prev[1])) n++;
        prev = [...s];
      }
      return n / 6;
    };
    for (const spd of [W, R]) {
      const clip = rate(1, spd), planner = rate(0, spd);
      expect(Math.abs(clip - planner) / planner, `${spd === R ? 'бег' : 'шаг'}: смена опоры ${clip.toFixed(2)} против ${planner.toFixed(2)} раз/с у планировщика`).toBeLessThan(0.1);
    }
  });

  it('⚠ СТАРТ С МЕСТА: опорная стопа не едет за разгоном клипа', () => {
    // ⚠ Мутация «вес фиксации = доля клипа» валит это: доля растёт четверть секунды, и стопа, державшаяся ею,
    // ехала за позой — 2.62 ед (сейчас 0.17; у планировщика 0.54).
    const { h, p } = make();
    setLocoMixOverride(1);
    const lock: ({ x: number; z: number } | null)[] = [null, null];
    let slide = 0;
    for (let i = 0; i < 90; i++) {
      p.setVel(0, i < 60 ? 0 : R); p.step(1 / 60);
      h.root.updateMatrixWorld(true);
      if (i < 60) continue;
      const sup = p.groundSupport;
      for (let leg = 0; leg < 2; leg++) {
        const f = footW(h, p, leg);
        if (!sup[leg]) { lock[leg] = null; continue; }
        lock[leg] ??= { x: f.x, z: f.z };
        slide = Math.max(slide, Math.hypot(f.x - lock[leg]!.x, f.z - lock[leg]!.z));
      }
    }
    expect(slide, `⚠ опорная стопа уехала на ${slide.toFixed(2)} за разгон`).toBeLessThan(0.5);
  });

  it('⚠ ОСТАНОВКА: руки не щёлкают со взмаха в покой — ни без стойки, ни со стойкой', () => {
    // ЗАМЕР жалобы (без стойки): рука висела на взмахе, пока доля клипа гасла, и через 0.23 с щёлкала в покой —
    // 40.9° за кадр. Сейчас 4.2° с бега и 2.3° с шага. ⚠ Мутации «вес рук — мгновенная скорость» и «без стойки
    // рука целиком из клипа» валят это.
    for (const content of [withLib(localStorageContent('warrior')), withStance(withLib(localStorageContent('warrior')))]) {
      for (const spd of [R, W]) {
        const { h, p } = make(content);
        setLocoMixOverride(1);
        let prev: THREE.Quaternion[] | null = null, jump = 0;
        for (let i = 0; i < 240; i++) {
          p.setVel(0, i < 180 ? spd : 0); p.step(1 / 60);
          const cur = ARMS.map((b) => h.bones.get(b)!.quaternion.clone());
          if (prev && i >= 175) for (let k = 0; k < cur.length; k++) jump = Math.max(jump, cur[k]!.angleTo(prev[k]!) * 180 / Math.PI);
          prev = cur;
        }
        expect(jump, `⚠ рука прыгнула на ${jump.toFixed(1)}° за кадр (${spd === R ? 'бег' : 'шаг'}, ${content.resolveUpper('none') ? 'стойка' : 'без стойки'})`).toBeLessThan(10);
      }
    }
  });

  it('⚠ КЛИП БЕЗ КАНАЛОВ РУК РУКИ НЕ ТРОГАЕТ: на бегу они такие же, как стоя (а не в Т-позе)', () => {
    // Импортированный пак часто несёт только ноги. ⚠ Мутация «нет кости в клипе → ноль» валит это: рука уходила
    // в нулевой поворот, то есть в Т-позу.
    const noArms: PoseContent = withLib(localStorageContent('warrior'));
    const strip = (c: Clip): Clip => ({ ...c, keys: c.keys.map((k) => {
      const pose = { ...k.pose };
      for (const b of [...ARMS, 'LeftShoulder', 'RightShoulder', 'LeftHand', 'RightHand']) delete pose[b];
      return { ...k, pose };
    }) });
    const stripped = { ...noArms, locoClip: (names: readonly string[], w: string) => { const c = noArms.locoClip!(names, w); return c ? strip(c) : null; } };
    for (const content of [stripped, withStance(stripped)]) {
      const { h, p } = make(content);
      setLocoMixOverride(1);
      for (let i = 0; i < 60; i++) p.step(1 / 60);
      const still = ARMS.map((b) => h.bones.get(b)!.quaternion.clone());
      p.setVel(0, R);
      for (let i = 0; i < 120; i++) p.step(1 / 60);
      for (let k = 0; k < ARMS.length; k++) {
        const d = h.bones.get(ARMS[k]!)!.quaternion.angleTo(still[k]!) * 180 / Math.PI;
        expect(d, `${ARMS[k]} (${content.resolveUpper('none') ? 'стойка' : 'без стойки'}): ⚠ ушла на ${d.toFixed(1)}° от позы стоя`).toBeLessThan(1);
      }
    }
  });

  it('⭐ ГАЛКУ СНЯЛИ — ПЛАНИРОВЩИК ПРИНИМАЕТ НОГИ ЗАНОВО: без лишних подшагов и без рывка позы', () => {
    // Стоял в планировщике → включил «только клипы» → повернулся клипом на 90° → выключил. Планты планировщика
    // остались на СТАРОМ курсе. ⚠ Мутация «не пересаживать стопы при возврате» валит это: 2 подшага поверх
    // уже законченного поворота (сейчас 0).
    const { h, p } = make();
    setLocoMixOverride(0);
    for (let i = 0; i < 120; i++) p.step(1 / 60);
    setLocoMixOverride(1);
    p.setYaw(Math.PI / 2);
    for (let i = 0; i < 180; i++) p.step(1 / 60);
    expect(p.turnClipName, 'поворот доигран').toBe(null);
    setLocoMixOverride(0);
    const names = [...h.bones.keys()];
    let steps = 0, prevSw = [...p.driver.swingLegs], jump = 0;
    let prev = names.map((b) => h.bones.get(b)!.quaternion.clone());
    for (let i = 0; i < 120; i++) {
      p.step(1 / 60);
      const sw = p.driver.swingLegs;
      for (let leg = 0; leg < 2; leg++) if (sw[leg] && !prevSw[leg]) steps++;
      prevSw = [...sw];
      const cur = names.map((b) => h.bones.get(b)!.quaternion.clone());
      for (let k = 0; k < cur.length; k++) jump = Math.max(jump, cur[k]!.angleTo(prev[k]!) * 180 / Math.PI);
      prev = cur;
    }
    expect(steps, '⚠ планировщик шагнул поверх законченного поворота').toBe(0);
    expect(jump, `⚠ поза прыгнула на ${jump.toFixed(1)}° на смене режима`).toBeLessThan(12);
    // И на ходу: туда и обратно на бегу — планировщик снова шагает.
    const { p: q } = make();
    setLocoMixOverride(0);
    let qSteps = 0, qPrev = [false, false];
    for (let i = 0; i < 480; i++) {
      if (i === 120) setLocoMixOverride(1);
      if (i === 360) setLocoMixOverride(0);
      q.setVel(0, R); q.step(1 / 60);
      if (i < 360) continue;
      const sw = q.driver.swingLegs;
      for (let leg = 0; leg < 2; leg++) if (sw[leg] && !qPrev[leg]) qSteps++;
      qPrev = [...sw];
    }
    expect(qSteps, 'после возврата планировщик снова шагает').toBeGreaterThan(4);
  });
});

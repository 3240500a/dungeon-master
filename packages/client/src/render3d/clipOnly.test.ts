import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { buildHumanoid } from './humanoid.js';
import { PosePlayer, localStorageContent, emptyGrid, setLocoMixOverride, type PoseContent } from './poseRuntime.js';
import { bakeGaitToClip, bakeTurnSet, GAIT_PRESETS, BAKE_MAXSPD } from './clipBake.js';
import { bakedLocoSpeed, locoRunWeight, LOCO_BAKE_WALK_SPD, LOCO_BAKE_RUN_SPD, LOCO_RUN_FULL_SPD } from './locoBlend.js';
import { clipDur, type Clip } from './clipModel.js';
import { GAIT } from './gaitKnobs.js';
import { SWING_KEY } from './turnInPlace.js';
import { LOCO_BAKE_REV } from './poseRuntime.js';

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
/** Скорости запекания набора (40 / 120 u/с) и игровая скорость воина, с которой бег весит 100 % (80 u/с). */
const R = LOCO_BAKE_RUN_SPD, W = LOCO_BAKE_WALK_SPD, GAME = LOCO_RUN_FULL_SPD;
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

const libContent = (l: Map<string, Clip>): PoseContent =>
  ({ ...localStorageContent('warrior'), locoClip: (names: readonly string[]) => { for (const n of names) { const c = l.get(n); if (c) return c; } return null; } });

/** Доля кадров, в которых нога считается опорной (обе ноги, после разогрева). */
const share = (l: Map<string, Clip>, spd: number): number => {
  const h = buildHumanoid({});
  const p = new PosePlayer(h, () => [], libContent(l), 'none', GX, emptyGrid());
  p.setVel(0, 0); p.setYaw(0); p.snapYaw();
  setLocoMixOverride(1);
  let on = 0, n = 0;
  for (let i = 0; i < 1320; i++) {
    p.setVel(0, spd); p.step(1 / 60);
    if (i < 120) continue;
    const s = p.groundSupport;
    on += (s[0] ? 1 : 0) + (s[1] ? 1 : 0); n += 2;
  }
  return on / n;
};
/** Библиотека БЕЗ канала опоры — ветка фолбэка (импортные клипы и снятые до ревизии 3). */
const noSwing = (l: Map<string, Clip>): Map<string, Clip> => new Map([...l].map(([k, c]) => [k, { ...c,
  keys: c.keys.map((f) => { const pose = { ...f.pose }; delete pose[SWING_KEY]; return { ...f, pose }; }) }]));
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

  it('⭐⭐ ИГРА ХОДИТ ТОЛЬКО КЛИПАМИ: перекрытие ставится безусловно, галки «бег клипами» в настройках клиента нет', () => {
    // Решение автора (19.09): «степ-планер из игры убираем полностью… остаётся только в поз-редакторе». `online3d` не
    // собирается в node (рендерер, DOM), поэтому проводка стережётся по исходнику — как у остальных швов редактора.
    const src = (f: string): string => readFileSync(path.join(__dirname, f), 'utf8');
    const game = src('online3d.ts');
    expect(game, '⚠ игра обязана включать «только клипы» сама, а не по галке').toMatch(/^\s*setLocoMixOverride\(1\);/m);
    expect(game, '⚠ перекрытие снова зависит от настройки игрока').not.toMatch(/setLocoMixOverride\((?!1\))/);
    expect(game).not.toContain('onLocoClips');
    const settings = src('settings3d.ts');
    expect(settings, '⚠ галка «бег клипами (иначе StepPlanner)» вернулась в настройки клиента').not.toContain('onLocoClips');
    expect(settings).not.toMatch(/type = 'checkbox'[^\n]*loco/i);
  });

  it('⭐⭐ КУКЛА БЕЗ ЗАПЕЧЁННОГО НАБОРА НЕ ЕДЕТ СТОЛБОМ: «только клипы» требует набор, иначе ноги ведёт планировщик', () => {
    // Игра просит «только клипы» у ВСЕХ кукол разом. Раньше режим включался по одному лишь перекрытию: планировщик
    // выключен, клипа нет — персонаж скользил по полу в позе стоя (ЗАМЕР ниже: подъём стопы 0).
    const lift = (content: PoseContent): number => {
      const h = buildHumanoid({});
      const p = new PosePlayer(h, () => [], content, 'none', GX, emptyGrid());
      p.setVel(0, R); p.setYaw(0); p.snapYaw();
      setLocoMixOverride(1);
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < 240; i++) { p.step(1 / 60); if (i >= 120) { const y = footW(h, p, 0).y; lo = Math.min(lo, y); hi = Math.max(hi, y); } }
      return hi - lo;
    };
    const none = localStorageContent('warrior');   // localStorage пуст — клипов нет вовсе
    expect(none.locoClip!(['run_fwd'], 'none')).toBe(null);
    expect(lift(none), '⚠ СТОЛБ: набора нет, а планировщик выключен — ноги не идут').toBeGreaterThan(3);
    expect(lift(withLib(none)), 'с набором ноги ведёт клип').toBeGreaterThan(3);
    // …и с набором планировщик по-прежнему не создаётся вовсе (первый сторож файла), а без него — работает он.
    const h = buildHumanoid({}); const p = new PosePlayer(h, () => [], none, 'none', GX, emptyGrid());
    setLocoMixOverride(1); p.setVel(0, R); p.step(1 / 60);
    expect((p.driver as unknown as { planner: unknown }).planner, 'без набора ноги обязан вести планировщик').not.toBe(null);
  });

  it('⭐ МОНСТР БЕЗ СВОИХ КЛИПОВ ХОДИТ НАБОРОМ ПЕРСОНАЖА-ФОЛБЭКА — и тоже без планировщика', () => {
    // Игра собирает монстров как `localStorageContent(<фракция>, 'warrior')`: своих клипов у фракций нет.
    const was = globalThis.localStorage;
    const clips = [...lib.values()];
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => (k === 'pe_clips' ? JSON.stringify(clips) : null), setItem: () => { /* */ }, removeItem: () => { /* */ }, clear: () => { /* */ }, key: () => null, length: 0,
    } as unknown as Storage;
    try {
      const content = localStorageContent('mon_undead', 'warrior');
      expect(content.locoClip!(['run_fwd'], 'axe')?.character, 'набор воина найден через фолбэк — под любым оружием').toBe('warrior');
      const h = buildHumanoid({});
      const p = new PosePlayer(h, () => [], content, 'axe', GX, emptyGrid());
      p.setVel(0, 0); p.setYaw(0); p.snapYaw();
      setLocoMixOverride(1);
      const { touched, restore } = trap(p);
      let lo = Infinity, hi = -Infinity;
      for (const [vx, vz] of [[0, 0], [0, W], [0, R], [R, 0], [0, 0]] as const) {
        p.setVel(vx, vz);
        for (let i = 0; i < 60; i++) { p.step(1 / 60); if (vz === R) { const y = footW(h, p, 0).y; lo = Math.min(lo, y); hi = Math.max(hi, y); } }
      }
      restore();
      expect(touched, '⚠ планировщик тронут у монстра').toEqual([]);
      expect(hi - lo, 'ноги монстра идут по клипу').toBeGreaterThan(3);
    } finally { (globalThis as unknown as { localStorage: Storage }).localStorage = was; }
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
    // ⭐ ИГРОВЫЕ 80 u/с: бег, снятый на 120, играет на 100 % веса в темпе 80/120 (смен опоры за эти 2 с — 9 против 12 на
    // 120, поэтому порог ниже). ЗАМЕР ухода опорной стопы с фиксацией на 80: вперёд / спиной / боком 0 / 0 / 0; без
    // фиксации (сама поза клипа за окно опоры, отдельный зонд) 1.22 / 1.17 / 1.50 — как на своей скорости 120.
    // ⚠ Темп эта мерка НЕ ловит: фиксация прижимает стопу при любом темпе (мутация «цикл = текущая скорость × период» —
    // здесь 0). Темп стережёт сверка цикла ниже, долю опоры — тест доли опоры.
    for (const [name, vx, vz, slideMax, minChanges] of [
      ['бег вперёд', 0, R, 0.3, 7], ['бег спиной', 0, -R, 0.3, 7], ['бег боком', R, 0, 1, 7],
      ['бег вперёд на 80', 0, GAME, 0.3, 6], ['бег спиной на 80', 0, -GAME, 0.3, 6], ['бег боком на 80', GAME, 0, 1, 6],
    ] as const) {
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
        expect(changes, `${name}: опора меняется (ноги переступают)`).toBeGreaterThanOrEqual(minChanges);
        expect(slide, `${name}: ⚠ опорная стопа уехала на ${slide.toFixed(2)}`).toBeLessThan(slideMax);
        expect(Math.max(yMax[0]! - yMin[0]!, yMax[1]! - yMin[1]!), `${name}: стопа отрывается`).toBeGreaterThan(5);
        const armDeg = (armMax - armMin) * 180 / Math.PI;
        expect(armDeg, `${name}: ⚠ руки не машут (размах ${armDeg.toFixed(1)}°)`).toBeGreaterThan(20);
      }
    }
  });

  it('⚠ ЧАСЫ КЛИПА ИДУТ В ТАКТ ЗАПЕКАНИЮ: темп шагов — как у планировщика, с которого клип снят', () => {
    // Часы «только клипы» — пройденный путь, делённый на длину цикла (скорость запекания × период). Скорость
    // запекания клип ПОМНИТ сам (`bakeSpeed`, пишет запекатель), и часы читают именно её (`bakedLocoSpeed`)…
    for (const s of GAIT_PRESETS) {
      const c = lib.get(s.name)!;
      if (s.name === 'idle') { expect(c.bakeSpeed, 'стойка скорости не несёт').toBeUndefined(); continue; }
      expect(c.bakeSpeed, `${s.name}: ⚠ клип не запомнил скорость запекания`).toBeCloseTo(Math.hypot(s.vx, s.vz) * BAKE_MAXSPD, 6);
      expect(bakedLocoSpeed(c), `${s.name}: ⚠ запекатель и часы разошлись в скорости`).toBe(c.bakeSpeed);
    }
    // …а сами часы — по темпу смены опоры против живого планировщика на том же ходу. Сверка — на СКОРОСТЯХ ЗАПЕКАНИЯ
    // (40 / 120): только там клип обязан идти в темпе планировщика; на 80 бег нарочно медленнее (см. тест ниже).
    // ЗАМЕР (набор 40 / 120): шаг 2.33 против 2.33, бег 5.50 против 5.50 раза/с. ⚠ Мутация «длина цикла ×1.3» валит это.
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

  /**
   * СТАРЫЙ НАБОР — как снимали до 17.09: 0.42 / 0.85 от 120 (50.4 / 102 u/с) и БЕЗ поля `bakeSpeed`. Строится лениво:
   * нужен двум тестам, а съём восьми клипов — треть секунды.
   */
  let oldSet: Map<string, Clip> | null = null;
  const oldLib = (): Map<string, Clip> => {
    if (oldSet) return oldSet;
    const h = buildHumanoid({});
    const p = new PosePlayer(h, () => [], localStorageContent('warrior'), 'none', GX, emptyGrid());
    oldSet = new Map();
    for (const s of GAIT_PRESETS) {
      if (s.name === 'idle') continue;
      const k = (/^run_/.test(s.name) ? 0.85 : 0.42) / Math.hypot(s.vx, s.vz);
      const c = bakeGaitToClip(p, h, { ...s, vx: s.vx * k, vz: s.vz * k }, { character: 'warrior', weapon: 'none' }).clip;
      delete c.bakeSpeed;
      oldSet.set(s.name, c);
    }
    return oldSet;
  };

  /** Длина цикла клипа на ходу, u: пройденный путь на один оборот фазы часов «только клипы». */
  const cycleAt = (l: Map<string, Clip>, vx: number, vz: number): number => {
    const { p } = make(libContent(l));
    setLocoMixOverride(1);
    const phase = (): number => (p as unknown as { clipPhase: number }).clipPhase;
    for (let i = 0; i < 120; i++) { p.setVel(vx, vz); p.step(1 / 60); }   // доля клипа и ворота по движению — на единице
    const ph0 = phase();
    let path = 0;
    for (let i = 0; i < 240; i++) { p.setVel(vx, vz); p.step(1 / 60); path += Math.hypot(vx, vz) / 60; }
    return path * 2 * Math.PI / (phase() - ph0);
  };

  it('⭐⭐ ВЕС БЕГА ПО СКОРОСТИ: 0 до 40, половина на 60, целиком с 80 u/с — и цикл клипа смешан тем же весом', () => {
    // Решение автора: набор снят на 40 / 120, а в игре бег играет на 100 % уже с 80. Цикл — смесь «скорость запекания ×
    // период» теми же весами, что поза. ЗАМЕР (набор умолчаний): 70.00 u шагом (40 × 1.75 с), 88.00 u бегом (120 × 0.733 с),
    // на 60 — 79.00. ⚠ Мутация «ось планировщика 40…115» (было до 17.09) даёт на 80 цикл 79.6 вместо 88 и валит это.
    expect(locoRunWeight(W)).toBe(0);
    expect(locoRunWeight(60)).toBeCloseTo(0.5, 12);
    expect(locoRunWeight(GAME)).toBe(1);
    const walk = lib.get('walk_fwd')!, run = lib.get('run_fwd')!;
    const cw = bakedLocoSpeed(walk) * clipDur(walk), cr = bakedLocoSpeed(run) * clipDur(run);
    for (const spd of [32, W, 60, GAME, 100, R, 130]) {
      const want = cw + (cr - cw) * locoRunWeight(spd), got = cycleAt(lib, 0, spd);
      expect(Math.abs(got - want) / want, `${spd} u/с: цикл ${got.toFixed(2)} u, ждали ${want.toFixed(2)} (вес бега ${locoRunWeight(spd).toFixed(2)})`).toBeLessThan(1e-3);
    }
  });

  it('⭐⭐ НА 80 u/с БЕГ, СНЯТЫЙ НА 120, ИГРАЕТ МЕДЛЕННЕЕ: цикл = 120 × период, темп 80/120', () => {
    const run = lib.get('run_fwd')!;
    expect(run.bakeSpeed).toBe(R);
    const got = cycleAt(lib, 0, GAME);
    expect(Math.abs(got - R * clipDur(run)), `цикл ${got.toFixed(3)} u против ${(R * clipDur(run)).toFixed(3)}`).toBeLessThan(1e-3 * got);
    // Тот же вывод снаружи — по темпу смены опоры: на 80 ровно 2/3 темпа на 120, клип тот же.
    const rate = (spd: number): number => {
      const { p } = make();
      setLocoMixOverride(1);
      let n = 0, prev = [true, true];
      for (let i = 0; i < 1320; i++) {
        p.setVel(0, spd); p.step(1 / 60);
        const s = p.groundSupport;
        if (i >= 120 && (s[0] !== prev[0] || s[1] !== prev[1])) n++;
        prev = [...s];
      }
      return n / 20;
    };
    const slow = rate(GAME), fast = rate(R);
    expect(Math.abs(slow / fast - GAME / R), `смена опоры ${slow.toFixed(2)} на 80 против ${fast.toFixed(2)} на 120`).toBeLessThan(0.04);
  });

  it('⚠ ЦИКЛ СМЕШАН ВЕСАМИ КОЛОНОК: боком — цикл страйфа, спиной — цикл хода спиной, наискосок — их доли', () => {
    // Сверки выше — только ВПЕРЁД, а на умолчаниях у всех колонок один период (88 u бегом, 70 u шагом), и перепутанные веса
    // колонок в часах не видны вовсе. У автора колонки разные (`pe_gait` 17.09: спиной stepWalk 18.5 против 25; опубл.
    // walk_back 1.082 с, walk_strafe_L 0.966 с, walk_fwd 1.119 с). Поэтому периоды разводим: спиной ×1.3, вправо ×0.8,
    // влево ×0.9 (стороны разные — чтобы ловилась и путаница Л/П). ЗАМЕР (вправо = +x): вперёд 88.00, вправо 70.40, влево 79.20, спиной
    // 114.39, на 80 те же; шагом вправо 56.00, спиной 91.00; наискосок 45° — 79.20 (пополам с «вперёд»), 135° — 92.40
    // (пополам страйф и спиной). ⚠ Мутация «веса страйфа и спины в часах перепутаны» проходила ВСЕ прежние тесты; здесь
    // боком даёт 114.39, спиной 70.40.
    const scale = (c: Clip, k: number): Clip => ({ ...c, keys: c.keys.map((key) => ({ ...key, t: key.t * k })) });
    const dl = new Map<string, Clip>();
    for (const [n, c] of lib) dl.set(n, scale(c, /_back$/.test(n) ? 1.3 : /_strafe_R$/.test(n) ? 0.8 : /_strafe_L$/.test(n) ? 0.9 : 1));
    const cyc = (n: string): number => bakedLocoSpeed(dl.get(n)!) * clipDur(dl.get(n)!);
    for (const [name, vx, vz, want] of [
      ['бег боком вправо', R, 0, cyc('run_strafe_R')], ['бег боком влево', -R, 0, cyc('run_strafe_L')], ['бег спиной', 0, -R, cyc('run_back')],
      ['боком на 80', GAME, 0, cyc('run_strafe_R')], ['спиной на 80', 0, -GAME, cyc('run_back')],
      ['шаг боком', W, 0, cyc('walk_strafe_R')], ['шаг спиной', 0, -W, cyc('walk_back')],
      ['наискосок 45°', 85, 85, (cyc('run_fwd') + cyc('run_strafe_R')) / 2], ['наискосок 135°', 85, -85, (cyc('run_strafe_R') + cyc('run_back')) / 2],
    ] as const) {
      const got = cycleAt(dl, vx, vz);
      expect(Math.abs(got - want) / want, `${name}: цикл ${got.toFixed(2)} u, ждали ${want.toFixed(2)}`).toBeLessThan(2e-3);
    }
  });

  it('⚠ СТАРЫЙ КЛИП БЕЗ `bakeSpeed` ИДЁТ СВОИМ ТЕМПОМ: 50.4 / 102 по имени, стопа не едет', () => {
    // Клипы, снятые до 17.09, поля не несут, а сняты на 0.42 / 0.85 от 120. До перезапекания они обязаны играть в
    // своём темпе: читай их новыми 40 / 120 — длина цикла ходьбы −21 %, бега +18 %, и стопы поехали бы.
    const old = oldLib();
    expect(bakedLocoSpeed(old.get('walk_fwd')!)).toBeCloseTo(50.4, 9);
    expect(bakedLocoSpeed(old.get('run_strafe_L')!)).toBeCloseTo(102, 9);
    // 102 ≥ 80 — играет чистый старый бег, и цикл обязан быть 102 × его период (а не 120 ×).
    const run = old.get('run_fwd')!, got = cycleAt(old, 0, 102);
    expect(Math.abs(got - 102 * clipDur(run)), `цикл ${got.toFixed(2)} u против ${(102 * clipDur(run)).toFixed(2)}`).toBeLessThan(1e-3 * got);
    // И опорная стопа старого набора на игровых 80 (та же мерка, что выше: уход за время опоры, с фиксацией).
    for (const [vx, vz, max] of [[0, GAME, 0.3], [GAME, 0, 1]] as const) {
      const { h: hh, p: pp } = make(libContent(old));
      setLocoMixOverride(1);
      const lock: ({ x: number; z: number } | null)[] = [null, null];
      let slide = 0;
      for (let i = 0; i < 360; i++) {
        pp.setVel(vx, vz); pp.step(1 / 60);
        hh.root.updateMatrixWorld(true);
        if (i < 120) continue;
        const sup = pp.groundSupport;
        for (let leg = 0; leg < 2; leg++) {
          const f = footW(hh, pp, leg);
          if (!sup[leg]) { lock[leg] = null; continue; }
          lock[leg] ??= { x: f.x, z: f.z };
          slide = Math.max(slide, Math.hypot(f.x - lock[leg]!.x, f.z - lock[leg]!.z));
        }
      }
      expect(slide, `старый набор (${vx}, ${vz}): ⚠ опорная стопа уехала на ${slide.toFixed(2)}`).toBeLessThan(max);
    }
  });

  it('⚠ ДОЛЯ ОПОРЫ — ТА, С КОТОРОЙ КЛИП СНЯТ, а не та, что у планировщика на текущей скорости', () => {
    // Клипы хода без канала `__swing`: опору дают окна по фазе шириной в долю опоры. Доля — смесь долей, с которыми сняты
    // клипы (ось планировщика на СКОРОСТИ ЗАПЕКАНИЯ), теми же весами, что поза. Чистый набор на 80 — ровно dutyRun, на 60 —
    // середина; старый бег (102, sb 0.827) на 80 — свою 0.224. ⚠ Мутация «доля по текущей скорости» (как было) даёт на 80
    // 0.259 и валит это; «голый lerp по весу бега» на старом наборе даёт 0.202 и валит последнюю строку. ЗАМЕР: 0.198 / 0.273 / 0.226.
    const G = GAIT;
    const plSb = (v: number): number => Math.min(1, Math.max(0, (v - G.speedWalk) / (G.speedRun - G.speedWalk)));
    const lerpD = (sb: number): number => G.dutyWalk + (G.dutyRun - G.dutyWalk) * sb;
    // ⚠ ЭТО ВЕТКА ФОЛБЭКА. С 19.09 запекатель пишет в клипы хода КАНАЛ ОПОРЫ `__swing` (ревизия 3), и окна по доле
    // больше не угадываются — они остались только для клипов БЕЗ канала: импортных и снятых раньше. Поэтому здесь
    // канал снимается явно, а то, что канал ГЛАВНЕЕ доли, проверяет случай ниже.
    for (const [name, l, spd, want] of [
      ['чистый набор, 80', noSwing(lib), GAME, lerpD(1)],
      ['чистый набор, 60', noSwing(lib), 60, lerpD(0.5)],
      ['старый набор, 80', noSwing(oldLib()), GAME, lerpD(plSb(102))],
    ] as const) {
      const got = share(l, spd);
      expect(Math.abs(got - want), `${name}: доля опоры ${got.toFixed(3)}, клипы сняты с ${want.toFixed(3)}`).toBeLessThan(0.012);
    }
  });

  it('⭐⭐ КАНАЛ ОПОРЫ В КЛИПЕ ГЛАВНЕЕ ДОЛИ: опора идёт из `__swing`, а не из настройки `dutyRun`', () => {
    // До 19.09 окно опоры на ходу ВЫВОДИЛОСЬ из `dutyWalk/dutyRun` — то есть из настройки, которую автор с тех пор
    // мог сдвинуть, а клип остался прежним. ЗАМЕР беды: щелчок голеностопа боком и спиной 43.6° / 42.9° ЗА КАДР,
    // ровно на кадре подъёма флага, когда стопа висит в 4.8–5.0 ед над полом. В индустрии это Sync Markers:
    // разметка едет В КЛИПЕ. Проверяем ровно это: сдвинутая настройка доли опору БОЛЬШЕ НЕ ДВИГАЕТ.
    const c = lib.get('run_fwd')!;
    expect(c.keys.some((k) => k.pose[SWING_KEY]), 'запекатель обязан писать канал опоры в клипы хода').toBe(true);
    expect(c.bakeRev, 'и помечать этим ревизию').toBe(LOCO_BAKE_REV);
    const was = GAIT.dutyRun;
    try {
      const a = share(lib, GAME);
      GAIT.dutyRun = Math.min(0.45, was + 0.2);            // грубо сдвигаем настройку
      const b = share(lib, GAME);
      expect(Math.abs(b - a), '⚠ доля опоры поехала за настройкой — значит канал не читается').toBeLessThan(0.005);
    } finally { GAIT.dutyRun = was; }
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

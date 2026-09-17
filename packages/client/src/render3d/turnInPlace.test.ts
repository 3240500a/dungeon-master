import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { buildHumanoid } from './humanoid.js';
import { PosePlayer, localStorageContent, emptyGrid, setLocoMixOverride, type PoseContent } from './poseRuntime.js';
import { GAIT } from './pose.js';
import { bakeGaitToClip, bakeTurnSet, GAIT_PRESETS, TURN_PRESETS, BAKE_MAXSPD } from './clipBake.js';
import { clipDur, clipPoseAt, hipsOffset, setHipsOffset, type Clip } from './clipModel.js';
import { pickTurn, turnClipName, turnSupportAt, turnYawAt, shouldCommitTurn, TURN_NAMES, SWING_KEY, TURN_SETTLE_SEC, TURN_URGENT_SEC } from './turnInPlace.js';

/**
 * ⭐⭐ ПОВОРОТ НА МЕСТЕ: «стоишь и поворачиваешься — подшагов нет».
 *
 * ЗАМЕР причины: планировщик шаги ДЕЛАЛ (45° → 2, 90° → 3, 180° → 6), но при локомоции клипами слой бега
 * накрывал ноги и стоя — застывшим кадром ходьбы, — и стопа не отрывалась от пола вовсе: подъём 0.00
 * против 6.5 у планировщика. Отсюда два требования, и оба стерегутся здесь:
 *  1. без запечённых поворотов подшаги планировщика ВИДНЫ и при клипах (ворота слоя бега по движению);
 *  2. с запечёнными поворотами играет клип нужной величины и сам ведёт таз (Turn In Place, как в Lyra).
 */
const GX = { armDown: 1.35, elbowBend: 0.25 };
const rad = (d: number): number => d * Math.PI / 180;

describe('выбор поворота', () => {
  const all = (): boolean => true;

  it('⭐ величина — БЛИЖАЙШАЯ к остатку (а не наибольшая «до которой дорос»)', () => {
    // ⚠ ЗДЕСЬ БЫЛО ДРУГОЕ ПРАВИЛО — «наибольший, до которого дорос, с запасом 10°». При нём 70° давали
    // 45° и следом ещё один поворот. Мутация «вернуть правило наибольшего» валит случай 70°.
    expect(pickTurn(rad(30), all), 'меньше наименьшего доворота — стоим, крутится верх').toBe(null);
    expect(pickTurn(rad(36), all)?.name).toBe('turn_R_45');
    expect(pickTurn(rad(60), all)?.deg, '60° ближе к 45').toBe(45);
    expect(pickTurn(rad(70), all)?.deg, '⚠ 70° ближе к 90 — одним поворотом, а не 45 и ещё раз').toBe(90);
    expect(pickTurn(rad(-85), all)?.name, 'знак — сторона').toBe('turn_L_90');
    expect(pickTurn(rad(140), all)?.deg, '140° ближе к 180').toBe(180);
    expect(pickTurn(rad(135), all)?.deg, 'ровно посередине — больший: меньше повторных подходов').toBe(180);
  });

  it('⭐⭐ РЕШАЕМ ПО ИТОГУ ДВИЖЕНИЯ ПРИЦЕЛА, а не по первому кадру', () => {
    // ⚠ Жалоба «сразу начинает на 45° и поворачивает за несколько подходов» — ровно отсутствие этих правил.
    const tw = { threshold: rad(40), relaxTime: 1.2 };
    expect(shouldCommitTurn(rad(60), 0, 0, tw), '⚠ мышь ещё едет — не решаем').toBe(false);
    expect(shouldCommitTurn(rad(60), TURN_SETTLE_SEC, 0, tw), 'мышь доехала, остаток за порогом доворота').toBe(true);
    expect(shouldCommitTurn(rad(30), TURN_SETTLE_SEC, 0, tw), 'остаток меньше порога — это скрутка корпуса').toBe(false);
    expect(shouldCommitTurn(rad(80), 0, TURN_URGENT_SEC, tw), 'верх упёрся в предел скрутки — не ждём мышь').toBe(true);
    expect(shouldCommitTurn(rad(36), tw.relaxTime, 0, tw), 'прицел давно стоит — доворачиваем и небольшой остаток').toBe(true);
  });

  it('⚠ нет клипа нужной величины — повернуться МЕНЬШИМ, а не стоять перекрученным', () => {
    const only45 = (n: string): boolean => n.endsWith('_45');
    expect(pickTurn(rad(170), only45)?.name).toBe('turn_R_45');
    expect(pickTurn(rad(170), () => false), 'поворотов нет вовсе').toBe(null);
  });

  it('имена — единственная правда о составе, и набор запекания их повторяет', () => {
    expect(TURN_NAMES.length).toBe(6);
    expect(turnClipName(90, true)).toBe('turn_R_90');
    expect(TURN_PRESETS.map((s) => s.name).sort(), '⚠ запекатель и рантайм разошлись в именах').toEqual([...TURN_NAMES].sort());
    for (const s of TURN_PRESETS) expect(Math.sign(s.deg), `${s.name}: сторона`).toBe(s.name.includes('_R_') ? 1 : -1);
  });

  it('опора из клипа: нога в воздухе — не заземлять', () => {
    const c = { name: 't', character: 'w', weapon: 'none', loop: false, keys: [
      { t: 0, pose: { [SWING_KEY]: [0, 0, 0] } }, { t: 1, pose: { [SWING_KEY]: [1, 0, 0] } },
    ] } as unknown as Clip;
    expect(turnSupportAt(c, 0)).toEqual([true, true]);
    expect(turnSupportAt(c, 1)).toEqual([false, true]);
  });
});

describe('поворот на месте в рантайме', () => {
  const GAIT0 = { ...GAIT };
  beforeEach(() => {
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: () => null, setItem: () => { /* */ }, removeItem: () => { /* */ }, clear: () => { /* */ }, key: () => null, length: 0,
    } as Storage;
  });
  afterEach(() => { setLocoMixOverride(null); delete (globalThis as unknown as { localStorage?: Storage }).localStorage; Object.assign(GAIT, GAIT0); });

  /** Запечь походку и повороты так же, как кнопка редактора. */
  const bake = (turns: boolean): Map<string, Clip> => {
    const h = buildHumanoid({});
    const p = new PosePlayer(h, () => [], localStorageContent('warrior'), 'none', GX, emptyGrid());
    const lib = new Map<string, Clip>();
    for (const s of GAIT_PRESETS) lib.set(s.name, bakeGaitToClip(p, h, s, { character: 'warrior', weapon: 'none' }).clip);
    if (turns) for (const r of bakeTurnSet(p, h, { character: 'warrior', weapon: 'none' })) lib.set(r.clip.name, r.clip);
    return lib;
  };

  interface Run { steps: number; stepsAfter: number; clips: string[]; lift: number; pelvis: number; swingFromClip: boolean; plantedSlide: number; clipEnd: number; contactChanges: number }
  /** Стоим, прицел прыгает на `deg`, 5 секунд смотрим. */
  const turn = (lib: Map<string, Clip>, mix: number, deg: number, moveAt = -1): Run => {
    const h = buildHumanoid({});
    const base = localStorageContent('warrior');
    const content = { ...base, locoClip: (names: readonly string[]) => { for (const n of names) { const c = lib.get(n); if (c) return c; } return null; } };
    const p = new PosePlayer(h, () => [], content, 'none', GX, emptyGrid());
    setLocoMixOverride(mix);
    p.setVel(0, 0); p.setYaw(0); p.snapYaw();
    for (let i = 0; i < 120; i++) p.step(1 / 60);
    h.root.updateMatrixWorld(true);
    const v = new THREE.Vector3();
    const y0 = [h.bones.get('LeftFoot')!.getWorldPosition(v).y, h.bones.get('RightFoot')!.getWorldPosition(v).y];
    const out: Run = { steps: 0, stepsAfter: 0, clips: [], lift: 0, pelvis: 0, swingFromClip: false, plantedSlide: 0, clipEnd: -1, contactChanges: 0 };
    // В «только клипы» планировщик не читаем вовсе: его выходы там не имеют смысла (и сторож ниже это требует).
    const legs = (): boolean[] => (p.clipOnly ? [false, false] : [...p.driver.swingLegs]);
    let prev = legs(), prevSup = [...p.groundSupport], last: string | null = null, ended = false;
    const prevFoot: (THREE.Vector3 | null)[] = [null, null];
    p.setYaw(rad(deg));
    for (let i = 0; i < 300; i++) {
      if (moveAt >= 0 && i >= moveAt) p.setVel(0, 0.85 * BAKE_MAXSPD);
      p.step(1 / 60);
      h.root.updateMatrixWorld(true);
      const cn = p.turnClipName;
      if (cn && cn !== last) out.clips.push(cn);
      if (!cn && last) { ended = true; if (out.clipEnd < 0) out.clipEnd = i; }
      last = cn;
      if (cn) {
        const s = p.groundSupport; if (!s[0] || !s[1]) out.swingFromClip = true;
        // Опорная стопа клипа обязана СТОЯТЬ в мире: таз идёт по кривой клипа, и ноги с ним в такт.
        // ⚠ Меряем УХОД ОТ ТОЧКИ, где опора началась, а не скорость за кадр: рассинхрон таза и ног
        // медленный (доли единицы за кадр), но за опору копится в заметное скольжение.
        for (let leg = 0; leg < 2; leg++) {
          const f = h.bones.get(leg === 0 ? 'LeftFoot' : 'RightFoot')!.getWorldPosition(new THREE.Vector3());
          if (s[leg] && !prevFoot[leg]) prevFoot[leg] = f;
          else if (s[leg]) out.plantedSlide = Math.max(out.plantedSlide, Math.hypot(f.x - prevFoot[leg]!.x, f.z - prevFoot[leg]!.z));
          else prevFoot[leg] = null;
        }
      }
      const sup = p.groundSupport;
      if (sup[0] !== prevSup[0] || sup[1] !== prevSup[1]) out.contactChanges++;
      prevSup = [...sup];
      const sw = legs();
      for (let leg = 0; leg < 2; leg++) {
        if (sw[leg] && !prev[leg]) { out.steps++; if (ended) out.stepsAfter++; }
        out.lift = Math.max(out.lift, h.bones.get(leg === 0 ? 'LeftFoot' : 'RightFoot')!.getWorldPosition(v).y - y0[leg]!);
      }
      prev = sw;
    }
    out.pelvis = p.pelvisYaw * 180 / Math.PI;
    return out;
  };

  it('⭐⭐ БЕЗ ЗАПЕЧЁННЫХ ПОВОРОТОВ ПОДШАГИ ПЛАНИРОВЩИКА ВИДНЫ И ПРИ КЛИПАХ БЕГА (смешанный режим)', () => {
    // ⚠ Мутация «убрать ворота по движению у слоя бега» валит это: подъём стопы 0.00 — ровно жалоба.
    // ⚠ Доля 0.99, а не 1: единица — режим «только клипы», в нём планировщика нет (см. тест ниже).
    const lib = bake(false);
    for (const deg of [45, 90, 180]) {
      const r = turn(lib, 0.99, deg);
      expect(r.steps, `${deg}°: планировщик шагает`).toBeGreaterThan(0);
      expect(r.lift, `${deg}°: ⚠ стопа не отрывается — слой бега накрыл подшаги`).toBeGreaterThan(3);
    }
  });

  it('⚠ «ТОЛЬКО КЛИПЫ» БЕЗ ЗАПЕЧЁННЫХ ПОВОРОТОВ — ПОДШАГОВ НЕТ: планировщик выключен, а заменить нечем', () => {
    // Это не баг, а ровно то, что должна показать репетиция без планировщика: повороты на месте надо запечь.
    const r = turn(bake(false), 1, 90);
    expect(r.clips, 'поворотов в библиотеке нет — играть нечего').toEqual([]);
    expect(r.contactChanges, '⚠ ноги переступили — значит, их ещё кто-то ведёт').toBe(0);
    expect(r.lift, '⚠ стопа оторвалась — значит, их ещё кто-то ведёт').toBeLessThan(0.5);
  });

  it('⭐⭐ С ЗАПЕЧЁННЫМИ ПОВОРОТАМИ — ОДИН КЛИП НУЖНОЙ ВЕЛИЧИНЫ, таз доходит, лишних шагов нет', () => {
    // ⚠ Мутация «не пересаживать стопы после клипа» валит `stepsAfter`: планировщик видел старые планты
    // на прежнем курсе и сразу же делал подшаги поверх уже законченного поворота.
    const lib = bake(true);
    for (const [deg, name] of [[45, 'turn_R_45'], [90, 'turn_R_90'], [179.5, 'turn_R_180'], [-90, 'turn_L_90']] as const) {
      // Доля 0.99 — смешанный режим: планировщик ЖИВ, и проверка «не шагал поверх клипа и после» не пустая.
      // Что в «только клипы» его нет вовсе, стережёт отдельный тест с подменой его выходов.
      const r = turn(lib, 0.99, deg);
      expect(r.clips, `${deg}°: сыграл один нужный поворот`).toEqual([name]);
      expect(r.steps, `${deg}°: ⚠ планировщик шагал поверх клипа`).toBe(0);
      expect(r.stepsAfter, `${deg}°: ⚠ лишние подшаги после поворота`).toBe(0);
      expect(Math.abs(r.pelvis - deg), `${deg}°: таз встал на ${r.pelvis.toFixed(1)}°`).toBeLessThan(3);
      expect(r.lift, `${deg}°: стопа поднимается (переступание из клипа)`).toBeGreaterThan(3);
      expect(r.swingFromClip, `${deg}°: ⚠ заземление не узнало о маховой ноге клипа`).toBe(true);
      // ⚠ Мутация «таз ведёт свой доворот, а не кривая клипа» валит это: опорная стопа поехала бы по полу.
      // Замер: 0.23–0.56 за опору; с тазом, ведомым своим доворотом, на 45° уже 1.41.
      expect(r.plantedSlide, `${deg}°: ⚠ опорная стопа уехала на ${r.plantedSlide.toFixed(2)} за опору`).toBeLessThan(1);
    }
  });

  it('⭐⭐ РЫВОК МЫШЬЮ — ОДИН ПОВОРОТ НУЖНОЙ ВЕЛИЧИНЫ, и не раньше, чем мышь доехала', () => {
    // ЗАМЕР жалобы (было): рывок 180° за 0.2 с → 45° на 0.07 с → 90° → 45°; рывок 90° → 45° → 45°.
    // ⚠ Мутация «решать в первый же кадр за порогом» валит это.
    const lib = bake(true);
    const flick = (deg: number, sec: number): { clips: string[]; firstAt: number } => {
      const h = buildHumanoid({});
      const base = localStorageContent('warrior');
      const p = new PosePlayer(h, () => [], { ...base, locoClip: (names: readonly string[]) => { for (const n of names) { const c = lib.get(n); if (c) return c; } return null; } }, 'none', GX, emptyGrid());
      setLocoMixOverride(1);
      p.setVel(0, 0); p.setYaw(0); p.snapYaw();
      for (let i = 0; i < 120; i++) p.step(1 / 60);
      const clips: string[] = []; let last: string | null = null, firstAt = -1;
      for (let i = 0; i < 60 * 4; i++) {
        const k = Math.min(1, i / 60 / sec), e = k * k * (3 - 2 * k);    // мышь разгоняется и тормозит
        p.setYaw(rad(deg) * e);
        p.step(1 / 60);
        const cn = p.turnClipName;
        if (cn && cn !== last) { clips.push(cn); if (firstAt < 0) firstAt = i / 60; }
        last = cn;
      }
      return { clips, firstAt };
    };
    const a = flick(179.5, 0.2);
    expect(a.clips, 'рывок на 180°').toEqual(['turn_R_180']);
    expect(a.firstAt, '⚠ поворот начался, пока мышь ещё ехала').toBeGreaterThanOrEqual(0.2 - 1e-6);
    expect(flick(90, 0.15).clips, 'рывок на 90°').toEqual(['turn_R_90']);
    expect(flick(90, 0.6).clips, 'плавно на 90°').toEqual(['turn_R_90']);
  });

  it('⚠ ПЛАНИРОВЩИК В РЕЖИМЕ НЕ-КЛИПОВ НЕ ТРОНУТ: повороты запечены, но галка на планировщике', () => {
    const r = turn(bake(true), 0, 90);
    expect(r.clips, 'клипы поворота не играют').toEqual([]);
    expect(r.steps).toBeGreaterThan(0);
  });

  it('⚠ ПОШЁЛ ПОСРЕДИ ПОВОРОТА — поворот гаснет и отдаёт ноги ходу', () => {
    const r = turn(bake(true), 1, 179.5, 20);
    expect(r.clips, 'поворот начался').toEqual(['turn_R_180']);
    // ⚠ Мутация «ход не обрывает поворот» валит это: поворот на 180° доиграл бы свои 1.3 с (≈79 кадров).
    expect(r.clipEnd, `⚠ поворот оборвался только на кадре ${r.clipEnd}`).toBeLessThan(20 + 12);
    // На ходу ноги у бега: в «только клипы» опора меняется по клипу бега (планировщика нет).
    expect(r.contactChanges, '⚠ ход не забрал ноги у недоигранного поворота').toBeGreaterThan(2);
  });

});

describe('шов клипа поворота: таз и ноги не прыгают (жалоба 17.09 «при повороте дёргается вверх-вниз»)', () => {
  const GAIT0 = { ...GAIT };
  beforeEach(() => {
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: () => null, setItem: () => { /* */ }, removeItem: () => { /* */ }, clear: () => { /* */ }, key: () => null, length: 0,
    } as Storage;
  });
  afterEach(() => { setLocoMixOverride(null); delete (globalThis as unknown as { localStorage?: Storage }).localStorage; Object.assign(GAIT, GAIT0); });

  const LEG_BONES = ['LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot', 'RightUpperLeg', 'RightLowerLeg', 'RightFoot'] as const;
  /**
   * Стойка с АВТОРСКИМ офсетом таза, как у всех опубликованных idle: релакс — `relaxY` (опубликованный воин −0.08), бой —
   * `combatY` (−1.06). ⚠ Без офсета `standY` совпадает с базой 30 `gaitToHumanoid`, и регрессию «только клипы» не видно —
   * так её и пропустили прежние тесты.
   */
  const authored = (combatY = -0.08, relaxY = -0.08): PoseContent => {
    const base = localStorageContent('warrior');
    return { ...base, resolveUpper: (w, c, t) => {
      const up = base.resolveUpper(w, c, t);
      const pose = { ...(up?.pose ?? {}) }; setHipsOffset(pose, [0, relaxY + (combatY - relaxY) * (c ?? 0), 0]);
      return { ...(up ?? { swing: 1 }), pose };
    } };
  };
  /** Повороты — как кнопкой редактора: процедуркой и в РЕЛАКС-стойке (боевой оси у набора нет). */
  const bakeTurns = (content: PoseContent): Map<string, Clip> => {
    const h = buildHumanoid({}); const p = new PosePlayer(h, () => [], content, 'none', GX, emptyGrid());
    const lib = new Map<string, Clip>();
    for (const r of bakeTurnSet(p, h, { character: 'warrior', weapon: 'none' })) lib.set(r.clip.name, r.clip);
    return lib;
  };
  interface Play { ys: number[]; leg: number[]; clips: string[]; start: number; end: number; standLegs: THREE.Quaternion[]; legs: THREE.Quaternion[] }
  /**
   * Стоим 2 с, прицел прыгает на `deg`, смотрим 3 с. По кадрам: высота таза, наибольший поворот кости ноги за кадр (°),
   * кадр старта и конца клипа. `hook` зовётся после шага кадра `i` (1…180).
   */
  const play = (lib: Map<string, Clip>, content: PoseContent, mix: number, o: { deg?: number; combat?: boolean; hook?: (p: PosePlayer, i: number, out: Play) => void } = {}): Play => {
    const h = buildHumanoid({});
    const p = new PosePlayer(h, () => [], { ...content, locoClip: (names: readonly string[]) => { for (const n of names) { const c = lib.get(n); if (c) return c; } return null; } }, 'none', GX, emptyGrid());
    setLocoMixOverride(mix);
    p.setCombat(!!o.combat);
    p.setVel(0, 0); p.setYaw(0); p.snapYaw();
    for (let i = 0; i < 120; i++) p.step(1 / 60);
    const hips = h.bones.get('Hips')!;
    const legs = LEG_BONES.map((n) => h.bones.get(n)!.quaternion);
    const prev = legs.map((q) => q.clone());
    const out: Play = { ys: [hips.position.y], leg: [0], clips: [], start: -1, end: -1, standLegs: legs.map((q) => q.clone()), legs };
    p.setYaw(rad(o.deg ?? 90));
    for (let i = 1; i <= 180; i++) {
      p.step(1 / 60);
      out.ys.push(hips.position.y);
      let m = 0;
      legs.forEach((q, k) => { m = Math.max(m, 2 * Math.acos(Math.min(1, Math.abs(q.dot(prev[k]!)))) * 180 / Math.PI); prev[k]!.copy(q); });
      out.leg.push(m);
      const cn = p.turnClipName;
      if (cn && !out.clips.includes(cn)) out.clips.push(cn);
      if (cn && out.start < 0) out.start = i;
      if (!cn && out.start >= 0 && out.end < 0) out.end = i;
      o.hook?.(p, i, out);
    }
    return out;
  };
  const maxStep = (ys: readonly number[]): number => { let m = 0; for (let i = 1; i < ys.length; i++) m = Math.max(m, Math.abs(ys[i]! - ys[i - 1]!)); return m; };
  const spread = (ys: readonly number[]): number => Math.max(...ys) - Math.min(...ys);

  it('⭐⭐ «ТОЛЬКО КЛИПЫ»: ТАЗ СТОЯ — НА ВЫСОТЕ СТОЙКИ, и поворот клипом не подбрасывает его вверх-вниз', () => {
    // ЗАМЕР жалобы: в «только клипы» таз стоя стоял на голой базе 30 (`CLIP_ONLY_TG().bobY = 0`), а клип поворота кладёт
    // его на высоту стойки. Рыцарь с опубликованным warrior: 30.000 → 34.968 за кадр на старте клипа, 34.809 → 30.000 на
    // конце. Здесь: стоя 31.920 / 31.920, наибольший шаг таза за кадр 0.018. ⚠ Мутация «bobY в «только клипы» снова 0»:
    // стоя 30.000 против 31.920.
    const content = authored(), lib = bakeTurns(content);
    const only = play(lib, content, 1), mixed = play(lib, content, 0.99);
    expect(only.clips, 'поворот сыграл клипом').toEqual(['turn_R_90']);
    expect(Math.abs(only.ys[0]! - mixed.ys[0]!), `таз стоя: только клипы ${only.ys[0]!.toFixed(3)}, планировщик ${mixed.ys[0]!.toFixed(3)}`).toBeLessThan(0.3);
    expect(maxStep(only.ys), `⚠ таз прыгнул на ${maxStep(only.ys).toFixed(3)} за кадр`).toBeLessThan(0.5);
  });

  it('⭐⭐ В БОЮ ПОВОРОТ НЕ ПОДНИМАЕТ ТАЗ: клип, запечённый в релаксе, ведёт высоту ПРИРАЩЕНИЕМ от своего первого ключа', () => {
    // ЗАМЕР (рыцарь, опубликованный warrior, бой): таз стоя 33.83, клип держал его на релакс-высоте — в смешанном режиме
    // скачок 1.14–1.46 за кадр туда и назад, в «только клипы» (с исправленной стойкой) подъём ~0.9 на весь поворот.
    // Здесь: размах 0.080 / 0.108 (только клипы / смешанный). ⚠ Мутации: «таз клипа абсолютом» — 1.483 в «только клипы»;
    // «приращение поверх ЖИВОЙ высоты кадра, а не запомненной на старте» — 0.308 в смешанном (планировщик с отобранными
    // ногами проседает сам, и клип ложился на просадку второй раз); «без вычитания первого ключа» — 1.080.
    // ⚠ ОФСЕТЫ ТАЗА НАРОЧНО ДАЛЕКО ОТ НУЛЯ (релакс −1.0, бой −2.5): при релаксе −0.08 первый ключ запечённого поворота ≈ 0, и
    // «приращение от первого ключа» не отличалось от «абсолюта поверх стойки» — мутация «без вычитания» проходила.
    // ⚠ И ВЫСОТА СТОЯ В БОЮ В «ТОЛЬКО КЛИПЫ» — ровно боевая стойка: `clipStandY` обязан перемериться на входе в бой. Мутации
    // «не перемерять в «только клипы»» и «`clipStandY` только вне «только клипы»» — таз стоя 31.000 против 29.500.
    const content = authored(-2.5, -1.0), lib = bakeTurns(content);
    const stanceY = buildHumanoid({}).hipsRest.y - 2.5;
    for (const mix of [1, 0.99]) {
      const r = play(lib, content, mix, { combat: true });
      expect(r.clips, `доля ${mix}: поворот сыграл клипом`).toEqual(['turn_R_90']);
      if (mix === 1) expect(Math.abs(r.ys[0]! - stanceY), `⚠ «только клипы», бой: таз стоя ${r.ys[0]!.toFixed(3)}, боевая стойка ${stanceY.toFixed(3)}`).toBeLessThan(0.01);
      expect(spread(r.ys), `доля ${mix}: ⚠ размах таза за поворот ${spread(r.ys).toFixed(3)} (стоя ${r.ys[0]!.toFixed(3)})`).toBeLessThan(0.2);
    }
  });

  it('⭐⭐ КОНЕЦ КЛИПА НЕ НА ВЫСОТЕ НАЧАЛА — таз доезжает плавно (шов `seamW`), а не за кадр', () => {
    // У запечённых поворотов последний ключ таза не там, где первый (рыцарь: −0.081 → −0.247 у turn_R_90): разница
    // скакала в кадр конца. Здесь она нарочно 0.3 — рампой по всему клипу, чтобы внутри клипа шаг был крошечным.
    // Здесь: 0.046 / 0.067 за кадр (только клипы / смешанный). ⚠ Мутация «без шва»: 0.276 за кадр в кадр конца.
    const content = authored(), baked = bakeTurns(content);
    const lib = new Map<string, Clip>();
    for (const [n, c] of baked) {
      const dur = clipDur(c) || 1;
      lib.set(n, { ...c, keys: c.keys.map((k) => {
        const pose = { ...k.pose }, hd = hipsOffset(pose) ?? [0, 0, 0];
        setHipsOffset(pose, [hd[0], hd[1] + 0.3 * k.t / dur, hd[2]]);
        return { ...k, pose };
      }) });
    }
    for (const mix of [1, 0.99]) {
      const r = play(lib, content, mix);
      expect(r.clips, `доля ${mix}: поворот сыграл клипом`).toEqual(['turn_R_90']);
      expect(r.end, `доля ${mix}: клип доиграл`).toBeGreaterThan(0);
      expect(maxStep(r.ys), `доля ${mix}: ⚠ таз прыгнул на ${maxStep(r.ys).toFixed(3)} за кадр`).toBeLessThan(0.1);
    }
  });

  it('⭐⭐ НОГИ НА ШВЕ: стойка «только клипы» ≠ первый ключ клипа — ноги перетекают, а не щёлкают', () => {
    // Опубликованный воин: `idleSettle` 0 — планировщик в idle-позу не уходит, и повороты запечены с ЕГО ногами стоя
    // (колено 0.411 рад), а «только клипы» стоит в авторской позе (0.023). ЗАМЕР на рыцаре: 23.4° за кадр на старте,
    // 22.9–24.8° на конце, опорная стопа на 1.25 за кадр (в бою 3.7). Здесь: разница стоек 23.6°, кадр старта 0.0°, хвост
    // конца ≤ 3.9° за кадр. ⚠ Мутации «без шва» и «шов только для таза»: 23.6° в кадр старта.
    GAIT.idleSettle = 0;
    const content = authored(), lib = bakeTurns(content);
    const r = play(lib, content, 1);
    expect(r.clips).toEqual(['turn_R_90']);
    expect(r.end, 'клип доиграл').toBeGreaterThan(0);
    // Сама разница стоек должна быть: иначе сторож пустой.
    const mixed = play(lib, content, 0.99);
    const gap = Math.max(...r.standLegs.map((q, k) => 2 * Math.acos(Math.min(1, Math.abs(q.dot(mixed.standLegs[k]!)))) * 180 / Math.PI));
    expect(gap, 'стойка «только клипы» и стойка планировщика различаются (иначе сторож пустой)').toBeGreaterThan(8);
    expect(r.leg[r.start]!, `⚠ ноги щёлкнули на ${r.leg[r.start]!.toFixed(1)}° в кадр старта`).toBeLessThan(2);
    const tail = Math.max(...r.leg.slice(r.end, r.end + 15));
    expect(tail, `⚠ ноги щёлкнули на ${tail.toFixed(1)}° за кадр на конце (стоя)`).toBeLessThan(gap * 0.3);
  });

  it('⚠ ОБРЫВ ПОВОРОТА СНАРУЖИ (`snapYaw`: телепорт) — снап без хвоста шва', () => {
    // Недогашенный шов не должен доехать через телепорт: после `snapYaw` ноги ровно в стойке уже на следующем кадре.
    // ⚠ Мутация «не сбрасывать шов в `cancelTurn`»: 20.6° от стойки.
    GAIT.idleSettle = 0;
    const content = authored(), lib = bakeTurns(content);
    let snapped = -1, after = -1;
    const r = play(lib, content, 1, { hook: (p, i, out) => {
      if (out.start > 0 && snapped < 0 && i === out.start + 1) { p.snapYaw(); snapped = i; }
      else if (snapped > 0 && i === snapped + 1) after = Math.max(...out.legs.map((q, k) => 2 * Math.acos(Math.min(1, Math.abs(q.dot(out.standLegs[k]!)))) * 180 / Math.PI));
    } });
    expect(r.start, 'поворот начался').toBeGreaterThan(0);
    expect(after, `⚠ через кадр после snapYaw ноги в ${after.toFixed(2)}° от стойки`).toBeLessThan(0.01);
  });

  it('⭐⭐ ПОДТЯЖКИ СТОП НЕ ЩЁЛКАЮТ ПОД КЛИПОМ ПОВОРОТА: встал с хода и сразу повернулся, пошёл посреди поворота', () => {
    // `warpStanceFeet` перерешает ногу IK целиком при любом весе > 0.001 и не трогает при 0 — её выключение само щёлкает.
    // ЗАМЕР на рыцаре (опубликованный warrior): шли 40, встали и прицел +90 в тот же кадр — клип стартует на f7, а фиксация
    // стоп (`lockW`) гаснет на f14: ноги 28.6° за кадр («только клипы»), смешанный — 29.5° там, где гаснет `locoW`; пошли
    // посреди поворота — подтяжка включалась посреди гашения клипа: 28.6°. Стало 3.4° / 4.1° / 7.9° (свой ход клипа).
    // Здесь кадр, где погасла подтяжка, сравниваем с тем же кадром клипа у поворота, начатого после её гашения: 0.6° /
    // 1.6° («только клипы» / смешанный). ⚠ Мутации: «подтяжка и под клипом поворота» — 11.9° / 11.9°; «шов ног до
    // подтяжек» — 13.9° в кадр старта и 11.9° в кадр конца гашения (пошли посреди поворота); «подтяжка на гашении клипа» —
    // +5.2° в кадр, где пошли (здесь −3.4°).
    GAIT.idleSettle = 0;
    const content = authored(), lib = bakeTurns(content);
    {
      const h = buildHumanoid({}); const p = new PosePlayer(h, () => [], content, 'none', GX, emptyGrid());
      for (const s of GAIT_PRESETS) lib.set(s.name, bakeGaitToClip(p, h, s, { character: 'warrior', weapon: 'none' }).clip);
    }
    const legStep = (legs: readonly THREE.Quaternion[], prev: THREE.Quaternion[]): number => {
      let m = 0;
      legs.forEach((q, k) => { m = Math.max(m, 2 * Math.acos(Math.min(1, Math.abs(q.dot(prev[k]!)))) * 180 / Math.PI); prev[k]!.copy(q); });
      return m;
    };
    interface Run { leg: number[]; start: number; end: number; warpOff: number; walk: number }
    /**
     * Стоим, идём 1 с на 40, встаём; через `aimAt` кадров прицел +90. `walkOff` — через столько кадров после старта клипа
     * снова пошли. По кадрам (от остановки): поворот ног за кадр; кадр старта и конца клипа; кадр, где гаснет вес
     * подтяжки (в «только клипы» — фиксация `lockW`, в смешанном — доля клипа бега `locoW`; ⚠ они и `turn` приватные —
     * читаем приведением).
     */
    const run = (mix: number, aimAt: number, walkOff = -1): Run => {
      const h = buildHumanoid({});
      const p = new PosePlayer(h, () => [], { ...content, locoClip: (names: readonly string[]) => { for (const n of names) { const c = lib.get(n); if (c) return c; } return null; } }, 'none', GX, emptyGrid());
      const w = p as unknown as { lockW: number; locoW: number; turn: unknown };
      setLocoMixOverride(mix);
      p.setVel(0, 0); p.setYaw(0); p.snapYaw();
      for (let i = 0; i < 120; i++) p.step(1 / 60);
      p.setVel(0, 40);
      for (let i = 0; i < 60; i++) p.step(1 / 60);
      const legs = LEG_BONES.map((n) => h.bones.get(n)!.quaternion), prev = legs.map((q) => q.clone());
      const out: Run = { leg: [], start: -1, end: -1, warpOff: -1, walk: -1 };
      let wasW = 1;
      for (let i = 0; i < 150; i++) {
        const walking = out.start >= 0 && walkOff >= 0 && i >= out.start + walkOff;
        if (walking && out.walk < 0) out.walk = i;
        p.setVel(0, walking ? 40 : 0);
        if (i === aimAt) p.setYaw(rad(90));
        p.step(1 / 60);
        out.leg.push(legStep(legs, prev));
        const cn = p.turnClipName, ww = mix >= 0.999 ? w.lockW : w.locoW;
        if (cn && out.start < 0) out.start = i;
        if (!w.turn && out.start >= 0 && out.end < 0) out.end = i;   // конец ГАШЕНИЯ: `turnClipName` гаснет раньше
        if (ww <= 0.001 && wasW > 0.001 && out.warpOff < 0) out.warpOff = i;
        wasW = ww;
      }
      return out;
    };
    for (const mix of [1, 0.99]) {
      const ref = run(mix, 30);   // поворот начат, когда подтяжка уже погасла: ход клипа без неё
      expect(ref.start, `доля ${mix}: опорный поворот начался после гашения подтяжки`).toBeGreaterThan(ref.warpOff);
      const at = (r: Run, i: number): number => ref.leg[ref.start + (i - r.start)]!;
      for (const aimAt of [0, 6]) {
        const r = run(mix, aimAt);
        const tag = `доля ${mix}, прицел через ${aimAt} кадров`;
        expect(r.start, `${tag}: клип стартовал, пока подтяжка ещё действует (иначе сторож пустой)`).toBeLessThan(r.warpOff);
        expect(r.leg[r.start]!, `${tag}: ⚠ ноги щёлкнули на ${r.leg[r.start]!.toFixed(1)}° в кадр старта`).toBeLessThan(2);
        const d = Math.abs(r.leg[r.warpOff]! - at(r, r.warpOff));
        expect(d, `${tag}: ⚠ ноги щёлкнули на ${r.leg[r.warpOff]!.toFixed(1)}° в кадр, где погасла подтяжка (ход клипа ${at(r, r.warpOff).toFixed(1)}°)`).toBeLessThan(3);
      }
      // Пошли посреди поворота: клип гаснет, подтяжка ждёт его конца — и включается в кадр, который покрывает шов.
      const r = run(mix, 30, 10);
      expect(r.end, `доля ${mix}: ход оборвал поворот`).toBeGreaterThan(r.walk);
      expect(r.leg[r.walk]! - r.leg[r.walk - 1]!, `доля ${mix}: ⚠ ноги щёлкнули на ${r.leg[r.walk]!.toFixed(1)}° в кадр, где пошли (кадром раньше ${r.leg[r.walk - 1]!.toFixed(1)}°)`).toBeLessThan(3);
      expect(r.leg[r.end]!, `доля ${mix}: ⚠ ноги щёлкнули на ${r.leg[r.end]!.toFixed(1)}° в кадр конца гашения`).toBeLessThan(2);
    }
  });
  it('⭐⭐ ВСТАЛ С ХОДА И СРАЗУ ПОВЕРНУЛСЯ — таз поворота не держит просадку остановки до конца клипа', () => {
    // ЗАМЕР на рыцаре (опубликованный warrior, «только клипы»; шли 40, встали и прицел +90 в тот же кадр): клип стартует на
    // f7, пока клип хода ещё догасает (`locoW` 0.47), и `lift`, запомненный на первом кадре, держал это догасание весь
    // поворот — таз посреди клипа ниже стойки на 0.63 (у поворота с места 0.07), после клипа вставал на 0.72, шаг таза за
    // кадр 0.120. Стало 0.07 / 0.16 / 0.026 — ровно как у поворота с места.
    // Здесь: отклонение от поворота с места (тот же кадр клипа, от 12-го) 0.000, шаг таза после клипа 0.003 (с места
    // 0.003). ⚠ Мутация «`lift` в «только клипы» запомнить на первом кадре» — отклонение 0.251.
    // Смешанный: `lift` запомненный (см. poseRuntime, «В СМЕШАННОМ»), и старт поворота обязан быть непрерывным: таз не
    // подбрасывается к высоте стойки за 0.15 с шва. Здесь: 0.043. ⚠ Мутация «`lift` = 0» — 0.780.
    const content = authored(), lib = bakeTurns(content);
    {
      const h = buildHumanoid({}); const p = new PosePlayer(h, () => [], content, 'none', GX, emptyGrid());
      for (const s of GAIT_PRESETS) lib.set(s.name, bakeGaitToClip(p, h, s, { character: 'warrior', weapon: 'none' }).clip);
    }
    interface Stop { stand: number; ys: number[]; start: number; end: number; locoW0: number }
    /** Стоим 2 с; если `walk` — идём 1 с на 40 и встаём; прицел +90 в кадр остановки. Кадры — от него. */
    const stopTurn = (mix: number, walk: boolean): Stop => {
      const h = buildHumanoid({});
      const p = new PosePlayer(h, () => [], { ...content, locoClip: (names: readonly string[]) => { for (const n of names) { const c = lib.get(n); if (c) return c; } return null; } }, 'none', GX, emptyGrid());
      const w = p as unknown as { locoW: number; turn: unknown };   // ⚠ приватные — читаем приведением
      setLocoMixOverride(mix);
      p.setVel(0, 0); p.setYaw(0); p.snapYaw();
      for (let i = 0; i < 120; i++) p.step(1 / 60);
      const hips = h.bones.get('Hips')!;
      const out: Stop = { stand: hips.position.y, ys: [], start: -1, end: -1, locoW0: 0 };
      if (walk) { p.setVel(0, 40); for (let i = 0; i < 60; i++) p.step(1 / 60); p.setVel(0, 0); }
      p.setYaw(rad(90));
      for (let i = 0; i < 160; i++) {
        p.step(1 / 60);
        out.ys.push(hips.position.y);
        if (w.turn && out.start < 0) { out.start = i; out.locoW0 = w.locoW; }
        if (!w.turn && out.start >= 0 && out.end < 0) out.end = i;   // конец с гашением: дальше — шов
      }
      return out;
    };
    const post = (r: Stop): number => { let m = 0; for (let i = r.end - 1; i <= r.end + 20; i++) m = Math.max(m, Math.abs(r.ys[i]! - r.ys[i - 1]!)); return m; };
    {
      const ref = stopTurn(1, false), r = stopTurn(1, true);
      expect(r.start > 0 && r.end > r.start && ref.end > ref.start, 'оба поворота сыграли клипом').toBe(true);
      expect(r.locoW0, 'клип стартовал, пока клип хода ещё догасает (иначе сторож пустой)').toBeGreaterThan(0.2);
      let dev = 0;
      for (let k = 12; k < r.end - r.start; k++) dev = Math.max(dev, Math.abs((r.ys[r.start + k]! - r.stand) - (ref.ys[ref.start + k]! - ref.stand)));
      expect(dev, `⚠ «только клипы»: таз поворота после хода отстоит от поворота с места на ${dev.toFixed(3)}`).toBeLessThan(0.02);
      expect(post(r), `⚠ «только клипы»: таз после клипа ${post(r).toFixed(3)} за кадр (с места ${post(ref).toFixed(3)})`).toBeLessThan(post(ref) + 0.01);
    }
    {
      const ref = stopTurn(0.99, false), r = stopTurn(0.99, true);
      expect(r.start > 0 && ref.start > 0, 'смешанный: оба поворота сыграли клипом').toBe(true);
      expect(r.ys[r.start - 1]! - r.stand, 'смешанный: поворот начат в просадке (иначе сторож пустой)').toBeLessThan(-0.3);
      let rise = 0;
      for (let k = 0; k <= 12; k++) rise = Math.max(rise, Math.abs((r.ys[r.start + k]! - r.ys[r.start - 1]!) - (ref.ys[ref.start + k]! - ref.ys[ref.start - 1]!)));
      expect(rise, `⚠ смешанный: таз на старте поворота ушёл на ${rise.toFixed(3)} от хода клипа`).toBeLessThan(0.15);
    }
  });

  it('⚠ СМЕНА ОРУЖИЯ ПОСРЕДИ ШВА — шов начинается заново с показанной позы, ноги не щёлкают сильнее самой смены', () => {
    // ЗАМЕР на рыцаре («только клипы», поворот +90, меч через 1 / 2 / 4 кадра после конца клипа): смещение шва, снятое против
    // ног старой стойки, ложилось на ноги новой — опорная стопа 3.53 / 3.26 / 2.35 за кадр (смена вне шва — 0.18). Стало 0
    // в кадр смены и ≤ 0.1 дальше. Вне шва смена — снап, как и была.
    // Здесь: вне шва ноги 34.4° за кадр (снап); на шве — кадр смены 0.0°, дальше ≤ 1.9°. ⚠ Мутации: «шов не
    // начинать заново» — 32.2° в кадр смены; «погасить шов» (`seamW` = 0) — 11.6°; «начинать заново и вне шва» —
    // вне шва 0.0°.
    GAIT.idleSettle = 0;
    const base = authored();
    /** У меча свои ноги стоя (согнуты): смена оружия меняет стойку, как у опубликованного воина (39.7° за кадр). */
    const content: PoseContent = { ...base, resolveUpper: (wpn, c, t) => {
      const up = base.resolveUpper(wpn, c, t);
      if (wpn !== 'sword' || !up) return up;
      const pose = { ...up.pose };
      for (const [nm, d] of [['LeftUpperLeg', -0.35], ['RightUpperLeg', -0.35], ['LeftLowerLeg', 0.6], ['RightLowerLeg', 0.6]] as const) {
        const e = pose[nm] ?? [0, 0, 0]; pose[nm] = [e[0]! + d, e[1]!, e[2]!];
      }
      return { ...up, pose };
    } };
    const lib = bakeTurns(base);
    let still = -1;
    const s = play(lib, content, 1, { deg: 0, hook: (p, i) => { if (i === 30) { p.setWeapon('sword'); still = i + 1; } } });
    expect(s.leg[still]!, 'вне шва смена — снап: стойка меча другая (иначе сторож пустой)').toBeGreaterThan(8);
    let swap = -1, seamAt = -1;
    const r = play(lib, content, 1, { hook: (p, i, out) => {
      if (out.end > 0 && swap < 0 && i === out.end + 1) { seamAt = (p as unknown as { seamW: number }).seamW; p.setWeapon('sword'); swap = i + 1; }
    } });
    expect(seamAt, 'сменили посреди шва (иначе сторож пустой)').toBeGreaterThan(0.3);
    expect(r.leg[swap]!, `⚠ ноги щёлкнули на ${r.leg[swap]!.toFixed(2)}° в кадр смены оружия на шве`).toBeLessThan(2);
    const tail = Math.max(...r.leg.slice(swap, swap + 12));
    expect(tail, `⚠ ноги ${tail.toFixed(2)}° за кадр после смены (снап вне шва ${s.leg[still]!.toFixed(2)}°)`).toBeLessThan(s.leg[still]! * 0.25);
  });

});

describe('запекание поворотов', () => {
  beforeEach(() => {
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: () => null, setItem: () => { /* */ }, removeItem: () => { /* */ }, clear: () => { /* */ }, key: () => null, length: 0,
    } as Storage;
  });
  afterEach(() => { setLocoMixOverride(null); delete (globalThis as unknown as { localStorage?: Storage }).localStorage; });

  it('⭐ клип несёт курс и опору, короткий, начинается и кончается стоя', () => {
    // ⚠ Мутация «конец съёма — когда таз ДОШЁЛ до прицела» валит длительность: у доворота мёртвая зона,
    // таз встаёт на 88.8° вместо 90°, и съём шёл до `maxSec` — клип на 6 с, из них пять стояния.
    const h = buildHumanoid({});
    const p = new PosePlayer(h, () => [], localStorageContent('warrior'), 'none', GX, emptyGrid());
    for (const r of bakeTurnSet(p, h, { character: 'warrior', weapon: 'none' })) {
      const want = TURN_PRESETS.find((s) => s.name === r.clip.name)!.deg;
      const dur = clipDur(r.clip);
      expect(dur, `${r.clip.name}: длительность`).toBeLessThan(2.5);
      expect(r.clip.rootYaw, 'клип помечен как несущий курс').toBe(true);
      expect(Math.abs(turnYawAt(r.clip, dur) * 180 / Math.PI - want), `${r.clip.name}: курс в конце`).toBeLessThan(2);
      expect(turnSupportAt(r.clip, 0), `${r.clip.name}: начало стоя`).toEqual([true, true]);
      expect(turnSupportAt(r.clip, dur), `${r.clip.name}: конец стоя`).toEqual([true, true]);
      let stepped = false;
      for (let t = 0; t < dur; t += 1 / 60) { const s = turnSupportAt(r.clip, t); if (!s[0] || !s[1]) stepped = true; }
      expect(stepped, `${r.clip.name}: в клипе есть переступание`).toBe(true);
    }
  });

  it('⚠ ЗАПЕКАЕТСЯ ПРОЦЕДУРКА, даже если включена локомоция клипами', () => {
    // Иначе плеер заиграл бы уже лежащий в библиотеке поворот, и новый клип сняли бы с него. Чтобы это
    // было ВИДНО, в библиотеке лежит поворот вдвое медленнее: заиграй его плеер — клип растянулся бы.
    // ⚠ Мутация «не форсировать процедурку при съёме» валит это.
    const spec = TURN_PRESETS.find((s) => s.name === 'turn_R_90')!;
    const h0 = buildHumanoid({});
    const p0 = new PosePlayer(h0, () => [], localStorageContent('warrior'), 'none', GX, emptyGrid());
    const ref = bakeTurnSet(p0, h0, { character: 'warrior', weapon: 'none' }, [spec])[0]!;
    const slow: Clip = { ...ref.clip, keys: ref.clip.keys.map((k) => ({ ...k, t: k.t * 2 })) };
    const h = buildHumanoid({});
    const base = localStorageContent('warrior');
    const p = new PosePlayer(h, () => [], { ...base, locoClip: (names: readonly string[]) => (names.includes('turn_R_90') ? slow : null) }, 'none', GX, emptyGrid());
    setLocoMixOverride(1);
    const got = bakeTurnSet(p, h, { character: 'warrior', weapon: 'none' }, [spec])[0]!;
    expect(Math.abs(clipDur(got.clip) - clipDur(ref.clip)), `⚠ клип снят с уже запечённого: ${clipDur(got.clip).toFixed(2)} с против ${clipDur(ref.clip).toFixed(2)}`).toBeLessThan(0.1);
  });
});

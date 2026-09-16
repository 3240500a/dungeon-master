import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { buildHumanoid } from './humanoid.js';
import { PosePlayer, localStorageContent, emptyGrid, setLocoMixOverride } from './poseRuntime.js';
import { GAIT } from './pose.js';
import { bakeGaitToClip, bakeTurnSet, GAIT_PRESETS, TURN_PRESETS, BAKE_MAXSPD } from './clipBake.js';
import { clipDur, clipPoseAt, type Clip } from './clipModel.js';
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

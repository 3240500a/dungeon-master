import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { buildHumanoid, type Humanoid } from './humanoid.js';
import { type Pose } from './clipModel.js';
import {
  poseRig, settleLikePhysGhost, onionClipKey, clampPicks, shiftPicks, onionFrames, ghostShade, settleCacheKey,
  ONION_PAST, ONION_FUTURE, ONION_FADE_MIN, ONION_FADE_SPAN, ROOT_VIEW_ZERO,
} from './frameEdit.js';

/**
 * ⭐ ПРИЗРАКИ ПРОИЗВОЛЬНЫХ КАДРОВ (18.09.2026) — чистая часть.
 *
 * Автор: «хочу отмечать галочкой произвольные кадры в правом меню и держать их призраки на виду, числом
 * не ограничиваясь». Здесь проверяется ВЫБОР кадров (переживает вставку/удаление ключа и обрезку клипа),
 * ОТТЕНОК по расстоянию и КЭШ ОСЕДАНИЯ (ключ по содержимому + старт с известного сдвига). Проводку в
 * `pose-editor.ts` сторожат `onionOwner.test.ts` и `frameEditWiring.test.ts`, позу призрака — `rootPreview.test.ts`.
 */
const P = (o: Record<string, [number, number, number]>): Pose => o;

describe('выбор кадров под призраки', () => {
  it('ключ набора — персонаж + оружие + имя клипа (у каждого клипа выбор свой)', () => {
    const c = { name: 'hit_sword_r_01', character: 'knight_06', weapon: 'sword' };
    expect(onionClipKey(c)).toBe('knight_06|sword|hit_sword_r_01');
    expect(onionClipKey({ ...c, weapon: 'axe' })).not.toBe(onionClipKey(c));
    expect(onionClipKey({ ...c, character: 'rogue' })).not.toBe(onionClipKey(c));
    expect(onionClipKey({ ...c, name: 'run_fwd' })).not.toBe(onionClipKey(c));
  });

  it('⭐ при загрузке индексы зажимаются по длине клипа, мусор выбрасывается', () => {
    expect(clampPicks([0, 3, 3, 9, -1, 2.5, NaN], 5)).toEqual([0, 3]);
    expect(clampPicks([], 5)).toEqual([]);
    expect(clampPicks([0, 1], 0), 'клипа нет — показывать нечего').toEqual([]);
  });

  it('⭐ отметки переживают ВСТАВКУ кадра: те, что правее, едут вместе с ключами', () => {
    expect(shiftPicks([0, 2, 5], 2, 1)).toEqual([0, 3, 6]);   // вставили ключ на место 2
    expect(shiftPicks([0, 1], 5, 1), 'вставка правее — ничего не двигается').toEqual([0, 1]);
  });

  it('⭐ отметки переживают УДАЛЕНИЕ кадра: его отметка уходит, правые съезжают', () => {
    expect(shiftPicks([0, 2, 3, 5], 2, -1)).toEqual([0, 2, 4]);
    expect(shiftPicks([0, 1], 4, -1), 'удалили правее — ничего не двигается').toEqual([0, 1]);
    expect(shiftPicks([3], 3, -1), 'удалили ровно отмеченный — отметки не остаётся').toEqual([]);
  });

  it('⭐ показываем отмеченные ∪ соседи ±N; текущий кадр призраком НЕ дублируем', () => {
    // 10 кадров, стоим на 4-м, отмечены 0, 4 и 8
    expect(onionFrames([0, 4, 8], 4, 10, false, 1)).toEqual([0, 8]);
    expect(onionFrames([0, 4, 8], 4, 10, true, 1)).toEqual([0, 3, 5, 8]);
    expect(onionFrames([0, 4, 8], 4, 10, true, 3)).toEqual([0, 1, 7, 8]);
    expect(onionFrames([], 4, 10, true, 2), 'ничего не отмечено — прежнее поведение, ровно два соседа').toEqual([2, 6]);
    expect(onionFrames([], 4, 10, false, 2), 'режим «соседние» выключен и отметок нет — призраков нет').toEqual([]);
  });

  it('на концах клипа соседи зажимаются и не задваиваются — как было до пула', () => {
    expect(onionFrames([], 0, 5, true, 2), 'на первом кадре «назад» не показываем').toEqual([2]);
    expect(onionFrames([], 4, 5, true, 2), 'на последнем — «вперёд»').toEqual([2]);
    expect(onionFrames([], 1, 5, true, 3), 'зажим до 0, а не «нет соседа»').toEqual([0, 4]);
    expect(onionFrames([], 0, 1, true, 1), 'один кадр — призраков нет').toEqual([]);
  });

  it('⚠ отметка за концом укороченного клипа не доживает до показа (иначе падение на keys[i]!)', () => {
    expect(onionFrames([1, 7], 0, 3, false, 1)).toEqual([1]);
  });
});

describe('оттенок и прозрачность по расстоянию', () => {
  it('⭐ назад синий, вперёд оранжевый; ближний — в точности базовый цвет', () => {
    expect(ghostShade(-1).tint).toBe(ONION_PAST);
    expect(ghostShade(1).tint).toBe(ONION_FUTURE);
    expect(ghostShade(-1).alpha).toBeCloseTo(1, 9);
    expect(ghostShade(1).alpha).toBeCloseTo(1, 9);
  });

  it('⭐ дальше — бледнее, и не до нуля (иначе дальние призраки просто исчезнут)', () => {
    let prev = 2;
    for (let d = 1; d <= ONION_FADE_SPAN + 4; d++) {
      const a = ghostShade(d).alpha;
      expect(a, `d=${d}`).toBeLessThanOrEqual(prev + 1e-9);
      expect(a).toBeGreaterThanOrEqual(ONION_FADE_MIN - 1e-9);
      prev = a;
    }
    expect(ghostShade(ONION_FADE_SPAN + 1).alpha).toBeCloseTo(ONION_FADE_MIN, 9);
    expect(ghostShade(100).alpha, 'дальше полки — не бледнеет').toBeCloseTo(ONION_FADE_MIN, 9);
  });

  it('оттенок выцветает к нейтральному, но сторону видно до самого конца', () => {
    const near = new THREE.Color(ghostShade(1).tint), far = new THREE.Color(ghostShade(ONION_FADE_SPAN + 1).tint);
    expect(far.getHSL({ h: 0, s: 0, l: 0 }).s, 'дальний — приглушённый').toBeLessThan(near.getHSL({ h: 0, s: 0, l: 0 }).s);
    const farPast = new THREE.Color(ghostShade(-(ONION_FADE_SPAN + 1)).tint);
    expect(farPast.b, 'прошлое остаётся холоднее будущего даже на полке').toBeGreaterThan(far.b);
  });
});

// ── Кэш оседания ─────────────────────────────────────────────────────────────────────────────────

const RIG = 'rig-key';
const crouch = P({ LeftUpperLeg: [-0.1, 0, 0], RightUpperLeg: [-0.1, 0, 0], __hipsD: [0, -1.6, 0] });
/** Одна нога поднята выше порога опоры — как на любом кадре переноса в беге (там сдвиг таза ДЕРЖИТСЯ, а не считается). */
const oneLeg = P({ RightUpperLeg: [-1.2, 0, 0], RightLowerLeg: [1.4, 0, 0], __hipsD: [0, -0.8, 0] });
const world = (h: Humanoid, nm: string): THREE.Vector3 => { h.root.updateMatrixWorld(true); return h.bones.get(nm)!.getWorldPosition(new THREE.Vector3()); };
/** Поставить позу на свежий риг ровно так, как это делает `applyPoseTo` до оседания. */
function stand(p: Pose): Humanoid {
  const h = buildHumanoid(); poseRig(h, p); h.root.position.set(0, 0, 0); h.root.updateMatrixWorld(true); return h;
}

describe('кэш оседания призраков', () => {
  it('⭐ старт с известного сдвига = ОДИН шаг вместо 29/355, та же поза', () => {
    for (const lag of [15, 1]) {
      const cold = stand(crouch), r0 = settleLikePhysGhost(cold, lag);
      const warm = stand(crouch), r1 = settleLikePhysGhost(warm, lag, undefined, r0.off);
      expect(r0.steps, `холодный прогон при lag ${lag} должен реально итерировать`).toBeGreaterThan(10);
      expect(r1.steps, `тёплый прогон при lag ${lag}`).toBe(1);
      // ⚠ Не «бит в бит», а В ПРЕДЕЛАХ ТОГО ЖЕ ДОПУСКА: холодный прогон сам останавливается за `SETTLE_EPS` (1e-5)
      // до неподвижной точки, а тёплый делает от неё ещё шаг — и подходит ближе, а не дальше (замер: 4.9e-6).
      expect(Math.abs(r1.off - r0.off)).toBeLessThan(1e-5);
      for (const nm of cold.boneNames) expect(world(warm, nm).distanceTo(world(cold, nm)), nm).toBeLessThan(1e-4);
    }
  });

  it('⚠ НА ОДНОЙ ОПОРЕ чужой сдвиг из кэша ЗАЛИПАЕТ — поэтому ключ обязан быть содержательным', () => {
    // Две опорные стопы — итерация сама себя чинит: любой старт сходится в ту же точку (запас прочности).
    const a = stand(crouch), ref = settleLikePhysGhost(a, 15);
    const b = stand(crouch); settleLikePhysGhost(b, 15, undefined, ref.off + 1.5);
    expect(world(b, 'Hips').distanceTo(world(a, 'Hips')), 'две опоры: неверный старт сходится обратно').toBeLessThan(1e-3);
    // А на ОДНОЙ опоре (маховая нога — это половина кадров бега) `groundFeet` держит сдвиг КАК ЕСТЬ
    // (`holdIdle`): неверный старт остаётся на месте навсегда. Это и есть цена ошибки в ключе кэша.
    const c0 = stand(oneLeg), r0 = settleLikePhysGhost(c0, 15);
    const c1 = stand(oneLeg), r1 = settleLikePhysGhost(c1, 15, undefined, r0.off + 2);
    expect(r1.off).toBeCloseTo(r0.off + 2, 9);
    expect(world(c1, 'Hips').distanceTo(world(c0, 'Hips'))).toBeGreaterThan(1.9);
  });

  it('⭐ ключ меняется на всём, от чего результат зависит', () => {
    const base = settleCacheKey(crouch, RIG, 15, 0, ROOT_VIEW_ZERO);
    expect(settleCacheKey(crouch, RIG, 15, 0, ROOT_VIEW_ZERO), 'та же поза — тот же ключ').toBe(base);
    const moved = { ...crouch, __hipsD: [0, -2.2, 0] as [number, number, number] };
    expect(settleCacheKey(moved, RIG, 15, 0, ROOT_VIEW_ZERO), 'таз').not.toBe(base);
    const leg = { ...crouch, LeftLowerLeg: [0.4, 0, 0] as [number, number, number] };
    expect(settleCacheKey(leg, RIG, 15, 0, ROOT_VIEW_ZERO), 'нога').not.toBe(base);
    const legacy = { LeftUpperLeg: crouch['LeftUpperLeg']!, RightUpperLeg: crouch['RightUpperLeg']!, __hipsP: [0, 30, 0] as [number, number, number] };
    expect(settleCacheKey(legacy, RIG, 15, 0, ROOT_VIEW_ZERO), 'легаси-таз (__hipsP) тоже в ключе').not.toBe(settleCacheKey({ ...legacy, __hipsP: [0, 28, 0] as [number, number, number] }, RIG, 15, 0, ROOT_VIEW_ZERO));
    expect(settleCacheKey(crouch, 'other-rig', 15, 0, ROOT_VIEW_ZERO), 'рецепт рига').not.toBe(base);
    expect(settleCacheKey(crouch, RIG, 1, 0, ROOT_VIEW_ZERO), 'lag заземления').not.toBe(base);
    expect(settleCacheKey(crouch, RIG, 15, 1.4, ROOT_VIEW_ZERO), 'подъём стопы').not.toBe(base);
    expect(settleCacheKey(crouch, RIG, 15, 0, { yaw: 1.2, x: 0, z: 0 }), 'корень вида').not.toBe(base);
  });

  it('⭐ правка ПОЗЫ КАДРА кэш не «залипает»: ключ другой, и старый сдвиг был бы виден', () => {
    const k = (p: Pose): string => settleCacheKey(p, RIG, 15, 0, ROOT_VIEW_ZERO);
    // Мутация «кэшировать по имени клипа и номеру кадра» (а не по содержимому) подсунула бы старый сдвиг.
    const lifted = { ...oneLeg, __hipsD: [0, -2.6, 0] as [number, number, number] };
    expect(k(lifted), 'таз подняли — ключ обязан смениться').not.toBe(k(oneLeg));
    const was = settleLikePhysGhost(stand(oneLeg), 15).off + 1.7;   // «сдвиг с прошлой правки»
    const fresh = stand(lifted), rf = settleLikePhysGhost(fresh, 15);
    const stale = stand(lifted); settleLikePhysGhost(stale, 15, undefined, was);
    expect(Math.abs(rf.off - was), 'иначе тест пустой').toBeGreaterThan(0.5);
    expect(world(stale, 'Hips').y).not.toBeCloseTo(world(fresh, 'Hips').y, 3);
  });

  it('руки/голова в ключ не входят — и это правда: заземление их не видит', () => {
    const armed = { ...crouch, LeftUpperArm: [0.9, 0.2, -0.3] as [number, number, number], Head: [0.4, 0, 0] as [number, number, number] };
    expect(settleCacheKey(armed, RIG, 15, 0, ROOT_VIEW_ZERO)).toBe(settleCacheKey(crouch, RIG, 15, 0, ROOT_VIEW_ZERO));
    const a = stand(crouch), b = stand(armed);
    expect(settleLikePhysGhost(b, 15).off).toBeCloseTo(settleLikePhysGhost(a, 15).off, 9);
    for (const nm of ['LeftFoot', 'RightFoot', 'Hips']) expect(world(b, nm).y).toBeCloseTo(world(a, nm).y, 9);
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { resolveStancePose, type StanceLayerInfo } from './poseLayers.js';
import type { Pose } from './clipModel.js';
import { buildHumanoid } from './humanoid.js';
import { PoseDriver, GAIT, POSE } from './pose.js';
import { gaitToHumanoid, layerTrace, type PoseContent, type GXKnobs } from './poseRuntime.js';

/**
 * ИНСПЕКТОР СЛОЁВ НЕ ИМЕЕТ ПРАВА ВРАТЬ.
 *
 * У окна отладки спрос выше, чем у обычной панели: на него смотрят именно тогда, когда происходящее
 * непонятно, и верят ему больше, чем себе. Врущее окно уводит в неверную сторону надолго — дешевле
 * не иметь его вовсе.
 *
 * Отсюда два требования, и оба проверяются здесь. Первое: числа приходят ОТТУДА, где вес и считается,
 * а не пересчитываются заново на стороне окна (вторая правда разойдётся с первой молча). Второе:
 * выключенная трасса не собирает ни строки — иначе окно отладки платит кадром игры за то, что никто
 * не смотрит.
 */
const DT = 1 / 60;
const POSE0 = { ...POSE }, GAIT0 = { ...GAIT };
afterEach(() => { layerTrace.on = false; Object.assign(POSE, POSE0); Object.assign(GAIT, GAIT0); });

// ── Состав стойки ────────────────────────────────────────────────────────────────────────────────
const BASE: Pose = { RightUpperArm: [-0.2, 0, 0.3], LeftUpperArm: [-0.2, 0, -0.3], Chest: [0, 0, 0] };
const SWORD: Pose = { ...BASE, RightUpperArm: [-0.9, 0.2, 0.5] };
const SHIELD: Pose = { ...BASE, LeftUpperArm: [-1.1, -0.1, -0.6] };
// ⚠ Ключей ПАР («sword+shield») здесь нет нарочно: пока есть авторская поза на точный ключ, резолвер
// берёт её целиком и НИЧЕГО не собирает. Ровно это и проверяет последний тест раздела.
const POSES: Record<string, Pose> = { none: BASE, sword: SWORD, shield: SHIELD, dagger: SHIELD, greatsword2: SWORD };
const find = (_k: 'idle' | 'combat_idle', item: string): Pose | null => POSES[item] ?? null;

describe('состав стойки приходит из резолвера, а не пересчитывается', () => {
  it('меч + щит: две строки, каждая со своей рукой, типом и силой из конфига', () => {
    const trace: StanceLayerInfo[] = [];
    resolveStancePose(find, 'sword+shield', 0, { trace, weight: (i) => (i === 'shield' ? 0.4 : 0.9) }, 0);
    expect(trace).toEqual([
      { item: 'sword', hand: 'main', kind: 'additive', weight: 0.9 },
      { item: 'shield', hand: 'off', kind: 'additive', weight: 0.4 },
    ]);
  });

  it('двуручное — ОДНА строка «замена верха», офф-руки у него не бывает', () => {
    const trace: StanceLayerInfo[] = [];
    resolveStancePose(find, 'sword+shield', 0, { trace, kind: (i) => (i === 'sword' ? 'override' : 'additive') }, 0);
    expect(trace).toHaveLength(1);
    expect(trace[0]!.kind, 'override — то есть слой второй руки выключен').toBe('override');
  });

  it('рука берётся из КОНФИГА, а не из позиции в ключе: предмет главной руки уехал в левую', () => {
    const trace: StanceLayerInfo[] = [];
    resolveStancePose(find, 'sword+shield', 0, { trace, hand: (i) => (i === 'sword' ? 'off' : undefined) }, 0);
    expect(trace[0]!.item).toBe('sword');
    expect(trace[0]!.hand, 'конфиг сказал «в левую» — значит в левую').toBe('off');
  });

  it('ЕСТЬ авторская поза на точный ключ — не смешивается НИЧЕГО, и трасса пуста', () => {
    // Это не дыра, а ответ на вопрос «почему сила смешивания ни на что не влияет»: для такого ключа
    // автор задал стойку целиком, и слои в ней не участвуют. Пустая трасса это и показывает.
    const trace: StanceLayerInfo[] = [];
    const withPair = (k: 'idle' | 'combat_idle', item: string): Pose | null => (item === 'sword+shield' ? SWORD : find(k, item));
    resolveStancePose(withPair, 'sword+shield', 0, { trace }, 0);
    expect(trace).toHaveLength(0);
  });

  it('боевая стойка не удваивает состав — `one()` зовётся дважды, а предмет один', () => {
    const trace: StanceLayerInfo[] = [];
    resolveStancePose(find, 'sword+shield', 0.5, { trace }, 0);
    expect(trace).toHaveLength(2);
  });

  it('повторный вызов не копит: трасса очищается на входе', () => {
    const trace: StanceLayerInfo[] = [];
    for (let i = 0; i < 3; i++) resolveStancePose(find, 'sword+shield', 0, { trace }, 0);
    expect(trace).toHaveLength(2);
  });
});

// ── Строки слоёв ─────────────────────────────────────────────────────────────────────────────────
const stub = (up: boolean): PoseContent => ({ resolveUpper: () => (up ? { pose: BASE, swing: 0.5 } : null) });
const gx = (): GXKnobs => ({ armDown: 1.35, elbowBend: 0.25 });

function frame(legMag: number, moveMag: number, up = true): void {
  const h = buildHumanoid({});
  const d = new PoseDriver();
  let z = 0; let t = d.update(DT);
  for (let i = 0; i < 60; i++) { z += 115 * DT; d.setWorld(0, z, 0, 0, 115); t = d.update(DT); }
  h.reset();
  gaitToHumanoid(h, [], gx(), legMag, t, stub(up), 'none', { clip: null, t: -1 }, moveMag);
}

describe('строки слоёв', () => {
  it('выключенная трасса не собирает НИ ОДНОЙ строки — кадр игры за неё не платит', () => {
    layerTrace.on = false;
    layerTrace.rows.length = 0;
    frame(1, 1);
    expect(layerTrace.rows).toHaveLength(0);
  });

  it('порядок — снизу вверх по стеку, как в корне графа', () => {
    layerTrace.on = true;
    frame(1, 1);
    const order = layerTrace.rows.map((r) => r.layer);
    expect(order[0]).toBe('НОГИ / ТАЗ');
    expect(order.indexOf('ПОЗА ВЕРХА')).toBeGreaterThan(0);
    expect(order.indexOf('ПОЯС И СКРУТКА')).toBeGreaterThan(order.indexOf('ПОЗА ВЕРХА'));
    expect(order.indexOf('ДЕЙСТВИЕ')).toBe(order.length - 1);
  });

  it('вес ног — ТОТ САМЫЙ legMag, с которым ноги и легли', () => {
    layerTrace.on = true;
    frame(0.37, 1);
    expect(layerTrace.rows.find((r) => r.layer === 'НОГИ / ТАЗ')!.w).toBeCloseTo(0.37, 9);
  });

  it('вес позы верха падает по мере хода — ровно как её и блендит ретаргет', () => {
    layerTrace.on = true;
    frame(1, 0);
    const still = layerTrace.rows.find((r) => r.layer === 'ПОЗА ВЕРХА')!.w;
    frame(1, 1);
    const moving = layerTrace.rows.find((r) => r.layer === 'ПОЗА ВЕРХА')!.w;
    expect(still, 'стоим — ровно авторская стойка').toBeCloseTo(1, 9);
    expect(moving, 'идём — проступает мах (swing 0.5)').toBeCloseTo(0.5, 9);
  });

  it('нет авторской стойки — строка говорит об этом, а не показывает ноль молча', () => {
    layerTrace.on = true;
    frame(1, 1, false);
    const r = layerTrace.rows.find((x) => x.layer === 'ПОЗА ВЕРХА')!;
    expect(r.src.startsWith('нет'), 'окно красит такую строку красным').toBe(true);
    expect(r.note).toBeTruthy();
  });

  it('пустой слот действия виден как пустой, а не пропадает из списка', () => {
    layerTrace.on = true;
    frame(1, 1);
    const r = layerTrace.rows.find((x) => x.layer === 'ДЕЙСТВИЕ')!;
    expect(r.src).toBe('пусто');
    expect(r.w).toBe(0);
  });

  it('метка времени обновляется — по ней окно отличает живую трассу от застывшей', () => {
    layerTrace.on = true;
    layerTrace.t = 0;
    frame(1, 1);
    expect(layerTrace.t).toBeGreaterThan(0);
  });
});

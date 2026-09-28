/**
 * ⭐⭐ ЖИВАЯ СТОЙКА ПОД СТАТИЧНОЙ ПОЗОЙ ОРУЖИЯ.
 *
 * Жалоба владельца: «хочу, чтобы безоружный айдл работал, когда не в бою, и руки с оружием
 * подмешивались к нему». Без этого шва данными это не сделать В ПРИНЦИПЕ: у одноручного оружия ключ
 * точной стойки и ключ предмета — ОДНА И ТА ЖЕ строка (`splitHands('sword')` → `['sword','none']`),
 * поэтому `resolveStancePose` короткозамыкал сборку на авторской позе и тело с мечом вставало насмерть.
 */
import { describe, it, expect } from 'vitest';
import { resolveStancePose, type StanceLookup } from './poseLayers.js';
import { PosePlayer, emptyGrid, type PoseContent, type UpperPose } from './poseRuntime.js';
import { makeStand } from './parityHarness.js';
import type { Pose } from './clipModel.js';

/** Безоружная база: «дышит» — грудь и шея ходят по синусу, плюс смещение таза. */
const liveBase = (t: number): Pose => ({
  Hips: [0, 0, 0],
  Spine: [0.02 * Math.sin(t), 0, 0],
  Chest: [0.06 * Math.sin(t), 0, 0],
  Neck: [0.20 * Math.sin(t), 0, 0],
  LeftUpperArm: [0, 0, 0.05 * Math.sin(t)],
  RightUpperArm: [0, 0, -0.05 * Math.sin(t)],
  LeftUpperLeg: [0.01 * Math.sin(t), 0, 0],
  __hipsD: [0.5 * Math.sin(t), 0, 0],
  __swing: [1, 0, 0],            // служебный канал набора хода — в стойку попасть НЕ ДОЛЖЕН
  __rootY: [1.23, 0, 0],
});
/** Авторская поза меча — ОДИН кадр: рука с оружием, корпус чуть довёрнут. */
const swordPose: Pose = {
  Hips: [0, 0.1, 0],
  Spine: [0.3, 0, 0],
  Chest: [0.2, 0, 0],
  Neck: [0, 0, 0],
  RightUpperArm: [0.4, 0, 0.9],
  RightLowerArm: [0, 0, 1.1],
  __wpnMain: [0, 0.2, 0],
};

/** Резолвер: `none` — живая база, `sword` — статичная авторская поза. */
const look: StanceLookup = (kind, item, t) => (item === 'none' ? liveBase(t) : item === 'sword' ? swordPose : null);
const isLive = (_k: 'idle' | 'combat_idle', item: string): boolean => item === 'none';

/** Размах ключа позы за цикл (макс−мин по каждой из трёх компонент, наибольший), в градусах. */
function span(weapon: string, key: string, opts: Parameters<typeof resolveStancePose>[3] = {}): number {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 64; i++) {
    const p = resolveStancePose(look, weapon, 0, opts, (i / 64) * Math.PI * 2);
    const v = p?.[key];
    if (!v) continue;
    for (let j = 0; j < 3; j++) { lo[j] = Math.min(lo[j]!, v[j]!); hi[j] = Math.max(hi[j]!, v[j]!); }
  }
  return Math.max(...[0, 1, 2].map((j) => (Number.isFinite(lo[j]!) ? hi[j]! - lo[j]! : 0))) * 180 / Math.PI;
}

describe('живая стойка под статичной позой оружия', () => {
  it('⚠ БЕЗ поставщика `live` поведение прежнее БИТ В БИТ: с мечом тело стоит', () => {
    expect(span('sword', 'Chest'), 'старая ветка обязана остаться нетронутой').toBeCloseTo(0, 6);
    expect(span('sword', 'Neck')).toBeCloseTo(0, 6);
  });

  it('⭐⭐ СО швом дыхание базы доезжает до тела С ОРУЖИЕМ и НЕ СЖАТО', () => {
    const o = { live: isLive };
    const free = { chest: span('none', 'Chest'), neck: span('none', 'Neck'), leg: span('none', 'LeftUpperLeg') };
    expect(free.chest, 'контроль: безоружный дышит и без шва').toBeGreaterThan(6);
    expect(span('sword', 'Chest', o), 'грудь с мечом = грудь без оружия').toBeCloseTo(free.chest, 3);
    expect(span('sword', 'Neck', o), 'шея с мечом = шея без оружия').toBeCloseTo(free.neck, 3);
    expect(span('sword', 'LeftUpperLeg', o), 'ноги тоже живут — стойка это всё тело').toBeCloseTo(free.leg, 3);
  });

  it('⭐ ЯКОРЬ НЕ СДВИНУТ: на нуле цикла поза равна авторской бит в бит', () => {
    const p = resolveStancePose(look, 'sword', 0, { live: isLive }, 0)!;
    for (const k of ['Hips', 'Spine', 'Chest', 'RightUpperArm', 'RightLowerArm', '__wpnMain']) {
      const got = p[k]!, want = swordPose[k]!;
      for (let j = 0; j < 3; j++) expect(got[j], `${k}[${j}] уехал от авторской стойки`).toBeCloseTo(want[j]!, 6);
    }
  });

  it('⚠ СЛУЖЕБНЫЕ КАНАЛЫ НАБОРА ХОДА в стойку не пускаются, а смещение таза — пускается', () => {
    const p = resolveStancePose(look, 'sword', 0, { live: isLive }, 1.0)!;
    expect(p['__swing'], '⚠ канал опоры подменил бы опорную ногу').toBeUndefined();
    expect(p['__rootY'], '⚠ канал курса развернул бы персонажа').toBeUndefined();
    expect(span('sword', '__hipsD', { live: isLive }), 'смещение таза — часть дыхания').toBeGreaterThan(0);
  });

  it('ЖИВАЯ авторская стойка оружия ветку НЕ включает — автор главнее сборки', () => {
    const allLive = (): boolean => true;                      // и `sword` считается живым
    expect(span('sword', 'Chest', { live: allLive }), 'своя живая стойка оружия играется как есть').toBeCloseTo(0, 6);
  });

  it('БЕЗОРУЖНЫЙ случай шов не трогает: сборка и без него отдаёт живую базу', () => {
    expect(span('none', 'Chest', { live: isLive })).toBeCloseTo(span('none', 'Chest'), 6);
  });
});

/**
 * ⭐ СОБСТВЕННАЯ ФАЗА ЖИВОЙ СТОЙКИ. Пока стойки были однокадровыми, общие часы никому не мешали; с живой
 * стойкой стая, заспавненная одним тиком, озиралась бы ХОРОМ (голова ходит на 21–56°).
 * ⚠ Умолчание — НОЛЬ: на этом стоит запекание, оно обязано стартовать с нуля.
 */
describe('фаза живой стойки', () => {
  /** Контент с ЖИВОЙ стойкой: поза зависит от времени `t`, как многокадровый клип. */
  const liveContent = (): PoseContent => ({
    charId: 'warrior',
    resolveUpper: (_w: string, _c?: number, t = 0): UpperPose => ({
      swing: 0, pose: { Chest: [0.5 * Math.sin(t), 0, 0], Hips: [0, 0, 0] },
    }),
  } as unknown as PoseContent);
  const chestAt = (phase: number): number => {
    const st = makeStand({ content: liveContent(), grid: emptyGrid(), mix: 1 });
    st.player.setIdlePhase(phase);
    const f = st.run({ vz: 0, frames: 1 });
    const q = f[f.length - 1]!.local.get('Chest')!;
    st.dispose();
    return q.x;
  };

  it('⭐⭐ ДВЕ КУКЛЫ С РАЗНОЙ ФАЗОЙ стоят по-разному — стая не озирается хором', () => {
    const a = chestAt(0), b = chestAt(1.6);
    expect(Math.abs(a - b), `фаза не развела кукол: ${a} против ${b}`).toBeGreaterThan(1e-3);
  });

  it('умолчание — НОЛЬ: запекание обязано стартовать с нуля', () => {
    // Сравниваем с ЯВНО выставленным нулём, а не с абсолютным числом: поза проходит через весь конвейер,
    // и её значение зависит от ручек. Инвариант же ровно один — «не звали ручку» ≡ «выставили 0».
    const st = makeStand({ content: liveContent(), grid: emptyGrid(), mix: 1 });
    const dflt = st.run({ vz: 0, frames: 1 });
    st.dispose();
    expect(Math.abs(dflt[dflt.length - 1]!.local.get('Chest')!.x - chestAt(0)), 'умолчание разошлось с явным нулём').toBeLessThan(1e-9);
  });

  it('⚠ СБРОС возвращает в СВОЮ фазу, а не в ноль — иначе стая снова сойдётся', () => {
    const body = String(Object.getOwnPropertyDescriptor(PosePlayer.prototype, 'resetGaitState')?.value ?? '');
    expect(body, 'сброс обязан класть idlePhase0, а не литеральный 0').toMatch(/idleT = this\.idlePhase0/);
  });
});

import { describe, it, expect } from 'vitest';
import { soundForMark } from './animSfx.js';
import { marksInRange, type Clip, type MarkEvent } from './clipModel.js';

/**
 * ⭐⭐ МЕТКИ ЗВУКОВОЙ ДОРОЖКИ ОБЯЗАНЫ ЧТО-ТО ДЕЛАТЬ.
 *
 * Вопрос был прямой: «работают ли метки?». Ответ на момент проверки — ЧАСТИЧНО: `impact` и `windup`
 * читались (момент урона и старт цепочки), а вся звуковая дорожка (`swing`, `sfx`, `footstep`) шла в
 * `PosePlayer.onMark`, у которого НЕ БЫЛО НИ ОДНОГО ПОДПИСЧИКА — проверено поиском по всему клиенту.
 * Разметка взмаха была работой в стол.
 *
 * Синтез звука тестом не проверить, а вот РЕШЕНИЕ «что и когда звучит» — можно, и ломается оно молча.
 */
describe('метка → звук', () => {
  const clip = (marks: { t: number; type: string; dur?: number }[]): Clip => ({
    name: 'hit_sword_r_01', character: 'warrior', weapon: 'sword', loop: false,
    keys: marks.map((m) => ({ t: m.t, pose: {}, marks: [{ type: m.type, ...(m.dur !== undefined ? { dur: m.dur } : {}) }] })),
  } as unknown as Clip);
  /** События, пройденные за весь клип. */
  const all = (c: Clip, to = 9): MarkEvent[] => marksInRange(c, -1e-9, to);

  it('⭐ УДАР звучит один раз, в точке метки', () => {
    const ev = all(clip([{ t: 0.45, type: 'impact' }]));
    const snd = ev.map(soundForMark).filter(Boolean);
    expect(snd.length, '⚠ удар прозвучал не один раз').toBe(1);
    expect(snd[0]!.kind).toBe('hit');
  });

  it('⭐⭐ ВЖУХ ДЛИТСЯ РОВНО СТОЛЬКО, СКОЛЬКО РАЗМЕЧЕН ВЗМАХ', () => {
    // ⚠ Мутация «фиксированная длительность» валит это: на клипе другого темпа свист разошёлся бы с движением.
    for (const d of [0.133, 0.268]) {
      const ev = all(clip([{ t: 0.32, type: 'swing', dur: d }]));
      const snd = ev.map(soundForMark).filter(Boolean);
      expect(snd.length, `⚠ на отрезке взмаха ${d} с прозвучало ${snd.length} звук(ов)`).toBe(1);
      expect(snd[0]!.kind).toBe('whoosh');
      expect(snd[0]!.dur, '⚠ длительность вжуха не взята из метки').toBeCloseTo(d, 6);
    }
  });

  it('⚠ КОНЕЦ ОТРЕЗКА — ТИШИНА, а не второй свист', () => {
    // ⚠ Мутация «озвучивать любую фазу» валит это: `marksInRange` даёт и `begin`, и `end`.
    const ev = all(clip([{ t: 0.3, type: 'swing', dur: 0.2 }]));
    expect(ev.map((e) => e.phase), 'событий обязано быть два — начало и конец').toEqual(['begin', 'end']);
    expect(soundForMark(ev[1]!), '⚠ конец взмаха тоже зазвучал').toBe(null);
  });

  it('⭐⭐ ЗАМАХ И ВЗМАХ ВМЕСТЕ — СВИСТИТ ОДИН РАЗ', () => {
    // ⚠ Мутация «убрать проверку соседних меток» валит это: на клипе с обеими метками свистело бы дважды.
    const c = clip([{ t: 0.1, type: 'windup' }, { t: 0.32, type: 'swing', dur: 0.15 }]);
    const whoosh = all(c).map(soundForMark).filter((s) => s?.kind === 'whoosh');
    expect(whoosh.length, '⚠ двойной свист на одном ударе').toBe(1);
    expect(whoosh[0]!.dur, '⚠ уцелел не тот звук: длительность обязана быть от ВЗМАХА').toBeCloseTo(0.15, 6);
  });

  it('⭐ размечен ТОЛЬКО замах — он и свистит (иначе удар был бы немой)', () => {
    const whoosh = all(clip([{ t: 0.1, type: 'windup' }])).map(soundForMark).filter(Boolean);
    expect(whoosh.length).toBe(1);
    expect(whoosh[0]!.kind).toBe('whoosh');
  });

  it('живой клип воина: взмах + удар + окно комбо = ровно вжух и удар', () => {
    // Разметка снята с реального `hit_none_r_01` пользователя.
    const c = clip([{ t: 0.12, type: 'combo', dur: 0.8 }, { t: 0.32, type: 'swing', dur: 0.133 }, { t: 0.453, type: 'impact' }]);
    const snd = all(c).map(soundForMark).filter(Boolean);
    expect(snd.map((s) => s!.kind), '⚠ порядок или состав звуков не тот').toEqual(['whoosh', 'hit']);
  });

  it('окно комбо само по себе молчит — это геймплей, а не звук', () => {
    expect(all(clip([{ t: 0.1, type: 'combo', dur: 0.5 }])).map(soundForMark).filter(Boolean).length).toBe(0);
  });

  it('⚠ вжух не бывает мгновенным и бесконечным — длительность зажата', () => {
    expect(soundForMark(all(clip([{ t: 0.1, type: 'swing', dur: 0.001 }]))[0]!)!.dur).toBeGreaterThanOrEqual(0.06);
    expect(soundForMark(all(clip([{ t: 0.1, type: 'swing', dur: 99 }]))[0]!)!.dur).toBeLessThanOrEqual(0.8);
  });
});

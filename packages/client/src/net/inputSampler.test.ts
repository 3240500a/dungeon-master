import { describe, it, expect } from 'vitest';
import { InputSampler, type HeldInput } from './inputSampler.js';

/**
 * ⭐ L2: ВВОД ВЕБ-3D — С ЧАСТОТОЙ ТИКА И С ПЕРЕНОСОМ ОСТАТКА, КАК У 2D. `online3d` копил время кадров и на отправке
 * ОБНУЛЯЛ счётчик (`inputAcc = 0`): при 60 Гц с дрожью кадра два кадра давали то 33.7 мс (шлём), то 32.9 (ждём третий),
 * и ввод шёл то 30, то 20 раз в секунду. И фронт нажатия он считал только в кадр отправки: удар или рывок, нажатый и
 * отпущенный между отправками, терялся. Теперь оба клиента ведёт один `InputSampler` (внутри — `InputPacer` 2D):
 * удержания сэмплируются каждый кадр, фронт уходит в том же кадре, остаток периода переносится.
 */
const binds = { mouseLeft: 'attack', mouseRight: 'fireball', hotbar: ['aura-might', 'dash', null] as (string | null)[] };
const toggles = new Set(['aura-might']);
const isToggle = (id: string): boolean => toggles.has(id);
const idle = (): HeldInput => ({ L: false, R: false, S: false, Q: false, A: false, dodge: false, interact: false });

/** Прогнать кадры и собрать отправленное. */
function run(s: InputSampler, frames: { dt: number; held?: Partial<HeldInput> }[]) {
  const sent: ReturnType<InputSampler['frame']>[] = [];
  const all: ReturnType<InputSampler['frame']>[] = [];
  for (const f of frames) {
    const r = s.frame(f.dt, binds, { ...idle(), ...f.held }, isToggle);
    all.push(r);
    if (r.due) sent.push(r);
  }
  return { sent, all };
}

describe('⭐ L2: InputSampler — ввод обоих клиентов с частотой тика', () => {
  it('144 Гц: за секунду не больше 31 кадра ввода и не меньше 29', () => {
    const { sent } = run(new InputSampler(), Array.from({ length: 144 }, () => ({ dt: 1000 / 144 })));
    expect(sent.length).toBeLessThanOrEqual(31);
    expect(sent.length).toBeGreaterThanOrEqual(29);
  });

  it('⭐ 60 Гц с дрожью кадра — 30 в секунду (остаток переносится; с обнулением было бы ~20)', () => {
    const frames = Array.from({ length: 120 }, (_, i) => ({ dt: 1000 / 60 + (i % 2 ? 0.4 : -0.4) }));
    expect(run(new InputSampler(), frames).sent.length).toBeGreaterThanOrEqual(58);
    // Два кадра чуть короче периода (33.2 мс < 33.3): обнуление ждало третий кадр на КАЖДОЙ отправке — 20 Гц вместо 30.
    const slow = Array.from({ length: 120 }, () => ({ dt: 16.6 }));
    expect(run(new InputSampler(), slow).sent.length, 'обнуление дало бы 40 (каждый третий кадр)').toBeGreaterThanOrEqual(59);
  });

  it('⭐ фронт рывка уходит в ТОМ ЖЕ кадре, между отправками; удержание его не повторяет', () => {
    const s = new InputSampler();
    run(s, [{ dt: 7 }]);                                            // первый кадр — сразу
    const { sent } = run(s, [{ dt: 7, held: { dodge: true } }, ...Array.from({ length: 20 }, () => ({ dt: 7, held: { dodge: true } }))]);
    expect(sent[0]!.dodge, 'кадр нажатия отправлен без ожидания периода').toBe(true);
    expect(sent.slice(1).every((r) => !r.dodge), 'удержание — не новый рывок').toBe(true);
  });

  it('⭐ удар, нажатый и отпущенный между отправками, не теряется', () => {
    const s = new InputSampler();
    run(s, [{ dt: 7 }]);                                            // отправка
    const { sent } = run(s, [{ dt: 7, held: { L: true } }, { dt: 7 }, { dt: 7 }]);
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(sent[0]!.attack, 'было (веб-3D): кадр нажатия ждал периода, а к нему кнопку уже отпустили').toBe(true);
  });

  it('тогл (аура) — только по фронту; обычный каст — по удержанию; атака видна каждый кадр (кукле — «зажато»)', () => {
    const s = new InputSampler();
    const { sent: t } = run(s, Array.from({ length: 30 }, () => ({ dt: 1000 / 60, held: { S: true } })));
    expect(t[0]!.cast).toBe('aura-might');
    expect(t.slice(1).every((r) => r.cast === null), 'удержание ауры не переключает её каждый тик').toBe(true);
    const { sent: c } = run(new InputSampler(), Array.from({ length: 30 }, () => ({ dt: 1000 / 60, held: { R: true } })));
    expect(c.every((r) => r.cast === 'fireball')).toBe(true);
    const { all } = run(new InputSampler(), Array.from({ length: 10 }, () => ({ dt: 1000 / 144, held: { L: true } })));
    expect(all.every((r) => r.attack), 'и в кадры без отправки').toBe(true);
    expect(all.filter((r) => r.due).length).toBeLessThan(all.length);
  });

  it('[E]: фронт — сразу, удержание — в каждой отправке (подбор сервер сэмплит каждый тик)', () => {
    const s = new InputSampler();
    run(s, [{ dt: 7 }]);
    const { sent } = run(s, [{ dt: 7, held: { interact: true } }, ...Array.from({ length: 10 }, () => ({ dt: 7, held: { interact: true } }))]);
    expect(sent[0]!.interact).toBe(true);
    expect(sent.every((r) => r.interact)).toBe(true);
  });

  it('пустой слот не шлёт ничего и фронтом не считается', () => {
    const s = new InputSampler();
    run(s, [{ dt: 7 }]);
    const { sent } = run(s, [{ dt: 7, held: { A: true } }]);       // hotbar[2] = null
    expect(sent).toEqual([]);
  });
});

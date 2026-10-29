import { describe, it, expect } from 'vitest';
import { impactSec, markSec, marksInRange, migrateClip, MARK_TRACK, isRangeMark, type Clip, type Mark, type Pose } from './clipModel.js';
import { flipClip, mirrorClip } from './poseLibrary.js';
import { trimClip } from './clipImport.js';

const P: Pose = { Spine: [0, 0, 0] };
const clip = (keys: { t: number; marks?: Mark[] }[]): Clip =>
  ({ name: 'c', character: 'ch', weapon: 'w', loop: false, keys: keys.map((k) => ({ t: k.t, pose: { ...P }, marks: k.marks })) });

describe('метки — модель', () => {
  it('дорожка выводится из типа: удар бьёт в геймплей, взмах — в звук, эффект — в vfx', () => {
    expect(MARK_TRACK['impact']).toBe('gameplay');
    expect(MARK_TRACK['swing']).toBe('audio');
    expect(MARK_TRACK['vfx']).toBe('vfx');
    expect(MARK_TRACK['camshake']).toBe('camera');
  });

  it('отрезок = заданный dur; без него метка точечная', () => {
    expect(isRangeMark({ type: 'swing', dur: 0.2 })).toBe(true);
    expect(isRangeMark({ type: 'impact' })).toBe(false);
    expect(isRangeMark({ type: 'swing', dur: 0 })).toBe(false);
  });

  it('удар и секции читаются по времени первого помеченного ключа', () => {
    const c = clip([{ t: 0 }, { t: 0.3, marks: [{ type: 'windup' }] }, { t: 0.55, marks: [{ type: 'impact', sfx: 'hit', vfx: 'spark' }] }, { t: 0.9 }]);
    expect(impactSec(c)).toBeCloseTo(0.55);
    expect(markSec(c, 'windup')).toBeCloseTo(0.3);
    expect(markSec(c, 'combo')).toBeNull();
    expect(impactSec(clip([{ t: 0 }]))).toBeNull();
  });

  it('удар несёт СВОИ звук и эффект — три метки на кадр не нужны', () => {
    const c = clip([{ t: 0.4, marks: [{ type: 'impact', sfx: 'hit_flesh', vfx: 'spark_metal' }] }]);
    const m = c.keys[0]!.marks![0]!;
    expect(m.sfx).toBe('hit_flesh'); expect(m.vfx).toBe('spark_metal');
    expect(c.keys[0]!.marks!.length).toBe(1);
  });

  it('метки ПЕРЕЖИВАЮТ миграцию клипа (она пересобирает поля по явному списку)', () => {
    const c = clip([{ t: 0.2, marks: [{ type: 'impact', sfx: 'x' }] }]);
    const back = migrateClip(JSON.parse(JSON.stringify(c)));
    expect(back.keys[0]!.marks?.[0]?.sfx).toBe('x');
  });
});

describe('метки — поиск по пройденному интервалу', () => {
  const c = clip([
    { t: 0, marks: [{ type: 'windup' }] },
    { t: 0.2, marks: [{ type: 'swing', sfx: 'whoosh', vfx: 'trail', dur: 0.3 }] },
    { t: 0.4, marks: [{ type: 'impact', sfx: 'hit', vfx: 'spark' }, { type: 'camshake', num: 1.4 }] },
    { t: 0.8, marks: [{ type: 'footstep', foot: 'L' }] },
  ]);

  it('метка на t=0 срабатывает на первом же кадре', () => {
    const e = marksInRange(c, -1e-9, 0.05);
    expect(e.map((x) => x.mark.type)).toEqual(['windup']);
  });

  it('отрезок даёт begin на ключе и end через dur — ровно по разу', () => {
    const all = [...marksInRange(c, -1e-9, 0.3), ...marksInRange(c, 0.3, 0.6)];
    const sw = all.filter((x) => x.mark.type === 'swing');
    expect(sw.map((x) => x.phase)).toEqual(['begin', 'end']);
    expect(sw[1]!.t).toBeCloseTo(0.5);
  });

  it('БОЛЬШОЙ ШАГ (сжатый тайм-варпом клип) метки не теряет', () => {
    const e = marksInRange(c, -1e-9, 1);
    expect(e.map((x) => x.mark.type)).toEqual(['windup', 'swing', 'impact', 'camshake', 'swing', 'footstep']);
    expect(e.map((x) => x.t)).toEqual([0, 0.2, 0.4, 0.4, 0.5, 0.8]);   // отсортировано по времени
  });

  it('пустой и обратный интервал не дают ничего (дребезг не создаёт дублей)', () => {
    expect(marksInRange(c, 0.4, 0.4)).toEqual([]);
    expect(marksInRange(c, 0.6, 0.2)).toEqual([]);
  });

  it('интервал полуоткрыт: граница не срабатывает дважды подряд', () => {
    const a = marksInRange(c, -1e-9, 0.4), b = marksInRange(c, 0.4, 0.9);
    expect(a.filter((x) => x.mark.type === 'impact')).toHaveLength(1);
    expect(b.filter((x) => x.mark.type === 'impact')).toHaveLength(0);
  });
});

describe('метки — операции над клипом', () => {
  it('переворот клипа меняет ногу у шага (перевёрнутый шаг делает ДРУГАЯ нога)', () => {
    const f = flipClip(clip([{ t: 0, marks: [{ type: 'footstep', foot: 'L' }] }]));
    expect(f.keys[0]!.marks![0]!.foot).toBe('R');
    expect(flipClip(f).keys[0]!.marks![0]!.foot).toBe('L');   // двойной переворот = тождество
  });

  it('переворот/зеркало КОПИРУЮТ метки, а не делят ссылку с исходником', () => {
    const c = clip([{ t: 0, marks: [{ type: 'impact', sfx: 'a' }] }]);
    for (const out of [flipClip(c), mirrorClip(c)]) {
      out.keys[0]!.marks![0]!.sfx = 'b';
      expect(c.keys[0]!.marks![0]!.sfx).toBe('a');
    }
  });

  it('прочие метки переворот не трогает', () => {
    const f = flipClip(clip([{ t: 0, marks: [{ type: 'impact', sfx: 'hit', vfx: 'spark' }] }]));
    expect(f.keys[0]!.marks![0]).toEqual({ type: 'impact', sfx: 'hit', vfx: 'spark' });
  });

  it('обрезка уносит метки вместе с уцелевшими ключами', () => {
    const c = clip([{ t: 0 }, { t: 0.5, marks: [{ type: 'impact' }] }, { t: 1 }]);
    expect(impactSec(trimClip(c, 0.25, 0.75))).toBeCloseTo(0.25);   // время съехало вместе с ключом
    expect(impactSec(trimClip(c, 0.6, 1))).toBeNull();              // ключ не попал в окно — метки нет
  });
});

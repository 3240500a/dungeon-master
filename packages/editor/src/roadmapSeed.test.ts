import { describe, it, expect } from 'vitest';
import { SEED, SEED_REV, migrateRoadmap } from './roadmapSeed.js';
import type { RoadmapDoc } from './roadmapModel.js';

/**
 * Правки наполнения доезжают до УЖЕ открытой копии роадмапа. Копия правлена человеком (галки, даты,
 * свои формулировки), поэтому главное здесь — что правка трогает только названное и ровно один раз.
 */

/** Копия «как у пользователя»: старый снимок без ревизии, с собственными правками. */
const oldCopy = (): RoadmapDoc => {
  const d = SEED();
  delete d.seedRev;
  delete d.public;
  for (const m of d.milestones) for (const it of m.items) { delete it.note; if (['m2-11', 'm3-15', 'm3-19', 'm3-20'].includes(it.id)) it.done = false; }
  for (const m of d.milestones) m.items = m.items.filter((it) => it.id !== 'm3-19' && it.id !== 'm3-20');
  return d;
};
const item = (d: RoadmapDoc, id: string) => d.milestones.flatMap((m) => m.items).find((x) => x.id === id);

describe('правки наполнения', () => {
  it('свежий сид уже доведён до последней ревизии — повторно ничего не применяется', () => {
    const d = SEED();
    expect(d.seedRev).toBe(SEED_REV);
    expect(migrateRoadmap(d)).toBe(false);
  });

  it('старая копия получает сделанное, заметки, новые пункты и роадмап для игроков — один раз', () => {
    const d = oldCopy();
    expect(migrateRoadmap(d)).toBe(true);
    expect(item(d, 'm3-15')?.done).toBe(true);
    expect(item(d, 'm3-15')?.note).toMatch(/сделано/);
    expect(item(d, 'm3-19')?.done, 'сделанное сверх плана добавлено').toBe(true);
    expect(d.public?.stages.length).toBeGreaterThan(0);
    expect(d.seedRev).toBe(SEED_REV);
    const snapshot = JSON.stringify(d);
    expect(migrateRoadmap(d), 'второй раз — ничего').toBe(false);
    expect(JSON.stringify(d)).toBe(snapshot);
  });

  it('⚠ своё не затирается: формулировка, заметка, свой роадмап для игроков, удалённый пункт', () => {
    const d = oldCopy();
    item(d, 'm2-11')!.title = 'моя формулировка';
    item(d, 'm3-15')!.note = 'моя заметка';
    d.public = { title: 'мой', intro: '', disclaimer: '', stages: [] };
    for (const m of d.milestones) m.items = m.items.filter((it) => it.id !== 'm3-16');
    migrateRoadmap(d);
    expect(item(d, 'm2-11')!.title).toBe('моя формулировка');
    expect(item(d, 'm3-15')!.note).toBe('моя заметка');
    expect(d.public.title).toBe('мой');
    expect(item(d, 'm3-16'), 'удалённое руками не воскресает').toBeUndefined();
  });

  it('частично сделанное получает заметку, но не галку', () => {
    const d = oldCopy();
    migrateRoadmap(d);
    expect(item(d, 'm2-3')?.done).toBeFalsy();
    expect(item(d, 'm2-3')?.note).toMatch(/частично/);
  });
});

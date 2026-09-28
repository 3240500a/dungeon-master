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

/**
 * ⭐ ПРАВКА 3 (28.09.2026). Проверяем ровно то, на чём такая правка ломается: новый пункт должен появиться
 * ДО того, как его отмечают сделанным, переименование не должно трогать СВОЮ формулировку автора, а
 * заметка — свою заметку.
 */
describe('правка 28.09: заморозка поз-редактора и ковка', () => {
  const fresh = (): RoadmapDoc => { const d = oldCopy(); migrateRoadmap(d); return d; };

  it('⭐⭐ ПОЗ-РЕДАКТОР: пункт переименован и отмечен, а открытые места названы в заметке', () => {
    const d = fresh();
    const it = item(d, 'm1-5');
    expect(it?.done, 'заморожен').toBe(true);
    expect(it?.title, 'обещание «осталось 1–2 недели» из названия убрано').not.toMatch(/1–2 недели/);
    expect(it?.title).toMatch(/28\.09\.2026/);
    expect(it?.note, 'решение принято с открытыми глазами — хвосты названы').toMatch(/ОСТАЛОСЬ ОТКРЫТЫМ/);
    expect(it?.note, 'и сказано, что зелёные тесты их не закрывают').toMatch(/сторож равняется на планировщик/);
  });

  it('⭐ НОВЫЙ ПУНКТ добавляется ДО отметки — иначе `markDone` промахнётся мимо несуществующего', () => {
    const d = fresh();
    for (const id of ['m1-6', 'm3-21', 'm3-22', 'm3-23']) {
      expect(item(d, id), `пункт ${id} обязан появиться`).toBeTruthy();
      expect(item(d, id)?.done, `пункт ${id} обязан быть отмечен`).toBe(true);
    }
    expect(item(d, 'm11-5')?.done, 'прод-сервер — работа впереди, галки быть не должно').toBeFalsy();
    expect(item(d, 'm19-9'), 'босс третьего биома добавлен').toBeTruthy();
  });

  it('⚠ СВОЮ формулировку и свою заметку автора правка НЕ ТРОГАЕТ', () => {
    const d = oldCopy();
    const mine = d.milestones.flatMap((m) => m.items).find((x) => x.id === 'm1-5')!;
    mine.title = 'моё название'; mine.note = 'моя заметка';
    migrateRoadmap(d);
    expect(item(d, 'm1-5')?.title, 'переименование не затирает своё').toBe('моё название');
    expect(item(d, 'm1-5')?.note, 'заметка не затирает свою').toBe('моя заметка');
    expect(item(d, 'm1-5')?.done, 'но галка ставится — это факт, а не формулировка').toBe(true);
  });

  it('заметки без галки остаются без галки', () => {
    const d = fresh();
    for (const id of ['m2-4', 'm2-6', 'm3-3', 'm3-5', 'm3-8']) {
      expect(item(d, id)?.note, `у ${id} обязана быть заметка сверки`).toMatch(/Сверка 28\.09|сверка 28\.09/i);
    }
    expect(item(d, 'm3-3')?.done, 'частичное не отмечается').toBeFalsy();
  });
});

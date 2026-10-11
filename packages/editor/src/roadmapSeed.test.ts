import { describe, it, expect } from 'vitest';
import { BASE_SEED, SEED, SEED_PATCHES, SEED_REV, migrateRoadmap } from './roadmapSeed.js';
import { autoClose, milestoneProgress, type RoadmapDoc } from './roadmapModel.js';

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
    // С правки 4 строки сверки ДОПИСЫВАЮТСЯ (`addNote`) — своя заметка остаётся целиком и первой.
    expect(item(d, 'm1-5')?.note?.split('\n')[0], 'заметка не затирает свою').toBe('моя заметка');
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

/**
 * ⭐ ПРАВКА 4 (11.10.2026). Копия у пользователя уже на ревизии 3, и почти у всех пунктов, которых касается
 * сверка, заметка уже есть — `noteOnly` их молча пропустил бы. Поэтому строки ДОПИСЫВАЮТСЯ, и проверяем
 * именно это: старое на месте, новое дописано, второй прогон ничего не удваивает, закрытая м01 не переоткрыта.
 */
describe('правка 11.10: Unity — основной клиент', () => {
  /** Копия «как у пользователя до 11.10»: снимок + правки 2–3, ревизия 3. */
  const rev3Copy = (): RoadmapDoc => {
    const d = BASE_SEED();
    for (const p of SEED_PATCHES) if (p.rev <= 3) p.apply(d);
    d.seedRev = 3;
    return d;
  };
  const migrated = (): RoadmapDoc => { const d = rev3Copy(); migrateRoadmap(d); return d; };
  const rev4 = SEED_PATCHES.find((p) => p.rev === 4)!;
  const ms = (d: RoadmapDoc, id: string) => d.milestones.find((m) => m.id === id)!;

  it('правка 4 — последняя ревизия, и свежий сид её уже содержит', () => {
    expect(rev4, 'правка 4 есть').toBeTruthy();
    expect(SEED_REV).toBe(4);
    expect(item(SEED(), 'm1-7')?.done).toBe(true);
    expect(item(SEED(), 'm2-23')?.done).toBe(true);
  });

  it('новые пункты появились с верными галками и заметками', () => {
    const d = migrated();
    for (const id of ['m1-7', 'm2-18', 'm2-19', 'm2-21', 'm2-22', 'm2-23', 'm2-24', 'm3-24']) {
      expect(item(d, id), `пункт ${id} обязан появиться`).toBeTruthy();
      expect(item(d, id)?.done, `пункт ${id} сделан`).toBe(true);
      expect(item(d, id)?.note, `у ${id} заметка с датой`).toMatch(/\d\d\.10/);
    }
    for (const id of ['m4-12', 'm11-6']) {
      expect(item(d, id), `пункт ${id} обязан появиться`).toBeTruthy();
      expect(item(d, id)?.done, `${id} — работа впереди, без галки`).toBeFalsy();
    }
    expect(ms(d, 'м01').items.some((x) => x.id === 'm1-7'), 'паритет Unity — в закрытой м01').toBe(true);
    expect(item(d, 'm2-20'), 'в м02 паритета нет').toBeUndefined();
    expect(item(d, 'm2-23')?.note, 'туман: коммит наборов и слияние в main').toMatch(/9beea26[\s\S]*77ed285/);
    expect(item(d, 'm2-24')?.note, 'камера: старт на дальнем и скрытие стен').toMatch(/3ba84b5[\s\S]*95\/230[\s\S]*f4eae62/);
    expect(item(d, 'm4-12')?.note, 'фон экрана загрузки назван').toMatch(/Smoke & Ember FX/);
  });

  it('⚠ м01 остаётся на 100 % и не теряет дату закрытия', () => {
    const d = rev3Copy();
    ms(d, 'м01').closedAt = '2026-09-28';
    expect(milestoneProgress(ms(d, 'м01'), {}).ratio, 'до правки').toBe(1);
    migrateRoadmap(d);
    expect(milestoneProgress(ms(d, 'м01'), {}).ratio, 'после правки').toBe(1);
    autoClose(d, { now: Date.parse('2026-10-11') });
    expect(ms(d, 'м01').closedAt, 'дата закрытия не стёрта и не переписана').toBe('2026-09-28');
    expect(milestoneProgress(ms(SEED(), 'м01'), {}).ratio, 'свежий сид — тоже 100 %').toBe(1);
  });

  it('⭐ m2-9 отмечен, а к заметке 28.09 строки ДОПИСАНЫ, не затирая её', () => {
    const before = item(rev3Copy(), 'm2-9')!;
    expect(before.done, 'до правки атмосфера открыта').toBeFalsy();
    expect(before.note, 'у m2-9 уже есть заметка 28.09 — `noteOnly` её бы пропустил').toMatch(/Сверка 28\.09/);
    const after = item(migrated(), 'm2-9')!;
    expect(after.done).toBe(true);
    expect(after.note!.startsWith(before.note! + '\n'), 'старая заметка целиком и первой').toBe(true);
    expect(after.note).toMatch(/Сверка 11\.10/);
    expect(after.note).toMatch(/Владелец принял 11\.10/);
    expect(after.note).toMatch(/f4eae62/);
  });

  it('своя заметка автора остаётся, строка сверки дописывается под ней', () => {
    const d = rev3Copy();
    item(d, 'm2-7')!.note = 'моя заметка';
    migrateRoadmap(d);
    const lines = item(d, 'm2-7')!.note!.split('\n');
    expect(lines[0]).toBe('моя заметка');
    expect(lines[1]).toMatch(/^Сверка 11\.10/);
  });

  it('второй прогон миграции — ничего, и повтор самой правки ничего не удваивает', () => {
    const d = migrated();
    const snapshot = JSON.stringify(d);
    expect(migrateRoadmap(d), 'ревизия уже 4').toBe(false);
    expect(JSON.stringify(d)).toBe(snapshot);
    rev4.apply(d);   // мимо `seedRev`: addItem / addNote / appendDesc сами обязаны не дублировать
    expect(JSON.stringify(d), 'повтор правки 4 — без изменений').toBe(snapshot);
  });

  it('appendDesc дописывает абзац к описанию вехи один раз и не трогает прежний текст', () => {
    const base = rev3Copy();
    const d = migrated();
    rev4.apply(d);
    for (const id of ['м04', 'м06']) {
      const desc = ms(d, id).desc!;
      expect(desc.startsWith(ms(base, id).desc! + '\n\n'), `${id}: прежнее описание целиком`).toBe(true);
      expect(desc.split('⚠ СВЕРКА 11.10.2026:').length - 1, `${id}: абзац сверки ровно один`).toBe(1);
    }
  });
});

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
  /** Ровно то, что дала правка 4, — без поздних правок (правка 5 закрыла m4-12). */
  const at4 = (): RoadmapDoc => { const d = rev3Copy(); rev4.apply(d); d.seedRev = 4; return d; };
  const ms = (d: RoadmapDoc, id: string) => d.milestones.find((m) => m.id === id)!;

  it('правка 4 есть, и свежий сид её уже содержит', () => {
    expect(rev4, 'правка 4 есть').toBeTruthy();
    expect(SEED_REV).toBeGreaterThanOrEqual(4);
    expect(item(SEED(), 'm1-7')?.done).toBe(true);
    expect(item(SEED(), 'm2-23')?.done).toBe(true);
  });

  it('новые пункты появились с верными галками и заметками', () => {
    const d = at4();
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
    expect(migrateRoadmap(d), 'ревизия уже последняя').toBe(false);
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

/**
 * ⭐ ПРАВКА 5 (13.10.2026). Копия у пользователя на ревизии 4. Проверяем: фазы декора встали в м02 ПЕРЕД итоговым
 * пунктом вехи, галки — только у сделанного, m4-12 закрыт с дописанной (не затёртой) заметкой правки 4, m2-7 галку
 * не получил (базовую крипту принимает владелец), удалённое руками не воскресает.
 */
describe('правка 13.10: декор подземелий и экран загрузки', () => {
  /** Копия «как у пользователя до 13.10»: снимок + правки 2–4, ревизия 4. */
  const rev4Copy = (): RoadmapDoc => {
    const d = BASE_SEED();
    for (const p of SEED_PATCHES) if (p.rev <= 4) p.apply(d);
    d.seedRev = 4;
    return d;
  };
  const rev5 = SEED_PATCHES.find((p) => p.rev === 5)!;
  /** ⭐ 14.10: только правка 5 (правка 6 закрывает m2-29/m2-30 — её проверяет свой блок ниже). */
  const migrated = (): RoadmapDoc => { const d = rev4Copy(); rev5.apply(d); d.seedRev = 5; return d; };
  const ms = (d: RoadmapDoc, id: string) => d.milestones.find((m) => m.id === id)!;

  it('правка 5 есть, и свежий сид её уже содержит', () => {
    expect(rev5, 'правка 5 есть').toBeTruthy();
    expect(SEED_REV).toBeGreaterThanOrEqual(5);
    expect(item(SEED(), 'm2-25')?.done).toBe(true);
    expect(item(SEED(), 'm4-12')?.done).toBe(true);
  });

  it('сделанное — с галкой, датой и коммитами; план и работа в процессе — без галки', () => {
    const d = migrated();
    for (const id of ['m2-25', 'm2-26', 'm2-27', 'm2-28']) {
      expect(item(d, id), `пункт ${id} обязан появиться`).toBeTruthy();
      expect(item(d, id)?.done, `пункт ${id} сделан`).toBe(true);
      expect(item(d, id)?.note, `у ${id} дата`).toMatch(/1[23]\.10/);
      expect(item(d, id)?.note, `у ${id} коммит`).toMatch(/\b[0-9a-f]{7}\b/);
    }
    for (const id of ['m2-29', 'm2-30', 'm2-31', 'm2-32', 'm4-13']) {
      expect(item(d, id), `пункт ${id} обязан появиться`).toBeTruthy();
      expect(item(d, id)?.done, `${id} — работа впереди, без галки`).toBeFalsy();
    }
    expect(item(d, 'm2-29')?.note, 'наборы — в работе').toMatch(/в работе/);
    expect(item(d, 'm2-7')?.done, 'базовую крипту принимает владелец — галки нет').toBeFalsy();
    expect(item(d, 'm2-7')?.note, 'но сверка дописана').toMatch(/Сверка 13\.10/);
  });

  it('новые пункты — в своих вехах и перед итоговым «✅»', () => {
    const d = migrated();
    expect(ms(d, 'м02').items.map((x) => x.id).slice(-9)).toEqual(
      ['m2-25', 'm2-26', 'm2-27', 'm2-28', 'm2-29', 'm2-30', 'm2-31', 'm2-32', 'm2-10']);
    const m4 = ms(d, 'м04').items.map((x) => x.id);
    expect(m4.indexOf('m4-13'), 'логотип экрана загрузки — сразу за самим экраном').toBe(m4.indexOf('m4-12') + 1);
    expect(m4[m4.length - 1], 'итог вехи остаётся последним').toBe('m4-11');
  });

  it('⭐ m4-12 закрыт, а заметка правки 4 осталась целиком и первой', () => {
    const before = item(rev4Copy(), 'm4-12')!;
    expect(before.done, 'до правки экран загрузки открыт').toBeFalsy();
    const after = item(migrated(), 'm4-12')!;
    expect(after.done).toBe(true);
    expect(after.note!.startsWith(before.note! + '\n'), 'старая заметка целиком и первой').toBe(true);
    expect(after.note).toMatch(/1fd5b76[\s\S]*bd6e88c[\s\S]*30722bd/);
  });

  it('удалённое руками не воскресает; второй прогон и повтор правки ничего не меняют', () => {
    const d = rev4Copy();
    for (const m of d.milestones) m.items = m.items.filter((it) => it.id !== 'm4-12');
    migrateRoadmap(d);
    expect(item(d, 'm4-12'), 'удалённый пункт не вернулся').toBeUndefined();

    const full = rev4Copy();
    migrateRoadmap(full);   // ⭐ 14.10: до последней ревизии (правка 6 и дальше), затем повтор правки 5
    const snapshot = JSON.stringify(full);
    expect(migrateRoadmap(full), 'ревизия уже последняя').toBe(false);
    rev5.apply(full);   // мимо `seedRev`: addItem / markDone / addNote сами обязаны не дублировать
    expect(JSON.stringify(full), 'повтор правки 5 — без изменений').toBe(snapshot);
  });
});

/**
 * ⭐ ПРАВКА 6 (14.10.2026). Копия у пользователя на ревизии 5. Проверяем: наборы и Мастерская — с галкой, коммитами и датой,
 * заметка правки 5 у m2-29 осталась первой, m2-7 галку не получил, повтор ничего не меняет.
 */
describe('правка 14.10: декор Ф4 «Наборы» и Ф3 «Мастерская»', () => {
  const rev5Copy = (): RoadmapDoc => {
    const d = BASE_SEED();
    for (const p of SEED_PATCHES) if (p.rev <= 5) p.apply(d);
    d.seedRev = 5;
    return d;
  };
  const migrated = (): RoadmapDoc => { const d = rev5Copy(); migrateRoadmap(d); return d; };

  it('правка 6 — последняя ревизия, и свежий сид её уже содержит', () => {
    expect(SEED_PATCHES.find((p) => p.rev === 6), 'правка 6 есть').toBeTruthy();
    expect(SEED_REV).toBe(6);
    expect(item(SEED(), 'm2-29')?.done).toBe(true);
    expect(item(SEED(), 'm2-30')?.done).toBe(true);
  });

  it('наборы и Мастерская — с галкой, датой и коммитом; заметка правки 5 у наборов — целиком и первой', () => {
    const before = item(rev5Copy(), 'm2-29')!;
    expect(before.done, 'до правки наборы в работе').toBeFalsy();
    const d = migrated();
    for (const id of ['m2-29', 'm2-30']) {
      expect(item(d, id)?.done, `${id} сделан`).toBe(true);
      expect(item(d, id)?.note, `у ${id} дата`).toMatch(/1[34]\.10/);
      expect(item(d, id)?.note, `у ${id} коммит`).toMatch(/\b[0-9a-f]{7}\b/);
    }
    expect(item(d, 'm2-29')!.note!.startsWith(before.note! + '\n'), 'старая заметка целиком и первой').toBe(true);
    expect(item(d, 'm2-30')?.note).toMatch(/214f217/);
    for (const id of ['m2-31', 'm2-32']) expect(item(d, id)?.done, `${id} — впереди`).toBeFalsy();
    expect(item(d, 'm2-7')?.done, 'вид крипты принимает владелец — галки нет').toBeFalsy();
    expect(item(d, 'm2-7')?.note).toMatch(/Сверка 14\.10/);
  });

  it('удалённое руками не воскресает; повтор правки ничего не меняет', () => {
    const d = rev5Copy();
    for (const m of d.milestones) m.items = m.items.filter((it) => it.id !== 'm2-30');
    migrateRoadmap(d);
    expect(item(d, 'm2-30'), 'удалённый пункт не вернулся').toBeUndefined();
    const once = JSON.stringify(d);
    SEED_PATCHES.find((p) => p.rev === 6)!.apply(d);
    expect(JSON.stringify(d), 'повтор правки 6 — без изменений').toBe(once);
  });
});

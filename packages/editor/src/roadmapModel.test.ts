import { describe, it, expect, beforeAll } from 'vitest';
import { ConfigRegistry } from '@dm/shared';
import {
  itemProgress, remainingOf, milestoneProgress, totalProgress, statusOf, deadlineOf,
  activeIndex, currentOf, isCounter, shortDate, COUNTERS,
  driftDays, autoClose, shiftDate, shiftTail, roadmapStats,
  type Item, type Milestone, type Ctx, type RoadmapDoc,
} from './roadmapModel.js';

/**
 * Роадмап ведёт работу, поэтому его арифметика обязана быть скучной и предсказуемой. Главное, что тут
 * проверяется, — ЧАСТИЧНЫЙ ЗАЧЁТ: пункт «13 из 35» должен двигать полосу вехи, иначе весь смысл
 * авто-счётчиков теряется и трекер снова превращается в ручной список галок.
 */

let cfg: ConfigRegistry;
beforeAll(() => { cfg = new ConfigRegistry(); cfg.loadAll(); });
const config = (): Ctx['config'] => ({
  monsters: cfg.get('monsters'), uniques: cfg.get('uniques'), models: cfg.get('models'),
  materials: cfg.get('materials'), textures: cfg.get('textures'), biomes: cfg.get('biomes'),
  affixes: cfg.get('affixes'), debuffs: cfg.get('debuffs'),
  'items.base': cfg.get('items.base'), 'skill-tree': cfg.get('skill-tree'),
  'mastery-tree': cfg.get('mastery-tree'), 'run-modifiers': cfg.get('run-modifiers'),
} as unknown as Ctx['config']);

const mk = (over: Partial<Item> = {}): Item => ({ id: 'i1', title: 'пункт', ...over });
const counter = (cur: number, target: number): Item =>
  mk({ target, source: { kind: 'manual', value: cur } });

describe('пункт: галка или счётчик', () => {
  it('галка — двоичная', () => {
    expect(itemProgress(mk({ done: false }), {})).toBe(0);
    expect(itemProgress(mk({ done: true }), {})).toBe(1);
    expect(isCounter(mk({ done: true }))).toBe(false);
  });

  it('⭐ ЧАСТИЧНЫЙ ЗАЧЁТ: 13 из 35 двигает полосу, а не считается нулём', () => {
    expect(itemProgress(counter(13, 35), {})).toBeCloseTo(0.371, 3);
    expect(remainingOf(counter(13, 35), {})).toBe(22);
  });

  it('перевыполнение не даёт больше единицы и не уходит в минус по остатку', () => {
    expect(itemProgress(counter(50, 35), {})).toBe(1);
    expect(remainingOf(counter(50, 35), {})).toBe(0);
  });

  it('цель 0 — это «ничего не требуется», а не деление на ноль', () => {
    expect(itemProgress(counter(0, 0), {})).toBe(1);
    expect(Number.isFinite(itemProgress(counter(5, 0), {}))).toBe(true);
  });

  it('источник молчит (нет конфига) → ведём себя как галка, а не как ноль навсегда', () => {
    const it = mk({ target: 10, source: { kind: 'config', counter: 'monsters' }, done: true });
    expect(currentOf(it, {})).toBeNull();
    expect(itemProgress(it, {})).toBe(1);
    expect(remainingOf(it, {})).toBeNull();
  });

  it('несуществующий счётчик не роняет вкладку', () => {
    const it = mk({ target: 10, source: { kind: 'config', counter: 'нет-такого' } });
    expect(currentOf(it, { config: config() })).toBeNull();
    expect(() => itemProgress(it, { config: config() })).not.toThrow();
  });
});

describe('счётчики читают РЕАЛЬНЫЙ конфиг', () => {
  it('монстры совпадают с длиной конфига', () => {
    const c = config()!;
    const it = mk({ target: 35, source: { kind: 'config', counter: 'monsters' } });
    expect(currentOf(it, { config: c })).toBe(cfg.get('monsters').length);
    expect(remainingOf(it, { config: c })).toBe(35 - cfg.get('monsters').length);
  });

  it('модели персонажей фильтруются по kind, а не берутся целиком', () => {
    const c = config()!;
    const all = cfg.get('models').length;
    const chars = COUNTERS.charModels!.count(c);
    expect(chars).toBeLessThanOrEqual(all);
    expect(chars).toBe(cfg.get('models').filter((m) => m.kind === 'character').length);
  });

  it('каждый счётчик реестра отрабатывает без исключений и даёт число либо честный null', () => {
    const c = config()!;
    for (const [key, def] of Object.entries(COUNTERS)) {
      const n = def.count(c);
      expect(n === null || (Number.isFinite(n) && n >= 0), `счётчик ${key} вернул мусор: ${n}`).toBe(true);
    }
  });

  it('⚠ НЕПОЛНЫЙ конфиг не роняет вкладку: счётчик по отсутствующему ключу возвращает null', () => {
    // Сервер может отдать частичный снапшот (или не отдать вовсе). Ноль тут был бы враньём —
    // «сделано 0 из 35» вместо «не знаю», и полоса вехи показывала бы ложный провал.
    for (const [key, def] of Object.entries(COUNTERS)) {
      expect(def.count({}), `счётчик ${key} на пустом конфиге обязан вернуть null`).toBeNull();
    }
    const it = mk({ target: 35, source: { kind: 'config', counter: 'monsters' } });
    expect(itemProgress(it, { config: {} })).toBe(0);   // как невыполненная галка, а не как деление на ноль
    expect(remainingOf(it, { config: {} })).toBeNull();
  });
});

describe('счётчики по файлам на сервере', () => {
  const ctx: Ctx = { assets: { byExt: { glb: 9, png: 17, ogg: 0 }, byDir: { 'tiles/crypt': 6 }, bytes: 0 } };
  it('считает по расширению', () => {
    expect(currentOf(mk({ target: 12, source: { kind: 'assets', ext: 'glb' } }), ctx)).toBe(9);
  });
  it('нулевое расширение — это 0, а не «нет источника» (звуков ещё нет, но счётчик должен работать)', () => {
    const snd = mk({ target: 200, source: { kind: 'assets', ext: 'ogg' } });
    expect(currentOf(snd, ctx)).toBe(0);
    expect(itemProgress(snd, ctx)).toBe(0);
    expect(remainingOf(snd, ctx)).toBe(200);
  });
  it('фильтр по папке важнее расширения', () => {
    expect(currentOf(mk({ target: 10, source: { kind: 'assets', ext: 'glb', dir: 'tiles/crypt' } }), ctx)).toBe(6);
  });
});

describe('веха', () => {
  const m = (items: Item[], to = '2027-02'): Milestone => ({ id: 'f1', title: 'Срез', goal: '', to, items });

  it('прогресс = среднее по пунктам, остаток = число незакрытых', () => {
    const p = milestoneProgress(m([mk({ done: true }), mk({ done: false }), counter(13, 35)]), {});
    expect(p.total).toBe(3);
    expect(p.remaining).toBe(2);
    expect(p.ratio).toBeCloseTo((1 + 0 + 13 / 35) / 3, 3);
  });

  it('пустая веха НЕ считается готовой', () => {
    const p = milestoneProgress(m([]), {});
    expect(p.ratio).toBe(0);
    expect(p.total).toBe(0);
    expect(statusOf(m([]), { now: Date.UTC(2026, 0, 1) })).not.toBe('done');
  });

  it('разбивка незакрытого по исполнителям — видно, у кого критический путь', () => {
    const p = milestoneProgress(m([
      mk({ who: 'art', done: false }), mk({ who: 'art', done: false }),
      mk({ who: 'code', done: false }), mk({ who: 'code', done: true }),
    ]), {});
    expect(p.byWho).toEqual({ art: 2, code: 1, design: 0 });
  });

  it('общий прогресс считает по ПУНКТАМ: веха из двух задач не весит как веха из двадцати', () => {
    const doc: RoadmapDoc = { milestones: [m([mk({ done: true }), mk({ done: true })], '2026-10'), m(Array.from({ length: 8 }, () => mk({ done: false })))] };
    expect(totalProgress(doc, {}).ratio).toBeCloseTo(2 / 10, 5);
    expect(totalProgress(doc, {}).remaining).toBe(8);
  });
});

describe('статусы и даты', () => {
  const done = (to: string): Milestone => ({ id: 'a', title: '', goal: '', to, items: [mk({ done: true })] });
  const open = (to: string): Milestone => ({ id: 'b', title: '', goal: '', to, items: [mk({ done: false })] });
  const NOW = Date.UTC(2027, 4, 15);   // 15 мая 2027

  it('закрытая веха — done, даже если срок давно прошёл', () => {
    expect(statusOf(done('2026-10'), { now: NOW })).toBe('done');
  });
  it('просрочка — только когда срок прошёл И осталось незакрытое', () => {
    expect(statusOf(open('2027-02'), { now: NOW })).toBe('overdue');
    expect(statusOf(open('2027-09'), { now: NOW })).toBe('planned');
  });
  it('ближайшая незакрытая помечается как активная', () => {
    expect(statusOf(open('2027-09'), { now: NOW }, true)).toBe('active');
  });

  it('`YYYY-MM` тянется до КОНЦА месяца, а не до первого числа', () => {
    // 2027-02 закрывается 28 февраля: 20 февраля просрочки ещё нет
    expect(statusOf(open('2027-02'), { now: Date.UTC(2027, 1, 20) })).not.toBe('overdue');
    expect(statusOf(open('2027-02'), { now: Date.UTC(2027, 2, 1) })).toBe('overdue');
    expect(deadlineOf({ id: '', title: '', goal: '', to: '2028-02', items: [] })).toBe(Date.UTC(2028, 1, 29, 23, 59, 59)); // високосный
  });

  it('активная веха — первая незакрытая по порядку', () => {
    const doc: RoadmapDoc = { milestones: [done('2026-10'), done('2026-12'), open('2027-02'), open('2027-09')] };
    expect(activeIndex(doc, { now: NOW })).toBe(2);
  });
  it('всё закрыто → показываем последнюю, а не падаем', () => {
    expect(activeIndex({ milestones: [done('2026-10')] }, { now: NOW })).toBe(0);
    expect(activeIndex({ milestones: [] }, { now: NOW })).toBe(0);
  });

  it('подпись даты: месяц и точный день выглядят по-разному', () => {
    expect(shortDate('2026-11')).toBe('ноя 26');
    expect(shortDate('2028-01-24')).toBe('24.01.28');
  });
});

describe('сроки: план, факт, отклонение', () => {
  const ms = (over: Partial<Milestone> = {}): Milestone =>
    ({ id: 'm', title: '', goal: '', to: '2027-02', planned: '2027-02', items: [mk({ done: false })], ...over });

  it('идём по плану → отклонение ноль', () => {
    expect(driftDays(ms())).toBe(0);
  });

  it('закрыли позже плана → плюс дни; раньше → минус', () => {
    expect(driftDays(ms({ closedAt: '2027-03-10' }))).toBe(10);   // план — конец февраля
    expect(driftDays(ms({ closedAt: '2027-02-18' }))).toBe(-10);
  });

  it('⭐ сдвиг срока НЕ обнуляет отклонение: иначе план всегда «выполняется»', () => {
    // Двигаем только `to`; `planned` остаётся, и отставание продолжает быть видно.
    const m = ms({ to: '2027-03', planned: '2027-02' });
    expect(driftDays(m)).toBe(31);   // 28 февраля → 31 марта = 31 день
  });

  it('факт закрытия ставится ОДИН раз и не переезжает следом за конфигом', () => {
    const doc: RoadmapDoc = { milestones: [ms({ items: [mk({ done: true })] })] };
    expect(autoClose(doc, { now: Date.UTC(2027, 1, 20) })).toBe(true);
    expect(doc.milestones[0]!.closedAt).toBe('2027-02-20');
    // повторный вызов в другой день ничего не меняет
    expect(autoClose(doc, { now: Date.UTC(2027, 5, 1) })).toBe(false);
    expect(doc.milestones[0]!.closedAt).toBe('2027-02-20');
  });

  it('веху переоткрыли (сняли галку) → факт снимается, статистика не врёт', () => {
    const doc: RoadmapDoc = { milestones: [ms({ items: [mk({ done: true })], closedAt: '2027-02-20' })] };
    doc.milestones[0]!.items[0]!.done = false;
    expect(autoClose(doc, { now: Date.UTC(2027, 2, 1) })).toBe(true);
    expect(doc.milestones[0]!.closedAt).toBeUndefined();
  });

  it('сдвиг даты сохраняет вид записи: месяц остаётся месяцем, день — днём', () => {
    expect(shiftDate('2027-02', 30)).toMatch(/^\d{4}-\d{2}$/);
    expect(shiftDate('2028-01-24', 14)).toBe('2028-02-07');
  });

  it('сдвиг хвоста двигает только последующие и только незакрытые', () => {
    const doc: RoadmapDoc = { milestones: [
      ms({ id: 'a', to: '2026-10', planned: '2026-10', closedAt: '2026-10-31' }),
      ms({ id: 'b', to: '2026-11', planned: '2026-11', closedAt: '2026-11-30' }),
      ms({ id: 'c', to: '2026-12', planned: '2026-12' }),
      ms({ id: 'd', to: '2028-01-24', planned: '2028-01-24' }),
    ] };
    const n = shiftTail(doc, 1, 14);
    expect(n).toBe(2);                                     // закрытые и предыдущие не тронуты
    expect(doc.milestones[0]!.to).toBe('2026-10');
    expect(doc.milestones[1]!.to).toBe('2026-11');
    expect(doc.milestones[3]!.to).toBe('2028-02-07');
    expect(doc.milestones[3]!.planned).toBe('2028-01-24'); // база НЕ поехала
  });

  it('статистика: средний сдвиг и отклонение релиза', () => {
    const doc: RoadmapDoc = { milestones: [
      ms({ id: 'a', to: '2026-10', planned: '2026-10', closedAt: '2026-11-10' }),   // +10
      ms({ id: 'b', to: '2026-11', planned: '2026-11', closedAt: '2026-12-06' }),   // +6
      ms({ id: 'c', to: '2028-02-07', planned: '2028-01-24' }),                     // релиз уехал на 14
    ] };
    const st = roadmapStats(doc)!;
    expect(st.closed).toBe(2);
    expect(st.avgDrift).toBe(8);
    expect(st.releaseDrift).toBe(14);
    expect(st.releasePlanned).toBe('2028-01-24');
    expect(st.forecast).toBe(shiftDate('2028-02-07', 8));   // одна незакрытая × средний сдвиг
  });

  it('⚠ ОТПРАВНАЯ ТОЧКА не участвует в сроках: иначе её «закрытие» даёт сдвиг из ниоткуда', () => {
    // Поймано живьём: снимок состояния с closedAt раньше конца месяца дал средний сдвиг −20 дней.
    const doc: RoadmapDoc = { milestones: [
      ms({ id: 'старт', to: '2026-09', planned: '2026-09', closedAt: '2026-09-10', baseline: true }),
      ms({ id: 'a', to: '2026-10', planned: '2026-10' }),
    ] };
    const st = roadmapStats(doc)!;
    expect(st.total).toBe(1);      // считаем только работу
    expect(st.closed).toBe(0);
    expect(st.avgDrift).toBe(0);
  });

  it('релизом считается веха с ТОЧНОЙ датой, а не последняя в списке', () => {
    // Точная дата = обязательство (запуск EA), месяц = ориентир («1.0 когда-нибудь в 2029»).
    const doc: RoadmapDoc = { milestones: [
      ms({ id: 'ea', to: '2028-01-24', planned: '2028-01-24' }),
      ms({ id: '1.0', to: '2029-06', planned: '2029-06' }),
    ] };
    expect(roadmapStats(doc)!.releaseNow).toBe('2028-01-24');
  });

  it('пустой роадмап не роняет статистику', () => {
    expect(roadmapStats({ milestones: [] })).toBeNull();
  });
});

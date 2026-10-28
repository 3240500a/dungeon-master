import { describe, it, expect } from 'vitest';
import {
  isWaypoint,
  openWaypoints,
  waypointStart,
  floorMonsterLevel,
  WAYPOINT_ENTRY_DEPTH,
  OPEN_WAYPOINTS_LIMIT,
  WAYPOINT_DEPTH_LIMIT,
} from './power.js';
import { ConfigRegistry } from '../config/registry.js';

/**
 * ⭐⭐ 14.10 (Г3, В1): ЧИСТЫЕ ФУНКЦИИ МЕТОК СПУСКА — ТАБЛИЦА.
 *
 * Метка (привал-вейпоинт, портал в город) не хранится в сейве: открытая метка — это глубина, кратная каденции
 * (`balance.dungeonAccess.waypointStep`) и не глубже рекорда тира (`save.difficultyProgress[tier]`). Плюс вход на
 * 1-м этаже открыт всегда. Эти три функции — ОДИН шов для сервера (анти-чит `descend`), алтаря клиента и порта
 * Unity: своя арифметика у клиента показала бы метку, которой сервер не даст.
 *
 * ⚠ МУТАЦИИ, КОТОРЫЕ ЭТОТ ФАЙЛ ОБЯЗАН ВАЛИТЬ (каждая проверена руками 14.10: наложить → прогнать → вернуть, md5
 * сверен):
 *  • `d % step === 0` → `d % step === 1` (сдвиг каденции) — валит «метка ли глубина» и всю таблицу списков;
 *  • ⭐⭐ Ф3 (16.10): ВОЗВРАТ ВХОДА в `openWaypoints` — валит «у свежего героя меток нет»: вход не метка, он
 *    отдельная кнопка портала «начать сначала», и подмешивать его в список значит обещать место круга,
 *    которого там нет (место 1 порталом не бывает);
 *  • `d ≤ рекорд` → `d ≤ рекорд + step` (щедрость на одну метку) — валит строки рекордов 1/2/7/20 таблицы;
 *  • зажим рекорда потолком (`Math.min(rec, 100)`) — валит строку рекорда 300 (прицел владельца 200–300);
 *  • `Math.min(record, asked)` → `asked` (кадр решает сам) — валит «кадр только ОГРАНИЧИВАЕТ сверху» целиком;
 *  • `Math.min(record, asked)` → `record` (кадр не читается вовсе) — валит «просил мельче — получил мельче»;
 *  • `weakest = Math.min(...)` → `Math.max(...)` (кооп по сильнейшему) — валит «пати идёт по самому слабому»;
 *  • снятие `Number.isFinite` у запрошенной глубины — валит «NaN/Infinity — это вход, а не глубина»;
 *  • снятие `limit` в `openWaypoints` — валит «порченый рекорд не роняет процесс» (список на 1e9);
 *  • ⭐ 14.10 (правка 7) снятие потолка `WAYPOINT_DEPTH_LIMIT` в `depthRecordOf` — валит «предохранитель
 *    один на обе функции» (старт снова уедет в 999999999);
 *  • потолок только в `openWaypoints` (а не в общем шве чтения рекорда) — валит тот же сторож: список и старт
 *    обязаны кончаться НА ОДНОЙ глубине (иначе алтарь показывает метку, которой сервер не даст);
 *  • потолок, связывающий игру (например 100 вместо 10 000) — валит строку рекорда 300 таблицы и «прицел
 *    владельца потолку не мешает».
 */

/** ⭐ Г8-3: живые МЕСТА порталов — ими же ходит генератор. Таблицы ниже задают каденцию сами, это сверка с данными. */
const liveStep = (): readonly number[] => {
  const r = new ConfigRegistry();
  r.loadAll();
  return r.get('balance').dungeonAccess.portalsAt;
};

describe('⭐ Г3 (В1): метка — арифметика по рекорду', () => {
  it('метка ли глубина: кратна шагу и ≥ 1 (мусор — не метка)', () => {
    expect(isWaypoint(3, 3, 0)).toBe(true);
    expect(isWaypoint(6, 3, 0)).toBe(true);
    expect(isWaypoint(300, 3, 0)).toBe(true);
    expect(isWaypoint(4, 3, 0)).toBe(false);
    expect(isWaypoint(0, 3, 0)).toBe(false);            // глубины 0 в спуске нет
    expect(isWaypoint(-3, 3, 0)).toBe(false);
    expect(isWaypoint(1, 1, 0)).toBe(true);             // шаг 1 — метка на каждом этаже
    expect(isWaypoint(7, 0, 0)).toBe(true);             // шаг 0 негоден → 1 (вторая линия после схемы)
    expect(isWaypoint(Number.NaN, 3, 0)).toBe(false);
    expect(isWaypoint(Number.POSITIVE_INFINITY, 3, 0)).toBe(false);
    expect(isWaypoint(1.5, 3, 0)).toBe(false);
    expect(isWaypoint(3.5, 3, 0)).toBe(true);           // дробь приводится вниз: 3.5 → 3
  });

  /**
   * ⭐ ТАБЛИЦА: шаг 2/3/5 × рекорд 0/1/2/7/20/300. Печатается в вывод теста — числа тут, а не в описании.
   * Прицел владельца — 200–300 этажей, поэтому рекорд 300 стоит в таблице явно: список на нём остаётся честным
   * (101 метка при шаге 3) и ничем не зажат.
   */
  it('⭐ таблица открытых меток: шаг 2/3/5 × рекорд 0/1/2/7/20/300', () => {
    const steps = [2, 3, 5];
    const records = [0, 1, 2, 7, 20, 300];
    const rows: string[] = [];
    const got: Record<string, number[]> = {};
    for (const step of steps) {
      for (const rec of records) {
        const list = openWaypoints({ normal: rec }, 'normal', step, 0);
        got[`${step}:${rec}`] = list;
        const shown = list.length > 8 ? `${list.slice(0, 4).join(', ')} … ${list.slice(-2).join(', ')}` : list.join(', ');
        rows.push(`шаг ${step} · рекорд ${String(rec).padStart(3)} → ${String(list.length).padStart(3)} шт: ${shown}`);
      }
    }
    console.log(`\nОТКРЫТЫЕ МЕТКИ (чистая функция, 14.10)\n${rows.join('\n')}`);

    // Шаг 2.
    expect(got['2:0']).toEqual([]);
    expect(got['2:1']).toEqual([]);
    expect(got['2:2']).toEqual([2]);
    expect(got['2:7']).toEqual([2, 4, 6]);
    expect(got['2:20']).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
    expect(got['2:300']!.length).toBe(150);          // 150 чётных (входа в списке нет)
    // Шаг 3 (живая каденция игры).
    expect(got['3:0']).toEqual([]);
    expect(got['3:1']).toEqual([]);
    expect(got['3:2']).toEqual([]);
    expect(got['3:7']).toEqual([3, 6]);
    expect(got['3:20']).toEqual([3, 6, 9, 12, 15, 18]);
    expect(got['3:300']!.length).toBe(100);          // 100 кратных трём
    expect(got['3:300']!.at(-1)).toBe(300);
    // Шаг 5.
    expect(got['5:0']).toEqual([]);
    expect(got['5:2']).toEqual([]);
    expect(got['5:7']).toEqual([5]);
    expect(got['5:20']).toEqual([5, 10, 15, 20]);
    expect(got['5:300']!.length).toBe(60);

    // Список всегда по возрастанию, без повторов, и каждая его глубина — метка (кроме входа).
    for (const [key, list] of Object.entries(got)) {
      const step = Number(key.split(':')[0]);
      expect(new Set(list).size, `${key}: без повторов`).toBe(list.length);
      expect([...list].sort((a, b) => a - b), `${key}: по возрастанию`).toEqual(list);
      for (const d of list) expect(isWaypoint(d, step, 0), `${key}: ${d} — метка`).toBe(true);
    }
  });

  /**
   * ⭐⭐ Ф3 (16.10, решение владельца): ВХОД — НЕ МЕТКА. «Если начало с первого этажа, то там сразу пусть будет
   * первый этаж, а не рест-этаж; рест-этажи все стоят на своих местах, ничего не подменяем». Раньше список
   * всегда дописывал глубину 1, и свежий герой видел «метку» на месте, которое порталом не бывает. Теперь
   * список — чистые метки рекорда, а «начать сначала» живёт кнопкой портала города и упирается в тот же зажим
   * сервера: `waypointStart` без подходящей метки возвращает `WAYPOINT_ENTRY_DEPTH`.
   */
  it('⭐⭐ Ф3: у свежего героя меток НЕТ — вход не метка, он отдельная кнопка портала', () => {
    expect(openWaypoints(undefined, 'normal', 3, 0)).toEqual([]);
    expect(openWaypoints({}, 'normal', 3, 0)).toEqual([]);
    expect(openWaypoints({ hard: 90 }, 'normal', 3, 0), 'рекорд ДРУГОГО тира меток не открывает').toEqual([]);
    expect(openWaypoints({ normal: Number.NaN }, 'normal', 3, 0)).toEqual([]);
    expect(openWaypoints({ normal: -40 }, 'normal', 3, 0)).toEqual([]);
    expect(openWaypoints({ normal: 2 }, 'normal', 3, 0), 'рекорд мельче первой метки — тоже пусто').toEqual([]);
    // Шаг 1: метка на каждом этаже, и первая из них — глубина 1 (но она тут МЕТКА, а не «вход»).
    expect(openWaypoints({ normal: 4 }, 'normal', 1, 0)).toEqual([1, 2, 3, 4]);
    // ⚠ И сервер всё равно умеет начать сначала: без подходящей метки старт — вход.
    expect(waypointStart([{}], 'normal', 3, 0, 99)).toBe(WAYPOINT_ENTRY_DEPTH);
  });

  it('⚠ порченый рекорд не роняет процесс: список срезан потолком доверия', () => {
    const list = openWaypoints({ normal: 1e9 }, 'normal', 3, 0);
    expect(list.length, 'срезка умолчанием').toBe(OPEN_WAYPOINTS_LIMIT);
    expect(list.every((d) => isWaypoint(d, 3, 0)), 'в списке только настоящие метки').toBe(true);
    // ⭐ 14.10 (правка 7): самая глубокая — НЕ 999999999, а последняя метка под потолком доверия к рекорду.
    expect(list.at(-1), 'оставлены САМЫЕ ГЛУБОКИЕ — до предохранителя').toBe(9999);
    const few = openWaypoints({ normal: 300 }, 'normal', 3, 0, { limit: 5 });
    expect(few, 'явный limit: 5 самых глубоких меток').toEqual([288, 291, 294, 297, 300]);
  });

  /**
   * ⭐⭐ 14.10 (правка 7): ПРЕДОХРАНИТЕЛЬ ГЛУБИНЫ — ОДИН НА СПИСОК И НА СТАРТ.
   * Замер проверки 14.10: у `openWaypoints` предохранитель был (срезка ДЛИНЫ), а у `waypointStart` никакого —
   * «рекорд 1000000000 → старт 999999999, область dungeon». Срезка длины от такого не спасала: она режет
   * СКОЛЬКО меток показать, а не КАК ГЛУБОКО верить сейву. Теперь потолок стоит в ОДНОМ шве чтения
   * рекорда, и разойтись функциям нельзя — именно это и судится ниже.
   */
  it('⭐ потолок доверия к рекорду: и список, и старт кончаются на одной глубине', () => {
    const rows: string[] = [];
    for (const step of [1, 3]) {
      const last = openWaypoints({ normal: 1e9 }, 'normal', step, 0).at(-1)!;
      const start = waypointStart([{ normal: 1e9 }], 'normal', step, 0, Number.MAX_SAFE_INTEGER);
      rows.push(`шаг ${step} · рекорд 1e9 → самая глубокая метка ${last}, старт ${start}`);
      expect(start, `шаг ${step}: старт не глубже предохранителя`).toBeLessThanOrEqual(WAYPOINT_DEPTH_LIMIT);
      expect(start, `шаг ${step}: список и старт — одна глубина`).toBe(last);
    }
    console.log(`\nПРЕДОХРАНИТЕЛЬ ГЛУБИНЫ (${WAYPOINT_DEPTH_LIMIT}, замер 14.10)\n${rows.join('\n')}`);
    // Рекорд ВЫШЕ потолка даёт то же, что ровно потолок: выше него число из сейва ничего не значит.
    const atCap = waypointStart([{ normal: WAYPOINT_DEPTH_LIMIT }], 'normal', 3, 0, Number.MAX_SAFE_INTEGER);
    expect(waypointStart([{ normal: WAYPOINT_DEPTH_LIMIT + 1 }], 'normal', 3, 0, Number.MAX_SAFE_INTEGER)).toBe(atCap);
    expect(waypointStart([{ normal: 1e9 }], 'normal', 3, 0, Number.MAX_SAFE_INTEGER)).toBe(atCap);
    // ⚠ ПРИЦЕЛ ВЛАДЕЛЬЦА (200–300 этажей) ПОТОЛОК НЕ СВЯЗЫВАЕТ: он на порядок дальше.
    expect(WAYPOINT_DEPTH_LIMIT).toBeGreaterThan(300 * 10);
    expect(waypointStart([{ normal: 300 }], 'normal', 3, 0, 300), 'прицел идёт без зажима').toBe(300);
    expect(openWaypoints({ normal: 300 }, 'normal', 3, 0).at(-1), 'и список на прицеле цел').toBe(300);
  });

  /**
   * ⭐ АНТИ-ЧИТ, ЧИСТАЯ ЧАСТЬ: кадр только ОГРАНИЧИВАЕТ сверху. Серверная половина (кадр → `Room.descend` → старт
   * забега) — `server/src/net/room.g3start.test.ts`.
   */
  it('⭐ старт по метке: разрешение считает рекорд, кадр только ограничивает сверху', () => {
    const rec = [{ normal: 60 }];
    const rows: string[] = [];
    const probe = (want: unknown): number => waypointStart(rec, 'normal', 3, 0, want as number);
    for (const want of [undefined, 1, 2, 3, 18, 20, 60, 61, 1e9]) {
      const got = probe(want);
      rows.push(`просил ${String(want).padStart(10)} → старт ${got}`);
    }
    console.log(`\nСТАРТ ПО МЕТКЕ (рекорд 60, шаг 3)\n${rows.join('\n')}`);

    expect(probe(undefined), 'кадра без глубины — вход (как было до Г3)').toBe(1);
    expect(probe(1)).toBe(1);
    expect(probe(2), 'мельче первой метки — вход').toBe(1);
    expect(probe(3)).toBe(3);
    expect(probe(18)).toBe(18);
    expect(probe(20), 'не кратная шагу — вниз до метки').toBe(18);
    expect(probe(60), 'ровно рекорд').toBe(60);
    expect(probe(61), 'глубже рекорда — зажато рекордом').toBe(60);
    expect(probe(1e9), 'подложенная глубина — зажата рекордом').toBe(60);
    // Мусор — это «границы нет», то есть вход; не отказ и не глубина читера.
    for (const bad of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '7', null, {}, [60]]) {
      expect(probe(bad), `мусор ${JSON.stringify(bad)} → вход`).toBe(1);
    }
    // Рекорд глубже прицела (300) список и старт не ломает.
    expect(waypointStart([{ normal: 300 }], 'normal', 3, 0, 300)).toBe(300);
    expect(waypointStart([{ normal: 300 }], 'normal', 3, 0, 299)).toBe(297);
  });

  it('⭐ кооп: пати идёт по САМОМУ СЛАБОМУ рекорду (60 и 20 при шаге 3 → не глубже 18)', () => {
    const party = [{ normal: 60 }, { normal: 20 }];
    expect(waypointStart(party, 'normal', 3, 0, 60)).toBe(18);
    expect(waypointStart(party, 'normal', 3, 0, 1e9)).toBe(18);
    expect(waypointStart(party, 'normal', 3, 0, 9)).toBe(9);              // просил мельче — получил мельче
    expect(waypointStart([...party, {}], 'normal', 3, 0, 60), 'новичок в пати — вход').toBe(1);
    expect(waypointStart([], 'normal', 3, 0, 60), 'пустая пати — как без рекорда').toBe(1);
    // Отставший догнал ногами (его рекорд вырос до 21) — метка 21 открылась пати.
    expect(waypointStart([{ normal: 60 }, { normal: 21 }], 'normal', 3, 0, 60)).toBe(21);
  });

  it('метки живой каденции и уровень монстров на них — из одного шва', () => {
    const step = liveStep();
    expect([...step], 'живые места порталов полосы (схема владельца 15.10)').toEqual([3, 6, 9, 12, 15, 18, 20]);
    const r = new ConfigRegistry();
    r.loadAll();
    // Тир — ВКЛЮЧЁННЫЙ в данных (в игре он один): выключенные держит только стенд серверных тестов.
    const diff = r.get('difficulties').find((d) => d.enabled !== false)!;
    const list = openWaypoints({ [diff.id]: 30 }, diff.id, step, 0);
    const rows = list.map((d) => `метка ${String(d).padStart(3)} → монстры ур. ${floorMonsterLevel(diff, d)}`);
    console.log(`\nМЕТКИ ТИРА «${diff.id}» ПРИ РЕКОРДЕ 30 (шаг ${step})\n${rows.join('\n')}`);
    expect(list, '⚠ Ф3: входа в списке нет — он кнопка портала, а не метка').toEqual([3, 6, 9, 12, 15, 18, 21, 24, 27, 30]);
    // ⚠ Уровень монстра на метке — ТОЛЬКО `floorMonsterLevel` (у включённого тира это 1 + (d−1)×floorStep);
    // алтарь обязан печатать его же, а не «глубину» (В6).
    expect(diff.id, 'включённый тир в данных').toBe('normal');
    expect(floorMonsterLevel(diff, 30)).toBe(Math.max(1, Math.round(diff.startLevel + 29 * diff.floorStep)));
    expect(floorMonsterLevel(diff, 30), 'при normal (1 / 1) метка 30 — монстры 30-го уровня').toBe(30);
  });
});

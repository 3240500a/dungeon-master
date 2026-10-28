import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { createRng } from '../formulas/rng.js';
import { floorMonsterLevel } from '../formulas/power.js';
import { generateRunPlan, defaultRunConfig } from './run/generateRunPlan.js';
import { floorChallengeLevel, spawnPacksEl } from './floor.js';
import { Cell, makeGrid } from '../world/grid.js';
import type { DungeonLayout } from './floorCommon.js';

/**
 * ⭐⭐ Г1 «УРОВЕНЬ МОНСТРА = НОМЕР ЭТАЖА»: сторож закона, принятого владельцем 13.10. Глубина — ЕДИНСТВЕННЫЙ источник
 * сложности; мощь героя в уровень монстра не входит нигде; у ФОРМУЛЫ потолка нет.
 *
 * ЧТО МЕРИТ. Настоящую цепочку заселения на настоящем реестре конфигов: глубину узла → `floorChallengeLevel` →
 * `spawnPacksEl` → `generateMonster`. Закон закреплён ЧИСЛАМИ — и не только живыми: таблица `LAW` держит его на
 * НЕСКОЛЬКИХ наборах данных тира, иначе он держался бы лишь пока в `difficulties.json` стоит `startLevel 1` /
 * `floorStep 1`.
 *
 * ⚠⚠ ЧЕМ ЗДЕСЬ ДАЁТСЯ НЕЗАВИСИМОСТЬ ОТ МОЩИ — ПОДПИСЬЮ, А НЕ ЗАМЕРОМ. Прогнать «то же заселение при мощи 1 и 80»
 * нечестно: у `spawnPacksEl` параметра для мощи больше НЕТ, а значит два таких прогона — это один и тот же вызов, и
 * такой ассерт мерил бы детерминизм `rng`, а не независимость (именно так и врал прежний «главный ассерт фазы»:
 * мутация «вернуть мощь в формулу» его НЕ ВАЛИЛА). Поэтому независимость стережёт ассерт ПОДПИСИ: мощи просто негде
 * проехать — ни параметром (у `spawnPacksEl`/`floorChallengeLevel`/`floorMonsterLevel` закреплён ТЕКСТ списка
 * аргументов, а не только `length`: параметр со значением по умолчанию в `length` не попадает, и такой сторож был бы
 * обманчив), ни полем данных тира (лишние поля вроде `offset`/`power` формула не читает). Сверху — `power.test.ts`.
 *
 * ПОЧЕМУ ЗАКОН ТАКОЙ (три звена, каждое проверено по коду, а не по памяти):
 *  1. `floorChallengeLevel` = `floorMonsterLevel(diff, depth)` (`dungeon/floor.ts` → `formulas/power.ts`):
 *     `round(startLevel + (max(1, depth) - 1) × floorStep)`. Для `normal` (единственная включённая сложность:
 *     `startLevel: 1`, `floorStep: 1`) это ровно `depth`.
 *  2. `spawnPacksEl` кладёт в `generateMonster` НЕ сам `floorCL`, а `floorCL - 1` — в босс-комнате
 *     `floorCL - 1 + max(1, round(floorCL × bossRoomDepthPct))`
 *     (строка `const mDepth = ...` в `dungeon/floor.ts`).
 *  3. `generateMonster` считает `level = max(0, opts.depth) + 1 + boost.levelBonus` (`formulas/monstergen.ts`):
 *     его `depth` НОЛЬ-БАЗОВЫЙ — отсюда «−1» в звене 2. `levelBonus` — надбавка редкости из `monster-rarity.json`
 *     (magic 0, rare +2, unique +3), ортогональная глубине.
 *  Итого для `normal`: `уровень монстра = depth` (+2/+3 за редкость, +доля глубины за босс-комнату).
 *  ⭐ 13.10: БОСС-НАДБАВКА — ДОЛЯ (`monster-derive.bossRoomDepthPct` = 0.1, минимум +1), а не плоские «+3».
 *  Жизнь растёт степенью, поэтому плоское число значило ×2.07 к жизни на 4-м уровне и ×1.04 на 200-м: босс был
 *  стеной на мелководье и рядовым в бездне. Доля держит ×1.15…×1.33 на всём диапазоне — это и стережёт
 *  ассерт «босс одинаково тяжелее на любой глубине» ниже.
 *
 * ⭐⭐ 13.10 (Г2, Р6): «ПОТОЛКА НЕТ» — ТЕПЕРЬ И ПРО МИР. Прежде достижимая глубина равнялась `runMaxDepth` по
 * `run-templates[].length.max` (было 15: «Глубокая экспедиция» 14 + финал; сама функция удалена в Р6), и де-факто уровень монстра кончался на
 * ней (босс 17), а глубины 60 / 200 / 1000 ниже были ПРОВЕРКОЙ ФОРМУЛЫ, не воспроизводимой ни при каком сиде.
 * Фаза Г2 сняла потолок там, где он и лежал, — в шаблонах забега: длины и финала у забега нет, слои строятся
 * ОКНОМ и адресуются глубиной (`generateRunPlan`), поэтому узел собирается на любом этаже (сторожа —
 * `dungeon/run/generateRunPlan.test.ts` «потолка нет», `config/difficultyReach.test.ts`). Кривую уровня под это
 * править не пришлось: она и считалась без потолка.
 *
 * ⚠ МУТАЦИИ, КОТОРЫЕ ЭТОТ ФАЙЛ ОБЯЗАН ВАЛИТЬ (каждая проверена руками 13.10 — сделана, прогнана, возвращена):
 *  • возврат мощи героя ПАРАМЕТРОМ (`floorMonsterLevel(diff, depth, el = 0)` и т.п. — даже со значением по умолчанию) — валит «ПОДПИСЬ: мощи негде проехать»;
 *  • возврат мощи ПОЛЕМ ДАННЫХ тира (`diff.offset`, `diff.power` — так и было до Г1) — валит «лишние поля тира
 *    формула не читает»;
 *  • любой потолок уровня или глубины (`Math.min`, кап тира, зажим по лестнице ступеней) — валит «у формулы потолка
 *    нет» (этажи 60/200/1000) и таблицу закона (`старт 6, рамп 1.5` на 201-м этаже);
 *  • подмена рампа константой или игнор `startLevel` — валит таблицу закона на НЕ-живых наборах, даже если живые
 *    1/1 всё ещё сходятся;
 *  • потеря «−1» в `mDepth` (кто-нибудь «починит» на `floorCL`) или лишняя «−1» — валит «уровень = номер этажа»;
 *  • снятие босс-надбавки, её перенос в уровень всей комнаты или возврат к плоскому «+3» — валит «босс = этаж +
 *    доля» и ассерт постоянства отношения жизни;
 *  • подмешивание редкости в глубину (вместо `levelBonus`) — валит «надбавка редкости ортогональна».
 *
 * ЧЕГО ЗАМЕР НЕ КАСАЕТСЯ. Остальные ручки глубины — свои и независимые: вес спавна по тирам глубины
 * (`depth-tiers` → `spawnWeightAt`) и подъём редкости глубиной (`balance.loot.depthRarity` → `rarityAtDepth`, до
 * 15-го этажа множитель ровно 1).
 */

const DEPTH = [1, 5, 10, 15] as const;
const DIFF = 'normal';
const SEED = 20251013;

function reg(): ConfigRegistry { const r = new ConfigRegistry(); r.loadAll(); return r; }
const R = reg();

/** Надбавка редкости к уровню — из тех же данных, что у генератора (`monster-rarity.json`): её вычитаем, чтобы видеть ЧИСТЫЙ закон. */
function levelBonus(rarity: string): number {
  return R.get('monster-rarity').find((x) => x.id === rarity)?.levelBonus ?? 0;
}

/**
 * Мини-этаж на сплошном полу 44×24: шесть боевых комнат (`small`/`large` — обе есть в `packs.json`) и одна
 * босс-комната. `spawnPacksEl` читает только `rooms` + `grid` (+ `decor`, которого здесь нет), поэтому
 * синтетическая раскладка даёт ровно то же заселение, что настоящий генератор, но без его шума.
 */
function floorLayout(): DungeonLayout {
  const grid = makeGrid(44, 24, Cell.Floor);
  const rooms = [
    { x: 1, y: 1, w: 8, h: 8, type: 'small', content: undefined },
    { x: 11, y: 1, w: 8, h: 8, type: 'small', content: undefined },
    { x: 21, y: 1, w: 10, h: 10, type: 'large', content: undefined },
    { x: 1, y: 12, w: 8, h: 8, type: 'small', content: undefined },
    { x: 11, y: 12, w: 10, h: 10, type: 'large', content: undefined },
    { x: 23, y: 13, w: 8, h: 8, type: 'small', content: undefined },
    { x: 33, y: 6, w: 9, h: 9, type: 'boss', content: 'boss' },
  ];
  return { grid, rooms } as unknown as DungeonLayout;
}

/** Босс-комната: по ней `spawnPacksEl` берёт `floorCL - 1 + bossBonus` — её монстров держим отдельно от сетки. */
const BOSS_ROOM = { x: 33, y: 6, w: 9, h: 9 };
const inBoss = (x: number, y: number): boolean => {
  const cx = Math.floor(x / 32), cy = Math.floor(y / 32);
  return cx >= BOSS_ROOM.x && cx < BOSS_ROOM.x + BOSS_ROOM.w && cy >= BOSS_ROOM.y && cy < BOSS_ROOM.y + BOSS_ROOM.h;
};

interface Cell2 {
  depth: number; challengeLevel: number;
  /** Уровни монстров БОЕВЫХ комнат (босс исключён), как их видит игра. */
  levels: number[];
  /** Те же уровни минус надбавка редкости — «чистый» закон без ортогонального буста. */
  pure: number[];
  /** Босс-комната отдельно: её `mDepth` = `floorCL - 1 + max(1, round(floorCL × bossRoomDepthPct))`. */
  bossPure: number[];
}

/** Полная цепочка заселения на глубине `depth` — ровно так, как её зовёт сервер (`Room.enterNode`): без мощи, по глубине. */
function measure(depth: number, r: ConfigRegistry = R): Cell2 {
  const list = spawnPacksEl(r, floorLayout(), depth, DIFF, createRng(SEED), undefined, 1, '');
  const levels: number[] = [], pure: number[] = [], bossPure: number[] = [];
  for (const s of list) {
    const p = s.def.level - levelBonus(s.def.rarity);
    if (inBoss(s.x, s.y)) { bossPure.push(p); continue; }
    levels.push(s.def.level); pure.push(p);
  }
  return { depth, challengeLevel: floorChallengeLevel(r, DIFF, depth), levels, pure, bossPure };
}

const grid: Cell2[] = DEPTH.map((d) => measure(d));

/**
 * ⭐⭐ ЗАКОН ПО ДАННЫМ, А НЕ ПО ЖИВЫМ ЧИСЛАМ. Ожидаемые уровни здесь — ЛИТЕРАЛЫ (посчитаны на бумаге), а не
 * повторение формулы кодом: иначе ассерт сверял бы реализацию с собой. Наборы взяты так, чтобы рамп был и целым, и
 * дробным, и нулевым, а старт — не единицей: подмена `floorStep` константой или игнор `startLevel` валят таблицу,
 * хотя живые 1/1 продолжали бы сходиться.
 */
const LAW: { name: string; startLevel: number; floorStep: number; want: [number, number][] }[] = [
  { name: 'живая «Средняя»: старт 1, рамп 1', startLevel: 1, floorStep: 1, want: [[1, 1], [5, 5], [15, 15], [60, 60], [200, 200]] },
  { name: 'старт 6, рамп 1.5 (прежняя «Сложная»)', startLevel: 6, floorStep: 1.5, want: [[1, 6], [3, 9], [5, 12], [15, 27], [201, 306]] },
  { name: 'старт 11, рамп 0.5 (дробный, медленный)', startLevel: 11, floorStep: 0.5, want: [[1, 11], [3, 12], [11, 16], [15, 18], [201, 111]] },
  { name: 'старт 4, рамп 0 (тир без кривой — глубина не поднимает)', startLevel: 4, floorStep: 0, want: [[1, 4], [5, 4], [200, 4]] },
];

/** Реестр, у которого у тира `normal` подменены только две ручки кривой (`cross: false` — правка одной таблицы). */
function regWith(startLevel: number, floorStep: number): ConfigRegistry {
  const r = reg();
  r.reload({ difficulties: r.get('difficulties').map((d) => (d.id === DIFF ? { ...d, startLevel, floorStep } : d)) }, { cross: false });
  return r;
}

/** Надбавка босс-комнаты: ДОЛЯ уровня этажа, минимум +1 (`monster-derive.bossRoomDepthPct`, ⭐ 13.10 — было плоское «+3»). */
const bossBonus = (level: number): number => Math.max(1, Math.round(level * R.get('monster-derive').bossRoomDepthPct));

describe('Г1: уровень монстра = номер этажа', () => {
  it('таблица замера (печать) — этаж × уровень монстров', () => {
    const pad = (s: string | number, n: number): string => String(s).padStart(n);
    const rows = [
      'Г1: уровень монстра = номер этажа',
      `сложность «${DIFF}» (startLevel 1, floorStep 1), seed ${SEED}, босс-комната отдельно`,
      ' этаж | монстры ур. | монстров | ур. мин | ур. макс | без редк. | босс (без редк.)',
      '------+-------------+----------+---------+----------+-----------+------------------',
    ];
    for (const c of grid) {
      const lo = Math.min(...c.levels), hi = Math.max(...c.levels);
      const p0 = Math.min(...c.pure), p1 = Math.max(...c.pure);
      const b0 = Math.min(...c.bossPure), b1 = Math.max(...c.bossPure);
      rows.push([
        pad(c.depth, 5), pad(c.challengeLevel, 12), pad(c.levels.length, 9),
        pad(lo, 8), pad(hi, 9), pad(p0 === p1 ? p0 : `${p0}–${p1}`, 10),
        pad(b0 === b1 ? b0 : `${b0}–${b1}`, 17),
      ].join(' |'));
    }
    console.log(rows.join('\n'));
    expect(grid.length).toBe(DEPTH.length);
    for (const c of grid) expect(c.levels.length, `этаж ${c.depth} заселён`).toBeGreaterThan(5);
  });

  it('⭐⭐ ПОДПИСЬ: мощи НЕГДЕ проехать в заселение — у функций нет для неё параметра', () => {
    // ⚠ СПИСОК АРГУМЕНТОВ ИЗМЕНИЛСЯ — ПЕРЕЧИТАЙ ФУНКЦИЮ: не вернулась ли в неё мощь героя. Он закреплён ТЕКСТОМ, а не
    // только `length`: параметр со значением по умолчанию (`el = 0`) в `length` не попадает и такой ассерт обманул бы.
    for (const [fn, want] of [
      [floorMonsterLevel, 'diff, depth'],
      [floorChallengeLevel, 'reg, difficultyId, depth'],
      // ⭐⭐ 15.10 (Г6, кооп): добавился `players` — ЧИСЛО ИГРОКОВ, и это не мощь: оно множит только ЖИЗНЬ готового
      // монстра (`balance.coop.hpPerExtraPlayer`), после `generateMonster`, не касаясь ни уровня, ни потока `rng`.
      // Сторож подписи держится: мощи по-прежнему негде проехать, а новый параметр назван и объяснён.
      // ⭐⭐ 15.10 (Г8-2): добавился `bossRank` — РАНГ БОССА узла (мини/крепкий/актовый, лестница полосы). Он множит
      // надбавку уровня боссовой КОМНАТЫ и жизнь её монстров, но уровня этажа не касается: мощи по-прежнему негде проехать.
      // ⭐⭐ Ф5-0 (16.10): добавился `buffs` — МНОЖИТЕЛИ МОДИФИКАТОРОВ ОТРЕЗКА (пачка, редкость, жизнь, урон,
      // скорости). Это не мощь героя: они приходят из ВЫБОРА алтаря через `floorSpec.modifiers`, применяются
      // после `generateMonster` и уровня этажа не касаются — мощи по-прежнему негде проехать.
      [spawnPacksEl, 'reg, layout, depth, difficultyId, rng, poolOverride, packDensity = 1, floorId = "", players = 1, bossRank, buffs'],
    ] as [(...a: never[]) => unknown, string][]) {
      // ⚠ Ф5-0 (16.10): умолчание, сославшееся на ИМПОРТ (`buffs = NO_RUN_BUFFS`), сборщик переписывает в
      // `__vite_ssr_import_*` — сравнивать такую подпись значит ловить сборщик, а не правку кода. Поэтому
      // значения по умолчанию из обеих строк срезаются, а САМИ ПАРАМЕТРЫ (их состав и порядок) сторожатся.
      const strip = (s: string): string => s.replace(/\s*=\s*[^,]+/g, '');
      const got = strip((/^function\s+\w+\(([^)]*)\)/.exec(String(fn))?.[1] ?? '?').replace(/'/g, '"').replace(/\s+/g, ' ').trim());
      expect(got, `подпись ${fn.name}: лишний аргумент — не мощь ли это?`).toBe(strip(want));
    }
    expect(floorMonsterLevel.length, 'floorMonsterLevel(diff, depth)').toBe(2);
    expect(floorChallengeLevel.length, 'floorChallengeLevel(reg, difficultyId, depth)').toBe(3);
    expect(spawnPacksEl.length, 'spawnPacksEl: 6 аргументов до первого со значением по умолчанию').toBe(6);
  });

  it('⭐⭐ ПОДПИСЬ: лишние поля тира формула не читает (мощь не просачивается данными)', () => {
    const clean = R.get('difficulties').find((d) => d.id === DIFF)!;
    // Ровно те поля, которыми мощь входила до Г1 (`offsetMode`/`offset`), плюс любые «мощные» имена: формула обязана
    // смотреть только на `startLevel`/`floorStep`.
    const dirty = { ...clean, offsetMode: 'flat', offset: 12, power: 80, el: 80, startChallenge: 80 } as unknown as typeof clean;
    for (const d of [1, 5, 15, 200]) {
      expect(floorMonsterLevel(dirty, d), `этаж ${d}: лишние поля тира двигают уровень`).toBe(floorMonsterLevel(clean, d));
    }
  });

  it('⭐⭐ ЗАКОН ПО ДАННЫМ: уровень монстра = startLevel + (этаж−1)×floorStep на РАЗНЫХ наборах тира', () => {
    const out: string[] = ['набор тира → этаж: уровень монстров (босс)'];
    for (const v of LAW) {
      const r = regWith(v.startLevel, v.floorStep);
      const line: string[] = [];
      for (const [depth, want] of v.want) {
        expect(floorMonsterLevel(r.get('difficulties').find((d) => d.id === DIFF)!, depth), `${v.name}: формула на этаже ${depth}`).toBe(want);
        expect(floorChallengeLevel(r, DIFF, depth), `${v.name}: строка HUD на этаже ${depth}`).toBe(want);
        const c = measure(depth, r);
        expect([...new Set(c.pure)], `${v.name}: уровни монстров на этаже ${depth}`).toEqual([want]);
        expect([...new Set(c.bossPure)], `${v.name}: босс на этаже ${depth}`).toEqual([want + bossBonus(want)]);
        line.push(`${depth}: ${want} (${want + bossBonus(want)})`);
      }
      out.push(`  ${v.name} — ${line.join(', ')}`);
    }
    console.log(out.join('\n'));
  });

  it('⭐ закон для «normal»: уровень монстра = номер этажа (и `floorChallengeLevel` = тот же `depth`)', () => {
    for (const c of grid) {
      expect(c.challengeLevel, `монстры ур. на этаже ${c.depth}`).toBe(c.depth);
      // Каждый монстр боевой комнаты — РОВНО `depth` (разброс даёт только надбавка редкости, её вычли).
      expect([...new Set(c.pure)], `уровни монстров на этаже ${c.depth}`).toEqual([c.depth]);
    }
  });

  it('⭐⭐ босс ОДИНАКОВО тяжелее на любой глубине: отношение жизни босс/рядовой не разъезжается', () => {
    // ⚠ ЭТО И ЕСТЬ СМЫСЛ ДОЛИ. Плоская надбавка «+3» под степенной кривой жизни (`hpVitPower` 1.76) давала
    // ×1.77 на 1-м уровне, ×2.07 на 4-м и ×1.04 на 200-м — босс был стеной там, где игрок только начал, и
    // рядовым там, где он должен быть боссом. Мерим ЧИСТОЕ действие надбавки на жизнь одного и того же
    // шаблона: hp(уровень + надбавка) / hp(уровень). Вернёшь плоское число — разброс улетит за порог.
    const s = R.get('monster-derive');
    const hpOf = (level: number): number => {
      const g = 1 + Math.max(0, level - 1) * s.levelGrowth;        // рост атрибутов за уровень
      const vit = 10 * g;                                          // типовой боец ростера
      return s.hpBase + vit * s.hpPerVit * Math.pow(Math.max(1, level) / 10, s.hpVitPower) + level * s.hpPerLevel;
    };
    const ratios = [1, 2, 4, 8, 15, 30, 60, 120, 200].map((d) => hpOf(d + bossBonus(d)) / hpOf(d));
    const lo = Math.min(...ratios), hi = Math.max(...ratios);
    expect(lo, `босс слабее рядового? отношения ${ratios.map((r) => r.toFixed(2)).join(', ')}`).toBeGreaterThan(1.05);
    expect(hi / lo, `разброс отношения жизни по глубине ${lo.toFixed(2)}…${hi.toFixed(2)}`).toBeLessThan(1.45);
  });

  it('босс-комната — та же формула плюс ДОЛЯ уровня (`bossRoomDepthPct`, минимум +1)', () => {
    for (const c of grid) expect([...new Set(c.bossPure)], `босс на этаже ${c.depth}`).toEqual([c.depth + bossBonus(c.depth)]);
  });

  it('⭐ ПОТОЛКА НЕТ НИ У ФОРМУЛЫ, НИ У МИРА: этажи 60, 200 и 1000 дают монстров 60, 200 и 1000 уровня', () => {
    // ⭐⭐ 13.10 (Г2, Р6): дна у мира больше нет — `runMaxDepth` УДАЛЕНА, и «потолка нет» проверяется делом, а не числом:
    // узел на 1000-м этаже строится настоящим генератором. Прежняя оговорка «в забеге не воспроизводимо» снята.
    const tpl = { id: 'спуск', tier: (R.get('difficulties').find((d) => d.enabled !== false) ?? R.get('difficulties')[0]!).id };
    const deep = generateRunPlan(R, defaultRunConfig(R, 11), undefined, { from: 1000, to: 1000 });
    expect(deep.nodes[0]?.depth, 'узел 1000-го этажа собирается (потолка мира нет)').toBe(1000);
    const out: string[] = ['потолка нет ни у формулы, ни у мира (Г2) — этажи ниже достижимы спуском:'];
    for (const d of [60, 200, 1000]) {
      const c = measure(d);
      expect(c.challengeLevel, `строка HUD на этаже ${d}`).toBe(d);
      expect([...new Set(c.pure)], `уровни монстров на этаже ${d}`).toEqual([d]);
      expect([...new Set(c.bossPure)], `босс на этаже ${d}`).toEqual([d + bossBonus(d)]);
      out.push(`  этаж ${d}: монстры ур.${d} (босс ${d + bossBonus(d)})`);
    }
    console.log(out.join('\n'));
  });

  it('глубина поднимает уровень шагом `floorStep` (=1) — это звено Г1 оставляет', () => {
    const byD = DEPTH.map((d) => grid.find((c) => c.depth === d)!);
    for (let i = 1; i < byD.length; i++) {
      expect(Math.min(...byD[i]!.pure) - Math.min(...byD[i - 1]!.pure), `этаж ${byD[i - 1]!.depth}→${byD[i]!.depth}`)
        .toBe(byD[i]!.depth - byD[i - 1]!.depth);
    }
  });

  it('надбавка редкости ортогональна: сырые уровни отличаются от чистых ровно на `levelBonus`', () => {
    const seen = new Set<number>();
    for (const c of grid) for (const l of c.levels) seen.add(l - c.depth);
    // Боевая комната не форсирует unique (+3) — встречаются только normal/magic (0) и rare (+2).
    expect([...seen].sort((a, b) => a - b).every((d) => d === 0 || d === 2)).toBe(true);
  });
});

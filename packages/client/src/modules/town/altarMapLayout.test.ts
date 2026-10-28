/**
 * ⭐⭐ Г8-3 (15.10, просьба владельца): СТОРОЖ ЦЕПИ МЕТОК НА АЛТАРЕ — «не пиши все этажи, а только карту
 * вейпоинтов… давай одну только сверху вниз, и пусть она чуть ветвится, не так ровно будет, а кривая».
 *
 * Что файл обязан валить:
 *  • цепь, решающую САМА, что открыто (второе правило доступа рядом с `openWaypoints`/`waypointStart` сервера —
 *    игрок увидел бы метку, которой сервер не даст);
 *  • узел, который не метка (между метками выбирать нечего — начать можно только с портала);
 *  • босса, потерянного между метками, или босса, нарисованного не на том звене;
 *  • ветвление ШИРЕ, чем разрешает шаблон (цепь обещала бы развилки, которых генератор не поставит), и ветвление
 *    на звене с боссом (его слой форсит ширину 1);
 *  • ⚠⚠ ГЕОМЕТРИЮ, ПОСЧИТАННУЮ ТРИГОНОМЕТРИЕЙ ИЛИ СЛУЧАЙНОСТЬЮ: координаты обязаны быть целыми и ОДИНАКОВЫМИ
 *    от прогона к прогону — на них стоит эталон порта Unity, а точность `Math.sin` платформозависима;
 *  • отсутствие предохранителя на рекорд: при рекорде 10 000 цепь обязана остаться конечной, а метки, не попавшие
 *    в неё, — остаться доступными (`hiddenMarks`).
 */
import { describe, it, expect } from 'vitest';
import { ConfigRegistry, openWaypoints, isWaypoint, bandDepth, floorMonsterLevel, WAYPOINT_ENTRY_DEPTH } from '@dm/shared';
import { altarChainView, chainHash, CHAIN_GEOM, type AltarChainView } from './altarMapLayout.js';

function reg(): ConfigRegistry {
  const r = new ConfigRegistry();
  r.loadAll();
  return r;
}
const cfg = reg();
const access = cfg.get('balance').dungeonAccess;
const DIFF = cfg.get('difficulties')[0]!;
const LVL = (d: number): number => floorMonsterLevel(DIFF, d);

function view(record: number, pick = WAYPOINT_ENTRY_DEPTH, widthMax = 3): AltarChainView {
  const marks = openWaypoints({ [DIFF.id]: record }, DIFF.id, access.portalsAt, access.contentCycle);
  return altarChainView(marks, record, access.portalsAt, access.contentCycle, access.bossLadder, pick, LVL, widthMax);
}

describe('⭐⭐ Г8-3: цепь меток на алтаре', () => {
  it('⭐⭐ УЗЛЫ = СПИСОК СЕРВЕРА: цепь не решает доступ сама, и каждый узел — МЕТКА, а не произвольный этаж', () => {
    for (const record of [0, 1, 3, 7, 20, 21, 41, 137]) {
      const marks = openWaypoints({ [DIFF.id]: record }, DIFF.id, access.portalsAt, access.contentCycle);
      const v = altarChainView(marks, record, access.portalsAt, access.contentCycle, access.bossLadder, WAYPOINT_ENTRY_DEPTH, LVL);
      expect(v.nodes.map((n) => n.depth), `рекорд ${record}: узлы = метки сервера`).toEqual([...marks].sort((a, b) => a - b));
      expect(v.openCount, `рекорд ${record}: счётчик открытых — длина списка сервера`).toBe(marks.length);
      for (const n of v.nodes) {
        const wp = isWaypoint(n.depth, access.portalsAt, access.contentCycle) || n.depth === WAYPOINT_ENTRY_DEPTH;
        expect(wp, `этаж ${n.depth}: узел обязан быть меткой`).toBe(true);
        expect(n.open, `этаж ${n.depth}: узел из списка сервера — открыт`).toBe(true);
        expect(n.level, `этаж ${n.depth}: уровень монстров — из той же функции, что в бою`).toBe(LVL(n.depth));
        expect(n.place, `этаж ${n.depth}: место в круге`).toBe(bandDepth(n.depth, access.contentCycle));
      }
    }
  });

  it('⭐⭐ ЧТО МЕЖДУ МЕТКАМИ: на звене либо босс лестницы, либо счёт боевых этажей — и одно исключает другое', () => {
    const v = view(60);
    const ladder = new Map(access.bossLadder.map((x) => [x.at, x.rank]));
    let bosses = 0;
    for (const link of v.links) {
      // Что генератор поставит между этими метками — считаем здесь независимо, теми же чистыми функциями.
      const want: { d: number; rank: string }[] = [];
      for (let d = link.from + 1; d < link.to; d++) {
        if (isWaypoint(d, access.portalsAt, access.contentCycle)) continue;
        const r = ladder.get(bandDepth(d, access.contentCycle));
        if (r) want.push({ d, rank: r });
      }
      if (want.length) {
        expect(link.boss, `звено ${link.from}→${link.to}: босс обязан быть`).toBeTruthy();
        expect([link.boss!.depth, link.boss!.rank], `звено ${link.from}→${link.to}: тот самый босс`).toEqual([want[0]!.d, want[0]!.rank]);
        expect(link.boss!.level, 'уровень босса — общей функцией').toBe(LVL(want[0]!.d));
        expect(link.gap, 'подписи «N эт.» на звене с боссом нет — иначе два обещания об одном').toBeNull();
        bosses += 1;
      } else {
        expect(link.boss, `звено ${link.from}→${link.to}: босса быть не должно`).toBeNull();
        expect(link.gap?.text, `звено ${link.from}→${link.to}: счёт боевых этажей`).toBe(`${link.to - link.from - 1} эт.`);
      }
    }
    expect(bosses, 'три босса на круг × три круга').toBe(9);
    // eslint-disable-next-line no-console
    console.log('Г8-3 ЦЕПЬ (рекорд 60): узлов ' + v.nodes.length + ', звеньев ' + v.links.length
      + ', боссов на звеньях ' + bosses + ', разделителей кругов ' + v.dividers.length
      + '; полотно ' + v.width + '×' + v.height);
  });

  it('⭐⭐ ВЕТВЛЕНИЕ НЕ ОБЕЩАЕТ ЛИШНЕГО: жил не больше ширины шаблона, на звене с боссом — одна, несущая ровно одна', () => {
    for (const widthMax of [1, 2, 3, 9]) {
      const v = view(60, WAYPOINT_ENTRY_DEPTH, widthMax);
      const cap = Math.max(1, Math.min(3, widthMax));
      for (const link of v.links) {
        expect(link.strands.length, `ширина ${widthMax}, звено ${link.from}→${link.to}`).toBeLessThanOrEqual(cap);
        expect(link.strands.length, 'жила всегда хотя бы одна').toBeGreaterThan(0);
        if (link.boss) expect(link.strands.length, 'на звене с боссом жила одна — его слой форсит ширину 1').toBe(1);
        expect(link.strands.filter((s) => s.main).length, 'несущая жила ровно одна').toBe(1);
      }
      if (widthMax === 1) {
        expect(v.links.every((l) => l.strands.length === 1), 'шаблон шириной 1 — прямая цепь без ветвления').toBe(true);
      }
      if (widthMax >= 2) {
        expect(v.links.some((l) => l.strands.length > 1), `ширина ${widthMax}: ветвление где-то есть`).toBe(true);
      }
    }
  });

  it('⚠⚠ ГЕОМЕТРИЯ — ЦЕЛАЯ И ВОСПРОИЗВОДИМАЯ: координаты целые, в полотне, и два прогона совпадают бит в бит', () => {
    const a = view(60), b = view(60);
    expect(JSON.stringify(a), 'два прогона — один и тот же результат (никакой случайности)').toBe(JSON.stringify(b));
    const whole = (v: number): boolean => Number.isInteger(v);
    for (const n of a.nodes) {
      expect(whole(n.x) && whole(n.y), `узел ${n.depth}: целые координаты`).toBe(true);
      expect(n.x - a.r >= 0 && n.x + a.r <= a.width, `узел ${n.depth}: в полотне по ширине`).toBe(true);
      expect(n.y >= 0 && n.y <= a.height, `узел ${n.depth}: в полотне по высоте`).toBe(true);
    }
    for (const l of a.links) {
      const from = a.nodes.find((n) => n.depth === l.from)!, to = a.nodes.find((n) => n.depth === l.to)!;
      for (const s of l.strands) {
        expect(s.points.length, 'точек на жиле — как в геометрии').toBe(CHAIN_GEOM.samples);
        for (const p of s.points) expect(whole(p.x) && whole(p.y), `звено ${l.from}→${l.to}: целые точки`).toBe(true);
        // Жила обязана идти ВНИЗ: точки по возрастанию y — иначе цепь завязывается узлом.
        for (let i = 1; i < s.points.length; i++) {
          expect(s.points[i]!.y >= s.points[i - 1]!.y, `звено ${l.from}→${l.to}: жила идёт вниз`).toBe(true);
        }
        // И соединять РОВНО свои узлы.
        expect([s.points[0]!.x, s.points[0]!.y], `звено ${l.from}→${l.to}: начало у своего узла`).toEqual([from.x, from.y + a.r]);
        expect([s.points.at(-1)!.x, s.points.at(-1)!.y], `звено ${l.from}→${l.to}: конец у своего узла`).toEqual([to.x, to.y - a.r]);
      }
    }
    // ⚠ Кривая, а не прямая: узлы обязаны гулять по горизонтали (иначе «не так ровно» не выполнено).
    const xs = a.nodes.map((n) => n.x);
    expect(Math.max(...xs) - Math.min(...xs), 'размах кривой').toBeGreaterThan(CHAIN_GEOM.amp);
    // eslint-disable-next-line no-console
    console.log('Г8-3 КРИВАЯ: x от ' + Math.min(...xs) + ' до ' + Math.max(...xs)
      + ' (середина ' + CHAIN_GEOM.width / 2 + '), шаг по вертикали ' + CHAIN_GEOM.stepY);
  });

  it('⚠ ХЕШ ИЗГИБА — БЕЗ ТРИГОНОМЕТРИИ И В РАМКАХ uint32 (на нём стоит паритет с Unity)', () => {
    for (const d of [1, 2, 3, 19, 20, 137, 9999, 10_000]) {
      const h = chainHash(d);
      expect(Number.isInteger(h) && h >= 0 && h <= 0xffffffff, `хеш ${d} — целый uint32`).toBe(true);
      expect(chainHash(d), 'и повторяем').toBe(h);
    }
    expect(new Set([1, 2, 3, 4, 5].map(chainHash)).size, 'соседние глубины дают разные изгибы').toBe(5);
  });

  it('⭐ КРУГИ РАЗМЕЧЕНЫ, А ЦЕПЬ ОДНА: разделитель стоит перед первым местом круга и ровно один на круг', () => {
    const v = view(100);
    const circles = v.dividers.map((d) => d.circle);
    expect(new Set(circles).size, 'на круг — один разделитель').toBe(circles.length);
    for (const d of v.dividers) {
      expect(d.label, 'подпись разделителя').toBe(`круг ${d.circle}`);
      // ⚠ Узла с местом 1 не бывает (первое место круга не портал), поэтому черта стоит МЕЖДУ
      // последней меткой прошлого круга и первой меткой нового.
      const prev = [...v.nodes].filter((n) => Math.ceil(n.depth / access.contentCycle) < d.circle).pop()!;
      const next = v.nodes.find((n) => Math.ceil(n.depth / access.contentCycle) === d.circle)!;
      expect(d.y > prev.y && d.y < next.y, `круг ${d.circle}: черта между ${prev.depth} и ${next.depth}`).toBe(true);
    }
    expect(circles, 'круги по порядку: 2, 3, 4, 5').toEqual([2, 3, 4, 5]);
  });

  it('⭐ ПРЕДОХРАНИТЕЛЬ ГЛУБИНЫ: цепь конечна, а не попавшие в неё метки ОСТАЮТСЯ доступны', () => {
    // ⭐⭐ Ф3 (16.10): вход БОЛЬШЕ НЕ МЕТКА — у свежего героя цепь ПУСТА, а «начать сначала» даёт портал города.
    expect(view(0).nodes.length, 'свежий герой — меток нет вовсе').toBe(0);
    expect(view(0).hiddenMarks.length, 'и прятать нечего').toBe(0);
    expect(view(0).hidden, 'строки про скрытые нет').toBeNull();
    const deep = view(10_000);
    expect(deep.nodes.length, 'узлов не больше предохранителя').toBeLessThanOrEqual(CHAIN_GEOM.maxMarks);
    expect(deep.nodes.at(-1)!.depth, 'последний узел — рекорд').toBe(10_000);
    const marks = openWaypoints({ [DIFF.id]: 10_000 }, DIFF.id, access.portalsAt, access.contentCycle);
    expect(deep.hiddenMarks.length + deep.nodes.length, '⭐⭐ вместе — ВСЕ открытые метки, ни одна не потеряна').toBe(marks.length);
    expect([...deep.hiddenMarks, ...deep.nodes.map((n) => n.depth)].sort((a, b) => a - b), 'и это ровно они')
      .toEqual([...marks].sort((a, b) => a - b));
    expect(deep.hidden, 'скрытые названы словами').toContain(`${deep.hiddenMarks.length}`);
    // eslint-disable-next-line no-console
    console.log('Г8-3 ГЛУБОКИЙ РЕКОРД 10000: меток ' + marks.length + ' = в цепи ' + deep.nodes.length
      + ' + рядом ' + deep.hiddenMarks.length + '; высота полотна ' + deep.height);
  });

  it('⭐ ВЫБОР ВИДЕН: отмечен ровно один узел, и строка «Старт» называет его уровень монстров', () => {
    const v = view(40, 23);
    expect(v.nodes.filter((n) => n.pick).map((n) => n.depth), 'помечен ровно один узел').toEqual([23]);
    expect(v.start).toContain('этаж 23');
    expect(v.start).toContain(`ур. ${LVL(23)}`);
    expect(v.start, 'и сказано, сколько меток открыто').toContain(`${v.openCount}`);
    expect(v.nodes.every((n) => !n.entry), '⚠ Ф3: узла-входа в цепи нет — только настоящие метки').toBe(true);
    expect(v.nodes[0]!.title, '⚠ Ф3: первый узел цепи — обычный портал, входа в ней нет').toContain('Портал');
  });

  it('⚠ МУСОРНЫЕ ВХОДЫ НЕ РОНЯЮТ ЦЕПЬ: цикл 0/NaN, пустая лестница, порченый рекорд', () => {
    for (const c of [0, 1, Number.NaN]) {
      const v = altarChainView([1], 1, access.portalsAt, c as number, [], WAYPOINT_ENTRY_DEPTH, LVL);
      expect(v.nodes.length, `цикл ${c}: цепь конечна`).toBe(1);
      expect(v.links.length, `цикл ${c}: звеньев нет`).toBe(0);
    }
    const bad = altarChainView([1], Number.NaN, access.portalsAt, access.contentCycle, access.bossLadder, WAYPOINT_ENTRY_DEPTH, LVL);
    expect(bad.record, 'порченый рекорд — ноль, а не NaN').toBe(0);
    const noLadder = altarChainView([1, 3, 6], 6, access.portalsAt, access.contentCycle,
      undefined as unknown as { at: number; rank: 'mini' }[], WAYPOINT_ENTRY_DEPTH, LVL);
    expect(noLadder.links.every((l) => l.boss === null), 'без лестницы боссов на звеньях нет').toBe(true);
  });
});

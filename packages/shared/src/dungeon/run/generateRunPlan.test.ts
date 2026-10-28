import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../../config/registry.js';
import { generateRunPlan, defaultRunConfig } from './generateRunPlan.js';
import { waypointWarnings } from './waypointData.js';
import { generateFloor } from '../generateFloor.js';
import { resolveFloorSpec } from '../floorSpec.js';
import { spawnPacksEl } from '../floor.js';
import { createRng } from '../../formulas/rng.js';
import { isWaypoint, bandDepth } from '../../formulas/power.js';
import { validate } from '../floorCommon.js';
import type { RunNode, RunPlan } from './types.js';

/**
 * ⭐⭐ 13.10 (Г2): СТОРОЖ БЕСКОНЕЧНОГО СПУСКА. Граф забега адресуется ГЛУБИНОЙ, а не порядком: у каждого слоя свой
 * сид (`layerSeed`), поэтому слой 500 строится без слоёв 1..499 и стоит столько же, сколько слой 1. Генератор
 * отдаёт ОКНО слоёв (`RunWindow`), финала и длины у забега нет, каденция привала/босса — чистая функция глубины.
 *
 * ⚠ МУТАЦИИ, КОТОРЫЕ ЭТОТ ФАЙЛ ОБЯЗАН ВАЛИТЬ. Каждая проверена руками 13.10 — наложена, прогнана, возвращена, md5
 * генератора сверен с исходным (`21f7e99b…`); в скобках — какие тесты её ловят на самом деле, а не «по замыслу»:
 *  • ОДИН ПОТОК НА ВЕСЬ ГРАФ (`createRng(seed)` вынесен из цикла слоёв, `widthAt` от того же сида — ровно как было
 *    до Г2) → «АДРЕСУЕМОСТЬ ГЛУБИНОЙ» + «у каждого узла есть выход…» (2 теста). Поток, лишь пересеваемый сидом
 *    ЗАБЕГА на каждом слое, ловится вторым из них: ширина слоя у рёбер и у самого слоя расходится;
 *  • СДВИГ НА ОДИН БРОСОК (ширину тянут не первым броском потока слоя) → «у каждого узла есть выход, у каждого —
 *    входящее, и спуск доходит до дна окна»: рёбра указывают на полосу, которой в следующем слое нет;
 *  • ОБРЕЗКА РЁБЕР ПО КРАЮ ОКНА (`if (d >= to) continue`) → «АДРЕСУЕМОСТЬ», «ПОТОЛКА НЕТ», «у каждого узла есть
 *    выход…», «сборка из членов» (4 теста): край окна становится тупиком, а `exitCount` — зависимым от окна;
 *  • ДЖИТТЕР (или любая память) В КАДЕНЦИИ ПРИВАЛА → «КАДЕНЦИЯ ЧИСТАЯ» + «план честно следует шаблону+членству»;
 *  • ВОЗВРАТ ОСОБОГО «ОДИНОЧНОГО ВХОДА» на `d === 1` → «особого узкого входа на первом этаже НЕТ»;
 *  • ЛЮБОЙ ПОТОЛОК ГЛУБИНЫ (`Math.min(to, 15)`, кап, `d <= L`) → 6 тестов, включая «узел на 10 000» и
 *    «генератор выдаёт узел на произвольной глубине» из `config/difficultyReach.test.ts`;
 *  • `layerSeed` БЕЗ СИДА ЗАБЕГА (только от глубины) → «СИД ЗАБЕГА РЕШАЕТ ВСЁ»;
 *  • ВОЗВРАТ ФИНАЛЬНОГО УЗЛА (последний слой окна без рёбер) → 5 тестов, включая «у каждого узла есть выход…» и
 *    «узел на произвольной глубине не тупик».
 */

function reg(): ConfigRegistry {
  const r = new ConfigRegistry();
  r.loadAll();
  return r;
}

/** Слой окна (узлы одной глубины, по полосам) — в виде, сравнимом бит в бит. */
function layer(plan: RunPlan, depth: number): string {
  return JSON.stringify(plan.nodes.filter((n) => n.depth === depth).sort((a, b) => a.lane - b.lane));
}

/** BFS от `startId` по рёбрам — множество достижимых id (рёбра за край окна отбрасываются). */
function reachable(plan: RunPlan): Set<string> {
  const byId = new Map(plan.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>([plan.startId]);
  const q = [plan.startId];
  for (let h = 0; h < q.length; h++) {
    const n = byId.get(q[h]!);
    if (!n) continue;
    for (const e of n.edges) if (byId.has(e.to) && !seen.has(e.to)) { seen.add(e.to); q.push(e.to); }
  }
  return seen;
}

describe('generateRunPlan — окно слоёв бесконечного спуска', () => {
  it('⭐⭐ АДРЕСУЕМОСТЬ ГЛУБИНОЙ: слой из окна {500,502} бит в бит равен тому же слою из окна {1,502}', () => {
    const r = reg();
    const cfg = defaultRunConfig(r, 777);
    const deep = generateRunPlan(r, cfg, undefined, { from: 500, to: 502 });
    const whole = generateRunPlan(r, cfg, undefined, { from: 1, to: 502 });
    expect(deep.nodes.length, 'глубокое окно пустым быть не может').toBeGreaterThan(0);
    for (const d of [500, 501, 502]) {
      expect(layer(deep, d), `слой ${d}: узлы, роли, модификаторы, сиды этажей и рёбра`).toEqual(layer(whole, d));
    }
    // И наоборот: мелкое окно = те же слои, что у большого (вход в спуск — свой у каждого окна).
    const head = generateRunPlan(r, cfg, undefined, { from: 1, to: 3 });
    for (const d of [1, 2, 3]) expect(layer(head, d), `слой ${d}`).toEqual(layer(whole, d));
    expect(deep.startId).toBe('n500_0');
    expect(head.startId).toBe('n1_0');
  });

  it('⭐ ЦЕНА НЕ РАСТЁТ С ГЛУБИНОЙ: окно одного размера на 1 / 100 / 1000 / 100000 — та же форма, то же время', () => {
    const r = reg();
    const cfg = defaultRunConfig(r, 4242);
    const widthMax = r.get('balance').dungeonAccess.width.max;
    const SIZE = 3;   // слоёв в окне
    const out: string[] = [];
    const times: number[] = [];
    for (const from of [1, 100, 1000, 100000]) {
      const t0 = performance.now();
      let plan!: RunPlan;
      const REP = 20;
      for (let i = 0; i < REP; i++) plan = generateRunPlan(r, cfg, undefined, { from, to: from + SIZE - 1 });
      const ms = (performance.now() - t0) / REP;
      times.push(ms);
      const depths = [...new Set(plan.nodes.map((n) => n.depth))].sort((a, b) => a - b);
      expect(depths, `окно с глубины ${from}: ровно ${SIZE} слоёв`).toEqual([from, from + 1, from + 2]);
      expect(plan.nodes.length, `узлов в окне с ${from}`).toBeLessThanOrEqual(SIZE * widthMax);
      expect(plan.nodes.length, `узлов в окне с ${from}`).toBeGreaterThanOrEqual(SIZE);
      out.push(`  глубина ${from}: узлов ${plan.nodes.length}, ${ms.toFixed(3)} мс`);
    }
    console.log(['цена окна из 3 слоёв (среднее по 20 прогонам):', ...out].join('\n'));
    // Форма — ассертом выше; время — печатью, но порядок величины сторожим: линейная по глубине сборка (слои 1..d)
    // на 100 000-м слое стоила бы десятки миллисекунд против десятых на первом.
    expect(times[3]!, `время на 100000-м слое ${times[3]!.toFixed(3)} мс против ${times[0]!.toFixed(3)} мс на первом`)
      .toBeLessThan(times[0]! * 8 + 3);
  });

  it('⭐⭐ Г8-2: привал и боссы — по МЕСТУ В ПОЛОСЕ (цикл 20), и повторяются круг в круг', () => {
    // ⚠⚠ ЗДЕСЬ ПРОВЕРЯЕТСЯ САМА СХЕМА ВЛАДЕЛЬЦА (15.10): порталы на местах 3/6/9/12/15/18/20 полосы,
    // боссы на 5/14/19 — «на 19-м босс, 20-й портал и 21-й по новой всё». Прежний тест судил «каждые N этажей по
    // абсолютному счёту» — с полосой это уже другое правило: во втором круге порталы стоят на 23/26/29/…/40, а не на 21/24/27.
    const r = reg();
    // ⭐ Ф1 (16.10): шаблона забега нет вовсе — форма одна на игру, и типов узлов без механики в ней не осталось.
    expect(Object.keys(r.get('balance').dungeonAccess.nodeTypeWeights).sort(), 'типы рядовых узлов').toEqual(['combat', 'elite', 'treasure']);
    const access = r.get('balance').dungeonAccess;
    const cycle = access.contentCycle;
    const portals = access.portalsAt;
    const ladder = new Map(access.bossLadder.map((x) => [x.at, x.rank]));
    expect([cycle, [...portals], [...ladder.keys()].sort((a, b) => a - b)], 'живая схема владельца 15.10')
      .toEqual([20, [3, 6, 9, 12, 15, 18, 20], [5, 14, 19]]);
    const cfg = defaultRunConfig(r, 31);
    const seen: { portals: number[]; bosses: [number, string][] } = { portals: [], bosses: [] };
    for (const w of [{ from: 1, to: 40 }, { from: 97, to: 120 }, { from: 9991, to: 10010 }]) {
      for (const n of generateRunPlan(r, cfg, undefined, w).nodes) {
        const at = ((n.depth - 1) % cycle) + 1;
        const wp = portals.includes(at);
        const rank = wp ? undefined : ladder.get(at);
        expect(n.type === 'rest', `этаж ${n.depth} (место ${at}, тип ${n.type}) — привал?`).toBe(wp);
        expect(n.type === 'boss', `этаж ${n.depth} (место ${at}, тип ${n.type}) — босс?`).toBe(rank !== undefined);
        expect(n.bossRank, `этаж ${n.depth}: ранг босса`).toBe(rank);
        if (wp || n.type === 'boss') expect(n.lane, `этаж ${n.depth}: привал и босс — слой в одну полосу`).toBe(0);
        if (w.from === 1) {
          if (wp) seen.portals.push(n.depth);
          if (rank) seen.bosses.push([n.depth, rank]);
        }
      }
    }
    // Первые два круга — ровно та последовательность, которую владелец расписал словами.
    // ⭐⭐ Г8-3 (схема владельца 15.10): круг кончается боссом на 19-м и порталом на 20-м, и 21-й — по новой.
    expect(seen.portals.sort((a, b) => a - b)).toEqual([3, 6, 9, 12, 15, 18, 20, 23, 26, 29, 32, 35, 38, 40]);
    expect(seen.bosses.sort((a, b) => a[0] - b[0])).toEqual([
      [5, 'mini'], [14, 'strong'], [19, 'act'], [25, 'mini'], [34, 'strong'], [39, 'act'],
    ]);
    console.log('Г8-2 ДВА КРУГА\nпорталы: ' + seen.portals.join(', ') + '\nбоссы: ' + seen.bosses.map(([d, k]) => `${d} (${k})`).join(', '));
  });

  /**
   * ⭐⭐ Г8-4 (15.10, решение владельца): НИЧТО НЕ ОТМЕНЯЕТ БОССОВ И МЕТОК — «боссы появляются на этажах боссов,
   * вейпоинты на этажах вейпоинтов согласно нашей новой таблице».
   *
   * ⚠⚠ ЭТО СТОРОЖ НА НАСТОЯЩУЮ ПОЙМАННУЮ ДЫРУ, А НЕ НА ТЕОРИЮ. До Г8-4 у генератора было ТРИ молчаливых условия
   * поверх таблицы: тумблер `bosses` шаблона, наличие этажа роли `boss`/`rest` у биома и ЧЛЕНСТВО такого этажа в
   * шаблоне. Замер: `crypt-boss` состоял только в `dungeon-standard` и `deep-expedition`, поэтому в «Короткой
   * вылазке» боссы крипты пропадали целиком — и ни один сторож этого не ловил. Теперь место круга решает всё.
   */
  it('⭐⭐ Г8-4: НИ ШАБЛОН, НИ СОСТАВ ЭТАЖЕЙ НЕ ОТМЕНЯЮТ ТАБЛИЦУ — боссы и метки на своих местах всегда', () => {
    const r = reg();
    const access = r.get('balance').dungeonAccess;
    const ladder = new Map(access.bossLadder.map((x) => [x.at, x.rank]));
    const want = (d: number): 'rest' | 'boss' | null => {
      if (isWaypoint(d, access.portalsAt, access.contentCycle)) return 'rest';
      return ladder.has(bandDepth(d, access.contentCycle)) ? 'boss' : null;
    };
    // (а) ЖИВЫЕ ДАННЫЕ: места круга дают узлы своего типа на всех 40 этажах.
    const live = generateRunPlan(r, defaultRunConfig(r, 7), undefined, { from: 1, to: 40 }).nodes;
    for (const n of live) {
      const w = want(n.depth);
      if (w) expect(n.type, `этаж ${n.depth}: узел по таблице`).toBe(w);
      expect(n.bossRank !== undefined, `этаж ${n.depth}: ранг только у боссового`).toBe(w === 'boss');
    }
    expect(live.filter((n) => n.type === 'boss').length, 'боссов за два круга — шесть').toBe(6);

    // (б) ⚠ БИОМ БЕЗ БОССОВОГО И БЕЗ ПРИВАЛЬНОГО ЭТАЖА: узлы ОСТАЮТСЯ (меняется только вид этажа под ними).
    //     Прежде это молча отменяло и боссов, и метки — ровно то, что запретил владелец.
    const r2 = reg();
    const floors = r2.get('floors');
    for (const f of floors) if (f.biomeId === 'crypt' && (f.role === 'boss' || f.role === 'rest')) f.enabled = false;
    const bare = generateRunPlan(r2, defaultRunConfig(r2, 7), undefined, { from: 1, to: 40 }).nodes;
    for (const n of bare) {
      const w = want(n.depth);
      if (w) expect(n.type, `этаж ${n.depth} (биом без таких этажей): узел всё равно по таблице`).toBe(w);
    }
    expect(bare.filter((n) => n.type === 'boss').length, 'боссы не пропали').toBe(6);
    expect(bare.filter((n) => n.type === 'rest').length, 'и метки не пропали').toBe(live.filter((n) => n.type === 'rest').length);
    // ⚠ Но контент под ними ДРУГОЙ — и об этом кричит сторож данных (`waypointWarnings`), а не тишина.
    const warn = waypointWarnings(r2.get('biomes'), floors);
    expect(warn.some((x) => x.id === 'crypt' && x.msg.includes('БЕЗ САМОГО БОССА')), 'предупреждение про босса').toBe(true);
    expect(warn.some((x) => x.id === 'crypt' && x.msg.includes('без комнаты-привала')), 'и про привал').toBe(true);
    // eslint-disable-next-line no-console
    console.log('Г8-4 ТАБЛИЦА СИЛЬНЕЕ ШАБЛОНА: с живыми этажами боссов '
      + live.filter((n) => n.type === 'boss').length + ', без боссовых/привальных этажей — столько же ('
      + bare.filter((n) => n.type === 'boss').length + '), предупреждений данных ' + warn.length);
  });

  it('⭐ ПОТОЛКА НЕТ: узел на глубине 10 000 несёт нормальный floorSpec и проходимую геометрию', () => {
    const r = reg();
    const plan = generateRunPlan(r, defaultRunConfig(r, 5), undefined, { from: 10_000, to: 10_000 });
    const n = plan.nodes.find((x) => x.id === 'n10000_0')!;
    expect(n, 'узел на 10 000-м этаже').toBeTruthy();
    expect(n.depth).toBe(10_000);
    expect(n.floorSpec.floorId, 'этаж подобран').toBeTruthy();
    expect(n.floorSpec.seed).toBeGreaterThan(0);
    expect(n.floorSpec.exitCount, 'выходы есть — спуск не кончается').toBeGreaterThan(0);
    expect(validate(generateFloor(n.floorSpec)), 'геометрия проходима').toBe(true);
  });

  it('⭐ СИД ЗАБЕГА РЕШАЕТ ВСЁ: на одной глубине разные сиды дают разные слои, одинаковые — те же', () => {
    const r = reg();
    const w = { from: 200, to: 204 };
    const a = generateRunPlan(r, defaultRunConfig(r, 11), undefined, w);
    const b = generateRunPlan(r, defaultRunConfig(r, 12), undefined, w);
    const a2 = generateRunPlan(r, defaultRunConfig(r, 11), undefined, w);
    expect(JSON.stringify(a2)).toEqual(JSON.stringify(a));
    expect(JSON.stringify(b)).not.toEqual(JSON.stringify(a));
    // Разные — именно слои (а не только сиды этажей): хоть один слой окна отличается составом.
    const shape = (p: RunPlan) => p.nodes.map((n) => `${n.id}:${n.type}:${n.edges.map((e) => e.to).join(',')}`).join('|');
    expect(shape(b)).not.toEqual(shape(a));
  });

  it('у КАЖДОГО узла есть выход, у каждого (кроме первого слоя) — входящее, и спуск доходит до дна окна', () => {
    const r = reg();
    for (let seed = 1; seed <= 60; seed++) {
      const from = 1 + (seed % 7) * 13;
      const plan = generateRunPlan(r, defaultRunConfig(r, seed), undefined, { from, to: from + 4 });
      const byId = new Map(plan.nodes.map((n) => [n.id, n]));
      const reach = reachable(plan);
      for (const n of plan.nodes) {
        expect(n.edges.length, `seed=${seed} ${n.id}: узел без выхода = тупик бесконечного спуска`).toBeGreaterThan(0);
        expect(n.floorSpec.exitCount, `seed=${seed} ${n.id}: выходов этажа = рёбер`).toBe(n.edges.length);
        if (n.depth > from) {
          const incoming = plan.nodes.some((a) => a.depth === n.depth - 1 && a.edges.some((e) => e.to === n.id));
          expect(incoming, `seed=${seed} ${n.id}: нет входящего ребра`).toBe(true);
        }
      }
      // Вход = нулевая полоса первого слоя окна; от него спуск обязан дойти до последнего слоя.
      expect(plan.startId).toBe(`n${from}_0`);
      expect(byId.has(plan.startId)).toBe(true);
      const deepestReached = Math.max(...[...reach].map((id) => byId.get(id)!.depth));
      expect(deepestReached, `seed=${seed}: спуск от входа упёрся на ${deepestReached}`).toBe(from + 4);
    }
  });

  it('⭐ особого «узкого входа» на первом этаже НЕТ (Р4): по сидам слой 1 бывает шире одной полосы', () => {
    const r = reg();
    // Правило «первый слой узкий» перестало быть правдой: спуск начинается с любой метки, а не только с 1-го этажа,
    // и слой 1 — обычный слой со своей шириной по сиду. Форсируют ширину 1 только привал и босс (каденция глубины).
    const widths = [];
    for (let seed = 1; seed <= 40; seed++) {
      widths.push(generateRunPlan(r, defaultRunConfig(r, seed), undefined, { from: 1, to: 1 }).nodes.length);
    }
    expect(Math.max(...widths), `ширины слоя 1 по 40 сидам: ${[...new Set(widths)].sort().join(',')}`).toBeGreaterThan(1);
    expect(Math.min(...widths), 'ширина слоя — не меньше одной полосы').toBeGreaterThanOrEqual(1);
  });

  it('детерминизм: один сид → идентичный план (окно по умолчанию)', () => {
    const r = reg();
    const cfg = defaultRunConfig(r, 4242);
    const a = generateRunPlan(r, cfg);
    const b = generateRunPlan(r, cfg);
    expect(JSON.stringify(b)).toEqual(JSON.stringify(a));
    // Умолчание — первый слой плюс `lookahead` вперёд (столько развилок видит карта забега).
    const look = r.get('balance').dungeonAccess.lookahead;
    expect([...new Set(a.nodes.map((n) => n.depth))].sort((p, q) => p - q))
      .toEqual(Array.from({ length: look + 1 }, (_, i) => 1 + i));
  });

  it('каждый узел этажа генерирует проходимую геометрию (микро-слой)', () => {
    const r = reg();
    const plan = generateRunPlan(r, defaultRunConfig(r, 99), undefined, { from: 1, to: 9 });
    for (const n of plan.nodes) {
      const L = generateFloor(n.floorSpec);
      expect(validate(L), `node=${n.id}`).toBe(true);
    }
  });

  it('привал = town-этаж (портал в город, без сундука — R7-11), boss = locked', () => {
    const r = reg();
    const plan = generateRunPlan(r, defaultRunConfig(r, 7), undefined, { from: 1, to: 12 });
    const rest = plan.nodes.find((n) => n.type === 'rest')!;
    expect(rest, 'привал в окне из 12 слоёв обязан быть').toBeTruthy();
    expect(rest.floorSpec.kind).toBe('town');
    const L = generateFloor(rest.floorSpec);
    expect(L.decor.some((d) => d.kind === 'portal')).toBe(true);
    expect(L.decor.some((d) => d.kind === 'stash'), 'сундук аккаунта — только в городе').toBe(false);
    expect(L.exits.length, 'привал — не тупик: спуск с него продолжается').toBe(rest.edges.length);
    const boss = plan.nodes.find((n) => n.type === 'boss');
    expect(boss, 'босс каждые 5 слоёв — в окне из 12 обязан быть').toBeTruthy();
    expect(boss!.floorSpec.locked).toBe(true);
  });

  it('развилка: число выходов этажа = число исходящих рёбер узла', () => {
    const r = reg();
    const plan = generateRunPlan(r, { ...defaultRunConfig(r, 5), branching: 1 }, undefined, { from: 1, to: 8 });
    const fork = plan.nodes.find((n) => n.edges.length >= 2);
    expect(fork, 'должна быть развилка при branching=1').toBeTruthy();
    expect(fork!.floorSpec.exitCount).toBe(fork!.edges.length);
    const L = generateFloor(fork!.floorSpec);
    expect(L.exits.length).toBe(fork!.edges.length);
  });

  it('⭐⭐ Г8-4: БИОМ ТОЛЬКО С combat-ЭТАЖАМИ — узлы круга ВСЁ РАВНО по таблице, меняется только этаж под ними', () => {
    const r = reg();
    // Переопределяем floors на combat-only набор для биома 'crypt'.
    r.reload({ floors: [{ id: 'c-combat', name: 'c', biomeId: 'crypt', role: 'combat', algoParams: { algorithm: 'rooms' } }] });
    const access = r.get('balance').dungeonAccess;
    const plan = generateRunPlan(r, { ...defaultRunConfig(r, 3), biomeId: 'crypt' }, undefined, { from: 1, to: 20 });
    const types = new Set(plan.nodes.map((n) => n.type));
    // ⚠⚠ ДО Г8-4 ЗДЕСЬ ЖДАЛИ ОБРАТНОГО: «нет boss-этажа — нет и босс-слота», «нет rest-этажа — привала не
    // поставить». Это и была дыра: состав контента молча отменял таблицу, и в «Короткой вылазке» боссы крипты
    // пропадали целиком. Владелец потребовал, чтобы место круга решало всё.
    expect(types.has('boss'), 'босс на своём месте круга есть — даже без боссового этажа').toBe(true);
    expect(types.has('rest'), 'и метка на своём месте есть').toBe(true);
    // А вот ЭТАЖ под ними — единственный, что у биома есть: узел тот, вид другой (об этом кричит `waypointWarnings`).
    for (const n of plan.nodes) {
      expect(n.floorSpec.floorId, `этаж узла ${n.depth}`).toBe('c-combat');
      expect(n.floorSpec.exitCount).toBeGreaterThan(0);   // тупика не бывает
    }
    const warn = waypointWarnings(r.get('biomes'), r.get('floors'));
    expect(warn.filter((x) => x.id === 'crypt').length, 'и про оба недостающих этажа сказано').toBe(2);
  });

  it('фичи этажа применяются: boss-этаж → комната boss + замок; чемпион/сокровищница → тег/сундук', () => {
    const r = reg();
    const floors = r.get('floors');
    const biome = r.get('biomes').find((b) => b.id === 'crypt')!;
    const boss = generateFloor(resolveFloorSpec(biome, floors.find((f) => f.id === 'crypt-boss')!, 6, 11, [], { exitCount: 1 }));
    expect(boss.rooms.some((rm) => rm.content === 'boss')).toBe(true);
    expect(boss.doors.length).toBeGreaterThan(0); // bossRoom → замок
    // Проверяем ПРИМЕНЕНИЕ фич (treasureRooms→сундук, uniqueRooms→страж) независимо от
    // балансного тюнинга конкретного этажа: форсим фичи в спеке (в конфиге числа крутит юзер).
    const vaultFloor = floors.find((f) => f.id === 'crypt-vault')!;
    const vaultSpec = resolveFloorSpec(biome, { ...vaultFloor, features: { ...vaultFloor.features, treasureRooms: 1, uniqueRooms: 1 } }, 6, 12, [], { exitCount: 1 });
    const vault = generateFloor(vaultSpec);
    expect(vault.rooms.some((rm) => rm.content === 'treasure')).toBe(true);
    expect(vault.rooms.some((rm) => rm.content === 'unique')).toBe(true); // страж
    expect(vault.decor.some((d) => d.kind === 'chest')).toBe(true);
  });

  it('спавн по составу ролей пачки + форс чемпиона в босс-комнате + packDensity', () => {
    const r = reg();
    const floors = r.get('floors');
    const biome = r.get('biomes').find((b) => b.id === 'crypt')!;
    const bossFloor = generateFloor(resolveFloorSpec(biome, floors.find((f) => f.id === 'crypt-boss')!, 6, 11, [], { exitCount: 1 }));
    const mons = spawnPacksEl(r, bossFloor, 6, 'normal', createRng(5), biome.monsterPool, 1);
    expect(mons.length).toBeGreaterThan(0);
    // Босс-комната (content:'boss') форсирует чемпионов.
    const inBoss = mons.filter((m) => { const room = bossFloor.rooms.find((rm) => rm.content === 'boss'); if (!room) return false; const cx = Math.floor(m.x / 32), cy = Math.floor(m.y / 32); return cx >= room.x && cx < room.x + room.w && cy >= room.y && cy < room.y + room.h; });
    expect(inBoss.length).toBeGreaterThan(0);
    expect(inBoss.every((m) => m.def.rarity === 'unique')).toBe(true);
    // Монстры берутся из пула биома (по ролям pack.entries).
    expect(mons.every((m) => biome.monsterPool.includes(m.def.id))).toBe(true);
    // packDensity ×2 → примерно вдвое больше монстров.
    const dense = spawnPacksEl(r, bossFloor, 6, 'normal', createRng(5), biome.monsterPool, 2);
    expect(dense.length).toBeGreaterThan(mons.length);
  });

  /**
   * ⭐⭐ Ф5-0 (16.10): ЭФФЕКТЫ ПОДКЛЮЧЕНЫ — И ВЫБОР ТЕПЕРЬ ДОЕЗЖАЕТ. Прежде сторож требовал обратного («в план не
   * едут»), и это было честно: статов не применял никто, а подпись без действия — обман. Теперь живы десять статов,
   * и правило осталось прежним по СМЫСЛУ: едет ровно то, что действует, благо — в паре с опасностью, а ГРАФ забега
   * от выбора не меняется (случайности он не тратит — забег из сейва регенерится тем же).
   */
  it('⭐⭐ Ф5-0: действующие run-модификаторы едут в план и в floorSpec, а граф забега — тот же', () => {
    const r = reg();
    const base = defaultRunConfig(r, 3);
    const plan = generateRunPlan(r, { ...base, modifiers: ['greedy-vault', 'hardened-foes'] });
    expect(plan.runModifiers, 'благо в паре с опасностью — оба доехали').toEqual(['greedy-vault', 'hardened-foes']);
    const sample = plan.nodes.find((n: RunNode) => n.type === 'combat')!;
    expect(sample.floorSpec.modifiers, 'и этаж узла о них знает').toContain('greedy-vault');
    // ⚠ Благо БЕЗ опасности по-прежнему отбрасывается — правило владельца сильнее подключения статов.
    const onlyBoon = generateRunPlan(r, { ...base, modifiers: ['greedy-vault'] });
    expect(onlyBoon.runModifiers, 'благо в одиночку не проходит').toEqual([]);
    // Выбор алтаря случайности плана не тратит: граф с ним и без — один (забег из сейва регенерится тем же).
    const bare = generateRunPlan(r, base);
    expect(plan.nodes.map((n) => [n.id, n.type, n.edges.map((e) => e.to), n.floorSpec.seed])).toEqual(bare.nodes.map((n) => [n.id, n.type, n.edges.map((e) => e.to), n.floorSpec.seed]));
  });

  it('⭐⭐ Ф1: ФОРМА ЗАБЕГА РЕШАЕТ ТОЛЬКО ВИД РЯДОВЫХ УЗЛОВ — метки и боссы круга ей не подчиняются', () => {
    const r = reg();
    // Нулевой вес сокровищницы: это ЕДИНСТВЕННОЕ, на что форма ещё влияет, — выбор рядового узла.
    const base = r.get('balance');
    r.reload({
      balance: { ...base, dungeonAccess: { ...base.dungeonAccess, width: { min: 1, max: 2 }, branching: 0.4, nodeTypeWeights: { combat: 5, elite: 1, treasure: 0 } } },
      floors: [
        { id: 'b-combat', name: 'c', biomeId: 'crypt', role: 'combat', algoParams: { algorithm: 'rooms' } },
        { id: 'b-elite', name: 'e', biomeId: 'crypt', role: 'elite', algoParams: { algorithm: 'rooms' } },
        { id: 'b-boss', name: 'bo', biomeId: 'crypt', role: 'boss', algoParams: { algorithm: 'rooms' } },
        { id: 'b-treasure', name: 't', biomeId: 'crypt', role: 'treasure', algoParams: { algorithm: 'rooms' } },
        { id: 'b-rest', name: 're', biomeId: 'crypt', role: 'rest', algoParams: { algorithm: 'rooms' } },
      ],
    });
    const access = r.get('balance').dungeonAccess;
    const ladder = new Map(access.bossLadder.map((x) => [x.at, x.rank]));
    const marks = Array.from({ length: 9 }, (_, i) => i + 1).filter((d) => isWaypoint(d, access.portalsAt, access.contentCycle));
    const bosses = Array.from({ length: 9 }, (_, i) => i + 1)
      .filter((d) => !isWaypoint(d, access.portalsAt, access.contentCycle) && ladder.has(bandDepth(d, access.contentCycle)));
    for (let seed = 1; seed <= 40; seed++) {
      const plan = generateRunPlan(r, { ...defaultRunConfig(r, seed), biomeId: 'crypt' }, undefined, { from: 1, to: 9 });
      const ids = plan.nodes.map((n) => n.floorSpec.floorId);
      // Вес 0 — рядовым узлом сокровищница не становится (это шаблон и решает).
      expect(ids.includes('b-treasure'), `seed=${seed}: вес 0 — сокровищницы в рядовых нет`).toBe(false);
      // А метки и боссы стоят ровно по таблице — шаблон их не отменяет и не двигает.
      expect(plan.nodes.filter((n) => n.type === 'rest').map((n) => n.depth), `seed=${seed}: метки`).toEqual(marks);
      expect(plan.nodes.filter((n) => n.type === 'boss').map((n) => n.depth), `seed=${seed}: боссы`).toEqual(bosses);
      for (const n of plan.nodes) expect(['combat', 'elite', 'rest', 'boss']).toContain(n.type);
    }
  });
});

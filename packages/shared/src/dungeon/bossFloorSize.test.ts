/**
 * ⭐⭐ Г8-3 (15.10, схема владельца): БОССОВЫЙ ЭТАЖ БОЛЬШЕ ПО РАЗМЕРУ — «боссовый уровень сделаем просто больше по
 * размеру». Множитель лежит в `balance.dungeonAccess.bossRanks[ранг].floorScale`, растяжку делает ОДИН шов
 * `resolveFloorSpec` (через `scaleAlgo`), и доезжает она до реально сгенерированного этажа.
 *
 * ЗАЧЕМ ЭТОТ СТОРОЖ — ТРИ ВЕЩИ, КОТОРЫЕ ЛОМАЮТСЯ МОЛЧА:
 *  1. ⚠⚠ `algoParams` — объект ЖИВОГО конфига (реестр держит его В ПАМЯТИ). Правка на месте вместо копии растянула
 *     бы этаж НАВСЕГДА и для всех, кто потом его выберет: второй боссовый этаж вышел бы ×1.8, третий ×2.5 — и
 *     обычные этажи того же `floorId` вместе с ними. Это ровно та грабля, о которой память проекта говорит
 *     «редактор и игра видят одно и то же»; поймать её можно только сравнением конфига ДО и ПОСЛЕ генерации.
 *  2. Число комнат ОБЯЗАНО ехать по площади. Комнаты у генератора фиксированного размера в клетках (6..9 / 10..14),
 *     поэтому растянутая сетка с прежним `roomCount` даёт не «больше», а ПУСТЕЕ: те же комнаты и длинные коридоры.
 *     Сторож держит плотность застройки, а не только габариты.
 *  3. Масштаб 1 не обязан ничего менять: рядовой этаж и этаж мини-босса должны остаться БАЙТ-В-БАЙТ прежними,
 *     иначе кадр `runPlan` на проводе и эталоны Unity разъедутся на ровном месте.
 */
import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { generateRunPlan, defaultRunConfig } from './run/generateRunPlan.js';
import { generateFloor } from './generateFloor.js';
import { resolveFloorSpec } from './floorSpec.js';
import { Cell } from '../world/grid.js';
import type { BossRank } from './run/types.js';

function reg(): ConfigRegistry {
  const r = new ConfigRegistry();
  r.loadAll();
  return r;
}
/** Узлы забега до 40-го этажа (два круга) с их рангом и габаритами этажа. */
function nodesTo(cfg: ConfigRegistry, to = 40): { depth: number; rank?: BossRank; cols: number; rows: number; rooms: number }[] {
  const plan = generateRunPlan(cfg, defaultRunConfig(cfg, 77), undefined, { from: 1, to });
  return plan.nodes.map((n) => ({
    depth: n.depth,
    ...(n.bossRank ? { rank: n.bossRank } : {}),
    cols: n.floorSpec.algoParams.cols,
    rows: n.floorSpec.algoParams.rows,
    rooms: n.floorSpec.algoParams.algorithm === 'rooms' ? n.floorSpec.algoParams.roomCount : 0,
  }));
}

describe('⭐⭐ Г8-3: боссовый этаж больше по размеру', () => {
  it('⭐⭐ РАСТЯЖКА ДОЕЗЖАЕТ ДО УЗЛА: у актового босса сетка шире, чем у рядового этажа того же круга', () => {
    const cfg = reg();
    const access = cfg.get('balance').dungeonAccess;
    const nodes = nodesTo(cfg);
    const act = nodes.filter((n) => n.rank === 'act');
    const plain = nodes.filter((n) => !n.rank);
    expect(act.length, 'за два круга актовых боссов два (19 и 39)').toBe(2);
    expect(plain.length, 'рядовых этажей много').toBeGreaterThan(20);

    const scale = access.bossRanks.act.floorScale;
    expect(scale, 'штатный масштаб актового').toBeGreaterThan(1);
    for (const a of act) {
      // Сравниваем с МЕДИАНОЙ рядовых: у биома несколько этажей с разной геометрией, один-к-одному сравнивать нельзя.
      const medCols = [...plain].map((p) => p.cols).sort((x, y) => x - y)[plain.length >> 1]!;
      expect(a.cols, `этаж ${a.depth} (актовый) шире рядового`).toBeGreaterThan(medCols);
    }
    const line = (n: { depth: number; rank?: BossRank; cols: number; rows: number; rooms: number }): string =>
      `этаж ${n.depth}${n.rank ? ` (${n.rank})` : ''}: ${n.cols}×${n.rows}, комнат ${n.rooms}`;
    // eslint-disable-next-line no-console
    console.log('Г8-3 РАЗМЕР ЭТАЖА ПО РАНГУ\n  '
      + [...nodes.filter((n) => n.rank), nodes.find((n) => !n.rank)!].map(line).join('\n  '));
  });

  it('⚠⚠ ЖИВОЙ КОНФИГ НЕ ТРОНУТ: геометрия этажа в реестре после генерации та же (растяжка — копия, а не правка на месте)', () => {
    const cfg = reg();
    const before = cfg.get('floors').map((f) => `${f.id}:${f.algoParams.cols}×${f.algoParams.rows}`);
    nodesTo(cfg, 60);               // три круга, девять боссов — девять поводов испортить конфиг
    nodesTo(cfg, 60);               // и второй проход: накопления быть не должно
    const after = cfg.get('floors').map((f) => `${f.id}:${f.algoParams.cols}×${f.algoParams.rows}`);
    expect(after, 'этажи биома в памяти реестра не растянулись').toEqual(before);
  });

  it('⭐⭐ ЭТАЖ НЕ ПУСТЕЕТ: доля ходибельных клеток на растянутой сетке та же (иначе «больше» = «пустее»)', () => {
    const cfg = reg();
    const biome = cfg.get('biomes')[0]!;
    const floor = cfg.get('floors').find((f) => f.biomeId === biome.id && f.role === 'boss')!;
    const scale = cfg.get('balance').dungeonAccess.bossRanks.act.floorScale;
    // ⚠ Живые боссовые этажи идут на bsp / cellular / maze — эти алгоритмы ЗАПОЛНЯЮТ сетку и дробят её сами,
    // поэтому плотность у них держится растяжкой габаритов. Проверяем это замером, а не на слово.
    const share = (s: number, seed: number): number => {
      const L = generateFloor(resolveFloorSpec(biome, floor, 19, seed, [], s > 1 ? { floorScale: s } : {}));
      let walk = 0, all = 0;
      for (const row of L.grid) for (const c of row) { all += 1; if (c !== Cell.Wall) walk += 1; }
      return walk / all;
    };
    const seeds = [11, 4242, 90210, 777, 31337];
    const one = seeds.map((s) => share(1, s));
    const big = seeds.map((s) => share(scale, s));
    const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(avg(big) / avg(one), `доля ходибельных клеток: рядовой ${avg(one).toFixed(3)} → актовый ${avg(big).toFixed(3)}`)
      .toBeGreaterThan(0.85);
    // eslint-disable-next-line no-console
    console.log(`Г8-3 ПЛОТНОСТЬ (${floor.algoParams.algorithm}): рядовой ${(avg(one) * 100).toFixed(1)}% ходибельных`
      + ` → актовый ${(avg(big) * 100).toFixed(1)}%`);
  });

  it('⭐ ЭТАЖ НА «КОМНАТАХ»: число комнат едет ПО ПЛОЩАДИ — та же застройка на большей сетке, а не 9 комнат на ×1.8', () => {
    const cfg = reg();
    const biome = cfg.get('biomes')[0]!;
    // Этаж «комнат» в живых данных — привал; геометрию берём его, роль здесь не важна (проверяется арифметика шва).
    const floor = cfg.get('floors').find((f) => f.algoParams.algorithm === 'rooms')!;
    const base = floor.algoParams;
    expect(base.algorithm, 'нужен этаж с алгоритмом комнат').toBe('rooms');
    const scaled = resolveFloorSpec(biome, floor, 19, 7, [], { floorScale: 1.35 }).algoParams;
    expect(scaled.algorithm).toBe('rooms');
    if (base.algorithm !== 'rooms' || scaled.algorithm !== 'rooms') return;
    expect([scaled.cols, scaled.rows], 'габариты — линейно').toEqual([Math.round(base.cols * 1.35), Math.round(base.rows * 1.35)]);
    expect(scaled.roomCount, 'комнаты — по площади (в квадрате)').toBe(Math.round(base.roomCount * 1.35 * 1.35));
    const dens = (c: number, r: number, n: number): number => n / (c * r);
    expect(dens(scaled.cols, scaled.rows, scaled.roomCount) / dens(base.cols, base.rows, base.roomCount),
      'плотность застройки держится (запас на округление)').toBeGreaterThan(0.9);
  });

  it('⭐ ХОДИБЕЛЬНАЯ ПЛОЩАДЬ РЕАЛЬНО БОЛЬШЕ: сгенерированный актовый этаж шире рядового того же этажа', () => {
    const cfg = reg();
    const biome = cfg.get('biomes')[0]!;
    const floor = cfg.get('floors').find((f) => f.biomeId === biome.id && f.role === 'boss')
      ?? cfg.get('floors').find((f) => f.biomeId === biome.id)!;
    const walk = (scale: number): number => {
      const spec = resolveFloorSpec(biome, floor, 19, 4242, [], scale > 1 ? { floorScale: scale } : {});
      const L = generateFloor(spec);
      let n = 0;
      for (const row of L.grid) for (const c of row) if (c !== Cell.Wall) n += 1;
      return n;
    };
    const one = walk(1);
    const big = walk(cfg.get('balance').dungeonAccess.bossRanks.act.floorScale);
    expect(big, 'ходибельных клеток у актового этажа больше').toBeGreaterThan(one);
    // eslint-disable-next-line no-console
    console.log(`Г8-3 ХОДИБЕЛЬНАЯ ПЛОЩАДЬ: рядовой ${one} клеток → актовый ${big} (×${(big / one).toFixed(2)})`);
  });

  it('⭐ МАСШТАБ 1 НИЧЕГО НЕ МЕНЯЕТ: спецификация этажа байт-в-байт та же (кадр на проводе не толстеет)', () => {
    const cfg = reg();
    const biome = cfg.get('biomes')[0]!;
    const floor = cfg.get('floors').find((f) => f.biomeId === biome.id)!;
    const plain = resolveFloorSpec(biome, floor, 7, 99);
    for (const s of [1, 0.5, Number.NaN]) {
      expect(JSON.stringify(resolveFloorSpec(biome, floor, 7, 99, [], { floorScale: s })), `масштаб ${s}`)
        .toBe(JSON.stringify(plain));
    }
    // Мини-босс в штатных данных стоит ровно на 1 — его этаж обязан нести ГЕОМЕТРИЮ СВОЕГО КОНФИГА без копии.
    expect(cfg.get('balance').dungeonAccess.bossRanks.mini.floorScale, 'мини — как обычный этаж').toBe(1);
    const plan = generateRunPlan(cfg, defaultRunConfig(cfg, 77), undefined, { from: 1, to: 40 });
    const byId = new Map(cfg.get('floors').map((f) => [f.id, f.algoParams]));
    const mini = plan.nodes.filter((n) => n.bossRank === 'mini');
    expect(mini.length, 'за два круга мини-боссов два (5 и 25)').toBe(2);
    for (const m of mini) {
      // ⚠ Сравнение ПО ССЫЛКЕ: при масштабе 1 шов обязан отдать тот же объект, а не его копию — так ловится
      // «а давайте всегда копировать», после которого на проводе поедут ключи и порядок полей.
      expect(m.floorSpec.algoParams, `этаж ${m.depth} (${m.floorSpec.floorId}): геометрия своего конфига без копии`)
        .toBe(byId.get(m.floorSpec.floorId));
    }
  });

  it('⚠ ПОТОЛКИ СХЕМЫ ДЕРЖАТСЯ: даже при масштабе 3 сетка и число комнат остаются в допустимых рамках', () => {
    const cfg = reg();
    const biome = cfg.get('biomes')[0]!;
    for (const floor of cfg.get('floors').filter((f) => f.biomeId === biome.id)) {
      const a = resolveFloorSpec(biome, floor, 19, 11, [], { floorScale: 3 }).algoParams;
      expect(a.cols, `${floor.id}: cols в рамках схемы`).toBeLessThanOrEqual(200);
      expect(a.rows, `${floor.id}: rows в рамках схемы`).toBeLessThanOrEqual(200);
      if (a.algorithm === 'rooms') expect(a.roomCount, `${floor.id}: комнат в рамках схемы`).toBeLessThanOrEqual(30);
    }
  });
});

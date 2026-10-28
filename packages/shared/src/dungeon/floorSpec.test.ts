import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { floorsSchema } from '../config/schemas.js';
import { pickFloorForRole, availableRoles, resolveFloorSpec } from './floorSpec.js';
import { generateFloor } from './generateFloor.js';
import { validate } from './floorCommon.js';
import { Cell } from '../world/grid.js';

function reg(): ConfigRegistry {
  const r = new ConfigRegistry();
  r.loadAll();
  return r;
}

/** Собрать Floor[] из частичных описаний (schema заполняет дефолты). */
function floors(...parts: Record<string, unknown>[]) {
  return floorsSchema.parse(parts);
}

describe('подбор этажа по РОЛИ + биому + глубине + членству', () => {
  /**
   * ⭐⭐ Ф2 (16.10, решение владельца): ОБЫЧНЫЕ ЭТАЖИ ОТВЯЗАНЫ ОТ ГЛУБИНЫ. Окно `minDepth..maxDepth` у боевых
   * этажей крипты открыто настежь (1..99), а смесь задаёт ВЕС ПО МЕСТУ КРУГА (`placeWeight`): мелкие чаще в начале
   * круга, крупные — к концу. Прежний сторож судил ровно обратное («мелко → залы, глубоко → катакомбы»), и после
   * правки его утверждение стало неверным по построению — поэтому он переписан на новый механизм, а не ослаблен.
   */
  it('⭐⭐ Ф2: смесь боевых этажей ЕДЕТ ПО КРУГУ — мелкие в начале, крупные в конце (вес по месту)', () => {
    const f = reg().get('floors');
    const CYCLE = 20;
    const mix = (place: number): Record<string, number> => {
      const out: Record<string, number> = {};
      for (let seed = 1; seed <= 400; seed++) {
        const id = pickFloorForRole('combat', 'crypt', f, place, seed * 7919, { place, cycle: CYCLE })?.id;
        if (id) out[id] = (out[id] ?? 0) + 1;
      }
      return out;
    };
    const first = mix(1), last = mix(CYCLE);
    const rows = [...new Set([...Object.keys(first), ...Object.keys(last)])].sort();
    console.log('Ф2 СМЕСЬ БОЕВЫХ ЭТАЖЕЙ (400 сидов)');
    for (const id of rows) console.log(`  ${id.padEnd(18)} место 1: ${String(first[id] ?? 0).padStart(3)}   место ${CYCLE}: ${String(last[id] ?? 0).padStart(3)}`);
    // На первом месте круга мелкий этаж обязан побеждать крупный, на последнем — наоборот.
    expect((first['crypt-halls'] ?? 0) > (first['crypt-depths'] ?? 0), 'место 1: мелкий чаще крупного').toBe(true);
    expect((last['crypt-depths'] ?? 0) > (last['crypt-halls'] ?? 0), `место ${CYCLE}: крупный чаще мелкого`).toBe(true);
    // И ни один размер не выпадает из смеси совсем — иначе «несколько размеров» существуют только на бумаге.
    expect(rows.length, 'размеров в смеси').toBeGreaterThanOrEqual(5);
    for (const id of rows) expect((first[id] ?? 0) + (last[id] ?? 0), `${id} встречается`).toBeGreaterThan(0);
  });

  it('⭐ Ф2: боссовый этаж берётся ПО РАНГУ лестницы круга, без ранга — любой боссовый', () => {
    const f = reg().get('floors');
    for (const rank of ['mini', 'strong', 'act'] as const) {
      const got = pickFloorForRole('boss', 'crypt', f, 5, 1, { bossRank: rank });
      expect(got?.bossRank, `ранг ${rank}`).toBe(rank);
    }
    expect(pickFloorForRole('boss', 'crypt', f, 5, 1)?.role, 'без ранга — всё равно боссовый').toBe('boss');
    // Ранга, которого нет в данных, быть не должно, но если появится — узел обязан получить этаж, а не undefined.
    expect(pickFloorForRole('boss', 'crypt', f, 5, 1, { bossRank: 'strong' })?.role).toBe('boss');
  });

  it('роль без этажа → undefined; членство шаблона учитывается', () => {
    const f = floors(
      { id: 'x-combat', name: 'x', biomeId: 'x', role: 'combat', algoParams: { algorithm: 'rooms' } },
      { id: 'x-boss', name: 'xb', biomeId: 'x', role: 'boss', templates: ['t1'], algoParams: { algorithm: 'rooms' } },
    );
    expect(pickFloorForRole('boss', 'y', f, 3, 1)).toBeUndefined(); // нет этажей биома y
    expect(pickFloorForRole('boss', 'x', f, 3, 1)?.id).toBe('x-boss');
    // ⭐⭐ Г8-4: ЧЛЕНСТВО В ШАБЛОНЕ БОЛЬШЕ НЕ ПРЯЧЕТ ЭТАЖ. Прежде этот же вызов «из другого шаблона» возвращал
    // undefined — и на этом молча пропадали боссы крипты в «Короткой вылазке». Теперь роль решают биом и глубина.
    expect(pickFloorForRole('boss', 'x', f, 3, 2)?.id).toBe('x-boss');
  });

  it('availableRoles учитывает биом + членство', () => {
    const f = floors(
      { id: 'x-combat', name: 'x', biomeId: 'x', role: 'combat', algoParams: { algorithm: 'rooms' } },
      { id: 'x-boss', name: 'xb', biomeId: 'x', role: 'boss', templates: ['t1'], algoParams: { algorithm: 'rooms' } },
      { id: 'x-rest', name: 'xr', biomeId: 'x', role: 'rest', algoParams: { algorithm: 'rooms' } },
    );
    // ⭐⭐ Г8-4: роли биома считаются БЕЗ шаблона — он больше не может спрятать боссовый этаж.
    expect([...availableRoles('x', f)].sort()).toEqual(['boss', 'combat', 'rest']);
  });

  it('enabled:false исключает этаж из подбора', () => {
    const f = floors(
      { id: 'x-a', name: 'a', biomeId: 'x', role: 'combat', weight: 1, enabled: false, algoParams: { algorithm: 'rooms' } },
      { id: 'x-b', name: 'b', biomeId: 'x', role: 'combat', weight: 1, algoParams: { algorithm: 'rooms' } },
    );
    // выключенный x-a не выбирается никогда — только x-b
    for (let s = 1; s <= 20; s++) expect(pickFloorForRole('combat', 'x', f, 3, s)?.id).toBe('x-b');
  });

  it('resolveFloorSpec: boss-этаж → locked, rest → town; фичи проброшены; геометрия проходима', () => {
    const r = reg();
    const f = r.get('floors');
    const biome = r.get('biomes').find((b) => b.id === 'crypt')!;
    const boss = f.find((x) => x.id === 'crypt-boss')!;
    const bossSpec = resolveFloorSpec(biome, boss, 5, 123, [], { exitCount: 1 });
    expect(bossSpec.role).toBe('boss');
    expect(bossSpec.locked).toBe(true); // features.bossRoom
    expect(bossSpec.features.bossRoom).toBe(true);
    expect(validate(generateFloor(bossSpec))).toBe(true);

    const rest = f.find((x) => x.id === 'crypt-rest')!;
    const restSpec = resolveFloorSpec(biome, rest, 4, 7, [], { exitCount: 2 });
    expect(restSpec.kind).toBe('town');
    const L = generateFloor(restSpec);
    expect(L.decor.some((d) => d.kind === 'portal')).toBe(true);
    // ⭐ R7-11: сундук аккаунта — только в городе (`server/net/guard.ts`): на привале его кнопка получала бы отказ.
    expect(L.decor.some((d) => d.kind === 'stash')).toBe(false);
  });
});

describe('⭐ 08.10: биом без процедурных колонн и стоячих факелов (biomes[].pillars / torches)', () => {
  it('крипта: в спецификации pillars/torches = false; у прочих биомов полей нет (runPlan на проводе — прежний)', () => {
    const r = reg();
    const crypt = r.get('biomes').find((b) => b.id === 'crypt')!;
    const other = r.get('biomes').find((b) => b.id !== 'crypt')!;
    const f = r.get('floors');
    const s = resolveFloorSpec(crypt, pickFloorForRole('combat', 'crypt', f, 3, 1), 3, 77);
    expect(s.pillars).toBe(false);
    expect(s.torches).toBe(false);
    const o = resolveFloorSpec(other, undefined, 3, 77);
    expect('pillars' in o || 'torches' in o).toBe(false);
  });

  it('этаж без колонн: ни клетки-колонны, ни декора pillar/torch; остальное — байт-в-байт как с ними, проходимость цела', () => {
    const r = reg();
    const crypt = r.get('biomes').find((b) => b.id === 'crypt')!;
    let pillarsSeen = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const floor = { id: 'h', name: 'h', biomeId: 'crypt', role: 'combat', algoParams: { algorithm: 'rooms', cols: 50, rows: 40, roomCount: 10, shapes: { hall: 3, rect: 1 } } };
      const spec = resolveFloorSpec({ ...crypt, pillars: true, torches: true }, floors(floor)[0], 3, seed);
      const off = { ...spec, pillars: false as const, torches: false as const };
      const a = generateFloor(spec);
      const b = generateFloor(off);
      pillarsSeen += a.grid.flat().filter((c) => c === Cell.Pillar).length + a.decor.filter((d) => d.kind === 'pillar').length;
      expect(b.grid.flat().includes(Cell.Pillar)).toBe(false);
      expect(b.decor.some((d) => d.kind === 'pillar' || d.kind === 'torch')).toBe(false);
      expect(validate(b)).toBe(true);
      // всё, кроме колонн и факелов, совпадает: сетка — с колоннами, ставшими полом; прочий декор, спавн, выходы
      const grid = a.grid.map((row) => row.map((c) => (c === Cell.Pillar ? Cell.Floor : c)));
      expect(b.grid).toEqual(grid);
      expect(b.decor).toEqual(a.decor.filter((d) => d.kind !== 'pillar' && d.kind !== 'torch'));
      expect({ spawn: b.spawn, exits: b.exits, doors: b.doors }).toEqual({ spawn: a.spawn, exits: a.exits, doors: a.doors });
    }
    expect(pillarsSeen).toBeGreaterThan(0);   // проверка не пустая: с колоннами они были
  });
});

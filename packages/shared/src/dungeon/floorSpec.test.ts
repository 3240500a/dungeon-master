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
  it('crypt combat: мелко → crypt-halls, глубоко → crypt-catacombs (окно глубины на сид-данных)', () => {
    const f = reg().get('floors');
    expect(pickFloorForRole('combat', 'crypt', f, 3, 'dungeon-standard', 1)?.id).toBe('crypt-halls');
    expect(pickFloorForRole('combat', 'crypt', f, 12, 'dungeon-standard', 1)?.id).toBe('crypt-catacombs');
  });

  it('роль без этажа → undefined; членство шаблона учитывается', () => {
    const f = floors(
      { id: 'x-combat', name: 'x', biomeId: 'x', role: 'combat', algoParams: { algorithm: 'rooms' } },
      { id: 'x-boss', name: 'xb', biomeId: 'x', role: 'boss', templates: ['t1'], algoParams: { algorithm: 'rooms' } },
    );
    expect(pickFloorForRole('boss', 'y', f, 3, 't1', 1)).toBeUndefined(); // нет этажей биома y
    expect(pickFloorForRole('boss', 'x', f, 3, 't1', 1)?.id).toBe('x-boss'); // boss член t1
    expect(pickFloorForRole('boss', 'x', f, 3, 't2', 1)).toBeUndefined(); // boss НЕ член t2
  });

  it('availableRoles учитывает биом + членство', () => {
    const f = floors(
      { id: 'x-combat', name: 'x', biomeId: 'x', role: 'combat', algoParams: { algorithm: 'rooms' } },
      { id: 'x-boss', name: 'xb', biomeId: 'x', role: 'boss', templates: ['t1'], algoParams: { algorithm: 'rooms' } },
      { id: 'x-rest', name: 'xr', biomeId: 'x', role: 'rest', algoParams: { algorithm: 'rooms' } },
    );
    expect([...availableRoles('x', f, 't2')].sort()).toEqual(['combat', 'rest']); // boss не член t2
    expect([...availableRoles('x', f, 't1')].sort()).toEqual(['boss', 'combat', 'rest']);
  });

  it('enabled:false исключает этаж из подбора', () => {
    const f = floors(
      { id: 'x-a', name: 'a', biomeId: 'x', role: 'combat', weight: 1, enabled: false, algoParams: { algorithm: 'rooms' } },
      { id: 'x-b', name: 'b', biomeId: 'x', role: 'combat', weight: 1, algoParams: { algorithm: 'rooms' } },
    );
    // выключенный x-a не выбирается никогда — только x-b
    for (let s = 1; s <= 20; s++) expect(pickFloorForRole('combat', 'x', f, 3, 't', s)?.id).toBe('x-b');
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
    const s = resolveFloorSpec(crypt, pickFloorForRole('combat', 'crypt', f, 3, 'dungeon-standard', 1), 3, 77);
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

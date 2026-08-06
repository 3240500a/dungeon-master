import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../../config/registry.js';
import { generateRunPlan, defaultRunConfig } from './generateRunPlan.js';
import { generateFloor } from '../generateFloor.js';
import { resolveFloorSpec } from '../floorSpec.js';
import { spawnPacksEl } from '../floor.js';
import { createRng } from '../../formulas/rng.js';
import { validate } from '../floorCommon.js';
import type { RunNode, RunPlan } from './types.js';

function reg(): ConfigRegistry {
  const r = new ConfigRegistry();
  r.loadAll();
  return r;
}

/** BFS от start по рёбрам — множество достижимых id. */
function reachable(plan: RunPlan): Set<string> {
  const byId = new Map(plan.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>([plan.startId]);
  const q = [plan.startId];
  for (let h = 0; h < q.length; h++) {
    const n = byId.get(q[h]!)!;
    for (const e of n.edges) if (!seen.has(e.to)) { seen.add(e.to); q.push(e.to); }
  }
  return seen;
}

describe('generateRunPlan — структура забега', () => {
  it('связность: финал достижим от старта, каждый узел имеет входящее (кроме старта)', () => {
    const r = reg();
    for (let seed = 1; seed <= 100; seed++) {
      const cfg = { ...defaultRunConfig(r, 'dungeon-standard', seed) };
      const plan = generateRunPlan(r, cfg);
      const reach = reachable(plan);
      expect(reach.has(plan.finaleId!), `seed=${seed} финал`).toBe(true);
      // все узлы достижимы от старта
      for (const n of plan.nodes) expect(reach.has(n.id), `seed=${seed} node=${n.id}`).toBe(true);
      // старт есть, финал — единственный без исходящих
      expect(plan.nodes.find((n) => n.id === plan.startId)!.type).toBe('start');
    }
  });

  it('детерминизм: один сид → идентичный план', () => {
    const r = reg();
    const cfg = defaultRunConfig(r, 'dungeon-standard', 4242);
    const a = generateRunPlan(r, cfg);
    const b = generateRunPlan(r, cfg);
    expect(JSON.stringify(b)).toEqual(JSON.stringify(a));
  });

  it('rest и boss появляются согласно каденции; финал типа finale', () => {
    const r = reg();
    const plan = generateRunPlan(r, { ...defaultRunConfig(r, 'dungeon-standard', 7), length: 12 });
    const types = new Set(plan.nodes.map((n) => n.type));
    expect(types.has('rest')).toBe(true);   // returnEvery=4 при length=12
    expect(types.has('boss')).toBe(true);   // bossEvery=5
    expect(plan.nodes.find((n) => n.id === plan.finaleId!)!.type).toBe('finale');
  });

  it('каждый узел этажа генерирует проходимую геометрию (микро-слой)', () => {
    const r = reg();
    const plan = generateRunPlan(r, defaultRunConfig(r, 'caves-deep', 99));
    for (const n of plan.nodes) {
      const L = generateFloor(n.floorSpec);
      expect(validate(L), `node=${n.id}`).toBe(true);
    }
  });

  it('rest-узел = town-этаж (портал+сундук, без монстров-замка), boss = locked', () => {
    const r = reg();
    const plan = generateRunPlan(r, { ...defaultRunConfig(r, 'dungeon-standard', 7), length: 12 });
    const rest = plan.nodes.find((n) => n.type === 'rest')!;
    expect(rest.floorSpec.kind).toBe('town');
    const L = generateFloor(rest.floorSpec);
    expect(L.decor.some((d) => d.kind === 'portal')).toBe(true);
    expect(L.decor.some((d) => d.kind === 'stash')).toBe(true);
    const boss = plan.nodes.find((n) => n.type === 'boss');
    if (boss) expect(boss.floorSpec.locked).toBe(true);
  });

  it('развилка: число выходов этажа = число исходящих рёбер узла', () => {
    const r = reg();
    const plan = generateRunPlan(r, { ...defaultRunConfig(r, 'deep-expedition', 5), branching: 1 });
    const fork = plan.nodes.find((n) => n.edges.length >= 2);
    expect(fork, 'должна быть развилка при branching=1').toBeTruthy();
    expect(fork!.floorSpec.exitCount).toBe(fork!.edges.length);
    const L = generateFloor(fork!.floorSpec);
    expect(L.exits.length).toBe(fork!.edges.length);
  });

  it('сборка из членов: биом только с combat-этажами → нет boss/rest, финал = простой+портал', () => {
    const r = reg();
    // Переопределяем floors на combat-only набор для биома 'crypt'.
    r.reload({ floors: [{ id: 'c-combat', name: 'c', biomeId: 'crypt', role: 'combat', algoParams: { algorithm: 'rooms' } }] });
    const plan = generateRunPlan(r, { ...defaultRunConfig(r, 'dungeon-standard', 3), biomeId: 'crypt', length: 10 });
    const types = new Set(plan.nodes.map((n) => n.type));
    expect(types.has('boss')).toBe(false);
    expect(types.has('rest')).toBe(false);
    const fin = plan.nodes.find((n) => n.id === plan.finaleId!)!;
    expect(fin.floorSpec.exitCount).toBe(0);
    const L = generateFloor(fin.floorSpec);
    expect(L.decor.some((d) => d.kind === 'portal')).toBe(true); // финал даёт портал в город
  });

  it('фичи этажа применяются: boss-этаж → комната boss + замок; чемпион/сокровищница → тег/сундук', () => {
    const r = reg();
    const floors = r.get('floors');
    const biome = r.get('biomes').find((b) => b.id === 'crypt')!;
    const boss = generateFloor(resolveFloorSpec(biome, floors.find((f) => f.id === 'crypt-boss')!, 6, 11, [], { exitCount: 1 }));
    expect(boss.rooms.some((rm) => rm.content === 'boss')).toBe(true);
    expect(boss.doors.length).toBeGreaterThan(0); // bossRoom → замок
    const vault = generateFloor(resolveFloorSpec(biome, floors.find((f) => f.id === 'crypt-vault')!, 6, 12, [], { exitCount: 1 }));
    expect(vault.rooms.some((rm) => rm.content === 'treasure')).toBe(true);
    expect(vault.rooms.some((rm) => rm.content === 'unique')).toBe(true); // страж
    expect(vault.decor.some((d) => d.kind === 'chest')).toBe(true);
  });

  it('спавн по составу ролей пачки + форс чемпиона в босс-комнате + packDensity', () => {
    const r = reg();
    const floors = r.get('floors');
    const biome = r.get('biomes').find((b) => b.id === 'crypt')!;
    const bossFloor = generateFloor(resolveFloorSpec(biome, floors.find((f) => f.id === 'crypt-boss')!, 6, 11, [], { exitCount: 1 }));
    const mons = spawnPacksEl(r, bossFloor, 6, 'normal', createRng(5), 20, biome.monsterPool, 1);
    expect(mons.length).toBeGreaterThan(0);
    // Босс-комната (content:'boss') форсирует чемпионов.
    const inBoss = mons.filter((m) => { const room = bossFloor.rooms.find((rm) => rm.content === 'boss'); if (!room) return false; const cx = Math.floor(m.x / 32), cy = Math.floor(m.y / 32); return cx >= room.x && cx < room.x + room.w && cy >= room.y && cy < room.y + room.h; });
    expect(inBoss.length).toBeGreaterThan(0);
    expect(inBoss.every((m) => m.def.rarity === 'unique')).toBe(true);
    // Монстры берутся из пула биома (по ролям pack.entries).
    expect(mons.every((m) => biome.monsterPool.includes(m.def.id))).toBe(true);
    // packDensity ×2 → примерно вдвое больше монстров.
    const dense = spawnPacksEl(r, bossFloor, 6, 'normal', createRng(5), 20, biome.monsterPool, 2);
    expect(dense.length).toBeGreaterThan(mons.length);
  });

  it('выбранные run-модификаторы прокидываются в план и в floorSpec узлов', () => {
    const r = reg();
    const cfg = { ...defaultRunConfig(r, 'dungeon-standard', 3), modifiers: ['greedy-vault', 'hardened-foes'] };
    const plan = generateRunPlan(r, cfg);
    expect(plan.runModifiers).toContain('greedy-vault');
    const sample = plan.nodes.find((n: RunNode) => n.type === 'combat')!;
    expect(sample.floorSpec.modifiers).toEqual(expect.arrayContaining(['greedy-vault', 'hardened-foes']));
  });
});

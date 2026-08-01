import type { ConfigRegistry } from '../../config/registry.js';
import type { RunModifier, RunNodeType, RunTemplate, Biome, Floor, FloorRole } from '../../config/schemas.js';
import { createRng, type Rng } from '../../formulas/rng.js';
import { resolveFloorSpec, pickFloorForRole, pickFloor, availableRoles } from '../floorSpec.js';
import type { RunConfig, RunNode, RunPlan } from './types.js';

/** Взвешенный выбор из [{item, weight}] по rng. Возвращает null для пустого/нулевого. */
function weightedPick<T>(entries: { item: T; weight: number }[], rng: Rng): T | null {
  const total = entries.reduce((s, e) => s + Math.max(0, e.weight), 0);
  if (total <= 0) return null;
  let r = rng.next() * total;
  for (const e of entries) { r -= Math.max(0, e.weight); if (r <= 0) return e.item; }
  return entries[entries.length - 1]!.item;
}

/** Смешение сида забега и координат узла → детерминированный сид этажа. */
function nodeSeed(runSeed: number, depth: number, lane: number): number {
  return ((runSeed ^ ((depth + 1) * 0x9e3779b1) ^ ((lane + 1) * 0x85ebca77)) >>> 0) || 1;
}

/** Роли, которые могут занять «боевой» слой (не boss/rest/finale). */
const COMBAT_ROLES: FloorRole[] = ['combat', 'elite', 'treasure', 'event', 'shop'];

/**
 * Генератор структуры забега v2 (макро): RunConfig → ветвящийся слоистый DAG. Форму задаёт шаблон
 * (длина/ветвление/каденция), а СОДЕРЖИМОЕ каждого слота — подобранный конфиг этажа-члена шаблона
 * (по роли+биому+глубине). Слот роли генерится ТОЛЬКО если есть этаж этой роли: нет boss-этажа →
 * босс-слота нет, финал = простой этаж+портал; нет rest-этажа → нет городов. Детерминировано от сида.
 */
export function generateRunPlan(reg: ConfigRegistry, config: RunConfig): RunPlan {
  const templates = reg.get('run-templates') as RunTemplate[];
  const biomes = reg.get('biomes') as Biome[];
  const floors = reg.get('floors') as Floor[];
  const mods = reg.get('run-modifiers') as RunModifier[];

  const tpl = templates.find((t) => t.id === config.templateId) ?? templates[0];
  const templateId = tpl?.id ?? config.templateId;
  const biome = biomes.find((b) => b.id === config.biomeId) ?? biomes[0]!;
  const rng = createRng((config.seed >>> 0) || 1);

  // Параметры: config переопределяет дефолты шаблона.
  const L = config.length ?? (tpl ? rng.int(tpl.length.min, tpl.length.max) : rng.int(6, 10));
  const widthMax = config.widthMax ?? tpl?.width.max ?? 3;
  const widthMin = tpl?.width.min ?? 1;
  const branching = config.branching ?? tpl?.branching ?? 0.5;
  const returnEvery = config.returnEvery ?? tpl?.returnEvery ?? 0;
  const returnJitter = tpl?.returnJitter ?? 0;
  const bossEvery = config.bossEvery ?? tpl?.bossEvery ?? 0;
  const finale = tpl?.finale ?? true;
  const typeWeights = config.nodeTypeWeights ?? (tpl?.nodeTypeWeights as Record<string, number>) ?? { combat: 6, elite: 2, treasure: 1, event: 1, shop: 1 };

  const nodeMods = mods.filter((m) => m.scope === 'node' && m.enabled !== false);
  const runModIds = config.modifiers.filter((id) => mods.some((m) => m.id === id && m.scope === 'run' && m.enabled !== false));

  // Доступные роли = у которых есть этаж-член шаблона в этом биоме.
  const avail = availableRoles(biome.id, floors, templateId);
  const combatRoles = (() => {
    const c = COMBAT_ROLES.filter((r) => avail.has(r));
    if (c.length) return c;
    const any = [...avail].filter((r) => r !== 'rest' && r !== 'boss' && r !== 'finale');
    return any.length ? any : ([...avail][0] ? [[...avail][0]!] : (['combat'] as FloorRole[]));
  })();
  const restAvail = avail.has('rest') && returnEvery > 0;
  const bossAvail = avail.has('boss') && bossEvery > 0;

  const nodes: RunNode[] = [];
  const layers: RunNode[][] = [];

  const makeNode = (nodeType: RunNodeType, floorRole: FloorRole, depth: number, lane: number): RunNode => {
    const nodeModIds: string[] = [];
    const canMod = nodeType === 'combat' || nodeType === 'elite' || nodeType === 'boss';
    if (canMod && nodeMods.length) {
      const chance = nodeType === 'boss' ? 0.9 : nodeType === 'elite' ? 0.6 : 0.3;
      if (rng.chance(chance)) {
        const picked = weightedPick(nodeMods.map((m) => ({ item: m, weight: m.weight })), rng);
        if (picked) nodeModIds.push(picked.id);
      }
    }
    const seed = nodeSeed(config.seed, depth, lane);
    const floor = pickFloorForRole(floorRole, biome.id, floors, depth, templateId, seed) ?? pickFloor(biome.id, floors, depth, seed);
    const floorSpec = resolveFloorSpec(biome, floor, depth, seed, [...runModIds, ...nodeModIds]);
    return { id: depth === 0 ? 'start' : `n${depth}_${lane}`, type: nodeType, depth, lane, biomeId: biome.id, floorSpec, modifiers: nodeModIds, edges: [] };
  };

  // Слой 0 — старт (обычный боевой этаж).
  const start = makeNode('start', combatRoles[0]!, 0, 0);
  layers[0] = [start];
  nodes.push(start);

  // Слои 1..L.
  let restCursor = returnEvery > 0 ? returnEvery + (returnJitter ? rng.int(-returnJitter, returnJitter) : 0) : Infinity;
  for (let d = 1; d <= L; d++) {
    const isRest = restAvail && d === restCursor && d < L;
    const isBoss = bossAvail && d % bossEvery === 0 && d < L;
    if (returnEvery > 0 && d === restCursor) restCursor = d + returnEvery + (returnJitter ? rng.int(-returnJitter, returnJitter) : 0);

    const width = isRest || isBoss ? 1 : Math.max(1, Math.min(widthMax, rng.int(widthMin, widthMax)));
    const layer: RunNode[] = [];
    for (let lane = 0; lane < width; lane++) {
      let role: FloorRole;
      if (isRest) role = 'rest';
      else if (isBoss) role = 'boss';
      else role = weightedPick(combatRoles.map((t) => ({ item: t, weight: typeWeights[t] ?? 0 })), rng) ?? combatRoles[0]!;
      const node = makeNode(role as RunNodeType, role, d, lane);
      layer.push(node);
      nodes.push(node);
    }
    layers[d] = layer;
  }

  // Финал: finale-этаж если есть, иначе boss, иначе простой (портал через exitCount 0).
  if (finale) {
    const fd = L + 1;
    const finaleRole: FloorRole = avail.has('finale') ? 'finale' : avail.has('boss') ? 'boss' : combatRoles[0]!;
    const fin = makeNode('finale', finaleRole, fd, 0);
    layers[fd] = [fin];
    nodes.push(fin);
  }

  // Рёбра между соседними слоями + гарантия входящего ребра.
  const norm = (lane: number, width: number) => (width <= 1 ? 0.5 : lane / (width - 1));
  for (let d = 0; d < layers.length - 1; d++) {
    const cur = layers[d]!, nxt = layers[d + 1]!;
    if (!cur || !nxt || !cur.length || !nxt.length) continue;
    const addEdge = (a: RunNode, b: RunNode) => { if (!a.edges.some((e) => e.to === b.id)) a.edges.push({ to: b.id }); };
    for (const a of cur) {
      const ax = norm(a.lane, cur.length);
      const sorted = [...nxt].sort((p, q) => Math.abs(norm(p.lane, nxt.length) - ax) - Math.abs(norm(q.lane, nxt.length) - ax));
      addEdge(a, sorted[0]!);
      if (sorted[1] && rng.chance(branching)) addEdge(a, sorted[1]!);
    }
    for (const b of nxt) {
      if (cur.some((a) => a.edges.some((e) => e.to === b.id))) continue;
      const bx = norm(b.lane, nxt.length);
      const src = [...cur].sort((p, q) => Math.abs(norm(p.lane, cur.length) - bx) - Math.abs(norm(q.lane, cur.length) - bx))[0]!;
      addEdge(src, b);
    }
  }

  // Число выходов этажа = число исходящих рёбер узла (развилка → несколько выходов; finale → 0).
  for (const n of nodes) n.floorSpec.exitCount = n.edges.length;

  const finaleNode = finale ? layers[L + 1]![0] : layers[L]?.[0];
  return {
    templateId,
    biomeId: biome.id,
    tier: config.tier,
    seed: config.seed,
    startId: start.id,
    finaleId: finaleNode?.id,
    nodes,
    runModifiers: runModIds,
  };
}

/** RunConfig по умолчанию из шаблона (для алтаря редактора / старта забега).
 *  Биом от шаблона НЕ зависит — берётся первый (алтарь переопределяет своим селектом). */
export function defaultRunConfig(reg: ConfigRegistry, templateId: string, seed: number): RunConfig {
  const templates = reg.get('run-templates') as RunTemplate[];
  const tpl = templates.find((t) => t.id === templateId) ?? templates[0]!;
  const biomes = reg.get('biomes') as Biome[];
  return {
    templateId: tpl.id,
    biomeId: biomes[0]!.id,
    tier: tpl.tier,
    seed,
    modifiers: [],
  };
}

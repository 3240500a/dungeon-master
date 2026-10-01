/**
 * ПРОДЮСЕР И СТОРОЖ эталона МИРА ЭТАЖА для Unity-клиента (U5a): интерактивы [E], подписи выходов развилки, метки миникарты,
 * цвета сундуков / дропов / снарядов / чисел урона и строки журнала по событиям сервера.
 *
 * Unity — основной клиент, веб — источник истины по правилам. Правила веб-3D живут ВНУТРИ `render3d/online3d.ts` (`buildArea`,
 * `updateInteractions`, `onEvents`, рендер снарядов и дропов) и наружу не экспортируются, поэтому здесь они повторены копией — и
 * каждая копия СТОРОЖИТСЯ строкой исходника (`SRC` ниже, как сторож `runExits.test.ts`): правило в `online3d.ts` поменяли —
 * тест падает, пока копию и эталон не обновят осознанно. Настоящими функциями веба считаются подписи выходов (`exitLabel`,
 * `exitInteract`), подписи узлов (`runLabels`), цвета каналов урона (`setDamageTypeMeta` + `dmgColorNum` — как их заводит `App` из
 * конфига) и планы забегов (`generateRunPlan` на шаблонах конфига).
 *
 * Эталон: `__golden__/unity_world.json` → Unity `Assets/DM/Net/Tests/unity_world_golden.json` (`tools/unity-check/golden_sync.py`),
 * проверка — `WorldCheck` (порт `Net/WorldRules.cs`). Перезапись: `npx vitest run -u packages/client/src/modules/run/unityWorldGolden.gen.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigRegistry, TILE, defaultRunConfig, generateRunPlan, type FloorInit, type RunPlan } from '@dm/shared';
import { exitInteract, exitLabel } from './runExits.js';
import { RUN_NODE_COLOR, RUN_NODE_LABEL, runNodeColor, runNodeLabel } from './runLabels.js';
import { dmgColorNum, setDamageTypeMeta } from '../../core/damageTypes.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ONLINE3D = readFileSync(join(HERE, '../../render3d/online3d.ts'), 'utf8');
const GAMELOG = readFileSync(join(HERE, '../../ui/gameLog.ts'), 'utf8');

/**
 * Строки `online3d.ts` / `gameLog.ts`, которые повторены ниже копией. Нет строки — правило веба поменялось: обновить копию, эталон и
 * порт Unity (`WorldRules.cs`).
 */
const SRC: [string, string][] = [
  // buildArea: выходы, декор узла, возврат у входа, рычаги, сундуки, город
  [ONLINE3D, 'const isFinale = (floor.exits?.length ?? 0) === 0;'],
  [ONLINE3D, 'const exits = floor.exits ?? (floor.stairs ? [floor.stairs] : []);'],
  [ONLINE3D, 'interactables.push(exitInteract(ex, floor, i, () => app.run?.plan, (k) => descendExit(k)));'],
  [ONLINE3D, "if (d.kind === 'shop') interactables.push({ x: d.x, y: d.y, radius: 40, label: 'Лавка', run: () => app.bus.emit('ui:open', { panel: 'shop' }) });"],
  [ONLINE3D, "else if (d.kind === 'portal') interactables.push(isFinale"],
  [ONLINE3D, "? { x: d.x, y: d.y, radius: 44, label: 'Завершить забег (голосование)', run: () => app.net.send({ t: 'descend' }) }"],
  [ONLINE3D, ": { x: d.x, y: d.y, radius: 44, label: 'Вернуться в город (голосование)', run: () => app.net.send({ t: 'return' }) });"],
  [ONLINE3D, "interactables.push({ x: floor.spawn.x, y: floor.spawn.y, radius: 40, label: 'Вернуться в город (голосование)', run: () => app.net.send({ t: 'return' }) });"],
  [ONLINE3D, "interactables.push({ x: lv.x, y: lv.y, radius: 40, label: 'Рычаг (открыть дверь)', run: () => app.net.send({ t: 'lever', leverId: lv.id }), doorId: lv.doorId });"],
  [ONLINE3D, "const tint = ch.tier === 'rare' ? 0xd0a24a : ch.tier === 'magic' ? 0x7fb6e0 : 0x9a7a52;"],
  [ONLINE3D, "interactables.push({ x: ch.x, y: ch.y, radius: 48, label: 'Сундук (открыть)', run: () => app.net.send({ t: 'chest', chestId: ch.id }) });"],
  [ONLINE3D, 'const wx = n.cx * TILE + TILE / 2, wz = n.cy * TILE + TILE / 2;'],
  [ONLINE3D, "interactables.push({ x: wx, y: wz, radius: 42, label: n.label, run: () => app.bus.emit('ui:open', { panel: n.panel }) });"],
  [ONLINE3D, 'const pwx = (cols - 4) * TILE + TILE / 2, pwz = (rows - 4) * TILE + TILE / 2;'],
  [ONLINE3D, "interactables.push({ x: pwx, y: pwz, radius: 46, label: 'В подземелье (выбор сложности)', run: () => app.bus.emit('ui:open', { panel: 'difficulty' }) });"],
  // спуск по ребру, открытие двери и сундука
  [ONLINE3D, 'const cur = run?.plan.nodes.find((n) => n.id === run.currentNodeId);'],
  [ONLINE3D, "app.net.send({ t: 'descend', targetNodeId: cur?.edges[i]?.to });"],
  [ONLINE3D, 'interactables = interactables.filter((it) => it.doorId !== doorId);'],
  [ONLINE3D, "interactables = interactables.filter((it) => Math.hypot(it.x - e.x, it.y - e.y) > 1 || it.label !== 'Сундук (открыть)');"],
  // подсказка [E] и метки миникарты
  [ONLINE3D, 'for (const it of interactables) { const d = Math.hypot(it.x - smoothX, it.y - smoothZ); if (d <= it.radius && d < best) { near = it; best = d; } }'],
  [ONLINE3D, 'if (near) { if (hint) hint.textContent = `[E] ${near.label}`; if (eDown && !eWasDown) near.run(); }'],
  [ONLINE3D, "else if (hint) hint.textContent = 'WASD — идти · ЛКМ/ПКМ/Shift/Space/Alt — действия · 1-4 — зелья · I/K/C — окна · колесо — зум · F3 — дебаг';"],
  [ONLINE3D, "kind: /спуст|подземель|глубже|город|заверш/i.test(it.label) ? 'portal' : /рычаг/i.test(it.label) ? 'lever' : 'npc'"],
  // снаряды, дропы, числа урона
  [ONLINE3D, "const tint = pr.owner === 'monster' ? 0xff8080 : dmgColorNum(pr.dom);"],
  [ONLINE3D, "const col = d.kind === 'gold' ? 0xffd24a : d.kind === 'materials' ? 0x9aa6b2 : 0xdcc060;"],
  [ONLINE3D, "const dom = (['physical', 'fire', 'cold', 'lightning', 'poison'] as const).reduce((b, t) => (e.byType[t] > e.byType[b] ? t : b), 'physical' as DamageType);"],
  [ONLINE3D, "if (!e.hit) vfx.floatText(e.x, e.y, 'промах', 0x9a9a9a);"],
  [ONLINE3D, "else if (e.blocked) vfx.floatText(e.x, e.y, 'блок', 0x8fd0ff);"],
  [ONLINE3D, "else if (e.amount > 0) vfx.damage(e.x, e.y, e.amount, e.target === 'player' ? 0xff5b5b : dmgColorNum(dom), e.crit);"],
  // журнал
  [ONLINE3D, "if (e.target === 'monster' && e.by === myId && e.hit && e.amount > 0) bus.emit('log:message', { text: `Нанёс ${e.amount}${e.crit ? ' крит!' : ''}`, kind: 'dmg-out' });"],
  [ONLINE3D, "else if (e.target === 'player' && e.id === myId && e.hit && e.amount > 0) bus.emit('log:message', { text: `Получил ${e.amount}${e.crit ? ' крит!' : ''}`, kind: 'dmg-in' });"],
  [ONLINE3D, "if (e.by === myId) bus.emit('log:message', { text: `Убит ${e.def.name}`, kind: 'kill' });"],
  [ONLINE3D, "if (e.playerId === myId) { bus.emit('log:message', { text: `Поднято: ${e.item.name}`, kind: 'loot' }); bus.emit('item:picked', { item: e.item }); }"],
  [ONLINE3D, "else if (e.type === 'xp') { if (e.playerId === myId) bus.emit('log:message', { text: `Опыт +${e.amount}`, kind: 'xp' }); }"],
  [ONLINE3D, "if (e.playerId === myId) { bus.emit('log:message', { text: `Новый уровень: ${e.level}!`, kind: 'kill' });"],
  [ONLINE3D, "else if (e.type === 'quest') { if (e.playerId === myId) bus.emit('log:message', { text: e.name, kind: 'system' }); }"],
  [GAMELOG, "'dmg-out': '#e6ddc9',"], [GAMELOG, "'dmg-in': '#c85a48',"], [GAMELOG, "kill: '#dca94b',"], [GAMELOG, "xp: '#8aa84a',"],
  [GAMELOG, "gold: '#dca94b',"], [GAMELOG, "loot: '#7fa8d0',"], [GAMELOG, "system: '#8f897c',"], [GAMELOG, 'const MAX_LINES = 200;'],
];

// ── Копии правил online3d (сторожатся `SRC`) ─────────────────────────────────
const TOWN_NPCS = [
  { cx: 4, cy: 4, label: 'Магазин', panel: 'shop', tint: 0x9fd0ff },
  { cx: 7, cy: 4, label: 'Кузница', panel: 'forge', tint: 0xffa060 },
  { cx: 10, cy: 4, label: 'Мастер прокачки', panel: 'master', tint: 0xb090ff },
  { cx: 14, cy: 4, label: 'Доска квестов', panel: 'quests', tint: 0xd0c060 },
  { cx: 17, cy: 4, label: 'Сундук', panel: 'stash', tint: 0xc99a48 },
];
const HINT_IDLE = 'WASD — идти · ЛКМ/ПКМ/Shift/Space/Alt — действия · 1-4 — зелья · I/K/C — окна · колесо — зум · F3 — дебаг';
const LOG_COLOR = { 'dmg-out': '#e6ddc9', 'dmg-in': '#c85a48', kill: '#dca94b', xp: '#8aa84a', gold: '#dca94b', loot: '#7fa8d0', system: '#8f897c' };

/** Интерактив, как его видит эталон: что делает [E] (`act` + аргумент) и где. Подпись выхода — на миг показа (план). */
interface Act { x: number; y: number; radius: number; label: string; act: string; id?: number; doorId?: number; exit?: number; panel?: string; target?: string | null }

/** `buildArea` веб-3D — интерактивы области в ТОМ ЖЕ порядке (ничья ближайшего — первый). */
function areaActs(floor: FloorInit, plan: RunPlan | undefined, currentNodeId: string | undefined): Act[] {
  const out: Act[] = [];
  if (floor.area === 'dungeon') {
    const isFinale = (floor.exits?.length ?? 0) === 0;
    const exits = floor.exits ?? (floor.stairs ? [floor.stairs] : []);
    exits.forEach((ex, i) => {
      let target: string | null | undefined;
      const it = exitInteract(ex, floor, i, () => plan, (k) => {
        const cur = plan?.nodes.find((n) => n.id === currentNodeId);
        target = cur?.edges[k]?.to ?? null;
      });
      it.run();
      out.push({ x: it.x, y: it.y, radius: it.radius, label: it.label, act: 'exit', exit: i, target });
    });
    for (const d of floor.decor) {
      if (d.kind === 'shop') out.push({ x: d.x, y: d.y, radius: 40, label: 'Лавка', act: 'panel', panel: 'shop' });
      else if (d.kind === 'portal') out.push(isFinale
        ? { x: d.x, y: d.y, radius: 44, label: 'Завершить забег (голосование)', act: 'descend' }
        : { x: d.x, y: d.y, radius: 44, label: 'Вернуться в город (голосование)', act: 'return' });
    }
    out.push({ x: floor.spawn.x, y: floor.spawn.y, radius: 40, label: 'Вернуться в город (голосование)', act: 'return' });
    for (const lv of floor.levers) out.push({ x: lv.x, y: lv.y, radius: 40, label: 'Рычаг (открыть дверь)', act: 'lever', id: lv.id, doorId: lv.doorId });
    for (const ch of floor.chests) out.push({ x: ch.x, y: ch.y, radius: 48, label: 'Сундук (открыть)', act: 'chest', id: ch.id });
  } else {
    for (const n of TOWN_NPCS) {
      const wx = n.cx * TILE + TILE / 2, wz = n.cy * TILE + TILE / 2;
      out.push({ x: wx, y: wz, radius: 42, label: n.label, act: 'panel', panel: n.panel });
    }
    const rows = floor.grid.length, cols = floor.grid[0]!.length;
    const pwx = (cols - 4) * TILE + TILE / 2, pwz = (rows - 4) * TILE + TILE / 2;
    out.push({ x: pwx, y: pwz, radius: 46, label: 'В подземелье (выбор сложности)', act: 'panel', panel: 'difficulty' });
  }
  return out;
}
/** `updateInteractions`: ближайший в своём радиусе (граница включена), ничья — первый в списке. */
function nearest(acts: Act[], x: number, y: number): number {
  let near = -1, best = Infinity;
  acts.forEach((it, i) => { const d = Math.hypot(it.x - x, it.y - y); if (d <= it.radius && d < best) { near = i; best = d; } });
  return near;
}
const markKind = (label: string): string => (/спуст|подземель|глубже|город|заверш/i.test(label) ? 'portal' : /рычаг/i.test(label) ? 'lever' : 'npc');
const chestTint = (tier: string): number => (tier === 'rare' ? 0xd0a24a : tier === 'magic' ? 0x7fb6e0 : 0x9a7a52);
const dropColor = (kind: string): number => (kind === 'gold' ? 0xffd24a : kind === 'materials' ? 0x9aa6b2 : 0xdcc060);
const projColor = (owner: string, dom: string): number => (owner === 'monster' ? 0xff8080 : dmgColorNum(dom));
type Dom = 'physical' | 'fire' | 'cold' | 'lightning' | 'poison';
type ByType = Partial<Record<Dom, number>>;
const hitDom = (byType: ByType): Dom => (['physical', 'fire', 'cold', 'lightning', 'poison'] as const)
  .reduce((b, t) => ((byType[t] as number) > (byType[b] as number) ? t : b), 'physical' as Dom);

/** Число всплывающего текста урона над целью (или промах/блок); null — ничего. */
function hitFloat(e: { hit: boolean; blocked: boolean; amount: number; crit: boolean; target: string; byType: ByType }): { text: string; color: number; big: boolean } | null {
  if (!e.hit) return { text: 'промах', color: 0x9a9a9a, big: false };
  if (e.blocked) return { text: 'блок', color: 0x8fd0ff, big: false };
  if (e.amount > 0) return { text: String(e.amount), color: e.crit ? 0xffd24a : (e.target === 'player' ? 0xff5b5b : dmgColorNum(hitDom(e.byType))), big: e.crit };   // vfx.damage
  return null;
}

/** `onEvents` → строка журнала (`log:message`) или null. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function logLine(e: any, myId: string): { text: string; kind: string } | null {
  if (e.type === 'hit') {
    if (e.target === 'monster' && e.by === myId && e.hit && e.amount > 0) return { text: `Нанёс ${e.amount}${e.crit ? ' крит!' : ''}`, kind: 'dmg-out' };
    if (e.target === 'player' && e.id === myId && e.hit && e.amount > 0) return { text: `Получил ${e.amount}${e.crit ? ' крит!' : ''}`, kind: 'dmg-in' };
    return null;
  }
  if (e.type === 'monster-died') return e.by === myId ? { text: `Убит ${e.def.name}`, kind: 'kill' } : null;
  if (e.type === 'item-picked') return e.playerId === myId ? { text: `Поднято: ${e.item.name}`, kind: 'loot' } : null;
  if (e.type === 'xp') return e.playerId === myId ? { text: `Опыт +${e.amount}`, kind: 'xp' } : null;
  if (e.type === 'levelup') return e.playerId === myId ? { text: `Новый уровень: ${e.level}!`, kind: 'kill' } : null;
  if (e.type === 'quest') return e.playerId === myId ? { text: e.name, kind: 'system' } : null;
  return null;
}

// ── Входы эталона ────────────────────────────────────────────────────────────
const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
/** План, каким его видит клиент: узлы — id, тип, рёбра (остальное подписи и спуск не читают). */
const slim = (p: RunPlan): unknown => ({ startId: p.startId, nodes: p.nodes.map((n) => ({ id: n.id, type: n.type, edges: n.edges.map((e) => ({ to: e.to })) })) });
const node = (id: string, type: string, to: string[]): RunPlan['nodes'][number] => ({ id, type, depth: 0, lane: 0, biomeId: 'crypt', floorSpec: {}, modifiers: [], edges: to.map((t) => ({ to: t })) } as unknown as RunPlan['nodes'][number]);
const SYNTH: RunPlan = {
  templateId: 't', biomeId: 'crypt', tier: 'normal', seed: 1, startId: 'start', runModifiers: [],
  nodes: [node('start', 'start', ['n1_0', 'n1_1', 'n1_2']), node('n1_0', 'shop', ['n2_0']), node('n1_1', 'boss', ['n2_0']), node('n1_2', 'mystery', ['n2_0']),
    node('n2_0', 'combat', ['n3_0', 'ghost']), node('n3_0', 'finale', [])],
};
const PLANS: RunPlan[] = [SYNTH];
for (const t of reg.get('run-templates').filter((x) => x.enabled !== false)) {
  for (const seed of [7, 4242]) PLANS.push(generateRunPlan(reg, defaultRunConfig(reg, t.id, seed)));
}

/** Этаж для `areaActs` (поля, которых интерактивы не читают, — пустые). */
const dungeon = (o: Partial<FloorInit>): FloorInit => ({
  area: 'dungeon', depth: 2, grid: [[0]], spawn: { x: 80, y: 80 }, decor: [], doors: [], levers: [], chests: [], ...o,
} as FloorInit);
const AREAS: { name: string; floor: FloorInit; plan?: number; current?: string }[] = [
  {
    name: 'развилка: два выхода, лавка, портал (возврат), декор, два рычага, четыре сундука', plan: 0, current: 'start',
    floor: dungeon({
      runNodeId: 'start', exits: [{ x: 400, y: 600 }, { x: 448, y: 600 }], stairs: { x: 400, y: 600 },
      decor: [{ x: 120, y: 90, kind: 'shop' }, { x: 300, y: 300, kind: 'portal' }, { x: 64, y: 64, kind: 'torch' }, { x: 500, y: 500, kind: 'obj', objectId: 'x', rot: 1.5, footprint: { w: 2, h: 2 } }, { x: 520, y: 140, kind: 'chest' }],
      levers: [{ id: 3, x: 200, y: 96, doorId: 7 }, { id: 4, x: 230, y: 96, doorId: 8 }],
      chests: [{ id: 11, x: 150, y: 300, tier: 'rare' }, { id: 12, x: 190, y: 300, tier: 'magic' }, { id: 13, x: 600, y: 600, tier: 'common' }, { id: 14, x: 640, y: 640, tier: 'legendary' }],
    }),
  },
  { name: 'обычный узел: один выход, рычаг у входа', plan: 0, current: 'n1_0', floor: dungeon({ runNodeId: 'n1_0', exits: [{ x: 400, y: 600 }], levers: [{ id: 1, x: 90, y: 80, doorId: 2 }] }) },
  { name: 'один выход на узле-развилке (подпись — тип первого ребра)', plan: 0, current: 'n2_0', floor: dungeon({ runNodeId: 'n2_0', exits: [{ x: 400, y: 600 }] }) },
  { name: 'выход на ребро, которого нет в графе', plan: 0, current: 'n2_0', floor: dungeon({ runNodeId: 'n2_0', exits: [{ x: 400, y: 600 }, { x: 440, y: 600 }, { x: 480, y: 600 }] }) },
  { name: 'плана ещё нет (кадр runPlan позже этажа)', floor: dungeon({ runNodeId: 'start', exits: [{ x: 400, y: 600 }, { x: 448, y: 600 }] }) },
  { name: 'финал: выходов нет — портал завершает забег', plan: 0, current: 'n3_0', floor: dungeon({ runNodeId: 'n3_0', exits: [], decor: [{ x: 300, y: 300, kind: 'portal' }, { x: 340, y: 300, kind: 'shop' }] }) },
  { name: 'старый сервер: без exits, только stairs', floor: dungeon({ stairs: { x: 400, y: 600 }, decor: [{ x: 300, y: 300, kind: 'portal' }] }) },
  { name: 'без exits и без stairs: финал, выходов нет', floor: dungeon({ decor: [{ x: 300, y: 300, kind: 'portal' }] }) },
  { name: 'город 22×15', floor: { area: 'town', depth: 0, grid: Array.from({ length: 15 }, () => Array.from({ length: 22 }, () => 0)), spawn: { x: 352, y: 240 }, decor: [], doors: [], levers: [], chests: [] } as unknown as FloorInit },
  { name: 'город 30×20', floor: { area: 'town', depth: 0, grid: Array.from({ length: 20 }, () => Array.from({ length: 30 }, () => 0)), spawn: { x: 352, y: 240 }, decor: [], doors: [], levers: [], chests: [] } as unknown as FloorInit },
];

/** Точки опроса ближайшего: центр каждого, граница по оси (включена), чуть за ней, середины пар, пустое место. */
function probes(acts: Act[]): [number, number][] {
  const pts: [number, number][] = [[-1000, -1000]];
  for (const a of acts) pts.push([a.x, a.y], [a.x + a.radius, a.y], [a.x, a.y - a.radius], [a.x - a.radius - 0.01, a.y], [a.x + 0.25, a.y + 0.5]);
  for (let i = 0; i < acts.length; i++) for (let j = i + 1; j < acts.length; j++) {
    const a = acts[i]!, b = acts[j]!;
    if (Math.hypot(a.x - b.x, a.y - b.y) < a.radius + b.radius) pts.push([(a.x + b.x) / 2, (a.y + b.y) / 2]);
  }
  return pts;
}

/** События сервера (как в `SessionEvent`) для журнала и чисел урона; свой игрок — `p1`. */
const ME = 'p1';
const BT = (o: ByType): ByType => ({ physical: 0, fire: 0, cold: 0, lightning: 0, poison: 0, ...o });
const EVENTS: unknown[] = [
  { type: 'hit', target: 'monster', id: 5, by: ME, x: 10, y: 20, hit: true, blocked: false, crit: false, amount: 14, byType: BT({ physical: 14 }), mat: 'flesh' },
  { type: 'hit', target: 'monster', id: 5, by: ME, x: 10, y: 20, hit: true, blocked: false, crit: true, amount: 31, byType: BT({ physical: 10, fire: 21 }), mat: 'flesh' },
  { type: 'hit', target: 'monster', id: 5, by: ME, x: 10, y: 20, hit: true, blocked: false, crit: false, amount: 12.5, byType: BT({ cold: 12.5 }), mat: 'plate' },
  { type: 'hit', target: 'monster', id: 5, by: ME, x: 10, y: 20, hit: true, blocked: false, crit: false, amount: 0.30000000000000004, byType: BT({ lightning: 0.3 }), mat: 'plate' },
  { type: 'hit', target: 'monster', id: 5, by: ME, x: 10, y: 20, hit: true, blocked: false, crit: false, amount: 0, byType: BT({}), mat: 'flesh' },
  { type: 'hit', target: 'monster', id: 5, by: ME, x: 10, y: 20, hit: false, blocked: false, crit: false, amount: 0, byType: BT({}), mat: 'flesh' },
  { type: 'hit', target: 'monster', id: 5, by: ME, x: 10, y: 20, hit: true, blocked: true, crit: false, amount: 7, byType: BT({ physical: 7 }), mat: 'flesh' },
  { type: 'hit', target: 'monster', id: 5, by: 'p2', x: 10, y: 20, hit: true, blocked: false, crit: false, amount: 9, byType: BT({ poison: 4, fire: 4 }), mat: 'flesh' },
  { type: 'hit', target: 'monster', id: 6, x: 10, y: 20, hit: true, blocked: false, crit: false, amount: 3, byType: { poison: 3 }, mat: 'flesh' },
  { type: 'hit', target: 'monster', id: 6, by: ME, x: 10, y: 20, hit: true, blocked: false, crit: false, amount: 5, byType: BT({ fire: 2, cold: 2, lightning: 1 }), mat: 'flesh' },
  { type: 'hit', target: 'player', id: ME, by: '7', x: 10, y: 20, hit: true, blocked: false, crit: false, amount: 22, byType: BT({ physical: 22 }), mat: 'leather' },
  { type: 'hit', target: 'player', id: ME, by: '7', x: 10, y: 20, hit: true, blocked: false, crit: true, amount: 40, byType: BT({ fire: 40 }), mat: 'leather' },
  { type: 'hit', target: 'player', id: ME, by: '7', x: 10, y: 20, hit: false, blocked: false, crit: false, amount: 0, byType: BT({}), mat: 'leather' },
  { type: 'hit', target: 'player', id: 'p2', by: '7', x: 10, y: 20, hit: true, blocked: false, crit: false, amount: 8, byType: BT({ physical: 8 }), mat: 'leather' },
  { type: 'hit', target: 'player', id: 'p2', by: ME, x: 10, y: 20, hit: true, blocked: false, crit: false, amount: 6, byType: BT({ physical: 6 }), mat: 'leather' },
  { type: 'monster-died', id: 5, def: { name: 'Зомби-скаут' }, x: 1, y: 2, by: ME },
  { type: 'monster-died', id: 6, def: { name: 'Скелет «Кость»' }, x: 1, y: 2, by: 'p2' },
  { type: 'monster-died', id: 7, def: { name: 'Тень' }, x: 1, y: 2 },
  { type: 'item-picked', playerId: ME, item: { name: 'Короткий меч «Жар» 🔥' }, x: 1, y: 2 },
  { type: 'item-picked', playerId: 'p2', item: { name: 'Щит' }, x: 1, y: 2 },
  { type: 'gold', playerId: ME, amount: 12, total: 340 },
  { type: 'materials', playerId: ME, gains: { 'iron-1': 2 }, x: 1, y: 2 },
  { type: 'xp', playerId: ME, amount: 35 },
  { type: 'xp', playerId: 'p2', amount: 35 },
  { type: 'levelup', playerId: ME, level: 7 },
  { type: 'levelup', playerId: 'p2', level: 7 },
  { type: 'quest', playerId: ME, kind: 'completed', questId: 'q1', name: 'Задание выполнено: Крысы в подвале' },
  { type: 'quest', playerId: 'p2', kind: 'accepted', questId: 'q1', name: 'Чужое' },
  { type: 'player-died', playerId: ME },
  { type: 'swing', playerId: ME, ability: 'attack', windupMs: 300, cooldownMs: 600, lockMs: 500, x: 1, y: 2, facing: 0 },
  { type: 'cooldown', playerId: ME, ability: 'war-cry', cooldownMs: 8000 },
  { type: 'dodge', playerId: ME, x: 1, y: 2, dir: 0 },
  { type: 'knockdown', id: 5, dx: 1, dy: 0 },
  { type: 'stun', id: 5 },
  { type: 'chest-opened', id: 11, x: 150, y: 300 },
  { type: 'floor-cleared' },
];

function build(): unknown {
  // Цвета каналов урона — как `App.refreshLabelResolvers`: physical из damage-kinds, стихии из magic-subtypes.
  const kinds = reg.get('damage-kinds'), subs = reg.get('magic-subtypes');
  const phys = kinds.find((k) => k.id === 'physical');
  setDamageTypeMeta({
    ...(phys ? { physical: { name: phys.name, short: phys.short, color: phys.color, ailment: null } } : {}),
    ...Object.fromEntries(subs.map((s) => [s.id, { name: s.name, short: s.short, color: s.color, ailment: s.ailment }])),
  });
  const doms = ['physical', 'fire', 'cold', 'lightning', 'poison', 'magical', 'arcane', ''];

  const plans = PLANS.map(slim);
  const exits: unknown[] = [];
  PLANS.forEach((p, k) => {
    for (const n of [...p.nodes, undefined]) {
      const edges = n?.edges.length ?? 1;
      for (let i = 0; i <= edges; i++) {
        const cur = p.nodes.find((q) => q.id === n?.id);
        exits.push({ plan: k, node: n?.id ?? null, i, label: exitLabel(p, n?.id, i), target: cur?.edges[i]?.to ?? null });
      }
    }
  });
  exits.push({ plan: null, node: 'start', i: 0, label: exitLabel(undefined, 'start', 0), target: null });

  const areas = AREAS.map((a) => {
    const plan = a.plan == null ? undefined : PLANS[a.plan];
    const acts = areaActs(a.floor, plan, a.current);
    const near = probes(acts).map(([x, y]) => {
      const i = nearest(acts, x, y);
      return { x, y, near: i, hint: i >= 0 ? `[E] ${acts[i]!.label}` : HINT_IDLE };
    });
    return { name: a.name, floor: a.floor, plan: a.plan ?? null, current: a.current ?? null, acts: acts.map((it) => ({ ...it, mark: markKind(it.label) })), near };
  });

  const projColorMain = ['monster', 'player'].flatMap((owner) => doms.map((dom) => ({ owner, dom, color: projColor(owner, dom) })));
  // Синтетический конфиг каналов: physical — ПЕРВЫЙ из damage-kinds (`find`), стихия — ПОСЛЕДНЯЯ из magic-subtypes (`fromEntries`), physical
  // в magic-subtypes перекрывает damage-kinds (spread позже). У боевого конфига physical совпадает с запасным #c9c9d4 — порча чтения не видна.
  const alt = {
    'damage-kinds': [{ id: 'physical', name: 'Ф', short: 'ф', color: '#a0b0c0' }, { id: 'physical', name: 'Ф2', short: 'ф', color: '#ffffff' }, { id: 'magical', name: 'М', short: 'м', color: '#123456' }],
    'magic-subtypes': [{ id: 'fire', name: 'О', short: 'о', color: '#112233', ailment: 'burn' }, { id: 'fire', name: 'О2', short: 'о', color: '#445566', ailment: 'burn' }, { id: 'cold', name: 'Х', short: 'х', color: '#ABCDEF', ailment: 'freeze' }],
  };
  const altPhys = alt['damage-kinds'].find((k) => k.id === 'physical');
  setDamageTypeMeta({
    ...(altPhys ? { physical: { name: altPhys.name, short: altPhys.short, color: altPhys.color, ailment: null } } : {}),
    ...Object.fromEntries(alt['magic-subtypes'].map((x) => [x.id, { name: x.name, short: x.short, color: x.color, ailment: x.ailment }])),
  });
  const projColorAlt = ['player'].flatMap((owner) => doms.map((dom) => ({ owner, dom, color: projColor(owner, dom) })));
  const altSub = { ...alt, 'magic-subtypes': [...alt['magic-subtypes'], { id: 'physical', name: 'П', short: 'п', color: '#0f0e0d', ailment: null }] };
  setDamageTypeMeta({
    ...(altPhys ? { physical: { name: altPhys.name, short: altPhys.short, color: altPhys.color, ailment: null } } : {}),
    ...Object.fromEntries(altSub['magic-subtypes'].map((x) => [x.id, { name: x.name, short: x.short, color: x.color, ailment: x.ailment }])),
  });
  const projColorAltSub = ['player'].flatMap((owner) => doms.map((dom) => ({ owner, dom, color: projColor(owner, dom) })));
  setDamageTypeMeta({   // обратно боевой конфиг: числа урона событий ниже — по нему (как `dmgConfig` эталона)
    ...(phys ? { physical: { name: phys.name, short: phys.short, color: phys.color, ailment: null } } : {}),
    ...Object.fromEntries(subs.map((x) => [x.id, { name: x.name, short: x.short, color: x.color, ailment: x.ailment }])),
  });

  const markLabels = ['Спуститься глубже (голосование)', 'Спуститься: Лавка (голосование)', 'СПУСТИТЬСЯ', 'В подземелье (выбор сложности)', 'Вернуться в город (голосование)',
    'Завершить забег (голосование)', 'Рычаг (открыть дверь)', 'РЫЧАГ', 'Сундук (открыть)', 'Лавка', 'Магазин', 'Кузница', 'Доска квестов', 'Город', 'Заверши', 'глубже', ''];

  return {
    note: 'генерит packages/client/src/modules/run/unityWorldGolden.gen.test.ts (веб = источник истины); порт — Unity Net/WorldRules.cs, проверка WorldCheck',
    tile: TILE,
    hintIdle: HINT_IDLE,
    nodeLabels: { ...RUN_NODE_LABEL, mystery: runNodeLabel('mystery') },
    nodeColors: { ...RUN_NODE_COLOR, mystery: runNodeColor('mystery') },
    plans,
    exits,
    townNpcs: TOWN_NPCS,
    areas,
    marks: markLabels.map((label) => ({ label, kind: markKind(label) })),
    chestTint: ['rare', 'magic', 'common', 'legendary', ''].map((tier) => ({ tier, color: chestTint(tier) })),
    dropColor: ['gold', 'materials', 'item', ''].map((kind) => ({ kind, color: dropColor(kind) })),
    dmgConfig: { 'damage-kinds': kinds.map((k) => ({ id: k.id, color: k.color })), 'magic-subtypes': subs.map((s) => ({ id: s.id, color: s.color })) },
    projColor: projColorMain,
    dmgConfigAlt: [
      { config: { 'damage-kinds': alt['damage-kinds'].map((k) => ({ id: k.id, color: k.color })), 'magic-subtypes': alt['magic-subtypes'].map((k) => ({ id: k.id, color: k.color })) }, projColor: projColorAlt },
      { config: { 'damage-kinds': altSub['damage-kinds'].map((k) => ({ id: k.id, color: k.color })), 'magic-subtypes': altSub['magic-subtypes'].map((k) => ({ id: k.id, color: k.color })) }, projColor: projColorAltSub },
    ],
    me: ME,
    events: EVENTS.map((e) => {
      const ev = e as { type: string };
      return { event: e, log: logLine(e, ME), float: ev.type === 'hit' ? hitFloat(e as Parameters<typeof hitFloat>[0]) : null };
    }),
    logColors: LOG_COLOR,
    logMax: 200,
  };
}

describe('unityWorldGolden — продюсер эталона мира этажа (пишет __golden__/unity_world.json)', () => {
  it('копии правил online3d / gameLog совпадают с исходником (иначе: правило поменялось — обновить копию, эталон и порт Unity)', () => {
    for (const [src, line] of SRC) expect(src.includes(line), `нет строки исходника: ${line}`).toBe(true);
    expect(ONLINE3D.match(/\{ cx: \d+, cy: \d+, label: '[^']+', panel: '[^']+', tint: 0x[0-9a-f]+ \}/g), 'TOWN_NPCS')
      .toEqual(TOWN_NPCS.map((n) => `{ cx: ${n.cx}, cy: ${n.cy}, label: '${n.label}', panel: '${n.panel}', tint: 0x${n.tint.toString(16)} }`));
  });

  it('покрытие: развилка с подписями see-ahead, выход без ребра, план позже этажа, финал, ничьи и граница радиуса', () => {
    const g = build() as { exits: { label: string; target: string | null }[]; areas: { acts: Act[]; near: { near: number }[] }[] };
    expect(g.exits.some((e) => e.label.startsWith('Спуститься: '))).toBe(true);
    expect(g.exits.some((e) => e.label === 'Спуститься глубже (голосование)' && e.target != null)).toBe(true);
    expect(g.exits.length).toBeGreaterThan(100);
    const fork = g.areas[0]!;
    expect(fork.acts.filter((a) => a.act === 'exit').map((a) => a.label)).toEqual(['Спуститься: Лавка (голосование)', 'Спуститься: Босс (голосование)']);
    expect(fork.acts.filter((a) => a.act === 'exit').map((a) => a.target)).toEqual(['n1_0', 'n1_1']);
    expect(g.areas[5]!.acts.find((a) => a.act === 'descend')?.label).toBe('Завершить забег (голосование)');
    expect(g.areas[3]!.acts.filter((a) => a.act === 'exit').map((a) => a.target)).toEqual(['n3_0', 'ghost', null]);
    expect(g.areas[3]!.acts.filter((a) => a.act === 'exit').map((a) => a.label)).toEqual(['Спуститься: Финал (голосование)', 'Спуститься глубже (голосование)', 'Спуститься глубже (голосование)']);
    expect(g.areas.every((a) => a.near.some((n) => n.near >= 0) && a.near.some((n) => n.near < 0))).toBe(true);
  });

  it('эталон на диске совпадает с правилами веба (иначе: перезаписать -u и отдать порту Unity)', async () => {
    await expect(JSON.stringify(build(), null, 1) + '\n', 'правило мира поменялось: npx vitest run -u packages/client/src/modules/run/unityWorldGolden.gen.test.ts, '
      + 'затем python tools/unity-check/golden_sync.py в Unity и догнать Net/WorldRules.cs (WorldCheck)')
      .toMatchFileSnapshot('./__golden__/unity_world.json');
  });
});

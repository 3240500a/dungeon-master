import type { RunConfig, RunNodeState, RunState } from './types.js';

/**
 * ⭐ R4-01: ЗАПИСЬ УЗЛА ЗАБЕГА — чистые правила (оркестрация — `server/net/room.ts`).
 *
 * Забег паркуется в городе: «в город → спуск» продолжает ТОТ ЖЕ узел, а узел пересобирается из сида. Раньше вместе с
 * ним вставало всё: сундуки (гарантированная целая вещь), боссы и уники (добыча «босса» для ворот t6) — круг «в город
 * и обратно» фармил их без конца, честным клиентом через портал входа в том числе. Теперь узел помнит, что на нём
 * взято, и продолжение собирает его КАК ОСТАВИЛИ: открытые сундуки открыты, убитые монстры не встают, дёрнутые рычаги
 * держат двери открытыми.
 *
 * Рядовые монстры тоже не встают — осознанно: воскресший рядовой — это тот же круг, только за опыт, сырьё и трофеи с
 * тел, а запись дешёвая (номера в списке заселения). Узел, брошенный недобитым, ждёт недобитым.
 *
 * Запись лежит в сейве КАЖДОГО участника (`save.run.node`): продолжить забег может любой из них — хозяином новой комнаты,
 * после выхода соседа, реконнектом из базы. Сейв из базы формой не верим — `normalizeNodeState`.
 *
 * ⭐ R4-04: и не только ТЕКУЩЕГО узла — каждого пройденного (`save.run.nodes`). Указатель забега двигали вход по коду и
 * продолжение хозяином, и он уезжал назад: запись пройденного узла пропадала, и тот вставал свежим по кругу. Теперь
 * указатель назад не ходит, а любой узел, где кто-то из участников уже был, собирается по записи.
 */

/** Потолок номеров в одном списке: этаж столько не заселяется, а запись из базы — не повод держать мусор любой длины. */
export const NODE_STATE_MAX = 4096;
/** R4-04: потолок записей узлов одного забега в сейве — в шаблонах до полусотни узлов, запись из базы не повод держать мусор. */
export const RUN_NODES_MAX = 512;

/** Тот же ли это забег: сид и всё, из чего сервер пересобирает граф и этажи (`Room.buildRunConfig`). */
export function sameRun(a: RunConfig, b: RunConfig): boolean {
  const mods = (c: RunConfig): string => [...(Array.isArray(c.modifiers) ? c.modifiers : [])].sort().join('\u0001');
  return a.seed === b.seed && a.templateId === b.templateId && a.biomeId === b.biomeId && a.tier === b.tier && mods(a) === mods(b);
}

/** Номера списка: целые ≥ 0, без повторов, по возрастанию, не длиннее потолка. */
function ids(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const out = [...new Set(v.filter((n): n is number => Number.isSafeInteger(n) && (n as number) >= 0))];
  return out.sort((a, b) => a - b).slice(0, NODE_STATE_MAX);
}

/** Запись узла из базы (jsonb) или чужих рук: форма проверяется, мусор отбрасывается. Негодная — `undefined`. */
export function normalizeNodeState(raw: unknown): RunNodeState | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id) return undefined;
  if (typeof r.el !== 'number' || !Number.isFinite(r.el) || r.el < 0) return undefined;
  return { id: r.id, el: r.el, chests: ids(r.chests), killed: ids(r.killed), levers: ids(r.levers) };
}

/** Независимая копия: запись комнаты раздаётся по сейвам копиями — сейвы пишутся и откатываются каждый сам по себе. */
export function copyNodeState(st: RunNodeState): RunNodeState {
  return { id: st.id, el: st.el, chests: [...st.chests], killed: [...st.killed], levers: [...st.levers] };
}

/**
 * Объединить две записи ОДНОГО узла: взятое кем-либо взято для всех. Мощь — первой записи (у записей одного узла она
 * одна: пишется на первом входе и разносится всем). Записи разных узлов не смешиваются — остаётся первая.
 */
export function mergeNodeState(a: RunNodeState | undefined, b: RunNodeState | undefined): RunNodeState | undefined {
  if (!a) return b ? copyNodeState(b) : undefined;
  if (!b || b.id !== a.id) return copyNodeState(a);
  return { id: a.id, el: a.el, chests: ids([...a.chests, ...b.chests]), killed: ids([...a.killed, ...b.killed]), levers: ids([...a.levers, ...b.levers]) };
}

/**
 * ⭐ R4-04: ВСЕ ЗАПИСИ ЭТОГО ЗАБЕГА ИЗ СЕЙВА — текущего узла (`node`) и пройденных (`nodes`), проверенные и слитые по id.
 * Раньше сейв держал запись только текущего узла: указатель, отмотанный назад (вход по коду в комнату, стоящую на узле
 * раньше, продолжение хозяином), терял запись пройденного, и тот вставал свежим по кругу — сундуки, босс, опыт. Чужой
 * забег — пусто.
 */
export function runRecords(run: RunState | undefined, cfg: RunConfig): RunNodeState[] {
  if (!run || !run.config || !sameRun(run.config, cfg)) return [];
  const out = new Map<string, RunNodeState>();
  const add = (raw: unknown): void => {
    const st = normalizeNodeState(raw);
    if (!st || (!out.has(st.id) && out.size >= RUN_NODES_MAX)) return;
    out.set(st.id, mergeNodeState(out.get(st.id), st)!);
  };
  add(run.node);
  if (Array.isArray(run.nodes)) for (const r of run.nodes) add(r);
  return [...out.values()];
}

/** Запись узла `nodeId` забега `cfg` из сейва — текущего или пройденного (R4-04), если она про этот забег. */
export function nodeStateFor(run: RunState | undefined, cfg: RunConfig, nodeId: string): RunNodeState | undefined {
  return runRecords(run, cfg).find((st) => st.id === nodeId);
}

/**
 * ⭐ R4-04: пройден ли узел этим сейвом этого забега (`visited`). Пройденный БЕЗ записи — сейв старше записей (до R4-01 —
 * вовсе без них, до R4-04 — только с текущим узлом): такой узел считается взятым целиком, а не свежим.
 */
export function visitedNode(run: RunState | undefined, cfg: RunConfig, nodeId: string): boolean {
  return !!run?.config && sameRun(run.config, cfg) && Array.isArray(run.visited) && run.visited.includes(nodeId);
}

/**
 * ⭐ R4-04: влить записи в свод забега (по id, объединением, НА МЕСТЕ — запись узла комната держит по ссылке). `true` —
 * свод изменился. Взятое кем-либо взято для всех: свод комнаты собирает записи всех участников забега.
 */
export function foldRunRecords(into: Map<string, RunNodeState>, recs: Iterable<RunNodeState>): boolean {
  let changed = false;
  for (const r of recs) {
    const cur = into.get(r.id);
    if (!cur) {
      if (into.size >= RUN_NODES_MAX) continue;
      into.set(r.id, copyNodeState(r));
      changed = true;
      continue;
    }
    for (const k of ['chests', 'killed', 'levers'] as const) for (const id of r[k]) if (noteNodeId(cur[k], id)) changed = true;
  }
  return changed;
}

/**
 * ⭐ R4-04: разложить записи забега по сейву копиями: запись узла указателя — в `node`, остальные — в `nodes` (по id, под
 * потолком). Так сейв помнит КАЖДЫЙ пройденный узел, а не только тот, где стоит.
 */
export function putRunRecords(run: RunState, records: Iterable<RunNodeState>): void {
  let cur: RunNodeState | undefined;
  const rest: RunNodeState[] = [];
  for (const r of records) {
    if (r.id === run.currentNodeId) cur = copyNodeState(r);
    else if (rest.length < RUN_NODES_MAX) rest.push(copyNodeState(r));
  }
  rest.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (cur) run.node = cur; else delete run.node;
  if (rest.length) run.nodes = rest; else delete run.nodes;
}

/** ⭐ R4-04: внести одну запись в сейв (объединением с тем, что уже есть): узла указателя — в `node`, иного — в `nodes`. */
export function putRunRecord(run: RunState, st: RunNodeState): void {
  if (st.id === run.currentNodeId) {
    const had = normalizeNodeState(run.node);
    run.node = mergeNodeState(st, had?.id === st.id ? had : undefined)!;
    return;
  }
  const list = Array.isArray(run.nodes) ? run.nodes : [];
  // Поиск — по id без разбора (зовётся на каждое убийство): проверяется только найденная запись.
  const i = list.findIndex((r) => (r as { id?: unknown } | null)?.id === st.id);
  const merged = mergeNodeState(st, i >= 0 ? normalizeNodeState(list[i]) : undefined)!;
  if (i >= 0) list[i] = merged;
  else if (list.length < RUN_NODES_MAX) list.push(merged);
  run.nodes = list;
}

/** Добавить номер в список записи (по возрастанию, без повторов, под потолком). `true` — список изменился. */
export function noteNodeId(list: number[], id: number): boolean {
  if (!Number.isSafeInteger(id) || id < 0 || list.includes(id) || list.length >= NODE_STATE_MAX) return false;
  let i = list.length;
  while (i > 0 && list[i - 1]! > id) i--;
  list.splice(i, 0, id);
  return true;
}

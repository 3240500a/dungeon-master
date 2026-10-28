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
 *
 * ⭐⭐ 13.10 (Г2, Р5): ОБА СПИСКА СЕЙВА — ОКНО, А НЕ ИСТОРИЯ. Спуск бесконечен, и «помнить всё» значило бы растить сейв
 * на запись за этаж без конца; а прежний потолок записей (`RUN_NODES_MAX`) при переполнении ОТКАЗЫВАЛ новым — то есть
 * за потолком узлы перестали бы записываться вовсе (при тогдашних 512 — с 513-го этажа). Поэтому держим самые
 * ГЛУБОКИЕ записи (глубина — из имени узла, `runNodeDepth`), а самые мелкие вытесняем: вверх дороги нет, и мелкая
 * запись больше никому не понадобится.
 */

/** Потолок номеров в одном списке: этаж столько не заселяется, а запись из базы — не повод держать мусор любой длины. */
export const NODE_STATE_MAX = 4096;
/**
 * R4-04: потолок записей узлов одного забега в сейве.
 * ⭐⭐ 13.10 (Г2, Р5): теперь это ОКНО, а не отказ — см. `deepestFirst`.
 *
 * ⭐⭐ 13.10 (решение владельца-архитектора): 32, А НЕ 512. Припаркованный узел плюс запас на отставшего напарника —
 * вот и всё, что окно обязано держать; записи глубже окна не нужны, потому что указатель забега НАЗАД НЕ ХОДИТ (R4-04),
 * и вернуться можно только на припаркованный узел или туда, где стоит напарник.
 *
 * ЦЕНА БЫЛА ИЗМЕРЕНА (`server/net/room.g2save.test.ts`, спуск на 600 этажей настоящей `Room`): при 512 сейв выходил на
 * полку ≈35 КБ (сам забег ≈31,6 КБ), при 32 — ≈6,2 КБ (забег ≈2,8 КБ). ⚠ Числа округлены нарочно: полка печатает от
 * прогона к прогону 6 226…6 228 Б (номера узлов и число убитых пляшут от сида), и точность до байта тут ложная.
 * Эти ~29 КБ уезжали в Postgres при КАЖДОЙ
 * записи сейва, а прочитать их всё равно некому. Окно закрывается на 33-м этаже (узел указателя лежит отдельно,
 * `run.node`), дальше ни один список не растёт.
 *
 * ⚠ `RUN_VISITED_MAX` при этом НЕ СУЖЕН — но дёшев он НЕ ТАК, как здесь стояло: прежняя строка («строки по 6 байт, его
 * 64 записи весят меньше одной записи узла») перевёрнута. ЗАМЕР 14.10 (тот же спуск на 600 этажей настоящей `Room`,
 * байты JSON сейва): запись `visited` — 9,0 Б (все 64 — 577 Б; на 100-м этаже 8,0 Б и 514 Б, в именах меньше цифр),
 * запись узла — 59–60 Б (32 записи — 1 921 Б). То есть все 64 записи `visited` весят как ДЕСЯТЬ записей узла. Сужать
 * всё равно нечего: 577 Б — пятая часть полки забега (2 843 Б), а читатель у списка ровно один (`visitedNode`, ниже).
 */
export const RUN_NODES_MAX = 32;
/**
 * ⭐⭐ 13.10 (Г2, Р5): потолок списка пройденных узлов (`RunState.visited`) — тоже ОКНО самых глубоких.
 *
 * Список был без потолка вовсе: до Г2 забег кончался на 15-м этаже, и длиннее двух десятков он не бывал. В бесконечном
 * спуске он растёт на запись за этаж — навсегда, в каждой записи сейва в Postgres.
 *
 * Почему 64 ХВАТАЕТ С ЗАПАСОМ: единственный читатель — `visitedNode`, и его зовут РОВНО для узла, в который входят
 * (`Room.enterNode`, флаг `bare`), а указатель забега ходит только вперёд (R4-04). То есть нужен ответ про текущий узел
 * и, после «в город → продолжить», про узлы не глубже него; узел на 64 слоя выше текущего не входится ни одним
 * сценарием (ни пати, ни вход по коду, ни «Продолжить» — все берут САМЫЙ ГЛУБОКИЙ указатель комнаты).
 */
export const RUN_VISITED_MAX = 64;

/**
 * ⭐⭐ 13.10 (Г2): ГЛУБИНА УЗЛА ИЗ ЕГО ИМЕНИ (`n<глубина>_<полоса>`, `generateRunPlan`) — без графа. −1 — имя не наше
 * (чужой сейв, мусор из базы): такая запись в окне самая мелкая и вытесняется первой.
 *
 * Один шов на всех: тем же читают глубину сервер (`Room.depthOf`, `nodeDepthOf`) и окно сейва ниже. План — ОКНО слоёв,
 * поиском в нём глубину узла не узнать: указатель напарника (и свой, из сейва) законно лежит за его краем.
 */
export function runNodeDepth(id: string | undefined): number {
  const m = /^n(\d+)_\d+$/.exec(id ?? '');
  // ⚠ 14.10: 15 ЦИФР ГЛУБИНЫ — ПОТОЛОК ПАРНОСТИ С БАЗОЙ, а не придирка. SQL-шов свода (`LEDGER_DEPTH` в
  // `server/db/db.ts`) кладёт глубину в `bigint` и потому берёт `[0-9]{1,15}`: имя с двадцатью цифрами уронило бы ВЕСЬ
  // запрос свода. Давай здесь такое имя число — порченая запись была бы в окне сейва САМОЙ ГЛУБОКОЙ, а в базе самой
  // мелкой: два правила вместо одного. Заодно за 2^53 `Number` врёт (`n9999999999999999_0` → 1e16), и два разных имени
  // получили бы одну глубину.
  return m && m[1]!.length <= 15 ? Number(m[1]) : -1;
}

/**
 * ⭐⭐ 14.10 (Г4): ПОЛОСА УЗЛА ИЗ ЕГО ИМЕНИ — вторая половина того же имени (`n<глубина>_<полоса>`), и разбирается она
 * ЗДЕСЬ, рядом с глубиной, а не своей регуляркой у читателя: формат имени обязан жить в одном месте (его пишет
 * `generateRunPlan`, читают сервер и окна сейва).
 *
 * −1 — имя не наше. Потолок цифр тот же, что у глубины, и по той же причине: за 2^53 `Number` врёт, а полоса —
 * НОМЕР В СЛОЕ (0…ширина−1), то есть больше горстки она не бывает ни в одном забеге.
 *
 * Единственный читатель — зажим полосы на входе в узел (`Room.enterNode` → `nodeFor`): ширину слоя решает живой
 * конфиг (`generateRunPlan.layerWidth`), и правка шаблона/каденции может оставить сейв с полосой, которой в слое
 * больше нет.
 */
export function runNodeLane(id: string | undefined): number {
  const m = /^n\d+_(\d+)$/.exec(id ?? '');
  return m && m[1]!.length <= 15 ? Number(m[1]) : -1;
}

/**
 * ⭐⭐ 13.10 (Г2, Р5): ОКНО САМЫХ ГЛУБОКИХ. Спуск бесконечен, а ВВЕРХ ДОРОГИ НЕТ — поэтому оба списка сейва не история, а
 * окно: переполнение выбрасывает САМУЮ МЕЛКУЮ запись, а не отказывает новой (прежний `RUN_NODES_MAX` отказывал — и
 * глубокий забег перестал бы помнить свежие узлы, то есть сундуки и боссы начали бы фармиться продолжением, ровно тот
 * баг, против которого записи и заведены, R4-01).
 *
 * `keep` — id, который обязан остаться при любой длине: это узел, на котором стоит комната (его запись она держит ПО
 * ССЫЛКЕ и дописывает на каждое убийство, `Room.noteNode`), — вытеснить его значило бы тихо перестать записывать.
 */
function deepestFirst<T>(items: T[], idOf: (v: T) => string, max: number, keep?: string): T[] {
  if (items.length <= max) return items;
  const order = [...items].sort((a, b) => runNodeDepth(idOf(b)) - runNodeDepth(idOf(a)));
  const live = new Set<string>();
  if (keep !== undefined && items.some((v) => idOf(v) === keep)) live.add(keep);
  for (const v of order) { if (live.size >= max) break; live.add(idOf(v)); }
  // ⚠ Повтор id из базы (сейв чужих рук) оставляем ОДИН: иначе окно вышло бы длиннее потолка, который стережёт схема
  // сейва. Теряется только двойник — записи одного узла всё равно сливаются чтением (`runRecords`).
  const seen = new Set<string>();
  return items.filter((v) => { const id = idOf(v); if (!live.has(id) || seen.has(id)) return false; seen.add(id); return true; });
}

/**
 * ⭐⭐ 13.10 (Г2, Р5): ПОМЕТИТЬ УЗЕЛ ПРОЙДЕННЫМ — окном самых глубоких (`RUN_VISITED_MAX`), без повторов и без мусора.
 * Узел, в который входят, остаётся в списке всегда: по нему `visitedNode` решает, собирать узел свежим или взятым.
 */
export function noteVisited(visited: readonly unknown[] | undefined, nodeId: string): string[] {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const v of Array.isArray(visited) ? visited : []) if (typeof v === 'string' && v && !seen.has(v)) { seen.add(v); list.push(v); }
  if (!seen.has(nodeId)) list.push(nodeId);
  return deepestFirst(list, (v) => v, RUN_VISITED_MAX, nodeId);
}

/** Тот же ли это забег: сид и всё, из чего сервер пересобирает граф и этажи (`Room.buildRunConfig`). */
export function sameRun(a: RunConfig, b: RunConfig): boolean {
  const mods = (c: RunConfig): string => [...(Array.isArray(c.modifiers) ? c.modifiers : [])].sort().join('\u0001');
  return a.seed === b.seed && a.biomeId === b.biomeId && a.tier === b.tier && mods(a) === mods(b);
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
    if (!st) return;
    out.set(st.id, mergeNodeState(out.get(st.id), st)!);
  };
  add(run.node);
  if (Array.isArray(run.nodes)) for (const r of run.nodes) add(r);
  // ⭐⭐ Г2 (Р5): потолок — ОКНО самых глубоких, и запись узла указателя (`run.node`) из него не выпадает.
  return deepestFirst([...out.values()], (st) => st.id, RUN_NODES_MAX, run.currentNodeId);
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
 *
 * ⭐⭐ Г2 (Р5): переполнение — ВЫТЕСНЕНИЕМ самых мелких (`keep` — узел указателя комнаты, он не вытесняется никогда), а
 * не отказом новым: в бесконечном спуске отказ означал бы «глубокие узлы не записываются» — то есть фарм продолжением.
 */
export function foldRunRecords(into: Map<string, RunNodeState>, recs: Iterable<RunNodeState>, keep?: string): boolean {
  let changed = false;
  for (const r of recs) {
    const cur = into.get(r.id);
    if (!cur) {
      into.set(r.id, copyNodeState(r));
      changed = true;
      continue;
    }
    for (const k of ['chests', 'killed', 'levers'] as const) for (const id of r[k]) if (noteNodeId(cur[k], id)) changed = true;
  }
  if (into.size > RUN_NODES_MAX) {
    const live = new Set(deepestFirst([...into.keys()], (id) => id, RUN_NODES_MAX, keep));
    for (const id of [...into.keys()]) if (!live.has(id)) into.delete(id);
  }
  return changed;
}

/**
 * ⭐ R4-04: разложить записи забега по сейву копиями: запись узла указателя — в `node`, остальные — в `nodes` (по id, под
 * потолком). Так сейв помнит КАЖДЫЙ пройденный узел, а не только тот, где стоит.
 */
export function putRunRecords(run: RunState, records: Iterable<RunNodeState>): void {
  let cur: RunNodeState | undefined;
  let rest: RunNodeState[] = [];
  for (const r of records) {
    if (r.id === run.currentNodeId) cur = copyNodeState(r);
    else rest.push(copyNodeState(r));
  }
  // ⭐⭐ Г2 (Р5): лишнее — САМОЕ МЕЛКОЕ (вверх дороги нет), а не «что не влезло по порядку»: иначе глубокий забег писал бы
  // в сейв записи первых этажей и терял свежие. Запись узла указателя лежит отдельно (`run.node`) и под потолок не идёт.
  rest = deepestFirst(rest, (r) => r.id, RUN_NODES_MAX);
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
  else list.push(merged);
  // ⭐⭐ Г2 (Р5): переполнение вытесняет самую МЕЛКУЮ запись, а не отказывает этой (см. `deepestFirst`).
  run.nodes = deepestFirst(list, (r) => String((r as { id?: unknown } | null)?.id ?? ''), RUN_NODES_MAX, st.id);
}

/** Добавить номер в список записи (по возрастанию, без повторов, под потолком). `true` — список изменился. */
export function noteNodeId(list: number[], id: number): boolean {
  if (!Number.isSafeInteger(id) || id < 0 || list.includes(id) || list.length >= NODE_STATE_MAX) return false;
  let i = list.length;
  while (i > 0 && list[i - 1]! > id) i--;
  list.splice(i, 0, id);
  return true;
}

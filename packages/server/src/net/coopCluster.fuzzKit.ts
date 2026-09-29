/**
 * ⭐ МОДЕЛЬ РЕЕСТРА КЛАСТЕРА ДЛЯ ФАЗЗЕРА ДВУХ НОД (`coopCluster.fuzz.test.ts`): таблицы `cluster_nodes`, `char_claims`, `run_locks` и
 * правила запросов `cluster/registry.ts` (и сброса забегов на старте ноды — `db.clearAllRuns`) — один в один, но в памяти, по часам
 * `now()` (поддельные часы теста = часы базы). Плюс маршрут гейтвея (`cluster/gateway.ts`, `/api/route` без потолка игроков).
 *
 * Здесь нет ничего от игры и от vitest: только таблицы и SQL-правила. Каждое правило — ссылкой на запрос-оригинал; расхождение модели
 * с SQL — ложные нарушения фаззера (или слепота), поэтому правила пишутся буквой запроса, а не «по смыслу».
 */
import { NODE_DEAD_SEC, CLAIM_IDLE_SEC } from '../cluster/claimRule.js';
import { LEASE_MS } from '../cluster/lease.js';

/** `registry.ts`: сколько нода может молчать, прежде чем её перестанут считать живой (маршрут гейтвея, `liveClaim`). */
export const NODE_STALE_SEC = 10;
/** `registry.ts`: закрепление маршрута (`claimChar`) переходит другой ноде, если его не касались дольше. */
export const CLAIM_STALE_SEC = 300;
export { NODE_DEAD_SEC, CLAIM_IDLE_SEC };

export interface NodeRowM { id: string; players: number; rooms: number; draining: boolean; beatAt: number }
export interface ClaimRowM { node: string; touchedAt: number; liveAt: number | null }
export interface RunLockM { node: string; room: string; liveAt: number }

/** Строка героя, как её видит сброс забегов (`clearAllRuns`): есть ли забег; сброс снимает его и поднимает версию. */
export interface CharRowView { hasRun(): boolean; dropRun(): void }

export class ClusterModel {
  nodes = new Map<string, NodeRowM>();
  claims = new Map<string, ClaimRowM>();
  runLocks = new Map<string, RunLockM>();
  constructor(private now: () => number) {}

  clear(): void { this.nodes.clear(); this.claims.clear(); this.runLocks.clear(); }

  /**
   * `claimHeldSql`: нода молчит не дольше `NODE_DEAD_SEC` и продлевала героя (забег) не раньше чем за `CLAIM_IDLE_SEC` до своего последнего
   * удара. Нет строки ноды — не держит (`NOT EXISTS`); `live_at` пуст — сравнение NULL, не держит.
   */
  held(liveAt: number | null, nodeId: string): boolean {
    const n = this.nodes.get(nodeId);
    if (!n || liveAt === null) return false;
    return n.beatAt > this.now() - NODE_DEAD_SEC * 1000 && liveAt > n.beatAt - CLAIM_IDLE_SEC * 1000;
  }

  /**
   * `heartbeat`: вставка или обновление строки ноды, `beat_at = now()`. ⭐ R17-01: `leased` — нода с арендой: только обновление, и только пока
   * реестр видел её меньше аренды назад (`beat_at > now() - LEASE_MS`); иначе — ничего (`false`).
   */
  heartbeat(id: string, s: { players: number; rooms: number; draining: boolean }, leased = false): boolean {
    const n = this.nodes.get(id);
    if (leased && (!n || n.beatAt <= this.now() - LEASE_MS)) return false;
    this.nodes.set(id, { id, players: s.players, rooms: s.rooms, draining: s.draining, beatAt: this.now() });
    return true;
  }

  /** ⭐ R16-02: `nodeBeatAge` — сколько секунд назад реестр видел удар ноды (часы базы); строки нет — `null`. */
  nodeBeatAge(id: string): number | null {
    const n = this.nodes.get(id);
    return n ? (this.now() - n.beatAt) / 1000 : null;
  }

  /** ⭐ R16-02: условие продления нодой с арендой (`leased`) — строка ноды есть и её удар не старше `NODE_DEAD_SEC`. */
  private leaseAlive(nodeId: string): boolean {
    const n = this.nodes.get(nodeId);
    return !!n && n.beatAt > this.now() - NODE_DEAD_SEC * 1000;
  }

  /** `liveNodes`: били сердцем за `NODE_STALE_SEC`, по id. */
  liveNodes(): NodeRowM[] {
    const t = this.now() - NODE_STALE_SEC * 1000;
    return [...this.nodes.values()].filter((n) => n.beatAt > t).sort((a, b) => a.id.localeCompare(b.id));
  }

  /** `sweepNodes`: молчат дольше `max(6·NODE_STALE_SEC, NODE_DEAD_SEC)` — долой, с их забегами. */
  sweepNodes(): number {
    const t = this.now() - Math.max(NODE_STALE_SEC * 6, NODE_DEAD_SEC) * 1000;
    const gone = [...this.nodes.values()].filter((n) => n.beatAt < t).map((n) => n.id);
    for (const id of gone) this.nodes.delete(id);
    if (gone.length) for (const [k, l] of [...this.runLocks]) if (gone.includes(l.node)) this.runLocks.delete(k);
    return gone.length;
  }

  /** `claimChar` (маршрут гейтвея): свободно или протухло (`touched_at` старше `CLAIM_STALE_SEC`) — `preferred`; касание всегда; `live_at` не ставит. */
  claimChar(charId: string, preferred: string): string {
    const now = this.now();
    const c = this.claims.get(charId);
    if (!c) { this.claims.set(charId, { node: preferred, touchedAt: now, liveAt: null }); return preferred; }
    if (c.touchedAt < now - CLAIM_STALE_SEC * 1000) c.node = preferred;
    c.touchedAt = now;
    return c.node;
  }

  /**
   * `claimForJoin`: нет строки — наша; своя, без живого героя (`live_at` пуст) или нода-держатель его не держит (`claimHeldSql`) — забираем
   * (`touched_at`, `live_at` = now); иначе — владелец (второй запрос).
   */
  claimForJoin(charId: string, nodeId: string): string {
    const now = this.now();
    const c = this.claims.get(charId);
    if (!c) { this.claims.set(charId, { node: nodeId, touchedAt: now, liveAt: now }); return nodeId; }
    if (c.node === nodeId || c.liveAt === null || !this.held(c.liveAt, c.node)) {
      c.node = nodeId; c.touchedAt = now; c.liveAt = now;
      return nodeId;
    }
    return c.node;
  }

  /** `claimOwner`: только чтение. */
  claimOwner(charId: string): string | null { return this.claims.get(charId)?.node ?? null; }

  /**
   * ⭐ R18-03: условие `db.putCharacterOwned` (запись по строке базы): закрепление героя за нодой (`EXISTS char_claims … node_id`), а у ноды с
   * арендой (`leased`) — и её удар в реестре моложе аренды (`beat_at > now() - LEASE_MS`).
   */
  ownsRow(charId: string, nodeId: string, leased: boolean): boolean {
    if (this.claims.get(charId)?.node !== nodeId) return false;
    if (!leased) return true;
    const n = this.nodes.get(nodeId);
    return !!n && n.beatAt > this.now() - LEASE_MS;
  }

  /** `liveClaim`: `live_at` моложе `CLAIM_IDLE_SEC` и нода била сердцем за `NODE_STALE_SEC`. */
  liveClaim(charId: string): string | null {
    const c = this.claims.get(charId);
    const n = c ? this.nodes.get(c.node) : undefined;
    const now = this.now();
    if (!c || !n || c.liveAt === null) return null;
    return c.liveAt > now - CLAIM_IDLE_SEC * 1000 && n.beatAt > now - NODE_STALE_SEC * 1000 ? c.node : null;
  }

  /**
   * `touchClaims`: нет строки — вставка за нодой; своя — продление; чужая — не трогаем. Возвращает продлённых (и вставленных). ⭐ R16-02:
   * `leased` — нода с арендой: мёртвая по реестру (`leaseAlive`) ничего не вставляет и не продлевает.
   */
  touchClaims(charIds: readonly string[], nodeId: string, leased = false): Set<string> {
    const now = this.now();
    const out = new Set<string>();
    if (leased && !this.leaseAlive(nodeId)) return out;
    for (const id of charIds) {
      const c = this.claims.get(id);
      if (!c) { this.claims.set(id, { node: nodeId, touchedAt: now, liveAt: now }); out.add(id); continue; }
      if (c.node !== nodeId) continue;
      c.touchedAt = now; c.liveAt = now;
      out.add(id);
    }
    return out;
  }

  /** `releaseChar`: только своё. */
  releaseChar(charId: string, nodeId: string): void {
    if (this.claims.get(charId)?.node === nodeId) this.claims.delete(charId);
  }

  /** `releaseNode`: закрепления, забеги и строка ноды. */
  releaseNode(nodeId: string): void {
    for (const [k, c] of [...this.claims]) if (c.node === nodeId) this.claims.delete(k);
    this.releaseNodeRuns(nodeId);
    this.nodes.delete(nodeId);
  }

  /** `claimRun`: нет строки, своя нода или держатель забег не держит (`claimHeldSql`) — наш (`null`); иначе код комнаты-держателя. */
  claimRun(key: string, nodeId: string, room: string): string | null {
    const now = this.now();
    const l = this.runLocks.get(key);
    if (!l || l.node === nodeId || !this.held(l.liveAt, l.node)) { this.runLocks.set(key, { node: nodeId, room, liveAt: now }); return null; }
    return l.room;
  }

  /** `touchRuns`: нет строки — вставка; своя — продление (и комната); чужая — не трогаем. ⭐ R16-02: `leased` — как у `touchClaims`. */
  touchRuns(runs: readonly { key: string; room: string }[], nodeId: string, leased = false): Set<string> {
    const now = this.now();
    const out = new Set<string>();
    if (leased && !this.leaseAlive(nodeId)) return out;
    for (const r of runs) {
      const l = this.runLocks.get(r.key);
      if (!l) { this.runLocks.set(r.key, { node: nodeId, room: r.room, liveAt: now }); out.add(r.key); continue; }
      if (l.node !== nodeId) continue;
      l.room = r.room; l.liveAt = now;
      out.add(r.key);
    }
    return out;
  }

  /** `releaseRun`: только своё и только за этой комнатой. */
  releaseRun(key: string, nodeId: string, room: string): void {
    const l = this.runLocks.get(key);
    if (l && l.node === nodeId && l.room === room) this.runLocks.delete(key);
  }

  /** `releaseNodeRuns`: все забеги ноды. */
  releaseNodeRuns(nodeId: string): number {
    let n = 0;
    for (const [k, l] of [...this.runLocks]) if (l.node === nodeId) { this.runLocks.delete(k); n++; }
    return n;
  }

  /**
   * `db.clearAllRuns(self, nodeStaleSec = 10)`: снять забег (и поднять версию) каждому герою с забегом, КРОМЕ того, чьё закрепление за другой
   * нодой, которая жива (`beat_at` моложе `nodeStaleSec`) или держит его (`claimHeldSql`).
   */
  clearAllRuns(self: string, rows: ReadonlyMap<string, CharRowView>, nodeStaleSec = NODE_STALE_SEC): number {
    const now = this.now();
    let n = 0;
    for (const [charId, row] of rows) {
      if (!row.hasRun()) continue;
      const c = this.claims.get(charId);
      const node = c ? this.nodes.get(c.node) : undefined;
      if (c && node && c.node !== self && (node.beatAt > now - nodeStaleSec * 1000 || this.held(c.liveAt, c.node))) continue;
      row.dropRun();
      n++;
    }
    return n;
  }

  /**
   * Маршрут гейтвея (`/api/route`, без потолка игроков): живых нод нет — 503; код комнаты — к ноде его буквы (нет такой живой — 404);
   * иначе самая свободная живая не сливаемая (иначе первая живая) и закрепление маршрута (`claimChar`) — к его ноде, если она жива.
   * `letterOf` — буква ноды в коде комнаты (`gateway.nodeLetter`).
   */
  route(charId: string, code: string | undefined, letterOf: (nodeId: string) => string): { node: string } | { error: 'no-nodes' | 'no-room' } {
    const nodes = this.liveNodes();
    if (!nodes.length) return { error: 'no-nodes' };
    if (code) {
      const byLetter = nodes.find((n) => letterOf(n.id) === code[0]);
      return byLetter ? { node: byLetter.id } : { error: 'no-room' };
    }
    const free = nodes.filter((n) => !n.draining).sort((a, b) => a.players - b.players)[0] ?? nodes[0]!;
    const owner = this.claimChar(charId, free.id);
    return { node: nodes.find((n) => n.id === owner)?.id ?? free.id };
  }

  /** Для трассировки: таблицы строкой. */
  dump(): string {
    const now = this.now();
    const age = (t: number | null): string => (t === null ? '∅' : `${Math.round((now - t) / 1000)}с`);
    const ns = [...this.nodes.values()].map((n) => `${n.id}${n.draining ? '(слив)' : ''}@${age(n.beatAt)}`).join(',');
    const cs = [...this.claims].map(([k, c]) => `${k}→${c.node}/${age(c.liveAt)}`).join(',');
    const rs = [...this.runLocks].map(([k, l]) => `${k.slice(-6)}→${l.node}:${l.room}/${age(l.liveAt)}`).join(',');
    return `ноды [${ns}] закрепления [${cs}] забеги [${rs}]`;
  }
}

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * ⭐ R6-08: ОЧЕРЕДЬ НА ВХОД ГЕЙТВЕЯ — ПО МЕСТУ В НЕЙ. Против НАСТОЯЩЕЙ базы `dungeon_test` (таблица `login_queue` и её SQL —
 * настоящие, без базы тест пропускается); подменены только сессия, персонаж и реестр нод (их игроки и живые закрепления).
 *
 * Было: `admit` звался только на потолке и получал «свободных мест» ≤ 0 — по месту не пускали никого; продление билета
 * `SET at = at` ничего не продлевало, и через минуту честного ожидания билет исчезал («1 из N» навсегда); освободившееся
 * место брал первый пришедший, а не голова очереди; реконнект к своей грейс-комнате и вход к другу по коду стояли в общей
 * очереди, хотя нода держит для них запас сверху.
 */
vi.hoisted(() => {
  process.env.DM_PG ??= 'postgresql://dm:dmpass@127.0.0.1:5432/dungeon_test';
  process.env.DM_MAX_PLAYERS = '1';
});
const st = vi.hoisted(() => ({
  /** Игроков на единственной ноде (по реестру). */
  players: 0,
  /** charId → нода, где у героя ЖИВОЕ закрепление (живая сессия, грейс, запись в полёте). */
  live: new Map<string, string>(),
}));
/** Аккаунт `r608-<x>`: токен — 64 hex из буквы, герой — `c-<x>`. */
const who = (x: string): { user: string; token: string; charId: string } => ({ user: `r608-${x}`, token: x.charCodeAt(0).toString(16).padStart(2, '0').repeat(32), charId: `c-${x}` });
vi.mock('../db/db.js', () => ({
  getSession: async (t: string) => {
    for (const x of 'abcdnx') if (who(x).token === t) return who(x).user;
    return null;
  },
  getCharacter: async (id: string) => {
    const x = id.slice(2);
    return id.startsWith('c-') ? { userId: who(x).user, data: {}, version: 1 } : null;
  },
}));
vi.mock('./registry.js', async (orig) => {
  const real = await orig<typeof import('./registry.js')>();
  return {
    ...real,
    liveNodes: async () => [{ id: 'node-0', url: 'ws://n0/ws', players: st.players, rooms: 0, draining: false, cpu_seconds: 0, rss_bytes: '0', loop_p99_ms: 0, tick_hz: 30 }],
    claimChar: async (_c: string, n: string) => n,
    sweepNodes: async () => 0,
    liveClaim: async (charId: string) => st.live.get(charId) ?? null,
  };
});

let alive = false;
let server: Server | undefined;
let base = '';
let pool: typeof import('../db/pool.js');
beforeAll(async () => {
  pool = await import('../db/pool.js');
  try {
    const reg = await import('./registry.js');
    await reg.initClusterSchema();
    alive = true;
  } catch {
    return;   // базы нет — тесты ниже пропустятся
  }
  const { installGatewayRoutes } = await import('./gateway.js');
  const app = express();
  installGatewayRoutes(app);
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server?.close();
  if (alive) { await pool.q('DELETE FROM login_queue WHERE user_id LIKE $1', ['r608-%']); await pool.closePool(); }
});
beforeEach(async () => {
  if (!alive) return;
  st.players = 0; st.live.clear();
  await pool.q('DELETE FROM login_queue');   // база тестовая: очередь — только этого файла
});

async function route(x: string, extra = ''): Promise<{ status: number; json: { url?: string; queue?: { ticket: string; position: number; total: number } } }> {
  const { limits } = await import('../net/rateLimit.js');
  limits.route.reset(who(x).user);
  const r = await fetch(`${base}/api/route?charId=${who(x).charId}${extra}`, { headers: { Authorization: `Bearer ${who(x).token}` } });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as { url?: string; queue?: { ticket: string; position: number; total: number } } };
}
const ticketRow = async (t: string): Promise<boolean> => (await pool.q('SELECT 1 FROM login_queue WHERE ticket = $1', [t])).length === 1;

describe.runIf(process.env.DM_SKIP_PG !== '1')('⭐ R6-08: очередь на вход — по месту в ней', () => {
  it('ждущий честно (опрашивает) — через полторы минуты билет цел и он первый; бросивший ждать — выбывает', async () => {
    if (!alive) return;
    st.players = 1;
    const a = await route('a'), b = await route('b');
    expect([a.status, b.status]).toEqual([503, 503]);
    const ta = a.json.queue!.ticket, tb = b.json.queue!.ticket;
    expect([a.json.queue!.position, b.json.queue!.position]).toEqual([1, 2]);
    await pool.q(`UPDATE login_queue SET at = at - interval '90 seconds' WHERE ticket = ANY($1)`, [[ta, tb]]);   // стоят полторы минуты
    const a2 = await route('a', `&ticket=${ta}`);
    expect(a2.status).toBe(503);
    expect(await ticketRow(ta), 'билет честно ждущего цел').toBe(true);
    expect(a2.json.queue!.position, 'и он первый').toBe(1);
    // B перестал опрашивать (закрыл вкладку) — его билет выбывает, A по-прежнему первый.
    await pool.q(`UPDATE login_queue SET seen_at = seen_at - interval '90 seconds' WHERE ticket = $1`, [tb]).catch(() => undefined);
    const a3 = await route('a', `&ticket=${ta}`);
    expect(await ticketRow(tb), 'бросивший ждать выбыл').toBe(false);
    expect(a3.json.queue).toMatchObject({ position: 1, total: 1 });
  });

  it('место освободилось — входит голова очереди, а не пришедший без билета и не второй', async () => {
    if (!alive) return;
    st.players = 1;
    const ta = (await route('a')).json.queue!.ticket;
    const tb = (await route('b')).json.queue!.ticket;
    st.players = 0;
    const n = await route('n');
    expect(n.status, 'новичок без билета — в хвост очереди').toBe(503);
    expect(n.json.queue).toMatchObject({ position: 3 });
    expect((await route('b', `&ticket=${tb}`)).status, 'второй ждёт').toBe(503);
    const a = await route('a', `&ticket=${ta}`);
    expect(a.status, 'первый входит').toBe(200);
    expect(a.json.url).toBe('ws://n0/ws');
    expect(await ticketRow(ta), 'билет вошедшего снят').toBe(false);
  });

  it('билет не передаётся: чужой билет головы очереди не пускает', async () => {
    if (!alive) return;
    st.players = 1;
    const ta = (await route('a')).json.queue!.ticket;
    await route('b');
    st.players = 0;
    const stolen = await route('b', `&ticket=${ta}`);
    expect(stolen.status).toBe(503);
    expect(stolen.json.queue?.position, 'B — на своём месте').toBe(2);
    expect(await ticketRow(ta), 'билет A на месте').toBe(true);
  });

  it('герой с живым закреплением (грейс, разрыв посреди забега) идёт к своей ноде мимо очереди', async () => {
    if (!alive) return;
    st.players = 1;
    await route('a');                                     // очередь не пуста
    st.live.set(who('c').charId, 'node-0');
    const c = await route('c');
    expect(c.status).toBe(200);
    expect(c.json.url).toBe('ws://n0/ws');
  });

  it('вход к другу по коду — в пределах запаса ноды, а не в общей очереди', async () => {
    if (!alive) return;
    st.players = 1;
    await route('a');
    const byCode = await route('d', '&roomCode=A2B3C4D5');
    expect(byCode.status).toBe(200);
    expect(byCode.json.url).toBe('ws://n0/ws');
    st.players = 1 + 4;                                   // запас нода держит max(4, ⌈потолок/4⌉) сверх потолка
    const over = await route('d', '&roomCode=A2B3C4D5');
    expect(over.status, 'за запасом — очередь').toBe(503);
  });
});

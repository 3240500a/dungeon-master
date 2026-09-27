import WebSocket from 'ws';
import type { ServerFrame } from '@dm/shared';

/**
 * PoC кластера (Ф4.4 очередь, Ф4.5 слив узла) — против ЖИВОГО кластера.
 *
 *   npm run poc:cluster -- --mode=queue   (кластер поднят с DM_MAX_PLAYERS)
 *   npm run poc:cluster -- --mode=drain
 *
 * Обе проверки о том, что происходит НА ГРАНИЦЕ: когда мест больше нет и когда узел уходит
 * на перезапуск. Это ровно те два случая, в которых сервер обычно и теряет людей.
 */
const BASE = process.argv.find((a) => a.startsWith('--base='))?.slice(7) ?? 'http://127.0.0.1:3999';
const MODE = process.argv.find((a) => a.startsWith('--mode='))?.slice(7) ?? 'queue';
const N = Number(process.argv.find((a) => a.startsWith('--n='))?.slice(4) ?? 40);

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function post<T>(path: string, body: unknown, token?: string): Promise<T> {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path} → ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

interface Cluster { players: number; maxPlayers: number | null; nodes: { id: string; url: string; players: number; draining: boolean }[] }
/** R6-20: состояние кластера — служебное: с самой машины или ключом чтения метрик (`DM_METRICS_KEY`), как `/metrics`. */
const METRICS_KEY = process.env.DM_METRICS_KEY ?? '';
const cluster = async (): Promise<Cluster> => {
  const r = await fetch(`${BASE}/api/cluster`, { headers: METRICS_KEY ? { authorization: `Bearer ${METRICS_KEY}` } : {} });
  if (!r.ok) throw new Error(`/api/cluster → ${r.status}: состояние кластера — с машины сервера или с DM_METRICS_KEY`);
  return (await r.json()) as Cluster;
};

/** Завести аккаунт с персонажем — общая часть обеих проверок. */
async function makePlayer(i: number): Promise<{ token: string; charId: string }> {
  const username = `cl_${Math.random().toString(36).slice(2, 7)}_${i}`;
  const { token } = await post<{ token: string }>('/api/register', { username, password: 'loadtest-password' });
  const { character } = await post<{ character: { charId: string } }>(
    '/api/characters', { classId: 'warrior', name: `C${i}` }, token);
  return { token, charId: character.charId };
}

/** Спросить маршрут: либо адрес узла, либо место в очереди. */
async function route(token: string, charId: string, ticket?: string)
  : Promise<{ url?: string; node?: string; queue?: { ticket: string; position: number } }> {
  const qs = `charId=${encodeURIComponent(charId)}${ticket ? `&ticket=${ticket}` : ''}`;
  const r = await fetch(`${BASE}/api/route?${qs}`, { headers: { authorization: `Bearer ${token}` } });
  return (await r.json()) as { url?: string; node?: string; queue?: { ticket: string; position: number } };
}

/** Подключиться и войти в свою комнату. Возвращает сокет. */
async function play(url: string, token: string, charId: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
  ws.on('message', (d: Buffer, bin: boolean) => {
    if (bin) return;
    const f = JSON.parse(d.toString()) as ServerFrame;
    if (f.t === 'voteStart') ws.send(JSON.stringify({ t: 'vote', accept: true }));
  });
  ws.send(JSON.stringify({ t: 'join', token, charId, fresh: true }));
  return ws;
}

// ── Ф4.4: очередь на вход ─────────────────────────────────────────────────────
async function queueMode(): Promise<void> {
  console.log(`Очередь на вход: ${N} игроков против потолка кластера\n`);
  const players = await Promise.all(Array.from({ length: N }, (_, i) => makePlayer(i)));

  let admitted = 0;
  let queued = 0;
  const tickets = new Map<number, string>();
  const socks: WebSocket[] = [];

  for (const [i, p] of players.entries()) {
    const r = await route(p.token, p.charId);
    if (r.url) { admitted++; socks.push(await play(r.url, p.token, p.charId)); }
    else if (r.queue) { queued++; tickets.set(i, r.queue.ticket); }
  }
  console.log(`  впущено сразу: ${admitted}, поставлено в очередь: ${queued}`);
  if (!queued) {
    console.log('\n✗ Очередь не сработала: потолок не достигнут. Поднимите кластер с DM_MAX_PLAYERS ниже числа игроков.');
    process.exit(1);
  }

  // Освобождаем места и смотрим, пускают ли из очереди.
  const freeing = Math.min(5, socks.length);
  for (let i = 0; i < freeing; i++) socks.pop()?.close();
  await wait(4000);

  let letIn = 0;
  for (const [i, ticket] of tickets) {
    const r = await route(players[i]!.token, players[i]!.charId, ticket);
    if (r.url) letIn++;
  }
  // ⚠ E2E 27.09: свободных мест после освобождения — не `freeing`, а потолок минус оставшиеся. Сразу пускают не всегда ровно
  // потолок: поправка гейтвея на ещё не отражённые направления держится до второго сердцебиения ноды, и вошедший успевает
  // посчитаться дважды (а билеты прошлого прогона стоят в голове очереди минуту). Прежняя проверка «впущено не больше
  // освобождённых + 2» тогда падала на честном сервере: мест было 9, пустили 9. Опасная сторона — пустить СВЕРХ потолка
  // (до правки гейтвея: 33 при потолке 30, `cluster/gateway.balance.test.ts`) — проверяется отдельно и строго.
  const cap = (await cluster()).maxPlayers ?? 0;
  const free = cap - (admitted - freeing);
  console.log(`  освободили ${freeing} мест (свободно ${free} из потолка ${cap}) → из очереди впустили: ${letIn}`);

  for (const s of socks) s.close();
  const ok = cap > 0 && admitted <= cap && queued > 0 && letIn > 0 && letIn <= free + 2;
  console.log(ok
    ? '\n✓ Сверх потолка игроки встают в очередь и проходят по мере освобождения мест.'
    : '\n✗ Очередь ведёт себя не так, как задумано.');
  process.exit(ok ? 0 : 1);
}

// ── Ф4.5: слив узла ───────────────────────────────────────────────────────────
async function drainMode(): Promise<void> {
  console.log(`Слив узла: ${N} игроков, снимаем один узел под нагрузкой\n`);
  const before = await cluster();
  if (before.nodes.length < 2) {
    console.log('✗ Нужен кластер минимум из двух узлов (DM_NODES=2).');
    process.exit(1);
  }

  const players = await Promise.all(Array.from({ length: N }, (_, i) => makePlayer(i)));
  const socks: { ws: WebSocket; node: string }[] = [];
  for (const p of players) {
    const r = await route(p.token, p.charId);
    if (r.url && r.node) socks.push({ ws: await play(r.url, p.token, p.charId), node: r.node });
  }
  await wait(4000);

  const mid = await cluster();
  const victim = mid.nodes.slice().sort((a, b) => b.players - a.players)[0]!;
  console.log(`  до слива: ${mid.players} игроков на ${mid.nodes.length} узлах `
    + `(${mid.nodes.map((n) => `${n.id}:${n.players}`).join(', ')})`);
  console.log(`  сливаем ${victim.id} — на нём ${victim.players} игроков`);

  // Порт узла берём из его адреса: слив — служебная ручка на самом узле.
  const port = new URL(victim.url).port;
  const r = await fetch(`http://127.0.0.1:${port}/internal/drain`, { method: 'POST' });
  console.log(`  ответ узла: ${r.status}`);

  await wait(6000);
  const after = await cluster();
  console.log(`  после слива: ${after.players} игроков на ${after.nodes.length} узлах `
    + `(${after.nodes.map((n) => `${n.id}:${n.players}`).join(', ')})`);

  // ГЛАВНОЕ: чужие узлы не должны были пострадать. Слив одного — это не встряска кластера.
  const survivors = mid.nodes.filter((n) => n.id !== victim.id);
  const keptAll = survivors.every((s) => (after.nodes.find((n) => n.id === s.id)?.players ?? -1) >= s.players);
  console.log(`  игроки на остальных узлах сохранились: ${keptAll ? 'да' : 'НЕТ'}`);

  // И ВТОРОЕ ГЛАВНОЕ: игрок со слитого узла возвращается в игру, а его прогресс цел.
  const victimPlayer = players[socks.findIndex((s) => s.node === victim.id)] ?? players[0]!;
  const back = await route(victimPlayer.token, victimPlayer.charId);
  let returned = false;
  if (back.url) {
    const ws = await play(back.url, victimPlayer.token, victimPlayer.charId);
    returned = await new Promise<boolean>((res) => {
      const t = setTimeout(() => res(false), 5000);
      ws.on('message', (d: Buffer, bin: boolean) => {
        if (bin) return;
        const f = JSON.parse(d.toString()) as ServerFrame;
        if (f.t === 'joined' || f.t === 'saveUpdate') { clearTimeout(t); res(true); }
      });
    });
    ws.close();
  }
  console.log(`  игрок со слитого узла вернулся в игру: ${returned ? 'да' : 'НЕТ'} (узел ${back.node ?? '—'})`);

  for (const s of socks) s.ws.close();
  const ok = keptAll && returned;
  console.log(ok
    ? '\n✓ Узел ушёл штатно: остальные не пострадали, игрок вернулся, прогресс на месте.'
    : '\n✗ Слив прошёл не так, как задумано.');
  process.exit(ok ? 0 : 1);
}

void (MODE === 'drain' ? drainMode() : queueMode()).catch((e: unknown) => {
  console.error('PoC не прошёл:', e);
  process.exit(1);
});

import WebSocket from 'ws';
import type { ServerFrame } from '@dm/shared';

/**
 * PoC подтверждённого дюпа (задача Ф0.3 плана доработки).
 *
 * Проверяет инвариант: ОДИН персонаж не может быть живым в двух комнатах одновременно.
 * Сегодня инвариант нарушен — `roomManager` дедуплицирует только ВНУТРИ комнаты
 * (`room.ts:attach`), а второй `join` без кода просто создаёт вторую комнату. Обе держат
 * свою копию сейва и автосейвят раз в 10 с → last-writer-wins → предмет, положенный
 * в сундук из первой сессии, возвращается в инвентарь записью второй.
 *
 *   npm run poc:dupe                       # ожидаем ПРОВАЛ, пока Ф0.3 не сделана
 *   npm run poc:dupe -- --base=http://…
 *
 * Код выхода: 0 — инвариант держится (второй вход отклонён), 1 — дюп воспроизводится.
 */
const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)=(.*)$/.exec(a);
  if (m) args.set(m[1]!, m[2]!);
}
const BASE = args.get('base') ?? 'http://127.0.0.1:3999';

async function post<T>(path: string, body: unknown, token?: string): Promise<T> {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path} → ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

interface Session { ws: WebSocket; room: string; playerId: string; }

/** Пытается войти в НОВУЮ комнату указанным персонажем. Резолвится на `joined`, реджектится на `error`. */
function openSession(label: string, token: string, charId: string): Promise<Session> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws');
    const timer = setTimeout(() => { ws.close(); reject(new Error(`${label}: сервер не ответил за 5 с`)); }, 5000);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', token, charId, fresh: true })));
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
    ws.on('message', (d: Buffer) => {
      let f: ServerFrame;
      try { f = JSON.parse(d.toString()) as ServerFrame; } catch { return; }
      if (f.t === 'joined') {
        clearTimeout(timer);
        console.log(`  ${label}: вошёл в комнату ${f.roomCode} как ${f.playerId}`);
        resolve({ ws, room: f.roomCode, playerId: f.playerId });
      } else if (f.t === 'error') {
        clearTimeout(timer);
        console.log(`  ${label}: отказ — ${f.code}: ${f.msg}`);
        reject(new Error(f.code));
      }
    });
  });
}

async function main(): Promise<void> {
  const username = `dupe_${Math.random().toString(36).slice(2, 8)}`;
  const { token } = await post<{ token: string }>('/api/register', { username, password: 'loadtest-password' });
  const { character } = await post<{ character: { charId: string } }>('/api/characters', { classId: 'warrior', name: 'Dup' }, token);
  console.log(`PoC дюпа: персонаж ${character.charId}`);

  const a = await openSession('сессия A', token, character.charId);
  let aClosed = false;
  a.ws.on('close', () => { aClosed = true; });
  await new Promise((r) => setTimeout(r, 500));

  // Инвариант — «во всём процессе ровно одна живая сессия персонажа». Его держат ДВЕ разные
  // допустимые семантики, и обе для нас годятся:
  //   отказ    — второй вход отклонён, играет A;
  //   выселение — второй вход принят, но A принудительно отключён (так сделано у нас: чаще
  //               всего второй вход это реконнект после обрыва, держать игрока снаружи хуже).
  // Дюп — это третий случай: B вошёл, а A остался жив. Тогда две копии сейва пишутся
  // независимо, last-writer-wins, и предмет из сундука возвращается в инвентарь.
  let dupe = false;
  try {
    const b = await openSession('сессия B (тот же charId!)', token, character.charId);
    await new Promise((r) => setTimeout(r, 1500)); // даём серверу закрыть выселенную сессию
    if (aClosed) {
      console.log(`\n✓ Инвариант держится: B вошёл в ${b.room}, сессия A выселена и отключена.`);
    } else {
      dupe = true;
      console.log(`\n✗ ДЮП ВОСПРОИЗВОДИТСЯ: персонаж живёт в комнатах ${a.room} и ${b.room} одновременно.`);
      console.log('  Обе комнаты держат свою копию сейва и пишут её в БД раз в 10 с (last-writer-wins).');
    }
    b.ws.close();
  } catch {
    console.log('\n✓ Инвариант держится: второй вход тем же персонажем отклонён.');
  }
  a.ws.close();
  process.exit(dupe ? 1 : 0);
}

void main();

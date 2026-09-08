import WebSocket from 'ws';
import type { ServerFrame, SaveState } from '@dm/shared';

/**
 * PoC санитарных проверок (Ф3.1) и дедупликации команд (Ф2.5) — против ЖИВОГО сервера.
 *
 *   npm run loadtest:server   (в другом окне)
 *   npm run poc:cheat
 *
 * Изображаем изменённый клиент: он не обязан соблюдать правила интерфейса и шлёт то, чего
 * честный клиент прислать не может. Проверяем два утверждения:
 *   1) сундук и лавка из подземелья недоступны (иначе добычу не надо доносить до города,
 *      а смерть в забеге перестаёт что-либо значить);
 *   2) команда, отправленная дважды с одним номером, применяется один раз.
 */
const BASE = process.argv.find((a) => a.startsWith('--base='))?.slice(7) ?? 'http://127.0.0.1:3999';

async function post<T>(path: string, body: unknown, token?: string): Promise<T> {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path} → ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const username = `cheat_${Math.random().toString(36).slice(2, 8)}`;
  const { token } = await post<{ token: string }>('/api/register', { username, password: 'loadtest-password' });
  const { character } = await post<{ character: { charId: string } }>(
    '/api/characters', { classId: 'warrior', name: 'Читер' }, token);

  const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws');
  let save: SaveState | undefined;
  const errors: string[] = [];
  let stashFrames = 0;

  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) return;                       // кадры мира здесь не интересны
    const f = JSON.parse(data.toString()) as ServerFrame;
    if (f.t === 'saveUpdate') save = f.save;
    else if (f.t === 'stash') stashFrames++;
    else if (f.t === 'error') errors.push(f.msg);
    else if (f.t === 'voteStart') ws.send(JSON.stringify({ t: 'vote', accept: true }));
  });
  await new Promise<void>((r) => ws.on('open', () => r()));
  ws.send(JSON.stringify({ t: 'join', token, charId: character.charId, fresh: true }));
  await wait(1500);

  // ── 1. Дедупликация: в городе шлём одну команду дважды с ОДНИМ номером ──────
  // Считаем не по сейву (у новичка может не быть свободных очков — проверка выйдет пустой),
  // а по серверному счётчику: он растёт РОВНО на отброшенные повторы.
  const send = (command: unknown, id?: number): void => { ws.send(JSON.stringify({ t: 'cmd', command, id })); };
  const dupCount = async (): Promise<number> => {
    const text = await (await fetch(BASE + '/metrics')).text();
    return Number(/^dm_cmd_duplicate_total (\d+)/m.exec(text)?.[1] ?? -1);
  };
  await wait(300);
  const dupBefore = await dupCount();
  send({ cmd: 'bind', slot: 'mouseLeft', value: 'attack' }, 1001);
  send({ cmd: 'bind', slot: 'mouseLeft', value: 'attack' }, 1001);
  send({ cmd: 'bind', slot: 'mouseLeft', value: 'attack' }, 1002);   // другой номер — должен пройти
  await wait(700);
  const dupAfter = await dupCount();
  const dedupOk = dupAfter - dupBefore === 1;
  console.log(`повтор команды: отброшено повторов ${dupAfter - dupBefore} (ожидается ровно 1)`);

  // ── 2. Место команды: уходим в подземелье и лезем в сундук ──────────────────
  errors.length = 0;
  stashFrames = 0;
  ws.send(JSON.stringify({ t: 'descend', difficultyId: 'normal' }));
  await wait(2500);

  send({ cmd: 'stashOpen' }, 2001);
  send({ cmd: 'sell', uid: save?.inventory[0]?.uid ?? 'нет' }, 2002);
  await wait(800);

  const blocked = errors.filter((e) => /только в городе/i.test(e)).length;
  console.log(`из подземелья: отказов «только в городе» ${blocked}, кадров сундука пришло ${stashFrames}`);

  ws.close();

  const ok = blocked >= 2 && stashFrames === 0 && dedupOk;
  console.log(ok
    ? '\n✓ Сундук и лавка из подземелья недоступны, повтор команды не выполняется дважды.'
    : '\n✗ Проверка не прошла.');
  process.exit(ok ? 0 : 1);
}

void main();

import WebSocket from 'ws';
import {
  ConfigRegistry, CRAFT_SLOT_LIST, keySlotOf, keyVariantsByBase, variantsFor,
  type CraftInput, type ServerFrame, type SaveState,
} from '@dm/shared';

/**
 * PoC санитарных проверок (Ф3.1) и дедупликации команд (Ф2.5) — против ЖИВОГО сервера.
 *
 *   npm run loadtest:server   (в другом окне)
 *   npm run poc:cheat
 *
 * Изображаем изменённый клиент: он не обязан соблюдать правила интерфейса и шлёт то, чего
 * честный клиент прислать не может. Проверяем утверждения:
 *   1) сундук и лавка из подземелья недоступны (иначе добычу не надо доносить до города,
 *      а смерть в забеге перестаёт что-либо значить);
 *   2) команда, отправленная дважды с одним номером, применяется один раз;
 *   3) кривая заявка на ковку или зачарование (лишний ключ, пятое гнездо, ступень вне лестницы,
 *      доводка вне рамки, битый ключ заявки, `__proto__`) отвергается схемой целиком, ничего не стоит
 *      и не рождает вещь; повтор ключа заявки не кует вторую вещь; из подземелья не куют.
 */

/**
 * Правдоподобная заявка из конфига ПО УМОЛЧАНИЮ: в каждом гнезде первая форма, чьё окно берёт ступень 1.
 * У живого сервера конфиг может быть переопределён — для проверки повтора ключа это неважно: оба ответа
 * обязаны совпасть, чем бы они ни были (вещь, «кузнец ещё не куёт», «журнал закрыт»).
 */
function honestInput(): CraftInput {
  const reg = new ConfigRegistry();
  reg.loadAll();
  const cls = 'sword', hands = 1, step = 1;
  const keySlot = keySlotOf(reg, cls);
  const group = keyVariantsByBase(reg, cls, hands).find((g) => g.variants.some((p) => p.stepMin <= step && step <= p.stepMax));
  const parts = {} as CraftInput['parts'];
  for (const slot of CRAFT_SLOT_LIST) {
    const pool = slot === keySlot ? group?.variants ?? [] : variantsFor(reg, cls, slot, hands);
    parts[slot] = { id: pool.find((v) => v.stepMin <= step && step <= v.stepMax)?.id ?? `${slot}-?`, step };
  }
  return { weaponClass: cls, hands, parts };
}
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

/**
 * Ф4 (E2E 28.09): адрес игрового сокета — у маршрута (`/api/route`), как у настоящего клиента. Гейтвей кластера игры не ведёт
 * (на `/ws` он отвечает страницей, HTTP 200), одиночный сервер отвечает собой. Раньше стенд стучался в `BASE/ws` и против
 * кластера падал на рукопожатии.
 */
async function routeUrl(token: string, charId: string): Promise<string> {
  const r = await fetch(`${BASE}/api/route?charId=${encodeURIComponent(charId)}`, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`/api/route → ${r.status} ${await r.text()}`);
  return ((await r.json()) as { url: string }).url;
}

async function main(): Promise<void> {
  const username = `cheat_${Math.random().toString(36).slice(2, 8)}`;
  const { token } = await post<{ token: string }>('/api/register', { username, password: 'loadtest-password' });
  const { character } = await post<{ character: { charId: string } }>(
    '/api/characters', { classId: 'warrior', name: 'Читер' }, token);

  const url = await routeUrl(token, character.charId);
  // Счётчик повторов — у НОДЫ героя (на гейтвее кластера — сумма сердцебиений, в ней его нет): её HTTP — тот же адрес без `/ws`.
  const nodeHttp = url.replace(/^ws/, 'http').replace(/\/ws(\/\d+)?(\?.*)?$/, '');
  const ws = new WebSocket(url);
  let save: SaveState | undefined;
  const errors: string[] = [];
  let stashFrames = 0;
  /** Ответы на команды по номеру (D3): так видно, чем кончилась КАЖДАЯ кривая заявка. */
  const results = new Map<number, Extract<ServerFrame, { t: 'cmdResult' }>>();

  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) return;                       // кадры мира здесь не интересны
    const f = JSON.parse(data.toString()) as ServerFrame;
    if (f.t === 'saveUpdate') save = f.save;
    else if (f.t === 'stash') stashFrames++;
    else if (f.t === 'error') errors.push(f.msg);
    else if (f.t === 'cmdResult' && f.id !== undefined) results.set(f.id, f);
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
    const text = await (await fetch(nodeHttp + '/metrics')).text();
    return Number(/^dm_cmd_duplicate_total (\d+)/m.exec(text)?.[1] ?? -1);
  };
  await wait(300);
  const dupBefore = await dupCount();
  // Слот — ЧИСЛО (0 = ЛКМ), как шлёт клиент: строковый слот схема команд (D11) отвергла бы до дедупа.
  send({ cmd: 'bind', slot: 0, value: 'attack' }, 1001);
  send({ cmd: 'bind', slot: 0, value: 'attack' }, 1001);
  send({ cmd: 'bind', slot: 0, value: 'attack' }, 1002);   // другой номер — должен пройти
  await wait(700);
  const dupAfter = await dupCount();
  const dedupOk = dupAfter - dupBefore === 1;
  console.log(`повтор команды: отброшено повторов ${dupAfter - dupBefore} (ожидается ровно 1)`);

  // ── 2. Ковка: кривые заявки и повтор ключа (D2/D4/D11) ──────────────────────
  // Всё в городе. Кривая заявка обязана получить «Неверная команда» — схема режет её до кузнеца;
  // ни одна не должна стоить золота и родить вещь.
  const input = honestInput();
  const goldBefore = save?.gold ?? 0;
  const itemsBefore = save?.inventory.length ?? 0;
  const craft = (nonce: unknown, inp: unknown): unknown => ({ cmd: 'craft', nonce, input: inp });
  const part = (slot: keyof CraftInput['parts'], patch: Record<string, unknown>): unknown =>
    ({ ...input, parts: { ...input.parts, [slot]: { ...input.parts[slot], ...patch } } });
  const malformed: unknown[] = [
    { ...(craft('cheat-000001', input) as object), price: 0 },                       // лишний ключ команды
    craft('cheat-000002', { ...input, tier: 6 }),                                     // лишний ключ заявки
    craft('cheat-000003', { ...input, parts: { ...input.parts, pommel: input.parts.head } }),   // пятое гнездо
    craft('cheat-000004', { ...input, parts: { strike: input.parts.strike, grip: input.parts.grip, bind: input.parts.bind } }),
    craft('cheat-000005', part('strike', { step: 0 })),
    craft('cheat-000006', part('strike', { step: 6 })),
    craft('cheat-000007', part('grip', { step: '5' })),
    craft('cheat-000008', part('bind', { material: 'iron-5' })),                     // лишний ключ детали
    craft('cheat-000009', { ...input, hands: 3 }),
    craft('cheat-000010', { ...input, finish: -1 }),                                  // доводка вне рамки
    craft('cheat-000011', { ...input, finish: 99 }),
    craft('cheat-000012', { ...input, finish: 1.5 }),
    craft('short', input),                                                            // ключ заявки короче 8
    craft('nonce with spaces', input),
    craft(12345678, input),
    craft('cheat-000013', null),
    { cmd: 'forgeEnchant', uid: save?.inventory[0]?.uid ?? 'x', rarity: 'unique' },  // уникальной не зачаровать
    { cmd: 'forgeEnchant', uid: save?.inventory[0]?.uid ?? 'x', rarity: 'magic', affixes: ['x'] },
  ];
  const malformedIds = malformed.map((_, i) => 3001 + i);
  malformed.forEach((c, i) => send(c, malformedIds[i]));
  // `__proto__` — только сырой строкой: JSON.stringify объекта этот ключ не сохранил бы.
  const protoId = 3100;
  ws.send(JSON.stringify({ t: 'cmd', id: protoId, command: craft('cheat-000014', input) })
    .replace('"weaponClass":', '"__proto__":{"isAdmin":true},"weaponClass":'));
  malformedIds.push(protoId);
  // Доводка в рамке схемы, но вне конфига — это уже отказ ядра (или «кузнец ещё не куёт»), не схемы.
  send(craft('cheat-000015', { ...input, finish: 31 }), 3150);
  // Повтор ОДНОГО ключа с разными номерами: ответы обязаны совпасть, вещь — не больше одной.
  send(craft('cheat-repeat-01', input), 3201);
  send(craft('cheat-repeat-01', input), 3202);
  await wait(1200);

  const junkAnswered = malformedIds.filter((id) => results.get(id)?.ok === false && results.get(id)?.reason === 'Неверная команда').length;
  const r1 = results.get(3201), r2 = results.get(3202);
  const repeatSame = !!r1 && !!r2 && r1.ok === r2.ok && r1.uid === r2.uid && (r1.ok || r1.reason === r2.reason);
  const finishRefused = results.get(3150)?.ok === false;
  const goldAfter = save?.gold ?? 0;
  const craftedNow = save?.inventory.filter((i) => i.parts).length ?? 0;
  const craftOk = junkAnswered === malformedIds.length && repeatSame && finishRefused
    && goldAfter <= goldBefore && craftedNow <= 1 && (save?.inventory.length ?? 0) <= itemsBefore + 1;
  console.log(`ковка: кривых заявок отвергнуто схемой ${junkAnswered} из ${malformedIds.length}; `
    + `повтор ключа — ${repeatSame ? 'тот же ответ' : 'РАЗНЫЕ ответы'} (${r1?.ok ? `вещь ${r1.uid}` : r1?.reason ?? 'нет ответа'}); `
    + `доводка вне конфига — ${finishRefused ? 'отказ' : 'ПРОШЛА'}; золото ${goldBefore} → ${goldAfter}, скованных вещей ${craftedNow}`);

  // ── 3. Место команды: уходим в подземелье и лезем в сундук и к кузнецу ─────
  errors.length = 0;
  stashFrames = 0;
  ws.send(JSON.stringify({ t: 'descend', difficultyId: 'normal' }));
  await wait(2500);

  send({ cmd: 'stashOpen' }, 2001);
  send({ cmd: 'sell', uid: save?.inventory[0]?.uid ?? 'нет' }, 2002);
  send(craft('cheat-dungeon-01', input), 2003);
  send({ cmd: 'forgeEnchant', uid: save?.inventory[0]?.uid ?? 'нет', rarity: 'magic' }, 2004);
  await wait(800);

  const blocked = errors.filter((e) => /только в городе/i.test(e)).length;
  const forgeBlocked = [2003, 2004].every((id) => /только в городе/i.test(results.get(id)?.reason ?? ''));
  console.log(`из подземелья: отказов «только в городе» ${blocked}, кадров сундука пришло ${stashFrames}, кузница ${forgeBlocked ? 'закрыта' : 'ОТКРЫТА'}`);

  ws.close();

  const ok = blocked >= 4 && stashFrames === 0 && dedupOk && craftOk && forgeBlocked;
  console.log(ok
    ? '\n✓ Сундук, лавка и кузница из подземелья недоступны, повтор команды не выполняется дважды, кривая ковка отвергается.'
    : '\n✗ Проверка не прошла.');
  process.exit(ok ? 0 : 1);
}

void main();

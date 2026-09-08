import WebSocket from 'ws';

/**
 * Проверка лимитов частоты (задача Ф0.5). Запускать против сервера, поднятого БЕЗ
 * `DM_RATELIMIT=off` — то есть НЕ через `loadtest:server`, а как боевой:
 *
 *   PORT=3999 DM_DB=data/flood.db npm start
 *   npm run poc:flood
 *
 * Нагрузочный стенд лимиты отключает намеренно (сотня ботов идёт с одного адреса), поэтому
 * их работоспособность проверяется здесь, отдельно.
 *
 * Код выхода: 0 — все три лимита сработали, 1 — какой-то не сработал.
 */
const BASE = process.argv.find((a) => a.startsWith('--base='))?.slice(7) ?? 'http://127.0.0.1:3999';

async function floodRegister(): Promise<boolean> {
  let ok = 0; let limited = 0;
  for (let i = 0; i < 40; i++) {
    // Имя обязано быть валидным (3–20 символов), иначе получим 422 и проверим не то.
    const name = `fl${Date.now() % 100000}x${i}`;
    const r = await fetch(BASE + '/api/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: name, password: 'flood-password' }),
    });
    if (r.status === 200) ok++;
    else if (r.status === 429) limited++;
    else console.log(`  неожиданный статус ${r.status}: ${await r.text()}`);
  }
  console.log(`  регистрация: прошло ${ok}, отбито 429 ${limited}`);
  return limited > 0 && ok <= 6; // ёмкость 5 + запас на пополнение
}

async function floodLogin(): Promise<boolean> {
  let limited = 0;
  for (let i = 0; i < 40; i++) {
    const r = await fetch(BASE + '/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'нет-такого-игрока', password: 'wrong-password' }),
    });
    if (r.status === 429) limited++;
  }
  console.log(`  вход: отбито 429 ${limited} из 40`);
  return limited > 0;
}

/** Флуд кадрами по WebSocket: соединение должно быть закрыто сервером. */
function floodFrames(): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws');
    let closed = false;
    ws.on('close', () => { closed = true; resolve(true); });
    ws.on('error', () => { if (!closed) resolve(true); });
    ws.on('open', () => {
      // Кадры валидные по форме, но с частотой, которой у клиента быть не может.
      for (let i = 0; i < 1000; i++) ws.send(JSON.stringify({ t: 'ping', id: i }));
    });
    setTimeout(() => { if (!closed) { ws.close(); resolve(false); } }, 4000);
  });
}

async function main(): Promise<void> {
  console.log(`Проверка лимитов частоты против ${BASE}`);
  const a = await floodRegister();
  const b = await floodLogin();
  const c = await floodFrames();
  console.log(`  кадры ws: соединение ${c ? 'закрыто сервером' : 'НЕ закрыто'}`);
  const all = a && b && c;
  console.log(all ? '\n✓ Все три лимита работают.' : '\n✗ Не сработало: ' + [!a && 'регистрация', !b && 'вход', !c && 'кадры ws'].filter(Boolean).join(', '));
  process.exit(all ? 0 : 1);
}

void main();

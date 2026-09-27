import WebSocket from 'ws';

/**
 * Проверка лимитов частоты (задача Ф0.5). Запускать против сервера, поднятого БЕЗ
 * `DM_RATELIMIT=off` — то есть НЕ через `loadtest:server`, а как боевой:
 *
 *   PORT=3999 DM_PG=postgresql://dm:dmpass@127.0.0.1:5432/dungeon_test NODE_ENV=production DM_MAX_ACCOUNTS_PER_IP=1000000 npx tsx packages/server/src/index.ts
 *   npm run poc:flood
 *
 * `DM_MAX_ACCOUNTS_PER_IP` поднят, чтобы регистрацию отбивал ЛИМИТ ЧАСТОТЫ, а не суточный потолок аккаунтов с адреса
 * (Ф3.5): стенд за день заводит их сотнями, и без этого «регистрация отбита» проверяла бы не то.
 *
 * Нагрузочный стенд лимиты отключает намеренно (сотня ботов идёт с одного адреса), поэтому
 * их работоспособность проверяется здесь, отдельно.
 *
 * Код выхода: 0 — все лимиты сработали, 1 — какой-то не сработал.
 */
const BASE = process.argv.find((a) => a.startsWith('--base='))?.slice(7) ?? 'http://127.0.0.1:3999';

async function floodRegister(): Promise<{ ok: boolean; name?: string }> {
  let ok = 0; let limited = 0; let first: string | undefined;
  for (let i = 0; i < 40; i++) {
    // Имя обязано быть валидным (3–20 символов), иначе получим 422 и проверим не то.
    const name = `fl${Date.now() % 100000}x${i}`;
    const r = await fetch(BASE + '/api/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: name, password: 'flood-password' }),
    });
    if (r.status === 200) { ok++; first ??= name; }
    else if (r.status === 429) limited++;
    else console.log(`  неожиданный статус ${r.status}: ${await r.text()}`);
  }
  console.log(`  регистрация: прошло ${ok}, отбито 429 ${limited}`);
  return { ok: limited > 0 && ok <= 6, name: first }; // ёмкость 5 + запас на пополнение
}

async function login(username: string, password: string): Promise<number> {
  const r = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return r.status;
}

/**
 * Поток входов с НЕСУЩЕСТВУЮЩИМ ником. ⭐ R7-13/R8-05: он не стоит scrypt и бакет входа не платит (иначе тролль за общим NAT
 * запирал вход соседям), а держит его свой широкий бакет поиска ника (`loginLookup`: 60 подряд, дальше 10 в секунду). Поэтому
 * запросов больше его ёмкости: прежние 40 проходили все, и проверка падала на правильном сервере (E2E 27.09).
 */
async function floodLookup(): Promise<boolean> {
  let limited = 0;
  for (let i = 0; i < 100; i++) if ((await login('нет-такого-игрока', 'wrong-password')) === 429) limited++;
  console.log(`  поиск ника: отбито 429 ${limited} из 100`);
  return limited > 0;
}

/** Перебор ПАРОЛЯ существующего героя: бакет входа (10 подряд) и бакет ника (R3-07) обязаны закрыть его быстро. */
async function floodPassword(name: string | undefined): Promise<boolean> {
  if (!name) { console.log('  перебор пароля: не на ком — ни одна регистрация не прошла'); return false; }
  // Бакет поиска ника после `floodLookup` пуст — пусть наберёт запас (10 в секунду), иначе отбивал бы он, а не бакет входа.
  await new Promise((r) => setTimeout(r, 3000));
  let firstLimited = 0;
  for (let i = 1; i <= 20 && !firstLimited; i++) if ((await login(name, 'wrong-password')) === 429) firstLimited = i;
  console.log(`  перебор пароля: ${firstLimited ? `отбит с ${firstLimited}-й попытки` : 'НЕ отбит за 20 попыток'}`);
  return firstLimited > 0 && firstLimited <= 12;
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
  const reg = await floodRegister();
  const a = reg.ok;
  const b = await floodLookup();
  const p = await floodPassword(reg.name);
  const c = await floodFrames();
  console.log(`  кадры ws: соединение ${c ? 'закрыто сервером' : 'НЕ закрыто'}`);
  const all = a && b && p && c;
  console.log(all ? '\n✓ Все лимиты работают.'
    : '\n✗ Не сработало: ' + [!a && 'регистрация', !b && 'поиск ника', !p && 'перебор пароля', !c && 'кадры ws'].filter(Boolean).join(', '));
  process.exit(all ? 0 : 1);
}

void main();

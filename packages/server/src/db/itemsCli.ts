import type { SaveState } from '@dm/shared';
import { isUuid } from '@dm/shared';
import { q, q1, closePool } from './pool.js';
import { itemsOfSave, itemsOfStash, locOfChar, revokeItem, LOC_REVOKED } from './items.js';

/**
 * Инструменты по предметам (Ф2). Ради них всё и затевалось: без журнала происхождения на
 * вопрос «откуда у него это» ответить нечем, а отзыв дюпнутой вещи превращается в откат всей
 * базы на сутки назад.
 *
 *   npm run items:audit                     — сверка леджера с сейвами + поиск странного
 *   npm run items:history -- --id=<uuid>    — вся жизнь одной вещи
 *   npm run items:revoke -- --id=<uuid> --reason="дюп через сундук"
 *
 * Отзыв работает и по живому серверу: вещь помечается отозванной, и попытка вернуть её в
 * сейв отклоняется проверкой в `syncItems` — автосейв игрока не воскресит её обратно.
 */
const arg = (k: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);

async function audit(): Promise<void> {
  console.log('АУДИТ ПРЕДМЕТОВ\n');

  const items = (await q1<{ n: string }>('SELECT COUNT(*) n FROM items'))?.n ?? '0';
  const evts = (await q1<{ n: string }>('SELECT COUNT(*) n FROM item_events'))?.n ?? '0';
  console.log(`в леджере вещей: ${items}, записей в журнале: ${evts}`);

  // 1. Вещи без записи о рождении — такого быть не может, если писал только наш код.
  const orphan = await q<{ id: string }>(
    `SELECT i.id FROM items i
     WHERE NOT EXISTS (SELECT 1 FROM item_events e WHERE e.item_id = i.id AND e.kind = 'created')
     LIMIT 10`);
  report('вещи без записи о рождении', orphan.map((r) => r.id));

  // 2. Главная сверка: то, что лежит у персонажей и в сундуках, против леджера.
  //    Расхождение = вещь есть в сейве, а леджер считает её чужой, ушедшей или не знает вовсе.
  const chars = await q<{ char_id: string; user_id: string; data: SaveState }>(
    'SELECT char_id, user_id, data FROM characters');
  const stashes = await q<{ user_id: string; data: { tabs?: unknown } }>(
    'SELECT user_id, data FROM account_stash');

  const mismatch: string[] = [];
  const legacy: string[] = [];
  const seen = new Map<string, string>();   // id вещи → где встретили (для поиска дублей в сейвах)
  const dupes: string[] = [];

  const check = async (id: string, where: string, userId: string): Promise<void> => {
    if (!isUuid(id)) { legacy.push(`${id} (${where})`); return; }
    const prev = seen.get(id);
    if (prev) { dupes.push(`${id}: ${prev} И ${where}`); return; }
    seen.set(id, where);
    const row = await q1<{ loc: string; user_id: string }>('SELECT loc, user_id FROM items WHERE id = $1', [id]);
    if (!row) { mismatch.push(`${id} (${where}): нет в леджере`); return; }
    if (row.user_id !== userId) { mismatch.push(`${id} (${where}): леджер числит за ${row.user_id}`); return; }
    if (row.loc !== where) mismatch.push(`${id} (${where}): леджер говорит «${row.loc}»`);
  };

  for (const c of chars) {
    for (const it of itemsOfSave(c.data)) await check(it.uid, locOfChar(c.char_id), c.user_id);
  }
  for (const s of stashes) {
    for (const it of itemsOfStash(s.data as never)) await check(it.uid, 'stash', s.user_id);
  }

  report('ОДНА ВЕЩЬ В ДВУХ МЕСТАХ (дюп)', dupes);
  report('сейв и леджер разошлись', mismatch);
  report('вещи со старыми id (до Ф2, вне леджера)', legacy);

  // 3. Возвраты «из мира»: подобранный свой дроп это нормально, но всплеск — повод посмотреть.
  const backs = (await q1<{ n: string }>(
    `SELECT COUNT(*) n FROM item_events WHERE from_loc = 'world'`))?.n ?? '0';
  console.log(`\nвозвратов из мира (подбор своего дропа): ${backs}`);

  const revoked = (await q1<{ n: string }>('SELECT COUNT(*) n FROM items WHERE loc = $1', [LOC_REVOKED]))?.n ?? '0';
  console.log(`отозванных вещей: ${revoked}`);

  const bad = dupes.length + mismatch.length + orphan.length;
  console.log(bad === 0 ? '\n✓ Инварианты держатся.' : `\n✗ Нарушений: ${bad}`);
  process.exitCode = bad === 0 ? 0 : 1;
}

function report(title: string, list: string[]): void {
  if (!list.length) { console.log(`  ✓ ${title}: нет`); return; }
  console.log(`  ✗ ${title}: ${list.length}`);
  for (const l of list.slice(0, 10)) console.log(`      ${l}`);
  if (list.length > 10) console.log(`      … и ещё ${list.length - 10}`);
}

async function history(id: string): Promise<void> {
  const item = await q1<{ user_id: string; loc: string; base_id: string; born_at: Date }>(
    'SELECT user_id, loc, base_id, born_at FROM items WHERE id = $1', [id]);
  if (!item) { console.log(`вещь ${id} в леджере не значится`); process.exitCode = 1; return; }
  console.log(`вещь ${id}\n  база ${item.base_id}, аккаунт ${item.user_id}, сейчас: ${item.loc}\n`);
  const evts = await q<{ at: Date; kind: string; from_loc: string | null; to_loc: string | null; reason: string | null }>(
    'SELECT at, kind, from_loc, to_loc, reason FROM item_events WHERE item_id = $1 ORDER BY seq', [id]);
  for (const e of evts) {
    const move = e.from_loc ? `${e.from_loc} → ${e.to_loc}` : `${e.to_loc}`;
    console.log(`  ${e.at.toISOString()}  ${e.kind.padEnd(8)} ${move}${e.reason ? `  (${e.reason})` : ''}`);
  }
}

async function revoke(id: string, reason: string): Promise<void> {
  const removed = await revokeItem(id, reason);
  if (!removed) { console.log(`вещь ${id} в леджере не значится`); process.exitCode = 1; return; }
  console.log(`вещь ${id} отозвана у ${removed.user} (была: ${removed.from})`);
  console.log(`  вычищена из: ${removed.touched.join(', ') || 'нигде не лежала'}`);
  console.log('  вернуться она не сможет: syncItems отклоняет запись отозванной вещи');
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const id = arg('id') ?? '';
  if (cmd === 'audit') await audit();
  else if (cmd === 'history') await history(id);
  else if (cmd === 'revoke') await revoke(id, arg('reason') ?? 'без причины');
  else console.log('использование: audit | history --id=<uuid> | revoke --id=<uuid> --reason="…"');
  await closePool();
}

void main();

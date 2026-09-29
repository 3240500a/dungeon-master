import { q, q1, closePool, initSchema } from './pool.js';
import { initClusterSchema } from '../cluster/registry.js';
import { revokeItem, releaseOrphans } from './items.js';
import { runAudit, formatAudit, saveAuditRun } from './audit.js';
import { planRollback, applyRollback } from './rollback.js';

/**
 * Инструменты по предметам (Ф2). Ради них всё и затевалось: без журнала происхождения на
 * вопрос «откуда у него это» ответить нечем, а отзыв дюпнутой вещи превращается в откат всей
 * базы на сутки назад.
 *
 *   npm run items:audit                     — сверка леджера с сейвами + поиск странного
 *   npm run items:history -- --id=<uuid>    — вся жизнь одной вещи
 *   npm run items:revoke -- --id=<uuid> --reason="дюп через сундук"
 *   npm run items:orphans [-- --fix]        — вещи удалённых героев (R15-03): показать / увести в `world`
 *
 * Отзыв работает и по живому серверу: вещь помечается отозванной, и попытка вернуть её в
 * сейв отклоняется проверкой в `syncItems` — автосейв игрока не воскресит её обратно.
 */
const arg = (k: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);

async function audit(): Promise<void> {
  // Схему заводит сервер при старте. Внятное сообщение вместо простыни из недр драйвера:
  // «нет таблицы items» на свежей базе — частый и совершенно нестрашный случай.
  const ready = await q1<{ ok: boolean }>(`SELECT to_regclass('items') IS NOT NULL AS ok`);
  if (!ready?.ok) {
    console.log('в этой базе ещё нет таблиц предметов — она не инициализирована.');
    console.log('Схема создаётся при первом старте сервера: npm run dev:server (или укажите DM_PG на нужную базу).');
    process.exitCode = 1;
    return;
  }

  const r = await runAudit();
  console.log(formatAudit(r));

  // Ручной прогон тоже попадает в историю: иначе «в ту ночь всё было чисто» проверить нечем.
  if (process.argv.includes('--save')) { await saveAuditRun(r); console.log('\nпрогон записан в историю'); }

  // Прошлые прогоны рядом: одно число без ряда ничего не говорит.
  const prev = await q<{ at: Date; incidents: number; items: number }>(
    'SELECT at, incidents, items FROM audit_runs ORDER BY at DESC LIMIT 5');
  if (prev.length) {
    console.log('\nпрошлые прогоны:');
    for (const p of prev) console.log(`  ${p.at.toISOString().slice(0, 16).replace('T', ' ')}  вещей ${p.items}, инцидентов ${p.incidents}`);
  }

  process.exitCode = r.incidents === 0 ? 0 : 1;
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

/**
 * Откат предметов аккаунта на момент времени (Ф2.7). По умолчанию только показывает план:
 * применять чужой прогресс вслепую нельзя.
 */
async function rollback(userId: string, to: string, reason: string): Promise<void> {
  const at = new Date(to);
  if (Number.isNaN(at.getTime())) {
    console.log('нужна дата в виде --to=2026-09-09T10:00:00Z');
    process.exitCode = 1;
    return;
  }
  const plan = await planRollback(userId, at);
  console.log(`ОТКАТ аккаунта ${userId} на ${at.toISOString()}
`);
  console.log(`  вернуть на место: ${plan.restore.length}`);
  for (const r of plan.restore.slice(0, 10)) console.log(`      ${r.id} → ${r.to}  (${r.item.name})`);
  if (plan.restore.length > 10) console.log(`      … и ещё ${plan.restore.length - 10}`);
  console.log(`  забрать (на тот момент не существовали): ${plan.remove.length}`);
  for (const r of plan.remove.slice(0, 10)) console.log(`      ${r.id} из ${r.from}`);
  if (plan.remove.length > 10) console.log(`      … и ещё ${plan.remove.length - 10}`);
  console.log(`  без изменений: ${plan.untouched}`);
  // ⭐ R16-03: у героя, которого удалили после отсечки, — вернуть некуда: откат их не трогает (где лежат сейчас, там и останутся).
  if (plan.deletedHero.length) {
    const heroes = [...new Set(plan.deletedHero.map((d) => d.char))];
    console.log(`  ⚠ у удалённых героев на отсечке: ${plan.deletedHero.length} (героев ${heroes.length}) — откат их НЕ трогает, сверить РУКАМИ`);
    for (const d of plan.deletedHero.slice(0, 10)) console.log(`      ${d.id}  char:${d.char}`);
    if (plan.deletedHero.length > 10) console.log(`      … и ещё ${plan.deletedHero.length - 10}`);
  }

  console.log('\nЧЕГО ОТКАТ НЕ ВЕРНЁТ: золото и опыт (журнала для них нет),');
  console.log('слоты экипировки (журнал пишет место, но не слот — всё уедет в инвентарь),');
  console.log('и отозванные вещи (решение человека сильнее восстановления по времени).');
  console.log('ВЕЩИ УДАЛЁННЫХ ГЕРОЕВ тоже не возвращаются: героя нет — класть их некуда (остаются там, где лежат сейчас).');
  // R2-32: вещь, разобранную после отсечки, откат вернёт, а её выход — нет.
  console.log('ВЫХОД КУЗНИЦЫ тоже остаётся: сырьё с разбора (сумка и кошелёк сундука) и открытия журнала кузнеца.');
  if (plan.forge.length) {
    console.log(`  ⚠ после отсечки разобрано/переплавлено: ${plan.forge.length} — сверить сырьё и журнал РУКАМИ`);
    for (const f of plan.forge.slice(0, 10)) console.log(`      ${f.id}  ${f.reason}  ${new Date(f.at).toISOString()}`);
    if (plan.forge.length > 10) console.log(`      … и ещё ${plan.forge.length - 10}`);
  }
  console.log(`  журнал кузнеца: мификов ${plan.journalMythic} (ворота t6) — откат их не трогает`);

  if (!process.argv.includes('--apply')) {
    console.log('\nЭто был показ. Чтобы применить: добавьте --apply');
    return;
  }
  const done = await applyRollback(plan, reason);
  console.log(`\n✓ Применено: возвращено ${done.restored}, забрано ${done.removed}.`);
  console.log('  Игроку стоит перезайти: у него в памяти прежняя копия сейва.');
}

/**
 * ⭐ R15-03: вещи героев, удалённых до того, как удаление стало уводить их из леджера, — «потерянные» ночного аудита. Показ по умолчанию,
 * `--fix` — увести в `world` событием `gone` (`charDeleted`); повтор ничего не делает.
 */
async function orphans(): Promise<void> {
  const fix = process.argv.includes('--fix');
  const r = await releaseOrphans(fix);
  if (!r.items) { console.log('вещей удалённых героев в леджере нет'); return; }
  console.log(`${fix ? 'уведено в world' : 'в леджере у удалённых героев'}: вещей ${r.items}, героев ${r.chars.length}`);
  for (const c of r.chars.slice(0, 20)) console.log(`  char:${c}`);
  if (r.chars.length > 20) console.log(`  … и ещё ${r.chars.length - 20}`);
  if (!fix) console.log('\nЭто был показ. Чтобы увести их (событие gone, причина charDeleted): добавьте --fix');
}

async function main(): Promise<void> {
  // Схема идемпотентна и берётся под блокировкой — инструмент не должен зависеть от того,
  // перезапускали ли сервер после появления новой таблицы. И схема кластера: аудит читает закрепления за нодами
  // (проверка 6), а на базе, где сервер ещё не стартовал (завели админа `create-admin` и сразу аудит), их таблиц нет —
  // аудит падал в самом конце на «отношение char_claims не существует».
  await initSchema();
  await initClusterSchema();
  const cmd = process.argv[2];
  const id = arg('id') ?? '';
  if (cmd === 'audit') await audit();
  else if (cmd === 'history') await history(id);
  else if (cmd === 'revoke') await revoke(id, arg('reason') ?? 'без причины');
  else if (cmd === 'rollback') await rollback(arg('user') ?? '', arg('to') ?? '', arg('reason') ?? 'откат по инциденту');
  else if (cmd === 'orphans') await orphans();
  else {
    console.log('использование:');
    console.log('  audit [--save]                                  сверка инвариантов');
    console.log('  history --id=<uuid>                             жизнь одной вещи');
    console.log('  revoke --id=<uuid> --reason="…"                 отозвать вещь');
    console.log('  rollback --user=<id> --to=<ISO-дата> [--apply]  откат предметов аккаунта (вещи удалённых героев не трогает)');
    console.log('  orphans [--fix]                                 вещи удалённых героев — в world');
  }
  await closePool();
}

void main();

import { setUserRole, getUserByName } from './db.js';
import { initSchema, closePool, q } from './pool.js';

/**
 * РОЛИ ПОЛЬЗОВАТЕЛЕЙ (доступ к инструментальным роутам).
 *
 *   npm run grant-admin -- <ник>     — выдать права администратора
 *   npm run revoke-admin -- <ник>    — снять их
 *   npm run admins                   — кто сейчас админ
 *
 * ЗАЧЕМ ОТДЕЛЬНАЯ КОМАНДА, А НЕ ГАЛОЧКА В РЕДАКТОРЕ. Право выдаёт тот, у кого есть доступ
 * к машине с базой, — иначе повышение прав становится обычным запросом, и любая дыра в редакторе
 * превращается в захват сервера. Тот же принцип, что у `items:revoke`: опасное действие живёт
 * в консоли, а не в интерфейсе.
 *
 * НИЧЕГО НЕ СОЗДАЁТ: аккаунт заводится обычной регистрацией в игре, здесь только меняется роль.
 */
const ROLES = new Set(['admin', 'player']);

async function main(): Promise<void> {
  const [cmd, name] = [process.argv[2], process.argv[3]];
  await initSchema();
  try {
    if (cmd === 'list') {
      const rows = await q<{ username: string }>(`SELECT username FROM users WHERE role = 'admin' ORDER BY username`);
      if (!rows.length) {
        console.log('администраторов нет. Выдать: npm run grant-admin -- <ник>');
      } else {
        console.log(`администраторы (${rows.length}):`);
        for (const u of rows) console.log('  ' + u.username);
      }
      return;
    }
    const role = cmd === 'grant' ? 'admin' : cmd === 'revoke' ? 'player' : '';
    if (!ROLES.has(role) || !name) {
      console.log('использование:');
      console.log('  npm run grant-admin  -- <ник>');
      console.log('  npm run revoke-admin -- <ник>');
      console.log('  npm run admins');
      process.exitCode = 1;
      return;
    }
    // Отдельная проверка существования — чтобы отличить «ника нет» от «роль уже такая»:
    // молчаливое «ок» на опечатке в нике оставило бы человека без доступа и без объяснения.
    if (!await getUserByName(name)) {
      console.log(`нет пользователя "${name}". Аккаунт заводится регистрацией в игре.`);
      process.exitCode = 1;
      return;
    }
    const id = await setUserRole(name, role);
    console.log(id
      ? `${name} → ${role} (${id})`
      : `не удалось изменить роль "${name}"`);
    // Роль проверяется на КАЖДОМ запросе (`devGuard` читает её из базы), поэтому снятие
    // действует сразу — перевыпускать токены не нужно.
  } finally {
    await closePool();
  }
}

void main();

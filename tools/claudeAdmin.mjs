/**
 * ⭐ УЧЁТКА АГЕНТА ДЛЯ ЛОКАЛЬНОГО DEV-СЕРВЕРА. Запускается кликом по `tools/claude-admin.cmd`.
 *
 * ЗАЧЕМ. Поз-редактор (5173) и редактор конфигов (5174) открываются только под ролью `admin`
 * (`devAuth.ensureAdmin` — «отмены здесь нет»). Пока учётки нет, агент каждый раз упирается в диалог
 * входа и вынужден просить хозяина нажать «войти». Своя учётка снимает это навсегда и НЕ требует
 * сообщать агенту хозяйский пароль.
 *
 * ЧТО ДЕЛАЕТ:
 *   1. придумывает случайный пароль (24 байта, base64url) — на экран он не выводится НИКОГДА;
 *   2. кладёт пару «имя+пароль» в `tools/deploy/local.claude.json` (рядом с `local.env.ps1`, и так же в `.gitignore`);
 *   3. заводит аккаунт и выдаёт ему роль `admin` ПРОЕКТНОЙ ЖЕ командой `npm run create-admin -- <ник> --reset`
 *      (пароль уходит в неё пайпом, в истории консоли и в списке процессов не остаётся);
 *   4. проверяет, что вход РЕАЛЬНО работает: POST /api/login на живой сервер.
 *
 * Повторный запуск безопасен: `--reset` просто пересоздаёт пароль и гасит старые сессии.
 * Отозвать: `npm run revoke-admin -- claude` (и удалить файл с паролем).
 *
 * ⚠ Это учётка ТОЛЬКО для локальной разработки. К боевому серверу она отношения не имеет:
 * там роль выдаётся отдельно и этим файлом не управляется.
 */
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const CRED = path.join(ROOT, 'tools', 'deploy', 'local.claude.json');
const USER = process.argv[2] || 'claude';
const API = process.env.DM_API || 'http://localhost:3001';

const say = (s) => process.stdout.write(s + '\n');

async function main() {
  say('Учётка агента для локального dev-сервера');
  say('=======================================\n');

  const pass = randomBytes(24).toString('base64url');

  mkdirSync(path.dirname(CRED), { recursive: true });
  const prev = existsSync(CRED);
  writeFileSync(CRED, JSON.stringify({
    username: USER,
    password: pass,
    api: API,
    note: 'Учётка агента для ЛОКАЛЬНОГО dev-сервера. В git не попадает (.gitignore). Отозвать: npm run revoke-admin -- ' + USER,
  }, null, 2));
  say((prev ? 'Пароль перевыпущен' : 'Пароль создан') + ' и записан в:');
  say('  ' + CRED + '\n');

  say('Завожу аккаунт «' + USER + '» и выдаю роль admin…');
  const code = await run('npm', ['run', '--silent', 'create-admin', '--', USER, '--reset'], pass + '\n');
  if (code !== 0) {
    say('\n❌ Команда create-admin завершилась с кодом ' + code + '.');
    say('   Чаще всего это значит, что не поднят Postgres (в деве ожидается 127.0.0.1:5432, база dungeon).');
    say('   Подними базу/сервер и запусти этот файл ещё раз.');
    return 1;
  }

  say('\nПроверяю вход на ' + API + ' …');
  try {
    const r = await fetch(API + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: USER, password: pass }),
    });
    if (r.ok) {
      say('✅ Вход работает. Больше просить тебя нажимать «войти» не придётся.');
    } else {
      say('⚠ Аккаунт заведён, но вход вернул ' + r.status + '.');
      say('   Если сервер сейчас не запущен — это нормально, проверка повторится при первом входе.');
    }
  } catch {
    say('⚠ Сервер на ' + API + ' не отвечает — проверку входа пропустил.');
    say('   Аккаунт заведён; когда поднимешь сервер, вход заработает.');
  }

  say('\nГотово. Пароль на экран не выводился и в историю консоли не попал.');
  say('Отозвать доступ:  npm run revoke-admin -- ' + USER);
  return 0;
}

/** Запустить команду, отдав ей `stdin`, и НЕ показывая содержимое stdin. */
function run(cmd, args, stdin) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: ROOT, shell: true, stdio: ['pipe', 'inherit', 'inherit'] });
    p.stdin.end(stdin);
    p.on('close', (c) => resolve(c ?? 1));
    p.on('error', () => resolve(1));
  });
}

main().then((c) => { process.exitCode = c; }, (e) => {
  say('❌ ' + (e && e.message ? e.message : String(e)));
  process.exitCode = 1;
});

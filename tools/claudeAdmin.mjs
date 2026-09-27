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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const CRED = path.join(ROOT, 'tools', 'deploy', 'local.claude.json');
const ARGS = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const USER = ARGS[0] || 'claude';
/** Явное согласие сменить пароль СУЩЕСТВУЮЩЕМУ аккаунту — по умолчанию мы этого не делаем. */
const FORCE = process.argv.includes('--force-reset');
const API = process.env.DM_API || 'http://localhost:3001';
/**
 * ⚠ ЗОВЁМ `node` НАПРЯМУЮ, А НЕ ЧЕРЕЗ npm — и это не украшение, а единственный путь без граблей.
 * `npm` на Windows это `npm.cmd`, а Node с некоторых версий отказывается запускать `.cmd` без
 * `shell: true` (`spawn EINVAL` — поймано прогоном). С `shell: true` же он ругается DEP0190:
 * аргументы не экранируются, а имя аккаунта приходит снаружи.
 * Обе беды снимаются разом: `tsx` — обычный `.mjs`, и его запускает сам `process.execPath`.
 */
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI = path.join(ROOT, 'packages', 'server', 'src', 'db', 'createAdminCli.ts');

const say = (s) => process.stdout.write(s + '\n');

async function main() {
  say('Учётка агента для локального dev-сервера');
  say('=======================================\n');

  const pass = randomBytes(24).toString('base64url');

  /**
   * ⚠ ДВЕ РАЗНЫЕ КОМАНДЫ, И ПУТАТЬ ИХ НЕЛЬЗЯ. `create-admin -- <ник>` заводит аккаунт (пароль берёт
   * из пайпа), а СУЩЕСТВУЮЩЕМУ только выдаёт роль и пароль НЕ трогает — намеренно, «чтобы не сменить
   * незаметно чужой пароль при совпадении ника». `--reset` меняет пароль, но только существующему.
   *
   * Отсюда порядок: сначала ЗАВЕСТИ. Если аккаунт уже был — записанный здесь пароль ему не подходит,
   * и молча делать `--reset` НЕЛЬЗЯ: под этим ником может оказаться живой игрок, и мы сменили бы ему
   * пароль и выбили все сессии. В таком случае останавливаемся и спрашиваем.
   */
  for (const f of [TSX, CLI]) {
    if (!existsSync(f)) {
      say('❌ Не найден файл: ' + f);
      say('   Похоже, не установлены зависимости. Выполни в корне проекта:  npm install');
      return 1;
    }
  }

  say('Завожу аккаунт «' + USER + '» и выдаю роль admin…');
  const made = await run(process.execPath, [TSX, CLI, USER], pass + '\n');
  if (made.code !== 0) {
    say('\n❌ Не получилось (код ' + made.code + '). Причину CLI написал выше. Частые случаи:');
    say('   • не поднят Postgres — в деве ожидается 127.0.0.1:5432, база dungeon;');
    say('   • ник короче 3 или длиннее 20 символов.');
    return 1;
  }
  if (/уже есть/.test(made.out)) {
    if (!FORCE) {
      say('\n⚠ Аккаунт «' + USER + '» СУЩЕСТВОВАЛ ДО ЭТОГО. Роль admin ему выдана, но пароль не менялся —');
      say('   значит записанный сейчас в local.claude.json пароль ему НЕ подходит.');
      say('   Молча менять пароль не буду: под этим ником может быть живой игрок.');
      say('\n   Если «' + USER + '» — точно наш служебный аккаунт, запусти так:');
      say('     tools\\claude-admin.cmd ' + USER + ' --force-reset');
      say('   Если нет — возьми другое имя:');
      say('     tools\\claude-admin.cmd мой-агент');
      return 1;
    }
    say('\n--force-reset: выставляю пароль существующему аккаунту (старые сессии будут отозваны)…');
    const set = await run(process.execPath, [TSX, CLI, USER, '--reset'], pass + '\n');
    if (set.code !== 0) { say('\n❌ Сменить пароль не удалось (код ' + set.code + ').'); return 1; }
  }

  // ⚠ ФАЙЛ С ПАРОЛЕМ ПИШЕТСЯ ТОЛЬКО ПОСЛЕ УСПЕХА. Записать его раньше значит оставить после отказа
  // правдоподобный, но НЕРАБОЧИЙ пароль — и следующий вход упрётся в него, а причина будет уже забыта.
  mkdirSync(path.dirname(CRED), { recursive: true });
  const prev = existsSync(CRED);
  writeFileSync(CRED, JSON.stringify({
    username: USER,
    password: pass,
    api: API,
    note: 'Учётка агента для ЛОКАЛЬНОГО dev-сервера. В git не попадает (.gitignore). Отозвать: npm run revoke-admin -- ' + USER,
  }, null, 2));
  say('\n' + (prev ? 'Пароль перевыпущен' : 'Пароль создан') + ' и записан в:');
  say('  ' + CRED);

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
    // stdout ПЕРЕХВАТЫВАЕМ (по нему решаем, был ли аккаунт), но тут же печатаем — человек должен
    // видеть ровно то, что сказал CLI, а не наш пересказ.
    const p = spawn(cmd, args, { cwd: ROOT, stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString('utf8'); process.stdout.write(d); });
    p.stdin.end(stdin);
    p.on('close', (code) => resolve({ code: code ?? 1, out }));
    p.on('error', () => resolve({ code: 1, out }));
  });
}

main().then((c) => { process.exitCode = c; }, (e) => {
  say('❌ ' + (e && e.message ? e.message : String(e)));
  process.exitCode = 1;
});

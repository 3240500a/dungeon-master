import { createInterface } from 'node:readline';
import { hashPassword } from '../auth/password.js';
import { createUser, getUserByName, setUserRole, setUserPassword, deleteSessionsOfUser } from './db.js';
import { initSchema, closePool } from './pool.js';

/**
 * ЗАВЕСТИ АДМИНСКИЙ АККАУНТ ОДНОЙ КОМАНДОЙ.
 *
 *   npm run create-admin -- <ник>              завести (или выдать роль существующему)
 *   npm run create-admin -- <ник> --reset      сменить пароль существующему
 *
 * Пароль спрашивается ИНТЕРАКТИВНО и не эхом. Причина простая: аргумент командной строки оседает
 * в истории консоли и виден в списке процессов — пароль администратора там оказаться не должен.
 * Ник существует → аккаунт не трогаем, только выдаём роль (то же, что `grant-admin`).
 *
 * Смены пароля в самой игре нет (см. комментарий у `/api/logout-all`), поэтому ключ `--reset`
 * здесь обязателен: иначе пароль, заданный один раз, оставался бы навсегда.
 * Смена пароля ГАСИТ ВСЕ СЕССИИ этого аккаунта — иначе старые токены продолжат работать,
 * а это не защита.
 */

/**
 * ЧТЕНИЕ ПАРОЛЯ. Два пути, и второй не для красоты.
 *
 * ЕСТЬ ТЕРМИНАЛ — спрашиваем дважды и гасим эхо. Один `readline` на оба вопроса: отдельный
 * интерфейс на каждый выглядит чище, но после `rl.close()` ввод завершается, и второй вопрос
 * уже никогда не получает строку — процесс молча выходит, ничего не создав (поймано на прогоне).
 *
 * ТЕРМИНАЛА НЕТ (пайп, CI, проверка) — читаем строки как есть. Глушить нечего: на экран и так
 * ничего не идёт. Без этого пути команда непроверяема, а непроверяемая команда, заводящая
 * администратора, — плохая команда. Пароль при этом всё равно НЕ в аргументах: аргументы
 * оседают в истории консоли и видны в списке процессов.
 */
async function readPassword(): Promise<{ pass: string; again: string }> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    const lines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
    // Вторая строка необязательна: в скрипте подтверждать пароль самому себе бессмысленно.
    return { pass: lines[0] ?? '', again: lines[1] === undefined || lines[1] === '' ? (lines[0] ?? '') : lines[1] };
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const out = process.stdout as NodeJS.WriteStream & { muted?: boolean };
  const write = out.write.bind(out);
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string): void => {
    if (!out.muted) write(s);
  };
  const ask = (question: string): Promise<string> => new Promise((resolve) => {
    write(question);
    out.muted = true;
    rl.question('', (answer) => { out.muted = false; write('\n'); resolve(answer); });
  });
  try {
    const pass = await ask('пароль (не отображается): ');
    const again = await ask('ещё раз: ');
    return { pass, again };
  } finally {
    out.muted = false;
    rl.close();
  }
}

async function main(): Promise<void> {
  const name = process.argv[2];
  const reset = process.argv.includes('--reset');
  if (!name) {
    console.log('использование: npm run create-admin -- <ник>');
    console.log('  ник 3–20 символов; пароль спросится отдельно и не будет виден');
    process.exitCode = 1;
    return;
  }
  if (name.length < 3 || name.length > 20) {
    console.log('ник должен быть 3–20 символов (тот же предел, что при регистрации в игре)');
    process.exitCode = 1;
    return;
  }

  await initSchema();
  try {
    const existing = await getUserByName(name);
    if (existing && !reset) {
      // Пароль не трогаем без явного --reset: команда «завести админа» не должна
      // незаметно менять чужой пароль при совпадении ника.
      const id = await setUserRole(name, 'admin');
      console.log(`аккаунт "${name}" уже есть — выдана роль admin (${id})`);
      console.log('сменить пароль: npm run create-admin -- ' + name + ' --reset');
      return;
    }
    if (!existing && reset) {
      console.log(`нет пользователя "${name}" — менять пароль нечему`);
      process.exitCode = 1;
      return;
    }

    const { pass, again } = await readPassword();
    if (pass.length < 6 || pass.length > 200) {
      console.log('пароль от 6 символов (тот же предел, что при регистрации)');
      process.exitCode = 1;
      return;
    }
    if (pass !== again) {
      console.log('пароли не совпали — ничего не создано');
      process.exitCode = 1;
      return;
    }

    const { hash, salt } = hashPassword(pass);
    if (reset) {
      const id = await setUserPassword(name, hash, salt);
      // Старые токены после смены пароля обязаны перестать работать, иначе смена ничего не даёт.
      const gone = await deleteSessionsOfUser(existing!.id);
      console.log(`пароль "${name}" сменён (${id}), отозвано сессий: ${gone}`);
      await setUserRole(name, 'admin');
      return;
    }
    const id = await createUser(name, hash, salt, 'cli');
    await setUserRole(name, 'admin');
    console.log(`создан администратор "${name}" (${id})`);
    console.log('этим логином входят поз-редактор и редактор конфигов');
  } finally {
    await closePool();
  }
}

void main();

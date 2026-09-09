import { ConfigRegistry } from '@dm/shared';
import { getConfigOverrides, setConfigOverride } from './db.js';
import { closePool } from './pool.js';

/**
 * Починка оверрайдов конфига, отставших от схемы.
 *
 * ЗАЧЕМ. Сервер применяет сохранённые оверрайды поверх дефолтов и МОЛЧА пропускает те,
 * что не проходят валидацию (это правильно: лучше играть на дефолтах, чем упасть). Но
 * молчание означает, что правка из редактора может месяцами не доезжать до игры, и никто
 * этого не заметит. Так и случилось с `materials`: у цвета стало четыре компоненты вместо
 * трёх (добавилась прозрачность), а сохранённое значение осталось трёхкомпонентным — и весь
 * оверрайд игнорировался с 22 августа.
 *
 *   npm run db:repair          — показать, что не проходит и что будет исправлено
 *   npm run db:repair -- --fix — записать исправленное
 *
 * Чинит только то, что чинится ОДНОЗНАЧНО: цвет [r,g,b] → [r,g,b,1] (непрозрачный —
 * ровно то, чем он был до появления альфы). Всё остальное только показывается: угадывать
 * авторский замысел скриптом нельзя.
 */
const FIX = process.argv.includes('--fix');

/** Дописать непрозрачность трёхкомпонентным цветам. Возвращает число исправлений. */
function padColors(v: unknown, key: string, path: string[], log: string[]): number {
  if (Array.isArray(v)) {
    // Цвет — массив из трёх чисел там, где ждут четыре.
    if (v.length === 3 && v.every((x) => typeof x === 'number')) {
      const last = path[path.length - 1] ?? '';
      if (/color|colour/i.test(last)) {
        (v as number[]).push(1);
        log.push(`  ${key}.${path.join('.')}: [${v.slice(0, 3).join(', ')}] → [${v.join(', ')}]`);
        return 1;
      }
    }
    let n = 0;
    for (const [i, item] of v.entries()) n += padColors(item, key, [...path, String(i)], log);
    return n;
  }
  if (v && typeof v === 'object') {
    let n = 0;
    for (const [k, item] of Object.entries(v)) n += padColors(item, key, [...path, k], log);
    return n;
  }
  return 0;
}

async function main(): Promise<void> {
  const reg = new ConfigRegistry();
  reg.loadAll();
  const overrides = await getConfigOverrides();

  const broken: string[] = [];
  for (const [key, value] of Object.entries(overrides)) {
    try {
      const trial = new ConfigRegistry();
      trial.loadAll();
      trial.reload({ [key]: value });
    } catch (e) {
      broken.push(key);
      console.log(`\n✗ «${key}» не проходит валидацию и НЕ ПРИМЕНЯЕТСЯ в игре`);
      console.log(`  ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`);
    }
  }
  if (!broken.length) {
    console.log('Все сохранённые оверрайды конфига проходят валидацию.');
    await closePool();
    return;
  }

  console.log('\nЧто можно исправить однозначно:');
  let fixedAny = false;
  for (const key of broken) {
    const value = structuredClone(overrides[key]);
    const log: string[] = [];
    const n = padColors(value, key, [], log);
    if (!n) { console.log(`  ${key}: автоматически не чинится — нужен редактор`); continue; }
    try {
      const trial = new ConfigRegistry();
      trial.loadAll();
      trial.reload({ [key]: value });
    } catch (e) {
      console.log(`  ${key}: после правки цветов всё ещё не проходит — не трогаю`);
      console.log(`    ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`);
      continue;
    }
    console.log(`  ${key}: исправлений ${n}`);
    for (const l of log.slice(0, 8)) console.log(l);
    if (log.length > 8) console.log(`    … и ещё ${log.length - 8}`);
    if (FIX) { await setConfigOverride(key, value); fixedAny = true; }
  }

  console.log(FIX
    ? (fixedAny ? '\n✓ Записано. Перезапустите сервер, чтобы оверрайды применились.' : '\nНичего не записано.')
    : '\nЭто был показ. Чтобы записать: npm run db:repair -- --fix');
  await closePool();
}

void main();

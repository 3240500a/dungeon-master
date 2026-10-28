/**
 * ⭐⭐ ИЗВЛЕКАТЕЛЬ ИГРОЦКОГО ТЕКСТА. Запуск из корня проекта:
 *     npm run i18n              — отчёт: корпус, нестабильные ключи, покрытие по языкам, сироты
 *     npm run i18n:stub -- en   — дописать в `locales.json` пустые заготовки для НЕпереведённых ключей
 *
 * Зачем отдельный инструмент, а не «перевести файлы данных»: русский текст ОСТАЁТСЯ на своём месте в
 * `config/data/*.json` — он источник и он же запас. Перевод кладётся рядом, ключом (`cfg:<таблица>/<id>/<поле>`),
 * и сюда же попадают литералы кода (`ui:<область>.<вещь>`). Так правка контента не требует правки переводов,
 * а забытый перевод виден отчётом, а не игроком.
 *
 * ⚠ Ключи считает `shared/src/i18n/keys.ts` — ОДНА реализация на извлекатель, рантайм и сторожа.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { defaultConfigData, localeCoverage, localeLangs, localesSchema, SOURCE_LANG, walkConfigText, type Locales } from '@dm/shared';

const DATA = 'packages/shared/src/config/data/locales.json';

function loadLocales(): Locales {
  try {
    const parsed = localesSchema.safeParse(JSON.parse(readFileSync(DATA, 'utf8')));
    if (!parsed.success) {
      console.error(`locales.json не прошёл схему:\n${parsed.error.toString()}`);
      process.exit(1);
    }
    return parsed.data;
  } catch {
    return {} as Locales;
  }
}

const corpus = walkConfigText(defaultConfigData);
const locales = loadLocales();
const langs = localeLangs(locales);
const keys = corpus.map((c) => c.key);

const mode = process.argv[2] === '--stub' ? 'stub' : 'report';
const target = process.argv[3];

if (mode === 'stub') {
  if (!target || target === SOURCE_LANG) {
    console.error(`Укажи язык, и не "${SOURCE_LANG}": русский текст живёт в самих данных конфига, в переводах ему места нет.`);
    process.exit(1);
  }
  const pack = locales[target];
  if (!pack) {
    console.error(`Языка "${target}" нет в ${DATA}. Сперва добавь его пакет (name/enabled/grammar) — это правка данных, а не кода.`);
    process.exit(1);
  }
  let added = 0;
  for (const { key } of corpus) {
    if (pack.strings[key] === undefined) { pack.strings[key] = ''; added++; }
  }
  // ⚠ Сироты НЕ удаляем молча: ключ мог уехать от правки контента, и перевод к нему — ценность. Их показывает отчёт.
  writeFileSync(DATA, `${JSON.stringify(locales, null, 2)}\n`, 'utf8');
  console.log(`${target}: дописано пустых заготовок — ${added}; всего ключей в пакете — ${Object.keys(pack.strings).length}`);
  process.exit(0);
}

// ── отчёт ───────────────────────────────────────────────────────────────────
const byTable = new Map<string, { n: number; chars: number }>();
for (const c of corpus) {
  const row = byTable.get(c.table) ?? { n: 0, chars: 0 };
  row.n++;
  row.chars += c.source.length;
  byTable.set(c.table, row);
}
const chars = corpus.reduce((s, c) => s + c.source.length, 0);

console.log('='.repeat(92));
console.log('КОРПУС ИГРОЦКОГО ТЕКСТА КОНФИГА');
console.log('='.repeat(92));
console.log(`строк: ${corpus.length} | символов: ${chars.toLocaleString('ru-RU')} | ~слов: ${Math.round(chars / 6).toLocaleString('ru-RU')}`);
console.log();
for (const [table, row] of [...byTable].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${table.padEnd(22)} ${String(row.n).padStart(5)} строк  ${row.chars.toLocaleString('ru-RU').padStart(9)} симв.`);
}

const unstable = corpus.filter((c) => !c.stable);
const dup = new Map<string, number>();
for (const c of corpus) dup.set(c.key, (dup.get(c.key) ?? 0) + 1);
const collisions = [...dup].filter(([, n]) => n > 1);

console.log();
console.log(`⚠ коллизий ключей: ${collisions.length}${collisions.length ? ` — ${collisions.slice(0, 5).map(([k]) => k).join(', ')}` : ' (схема держит)'}`);
console.log(`⚠ ключей по ИНДЕКСУ (поедут от переупорядочивания): ${unstable.length}`);
for (const c of unstable.slice(0, 8)) console.log(`     ${c.key}`);

console.log();
console.log('ЯЗЫКИ');
console.log('-'.repeat(92));
if (!langs.length) {
  console.log('  (ни одного языка в locales.json — добавь пакет языка и позови `npm run i18n:stub -- en`)');
} else {
  for (const lang of langs) {
    const pack = locales[lang]!;
    const cov = localeCoverage(locales, lang, keys);
    const own = Object.keys(pack.strings).length;
    const orphans = Object.keys(pack.strings).filter((k) => !dup.has(k) && k.startsWith('cfg:'));
    const filled = Object.entries(pack.strings).filter(([, v]) => (typeof v === 'string' ? v : Object.values(v).join('')).trim()).length;
    console.log(`  ${lang.padEnd(4)} ${pack.name.padEnd(12)} ${pack.enabled ? 'включён ' : 'выключен'} покрытие ${(cov * 100).toFixed(1).padStart(5)} %  ключей ${String(own).padStart(5)} (заполнено ${filled})  сирот ${orphans.length}`);
    for (const o of orphans.slice(0, 4)) console.log(`         сирота: ${o}`);
  }
}
console.log();
console.log('⚠ Литералы КОДА (`ui:`) этот отчёт НЕ СЧИТАЕТ, и сторожа на них ПОКА НЕТ (шаг 8 плана).');
console.log('  Считать их надо по Unity-рантайму (`Assets/DM`), а не по вебу: веб-клиент снят и в подсчёты не входит.');
console.log('  Замер 26.10 на глаз: ~2 100 литералов интерфейса Unity.');

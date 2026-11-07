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
 *
 * ⭐⭐ i18n Ф2 (06.11): и ФРАЗЫ КОДА СЕРВЕРА (`srv:`) — каждый `tr()`/`trn()` в `packages/shared/src` и `packages/server/src`, найденный по
 * дереву TypeScript (`shared/src/i18n/srvExtract.ts`). Отчёт ПЕРЕПИСЫВАЕТ снимок `packages/shared/src/i18n/corpus.srv.json` (его коммитят:
 * по нему работает вкладка «🌐 Языки», а сторож `srvCorpus.test.ts` падает, если код ушёл от снимка). Покрытие и заготовки — по обоим
 * корпусам: `cfg:` + `srv:`.
 *
 * ⭐⭐ i18n (07.11, «литералы обвязки»): и ФРАЗЫ КЛИЕНТА UNITY (`ui:`) — каждый `DmText.T`/`Tn`/`With`/`WithN` рантайма `Assets/DM`
 * Unity-репо (`shared/src/i18n/uiExtract.ts`; репо — `DM_UNITY_REPO`, иначе соседняя `../ashes of the past/Ashes of the past`). Есть
 * Unity-репо — отчёт ПЕРЕПИСЫВАЕТ снимок `corpus.ui.json` и эталон Unity `__golden__/unity_ui.json` (корпус + псевдоязык; копия в Unity —
 * `golden_sync.py`); нет — берёт закоммиченный снимок и говорит об этом. Покрытие, сироты и заготовки — по трём корпусам.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { defaultConfigData, localeCoverage, localeLangs, localesSchema, SOURCE_LANG, walkConfigText, type FormSet, type Locales } from '@dm/shared';
import { extractSrvFromRepo, srvCorpusFileText, srvCorpusOf } from '../../packages/shared/src/i18n/srvExtract.js';
import { extractUiFromRepo, uiCorpusFileText, uiCorpusOf, unityRepoRoot, unityUiGoldenText } from '../../packages/shared/src/i18n/uiExtract.js';

const DATA = 'packages/shared/src/config/data/locales.json';
const SRV_FILE = 'packages/shared/src/i18n/corpus.srv.json';
const UI_FILE = 'packages/shared/src/i18n/corpus.ui.json';
const UI_GOLDEN = 'packages/shared/src/i18n/__golden__/unity_ui.json';

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
// ⭐ i18n Ф2: фразы кода — по дереву исходников; нарушение шва (ключ не литерал, два исходника) — отказ, а не тихий пропуск
const srv = extractSrvFromRepo(process.cwd());
if (srv.problems.length) {
  console.error(`Фразы кода нарушают правило шва (tr.ts):\n  ${srv.problems.join('\n  ')}`);
  process.exit(1);
}
const srvStrings = srvCorpusOf(srv.phrases);
// ⭐ 07.11: фразы клиента Unity — по коду Unity-репо, если он рядом; иначе — закоммиченный снимок (переписывать его нечем)
const unityRoot = unityRepoRoot(process.cwd());
const ui = unityRoot ? extractUiFromRepo(unityRoot) : null;
if (ui?.problems.length) {
  console.error(`Фразы клиента Unity нарушают правило шва (DmText.cs):\n  ${ui.problems.join('\n  ')}`);
  process.exit(1);
}
const uiSnapshot = (): Record<string, FormSet> => {
  try { return (JSON.parse(readFileSync(UI_FILE, 'utf8')) as { strings: Record<string, FormSet> }).strings; } catch { return {}; }
};
const uiStrings = ui ? uiCorpusOf(ui.phrases) : uiSnapshot();
const keys = [...corpus.map((c) => c.key), ...Object.keys(srvStrings), ...Object.keys(uiStrings)];

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
  for (const key of keys) {
    if (pack.strings[key] === undefined) { pack.strings[key] = ''; added++; }
  }
  // ⚠ Сироты НЕ удаляем молча: ключ мог уехать от правки контента, и перевод к нему — ценность. Их показывает отчёт.
  writeFileSync(DATA, `${JSON.stringify(locales, null, 2)}\n`, 'utf8');
  console.log(`${target}: дописано пустых заготовок — ${added}; всего ключей в пакете — ${Object.keys(pack.strings).length}`);
  process.exit(0);
}

// ── отчёт ───────────────────────────────────────────────────────────────────
// ⭐ i18n Ф2: снимок фраз кода — переписывается каждым отчётом (он коммитится; сторож сверяет его с кодом)
const srvText = srvCorpusFileText(srvStrings);
let srvWas = '';
try { srvWas = readFileSync(SRV_FILE, 'utf8').replace(/\r\n/g, '\n'); } catch { /* файла ещё нет */ }
if (srvWas !== srvText) writeFileSync(SRV_FILE, srvText, 'utf8');
// ⭐ 07.11: снимок фраз клиента и эталон Unity (корпус + псевдоязык) — переписываются, когда есть что писать
const rewrite = (file: string, text: string): boolean => {
  let was = '';
  try { was = readFileSync(file, 'utf8').replace(/\r\n/g, '\n'); } catch { /* файла ещё нет */ }
  if (was === text) return false;
  writeFileSync(file, text, 'utf8');
  return true;
};
const uiChanged = ui ? rewrite(UI_FILE, uiCorpusFileText(uiStrings)) : false;
const goldenChanged = existsSync(UI_FILE) || ui ? rewrite(UI_GOLDEN, unityUiGoldenText(uiStrings, (locales as Record<string, unknown>)[SOURCE_LANG])) : false;

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

const srvChars = Object.values(srvStrings).reduce<number>((s, v) => s + (typeof v === 'string' ? v.length : Object.values(v).join('').length), 0);
console.log();
console.log(`ФРАЗЫ КОДА СЕРВЕРА (srv:): ${Object.keys(srvStrings).length} ключей в ${srv.phrases.length} вызовах | символов: ${srvChars.toLocaleString('ru-RU')}`
  + ` | снимок ${SRV_FILE}: ${srvWas === srvText ? 'свежий' : 'ОБНОВЛЁН — закоммить'}`);
const uiChars = Object.values(uiStrings).reduce<number>((s, v) => s + (typeof v === 'string' ? v.length : Object.values(v).join('').length), 0);
if (ui) {
  console.log(`ФРАЗЫ КЛИЕНТА UNITY (ui:): ${Object.keys(uiStrings).length} ключей в ${ui.phrases.length} вызовах | символов: ${uiChars.toLocaleString('ru-RU')}`
    + ` | снимок ${UI_FILE}: ${uiChanged ? 'ОБНОВЛЁН — закоммить' : 'свежий'} | эталон Unity ${UI_GOLDEN}: ${goldenChanged ? 'ОБНОВЛЁН — закоммить и golden_sync.py в Unity' : 'свежий'}`);
} else {
  console.log(`ФРАЗЫ КЛИЕНТА UNITY (ui:): ⏸ Unity-репо не найден (DM_UNITY_REPO или ../ashes of the past/Ashes of the past) — код не читан, `
    + `взят снимок ${UI_FILE}: ${Object.keys(uiStrings).length} ключей${goldenChanged ? ` (эталон ${UI_GOLDEN} пересобран из снимка)` : ''}`);
}

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
    const orphans = Object.keys(pack.strings).filter((k) => (k.startsWith('cfg:') && !dup.has(k)) || (k.startsWith('srv:') && !(k in srvStrings))
      || (k.startsWith('ui:') && !(k in uiStrings)));
    const filled = Object.entries(pack.strings).filter(([, v]) => (typeof v === 'string' ? v : Object.values(v).join('')).trim()).length;
    console.log(`  ${lang.padEnd(4)} ${pack.name.padEnd(12)} ${pack.enabled ? 'включён ' : 'выключен'} покрытие ${(cov * 100).toFixed(1).padStart(5)} %  ключей ${String(own).padStart(5)} (заполнено ${filled})  сирот ${orphans.length}`);
    for (const o of orphans.slice(0, 4)) console.log(`         сирота: ${o}`);
  }
}
console.log();
console.log('Покрытие и сироты — по трём корпусам: конфиг (cfg:), фразы сервера (srv:), фразы клиента Unity (ui:).');

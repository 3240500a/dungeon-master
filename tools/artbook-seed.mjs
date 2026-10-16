/**
 * ⭐ 16.10 (Артбук): ИМПОРТ ЧЕРНОВИКА В СИД вкладки «🎨 Артбук» редактора конфигов.
 *
 *   node tools/artbook-seed.mjs <путь к draft.json>
 *
 * Черновик (сборка исследований по нежити крипты) кладётся как есть в `packages/editor/src/artbook/seed/crypt.json` — с
 * отступом в один пробел и LF, чтобы следующий импорт давал читаемый дифф. Правки владельца живут отдельно (`pe_artbook`,
 * по пути поля) и новым сидом НЕ затираются: поля, которых он не трогал, поедут с сидом, тронутые — останутся его, а там, где
 * сид под правкой поменялся, вкладка покажет «сид обновился».
 *
 * Проверяет форму до записи: пять подтипов с id, у архетипов — известные подтипы, у матрицы — колонки подтипов. Кривой
 * черновик не пишется (иначе вкладка открылась бы пустой).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.argv[2];
if (!src) { console.error('нужен путь к draft.json'); process.exit(2); }
const d = JSON.parse(readFileSync(src, 'utf8'));

const fail = (m) => { console.error('черновик не годится: ' + m); process.exit(1); };
if (!Array.isArray(d.subtypes) || !d.subtypes.length) fail('нет subtypes');
const ids = new Set(d.subtypes.map((s) => s.id));
if ([...ids].some((id) => typeof id !== 'string' || !/^[a-z0-9_]+$/.test(id))) fail('id подтипа не латиницей');
if (!Array.isArray(d.archetypes)) fail('нет archetypes');
for (const a of d.archetypes) {
  if (typeof a.id !== 'string') fail('архетип без id');
  for (const s of a.subtypes ?? []) if (!ids.has(s)) fail(`архетип ${a.id}: неизвестный подтип ${s}`);
}
for (const c of d.matrix?.columns ?? []) if (!ids.has(c.id)) fail(`матрица: неизвестная колонка ${c.id}`);

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'editor', 'src', 'artbook', 'seed', 'crypt.json');
writeFileSync(out, JSON.stringify(d, null, 1) + '\n', 'utf8');
console.log(`сид записан: ${out} — подтипов ${d.subtypes.length}, архетипов ${d.archetypes.length}`);

/**
 * Стенд проверок видов города (town*.test.ts): реестр конфига ИЗ СНИМКА ЭТАЛОНА и чтение эталонов.
 *
 * Эталоны Unity (`unity_town.json`, `unity_panels.json`, `unity_salvage.json`, `unity_exchange.json`, `unity_stats.json`) кладут в
 * `config` ровно те поля таблиц, что читал порт C#. Схемам реестра этого мало (имени базы нет, полей детали нет), поэтому таблица эталона
 * накладывается построчно на встроенную: строка с тем же `id` (у приманок вида `iron-3-off` — строка-прототип `iron-3`), поля эталона —
 * поверх. Строки и их ПОРЯДОК — эталона (приманка перед `iron-3` стоит именно там, где её поставил генератор). `balance` — глубокое
 * наложение. Чего эталон не нёс (поле, которое C# не читал), остаётся встроенным: правила его не меняли, иначе генератор положил бы его.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ConfigRegistry } from '../config/registry.js';
import type { ConfigKey } from '../config/schemas.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..');

/**
 * Пути эталонов. ⭐ С11 (29.10): эталоны веб-окон ЗАМОРОЖЕНЫ в `__fixtures__` (выход веб-клиента на теге `web-client-final`): веб-клиента и
 * портов правил Unity больше нет, вид сервера — сам источник, а файлы держат прежнее поведение окон как регрессию.
 * ⭐ С-аудит (29.10): и эталон вкладки «⇄ Обмен» — тоже здесь (`unity_exchange.json`, байт в байт `Assets/DM/UI/Tests/unity_exchange_golden.json`
 * HEAD Unity-репо до удаления порта): раньше он читался из соседнего Unity-репо, а с удалением файла там весь `townExchange.test.ts` молча
 * пропускался. Нет файла — тест ПАДАЕТ, а не пропускается.
 */
export const GOLDEN = {
  town: join(HERE, '__fixtures__', 'unity_town.json'),
  panels: join(HERE, '__fixtures__', 'unity_panels.json'),
  salvage: join(ROOT, 'packages/shared/src/economy/__golden__/unity_salvage.json'),
  stats: join(HERE, '__fixtures__', 'unity_stats.json'),
  exchange: join(HERE, '__fixtures__', 'unity_exchange.json'),
} as const;

export function readGolden<T = Record<string, unknown>>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return null; }
}

type Row = Record<string, unknown> & { id?: unknown };
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function deepMerge(base: unknown, over: unknown): unknown {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v);
  return out;
}

/** Прототип строки: тот же id, иначе самый длинный id-префикс (`iron-3-off` → `iron-3`), иначе первая строка. */
function protoOf(rows: readonly Row[], id: unknown): Row | undefined {
  if (typeof id !== 'string') return rows[0];
  const same = rows.find((r) => r.id === id);
  if (same) return same;
  let best: Row | undefined;
  for (const r of rows) if (typeof r.id === 'string' && id.startsWith(r.id) && (!best || (r.id as string).length > (best.id as string).length)) best = r;
  return best ?? rows[0];
}

function mergeRows(base: readonly Row[], over: readonly Row[]): Row[] {
  return over.map((o) => ({ ...(protoOf(base, o.id) ?? {}), ...o }));
}

function mergeTable(base: unknown, over: unknown): unknown {
  if (Array.isArray(base) && Array.isArray(over)) return mergeRows(base as Row[], over as Row[]);
  if (isObj(base) && isObj(over) && Array.isArray(over.nodes) && Array.isArray(base.nodes)) {
    return { ...base, ...over, nodes: mergeRows(base.nodes as Row[], over.nodes as Row[]) };
  }
  return deepMerge(base, over);
}

/** Реестр из снимка `config` эталона, наложенного на встроенные таблицы (правила поверх таблиц — выключены: снимок частичный). */
export function registryFromGolden(config: Record<string, unknown>): ConfigRegistry {
  const reg = new ConfigRegistry();
  reg.loadAll(undefined, { cross: false });
  const raw = reg.snapshot() as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const [key, table] of Object.entries(config)) patch[key] = mergeTable(raw[key], table);
  reg.reload(patch as Partial<Record<ConfigKey, unknown>>, { cross: false });
  return reg;
}

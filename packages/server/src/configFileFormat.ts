import type { z } from 'zod';
import { configSchemas } from '@dm/shared';

/** Схема записи, если конфиг — массив (для отсечения умолчаний zod при записи файла). */
export function arrayElementSchema(key: string): z.ZodTypeAny | undefined {
  // По имени типа, а не `instanceof`: у shared и сервера могут оказаться разные копии zod.
  const s = (configSchemas as Record<string, z.ZodTypeAny>)[key];
  const def = s?._def as { typeName?: string; type?: z.ZodTypeAny } | undefined;
  return def?.typeName === 'ZodArray' ? def.type : undefined;
}

/**
 * ЗАПИСЬ КОНФИГА В ФАЙЛ БЕЗ ЛИШНЕГО DIFF. Роут «записать в файл» получает от редактора значение, уже
 * прогнанное через zod — со всеми умолчаниями. Записанное как есть (`JSON.stringify(v, null, 2)`), оно:
 * - ломало файлы формата «строка на запись» (`weapon-parts.json`: 311 деталей, по строке на каждую, CRLF)
 *   — одна правка превращалась в diff на шесть тысяч строк;
 * - вписывало умолчания в каждую строку (`"form": ""` у всех 311 деталей), хотя в файле их нет.
 *
 * Поэтому у файла «строка на запись» формат сохраняется: неизменённая запись пишется ИСХОДНОЙ строкой
 * байт-в-байт, изменённая — поверх исходной, без ключей, которые zod лишь дописал умолчанием. Остальные
 * файлы пишутся по-старому.
 */

/** Как JSON-строку пишет Python `json.dumps(..., separators=(', ', ': '), ensure_ascii=False)` — формат этих файлов. */
export function rowJson(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(rowJson).join(', ') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined)
      .map(([k, x]) => `${JSON.stringify(k)}: ${rowJson(x)}`).join(', ') + '}';
  }
  return JSON.stringify(v);
}

const deepEq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

interface RowFile { nl: string; lines: string[]; rows: Record<string, unknown>[] }

/** Файл — массив «строка на запись»? Тогда его строки и записи (по порядку). */
export function parseRowFile(text: string): RowFile | null {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const all = text.split(nl);
  if (all[all.length - 1] === '') all.pop();
  if (all.length < 2 || all[0]!.trim() !== '[' || all[all.length - 1]!.trim() !== ']') return null;
  const lines = all.slice(1, -1);
  const rows: Record<string, unknown>[] = [];
  for (const l of lines) {
    try {
      const v = JSON.parse(l.trim().replace(/,$/, '')) as unknown;
      if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
      rows.push(v as Record<string, unknown>);
    } catch { return null; }
  }
  return { nl, lines, rows };
}

/**
 * Текст файла для нового значения ключа. `existing` — текущий файл (или null), `element` — схема записи
 * массива (чтобы понять, какие ключи zod дописал умолчанием). Не «строка на запись» — прежний формат.
 */
export function formatConfigFile(value: unknown, existing: string | null, element?: z.ZodTypeAny): string {
  const file = existing ? parseRowFile(existing) : null;
  if (!file || !Array.isArray(value)) return JSON.stringify(value, null, 2) + '\n';
  const byId = new Map<string, { line: string; raw: Record<string, unknown> }>();
  file.rows.forEach((raw, i) => { if (typeof raw.id === 'string') byId.set(raw.id, { line: file.lines[i]!.trim().replace(/,$/, ''), raw }); });
  const norm = (raw: Record<string, unknown>): Record<string, unknown> => {
    if (!element) return raw;
    const r = element.safeParse(raw);
    return r.success ? (r.data as Record<string, unknown>) : raw;
  };
  const out = (value as Record<string, unknown>[]).map((row) => {
    const prev = typeof row.id === 'string' ? byId.get(row.id) : undefined;
    if (!prev) return rowJson(row);
    const before = norm(prev.raw);
    if (deepEq(before, row)) return prev.line; // не менялась — исходная строка байт-в-байт
    // Менялась: поверх исходной записи, в её порядке ключей; новые ключи — только настоящие, не умолчания.
    const merged: Record<string, unknown> = {};
    for (const k of Object.keys(prev.raw)) if (k in row) merged[k] = row[k];
    for (const [k, v] of Object.entries(row)) {
      if (k in merged) continue;
      if (!(k in prev.raw) && deepEq(v, before[k])) continue;
      merged[k] = v;
    }
    return rowJson(merged);
  });
  return '[' + file.nl + out.map((l) => '  ' + l).join(',' + file.nl) + file.nl + ']' + file.nl;
}

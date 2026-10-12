import { describe, it, expect } from 'vitest';
import type { z } from 'zod';
import { configSchemas } from '@dm/shared';
import { DECOR_FIELD_LABELS, DECOR_PATH_LABELS } from './decorLabels.js';

/**
 * ⭐ 12.10 (Ф2 декора): подписи правил пропов в форме биома (`decorLabels.ts`) — каждый путь «родитель.ключ» есть в схеме правил пропов, а
 * подпись по одному имени ключа не ляжет на чужой конфиг (имя встречается только внутри `dressing.props`): генератор форм подписывает по имени.
 */
type Any = z.ZodTypeAny;
function unwrap(s: Any): Any {
  for (;;) {
    const tn = s._def.typeName;
    if (tn === 'ZodOptional' || tn === 'ZodNullable' || tn === 'ZodDefault') s = s._def.innerType;
    else if (tn === 'ZodEffects') s = s._def.schema;
    else if (tn === 'ZodLazy') s = s._def.getter();
    else return s;
  }
}
/** Все поля всех объектов схемы: путь ключей до поля (без индексов массивов). Общая подсхема обходится в каждом месте; `up` — предки (от петли). */
function fields(s: Any, path: string[], out: string[][], up: Any[] = []): string[][] {
  const u = unwrap(s);
  if (up.includes(u)) return out;
  const next = [...up, u];
  const tn = u._def.typeName;
  if (tn === 'ZodObject') for (const [k, sub] of Object.entries((u as z.ZodObject<z.ZodRawShape>).shape)) { out.push([...path, k]); fields(sub as Any, [...path, k], out, next); }
  else if (tn === 'ZodArray') fields(u._def.type, path, out, next);
  else if (tn === 'ZodRecord') fields(u._def.valueType, path, out, next);
  else if (tn === 'ZodTuple') for (const it of u._def.items as Any[]) fields(it, path, out, next);
  else if (tn === 'ZodUnion' || tn === 'ZodDiscriminatedUnion') {
    const raw = u._def.options;
    for (const o of (Array.isArray(raw) ? raw : [...raw.values()]) as Any[]) fields(o, path, out, next);
  }
  return out;
}

describe('⭐ 12.10 (Ф2): подписи правил пропов в форме биома', () => {
  const props = fields(configSchemas.biomes as unknown as Any, [], []).filter((p) => p.includes('props'));
  const all = Object.entries(configSchemas).flatMap(([k, s]) => fields(s as unknown as Any, [k], []));

  it('каждый путь «родитель.ключ» — поле правил пропов (dressing.props)', () => {
    const pairs = new Set(props.map((p) => p.slice(-2).join('.')));
    for (const k of Object.keys(DECOR_PATH_LABELS)) expect(pairs.has(k), k).toBe(true);
  });

  it('подпись по имени — только имена, которых нет нигде в схемах конфигов, кроме правил пропов', () => {
    for (const k of Object.keys(DECOR_FIELD_LABELS)) {
      const at = all.filter((p) => p[p.length - 1] === k);
      expect(at.length, k).toBeGreaterThan(0);
      for (const p of at) expect(p.slice(0, -1).includes('props') || p.join('.').endsWith('dressing.props'), `${k}: ${p.join('.')}`).toBe(true);
    }
  });
});

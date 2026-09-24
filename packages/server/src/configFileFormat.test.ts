import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { arrayElementSchema, formatConfigFile, parseRowFile, rowJson } from './configFileFormat.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PARTS = join(HERE, '../../shared/src/config/data/weapon-parts.json');

/** То, что присылает редактор: весь массив, прогнанный через zod (с умолчаниями). */
function asEditorSends(text: string): Record<string, unknown>[] {
  const el = arrayElementSchema('weapon-parts')!;
  return parseRowFile(text)!.rows.map((r) => el.parse(r) as Record<string, unknown>);
}

describe('запись конфига в файл без лишнего diff', () => {
  const text = readFileSync(PARTS, 'utf8');

  it('weapon-parts без правок пишется байт-в-байт, хотя zod дописал умолчания в каждую строку', () => {
    const sent = asEditorSends(text);
    expect(sent.every((r) => 'form' in r)).toBe(true); // умолчания правда приехали
    expect(formatConfigFile(sent, text, arrayElementSchema('weapon-parts'))).toBe(text);
  });

  it('правка одной детали меняет ровно одну строку, без чужих умолчаний и в порядке её ключей', () => {
    const sent = asEditorSends(text);
    const i = sent.findIndex((r) => r.id === 'sw-a-xiii');
    sent[i] = { ...sent[i]!, geom: { len: 90, width: 6.3, bal: 0.49, flare: 1, spine: 0 }, form: 'falchion' };
    const out = formatConfigFile(sent, text, arrayElementSchema('weapon-parts'));
    const a = text.split('\r\n'), b = out.split('\r\n');
    expect(b.length).toBe(a.length);
    const diff = a.map((l, k) => (l === b[k] ? -1 : k)).filter((k) => k >= 0);
    expect(diff).toHaveLength(1);
    const row = JSON.parse(b[diff[0]!]!.trim().replace(/,$/, '')) as Record<string, unknown>;
    expect(row.geom).toEqual({ len: 90, width: 6.3, bal: 0.49, flare: 1, spine: 0 });
    expect(row.form).toBe('falchion');
    expect(Object.keys(row).indexOf('id')).toBe(0);
  });

  it('новая деталь дописывается строкой, удалённая исчезает', () => {
    const sent = asEditorSends(text);
    const removed = sent.shift()!;
    sent.push({ ...removed, id: 'zz-new' });
    const out = formatConfigFile(sent, text, arrayElementSchema('weapon-parts'));
    expect(out).not.toContain(`"id": "${String(removed.id)}"`);
    expect(out.split('\r\n').filter((l) => l.includes('"id": "zz-new"'))).toHaveLength(1);
  });

  it('файл не «строка на запись» — прежний формат (JSON с отступом 2)', () => {
    const v = { a: 1, b: [1, 2] };
    expect(formatConfigFile(v, '{\n  "a": 0\n}\n')).toBe(JSON.stringify(v, null, 2) + '\n');
    expect(formatConfigFile([{ id: 'x' }], null)).toBe(JSON.stringify([{ id: 'x' }], null, 2) + '\n');
  });

  it('rowJson пишет как Python json.dumps с разделителями «, » и «: »', () => {
    expect(rowJson({ id: 'а', n: [1, 2], o: { k: true } })).toBe('{"id": "а", "n": [1, 2], "o": {"k": true}}');
  });
});

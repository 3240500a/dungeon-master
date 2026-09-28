/**
 * ⭐ ФАЗЗЕР ПРОТОКОЛА (B3) — чистая часть: генератор чисел по сиду, кривые кадры и усадка последовательности.
 *
 * Здесь нет ни базы, ни комнат, ни vitest: только то, из чего `protocolFuzz.test.ts` собирает прогон. Всё решает сид —
 * одна и та же последовательность операций даёт одни и те же кадры байт в байт, иначе усадка (выбросить операцию и
 * проверить, осталось ли нарушение) гадала бы на кофейной гуще.
 *
 * Кривой кадр строится из ЧЕСТНОГО (того, что шлют веб-2D, веб-3D, мост редактора и Unity) мутациями дерева кадра, а не
 * случайной строкой: так он доходит до глубоких проверок (схема, комната, ядро), а не отсекается первой же скобкой. Дерево
 * держит ключи ПАРАМИ (`Obj`), а не объектом JS: иначе `__proto__` стал бы прототипом, а не ключом, и повтор ключа
 * (`{"t":"input","t":"join"}`) нельзя было бы выразить вовсе.
 */

/** Генератор по сиду (sfc32): быстрый, 128 бит состояния, поток повторяется по сиду. */
export class Prng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  constructor(seed: number) {
    this.a = 0x9e3779b9; this.b = 0x243f6a88; this.c = 0xb7e15162; this.d = seed >>> 0;
    for (let i = 0; i < 12; i++) this.next();
  }
  /** [0, 1). */
  next(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }
  /** Целое в [0, n). */
  int(n: number): number { return Math.floor(this.next() * n); }
  /** Целое в [lo, hi]. */
  range(lo: number, hi: number): number { return lo + this.int(hi - lo + 1); }
  chance(p: number): boolean { return this.next() < p; }
  pick<T>(a: readonly T[]): T { return a[this.int(a.length)]!; }
  /** Выбор по весам: `[вес, значение]`. */
  weighted<T>(a: readonly (readonly [number, T])[]): T {
    let sum = 0;
    for (const [w] of a) sum += w;
    let x = this.next() * sum;
    for (const [w, v] of a) { x -= w; if (x < 0) return v; }
    return a[a.length - 1]![1];
  }
  /** Новый поток из этого (свой сид у каждой операции: выброс соседней её не меняет). */
  fork(): number { return (this.next() * 4294967296) >>> 0; }
}

// ── Дерево кадра ─────────────────────────────────────────────────────────────
/** Кусок JSON как есть (`NaN`, `1e999`, `-0`, битый хвост) — `JSON.stringify` таких не пишет. */
export class Raw { constructor(readonly text: string) {} }
/** Объект ПАРАМИ ключ-значение: повтор ключа и `__proto__` как обычный ключ. */
export class Obj { constructor(readonly pairs: [string, Tree][]) {} }
export type Tree = null | boolean | number | string | Raw | Obj | Tree[];

/** Обычное значение JS → дерево (объекты — парами, в порядке ключей). */
export function toTree(v: unknown): Tree {
  if (v === null || typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(toTree);
  if (v && typeof v === 'object') {
    return new Obj(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).map(([k, x]) => [k, toTree(x)]));
  }
  return null;
}

/** Дерево → текст кадра. Строки — через `JSON.stringify`: непарный суррогат и управляющий символ уходят экраном, как у браузера. */
export function enc(t: Tree): string {
  if (t instanceof Raw) return t.text;
  if (t instanceof Obj) return `{${t.pairs.map(([k, v]) => `${JSON.stringify(k)}:${enc(v)}`).join(',')}}`;
  if (Array.isArray(t)) return `[${t.map(enc).join(',')}]`;
  if (typeof t === 'number') return Number.isFinite(t) ? JSON.stringify(t) : 'null';
  return JSON.stringify(t);
}

/** Все места дерева, куда можно дотянуться: родитель и ключ (номер в массиве или номер пары). */
interface Slot { get(): Tree; set(v: Tree): void; parent: Obj | Tree[] | null; key: number }
function slots(root: { v: Tree }): Slot[] {
  const out: Slot[] = [{ get: () => root.v, set: (v) => { root.v = v; }, parent: null, key: 0 }];
  const walk = (t: Tree, depth: number): void => {
    if (depth > 12) return;
    if (t instanceof Obj) {
      t.pairs.forEach((p, i) => {
        out.push({ get: () => p[1], set: (v) => { p[1] = v; }, parent: t, key: i });
        walk(p[1], depth + 1);
      });
    } else if (Array.isArray(t)) {
      t.forEach((x, i) => {
        out.push({ get: () => t[i]!, set: (v) => { t[i] = v; }, parent: t, key: i });
        walk(x, depth + 1);
      });
    }
  };
  walk(root.v, 0);
  return out;
}
function objects(root: { v: Tree }): Obj[] {
  return slots(root).map((s) => s.get()).filter((t): t is Obj => t instanceof Obj);
}

/** Ключи, которыми честный кадр не пользуется: прототипные, похожие на настоящие, служебные. */
const KEY_POOL = [
  '__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty', 'toJSON', '__defineGetter__',
  't', 'T', 't ', ' t', 'type', 'cmd', 'command', 'id', 'seq', 'input', 'token', 'charId', 'roomCode', 'fresh', 'resume',
  'accept', 'leverId', 'chestId', 'difficultyId', 'targetNodeId', 'runConfig', 'modifiers', 'uid', 'slot', 'maxGold', 'n',
  'x', 'y', 'move', 'facing', 'dodge', 'useBelt', 'cast', 'attack', 'interact', 'nonce', 'parts', 'extra', '', 'a\u0000b',
  '\ud800', 'ключ', '\u202e', '0', '-1', 'length',
];
/** Строки для подмены: управляющие, суррогаты, прототипные, похожие на id, пустые. */
const STR_POOL = [
  '', ' ', 'input', 'join', 'cmd', 'ping', 'INPUT', 'input ', 'input\u0000', 'null', 'undefined', 'NaN', '__proto__', 'constructor',
  'toString', 'hasOwnProperty', 'prototype', 'weapon', 'offhand', 'belt', 'attack', 'normal', 'nightmare', 'town', 'dungeon',
  '\u0000', '\u0001\u0002', '\u001b[31m', '\u007f', '\u0085', '\u2028', '\u2029', '\u202e', '\ufeff', '\ud800', '\udfff', '\ud83d\ude00',
  'a'.repeat(64), 'a'.repeat(65), 'ab'.repeat(32), 'f4'.repeat(32), '0'.repeat(64), 'Z9Z9Z9Z9', 'A2345678', '../../etc/passwd',
  '<script>', '%s%s%n', '{"t":"ping"}', '1', '-1', '1e999', '0x10',
];
/** Числа на краях: огромные, отрицательные, дробные, небезопасные целые. */
const NUM_POOL: Tree[] = [
  0, -1, 1, 2, 7, 15, 16, 31, 32, 63, 64, 65, 255, 1000, 1001, 65535, 2 ** 31 - 1, 2 ** 31, 2 ** 32, -(2 ** 31) - 1,
  2 ** 53 - 1, 2 ** 53, 2 ** 53 + 2, 1e21, 1e308, -1e308, 0.5, -0.5, 1e-320, 3.14159,
  new Raw('-0'), new Raw('1e999'), new Raw('-1e999'), new Raw('NaN'), new Raw('Infinity'), new Raw('0x10'), new Raw('01'),
  new Raw('1.'), new Raw('.5'), new Raw('1e'), new Raw('+1'),
];

/** Случайное значение для подмены: любого типа, в том числе кривого. */
function anyValue(r: Prng, depth = 0): Tree {
  const kind = r.int(depth > 2 ? 5 : 8);
  switch (kind) {
    case 0: return null;
    case 1: return r.chance(0.5);
    case 2: return r.pick(NUM_POOL);
    case 3: return r.pick(STR_POOL);
    case 4: return r.chance(0.5) ? new Obj([]) : [];
    case 5: return Array.from({ length: r.range(1, 4) }, () => anyValue(r, depth + 1));
    case 6: return new Obj(Array.from({ length: r.range(1, 4) }, (): [string, Tree] => [r.pick(KEY_POOL), anyValue(r, depth + 1)]));
    default: return r.pick(STR_POOL) + String(r.int(1000));
  }
}
/** Строка из символов класса: печатные, кириллица, управляющие, суррогаты, скобки, двоеточия. */
function charsOf(r: Prng, n: number): string {
  const cls = r.int(7);
  let s = '';
  for (let i = 0; i < n; i++) {
    switch (cls) {
      case 0: s += String.fromCharCode(97 + r.int(26)); break;
      case 1: s += String.fromCharCode(0x430 + r.int(32)); break;
      case 2: s += String.fromCharCode(r.int(32)); break;
      case 3: s += String.fromCharCode(0xd800 + r.int(0x800)); break;
      case 4: s += r.pick(['{', '[', ':', '"', '\\', ',']); break;
      case 5: s += String.fromCharCode(r.int(0x10000)); break;
      default: s += r.pick(['a', '\u0000', '\u2028', '\ud800', 'я', ' ', '\u202e']); break;
    }
  }
  return s;
}
/** Вложенность глубины `d`: массивы, объекты или смесь. */
function nested(r: Prng, d: number): Tree {
  const style = r.int(3);
  let t: Tree = style === 0 ? 1 : new Obj([]);
  for (let i = 0; i < d; i++) {
    const s = style === 2 ? r.int(2) : style;
    t = s === 0 ? [t] : new Obj([[r.pick(['a', 'x', 'move', 'input', 'command']), t]]);
  }
  return t;
}

/** Одна мутация дерева (на месте) — возвращает её имя для отчёта. */
type Mut = (root: { v: Tree }, r: Prng) => string | null;
const MUTATIONS: readonly (readonly [number, string, Mut])[] = [
  [3, 'drop', (root, r) => {
    const os = objects(root).filter((o) => o.pairs.length);
    if (!os.length) return null;
    const o = r.pick(os);
    const [k] = o.pairs.splice(r.int(o.pairs.length), 1)[0]!;
    return `drop ${k}`;
  }],
  [3, 'add', (root, r) => {
    const os = objects(root);
    if (!os.length) return null;
    const k = r.pick(KEY_POOL);
    r.pick(os).pairs.push([k, anyValue(r)]);
    return `add ${JSON.stringify(k)}`;
  }],
  [2, 'rename', (root, r) => {
    const os = objects(root).filter((o) => o.pairs.length);
    if (!os.length) return null;
    const p = r.pick(r.pick(os).pairs);
    const was = p[0];
    p[0] = r.chance(0.5) ? r.pick(KEY_POOL) : r.pick([was.toUpperCase(), `${was} `, `${was}\u0000`, `_${was}`, was.slice(1)]);
    return `rename ${JSON.stringify(was)}→${JSON.stringify(p[0])}`;
  }],
  [4, 'retype', (root, r) => {
    const ss = slots(root).slice(1);
    if (!ss.length) return null;
    const s = r.pick(ss);
    s.set(anyValue(r));
    return 'retype';
  }],
  [4, 'number', (root, r) => {
    const ss = slots(root).filter((s) => typeof s.get() === 'number');
    const s = ss.length ? r.pick(ss) : r.pick(slots(root).slice(1).length ? slots(root).slice(1) : slots(root));
    const v = r.pick(NUM_POOL);
    s.set(v);
    return `number ${v instanceof Raw ? v.text : String(v)}`;
  }],
  [2, 'deep', (root, r) => {
    const ss = slots(root).slice(1);
    if (!ss.length) return null;
    const d = r.pick([8, 30, 63, 64, 65, 120, 400]);
    r.pick(ss).set(nested(r, d));
    return `deep ${d}`;
  }],
  [2, 'long', (root, r) => {
    const ss = slots(root).filter((s) => typeof s.get() === 'string');
    const s = ss.length ? r.pick(ss) : r.pick(slots(root));
    const n = r.pick([65, 257, 1000, 4000, 15_000]);
    s.set(charsOf(r, n));
    return `long ${n}`;
  }],
  [3, 'ctrl', (root, r) => {
    const ss = slots(root).filter((s) => typeof s.get() === 'string');
    if (!ss.length) return null;
    const s = r.pick(ss);
    const v = s.get() as string;
    const c = r.pick(['\u0000', '\u0007', '\u001f', '\u007f', '\u0085', '\u2028', '\u202e', '\ufeff', '\u200b']);
    const at = r.int(v.length + 1);
    s.set(v.slice(0, at) + c + v.slice(at));
    return `ctrl U+${c.charCodeAt(0).toString(16)}`;
  }],
  [3, 'surrogate', (root, r) => {
    const ss = slots(root).filter((s) => typeof s.get() === 'string');
    if (!ss.length) return null;
    const s = r.pick(ss);
    const v = s.get() as string;
    const c = r.pick(['\ud800', '\udbff', '\udc00', '\udfff']);
    const at = r.int(v.length + 1);
    s.set(v.slice(0, at) + c + v.slice(at));
    return `surrogate U+${c.charCodeAt(0).toString(16)}`;
  }],
  [3, 'proto', (root, r) => {
    const os = objects(root);
    if (!os.length) return null;
    const k = r.pick(['__proto__', 'constructor', 'prototype']);
    const v = r.chance(0.5)
      ? new Obj([['t', 'join'], ['isAdmin', true], ['toString', 1], ['cmd', 'respec'], ['prototype', new Obj([['polluted', true]])]])
      : anyValue(r);
    r.pick(os).pairs.splice(r.int(2), 0, [k, v]);
    return `proto ${k}`;
  }],
  [2, 'arrayify', (root, r) => {
    const ss = slots(root).filter((s) => s.get() instanceof Obj);
    if (!ss.length) return null;
    const s = r.pick(ss);
    const o = s.get() as Obj;
    s.set(r.chance(0.5) ? o.pairs.map(([, v]) => v) : [o]);
    return 'arrayify';
  }],
  [2, 'dupkey', (root, r) => {
    const os = objects(root).filter((o) => o.pairs.length);
    if (!os.length) return null;
    const o = r.pick(os);
    const [k] = r.pick(o.pairs);
    const v = k === 't' ? r.pick<Tree>(['join', 'cmd', 'input', 'ping', 'leave', 'abandon', 'runStatus', 'descend']) : anyValue(r);
    if (r.chance(0.5)) o.pairs.push([k, v]); else o.pairs.unshift([k, v]);
    return `dupkey ${JSON.stringify(k)}`;
  }],
  [2, 't', (root, r) => {
    const o = root.v instanceof Obj ? root.v : null;
    if (!o) return null;
    const p = o.pairs.find(([k]) => k === 't');
    const v: Tree = r.chance(0.7)
      ? r.pick<Tree>(['INPUT', 'input ', ' input', 'Input', 'cmd\u0000', 'join\u202e', '__proto__', 'constructor', 'toString', 'pong',
        'snapshot', 'joined', 'error', '', 'pingg', 'descend', 'leave', 'runStatus', 'abandon', 'vote', 'lever', 'chest', 'arena', 'return'])
      : anyValue(r);
    if (p) p[1] = v; else o.pairs.unshift(['t', v]);
    return `t=${enc(v).slice(0, 24)}`;
  }],
  [1, 'wide', (root, r) => {
    const os = objects(root);
    if (!os.length) return null;
    const o = r.pick(os);
    const n = r.pick([40, 100, 129, 200, 600]);
    for (let i = 0; i < n; i++) o.pairs.push([`k${i}`, r.chance(0.5) ? i : 'v']);
    return `wide ${n}`;
  }],
  [1, 'bigarray', (root, r) => {
    const ss = slots(root).slice(1);
    if (!ss.length) return null;
    const n = r.pick([33, 64, 65, 200, 2000]);
    r.pick(ss).set(Array.from({ length: n }, (_, i) => (r.chance(0.5) ? 0 : `m${i}`)));
    return `bigarray ${n}`;
  }],
  [2, 'strnum', (root, r) => {
    const ss = slots(root).filter((s) => typeof s.get() === 'number');
    if (!ss.length) return null;
    const s = r.pick(ss);
    s.set(String(s.get()));
    return 'strnum';
  }],
  [1, 'empty', (root, r) => {
    const ss = slots(root);
    const s = r.pick(ss);
    const v = r.pick<Tree>([new Obj([]), [], '', null, 0, false]);
    s.set(v);
    return `empty ${enc(v)}`;
  }],
];

/** Мутации самого текста (после сборки): битый хвост, мусор до и после, пробел перед префиксом ввода. */
const TEXT_MUTATIONS: readonly (readonly [number, string, (s: string, r: Prng) => string])[] = [
  [3, 'truncate', (s, r) => s.slice(0, r.int(Math.max(1, s.length)))],
  [1, 'bom', (s) => `\ufeff${s}`],
  [1, 'lead-space', (s) => ` ${s}`],
  [1, 'trail-junk', (s, r) => s + r.pick(['}', ']', ',', ' ', '\u0000', 'x', '{}', '\n'])],
  [1, 'prefix-space', (s) => s.replace(/^\{"t":"([a-zA-Z]+)"/, '{ "t" : "$1"')],
  [1, 'raw-ctrl', (s, r) => { const at = r.int(s.length + 1); return s.slice(0, at) + String.fromCharCode(r.int(32)) + s.slice(at); }],
  [1, 'double', (s) => s + s],
  [1, 'wrap-array', (s) => `[${s}]`],
];

/**
 * Кривой кадр из честного: 1–3 мутации дерева и (иногда) текста. `how` — перечень мутаций для отчёта. Сам кадр может выйти и
 * честным (мутация попала в необязательное поле) — годен он или нет, решает оракул прогона, а не генератор.
 */
export function mutateFrame(base: unknown, seed: number): { raw: string; how: string } {
  const r = new Prng(seed);
  const root = { v: toTree(base) };
  const done: string[] = [];
  const n = r.weighted([[5, 1], [3, 2], [1, 3]] as const);
  for (let i = 0, tries = 0; i < n && tries < 10; tries++) {
    const [, , m] = r.weighted(MUTATIONS.map((x) => [x[0], x] as const));
    const what = m(root, r);
    if (what) { done.push(what); i++; }
  }
  let raw = enc(root.v);
  if (r.chance(0.15)) {
    const [, name, tm] = r.weighted(TEXT_MUTATIONS.map((x) => [x[0], x] as const));
    raw = tm(raw, r);
    done.push(name);
  }
  return { raw, how: done.join(', ') };
}

/** Мусор вместо кадра: байты, похожие на JSON обрывки, пустое, одни скобки. */
export function junkText(seed: number, len: number): { raw: string; how: string } {
  const r = new Prng(seed);
  const style = r.int(6);
  switch (style) {
    case 0: return { raw: charsOf(r, len), how: `chars ${len}` };
    case 1: return { raw: '', how: 'empty' };
    case 2: return { raw: r.pick(['null', 'true', '0', '-1', '"x"', '[]', '{}', '[{}]', '{"t":null}', '{"t":{}}', '{"t":[]}', '{"t":1}', '1e999']), how: 'scalar' };
    case 3: return { raw: '['.repeat(Math.min(len, 60)) + ']'.repeat(Math.min(len, 60)), how: 'brackets' };
    case 4: return { raw: `{"t":"input"${charsOf(r, len)}`, how: 'input-prefix junk' };
    default: return { raw: `{"t":"${r.pick(['join', 'cmd', 'ping', 'runStatus'])}",${charsOf(r, len)}`, how: 'broken object' };
  }
}

/** Случайные байты для двоичного кадра: иногда — корректный UTF-8 честного кадра, иногда — битый UTF-8. */
export function junkBytes(seed: number, len: number, honest?: string): { bytes: Uint8Array; how: string } {
  const r = new Prng(seed);
  if (honest && r.chance(0.4)) return { bytes: new TextEncoder().encode(honest), how: 'binary honest json' };
  const b = new Uint8Array(len);
  for (let i = 0; i < len; i++) b[i] = r.chance(0.2) ? r.pick([0xc0, 0xc1, 0xf5, 0xff, 0xed, 0xa0, 0x80]) : r.int(256);
  return { bytes: b, how: `binary ${len}` };
}

/**
 * ⭐ УСАДКА: выбрасывать операции, пока нарушение остаётся. Сперва кусками (половина, четверть, …), потом по одной — классический
 * ddmin без перебора подмножеств: минимум «по одной» (выброс любой одной убирает нарушение), а не глобальный минимум. `still` —
 * воспроизводится ли нарушение того же вида на наборе; `budget` — потолок прогонов (усадка медленных прогонов не вечна).
 */
export async function shrinkOps<T>(ops: readonly T[], still: (ops: T[]) => Promise<boolean>, budget = 400): Promise<T[]> {
  let cur = [...ops];
  let runs = 0;
  for (let chunk = Math.max(1, Math.floor(cur.length / 2)); chunk >= 1 && runs < budget; chunk = Math.floor(chunk / 2)) {
    let progress = true;
    while (progress && runs < budget) {
      progress = false;
      for (let at = 0; at < cur.length && runs < budget;) {
        const next = [...cur.slice(0, at), ...cur.slice(at + chunk)];
        runs++;
        if (next.length < cur.length && await still(next)) { cur = next; progress = true; } else at += chunk;
      }
    }
  }
  return cur;
}

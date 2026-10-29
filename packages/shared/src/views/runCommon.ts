import type { ConfigRegistry } from '../config/registry.js';
import { Localizer, SOURCE_LANG, cfgKey, type Lang, type Locales } from '../i18n/index.js';

/**
 * ⭐⭐ С-views (29.10): ОБЩЕЕ ДЛЯ ВИДОВ ЗАБЕГА — то, что окна Unity считали «по-сишарпному» и что сервер обязан повторить
 * БИТ В БИТ, раз модель теперь считает он.
 *
 * ⚠⚠ ПОЧЕМУ ЗДЕСЬ СВОЁ ОКРУГЛЕНИЕ. Окна Unity (`Altar.cs`, `SealReforge.cs`) форматировали числа средствами .NET:
 *  • `Math.Round(x)` — БАНКОВСКОЕ округление (0.5 → к чётному), а `Math.round` JS — к большему;
 *  • `x.ToString("0.00")` — пользовательский формат .NET: число сначала сводится к 15 значащим цифрам, потом
 *    округляется «от нуля» по десятичным цифрам, а `toFixed(2)` JS округляет ТОЧНОЕ двоичное значение.
 * Возьми здесь JS-средства — и строка свода «Размер пачки ×1.01» разошлась бы с прежним окном на краях, где игрок
 * этого не ждёт. Поэтому вид зовёт эти две функции, а не стандартные.
 */

/** `Math.Round(double)` .NET — по умолчанию к ЧЁТНОМУ (MidpointRounding.ToEven). */
export function csRound(v: number): number {
  if (!Number.isFinite(v)) return v;
  const f = Math.floor(v);
  const d = v - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/**
 * `v.ToString("0.00")` (InvariantCulture) .NET: 15 значащих цифр, затем округление «от нуля» до `digits` знаков.
 * Значения вида — множители около 1…10; экспоненту `toPrecision` всё равно разбираем, чтобы не врать на краях.
 */
export function csFixed(v: number, digits: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (v === 0) return (0).toFixed(digits);
  const neg = v < 0;
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(Math.abs(v).toPrecision(15));
  if (!m) return v.toFixed(digits);
  const ds = m[1]! + (m[2] ?? '');
  const point = m[1]!.length + (m[3] ? Number.parseInt(m[3], 10) : 0);
  const keep = point + digits;
  const head = keep > 0 ? ds.slice(0, keep).padEnd(keep, '0') : '';
  const next = keep >= 0 && keep < ds.length ? ds.charCodeAt(keep) - 48 : 0;
  let n = BigInt(head || '0');
  if (next >= 5) n += 1n;
  const s = n.toString().padStart(digits + 1, '0');
  const out = digits > 0 ? `${s.slice(0, s.length - digits)}.${s.slice(s.length - digits)}` : s;
  return (neg && n !== 0n ? '-' : '') + out;
}

/** `${n}` JS — то же, что `WorldRules.JsNum` Unity (кратчайшая обратимая запись). */
export function jsNum(v: unknown): string {
  return typeof v === 'number' ? String(v) : v === undefined ? 'undefined' : String(v);
}

/** Число ли (JSON Integer/Float у Newtonsoft). */
export function isNum(v: unknown): v is number {
  return typeof v === 'number' && !Number.isNaN(v);
}

/** Строка ли (у Newtonsoft `Str()` — только `JTokenType.String`). */
export function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** `Or(a, b)` окон Unity: первая непустая строка, иначе null. */
export function orStr(a: unknown, b: unknown): string | null {
  if (typeof a === 'string' && a.length > 0) return a;
  if (typeof b === 'string' && b.length > 0) return b;
  return null;
}

/** Сортировка строк по кодовым единицам UTF-16 — `string.CompareOrdinal` C#. */
export function ordinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Обезвреживание rich text Unity (`VoteText.Esc`): авторский текст конфига и ник игрока не становятся разметкой.
 * ⚠ Это НЕ html-экранирование: окна Unity рисуют uGUI rich text, и угловые скобки там — единственная опасность.
 */
export function richEsc(s: string | null | undefined): string {
  return (s ?? '').replace(/</g, '‹').replace(/>/g, '›');
}

/** Опции языка для всех видов забега. */
export interface RunViewOptions {
  /**
   * Язык игрока. ⚠ Сегодня окна забега Unity не зовут `DmI18n` вовсе — их фразы живут литералами, и `ui:`-ключей для
   * них нет. Поэтому язык переводит только тексты КОНФИГА (имена биомов, тиров, печатей, статов) через `Localizer`
   * и ключи `cfg:` — то же правило, что у предметов; фразы окна остаются русскими, пока для них не заведут ключи.
   * Умолчание — язык-источник (`ru`): тогда вид бит в бит равен прежнему окну.
   */
  lang?: Lang;
}

/** Перевод одной строки конфига: `table/path/field` → текст на языке; нет перевода — исходник. */
export type CfgText = (table: string, path: readonly string[], field: string, source: string | null | undefined) => string | null;

/** Разрешитель строк конфига для языка. Язык-источник — без `Localizer` (исходник и есть ответ). */
export function cfgTextOf(reg: ConfigRegistry | undefined, opts?: RunViewOptions): CfgText {
  const lang = opts?.lang ?? SOURCE_LANG;
  const pass: CfgText = (_t, _p, _f, source) => source ?? null;
  if (!reg || lang === SOURCE_LANG) return pass;
  let loc: Localizer;
  try {
    loc = new Localizer(reg.get('locales') as Locales, lang);
  } catch {
    return pass;
  }
  return (table, path, field, source) => (source == null ? null : loc.text(cfgKey(table, path, field), source));
}

/** Цвета узлов забега (показ) — `WorldRules.NodeColors` Unity, веб `runLabels.RUN_NODE_COLOR`. */
export const RUN_NODE_COLOR: Readonly<Record<string, number>> = {
  start: 0x9fd0ff,
  combat: 0x8a8f9a,
  elite: 0xd0a040,
  boss: 0xd05050,
  treasure: 0xf0d070,
  rest: 0x8a5cff,
};

/** Цвет узла: нет в таблице — серый боя (`WorldRules.NodeColor`). */
export function runNodeColor(type: string | null | undefined): number {
  return (type != null ? RUN_NODE_COLOR[type] : undefined) ?? 0x8a8f9a;
}

/** `#rrggbb` (`RunMapLayout.Hex`). */
export function hex6(rgb: number): string {
  return '#' + (rgb & 0xffffff).toString(16).padStart(6, '0');
}

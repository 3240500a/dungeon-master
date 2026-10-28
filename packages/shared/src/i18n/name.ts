/**
 * ⭐⭐ СБОРКА ИМЕНИ ПО ШАБЛОНУ ЛОКАЛИ — порядок слов и связки живут в ДАННЫХ, не в коде.
 *
 * Имена вещей у нас не хранятся, а собираются: 430 тысяч возможных сочетаний (замер) — выписать нельзя,
 * и так же собирают Grim Dawn, Guild Wars 2 и PoE. Но порядок слов русский: «Кровавый меч ранней эпохи с
 * навершием». В английском прилагательное тоже впереди, в испанском — ПОЗАДИ и со связкой («espada de
 * fuego»), в китайском — без пробелов вовсе. Поэтому шаблон — строка локали, а не литерал кода.
 *
 * ⚠ ГРАНИЦА, КОТОРУЮ НЕЛЬЗЯ СТИРАТЬ: по шаблону собираются только ИМЕНА. Предложение (тултип, описание,
 * сообщение) — всегда ОДНА строка с подстановками, никогда склейка фрагментов. Правило из Unreal: не
 * вставляй имя вещи в тултип — заведи тултип на вещь. Из того же следует вторая дисциплина: строка,
 * участвующая в сборке имени, нигде больше в интерфейсе не переиспользуется. На нарушении этого Last
 * Epoch получил «случайные пробелы» в китайских аффиксах.
 *
 * ### Шаблон
 * `{слот}` — подстановка, `{слот:lower}` — со строчной буквы (русскому нужно внутри фразы: «Меч» → «меч»).
 * Всё остальное — литерал: пробелы, запятые, связки вроде `de`.
 *
 * ⚠ ЛИТЕРАЛ МЕЖДУ ПУСТЫМИ СЛОТАМИ НЕ ВЫВОДИТСЯ. Пустые слоты — норма, а не ошибка: у клинка без навершия
 * слот `{head.pommel.with}` пуст, и дословная подстановка дала бы висящую связку («espada de» без слова).
 * Правило: литерал между двумя слотами выводится, только если НЕПУСТЫ ОБА; литерал в начале и в конце —
 * только если непуст соседний слот. Пробельный литерал заменяется на разделитель языка (`grammar.join`),
 * поэтому китайскому не нужно переписывать ни один шаблон — достаточно `join: ""`.
 */

import { DEFAULT_GRAMMAR, type LangGrammar } from './forms.js';

/** Шаг разбора шаблона: ссылка на слот либо литеральный текст между ссылками. */
type Token = { slot: string; mod?: string } | { lit: string };

const TOKEN = /\{([^}]+)\}/g;

/** Разбирает шаблон на ссылки и литералы. */
function tokenize(tpl: string): Token[] {
  const out: Token[] = [];
  let at = 0;
  for (const m of tpl.matchAll(TOKEN)) {
    if (m.index > at) out.push({ lit: tpl.slice(at, m.index) });
    const [slot, mod] = m[1]!.split(':');
    out.push({ slot: slot!.trim(), mod: mod?.trim() });
    at = m.index + m[0].length;
  }
  if (at < tpl.length) out.push({ lit: tpl.slice(at) });
  return out;
}

/**
 * ⚠ РЕГИСТР БЕЗ ЛОКАЛИ ХОЗЯИНА. Было `toLocaleUpperCase()` — то есть правила ОС того, кто запустил
 * процесс: на турецком хосте `i` даёт `İ`, и одно и то же имя выходит разным у сервера, у редактора
 * и у игрока. Чистая функция, по которой считаются золотые эталоны, не вправе зависеть от среды —
 * и портировать её в C# в таком виде нельзя вовсе. Берём отображение без локали.
 *
 * ⚠ Остаток, который портом НЕ закрыт: JS делает ПОЛНОЕ юникодное отображение (`ß` → `SS`, `ﬁ` →
 * `FI`), а .NET — только простое, буква в букву. На русском это не видно (замер: кириллица
 * отображается одинаково), оживёт на латинском переводе, если имя начнётся с лигатуры. Решать это
 * вместе с включением первого латинского языка: либо таблица полного отображения в C#, либо правило
 * «заглавную не ставим» у таких языков данными (`capitalize: "none"`).
 */
const upFirst = (s: string): string => {
  const i = s.search(/\p{L}/u);
  return i < 0 ? s : s.slice(0, i) + s[i]!.toUpperCase() + s.slice(i + 1);
};

const lowFirst = (s: string): string => {
  const i = s.search(/\p{L}/u);
  return i < 0 ? s : s.slice(0, i) + s[i]!.toLowerCase() + s.slice(i + 1);
};

/**
 * ⚠ РЕГИСТР МЕНЯЕТСЯ У ТОКЕНА, А НЕ ПОДСТРОКОЙ. В русском PoE заглавные ставили подстановочной заменой, и
 * вышло «поЛукафтан»: замена нашла подстроку внутри слова. Здесь регистр правится только у первой буквы
 * собранного имени или у конкретного слота — позиционно, без поиска по тексту.
 */
function applyMod(value: string, mod: string | undefined): string {
  if (mod === 'lower') return lowFirst(value);
  if (mod === 'upper') return upFirst(value);
  return value;
}

/**
 * Собирает имя: подставляет слоты в шаблон локали, выбрасывает литералы при пустых слотах, приводит
 * пробельные разделители к разделителю языка и ставит заглавную букву по правилу языка.
 */
export function fillNameTemplate(
  tpl: string,
  slots: Readonly<Record<string, string>>,
  grammar: LangGrammar = DEFAULT_GRAMMAR,
): string {
  const toks = tokenize(tpl);
  // значение каждой ссылки — заранее, чтобы решить судьбу соседних литералов
  const value = toks.map((t) => ('slot' in t ? applyMod((slots[t.slot] ?? '').trim(), t.mod) : ''));
  const filled = toks.map((t, i) => 'slot' in t && value[i] !== '');

  const out: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if ('slot' in t) { if (filled[i]) out.push(value[i]!); continue; }
    // ближайшие ссылки слева и справа — решают, нужен ли литерал вообще
    let left: boolean | undefined;
    for (let j = i - 1; j >= 0; j--) if ('slot' in toks[j]!) { left = filled[j]; break; }
    let right: boolean | undefined;
    for (let j = i + 1; j < toks.length; j++) if ('slot' in toks[j]!) { right = filled[j]; break; }
    const needed = left === undefined ? right !== false : right === undefined ? left : left && right;
    if (!needed) continue;
    // ⚠ Разделитель ставится ТОЛЬКО там, где в шаблоне был пробел: из «{a}» не должно выйти «« Меч »».
    const inner = t.lit.trim();
    const lead = /^\s/.test(t.lit) ? grammar.join : '';
    const trail = /\s$/.test(t.lit) ? grammar.join : '';
    out.push(inner === '' ? grammar.join : lead + inner + trail);
  }

  const joined = out.join('').replace(/[ \t]{2,}/g, grammar.join === ' ' ? ' ' : grammar.join).trim();
  return (grammar.capitalize ?? 'first') === 'none' ? joined : upFirst(joined);
}

/**
 * ИМЕНА ШАБЛОНОВ СБОРКИ — ключи в `locales[lang].templates`. Это не вся сборка имён: шаблоны оружейных
 * семейств живут в самих данных (`weapon-types[].fallback.template`, 10 штук) и переводятся как обычный
 * текст, поэтому переводчик может переставить в них слоты — так же устроен живой API Guild Wars 2.
 * Здесь — четыре общих формы имени вещи, которые сегодня захардкожены в `formulas/itemgen.ts`.
 */
export const NAME_TEMPLATES = {
  /** Ступень + база: «Кровавый меч». Прилагательное согласуется с базой. */
  tiered: 'item.tiered',
  /** D2-магия: слово-префикс + база + слово-суффикс. Суффикс в родительном, инвариантен. */
  magic: 'item.magic',
  /** База + титул: «Меч тёмных братьев». */
  titled: 'item.titled',
  /** Рар: база + основа + эпитет: «Меч искры жажды». */
  rare: 'item.rare',
} as const;

/** Шаблоны по умолчанию — ТЕКУЩИЙ русский порядок слов, слово в слово как в `formulas/itemgen.ts`. */
export const DEFAULT_NAME_TEMPLATES: Readonly<Record<string, string>> = {
  [NAME_TEMPLATES.tiered]: '{tier} {base}',
  [NAME_TEMPLATES.magic]: '{prefix} {base} {suffix}',
  [NAME_TEMPLATES.titled]: '{base} {title}',
  [NAME_TEMPLATES.rare]: '{base} {noun} {epithet}',
};

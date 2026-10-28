/**
 * ⭐⭐ ГРАММАТИКА — ДАННЫЕ ЯЗЫКА, А НЕ КОД ФОРМУЛЫ.
 *
 * Сегодня русское согласование зашито в КОД, и притом в четырёх независимых реализациях:
 *   • `formulas/craftType.ts` → `agree(phrase, gender)` — окончания `ая`/`яя`/`ое`/`ые` для `{…adj}` шаблона;
 *   • `formulas/itemgen.ts`   → `declineTier(adj, gender)` — то же для префикса ступени, плюс `magicName`;
 *   • Unity `UI/DmTownCraft.cs`   → `Agree(...)` — БОГАЧЕ TS-версии (мягкие основы, шипящие, `ий`/`ой`);
 *   • Unity `UI/DmTownUpgrade.cs` → `DeclineTier(...)`.
 * В паритете их держат только золотые эталоны. Для любого языка кроме русского эта арифметика окончаний
 * выдаёт мусор, а порядок слов в шаблоне (`{adj} {noun} {epoch} {with}`) — русский.
 *
 * Решение: фрагмент несёт СВОИ ФОРМЫ, а код только ВЫБИРАЕТ форму. Тогда язык добавляется данными, а
 * специфичного для языка кода не остаётся вовсе — ни в TS, ни в C#.
 *
 * ```json
 * // ru: формы прилагательного по роду и числу существительного
 * "cfg:item-tiers/t3/name": { "m": "Кровавый", "f": "Кровавая", "n": "Кровавое", "pl": "Кровавые" }
 * // en: согласования нет — одна форма
 * "cfg:item-tiers/t3/name": "Bloody"
 * // es: род и число, но свои
 * "cfg:item-tiers/t3/name": { "m": "Sangriento", "f": "Sangrienta", "pl.m": "Sangrientos", "pl.f": "Sangrientas" }
 * ```
 *
 * ⚠ Побочная выгода: арифметика окончаний ВСЕГДА врёт на нерегулярных прилагательных, а явные формы — нет.
 * ⚠ Побочное следствие: род существительного — свойство ЯЗЫКА, а не вещи. «меч» мужского рода, `sword`
 * рода не имеет, `espada` — ЖЕНСКОГО. Поэтому согласование живёт в записи перевода, а поле `gender` у вещи
 * (`items-base[].gender`, `weapon-anatomy` варианты существительного — 232 записи) остаётся русским запасом.
 *
 * Замер 26.10: форм требуют 82 фрагмента-прилагательных (русский 4 формы → 328 строк), голов 576 (им нужен
 * только признак рода на язык), инвариантных 192 (одна строка), шаблонов порядка слов 10 + 4.
 */

/**
 * ⭐ ЗАКРЫТЫЙ СЛОВАРЬ ПРИЗНАКОВ СОГЛАСОВАНИЯ. Словарь закрыт намеренно: в WoW признаки накопились двумя
 * несовместимыми нумерациями, и до сих пор живут обе. Значения взяты из CLDR `grammaticalFeatures`:
 * род — `masculine/feminine/neuter/common`, число — `singular/plural`, падеж — латинские имена.
 * Короткие токены, а не полные имена CLDR, потому что таблицу форм правят руками в редакторе.
 */
export const AGREEMENT_FEATURES = {
  /** Род. `c` — общий (есть в шведском/датском; у нас не используется, но словарь закрыт заранее). */
  gender: ['m', 'f', 'n', 'c'],
  /** Число. */
  number: ['sg', 'pl'],
  /**
   * Падеж. ⚠ СЕГОДНЯ НЕ ИСПОЛЬЗУЕТСЯ: имя вещи всегда в именительном, и ни одно игроцкое предложение
   * не вставляет имя внутрь себя (замер). Словарь падежей заложен, чтобы формат ключа не менялся, если
   * решение когда-нибудь пересмотрят, — но ЗАПОЛНЯТЬ падежи не надо, это ×6 работы переводчику.
   */
  case: ['nom', 'gen', 'dat', 'acc', 'ins', 'loc'],
} as const;

/** Все допустимые токены признака — для сторожа: ключ формы вне словаря должен падать на тестах. */
export const AGREEMENT_TOKENS: ReadonlySet<string> = new Set<string>([
  ...AGREEMENT_FEATURES.gender, ...AGREEMENT_FEATURES.number, ...AGREEMENT_FEATURES.case,
]);

/**
 * Согласование: токены признаков через точку, например `f`, `pl`, `f.sg`, `gen.pl.f`. Порядок токенов
 * при ЧТЕНИИ не важен (разбираем по словарю), при ЗАПИСИ канонический — падеж, число, род.
 * Пустая строка — язык не согласует (английский, китайский).
 */
export type Agreement = string;

/** Набор форм фрагмента: одна строка — одна форма на все случаи; запись — формы по согласованию. */
export type FormSet = string | Readonly<Record<string, string>>;

/** Разбирает строку согласования в признаки. Неизвестный токен молча игнорируется (сторож ловит его на тестах). */
function parseAgreement(a: Agreement): { c?: string; n?: string; g?: string } {
  const out: { c?: string; n?: string; g?: string } = {};
  for (const tok of a.split('.')) {
    if ((AGREEMENT_FEATURES.gender as readonly string[]).includes(tok)) out.g = tok;
    else if ((AGREEMENT_FEATURES.number as readonly string[]).includes(tok)) out.n = tok;
    else if ((AGREEMENT_FEATURES.case as readonly string[]).includes(tok)) out.c = tok;
  }
  return out;
}

/** Канонический ключ из признаков: падеж, число, род — через точку, пустые пропущены. */
export function agreementKey(f: { c?: string; n?: string; g?: string }): Agreement {
  return [f.c, f.n, f.g].filter((x): x is string => !!x).join('.');
}

/**
 * Кандидаты ключей от самого точного к самому общему. Признаки отбрасываются в порядке «падеж → число →
 * род»: род держится дольше всех, потому что согласование в наших данных — это прежде всего род.
 * Для `nom.sg.f`: `nom.sg.f` → `sg.f` → `nom.f` → `f` → `nom.sg` → `sg` → `nom`.
 */
function candidates(a: Agreement): string[] {
  const { c, n, g } = parseAgreement(a);
  const out: string[] = [];
  const push = (f: { c?: string; n?: string; g?: string }): void => {
    const k = agreementKey(f);
    if (k && !out.includes(k)) out.push(k);
  };
  push({ c, n, g });
  push({ n, g });
  push({ c, g });
  push({ g });
  push({ c, n });
  push({ n });
  push({ c });
  return out;
}

/** Запасы, когда согласование не сошлось ни с одним ключом: общая форма → мужской род → единственное число. */
const FALLBACK_ORDER: readonly string[] = ['one', 'm', 'sg', 'n', 'f', 'pl'];

/**
 * Выбирает форму фрагмента под согласование существительного. ЕДИНСТВЕННОЕ место, где в коде остаётся
 * что-то про согласование, — и оно не знает ни одного языка.
 */
export function pickForm(forms: FormSet | undefined, agreement?: Agreement): string {
  if (forms === undefined) return '';
  if (typeof forms === 'string') return forms;
  if (agreement) {
    for (const k of candidates(agreement)) {
      const v = forms[k];
      if (typeof v === 'string') return v;
    }
  }
  for (const f of FALLBACK_ORDER) {
    const v = forms[f];
    if (typeof v === 'string') return v;
  }
  const first = Object.values(forms).find((v) => typeof v === 'string');
  return typeof first === 'string' ? first : '';
}

/**
 * Согласование, которое НЕСЁТ сам фрагмент-существительное (если перевод его объявил).
 * Ключ `agreement` — канонический; `gender` принимается как привычное имя того же поля.
 */
export function formAgreement(forms: FormSet | undefined): Agreement | undefined {
  if (forms === undefined || typeof forms === 'string') return undefined;
  const g = forms.agreement ?? forms.gender;
  return typeof g === 'string' && g ? normalizeAgreement(g) : undefined;
}

/**
 * ⭐ Приводит СТАРОЕ поле `gender` конфига к словарю признаков. В конфиге значение `p` означает «вещь
 * называется во множественном числе» («Сапоги», «Перчатки») — это ЧИСЛО, а не род, и в закрытом словаре
 * ему место под `pl`. Поле в данных не трогаем: 232 записи, и переписывать их ради имени токена — лишний
 * риск и шевеление золотых эталонов. Приводим на входе.
 */
export function normalizeAgreement(legacy: string | undefined): Agreement {
  if (!legacy) return '';
  if (legacy === 'p') return 'pl';
  const { c, n, g } = parseAgreement(legacy);
  return agreementKey({ c, n, g });
}

/** Правила сборки имени на языке. Всё, что раньше было «кодом про русский». */
export interface LangGrammar {
  /** Чем склеиваются части имени: пробел у ru/en/es, пустая строка у zh/ja. */
  readonly join: string;
  /** Согласует ли язык фрагменты-прилагательные с существительным: ru/es — да, en/zh — нет. */
  readonly agrees: boolean;
  /**
   * Заглавная буква собранного имени: `first` — первая буква всего имени (так сегодня и работает),
   * `none` — не трогать (нужно языкам, где регистр несёт смысл или его просто нет).
   */
  readonly capitalize?: 'first' | 'none';
}

/** Умолчание: язык с пробелами и согласованием (как русский). Для языка без правил — безопасный выбор. */
export const DEFAULT_GRAMMAR: LangGrammar = { join: ' ', agrees: true, capitalize: 'first' };

/**
 * Склеивает части имени по правилам языка: пустые части выбрасываются, лишние пробелы сводятся к одному.
 * ⚠ Пустые части — норма: шаблон имени оружия ссылается на слоты деталей, которых у вещи может не быть
 * (`{head.pommel.with}` у клинка без навершия), и сегодня их отсутствие тоже даёт пустую подстановку.
 */
export function joinParts(parts: readonly string[], grammar: LangGrammar = DEFAULT_GRAMMAR): string {
  return parts.map((p) => p.trim()).filter((p) => p).join(grammar.join).replace(/\s+/g, ' ').trim();
}

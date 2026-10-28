/**
 * ⭐⭐ КЛЮЧИ ИГРОЦКОГО ТЕКСТА — одна реализация на ТРИ потребителя: извлекатель (`tools/i18n`), рантайм
 * (`t`, `cfgText`) и сторожа. Схема ключей, разъехавшаяся между извлекателем и рантаймом, — это молчаливо
 * непереведённый текст в игре, который видно только игроку, поэтому derivation живёт здесь и больше нигде.
 *
 * **Ключ конфига:** `cfg:<таблица>/<путь по id>/<поле>` — например `cfg:items-base/quilted-cap/name`.
 * Путь идёт по `id`-подобным полям, а НЕ по индексу: вставленная в середину списка вещь не должна сдвигать
 * ключи всех остальных (иначе каждая правка контента обнуляет часть перевода). Замер 27.10 на живых данных:
 * 3 898 игроцких строк, коллизий ключей — 0, ключей по индексу — 0.
 *
 * **Ключ кода:** `ui:<область>.<вещь>` — например `ui:town.forge.title`. У литерала в коде нет естественного
 * пути, поэтому ключ авторский; русский источник таких ключей лежит в `locales` под языком `ru`.
 */

/** Язык: код по BCP-47 в нижнем регистре (`ru`, `en`, `es`, `zh`). Язык по умолчанию и запас — `ru`. */
export type Lang = string;

/** Язык-источник: на нём написан контент, и он же запас, если перевода нет. */
export const SOURCE_LANG: Lang = 'ru';

/**
 * ПОЛЯ, В КОТОРЫХ ЖИВЁТ ИГРОЦКИЙ ТЕКСТ. Список НЕ угадан — снят замером: собраны все поля конфига, чьё
 * значение содержит кириллицу (26.10, 23 поля), и из них руками отобраны видимые игроку.
 *
 * ⚠ Сюда входят ФРАГМЕНТЫ СБОРКИ ИМЁН (`adj`, `with`, `epoch`, `word`, `t`, `name2h`, `template`): имена
 * вещей у нас не хранятся, а собираются из частей по шаблону. Пропустить их — значит получить вещь, у
 * которой переведено описание и не переведено имя.
 */
export const I18N_TEXT_FIELDS: readonly string[] = [
  'name', 'name2h', 'title', 'subtitle', 'tagline', 'label', 'caption',
  'description', 'desc', 'lore',
  // фрагменты и шаблоны сборки имён
  'template', 'text', 'adj', 'with', 'epoch', 'word', 't', 'short',
];

/**
 * ⚠ ПОЛЯ С КИРИЛЛИЦЕЙ, КОТОРЫЕ ИГРОК НЕ ВИДИТ — перечислены явно, чтобы следующий замер не выдал их за
 * пропущенные: `ref` и `source` — скрытая историческая справка ковки (решение владельца: `ref` не
 * показывается), `note` — заметки автора в сырье, `code` — код детали, `seam` — имя кодового шва в
 * `run-mod-stats` (для редактора и документов).
 */
export const I18N_INTERNAL_FIELDS: readonly string[] = ['ref', 'source', 'note', 'code', 'seam'];

/**
 * ТАБЛИЦЫ, ТЕКСТ КОТОРЫХ ИГРОК НЕ ВИДИТ. Арт-манифест (`art`) — имена мешей и материалов в паспортах,
 * `textures`/`models` — имена файлов, `objects`/`room-prefabs`/`environment` — декор и окружение, их подписи
 * нужны только редактору. Замер: исключение снимает 223 строки из 3 817.
 */
export const I18N_SKIP_TABLES: ReadonlySet<string> = new Set([
  'art', 'textures', 'models', 'objects', 'room-prefabs', 'environment',
  /**
   * ⚠⚠ САМА ТАБЛИЦА ПЕРЕВОДОВ — тоже мимо. Иначе обходчик извлекает САМОНАЗВАНИЯ ЯЗЫКОВ («Русский»,
   * «English», «Español», «简体中文») как строки под перевод, а самоназвание на то и самоназвание, что в
   * списке языков выглядит одинаково на любом языке. Поймано расхождением замеров: отчёт давал 3 898 строк,
   * а заготовки записались на 3 902 — ровно четыре имени языков.
   */
  'locales',
]);

/** Поля, по которым строится СТАБИЛЬНЫЙ путь ключа. `tag` — опора клинковых вилок (`short`/`arming`/…). */
const ID_FIELDS: readonly string[] = ['id', 'key', 'classId', 'branchId', 'tag', 'stat', 'slot'];

/**
 * Опора строки списка — `id`-подобное поле, и ничего больше. Индекс остаётся последним запасом, и сторож
 * на него ругается: на живых данных 27.10 до него не доходит ни одна строка из 3 898.
 *
 * ⚠⚠ ОПОРА НА ТЕКСТ ФРАГМЕНТА БЫЛА ОШИБКОЙ, И ЕЁ ТУТ БОЛЬШЕ НЕТ. Соблазн понятен: правка слова даёт новый
 * ключ, и по смыслу это даже верно — другое слово есть другой перевод. Но редактор правит русский
 * ПОСТОЯННО, и тогда любая опечатка в «Пепел» осиротила бы перевод на всех языках сразу. Так же нельзя
 * опираться и на УСЛОВИЕ (`when`) варианта существительного: условие — балансные данные, и правка порога
 * длины клинка осиротила бы слово, которое не менялось. Поэтому записям без `id` их выдали: 75 фрагментов
 * имён раров и 4 варианта существительного меча. Тот же выбор сделан в PoE — пулы слов адресуются записью.
 */
function anchor(node: unknown, index: number): { seg: string; stable: boolean } {
  if (node !== null && typeof node === 'object') {
    const row = node as Record<string, unknown>;
    for (const f of ID_FIELDS) {
      const v = row[f];
      if (typeof v === 'string' && v) return { seg: v, stable: true };
    }
  }
  return { seg: String(index), stable: false };
}

/** Ключ текста таблицы конфига. */
export function cfgKey(table: string, path: readonly string[], field: string): string {
  return path.length ? `cfg:${table}/${path.join('/')}/${field}` : `cfg:${table}/${field}`;
}

/** Найденная игроцкая строка конфига. */
export interface ConfigText {
  /** Ключ вида `cfg:items-base/quilted-cap/name`. */
  key: string;
  /** Текст на языке-источнике — он же запас, если перевода нет. */
  source: string;
  /** Таблица, из которой он взят. */
  table: string;
  /** Поле строки (`name`, `description`, `adj`…). */
  field: string;
  /** ⚠ false — путь пошёл по ИНДЕКСУ: ключ поедет от переупорядочивания, сторож на это ругается. */
  stable: boolean;
}

/**
 * Обходит сырые данные конфига и возвращает ВСЕ игроцкие строки с ключами. Берёт сырые данные
 * (`Record<string, unknown>`), а не реестр: так одинаково работает по встроенным файлам, по телу
 * `/api/config` и по снимку сервера.
 */
export function walkConfigText(raw: Record<string, unknown>): ConfigText[] {
  const out: ConfigText[] = [];
  const text = new Set(I18N_TEXT_FIELDS);

  const walk = (node: unknown, table: string, path: string[], stable: boolean): void => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => {
        const a = anchor(item, i);
        walk(item, table, [...path, a.seg], stable && a.stable);
      });
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const row = node as Record<string, unknown>;
    for (const [field, value] of Object.entries(row)) {
      if (typeof value === 'string') {
        if (text.has(field) && value.trim()) {
          out.push({ key: cfgKey(table, path, field), source: value, table, field, stable });
        }
        continue;
      }
      if (value !== null && typeof value === 'object') walk(value, table, [...path, field], stable);
    }
  };

  for (const [table, value] of Object.entries(raw)) {
    if (I18N_SKIP_TABLES.has(table)) continue;
    walk(value, table, [], true);
  }
  return out;
}

/** Транслитерация для достройки `id` записи из её текста. Схема одна на проект — иначе достроенные
 * id разойдутся с отгружаемыми, и старый оверрайд получит ДРУГИЕ ключи перевода. */
const TRANSLIT: Readonly<Record<string, string>> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k',
  л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c',
  ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/**
 * Читаемый слаг из текста — опора `id` для записи, у которой его нет (оверрайд старше поля).
 * ⚠ Это ВОССТАНОВЛЕНИЕ, а не способ заводить ключи: у отгружаемых данных `id` проставлены явно,
 * потому что ключ, держащийся за текст, осиротит перевод при первой же правке слова.
 */
export function textSlug(s: string): string {
  const out: string[] = [];
  for (const ch of s.trim().toLowerCase()) {
    out.push(TRANSLIT[ch] ?? (/[a-z0-9]/.test(ch) ? ch : '-'));
  }
  return out.join('').split('-').filter(Boolean).join('-');
}

/** Подстановки `{имя}` в строке — для сторожа паритета: у перевода обязан быть ТОТ ЖЕ набор слотов. */
export function placeholders(s: string): string[] {
  return [...s.matchAll(/\{([a-zA-Z0-9_.-]+)\}/g)].map((m) => m[1]!).sort();
}

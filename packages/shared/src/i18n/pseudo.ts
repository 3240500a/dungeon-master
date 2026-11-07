/**
 * ⭐⭐ i18n Ф2 (06.11): ПСЕВДОЯЗЫК — перевод, в котором КАЖДЫЙ ключ корпуса (`cfg:` конфига, `srv:` кода сервера и ⭐ 07.11 `ui:` клиента Unity) есть, и ни в одном нет
 * кириллицы: исходник транслитерирован буква в букву («Нет места в сумке» → «Net mesta v sumke»), `{слоты}` и знаки (`⚠`, `·`, `«»`)
 * целы. Отсюда сторож утечек: всё, что сервер собрал на таком языке и в чём осталась хоть одна кириллическая буква, собрано МИМО шва —
 * литерал без `tr`, текст конфига без `cfgText`, запечённое имя без показа (`itemDisplayName`). Тот же приём (pseudo-localization) —
 * у Microsoft и Android: дыру видно на первом же экране, а не у первого иностранного игрока.
 *
 * Нужен тестам (`i18n/leakGuard.test.ts`, `server/net/room.leak.test.ts`) и редактору (предпросмотр «что останется русским»).
 */
import { walkConfigText } from './keys.js';
import type { FormSet } from './forms.js';
import type { Lang } from './keys.js';
import { SRV_CORPUS } from './srvCorpus.js';
import { UI_CORPUS } from './uiCorpus.js';
import type { LocalePack, Locales } from './index.js';

const LOWER: Readonly<Record<string, string>> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu',
  я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g',
};

/** Кириллическая буква (весь блок U+0400–U+04FF и дополнение) — то, чего в выводе псевдоязыка быть не должно. */
export const CYRILLIC = /[Ѐ-ӿԀ-ԯ]/;

/** Транслитерация с сохранением регистра первой буквы; неизвестная кириллица — `?` (видно, но не кириллица). */
export function pseudoText(s: string): string {
  return s.replace(/[Ѐ-ӿԀ-ԯ]/g, (ch) => {
    const low = ch.toLowerCase();
    const t = LOWER[low] ?? '?';
    return ch === low || !t ? t : t[0]!.toUpperCase() + t.slice(1);
  });
}

/** Перевод одной записи корпуса: строка — строкой, формы по числу — теми же категориями. */
export function pseudoForms(src: FormSet): FormSet {
  if (typeof src === 'string') return pseudoText(src);
  return Object.fromEntries(Object.entries(src).map(([k, v]) => [k, pseudoText(v)]));
}

/**
 * Таблица языков `base` + псевдоязык `lang` (включён), переведённый целиком: все `cfg:` сырых данных `raw` (тот же обход, что у
 * извлекателя), все `srv:` корпуса кода и все `ui:` корпуса клиента. Грамматика — пробел, без согласования (у транслита нет рода), заглавная — как у источника.
 */
export function pseudoLocales(base: Locales | undefined, raw: Record<string, unknown>, lang: Lang = 'xx'): Locales {
  const strings: Record<string, FormSet> = {};
  for (const c of walkConfigText(raw)) strings[c.key] = pseudoText(c.source);
  for (const [k, v] of Object.entries(SRV_CORPUS)) strings[k] = pseudoForms(v);
  for (const [k, v] of Object.entries(UI_CORPUS)) strings[k] = pseudoForms(v);   // ⭐ 07.11: и фразы клиента Unity (`ui:`)
  const pack: LocalePack = {
    name: 'Pseudo', enabled: true, grammar: { join: ' ', agrees: false, capitalize: 'first' }, templates: {}, strings,
  };
  return { ...(base ?? {}), [lang]: pack } as Locales;
}

/** Все кириллические места в тексте `json` — с окрестностью, для отчёта сторожа («где утекло»). */
export function cyrillicLeaks(json: string, allow: readonly string[] = [], around = 40): string[] {
  let text = json;
  for (const a of allow) text = text.split(a).join('');
  const out: string[] = [];
  const re = /[Ѐ-ӿԀ-ԯ]+/g;
  let m: RegExpExecArray | null;
  let last = -1;
  while ((m = re.exec(text))) {
    if (m.index < last) continue;
    const from = Math.max(0, m.index - around), to = Math.min(text.length, m.index + m[0].length + around);
    out.push(text.slice(from, to));
    last = to;
  }
  return out;
}

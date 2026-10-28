/**
 * ⭐⭐ ЕДИНЫЙ ШОВ СБОРКИ ИМЕНИ ВЕЩИ — на любом языке.
 *
 * До этого имя собирали четыре места с русским порядком слов и русской арифметикой окончаний внутри
 * (`tieredName`, `magicName`, `titledName`, `rareItemName` в `itemgen.ts`). Теперь все четыре — ОДНА
 * функция: порядок слов берётся из шаблона языка, формы — из таблицы переводов, а русская арифметика
 * осталась запасом на один язык (`ruAgree`) и умирает по мере заполнения форм.
 *
 * ### Что считается чем
 * | роль | слоты | что с ними делается |
 * |---|---|---|
 * | голова | `base` | НЕСЁТ согласование: его объявляет перевод, запас — `items-base[].gender` |
 * | согласуемое | `tier`, `prefix`, `title` | прилагательное: берётся форма под согласование головы |
 * | инвариант | `suffix`, `noun`, `epithet` | родительный падеж, вставляется как есть |
 *
 * ⚠ Согласование — свойство ЯЗЫКА, а не вещи: «меч» мужского рода, `sword` рода не имеет, `espada` —
 * ЖЕНСКОГО. Поэтому `spec.agreement` (русский `gender` из конфига) — только запас, а главный источник —
 * `loc.agreementOf(base.key)`: его объявляет сама запись перевода существительного.
 *
 * ⚠ ИМЯ ВСЕГДА В ИМЕНИТЕЛЬНОМ. Падежей в таблице форм нет и заполнять их не надо: ни одно игроцкое
 * предложение не вставляет имя вещи внутрь себя (замер 26.10), а значит падежи — это ×6 работы
 * переводчику без единого видимого следствия. Так же сделано в Grim Dawn. Если это когда-нибудь
 * изменится, формат ключа формы уже готов (`gen.pl.f`) — менять придётся данные, не код.
 */

import type { Localizer } from '../i18n/index.js';
import { NAME_TEMPLATES, SOURCE_LANG, normalizeAgreement } from '../i18n/index.js';
import { ruAgree } from './ruAgree.js';

/** Форма имени: какой шаблон локали собирает вещь этой редкости. */
export type NameShape = 'tiered' | 'magic' | 'titled' | 'rare';

/** Фрагмент имени: ключ перевода и текст на языке-источнике (он же запас, если перевода нет). */
export interface NameFragment {
  key: string;
  source: string;
}

/** Из чего собирается имя. Пустые слоты — норма: шаблон выбросит их вместе со связками. */
export interface ItemNameSpec {
  shape: NameShape;
  /** Голова имени — база вещи. */
  base: NameFragment;
  /** Русское согласование головы (`items-base[].gender`), запас для `loc.agreementOf`. */
  agreement?: string;
  /** Прилагательное ступени («Кровавый»). */
  tier?: NameFragment;
  /** Слово-префикс магической вещи («Жгучий»). */
  prefix?: NameFragment;
  /** Слово-суффикс магической вещи («пламени») — родительный, не согласуется. */
  suffix?: NameFragment;
  /** Титул уника («тёмных братьев»). */
  title?: NameFragment;
  /** Основа имени рара («Искра»). */
  noun?: NameFragment;
  /** Эпитет имени рара («жажды») — родительный, не согласуется. */
  epithet?: NameFragment;
}

/** Слоты, которые согласуются с головой. Всё прочее — инвариант. */
const AGREEING: readonly (keyof ItemNameSpec)[] = ['tier', 'prefix', 'title'];

/**
 * Собирает имя вещи на языке `loc`.
 *
 * Запас арифметикой включается при ДВУХ условиях сразу: язык — источник, и у фрагмента нет записи форм.
 * На любом другом языке запас не зовётся: отсутствие перевода честнее показать русским словом, чем
 * русским словом с русским окончанием, пришитым к испанской фразе.
 */
export function composeItemName(loc: Localizer, spec: ItemNameSpec): string {
  const ru = loc.lang === SOURCE_LANG;
  const agreement = loc.agreementOf(spec.base.key, normalizeAgreement(spec.agreement)) ?? '';

  const slots: Record<string, string> = { base: loc.text(spec.base.key, spec.base.source) };
  for (const slot of ['tier', 'prefix', 'suffix', 'title', 'noun', 'epithet'] as const) {
    const frag = spec[slot] as NameFragment | undefined;
    if (!frag) continue;
    if (!AGREEING.includes(slot)) { slots[slot] = loc.text(frag.key, frag.source); continue; }
    const forms = loc.forms(frag.key);
    slots[slot] = forms !== undefined
      ? loc.form(frag.key, agreement, frag.source)
      : ru ? ruAgree(frag.source, agreement) : frag.source;
  }
  return loc.name(NAME_TEMPLATES[spec.shape], slots);
}

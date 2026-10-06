import {
  FIELD_SALVAGE_FULL, canSalvageItem, fieldSalvageFits, salvageJournalGains, salvageMean, salvagePreview, salvageRange,
  type ConfigRegistry, type CraftJournal, type Item, type SalvageCardLine,
} from '@dm/shared';
import type { App } from '../../core/app.js';
import { askInGame } from '../../ui/kit.js';

/**
 * ЧТО СПРОСИТЬ, ПРЕЖДЕ ЧЕМ ВЕЩЬ ИСЧЕЗНЕТ — чистое решение, без DOM (docs/CRAFT_WEAPONS.md §12.2, §17).
 *
 * Два правила экрана:
 * - **Разбор и продажа СКОВАННОГО спрашивают дважды** (§17): в скованную вещь вложены сырьё, золото и
 *   доводка, а назад переплавка вернёт лишь часть.
 * - **Полевой разбор и продажа предупреждают, что журнал это не засчитает** (§12.2): журнал пополняет только
 *   разбор у кузнеца, и без вопроса разбор в поле — тихая ловушка: игрок сжигает единственный носитель штучной
 *   детали ради трети сырья и не узнаёт об этом никогда. Продажа — та же потеря.
 *
 * Сама проверка — ТА ЖЕ функция, которой кузнец пополняет журнал (`salvageIntoJournal`) над копией
 * журнала: что засчитал бы разбор у кузнеца, того в поле и в лавке и не хватит. Своих правил здесь нет.
 */

/**
 * ЧТО ЗАСЧИТАЛ БЫ ЖУРНАЛУ РАЗБОР У КУЗНЕЦА — строками для вопроса; пусто — терять нечего.
 *
 * ⚠ R2-07: ВСЁ, что возвращает `salvageIntoJournal`, а не только тип и детали: кодекс, снаряжение, эскиз. Потолка ступени и мификов
 * больше нет (решение владельца D3: у ковки нет ворот ступени — её держит сырьё). Оговорка — чтобы вопрос не звал зря: эскиз — только
 * когда разбор ДОВОДИТ счёт жалости до него и эскиз есть на что потратить. Сам счёт к эскизу (1 из 8…) вопросом не зовём: он копится
 * любым разбором найденного у кузнеца — вопрос висел бы на каждой вещи.
 */
export function journalGainsOf(reg: ConfigRegistry, item: Item, journal: CraftJournal | null | undefined): string[] {
  // Одно правило с карточкой разбора у кузнеца (`salvagePreview`): обе строки — из `salvageJournalGains` (@dm/shared).
  return salvageJournalGains(reg, item, journal);
}

/**
 * ⭐ КАРТОЧКА РАЗБОРА В ПОЛЕ — строками для подсказки пункта «Разобрать здесь (30 %)» (предложение «Разбор, сырьё и чары» §15.2):
 * заголовок, «Сырьё: ≈ …», «Эссенция: ≈ 0–1 / нет — почему», эскиз и мягкая подсказка «у кузнеца втрое больше…». Строки КАТАЛОГА нет:
 * разбор в поле каталог не пишет вовсе (решение владельца D2) — что потеряешь, говорит подсказка и вопрос перед разбором. Всё — из
 * `salvagePreview` (те же функции, что у разбора сервера); своих правил здесь нет.
 * Подсказка погашенного пункта «Разобрать нельзя: …» (`fieldSalvageEntry`) — отсюда же, заголовком «Разобрать нельзя» («Переплавить нельзя»
 * у скованной — глагол карточки), а не «Разобрать здесь (30 %)»:
 * - разбор НЕВОЗМОЖЕН (`salvagePreview().ok` — нет: стартовый набор, уник, «ничего не дал бы»…) — ТОЛЬКО заголовок и причина, как у верстака
 *   кузницы (`benchActions`: `lines: can.ok ? four : [причина]`). ⚠ Было: и тут четыре строки «что вышло бы» — у отказа они лгали
 *   («Эссенция: нет — материал выключен» у уника, «Эскиз: копит только разбор у кузнеца (меч 0/8)» у стартового меча);
 * - разбор возможен, но мешает то, чего карточка сама не знает (сумка полна — `fieldSalvageFits`, приходит `refusal`), — причина после
 *   заголовка и карточка целиком: что вышло бы, освободи место, — правда.
 */
export function fieldSalvageLines(
  reg: ConfigRegistry, item: Item, journal: CraftJournal | null | undefined, refusal?: string,
): { text: string; tone: SalvageCardLine['tone'] | 'title' | 'hint' }[] {
  const c = salvagePreview(reg, item, journal, true);
  const line = (l: SalvageCardLine): { text: string; tone: SalvageCardLine['tone'] } => ({ text: `${l.label}: ${l.text}`, tone: l.tone });
  const no = `${c.verb === 'melt' ? 'Переплавить' : 'Разобрать'} нельзя`;
  if (!c.ok) return [{ text: no, tone: 'title' }, { text: c.reason ?? refusal ?? 'нельзя', tone: 'warn' }];
  return [
    { text: refusal ? no : c.title, tone: 'title' },
    ...(refusal ? [{ text: refusal, tone: 'warn' as const }] : []),
    line(c.materials),
    line(c.essence),
    ...(c.catalog ? [line(c.catalog)] : []),
    ...(c.sketch ? [line(c.sketch)] : []),
    ...(c.hint ? [{ text: c.hint[0]!.toUpperCase() + c.hint.slice(1), tone: 'hint' as const }] : []),
  ];
}

/**
 * ⭐ ПУНКТ «РАЗОБРАТЬ» МЕНЮ ПРЕДМЕТА В ПОЛЕ — одно решение для меню инвентаря (`inventoryPanel.ts`) и эталона Unity (`unity_panels.json`,
 * `menu`): можно — «Разобрать здесь (30 %)»; нельзя — пункт ОСТАЁТСЯ, погашенный, с причиной в подписи («Разобрать нельзя: …», как
 * «Надеть нельзя: …»), а подсказка — из карточки разбора в поле (`fieldSalvageLines`: «Разобрать нельзя» и почему). Причины — все отказы
 * разбора в поле (`canSalvageItem` — тот же ответ, что у сервера): стартовый набор (`STARTER_FIELD`), уник, «ничего не дал бы», переплавка
 * ни с чем; и место — сырьё лучшего броска не ляжет в сумку (`fieldSalvageFits`, V-B3-04).
 * ⚠ Было: при отказе `canSalvageItem` пункт молча пропадал — стартовый меч в подземелье разбирать «не предлагалось» без объяснения.
 * Зелья и сырьё (`null`): разбор к ним не относится вовсе — пункт «нельзя» висел бы на каждой склянке и стопке.
 */
export interface FieldSalvageEntry { label: string; ok: boolean; reason?: string }
export function fieldSalvageEntry(reg: ConfigRegistry, inventory: readonly Item[], item: Item): FieldSalvageEntry | null {
  if (item.kind === 'consumable' || item.kind === 'material') return null;
  const can = canSalvageItem(reg, item, true);
  if (!can.ok) {
    const reason = can.reason ?? 'Эту вещь не из чего разбирать';
    return { label: `Разобрать нельзя: ${reason}`, ok: false, reason };
  }
  if (!fieldSalvageFits(reg, inventory, item)) return { label: 'Разобрать нельзя: сумка полна', ok: false, reason: FIELD_SALVAGE_FULL };
  return { label: `Разобрать здесь (${Math.round(reg.get('balance').salvage.fieldYield * 100)} %)`, ok: true };
}

/** Где вещь исчезает: разбор в поле, разбор (переплавка) у кузнеца, продажа. */
export type DisposeAct = 'field' | 'forge' | 'sell';

/**
 * Вопросы по порядку; пусто — спрашивать нечего. Скованная вещь — два вопроса (второй — «точно?»),
 * найденная, которую кузнец засчитал бы журналу, в поле и в лавке — один. У кузнеца — ни одного: он и засчитает.
 */
export function disposePrompts(
  reg: ConfigRegistry, item: Item, act: DisposeAct, journal: CraftJournal | null | undefined, price?: number,
): string[] {
  const out: string[] = [];
  const priced = price !== undefined ? ` за ${price} золота` : '';
  if (item.parts) {
    out.push(
      act === 'sell' ? `Продать скованную «${item.name}»${priced}? Скованное лавочник берёт как любую вещь.`
      : act === 'field' ? `Переплавить скованную «${item.name}» прямо здесь? В поле вернётся лишь малая доля сырья.`
      : `Переплавить скованную «${item.name}»? Кузнец вернёт лишь часть сырья, доводка не вернётся.`,
      `Точно? «${item.name}» исчезнет навсегда — скованную вещь не вернуть.`,
    );
  }
  if (act !== 'forge') {
    const gains = journalGainsOf(reg, item, journal);
    if (gains.length) {
      out.push(act === 'field'
        ? `Разбор в поле журнал кузнеца не пополняет, а у кузнеца эта вещь дала бы:\n(${gains.join(', ')})\n`
          + 'Засчитывает только разбор у кузнеца в городе. Разобрать здесь всё равно?'
        : `Продажа журнал кузнеца не пополняет, а разбор у кузнеца дал бы:\n(${gains.join(', ')})\n`
          + `Продать «${item.name}»${priced} всё равно?`);
    }
  }
  return out;
}

/**
 * Задать вопросы по очереди; «нет» на любом — отказ. `ask` — `window.confirm` (в тестах — подделка).
 * ⚠ Только для ГОРОДА (кузница, лавка): `window.confirm` замораживает страницу, а в подземелье сервер тем
 * временем гоняет бой с последним вводом. Вне города — `confirmAllAsync` с вопросом в игре (`salvageInField`).
 */
export function confirmAll(prompts: readonly string[], ask: (msg: string) => boolean = (m) => window.confirm(m)): boolean {
  for (const p of prompts) if (!ask(p)) return false;
  return true;
}

/** То же по очереди, но ответ — промисом (вопрос в игре, `askInGame`): страница и бой не встают. */
export async function confirmAllAsync(prompts: readonly string[], ask: (msg: string) => Promise<boolean>): Promise<boolean> {
  for (const p of prompts) if (!(await ask(p))) return false;
  return true;
}

/**
 * ⭐ РАЗБОР В ПОЛЕ (R1-14): вопросы — В ИГРЕ, не `window.confirm`. В подземелье рядом монстры, а замороженная
 * страница не шлёт ввода: сервер ведёт героя с последним полученным (зажатый W идёт), и монстры бьют, пока
 * игрок читает вопрос. Здесь страница живёт, и драться можно, не отвечая.
 *
 * Пока висел вопрос, игра шла: вещь могли выбросить, переложить, потерять со смертью, герой — уйти в город (там
 * пункта нет вовсе). Поэтому после «да» проверяем снова и шлём, только если вещь ещё в сумке и мы не в городе.
 * `true` — команда ушла. R3-23: перепроверка отказала — строка в логе («Разбор отменён: …»), а не молчание: игрок
 * ответил «да» и ждёт итога. Смена области сама снимает вопрос (`dismissAsk`) — это «нет», и лог молчит.
 *
 * R2-14: отказ сервера — в лог игры. Разбор делит лимит частоты с кузницей (запас 5, +2 в секунду), и шестой
 * разбор подряд получает «Слишком часто»; раньше в подземелье этот отказ не видел никто — клик «ничего не делал».
 */
export async function salvageInField(
  app: Pick<App, 'config' | 'state' | 'stash' | 'request' | 'bus'>, item: Item, ask: (msg: string) => Promise<boolean> = (m) => askInGame(m),
): Promise<boolean> {
  if (!(await confirmAllAsync(disposePrompts(app.config, item, 'field', app.stash?.forgeJournal), ask))) return false;
  const state = app.state;
  const why = !state ? 'герой не в игре' : state.area === 'town' ? 'герой уже в городе — там разбирает кузнец'
    : !state.save.inventory.some((i) => i.uid === item.uid) ? `«${item.name}» уже нет в сумке` : '';
  if (why) { app.bus.emit('log:message', { text: `Разбор отменён: ${why}`, kind: 'system' }); return false; }
  // ⭐ R8-14: с низом вилки выхода по конфигу клиента: правка выхода живьём на сервере — отказ, вещь цела, конфиг перечитан.
  // R9-04: и со средним выходом — у дробной доли (пояс, обычное оружие: «0–1») низ вилки правку выхода не видит.
  const low = Object.fromEntries(Object.entries(salvageRange(app.config, item, true).range).map(([id, r]) => [id, r.min]));
  const avg = salvageMean(app.config, item, true);
  void app.request({ cmd: 'salvage', uid: item.uid, minYield: low, ...(avg ? { avgYield: avg } : {}) }).then((r) => {
    if (r && !r.ok) app.bus.emit('log:message', { text: `Разбор не удался: ${r.reason ?? 'сервер отказал'}`, kind: 'system' });
    // ⭐ §15.2: итог — строкой в лог ВСЕГДА («Получено: … · каталог пополняет только разбор у кузнеца»): разбор в поле не молчит.
    else if (r?.ok && r.summary) app.bus.emit('log:message', { text: `Разбор «${item.name}»: ${r.summary}`, kind: 'loot' });
  });
  return true;
}

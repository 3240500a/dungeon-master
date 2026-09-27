import {
  craftTiers, emptyJournal, partById, salvageIntoJournal, salvageMean, salvageRange, salvageYield, sketchable, typeOfItem,
  type ConfigRegistry, type CraftJournal, type Item, type SalvageRng,
} from '@dm/shared';
import type { App } from '../../core/app.js';
import { askInGame } from '../../ui/kit.js';

/** Бросок для выбора ПУТИ разбора: путь от кубика не зависит, выход здесь не нужен. */
const NO_ROLL: SalvageRng = { int: (a) => a, chance: () => false };

/**
 * ЧТО СПРОСИТЬ, ПРЕЖДЕ ЧЕМ ВЕЩЬ ИСЧЕЗНЕТ — чистое решение, без DOM (docs/CRAFT_WEAPONS.md §12.2, §17).
 *
 * Два правила экрана:
 * - **Разбор и продажа СКОВАННОГО спрашивают дважды** (§17): в скованную вещь вложены сырьё, золото и
 *   доводка, а назад переплавка вернёт лишь часть.
 * - **Полевой разбор и продажа предупреждают, что журнал это не засчитает** (§12.2): журнал пополняет только
 *   разбор у кузнеца, и без вопроса разбор в поле — тихая ловушка: игрок сжигает единственный носитель штучной
 *   детали (или мифик к воротам t6) ради трети сырья и не узнаёт об этом никогда. Продажа — та же потеря.
 *
 * Сама проверка — ТА ЖЕ функция, которой кузнец пополняет журнал (`salvageIntoJournal`) над копией
 * журнала: что засчитал бы разбор у кузнеца, того в поле и в лавке и не хватит. Своих правил здесь нет.
 */

/**
 * ЧТО ЗАСЧИТАЛ БЫ ЖУРНАЛУ РАЗБОР У КУЗНЕЦА — строками для вопроса; пусто — терять нечего.
 *
 * ⚠ R2-07: ВСЁ, что возвращает `salvageIntoJournal`, а не только тип и детали: кодекс, потолок ступени (первая вещь
 * новой ступени — частый случай в начале), мифик к воротам t6, эскиз. Раньше мифик с известными деталями уходил в
 * поле без вопроса — и с ним потолок ковки и счёт ворот: полевой разбор журнал не трогает вовсе.
 * Две оговорки — чтобы вопрос не звал зря: мифик — только пока ворота закрыты (сверх `mythicSalvages` счёт ничего не
 * даёт); эскиз — только когда разбор ДОВОДИТ счёт жалости до него и эскиз есть на что потратить. Сам счёт к эскизу
 * (1 из 8…) вопросом не зовём: он копится любым разбором найденного у кузнеца — вопрос висел бы на каждой вещи.
 */
export function journalGainsOf(reg: ConfigRegistry, item: Item, journal: CraftJournal | null | undefined): string[] {
  // Скованное журнал знает (его сковали из открытого), уникальное кузнец не разбирает вовсе.
  if (item.parts || item.kind !== 'weapon' || item.rarity === 'unique') return [];
  // Журнал пополняет только разбор ПО ДЕТАЛЯМ — ровно то условие, по которому его зовёт `forgeSalvage`.
  if (salvageYield(reg, item, NO_ROLL, false).source !== 'parts') return [];
  // Журнала нет (кадр сундука не пришёл) — честнее считать всё неизвестным: лишний вопрос дешевле ловушки.
  const j = journal ?? emptyJournal();
  const u = salvageIntoJournal(reg, j, item);
  const base = u.newBase ? reg.get('items.base').find((b) => b.id === item.baseId) : undefined;
  const tiers = craftTiers(reg);
  const tier = u.tierUp ? tiers[u.journal.tierHi] : undefined;
  const need = reg.get('balance').craft.journal.mythicSalvages;
  const sketch = u.sketch && reg.get('weapon-parts').some((p) => p.enabled !== false && sketchable(reg, u.journal, p.id));
  return [
    ...(base ? [`тип «${base.name}»`] : []),
    ...u.unlocked.map((id) => `деталь «${partById(reg, id)?.name ?? id}»`),
    ...(u.newType ? [`кодекс «${typeOfItem(reg, item)?.name ?? u.newType}»`] : []),
    ...(tier ? [`ступень «${tier.name}» — потолок ковки`] : []),
    ...(u.mythic && j.mythic < need ? [`мифик к воротам ${tiers.at(-1)?.id ?? 't6'} (${j.mythic + 1} из ${need})`] : []),
    ...(sketch ? ['эскиз — деталь на выбор'] : []),
  ];
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
  });
  return true;
}

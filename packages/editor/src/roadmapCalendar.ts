/**
 * КАЛЕНДАРЬ ВНЕШНИХ СОБЫТИЙ STEAM — фестивали и распродажи (Р7).
 *
 * ЗАЧЕМ. Простой сдвиг «на N дней» верен только для НАШЕЙ работы. Внешние даты так не двигаются:
 *  • обогнали план — фестиваль раньше не случится, он идёт когда идёт;
 *  • отстали — можно не успеть подать заявку и вылететь на следующий, а это три месяца;
 *  • дата запуска вообще не «месяц туда-сюда», а конкретное чистое окно между распродажами.
 * Поэтому вехи-события привязываются к РЕАЛЬНЫМ датам, а план подгоняется под них, а не наоборот.
 *
 * ⚠ ПРАВИЛА NEXT FEST, каждое из которых способно стоить проекту месяцев (сверено по
 * partner.steamgames.com/doc/marketing/upcoming_events/nextfest и по страницам конкретных выпусков):
 *  1. «Titles may only participate in ONE Next Fest» — РОВНО ОДИН РАЗ за всю жизнь игры.
 *  2. Игра «will not be released before the applicable Next Fest edition concludes» — на момент
 *     фестиваля она обязана быть НЕ ВЫШЕДШЕЙ (ранний доступ уже считается вышедшей). Значит запуск
 *     ВСЕГДА позже фестиваля, иначе фестиваль просто сгорает.
 *  3. Нельзя участвовать прологом или укороченной версией уже вышедшей на Steam игры.
 *
 * ⭐ СРОКОВ НЕ ОДИН, А ТРИ, и они разнесены на месяц-полтора — это меняет планирование:
 *  • `regDeadline` — ЗАЯВКА. Нужна опубликованная страница и опт-ин. Закрывается за 43–50 дней.
 *  • `demoDeadline` — ДЕМО на проверку. Всего за 14–21 день до фестиваля, то есть на 4–5 недель ПОЗЖЕ
 *    заявки: демо доделывается уже ПОСЛЕ подачи. Раньше я считал их одним сроком и требовал демо на
 *    месяц раньше, чем нужно на самом деле.
 *  • `trailerDeadline` — когда Valve забирает трейлер в официальный ролик фестиваля (за 35–42 дня).
 * Замер по трём объявленным выпускам: заявка −49/−43/−50 дн, демо −21/−14/−14, трейлер −41/−35/−42.
 *
 * Объявленные Valve даты стоят с `confirmed: true`. Что не объявлено — посчитано по этим же смещениям
 * от предсказанной даты начала и помечено `confirmed: false`; перед подачей сверить.
 */

export type EventKind = 'fest' | 'sale';

export interface ExtEvent {
  id: string;
  kind: EventKind;
  title: string;
  /** `YYYY-MM-DD` включительно. */
  from: string;
  to: string;
  /** ЗАЯВКА: страница опубликована и опт-ин сделан. Только у фестивалей. */
  regDeadline?: string;
  /** ДЕМО сдано на проверку. На 4–5 недель ПОЗЖЕ заявки — демо доделывается после подачи. */
  demoDeadline?: string;
  /** Трейлер должен лежать на странице: Valve забирает его в официальный ролик фестиваля. */
  trailerDeadline?: string;
  /** false — дата не объявлена Valve, а спрогнозирована по шаблону прошлых лет. */
  confirmed: boolean;
}

/**
 * Известные события. Фестивали идут трижды в год (февраль, июнь, октябрь), распродажи — четырежды.
 * Источник: страница «Предстоящие события Steam» и страницы конкретных выпусков Next Fest.
 */
export const STEAM_EVENTS: ExtEvent[] = [
  { id: 'sale-autumn-26', kind: 'sale', title: 'Осенняя распродажа', from: '2026-10-01', to: '2026-10-08', confirmed: true },
  { id: 'fest-oct-26', kind: 'fest', title: 'Next Fest — октябрь 2026', from: '2026-10-19', to: '2026-10-26',
    regDeadline: '2026-08-31', demoDeadline: '2026-09-28', trailerDeadline: '2026-09-08', confirmed: true },
  { id: 'sale-winter-26', kind: 'sale', title: 'Зимняя распродажа', from: '2026-12-17', to: '2027-01-04', confirmed: true },
  { id: 'fest-feb-27', kind: 'fest', title: 'Next Fest — февраль 2027', from: '2027-02-22', to: '2027-03-01',
    regDeadline: '2027-01-10', demoDeadline: '2027-02-08', trailerDeadline: '2027-01-18', confirmed: true },
  { id: 'sale-spring-27', kind: 'sale', title: 'Весенняя распродажа', from: '2027-03-18', to: '2027-03-25', confirmed: true },
  { id: 'fest-jun-27', kind: 'fest', title: 'Next Fest — июнь 2027', from: '2027-06-14', to: '2027-06-21',
    regDeadline: '2027-04-25', demoDeadline: '2027-05-31', trailerDeadline: '2027-05-03', confirmed: true },
  { id: 'sale-summer-27', kind: 'sale', title: 'Летняя распродажа', from: '2027-06-24', to: '2027-07-08', confirmed: true },
  // Ниже Valve ещё ничего не объявляла. Начало — тот же понедельник того же месяца, сроки — по замеренным
  // смещениям (октябрь: −49/−21/−41, февраль: −43/−14/−35, июнь: −50/−14/−42).
  // ⚠ Срок сдачи демо взят по ДВУМ ПОСЛЕДНИМ выпускам (−14 дн), а не по октябрьскому-2026 (−21).
  // Разница в неделю, и она напрямую решает, успевает ли полировка демо. Сверить, как объявят.
  { id: 'fest-oct-27', kind: 'fest', title: 'Next Fest — октябрь 2027', from: '2027-10-18', to: '2027-10-25',
    regDeadline: '2027-08-30', demoDeadline: '2027-10-04', trailerDeadline: '2027-09-07', confirmed: false },
  { id: 'sale-autumn-27', kind: 'sale', title: 'Осенняя распродажа', from: '2027-11-24', to: '2027-12-01', confirmed: false },
  { id: 'sale-winter-27', kind: 'sale', title: 'Зимняя распродажа', from: '2027-12-16', to: '2028-01-03', confirmed: false },
  { id: 'fest-feb-28', kind: 'fest', title: 'Next Fest — февраль 2028', from: '2028-02-21', to: '2028-02-28',
    regDeadline: '2028-01-09', demoDeadline: '2028-02-07', trailerDeadline: '2028-01-17', confirmed: false },
  { id: 'sale-spring-28', kind: 'sale', title: 'Весенняя распродажа', from: '2028-03-16', to: '2028-03-23', confirmed: false },
  { id: 'fest-jun-28', kind: 'fest', title: 'Next Fest — июнь 2028', from: '2028-06-12', to: '2028-06-19',
    regDeadline: '2028-04-23', demoDeadline: '2028-05-29', trailerDeadline: '2028-05-01', confirmed: false },
  { id: 'sale-summer-28', kind: 'sale', title: 'Летняя распродажа', from: '2028-06-22', to: '2028-07-06', confirmed: false },
];

const DAY = 86_400_000;
const ms = (iso: string): number => Date.parse(iso + 'T12:00:00Z');
export const evStart = (e: ExtEvent): number => ms(e.from);
export const evEnd = (e: ExtEvent): number => ms(e.to);
export const byId = (id: string): ExtEvent | undefined => STEAM_EVENTS.find((e) => e.id === id);

export const fests = (): ExtEvent[] => STEAM_EVENTS.filter((e) => e.kind === 'fest');

/**
 * Самый РАННИЙ фестиваль, на который мы успеваем ПО ОБОИМ срокам.
 *
 * ⚠ Сроков два, и путать их нельзя (я сначала проверял только первый и получил план, где демо
 * доводится уже ПОСЛЕ фестиваля):
 *  • `pageBy` — когда открывается страница магазина. Сравнивается с `regDeadline` (заявка).
 *  • `demoBy` — когда демо доведено до сдачи. Сравнивается с `demoDeadline` (проверка билда).
 * Первый срок наступает на месяц раньше второго, поэтому одной проверки не хватает ни в одну сторону.
 *
 * ⭐ Отсюда и берётся выигрыш от опережения плана: закончили раньше — успеваем на июньский,
 * а не ждём октябрьского. Четыре месяца разницы.
 */
export function earliestFest(pageBy: number, demoBy = pageBy, from = Date.now()): ExtEvent | null {
  return fests().find((f) => f.regDeadline && f.demoDeadline
    && ms(f.regDeadline) >= pageBy && ms(f.demoDeadline) >= demoBy && evStart(f) >= from) ?? null;
}

/** Какой из двух сроков фестиваля мы не проходим. `null` — проходим оба. */
export function festBlocker(f: ExtEvent, pageBy: number, demoBy: number): string | null {
  if (f.regDeadline && ms(f.regDeadline) < pageBy) {
    return `страница выходит позже заявки (${f.regDeadline})`;
  }
  if (f.demoDeadline && ms(f.demoDeadline) < demoBy) {
    return `демо доводится позже сдачи билда (${f.demoDeadline})`;
  }
  return null;
}

/**
 * На сколько дней мы не успели к заявке на фестивали, которые из-за этого пропускаем.
 * Нужно для честного отчёта: «до июньского не хватило 5 дней» — это повод подвинуть публикацию
 * страницы на неделю, а не молча ждать октября. Далёкие промахи не показываем — смотреть незачем.
 */
export function nearMisses(pageBy: number, demoBy = pageBy, from = Date.now(), withinDays = 45):
{ ev: ExtEvent; lateBy: number; why: string }[] {
  return fests()
    .filter((f) => evStart(f) >= from && festBlocker(f, pageBy, demoBy))
    .map((f) => {
      const regLate = Math.round((pageBy - ms(f.regDeadline!)) / DAY);
      const demoLate = Math.round((demoBy - ms(f.demoDeadline!)) / DAY);
      return { ev: f, lateBy: Math.max(regLate, demoLate), why: festBlocker(f, pageBy, demoBy)! };
    })
    .filter((x) => x.lateBy > 0 && x.lateBy <= withinDays);
}

/** Событие, внутрь которого попадает дата (распродажа или фестиваль), либо null. */
export function eventAt(day: number): ExtEvent | null {
  return STEAM_EVENTS.find((e) => day >= evStart(e) - DAY && day <= evEnd(e) + DAY) ?? null;
}

/**
 * Сколько ждать после конца крупной распродажи. ⚠ Это ЭВРИСТИКА, а не правило Valve: сразу после
 * распродажи у покупателей потрачен бюджет, а «New & Trending» забит релизами, которые сами ждали её
 * конца. Три недели — компромисс между «толпа рассосалась» и «не тянуть месяц».
 * Именно это правило и даёт 24.01.2028: Зимняя кончается 3 января, 17-е ещё в хвосте, 24-е уже нет.
 */
export const SALE_COOLDOWN_DAYS = 21;

/** Конец ближайшей ПРЕДШЕСТВУЮЩАЯ дню распродажи — от него отсчитывается остывание. */
function lastSaleBefore(day: number): ExtEvent | null {
  const past = STEAM_EVENTS.filter((e) => e.kind === 'sale' && evEnd(e) <= day);
  return past.length ? past[past.length - 1]! : null;
}

/** Причина, по которой день не годится для запуска, либо null если годится. */
export function launchBlocker(day: number): string | null {
  const d = new Date(day);
  if (d.getUTCDay() !== 1) return 'не понедельник';              // понедельник = вся неделя в «Popular Upcoming» перед релизом
  const hit = eventAt(day);
  if (hit) return hit.kind === 'sale' ? `распродажа: ${hit.title}` : `фестиваль: ${hit.title}`;
  const mo = d.getUTCMonth();                                    // 0 = январь
  if (mo === 10 || mo === 11) return 'ноябрь–декабрь: +30 % релизов и обе распродажи';
  const sale = lastSaleBefore(day);
  if (sale) {
    const since = Math.round((day - evEnd(sale)) / DAY);
    if (since < SALE_COOLDOWN_DAYS) return `всего ${since} дн после «${sale.title}» — бюджет покупателей ещё не восстановился`;
  }
  return null;
}

export interface LaunchPick {
  date: string;
  /** Отвергнутые кандидаты с причинами — чтобы решение было видно, а не сваливалось как факт. */
  rejected: { date: string; why: string }[];
}

/**
 * Ближайшая ХОРОШАЯ дата запуска не раньше `after`.
 * Перебираем понедельники и отбрасываем те, что попадают в распродажу, фестиваль или мёртвый сезон.
 * Возвращаем и отвергнутые — иначе непонятно, почему дата именно такая.
 */
export function bestLaunchDate(after: number, limitWeeks = 60): LaunchPick {
  const rejected: LaunchPick['rejected'] = [];
  const d = new Date(after);
  d.setUTCHours(12, 0, 0, 0);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);   // до ближайшего понедельника
  for (let i = 0; i < limitWeeks; i++) {
    const day = d.getTime();
    const why = launchBlocker(day);
    const iso = new Date(day).toISOString().slice(0, 10);
    if (!why) return { date: iso, rejected };
    rejected.push({ date: iso, why });
    d.setUTCDate(d.getUTCDate() + 7);
  }
  // Сюда попадаем только если весь горизонт занят — вернуть первого кандидата честнее, чем произвольный
  // день: вызывающий увидит в `rejected` ту же причину и поймёт, что окна нет вообще.
  return { date: rejected[0]?.date ?? new Date(after).toISOString().slice(0, 10), rejected };
}

/** Сколько недель между двумя датами — для подписи «фестиваль за N недель до запуска». */
export const weeksBetween = (a: string, b: string): number => Math.round((ms(b) - ms(a)) / (7 * DAY));

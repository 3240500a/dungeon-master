/**
 * ПЕРЕСЧЁТ ПЛАНА ПОД РЕАЛЬНЫЕ ДАТЫ (Р7).
 *
 * Плоский сдвиг «всё на N дней» верен только для нашей работы. Здесь три разных правила, потому что
 * три разных природы у вех:
 *
 *  1. РАБОТА — двигается на величину отставания. Обогнали — едет назад, отстали — вперёд.
 *  2. ФЕСТИВАЛЬ — внешняя дата. Обогнали план → перецепляемся на БОЛЕЕ РАННИЙ фестиваль, если ещё
 *     успеваем подать заявку; отстали → на ближайший, куда успеваем. Между ними ничего нет: фестиваль
 *     не «сдвигается на месяц», он либо тот, либо следующий, а это ±4 месяца.
 *  3. ЗАПУСК — не дата, а ОКНО. Снапается на ближайший чистый понедельник после фестиваля, минуя
 *     распродажи и мёртвый ноябрь-декабрь.
 *
 * ⚠ ЖЁСТКОЕ ОГРАНИЧЕНИЕ: на момент фестиваля игра обязана быть НЕ ВЫШЕДШЕЙ, поэтому запуск всегда
 * позже фестиваля. Если план это нарушает, фестиваль просто сгорает — а он один на всю жизнь игры.
 */
import {
  driftDays, shiftDate, deadlineOf, milestoneProgress, shortDate,
  type RoadmapDoc, type Milestone, type Ctx, type Proposal,
} from './roadmapModel.js';
import {
  byId, earliestFest, nearMisses, festBlocker, bestLaunchDate, evEnd, evStart, weeksBetween, type ExtEvent,
} from './roadmapCalendar.js';

const DAY = 86_400_000;
const iso = (msv: number): string => new Date(msv).toISOString().slice(0, 10);

/*
 * ⚠ ЗАПАСА ЗДЕСЬ НЕТ НАМЕРЕННО. Сначала я закладывал две недели «на полировку и трейлер», но заявку
 * принимают по ОПУБЛИКОВАННОЙ СТРАНИЦЕ, а демо сдаётся на месяц позже — запас уже встроен в сами
 * сроки Valve. Искусственная добавка только врала в отчёте: промах в 5 дней показывался как 19,
 * и вместо «подвинь публикацию на неделю» получалось «не судьба, ждём октября».
 * Решение о собственном запасе принимает человек — сдвигая веху, а не пряча его в формуле.
 */
/** Сколько ждать после фестиваля до запуска: отклик фестиваля надо успеть отработать. */
const FEST_TO_LAUNCH_WEEKS = 12;

/** Отставание (или опережение) на последней ЗАКРЫТОЙ вехе — им и двигаем хвост. */
export function currentDrift(doc: RoadmapDoc): number {
  const closed = doc.milestones.filter((m) => m.closedAt && !m.baseline);
  const last = closed[closed.length - 1];
  return last ? driftDays(last) : 0;
}

/**
 * Собрать предложения по пересчёту. Ничего не меняет — только считает, что БЫЛО БЫ, если применить.
 * Решение остаётся за человеком: даты релиза не должны меняться сами по себе.
 */
export function replan(doc: RoadmapDoc, ctx: Ctx = {}): { drift: number; proposals: Proposal[]; notes: string[] } {
  const now = ctx.now ?? Date.now();
  const drift = currentDrift(doc);
  const proposals: Proposal[] = [];
  const notes: string[] = [];

  const open = doc.milestones.filter((m) => !m.baseline && !m.closedAt);
  if (!open.length) return { drift, proposals, notes: ['Все вехи закрыты — пересчитывать нечего.'] };

  // ── 1. Работа: сдвиг на величину отставания ──
  const work = open.filter((m) => (m.kind ?? 'work') === 'work');
  if (drift !== 0) {
    for (const m of work) {
      const next = shiftDate(m.to, drift);
      proposals.push({
        milestoneId: m.id, title: m.title, from: m.to, to: next, later: drift > 0,
        why: drift > 0 ? `отставание ${drift} дн переносится вперёд` : `опережение ${-drift} дн подтягивает срок`,
      });
    }
  } else notes.push('Идём ровно по плану — рабочие вехи не двигаем.');

  // ⚠ Готовность демо — это НЕ последняя веха перед фестивалем. Заявку принимают по демо, а работа
  // между подачей и фестивалем (второй биом, баланс) срок заявки не двигает. Поэтому берём веху с
  // меткой `gatesFest`, и только если её нет — падаем на прежнее «последняя работа перед фестивалем».
  const festMs = open.find((m) => m.kind === 'fest');
  const festIdx = festMs ? doc.milestones.indexOf(festMs) : doc.milestones.length;
  const beforeFest = work.filter((m) => doc.milestones.indexOf(m) < festIdx);
  const gate = doc.milestones.find((m) => m.gatesFest) ?? beforeFest[beforeFest.length - 1];
  const endOf = (m: Milestone): number => (m.closedAt
    ? Date.parse(m.closedAt + 'T23:59:59Z')
    : deadlineOf({ ...m, to: shiftDate(m.to, drift) }));
  const pageBy = gate ? endOf(gate) : now;
  // ⚠ Второй срок: демо сдаётся на проверку за 2–3 недели до фестиваля, и доводится оно ПОСЛЕДНЕЙ
  // рабочей вехой перед ним. Без этой проверки план спокойно ставил полировку демо на месяц ПОСЛЕ
  // начала фестиваля — и пересчёт этого не замечал.
  const demoGate = doc.milestones.find((m) => m.gatesDemo) ?? beforeFest[beforeFest.length - 1];
  const demoBy = demoGate ? endOf(demoGate) : pageBy;

  // ── 2. Фестиваль: перецепляем на самый ранний доступный ──
  let chosen: ExtEvent | null = null;
  if (festMs) {
    const cur = festMs.eventId ? byId(festMs.eventId) : null;
    chosen = earliestFest(pageBy, demoBy, now);
    if (!chosen) {
      notes.push('⚠ Ни на один известный фестиваль подать уже нельзя — календарь надо продлить.');
    } else if (!cur || chosen.id !== cur.id) {
      const earlier = !cur || evStart(chosen) < evStart(cur);
      const why = cur ? festBlocker(cur, pageBy, demoBy) : null;
      proposals.push({
        milestoneId: festMs.id, title: festMs.title, from: festMs.to, to: iso(evStart(chosen)),
        later: !earlier, eventId: chosen.id,
        why: earlier
          ? `успеваем на более ранний: ${chosen.title}, заявка до ${shortDate(chosen.regDeadline!)}, демо до ${shortDate(chosen.demoDeadline!)}`
          : `${why ?? 'на прежний не успеваем'} → ${chosen.title}, заявка до ${shortDate(chosen.regDeadline!)}`,
      });
      if (earlier && cur) {
        const gainDays = Math.round((evStart(cur) - evStart(chosen)) / DAY);
        notes.push(`⭐ Опережение позволяет перецепиться на «${chosen.title}» — выигрыш ${gainDays} дн (~${Math.round(gainDays / 30)} мес).`);
      }
    } else {
      notes.push(`Фестиваль остаётся прежним («${chosen.title}»): раньше он всё равно не случится.`);
    }
    // ⭐ Промах в пару дней — это не «не судьба», а повод подвинуть публикацию страницы на неделю.
    // Разница между соседними фестивалями — четыре месяца, поэтому такой промах надо называть вслух.
    for (const m of nearMisses(pageBy, demoBy, now)) {
      notes.push(`⭐ До «${m.ev.title}» не хватило ${m.lateBy} дн — ${m.why}. `
        + `Заявка ${shortDate(m.ev.regDeadline!)} · трейлер ${shortDate(m.ev.trailerDeadline!)} · `
        + `демо на проверку ${shortDate(m.ev.demoDeadline!)}.`);
    }
    if (chosen && !chosen.confirmed) notes.push(`⚠ Дата «${chosen.title}» не объявлена Valve — спрогнозирована по шаблону, сверить перед подачей.`);
  }

  // Порядок на ленте может перестать быть хронологическим: фестиваль зависит только от ДЕМО, а работа
  // после подачи (второй биом, баланс) продолжается и законно заезжает за дату фестиваля.
  if (chosen && beforeFest.some((m) => deadlineOf({ ...m, to: shiftDate(m.to, drift) }) > evStart(chosen!))) {
    notes.push('Часть рабочих вех окажется ПОЗЖЕ фестиваля — это нормально: заявка идёт по демо, а не по всей игре.');
  }

  // ── 3. Запуск: снапаем на чистое окно после фестиваля ──
  const launch = open.find((m) => m.kind === 'launch');
  if (launch) {
    // Два ограничения снизу, и оба обязательные:
    //  • вся работа должна быть закончена (иначе предложим запуск раньше «кандидата в релиз»);
    //  • после фестиваля нужен зазор, чтобы успеть отработать отклик.
    // ⚠ Только работа ДО запуска: после него в плане стоит 1.0, и тянуть релиз за ней бессмысленно
    // (иначе ранний доступ уезжает на дату полной игры — поймано тестом на нетронутом сиде).
    const launchIdx = doc.milestones.indexOf(launch);
    const beforeLaunch = work.filter((m) => doc.milestones.indexOf(m) < launchIdx);
    const lastWork = beforeLaunch[beforeLaunch.length - 1];
    const workDone = lastWork ? deadlineOf({ ...lastWork, to: shiftDate(lastWork.to, drift) }) : now;
    const afterFest = chosen ? evEnd(chosen) + FEST_TO_LAUNCH_WEEKS * 7 * DAY : workDone;
    const notBefore = Math.max(afterFest, workDone, now);
    const pick = bestLaunchDate(notBefore);
    if (pick.date !== launch.to) {
      const later = Date.parse(pick.date) > deadlineOf(launch);
      proposals.push({
        milestoneId: launch.id, title: launch.title, from: launch.to, to: pick.date, later,
        why: chosen
          ? `чистый понедельник через ${weeksBetween(iso(evEnd(chosen)), pick.date)} нед после «${chosen.title}»`
          : 'ближайший чистый понедельник вне распродаж',
      });
    }
    if (workDone > afterFest && lastWork) {
      notes.push(`Запуск упирается не в фестиваль, а в работу: «${lastWork.title}» заканчивается ${shortDate(iso(workDone))}.`);
    }
    for (const r of pick.rejected.slice(0, 4)) notes.push(`${shortDate(r.date)} не годится — ${r.why}.`);
    if (chosen && Date.parse(pick.date) <= evEnd(chosen)) {
      notes.push('⚠ Запуск оказался бы РАНЬШЕ фестиваля — тогда фестиваль сгорает: на нём игра обязана быть невышедшей.');
    }
  }

  return { drift, proposals, notes };
}

/** Применить предложения. Изначальный план (`planned`) не трогаем — иначе отклонение обнулится. */
export function applyProposals(doc: RoadmapDoc, proposals: Proposal[]): number {
  let n = 0;
  for (const p of proposals) {
    const m = doc.milestones.find((x) => x.id === p.milestoneId);
    if (!m || m.closedAt) continue;
    m.planned ??= m.to;
    if (p.eventId) m.eventId = p.eventId;   // веха-фестиваль остаётся привязанной к событию, а не к голой дате
    const shift = Date.parse(p.to) - Date.parse(p.from.length === 7 ? p.from + '-01' : p.from);
    if (m.from && Number.isFinite(shift)) m.from = shiftDate(m.from, Math.round(shift / DAY));
    m.to = p.to;
    n++;
  }
  return n;
}

/** Проставить вехе-фестивалю выбранное событие (отдельно, чтобы `applyProposals` осталась простой). */
export function bindFest(doc: RoadmapDoc, milestoneId: string, eventId: string): void {
  const m = doc.milestones.find((x) => x.id === milestoneId);
  if (m) { m.kind = 'fest'; m.eventId = eventId; }
}

/** Готовность вехи — нужна вызывающему, чтобы не тянуть модель отдельно. */
export const isDone = (m: Milestone, ctx: Ctx): boolean => {
  const p = milestoneProgress(m, ctx);
  return p.total > 0 && p.ratio >= 1;
};

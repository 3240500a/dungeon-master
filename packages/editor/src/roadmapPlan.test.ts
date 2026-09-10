import { describe, it, expect } from 'vitest';
import {
  STEAM_EVENTS, byId, fests, earliestFest, nearMisses, eventAt, launchBlocker, bestLaunchDate,
  evStart, evEnd, weeksBetween, SALE_COOLDOWN_DAYS,
} from './roadmapCalendar.js';
import { replan, applyProposals, currentDrift } from './roadmapReplan.js';
import { SEED } from './roadmapSeed.js';
import type { Milestone, RoadmapDoc } from './roadmapModel.js';

/**
 * Пересчёт плана трогает ЕДИНСТВЕННУЮ дату, ошибка в которой не чинится работой — дату релиза.
 * Поэтому проверяем не «функция что-то вернула», а сами правила:
 *  • фестиваль не двигается «на месяц», он либо тот, либо следующий (±4 месяца);
 *  • запуск ВСЕГДА позже фестиваля — иначе фестиваль, который бывает раз в жизни игры, сгорает;
 *  • изначальный план не переписывается пересчётом, иначе отклонение обнулится и план всегда «удался».
 */

const day = (iso: string): number => Date.parse(iso + 'T12:00:00Z');
const DAY = 86_400_000;

describe('календарь: сами данные', () => {
  it('события идут по возрастанию и не вывернуты наизнанку', () => {
    for (const e of STEAM_EVENTS) expect(evStart(e)).toBeLessThanOrEqual(evEnd(e));
    for (let i = 1; i < STEAM_EVENTS.length; i++) {
      expect(evStart(STEAM_EVENTS[i]!)).toBeGreaterThanOrEqual(evStart(STEAM_EVENTS[i - 1]!));
    }
  });

  it('у каждого фестиваля три срока, и они идут в правильном порядке', () => {
    for (const f of fests()) {
      expect(f.regDeadline).toBeTruthy();
      expect(f.demoDeadline).toBeTruthy();
      expect(f.trailerDeadline).toBeTruthy();
      // ⭐ Демо сдаётся ПОЗЖЕ заявки — это и есть тот запас, который я сначала потерял, считая их одним сроком.
      expect(day(f.demoDeadline!)).toBeGreaterThan(day(f.regDeadline!));
      expect(day(f.trailerDeadline!)).toBeGreaterThan(day(f.regDeadline!));
      expect(day(f.demoDeadline!)).toBeLessThan(evStart(f));
      const reg = Math.round((evStart(f) - day(f.regDeadline!)) / DAY);
      const demo = Math.round((evStart(f) - day(f.demoDeadline!)) / DAY);
      expect(reg).toBeGreaterThanOrEqual(42);   // замер по объявленным: 49 / 43 / 50
      expect(reg).toBeLessThanOrEqual(52);
      expect(demo).toBeGreaterThanOrEqual(13);  // замер по объявленным: 21 / 14 / 14
      expect(demo).toBeLessThanOrEqual(22);
    }
  });

  it('объявленные Valve выпуски стоят с точными датами, непроверенные помечены', () => {
    const real = { 'fest-oct-26': ['2026-10-19', '2026-08-31', '2026-09-28'],
      'fest-feb-27': ['2027-02-22', '2027-01-10', '2027-02-08'],
      'fest-jun-27': ['2027-06-14', '2027-04-25', '2027-05-31'] } as Record<string, string[]>;
    for (const [id, [from, reg, demo]] of Object.entries(real)) {
      const f = byId(id)!;
      expect([f.from, f.regDeadline, f.demoDeadline, f.confirmed]).toEqual([from, reg, demo, true]);
    }
    for (const f of fests()) if (!real[f.id]) expect(f.confirmed).toBe(false);
  });

  it('фестивали идут трижды в год — между соседними не больше пяти месяцев', () => {
    const f = fests();
    for (let i = 1; i < f.length; i++) {
      const gap = Math.round((evStart(f[i]!) - evStart(f[i - 1]!)) / DAY);
      expect(gap).toBeLessThanOrEqual(155);
    }
  });
});

describe('окно запуска: причина отказа называется', () => {
  it('вторник отвергается первым — это день техобслуживания Steam', () => {
    expect(launchBlocker(day('2028-01-25'))).toBe('не понедельник');
  });

  it('понедельник внутри распродажи не годится', () => {
    expect(launchBlocker(day('2027-12-20'))).toMatch(/распродажа/);
  });

  it('ноябрь отвергается даже вне распродажи', () => {
    expect(eventAt(day('2027-11-22'))).toBeNull();
    expect(launchBlocker(day('2027-11-22'))).toMatch(/ноябрь/);
  });

  it('⭐ хвост распродажи: 10 и 17 января отвергнуты, 24-е принято', () => {
    // Зимняя-2027 кончается 2028-01-03. 10-е ещё внутри «плюс день», 17-е — две недели, 24-е — ровно три.
    expect(launchBlocker(day('2028-01-10'))).toBeTruthy();
    expect(launchBlocker(day('2028-01-17'))).toMatch(/бюджет покупателей/);
    expect(launchBlocker(day('2028-01-24'))).toBeNull();
    expect(Math.round((day('2028-01-24') - day('2028-01-03')) / DAY)).toBe(SALE_COOLDOWN_DAYS);
  });

  it('bestLaunchDate даёт согласованную с планом дату и объясняет отвергнутые', () => {
    const pick = bestLaunchDate(day('2028-01-05'));
    expect(pick.date).toBe('2028-01-24');
    expect(pick.rejected.map((r) => r.date)).toEqual(['2028-01-10', '2028-01-17']);
    expect(launchBlocker(day(pick.date))).toBeNull();
  });

  it('выбранный день всегда понедельник и всегда не раньше запрошенного', () => {
    for (const from of ['2026-09-10', '2027-03-01', '2027-06-30', '2027-12-01']) {
      const pick = bestLaunchDate(day(from));
      expect(new Date(day(pick.date)).getUTCDay()).toBe(1);
      expect(day(pick.date)).toBeGreaterThanOrEqual(day(from));
      expect(launchBlocker(day(pick.date))).toBeNull();
    }
  });
});

describe('выбор фестиваля: успеваем подать заявку, а не «попадаем на даты»', () => {
  it('⭐ демо готово в апреле 2027 → июньский фестиваль, а не октябрьский', () => {
    const f = earliestFest(day('2027-04-20'), day('2027-04-20'));
    expect(f?.id).toBe('fest-jun-27');
  });

  it('опоздали к сроку заявки на день — уже следующий фестиваль, это четыре месяца', () => {
    const jun = byId('fest-jun-27')!;
    const late = day(jun.regDeadline!) + DAY;
    expect(earliestFest(late, late)?.id).toBe('fest-oct-27');
  });

  it('сравнение идёт со СРОКОМ ЗАЯВКИ, а не с датой фестиваля', () => {
    // Демо готово за неделю до начала июньского: на сам фестиваль уже не попасть.
    const f = earliestFest(day('2027-06-07'), day('2027-06-07'));
    expect(f?.id).toBe('fest-oct-27');
  });

  it('за горизонтом календаря честно возвращается null, а не последний попавшийся', () => {
    expect(earliestFest(day('2030-01-01'), day('2030-01-01'))).toBeNull();
  });

  it('⭐ близкий промах называется в днях: до июньского-2027 не хватает 5 дней', () => {
    const readyBy = day('2027-04-30');                    // страница открывается 30 апреля
    expect(earliestFest(readyBy, day('2027-04-30'))?.id).toBe('fest-oct-27');
    const miss = nearMisses(readyBy, day('2027-04-30'));
    expect(miss.map((m) => [m.ev.id, m.lateBy])).toEqual([['fest-jun-27', 5]]);
  });

  it('далёкие промахи не показываются — смотреть на полгода опоздания незачем', () => {
    expect(nearMisses(day('2027-08-01'), day('2027-08-01'))).toEqual([]);
  });
});

// ── Синтетический план: две рабочие вехи, фестиваль и запуск ────────────────────────────────────
const mk = (over: Partial<Milestone> & { id: string; to: string }): Milestone =>
  ({ title: over.id, goal: '', items: [], ...over });

const docOf = (): RoadmapDoc => ({
  milestones: [
    mk({ id: 'm1', to: '2027-01-31', planned: '2027-01-31', closedAt: '2027-01-31' }),
    // m2 — публикация демо: именно она открывает заявку на фестиваль (см. `gatesFest`).
    mk({ id: 'm2', to: '2027-04-30', planned: '2027-04-30', gatesFest: true }),
    // m3 — доводка демо до сдачи билда: ВТОРОЙ срок фестиваля, на месяц позже заявки.
    mk({ id: 'm3', to: '2027-07-31', planned: '2027-07-31', gatesDemo: true }),
    mk({ id: 'fest', title: 'Next Fest', to: '2027-10-18', planned: '2027-10-18', kind: 'fest', eventId: 'fest-oct-27' }),
    mk({ id: 'launch', title: 'Запуск', to: '2028-01-24', planned: '2028-01-24', kind: 'launch' }),
  ],
});

describe('пересчёт плана', () => {
  it('идём по плану — рабочие вехи не трогаем и фестиваль остаётся прежним', () => {
    const doc = docOf();
    const { drift, proposals, notes } = replan(doc, { now: day('2027-02-01') });
    expect(drift).toBe(0);
    expect(proposals.filter((p) => p.milestoneId.startsWith('m'))).toHaveLength(0);
    expect(notes.join(' ')).toMatch(/Фестиваль остаётся прежним/);
  });

  it('отставание двигает ТОЛЬКО работу — фестиваль на месяц не переносится', () => {
    const doc = docOf();
    doc.milestones[0]!.closedAt = '2027-03-02';           // закрыли на 30 дней позже
    const { drift, proposals } = replan(doc, { now: day('2027-03-02') });
    expect(drift).toBe(30);
    expect(proposals.find((p) => p.milestoneId === 'm2')!.to).toBe('2027-05-30');
    // Месяц отставания съедается запасом до срока заявки — фестиваль остаётся на месте.
    expect(proposals.find((p) => p.milestoneId === 'fest')).toBeUndefined();
  });

  it('⚠ отстали так, что срок заявки прошёл → фестиваль прыгает ЦЕЛИКОМ, на 4 месяца', () => {
    const doc = docOf();
    doc.milestones[0]!.closedAt = '2027-06-15';           // +135 дней: гейт демо уезжает за 30 августа
    const { proposals, notes } = replan(doc, { now: day('2027-06-15') });
    const fest = proposals.find((p) => p.milestoneId === 'fest')!;
    expect(fest.to).toBe('2028-02-21');                   // не «октябрь + 120 дней», а следующий фестиваль
    expect(fest.later).toBe(true);
    expect(fest.why).toMatch(/страница выходит позже заявки/);
    expect(notes.join(' ')).not.toMatch(/остаётся прежним/);
  });

  it('⭐ опережение перецепляет на более ранний фестиваль (в этом весь смысл затеи)', () => {
    const doc = docOf();
    doc.milestones[0]!.closedAt = '2026-11-01';           // закрыли на 91 день раньше
    const { drift, proposals, notes } = replan(doc, { now: day('2026-11-01') });
    expect(drift).toBeLessThan(0);
    const fest = proposals.find((p) => p.milestoneId === 'fest')!;
    expect(fest.eventId).toBe('fest-jun-27');
    expect(fest.later).toBe(false);
    expect(notes.join(' ')).toMatch(/выигрыш/);
  });

  it('⚠ запуск ВСЕГДА позже фестиваля — иначе фестиваль сгорает', () => {
    for (const closed of ['2026-11-01', '2027-01-31', '2027-03-02', '2027-06-01']) {
      const doc = docOf();
      doc.milestones[0]!.closedAt = closed;
      const { proposals } = replan(doc, { now: day(closed) });
      applyProposals(doc, proposals);
      const fest = doc.milestones.find((m) => m.kind === 'fest')!;
      const launch = doc.milestones.find((m) => m.kind === 'launch')!;
      const ev = byId(fest.eventId!)!;
      expect(day(launch.to)).toBeGreaterThan(evEnd(ev));
      expect(weeksBetween(ev.to, launch.to)).toBeGreaterThanOrEqual(12);
      expect(launchBlocker(day(launch.to))).toBeNull();
    }
  });

  it('⚠ запуск не может быть раньше последней рабочей вехи — иначе релиз до «кандидата в релиз»', () => {
    const doc = docOf();
    doc.milestones.splice(3, 0, mk({ id: 'rc', title: 'Кандидат в релиз', to: '2027-12-31', planned: '2027-12-31' }));
    doc.milestones[0]!.closedAt = '2026-11-01';           // −91 день: фестиваль уезжает на июнь
    const { proposals } = replan(doc, { now: day('2026-11-01') });
    applyProposals(doc, proposals);
    const rc = doc.milestones.find((m) => m.id === 'rc')!;
    const launch = doc.milestones.find((m) => m.kind === 'launch')!;
    expect(day(launch.to)).toBeGreaterThan(day(rc.to));
  });

  it('применение сохраняет изначальный план — иначе отклонение обнулится и план всегда «удался»', () => {
    const doc = docOf();
    doc.milestones[0]!.closedAt = '2027-03-02';
    const { proposals } = replan(doc, { now: day('2027-03-02') });
    const n = applyProposals(doc, proposals);
    expect(n).toBe(proposals.length);
    for (const m of doc.milestones) expect(m.planned).toBe(docOf().milestones.find((x) => x.id === m.id)!.planned);
    expect(doc.milestones[1]!.to).toBe('2027-05-30');
  });

  it('применение не трогает закрытые вехи — факт задним числом не переписывается', () => {
    const doc = docOf();
    doc.milestones[0]!.closedAt = '2027-03-02';
    const { proposals } = replan(doc, { now: day('2027-03-02') });
    proposals.push({ milestoneId: 'm1', title: 'm1', from: '2027-01-31', to: '2027-09-09', why: '', later: true });
    applyProposals(doc, proposals);
    expect(doc.milestones[0]!.to).toBe('2027-01-31');
  });

  it('веха-фестиваль после применения остаётся привязанной к событию, а не к голой дате', () => {
    const doc = docOf();
    doc.milestones[0]!.closedAt = '2026-11-01';
    applyProposals(doc, replan(doc, { now: day('2026-11-01') }).proposals);
    const fest = doc.milestones.find((m) => m.kind === 'fest')!;
    expect(fest.eventId).toBe('fest-jun-27');
    expect(fest.to).toBe(byId('fest-jun-27')!.from);
  });

  it('пересчёт ничего не меняет сам по себе — решение остаётся за человеком', () => {
    const doc = docOf();
    doc.milestones[0]!.closedAt = '2027-03-02';
    const before = JSON.stringify(doc);
    replan(doc, { now: day('2027-03-02') });
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('отклонение берётся с последней ЗАКРЫТОЙ вехи, а отправная точка в счёт не идёт', () => {
    const doc = docOf();
    doc.milestones.unshift(mk({ id: 'm0', to: '2026-10-01', planned: '2026-12-01', closedAt: '2026-10-01', baseline: true }));
    expect(currentDrift(doc)).toBe(0);
  });
});

describe('реальный план из сида согласован с календарём', () => {
  const seed = SEED();
  const fest = seed.milestones.find((m) => m.kind === 'fest')!;
  const launch = seed.milestones.find((m) => m.kind === 'launch')!;

  it('веха-фестиваль стоит ровно на дате события, а не «примерно в октябре»', () => {
    const ev = byId(fest.eventId!)!;
    expect(fest.to).toBe(ev.from);
  });

  it('ровно одна веха помечена как гейт демо — иначе выбор фестиваля неоднозначен', () => {
    expect(seed.milestones.filter((m) => m.gatesFest)).toHaveLength(1);
  });

  it('дата запуска проходит все правила окна и отстоит от фестиваля минимум на 12 недель', () => {
    expect(launchBlocker(day(launch.to))).toBeNull();
    expect(weeksBetween(byId(fest.eventId!)!.to, launch.to)).toBeGreaterThanOrEqual(12);
  });

  it('⭐ пересчёт на нетронутом плане не предлагает НИЧЕГО — план и календарь уже сходятся', () => {
    const { drift, proposals } = replan(SEED(), { now: day('2026-09-10') });
    expect(drift).toBe(0);
    expect(proposals).toEqual([]);
  });
});

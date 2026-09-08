import type { PlaySessionRow } from '../db/telemetry.js';

/**
 * Детектор аномалий (Ф3.3).
 *
 * ПРАВИЛО, КОТОРОЕ ВАЖНЕЕ ВСЕХ ОСТАЛЬНЫХ: **ни одна автоматика здесь никого не банит.**
 * Она помечает, человек смотрит выгрузку, решение принимает человек. Один ложный бан стоит
 * дороже десяти пропущенных ботов: пойманный бот теряет аккаунт, а честный игрок — доверие
 * к игре, и рассказывает об этом всем. Автоматика по одному сигналу ложно срабатывает
 * гарантированно, поэтому вес сигнала и порог разбирательства разведены.
 *
 * Функции здесь ЧИСТЫЕ: на вход строки телеметрии, на выход пометки. Никакой базы, никакой
 * записи — иначе правила нельзя проверить тестом, а непроверяемое правило со временем начинает
 * ловить не то.
 */

/** Одна сработавшая сигнатура. */
export interface Flag {
  /** Кого пометили. */
  userId: string;
  /** Короткий код сигнатуры — по нему группируют и считают. */
  kind: 'marathon' | 'metronome' | 'ip-swarm' | 'value-outlier';
  /** Человеческое объяснение с числами: без него выгрузку невозможно разбирать. */
  why: string;
  /** Вес: 1 — «посмотреть», 2 — «странно», 3 — «почти наверняка». Не приговор, а очередь. */
  weight: number;
}

/** Пороги вынесены наружу: их придётся двигать по реальной популяции, а не по интуиции. */
export interface Thresholds {
  /** Часов подряд без выхода — сигнатура «марафон». */
  marathonHours: number;
  /** Разброс интервала между действиями (мс), ниже которого ритм не человеческий. */
  metronomeSdMs: number;
  /** Сколько действий нужно, чтобы разброс вообще что-то значил. */
  metronomeMinActions: number;
  /** Аккаунтов с одного адреса за окно — сигнатура «рой». */
  ipAccounts: number;
  /** Во сколько раз выше медианы популяции — сигнатура «выброс по ценности». */
  valueMedianMult: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  marathonHours: 16,
  // Человеческий разброс интервалов — десятки миллисекунд даже у тренированной руки.
  // 25 мс это уже подозрительно ровно; ставим с запасом, чтобы не ловить своих.
  metronomeSdMs: 25,
  metronomeMinActions: 200,
  ipAccounts: 4,
  valueMedianMult: 5,
};

/** Медиана — устойчива к выбросам, в отличие от среднего (которое сами же боты и сдвигают). */
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Разобрать телеметрию и вернуть пометки. Порядок — по весу, потом по объёму:
 * разбирать выгрузку человек будет сверху.
 */
export function detect(rows: PlaySessionRow[], th: Thresholds = DEFAULT_THRESHOLDS): Flag[] {
  const flags: Flag[] = [];

  // ── Марафон: сессия длиннее суток работы человека ──────────────────────────
  for (const r of rows) {
    const hours = r.minutes / 60;
    if (hours >= th.marathonHours) {
      flags.push({
        userId: r.user_id, kind: 'marathon', weight: 2,
        why: `сессия ${hours.toFixed(1)} ч подряд (персонаж ${r.char_id})`,
      });
    }
  }

  // ── Метроном: ритм действий ровнее человеческого ───────────────────────────
  for (const r of rows) {
    if (r.actions < th.metronomeMinActions) continue;   // на коротком куске разброс ничего не значит
    if (r.action_sd_ms > 0 && r.action_sd_ms < th.metronomeSdMs) {
      flags.push({
        userId: r.user_id, kind: 'metronome', weight: 3,
        why: `разброс интервала ${r.action_sd_ms.toFixed(1)} мс при среднем ${r.action_mean_ms.toFixed(0)} мс`
          + ` на ${r.actions} действиях — живая рука так не умеет`,
      });
    }
  }

  // ── Рой: много аккаунтов с одного адреса ───────────────────────────────────
  const byIp = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.ip) continue;
    let set = byIp.get(r.ip);
    if (!set) { set = new Set(); byIp.set(r.ip, set); }
    set.add(r.user_id);
  }
  for (const [ip, users] of byIp) {
    if (users.size < th.ipAccounts) continue;
    // Помечаем каждый аккаунт роя: разбирать всё равно придётся всех вместе.
    for (const userId of users) {
      flags.push({
        userId, kind: 'ip-swarm', weight: 1,
        why: `${users.size} аккаунтов с адреса ${ip} за окно наблюдения`
          + ' (может быть семья или общий интернет — смотреть вместе с остальными сигналами)',
      });
    }
  }

  // ── Выброс по ценности: набор золота и опыта против медианы популяции ───────
  const perHour = (r: PlaySessionRow): number => (r.gold + r.xp) / Math.max(1 / 60, r.minutes / 60);
  // В базу сравнения берём только сессии длиннее пяти минут: на минутных обрывках
  // «в час» превращается в шум и любой игрок выглядит выбросом.
  const solid = rows.filter((r) => r.minutes >= 5);
  const med = median(solid.map(perHour));
  if (med > 0) {
    for (const r of solid) {
      const v = perHour(r);
      if (v >= med * th.valueMedianMult) {
        flags.push({
          userId: r.user_id, kind: 'value-outlier', weight: 2,
          why: `${Math.round(v)} ценности в час против медианы ${Math.round(med)}`
            + ` (в ${(v / med).toFixed(1)} раза)`,
        });
      }
    }
  }

  return flags.sort((a, b) => b.weight - a.weight);
}

/** Свести пометки по аккаунтам: очередь на разбор, самые тяжёлые сверху. */
export function summarize(flags: Flag[]): { userId: string; score: number; kinds: string[]; why: string[] }[] {
  const by = new Map<string, { userId: string; score: number; kinds: Set<string>; why: string[] }>();
  for (const f of flags) {
    let e = by.get(f.userId);
    if (!e) { e = { userId: f.userId, score: 0, kinds: new Set(), why: [] }; by.set(f.userId, e); }
    // Разные сигнатуры складываются, одна и та же повторно — нет: десять марафонских сессий
    // это тот же самый сигнал, а не десять независимых поводов.
    if (!e.kinds.has(f.kind)) { e.score += f.weight; e.kinds.add(f.kind); e.why.push(f.why); }
  }
  return [...by.values()]
    .map((e) => ({ userId: e.userId, score: e.score, kinds: [...e.kinds], why: e.why }))
    .sort((a, b) => b.score - a.score);
}

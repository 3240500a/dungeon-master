/**
 * Телеметрия поведения (Ф3.2).
 *
 * ЗАЧЕМ. Автоприцел, идеальный ритм атак и боты-фармеры сервером не запрещаются — их нечем
 * запретить: клиент открыт, а всё, что он делает, законно по протоколу. Значит остаётся
 * второй вид защиты — заметить. Для этого нужны числа о том, КАК играют, а не только о том,
 * что произошло.
 *
 * ЧТО СЧИТАЕМ. Исследования по детекту ботов в RPG сходятся на нескольких группах признаков:
 * частота действий, ритм между действиями, продолжительность сессии, скорость набора ценности
 * и схожесть между аккаунтами. Первые четыре считаются прямо здесь; схожесть — уже запросом
 * по накопленным строкам (Ф3.3).
 *
 * ГЛАВНОЕ ЧИСЛО — РАЗБРОС ИНТЕРВАЛОВ. Человек не может бить с постоянным периодом: у живой
 * руки разброс десятки миллисекунд. У скрипта он близок к нулю. Считаем разброс алгоритмом
 * Уэлфорда: одним проходом, без хранения истории, в трёх числах.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Ни решений, ни санкций. Этот модуль только измеряет; кто и что с этими
 * числами делает — дело Ф3.3, и там правило прямое: автоматика помечает, а не банит.
 */

import { counters } from './metrics.js';

/** Накопитель по одной игровой сессии (вход в комнату → выход). */
export class SessionTelemetry {
  readonly startedAt = Date.now();
  kills = 0;
  gold = 0;
  xp = 0;
  items = 0;
  deaths = 0;
  floors = 0;
  /**
   * Кузница (K7, docs/CRAFT_WEAPONS.md §22): скованно, переплавлено скованных, разобрано найденных
   * (у кузнеца и на месте), зачаровано. Рядом с убийствами — иначе «цена ковки ≈ времени фарма»
   * после запуска проверить будет нечем. Считаются только УСПЕШНЫЕ действия, записанные в базу.
   */
  crafted = 0;
  melted = 0;
  salvaged = 0;
  enchanted = 0;
  /** Действий всего: атаки и команды — всё, что игрок делает НАМЕРЕННО. */
  actions = 0;

  /** Уэлфорд по интервалам между действиями (мс): n, среднее, сумма квадратов отклонений. */
  private n = 0;
  private mean = 0;
  private m2 = 0;
  private lastAt = 0;

  /**
   * Отметить намеренное действие. Интервалы длиннее минуты в разброс НЕ идут: это пауза
   * (отошёл, читает описание), и она рассказывает о человеке, а не о его ритме — попади она
   * в статистику, разброс раздулся бы и спрятал ровно то, что мы ищем.
   */
  action(at = Date.now()): void {
    this.actions++;
    if (this.lastAt) {
      const dt = at - this.lastAt;
      if (dt > 0 && dt <= 60_000) {
        this.n++;
        const d = dt - this.mean;
        this.mean += d / this.n;
        this.m2 += d * (dt - this.mean);
      }
    }
    this.lastAt = at;
  }

  /** Среднее и стандартное отклонение интервала, мс. Пусто, пока замеров меньше двух. */
  intervals(): { count: number; meanMs: number; sdMs: number } {
    return {
      count: this.n,
      meanMs: this.n ? this.mean : 0,
      sdMs: this.n > 1 ? Math.sqrt(this.m2 / (this.n - 1)) : 0,
    };
  }

  /** Длительность сессии, минуты. */
  minutes(now = Date.now()): number {
    return (now - this.startedAt) / 60_000;
  }

  /** Отметить успешное действие кузницы по причине записи (D9). Прочие причины — не кузница, мимо. */
  forge(reason: string): ForgeOp | null {
    const op = forgeOpOf(reason);
    if (op) this[op]++;
    return op;
  }

  /** Ценность в час: золото + опыт. Грубая мера «выхлопа» — для сравнения с популяцией. Рядом — кузница. */
  perHour(now = Date.now()): {
    goldPerHour: number; xpPerHour: number; killsPerHour: number;
    craftedPerHour: number; meltedPerHour: number; salvagedPerHour: number; enchantedPerHour: number;
  } {
    const h = Math.max(1 / 60, this.minutes(now) / 60);   // не делим на ноль на первой минуте
    return {
      goldPerHour: this.gold / h, xpPerHour: this.xp / h, killsPerHour: this.kills / h,
      craftedPerHour: this.crafted / h, meltedPerHour: this.melted / h,
      salvagedPerHour: this.salvaged / h, enchantedPerHour: this.enchanted / h,
    };
  }
}

/** Действие кузницы в телеметрии — имя счётчика сессии. */
export type ForgeOp = 'crafted' | 'melted' | 'salvaged' | 'enchanted';

/**
 * Причина записи (D9) → действие кузницы. Одна таблица на сессию и на `/metrics`: причина уже различает
 * переплавку скованного (`melt`) и разбор найденного (`salvage`) — второй раз решать это по вещи незачем,
 * да и вещи после разбора уже нет. `forge` (подъём тира, починка, перекатка) и `stash` — не сюда.
 */
export function forgeOpOf(reason: string): ForgeOp | null {
  switch (reason) {
    case 'craft': return 'crafted';
    case 'melt': return 'melted';
    case 'salvage': return 'salvaged';
    case 'enchant': return 'enchanted';
    default: return null;
  }
}

/** Счётчик `/metrics` для действия кузницы. */
const FORGE_COUNTER = {
  crafted: 'forgeCrafted', melted: 'forgeMelted', salvaged: 'forgeSalvaged', enchanted: 'forgeEnchanted',
} as const satisfies Record<ForgeOp, keyof typeof counters>;

/**
 * Успешное действие кузницы — в телеметрию сессии и в `/metrics` разом. Зовётся ПОСЛЕ удачной записи
 * (или удачного действия, которое запись не откатывает): отказ, откат и повтор ключа ковки не считаются.
 */
export function tallyForge(tm: SessionTelemetry, reason: string): void {
  const op = tm.forge(reason);
  if (op) counters[FORGE_COUNTER[op]]++;
}

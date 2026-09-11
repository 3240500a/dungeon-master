/**
 * КОНФИГ КОНТРОЛЛЕРА АНИМАЦИЙ (`pe_anim`, Ф1.2).
 *
 * Отвечает на два вопроса, которые до этого были зашиты в код и в имена файлов:
 *
 *  1. ЧЕМ ПРЕДМЕТ ПОДМЕШИВАЕТСЯ к безоружной базе — аддитивной дельтой на свою руку или заменой
 *     верха целиком (двуручное), в какой он руке и с какой силой. Раньше это решал захардкоженный
 *     список `TWO_HANDED` и позиция в ключе оружия; настроить факел в левой руке было нечем.
 *
 *  2. КАКОЙ КЛИП ЗА ЧТО ОТВЕЧАЕТ — по ССЫЛКЕ, а не по имени файла. Требование прямое:
 *     «переименовывать ничего не надо, это всё будет настраиваться в контроллере». Поэтому
 *     `idle_axe_relax` может быть базовой стойкой топора, оставаясь `idle_axe_relax`.
 *
 * ПУСТОЙ КОНФИГ = сегодняшнее поведение. Все умолчания выводятся из конвенции имён (`idle_<item>`,
 * `combat_idle_<item>`) и из типа предмета, поэтому файл можно не заводить вовсе.
 *
 * Модуль ЧИСТЫЙ (только разбор данных) — тестируется в node.
 */
import { isTwoHanded, type LayerKind } from './poseLayers.js';

/** Настройка одного предмета: чем он подмешивается и какими клипами описан. */
export interface AnimItem {
  /** `additive` — дельта на свою руку; `override` — заменяет верх целиком. Нет → двуручное = override. */
  kind?: LayerKind;
  /** В какой руке предмет. Нет → по позиции в ключе оружия (`sword+shield`: sword главная, shield офф). */
  hand?: 'main' | 'off';
  /** Сила подмешивания 0..1. Нет → 1 (поза предмета целиком). */
  weight?: number;
  /** Имя клипа спокойной стойки. Нет → `idle_<item>`. */
  idle?: string;
  /** Имя клипа боевой стойки. Нет → `combat_idle_<item>`. */
  combatIdle?: string;
}

/** Содержимое ключа `pe_anim` — по персонажу. */
export interface AnimGraph {
  /** Базовые БЕЗОРУЖНЫЕ стойки: от них строится всё. Нет → `idle_none` / `combat_idle_none`. */
  base?: { idle?: string; combatIdle?: string };
  items?: Record<string, AnimItem>;
  /**
   * Клипы состояний по имени состояния: `stagger`, `knockdown_fall`, `getup`, `hit_react_F`…
   * Нет записи — берётся клип с тем же именем, что и состояние; нет и его — состояние не
   * отыгрывается вовсе (и это нормально: пока клип не заавторен, ломаться нечему).
   */
  states?: Record<string, string>;
}
export type AnimStore = Record<string, AnimGraph>;

/** Разобранный конфиг: всё, что нужно рантайму, уже с подставленными умолчаниями. */
export interface AnimCfg {
  /** Имя клипа стойки для предмета (`none` = безоружная база). */
  clipName(kind: 'idle' | 'combat_idle', item: string): string;
  /** Тип оверлея предмета. */
  kindOf(item: string): LayerKind;
  /** Рука предмета, если задана явно (иначе решает позиция в ключе оружия). */
  handOf(item: string): 'main' | 'off' | undefined;
  /** Сила подмешивания 0..1. */
  weightOf(item: string): number;
  /** Есть ли вообще запись про этот предмет (для UI: показывать «настроено» или «по умолчанию»). */
  has(item: string): boolean;
  /** Имя клипа для состояния (`stagger`, `getup`…). Нет привязки → само имя состояния. */
  stateName(state: string): string;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Имя стойки по конвенции — умолчание, когда привязки нет. */
export const defaultStanceName = (kind: 'idle' | 'combat_idle', item: string): string => `${kind}_${item}`;

/**
 * Прочитать конфиг персонажа. `raw` — сырое содержимое `pe_anim` (что угодно из localStorage),
 * поэтому всё проверяется по месту: битая запись не должна ронять анимацию целиком.
 */
export function readAnimCfg(raw: unknown, charId: string, fallbackId?: string): AnimCfg {
  const store = (raw && typeof raw === 'object' ? raw : {}) as AnimStore;
  const g = store[charId] ?? (fallbackId ? store[fallbackId] : undefined) ?? {};
  const items = (g.items && typeof g.items === 'object' ? g.items : {}) as Record<string, AnimItem>;
  const it = (item: string): AnimItem | undefined => {
    const v = items[item];
    return v && typeof v === 'object' ? v : undefined;
  };
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  return {
    clipName(kind, item) {
      if (item === 'none') {
        const b = g.base && typeof g.base === 'object' ? g.base : {};
        const nm = kind === 'idle' ? str(b.idle) : str(b.combatIdle);
        return nm ?? defaultStanceName(kind, 'none');
      }
      const c = it(item);
      const nm = kind === 'idle' ? str(c?.idle) : str(c?.combatIdle);
      return nm ?? defaultStanceName(kind, item);
    },
    kindOf(item) {
      const k = it(item)?.kind;
      return k === 'additive' || k === 'override' ? k : (isTwoHanded(item) ? 'override' : 'additive');
    },
    handOf(item) {
      const h = it(item)?.hand;
      return h === 'main' || h === 'off' ? h : undefined;
    },
    weightOf(item) {
      const w = it(item)?.weight;
      return typeof w === 'number' && Number.isFinite(w) ? clamp01(w) : 1;
    },
    has: (item) => it(item) !== undefined,
    stateName(state) {
      const m = g.states && typeof g.states === 'object' ? (g.states as Record<string, unknown>) : {};
      return str(m[state]) ?? state;
    },
  };
}

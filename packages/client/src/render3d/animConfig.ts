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
export interface AnimItem extends AnimItemFidgets {
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

/**
 * Состояние слота действия — то, что раньше было константами в коде.
 *
 * `XFADE_SEC = 0.12` был один на все переходы; приоритет «нокдаун сильнее стана» был зашит порядком
 * `if`-ов; прервать текущее действие могло ЛЮБОЕ следующее; низом слот владел всегда по `1 − moveMag`.
 * Теперь это поля, и их можно авторить.
 */
export interface AnimState {
  /** Имя клипа. Нет → имя самого состояния. */
  clip?: string;
  /** Кто кого перебивает: больше — сильнее. Нет → 0. */
  priority?: number;
  /** Можно ли прервать это состояние до конца. Нет → можно (как было). */
  interruptible?: boolean;
  /** Кроссфейд входа, сек. Нет → 0.12 (прежняя константа). */
  blendSec?: number;
  /** Владение ногами: `auto` — по скорости (как было), `never` — только верх, `always` — всегда низ. */
  legs?: 'auto' | 'never' | 'always';
  /**
   * ЦЕПОЧКА: какие состояния могут пойти ПОСЛЕ этого (комбо). Пока это авторская разметка для графа —
   * рантайм выбирает следующий удар сам (`attackClips`); связывание придёт вместе с окном комбо.
   */
  next?: string[];
}

/** Дополнение `AnimItem`: вставки, требующие САМ предмет в руке (прокрут меча). */
export interface AnimItemFidgets {
  /**
   * ⭐ МЕСТО В ДАННЫХ = УСЛОВИЕ НА ОРУЖИЕ. Вставка под `items.sword` попадает в пул, только когда `sword`
   * реально в руках (разбор ключа — `splitHands`). Отдельного поля «требует предмет» нет НАРОЧНО: оно
   * смогло бы разойтись с действительностью, а место в данных разойтись не может.
   */
  fidgets?: (string | AnimFidget)[];
}

/**
 * ⭐ ОДИН ФИДЖЕТ — редкая вставка в покой («переступил», «крутанул мечом»). Короткая форма — просто имя
 * клипа, как у `states`. `weight` — это буквально «Chance to Play» из `Random Player` Unreal, `blend` —
 * его «Blend In» (сек).
 */
export interface AnimFidget { clip: string; weight?: number; blend?: number }
/** Разобранный фиджет: `scope` говорит, чем он является — подменой БАЗЫ или позой С ПРЕДМЕТОМ. */
export interface FidgetCfg { clip: string; weight: number; blend: number; scope: 'base' | 'item' }
/** Расписание редких вставок. Секунды. */
export interface IdleBreakCfg { after: number; gapMin: number; gapMax: number; blend: number }
/**
 * ⚠ УМОЛЧАНИЯ — ИЗ ЗАМЕРА, а не «на глаз»: 12 кукол × 10 минут непрерывного простоя на реальных длинах
 * тейков (7.4 / 7.1 / 12.4 / 15.8 / 10.0 с) дают 10–13 вставок на куклу, доля времени в фиджете 17–24 %,
 * средняя пауза 40.6 с при σ = 8.8 с. Разброс σ и есть ответ на «чтобы не по будильнику».
 */
export const IDLE_BREAK_DEF: IdleBreakCfg = { after: 12, gapMin: 25, gapMax: 55, blend: 0.25 };

/** Содержимое ключа `pe_anim` — по персонажу. */
export interface AnimGraph {
  /** Базовые БЕЗОРУЖНЫЕ стойки: от них строится всё. Нет → `idle_none` / `combat_idle_none`. */
  base?: {
    idle?: string; combatIdle?: string;
    /**
     * ⭐⭐ РЕДКИЕ ВСТАВКИ К БЕЗОРУЖНОЙ БАЗЕ. Подменяют БАЗУ, поэтому дельта предмета и авторский якорь
     * ложатся ПОВЕРХ — значит одна пачка играет со ВСЕМ оружием (замер: размах за фиджет безоружный = с
     * мечом, голова 26.8 → 26.8°, шея 31.2 → 31.2°; якорь меча не сдвинут, 1.7e-6°).
     */
    fidgets?: (string | AnimFidget)[];
    /** То же для боевой оси. Смешивает их уже стоящая ось `combat` — входа в бой чинить не надо. */
    combatFidgets?: (string | AnimFidget)[];
    /** Расписание. Нет — `IDLE_BREAK_DEF`. */
    idleBreak?: Partial<IdleBreakCfg>;
  };
  items?: Record<string, AnimItem>;
  /**
   * Состояния слота действия: `attack`, `stagger`, `knockdown_fall`, `getup`, `hit_react_F`…
   * Значение — либо просто имя клипа (короткая форма), либо настройка целиком.
   * Нет записи — клип с тем же именем, что и состояние; нет и его — состояние не отыгрывается
   * (и это нормально: пока клип не заавторен, ломаться нечему).
   */
  states?: Record<string, string | AnimState>;
  /** Раскладка узлов графа — тоже авторская работа, поэтому лежит рядом с данными, а не в личных настройках. */
  layout?: Record<string, { x: number; y: number }>;
}
export type AnimStore = Record<string, AnimGraph>;

/** Разобранный конфиг: всё, что нужно рантайму, уже с подставленными умолчаниями. */
export interface AnimCfg {
  /** Имя клипа стойки для предмета (`none` = безоружная база). */
  clipName(kind: 'idle' | 'combat_idle', item: string): string;
  /**
   * Пул редких вставок для этой оси и ЭТОГО набора предметов. `items` — что реально в руках
   * (обе руки; `splitHands` уже разобран вызывающим). Базовые идут всегда, предметные — только свои.
   */
  fidgets(kind: 'idle' | 'combat_idle', items: readonly string[]): FidgetCfg[];
  /** Расписание вставок (с умолчаниями). */
  idleBreak(): IdleBreakCfg;
  /** Имена для ПОИСКА в порядке приоритета: привязка (если есть) → нынешняя конвенция → историческая. */
  clipNames(kind: 'idle' | 'combat_idle', item: string): string[];
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
  /** Настройка состояния с подставленными умолчаниями (`next` — как записано, цепочки необязательны). */
  stateCfg(state: string): { clip: string; priority: number; interruptible: boolean; blendSec: number; legs: 'auto' | 'never' | 'always'; next: string[] };
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Кроссфейд входа в состояние по умолчанию — та самая прежняя константа `XFADE_SEC`. */
export const DEF_BLEND_SEC = 0.12;
/** Имя стойки по конвенции — умолчание, когда привязки нет. */
/**
 * ⭐⭐ КОНВЕНЦИЯ ИМЁН СТОЕК: **`idle_<оружие>_relax`** и **`idle_<оружие>_incombat`**.
 *
 * Схема автора: `действие_оружие_состояние`. Спокойная и боевая стойки — это ОДНО действие в двух
 * состояниях, поэтому состояние стоит суффиксом, а не отдельным префиксом: имена лежат рядом в
 * списке, и видно, что у оружия есть обе, а не две разные записи в разных концах алфавита.
 *
 * ⚠ УДАРЫ ЭТОЙ КОНВЕНЦИИ НЕ КАСАЮТСЯ: они по умолчанию боевые, и суффикс состояния им не нужен.
 * Их по-прежнему собирает префикс `hit_` (`attackClips`), а не это правило.
 *
 * ⚠ ИСТОРИЧЕСКИЕ ИМЕНА (`idle_<оружие>` / `combat_idle_<оружие>`) ПРОДОЛЖАЮТ НАХОДИТЬСЯ — см.
 * `stanceNameCandidates`. Создаём новые по новой схеме, ищем по обеим: смена конвенции не должна
 * обнулять чужую работу.
 */
export const defaultStanceName = (kind: 'idle' | 'combat_idle', item: string): string =>
  kind === 'idle' ? `idle_${item}_relax` : `idle_${item}_incombat`;

/** Имена-кандидаты при ПОИСКЕ стойки: сперва нынешняя конвенция, затем историческая. */
export const stanceNameCandidates = (kind: 'idle' | 'combat_idle', item: string): string[] =>
  [defaultStanceName(kind, item), `${kind}_${item}`];

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
    clipNames(kind, item) {
      // ⚠ Привязка ПЕРВОЙ: она явный выбор автора и должна бить любую конвенцию.
      const bound = this.clipName(kind, item);
      const out = [bound];
      for (const n of stanceNameCandidates(kind, item)) if (!out.includes(n)) out.push(n);
      return out;
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
    fidgets(kind, itemsInHand) {
      const num = (v: unknown, d: number, min = 0): number => (typeof v === 'number' && Number.isFinite(v) && v >= min ? v : d);
      const norm = (v: unknown, scope: 'base' | 'item'): FidgetCfg | null => {
        const o: AnimFidget = typeof v === 'string' ? { clip: v } : (v && typeof v === 'object' ? v as AnimFidget : { clip: '' });
        const nm = str(o.clip);
        if (!nm) return null;                                  // мусор в списке не роняет анимацию — просто не попадает в пул
        return { clip: nm, weight: num(o.weight, 1, 0), blend: num(o.blend, this.idleBreak().blend, 0), scope };
      };
      const list = (v: unknown, scope: 'base' | 'item'): FidgetCfg[] =>
        (Array.isArray(v) ? v : []).map((x) => norm(x, scope)).filter((x): x is FidgetCfg => !!x && x.weight > 0);
      const b = g.base && typeof g.base === 'object' ? g.base : {};
      const out = list(kind === 'idle' ? b.fidgets : b.combatFidgets, 'base');
      // ⚠ Боевая ось БЕЗ своей пачки падает на спокойную — та же логика, что у ролей стоек: пусто ≠ «молчи».
      const fallback = kind === 'combat_idle' && out.length === 0 ? list(b.fidgets, 'base') : [];
      const seen = new Set<string>();
      const res = [...out, ...fallback].filter((f) => !seen.has(f.clip) && seen.add(f.clip));
      for (const i of itemsInHand) {
        if (i === 'none') continue;
        for (const f of list(it(i)?.fidgets, 'item')) if (!seen.has(f.clip) && seen.add(f.clip)) res.push(f);
      }
      return res;
    },
    idleBreak() {
      const b = g.base && typeof g.base === 'object' ? g.base : {};
      const o = (b.idleBreak && typeof b.idleBreak === 'object' ? b.idleBreak : {}) as Partial<IdleBreakCfg>;
      const n = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);
      const gapMin = n(o.gapMin, IDLE_BREAK_DEF.gapMin);
      return {
        after: n(o.after, IDLE_BREAK_DEF.after),
        gapMin,
        gapMax: Math.max(gapMin, n(o.gapMax, IDLE_BREAK_DEF.gapMax)),   // перепутанные местами не ломают расписание
        blend: n(o.blend, IDLE_BREAK_DEF.blend),
      };
    },
    has: (item) => it(item) !== undefined,
    stateName(state) { return this.stateCfg(state).clip; },
    stateCfg(state) {
      const m = g.states && typeof g.states === 'object' ? (g.states as Record<string, unknown>) : {};
      const raw = m[state];
      const o: AnimState = typeof raw === 'string' ? { clip: raw } : (raw && typeof raw === 'object' ? raw as AnimState : {});
      const legs = o.legs === 'never' || o.legs === 'always' ? o.legs : 'auto';
      return {
        clip: str(o.clip) ?? state,
        priority: typeof o.priority === 'number' && Number.isFinite(o.priority) ? o.priority : 0,
        interruptible: o.interruptible !== false,
        blendSec: typeof o.blendSec === 'number' && Number.isFinite(o.blendSec) && o.blendSec >= 0 ? o.blendSec : DEF_BLEND_SEC,
        legs,
        next: Array.isArray(o.next) ? o.next.filter((n): n is string => typeof n === 'string') : [],
      };
    },
  };
}

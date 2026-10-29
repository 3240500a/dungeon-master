/**
 * НАБОР ФИЗ-ТЕЛ — ДАННЫЕ, А НЕ КОД (Ф11).
 *
 * Раньше таблица тел `B[]` в `humanoidRagdoll.ts` была зашита: 17 тел, родитель адресован ИНДЕКСОМ, и из
 * неё выведены шесть таблиц. Выключить тело было нельзя ни в каком смысле — сдвинулись бы все индексы.
 *
 * Здесь — чистое ядро пересборки. Оно решает единственную нетривиальную задачу: что делать с ребёнком,
 * у которого выключили родителя. Две вещи должны переехать:
 *   1) РОДИТЕЛЬ — становится ближайшим ВКЛЮЧЁННЫМ предком (иначе констрейнт не к чему цеплять);
 *   2) ЦЕПЬ РЕТАРГЕТА — углы выключенных предков сливаются в потомка. Физ-тело ведётся к ЛОКАЛЬНОМУ
 *      повороту относительно своего родителя; если между ними исчезло тело, его поворот обязан войти
 *      в цель потомка, иначе тело будет целиться мимо позы (голова «отстанет» на изгиб спины).
 * Второй пункт — тот, который легко забыть, и он не виден до тех пор, пока кто-то реально не выключит
 * тело в середине цепи. Поэтому он тут, в тестируемом виде, а не внутри создания Jolt-куклы.
 *
 * Модуль ЧИСТЫЙ (ни Jolt, ни THREE) — целиком тестируется в node. Сами тела (формы, оси, лимиты) остаются
 * в `humanoidRagdoll.ts`: это физика, ей тут не место.
 */

/** Узел каталога: имя, родитель ПО ИМЕНИ (индексы — забота активного набора) и цепь humanoid-костей. */
export interface PhysNode {
  name: string;
  parent: string | null;
  /** Humanoid-кости, чьи повороты складываются в поворот этого тела (порядок: родитель → ребёнок). */
  chain: string[];
  /** `core` — скелет, без которого кукла не кукла; `extra` — кисти/носки; `opt` — пальцы и прочая мелочь. */
  tier: 'core' | 'extra' | 'opt';
}

/** Тело активного набора: родитель уже ИНДЕКСОМ (как требует Jolt), цепь уже с учётом слияний. */
export interface PhysActive { name: string; parent: number; chain: string[] }

/**
 * Активный набор из каталога и множества включённых имён.
 * Корень (`parent === null`) включён ВСЕГДА — без таза нет ни kinematic-авторитета, ни дерева.
 * Порядок каталога сохраняется, поэтому «родитель раньше ребёнка» (требование Jolt) держится само.
 */
export function resolvePhysSet(catalog: readonly PhysNode[], enabled: Iterable<string>): PhysActive[] {
  const on = new Set(enabled);
  const byName = new Map(catalog.map((n) => [n.name, n]));
  const idxOf = new Map<string, number>();
  const folded = new Map<string, string[]>();   // имя ВЫКЛЮЧЕННОГО узла → что он передаёт детям
  const out: PhysActive[] = [];
  for (const n of catalog) {
    const inherited = n.parent ? (folded.get(n.parent) ?? []) : [];
    if (n.parent === null || on.has(n.name)) {
      let p: string | null | undefined = n.parent;
      while (p && !idxOf.has(p)) p = byName.get(p)?.parent ?? null;   // вверх до ближайшего включённого
      out.push({ name: n.name, parent: p ? idxOf.get(p)! : -1, chain: [...inherited, ...n.chain] });
      idxOf.set(n.name, out.length - 1);
      folded.set(n.name, []);                    // включён → цепь дальше не течёт
    } else {
      folded.set(n.name, [...inherited, ...n.chain]);
    }
  }
  return out;
}

/** Пресеты набора. `custom` не перечислен: это «то, что юзер натыкал галками». */
export interface PhysPreset { id: string; label: string; hint: string; tiers: PhysNode['tier'][] }

export const PHYS_PRESETS: readonly PhysPreset[] = [
  { id: 'min', label: 'Минимум', hint: 'таз/спина/голова/конечности — дешевле всего, кисти и носки ведёт поза', tiers: ['core'] },
  { id: 'base', label: 'Базовый', hint: 'как было всегда: + кисти и носки', tiers: ['core', 'extra'] },
  { id: 'full', label: '+ пальцы', hint: 'каждая фаланга получает физ-тело — дорого, но пальцы физически взаимодействуют', tiers: ['core', 'extra', 'opt'] },
];

/** Имена тел пресета. Неизвестный id — базовый набор (тихо ломаться тут нечему, но и падать незачем). */
export function presetBodies(catalog: readonly PhysNode[], id: string): string[] {
  const pr = PHYS_PRESETS.find((p) => p.id === id) ?? PHYS_PRESETS.find((p) => p.id === 'base')!;
  return catalog.filter((n) => pr.tiers.includes(n.tier)).map((n) => n.name);
}

/** Совпадает ли набор с каким-то пресетом (чтобы выпадашка показывала «Свой» честно). */
export function matchPhysPreset(catalog: readonly PhysNode[], names: Iterable<string>): string {
  const set = new Set(names);
  for (const pr of PHYS_PRESETS) {
    const want = presetBodies(catalog, pr.id);
    if (want.length === set.size && want.every((n) => set.has(n))) return pr.id;
  }
  return 'custom';
}

/**
 * Что реально стоит шаг симуляции: тел и констрейнтов. Констрейнт — у каждого тела, кроме корня,
 * поэтому число выводится из набора, а не считается отдельно.
 */
export const physCost = (active: readonly { name: string }[]): { bodies: number; constraints: number } =>
  ({ bodies: active.length, constraints: Math.max(0, active.length - 1) });

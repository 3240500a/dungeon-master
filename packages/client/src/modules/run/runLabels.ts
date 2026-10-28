import { waypointGap, type RunNodeType, type WaypointPlaces } from '@dm/shared';

/**
 * Единые русские подписи и цвета типов узлов забега (v2). Используются рендером выходов
 * (2D `OnlineScene`/3D `online3d`), миникартой и панелью «Карта забега» — одна истина.
 */
export const RUN_NODE_LABEL: Record<RunNodeType, string> = {
  start: 'Вход',
  combat: 'Бой',
  elite: 'Элита',
  boss: 'Босс',
  treasure: 'Сокровищница',
  rest: 'Привал',
};

export const RUN_NODE_COLOR: Record<RunNodeType, number> = {
  start: 0x9fd0ff,
  combat: 0x8a8f9a,
  elite: 0xd0a040,
  boss: 0xd05050,
  treasure: 0xf0d070,
  rest: 0x8a5cff,
};

/**
 * ⭐ Г3 (В6): СТРОКА HUD ПРО МЕТКУ — ОДИН ШОВ НА ОБА КЛИЕНТА. Арифметику считает чистая функция глубины
 * (`waypointGap` из `@dm/shared`, та же каденция, что у генератора), а текст живёт здесь — рядом с прочими
 * подписями забега, чтобы 2D (`UIScene`) и 3D (`hud3d`) не разъехались словами при одинаковых числах.
 *
 * ⚠ Без склонения намеренно («до метки 2 эт.»): шаг каденции — число баланса, и при шаге 11 в строке оказалось бы
 * «10 этажей», при шаге 2 — «1 этаж». Падежи пришлось бы считать на каждом кадре HUD ради одного слова.
 */
export function waypointHint(depth: number, places: WaypointPlaces, cycle: number): string {
  const gap = waypointGap(depth, places, cycle);
  return gap === 0 ? 'метка здесь' : `до метки ${gap} эт.`;
}

export function runNodeLabel(t: string): string {
  return RUN_NODE_LABEL[t as RunNodeType] ?? t;
}
export function runNodeColor(t: string): number {
  return RUN_NODE_COLOR[t as RunNodeType] ?? 0x8a8f9a;
}

/**
 * ⭐⭐ Г8-2 (15.10): ПОДПИСЬ ЛЕСТНИЦЫ БОССОВ — «5 · 14 · 20 полосы». Один шов на алтарь, эталон порта Unity и любую
 * будущую панель: лестница живёт в данных (`balance.dungeonAccess.bossLadder`), и её места обязаны читаться игроку
 * одинаково всюду. Ранг в подписи не называем — на чипе шаблона важно ГДЕ, а не насколько тяжёлый.
 */
export function bossLadderText(ladder: readonly { at: number; rank: string }[] | undefined | null): string {
  // ⚠ ПОДПИСЬ ОБЯЗАНА БЫТЬ ВСЮДУ ОПРЕДЕЛЕНА: её зовут и на синтетических конфигах стендов, где `dungeonAccess`
  // собран частично (замер: `[...undefined]` ронял продюсер эталона — «ladder is not iterable»). Нет лестницы — «нет».
  const at = (Array.isArray(ladder) ? ladder : [])
    .map((x) => Math.floor(Number(x?.at)))
    .filter((x) => Number.isFinite(x) && x >= 1)
    .sort((a, b) => a - b);
  return at.length ? `${at.join(' · ')} полосы` : 'нет';
}

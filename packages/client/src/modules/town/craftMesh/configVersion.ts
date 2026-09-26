import type { ConfigRegistry } from '@dm/shared';

/**
 * Таблицы конфига, из которых строится модель из деталей (`buildCraftMesh`): анатомия, сами детали, тип → база
 * (её стихия красит свечение фокуса), тип читает и `balance`. Правка любой — другая модель при той же подписи.
 */
export const CRAFT_MESH_DEPS = ['items.base', 'weapon-parts', 'weapon-anatomy', 'weapon-types', 'balance'] as const;

const seen = new WeakMap<ConfigRegistry, { deps: unknown[]; ver: number }>();
let seq = 0;

/**
 * ⭐ ВЕРСИЯ КОНФИГА МОДЕЛИ — в ключ всего, что кэширует модель по подписи деталей (R1-22).
 *
 * Реестр правится НА МЕСТЕ (`reload`: конфиг сервера при старте, live-apply редактора), а подпись вида — только база
 * и id:ступень деталей. Ключ «объект реестра + подпись» правки не видел: сбой, пойманный до прихода конфига,
 * залипал на сессию, а новые куклы брали модель старой формы. `reload` кладёт каждую таблицу НОВЫМ объектом —
 * сравниваем ссылки, как `DERIVED_DEPS` в `shared/session/weapon3d.ts`. Номер уникален на страницу, поэтому
 * реестр отдельно в ключ класть не нужно. Модуль крошечный и НЕ тянет построитель (`index.ts` грузится лениво).
 */
export function craftMeshConfigVersion(reg: ConfigRegistry): number {
  // Таблицы нет (битый реестр) — `undefined`: сборка упадёт сама и будет помечена несобираемой, версия не скачет.
  const deps = CRAFT_MESH_DEPS.map((k) => { try { return reg.get(k) as unknown; } catch { return undefined; } });
  const s = seen.get(reg);
  if (s && s.deps.every((d, i) => d === deps[i])) return s.ver;
  const ver = ++seq;
  seen.set(reg, { deps, ver });
  return ver;
}

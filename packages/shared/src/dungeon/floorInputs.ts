import type { ConfigRegistry } from '../config/registry.js';
import type { Biome } from '../config/schemas.js';
import { decorPlaceOf, decorSpecsFor, obstaclesFromDecor, type DecorSpec, type PlaceDecorOpts } from './decor.js';
import { dressingOf, type DressingOpts } from './dressing.js';
import type { DungeonLayout } from './floorCommon.js';
import { generateFloor, type GenFloorOpts } from './generateFloor.js';
import type { FloorSpec } from './run/types.js';
import type { Obstacle } from '../world/state.js';

/**
 * ⭐ 12.10 (Ф1 «Паспорт», G12): ВХОДЫ СБОРКИ ЭТАЖА БИОМА — одни на сервер (`Room.enterNode`), сим (`runSessionSim`),
 * нагрузочный стенд и превью редактора (забег, этажи, лут). ⚠ Фаззер правил (`session/fuzz/rulesFuzz.ts`) пока зовёт `generateFloor`
 * сам, без плотности биома (`decorPlace` = умолчания): сегодня это те же этажи (`decorDensity` всех биомов = умолчаниям), но правка
 * плотности его разведёт — перевести на `generateFloorFor`, когда файл освободит соседняя работа. Раньше каждый звал `generateFloor` со своим набором: редактор и сим — без спек
 * декора и без оформления (в превью не было ни статуй, ни костров, а в симе — их преград), сервер — без плотности россыпи (`undefined`).
 * Теперь «редактор ≡ игра»: спеки декора биома (строки `objects` + неявные объекты паспортов, `decorSpecsFor`), плотность россыпи биома
 * (`biomes[].decorDensity`, `decorPlaceOf`), сундуки этажа (`chests` + `balance.loot.chestsPerFloor`), оформление (`dressingOf`).
 * Реестр — любой с `get`: живой сервера, свой у сима, рабочая копия редактора — СЫРЫЕ данные `{ get: (k) => data[k] }` (не разобранный
 * реестр; сверено: те же этажи, что у разобранного).
 */
export type FloorConfig = Pick<ConfigRegistry, 'get'>;

export interface FloorInputs {
  /** Спеки расставляемых объектов биома (россыпь, оформление, коллайдеры преград). */
  decorSpecs: DecorSpec[];
  /** Плотность россыпи биома; нет поля у биома — умолчания `placeFloorDecor`. */
  decorPlace?: PlaceDecorOpts;
  /** Сундуки этажа. */
  chests: NonNullable<GenFloorOpts['chests']>;
  /** Оформление биома по правилу; нет `dressing` у биома — `undefined`. */
  dressing?: DressingOpts;
}

/** Входы сборки этажа биома `biome` из конфига `cfg` (нет биома — без декора и оформления, сундуки — как у всех). */
export function floorInputs(cfg: FloorConfig, biome: Biome | undefined): FloorInputs {
  const balance = cfg.get('balance');
  return {
    decorSpecs: biome ? decorSpecsFor(cfg.get('objects'), cfg.get('models'), biome.id, cfg.get('art')) : [],
    decorPlace: decorPlaceOf(biome),
    chests: { tiers: cfg.get('chests'), perFloor: balance.loot.chestsPerFloor },
    dressing: dressingOf(biome, balance),
  };
}

/** Этаж узла забега так, как его строит сервер: `generateFloor` с входами биома + преграды декора (`obstaclesFromDecor`) для сессии. */
export function generateFloorFor(cfg: FloorConfig, spec: FloorSpec, biome: Biome | undefined): { layout: DungeonLayout; inputs: FloorInputs; obstacles: Obstacle[] } {
  const inputs = floorInputs(cfg, biome);
  const layout = generateFloor(spec, cfg.get('room-prefabs'), inputs.decorSpecs, inputs.decorPlace, inputs.chests, inputs.dressing);
  const obstacles = obstaclesFromDecor(layout.decor, new Map(inputs.decorSpecs.map((s) => [s.id, s])));
  return { layout, inputs, obstacles };
}

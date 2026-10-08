import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { ConfigRegistry, type ConfigKey, type CraftParts } from '@dm/shared';
import { buildCraftMesh, type CraftMeshResult } from '../../../client/src/modules/town/craftMesh/index.js';
import { CRAFT_MESH_DEPS } from '../../../client/src/modules/town/craftMesh/configVersion.js';

/**
 * ⭐ ПЕЧЬ МОДЕЛИ ИЗ ДЕТАЛЕЙ: тот же построитель, что у веб-клиента (`client/modules/town/craftMesh`), → бинарный GLB.
 *
 * Зачем на сервере: геометрия клинка кормит его статы (`bladeGeom.ts` → `shared/formulas/bladeStats.ts`), и второй построитель
 * (порт 5.2 тыс. строк в C#) был бы второй правдой о форме — решение Р2 плана Unity. Unity грузит GLB через glTFast и
 * ставит свои материалы по именам.
 *
 * Модуль грузит `three` и 5.7 тыс. строк построителей — поэтому живёт ТОЛЬКО в потоке печи (`worker.ts`) и в тестах.
 * Главный поток (ручка, тик комнат одиночного процесса) его не импортирует никогда.
 *
 * КОНТРАКТ ФАЙЛА (docs/CRAFT_WEAPONS.md §21.1 «Модель из деталей — GLB с сервера»):
 * - единицы — САНТИМЕТРЫ реального оружия (контракт построителя, `craftMesh/core.ts`); в метры переводит клиент (×0.01);
 * - начало координат — хват основной руки, рабочий конец — в −Y, плоскость клинка — XY (лезвия по ±X, толщина по Z);
 * - корневой узел `craftWeapon`, под ним РОВНО четыре узла гнёзд `strike`, `grip`, `bind`, `head`; меши — `<гнездо>.<n>`;
 *   у узла-зеркала (вторая половина гарды) масштаб −1 по X — так и в GLB (glTF это разрешает, порядок обхода — по знаку);
 * - материал — `семья:ступень` (`iron:3`), у светящегося фокуса `focus:2:glow=9ec8ff`, мелочь вне лестниц — `fixed:rrggbb`;
 *   цвет, металличность и шероховатость лежат в PBR материала — показ без своих материалов тоже честный;
 * - `extras` корня: `{ dmCraftMesh: { v, units: 'cm', grip: 'origin', workingEnd: '-Y', look, rev } }`.
 *
 * ⭐ 08.10 (Ф4, план «Unity — дом визуального контента»): та же сборка (`buildForBake`) печётся и в двоичный DMCM v1 (`encodeBin.ts`,
 * `GET /api/craft-mesh.bin`) — Unity уходит от glTFast. GLB остаётся для старых сборок Unity и как оракул паритета (`craftMeshBin.test.ts`).
 */

/**
 * ⚠ `GLTFExporter` собирает бинарный GLB через `FileReader`, а в node его нет. Шим в три строки — как в
 * `client/render3d/glbExport.test.ts`: на содержимое файла он не влияет.
 */
class NodeFileReader {
  result: ArrayBuffer | null = null;
  onloadend: (() => void) | null = null;
  readAsArrayBuffer(b: Blob): void { void b.arrayBuffer().then((ab) => { this.result = ab; this.onloadend?.(); }); }
}
(globalThis as unknown as { FileReader?: unknown }).FileReader ??= NodeFileReader;

/** Версия формата файла — в `extras` корня; поднимать, когда меняется контракт выше. */
export const CRAFT_GLB_FORMAT = 1;

/**
 * Реестр печи — ТОЛЬКО таблицы модели (`CRAFT_MESH_DEPS`). Любая другая таблица бросает «не загружен»: построитель, начавший
 * читать таблицу вне списка, падает здесь громко (сторож — `craftMeshBake.test.ts`), а не печёт модель, которую кэш по
 * ревизии этих таблиц не увидел бы устаревшей. Таблицы уже разобраны схемой на главном потоке — правило поверх нескольких
 * таблиц (`cross`) судит сборка живого конфига, не печь.
 */
export function depsRegistry(tables: Readonly<Record<string, unknown>>): ConfigRegistry {
  const reg = new ConfigRegistry();
  const partial: Partial<Record<ConfigKey, unknown>> = {};
  for (const k of CRAFT_MESH_DEPS) partial[k] = tables[k];
  reg.reload(partial, { cross: false });
  return reg;
}

/** Нормали построителя бывают ненормированными; экспортёр тогда копирует атрибут и пишет предупреждение на КАЖДЫЙ меш. */
function normalizeNormals(geo: THREE.BufferGeometry): void {
  const n = geo.getAttribute('normal') as THREE.BufferAttribute | undefined;
  if (!n) return;
  const v = new THREE.Vector3();
  for (let i = 0; i < n.count; i++) {
    v.fromBufferAttribute(n, i);
    if (v.x === 0 && v.y === 0 && v.z === 0) v.setX(1); else v.normalize();   // как `createNormalizedNormalAttribute` экспортёра
    n.setXYZ(i, v.x, v.y, v.z);
  }
}

export interface BakeMeta {
  /** Подпись вида (`weaponLookSig`). */
  look: string;
  /** Ревизия таблиц модели, с которой печётся. */
  rev: string;
}

/**
 * Сборка вида, готовая к печи в ЛЮБОЙ формат: корень `craftWeapon`, `userData` с контрактом, меши `<гнездо>.<n>`, нормали нормированы
 * (каждая геометрия — один раз: зеркальные клоны делят её с оригиналом). ⭐ 08.10 (Ф4): одна подготовка на GLB и DMCM (`encodeBin.ts`) —
 * два формата одной сборки не расходятся ни нормалями, ни обходом. `null` — построитель не собрал; освобождает вызывающий (`dispose`).
 */
export function buildForBake(reg: ConfigRegistry, weaponClass: string, hands: number, parts: CraftParts, meta: BakeMeta): CraftMeshResult | null {
  const res = buildCraftMesh(reg, weaponClass, hands, parts);
  if (!res) return null;
  try {
    const root = res.group;
    root.name = 'craftWeapon';
    root.userData = { dmCraftMesh: { v: CRAFT_GLB_FORMAT, units: 'cm', grip: 'origin', workingEnd: '-Y', look: meta.look, rev: meta.rev } };
    const seen = new Set<THREE.BufferGeometry>();
    for (const slot of root.children) {
      let i = 0;
      slot.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        if (!m.name) m.name = `${slot.name}.${i}`;
        i++;
        if (!seen.has(m.geometry)) { seen.add(m.geometry); normalizeNormals(m.geometry); }
      });
    }
    return res;
  } catch (e) {
    res.dispose();
    throw e;
  }
}

/**
 * Испечь GLB. `null` — построитель модели не собрал (нет детали или анатомии); исключение построителя уходит наверх — поток
 * печи отвечает сбоем (`error`), а несобираемым вид считает служба, если сбой повторился (`service.ts`). Геометрия и материалы
 * сборки освобождаются в любом исходе.
 */
export async function bakeCraftGlb(reg: ConfigRegistry, weaponClass: string, hands: number, parts: CraftParts, meta: BakeMeta): Promise<Uint8Array | null> {
  const res = buildForBake(reg, weaponClass, hands, parts, meta);
  if (!res) return null;
  try {
    const out = await new GLTFExporter().parseAsync(res.group, { binary: true, trs: true, onlyVisible: true });
    if (!(out instanceof ArrayBuffer)) throw new Error('экспортёр вернул не бинарный GLB');
    return new Uint8Array(out);
  } finally {
    res.dispose();
  }
}

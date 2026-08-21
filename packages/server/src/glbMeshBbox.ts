/**
 * ИЗВЛЕЧЕНИЕ КОЛЛАЙДЕРА ИЗ GLB (dev-аплоад напольного декора). Моделлер кладёт в GLB невидимый меш по конвенции имени
 * `collider*` — его габариты задают форму коллизии (которую считает СЕРВЕР). Здесь читаем ТОЛЬКО JSON-чанк GLB
 * (glTF гарантирует `min`/`max` у POSITION-аксессора) → XZ-габариты bbox → коллайдер в ДОЛЯХ ТАЙЛА.
 *
 * Конвенция масштаба: 100 модель-единиц = 1 тайл (как floorUnitScale в клиенте; 1 тайл = 1 м). Ось «вверх» — Z
 * (экспорт из Max, Z-up): горизонталь = модель-X (→ игровой X) и модель-Y (→ игровой Z), высота = Z (не нужна для XZ).
 * Форма подсказывается по квадратности footprint'а; финальную форму (круг/бокс) выбирает объект в редакторе.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;

export interface MeshCollider { shape: 'circle' | 'box'; r?: number; w?: number; h?: number }

/** Парсит JSON-чанк GLB (без декода бинаря). null на не-GLB/повреждённом. */
function parseGlbJson(input: Buffer): any | null {
  try {
    if (input.length < 12 || input.readUInt32LE(0) !== MAGIC || input.readUInt32LE(4) !== 2) return null;
    let off = 12;
    while (off + 8 <= input.length) {
      const clen = input.readUInt32LE(off), ctype = input.readUInt32LE(off + 4), cstart = off + 8;
      if (ctype === CHUNK_JSON) return JSON.parse(new TextDecoder().decode(input.subarray(cstart, cstart + clen)));
      off = cstart + clen;
    }
  } catch { /* повреждён */ }
  return null;
}

/** Индексы мешей, чьё имя (или имя ссылающегося на них узла) начинается на `collider`. */
function colliderMeshIndices(json: any): Set<number> {
  const out = new Set<number>();
  const meshes: any[] = Array.isArray(json.meshes) ? json.meshes : [];
  meshes.forEach((m, i) => { if (typeof m?.name === 'string' && /^collider/i.test(m.name)) out.add(i); });
  for (const n of (Array.isArray(json.nodes) ? json.nodes : [])) {
    if (typeof n?.name === 'string' && /^collider/i.test(n.name) && typeof n.mesh === 'number') out.add(n.mesh);
  }
  return out;
}

/**
 * Извлекает коллайдер из меша `collider*` GLB (габариты в долях тайла). null — если такого меша нет или нет min/max.
 * `unitsPerTile` — модель-единиц на тайл (конвенция 100).
 */
export function extractColliderFromGlb(input: Buffer, unitsPerTile = 100): MeshCollider | null {
  const json = parseGlbJson(input);
  if (!json) return null;
  const idxs = colliderMeshIndices(json);
  if (!idxs.size) return null;
  const meshes: any[] = Array.isArray(json.meshes) ? json.meshes : [];
  const accessors: any[] = Array.isArray(json.accessors) ? json.accessors : [];
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  let found = false;
  for (const mi of idxs) {
    for (const prim of (meshes[mi]?.primitives ?? [])) {
      const pa = prim?.attributes?.POSITION;
      const acc = typeof pa === 'number' ? accessors[pa] : null;
      if (!acc || !Array.isArray(acc.min) || !Array.isArray(acc.max)) continue;   // glTF требует min/max у POSITION
      for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k]!, acc.min[k]); mx[k] = Math.max(mx[k]!, acc.max[k]); }
      found = true;
    }
  }
  if (!found) return null;
  const upt = unitsPerTile > 1e-6 ? unitsPerTile : 100;
  const fx = Math.abs(mx[0]! - mn[0]!) / upt;   // модель-X → игровой X (тайлы)
  const fz = Math.abs(mx[1]! - mn[1]!) / upt;   // модель-Y → игровой Z (Z-up)
  const lo = Math.min(fx, fz), hi = Math.max(fx, fz);
  if (hi <= 1e-4) return null;
  // Квадратный footprint → круг (цилиндр), иначе бокс. Финальную форму задаёт объект; это подсказка.
  if (lo / hi > 0.72) return { shape: 'circle', r: hi / 2 };
  return { shape: 'box', w: fx, h: fz };
}

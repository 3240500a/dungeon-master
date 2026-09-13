/**
 * НОРМАЛИЗАЦИЯ ЭКСПОРТИРОВАННОГО GLB: ОДИН СКЕЛЕТ — ОДИН СКИН.
 *
 * Норма индустрии для модульного персонажа: ОДНА арматура и много скиннед-мешей, которые на неё
 * ссылаются. В glTF это выражается прямо — несколько мешей с ОДНИМ индексом `skin`.
 *
 * ⚠ `GLTFExporter` так не умеет: он заводит скин НА КАЖДЫЙ `SkinnedMesh`, даже когда все они сидят на
 * одном `THREE.Skeleton`. Наш рыцарь — 38 частей, и на выходе получалось 38 одинаковых скинов по 100
 * суставов. Это не просто лишние килобайты: при следующей загрузке из такого файла снова рождается 38
 * скелетов, и их снова приходится схлопывать (`skeletonDedupe`). То есть костыль на загрузке кормил
 * сам себя — файл оставался «неправильным», сколько бы раз его ни переэкспортировали.
 *
 * Поэтому нормализуем САМ ФАЙЛ: скины с одинаковым набором суставов И одинаковыми обратными
 * бинд-матрицами схлопываются в один, узлы переводятся на него. Двоичный чанк не трогаем — меняется
 * только JSON, поэтому операция дешёвая и обратимая по смыслу.
 */

const MAGIC = 0x46546c67, JSON_CHUNK = 0x4e4f534a, BIN_CHUNK = 0x004e4942;

interface Chunks { json: Record<string, unknown>; bin: Uint8Array | null }

function readGlb(buf: ArrayBuffer): Chunks {
  if (buf.byteLength < 20) throw new Error('не GLB: файл короче заголовка');
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('не GLB: нет сигнатуры glTF');
  let off = 12, json: Record<string, unknown> | null = null, bin: Uint8Array | null = null;
  while (off + 8 <= buf.byteLength) {
    const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
    if (type === JSON_CHUNK) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, off + 8, len))) as Record<string, unknown>;
    else if (type === BIN_CHUNK) bin = new Uint8Array(buf, off + 8, len);
    off += 8 + len;
  }
  if (!json) throw new Error('не GLB: JSON-чанк не найден');
  return { json, bin };
}

/** Собрать GLB обратно. Паддинг по спецификации: JSON добивается пробелами, BIN — нулями. */
function writeGlb(json: Record<string, unknown>, bin: Uint8Array | null): ArrayBuffer {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const binLen = bin ? bin.length : 0;
  const binPad = bin ? (4 - (binLen % 4)) % 4 : 0;
  const total = 12 + 8 + jsonBytes.length + jsonPad + (bin ? 8 + binLen + binPad : 0);
  const out = new ArrayBuffer(total);
  const dv = new DataView(out), u8 = new Uint8Array(out);
  dv.setUint32(0, MAGIC, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  let off = 12;
  dv.setUint32(off, jsonBytes.length + jsonPad, true); dv.setUint32(off + 4, JSON_CHUNK, true);
  u8.set(jsonBytes, off + 8);
  for (let i = 0; i < jsonPad; i++) u8[off + 8 + jsonBytes.length + i] = 0x20;   // пробел
  off += 8 + jsonBytes.length + jsonPad;
  if (bin) {
    dv.setUint32(off, binLen + binPad, true); dv.setUint32(off + 4, BIN_CHUNK, true);
    u8.set(bin, off + 8);
  }
  return out;
}

/** Байты обратных бинд-матриц скина — по ним и решаем, одинаковые скины или нет. */
function ibmBytes(json: Record<string, unknown>, bin: Uint8Array | null, acc: unknown): string {
  if (typeof acc !== 'number' || !bin) return 'нет';
  const accessors = (json.accessors ?? []) as { bufferView?: number; byteOffset?: number; count?: number }[];
  const views = (json.bufferViews ?? []) as { byteOffset?: number; byteLength?: number }[];
  const a = accessors[acc]; if (!a || a.bufferView === undefined) return 'нет';
  const v = views[a.bufferView]; if (!v) return 'нет';
  const start = (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const len = Math.min((a.count ?? 0) * 64, (v.byteLength ?? 0));
  if (len <= 0 || start + len > bin.length) return 'нет';
  // Короткая подпись вместо всего массива: сумма по байтам + длина. Совпадение случайно не случается,
  // а сравнивать мегабайты незачем.
  let h = 2166136261;
  for (let i = start; i < start + len; i++) { h ^= bin[i]!; h = Math.imul(h, 16777619); }
  return `${len}:${h >>> 0}`;
}

export interface MergeReport { before: number; after: number; nodes: number }

/** Схлопнуть одинаковые скины в один. Возвращает новый буфер и отчёт (для статуса в панели). */
export function mergeIdenticalSkins(buf: ArrayBuffer): { out: ArrayBuffer; report: MergeReport } {
  const { json, bin } = readGlb(buf);
  const skins = (json.skins ?? []) as { joints?: number[]; inverseBindMatrices?: unknown; skeleton?: unknown }[];
  const nodes = (json.nodes ?? []) as { skin?: number }[];
  if (skins.length < 2) return { out: buf, report: { before: skins.length, after: skins.length, nodes: 0 } };

  const keyOf = (s: (typeof skins)[number]): string =>
    `${(s.joints ?? []).join(',')}|${String(s.skeleton ?? '')}|${ibmBytes(json, bin, s.inverseBindMatrices)}`;
  const firstByKey = new Map<string, number>();
  const remap = new Map<number, number>();
  const kept: typeof skins = [];
  skins.forEach((s, i) => {
    const k = keyOf(s);
    const first = firstByKey.get(k);
    if (first === undefined) { firstByKey.set(k, kept.length); remap.set(i, kept.length); kept.push(s); }
    else remap.set(i, first);
  });
  if (kept.length === skins.length) return { out: buf, report: { before: skins.length, after: skins.length, nodes: 0 } };

  let touched = 0;
  for (const n of nodes) {
    if (typeof n.skin !== 'number') continue;
    const to = remap.get(n.skin);
    if (to !== undefined && to !== n.skin) { n.skin = to; touched++; }
    else if (to !== undefined) n.skin = to;
  }
  json.skins = kept;
  return { out: writeGlb(json, bin), report: { before: skins.length, after: kept.length, nodes: touched } };
}

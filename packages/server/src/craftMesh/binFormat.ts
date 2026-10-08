import { CRAFT_SLOT_LIST } from '@dm/shared';

/**
 * ⭐ 08.10 (Ф4, план «Unity — дом визуального контента»): ДВОИЧНЫЙ МЕШ КОВАНОГО ОРУЖИЯ «DMCM v1» — числа раскладки и ЭТАЛОННЫЙ
 * ДЕКОДЕР. Сама раскладка описана ОДНИМ местом — таблицей в шапке `encodeBin.ts` (её же повторяет docs/CRAFT_WEAPONS.md §21.1,
 * «Двоичный меш DMCM v1»); здесь только её числа (смещения полей, размеры записей) и декодер, по которому сверяются тесты
 * (`craftMeshBin.test.ts`) и эталон Unity (`unityCraftMeshGolden.gen.test.ts`). Декодер Unity (`CraftMeshBin.cs`) — порт этого.
 *
 * Модуль ничего не грузит (ни `three`, ни построителей): его берёт и главный поток — версия формата входит в ключ кэша
 * (`service.ts`), а `three` главному потоку нельзя.
 */

/** Версия формата: в заголовке, в метаданных (`v`), в ключе кэша (`|bin1`) и в ETag (`"cmb1-…"`). Поднимать при любой правке раскладки. */
export const CRAFT_BIN_FORMAT = 1;
export const DMCM_MAGIC = 'DMCM';
/** Флаг заголовка: индексы u32 (иначе u16). Других битов в v1 нет — иной бит декодер отказывает. */
export const DMCM_FLAG_INDEX32 = 1;
/** Гнёзда — ровно четыре, в порядке `CRAFT_SLOT_LIST`. */
export const DMCM_SLOTS: readonly string[] = CRAFT_SLOT_LIST;
/** `alphaMode` материала: число в файле → имя glTF. */
export const DMCM_ALPHA = ['OPAQUE', 'MASK', 'BLEND'] as const;
export type DmcmAlpha = typeof DMCM_ALPHA[number];

export const DMCM_HEADER_BYTES = 112;
export const DMCM_MATERIAL_BYTES = 52;
export const DMCM_SLOT_BYTES = 52;
export const DMCM_GROUP_BYTES = 12;

/** Смещения полей заголовка (таблица — `encodeBin.ts`). */
export const DMCM_H = {
  magic: 0, version: 4, flags: 6, fileBytes: 8, bmin: 12, bmax: 24, tip: 36,
  matCount: 48, slotCount: 50, groupCount: 52, vertexCount: 56, indexCount: 60,
  matOffset: 64, slotOffset: 68, groupOffset: 72, strOffset: 76, strBytes: 80, metaOffset: 84, metaBytes: 88,
  posOffset: 92, nrmOffset: 96, uvOffset: 100, idxOffset: 104, reserved: 108,
} as const;
/** Смещения полей записи материала. */
export const DMCM_M = {
  nameOffset: 0, nameBytes: 4, alphaMode: 6, doubleSided: 7, baseColor: 8, metallic: 24, roughness: 28,
  emissive: 32, emissiveStrength: 44, alphaCutoff: 48,
} as const;
/** Смещения полей записи гнезда. */
export const DMCM_S = {
  nameOffset: 0, nameBytes: 4, groupCount: 6, groupFirst: 8, vertexStart: 12, vertexCount: 16, indexStart: 20, indexCount: 24,
  bmin: 28, bmax: 40,
} as const;
/** Смещения полей записи группы. */
export const DMCM_G = { material: 0, reserved: 2, indexStart: 4, indexCount: 8 } as const;

/** До кратного 4. */
export const pad4 = (n: number): number => (n + 3) & ~3;

/**
 * Потоки пишутся и читаются типизированными массивами прямо по буферу — это порядок байтов МАШИНЫ. Файл — little-endian; node на
 * x64/arm64 — тоже. На машине big-endian кодер и декодер отказывают громко, а не пишут перевёрнутые числа.
 */
export const HOST_LE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

export type V3 = [number, number, number];

export interface DmcmMaterial {
  name: string;
  /** RGBA, линейный. */
  baseColor: [number, number, number, number];
  metallic: number;
  roughness: number;
  /** RGB, линейный. */
  emissive: V3;
  emissiveStrength: number;
  alphaMode: DmcmAlpha;
  alphaCutoff: number;
  doubleSided: boolean;
}
export interface DmcmGroup { material: number; indexStart: number; indexCount: number }
export interface DmcmSlot {
  name: string;
  vertexStart: number;
  vertexCount: number;
  indexStart: number;
  indexCount: number;
  bmin: V3;
  bmax: V3;
  groups: DmcmGroup[];
}
export interface DmcmFile {
  version: number;
  flags: number;
  index32: boolean;
  fileBytes: number;
  bmin: V3;
  bmax: V3;
  tip: V3;
  vertexCount: number;
  indexCount: number;
  meta: Record<string, unknown>;
  materials: DmcmMaterial[];
  slots: DmcmSlot[];
  /** Потоки — копии (свой буфер), индексы — ОТНОСИТЕЛЬНО `vertexStart` своего гнезда. */
  position: Float32Array;
  normal: Float32Array;
  uv: Float32Array;
  index: Uint16Array | Uint32Array;
}

/**
 * Почему файл отказан — разные причины различимы (Unity по ним решает, что писать в журнал; всё — отказ до следующего поколения):
 * `truncated` — файл короче заголовка или своего `fileBytes`; `magic` — не DMCM; `version` — не v1; `flags` — неизвестный бит;
 * `length` — файл ДЛИННЕЕ `fileBytes`; `layout` — смещения, счёт, имена, группы или индексы не сходятся.
 */
export type DmcmError = 'truncated' | 'magic' | 'version' | 'flags' | 'length' | 'layout';
export type DmcmDecode = { ok: true; file: DmcmFile } | { ok: false; error: DmcmError; detail: string };

class Bad extends Error { constructor(readonly kind: DmcmError, msg: string) { super(msg); } }

/** Разобрать DMCM v1 со всеми проверками раскладки. Ничего не бросает: кривой файл — `{ ok: false, error }`. */
export function decodeCraftBin(bytes: Uint8Array): DmcmDecode {
  try {
    return { ok: true, file: decode(bytes) };
  } catch (e) {
    if (e instanceof Bad) return { ok: false, error: e.kind, detail: e.message };
    return { ok: false, error: 'layout', detail: e instanceof Error ? e.message : String(e) };
  }
}

function decode(src: Uint8Array): DmcmFile {
  if (!HOST_LE) throw new Error('DMCM: машина big-endian — эталонный декодер читает потоки в порядке машины');
  if (src.byteLength < 4) throw new Bad('truncated', `файл ${src.byteLength} Б — короче магии`);
  const magic = String.fromCharCode(src[0]!, src[1]!, src[2]!, src[3]!);
  if (magic !== DMCM_MAGIC) throw new Bad('magic', `магия «${magic}»`);
  if (src.byteLength < DMCM_HEADER_BYTES) throw new Bad('truncated', `файл ${src.byteLength} Б — короче заголовка`);
  // Своя копия: смещения потоков кратны 4 от начала файла — типизированные массивы ложатся на них без копирования по полю.
  const buf = src.slice().buffer as ArrayBuffer;
  const dv = new DataView(buf);
  const u16 = (o: number): number => dv.getUint16(o, true);
  const u32 = (o: number): number => dv.getUint32(o, true);
  const f32 = (o: number): number => dv.getFloat32(o, true);
  const v3 = (o: number): V3 => [f32(o), f32(o + 4), f32(o + 8)];
  const version = u16(DMCM_H.version);
  if (version !== CRAFT_BIN_FORMAT) throw new Bad('version', `версия ${version}`);
  const flags = u16(DMCM_H.flags);
  if (flags & ~DMCM_FLAG_INDEX32) throw new Bad('flags', `флаги ${flags.toString(2)}`);
  const fileBytes = u32(DMCM_H.fileBytes);
  if (fileBytes > src.byteLength) throw new Bad('truncated', `файл ${src.byteLength} Б, заголовок обещает ${fileBytes}`);
  if (fileBytes < src.byteLength) throw new Bad('length', `файл ${src.byteLength} Б, заголовок — ${fileBytes}`);
  if (u32(DMCM_H.reserved) !== 0) throw new Bad('layout', 'резерв заголовка не ноль');
  const index32 = (flags & DMCM_FLAG_INDEX32) !== 0;
  const matCount = u16(DMCM_H.matCount), slotCount = u16(DMCM_H.slotCount), groupCount = u32(DMCM_H.groupCount);
  const vertexCount = u32(DMCM_H.vertexCount), indexCount = u32(DMCM_H.indexCount);
  if (slotCount !== DMCM_SLOTS.length) throw new Bad('layout', `гнёзд ${slotCount}`);
  if (indexCount % 3) throw new Bad('layout', `индексов ${indexCount} — не треугольники`);
  const section = (name: string, off: number, bytes: number): number => {
    if (off % 4 || off < DMCM_HEADER_BYTES || off + bytes > fileBytes) throw new Bad('layout', `раздел ${name}: ${off}+${bytes} из ${fileBytes}`);
    return off;
  };
  const matOff = section('MATERIAL', u32(DMCM_H.matOffset), matCount * DMCM_MATERIAL_BYTES);
  const slotOff = section('SLOT', u32(DMCM_H.slotOffset), slotCount * DMCM_SLOT_BYTES);
  const groupOff = section('GROUP', u32(DMCM_H.groupOffset), groupCount * DMCM_GROUP_BYTES);
  const strBytes = u32(DMCM_H.strBytes);
  const strOff = section('STRINGS', u32(DMCM_H.strOffset), strBytes);
  const metaBytes = u32(DMCM_H.metaBytes);
  const metaOff = section('META', u32(DMCM_H.metaOffset), metaBytes);
  const posOff = section('POSITION', u32(DMCM_H.posOffset), vertexCount * 12);
  const nrmOff = section('NORMAL', u32(DMCM_H.nrmOffset), vertexCount * 12);
  const uvOff = section('UV0', u32(DMCM_H.uvOffset), vertexCount * 8);
  const idxOff = section('INDEX', u32(DMCM_H.idxOffset), indexCount * (index32 ? 4 : 2));
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  const str = (off: number, n: number, what: string): string => {
    if (off < strOff || off + n > strOff + strBytes) throw new Bad('layout', `строка ${what} вне раздела строк`);
    return utf8.decode(new Uint8Array(buf, off, n));
  };

  let meta: Record<string, unknown>;
  try { meta = JSON.parse(utf8.decode(new Uint8Array(buf, metaOff, metaBytes))) as Record<string, unknown>; }
  catch { throw new Bad('layout', 'метаданные — не JSON'); }
  if (!meta || typeof meta !== 'object' || meta.v !== CRAFT_BIN_FORMAT) throw new Bad('layout', 'метаданные без v');

  const materials: DmcmMaterial[] = [];
  for (let i = 0; i < matCount; i++) {
    const o = matOff + i * DMCM_MATERIAL_BYTES;
    const alpha = dv.getUint8(o + DMCM_M.alphaMode), ds = dv.getUint8(o + DMCM_M.doubleSided);
    if (alpha >= DMCM_ALPHA.length || ds > 1) throw new Bad('layout', `материал ${i}: alphaMode ${alpha}, doubleSided ${ds}`);
    const bc = o + DMCM_M.baseColor;
    materials.push({
      name: str(u32(o + DMCM_M.nameOffset), u16(o + DMCM_M.nameBytes), `материала ${i}`),
      baseColor: [f32(bc), f32(bc + 4), f32(bc + 8), f32(bc + 12)],
      metallic: f32(o + DMCM_M.metallic),
      roughness: f32(o + DMCM_M.roughness),
      emissive: v3(o + DMCM_M.emissive),
      emissiveStrength: f32(o + DMCM_M.emissiveStrength),
      alphaMode: DMCM_ALPHA[alpha]!,
      alphaCutoff: f32(o + DMCM_M.alphaCutoff),
      doubleSided: ds === 1,
    });
  }

  const index = index32 ? new Uint32Array(buf, idxOff, indexCount) : new Uint16Array(buf, idxOff, indexCount);
  const slots: DmcmSlot[] = [];
  let vNext = 0, iNext = 0, gNext = 0;
  for (let s = 0; s < slotCount; s++) {
    const o = slotOff + s * DMCM_SLOT_BYTES;
    const name = str(u32(o + DMCM_S.nameOffset), u16(o + DMCM_S.nameBytes), `гнезда ${s}`);
    if (name !== DMCM_SLOTS[s]) throw new Bad('layout', `гнездо ${s} — «${name}», ждали «${DMCM_SLOTS[s]}»`);
    const slot: DmcmSlot = {
      name,
      vertexStart: u32(o + DMCM_S.vertexStart), vertexCount: u32(o + DMCM_S.vertexCount),
      indexStart: u32(o + DMCM_S.indexStart), indexCount: u32(o + DMCM_S.indexCount),
      bmin: v3(o + DMCM_S.bmin), bmax: v3(o + DMCM_S.bmax), groups: [],
    };
    const gc = u16(o + DMCM_S.groupCount), gFirst = u32(o + DMCM_S.groupFirst);
    if (slot.vertexStart !== vNext || slot.indexStart !== iNext || gFirst !== gNext) throw new Bad('layout', `гнездо ${name}: диапазоны не встык`);
    if (slot.indexCount % 3) throw new Bad('layout', `гнездо ${name}: индексов ${slot.indexCount}`);
    if (index32 === false && slot.vertexCount > 0xffff) throw new Bad('layout', `гнездо ${name}: ${slot.vertexCount} вершин при индексах u16`);
    if (slot.vertexStart + slot.vertexCount > vertexCount || slot.indexStart + slot.indexCount > indexCount) throw new Bad('layout', `гнездо ${name}: за потоками`);
    let iRel = 0;
    for (let g = 0; g < gc; g++) {
      if (gFirst + g >= groupCount) throw new Bad('layout', `гнездо ${name}: группа вне таблицы`);
      const go = groupOff + (gFirst + g) * DMCM_GROUP_BYTES;
      const grp: DmcmGroup = { material: u16(go + DMCM_G.material), indexStart: u32(go + DMCM_G.indexStart), indexCount: u32(go + DMCM_G.indexCount) };
      if (u16(go + DMCM_G.reserved) !== 0) throw new Bad('layout', `гнездо ${name}: резерв группы не ноль`);
      if (grp.material >= matCount) throw new Bad('layout', `гнездо ${name}: материал ${grp.material} из ${matCount}`);
      if (grp.indexStart !== iRel || grp.indexCount % 3 || grp.indexCount === 0) throw new Bad('layout', `гнездо ${name}: группа ${g} не встык`);
      iRel += grp.indexCount;
      slot.groups.push(grp);
    }
    if (iRel !== slot.indexCount) throw new Bad('layout', `гнездо ${name}: группы покрыли ${iRel} индексов из ${slot.indexCount}`);
    for (let i = slot.indexStart; i < slot.indexStart + slot.indexCount; i++) {
      if (index[i]! >= slot.vertexCount) throw new Bad('layout', `гнездо ${name}: индекс ${index[i]} при ${slot.vertexCount} вершинах`);
    }
    vNext += slot.vertexCount; iNext += slot.indexCount; gNext += gc;
    slots.push(slot);
  }
  if (vNext !== vertexCount || iNext !== indexCount || gNext !== groupCount) throw new Bad('layout', 'гнёзда не покрыли потоки');

  return {
    version, flags, index32, fileBytes,
    bmin: v3(DMCM_H.bmin), bmax: v3(DMCM_H.bmax), tip: v3(DMCM_H.tip),
    vertexCount, indexCount, meta, materials, slots,
    position: new Float32Array(buf, posOff, vertexCount * 3),
    normal: new Float32Array(buf, nrmOff, vertexCount * 3),
    uv: new Float32Array(buf, uvOff, vertexCount * 2),
    index,
  };
}

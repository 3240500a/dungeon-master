/**
 * СТРИППЕР ВШИТЫХ ТЕКСТУР ИЗ GLB (dev-аплоад окружения/объектов). Проблема пайплайна: экспорт «с текстурами+развёрткой»
 * весит мегабайты (картинки вшиты в бинарь), а экспорт «без материала» РОНЯЕТ UV (экспортёр считает канал лишним).
 * Решение: юзер экспортирует как удобно (с материалом → UV на месте), сервер ХИРУРГИЧЕСКИ вырезает только байты
 * картинок и пересобирает бинарь, СОХРАНЯЯ ВСЮ ГЕОМЕТРИЮ (POSITION/NORMAL/TEXCOORD_0/скин/индексы). На выходе GLB =
 * десятки КБ (геометрия+развёртка). Материал в игре всё равно берётся из конфига (`materialId`) — вшитый не нужен.
 *
 * Безопасно только там, где материал переопределяется конфигом (окружение/объекты). Скины персонажей частично
 * полагаются на вшитый материал (modelSkin: конфиг-материал лишь при заданном submeshMaterials) → их НЕ стрипаем.
 *
 * Формат GLB: header(12) + чанки [len u32][type u32][data]. JSON-чанк type 0x4E4F534A (пад пробелами 0x20),
 * BIN-чанк 0x004E4942 (пад нулями). Картинки лежат как bufferView в общий буфер (buffer 0). Убираем их bufferView,
 * КОМПАКТИМ бинарь (оставшиеся bufferView сдвигаем, 4-байт-выравнивание), РЕМАПИМ ссылки аксессоров → индексы не съедут.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const MAGIC = 0x46546c67;         // 'glTF'
const CHUNK_JSON = 0x4e4f534a;    // 'JSON'
const CHUNK_BIN = 0x004e4942;     // 'BIN\0'

export interface StripResult { out: Buffer; changed: boolean; note: string }

/** Срезать *Texture-ссылки из материалов + удалить images/textures/samplers (ссылки, не байты). */
function dropTexJson(json: any): void {
  delete json.images; delete json.textures; delete json.samplers;
  for (const m of (Array.isArray(json.materials) ? json.materials : [])) {
    if (m.pbrMetallicRoughness) { delete m.pbrMetallicRoughness.baseColorTexture; delete m.pbrMetallicRoughness.metallicRoughnessTexture; }
    delete m.normalTexture; delete m.occlusionTexture; delete m.emissiveTexture;
    if (m.extensions && typeof m.extensions === 'object') {
      for (const ext of Object.values(m.extensions)) {
        if (ext && typeof ext === 'object') for (const k of Object.keys(ext as any)) if (/texture/i.test(k)) delete (ext as any)[k];
      }
    }
  }
}

/** Собрать GLB заново из json + bin (bin — без хвостового паддинга; чанки паддятся тут). */
function serializeGlb(json: any, bin: Buffer): Buffer {
  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  if (jsonPad) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);   // пробелы
  const hasBin = bin.length > 0;
  let binBuf = bin;
  if (hasBin) { const p = (4 - (binBuf.length % 4)) % 4; if (p) binBuf = Buffer.concat([binBuf, Buffer.alloc(p, 0x00)]); }
  const total = 12 + 8 + jsonBuf.length + (hasBin ? 8 + binBuf.length : 0);
  const out = Buffer.alloc(total);
  let o = 0;
  out.writeUInt32LE(MAGIC, o); o += 4; out.writeUInt32LE(2, o); o += 4; out.writeUInt32LE(total, o); o += 4;
  out.writeUInt32LE(jsonBuf.length, o); o += 4; out.writeUInt32LE(CHUNK_JSON, o); o += 4;
  jsonBuf.copy(out, o); o += jsonBuf.length;
  if (hasBin) { out.writeUInt32LE(binBuf.length, o); o += 4; out.writeUInt32LE(CHUNK_BIN, o); o += 4; binBuf.copy(out, o); }
  return out;
}

/**
 * Вырезать вшитые текстуры из GLB, сохранив геометрию. На любой неподдержанной форме (не GLB / v!=2 / сжатая
 * геометрия Draco|meshopt / мультибуфер) — безопасный no-op или срез только JSON-ссылок (без риска для геометрии).
 */
export function stripGlbTextures(input: Buffer): StripResult {
  try {
    if (input.length < 12 || input.readUInt32LE(0) !== MAGIC) return { out: input, changed: false, note: 'не GLB' };
    if (input.readUInt32LE(4) !== 2) return { out: input, changed: false, note: 'glTF !=v2' };
    // разбор чанков
    let off = 12, json: any = null, bin: Buffer | null = null;
    while (off + 8 <= input.length) {
      const clen = input.readUInt32LE(off), ctype = input.readUInt32LE(off + 4), cstart = off + 8;
      const cdata = input.subarray(cstart, cstart + clen);
      if (ctype === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(cdata));
      else if (ctype === CHUNK_BIN) bin = Buffer.from(cdata);
      off = cstart + clen;
    }
    if (!json) return { out: input, changed: false, note: 'нет JSON-чанка' };
    const images = Array.isArray(json.images) ? json.images : [];
    if (images.length === 0 && !json.textures && !json.samplers) return { out: input, changed: false, note: 'нет вшитых картинок' };

    const req: string[] = Array.isArray(json.extensionsRequired) ? json.extensionsRequired : [];
    if (req.some((e) => /draco|meshopt/i.test(String(e)))) { dropTexJson(json); return { out: serializeGlb(json, bin ?? Buffer.alloc(0)), changed: true, note: 'сжатая геометрия ('+req.join(',')+') — срез только ссылок' }; }
    if (!bin) { dropTexJson(json); return { out: serializeGlb(json, Buffer.alloc(0)), changed: true, note: 'без BIN — срез ссылок' }; }
    if (!Array.isArray(json.buffers) || json.buffers.length !== 1 || json.buffers[0].uri) { dropTexJson(json); return { out: serializeGlb(json, bin), changed: true, note: 'мультибуфер/внешний — срез только ссылок' }; }

    // bufferView'ы картинок → на удаление
    const imgViews = new Set<number>();
    for (const im of images) if (typeof im.bufferView === 'number') imgViews.add(im.bufferView);
    const bvs: any[] = Array.isArray(json.bufferViews) ? json.bufferViews : [];

    // компактим бинарь: оставляем не-картиночные bufferView, 4-байт-выравнивание, строим ремап старый→новый индекс
    const remap = new Map<number, number>();
    const kept: any[] = [];
    const parts: Buffer[] = [];
    let newLen = 0;
    for (let i = 0; i < bvs.length; i++) {
      if (imgViews.has(i)) continue;
      const bv = bvs[i], start = bv.byteOffset || 0;
      const pad = (4 - (newLen % 4)) % 4;
      if (pad) { parts.push(Buffer.alloc(pad)); newLen += pad; }
      parts.push(Buffer.from(bin.subarray(start, start + bv.byteLength)));   // копия среза
      remap.set(i, kept.length);
      kept.push({ ...bv, byteOffset: newLen });
      newLen += bv.byteLength;
    }
    const newBin = Buffer.concat(parts, newLen);

    // ремап всех ссылок на bufferView (аксессоры + sparse)
    for (const a of (Array.isArray(json.accessors) ? json.accessors : [])) {
      if (typeof a.bufferView === 'number') { const n = remap.get(a.bufferView); if (n === undefined) delete a.bufferView; else a.bufferView = n; }
      if (a.sparse) {
        if (a.sparse.indices && typeof a.sparse.indices.bufferView === 'number') a.sparse.indices.bufferView = remap.get(a.sparse.indices.bufferView) ?? a.sparse.indices.bufferView;
        if (a.sparse.values && typeof a.sparse.values.bufferView === 'number') a.sparse.values.bufferView = remap.get(a.sparse.values.bufferView) ?? a.sparse.values.bufferView;
      }
    }
    json.bufferViews = kept;
    json.buffers[0].byteLength = newBin.length;
    dropTexJson(json);
    const out = serializeGlb(json, newBin);
    return { out, changed: true, note: `сжат ${input.length}→${out.length} байт (−${images.length} картинок)` };
  } catch (e) {
    return { out: input, changed: false, note: 'ошибка стрипа: ' + (e as Error).message };
  }
}

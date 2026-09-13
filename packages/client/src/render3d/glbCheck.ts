/**
 * ПРОВЕРКА ГОТОВОГО GLB ПЕРЕД ЗАЛИВКОЙ.
 *
 * Повод: на сервер уехал ассет, в котором 38 скинов ссылались на 100 суставов каждый, а костей в
 * файле не было ВООБЩЕ (`joints: [null × 100]`). Такой GLB не грузится ничем — ни игрой, ни
 * редактором, ни внешним вьюером, — и выглядит это как «модель не отображается, атлас не
 * распознаётся». Заливка при этом прошла успешно: ломаться было нечему, файл как файл.
 *
 * ⚠ Поэтому смотрим не на «экспорт не бросил исключение», а на САМ РЕЗУЛЬТАТ. Разбирать нужен только
 * JSON-чанк контейнера — это десятки килобайт и никаких зависимостей, так что проверка бесплатная и
 * её не жалко ставить на каждый экспорт.
 */

export interface GlbSkinReport {
  /** Сколько скинов в файле. */
  skins: number;
  /** Сколько нод помечено костями (через `skins[].joints`). */
  bones: number;
  /** Ссылок на несуществующие ноды (то самое `null`). */
  badJoints: number;
  /** Сколько мешей. Ноль при непустом файле — тоже подозрительно. */
  meshes: number;
}

/** JSON-чанк GLB. Бросает, если это не GLB — молчаливое «ок» на мусоре хуже ошибки. */
function glbJson(buf: ArrayBuffer): Record<string, unknown> {
  if (buf.byteLength < 20) throw new Error('не GLB: файл короче заголовка');
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('не GLB: нет сигнатуры glTF');
  let off = 12;
  while (off + 8 <= buf.byteLength) {
    const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
    if (type === 0x4e4f534a) {                                   // 'JSON'
      const txt = new TextDecoder().decode(new Uint8Array(buf, off + 8, len));
      return JSON.parse(txt) as Record<string, unknown>;
    }
    off += 8 + len;
  }
  throw new Error('не GLB: JSON-чанк не найден');
}

export function glbSkinReport(buf: ArrayBuffer): GlbSkinReport {
  const js = glbJson(buf);
  const nodes = Array.isArray(js.nodes) ? js.nodes.length : 0;
  const skins = Array.isArray(js.skins) ? (js.skins as { joints?: unknown[] }[]) : [];
  const meshes = Array.isArray(js.meshes) ? js.meshes.length : 0;
  const used = new Set<number>();
  let badJoints = 0;
  for (const s of skins) {
    for (const j of s.joints ?? []) {
      if (typeof j === 'number' && Number.isInteger(j) && j >= 0 && j < nodes) used.add(j);
      else badJoints++;                                          // null/мимо диапазона = висячая ссылка
    }
  }
  return { skins: skins.length, bones: used.size, badJoints, meshes };
}

/** Бросить понятную ошибку, если файл заливать нельзя. Возвращает отчёт — его удобно показать в статусе. */
export function assertGlbUsable(buf: ArrayBuffer): GlbSkinReport {
  const r = glbSkinReport(buf);
  if (r.badJoints > 0) {
    throw new Error(`скелет не попал в GLB: ${r.badJoints} висячих ссылок на суставы при ${r.bones} костях в файле. `
      + 'Обычно это скрытый скелет в исходнике (в максе его прячут) — экспорт обязан идти с onlyVisible=false.');
  }
  if (r.skins > 0 && r.bones === 0) throw new Error('в GLB есть скины, но нет костей — файл нерабочий');
  return r;
}

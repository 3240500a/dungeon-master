import * as THREE from 'three';
import type { ConfigRegistry, CraftParts } from '@dm/shared';
import { buildForBake, type BakeMeta } from './bake.js';
import {
  CRAFT_BIN_FORMAT, DMCM_FLAG_INDEX32, DMCM_G, DMCM_GROUP_BYTES, DMCM_H, DMCM_HEADER_BYTES, DMCM_M, DMCM_MATERIAL_BYTES,
  DMCM_MAGIC, DMCM_S, DMCM_SLOT_BYTES, DMCM_SLOTS, HOST_LE, pad4,
} from './binFormat.js';

/**
 * ⭐ 08.10 (Ф4, план «Unity — дом визуального контента»): ДВОИЧНЫЙ МЕШ КОВАНОГО ОРУЖИЯ «DMCM v1» вместо GLB.
 *
 * Зачем: Unity грузит модель из деталей glTFast'ом (`CraftMesh.cs`), а в Ф6 glTFast уходит из проекта. GLB для меша без текстур и
 * костей — лишний разбор (JSON узлов, аксессоры) и десятки рендереров на оружие (узел на деталь). DMCM — то же содержимое БЕЗ ПОТЕРЬ
 * (float32), уже запечённое в пространство корня и разложенное на четыре гнезда: Unity строит четыре меша `Mesh.AllocateWritableMeshData`
 * без разбора, по подмешу на материал.
 *
 * Содержимое — ровно то, что сегодня кладёт в GLB `bake.ts`, из той же сборки (`buildForBake`: тот же построитель и та же нормировка
 * нормалей): СИСТЕМА КООРДИНАТ ТА ЖЕ — сантиметры, правая система three, начало — хват основной руки, рабочий конец — в −Y. Свою
 * конверсию Unity делает сама, КАК glTFast: x → −x у позиций и нормалей, v → 1 − v, треугольник (a, b, c) → (c, b, a).
 *
 * Обход — как у экспортёра GLB (`onlyVisible`, в глубину, узел раньше детей, дети по порядку); каждый меш запекается в пространство
 * корня: p' = M·p, n' = normalize((M⁻¹)ᵀ·n) — масштабы узлов бывают НЕРАВНОМЕРНЫЕ (`blades.ts`, `polearms.ts`, `magic.ts`, `hafted.ts`),
 * так что нормали — только через обратную-транспонированную. det(M) < 0 (зеркальные клоны `mirrorX`: масштаб −1 по X) — b и c в каждом
 * треугольнике меняются местами: в GLB намотку переворачивает показ по знаку узла, а здесь узла нет. Геометрия без индексов —
 * последовательные индексы; без UV — нули. Гнездо меша — его предок под корнем (под корнем РОВНО четыре узла гнёзд); внутри гнезда
 * индексы сложены группами по материалу в порядке первой встречи, вершины — в порядке мешей (как в GLB).
 *
 * ═══ РАСКЛАДКА DMCM v1 (единственное описание; копия — docs/CRAFT_WEAPONS.md §21.1 «Двоичный меш DMCM v1»; числа — `binFormat.ts`) ═══
 * Little-endian. Все смещения — в байтах ОТ НАЧАЛА ФАЙЛА. Каждый раздел начинается с кратного 4; хвосты строк, метаданных и индексов
 * добиты нулями до кратного 4. Разделы идут в порядке: ЗАГОЛОВОК, MATERIAL, SLOT, GROUP, STRINGS, META, POSITION, NORMAL, UV0, INDEX.
 *
 *  ЗАГОЛОВОК — 112 байт
 *   off  тип      поле
 *     0  u8[4]    magic = «DMCM» (44 4D 43 4D)
 *     4  u16      version = 1
 *     6  u16      flags: бит 0 — индексы u32 (иначе u16); прочие биты — 0 (иной бит декодер v1 отказывает)
 *     8  u32      fileBytes — полный размер файла (меньше длины ответа или больше — отказ)
 *    12  f32×3    bmin — габарит всего оружия (по записанным POSITION; без вершин — нули)
 *    24  f32×3    bmax
 *    36  f32×3    tip — вершина, САМАЯ ДАЛЬНЯЯ ОТ НАЧАЛА КООРДИНАТ (хвата), по всему оружию; из равных — первая по потоку
 *    48  u16      matCount
 *    50  u16      slotCount = 4
 *    52  u32      groupCount — групп во всех гнёздах
 *    56  u32      vertexCount — вершин всего
 *    60  u32      indexCount — индексов всего (кратно 3)
 *    64  u32      matOffset   → MATERIAL × matCount
 *    68  u32      slotOffset  → SLOT × 4
 *    72  u32      groupOffset → GROUP × groupCount
 *    76  u32      strOffset   → STRINGS: имена материалов и гнёзд, UTF-8 без нулей-концов
 *    80  u32      strBytes
 *    84  u32      metaOffset  → META: UTF-8 JSON {"v":1,"units":"cm","grip":"origin","workingEnd":"-Y","look":…,"rev":…}
 *    88  u32      metaBytes
 *    92  u32      posOffset   → POSITION f32×3 × vertexCount
 *    96  u32      nrmOffset   → NORMAL   f32×3 × vertexCount (единичные)
 *   100  u32      uvOffset    → UV0      f32×2 × vertexCount (у геометрии без UV — 0, 0)
 *   104  u32      idxOffset   → INDEX    u16|u32 × indexCount — ОТНОСИТЕЛЬНО vertexStart своего гнезда
 *   108  u32      reserved = 0
 *
 *  MATERIAL — 52 байта (PBR РОВНО как пишет GLTFExporter: те же числа, что в GLB, только float32)
 *     0  u32      nameOffset, 4 u16 nameBytes — имя: `семья:ступень`, `семья:ступень:glow=rrggbb`, `fixed:rrggbb` (грамматика MatCache)
 *     6  u8       alphaMode: 0 OPAQUE · 1 MASK · 2 BLEND
 *     7  u8       doubleSided: 0 | 1
 *     8  f32×4    baseColor RGBA, ЛИНЕЙНЫЙ (= baseColorFactor; в GLB его нет — 1,1,1,1)
 *    24  f32      metallic (= metallicFactor)
 *    28  f32      roughness (= roughnessFactor)
 *    32  f32×3    emissive RGB, ЛИНЕЙНЫЙ (= emissiveFactor; нет — 0,0,0)
 *    44  f32      emissiveStrength (= KHR_materials_emissive_strength; нет — 1; свечение навершия жезла/посоха — 0.45)
 *    48  f32      alphaCutoff (= alphaCutoff при MASK; иначе 0.5 — умолчание glTF)
 *
 *  SLOT — 52 байта, ровно 4 записи в порядке CRAFT_SLOT_LIST: strike, grip, bind, head
 *     0  u32      nameOffset, 4 u16 nameBytes — имя гнезда
 *     6  u16      groupCount
 *     8  u32      groupFirst — номер первой группы гнезда в GROUP (группы гнезда — подряд)
 *    12  u32      vertexStart, 16 u32 vertexCount — диапазон вершин (гнёзда встык, по порядку)
 *    20  u32      indexStart,  24 u32 indexCount  — диапазон индексов (так же)
 *    28  f32×3    bmin, 40 f32×3 bmax — габарит гнезда (пустое гнездо — нули)
 *
 *  GROUP — 12 байт (подмеш Unity)
 *     0  u16      material — номер в MATERIAL
 *     2  u16      reserved = 0
 *     4  u32      indexStart — ОТ НАЧАЛА ИНДЕКСОВ СВОЕГО ГНЕЗДА (группы гнезда встык с 0 и покрывают его индексы целиком)
 *     8  u32      indexCount (кратно 3, > 0)
 *
 *  Индексы u16, если в каждом гнезде ≤ 65535 вершин; иначе u32 и флаг. Треугольники — против часовой стрелки при взгляде с лицевой
 *  стороны в правой системе (как glTF). Пустое гнездо (нет мешей) — нули в счётчиках и габарите, групп нет.
 *
 * Модуль грузит `three` и построители (через `bake.ts`) — живёт ТОЛЬКО в потоке печи (`worker.ts`) и в тестах; штамп кода печи
 * (`service.ts`: вся папка `server/src/craftMesh`) его покрывает.
 */

/** Испечь DMCM v1. `null` — построитель не собрал (как у GLB); сборка освобождается в любом исходе. */
export async function bakeCraftBin(reg: ConfigRegistry, weaponClass: string, hands: number, parts: CraftParts, meta: BakeMeta): Promise<Uint8Array | null> {
  const res = buildForBake(reg, weaponClass, hands, parts, meta);
  if (!res) return null;
  try {
    return encodeCraftBin(res.group, meta);
  } finally {
    res.dispose();
  }
}

interface MatRec {
  name: string;
  baseColor: number[];
  metallic: number;
  roughness: number;
  emissive: number[];
  emissiveStrength: number;
  alpha: 0 | 1 | 2;
  alphaCutoff: number;
  doubleSided: boolean;
}

/** PBR материала так, как его пишет `GLTFExporter.processMaterialAsync` (+ `KHR_materials_emissive_strength`). */
function materialRecord(m: THREE.Material): MatRec {
  if ((m as THREE.ShaderMaterial).isShaderMaterial) throw new Error(`DMCM: материал «${m.name}» — ShaderMaterial (экспортёр GLB его тоже не пишет)`);
  const std = (m as THREE.MeshStandardMaterial).isMeshStandardMaterial === true;
  const color = (m as THREE.MeshStandardMaterial).color as THREE.Color | undefined;
  const emissive = (m as THREE.MeshStandardMaterial).emissive as THREE.Color | undefined;
  return {
    name: m.name,
    baseColor: [color?.r ?? 1, color?.g ?? 1, color?.b ?? 1, m.opacity],
    metallic: std ? (m as THREE.MeshStandardMaterial).metalness : 0,
    roughness: std ? (m as THREE.MeshStandardMaterial).roughness : 1,
    emissive: emissive ? [emissive.r, emissive.g, emissive.b] : [0, 0, 0],
    emissiveStrength: std ? (m as THREE.MeshStandardMaterial).emissiveIntensity : 1,
    alpha: m.transparent ? 2 : m.alphaTest > 0 ? 1 : 0,
    alphaCutoff: !m.transparent && m.alphaTest > 0 ? m.alphaTest : 0.5,
    doubleSided: m.side === THREE.DoubleSide,
  };
}

interface SlotAcc {
  pos: number[];
  nrm: number[];
  uv: number[];
  /** Индексы по материалу (номер в таблице материалов) — в порядке первой встречи в гнезде. */
  buckets: Map<number, number[]>;
}

/**
 * Закодировать готовую сборку (`buildForBake`: нормали уже нормированы) в DMCM v1. Корень — ровно четыре узла гнёзд; иначе, как и на
 * линиях/точках/меше без нормалей, — исключение (контракт построителя нарушен: громко, а не тихо кривой файл).
 */
export function encodeCraftBin(root: THREE.Object3D, meta: BakeMeta): Uint8Array {
  if (!HOST_LE) throw new Error('DMCM: машина big-endian — потоки пишутся в порядке машины');
  const names = root.children.map((c) => c.name);
  if (names.length !== DMCM_SLOTS.length || DMCM_SLOTS.some((s) => names.filter((n) => n === s).length !== 1)) {
    throw new Error(`DMCM: под корнем должны быть ровно гнёзда ${DMCM_SLOTS.join('/')}, а не ${names.join('/')}`);
  }
  const matIndex = new Map<THREE.Material, number>();
  const mats: MatRec[] = [];
  const indexOfMat = (m: THREE.Material): number => {
    let i = matIndex.get(m);
    if (i === undefined) { i = mats.length; matIndex.set(m, i); mats.push(materialRecord(m)); }
    return i;
  };

  // Пространство корня = сцена GLB: матрица корня тоже в ней (у построителей она единичная, но файл честен и без этого допущения).
  const rootM = new THREE.Matrix4().compose(root.position, root.quaternion, root.scale);
  const nm = new THREE.Matrix3();
  const accs: SlotAcc[] = [];
  for (const slotName of DMCM_SLOTS) {
    const acc: SlotAcc = { pos: [], nrm: [], uv: [], buckets: new Map() };
    accs.push(acc);
    if (!root.visible) continue;   // как `onlyVisible` экспортёра: невидимый корень — пустая сцена
    const slot = root.children.find((c) => c.name === slotName)!;
    if (!slot.visible) continue;
    const walk = (o: THREE.Object3D, parent: THREE.Matrix4): void => {
      // Матрица — из TRS узла, как пишет экспортёр (`trs: true`), а не из `o.matrix` (её могли не обновить).
      const M = new THREE.Matrix4().compose(o.position, o.quaternion, o.scale).premultiply(parent);
      const obj = o as THREE.Mesh & { isLine?: boolean; isPoints?: boolean };
      if (obj.isLine || obj.isPoints) throw new Error(`DMCM: «${o.name}» — линия/точки, формат — только треугольники`);
      if (obj.isMesh) addMesh(acc, obj, M);
      for (const c of o.children) if (c.visible) walk(c, M);
    };
    const addMesh = (a: SlotAcc, mesh: THREE.Mesh, M: THREE.Matrix4): void => {
      const g = mesh.geometry;
      const P = g.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (!P || P.count === 0) return;   // экспортёр: меш без атрибутов не пишется
      const multi = Array.isArray(mesh.material);
      if (multi && g.groups.length === 0) return;   // экспортёр: мульти-материал без групп не пишется
      if (!multi && (mesh.material as THREE.MeshStandardMaterial).wireframe) throw new Error(`DMCM: «${mesh.name}» — каркас (в GLB это линии)`);
      const N = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
      if (!N) throw new Error(`DMCM: у меша «${mesh.name}» нет нормалей`);
      const T = g.getAttribute('uv') as THREE.BufferAttribute | undefined;
      const I = g.index;
      const total = I ? I.count : P.count;
      const base = a.pos.length / 3;
      const e = M.elements;
      const n = nm.getNormalMatrix(M).elements;
      for (let i = 0; i < P.count; i++) {
        const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
        a.pos.push(e[0]! * x + e[4]! * y + e[8]! * z + e[12]!, e[1]! * x + e[5]! * y + e[9]! * z + e[13]!, e[2]! * x + e[6]! * y + e[10]! * z + e[14]!);
        const u = N.getX(i), v = N.getY(i), w = N.getZ(i);
        let nx = n[0]! * u + n[3]! * v + n[6]! * w, ny = n[1]! * u + n[4]! * v + n[7]! * w, nz = n[2]! * u + n[5]! * v + n[8]! * w;
        const len = Math.hypot(nx, ny, nz);
        if (len > 0) { nx /= len; ny /= len; nz /= len; }
        a.nrm.push(nx, ny, nz);
        if (T) a.uv.push(T.getX(i), T.getY(i)); else a.uv.push(0, 0);
      }
      const flip = M.determinant() < 0;
      const materials = multi ? (mesh.material as THREE.Material[]) : [mesh.material as THREE.Material];
      const groups = multi ? g.groups : [{ start: 0, count: total, materialIndex: 0 }];
      for (const grp of groups) {
        const mat = materials[grp.materialIndex ?? 0];
        if (!mat) throw new Error(`DMCM: у меша «${mesh.name}» нет материала группы ${grp.materialIndex}`);
        const start = grp.start, end = Math.min(total, grp.start + grp.count);
        if (end <= start) continue;   // пустая группа геометрии — пустой группы в файле нет (декодер её отказал бы)
        if ((end - start) % 3) throw new Error(`DMCM: у меша «${mesh.name}» ${end - start} индексов — не треугольники`);
        const mi = indexOfMat(mat);
        let bucket = a.buckets.get(mi);
        if (!bucket) { bucket = []; a.buckets.set(mi, bucket); }
        for (let t = start; t < end; t += 3) {
          const ia = I ? I.getX(t) : t, ib = I ? I.getX(t + 1) : t + 1, ic = I ? I.getX(t + 2) : t + 2;
          if (ia >= P.count || ib >= P.count || ic >= P.count) throw new Error(`DMCM: у меша «${mesh.name}» индекс вне вершин`);
          if (flip) bucket.push(base + ia, base + ic, base + ib);
          else bucket.push(base + ia, base + ib, base + ic);
        }
      }
    };
    walk(slot, rootM);
  }
  return writeFile(accs, mats, meta);
}

function writeFile(accs: SlotAcc[], mats: MatRec[], meta: BakeMeta): Uint8Array {
  const enc = new TextEncoder();
  const vertexCount = accs.reduce((s, a) => s + a.pos.length / 3, 0);
  const indexCount = accs.reduce((s, a) => s + [...a.buckets.values()].reduce((t, b) => t + b.length, 0), 0);
  const groupCount = accs.reduce((s, a) => s + a.buckets.size, 0);
  const index32 = accs.some((a) => a.pos.length / 3 > 0xffff);
  if (mats.length > 0xffff) throw new Error(`DMCM: материалов ${mats.length}`);

  const matNames = mats.map((m) => enc.encode(m.name));
  const slotNames = DMCM_SLOTS.map((s) => enc.encode(s));
  const strBytes = [...matNames, ...slotNames].reduce((s, b) => s + b.length, 0);
  const metaBytes = enc.encode(JSON.stringify({ v: CRAFT_BIN_FORMAT, units: 'cm', grip: 'origin', workingEnd: '-Y', look: meta.look, rev: meta.rev }));

  const matOffset = DMCM_HEADER_BYTES;
  const slotOffset = matOffset + mats.length * DMCM_MATERIAL_BYTES;
  const groupOffset = slotOffset + DMCM_SLOTS.length * DMCM_SLOT_BYTES;
  const strOffset = groupOffset + groupCount * DMCM_GROUP_BYTES;
  const metaOffset = pad4(strOffset + strBytes);
  const posOffset = pad4(metaOffset + metaBytes.length);
  const nrmOffset = posOffset + vertexCount * 12;
  const uvOffset = nrmOffset + vertexCount * 12;
  const idxOffset = uvOffset + vertexCount * 8;
  const fileBytes = pad4(idxOffset + indexCount * (index32 ? 4 : 2));

  const buf = new ArrayBuffer(fileBytes);
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  const pos = new Float32Array(buf, posOffset, vertexCount * 3);
  const nrm = new Float32Array(buf, nrmOffset, vertexCount * 3);
  const uv = new Float32Array(buf, uvOffset, vertexCount * 2);
  const idx = index32 ? new Uint32Array(buf, idxOffset, indexCount) : new Uint16Array(buf, idxOffset, indexCount);
  const f3 = (o: number, v: readonly number[]): void => { for (let k = 0; k < 3; k++) dv.setFloat32(o + 4 * k, v[k]!, true); };

  // Строки: имена материалов, затем гнёзд.
  let strAt = strOffset;
  const putStr = (b: Uint8Array): [number, number] => { u8.set(b, strAt); const r: [number, number] = [strAt, b.length]; strAt += b.length; return r; };
  const matStr = matNames.map(putStr);
  const slotStr = slotNames.map(putStr);
  u8.set(metaBytes, metaOffset);

  mats.forEach((m, i) => {
    const o = matOffset + i * DMCM_MATERIAL_BYTES;
    dv.setUint32(o + DMCM_M.nameOffset, matStr[i]![0], true);
    dv.setUint16(o + DMCM_M.nameBytes, matStr[i]![1], true);
    dv.setUint8(o + DMCM_M.alphaMode, m.alpha);
    dv.setUint8(o + DMCM_M.doubleSided, m.doubleSided ? 1 : 0);
    for (let k = 0; k < 4; k++) dv.setFloat32(o + DMCM_M.baseColor + 4 * k, m.baseColor[k]!, true);
    dv.setFloat32(o + DMCM_M.metallic, m.metallic, true);
    dv.setFloat32(o + DMCM_M.roughness, m.roughness, true);
    f3(o + DMCM_M.emissive, m.emissive);
    dv.setFloat32(o + DMCM_M.emissiveStrength, m.emissiveStrength, true);
    dv.setFloat32(o + DMCM_M.alphaCutoff, m.alphaCutoff, true);
  });

  const gmin = [Infinity, Infinity, Infinity], gmax = [-Infinity, -Infinity, -Infinity];
  let tip = [0, 0, 0], tipD = -1;
  let v0 = 0, i0 = 0, g0 = 0;
  accs.forEach((a, s) => {
    const vc = a.pos.length / 3;
    pos.set(a.pos, v0 * 3);
    nrm.set(a.nrm, v0 * 3);
    uv.set(a.uv, v0 * 2);
    // Габарит и конец — по ЗАПИСАННЫМ float32: заголовок описывает ровно байты файла.
    const smin = [Infinity, Infinity, Infinity], smax = [-Infinity, -Infinity, -Infinity];
    for (let i = v0; i < v0 + vc; i++) {
      const x = pos[i * 3]!, y = pos[i * 3 + 1]!, z = pos[i * 3 + 2]!;
      const p = [x, y, z];
      for (let k = 0; k < 3; k++) { if (p[k]! < smin[k]!) smin[k] = p[k]!; if (p[k]! > smax[k]!) smax[k] = p[k]!; }
      const d = x * x + y * y + z * z;
      if (d > tipD) { tipD = d; tip = p; }
    }
    if (!vc) { smin.fill(0); smax.fill(0); }
    else for (let k = 0; k < 3; k++) { gmin[k] = Math.min(gmin[k]!, smin[k]!); gmax[k] = Math.max(gmax[k]!, smax[k]!); }
    let rel = 0;
    let gi = g0;
    for (const [mi, b] of a.buckets) {
      idx.set(b, i0 + rel);
      const o = groupOffset + gi * DMCM_GROUP_BYTES;
      dv.setUint16(o + DMCM_G.material, mi, true);
      dv.setUint32(o + DMCM_G.indexStart, rel, true);
      dv.setUint32(o + DMCM_G.indexCount, b.length, true);
      rel += b.length;
      gi++;
    }
    const o = slotOffset + s * DMCM_SLOT_BYTES;
    dv.setUint32(o + DMCM_S.nameOffset, slotStr[s]![0], true);
    dv.setUint16(o + DMCM_S.nameBytes, slotStr[s]![1], true);
    dv.setUint16(o + DMCM_S.groupCount, a.buckets.size, true);
    dv.setUint32(o + DMCM_S.groupFirst, g0, true);
    dv.setUint32(o + DMCM_S.vertexStart, v0, true);
    dv.setUint32(o + DMCM_S.vertexCount, vc, true);
    dv.setUint32(o + DMCM_S.indexStart, i0, true);
    dv.setUint32(o + DMCM_S.indexCount, rel, true);
    f3(o + DMCM_S.bmin, smin);
    f3(o + DMCM_S.bmax, smax);
    v0 += vc; i0 += rel; g0 = gi;
  });
  if (!vertexCount) { gmin.fill(0); gmax.fill(0); }

  for (let k = 0; k < 4; k++) u8[DMCM_H.magic + k] = DMCM_MAGIC.charCodeAt(k);
  dv.setUint16(DMCM_H.version, CRAFT_BIN_FORMAT, true);
  dv.setUint16(DMCM_H.flags, index32 ? DMCM_FLAG_INDEX32 : 0, true);
  dv.setUint32(DMCM_H.fileBytes, fileBytes, true);
  f3(DMCM_H.bmin, gmin);
  f3(DMCM_H.bmax, gmax);
  f3(DMCM_H.tip, tip);
  dv.setUint16(DMCM_H.matCount, mats.length, true);
  dv.setUint16(DMCM_H.slotCount, DMCM_SLOTS.length, true);
  dv.setUint32(DMCM_H.groupCount, groupCount, true);
  dv.setUint32(DMCM_H.vertexCount, vertexCount, true);
  dv.setUint32(DMCM_H.indexCount, indexCount, true);
  dv.setUint32(DMCM_H.matOffset, matOffset, true);
  dv.setUint32(DMCM_H.slotOffset, slotOffset, true);
  dv.setUint32(DMCM_H.groupOffset, groupOffset, true);
  dv.setUint32(DMCM_H.strOffset, strOffset, true);
  dv.setUint32(DMCM_H.strBytes, strBytes, true);
  dv.setUint32(DMCM_H.metaOffset, metaOffset, true);
  dv.setUint32(DMCM_H.metaBytes, metaBytes.length, true);
  dv.setUint32(DMCM_H.posOffset, posOffset, true);
  dv.setUint32(DMCM_H.nrmOffset, nrmOffset, true);
  dv.setUint32(DMCM_H.uvOffset, uvOffset, true);
  dv.setUint32(DMCM_H.idxOffset, idxOffset, true);
  dv.setUint32(DMCM_H.reserved, 0, true);
  return u8;
}

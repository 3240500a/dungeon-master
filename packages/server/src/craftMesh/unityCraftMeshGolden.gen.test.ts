/**
 * ⭐ 08.10 (Ф4, план «Unity — дом визуального контента»): ПРОДЮСЕР golden-эталона ДВОИЧНОГО МЕША КОВАНОГО ОРУЖИЯ (DMCM v1) для Unity.
 * На каждом `npm test` перегенерирует `packages/client/src/render3d/__golden__/unity_craftmesh.json` из ТЕКУЩЕГО кода печи и конфига:
 * для 8 разных семейств (клинок с зеркальными частями, древковое, топор, лук, магическое со свечением…) — файл DMCM в base64 (ровно
 * то, что отдаёт `GET /api/craft-mesh.bin`) и то, что ОБЯЗАН получить декодер Unity (`CraftMeshBin.cs`) после своей конверсии осей
 * (как glTFast: x → −x у позиций и нормалей, v → 1 − v, треугольник (a, b, c) → (c, b, a)): по гнёздам — счёт вершин и индексов, группы,
 * габарит в осях Unity, контрольные суммы потоков, первые вершины и треугольники явно; конец (`tip`) в осях Unity; материалы.
 * Раскладка файла — шапка `encodeBin.ts` и docs/CRAFT_WEAPONS.md §21.1 «Двоичный меш DMCM v1».
 *
 * Одной командой: `npx vitest run packages/server/src/craftMesh/unityCraftMeshGolden.gen.test.ts`.
 * Скопировать в Unity: `python tools/unity-check/golden_sync.py` (репо Unity; пару «веб → Unity» добавляет порт декодера:
 * `packages/client/src/render3d/__golden__/unity_craftmesh.json` → `Assets/DM/Net/Tests/unity_craftmesh_golden.json`).
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { ConfigRegistry, defaultParts, weaponLookSig } from '@dm/shared';
import { CRAFT_MESH_DEPS } from '../../../client/src/modules/town/craftMesh/configVersion.js';
import { buildForBake, depsRegistry } from './bake.js';
import { bakeCraftBin } from './encodeBin.js';
import {
  CRAFT_BIN_FORMAT, DMCM_FLAG_INDEX32, DMCM_GROUP_BYTES, DMCM_HEADER_BYTES, DMCM_MATERIAL_BYTES, DMCM_SLOT_BYTES, DMCM_SLOTS,
  decodeCraftBin, type DmcmFile, type V3,
} from './binFormat.js';
import { craftMeshRev, craftMeshTables } from './service.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '../../../client/src/render3d/__golden__/unity_craftmesh.json');

const reg = new ConfigRegistry();
reg.loadAll();
const tables = craftMeshTables(reg);
const bakeReg = depsRegistry(tables);
const REV = craftMeshRev(tables);

/** Случаи эталона: `kind` — зачем он здесь (сторож проверяет, что он и правда такой). */
const CASES: { cls: string; hands: number; step: number; kind: string }[] = [
  { cls: 'sword', hands: 1, step: 3, kind: 'клинок с зеркальными частями (гарда)' },
  { cls: 'dagger', hands: 1, step: 5, kind: 'клинок, верхняя ступень' },
  { cls: 'halberd', hands: 2, step: 2, kind: 'древковое' },
  { cls: 'axe', hands: 2, step: 3, kind: 'топор' },
  { cls: 'mace', hands: 1, step: 1, kind: 'булава, нижняя ступень' },
  { cls: 'bow', hands: 2, step: 3, kind: 'лук' },
  { cls: 'crossbow', hands: 2, step: 4, kind: 'арбалет' },
  { cls: 'staff', hands: 2, step: 3, kind: 'магическое со свечением навершия (emissiveStrength 0.45)' },
];

/** FNV-1a 32 бита по байтам. */
function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]!; h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
/** Контрольные суммы потока float32 (после конверсии): FNV-1a по байтам LE с −0 → +0 и взвешенная сумма. */
function sumF32(v: Float32Array, comps: number): { fnv: number; wsum: number } {
  const c = Float32Array.from(v, (x) => (x === 0 ? 0 : x));   // −0 → +0: смена знака у нуля в хеш не идёт
  let w = 0;
  for (let i = 0; i < v.length / comps; i++) for (let k = 0; k < comps; k++) w += c[i * comps + k]! * ((i % 7) + 1) * (k + 1);
  return { fnv: fnv1a(new Uint8Array(c.buffer)), wsum: w };
}
function sumIdx(v: Uint32Array): { fnv: number; wsum: number } {
  let w = 0;
  for (let t = 0; t < v.length; t++) w += v[t]! * ((t % 7) + 1);
  return { fnv: fnv1a(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)), wsum: w };
}

const ux = (p: V3): V3 => [-p[0], p[1], p[2]];
/** Габарит в осях Unity: x отражён — min.x и max.x меняются местами. */
const uBounds = (min: V3, max: V3): { min: V3; max: V3 } => ({ min: [-max[0], min[1], min[2]], max: [-min[0], max[1], max[2]] });
const z0 = (x: number): number => (x === 0 ? 0 : x);   // −0 в JSON всё равно «0», но пусть и в памяти будет +0
const zv = (v: number[]): number[] => v.map(z0);

/** То, что обязана получить Unity из одного гнезда после конверсии. */
function unitySlot(file: DmcmFile, s: DmcmFile['slots'][number]) {
  const pos = new Float32Array(s.vertexCount * 3), nrm = new Float32Array(s.vertexCount * 3), uv = new Float32Array(s.vertexCount * 2);
  for (let i = 0; i < s.vertexCount; i++) {
    const j = s.vertexStart + i;
    pos[i * 3] = -file.position[j * 3]!; pos[i * 3 + 1] = file.position[j * 3 + 1]!; pos[i * 3 + 2] = file.position[j * 3 + 2]!;
    nrm[i * 3] = -file.normal[j * 3]!; nrm[i * 3 + 1] = file.normal[j * 3 + 1]!; nrm[i * 3 + 2] = file.normal[j * 3 + 2]!;
    const v = file.uv[j * 2 + 1]!;
    // 1 − v во float32 (как `1f - v` Unity): у v вне (0, 2^-28) разность float32 точна в double — двойного округления нет.
    if (v !== 0 && Math.abs(v) < 2 ** -28) throw new Error(`эталон ненадёжен: v = ${v} — 1 − v в double и во float32 могут разойтись`);
    uv[i * 2] = file.uv[j * 2]!; uv[i * 2 + 1] = Math.fround(1 - v);
  }
  const idx = new Uint32Array(s.indexCount);
  for (let t = 0; t < s.indexCount; t += 3) {
    const a = file.index[s.indexStart + t]!, b = file.index[s.indexStart + t + 1]!, c = file.index[s.indexStart + t + 2]!;
    idx[t] = c; idx[t + 1] = b; idx[t + 2] = a;
  }
  return {
    name: s.name,
    vertexCount: s.vertexCount,
    indexCount: s.indexCount,
    bounds: s.vertexCount ? uBounds(s.bmin, s.bmax) : { min: [0, 0, 0], max: [0, 0, 0] },
    groups: s.groups.map((g) => ({ material: g.material, materialName: file.materials[g.material]!.name, indexStart: g.indexStart, indexCount: g.indexCount })),
    checksum: { position: sumF32(pos, 3), normal: sumF32(nrm, 3), uv: sumF32(uv, 2), index: sumIdx(idx) },
    firstVertices: Array.from({ length: Math.min(3, s.vertexCount) }, (_, i) => ({
      p: zv([pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!]), n: zv([nrm[i * 3]!, nrm[i * 3 + 1]!, nrm[i * 3 + 2]!]), uv: zv([uv[i * 2]!, uv[i * 2 + 1]!]),
    })),
    firstTriangles: Array.from({ length: Math.min(2, s.indexCount / 3) }, (_, t) => [idx[t * 3]!, idx[t * 3 + 1]!, idx[t * 3 + 2]!]),
  };
}

/** Зеркальных мешей (det < 0 в пространстве корня) в сборке — для сторожа «клинок с зеркальными частями». */
function mirroredParts(cls: string, hands: number, step: number): number {
  const res = buildForBake(bakeReg, cls, hands, defaultParts(reg, cls, hands, step)!, { look: 'x', rev: 'r' })!;
  try {
    res.group.updateMatrixWorld(true);
    let n = 0;
    res.group.traverse((o) => { if ((o as THREE.Mesh).isMesh && o.matrixWorld.determinant() < 0) n++; });
    return n;
  } finally {
    res.dispose();
  }
}

describe('unityCraftMeshGolden — продюсер эталона (пишет render3d/__golden__/unity_craftmesh.json)', () => {
  it('генерит эталон DMCM v1 и того, что получает Unity после конверсии, и пишет на диск', async () => {
    const cases = [];
    for (const c of CASES) {
      const parts = defaultParts(reg, c.cls, c.hands, c.step);
      expect(parts, `${c.cls}/${c.hands}`).toBeTruthy();
      const base = reg.get('items.base').find((b) => b.kind === 'weapon' && b.weaponClass === c.cls && (b.hands ?? 1) === c.hands && !b.id.startsWith('archmage'));
      const look = weaponLookSig({ baseId: base?.id ?? '', parts: parts! });
      const bin = (await bakeCraftBin(bakeReg, c.cls, c.hands, parts!, { look, rev: REV }))!;
      const d = decodeCraftBin(bin);
      if (!d.ok) throw new Error(`${c.cls}: ${d.error} ${d.detail}`);
      const file = d.file;
      const mirrored = mirroredParts(c.cls, c.hands, c.step);
      if (c.kind.includes('зеркальн')) expect(mirrored, `${c.cls}/${c.hands}: зеркальные части есть`).toBeGreaterThan(0);
      if (c.kind.includes('свечени')) expect(file.materials.some((m) => m.emissiveStrength !== 1 && /:glow=/.test(m.name)), 'свечение в материалах').toBe(true);
      cases.push({
        family: `${c.cls}/${c.hands}`, kind: c.kind, cls: c.cls, hands: c.hands, step: c.step, look, rev: REV,
        fileBytes: file.fileBytes, flags: file.flags, index32: file.index32, vertexCount: file.vertexCount, indexCount: file.indexCount,
        mirroredParts: mirrored,
        meta: file.meta,
        bounds: uBounds(file.bmin, file.bmax),
        tip: zv(ux(file.tip)),
        materials: file.materials,
        slots: file.slots.map((s) => unitySlot(file, s)),
        dmcm: Buffer.from(bin).toString('base64'),
      });
    }
    const golden = {
      note: 'Эталон паритета Unity ↔ веб для двоичного меша кованого оружия DMCM v1 (Ф4 плана «Unity — дом визуального контента»): файл, '
        + 'который отдаёт GET /api/craft-mesh.bin, и что обязан получить декодер Unity после конверсии осей. '
        + 'Генерит packages/server/src/craftMesh/unityCraftMeshGolden.gen.test.ts.',
      regen: 'npx vitest run packages/server/src/craftMesh/unityCraftMeshGolden.gen.test.ts',
      spec: 'packages/server/src/craftMesh/encodeBin.ts (шапка) · docs/CRAFT_WEAPONS.md §21.1 «Двоичный меш DMCM v1» · эталонный декодер — packages/server/src/craftMesh/binFormat.ts',
      format: {
        magic: 'DMCM', version: CRAFT_BIN_FORMAT, flagIndex32: DMCM_FLAG_INDEX32, slots: DMCM_SLOTS,
        headerBytes: DMCM_HEADER_BYTES, materialBytes: DMCM_MATERIAL_BYTES, slotBytes: DMCM_SLOT_BYTES, groupBytes: DMCM_GROUP_BYTES,
        alphaMode: ['OPAQUE', 'MASK', 'BLEND'],
      },
      unityConversion: {
        position: 'x → −x (смена знака), y и z как есть; единицы — сантиметры (×0.01 — на узле-посреднике craftWeapon)',
        normal: 'x → −x',
        uv: 'u как есть, v → 1 − v во float32 (`1f - v`)',
        triangle: '(a, b, c) → (c, b, a); индексы — относительно vertexStart своего гнезда; группы (indexStart/indexCount от начала индексов гнезда) не меняются',
        bounds: 'min = (−bmax.x, bmin.y, bmin.z), max = (−bmin.x, bmax.y, bmax.z); пустое гнездо — нули',
        tip: '(−tip.x, tip.y, tip.z)',
        materials: 'как в файле: цвета ЛИНЕЙНЫЕ (baseColor, emissive), emissiveStrength — множитель эмиссии; перевод в URP — дело Unity',
      },
      checksum: {
        fnv: 'FNV-1a 32 бита (h = 2166136261; на каждый байт: h ^= b; h *= 16777619 по модулю 2^32) по байтам little-endian потока гнезда '
          + 'ПОСЛЕ конверсии: позиции и нормали — float32 x, y, z подряд; UV — float32 u, v; индексы — uint32 (независимо от u16/u32 в файле) '
          + 'в порядке после (a, b, c) → (c, b, a). Перед хешем −0 заменяется на +0. Сверять точно.',
        wsum: 'Σ_i Σ_k value[i][k] · ((i mod 7) + 1) · (k + 1) в double, i — номер вершины в гнезде, k — компонента (0…2 или 0…1); '
          + 'для индексов Σ_t index[t] · ((t mod 7) + 1), t — номер индекса в гнезде после конверсии. Сверять с допуском 1e-9 относительно '
          + '(компилятор вправе слить умножение со сложением).',
      },
      cases,
    };
    const text = JSON.stringify(golden);
    expect(text.length, 'эталон — до ~1 МБ').toBeLessThan(1_100_000);
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, text);
  });
});

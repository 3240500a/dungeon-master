import { describe, it, expect } from 'vitest';
import { extractColliderFromGlb } from './glbMeshBbox.js';

/** Собирает минимальный GLB (только JSON-чанк) из glTF-объекта. Экстрактор читает лишь JSON (min/max аксессоров). */
function makeGlb(json: object): Buffer {
  const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const pad = (4 - (jsonBuf.length % 4)) % 4;
  const jsonPadded = Buffer.concat([jsonBuf, Buffer.alloc(pad, 0x20)]);
  const total = 12 + 8 + jsonPadded.length;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonPadded.length, 12); out.writeUInt32LE(0x4e4f534a, 16);
  jsonPadded.copy(out, 20);
  return out;
}

describe('extractColliderFromGlb', () => {
  it('меш collider_box → бокс в долях тайла (100 ед = 1 тайл, Z-up)', () => {
    const glb = makeGlb({
      asset: { version: '2.0' },
      meshes: [{ name: 'collider_box', primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ min: [-30, -20, 0], max: [30, 20, 50] }],   // X 60, Y 40 → footprint 0.6 × 0.4 тайла
    });
    expect(extractColliderFromGlb(glb)).toEqual({ shape: 'box', w: 0.6, h: 0.4 });
  });

  it('квадратный footprint → круг', () => {
    const glb = makeGlb({
      asset: { version: '2.0' },
      meshes: [{ name: 'Collider_pillar', primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ min: [-20, -20, 0], max: [20, 20, 80] }],   // 40×40 → круг r=0.2
    });
    expect(extractColliderFromGlb(glb)).toEqual({ shape: 'circle', r: 0.2 });
  });

  it('коллайдер по имени УЗЛА (node.name collider*, node.mesh)', () => {
    const glb = makeGlb({
      asset: { version: '2.0' },
      nodes: [{ name: 'collider_thing', mesh: 0 }],
      meshes: [{ name: 'hull', primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ min: [-25, -25, 0], max: [25, 25, 60] }],
    });
    expect(extractColliderFromGlb(glb)).toEqual({ shape: 'circle', r: 0.25 });
  });

  it('нет меша collider* → null', () => {
    const glb = makeGlb({
      asset: { version: '2.0' },
      meshes: [{ name: 'body', primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ min: [-30, -20, 0], max: [30, 20, 50] }],
    });
    expect(extractColliderFromGlb(glb)).toBeNull();
  });

  it('не-GLB → null', () => {
    expect(extractColliderFromGlb(Buffer.from('nope'))).toBeNull();
  });
});

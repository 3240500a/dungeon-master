import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { ConfigRegistry } from '../config/registry.js';
import { artSchema, artSetSchema, biomeDressingSchema, type Biome, type Floor } from '../config/schemas.js';
import { Cell, TILE, worldToCell, type Grid } from '../world/grid.js';
import { PLAYER_RADIUS } from '../world/state.js';
import { segmentHits } from '../world/pathfind.js';
import type { DecorObject, DungeonLayout, Room } from './floorCommon.js';
import { decorSpecsFor, decorWarnings, footprintRect, obstaclesFromDecor, type ArtRowLite, type DecorSpec } from './decor.js';
import { isFarFace, toCameraXY } from './dressing.js';
import { generateFloorFor, type FloorConfig } from './floorInputs.js';
import { resolveFloorSpec } from './floorSpec.js';
import { decorStats, formatDecorStats } from './decorStats.js';
import { placeSlots, placeStatueSets, type PropRules, type SetLogEntry } from './slots.js';
import { requiredCount, setMemberRecords, setOffset, setSpecsFor, statueSetPlace, type ArtSetRowLite, type SetSpec } from './sets.js';

/**
 * ⭐ 14.10 (у статуи): СТОРОЖА НАБОРА У СТАТУИ (якорь `statue`, `slots.ts placeStatueSets`, строка `crypt_set_statue`, правило
 * `dressing.props.sets.statueChance`):
 *  • строка манифеста — ровно то, что выгрузит экспорт Unity: схема, все поля, и РАМКА — префаб по строке (обратное правило: X = −x, Z = z + h/2)
 *    даёт по габаритам манифеста ту же строку (правило якоря statue: начало по x — середина статуи, след симметричный ⌈2·max|x| − 0.1⌉ × ⌈z1 − 0.1⌉);
 *    модели членов — в следе, перед линией стены, не в статуе;
 *  • синтетика: набор встаёт перед нишей, лицом в комнату, одна на статую, зеркало — обе стороны, состав «k из n» — все варианты; клетки ниши
 *    открыты ЭТОМУ набору; шанс 0 — ни одного; Р6 — откат всего набора; в Р3 набор у статуи не идёт;
 *  • живые этажи крипты: записи = развёртка журнала в точке статуи, лицом в комнату, у дальней стены, не в стене и не в статуе, не на полосах и
 *    якорях, один на статую; шанс ≈ statueChance; Р6 по сводке чист;
 *  • прочее НЕ МЕНЯЕТСЯ: без строки набора у статуи — этажи байт-в-байт снимок кода до прохода (`__golden__/floors_pre_statue_sets.json`); со
 *    строкой — декор этажа без членов наборов у статуй, сундуки, полосы, проёмы, журнал прочих наборов и преграды — те же, что без строки;
 *  • предупреждения редактора; сводка `decorStats`.
 */
const reg = new ConfigRegistry();
reg.loadAll();
const crypt = reg.get('biomes').find((b) => b.id === 'crypt')!;
const toCam = toCameraXY(reg.get('balance').camera.azimuthDeg);
const cryptSpecs = decorSpecsFor(reg.get('objects'), reg.get('models'), 'crypt', reg.get('art'));
const known = new Map(cryptSpecs.map((s) => [s.id, s]));
const ROW = (reg.get('art') as ArtSetRowLite[]).find((a) => a.id === 'crypt_set_statue')!;
const STATUE_SET = setSpecsFor(reg.get('art'), 'crypt', cryptSpecs, crypt.dressing!.props!.sets).sets.find((s) => s.id === 'crypt_set_statue')!;
const STATUE_IDS = crypt.dressing!.statues!.objectIds;
const BOUNDS = new Map<string, { min: number[]; max: number[] }>();
for (const a of reg.get('art') as ArtRowLite[]) if ((a.kind === 'env' || a.kind === 'prop') && a.bounds && !BOUNDS.has(a.id)) BOUNDS.set(a.id, a.bounds);
const digest = (x: unknown): string => createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 20);

/** Живой конфиг с манифестом `art(rows)` и биомами `biomes(b)`. */
function withArt(art: (rows: ArtRowLite[]) => ArtRowLite[], biomes?: (b: Biome) => Biome): ConfigRegistry {
  const r = new ConfigRegistry();
  r.loadAll();
  r.reload({ art: art(r.get('art') as ArtRowLite[]) as never });
  if (biomes) r.reload({ biomes: r.get('biomes').map(biomes) });
  return r;
}
const isStatueRow = (a: ArtRowLite): boolean => a.kind === 'set' && a.set?.anchor === 'statue';
const noRow = withArt((rows) => rows.filter((a) => !isStatueRow(a)));
const setsRule = (b: Biome, p: object): Biome => (b.dressing?.props?.sets ? { ...b, dressing: { ...b.dressing, props: { ...b.dressing.props, sets: { ...b.dressing.props.sets, ...p } } } } : b);

/** Этажи крипты пути сервера: роли биома по кругу, сид и выходы — от номера (как `decorStats`). */
function cryptFloors(cfg: ConfigRegistry, n: number): { L: DungeonLayout; obstacles: ReturnType<typeof generateFloorFor>['obstacles']; id: string; seed: number }[] {
  const b = cfg.get('biomes').find((x) => x.id === 'crypt')!;
  const floors = cfg.get('floors').filter((f) => f.biomeId === 'crypt' && f.role !== 'rest' && f.enabled !== false);
  const out = [];
  for (let i = 0; i < n; i++) {
    const f = floors[i % floors.length]!;
    const spec = resolveFloorSpec(b, f as Floor, f.minDepth, (i * 7919 + 13) >>> 0, [], { exitCount: 1 + (i % 3) });
    const g = generateFloorFor(cfg, spec, b);
    out.push({ L: g.layout, obstacles: g.obstacles, id: `${f.id}/${i}`, seed: spec.seed });
  }
  return out;
}
const statueEntries = (L: DungeonLayout): SetLogEntry[] => (L.slotLog?.sets?.list ?? []).filter((e) => e.anchor === 'statue');

// ── геометрия: углы модели в осях сервера (MirrorX → three Ry, как `EnvRules.WallClear` и `sets.test.ts`) и пересечение выпуклых ───────────────
type P = { x: number; y: number };
function modelCorners(key: string, x: number, y: number, rot: number): P[] {
  const b = BOUNDS.get(key)!, c = Math.cos(rot), s = Math.sin(rot);
  return [[-b.max[0]!, b.min[2]!], [-b.min[0]!, b.min[2]!], [-b.min[0]!, b.max[2]!], [-b.max[0]!, b.max[2]!]].map(([bx, bz]) => ({ x: x + bx! * c + bz! * s, y: y - bx! * s + bz! * c }));
}
/** Глубина взаимного проникновения двух выпуклых многоугольников (SAT); 0 — не пересекаются. */
function overlap(a: readonly P[], b: readonly P[]): number {
  let depth = Infinity;
  for (const poly of [a, b]) for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!, q = poly[(i + 1) % poly.length]!;
    let nx = -(q.y - p.y), ny = q.x - p.x; const l = Math.hypot(nx, ny); nx /= l; ny /= l;
    const pr = (pts: readonly P[]): [number, number] => { const v = pts.map((t) => t.x * nx + t.y * ny); return [Math.min(...v), Math.max(...v)]; };
    const [a0, a1] = pr(a), [b0, b1] = pr(b);
    const o = Math.min(a1, b1) - Math.max(a0, b0);
    if (o <= 0) return 0;
    depth = Math.min(depth, o);
  }
  return depth;
}

describe('⭐ 14.10 (у статуи): строка набора — то, что выгрузит Unity', () => {
  it('строка crypt_set_statue: вид set, группа biome_crypt, якорь statue; схема — все поля (разбор строку не меняет); набор биома встаёт', () => {
    expect(ROW).toBeDefined();
    expect([ROW.kind, ROW.group, ROW.set!.anchor]).toEqual(['set', 'biome_crypt', 'statue']);
    expect(() => artSchema.parse([ROW])).not.toThrow();
    expect(artSetSchema.parse(ROW.set)).toEqual(ROW.set);
    expect(setSpecsFor(reg.get('art'), 'crypt', cryptSpecs).problems).toEqual([]);
    // камень — всегда, второй камень — «не всегда», ящик 01 или 02 — «не всегда» (группа из двух, встаёт ≤ 1)
    expect(STATUE_SET.members.map((m) => [m.key, m.group])).toEqual([
      ['crypt_stone_01', ''], ['crypt_stone_01', 'stone'], ['crypt_wooden_crate_01', 'crate'], ['crypt_wooden_crate_02', 'crate']]);
    expect(STATUE_SET.groups).toEqual([{ id: 'stone', min: 0, max: 1 }, { id: 'crate', min: 0, max: 1 }]);
    expect(requiredCount(STATUE_SET)).toBe(1);
    expect(STATUE_SET.members.every((m) => m.on === undefined && m.h === 0)).toBe(true);
    expect(STATUE_SET.rooms.corridor, 'в коридорах — нет').toBe(0);
  });

  it('рамка Unity: префаб по строке (X = −x, Z = z + h/2, float32) → по габаритам манифеста ровно эта строка (якорь statue: начало x — середина статуи)', () => {
    const f32 = Math.fround, r = (v: number, d: number): number => Math.round(v * 10 ** d) / 10 ** d + 0;
    const norm = (a: number): number => { let v = a % 360; if (v <= -180) v += 360; if (v > 180) v -= 360; return v + 0; };
    const cells = (span: number): number => Math.max(1, Math.ceil(span - 0.1 - 1e-9));
    const fp = ROW.set!.footprint!;
    const locals = ROW.set!.members!.map((m) => ({ key: m.key!, X: f32(-m.x!), Z: f32(m.z! + fp.h! / 2), eulerY: f32(-m.yaw!), group: m.group ?? '' }));
    let x0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    const srv = locals.map((m) => {
      const x = -m.X, z = m.Z, yaw = norm(-m.eulerY);
      for (const p of modelCorners(m.key, x, z, (yaw * Math.PI) / 180)) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z1 = Math.max(z1, p.y); }
      return { x, z, yaw };
    });
    const w = cells(2 * Math.max(Math.abs(x0), Math.abs(x1))), h = cells(z1);
    expect({ w, h }).toEqual(fp);
    const back = locals.map((m, i) => ({ key: m.key, x: r(srv[i]!.x - 0, 3), z: r(srv[i]!.z - h / 2, 3), h: 0, yaw: norm(r(srv[i]!.yaw, 2)), group: m.group }));
    expect(back).toEqual(ROW.set!.members);
  });

  it('модели членов (габарит манифеста) во всех 8 положениях: в полном следе (± 0.06), перед линией стены, не в статуе (любой из четырёх)', () => {
    const at = { cx: 20 * TILE, cy: 16 * TILE };
    for (let q = 0; q < 4; q++) for (const mirror of [false, true]) {
      const recs = setMemberRecords(STATUE_SET, STATUE_SET.members.map((_, i) => i), { ...at, q, mirror });
      const n = setOffset(0, 1, q, false), t = setOffset(1, 0, q, false);   // лицо набора и ось x рамки в мире
      const wall = { x: at.cx / TILE - n.x * (STATUE_SET.footprint.h / 2), y: at.cy / TILE - n.y * (STATUE_SET.footprint.h / 2) };   // середина статуи на линии стены
      for (const d of recs) {
        const pts = modelCorners(d.objectId!, d.x / TILE, d.y / TILE, d.rot!);
        for (const p of pts) {
          const along = (p.x - wall.x) * t.x + (p.y - wall.y) * t.y, out = (p.x - wall.x) * n.x + (p.y - wall.y) * n.y;
          expect(Math.abs(along), `q${q}${mirror ? 'm' : ''} ${d.objectId}: вдоль`).toBeLessThanOrEqual(STATUE_SET.footprint.w / 2 + 0.06);
          expect(out, `q${q}${mirror ? 'm' : ''} ${d.objectId}: в стене`).toBeGreaterThanOrEqual(0);
          expect(out).toBeLessThanOrEqual(STATUE_SET.footprint.h + 0.06);
        }
        // статуя — в своей точке (середина на линии стены), лицом по нормали
        for (const sid of STATUE_IDS) expect(overlap(pts, modelCorners(sid, wall.x, wall.y, Math.atan2(n.x, n.y))), `q${q}${mirror ? 'm' : ''} ${d.objectId} в ${sid}`).toBe(0);
      }
    }
  });
});

// ── синтетика: комната, статуя в нише дальней стены ─────────────────────────────────────────────────────────────────────────────
const parse = (rows: string[]): Grid => rows.map((r) => [...r].map((ch) => (ch === '#' ? Cell.Wall : Cell.Floor)));
/** Комната w × h в (2, 2), статуи (2 грани) — посреди северной стены и/или восточной (обе дальние при азимуте −45°). */
function statueRoom(w: number, h: number, where: readonly ('north' | 'east')[], spawnAt?: { cx: number; cy: number }): DungeonLayout {
  const rows: string[] = [];
  for (let y = 0; y < h + 4; y++) rows.push([...Array(w + 4)].map((_, x) => (x >= 2 && x < w + 2 && y >= 2 && y < h + 2 ? '.' : '#')).join(''));
  const rm: Room = { x: 2, y: 2, w, h, type: 'large' };
  const s = spawnAt ?? { cx: 2, cy: 2 + h - 1 };
  const sp = { x: s.cx * TILE + 16, y: s.cy * TILE + 16 };
  const L: DungeonLayout = { grid: parse(rows), rooms: [rm], spawn: sp, stairsDown: sp, exits: [sp], decor: [], doors: [], levers: [], chests: [] };
  for (const side of where) {
    const faces: [number, number, number, number][] = side === 'north'
      ? [0, 1].map((k) => [2 + (w >> 1) - 1 + k, 1, 0, 1] as [number, number, number, number])
      : [0, 1].map((k) => [2 + w, 2 + (h >> 1) - 1 + k, -1, 0] as [number, number, number, number]);
    const pts = faces.map(([x, y, dx, dz]) => ({ x: x * TILE + 16 + dx * 16, y: y * TILE + 16 + dz * 16 }));
    L.decor.push({ x: (pts[0]!.x + pts[1]!.x) / 2, y: (pts[0]!.y + pts[1]!.y) / 2, kind: 'obj', objectId: 't_statue', rot: Math.atan2(faces[0]![2], faces[0]![3]), footprint: { w: 2, h: 1 }, wallFaces: faces });
  }
  return L;
}
const spec = (id: string, x: Partial<DecorSpec> = {}): DecorSpec => ({
  id, footprint: { w: 1, h: 1 }, weight: 1, spawnChance: 1, surface: 'floor', coversFloor: false, blocks: true, blocksSight: false,
  collider: { shape: 'circle', r: 0.36 }, clearance: 0, contexts: ['socket'], passport: { contexts: ['socket'], footprint: { w: 1, h: 1 }, blocks: true, blocksSight: false, keepPath: true }, ...x,
});
const SPECS = [
  spec('t_statue', { surface: 'wall', footprint: { w: 2, h: 1 }, collider: { shape: 'box', w: 2, h: 0.45 }, contexts: undefined, passport: undefined }),
  spec('t_stone', { footprint: { w: 2, h: 1 }, collider: { shape: 'box', w: 1.5, h: 0.94 } }),
  spec('t_crate'), spec('t_crate2'),
  spec('t_wall9', { collider: { shape: 'box', w: 20, h: 0.3 } }),   // коллайдер на 20 клеток — режет комнату (Р6)
];
const SYN_KNOWN = new Map(SPECS.map((s) => [s.id, s]));
const synRow = (id: string, members: object[], extra: object = {}): ArtSetRowLite =>
  ({ id, kind: 'set', group: 'biome_syn', set: { anchor: 'statue', members, rooms: { large: 1 }, minRoom: 3, perRoomMax: 2, perFloorMax: 9, ...extra } as ArtSetRowLite['set'] });
// раскладка — как у crypt_set_statue (камень у основания, второй навален, ящик одним из двух — с другой стороны)
const SYN_ROWS: ArtSetRowLite[] = [
  synRow('s_statue', [{ key: 't_stone', x: 1.8, z: -0.48, yaw: 178.21 }, { key: 't_stone', x: 1.25, z: 0.3, yaw: 160, group: 'stone' },
    { key: 't_crate', x: -1.52, z: -0.54, yaw: 8, group: 'crate' }, { key: 't_crate2', x: -1.52, z: -0.54, yaw: -14, group: 'crate' }],
  { footprint: { w: 6, h: 2 }, groups: [{ id: 'stone', min: 0, max: 1 }, { id: 'crate', min: 0, max: 1 }] }),
  synRow('s_front', [{ key: 't_crate', x: 0, z: 0, yaw: 0 }], { footprint: { w: 2, h: 1 } }),   // ящик посреди ниши — только клетки перед статуей
  synRow('s_cut', [{ key: 't_crate', x: 1.5, z: 0, yaw: 0 }, { key: 't_wall9', x: 1.5, z: 0, yaw: 90 }], { footprint: { w: 4, h: 1 } }),
];
const synSets = (ids: string[]): SetSpec[] => setSpecsFor(SYN_ROWS, 'syn', SPECS, { setIds: ids }).sets;
const rulesOf = (statueChance: number, on = true): PropRules => biomeDressingSchema.parse({
  props: { density: { min: 30, max: 30, perArea: 100 }, emptyRoomShare: 0, sameNotNear: 0, lanes: { width: 1 }, center: { on: false }, againstWall: { on: false },
    corner: { on: false }, doorway: { on: false }, wall: { on: false }, sets: { on, chance: 1, perRoom: 1, statueChance, setIds: [], setLimits: [] } },
}).props!;
function synth(ids: string[], L: DungeonLayout, seed: number, chance = 1): DungeonLayout {
  const sets = synSets(ids), rules = rulesOf(chance);
  placeSlots(L, rules, [], seed, { camAzimuthDeg: -45, known: SYN_KNOWN, sets });   // в Р3 наборы у статуй не идут
  placeStatueSets(L, rules, seed, { camAzimuthDeg: -45, known: SYN_KNOWN, sets, statueIds: ['t_statue'] });
  return L;
}

describe('⭐ 14.10 (у статуи): синтетика — проход у статуй', () => {
  it('перед каждой нишей — один набор: точка — середина статуи на линии стены + h/2, лицом в комнату; записи = развёртка; зеркало и состав — все варианты', () => {
    const s = synSets(['s_statue'])[0]!;
    const mirrors = new Set<boolean>(), comps = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      const L = synth(['s_statue'], statueRoom(14, 9, ['north', 'east']), seed);
      const es = statueEntries(L);
      expect(es.map((e) => e.statue).sort(), `сид ${seed}: по набору на статую`).toEqual([0, 1]);
      expect(L.slotLog!.sets!.statues).toEqual({ total: 2, rolled: 2, placed: 2 });
      for (const e of es) {
        const st = L.decor[e.statue!]!;
        const [, , dx, dz] = st.wallFaces![0]!;
        expect(e.place).toEqual(statueSetPlace(st.wallFaces!, s.footprint.h, e.place.mirror));
        expect(setOffset(0, 1, e.place.q, false), 'лицом в комнату').toEqual({ x: dx, y: dz });
        expect(isFarFace(dx, dz, toCam)).toBe(true);
        expect(L.decor.slice(e.at, e.at + e.idx.length)).toEqual(setMemberRecords(s, e.idx, e.place));
        mirrors.add(e.place.mirror);
        comps.add(e.idx.join(','));
      }
    }
    expect([...mirrors].sort()).toEqual([false, true]);
    expect([...comps].sort(), 'камень всегда; второй камень и ящик 01 / 02 — «не всегда»').toEqual(['0', '0,1', '0,1,2', '0,1,3', '0,2', '0,3']);
  });

  it('клетки перед нишей открыты ЭТОМУ набору (ящик посреди ниши встаёт); шанс 0 — ни одного (журнал: выпало 0); правило выключено — прохода нет', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const L = synth(['s_front'], statueRoom(10, 7, ['north']), seed);
      const [e] = statueEntries(L);
      expect(e, `сид ${seed}`).toBeDefined();
      const d = L.decor[e!.at]!, c = worldToCell(d.x, d.y), [fx, fy, dx, dz] = L.decor[e!.statue!]!.wallFaces![0]!;
      expect(c.cy, 'ящик — в ряду перед нишей').toBe(fy + dz);
      expect([fx + dx, fx + dx + 1]).toContain(c.cx);
    }
    const z = synth(['s_statue'], statueRoom(14, 9, ['north', 'east']), 3, 0);
    expect(statueEntries(z)).toEqual([]);
    expect(z.slotLog!.sets!.statues).toEqual({ total: 2, rolled: 0, placed: 0 });
    expect(z.decor.filter((d) => d.objectId !== 't_statue')).toEqual([]);
    const off = statueRoom(14, 9, ['north']), rules = rulesOf(1, false);
    placeSlots(off, rules, [], 3, { camAzimuthDeg: -45, known: SYN_KNOWN, sets: synSets(['s_statue']) });
    const before = JSON.stringify(off);
    placeStatueSets(off, rules, 3, { camAzimuthDeg: -45, known: SYN_KNOWN, sets: synSets(['s_statue']), statueIds: ['t_statue'] });
    expect(JSON.stringify(off)).toBe(before);
  });

  it('в Р3 (`placeSlots`) набор у статуи не идёт: с шансом наборов 1 и одним набором у статуи журнал Р3 пуст', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const L = statueRoom(14, 9, ['north']);
      placeSlots(L, rulesOf(1), [], seed, { camAzimuthDeg: -45, known: SYN_KNOWN, sets: synSets(['s_statue']) });
      expect(L.slotLog!.sets, 'нет наборов Р3 — нет и поля').toBeUndefined();
      expect(L.decor.length).toBe(1);
    }
  });

  it('Р6 — всё или ничего: набор, член которого режет комнату, откатывается целиком (обе стороны); журнал — откат', () => {
    let rejected = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const L = synth(['s_cut'], statueRoom(12, 9, ['north'], { cx: 13, cy: 3 }), seed);
      rejected += L.slotLog!.sets!.rejected;
      expect(statueEntries(L), `сид ${seed}`).toEqual([]);
      expect(L.decor.filter((d) => d.objectId === 't_crate' || d.objectId === 't_wall9')).toEqual([]);
    }
    expect(rejected).toBeGreaterThan(0);
  });
});

describe('⭐ 14.10 (у статуи): живые этажи крипты', () => {
  const runs = cryptFloors(reg, 160);
  const all = runs.flatMap((r) => statueEntries(r.L).map((e) => ({ ...r, e })));

  it('записи = развёртка в точке статуи; лицом в комнату, у дальней стены; один на статую; члены перед линией стены и не в статуе', () => {
    expect(all.length).toBeGreaterThan(150);
    for (const { L, id } of runs) {
      const es = statueEntries(L);
      expect(new Set(es.map((e) => e.statue)).size, `${id}: один на статую`).toBe(es.length);
    }
    for (const { L, id, e } of all) {
      const st = L.decor[e.statue!]!;
      expect(STATUE_IDS, `${id}: запись статуи`).toContain(st.objectId);
      const [, , dx, dz] = st.wallFaces![0]!;
      expect(e.id).toBe('crypt_set_statue');
      expect(e.place).toEqual(statueSetPlace(st.wallFaces!, STATUE_SET.footprint.h, e.place.mirror));
      expect(setOffset(0, 1, e.place.q, false), `${id}: лицом в комнату`).toEqual({ x: dx, y: dz });
      expect(isFarFace(dx, dz, toCam)).toBe(true);
      const recs = L.decor.slice(e.at, e.at + e.idx.length);
      expect(recs).toEqual(setMemberRecords(STATUE_SET, e.idx, e.place));
      const statue = modelCorners(st.objectId!, st.x / TILE, st.y / TILE, st.rot!);
      for (const d of recs) {
        const pts = modelCorners(d.objectId!, d.x / TILE, d.y / TILE, d.rot!);
        for (const p of pts) expect((p.x - st.x / TILE) * dx + (p.y - st.y / TILE) * dz, `${id}: ${d.objectId} в стене`).toBeGreaterThanOrEqual(0);
        expect(overlap(pts, statue), `${id}: ${d.objectId} в статуе`).toBe(0);
      }
    }
  });

  it('полосы, якоря, сундуки, ниши прочих статуй: члены не на полосах, центр клетки полосы не под их коллайдером; след — пол своей комнаты', () => {
    for (const { L, id, e } of all) {
      const cols = L.grid[0]!.length;
      const lane = new Set((L.lanes ?? []).flatMap((l) => l.cells));
      const mouth = new Set((L.doorways ?? []).flatMap((d) => d.inner.map((c) => c.cy * cols + c.cx)));
      const recs = L.decor.slice(e.at, e.at + e.idx.length);
      for (const d of recs) {
        const r = footprintRect(d);
        for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) expect(lane.has(y * cols + x), `${id}: ${d.objectId} на полосе ${x},${y}`).toBe(false);
      }
      const obs = obstaclesFromDecor(recs, known);
      for (const i of lane) {
        if (mouth.has(i)) continue;
        const x = (i % cols) * TILE + 16, y = ((i / cols) | 0) * TILE + 16;
        expect(obs.some((o) => segmentHits(o, x, y, x, y, PLAYER_RADIUS)), `${id}: полоса под коллайдером`).toBe(false);
      }
      const room = L.rooms[e.room]!;
      expect(room.type).not.toBe('entrance');
      for (let y = e.rect.y0; y <= e.rect.y1; y++) for (let x = e.rect.x0; x <= e.rect.x1; x++) {
        expect(L.grid[y]![x], `${id}: след не пол`).toBe(Cell.Floor);
        expect(x >= room.x && x < room.x + room.w && y >= room.y && y < room.y + room.h, `${id}: след вне комнаты`).toBe(true);
      }
      for (const p of [L.spawn, ...L.exits, ...L.levers, ...L.chests]) {
        const c = worldToCell(p.x, p.y);
        expect(c.cx >= e.rect.x0 && c.cx <= e.rect.x1 && c.cy >= e.rect.y0 && c.cy <= e.rect.y1, `${id}: якорь в наборе`).toBe(false);
      }
      for (const [k, d] of L.decor.entries()) {
        if (k === e.statue || !d.wallFaces) continue;
        for (const [x, y, ddx, ddz] of d.wallFaces) {
          const cx = x + ddx, cy = y + ddz;
          expect(cx >= e.rect.x0 && cx <= e.rect.x1 && cy >= e.rect.y0 && cy <= e.rect.y1, `${id}: перед чужой нишей`).toBe(false);
        }
      }
    }
  });

  it('стороны и состав — все варианты; шанс на статую ≈ statueChance (поток на статую); Р6 по сводке чист; наборы у статуй встают', () => {
    expect(new Set(all.map((x) => x.e.place.mirror)).size).toBe(2);
    expect(new Set(all.map((x) => x.e.idx.join(','))).size).toBe(6);
    const st = decorStats(reg, crypt, { floors: 200, warmup: 0, now: () => 0 });
    expect(st.cut.props).toEqual({ cells: 0, anchors: 0 });
    expect(st.cut.other.anchors).toBe(0);
    const s = st.sets!.statue!;
    expect(s.statues).toBeGreaterThan(8);
    expect(Math.abs(s.rolled / s.statues - crypt.dressing!.props!.sets!.statueChance), 'выпало ≈ шанс').toBeLessThan(0.05);
    expect(s.perFloor).toBeGreaterThan(1.5);
    expect(st.sets!.byId['crypt_set_statue']!.perFloor).toBeCloseTo(s.perFloor, 12);
    expect(formatDecorStats(st)).toContain('у статуй');
  }, 120_000);
});

describe('⭐ 14.10 (у статуи): прочее этажа не меняется', () => {
  const GOLDEN = new URL('./__golden__/floors_pre_statue_sets.json', import.meta.url);
  const asCfg = (t: Record<string, unknown>): FloorConfig => ({ get: (k: string) => t[k] }) as unknown as FloorConfig;

  it('без строки набора у статуи — этажи байт-в-байт снимок кода до прохода (замороженные входы крипты × все её этажи × 10 сидов)', () => {
    const g = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { note: string; seeds: number; digests: Record<string, string>; inputs: Record<string, unknown> };
    const run = (): Map<string, string> => {
      const cfg = asCfg(g.inputs), out = new Map<string, string>();
      for (const b of cfg.get('biomes')) for (const f of cfg.get('floors')) for (let seed = 1; seed <= g.seeds; seed++) {
        const { layout, obstacles } = generateFloorFor(cfg, resolveFloorSpec(b, f, f.minDepth, seed * 7919 + 13, [], { exitCount: 1 + (seed % 3) }), b);
        out.set(`${b.id}/${f.id}/${seed}`, createHash('sha256').update(JSON.stringify({ L: layout, obstacles })).digest('hex').slice(0, 20));
      }
      return out;
    };
    if (process.env.DM_STATUE_GOLDEN === 'write') writeFileSync(GOLDEN, JSON.stringify({ ...g, digests: Object.fromEntries(run()) }) + '\n');   // намеренная правка генерации
    expect((g.inputs.art as ArtRowLite[]).some(isStatueRow), 'входы снимка — без строки у статуи').toBe(false);
    expect((g.inputs.art as ArtRowLite[]).filter((a) => a.kind === 'set').length, 'входы снимка — с наборами Ф4').toBe(5);
    const got = run();
    expect(got.size).toBe(Object.keys(g.digests).length);
    expect(got.size).toBeGreaterThanOrEqual(50);
    expect([...got].filter(([k, v]) => g.digests[k] !== v).map(([k]) => k), 'этажи, ставшие другими').toEqual([]);
  });

  it('со строкой: декор без членов наборов у статуй, сундуки, полосы, проёмы, журнал прочих наборов и преграды — те же, что без строки; члены — в конце декора', () => {
    const a = cryptFloors(reg, 120), b = cryptFloors(noRow, 120);
    let added = 0;
    a.forEach((A, i) => {
      const B = b[i]!, id = A.id;
      const es = statueEntries(A.L);
      const mine = new Set(es.flatMap((e) => e.idx.map((_, k) => e.at + k)));
      added += mine.size;
      for (const k of mine) expect(k, `${id}: член набора у статуи — после прочего декора`).toBeGreaterThanOrEqual(B.L.decor.length);
      expect(A.L.decor.filter((_, k) => !mine.has(k)), id).toEqual(B.L.decor);
      expect(A.L.chests, id).toEqual(B.L.chests);
      expect(A.L.lanes).toEqual(B.L.lanes);
      expect(A.L.doorways).toEqual(B.L.doorways);
      expect(A.L.grid).toEqual(B.L.grid);
      expect(A.L.slotLog!.rooms).toEqual(B.L.slotLog!.rooms);
      expect(A.L.slotLog!.passes).toEqual(B.L.slotLog!.passes);
      expect(A.L.slotLog!.sets!.list.filter((e) => e.anchor !== 'statue')).toEqual(B.L.slotLog!.sets!.list);
      expect(A.L.slotLog!.sets!.placed - es.length).toBe(B.L.slotLog!.sets!.placed);
      expect(A.obstacles.slice(0, B.obstacles.length), id).toEqual(B.obstacles);
      expect(A.obstacles.length - B.obstacles.length).toBe(obstaclesFromDecor(A.L.decor.filter((_, k) => mine.has(k)), known).length);
      expect('statues' in B.L.slotLog!.sets!, 'без строки — без сводки прохода').toBe(false);
    });
    expect(added).toBeGreaterThan(100);
  });

  it('шанс 0 — декор и преграды как без строки (проход только считает); правила наборов выключены — этаж как без строки целиком', () => {
    const zero = cryptFloors(withArt((r) => r, (bm) => setsRule(bm, { statueChance: 0 })), 30), b = cryptFloors(noRow, 30);
    zero.forEach((Z, i) => {
      expect(statueEntries(Z.L)).toEqual([]);
      expect(Z.L.decor).toEqual(b[i]!.L.decor);
      expect(Z.obstacles).toEqual(b[i]!.obstacles);
      expect(Z.L.slotLog!.sets!.statues!.placed).toBe(0);
    });
    const off = cryptFloors(withArt((r) => r, (bm) => setsRule(bm, { on: false })), 20).map((r) => digest({ L: r.L, o: r.obstacles }));
    const offNo = cryptFloors(withArt((r) => r.filter((a) => !isStatueRow(a)), (bm) => setsRule(bm, { on: false })), 20).map((r) => digest({ L: r.L, o: r.obstacles }));
    expect(off).toEqual(offNo);
  });
});

describe('⭐ 14.10 (у статуи): предупреждения и сводка', () => {
  const setMsgs = (w: ReturnType<typeof decorWarnings>): string[] => w.filter((x) => /набор/.test(x.msg)).map((x) => `${x.section}:${x.id}`);

  it('крипта — чисто; набор у статуи у биома без статуй — предупреждение', () => {
    expect(setMsgs(decorWarnings(reg.get('objects'), reg.get('art') as ArtRowLite[], reg.get('biomes')))).toEqual([]);
    const bare = reg.get('biomes').map((b) => (b.id === 'crypt' ? { ...b, dressing: { ...b.dressing!, statues: { ...b.dressing!.statues!, objectIds: [] } } } : b));
    expect(setMsgs(decorWarnings(reg.get('objects'), reg.get('art') as ArtRowLite[], bare))).toEqual(['art:crypt_set_statue']);
  });

  it('сводка «до / после» только наборов у статуй (шанс 0): прочие пропы — те же; строка «у статуй» со стрелкой', () => {
    const after = decorStats(reg, crypt, { floors: 24, warmup: 0, now: () => 0 });
    const before = decorStats(reg, crypt, { floors: 24, warmup: 0, now: () => 0, withoutStatueSets: true });
    expect(before.sets!.statue!.perFloor).toBe(0);
    expect(after.sets!.statue!.perFloor).toBeGreaterThan(0);
    expect(after.rooms).toBe(before.rooms);
    expect(after.passes).toEqual(before.passes);
    expect(after.items['crypt_wall_torch_01']).toBe(before.items['crypt_wall_torch_01']);
    expect(after.items['crypt_floor_grille_01']).toBe(before.items['crypt_floor_grille_01']);
    const txt = formatDecorStats(after, before);
    expect(txt).toContain('без наборов у статуй');
    expect(txt).toMatch(/у статуй: .* встало наборов 0\.00 → /);
  });
});

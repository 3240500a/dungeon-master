import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { ConfigRegistry } from '../config/registry.js';
import { artSchema, artSetSchema, biomeDressingSchema, DECOR_SET_ANCHORS, type Biome, type Floor } from '../config/schemas.js';
import { createRng } from '../formulas/rng.js';
import { Cell, TILE, worldToCell, type Grid } from '../world/grid.js';
import type { DecorObject, DungeonLayout, Room } from './floorCommon.js';
import { boxYaw, claimsOf, decorSpecsFor, decorWarnings, footprintRect, obstaclesFromDecor, type ArtRowLite, type DecorSpec } from './decor.js';
import { isFarFace, toCameraXY } from './dressing.js';
import { generateFloorFor } from './floorInputs.js';
import { PLAYER_RADIUS } from '../world/state.js';
import { segmentHits } from '../world/pathfind.js';
import { resolveFloorSpec } from './floorSpec.js';
import { decorStats } from './decorStats.js';
import { placeSlots, recordsRect, type PropRules } from './slots.js';
import {
  chooseMembers, quarterOf, requiredCount, setFootprintAt, setMemberRecords, setOffset, setSpecsFor, shrinkMembers, type ArtSetRowLite, type SetSpec,
} from './sets.js';

/**
 * ⭐ 13.10 (Ф4 «Наборы», план декора): СТОРОЖА НАБОРОВ-СЦЕНОК (`sets.ts`, проход Р3 `slots.ts`, правило биома `dressing.props.sets`):
 *  • схема строки набора (вид `set` манифеста, `artSetSchema`) и игровая ревизия (блок набора — игровой, подпись `name` — нет);
 *  • наборы биома (`setSpecsFor`): биом папки, порядок по ключу, правила `setIds` / `setLimits`, проблемы строки — набор вне игры;
 *  • состав «k из n» (`chooseMembers`): границы групп, стоящий на другом — только с хозяином, бюджет, запасной (`shrinkMembers`);
 *  • развёртка во ВСЕХ 8 положениях (4 четверти × зеркало): раскладка членов, курсы, высоты — те же, что в рамке набора; модели в следе;
 *  • стоящий на другом (`DecorObject.h`) — ни преграды, ни пола; курс бокса преграды — как у модели (`boxYaw`; четверти — прежнее число);
 *  • синтетика: центр — у центра комнаты с кольцом пола и полосы его огибают; у стены — задний край на линии стены; угол — обе стены; дальняя
 *    стена; высокий в центр — никогда; Р6 — откат ВСЕГО набора;
 *  • живые этажи крипты с наборами (НАБОРЫ КРИПТЫ — те, что выгрузит Unity: `CRYPT_SETS`): ≥ 500 этажей — проходимость (сводка Р6), полосы,
 *    лимиты, бюджет, записи = развёртка журнала, якоря у стен; детерминизм; без наборов — этаж прежний байт-в-байт;
 *  • предупреждения редактора (`decorWarnings`).
 */

/** Наборы крипты — ровно те строки, что выгрузит экспорт Unity по префабам Env/crypt/sets/<id>/ (раскладка — ручная комната владельца
 *  top_down/dungeon, сцена test; второй камень завала — наш). Синтетика теста: живой манифест до выгрузки их не содержит. */
const CRYPT_SETS: ArtSetRowLite[] = [
  { id: 'crypt_set_refectory', kind: 'set', group: 'biome_crypt', set: {
    name: 'Трапезная', anchor: 'center', footprint: { w: 3, h: 3 },
    members: [
      { key: 'crypt_wooden_table_3x_01', x: 0, z: 0.034, h: 0, yaw: -90, group: '' },
      { key: 'crypt_wooden_stool_01', x: 0.885, z: 0.909, h: 0, yaw: -2.78, group: 'stools' },
      { key: 'crypt_wooden_stool_01', x: 0.01, z: 0.909, h: 0, yaw: 0, group: 'stools' },
      { key: 'crypt_wooden_stool_01', x: -0.74, z: 1.034, h: 0, yaw: 92.64, group: 'stools' },
      { key: 'crypt_wooden_stool_01', x: 1, z: -0.966, h: 0, yaw: -123.17, group: 'stools' },
      { key: 'crypt_wooden_stool_01', x: 0.135, z: -0.966, h: 0, yaw: 174.4, group: 'stools' },
      { key: 'crypt_wooden_stool_01', x: -0.865, z: -0.966, h: 0, yaw: -123.17, group: 'stools' },
    ],
    groups: [{ id: 'stools', min: 2, max: 6 }], rooms: { small: 0, large: 1, treasure: 0.5, boss: 0, corridor: 0 },
    minRoom: 7, weight: 3, perRoomMax: 1, perFloorMax: 2, tags: ['furniture', 'table'], biomes: [],
  } },
  { id: 'crypt_set_scribe', kind: 'set', group: 'biome_crypt', set: {
    name: 'Писарский угол', anchor: 'againstWall', footprint: { w: 2, h: 4 },
    members: [
      { key: 'crypt_wooden_table_2x_01', x: 0, z: -1.5, h: 0, yaw: -90, group: '' },
      { key: 'crypt_wooden_chair_01', x: -0.25, z: -0.625, h: 0, yaw: -62.36, group: 'chair' },
      { key: 'crypt_wooden_crate_02', x: -0.247, z: 0.81, h: 0, yaw: 62.4, group: 'crate' },
    ],
    groups: [{ id: 'chair', min: 0, max: 1 }, { id: 'crate', min: 0, max: 1 }], rooms: { small: 1, large: 1, treasure: 0.5, boss: 0, corridor: 0 },
    minRoom: 5, weight: 1, perRoomMax: 1, perFloorMax: 3, tags: ['furniture', 'table'], biomes: [],
  } },
  { id: 'crypt_set_library', kind: 'set', group: 'biome_crypt', set: {
    name: 'Библиотека', anchor: 'farWall', footprint: { w: 2, h: 1 },
    members: [
      { key: 'crypt_wooden_shelf_01', x: 0, z: -0.25, h: 0, yaw: 0, group: '' },
      { key: 'crypt_books_01', x: 0, z: -0.25, h: 0, yaw: 0, group: '', on: 0 },
    ],
    groups: [], rooms: { small: 1, large: 1, treasure: 1, boss: 0, corridor: 0 },
    minRoom: 5, weight: 2, perRoomMax: 1, perFloorMax: 2, tags: ['furniture', 'storage', 'books'], biomes: [],
  } },
  { id: 'crypt_set_storage', kind: 'set', group: 'biome_crypt', set: {
    name: 'Склад', anchor: 'corner', footprint: { w: 2, h: 1 },
    members: [
      { key: 'crypt_wooden_crate_02', x: 0.196, z: -0.093, h: 0, yaw: 75, group: '' },
      { key: 'crypt_wooden_crate_02', x: -0.64, z: -0.125, h: 0, yaw: 0, group: '' },
      { key: 'crypt_wooden_crate_02', x: -0.265, z: 0, h: 0.75, yaw: -34.3, group: 'top', on: 1 },
    ],
    groups: [{ id: 'top', min: 0, max: 1 }], rooms: { small: 1, large: 1, treasure: 1.5, boss: 0, corridor: 0 },
    minRoom: 4, weight: 1, perRoomMax: 2, perFloorMax: 4, tags: ['storage', 'crate'], biomes: [],
  } },
  { id: 'crypt_set_rubble', kind: 'set', group: 'biome_crypt', set: {
    name: 'Завал', anchor: 'corner', footprint: { w: 2, h: 2 },
    members: [
      { key: 'crypt_stone_01', x: -0.237, z: -0.512, h: 0, yaw: 178.21, group: '' },
      { key: 'crypt_stone_01', x: 0.013, z: 0.108, h: 0, yaw: 116.21, group: 'second' },
    ],
    groups: [{ id: 'second', min: 0, max: 1 }], rooms: { small: 1, large: 1, treasure: 0.5, boss: 1, corridor: 0 },
    minRoom: 4, weight: 0.8, perRoomMax: 1, perFloorMax: 3, tags: ['rubble'], biomes: [],
  } },
];

/** Живой конфиг, у манифеста которого строки наборов — `rows` (вместо своих, если есть). */
function withSets(rows: readonly ArtSetRowLite[] = CRYPT_SETS, biomes?: (b: Biome) => Biome): ConfigRegistry {
  const r = new ConfigRegistry();
  r.loadAll();
  r.reload({ art: [...r.get('art').filter((a) => a.kind !== 'set'), ...rows] });
  if (biomes) r.reload({ biomes: r.get('biomes').map(biomes) });
  return r;
}
const reg = withSets();
const crypt = reg.get('biomes').find((b) => b.id === 'crypt')!;
const toCam = toCameraXY(reg.get('balance').camera.azimuthDeg);
const cryptSpecs = decorSpecsFor(reg.get('objects'), reg.get('models'), 'crypt', reg.get('art'));
const known = new Map(cryptSpecs.map((s) => [s.id, s]));
const SETS = setSpecsFor(reg.get('art'), 'crypt', cryptSpecs, crypt.dressing!.props!.sets).sets;
const setById = new Map(SETS.map((s) => [s.id, s]));
/** Без правил наборов у крипты. */
const noSetRules = (b: Biome): Biome => (b.dressing?.props?.sets ? { ...b, dressing: { ...b.dressing, props: (({ sets: _s, ...p }) => p)(b.dressing.props) } } : b);

/** Этажи крипты пути сервера: роли биома по кругу, сид и выходы — от номера (как `decorStats`). */
function cryptFloors(cfg: ConfigRegistry, n: number, from = 0): { L: DungeonLayout; specs: DecorSpec[]; obstacles: ReturnType<typeof generateFloorFor>['obstacles']; id: string }[] {
  const b = cfg.get('biomes').find((x) => x.id === 'crypt')!;
  const floors = cfg.get('floors').filter((f) => f.biomeId === 'crypt' && f.role !== 'rest' && f.enabled !== false);
  const out = [];
  for (let i = from; i < from + n; i++) {
    const f = floors[i % floors.length]!;
    const g = generateFloorFor(cfg, resolveFloorSpec(b, f as Floor, f.minDepth, (i * 7919 + 13) >>> 0, [], { exitCount: 1 + (i % 3) }), b);
    out.push({ L: g.layout, specs: g.inputs.decorSpecs, obstacles: g.obstacles, id: `${f.id}/${i}` });
  }
  return out;
}
const digest = (x: unknown): string => createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 20);

describe('⭐ 13.10 (Ф4): схема набора, данные, игровая ревизия', () => {
  it('строки наборов крипты проходят схему (вид set манифеста); имена якорей; умолчания — страховка миграции', () => {
    expect(DECOR_SET_ANCHORS).toEqual(['center', 'againstWall', 'corner', 'farWall', 'statue']);   // ⭐ 14.10: + у статуи (`statueSets.test.ts`)
    for (const r of CRYPT_SETS) {
      expect(() => artSchema.parse([r]), r.id).not.toThrow();
      expect(artSetSchema.parse(r.set)).toEqual(r.set);   // Unity пишет все поля — разбор их не меняет
    }
    const d = artSetSchema.parse({ members: [{ key: 'k', x: 0, z: 0 }] });
    expect(d).toEqual({ name: '', anchor: 'center', footprint: { w: 1, h: 1 }, members: [{ key: 'k', x: 0, z: 0, h: 0, yaw: 0, group: '' }], groups: [],
      rooms: { small: 1, large: 1, treasure: 1, boss: 1, corridor: 1 }, minRoom: 1, weight: 1, perRoomMax: 1, perFloorMax: 2, tags: [], biomes: [] });
    expect(() => artSetSchema.parse({ members: [] }), 'набор без членов').toThrow();
  });

  it('правила наборов крипты — в data/biomes.json (все поля); у прочих биомов правил наборов нет', () => {
    const live = new ConfigRegistry(); live.loadAll();
    const raw = live.get('biomes').find((b) => b.id === 'crypt')!.dressing!.props!.sets;
    expect(raw).toEqual({ on: true, chance: 1, perRoom: 2, statueChance: 1, setIds: [], setLimits: [] });   // ⭐ 14.10: + шанс у статуи; ⭐ 15.10 владелец «наборов не видно»: 0.6/1/0.5 → 1/2/1
    for (const b of live.get('biomes')) if (b.id !== 'crypt') expect(b.dressing?.props?.sets, b.id).toBeUndefined();
    expect(biomeDressingSchema.parse({ props: { sets: {} } }).props!.sets).toEqual({ on: true, chance: 0.6, perRoom: 1, statueChance: 0.5, setIds: [], setLimits: [] });
  });

  it('игровая ревизия: строки наборов — игровые (член, раскладка), подпись `name` — нет', () => {
    const bare = withSets([]), a = withSets(), b = withSets(CRYPT_SETS.map((r) => ({ ...r, set: { ...r.set!, name: `${r.set!.name}!` } })));
    const c = withSets(CRYPT_SETS.map((r, i) => (i ? r : { ...r, set: { ...r.set!, members: r.set!.members!.map((m, k) => (k ? m : { ...m, x: 0.1 })) } })));
    expect(a.gameRevision()).not.toBe(bare.gameRevision());
    expect(b.gameRevision(), 'подпись — только для людей').toBe(a.gameRevision());
    expect(c.gameRevision(), 'раскладка члена меняет этажи').not.toBe(a.gameRevision());
  });
});

describe('⭐ 13.10 (Ф4): наборы биома — `setSpecsFor`', () => {
  it('крипта: пять наборов по ключу; члены — объекты биома; высокий — библиотека; отступ — наибольший у членов', () => {
    expect(SETS.map((s) => s.id)).toEqual(['crypt_set_library', 'crypt_set_refectory', 'crypt_set_rubble', 'crypt_set_scribe', 'crypt_set_storage']);
    for (const s of SETS) for (const m of s.members) expect(m.spec.id, `${s.id}: ${m.key}`).toBe(m.key);
    expect(SETS.filter((s) => s.tall).map((s) => s.id)).toEqual(['crypt_set_library']);
    expect(setById.get('crypt_set_refectory')!.clearance).toBe(1);   // стол 3x — отступ 1
    expect(setById.get('crypt_set_storage')!.clearance).toBe(0);
    expect(setById.get('crypt_set_refectory')!.members[1]!.yaw).toBeCloseTo((-2.78 * Math.PI) / 180, 12);   // курс — в радианах
    // прочие биомы — без наборов (группа biome_crypt); порядок строк манифеста не важен
    expect(setSpecsFor(reg.get('art'), 'caves', cryptSpecs).sets).toEqual([]);
    const shuffled = [...CRYPT_SETS].reverse();
    expect(setSpecsFor(shuffled, 'crypt', cryptSpecs).sets.map((s) => s.id)).toEqual(SETS.map((s) => s.id));
  });

  it('правила биома: setIds — какие, setLimits — вес и лимиты поверх строки, on: false — никаких', () => {
    const only = setSpecsFor(CRYPT_SETS, 'crypt', cryptSpecs, { setIds: ['crypt_set_storage', 'нет_такого'] }).sets;
    expect(only.map((s) => s.id)).toEqual(['crypt_set_storage']);
    const tuned = setSpecsFor(CRYPT_SETS, 'crypt', cryptSpecs, { setLimits: [{ id: 'crypt_set_scribe', weight: 7, perFloorMax: 9 }] }).sets;
    const sc = tuned.find((s) => s.id === 'crypt_set_scribe')!;
    expect([sc.weight, sc.perRoomMax, sc.perFloorMax]).toEqual([7, 1, 9]);
    expect(setSpecsFor(CRYPT_SETS, 'crypt', cryptSpecs, { on: false }).sets).toEqual([]);
  });

  it('проблемы строки — набор вне игры: член без объекта, хозяин не раньше, высота без хозяина, группа без описания, якорь, пустой', () => {
    const row = (id: string, set: ArtSetRowLite['set']): ArtSetRowLite => ({ id, kind: 'set', group: 'biome_crypt', set });
    const m = { key: 'crypt_wooden_crate_02', x: 0, z: 0 };
    const bad = [
      row('a_nokey', { members: [{ ...m, key: 'crypt_нет' }] }),
      row('b_on', { members: [m, { ...m, on: 1 }] }),
      row('c_h', { members: [{ ...m, h: 0.5 }] }),
      row('d_group', { members: [{ ...m, group: 'x' }] }),
      row('e_anchor', { anchor: 'roof', members: [m] }),
      row('f_empty', { members: [] }),
      row('g_ok', { members: [m, { ...m, h: 0.75, on: 0 }] }),
    ];
    const r = setSpecsFor(bad, 'crypt', cryptSpecs);
    expect(r.sets.map((s) => s.id)).toEqual(['g_ok']);
    expect(r.problems.map((p) => p.id)).toEqual(['a_nokey', 'b_on', 'c_h', 'd_group', 'e_anchor', 'f_empty']);
  });
});

describe('⭐ 13.10 (Ф4): состав набора — «оставить k из n» (только сервер)', () => {
  const ref = setById.get('crypt_set_refectory')!, sto = setById.get('crypt_set_storage')!, scr = setById.get('crypt_set_scribe')!;

  it('трапезная: стол всегда, табуретов 2…6 — каждое число встречается; детерминизм', () => {
    const seen = new Set<number>();
    for (let s = 1; s <= 400; s++) {
      const c = chooseMembers(ref, createRng(s), 99)!;
      expect(c[0]).toBe(0);
      expect(c).toEqual([...c].sort((a, b) => a - b));
      seen.add(c.length - 1);
      expect(chooseMembers(ref, createRng(s), 99)).toEqual(c);
    }
    expect([...seen].sort()).toEqual([2, 3, 4, 5, 6]);
  });

  it('бюджет: необязательные урезаются до min групп; обязательные + min не влезают — набора нет', () => {
    expect(requiredCount(ref)).toBe(1);
    for (let s = 1; s <= 50; s++) expect(chooseMembers(ref, createRng(s), 3)!.length).toBe(3);
    expect(chooseMembers(ref, createRng(1), 2)).toBeNull();
    expect(chooseMembers(ref, createRng(1), 99, true)!.length, 'запасной состав — группы на min').toBe(3);
  });

  it('стоящий на другом — только с хозяином; хозяин необязателен — без него нет и его', () => {
    for (let s = 1; s <= 60; s++) {
      const c = chooseMembers(sto, createRng(s), 99)!;
      expect(c.slice(0, 2)).toEqual([0, 1]);
      if (c.includes(2)) expect(c).toContain(sto.members[2]!.on!);
    }
    const host = { ...sto, groups: [{ id: 'h', min: 0, max: 0 }], members: sto.members.map((m, i) => (i === 1 ? { ...m, group: 'h' } : i === 2 ? { ...m, group: '' } : m)) };
    expect(requiredCount(host), 'ящик сверху стоит на необязательном').toBe(1);
    expect(chooseMembers(host, createRng(3), 99)).toEqual([0]);
  });

  it('запасной состав (`shrinkMembers`): по одному необязательному с последней группы — писарский угол: ящик, затем стул', () => {
    expect(shrinkMembers(scr, [0, 1, 2])).toEqual([0, 1]);
    expect(shrinkMembers(scr, [0, 1])).toEqual([0]);
    expect(shrinkMembers(scr, [0])).toBeNull();
    expect(shrinkMembers(sto, [0, 1, 2])).toEqual([0, 1]);
  });
});

describe('⭐ 13.10 (Ф4): развёртка — все 8 положений (4 четверти × зеркало)', () => {
  const art = new Map((reg.get('art') as ArtRowLite[]).filter((a) => a.kind === 'env' && a.bounds).map((a) => [a.id, a.bounds!]));
  const placeAt = { cx: 20 * TILE, cy: 16 * TILE };

  it('раскладка, курсы и высоты членов — как в рамке набора: точка — поворот рамки, курс — четверть ± курс члена', () => {
    for (const s of SETS) for (let q = 0; q < 4; q++) for (const mirror of [false, true]) {
      const all = s.members.map((_, i) => i);
      const recs = setMemberRecords(s, all, { ...placeAt, q, mirror });
      const phi = (q * Math.PI) / 2, c = Math.cos(phi), sn = Math.sin(phi);
      recs.forEach((d, i) => {
        const m = s.members[i]!, lx = mirror ? -m.x : m.x;
        expect(d.x).toBeCloseTo(placeAt.cx + (lx * c + m.z * sn) * TILE, 9);
        expect(d.y).toBeCloseTo(placeAt.cy + (-lx * sn + m.z * c) * TILE, 9);
        // лицо модели в мире = поворот рамки лица члена в рамке (тот же поворот, что у точек; зеркало — x → −x)
        const fx = mirror ? -Math.sin(m.yaw) : Math.sin(m.yaw), fz = Math.cos(m.yaw);
        expect(Math.sin(d.rot!)).toBeCloseTo(fx * c + fz * sn, 9);
        expect(Math.cos(d.rot!)).toBeCloseTo(-fx * sn + fz * c, 9);
        expect(d.rot!).toBeGreaterThan(-Math.PI - 1e-12); expect(d.rot!).toBeLessThanOrEqual(Math.PI + 1e-12);
        expect('h' in d, `${s.id}/${i}: высота — только у стоящего на другом`).toBe(m.on !== undefined);
        if (m.on !== undefined) expect(d.h).toBeCloseTo(m.h * TILE, 12);
        expect(d.footprint).toEqual(m.spec.footprint);
        expect(d.objectId).toBe(m.key);
      });
      // взаимные расстояния и разности курсов (с зеркалом — знак) — как в рамке
      for (let i = 0; i < recs.length; i++) for (let j = i + 1; j < recs.length; j++) {
        const a = s.members[i]!, b = s.members[j]!;
        expect(Math.hypot(recs[i]!.x - recs[j]!.x, recs[i]!.y - recs[j]!.y)).toBeCloseTo(Math.hypot(a.x - b.x, a.z - b.z) * TILE, 9);
        const dr = recs[i]!.rot! - recs[j]!.rot!, dy = (mirror ? -1 : 1) * (a.yaw - b.yaw);
        expect(Math.cos(dr)).toBeCloseTo(Math.cos(dy), 9); expect(Math.sin(dr)).toBeCloseTo(Math.sin(dy), 9);
      }
    }
  });

  it('модели членов (габарит манифеста, оси сервера — как у рендера) — внутри полного следа набора (± 0.06 клетки) в каждом положении', () => {
    for (const s of SETS) for (let q = 0; q < 4; q++) for (const mirror of [false, true]) {
      const fp = setFootprintAt(s, q);
      const recs = setMemberRecords(s, s.members.map((_, i) => i), { ...placeAt, q, mirror });
      for (const d of recs) {
        const b = art.get(d.objectId!)!;
        const c = Math.cos(d.rot!), sn = Math.sin(d.rot!);
        for (const bx of [-b.max[0]!, -b.min[0]!]) for (const bz of [b.min[2]!, b.max[2]!]) {   // MirrorX → three Ry (как `EnvRules.WallClear`)
          const x = d.x / TILE + bx * c + bz * sn, y = d.y / TILE - bx * sn + bz * c;
          expect(Math.abs(x - placeAt.cx / TILE), `${s.id} q${q}${mirror ? 'm' : ''} ${d.objectId}`).toBeLessThanOrEqual(fp.w / 2 + 0.06);
          expect(Math.abs(y - placeAt.cy / TILE), `${s.id} q${q}${mirror ? 'm' : ''} ${d.objectId}`).toBeLessThanOrEqual(fp.h / 2 + 0.06);
        }
      }
    }
  });

  it('четверть по нормали стены; смещение рамки — точные числа (без шума cos π/2); след на нечётной четверти — сторонами наоборот', () => {
    expect([quarterOf({ x: 0, y: 1 }), quarterOf({ x: 1, y: 0 }), quarterOf({ x: 0, y: -1 }), quarterOf({ x: -1, y: 0 })]).toEqual([0, 1, 2, 3]);
    expect(setOffset(1, 2, 1, false)).toEqual({ x: 2, y: -1 });
    expect(setOffset(1, 2, 3, true)).toEqual({ x: -2, y: -1 });
    expect(setFootprintAt({ footprint: { w: 2, h: 4 } }, 1)).toEqual({ w: 4, h: 2 });
    expect(setFootprintAt({ footprint: { w: 2, h: 4 } }, 2)).toEqual({ w: 2, h: 4 });
  });
});

describe('⭐ 13.10 (Ф4): преграды и пол членов', () => {
  it('стоящий на другом (`h`) — ни преграды, ни занятого пола; под ним — у того, кто под ним', () => {
    const base: DecorObject = { x: 100, y: 100, kind: 'obj', objectId: 'crypt_wooden_crate_02', rot: 0, footprint: { w: 1, h: 1 } };
    const top: DecorObject = { ...base, x: 112, h: 24 };
    expect(obstaclesFromDecor([base, top], known)).toHaveLength(1);
    expect(obstaclesFromDecor([top], known)).toEqual([]);
    const c1 = claimsOf([top], known);
    expect(c1.free(footprintRect(top))).toBe(true);
    const c2 = claimsOf([base], known);
    expect(c2.free(footprintRect(base))).toBe(false);
  });

  it('курс бокса — как у модели: на четверти число прежнее (бокс симметричен), иначе −rot; углы бокса = углы модели рендера', () => {
    for (const rot of [0, Math.PI / 2, -Math.PI / 2, Math.PI, Math.atan2(1, 0), Math.atan2(-1, 0), (3 * Math.PI) / 2]) expect(boxYaw(rot)).toBe(rot);
    const stone = known.get('crypt_stone_01')!;
    for (const deg of [178.21, 116.21, 30, -62.4, 45, -123.17]) {
      const rot = (deg * Math.PI) / 180;
      const [o] = obstaclesFromDecor([{ x: 0, y: 0, kind: 'obj', objectId: stone.id, rot, footprint: { w: 2, h: 1 } }], known);
      expect(o!.shape).toBe('box');
      const cy = Math.cos(o!.yaw!), sy = Math.sin(o!.yaw!);
      const box = [-1, 1].flatMap((sx) => [-1, 1].map((sz) => [sx * o!.hw! * cy - sz * o!.hh! * sy, sx * o!.hw! * sy + sz * o!.hh! * cy]));
      const c = Math.cos(rot), s = Math.sin(rot), w = (stone.collider!.w! * TILE) / 2, h = (stone.collider!.h! * TILE) / 2;
      const model = [-1, 1].flatMap((sx) => [-1, 1].map((sz) => [sx * w * c + sz * h * s, -sx * w * s + sz * h * c]));   // three Ry (оси сервера)
      for (const p of model) expect(box.some((q) => Math.hypot(q[0]! - p[0]!, q[1]! - p[1]!) < 1e-9), `${deg}°: угол модели ${p}`).toBe(true);
    }
  });
});

// ── синтетика: одна комната, сетка из строк ─────────────────────────────────────────────────────────────────────────────
const parse = (rows: string[]): Grid => rows.map((r) => [...r].map((ch) => (ch === '#' ? Cell.Wall : Cell.Floor)));
function room(w: number, h: number, door?: 'top' | 'left', spawnAt?: { cx: number; cy: number }): DungeonLayout {
  const rows: string[] = [];
  for (let y = 0; y < h + 4; y++) rows.push([...Array(w + 4)].map((_, x) => (x >= 2 && x < w + 2 && y >= 2 && y < h + 2 ? '.' : '#')).join(''));
  const grid = parse(rows);
  if (door === 'top') for (let x = 4; x < 7; x++) { grid[1]![x] = Cell.Floor; grid[0]![x] = Cell.Floor; }
  if (door === 'left') for (let y = 4; y < 7; y++) { grid[y]![1] = Cell.Floor; grid[y]![0] = Cell.Floor; }
  const rm: Room = { x: 2, y: 2, w, h, type: 'large' };
  const s = spawnAt ?? { cx: 2 + w - 1, cy: 2 + h - 1 };   // спавн — по умолчанию в дальнем углу комнаты (не на наборе)
  const sp = { x: s.cx * TILE + 16, y: s.cy * TILE + 16 };
  return { grid, rooms: [rm], spawn: sp, stairsDown: sp, exits: [sp], decor: [], doors: [], levers: [], chests: [] };
}
const spec = (id: string, x: Partial<DecorSpec> = {}): DecorSpec => ({
  id, footprint: { w: 1, h: 1 }, weight: 1, spawnChance: 1, surface: 'floor', coversFloor: false, blocks: true, blocksSight: false,
  collider: { shape: 'circle', r: 0.3 }, clearance: 0, contexts: ['socket'], passport: { contexts: ['socket'], footprint: { w: 1, h: 1 }, blocks: true, blocksSight: false }, ...x,
});
const SPECS = [
  spec('t_table', { footprint: { w: 2, h: 1 }, collider: { shape: 'box', w: 1.8, h: 0.8 } }),
  spec('t_stool'), spec('t_crate'),
  spec('t_shelf', { footprint: { w: 2, h: 1 }, collider: { shape: 'box', w: 2, h: 0.4 }, passport: { contexts: ['socket'], footprint: { w: 2, h: 1 }, blocks: true, blocksSight: true, tall: true } }),
  spec('t_wall9', { collider: { shape: 'box', w: 20, h: 0.3 } }),   // коллайдер на 20 клеток при следе 1 × 1 — режет комнату поперёк (Р6)
];
const SYN_KNOWN = new Map(SPECS.map((s) => [s.id, s]));
const synRow = (id: string, anchor: string, members: object[], extra: object = {}): ArtSetRowLite =>
  ({ id, kind: 'set', group: 'biome_syn', set: { anchor, members, rooms: { large: 1 }, minRoom: 3, perFloorMax: 9, ...extra } as ArtSetRowLite['set'] });
const SYN_ROWS: ArtSetRowLite[] = [
  synRow('s_center', 'center', [{ key: 't_table', x: 0, z: 0, yaw: 0 }, { key: 't_stool', x: -0.6, z: 0.9, yaw: 20, group: 'g' }, { key: 't_stool', x: 0.6, z: -0.9, yaw: -160, group: 'g' }],
    { footprint: { w: 2, h: 3 }, groups: [{ id: 'g', min: 2, max: 2 }] }),
  synRow('s_wall', 'againstWall', [{ key: 't_table', x: 0, z: -0.6, yaw: 0 }, { key: 't_stool', x: 0.5, z: 0.6, yaw: 33 }], { footprint: { w: 2, h: 2 } }),
  synRow('s_corner', 'corner', [{ key: 't_crate', x: -0.5, z: 0, yaw: 10 }, { key: 't_crate', x: 0.5, z: 0, yaw: -5 }, { key: 't_crate', x: 0, z: 0, h: 0.75, yaw: 40, on: 0 }],
    { footprint: { w: 2, h: 1 } }),
  synRow('s_far', 'farWall', [{ key: 't_shelf', x: 0, z: -0.25, yaw: 0 }], { footprint: { w: 2, h: 1 } }),
  synRow('s_tallcenter', 'center', [{ key: 't_shelf', x: 0, z: 0, yaw: 0 }], { footprint: { w: 2, h: 1 } }),
  synRow('s_cut', 'againstWall', [{ key: 't_stool', x: 0, z: 0, yaw: 0 }, { key: 't_wall9', x: 0, z: 0, yaw: 90 }], { footprint: { w: 1, h: 1 } }),
];
const SYN_RULES: PropRules = biomeDressingSchema.parse({
  props: { density: { min: 30, max: 30, perArea: 100 }, emptyRoomShare: 0, sameNotNear: 0, lanes: { width: 1 }, center: { on: false }, againstWall: { on: false },
    corner: { on: false }, doorway: { on: false }, wall: { on: false }, sets: { on: true, chance: 1, perRoom: 1, setIds: [], setLimits: [] } },
}).props!;
function synth(ids: string[], L: DungeonLayout, seed = 7): DungeonLayout {
  const sets = setSpecsFor(SYN_ROWS, 'syn', SPECS, { setIds: ids }).sets;
  placeSlots(L, SYN_RULES, [], seed, { camAzimuthDeg: -45, known: SYN_KNOWN, sets });
  return L;
}
const entry = (L: DungeonLayout) => L.slotLog!.sets!.list;

describe('⭐ 13.10 (Ф4): Р3 на синтетике — якоря, полосы, Р6', () => {
  it('центр: у центра комнаты, кольцо пола вокруг действительного следа, полосы его огибают', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const L = synth(['s_center'], room(11, 9, 'top'), seed);
      const [e] = entry(L);
      expect(e, `сид ${seed}`).toBeDefined();
      const r = L.rooms[0]!;
      expect(Math.hypot(e!.place.cx / TILE - (r.x + r.w / 2), e!.place.cy / TILE - (r.y + r.h / 2))).toBeLessThanOrEqual(0.75);
      for (let y = e!.rect.y0 - 1; y <= e!.rect.y1 + 1; y++) for (let x = e!.rect.x0 - 1; x <= e!.rect.x1 + 1; x++) expect(L.grid[y]![x]).toBe(Cell.Floor);
      const cols = L.grid[0]!.length;
      for (const i of L.lanes!.flatMap((l) => l.cells)) {
        const x = i % cols, y = (i / cols) | 0;
        expect(x >= e!.rect.x0 && x <= e!.rect.x1 && y >= e!.rect.y0 && y <= e!.rect.y1, `полоса в наборе ${x},${y}`).toBe(false);
      }
      expect(L.decor.slice(e!.at, e!.at + e!.idx.length)).toEqual(setMemberRecords(setSpecsFor(SYN_ROWS, 'syn', SPECS).sets.find((s) => s.id === 's_center')!, e!.idx, e!.place));
    }
  });

  it('у стены: задний край полного следа — на линии стены, лицо — в комнату; члены — на авторском расстоянии от линии', () => {
    const s = setSpecsFor(SYN_ROWS, 'syn', SPECS).sets.find((x) => x.id === 's_wall')!;
    let n = 0;
    for (let seed = 1; seed <= 16; seed++) {
      const L = synth(['s_wall'], room(8, 7), seed);
      for (const e of entry(L)) {
        n++;
        const face = { x: Math.round(Math.sin((e.place.q * Math.PI) / 2)), y: Math.round(Math.cos((e.place.q * Math.PI) / 2)) };   // лицо набора
        const fp = setFootprintAt(s, e.place.q);
        // задний край: от центра следа на h/2 против лица; за ним — стена на всю ширину
        const bx = e.place.cx / TILE - face.x * (s.footprint.h / 2), by = e.place.cy / TILE - face.y * (s.footprint.h / 2);
        const along = { x: Math.abs(face.y), y: Math.abs(face.x) };
        for (let k = 0; k < s.footprint.w; k++) {
          const cx = Math.floor(bx - along.x * (fp.w / 2) + along.x * (k + 0.5) - face.x * 0.5), cy = Math.floor(by - along.y * (fp.h / 2) + along.y * (k + 0.5) - face.y * 0.5);
          expect(L.grid[cy]![cx], 'за набором — стена').toBe(Cell.Wall);
        }
        L.decor.slice(e.at, e.at + e.idx.length).forEach((d, i) => {
          const m = s.members[e.idx[i]!]!;
          const dist = (d.x / TILE - bx) * face.x + (d.y / TILE - by) * face.y;
          expect(dist).toBeCloseTo(m.z + s.footprint.h / 2, 9);
        });
      }
    }
    expect(n).toBeGreaterThan(10);
  });

  it('угол: задний край — на одной стене, левый край рамки — на смежной; стоящий сверху — с высотой, без преграды', () => {
    let n = 0;
    for (let seed = 1; seed <= 16; seed++) {
      const L = synth(['s_corner'], room(6, 6), seed);
      for (const e of entry(L)) {
        n++;
        const recs = L.decor.slice(e.at, e.at + e.idx.length);
        const top = recs.find((d) => d.h !== undefined)!;
        expect(top.h).toBe(24);
        expect(obstaclesFromDecor(recs, SYN_KNOWN)).toHaveLength(2);
        // крайний член рамки (x = −0.5) — у смежной стены: соседняя с его клеткой в сторону −x рамки — стена
        const m0 = setOffset(-1, 0, e.place.q, e.place.mirror);
        const c0 = worldToCell(recs[0]!.x, recs[0]!.y);
        expect(L.grid[c0.cy + m0.y]![c0.cx + m0.x], 'левый край рамки — у смежной стены').toBe(Cell.Wall);
        const back = setOffset(0, -1, e.place.q, e.place.mirror);
        expect(L.grid[c0.cy + back.y]![c0.cx + back.x], 'задний край — у стены').toBe(Cell.Wall);
      }
    }
    expect(n).toBeGreaterThan(10);
  });

  it('дальняя стена — только север и восток (азимут −45°); высокий набор в центр — никогда', () => {
    let n = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const L = synth(['s_far'], room(7, 7), seed);
      for (const e of entry(L)) { n++; const f = setOffset(0, 1, e.place.q, false); expect(isFarFace(f.x, f.y, toCam)).toBe(true); }
      expect(entry(synth(['s_tallcenter'], room(9, 9), seed))).toEqual([]);
    }
    expect(n).toBeGreaterThan(10);
  });

  it('Р6 — всё или ничего: набор, член которого режет комнату, откатывается целиком (ни одного члена в декоре)', () => {
    let rejected = 0;
    for (let seed = 1; seed <= 10; seed++) {
      // проём и спавн — у западной стены: полоса — там же, а поперечный коллайдер у восточной части отрезает её (полосу не задевая) — это Р6
      const L = synth(['s_cut'], room(8, 9, 'left', { cx: 2, cy: 9 }), seed);
      rejected += L.slotLog!.sets!.rejected;
      expect(entry(L), `сид ${seed}`).toEqual([]);
      expect(L.decor.filter((d) => d.objectId === 't_stool' || d.objectId === 't_wall9')).toEqual([]);
    }
    expect(rejected, 'Р6 срабатывал').toBeGreaterThan(0);
  });

  it('без наборов (нет строк или правило выключено) — ни бросков, ни поля журнала: раскладка та же', () => {
    const a = room(9, 8, 'top'); placeSlots(a, SYN_RULES, [], 5, { camAzimuthDeg: -45, known: SYN_KNOWN });
    const b = room(9, 8, 'top'); placeSlots(b, { ...SYN_RULES, sets: { ...SYN_RULES.sets!, on: false } }, [], 5, { camAzimuthDeg: -45, known: SYN_KNOWN, sets: setSpecsFor(SYN_ROWS, 'syn', SPECS).sets });
    expect(a.slotLog!.sets).toBeUndefined();
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

describe('⭐ 13.10 (Ф4): живые этажи крипты с наборами крипты', () => {
  const runs = cryptFloors(reg, 120);

  it('детерминизм: те же сиды — те же этажи целиком', () => {
    expect(cryptFloors(withSets(), 12).map((r) => digest(r.L))).toEqual(runs.slice(0, 12).map((r) => digest(r.L)));
  });

  it('записи членов = развёртка журнала (набор, состав, точка, поворот, зеркало); у стены и в угол — стены за следом; дальние — только дальние', () => {
    const per = new Map<string, number>();
    for (const { L, id } of runs) {
      for (const e of L.slotLog!.sets!.list) {
        const s = setById.get(e.id)!;
        per.set(e.id, (per.get(e.id) ?? 0) + 1);
        expect(L.decor.slice(e.at, e.at + e.idx.length), `${id}: ${e.id}`).toEqual(setMemberRecords(s, e.idx, e.place));
        // действительный след — следы записей и клетки под коллайдерами членов радиусом героя (не меньше следов)
        const rr = recordsRect(L.decor.slice(e.at, e.at + e.idx.length));
        expect(e.rect.x0 <= rr.x0 && e.rect.y0 <= rr.y0 && e.rect.x1 >= rr.x1 && e.rect.y1 >= rr.y1, `${id}: ${e.id} след`).toBe(true);
        for (const c of L.chests) { const k = worldToCell(c.x, c.y); expect(k.cx >= e.rect.x0 && k.cx <= e.rect.x1 && k.cy >= e.rect.y0 && k.cy <= e.rect.y1, `${id}: сундук в наборе`).toBe(false); }
        expect(e.idx.length).toBeGreaterThanOrEqual(requiredCount(s));
        const face = setOffset(0, 1, e.place.q, false);
        if (s.anchor !== 'center') {
          const fp = setFootprintAt(s, e.place.q);
          const x0 = e.place.cx / TILE - fp.w / 2, y0 = e.place.cy / TILE - fp.h / 2;
          // клетки полного следа у его заднего края → за ними стена
          for (let k = 0; k < s.footprint.w; k++) {
            const along = { x: Math.abs(face.y), y: Math.abs(face.x) };
            const back = { x: face.x > 0 ? x0 : face.x < 0 ? x0 + fp.w - 1 : x0 + k * along.x, y: face.y > 0 ? y0 : face.y < 0 ? y0 + fp.h - 1 : y0 + k * along.y };
            expect(L.grid[Math.round(back.y - face.y)]![Math.round(back.x - face.x)], `${id}: ${e.id} — за задним краем стена`).toBe(Cell.Wall);
          }
        }
        if (s.anchor === 'farWall' || s.tall) expect(isFarFace(face.x, face.y, toCam), `${id}: ${e.id} у ближней стены`).toBe(true);
      }
    }
    for (const s of SETS) expect(per.get(s.id) ?? 0, `${s.id} не встал ни разу на ${runs.length} этажах`).toBeGreaterThan(0);
  });

  it('лимиты: на этаж — perFloorMax, в комнате — perRoomMax и не больше perRoom наборов; бюджет комнаты — не выше цели', () => {
    const perRoom = crypt.dressing!.props!.sets!.perRoom;
    for (const { L, id } of runs) {
      const list = L.slotLog!.sets!.list;
      for (const s of SETS) {
        const mine = list.filter((e) => e.id === s.id);
        expect(mine.length, `${id}: ${s.id} на этаже`).toBeLessThanOrEqual(s.perFloorMax);
        for (const r of new Set(mine.map((e) => e.room))) expect(mine.filter((e) => e.room === r).length).toBeLessThanOrEqual(s.perRoomMax);
      }
      for (const r of new Set(list.map((e) => e.room))) expect(list.filter((e) => e.room === r).length).toBeLessThanOrEqual(perRoom);
      for (const r of L.slotLog!.rooms) expect(r.placed, `${id}: комната ${r.room}`).toBeLessThanOrEqual(r.target);
    }
  });

  it('полосы и якоря: члены «не запирать проход» на полу — не на полосе; на другом — ни преграды; преград ровно столько, сколько твёрдых на полу', () => {
    for (const { L, obstacles, specs, id } of runs) {
      const by = new Map(specs.map((s) => [s.id, s]));
      const cols = L.grid[0]!.length;
      const lane = new Set((L.lanes ?? []).flatMap((l) => l.cells));
      for (const e of L.slotLog!.sets!.list) for (const d of L.decor.slice(e.at, e.at + e.idx.length)) {
        const s = by.get(d.objectId!)!;
        if (d.h !== undefined || !(s.blocks || s.passport?.keepPath)) continue;
        const r = footprintRect(d);
        for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) expect(lane.has(y * cols + x), `${id}: ${d.objectId} на полосе ${x},${y}`).toBe(false);
      }
      const hard = L.decor.filter((d) => d.kind === 'obj' && d.h === undefined && by.get(d.objectId!)?.blocks).length;
      expect(obstacles.length, id).toBe(hard);
      for (const p of [L.spawn, ...L.exits, ...L.levers, ...L.chests]) {
        const c = worldToCell(p.x, p.y);
        for (const e of L.slotLog!.sets!.list) expect(c.cx >= e.rect.x0 && c.cx <= e.rect.x1 && c.cy >= e.rect.y0 && c.cy <= e.rect.y1, `${id}: якорь в наборе ${e.id}`).toBe(false);
      }
    }
  });

  it('полосы: центр клетки полосы (кроме устья проёма) — не под коллайдером ни одного декора радиусом героя, и с наборами', () => {
    let lanes = 0;
    for (const { L, obstacles, id } of runs) {
      const cols = L.grid[0]!.length;
      const mouth = new Set((L.doorways ?? []).flatMap((d) => d.inner.map((c) => c.cy * cols + c.cx)));
      for (const i of (L.lanes ?? []).flatMap((l) => l.cells)) {
        if (mouth.has(i)) continue;
        lanes++;
        const x = (i % cols) * TILE + 16, y = ((i / cols) | 0) * TILE + 16;
        expect(obstacles.some((o) => segmentHits(o, x, y, x, y, PLAYER_RADIUS)), `${id}: полоса под коллайдером ${i % cols},${(i / cols) | 0}`).toBe(false);
      }
    }
    expect(lanes).toBeGreaterThan(1000);
  });

  it('стулья, табуреты и книги (сокет) — только членами наборов; одиночки того же пропа — не ближе sameNotNear к членам', () => {
    const R = crypt.dressing!.props!.sameNotNear;
    const sockets = new Set(['crypt_wooden_chair_01', 'crypt_wooden_stool_01', 'crypt_books_01']);
    let seats = 0;
    const pt = (d: DecorObject): { x: number; y: number } => { const r = footprintRect(d); return { x: ((r.x0 + r.x1 + 1) / 2) * TILE, y: ((r.y0 + r.y1 + 1) / 2) * TILE }; };
    for (const { L, id } of runs) {
      const member = new Set<DecorObject>();
      for (const e of L.slotLog!.sets!.list) for (const d of L.decor.slice(e.at, e.at + e.idx.length)) member.add(d);
      for (const d of L.decor) if (d.kind === 'obj' && sockets.has(d.objectId!)) { expect(member.has(d), `${id}: ${d.objectId} одиночкой`).toBe(true); seats++; }
      const singles = L.decor.filter((d) => d.kind === 'obj' && !member.has(d) && known.get(d.objectId!)?.contexts && !known.get(d.objectId!)?.passport?.doorway);
      for (const a of singles) for (const b of member) {
        if (a.objectId !== b.objectId) continue;
        const p = pt(a), q = pt(b);
        expect(Math.hypot(p.x - q.x, p.y - q.y), `${id}: ${a.objectId} одиночкой у члена набора`).toBeGreaterThan(R * TILE);
      }
    }
    expect(seats).toBeGreaterThan(50);
  });

  it('Р6 по сводке, 504 этажа: пропы (и члены наборов) не отрезают ни клетки, якоря достижимы; наборы встают', () => {
    const st = decorStats(reg, crypt, { floors: 504, warmup: 0, now: () => 0 });
    expect(st.cut.props).toEqual({ cells: 0, anchors: 0 });
    expect(st.cut.other.anchors).toBe(0);
    expect(st.sets!.perFloor).toBeGreaterThan(3);
    expect(Object.keys(st.sets!.byId).sort()).toEqual(SETS.map((s) => s.id));
    expect(st.sets!.byId['crypt_set_refectory']!.members).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it('без строк наборов в манифесте — крипта байт-в-байт та же, что без правил наборов; правило выключено — тоже', () => {
    const none = cryptFloors(withSets([]), 40).map((r) => digest({ L: r.L, o: r.obstacles }));
    const noRules = cryptFloors(withSets(CRYPT_SETS, noSetRules), 40).map((r) => digest({ L: r.L, o: r.obstacles }));
    const off = cryptFloors(withSets(CRYPT_SETS, (b) => (b.dressing?.props?.sets ? { ...b, dressing: { ...b.dressing, props: { ...b.dressing.props, sets: { ...b.dressing.props.sets, on: false } } } } : b)), 40)
      .map((r) => digest({ L: r.L, o: r.obstacles }));
    expect(noRules).toEqual(none);
    expect(off).toEqual(none);
    expect(runs.slice(0, 40).map((r) => digest({ L: r.L, o: r.obstacles })), 'наборы этажи меняют (намеренно)').not.toEqual(none);
    expect(cryptFloors(withSets([]), 3).every((r) => !('sets' in r.L.slotLog!)), 'журнал без поля наборов').toBe(true);
  });
});

describe('⭐ 13.10 (Ф4): предупреждения наборов (`decorWarnings`)', () => {
  const objects = reg.get('objects');
  const art = (rows: readonly ArtSetRowLite[]): ArtRowLite[] => [...(reg.get('art') as ArtRowLite[]).filter((a) => a.kind !== 'set'), ...(rows as ArtRowLite[])];
  const setMsgs = (w: ReturnType<typeof decorWarnings>): string[] => w.filter((x) => /набор/.test(x.msg)).map((x) => `${x.section}:${x.id}`);

  it('наборы крипты — чисто', () => {
    expect(setMsgs(decorWarnings(objects, art(CRYPT_SETS), reg.get('biomes')))).toEqual([]);
  });

  it('член без объекта, высокий в центр, чужой id в правилах, наборы без правил — предупреждения', () => {
    const bad: ArtSetRowLite[] = [...CRYPT_SETS,
      { id: 'crypt_set_bad', kind: 'set', group: 'biome_crypt', set: { members: [{ key: 'crypt_нет', x: 0, z: 0 }] } },
      { id: 'crypt_set_tallc', kind: 'set', group: 'biome_crypt', set: { anchor: 'center', members: [{ key: 'crypt_wooden_shelf_01', x: 0, z: 0 }] } }];
    const biomes = reg.get('biomes').map((b) => (b.id === 'crypt' ? { ...b, dressing: { ...b.dressing!, props: { ...b.dressing!.props!, sets: { ...b.dressing!.props!.sets!, setIds: ['crypt_set_нет'] } } } } : b));
    expect(setMsgs(decorWarnings(objects, art(bad), biomes))).toEqual(['art:crypt_set_bad', 'art:crypt_set_tallc', 'biomes:crypt']);
    expect(setMsgs(decorWarnings(objects, art(CRYPT_SETS), reg.get('biomes').map(noSetRules)))).toEqual(['biomes:crypt']);
  });
});

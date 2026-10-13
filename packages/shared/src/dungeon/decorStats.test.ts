import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { biomeWithoutPropRules, biomeWithoutSetRules, decorStats, formatDecorStats } from './decorStats.js';

/**
 * ⭐ 12.10 (Ф2 «Слоты и полосы»): сводка декора по сидам (`decorStats`, CLI `npm run decor:stats`) — считается тем же путём сервера, что игра,
 * и сама держит сторож Р6: пропы с паспортом не отрезают ни клетки, якоря достижимы. Выборка маленькая — полная (500 этажей) живёт в CLI.
 */
const reg = new ConfigRegistry();
reg.loadAll();
// ⭐ 13.10 (Ф4): сторожа Ф2 — на манифесте без строк наборов-сценок (сводка наборов — `sets.test.ts`, «наборы в сводке» ниже)
reg.reload({ art: reg.get('art').filter((a) => a.kind !== 'set') });
const crypt = reg.get('biomes').find((b) => b.id === 'crypt')!;
let tick = 0;
const now = (): number => (tick += 1);   // часы теста — детерминированные (время сборки в сводке не судим)

describe('⭐ 12.10 (Ф2): сводка декора по сидам', () => {
  const after = decorStats(reg, crypt, { floors: 24, warmup: 0, now });
  const before = decorStats(reg, crypt, { floors: 24, warmup: 0, now, withoutRules: true });

  it('крипта со слотами: журнал проходов, проёмы, полосы; пропы на комнату в бюджете; стулья и табуреты не стоят (наборы Ф4)', () => {
    expect(after.rules).toBe(true);
    expect(after.floors).toBe(24);
    expect(after.rooms).toBeGreaterThan(100);
    expect(after.passes?.againstWall.placed).toBeGreaterThan(0);
    expect(after.doorways?.perFloor).toBeGreaterThan(5);
    expect(after.laneShare).toBeGreaterThan(0.1);
    expect(after.perRoom.max).toBeLessThanOrEqual(12);
    expect(after.emptyShare).toBeGreaterThan(0.1);
    expect(after.items['crypt_wooden_chair_01'] ?? 0).toBe(0);
    expect(after.items['crypt_wooden_stool_01'] ?? 0).toBe(0);
    expect(after.budget!.placed).toBeLessThanOrEqual(after.budget!.target + 1e-9);
  });

  it('Р6 в сводке: пропы с паспортом не отрезают ни клетки, якоря достижимы (и у прочего декора)', () => {
    expect(after.cut.props).toEqual({ cells: 0, anchors: 0 });
    expect(after.cut.other.anchors).toBe(0);
    expect(before.cut.other.anchors).toBe(0);
  });

  it('«до» — путь Ф1 (биом без правил пропов): ни журнала, ни проёмов, ни полос; те же этажи и комнаты выборки', () => {
    expect(before.rules).toBe(false);
    expect(before.passes).toBeUndefined();
    expect(before.doorways).toBeUndefined();
    expect(before.laneShare).toBeUndefined();
    expect(before.rooms).toBe(after.rooms);
    expect(biomeWithoutPropRules(crypt).dressing?.props).toBeUndefined();
    expect(biomeWithoutPropRules(crypt).dressing?.torch).toEqual(crypt.dressing?.torch);
  });

  it('детерминизм: та же выборка — та же сводка (кроме времени); текст «до → после» собирается', () => {
    const again = decorStats(reg, crypt, { floors: 24, warmup: 0, now });
    expect({ ...again, genMs: 0 }).toEqual({ ...after, genMs: 0 });
    const txt = formatDecorStats(after, before);
    expect(txt).toContain('crypt');
    expect(txt).toContain('→');
    expect(txt).not.toContain('⚠ ОТРЕЗАНО');
  });

  it('биом без правил пропов — сводка без полей слотов', () => {
    const other = reg.get('biomes').find((b) => !b.dressing?.props)!;
    const s = decorStats(reg, other, { floors: 6, warmup: 0, now });
    expect(s.rules).toBe(false);
    expect(s.passes).toBeUndefined();
    expect(s.cut.props.anchors).toBe(0);
  });
});

describe('⭐ 13.10 (Ф4): наборы-сценки в сводке', () => {
  // строки наборов — синтетика (две строки по образцу наборов крипты): живой манифест до выгрузки Unity их не содержит
  const rows = [
    { id: 'crypt_set_storage_t', kind: 'set' as const, group: 'biome_crypt', set: { anchor: 'corner' as const, footprint: { w: 2, h: 1 }, members: [
      { key: 'crypt_wooden_crate_02', x: 0.196, z: -0.093, h: 0, yaw: 75, group: '' }, { key: 'crypt_wooden_crate_02', x: -0.64, z: -0.125, h: 0, yaw: 0, group: '' },
      { key: 'crypt_wooden_crate_02', x: -0.265, z: 0, h: 0.75, yaw: -34.3, group: 'top', on: 1 }], groups: [{ id: 'top', min: 0, max: 1 }], minRoom: 4, perRoomMax: 2, perFloorMax: 4 } },
    { id: 'crypt_set_rubble_t', kind: 'set' as const, group: 'biome_crypt', set: { anchor: 'corner' as const, footprint: { w: 2, h: 2 }, members: [
      { key: 'crypt_stone_01', x: -0.237, z: -0.512, h: 0, yaw: 178.21, group: '' }, { key: 'crypt_stone_01', x: 0.013, z: 0.108, h: 0, yaw: 116.21, group: 'second' }],
      groups: [{ id: 'second', min: 0, max: 1 }], minRoom: 4, perFloorMax: 3 } },
  ];
  const withSets = new ConfigRegistry(); withSets.loadAll();
  withSets.reload({ art: [...withSets.get('art').filter((a) => a.kind !== 'set'), ...rows] });
  const c2 = withSets.get('biomes').find((b) => b.id === 'crypt')!;
  const s = decorStats(withSets, c2, { floors: 24, warmup: 0, now });
  const noSets = decorStats(withSets, c2, { floors: 24, warmup: 0, now, withoutSets: true });

  it('наборы на этаж, по id — на этаж и членов в наборе, доля комнат с набором; «до» (без правил наборов) — без поля; Р6 чист', () => {
    expect(s.sets!.perFloor).toBeGreaterThan(0.5);
    expect(Object.keys(s.sets!.byId).sort()).toEqual(['crypt_set_rubble_t', 'crypt_set_storage_t']);
    expect(s.sets!.byId['crypt_set_storage_t']!.members).toBeGreaterThanOrEqual(2);
    expect(s.sets!.roomShare).toBeGreaterThan(0); expect(s.sets!.roomShare).toBeLessThan(1);
    expect(noSets.sets).toBeUndefined();
    expect(biomeWithoutSetRules(c2).dressing?.props?.sets).toBeUndefined();
    expect(biomeWithoutSetRules(c2).dressing?.props?.density).toEqual(c2.dressing?.props?.density);
    expect(s.cut.props).toEqual({ cells: 0, anchors: 0 });
    expect(s.rooms).toBe(noSets.rooms);
    const txt = formatDecorStats(s, noSets);
    expect(txt).toContain('наборы на этаж');
    expect(txt).toContain('без наборов');
  });

  it('без строк наборов в манифесте правила наборов крипты ничего не меняют: сводка та же, что без правил', () => {
    const plain = decorStats(reg, crypt, { floors: 12, warmup: 0, now });
    const plainNo = decorStats(reg, crypt, { floors: 12, warmup: 0, now, withoutSets: true });
    expect({ ...plain, genMs: 0 }).toEqual({ ...plainNo, genMs: 0 });
  });
});

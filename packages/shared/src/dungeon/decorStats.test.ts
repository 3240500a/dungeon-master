import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { biomeWithoutPropRules, decorStats, formatDecorStats } from './decorStats.js';

/**
 * ⭐ 12.10 (Ф2 «Слоты и полосы»): сводка декора по сидам (`decorStats`, CLI `npm run decor:stats`) — считается тем же путём сервера, что игра,
 * и сама держит сторож Р6: пропы с паспортом не отрезают ни клетки, якоря достижимы. Выборка маленькая — полная (500 этажей) живёт в CLI.
 */
const reg = new ConfigRegistry();
reg.loadAll();
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

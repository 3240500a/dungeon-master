import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { ConfigRegistry, newCharacterSave, type ServerFrame, type RunPlan, type RunNode } from '@dm/shared';

/**
 * E2E (headless) серверного жизненного цикла забега v2 (Ф4.2/4.4). Гоняем реальную `Room`
 * с фейковым ws, читаем ИСХОДЯЩИЕ кадры как чёрный ящик: старт из города → RunPlan → узлы с
 * выходами (контракт exits.length == edges.length) → развилки → финал (портал, 0 выходов) →
 * завершение → город; `save.run` персистится в забеге и очищается на финале. Плюс алтарь:
 * выбор биома/шаблона учитывается, невалидный/выключенный отбрасывается (анти-чит).
 *
 * БД замокана: `db.ts` открывает SQLite (node:sqlite) при импорте — не тащим её в тест (и не
 * трогаем боевую БД дев-сервера); персистентность здесь не проверяется, состояние забега берём
 * из исходящих кадров.
 */
vi.mock('../db/db.js', () => ({
  putCharacter: () => {},
  getCharacter: () => null,
  getAccountStash: () => null,
  putAccountStash: () => {},
}));
type Room = import('./room.js').Room;
let RoomCtor: typeof import('./room.js').Room;
let cfg: ConfigRegistry;

class FakeWs {
  readonly OPEN = 1;
  readyState = 1;
  frames: ServerFrame[] = [];
  send(raw: string): void { this.frames.push(JSON.parse(raw) as ServerFrame); }
  last<T extends ServerFrame['t']>(t: T): Extract<ServerFrame, { t: T }> | undefined {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i]!;
      if (f.t === t) return f as Extract<ServerFrame, { t: T }>;
    }
    return undefined;
  }
}

const rooms: Room[] = [];
let seq = 0;
function makeRoom(): { room: Room; ws: FakeWs; pid: string } {
  const room = new RoomCtor('TEST', cfg, { onEmpty() {}, onGrace() {}, onUngrace() {} });
  rooms.push(room);
  const ws = new FakeWs();
  const save = newCharacterSave(cfg, cfg.get('classes')[0]!.id, 'Hero', `char-${++seq}`);
  const pid = room.addPlayer(ws as unknown as WebSocket, 'user-1', save);
  return { room, ws, pid };
}
const nodeOf = (plan: RunPlan, id: string): RunNode => plan.nodes.find((n) => n.id === id)!;

beforeAll(async () => {
  ({ Room: RoomCtor } = await import('./room.js'));
  cfg = new ConfigRegistry();
  cfg.loadAll();
});

afterEach(() => { for (const r of rooms) r.stop(); rooms.length = 0; });

describe('Room — жизненный цикл забега v2 (сервер, headless)', () => {
  it('старт → выходы по рёбрам → финал → город; exits==edges на каждом шаге, save.run пишется и очищается', () => {
    const { room, ws, pid } = makeRoom();

    // Старт забега из города (соло → голосование проходит сразу).
    room.descend(pid);
    expect(ws.last('runPlan'), 'после старта приходит RunPlan').toBeDefined();
    expect(ws.last('areaChanged')?.floor.area).toBe('dungeon');
    expect(ws.last('saveUpdate')?.save.run, 'в забеге save.run записан').toBeTruthy();

    // Контракт на стартовом узле: число выходов этажа == число исходящих рёбер узла.
    {
      const rp = ws.last('runPlan')!;
      const cur = nodeOf(rp.plan, rp.currentNodeId);
      const area = ws.last('areaChanged')!;
      expect(area.floor.runNodeId).toBe(rp.currentNodeId);
      expect(area.floor.exits?.length ?? 0).toBe(cur.edges.length);
    }

    // Прогон всего графа по первому ребру до финала (0 рёбер), проверяя контракт на каждом узле.
    let guard = 0;
    for (; guard < 40; guard++) {
      const rp = ws.last('runPlan')!;
      const cur = nodeOf(rp.plan, rp.currentNodeId);
      if (cur.edges.length === 0) break; // достигли финала
      const target = cur.edges[0]!.to;
      room.descend(pid, undefined, target);
      const rp2 = ws.last('runPlan')!;
      expect(rp2.currentNodeId, 'спуск по ребру → вошли в целевой узел').toBe(target);
      const a2 = ws.last('areaChanged')!;
      expect(a2.floor.runNodeId).toBe(target);
      expect(a2.floor.exits?.length ?? 0).toBe(nodeOf(rp2.plan, target).edges.length);
    }
    expect(guard, 'граф сошёлся к финалу за разумное число шагов').toBeLessThan(40);

    // Финал: выходов нет, есть портал-декор в город.
    const finArea = ws.last('areaChanged')!;
    expect(finArea.floor.exits?.length ?? 0).toBe(0);
    expect(finArea.floor.decor.some((d) => d.kind === 'portal'), 'финал даёт портал в город').toBe(true);

    // Завершение забега (финал → город + очистка run).
    room.descend(pid);
    expect(ws.last('areaChanged')?.floor.area, 'финиш возвращает в город').toBe('town');
    expect(ws.last('saveUpdate')?.save.run, 'после финиша забег очищен').toBeUndefined();
  });

  it('алтарь: выбранные биом/шаблон учитываются; несуществующие/выключенные отбрасываются (фолбэк)', () => {
    const biomes = cfg.get('biomes').filter((b) => b.enabled !== false);
    const tpls = cfg.get('run-templates').filter((t) => t.enabled !== false);
    expect(biomes.length, 'есть включённые биомы').toBeGreaterThan(0);
    expect(tpls.length, 'есть включённые шаблоны').toBeGreaterThan(0);

    // Берём НЕ первый (если возможно) — чтобы доказать, что выбор реально учтён, а не дефолт.
    const pickBiome = biomes[biomes.length - 1]!;
    const pickTpl = tpls[tpls.length - 1]!;
    {
      const { room, ws, pid } = makeRoom();
      room.descend(pid, 'normal', undefined, { biomeId: pickBiome.id, templateId: pickTpl.id, modifiers: [] });
      const rp = ws.last('runPlan')!;
      expect(rp.plan.biomeId).toBe(pickBiome.id);
      expect(rp.plan.templateId).toBe(pickTpl.id);
    }
    // Мусорный выбор → фолбэк на включённый контент (без падения/мусора в плане).
    {
      const { room, ws, pid } = makeRoom();
      room.descend(pid, 'normal', undefined, { biomeId: 'no-such-biome', templateId: 'no-such-tpl', modifiers: ['bogus'] });
      const rp = ws.last('runPlan')!;
      expect(biomes.some((b) => b.id === rp.plan.biomeId)).toBe(true);
      expect(tpls.some((t) => t.id === rp.plan.templateId)).toBe(true);
    }
  });
});

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { GameConn } from './conn.js';
import { ConfigRegistry, newCharacterSave, type ServerFrame, type RunPlan, type RunNode } from '@dm/shared';

/**
 * E2E (headless) серверного жизненного цикла забега v2 (Ф4.2/4.4). Гоняем реальную `Room`
 * с фейковым ws, читаем ИСХОДЯЩИЕ кадры как чёрный ящик: старт из города → RunPlan → узлы с
 * выходами (контракт exits.length == edges.length) → развилки → финал (портал, 0 выходов) →
 * завершение → город; `save.run` персистится в забеге и очищается на финале. Плюс алтарь:
 * выбор биома/шаблона учитывается, невалидный/выключенный отбрасывается (анти-чит).
 *
 * БД замокана: `db.ts` открывает пул к Postgres при импорте — не тащим базу в юнит-тест (и не
 * трогаем боевую БД дев-сервера); персистентность здесь не проверяется, состояние забега берём
 * из исходящих кадров. Ф2: доступ асинхронный, поэтому мок отдаёт ПРОМИСЫ — синхронный мок
 * молча ломал бы `await` в комнате.
 */
vi.mock('../db/db.js', () => ({
  // Ф0.3: запись сейва возвращает НОВУЮ версию (или null при расхождении). Мок всегда успешен.
  putCharacter: (_c: string, _u: string, _d: unknown, v: number) => Promise.resolve(v + 1),
  putCharacterWithStash: (_c: string, _u: string, _d: unknown, v: number) => Promise.resolve(v + 1),
  createCharacter: () => Promise.resolve(1),
  getCharacter: () => Promise.resolve(null),
  getAccountStash: () => Promise.resolve(null),
  putAccountStash: () => Promise.resolve(),
}));
type Room = import('./room.js').Room;
let RoomCtor: typeof import('./room.js').Room;
let cfg: ConfigRegistry;

class FakeWs implements GameConn {
  open = true;
  readonly ip = '127.0.0.1';
  frames: ServerFrame[] = [];
  /** Двоичные кадры мира (Ф1.4) тесту не нужны — он читает управляющие. */
  send(raw: string | Uint8Array): void { if (typeof raw === 'string') this.frames.push(JSON.parse(raw) as ServerFrame); }
  close(): void { this.open = false; }
  onMessage(): void { /* тест не шлёт кадры вверх — комнату дёргают напрямую */ }
  onClose(): void { /* закрытие в тесте не проверяется */ }
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
  const pid = room.addPlayer(ws as unknown as GameConn, 'user-1', save, 1);
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

  /**
   * БАГ ИЗ ИГРЫ: погиб в забеге, вернулся в город — а реконнект предлагал «продолжить»
   * и высаживал на том же этаже, где убили, со всем живым прогрессом.
   *
   * Корень: возврат после вайпа идёт через `enterTown`, а забег чистил только `finishRun`
   * (финал). Значит `save.run` переживал смерть и персистился со старым узлом.
   */
  it('вАЙП ЗАВЕРШАЕТ ЗАБЕГ: после смерти соло `save.run` пуст, продолжать нечего', () => {
    const { room, ws, pid } = makeRoom();
    room.descend(pid);
    const startId = ws.last('runPlan')!.plan.startId;
    // Спускаемся ГЛУБЖЕ старта — иначе «новый забег начался со старта» ничего не доказывает:
    // погибнув на стартовом узле, мы бы и при НЕИСПРАВЛЕННОМ баге вернулись туда же.
    const firstEdge = nodeOf(ws.last('runPlan')!.plan, startId).edges[0]!.to;
    room.descend(pid, undefined, firstEdge);
    const runBefore = ws.last('saveUpdate')?.save.run;
    expect(runBefore, 'в забеге указатель есть').toBeTruthy();
    const diedAt = runBefore!.currentNodeId;
    expect(diedAt, 'гибнем НЕ на стартовом узле').not.toBe(startId);

    // Убиваем игрока через САМУ СИМУЛЯЦИЮ (смертельный DoT), а не вызовом внутреннего
    // метода: баг был именно в СЦЕПЛЕНИИ «событие смерти → вайп → забег», и проверять
    // надо весь этот путь. Сессия приватная — тянемся через каст, это тест.
    const inner = room as unknown as { session: { world: { players: Record<string, { hp: number; debuffs: Record<string, unknown> }> } } };
    const p = inner.session.world.players[pid]!;
    p.hp = 1;
    p.debuffs.poison = { stacks: 1, maxStacks: 1, expiresAt: Date.now() + 60_000, mag: 9999, mag2: 0 };

    for (let i = 0; i < 20 && !ws.last('died'); i++) room.step(false);
    expect(ws.last('died'), 'игрок действительно погиб').toBeDefined();
    expect(ws.last('died')!.toTown, 'соло = вайп → возврат в город').toBe(true);

    // ГЛАВНОЕ: указатель забега снят СРАЗУ на вайпе, а не когда-нибудь потом —
    // именно этот сейв уйдảт в БД автосейвом и его же прочитает реконнект.
    expect(ws.last('saveUpdate')?.save.run, 'после вайпа забег окончен').toBeUndefined();

    // И следующий спуск начинает НОВЫЙ забег с начала, а не возвращает на этаж гибели.
    room.step(false);                       // доводим таймер окна смерти до города
    (room as unknown as { wipeAt: number }).wipeAt = 1;   // не ждём 4 секунды реального времени
    room.step(false);
    expect(ws.last('areaChanged')?.floor.area, 'вайп уводит в город').toBe('town');
    room.descend(pid);
    const rp = ws.last('runPlan')!;
    expect(rp.currentNodeId, 'новый забег — со стартового узла').toBe(rp.plan.startId);
    expect(rp.currentNodeId, 'и ТОЧНО не с этажа, где убили').not.toBe(diedAt);
  });

  /**
   * Соседняя болезнь того же бага. Модалка «Продолжить/Завершить» считала забег идущим по
   * САМОМУ ФАКТУ живой грейс-комнаты, а комната живёт и когда игрок просто стоит в городе.
   * Забег идёт ровно пока жив план — это и спрашивает `roomManager` через `inRun`.
   */
  it('inRun честно говорит, идёт ли забег: город → нет, забег → да, после вайпа → нет', () => {
    const { room, ws, pid } = makeRoom();
    expect(room.inRun, 'в городе до старта продолжать нечего').toBe(false);

    room.descend(pid);
    expect(room.inRun, 'в забеге — есть').toBe(true);

    // Выход в город ПОСРЕДИ забега его НЕ завершает: туда ходят за покупками и возвращаются.
    room.returnTown(pid);
    expect(ws.last('areaChanged')?.floor.area).toBe('town');
    expect(room.inRun, 'выход в город — не конец забега').toBe(true);
    expect(ws.last('saveUpdate')?.save.run, 'указатель цел — есть куда вернуться').toBeTruthy();

    // А вот гибель — конец.
    room.descend(pid);
    const inner = room as unknown as { session: { world: { players: Record<string, { hp: number; debuffs: Record<string, unknown> }> } } };
    const p = inner.session.world.players[pid]!;
    p.hp = 1;
    p.debuffs.poison = { stacks: 1, maxStacks: 1, expiresAt: Date.now() + 60_000, mag: 9999, mag2: 0 };
    for (let i = 0; i < 20 && !ws.last('died'); i++) room.step(false);
    expect(ws.last('died'), 'игрок погиб').toBeDefined();
    expect(room.inRun, 'после вайпа продолжать нечего — модалка не должна появляться').toBe(false);
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

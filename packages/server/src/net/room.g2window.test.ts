import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { ConfigRegistry, defaultRunConfig, newCharacterSave, type SaveState, type RunPlan, type RunConfig, type ServerFrame } from '@dm/shared';
// ⚠ Подпись выхода — та, что увидит игрок (`exitLabel`, ⭐ С1: в `@dm/shared`, её читают сервер и клиенты), а не то, что лежит в плане.
import { exitLabel } from '@dm/shared';

// Двадцать этажей — это двадцать настоящих генераций этажа и заселений; умолчание 5 с тут лотерея.
vi.setConfig({ testTimeout: 60_000 });

/**
 * ⭐⭐ 13.10 (Г2): ОКНО ПЛАНА СКОЛЬЗИТ ЗА УЗЛОМ — СТОРОЖ SEE-AHEAD НА РАЗВИЛКЕ (C-10).
 *
 * Комната держит в `runPlan` не весь граф (спуск бесконечен), а ОКНО слоёв: текущий плюс `lookahead` вперёд. Пересобирала
 * она его ТОЛЬКО когда узла в окне нет, — и каждый (lookahead+1)-й этаж окно кончалось РОВНО на том узле, где стоит пати:
 * заглядывания вперёд 0 слоёв. Подпись выхода берёт тип целевого узла из плана (`client/modules/run/runExits.ts`:
 * `plan.nodes.find` за краем окна даёт undefined → фолбэк «Спуститься глубже»), поэтому на каждом третьем этаже ВСЕ ветки
 * развилки подписывались одинаково — ветка выбиралась вслепую, ровно беда C-10, против которой see-ahead и сделан.
 * Замер до правки: «этажей с нулевым заглядыванием вперёд: 4 из 14».
 *
 * Сторожим на НАСТОЯЩЕЙ `Room` и по КАДРУ, который уходит клиенту (`runPlan`, уже без сидов — `clientPlan`): предмет —
 * связка «окно сервера → подпись клиента», а не каждая половина по отдельности.
 *
 * ⚠ ОБРАТНАЯ СТОРОНА ТОЙ ЖЕ ПРАВКИ: окно обязано и КОНЧАТЬСЯ. Если бы доращивание только добавляло слои, кадр `runPlan`
 * рос бы на узел за этаж (а вверх дороги нет, R4-04) — поэтому слои за спиной отбрасываются, и число слоёв в плане стоит
 * на месте. Это тоже здесь.
 *
 * База замокана: `db.ts` открывает пул к Postgres при импорте.
 */
const db = vi.hoisted(() => ({ versions: new Map<string, number>(), data: new Map<string, unknown>() }));
vi.mock('../db/db.js', () => ({
  putCharacter: async (charId: string, _u: string, data: SaveState, version: number) => {
    if (version !== (db.versions.get(charId) ?? 1)) return null;
    db.versions.set(charId, version + 1); db.data.set(charId, structuredClone(data));
    return version + 1;
  },
  putCharacterOwned: async () => null,
  putCharacterWithStash: async () => ({ ok: false, conflict: 'stash' }),
  getCharacter: async () => null,
  getAccountStash: async () => null,
  putAccountStash: () => Promise.resolve(),
  getRunLedger: async () => [],
  mergeRunLedger: () => Promise.resolve(),
  landedVersion: async () => null,
}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));

type RoomIn = {
  area: string; runNodeId: string | null; runPlan: RunPlan | null; runConfig: RunConfig | null;
  addPlayer(ws: unknown, userId: string, save: SaveState, version: number): string;
  descend(pid: string): void;
  enterNode(nodeId: string): void;
  stop(): void;
};
let RoomCtor: new (code: string, cfg: ConfigRegistry, hooks: object) => RoomIn;
let planOf: (reg: ConfigRegistry, run: RunConfig, window?: { from: number; to: number }) => RunPlan;
let cfg: ConfigRegistry;
beforeAll(async () => {
  const mod = (await import('./room.js')) as unknown as { Room: typeof RoomCtor; runPlanOf: typeof planOf };
  RoomCtor = mod.Room; planOf = mod.runPlanOf;
  cfg = new ConfigRegistry();
  cfg.loadAll();
});
const rooms: RoomIn[] = [];
afterEach(() => { for (const r of rooms.splice(0)) r.stop(); });

/** Кадры комнаты как их видит клиент: управляющие — текстом (двоичный мир сторожу не нужен). */
class FakeWs {
  open = true; readonly ip = '127.0.0.1';
  frames: ServerFrame[] = [];
  send(raw: string | Uint8Array): void { if (typeof raw === 'string') this.frames.push(JSON.parse(raw) as ServerFrame); }
  close(): void { this.open = false; } onMessage(): void {} onClose(): void {}
  lastPlan(): Extract<ServerFrame, { t: 'runPlan' }> {
    for (let i = this.frames.length - 1; i >= 0; i--) { const f = this.frames[i]!; if (f.t === 'runPlan') return f; }
    throw new Error('кадра `runPlan` не было');
  }
}

/** Фолбэк подписи — ровно то, что игрок видел на каждом третьем этаже вместо типа цели. */
const FALLBACK = 'Спуститься глубже (голосование)';

describe('⭐⭐ Г2: окно плана скользит за узлом (see-ahead живёт на КАЖДОМ этаже)', () => {
  it('20 этажей подряд: вперёд всегда `lookahead` слоёв, подписи выходов развилки несут ТИП цели, план не растёт', () => {
    const room = new RoomCtor('G2WIN', cfg, { onEmpty: () => {}, onGrace: () => {}, onUngrace: () => {} });
    rooms.push(room);
    const charId = 'char-g2win';
    const save = newCharacterSave(cfg, 'warrior', 'Ahead', charId);
    save.level = 20;
    db.versions.set(charId, 1); db.data.set(charId, structuredClone(save));
    const ws = new FakeWs();
    const pid = room.addPlayer(ws as never, `user-${charId}`, save, 1);
    room.descend(pid);   // соло → голосование проходит сразу
    expect(room.area, 'в подземелье').toBe('dungeon');

    const lookahead = Math.max(1, cfg.get('balance').dungeonAccess.lookahead);
    const rows: { depth: number; ahead: number; layers: number; edges: number; labels: string }[] = [];
    let forks = 0, blind = 0;
    for (let i = 0; i < 20; i++) {
      const frame = ws.lastPlan();
      const cur = frame.plan.nodes.find((n) => n.id === frame.currentNodeId)!;
      expect(cur, `узел ${frame.currentNodeId} есть в кадре плана`).toBeTruthy();
      const depths = frame.plan.nodes.map((n) => n.depth);
      const ahead = Math.max(...depths) - cur.depth;
      const layers = new Set(depths).size;
      const labels = cur.edges.map((_, k) => exitLabel(frame.plan, frame.currentNodeId, k));
      rows.push({ depth: cur.depth, ahead, layers, edges: cur.edges.length, labels: labels.join(' / ') });

      // ⭐ ЗАГЛЯДЫВАНИЕ ВПЕРЁД — НА КАЖДОМ ЭТАЖЕ: прежде на каждом (lookahead+1)-м оно было нулевым.
      expect(ahead, `этаж ${cur.depth}: слоёв вперёд`).toBe(lookahead);
      // ⭐ И ОКНО КОНЧАЕТСЯ: слоёв в плане ровно окно (иначе кадр рос бы на узел за этаж).
      expect(layers, `этаж ${cur.depth}: слоёв в плане`).toBe(lookahead + 1);
      // ⭐ ПОДПИСИ РАЗВИЛКИ — ТИП ЦЕЛИ, А НЕ ФОЛБЭК.
      expect(cur.edges.length, `этаж ${cur.depth}: выходы есть (спуск не кончается)`).toBeGreaterThan(0);
      if (cur.edges.length > 1) {
        forks++;
        for (const l of labels) {
          if (l === FALLBACK) blind++;
          expect(l, `этаж ${cur.depth}: подпись выхода развилки`).toMatch(/^Спуститься: /);
        }
      }
      room.enterNode(cur.edges[0]!.to);
    }

    console.log([
      '⭐⭐ Г2: скользящее окно плана (настоящая Room, кадр `runPlan` как у клиента)',
      ' этаж | вперёд | слоёв | рёбер | подписи выходов',
      '------+--------+-------+-------+----------------',
      ...rows.map((r) => ` ${String(r.depth).padStart(4)} | ${String(r.ahead).padStart(6)} | ${String(r.layers).padStart(5)} | ${String(r.edges).padStart(5)} | ${r.labels}`),
      `развилок на 20 этажах: ${forks}; из них вслепую (фолбэк): ${blind}; lookahead = ${lookahead}`,
    ].join('\n'));
    expect(forks, 'развилок на 20 этажах не нашлось — сторож проверял бы пустоту').toBeGreaterThan(0);
    expect(blind, 'ветка развилки подписана вслепую').toBe(0);
  });

  it('⭐ цена доращивания слоя не зависит от глубины (замер на 1 и на 500 000)', () => {
    const run = defaultRunConfig(cfg, 12345);
    const ms = (from: number): number => {
      const t = performance.now();
      for (let i = 0; i < 200; i++) planOf(cfg, run, { from: from + i, to: from + i });
      return (performance.now() - t) / 200;
    };
    ms(1);   // прогрев: первый прогон платит за разбор и подбор этажей
    const shallow = ms(1), deep = ms(500_000);
    console.log(`цена одного слоя: глубина 1 — ${shallow.toFixed(3)} мс, глубина 500 000 — ${deep.toFixed(3)} мс`);
    // Сид слоя — от ГЛУБИНЫ (Р1), поэтому слой 500 000 стоит столько же, сколько первый: это и есть корень
    // бесконечного спуска, и доращивать окно каждый этаж поэтому не дорого.
    expect(deep, 'глубокий слой стал дороже мелкого — сид слоя снова зависит от порядка').toBeLessThan(shallow * 3 + 0.5);
  });
});

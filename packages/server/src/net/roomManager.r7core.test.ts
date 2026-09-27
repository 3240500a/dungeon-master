import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { GameConn } from './conn.js';
import { ConfigRegistry, createRng, generateItem, newCharacterSave, type ServerFrame, type SaveState, type Item } from '@dm/shared';
import { limits } from './rateLimit.js';

// Тесты ждут менеджер оборотами цикла (`settle` — setTimeout(0)), а на Windows каждый оборот — шаг системного таймера
// (~15,6 мс). Под нагрузкой полного прогона умолчание 5 с — лотерея; гонки этот потолок не прячет.
vi.setConfig({ testTimeout: 20_000 });

/**
 * Раунд 7 (ядро), граница менеджера комнат: взгляд с провода приводится до комнаты (R7-01), сломанный уник старого сейва
 * входит целым (R7-19). База — маленькая честная (версии сейва), у героя свой аккаунт и токен.
 */
const db = vi.hoisted(() => ({
  chars: new Map<string, { userId: string; data: unknown; version: number }>(),
  sessions: new Map<string, string>(),
}));
vi.mock('../db/db.js', () => ({
  // R9-01: свод записей забегов в базе (`run_ledger`) — пустой; комнаты пишут в него, вход читает.
  getRunLedger: () => Promise.resolve([]),
  mergeRunLedger: () => Promise.resolve(),
  getSession: async (token: string) => db.sessions.get(token) ?? null,
  getCharacter: async (charId: string) => {
    const r = db.chars.get(charId);
    return r ? { userId: r.userId, data: structuredClone(r.data), version: r.version } : null;
  },
  putCharacter: async (charId: string, _u: string, data: unknown, v: number) => {
    const r = db.chars.get(charId);
    if (!r || v !== r.version) return null;
    r.version = v + 1; r.data = structuredClone(data);
    return r.version;
  },
  putCharacterWithStash: async () => ({ ok: false, conflict: 'stash' }),
  getAccountStash: () => Promise.resolve(null),
  putAccountStash: () => Promise.resolve(),
}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));
vi.mock('../cluster/registry.js', () => ({
  releaseChar: () => Promise.resolve(),
  claimForJoin: (_c: string, node: string) => Promise.resolve(node),
  claimOwner: () => Promise.resolve(process.env.DM_NODE_ID ?? 'node-0'),
}));
vi.mock('../cluster/node.js', () => ({ isDraining: () => false }));

let RM: typeof import('./roomManager.js').RoomManager;
let rm: InstanceType<typeof RM>;
let cfg: ConfigRegistry;
const tok = (userId: string): string => createHash('sha256').update(userId).digest('hex');

class FakeConn implements GameConn {
  open = true;
  readonly ip = '127.0.0.1';
  frames: ServerFrame[] = [];
  private onMsg: (raw: string) => void = () => {};
  private onEnd: () => void = () => {};
  send(raw: string | Uint8Array): void { if (typeof raw === 'string') this.frames.push(JSON.parse(raw) as ServerFrame); }
  close(): void { if (!this.open) return; this.open = false; this.onEnd(); }
  onMessage(cb: (raw: string) => void): void { this.onMsg = cb; }
  onClose(cb: () => void): void { this.onEnd = cb; }
  push(frame: unknown): void { this.onMsg(JSON.stringify(frame)); }
  last<T extends ServerFrame['t']>(t: T): Extract<ServerFrame, { t: T }> | undefined {
    for (let i = this.frames.length - 1; i >= 0; i--) if (this.frames[i]!.t === t) return this.frames[i] as Extract<ServerFrame, { t: T }>;
    return undefined;
  }
}
const settle = async (n = 10): Promise<void> => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
type RoomIn = { stop(): void; clients: Map<string, { input: { facing: number } }> };
const rooms = (): RoomIn[] => [...(rm as unknown as { rooms: Map<string, RoomIn> }).rooms.values()];

let seq = 0;
function seedChar(prefix: string, patch?: (s: SaveState) => void): { charId: string; token: string } {
  const charId = `${prefix}-${++seq}`;
  const userId = `user-${charId}`;
  const save = newCharacterSave(cfg, cfg.get('classes')[0]!.id, prefix, charId);
  patch?.(save);
  db.chars.set(charId, { userId, data: save, version: 1 });
  db.sessions.set(tok(userId), userId);
  for (const l of [limits.roomJoin, limits.roomCreate, limits.lobby, limits.townCmd, limits.forgeCmd, limits.cmdResync]) l.reset(userId);
  return { charId, token: tok(userId) };
}
async function joined(h: { charId: string; token: string }): Promise<FakeConn> {
  const ws = new FakeConn();
  rm.handleConnection(ws);
  ws.push({ t: 'join', token: h.token, charId: h.charId, fresh: true });
  await settle();
  expect(ws.last('joined'), `${h.charId} вошёл: ${JSON.stringify(ws.last('error'))}`).toBeDefined();
  return ws;
}

beforeAll(async () => {
  ({ RoomManager: RM } = await import('./roomManager.js'));
  cfg = new ConfigRegistry();
  cfg.loadAll();
  // Без фоновой дописи по таймеру (R3-19): интервал — на поддельных часах, и с ними же пропадает.
  vi.useFakeTimers({ toFake: ['setInterval'] });
  try { rm = new RM(cfg); } finally { vi.useRealTimers(); }
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => { for (const r of rooms()) r.stop(); });

describe('⭐ R7-01: взгляд с провода приводится до комнаты', () => {
  it('кадр ввода с facing 1e17 — в комнату приходит угол в [−π, π] того же направления', async () => {
    const h = seedChar('r701');
    const ws = await joined(h);
    const pid = ws.last('joined')!.playerId;
    ws.push({ t: 'input', seq: 1, input: { move: { x: 0, y: 0 }, facing: 1e17, attack: true, cast: null, interact: false } });
    const c = rooms().map((r) => r.clients.get(pid)).find(Boolean)!;
    expect(c, 'герой в комнате').toBeDefined();
    expect(c.input.facing, 'было: 1e17 как есть — взмах по кругу 360°').toBe(Math.atan2(Math.sin(1e17), Math.cos(1e17)));
    ws.close();
    await settle();
  });
});

describe('⭐ R7-19: сломанный уник старого сейва входит целым', () => {
  it('вход героя: уник в сумке — без «сломано», прочий сломанный трофей — как был', async () => {
    const mk = (rarity: 'unique' | 'rare', seed: number): Item => ({
      ...generateItem(cfg.get('items.base'), cfg.get('affixes'), cfg.get('uniques'), {
        dropBias: 1, itemLevel: 20, baseId: 'short-sword', tiers: cfg.get('item-tiers'), rarities: cfg.get('rarities'), forceRarity: rarity,
        maxReqTotal: cfg.get('balance').maxTotalRequirement, origin: 'drop',
      }, createRng(seed)),
      broken: true, pos: { x: 4 + seed, y: 0 },
    });
    const u = mk('unique', 1), r = mk('rare', 2);
    const h = seedChar('r719', (s) => { s.inventory.push(u, r); });
    const ws = await joined(h);
    const inv = ws.last('joined')!.save.inventory;
    expect(inv.find((i) => i.uid === u.uid)?.broken, 'уник цел').toBeUndefined();
    expect(inv.find((i) => i.uid === r.uid)?.broken, 'редкий трофей — решение игрока').toBe(true);
    ws.close();
    await settle();
  });
});

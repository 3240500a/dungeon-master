import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { GameConn } from './conn.js';
import { ConfigRegistry, newCharacterSave, type ServerFrame, type SaveState } from '@dm/shared';
import { limits } from './rateLimit.js';

// Тест ждёт менеджер оборотами цикла; под нагрузкой полного прогона умолчание 5 с — лотерея. Гонку этот потолок не прячет —
// её держат ворота теста (`ledgerGate`, ожидание версии строки), а не время.
vi.setConfig({ testTimeout: 60_000 });

/**
 * ⭐ R10-05, граница менеджера комнат: прощальная запись, НАЧАТАЯ И ЗАКОНЧЕННАЯ, пока «Продолжить» ждал базу, — не проходит мимо
 * проверки R5-10. `finishRun` пишет копию отключённого напарника (`onFarewell`) и из грейса его не снимает; раньше `farewellMoved`
 * видел только запись в полёте или смену грейса, и вход собирал сессию из копии ДО финала. База — маленькая честная (версии
 * сейва), запись идёт «круг базы» (несколько мс), чтение свода забега держат ворота теста. Оба героя — одного аккаунта.
 */
const db = vi.hoisted(() => ({
  chars: new Map<string, { data: unknown; version: number }>(),
  /** Чтение свода забега ждёт, пока тест не откроет ворота (вход «Продолжить» стоит в `foldRunLedger`). */
  ledgerGate: null as Promise<void> | null,
  /** Вход дошёл до чтения свода — сейв он уже прочитал. */
  ledgerAsked: null as (() => void) | null,
  log: [] as string[],
}));
vi.mock('../db/db.js', () => ({
  getRunLedger: async () => {
    db.ledgerAsked?.();
    if (db.ledgerGate) await db.ledgerGate;
    return [];
  },
  mergeRunLedger: () => Promise.resolve(),
  getSession: async () => 'user-r10rm',
  getCharacter: async (charId: string) => {
    const r = db.chars.get(charId);
    return r ? { userId: 'user-r10rm', data: structuredClone(r.data), version: r.version } : null;
  },
  putCharacter: async (charId: string, _u: string, data: unknown, v: number) => {
    const snap = structuredClone(data);
    await new Promise((res) => setTimeout(res, 3));   // круг базы
    const r = db.chars.get(charId);
    if (!r || v !== r.version) { db.log.push(`${charId} v${v} CONFLICT`); return null; }
    r.version = v + 1; r.data = snap;
    db.log.push(`${charId} v${v}->v${r.version}`);
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

const TOK = 'ab'.repeat(32);
class FakeConn implements GameConn {
  open = true;
  frames: ServerFrame[] = [];
  closedWith?: number;
  private onMsg: (raw: string) => void = () => {};
  private onEnd: () => void = () => {};
  constructor(readonly ip = '127.0.0.1') {}
  send(raw: string | Uint8Array): void { if (typeof raw === 'string') this.frames.push(JSON.parse(raw) as ServerFrame); }
  close(code?: number): void { if (!this.open) return; this.open = false; this.closedWith = code; this.onEnd(); }
  onMessage(cb: (raw: string) => void): void { this.onMsg = cb; }
  onClose(cb: () => void): void { this.onEnd = cb; }
  push(frame: unknown): void { this.onMsg(JSON.stringify(frame)); }
  last<T extends ServerFrame['t']>(t: T): Extract<ServerFrame, { t: T }> | undefined {
    for (let i = this.frames.length - 1; i >= 0; i--) if (this.frames[i]!.t === t) return this.frames[i] as Extract<ServerFrame, { t: T }>;
    return undefined;
  }
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
/** Ждать условия оборотами цикла (не часами): записи мока идут кругами по несколько мс. */
async function until(what: string, ok: () => boolean, turns = 2_000): Promise<void> {
  for (let i = 0; i < turns; i++) { if (ok()) return; await tick(); }
  throw new Error(`не дождались: ${what}`);
}

type RoomIn = {
  code: string; area: string; stop(): void; finishRun(): void;
  session: { world: { drops: { id: number; item?: { uid: string } }[] } };
};
type RMIn = { rooms: Map<string, RoomIn>; graceByChar: Map<string, RoomIn>; inflight: Map<string, unknown> };
let rm: InstanceType<typeof import('./roomManager.js').RoomManager>;
let cfg: ConfigRegistry;
const mgr = (): RMIn => rm as unknown as RMIn;
beforeAll(async () => {
  const { RoomManager } = await import('./roomManager.js');
  cfg = new ConfigRegistry();
  cfg.loadAll();
  vi.useFakeTimers({ toFake: ['setInterval'] });   // без фоновой дописи копий по таймеру (R3-19)
  try { rm = new RoomManager(cfg); } finally { vi.useRealTimers(); }
});
afterAll(() => { for (const r of mgr().rooms.values()) r.stop(); });

function seed(id: string, patch?: (s: SaveState) => void): void {
  const s = newCharacterSave(cfg, cfg.get('classes')[0]!.id, id, id) as SaveState;
  patch?.(s);
  db.chars.set(id, { data: s, version: 1 });
}
const uidsOf = (s: SaveState): string[] => [
  ...Object.values(s.equipment).filter(Boolean).map((i) => i!.uid), ...s.inventory.map((i) => i.uid), ...s.belt.filter(Boolean).map((i) => i!.uid),
];
let ipSeq = 0;
function conn(): FakeConn { const ws = new FakeConn(`198.51.100.${++ipSeq}`); rm.handleConnection(ws); return ws; }

describe('⭐ R10-05: прощальная запись финала, легшая внутри ожидания «Продолжить», — вход «сохраняем, повторите»', () => {
  it('H в грейсе; «Продолжить» H ждёт свод, пати тем временем завершает забег (копия H записана) — вход не собирается из старой копии, дюпа нет', async () => {
    for (const l of [limits.roomJoin, limits.roomCreate, limits.lobby, limits.lobbyConn, limits.townCmd, limits.cmdResync]) l.reset('user-r10rm');
    let dupUid = '';
    seed('R10H', (s) => { const w = s.equipment.weapon!; delete s.equipment.weapon; w.pos = { x: 0, y: 0 }; s.inventory.push(w); dupUid = w.uid; });
    seed('R10P');
    const wsP = conn();
    wsP.push({ t: 'join', token: TOK, charId: 'R10P', fresh: true });
    await until('P вошёл', () => !!wsP.last('joined'));
    const code = wsP.last('joined')!.roomCode;
    const wsH = conn();
    wsH.push({ t: 'join', token: TOK, charId: 'R10H', roomCode: code });
    await until('H вошёл', () => !!wsH.last('joined'));
    const room = mgr().rooms.get(code)!;
    wsP.push({ t: 'descend' });
    await until('голосование', () => !!wsH.last('voteStart'));
    wsH.push({ t: 'vote', accept: true });
    await until('спуск', () => room.area === 'dungeon');
    // H закрыл вкладку посреди забега — грейс в этой комнате; прощальная запись легла.
    wsH.close();
    await until('грейс H и его прощальная запись', () => mgr().graceByChar.get('R10H') === room && !mgr().inflight.has('R10H'));
    const v = db.chars.get('R10H')!.version;
    expect((db.chars.get('R10H')!.data as SaveState).run, 'забег H в базе').toBeTruthy();

    // «Продолжить» H — и кадр сразу за ним (кадры после `join` ждут его конца).
    let open!: () => void;
    db.ledgerGate = new Promise<void>((r) => { open = r; });
    const asked = new Promise<void>((r) => { db.ledgerAsked = r; });
    const ws2 = conn();
    ws2.push({ t: 'join', token: TOK, charId: 'R10H', resume: true });
    ws2.push({ t: 'cmd', command: { cmd: 'drop', uid: dupUid }, id: 1 });
    await asked;                                              // вход прочитал сейв H (версия v) и ждёт свод
    db.ledgerAsked = null;
    // Пати завершает забег: копия H пишется со снятым забегом (`onFarewell`), грейс H НЕ снимается.
    room.finishRun();
    await until('запись финала легла', () => db.chars.get('R10H')!.version === v + 1 && !mgr().inflight.has('R10H'));
    expect(mgr().graceByChar.get('R10H'), 'финал грейс не снимает').toBe(room);

    db.ledgerGate = null;
    open();
    await until('ответ входу', () => !!ws2.last('joined') || !!ws2.last('error'));
    expect(ws2.last('joined'), 'вход из копии до финала не собран').toBeUndefined();
    expect(ws2.last('error')?.code, '«сохраняем, повторите»').toBe('busy');
    for (let i = 0; i < 20; i++) await tick();   // кадр `cmd` за входом разобран (соединению без сессии он ничего не делает)
    expect(room.session.world.drops.some((d) => d.item?.uid === dupUid), 'выброса старой копией нет').toBe(false);

    // Повтор входа — уже из базы, где забег снят: вещь у H одна.
    const ws3 = conn();
    ws3.push({ t: 'join', token: TOK, charId: 'R10H', resume: true });
    await until('ответ повтору', () => !!ws3.last('joined') || !!ws3.last('error'));
    wsP.close();
    await until('записи легли', () => !mgr().inflight.has('R10P') && !mgr().inflight.has('R10H'));
    const hRow = db.chars.get('R10H')!.data as SaveState;
    const pRow = db.chars.get('R10P')!.data as SaveState;
    expect(uidsOf(hRow).includes(dupUid) && uidsOf(pRow).includes(dupUid), `вещь у двоих: ${db.log.slice(-6).join(' | ')}`).toBe(false);
    expect(hRow.run, 'забег H снят финалом').toBeUndefined();
  });
});

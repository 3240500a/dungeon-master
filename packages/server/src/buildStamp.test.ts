import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigRegistry, buildStampOf, newCharacterSave, type SaveState, type AccountStash, type ServerFrame } from '@dm/shared';
import type { GameConn } from './net/conn.js';
import { serverBuild } from './buildStamp.js';

/**
 * ⭐ R18-08: ШТАМП СБОРКИ СЕРВЕРА — тот же, что `vite build` вписывает в бандл вкладки (`client/vite.config.ts` → `__DM_BUILD__`), и едет в
 * кадре `joined`. Разойдись они на одних исходниках — каждая вкладка слышала бы «перезагрузите» после каждого входа; не доедь штамп в кадр —
 * вкладка, пережившая деплой со старым кодом цен, снова кликала бы в «Цена изменилась» молча.
 */
vi.mock('./db/db.js', () => ({
  getRunLedger: () => Promise.resolve([]),
  mergeRunLedger: () => Promise.resolve(),
  putCharacter: (_c: string, _u: string, _d: SaveState, v: number) => Promise.resolve(v + 1),
  putCharacterWithStash: (_c: string, _u: string, _d: SaveState, v: number, _s: AccountStash, sv: number) =>
    Promise.resolve({ ok: true, version: v + 1, stashVersion: sv + 1 }),
  createCharacter: () => Promise.resolve(1),
  getCharacter: () => Promise.resolve(null),
  getAccountStash: () => Promise.resolve(null),
  putAccountStash: () => Promise.resolve(),
  landedVersion: () => Promise.resolve(null),
}));
vi.mock('./db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));

const HERE = dirname(fileURLToPath(import.meta.url));

class FakeWs implements GameConn {
  open = true;
  readonly ip = '127.0.0.1';
  frames: ServerFrame[] = [];
  send(raw: string | Uint8Array): void { if (typeof raw === 'string') this.frames.push(JSON.parse(raw) as ServerFrame); }
  close(): void { this.open = false; }
  onMessage(): void { /* комнату дёргают напрямую */ }
  onClose(): void { /* не проверяется */ }
}

type Room = import('./net/room.js').Room;
let RoomCtor: typeof import('./net/room.js').Room;
let cfg: ConfigRegistry;
const rooms: Room[] = [];
beforeAll(async () => {
  ({ Room: RoomCtor } = await import('./net/room.js'));
  cfg = new ConfigRegistry();
  cfg.loadAll();
});
afterEach(() => { for (const r of rooms) r.stop(); rooms.length = 0; });

describe('⭐ R18-08: штамп сборки сервера', () => {
  it('штамп сервера = штамп исходников shared = штамп, который `vite build` вписывает в бандл; дев-сервер Vite — пустой', async () => {
    const stamp = serverBuild();
    expect(stamp, 'исходники shared рядом — штамп есть').not.toBe('');
    expect(serverBuild(), 'один на процесс').toBe(stamp);
    const dir = join(HERE, '../../shared/src');
    const all = (readdirSync(dir, { recursive: true }) as string[]).filter((p) => statSync(join(dir, p)).isFile());   // вся папка: и тесты, и данные
    const files = all.map((p) => [p, readFileSync(join(dir, p), 'utf8')] as const);
    expect(buildStampOf(files), 'независимый обход той же папки').toBe(stamp);
    // Сборка клиента: тот же штамп — в `define` (как его видит `vite build`), а дев-серверу — пустой.
    const VITE = '../../client/vite.config.ts';   // путём из переменной: проверка типов сервера не тянет конфиг сборки клиента
    const { default: config } = (await import(/* @vite-ignore */ VITE)) as { default: (env: { command: string; mode: string }) => { define?: Record<string, string> } };
    expect(JSON.parse(config({ command: 'build', mode: 'production' }).define!.__DM_BUILD__!), 'было: у вкладки штампа не было вовсе').toBe(stamp);
    expect(JSON.parse(config({ command: 'serve', mode: 'development' }).define!.__DM_BUILD__!)).toBe('');
  });

  it('кадр `joined` несёт штамп сборки', () => {
    const room = new RoomCtor('BLD1', cfg, { onEmpty() {}, onGrace() {}, onUngrace() {} });
    rooms.push(room);
    const ws = new FakeWs();
    room.addPlayer(ws as unknown as GameConn, 'u-build', newCharacterSave(cfg, cfg.get('classes')[0]!.id, 'Штамп', 'char-build-1'), 1);
    const joined = ws.frames.find((f): f is Extract<ServerFrame, { t: 'joined' }> => f.t === 'joined');
    expect(joined?.build, 'было: кадр без штампа — вкладке не с чем сравнить свой').toBe(serverBuild());
  });
});

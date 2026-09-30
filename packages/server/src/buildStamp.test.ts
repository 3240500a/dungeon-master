import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD_CHANGED, ConfigRegistry, PRICE_CHANGED, buildStampOf, isBuildStampSource, newCharacterSave, type SaveState, type AccountStash, type ServerFrame } from '@dm/shared';
import type { GameConn } from './net/conn.js';
import { serverBuild, stampOfDir } from './buildStamp.js';

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


/**
 * ⚠ R19-06 × D3: ШТАМП — ПО КОДУ, А НЕ ПО КОНЦАМ СТРОК, И У ОБЕИХ СТОРОН ОДИН. Бандл клиента собирают на рабочей машине Windows (`core.autocrlf=true`
 * — CRLF), сервер работает из выгрузки Linux (LF) того же коммита. Раньше штампы расходились, и каждой вкладке после каждого входа звучало
 * «перезагрузите», а перезагрузка не помогала никогда. Здесь — настоящие исходники shared, выложенные в две папки (LF и CRLF, с BOM у части
 * файлов), и оба настоящих читателя папки: сервера (`stampOfDir`) и сборки клиента (`vite.config.ts` `buildStampOfDir`).
 */
describe('⚠ R19-06 × D3: штамп сборки — CRLF и LF одного кода дают один штамп у сервера и у сборки клиента', () => {
  it('выгрузки Windows (CRLF, BOM) и Linux (LF) одного кода — один штамп у обоих читателей; правка знака его двигает', async () => {
    const src = join(HERE, '../../shared/src');
    const files = (readdirSync(src, { recursive: true }) as string[]).filter((p) => isBuildStampSource(p) && statSync(join(src, p)).isFile());
    const root = mkdtempSync(join(tmpdir(), 'dm-stamp-'));
    try {
      const lay = (name: string, text: (t: string, i: number) => string): string => {
        const dir = join(root, name);
        files.forEach((p, i) => {
          mkdirSync(dirname(join(dir, p)), { recursive: true });
          writeFileSync(join(dir, p), text(readFileSync(join(src, p), 'utf8').replace(/\r\n?/g, '\n'), i), 'utf8');
        });
        return dir;
      };
      const lf = lay('lf', (t) => t);
      const crlf = lay('crlf', (t, i) => `${i % 3 === 0 ? '﻿' : ''}${t.replace(/\n/g, '\r\n')}`);
      expect(readFileSync(join(crlf, files[1]!), 'utf8'), 'выгрузка и правда CRLF').toMatch(/\r\n/);
      const VITE = '../../client/vite.config.ts';   // путём из переменной: проверка типов сервера не тянет конфиг сборки клиента
      const { buildStampOfDir } = (await import(/* @vite-ignore */ VITE)) as { buildStampOfDir: (dir: string) => string };
      const stamp = stampOfDir(lf);
      expect(stamp, 'штамп есть').not.toBe('');
      expect(stampOfDir(crlf), 'сервер из выгрузки Windows (CRLF, BOM)').toBe(stamp);
      expect(buildStampOfDir(crlf), 'было: бандл с рабочей машины (CRLF) — чужой штамп, «перезагрузите» навсегда').toBe(stamp);
      expect(buildStampOfDir(lf), 'бандл из выгрузки Linux').toBe(stamp);
      // А правка кода под CRLF — другой штамп: нормализация не прячет знаки.
      const victim = files.find((p) => p.replace(/\\/g, '/') === 'economy/townActions.ts')!;
      const text = readFileSync(join(crlf, victim), 'utf8');
      writeFileSync(join(crlf, victim), text.replace("'Цена изменилась'", "'Цена изменилась!'"), 'utf8');
      expect(buildStampOfDir(crlf)).not.toBe(stamp);
      expect(stampOfDir(crlf)).toBe(buildStampOfDir(crlf));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    // Потолок — не про проверку: две выгрузки исходников (~230 файлов) на диск и конфиг сборки клиента; под нагрузкой полного прогона — секунды.
  }, 60_000);
});

/**
 * ⭐ D3: РУКОПОЖАТИЕ НА ВХОДЕ И СОГЛАСИЕ НА СБОРКУ. Кадр `joined` несёт версию протокола, штамп сборки и ревизию конфига комнаты (вкладка сверяет
 * их один раз на вход — `client/net/versionGate.ts`). Команды кузницы, лавки и разбора несут штамп сборки вкладки: чужой — отказ «Цена изменилась»
 * ДО исполнения (`buildChanged`): старый код, показавший цену выше новой, иначе платил не показанное. Нет штампа (Unity, дев-сервер) — как раньше.
 */
describe('⭐ D3: рукопожатие `joined` и согласие на сборку', () => {
  function enter(code: string) {
    const room = new RoomCtor(code, cfg, { onEmpty() {}, onGrace() {}, onUngrace() {} });
    rooms.push(room);
    const ws = new FakeWs();
    const save = newCharacterSave(cfg, cfg.get('classes')[0]!.id, 'Штамп', `char-${code}`);
    const pid = room.addPlayer(ws as unknown as GameConn, `u-${code}`, save, 1);
    return { room, ws, pid };
  }

  it('кадр `joined` несёт ревизию конфига комнаты — ту, с которой сверяется согласие команд', () => {
    const { ws } = enter('BLD2');
    const joined = ws.frames.find((f): f is Extract<ServerFrame, { t: 'joined' }> => f.t === 'joined');
    expect(joined?.cfgRev, 'было: ревизии в рукопожатии не было — вкладка перечитывала конфиг на каждом входе вслепую').toBe(cfg.revision());
    expect(joined?.build).toBe(serverBuild());
    expect(typeof joined?.v).toBe('number');
  });

  it('чужой штамп — отказ до исполнения; свой или без штампа — команда идёт дальше (до своих проверок)', async () => {
    const { room, ws, pid } = enter('BLD3');
    const reply = async (command: Record<string, unknown>, id: number): Promise<Extract<ServerFrame, { t: 'cmdResult' }>> => {
      await room.handleCmd(pid, command, id);
      return ws.frames.find((f): f is Extract<ServerFrame, { t: 'cmdResult' }> => f.t === 'cmdResult' && f.id === id)!;
    };
    const base = { cmd: 'sell', uid: 'no-such-item', minGold: 1, cfgRev: cfg.revision() };
    const foreign = await reply({ ...base, build: `${serverBuild()}-old` }, 1);
    expect(foreign.ok).toBe(false);
    expect(foreign.reason, 'чужая сборка — отказ до всего, причиной «Цена изменилась»: вкладка перечитает конфиг и скажет «перезагрузите»').toBe(BUILD_CHANGED);
    expect(foreign.reason!.startsWith(PRICE_CHANGED)).toBe(true);
    for (const [i, cmd] of [{ ...base, build: serverBuild() }, base].entries()) {
      const r = await reply(cmd, 10 + i);
      expect(r.reason, `${'build' in cmd ? 'свой штамп' : 'без штампа (Unity, дев-сервер)'} — дальше, к своим проверкам`).not.toBe(BUILD_CHANGED);
    }
    const buy = await reply({ cmd: 'buy', uid: 'no-such-item', maxGold: 1 }, 20);
    expect(buy.reason, 'покупка — не команда согласия: цену прислал сервер').not.toBe(BUILD_CHANGED);
  });
});

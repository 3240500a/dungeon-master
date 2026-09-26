import { describe, it, expect, vi, afterEach } from 'vitest';
import { emptyJournal, type ClientFrame, type ServerFrame, type TownCommand } from '@dm/shared';
import { CmdReplies, CMD_REPLY_MS, type CmdReply } from './cmdReplies.js';
import { App } from '../core/app.js';

/**
 * ⭐ ОТВЕТ НА КОМАНДУ ПО НОМЕРУ (D3). Окно ковки ждёт итога ИМЕННО своей заявки: пришёл — ответ,
 * не пришёл — «неизвестно» (`null`), и это НЕ отказ. Главные законы:
 * - чужой номер не отпускает ждущего (иначе ответ на «купить» закрыл бы ожидание ковки);
 * - тишина не висит вечно — таймаут отдаёт `null`;
 * - ждущего регистрируют ДО отправки: мост редактора отвечает синхронно, внутри `sendCmd`.
 */

const reply = (id: number | undefined, over: Partial<CmdReply> = {}): CmdReply =>
  ({ t: 'cmdResult', ...(id !== undefined ? { id } : {}), cmd: 'craft', ok: true, ...over });

afterEach(() => { vi.useRealTimers(); });

describe('CmdReplies — ожидание cmdResult', () => {
  it('ответ со своим номером отпускает ждущего ровно этим ответом', async () => {
    const r = new CmdReplies();
    const p = r.wait(7);
    expect(r.settle(reply(7, { uid: 'u-1' }))).toBe(true);
    await expect(p).resolves.toMatchObject({ id: 7, ok: true, uid: 'u-1' });
    expect(r.pending).toBe(0);
  });

  it('⭐ чужой номер и ответ без номера — не наши: ждущий ждёт дальше', async () => {
    vi.useFakeTimers();
    const r = new CmdReplies();
    const p = r.wait(3, 1000);
    expect(r.settle(reply(4))).toBe(false);
    expect(r.settle(reply(undefined))).toBe(false);
    expect(r.settle({ ...reply(3), id: '3' as unknown as number })).toBe(false); // номер строкой — не номер
    expect(r.pending).toBe(1);
    r.settle(reply(3, { ok: false, reason: 'Не хватает' }));
    await expect(p).resolves.toMatchObject({ ok: false, reason: 'Не хватает' });
  });

  it('⭐ тишина → null по таймауту (итог неизвестен), поздний ответ уже никого не отпускает', async () => {
    vi.useFakeTimers();
    const r = new CmdReplies();
    const p = r.wait(1);
    vi.advanceTimersByTime(CMD_REPLY_MS - 1);
    expect(r.pending).toBe(1);
    vi.advanceTimersByTime(1);
    await expect(p).resolves.toBeNull();
    expect(r.settle(reply(1))).toBe(false);
  });

  it('тот же номер дважды: прежний ждущий получает null, новый — ответ', async () => {
    const r = new CmdReplies();
    const a = r.wait(5), b = r.wait(5);
    r.settle(reply(5, { uid: 'x' }));
    await expect(a).resolves.toBeNull();
    await expect(b).resolves.toMatchObject({ uid: 'x' });
  });

  it('dropAll отпускает всех с null', async () => {
    const r = new CmdReplies();
    const ps = [r.wait(1), r.wait(2)];
    r.dropAll();
    await expect(Promise.all(ps)).resolves.toEqual([null, null]);
    expect(r.pending).toBe(0);
  });

  it('⭐ R5-18: поздний ответ (после таймаута) доходит до `onLate` — ждавший узнаёт итог; в лог App он идёт по-прежнему', async () => {
    vi.useFakeTimers();
    const r = new CmdReplies();
    const late: CmdReply[] = [];
    const p = r.wait(11, 1000, (x) => late.push(x));
    vi.advanceTimersByTime(1000);
    await expect(p).resolves.toBeNull();
    expect(r.settle(reply(11, { ok: false, reason: 'Не удалось сохранить, попробуйте ещё раз' })), 'ждущего нет — App пишет отказ в лог').toBe(false);
    expect(late, 'было: поздний ответ не узнавал никто — окно повторяло тот же номер и получало эхо отказа').toMatchObject([{ id: 11, ok: false }]);
    r.settle(reply(11));
    expect(late, 'один раз').toHaveLength(1);
  });

  it('R5-18: без таймаута `onLate` молчит — ответ получает сам ждущий; обрыв (dropAll) и новый ждущий того же номера его снимают', async () => {
    vi.useFakeTimers();
    const r = new CmdReplies();
    const late: number[] = [];
    const a = r.wait(1, 1000, () => late.push(1));
    r.settle(reply(1));
    await expect(a).resolves.toMatchObject({ id: 1 });
    void r.wait(2, 1000, () => late.push(2));
    vi.advanceTimersByTime(1000);
    r.dropAll();                                      // ответ по мёртвому сокету не придёт — а номер нового сокета тот же
    r.settle(reply(2));
    void r.wait(3, 1000, () => late.push(3));
    vi.advanceTimersByTime(1000);
    const again = r.wait(3, 1000);                    // повтор тем же номером (R4-23) — ответ достаётся ему
    r.settle(reply(3));
    await expect(again).resolves.toMatchObject({ id: 3 });
    expect(late).toEqual([]);
  });

  it('ответ ДО ожидания теряется — поэтому App.request регистрирует ждущего до отправки', () => {
    const r = new CmdReplies();
    expect(r.settle(reply(9))).toBe(false);
  });
});

describe('App — номер команды, request и кадры сервера', () => {
  /** Подать кадр сервера так, как его подаёт сокет: всем обработчикам этого типа. */
  const deliver = (app: App, frame: ServerFrame): void => {
    const hs = (app.net as unknown as { handlers: Map<string, ((f: ServerFrame) => void)[]> }).handlers.get(frame.t) ?? [];
    for (const h of hs) h(frame);
  };
  const spySend = (app: App): ClientFrame[] => {
    const sent: ClientFrame[] = [];
    app.net.send = (f: ClientFrame): void => { sent.push(f); };
    return sent;
  };

  it('sendCmd возвращает номер кадра; номера растут, request берёт свой', () => {
    const app = new App();
    const sent = spySend(app);
    const a = app.sendCmd({ cmd: 'stashOpen' });
    void app.request({ cmd: 'forgeSalvage', uid: 'u' }, 50);
    const b = app.sendCmd({ cmd: 'stashOpen' });
    expect(sent.map((f) => (f.t === 'cmd' ? f.id : -1))).toEqual([a, a + 1, b]);
    expect(b).toBe(a + 2);
  });

  it('⭐ ответ сервера (кадр cmdResult) отпускает request ровно своего номера', async () => {
    const app = new App();
    const sent = spySend(app);
    const p = app.request({ cmd: 'forgeEnchant', uid: 'u-9', rarity: 'rare' });
    const f = sent[0]!;
    if (f.t !== 'cmd') throw new Error('ждали кадр cmd');
    deliver(app, reply(f.id! + 100, { cmd: 'buy' }));         // чужой ответ
    deliver(app, reply(f.id, { cmd: 'forgeEnchant', uid: 'u-9' }));
    await expect(p).resolves.toMatchObject({ id: f.id, uid: 'u-9' });
  });

  it('мост редактора отвечает синхронно внутри sendCmd — ответ не теряется', async () => {
    const app = new App();
    app.sendCmd = (cmd: TownCommand, id = app.nextCmdId()): number => {
      app.replies.settle({ t: 'cmdResult', id, cmd: cmd.cmd, ok: true, uid: 'from-harness' });
      return id;
    };
    await expect(app.request({ cmd: 'forgeSalvage', uid: 'x' }, 50)).resolves.toMatchObject({ uid: 'from-harness' });
  });

  it('⭐ кадр stash кладёт журнал кузнеца в app.stash (его читают окно ковки и полевой разбор)', () => {
    const app = new App();
    const journal = { ...emptyJournal(), bases: ['longsword'], variants: ['v-1'] };
    deliver(app, { t: 'stash', tabs: [[]], cols: 10, rows: 8, tabCount: 1, materials: { 'iron-1': 3 }, forgeJournal: journal });
    expect(app.stash?.forgeJournal).toEqual(journal);
    expect(app.stash?.materials).toEqual({ 'iron-1': 3 });
  });
});

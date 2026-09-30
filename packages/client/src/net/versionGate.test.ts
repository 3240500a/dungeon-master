import { describe, it, expect } from 'vitest';
import { REFUSAL_REPEAT_MS, VersionGate, type ConfigRead } from './versionGate.js';

/**
 * ⭐ D3: ПРАВИЛО ВЕРСИЙ — чистый класс на подделках: рукопожатие на входе (протокол, штамп сборки, ревизия конфига), отказ «Цена изменилась»
 * (перечитать конфиг ОДИН раз, потом решить) и упавший кусок сборки. Инварианты: на вход — ровно одна строка «перезагрузите», если вкладка старше
 * сервера, и ни одной, если нет; отказ, который перечитывание не лечит, у вкладки старше сервера — всегда с подсказкой (не чаще предела повтора);
 * у вкладки не старше — никогда. Проводка в `App` и оба клиента — `core/app.config.test.ts`, `scenes/OnlineScene.test.ts`, фаззер B3.
 */
function rig(opts: { build?: string; rev?: string } = {}) {
  const st = {
    now: 1_000_000,
    mine: opts.build ?? 'b1',
    rev: opts.rev ?? 'r1',
    unreadable: false,
    /** Что вернёт следующее перечитывание (и что оно сделает с конфигом вкладки). */
    next: 'same' as ConfigRead,
    onReread: undefined as (() => void) | undefined,
    rereads: 0,
    told: [] as number[],
  };
  const gate = new VersionGate({
    reread: () => { st.rereads++; st.onReread?.(); return Promise.resolve(st.next); },
    configRevision: () => st.rev,
    configUnreadable: () => st.unreadable,
    tell: () => { st.told.push(st.now); },
    protocol: 7,
    buildDiffers: (s) => !!s && !!st.mine && s !== st.mine,
    now: () => st.now,
  });
  return { gate, st };
}

describe('⭐ D3: рукопожатие на входе — одна строка «перезагрузите» на вход, если вкладка старше сервера', () => {
  it('всё сходится — ни строки и ни одного перечитывания (ревизия конфига та же)', async () => {
    const { gate, st } = rig();
    await gate.joined({ v: 7, build: 'b1', cfgRev: 'r1' });
    expect(st.told).toEqual([]);
    expect(st.rereads, 'ревизия та же — конфиг не перечитывается').toBe(0);
    expect(gate.stale()).toBe(false);
  });

  it('каждая причина по отдельности и все разом — ровно одна строка на вход', async () => {
    const cases: [string, { v?: number; build?: string; cfgRev?: string }, () => void][] = [
      ['другой протокол', { v: 8, build: 'b1', cfgRev: 'r1' }, () => { }],
      ['чужой штамп сборки', { v: 7, build: 'b2', cfgRev: 'r1' }, () => { }],
      ['конфиг сервера не разобран (R7-14)', { v: 7, build: 'b1', cfgRev: 'r2' }, () => { }],
      ['всё разом', { v: 8, build: 'b2', cfgRev: 'r2' }, () => { }],
    ];
    for (const [what, f] of cases) {
      const { gate, st } = rig();
      st.onReread = () => { if (f.cfgRev !== st.rev) { st.next = 'broken'; st.unreadable = true; } };
      await gate.joined(f);
      expect(st.told.length, what).toBe(1);
    }
  });

  it('новый вход к той же чужой сборке — снова одна строка (было: молча — «сказано на этот штамп»)', async () => {
    const { gate, st } = rig();
    await gate.joined({ v: 7, build: 'b2', cfgRev: 'r1' });
    st.now += 100;
    await gate.joined({ v: 7, build: 'b2', cfgRev: 'r1' });
    expect(st.told.length).toBe(2);
    st.mine = 'b2';   // игрок перезагрузил страницу: бандл новой сборки
    await gate.joined({ v: 7, build: 'b2', cfgRev: 'r1' });
    expect(st.told.length, 'после перезагрузки — ни слова').toBe(2);
  });

  it('ревизия конфига не та (или сервер её не прислал) — одно перечитывание; лёг конфиг — вкладка не старше, молчим', async () => {
    const { gate, st } = rig();
    st.next = 'fresh';
    st.onReread = () => { st.rev = 'r2'; };
    await gate.joined({ v: 7, build: 'b1', cfgRev: 'r2' });
    expect(st.rereads).toBe(1);
    await gate.joined({ v: 7, build: 'b1' });
    expect(st.rereads, 'сервер старше рукопожатия — перечитывание условным запросом, как прежде').toBe(2);
    expect(st.told).toEqual([]);
  });

  it('штампа нет с одной из сторон (дев-сервер Vite, сервер без исходников) — сравнивать нечего', async () => {
    for (const [mine, srv] of [['', 'b2'], ['b1', undefined]] as const) {
      const { gate, st } = rig({ build: mine });
      await gate.joined({ v: 7, build: srv, cfgRev: 'r1' });
      expect(st.told, `вкладка «${mine}», сервер «${String(srv)}»`).toEqual([]);
    }
  });

  it('сверка входа, обогнанная следующим входом, решения не выносит (одна строка — у последнего входа)', async () => {
    const { gate, st } = rig();
    let release!: () => void;
    let first = true;
    const deps = (gate as unknown as { deps: { reread: () => Promise<ConfigRead> } }).deps;
    const orig = deps.reread;
    deps.reread = () => {
      if (!first) return orig();
      first = false;
      return new Promise<ConfigRead>((res) => { release = () => res('broken'); });
    };
    st.unreadable = true;
    const a = gate.joined({ v: 7, build: 'b1', cfgRev: 'r1' });   // конфиг сервера не разобран: перечитывание висит
    await gate.joined({ v: 7, build: 'b1', cfgRev: 'r1' });       // новый вход раньше ответа
    release();
    await a;
    expect(st.told.length, 'одна строка на последний вход, опоздавший ответ первого — не вторая').toBe(1);
  });
});

describe('⭐ D3: отказ «Цена изменилась» — одно перечитывание, потом решение', () => {
  it('вкладка старше сервера (код): отказ, который перечитывание не лечит, — «перезагрузите», не чаще предела повтора', async () => {
    const { gate, st } = rig();
    await gate.joined({ v: 7, build: 'b2', cfgRev: 'r1' });
    expect(st.told.length).toBe(1);
    st.now += 100;
    await gate.refused();
    expect(st.told.length, 'сразу за строкой входа — не лента').toBe(1);
    for (let click = 1; click <= 3; click++) {
      st.now += REFUSAL_REPEAT_MS;
      const before = st.rereads;
      await gate.refused();
      expect(st.rereads - before, 'перечитывание — одно на отказ').toBe(1);
      expect(st.told.length, `клик ${click}`).toBe(1 + click);
    }
    st.now += REFUSAL_REPEAT_MS - 1;
    await gate.refused();
    expect(st.told.length, 'зажатый клик — одна строка').toBe(4);
  });

  it('перечитывание принесло новый конфиг (или обогнано следующим) — отказ объяснён, молчим даже у чужой сборки', async () => {
    const { gate, st } = rig();
    await gate.joined({ v: 7, build: 'b2', cfgRev: 'r1' });
    for (const r of ['fresh', 'overtaken'] as const) {
      st.now += 10 * REFUSAL_REPEAT_MS;
      st.next = r;
      await gate.refused();
      expect(st.told.length, r).toBe(1);
    }
  });

  it('конфиг сервера вкладка не разбирает (R7-14) или разобрала не в то же (R16 C-07) — отказ с подсказкой; починили — молчим', async () => {
    const { gate, st } = rig();
    await gate.joined({ v: 7, build: 'b1', cfgRev: 'r1' });
    st.unreadable = true;
    st.now += 10 * REFUSAL_REPEAT_MS;
    st.next = 'broken';
    await gate.refused();
    expect(st.told.length).toBe(1);
    st.now += 10 * REFUSAL_REPEAT_MS;
    st.next = 'same';
    await gate.refused();
    expect(st.told.length, 'тот же негодный (304) — снова подсказка: тупика нет').toBe(2);
    st.unreadable = false;
    st.now += 10 * REFUSAL_REPEAT_MS;
    st.next = 'fresh';
    await gate.refused();
    st.now += 10 * REFUSAL_REPEAT_MS;
    st.next = 'same';
    await gate.refused();
    expect(st.told.length, 'конфиг лёг — вкладка не старше: гонка той же сборки без подсказки').toBe(2);
  });

  it('вкладка не старше сервера: отказ ценой (гонка двойного клика) — никогда «перезагрузите»; сервер не ответил — тоже', async () => {
    const { gate, st } = rig();
    await gate.joined({ v: 7, build: 'b1', cfgRev: 'r1' });
    for (const r of ['same', 'failed'] as const) {
      st.now += 10 * REFUSAL_REPEAT_MS;
      st.next = r;
      await gate.refused();
    }
    expect(st.told).toEqual([]);
  });
});

describe('⭐ D3 × R10-12: ленивый кусок сборки не загрузился — код вкладки старше', () => {
  it('строка сразу (с пределом повтора), и дальше отказы ценой — тоже с подсказкой', async () => {
    const { gate, st } = rig();
    await gate.joined({ v: 7, build: 'b1', cfgRev: 'r1' });
    gate.chunkFailed();
    expect(st.told.length).toBe(1);
    expect(gate.codeStale()).toBe(true);
    st.now += REFUSAL_REPEAT_MS;
    await gate.refused();
    expect(st.told.length).toBe(2);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_REV_HEADER, ConfigRegistry, configCrossIssues, defaultConfigData } from '@dm/shared';
import { App } from './app.js';

/**
 * ⭐ R22-01: ФАЙЛЫ ДАННЫХ, ВМЕСТЕ НАРУШАЮЩИЕ ПРАВИЛО ПОВЕРХ ТАБЛИЦ (D4), НЕ РОНЯЮТ ВКЛАДКУ.
 *
 * С R21-03 сервер грузит основу (файлы) без правила поверх таблиц, приводит древо и вставки зажимом с ИНЦИДЕНТОМ и работает. А вкладка
 * строила `App` со встроенными файлами тем же `loadAll()` — с правилом по умолчанию: правка одного `data/*.json` (отдых баффа 0.25 → 0.30,
 * откат клича −10 %), слияние двух годных по отдельности правок, откат одного файла — и конструктор `App` бросал «⭐ D4 правило баффа…» раньше,
 * чем `syncConfig` успевал взять годный приведённый конфиг сервера: пустая страница у 2D и 3D на каждой загрузке у каждого игрока (деплой
 * тестов не гоняет). Правило принадлежит ИТОГОВОМУ конфигу, и судят его запись и сборка сервера; вкладка — ЧИТАТЕЛЬ: встроенные файлы — лишь
 * основа до ответа сервера, тело `/api/config` уже решено сервером, правка из канала редактора — уже принята сервером.
 */
type Tables = Record<string, unknown>;
type Tree = { nodes: { id: string; effect: { active?: { category?: string; cooldown: number } } }[] };

/** Файлы данных, которые ВМЕСТЕ нарушают D4 (по отдельности каждая таблица годна схемой). */
const BROKEN: Record<string, (d: Tables) => void> = {
  'отдых баффа 0.25 → 0.30 (balance.json)': (d) => { d.balance = { ...(d.balance as Tables), buffMinRest: 0.3 }; },
  'откат «Боевого клича» −10 % (skill-tree.json)': (d) => {
    const tree = structuredClone(d['skill-tree']) as Tree;
    const cry = tree.nodes.find((n) => n.id === 'b-class-warrior-a5')!;
    cry.effect.active!.cooldown = Math.round(cry.effect.active!.cooldown * 0.9 * 100) / 100;
    d['skill-tree'] = tree;
  },
};

/** Сервер: настоящая сборка живого конфига (`server/configCandidate.ts`) — импорт с путём из переменной: клиент не тянет сервер в проверку типов. */
type Candidate = { raw: Tables; reg: ConfigRegistry; fileFixes: Record<string, string[]>; crossLeft: unknown[] };
async function buildCandidate(files: Tables): Promise<Candidate> {
  const CANDIDATE = '../../../server/src/configCandidate.js';
  const m = (await import(/* @vite-ignore */ CANDIDATE)) as { buildCandidate: (base: Tables, stored: Tables) => Candidate };
  return m.buildCandidate(files, {});
}

class FakeBc {
  static all: FakeBc[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  constructor(public name: string) { FakeBc.all.push(this); }
  postMessage(): void { }
  close(): void { }
}

const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

describe('⭐ R22-01: встроенные файлы вместе нарушают D4 — вкладка открывается и берёт конфиг сервера', () => {
  const G = globalThis as unknown as { fetch?: unknown; window?: unknown; BroadcastChannel?: unknown };
  let saved: { fetch: unknown; window: unknown; bc: unknown };
  /** Встроенные таблицы, которые тест подменил (сборка клиента с этими файлами), — вернуть после теста. */
  let bundle: Tables;
  /** Тело `/api/config` и ревизия сервера; `null` — сервер не отвечает. */
  let served: { body: Tables; rev: string } | null;
  beforeEach(() => {
    saved = { fetch: G.fetch, window: G.window, bc: G.BroadcastChannel };
    bundle = { ...defaultConfigData };
    served = null;
    FakeBc.all = [];
    G.fetch = async (url: string): Promise<unknown> => {
      if (url !== '/api/config') throw new Error(`не ждали ${url}`);
      if (!served) throw new Error('сервер перезапускается');
      const s = served;
      const headers = { get: (h: string): string | null => (h.toLowerCase() === 'etag' ? `W/"${s.rev}"` : h.toLowerCase() === CONFIG_REV_HEADER ? s.rev : null) };
      return { ok: true, status: 200, headers, json: async () => JSON.parse(JSON.stringify(s.body)) as unknown };
    };
  });
  afterEach(() => {
    for (const k of Object.keys(defaultConfigData)) defaultConfigData[k] = bundle[k];
    G.fetch = saved.fetch; G.window = saved.window; G.BroadcastChannel = saved.bc;
  });
  /** Сборка клиента с этими файлами данных (встроенные дефолты). */
  function ship(files: Tables): void { for (const [k, v] of Object.entries(files)) defaultConfigData[k] = v; }
  const filesWith = (edit: (d: Tables) => void): Tables => { const d = structuredClone(bundle); edit(d); return d; };

  for (const [what, edit] of Object.entries(BROKEN)) {
    it(`⭐ ${what}: сервер собирается с зажимом, а \`App\` строится (было — бросок D4 в конструкторе, пустая страница) и берёт конфиг сервера`, async () => {
      const files = filesWith(edit);
      expect(() => new ConfigRegistry().loadAll(files), 'сами файлы вместе правило нарушают (иначе тест ни о чём)').toThrow(/D4 правило баффа/);
      const c = await buildCandidate(files);
      expect(c.crossLeft, 'сервер собирает годный кандидат — зажим с инцидентом').toEqual([]);
      expect(Object.keys(c.fileFixes).length, 'приведён файл (инцидент сервера)').toBeGreaterThan(0);
      ship(files);

      const offline = new App({ offline: true });   // мост редактора и старт вкладки до ответа сервера — встроенные файлы как есть
      expect(offline.config.get('balance').buffMinRest).toBe((files.balance as { buffMinRest: number }).buffMinRest);

      served = { body: c.reg.snapshot() as unknown as Tables, rev: c.reg.revision() };
      const app = new App();
      await flush();
      expect(app.configRevision(), 'старт вкладки: взят приведённый конфиг сервера').toBe(c.reg.revision());
      expect(app.config.revision(), 'разобран в то же').toBe(c.reg.revision());
      expect(configCrossIssues((k) => app.config.get(k)), 'в игре — годное, как у сервера').toEqual([]);
      expect(await app.syncConfig(), 'тот же конфиг — снова ложится, не «вкладка старше»').toBe('fresh');
    });
  }

  it('⭐ сервер сам поставил конфиг, нарушающий правило (сборка без проверки с инцидентом, `crossLeft`): вкладка его берёт — «fresh», а не «перезагрузите»', async () => {
    const files = filesWith(BROKEN['отдых баффа 0.25 → 0.30 (balance.json)']!);
    const reg = new ConfigRegistry();
    reg.loadAll(files, { cross: false });   // как `install` сервера при `crossLeft`: схема каждой таблицы, без правила поверх
    served = { body: reg.snapshot() as unknown as Tables, rev: reg.revision() };
    const app = new App();
    await flush();
    expect(app.configRevision(), 'было: каждая вкладка — «broken», «вкладка старше сервера» навсегда').toBe(reg.revision());
    expect(await app.syncConfig()).toBe('fresh');
  });

  it('⭐ правка из канала редактора (уже принятая сервером) ложится, даже если с прочими таблицами вкладки она правило нарушает', async () => {
    const w = { addEventListener: (): void => { }, BroadcastChannel: FakeBc };
    G.window = w; G.BroadcastChannel = FakeBc;
    const app = new App();   // сервер не ответил на старте (перезапуск) — вкладка на встроенных файлах, древо — файла
    await flush();
    // Хозяин на сервере: древо с откатами длиннее (оверрайд) и отдых 0.30 — вместе годны; сервер принял баланс, редактор разослал его вкладкам.
    const bal = { ...app.config.get('balance'), buffMinRest: 0.3, respecCost: 4242 };
    FakeBc.all.at(-1)!.onmessage!({ data: { key: 'balance', value: bal } });
    expect(app.config.get('balance').respecCost, 'было: принятая сервером правка молча отброшена (правило — над древом вкладки)').toBe(4242);
  });

  /**
   * СТОРОЖ КЛАССА: клиенты и редактор — ЧИТАТЕЛИ готового конфига. Каждая загрузка реестра (`loadAll`, `reload`) в их коде — без правила поверх
   * таблиц (`{ cross: false }`): встроенные файлы, тело сервера, принятая сервером правка, рабочая копия инструментов «что, если». Правило судят
   * только запись (проба сервера, `validated` канала редактора до отправки) и сборка сервера. Новая загрузка без него — снова бросок на данных,
   * с которыми сервер работает.
   */
  it('сторож: каждая загрузка реестра в клиенте и редакторе — читателем (`cross: false`)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const roots = [join(here, '..'), join(here, '..', '..', '..', 'editor', 'src')];
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.ts$/.test(n) && !/\.test\.ts$|\.fuzzKit\.ts$|\.d\.ts$/.test(n)) files.push(p);
      }
    };
    for (const r of roots) walk(r);
    const bad: string[] = [];
    let seen = 0;
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/(\w+)\s*\.\s*(loadAll|reload)\s*\(/g)) {
        if (m[1] === 'location') continue;   // `location.reload()` — страница, не реестр
        const line = src.slice(0, m.index).split('\n').length;
        if (/^\s*(\*|\/\/)/.test(src.slice(src.lastIndexOf('\n', m.index) + 1, m.index))) continue;   // в комментарии
        let depth = 0, i = m.index! + m[0].length - 1;
        for (; i < src.length; i++) { if (src[i] === '(') depth++; else if (src[i] === ')' && --depth === 0) break; }
        seen++;
        if (!/cross:\s*false/.test(src.slice(m.index, i))) bad.push(`${relative(join(here, '..', '..', '..'), f)}:${line}`);
      }
    }
    expect(seen, 'сторож видит загрузки реестра').toBeGreaterThan(10);
    expect(bad, 'загрузка реестра с правилом поверх таблиц у читателя').toEqual([]);
  });
});

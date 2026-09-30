import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { configCrossIssues, configRev, configSchemas, createRng, defaultConfigData, type ConfigKey, type Rng } from '@dm/shared';
import { LiveConfigBase, bundledWorkingCopy } from './liveConfig.js';
import { ConfigChannel, type ChannelIo } from './configChannel.js';
import { serverRig, type ServerRig, type Tables } from './configChannel.fuzzKit.js';

/**
 * ⭐ R22-08 (и R22-01): ФАЗЗЕР «РЕДАКТОР ≡ СЕРВЕР» — канал записи редактора (`configChannel.ts`, настоящий) над настоящими ручками записи и
 * живым конфигом сервера (`configChannel.fuzzKit.ts`). Сид даёт сборку (иногда — файлы данных, ВМЕСТЕ нарушающие правило поверх таблиц D4:
 * сервер собирает их с зажимом) и последовательность действий хозяина по трём таблицам правила (`balance`, `skill-tree`, `skill-inserts`) и
 * чужой ему (`rarities`): правка формы без применения (числами у границы правила), «Применить на сервере», «Применить везде», «Сбросить к
 * дефолту», запись той же таблицы из другой вкладки (база этого редактора устаревает), перезагрузка страницы редактора. После КАЖДОГО шага:
 *  0 — редактор открывается над любой сборкой, с которой сервер работает (`0-boot`, R22-01);
 *  1 — рабочая копия — то, что хозяин видит и правил: её меняет только он, принятый сброс (таблицей сервера) и перезагрузка (`1-copy`);
 *  2 — вкладкам игры уходит только то, что сервер держит (`2-post-not-live`);
 *  3 — принятое сервером — ровно то, что хозяин видел (`3-accepted-not-intended`: иначе «Применить одного поля» заменяло прочие поля — C-09);
 *      отказ ничего на сервере не меняет (`3-refused-wrote`); принятый сброс — форма и база записи = таблица сервера (`3-reset`);
 *  4 — вердикт правила поверх таблиц у редактора тот же, что у сервера, пока база редактора — живое сервера (`4-verdict`).
 * Самопроверки: прежний сброс (дефолты в форму и вкладкам до ответа) и прежняя проверка правила (над неприменёнными таблицами рабочей копии)
 * фаззером ловятся.
 *
 * ПЕРЕМЕННЫЕ: `DM_FUZZ_SEEDS=N` (умолчание 5), `DM_FUZZ_FROM` — с какого сида, `DM_FUZZ_OPS` — длина последовательности (умолчание 10),
 * `DM_FUZZ_TRACE=1` — след шагов в stderr.
 */
const env = (k: string, d: number): number => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? Math.floor(v) : d; };
const SEEDS = env('DM_FUZZ_SEEDS', 5);
const FROM = env('DM_FUZZ_FROM', 1);
const OPS = env('DM_FUZZ_OPS', 10);

const CROSS = ['balance', 'skill-tree', 'skill-inserts'] as const;
const TABLES = [...CROSS, 'rarities'] as const;
type Key = (typeof TABLES)[number];
type Tree = { nodes: { id: string; maxRank: number; effect: { active?: { category?: string; cooldown: number; durationSec: number }; grantsInsert?: string } }[] };
type Ins = { id: string; proc?: { ability: { category?: string; cooldown: number } } }[];
const clone = <T>(v: T): T => structuredClone(v);
/** Таблица, как её разберёт схема (сравнение «одно и то же»); не разбирается — сырой JSON. */
const parsed = (key: string, value: unknown): string => {
  const r = configSchemas[key as ConfigKey].safeParse(clone(value));
  return JSON.stringify(r.success ? r.data : value);
};

/** Правка таблицы `key` поверх `from` — как форма редактора, числами у границы правила. */
function mutate(r: Rng, key: Key, from: unknown): unknown {
  const t = clone(from) as Record<string, unknown>;
  if (key === 'balance') {
    if (r.chance(0.7)) (t as { buffMinRest: number }).buffMinRest = r.pick([0.05, 0.1, 0.1, 0.25, 0.3, 0.5, 1]);
    if (r.chance(0.6)) (t as { respecCost: number }).respecCost = 100 + r.int(0, 9000);   // правка экономики рядом — живёт или нет вместе с балансом
    return t;
  }
  if (key === 'skill-tree') {
    const tree = t as unknown as Tree;
    const buffs = tree.nodes.filter((n) => n.effect.active?.category === 'buff');
    const donors = tree.nodes.filter((n) => n.effect.grantsInsert === 'ins-ward' || n.effect.grantsInsert === 'ins-swiftness');
    if (r.chance(0.75)) {
      const b = r.pick(buffs);
      b.effect.active!.cooldown = Math.round(b.effect.active!.durationSec * r.pick([1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 2, 3]) * 100) / 100;
      if (r.chance(0.4)) b.maxRank = r.pick([1, 3, 6, 8, 12]);
    } else r.pick(donors).maxRank = r.pick([1, 3, 10, 20]);
    return tree;
  }
  if (key === 'skill-inserts') {
    const sig = r.pick((t as unknown as Ins).filter((i) => i.proc?.ability.category === 'buff'));
    sig.proc!.ability.cooldown = r.pick([4, 5, 7, 10.4, 10.5, 14, 30]);
    return t;
  }
  const rar = t as unknown as { priceMult: number }[];
  const row = r.pick(rar);
  row.priceMult = Math.round((row.priceMult + r.pick([-0.1, 0.1, 0.25])) * 100) / 100;
  if (row.priceMult <= 0) row.priceMult = 0.1;
  return t;
}

/** Сборка файлов данных этого сида: иногда вместе нарушающих D4 (R22-01) — сервер собирает их с зажимом и инцидентом. */
function filesOf(r: Rng): { files: Tables; broken: string } {
  if (!r.chance(0.35)) return { files: defaultConfigData, broken: '' };
  if (r.chance(0.5)) {
    const rest = r.pick([0.3, 0.5]);
    return { files: { ...defaultConfigData, balance: { ...(defaultConfigData.balance as Tables), buffMinRest: rest } }, broken: `отдых ${rest}` };
  }
  // Откат баффа короче (−10 %, у баффа с запасом — глубже, пока правило не нарушено).
  const id = r.pick((defaultConfigData['skill-tree'] as Tree).nodes.filter((n) => n.effect.active?.category === 'buff')).id;
  for (const cut of [0.1, 0.2, 0.3, 0.4]) {
    const tree = clone(defaultConfigData['skill-tree']) as Tree;
    const b = tree.nodes.find((n) => n.id === id)!;
    b.effect.active!.cooldown = Math.round(b.effect.active!.cooldown * (1 - cut) * 100) / 100;
    const files: Tables = { ...defaultConfigData, 'skill-tree': tree };
    if (configCrossIssues((k) => configSchemas[k].parse(clone(files[k]))).length) return { files, broken: `откат ${id} −${cut * 100} %` };
  }
  return { files: { ...defaultConfigData, balance: { ...(defaultConfigData.balance as Tables), buffMinRest: 0.5 } }, broken: 'отдых 0.5' };
}

interface Violation { seed: number; step: number; op: string; inv: string; msg: string }
interface Opts { legacyReset?: boolean; legacyValidate?: boolean }

async function runSeed(seed: number, opts: Opts = {}): Promise<Violation | null> {
  const r = createRng((seed * 0x2208c0de + 17) >>> 0 || 1);
  const { files, broken } = filesOf(r);
  let step = -1;
  let op = broken ? `сборка: файлы вместе нарушают D4 (${broken})` : 'сборка';
  const v = (inv: string, msg: string): Violation => ({ seed, step, op, inv, msg });
  const s: ServerRig = await serverRig(files);
  // 0 — редактор открывается (R22-01): рабочая копия до ответа сервера — встроенные файлы.
  let data: Tables;
  try { data = bundledWorkingCopy(files); } catch (e) { return v('0-boot', String(e).split('\n').slice(0, 2).join(' ')); }
  const bundle = clone(data);
  const live = new LiveConfigBase();
  const late: string[] = [];
  const io: ChannelIo = {
    send: s.send, read: () => s.read(),
    // 2 — вкладкам игры только то, что сервер держит, в миг рассылки.
    post: (k, value) => { if (parsed(k, value) !== parsed(k, s.config.get(k as ConfigKey))) late.push(`«${k}» разослана вкладкам игры, а у сервера другая`); },
    status: () => undefined, label: (k) => k, later: (fn) => { fn(); },
  };
  const ch = new ConfigChannel(data, live, io);
  if (opts.legacyReset) {
    // ⚠ Самопроверка: сброс до R22-08 — встроенные дефолты в форму и вкладкам игры ДО ответа, база — ответом DELETE.
    ch.reset = async (key: string): Promise<boolean> => {
      data[key] = clone(bundle[key]);
      io.post(key, data[key]);
      const reply = await s.send(`/api/dev/config/${encodeURIComponent(key)}`, { method: 'DELETE' });
      if (reply.ok) live.saved(((await reply.json()) as { rev?: unknown }).rev);
      return reply.ok;
    };
  }
  if (opts.legacyValidate) {
    // ⚠ Самопроверка: проверка правила до R22-08 — прочие таблицы из рабочей копии (неприменённые), а не живые.
    ch.validated = (keys) => {
      const out: Tables = {};
      for (const k of keys) {
        const got = configSchemas[k as ConfigKey].safeParse(data[k]);
        if (!got.success) return null;
        out[k] = got.data;
      }
      if (!keys.some((k) => (CROSS as readonly string[]).includes(k))) return out;
      return configCrossIssues((k) => (k in out ? out[k] : configSchemas[k].safeParse(data[k]).data)).length ? null : out;
    };
  }
  /** Хозяин открыл (или перезагрузил) страницу редактора: рабочая копия и база — живой конфиг сервера. */
  const intended: Tables = {};
  const load = async (): Promise<void> => {
    const snap = await s.read();
    live.accept(snap);
    Object.assign(data, snap);
    for (const k of TABLES) intended[k] = clone(data[k]);
  };
  await load();

  for (step = 0; step < OPS; step++) {
    const roll = r.int(0, 99);
    const serverBefore = Object.fromEntries(TABLES.map((k) => [k, parsed(k, s.config.get(k))]));
    // База редактора — живое сервера (для вердикта правила): живые таблицы правила у редактора те же, что у сервера.
    const baseCurrent = CROSS.every((k) => parsed(k, live.value(k)) === serverBefore[k]);
    late.length = 0;
    if (roll < 30) {
      const k = r.pick(TABLES);
      data[k] = mutate(r, k, data[k]);
      intended[k] = clone(data[k]);
      op = `правка формы «${k}» (не применена)`;
    } else if (roll < 58) {
      const keys: Key[] = r.chance(0.25) ? [...new Set([r.pick(TABLES), r.pick(TABLES)])] : [r.pick(TABLES)];
      const toFile = r.chance(0.3);
      const values = ch.validated(keys);
      op = `${toFile ? '«Применить везде»' : '«Применить на сервере»'} ${keys.join('+')}`;
      if (!toFile && baseCurrent) {
        // 4 — вердикт правила поверх таблиц: сервер проверит правку над живым кандидатом.
        const why = await s.live.trial(Object.fromEntries(keys.map((k) => [k, configSchemas[k as ConfigKey].parse(clone(data[k]))])));
        if ((values === null) !== (why !== null)) return v('4-verdict', values === null ? 'редактор отказал правке, которую сервер принимает' : `редактор пропустил правку, которой сервер откажет: ${why!.split('\n')[1] ?? why}`);
      }
      if (values) {
        const ok = toFile ? await ch.toFile(values) : await ch.push(values);
        op += ` → ${s.last?.status ?? '—'}`;
        if (ok) {
          for (const k of keys) if (parsed(k, s.config.get(k)) !== parsed(k, intended[k])) return v('3-accepted-not-intended', `«${k}»: сервер принял не то, что хозяин видел в форме`);
        } else {
          for (const k of TABLES) if (parsed(k, s.config.get(k)) !== serverBefore[k]) return v('3-refused-wrote', `«${k}»: отказ, а живое сменилось`);
        }
      } else op += ' → отказ редактора';
    } else if (roll < 78) {
      const held = CROSS.filter((k) => s.rows.has(k));
      const k: Key = held.length && r.chance(0.8) ? r.pick(held) : r.pick(TABLES);
      s.failReads = r.chance(0.1) ? 1 : 0;   // сервер ушёл на перезапуск сразу после сброса
      const ok = await ch.reset(k);
      s.failReads = 0;
      op = `«Сбросить к дефолту» ${k} → ${s.last?.status ?? '—'}${ok ? '' : ' (не перечитано / отказ)'}`;
      if (ok) {
        intended[k] = JSON.parse(JSON.stringify(s.config.get(k as ConfigKey))) as unknown;
        if (parsed(k, data[k]) !== parsed(k, s.config.get(k as ConfigKey))) return v('3-reset', `«${k}»: форма после сброса — не таблица сервера`);
        const base = (live.body({ [k]: 0 })!.__baseRev as Record<string, string>)[k];
        if (base !== configRev(s.config.get(k as ConfigKey))) return v('3-reset', `«${k}»: база записи после сброса — не таблица сервера`);
      }
    } else if (roll < 92) {
      const k = r.pick(TABLES);
      const st = await s.otherTab(k, mutate(r, k, s.config.get(k as ConfigKey)));
      op = `другая вкладка пишет «${k}» → ${st}`;
    } else {
      await load();
      op = 'перезагрузка страницы редактора';
    }
    if (process.env.DM_FUZZ_TRACE) process.stderr.write(`seed ${seed} step ${step}: ${op}\n`);
    if (late.length) return v('2-post-not-live', late.join(' | '));
    for (const k of TABLES) if (JSON.stringify(data[k]) !== JSON.stringify(intended[k])) return v('1-copy', `«${k}»: рабочая копия сменилась мимо хозяина`);
  }
  return null;
}

describe('⭐ R22-08: фаззер «редактор ≡ сервер» — канал записи редактора над настоящими ручками', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => undefined); });
  afterEach(() => { vi.restoreAllMocks(); });

  it(`инварианты после каждого шага: ${SEEDS} сидов × ${OPS} шагов`, async () => {
    const found: Violation[] = [];
    for (let seed = FROM; seed < FROM + SEEDS; seed++) {
      const bad = await runSeed(seed);
      if (bad) found.push(bad);
    }
    expect(found).toEqual([]);
  }, Math.max(120_000, SEEDS * OPS * 3_000));   // шаг — две-три полные сборки конфига сервера (~0.2 с, под нагрузкой — кратно)

  it('самопроверка: прежний сброс (дефолты в форму и вкладкам игры до ответа сервера) ловится', async () => {
    let caught: Violation | null = null;
    for (let seed = 1; seed <= 20 && !caught; seed++) caught = await runSeed(seed, { legacyReset: true });
    if (process.env.DM_FUZZ_TRACE) process.stderr.write(JSON.stringify(caught) + '\n');
    expect(caught, 'фаззер обязан поймать сброс мимо ответа сервера').not.toBeNull();
    expect(caught!.inv).toMatch(/^(1-copy|2-post-not-live|3-)/);
  }, 240_000);

  it('самопроверка: прежняя проверка правила (над неприменёнными таблицами рабочей копии) ловится', async () => {
    let caught: Violation | null = null;
    for (let seed = 1; seed <= 20 && !caught; seed++) caught = await runSeed(seed, { legacyValidate: true });
    if (process.env.DM_FUZZ_TRACE) process.stderr.write(JSON.stringify(caught) + '\n');
    expect(caught, 'фаззер обязан поймать вердикт правила не над живым').not.toBeNull();
    expect(caught!.inv).toBe('4-verdict');
  }, 240_000);
});

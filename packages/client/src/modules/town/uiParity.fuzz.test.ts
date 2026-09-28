import { describe, it, expect, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import type { AccountStash, SaveState } from '@dm/shared';
import { genOps, runSeq, shrinkSeq, type Hit, type Op } from './uiParity.fuzzKit.js';

/**
 * ⭐ B3: ФАЗЗЕР ПАРИТЕТА «ОКНО ≡ СЕРВЕР» (города). Модель и инварианты — `uiParity.fuzzKit.ts`: случайные сейвы, сундуки, журналы,
 * прилавки и живые правки конфига; на каждом шаге-окне НАСТОЯЩИЕ окна клиента (верстак, окно ковки, эскизы, лавка, «Купить»
 * кузницы, меню инвентаря) говорят, что горит, почём и что выйдет, — и клик уходит НАСТОЯЩИМ `App` / `NetClient` в НАСТОЯЩУЮ
 * `Room.handleCmd` (мок базы ниже — маленькая честная база, как у `room.economyFuzz.test.ts`). Нарушение печатается с сидом и
 * СЖАТОЙ цепочкой шагов (выброшено всё, без чего оно не воспроизводится).
 *
 * Умолчание — 36 цепочек по 30 шагов (~10 с) на полный прогон. Больше — `DM_FUZZ_SEEDS=N` (с `DM_FUZZ_FROM` — первый сид, `DM_FUZZ_OPS`
 * — длина цепочки; 4 процесса по 600 цепочек параллельно — ~2.5 мин), сводка в файл — `DM_FUZZ_OUT`, без сжатия — `DM_FUZZ_SHRINK=0`,
 * сжимать и известные — `DM_FUZZ_SHRINK_KNOWN=1`, повтор одной цепочки — `DM_FUZZ_REPLAY='{"seed":N,"ops":[…]}'`, счётчики исходов
 * (горело/серое × исполнено/отказ, род отказа, строго/устаревший конфиг) — `DM_FUZZ_VERBOSE=1`. Найденное и не исправленное — в
 * `KNOWN` (главный прогон на нём не краснеет) и своим `it.fails` с минимальной цепочкой.
 */
const env = (k: string, d: number): number => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? Math.floor(v) : d; };
const BIG = !!process.env.DM_FUZZ_SEEDS;
const SEEDS = env('DM_FUZZ_SEEDS', 36);
const FROM = env('DM_FUZZ_FROM', 1);
const LEN = env('DM_FUZZ_OPS', 30);
const SHRINK = process.env.DM_FUZZ_SHRINK !== '0';
const SHRINK_KNOWN = process.env.DM_FUZZ_SHRINK_KNOWN === '1';

// Большой прогон — потолок по числу цепочек (до ~1 с на цепочку под нагрузкой, сжатие — ещё до сотни прогонов на нарушение).
vi.setConfig({ testTimeout: Math.max(300_000, SEEDS * LEN * 60 + 600_000) });

const db = vi.hoisted(() => ({
  saves: new Map<string, number>(),
  data: new Map<string, SaveState>(),
  stashes: new Map<string, { data: AccountStash; version: number }>(),
}));
/** Бросок сервера (`townRng` сеется `randomInt`) — от сида цепочки: иначе сжатие не воспроизводило бы выход разбора и бросок ковки. */
const cryptoHook = vi.hoisted(() => ({ randomInt: undefined as undefined | ((a: number, b: number) => number) }));
vi.mock('node:crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:crypto')>();
  const randomInt = ((a: number, b?: number, cb?: unknown) => (cryptoHook.randomInt && typeof b === 'number' && cb === undefined
    ? cryptoHook.randomInt(a, b) : (real.randomInt as (...x: unknown[]) => number)(a, b, cb))) as typeof real.randomInt;
  return { ...real, default: { ...real, randomInt }, randomInt };
});
vi.mock('../../../../server/src/db/db.js', () => ({
  putCharacter: (charId: string, _u: string, data: SaveState, v: number) => {
    if (v !== (db.saves.get(charId) ?? 1)) return Promise.resolve(null);
    db.saves.set(charId, v + 1);
    db.data.set(charId, structuredClone(data));
    return Promise.resolve(v + 1);
  },
  putCharacterWithStash: (charId: string, userId: string, data: SaveState, v: number, stash: AccountStash, sv: number) => {
    if (v !== (db.saves.get(charId) ?? 1)) return Promise.resolve({ ok: false, conflict: 'save' });
    if (sv !== (db.stashes.get(userId)?.version ?? 0)) return Promise.resolve({ ok: false, conflict: 'stash' });
    db.saves.set(charId, v + 1);
    db.data.set(charId, structuredClone(data));
    db.stashes.set(userId, { data: structuredClone(stash), version: sv + 1 });
    return Promise.resolve({ ok: true, version: v + 1, stashVersion: sv + 1 });
  },
  createCharacter: () => Promise.resolve(1),
  getCharacter: () => Promise.resolve(null),
  getAccountStash: (userId: string) => {
    const row = db.stashes.get(userId);
    return Promise.resolve(row ? { data: structuredClone(row.data), version: row.version } : null);
  },
  putAccountStash: () => Promise.resolve(),
  getRunLedger: () => Promise.resolve([]),
  mergeRunLedger: () => Promise.resolve(),
  landedVersion: () => Promise.resolve(null),
}));
vi.mock('../../../../server/src/db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));

/**
 * ИЗВЕСТНЫЕ НАРУШЕНИЯ — ждут правки продукта (шаг правки). У каждого: образец ключа (главный прогон на нём не краснеет) и
 * минимальная цепочка, сжатая фаззером, — свой `it.fails` ниже: он «проходит», пока нарушение воспроизводится. После правки
 * `it.fails` покраснеет — тогда строку убрать отсюда, а тест перевести в `it` (он станет сторожем правки).
 */
interface Known { id: string; key: RegExp; what: string; repro: { seed: number; ops: Op[]; key: RegExp }[] }
const op = (k: Op['k'], s: number): Op => ({ k, s });
const KNOWN: Known[] = [];
const knownOf = (key: string): string | undefined => KNOWN.find((k) => k.key.test(key))?.id;

/**
 * ПОПРАВЛЕННЫЕ — те же минимальные цепочки, но обычным `it`: сторожа правки (главный прогон их ключи больше не прощает).
 */
const FIXED: Known[] = [
  {
    // Шов: `describeItem` — строка «Одной рукой» у предпросмотра вилкой по краям (`formulas/versatile.test.ts`).
    id: 'V-B3-01', key: /^(stale:)?range:craft-line:Одной рукой/,
    what: 'предпросмотр ковки полуторного оружия показывает «Одной рукой (со щитом)» вилкой, и скованная вещь в неё попадает',
    repro: [{ seed: 11430, ops: [op('fund', 1691763237), op('craft', 96317549)], key: /^range:craft-line:Одной рукой/ }],
  },
  {
    // Шов: `canBuy` — золото и место одним ответом для `buyItem` и ценника прилавка (лавка, «Купить» кузницы).
    id: 'V-B3-02', key: /^parity:enabled-refused:buy:space$/,
    what: 'прилавок: ценник «по карману» не смотрел на место в сумке — сервер отказывал «Нет места»',
    repro: [
      { seed: 11951, ops: [op('buy', 1039315961)], key: /^parity:enabled-refused:buy:space$/ },
      { seed: 1013, ops: [op('bagFill', 33933805), op('buy', 1710536177)], key: /^parity:enabled-refused:buy:space$/ },
    ],
  },
  {
    // Шов: `craftFits` — место ПОСЛЕ списания сырья одним ответом для `craftAction` и «Ковать» (сумка хозяина `CraftHost.bag`).
    id: 'V-B3-03', key: /^parity:enabled-refused:craft:space$/,
    what: 'окно ковки: «Ковать» горела при полной сумке — сервер отказывал «Нет места в сумке»',
    repro: [
      { seed: 10024, ops: [op('bagFill', 644189836), op('craft', 1325763302)], key: /^parity:enabled-refused:craft:space$/ },
      { seed: 11309, ops: [op('fund', 1438648595), op('craft', 1968629355)], key: /^parity:enabled-refused:craft:space$/ },
    ],
  },
  {
    // Шов: `fieldSalvageFits` — место по ЛУЧШЕМУ броску одним ответом для `fieldSalvage` и меню инвентаря.
    id: 'V-B3-04', key: /^parity:(enabled-refused:field:space|disabled-accepted:field)$/,
    what: 'меню инвентаря: «Разобрать здесь» предлагалось (со всеми вопросами), когда сырьё не влезет, — сервер отказывал «Сумка полна»',
    repro: [
      { seed: 12427, ops: [op('lootCrafted', 1233428131), op('fund', 1403730367), op('buy', 249656795), op('lootCrafted', 1453575374), op('field', 943540528)], key: /^parity:enabled-refused:field:space$/ },
      { seed: 1246, ops: [op('lootCrafted', 2119327025), op('bagFill', 1889245316), op('field', 1171421451)], key: /^parity:enabled-refused:field:space$/ },
    ],
  },
  {
    // Шов: строка эскиза окна — ровно `sketchable` сервера; форма закрытого здесь типа — с подсказкой, где ковать (`sketchElsewhere`).
    id: 'V-B3-05', key: /^parity:(disabled-accepted|enabled-refused):sketch/,
    what: 'эскизы: ключевая форма под 🔒 в одном семействе (его база закрыта), а сервер открывал её эскизом — та же форма ключ открытой базы другого хвата',
    repro: [{ seed: 10015, ops: [op('sketch', 40400573)], key: /^parity:disabled-accepted:sketch:locked$/ }],
  },
  {
    // Шов: `defaultParts` → null обрабатывают `initialCraftState` / `normalizeCraftState` (пустые гнёзда), окно — «Кузнец сейчас не куёт…».
    id: 'V-B3-06', key: /^ui-throw:craftWindow/,
    what: 'окно ковки падало (TypeError), если в конфиге выключены все варианты одного гнезда класса (`defaultParts` → null)',
    repro: [
      { seed: 10167, ops: [op('config', 1631806960), op('craft', 971281953)], key: /^ui-throw:craftWindow:Cannot read properties of null/ },
      { seed: 12206, ops: [op('config', 887772969), op('windowEnchant', 1823580486)], key: /^ui-throw:craftWindow:enchant:Cannot read properties of null/ },
      { seed: 10167, ops: [op('config', 1631806960), op('sketch', 1104816907)], key: /^ui-throw:craftWindow:sketch:Cannot read properties of null/ },
    ],
  },
  {
    // Шов: согласие на конфиг — `cfgRev` команд кузницы, скупки и разбора (`App.sendCmd` → `Room.runCmd` → `configChanged`).
    id: 'V-B3-07', key: /^stale:/,
    what: 'устаревший конфиг клиента: команда кузницы отказана «Цена изменилась» до исполнения, клиент перечитывает конфиг — исход не расходится с показанным',
    repro: [
      { seed: 11410, ops: [op('config', 483653893), op('fund', 998687216), op('craft', 1864701636)], key: /^stale:range:craft-hit$/ },
      { seed: 11995, ops: [op('fund', 1313658462), op('config', 691501595), op('craft', 1841287644)], key: /^stale:range:craft-req$/ },
      { seed: 11890, ops: [op('config', 949550270), op('windowEnchant', 1117953636)], key: /^stale:enabled-refused:windowEnchant:closed$/ },
    ],
  },
];

interface Found { seed: number; ops: Op[]; hit: Hit }

async function report(found: Map<string, Found>): Promise<string[]> {
  const lines: string[] = [];
  for (const [key, f] of found) {
    const known = knownOf(key);
    let ops = f.ops.slice(0, f.hit.at + 1);
    let log = f.hit.log;
    let msg = f.hit.msg;
    if (SHRINK && (!known || SHRINK_KNOWN)) {
      const s = await shrinkSeq(db, cryptoHook, f.seed, f.ops, key);
      if (s.out.hits.length) {
        ops = s.ops;
        const h = s.out.hits.find((x) => x.key === key)!;
        log = s.out.log;
        msg = h.msg;
      }
    }
    lines.push([
      `✗ ${key}${known ? ` (известное ${known})` : ''} — сид ${f.seed}, шагов в сжатой цепочке ${ops.length}`,
      `  ${msg}`,
      `  повтор: DM_FUZZ_REPLAY='${JSON.stringify({ seed: f.seed, ops })}'`,
      ...log.map((l) => `    ${l}`),
    ].join('\n'));
  }
  return lines;
}

describe.skipIf(!!process.env.DM_FUZZ_REPLAY)('⭐ B3: паритет «окно ≡ сервер» — верстак, ковка, эскизы, лавка, разбор в поле', () => {
  it(`${SEEDS} цепочек по ${LEN} шагов (сиды ${FROM}…${FROM + SEEDS - 1})`, async () => {
    const found = new Map<string, Found>();
    const stats: Record<string, number> = {};
    const t0 = Date.now();
    for (let seed = FROM; seed < FROM + SEEDS; seed++) {
      const ops = genOps(seed, LEN);
      const out = await runSeq(db, cryptoHook, seed, ops);
      for (const [k, v] of Object.entries(out.stats)) stats[k] = (stats[k] ?? 0) + v;
      for (const h of out.hits) if (!found.has(h.key)) found.set(h.key, { seed, ops, hit: h });
      if (BIG && (seed - FROM + 1) % 100 === 0) console.log(`[B3] ${seed - FROM + 1}/${SEEDS} цепочек, ${Math.round((Date.now() - t0) / 1000)} с, нарушений ${found.size}`);
    }
    const lines = await report(found);
    // Известные печатаются только в большом прогоне и по `DM_FUZZ_VERBOSE`: в полном прогоне тестов их цепочки — `it.fails` ниже.
    const shown = BIG || process.env.DM_FUZZ_VERBOSE ? lines : lines.filter((l) => !l.split('\n')[0]!.includes('(известное V-'));
    if (shown.length) console.log(shown.join('\n\n'));
    if (process.env.DM_FUZZ_VERBOSE) console.log(Object.entries(stats).sort().map(([k, v]) => `${k.padEnd(34)} ${v}`).join('\n'));
    if (process.env.DM_FUZZ_OUT) {
      writeFileSync(process.env.DM_FUZZ_OUT, JSON.stringify({ from: FROM, seeds: SEEDS, len: LEN, stats, found: [...found.entries()].map(([k, f]) => ({ key: k, seed: f.seed, at: f.hit.at, msg: f.hit.msg, log: f.hit.log })) }, null, 1));
    }
    // Свойство не пустое: окна не только гаснут — сервер реально исполняет горящее.
    const sum = (re: RegExp): number => Object.entries(stats).filter(([k]) => re.test(k)).reduce((n, [, v]) => n + v, 0);
    expect(sum(/^bench:.*:on:ok$/), 'верстак: исполненные карточки').toBeGreaterThan(SEEDS);
    expect(sum(/^craft:on:ok$/), 'ковка: скованные вещи').toBeGreaterThan(0);
    expect(sum(/^(buy|sell):on:ok$/), 'лавка: сделки').toBeGreaterThan(SEEDS / 2);
    const unknown = [...found.keys()].filter((k) => !knownOf(k));
    expect(unknown, shown.join('\n\n')).toEqual([]);
  });
});

/**
 * Известные нарушения — минимальные цепочки фаззера. `it.fails`: зелёный, пока нарушение воспроизводится (см. `KNOWN`).
 * Список пуст (всё поправлено) — блока нет: пустой `describe` vitest считает ошибкой («No test found in suite»).
 */
if (KNOWN.length) describe.skipIf(!!process.env.DM_FUZZ_REPLAY || BIG)('B3: известные нарушения воспроизводятся (ждут правки)', () => {
  for (const k of KNOWN) {
    for (const [i, r] of k.repro.entries()) {
      it.fails(`${k.id}${k.repro.length > 1 ? `.${i + 1}` : ''}: ${k.what}`, async () => {
        const out = await runSeq(db, cryptoHook, r.seed, r.ops);
        expect(out.hits.filter((h) => r.key.test(h.key)).map((h) => `${h.key}: ${h.msg}`), out.log.join(' ⏎ ')).toEqual([]);
      });
    }
  }
});

/** Поправленные нарушения — их минимальные цепочки больше не воспроизводят нарушение (см. `FIXED`). */
describe.skipIf(!!process.env.DM_FUZZ_REPLAY || BIG)('B3: поправленные нарушения не возвращаются', () => {
  for (const k of FIXED) {
    for (const [i, r] of k.repro.entries()) {
      it(`${k.id}${k.repro.length > 1 ? `.${i + 1}` : ''}: ${k.what}`, async () => {
        const out = await runSeq(db, cryptoHook, r.seed, r.ops);
        expect(out.hits.filter((h) => k.key.test(h.key)).map((h) => `${h.key}: ${h.msg}`), out.log.join(' ⏎ ')).toEqual([]);
      });
    }
  }
});

describe.runIf(!!process.env.DM_FUZZ_REPLAY)('B3: повтор цепочки', () => {
  it('DM_FUZZ_REPLAY', async () => {
    const { seed, ops } = JSON.parse(process.env.DM_FUZZ_REPLAY!) as { seed: number; ops: Op[] };
    const out = await runSeq(db, cryptoHook, seed, ops);
    console.log(out.log.join('\n'));
    for (const h of out.hits) console.log(`✗ ${h.key} на шаге ${h.at}: ${h.msg}`);
  });
});

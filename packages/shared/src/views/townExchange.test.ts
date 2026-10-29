/**
 * Вид «⇄ Обмен» ⇄ эталон вкладки Unity (`__fixtures__/unity_exchange.json` — заморожен из `Assets/DM/UI/Tests/unity_exchange_golden.json`
 * HEAD Unity-репо, ExchangeCheck.cs; генерил его `tools/unity-check/exchange_golden.mts` кодом веба): реестр каждого из конфигов эталона —
 * из его снимка, модель вкладки на каждом выборе — до буквы, `defaultGive`.
 * ⭐ С-аудит (29.10): эталона нет — тест ПАДАЕТ (раньше `describe.skipIf` молча пропускал все случаи, и правка обмена проходила `npm test`).
 * ⚠ ОТКЛОНЕНИЕ (сервер ≠ эталон): конфиг `odd` (курс 5 → 3, золото за сорт `[7, 0, 1]`) схема сервера НЕ ПРИНИМАЕТ (`goldPerUnit` — ровно пять
 * чисел ≥ 1): сервер с ним не стартует и правку из редактора отвергает — у игрока такого окна не бывает. Его кейсы не сверяются; что реестр
 * его отвергает — проверено явно.
 */
import { describe, it, expect } from 'vitest';
import type { Item, SaveState } from '../types/index.js';
import { GOLDEN, readGolden, registryFromGolden } from './town.testkit.js';
import { exchangeDefaultGive, exchangeModel, exchangeView } from './town.js';

type Golden = {
  config: Record<string, Record<string, unknown>>;
  stocks: Record<string, Record<string, { inv: Item[]; wallet: Record<string, number>; gold: number }>>;
  defaultGive: { cfg: string; have: number; out: number }[];
  cases: { cfg: string; stock: string; sel: { from: string | null; to: string | null; n: number | null }; out: Record<string, unknown> }[];
};
const g = readGolden<Golden>(GOLDEN.exchange);
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
/** Конфиги эталона, которых сервер не примет (схема `balance`). */
const SERVER_REJECTS = new Set(['odd']);

describe('вид «⇄ Обмен» ⇄ unity_exchange.json', () => {
  it('эталон на месте', () => {
    expect(g, `эталон обмена: ${GOLDEN.exchange}`).not.toBeNull();
  });
  if (!g) return;
  const regs = new Map(Object.entries(g.config).filter(([name]) => !SERVER_REJECTS.has(name)).map(([name, cfg]) => [name, registryFromGolden(cfg)]));

  it('конфиг, которого сервер не примет, отвергнут реестром (его кейсы — не сверяются)', () => {
    for (const name of SERVER_REJECTS) expect(() => registryFromGolden(g!.config[name]!), name).toThrow(/balance/);
    const skipped = g!.cases.filter((c) => SERVER_REJECTS.has(c.cfg)).length + g!.defaultGive.filter((c) => SERVER_REJECTS.has(c.cfg)).length;
    expect(skipped).toBeGreaterThan(0);
  });

  it('defaultGive', () => {
    for (const c of g!.defaultGive) {
      const reg = regs.get(c.cfg);
      if (reg) expect(exchangeDefaultGive(reg, c.have), `${c.cfg} есть ${c.have}`).toBe(c.out);
    }
  });

  it('модель вкладки на каждом выборе', () => {
    let n = 0;
    for (const c of g!.cases) {
      const reg = regs.get(c.cfg);
      if (!reg) continue;
      const s = g!.stocks[c.cfg]![c.stock]!;
      // n: null эталона — NaN C# (`D(null)`), у вида — «задано, но не число» → 0, как у веба; `undefined` — «только что выбрал» (начальное).
      const sel = { from: c.sel.from, to: c.sel.to, n: c.sel.n === null ? Number.NaN : c.sel.n };
      expect(json(exchangeModel(reg, s.inv, s.wallet, s.gold, sel)), `[${c.cfg}/${c.stock}] ${JSON.stringify(c.sel)}`).toEqual(c.out);
      n++;
    }
    expect(n).toBeGreaterThan(600);
  });

  it('выбор без «сколько» — начальное `defaultGive` стопки; вид героя = модель по сейву и сундуку', () => {
    const reg = regs.get('live')!;
    const s = g!.stocks.live!.mixed!;
    const save = { inventory: s.inv, gold: s.gold } as unknown as SaveState;
    const first = exchangeView(reg, save, { materials: s.wallet }, { from: null, to: null });
    const src = first.sources[0]!;
    const picked = exchangeView(reg, save, { materials: s.wallet }, { from: src.id, to: null });
    expect(picked.n).toBe(Math.min(src.have, exchangeDefaultGive(reg, src.have)));
    expect(json(picked)).toEqual(json(exchangeModel(reg, s.inv, s.wallet, s.gold, { from: src.id, to: null, n: exchangeDefaultGive(reg, src.have) })));
  });
});

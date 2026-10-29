/**
 * Виды города ⇄ эталон карточки разбора Unity (`unity_salvage.json`, SalvagePreviewCheck.cs) и раздел `bench` эталона статов
 * (`unity_stats.json`, StatsCheck.cs): реестр — из снимка `config`.
 *  • `cases` — карточка разбора у кузнеца и в поле в девяти журналах (её строки — в карточке «♻ Разобрать» верстака и подсказке пункта
 *    «Разобрать здесь»: `fieldSalvageLines` сверяется с той же карточкой эталона), строка происхождения подсказки вещи (`itemTipView`);
 *  • `exchange` — цели и расчёт обмена (ядро вида «⇄ Обмен»);
 *  • `bench` (статы) — предпросмотр верстака: подпись, строки «было → станет», цель и поднятая вещь.
 */
import { describe, it, expect } from 'vitest';
import type { Item } from '../types/index.js';
import { emptyJournal, fullJournal, type CraftJournal } from '../formulas/craft.js';
import { salvagePreview, type SalvageCard } from '../economy/salvagePreview.js';
import { exchangeQuote, exchangeTargets } from '../economy/exchange.js';
import { upgradedItem } from '../economy/townActions.js';
import { GOLDEN, readGolden, registryFromGolden } from './town.testkit.js';
import { benchPreview, benchTarget, fieldSalvageLines, itemTipView, type TipLine } from './town.js';

type SalvageGolden = {
  config: Record<string, unknown>;
  cases: { item: Item; parts: Record<string, { id: string }> | null; type: { id: string | null } | null; tierIndex: number; origin: string | null;
    journals: { name: string; smith: SalvageCard; field: SalvageCard }[] }[];
  exchange: { targets: { from: string; out: unknown }[]; quotes: { from: string; to: string; n: number; have?: Record<string, number>; gold?: number; out: unknown }[] };
};
type StatsGolden = { config: Record<string, unknown>; bench: { item: Item; label: string; rows: { was: string; will: string }[]; target: Item | null; upgraded: Item | null }[] };
const sg = readGolden<SalvageGolden>(GOLDEN.salvage);
const st = readGolden<StatsGolden>(GOLDEN.stats);
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Подсказка пункта «Разобрать здесь» из карточки поля эталона — по правилу `fieldSalvageLines` (без отказа «сумка полна»). */
function linesOfCard(c: SalvageCard): TipLine[] {
  const no = `${c.verb === 'melt' ? 'Переплавить' : 'Разобрать'} нельзя`;
  if (!c.ok) return [{ text: no, tone: 'title' }, { text: c.reason ?? 'нельзя', tone: 'warn' }];
  const l = (x: { label: string; text: string; tone: TipLine['tone'] }): TipLine => ({ text: `${x.label}: ${x.text}`, tone: x.tone });
  return [{ text: c.title, tone: 'title' }, l(c.materials), l(c.essence), ...(c.catalog ? [l(c.catalog)] : []), ...(c.sketch ? [l(c.sketch)] : []),
    ...(c.hint ? [{ text: c.hint[0]!.toUpperCase() + c.hint.slice(1), tone: 'hint' as const }] : [])];
}

describe.skipIf(!sg)('виды города ⇄ unity_salvage.json', () => {
  const reg = registryFromGolden(sg!.config);
  const full = fullJournal(reg);
  const sketchAfter = reg.get('balance').craft.journal.sketchAfter;
  const journalFor = (c: SalvageGolden['cases'][number], name: string): CraftJournal | null => {
    if (name === 'null') return null;
    if (name === 'empty') return emptyJournal();
    const variants = ['strike', 'grip', 'bind', 'head'].map((s) => c.parts![s]!.id);
    const types = c.type?.id ? [c.type.id] : [];
    const known: CraftJournal = { ...emptyJournal(), bases: [c.item.baseId], variants, tierHi: c.tierIndex, typesSeen: types };
    const all: CraftJournal = { ...full, typesSeen: types };
    const base = reg.get('items.base').find((b) => b.id === c.item.baseId);
    const sk = base?.kind === 'weapon' ? { [base.weaponClass]: sketchAfter - 1 } : {};
    const t: Record<string, CraftJournal> = {
      known, 'no-variant': { ...known, variants: variants.slice(1) }, 'no-base': { ...known, bases: [] }, all,
      'all-gate': { ...all, mythic: 0 }, sketch: { ...known, classSalvages: sk }, 'sketch-all': { ...all, classSalvages: sk },
    };
    return t[name]!;
  };

  it('карточка разбора у кузнеца и в поле; подсказка пункта «Разобрать здесь»; строка происхождения', () => {
    let n = 0;
    for (const c of sg!.cases) {
      expect(itemTipView(reg, c.item).origin, `${c.item.uid} origin`).toBe(c.origin);
      for (const j of c.journals) {
        const journal = journalFor(c, j.name);
        const who = `${c.item.uid} [${j.name}]`;
        expect(json(salvagePreview(reg, c.item, journal, false)), `${who} smith`).toEqual(j.smith);
        expect(json(salvagePreview(reg, c.item, journal, true)), `${who} field`).toEqual(j.field);
        expect(fieldSalvageLines(reg, c.item, journal), `${who} tip`).toEqual(linesOfCard(j.field));
        n++;
      }
    }
    expect(n).toBeGreaterThan(300);
  });

  it('обмен: цели и расчёт (ядро вида «⇄ Обмен»)', () => {
    for (const t of sg!.exchange.targets) expect(json(exchangeTargets(reg, t.from)), t.from).toEqual(t.out);
    for (const q of sg!.exchange.quotes) expect(json(exchangeQuote(reg, q.from, q.to, q.n, q.have, q.gold)), `${q.from}→${q.to}×${q.n}`).toEqual(q.out);
  });
});

describe.skipIf(!st)('виды города ⇄ unity_stats.json · bench', () => {
  const reg = registryFromGolden(st!.config);
  it('предпросмотр верстака: подпись, «было → станет», цель, поднятая вещь', () => {
    for (const x of st!.bench) {
      const who = `${x.item.uid} «${x.item.name}»`;
      const p = benchPreview(reg, x.item);
      expect(p.label, `${who} label`).toBe(x.label);
      expect(p.rows, `${who} rows`).toEqual(x.rows);
      expect(json(benchTarget(reg, x.item) ?? null), `${who} target`).toEqual(x.target);
      expect(json(upgradedItem(reg, x.item) ?? null), `${who} upgraded`).toEqual(x.upgraded);
    }
    expect(st!.bench.filter((b) => b.rows.length).length).toBeGreaterThan(20);
  });
});

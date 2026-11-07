import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { defaultConfigData } from '../config/defaults.js';
import { CYRILLIC, pseudoLocales, withTextLang } from '../i18n/index.js';
import { unityViewsSample } from './unityViews.testkit.js';
import { compareTable, compareView } from './heroCard.js';
import { questsView } from './townHero.js';
import { runReforgeHead, runReforgeView } from './runReforge.js';
import { craftView, initialCraftState } from './craft.js';
import { fullJournal } from '../formulas/craft.js';
import type { SheetBlock, SheetRow } from './hero.js';
import type { QuestProgress } from '../types/quest.js';

/**
 * ⭐ i18n (07.11, хвосты Ф1): МАШИННЫЕ ПОЛЯ ВИДОВ ВМЕСТО СРАВНЕНИЯ ТЕКСТА В UNITY. Окна Unity решали по русскому тексту модели: блок «Защита»
 * и «Атрибуты…», строка пула по подписи, полоса по «▮N%», её цвет по подписи («Огонь», «Опыт»), «+Δ» по ведущему «+», задание по слову
 * «выполнено», строка «В сумке …», имя детали без «✦ » / «🔒 », оговорка и предупреждение по «⚠». Сторож двух свойств:
 *  1. на РУССКОМ образце (эталон окон) каждое поле говорит РОВНО то, что выводило из текста прежнее правило Unity, — окно, перешедшее на
 *     поле, рисует то же, что рисовало;
 *  2. поле НЕ ЗАВИСИТ ОТ ЯЗЫКА: на псевдоязыке (ни одной кириллической буквы в тексте) — те же значения, а текстовое правило уже врёт.
 */
const cfg = new ConfigRegistry();
cfg.loadAll();
const xxCfg = new ConfigRegistry();
xxCfg.loadAll();
xxCfg.reload({ locales: pseudoLocales(xxCfg.get('locales'), defaultConfigData) });

const ru = unityViewsSample(cfg);
const xx = withTextLang(xxCfg.get('locales'), 'xx', () => unityViewsSample(xxCfg));

// ── прежние правила Unity (CharacterPanel / QuestsPanel / StashPanel / CraftPanel / SealReforgeView), по тексту ──
const POOL_LABELS = ['Здоровье', 'Мана', 'Выносливость'];
const BAR_TONE: Record<string, string> = { Здоровье: 'hp', Мана: 'mana', Выносливость: 'stamina', Опыт: 'xp', Огонь: 'fire', Холод: 'cold', Молния: 'lightning', Яд: 'poison' };
/** `CharacterPanel.PoolOf`. */
function unityPool(b: SheetBlock, r: SheetRow): number {
  const c = r.cells;
  const bars = b.title == null && c.length > 1 && c[c.length - 1]!.startsWith('▮');
  if (!bars && b.title !== 'Защита') return -1;
  return POOL_LABELS.indexOf(c[0] ?? '');
}
/** `CharacterPanel.DrawRow`: ячейка полосы, её доля и цвет; «+Δ» — не первая ячейка значения с «+». */
function unityRow(r: SheetRow): { bar: number; pct: number; tone: string; delta: number } {
  const c = r.cells;
  if (c.length === 1) return { bar: -1, pct: 0, tone: '', delta: -1 };
  const bar = c.findIndex((x) => x.startsWith('▮'));
  const vals = c.map((x, i) => ({ x, i })).slice(1).filter((v) => v.i !== bar);
  const d = vals.findIndex((v, k) => k > 0 && v.x.startsWith('+'));
  return { bar, pct: bar >= 0 ? Number(c[bar]!.slice(1).replace(/%$/, '')) : 0, tone: bar >= 0 ? BAR_TONE[c[0]!] ?? 'poise' : '', delta: d >= 0 ? vals[d]!.i : -1 };
}

type Sample = typeof ru.out;
const sheets = (o: Sample): SheetBlock[][] => [o.sheet.blocks, o.sheetPending.blocks];
/** Все машинные поля образца — по путям (то, что Unity читает вместо текста). */
function machine(o: Sample): Record<string, unknown> {
  const m: Record<string, unknown> = {};
  sheets(o).forEach((bs, s) => bs.forEach((b, i) => {
    m[`sheet${s}/${i}/id`] = b.id;
    b.rows.forEach((r, k) => { m[`sheet${s}/${i}/${k}`] = { pool: r.pool, bar: r.bar, delta: r.delta }; });
  }));
  for (const part of ['active', 'board'] as const) o.town.quests[part].forEach((q, i) => { m[`quest/${part}/${i}`] = q.state; });
  o.town.materials.rows.forEach((r, i) => r.cells.forEach((c, k) => { if (c) m[`mat/${i}/${k}`] = c.tipBag; }));
  m['mat/essence'] = o.town.materials.essence?.tipBag;
  for (const v of ['plain', 'crafted'] as const) {
    (o.craft[v].slots as { rows: { id?: string; name?: string }[] }[]).forEach((sl, i) => sl.rows.forEach((r, k) => { m[`craft/${v}/${i}/${k}`] = r.name !== undefined; }));   // имя детали — текст языка; поле есть у тех же строк
  }
  m['reforge/sourceWarn'] = o.run.reforge.sourceWarn;
  return m;
}

describe('⭐ i18n (07.11): машинные поля видов ≡ прежние правила Unity по русскому тексту, и не зависят от языка', () => {
  it('⭐ лист героя: `id` блока, `pool`, `bar` (ячейка, доля, тон), `delta` — ровно то, что Unity выводил из текста', () => {
    const bad: string[] = [];
    for (const bs of sheets(ru.out)) {
      for (const b of bs) {
        if ((b.id === 'defense') !== (b.title === 'Защита')) bad.push(`блок ${b.id}: «Защита»`);
        if ((b.id === 'attributes') !== (b.title?.startsWith('Атрибуты') ?? false)) bad.push(`блок ${b.id}: «Атрибуты»`);
        for (const r of b.rows) {
          const u = unityRow(r), p = unityPool(b, r);
          if ((r.pool ?? -1) !== p) bad.push(`${b.id} «${r.cells[0]}»: pool ${r.pool} ≠ ${p}`);
          if ((r.bar?.cell ?? -1) !== u.bar || (r.bar && (r.bar.pct !== u.pct || r.bar.tone !== u.tone))) bad.push(`${b.id} «${r.cells[0]}»: bar ${JSON.stringify(r.bar)} ≠ ${JSON.stringify(u)}`);
          if ((r.delta ?? -1) !== u.delta) bad.push(`${b.id} «${r.cells[0]}»: delta ${r.delta} ≠ ${u.delta}`);
        }
      }
    }
    expect(bad).toEqual([]);
    const ids = ru.out.sheet.blocks.map((b) => b.id);
    expect(new Set(ids).size, 'id блока — один на блок').toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(['head', 'bars', 'power', 'attributes', 'offense', 'defense', 'resistances', 'ailments', 'other']));
    expect(ru.out.sheetPending.blocks.some((b) => b.rows.some((r) => r.delta !== undefined)), 'превью набранных очков — с «+Δ»').toBe(true);
  });

  it('⭐ журнал заданий, сырьё, ковка, перековка: `state`, `tipBag`, `name`, `sourceWarn` — как прежнее правило по тексту', () => {
    for (const part of ['active', 'board'] as const) {
      for (const q of ru.out.town.quests[part]) expect(q.state === 'completed', q.questId).toBe(q.status === 'выполнено');
    }
    const cells = [...ru.out.town.materials.rows.flatMap((r) => r.cells), ru.out.town.materials.essence].filter((c): c is NonNullable<typeof c> => !!c);
    for (const c of cells) expect(c.tipBag, c.id).toBe(c.tip.findIndex((l, i) => i > 0 && l.startsWith('В сумке ')));
    expect(cells.some((c) => c.tipBag > 0), 'образец несёт сырьё в сумке').toBe(true);
    for (const v of ['plain', 'crafted'] as const) {
      for (const r of (ru.out.craft[v].slots as { rows: { head?: string; text?: string; name?: string }[] }[]).flatMap((s) => s.rows)) {
        if (r.head !== undefined) { expect(r.name).toBeUndefined(); continue; }
        const strip = (t: string): string => (['✦ ', '🔒 '].find((p) => t.startsWith(p)) ? t.slice(t.indexOf(' ') + 1) : t);
        expect(r.name, r.text).toBe(strip(r.text!));
      }
    }
    for (const loaded of [true, false]) {
      const h = runReforgeHead(cfg, runReforgeView(cfg, ru.save, loaded ? ru.stash : null), loaded);
      expect(h.sourceWarn).toBe(h.source?.startsWith('⚠') ?? false);
    }
    // журнал с выполненным заданием — «выполнено» и `completed`
    const save = structuredClone(ru.save);
    const q = save.quests[0] as QuestProgress | undefined;
    if (q) {
      q.status = 'completed';
      const e = questsView(save, ru.board, cfg).active.find((x) => x.questId === q.questId)!;
      expect([e.status, e.state, e.canTurnIn]).toEqual(['выполнено', 'completed', true]);
    }
  });

  it('⭐ «в руках → скую»: оговорка (`note: true`) — ровно строка во всю ширину с «⚠»; раздел — без поля', () => {
    const v = compareView(cfg, ru.save, ru.weapon, {});
    const card = { ...v.b, status: { ...(v.b.status ?? { kind: 'bleed', name: 'Кровотечение', chance: 0.9, avgStacks: 1, maxStacks: 3 }), capped: true } };
    const rows = compareTable(v.a, card as typeof v.b, 'A', 'B', ru.save);
    const notes = rows.filter((r) => r.note);
    expect(notes.length).toBe(1);
    for (const r of rows) expect(r.note === true, r.cells.join('|')).toBe(r.cells.length === 1 && r.cells[0]!.startsWith('⚠'));
  });

  it('⭐ i18n Ф3: итог ковки (`left.message.bad`) — флагом того, кто пишет итог (`messageBad`), а не по «Не» в начале текста', () => {
    const msg = (message: string, messageBad: boolean) => craftView(cfg, {
      st: { ...initialCraftState(cfg, 'sword'), message, messageBad }, journal: fullJournal(cfg), wallet: {}, gold: 0, bag: null, sketch: false,
    }).left.message;
    expect(msg('', true), 'итога нет — поля нет (так у сервера всегда)').toBeNull();
    expect(msg('Не вышло: нет места', true)).toEqual({ text: 'Не вышло: нет места', bad: true });
    expect(msg('Forge failed: no room', true), 'прежнее правило по тексту дало бы «удачу»').toEqual({ text: 'Forge failed: no room', bad: true });
    expect(msg('Надето', false)).toEqual({ text: 'Надето', bad: false });
    expect(ru.out.craft.plain.left.message, 'эталон окон: итога нет').toBeNull();
  });

  it('⭐⭐ поля НЕ ЗАВИСЯТ ОТ ЯЗЫКА: на псевдоязыке — те же значения, а текст уже без кириллицы (текстовое правило соврало бы)', () => {
    expect(machine(xx.out)).toEqual(machine(ru.out));
    const def = xx.out.sheet.blocks.find((b) => b.id === 'defense')!;
    expect(def.title).not.toBe('Защита');
    expect(def.title).not.toMatch(CYRILLIC);
    const hp = def.rows.find((r) => r.pool === 0)!;
    expect(POOL_LABELS.includes(hp.cells[0]!), 'подпись пула на другом языке — не из PoolLabels').toBe(false);
    const done = withTextLang(xxCfg.get('locales'), 'xx', () => {
      const save = structuredClone(xx.save);
      const q = save.quests[0];
      if (q) q.status = 'completed';
      return questsView(save, xx.board, xxCfg).active[0];
    });
    if (done) expect([done.state, done.status === 'выполнено']).toEqual(['completed', false]);
  });
});

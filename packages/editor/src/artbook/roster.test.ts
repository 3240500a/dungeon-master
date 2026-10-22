import { describe, it, expect } from 'vitest';
import cryptJson from './seed/crypt.json';
import { loadRoster, loadRosterIndex, type CryptDraft, type RosterIndex, type RosterV2 } from './seed.js';
import {
  armorMix, entryMech, fmtMult, mechSummary, plural, promptOf, queueCell, queueCounts, queueTotalCell, resistText, rosterEntries, rosterEntry, statusMult,
} from './roster.js';

/**
 * ⭐ 17.10 (Артбук): чистые помощники ростеров по ярусам — те же счёты и та же сводка «механика держится на», что в документе
 * «Ростер и очерёдность» (`gen_roster.py`): цены кодов — из «Рычагов движка» черновика, очереди — из `index.json`.
 */
const crypt = cryptJson as unknown as CryptDraft;
const codes = crypt.engine.codes;
const ORDER_PROD = ['medieval', 'greece', 'rome', 'vikings', 'egypt', 'mesopotamia'];
const load = async (): Promise<{ idx: RosterIndex; R: Record<string, RosterV2> }> => {
  const idx = await loadRosterIndex();
  const R = Object.fromEntries(await Promise.all(idx.order.map(async (id) => [id, await loadRoster(id)] as const)));
  return { idx, R };
};

describe('artbook: ростеры v2 — чистые помощники', () => {
  it('⭐ 22.10 промт Nano Banana: стиль + фон — первый абзац, описание карточки, концовка; без описания — пусто; у боссов Европы описание есть', async () => {
    expect(promptOf({ style: ' Стиль. ', backdrop: 'Фон.', card: 'Кто.', close: 'Без текста.' })).toBe('Стиль. Фон.\n\nКто.\n\nБез текста.');
    expect(promptOf({ style: 'Стиль.', card: 'Кто.' })).toBe('Стиль.\n\nКто.');
    expect(promptOf({ style: 'Стиль.', backdrop: 'Фон.', card: '  ', close: 'Без текста.' })).toBe('');
    const { idx, R } = await load();
    expect(idx.prompt?.style).toContain('Diablo IV');
    expect(idx.prompt?.close).toBe('Без текста и надписей.');
    for (const id of idx.order) expect(R[id]!.promptBackdrop, id).toMatch(/фон/);
    for (const b of R.medieval!.bosses) expect(b.prompt, b.id).toMatch(/^Босс-зомби: /);
    // решение 22.10: в промтах нет формата и размера — их ставят в настройках генератора
    for (const b of R.medieval!.bosses) expect(b.prompt, b.id).not.toMatch(/2:3|соотношени|формат|пикс/);
    // ⭐ 23.10: своё начало промта — у колесницы (не «один персонаж»); у остальных боссов его нет
    const chariot = R.mesopotamia!.bosses.find((b) => b.id === 'boss14_dust_chariot')!;
    expect(chariot.promptStyle).toMatch(/колесниц/);
    expect(promptOf({ style: chariot.promptStyle, card: chariot.prompt })).toMatch(/^Мрачный реалистичный концепт-арт.*колесниц/);
    // решение 23.10: рот у боссов свободен — они говорят в бою
    for (const id of idx.order) for (const b of R[id]!.bosses) expect(b.prompt ?? '', `${id}/${b.id}`).not.toMatch(/в зубах|во рту/);
  });

  it('«механика держится на» — как в документе: есть / легко (новые вещи, коды «мелко») / на будущее с ценой', async () => {
    const { R } = await load();
    const med = R.medieval!;
    const m = (id: string): string => entryMech(rosterEntry(med, id)!, codes).text;
    expect(m('militiaman')).toBe('легко: новые вещи `u-buckler` · на будущее: К9 (крупно)');
    expect(m('veteran'), 'новая вещь оружия раньше вещей из текста').toBe('легко: новые вещи `u-warhammer1h`, `u-buckler` · на будущее: К8 (крупно)');
    expect(m('boss5_sergeant')).toBe('есть · легко: данные · на будущее: К8 (крупно), К11 (крупно), К19 (средне + модели), К22 (крупно)');
    expect(m('banner_bearer')).toBe('на будущее: К1 (средне), К9 (крупно), К14 (средне)');
    // цена «мелко» — [легко]; кода нет в «Рычагах» — не считается; без пометок — «данные»
    expect(mechSummary('[легко: К2] и К4, К99', codes).text).toBe('легко: К2, К4');
    expect(mechSummary('просто текст', codes)).toMatchObject({ have: false, easy: [], future: [], text: 'данные' });
  });

  it('счёты очередей: «1 · сначала» 10, «2 · следом» 6 (5 + босс 5), итого в работе 143', async () => {
    const { idx, R } = await load();
    expect(idx.roster.productionOrder, 'Европа первой').toEqual(ORDER_PROD);
    const qs = idx.roster.queues;
    const cells = (id: string): string[] => { const c = queueCounts(R[id]!, qs); return [...qs.map((q) => queueCell(c, q)), String(c.inWork)]; };
    expect(cells('medieval')).toEqual(['10', '6 (5 + босс 5)', '8 (2 босса + 6 особых)', '13 (2 босса + 11 идей)', '24']);
    expect(cells('greece')).toEqual(['10', '6 (5 + босс 5)', '8 (2 босса + 6 особых)', '26 (3 босса + 23 идеи)', '24']);
    expect(cells('mesopotamia')).toEqual(['10', '6 (5 + босс 5)', '7 (2 босса + 5 особых)', '17 (3 босса + 14 идей)', '23']);
    const all = ORDER_PROD.map((id) => queueCounts(R[id]!, qs));
    expect(qs.map((q) => queueTotalCell(all, q))).toEqual(['60', '36', '47 (12 боссов + 35 особых)', '135 (17 боссов + 118 идей)']);
    expect(all.reduce((n, c) => n + c.inWork, 0)).toBe(143);
  });

  it('карточки по id: бойцы ярусов, боссы по этажу, особые по волне; путь правки — от корня ростера', async () => {
    const { R } = await load();
    for (const r of Object.values(R)) {
      const es = rosterEntries(r);
      expect(es.length, r.id).toBe(15 + 3 + r.specials.length);
      expect(es.filter((e) => e.kind === 'boss').map((e) => (e.kind === 'boss' ? e.boss.floor : 0)), r.id).toEqual([5, 14, 19]);
      const waves = es.flatMap((e) => (e.kind === 'special' ? [e.special.wave] : []));
      expect(waves, r.id).toEqual([...waves].sort((a, b) => a - b));
    }
    expect(rosterEntry(R.medieval!, 'militiaman')?.path).toBe('tiers/light/cards/militiaman');
    expect(rosterEntry(R.medieval!, 'boss14_guildmaster')?.path).toBe('bosses/boss14_guildmaster');
    expect(rosterEntry(R.medieval!, 'нет-такой')).toBeUndefined();
  });

  it('броня яруса, стойкость, статусы, склонения', async () => {
    const { idx, R } = await load();
    expect(armorMix(R.medieval!.tiers[0]!.cards)).toBe('стёганая 2, кожа 3');
    expect(armorMix(R.mesopotamia!.tiers[2]!.cards)).toBe('сегментная 5');
    expect(resistText(idx.tierResistMult.light)).toBe('без стойкости');
    expect(resistText(idx.tierResistMult.heavy)).toBe('режущий ×0.75, колющий ×0.85, дробящий ×1.25, молния ×1.2');
    expect([statusMult(R.medieval!, 'Ошеломление'), statusMult(R.medieval!, 'Рана'), statusMult(R.medieval!, 'Увечье')]).toEqual([1.25, 1, 0.8]);
    expect([fmtMult(1.25), fmtMult(1), fmtMult(0.8)]).toEqual(['×1.25', '×1.0', '×0.8']);
    expect([1, 2, 5, 11, 21, 23, 118].map((n) => plural(n, 'идея', 'идеи', 'идей'))).toEqual(['идея', 'идеи', 'идей', 'идей', 'идея', 'идеи', 'идей']);
  });
});

import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { isDifficultyUnlocked } from '../formulas/power.js';
import { runNodeLabel } from '../dungeon/run/labels.js';
import { runDifficultyUnlocked, runVoteQuestion, type RunVoteFrame } from './runVote.js';
import { RUN_DEATH_TEXT, runDeathDock, runDeathFrame, runDeathOnFrame, runDeathView, type RunDiedFrame } from './runDeath.js';

/**
 * ⭐⭐ С-views (29.10): ОКНА СМЕРТИ И ГОЛОСОВАНИЯ — случаи `RunModalsCheck.cs` Unity на видах сервера (эталонные
 * последовательности сверяет `runGolden.test.ts`), плюс то, что сервер теперь кладёт в кадры сам.
 */

const died = (o: RunDiedFrame = {}): RunDiedFrame => ({ goldLost: 0, itemsLost: 0, toTown: false, ...o });
const vote = (o: Partial<RunVoteFrame> = {}): RunVoteFrame => ({ kind: 'descend', ...o });

const DIEFIELDS = { DeathState: ['hasLosses', 'lossGold', 'lossItems', 'toTown', 'canLeave', 'pvp', 'wipe', 'open'], DeathView: ['title', 'loss', 'status', 'spectate', 'town'] };

describe('С-views: окно смерти (RunModalsCheck)', () => {
  it('статусы не подменяют потери и не открывают закрытое окно; режимы окна', () => {
    let s = runDeathOnFrame(null, died({ goldLost: 350, itemsLost: 2 }));
    const v = runDeathView(s);
    expect(Object.keys(s)).toEqual(DIEFIELDS.DeathState);
    expect(Object.keys(v)).toEqual(DIEFIELDS.DeathView);
    expect([s.open, v.loss, v.spectate]).toEqual([true, 'Потеряно: <b>350</b> золота, <b>2</b> предм.', RUN_DEATH_TEXT.spectate]);
    s.open = false;
    s = runDeathOnFrame(runDeathOnFrame(s, died({ toTown: true, status: true })), died({ status: true }));
    expect([s.open, s.hasLosses, s.lossGold, s.lossItems]).toEqual([false, true, 350, 2]);

    const o = runDeathOnFrame(runDeathOnFrame(null, died({ goldLost: 350, itemsLost: 2 })), died({ toTown: true, status: true }));
    expect(runDeathView(o)).toEqual({ title: 'Вы погибли', loss: 'Потеряно: <b>350</b> золота, <b>2</b> предм.', status: 'Возвращаетесь в город…', spectate: 'Смотреть', town: null });

    const c = runDeathOnFrame(runDeathOnFrame(null, died({ goldLost: 10 })), died({ status: true, canLeave: true }));
    expect([runDeathView(c).town, runDeathDock(c)]).toEqual([RUN_DEATH_TEXT.town, null]);

    const entered = runDeathOnFrame(null, died({ status: true }));
    expect([entered.open, runDeathView(entered).loss, runDeathView(entered).title]).toEqual([true, null, 'Вы погибли']);
    expect(runDeathView(runDeathOnFrame(null, died({ goldLost: 5, itemsLost: 1, toTown: true }))).spectate).toBeNull();
    expect(runDeathView(runDeathOnFrame(null, died({ pvp: true })))).toEqual({ title: 'Вы повержены', loss: null, status: 'Возрождение через пару секунд…', spectate: 'Смотреть за соперником', town: null });

    let d = runDeathOnFrame(null, died({ goldLost: 350, itemsLost: 2 }));
    d.open = false;
    expect(runDeathDock(d)).toBeNull();
    d = runDeathOnFrame(d, died({ status: true, canLeave: true }));
    expect(runDeathDock(d)).toEqual({ status: RUN_DEATH_TEXT.canLeave, town: 'В город' });
    expect([d.open, d.lossGold]).toEqual([false, 350]);
    for (const next of [died({ status: true }), died({ status: true, toTown: true })]) {
      let x = runDeathOnFrame(null, died({ goldLost: 350, itemsLost: 2 }));
      x.open = false;
      x = runDeathOnFrame(runDeathOnFrame(x, died({ status: true, canLeave: true })), next);
      expect([runDeathDock(x), x.open]).toEqual([null, false]);
    }
  });

  it('кадр сервера: `opens` только у новой смерти, арены и статуса без памяти; плашка — для закрытого окна', () => {
    const a = runDeathFrame(null, died({ goldLost: 350, itemsLost: 2 }));
    expect([a.opens, a.dock, a.view.loss]).toEqual([true, null, 'Потеряно: <b>350</b> золота, <b>2</b> предм.']);
    const b = runDeathFrame(a.state, died({ status: true, canLeave: true }));
    expect([b.opens, b.dock, b.view.town, b.view.loss]).toEqual([false, { status: RUN_DEATH_TEXT.canLeave, town: 'В город' }, 'В город', a.view.loss]);
    expect(runDeathFrame(null, died({ status: true })).opens).toBe(true);
    expect(runDeathFrame(b.state, died({ pvp: true, status: true })).opens).toBe(true);
    expect(JSON.parse(JSON.stringify(b))).toEqual(b);
  });
});

describe('С-views: вопрос голосования (RunModalsCheck)', () => {
  const cfg = {
    difficulties: [
      { id: 'easy', name: 'Лёгкая', unlockFloor: 0 }, { id: 'normal', name: 'Средняя', unlockFloor: 5 },
      { id: 'hard', name: 'Сложная', unlockFloor: 10 }, { id: 'nightmare', name: 'Кошмар', unlockFloor: 12 },
    ],
    biomes: [{ id: 'crypt', name: 'Склеп' }],
    'run-modifiers': [{ id: 'm1', name: 'Стеклянные кости' }],
  };

  it('новый забег: тир, биом, модификатор, закрытый тир — прямо; продолжение — ник обезврежен', () => {
    const f = vote({ difficultyId: 'nightmare', biomeId: 'crypt', modifiers: ['m1'] });
    expect(runVoteQuestion(f, cfg, {})).toBe('Новый забег?\nСложность: <b>Кошмар</b> · Склеп\nМодификаторы: Стеклянные кости'
      + '\n<b><color=#e6a05a>Внимание: сложность «Кошмар» вам ещё не открыта</color></b>');
    expect(runVoteQuestion(f, cfg, { easy: 99, normal: 99, hard: 99 })).not.toContain('не открыта');
    const res = runVoteQuestion(vote({ difficultyId: 'easy', biomeId: 'crypt', modifiers: [], resume: { host: '<b>Ник</b>', depth: 4 } }), cfg, {});
    expect(res).toBe('Продолжить забег ‹b›Ник‹/b› с этажа 4?\nСложность: <b>Лёгкая</b> · Склеп');
  });

  it('прочие голосования и спуск по ребру — как прежде; неизвестный тип узла — сам id, обезвреженный', () => {
    expect(runVoteQuestion(vote(), cfg)).toBe('Спуск на след. этаж?');
    expect(runVoteQuestion(vote({ kind: 'town' }), cfg)).toBe('Вернуться в город?');
    expect(runVoteQuestion(vote({ kind: 'arena' }), cfg)).toBe('Войти в PvP-арену?');
    for (const t of ['boss', 'rest', 'shop', 'treasure']) expect(runVoteQuestion(vote({ targetNodeType: t }), cfg)).toBe(`Спуск: ${runNodeLabel(t)}?`);
    expect(runVoteQuestion(vote({ finish: true }), cfg)).toBe('Завершить забег и вернуться в город?');
    expect(runVoteQuestion(vote({ targetNodeType: '<i>x</i>' }), cfg)).toBe('Спуск: ‹i›x‹/i›?');
  });

  it('⚠ стартовая глубина из `voteStart` (уже зажатая сервером) — в вопросе, как у веба; 1-й этаж — «Новый забег?»', () => {
    expect(runVoteQuestion(vote({ difficultyId: 'easy', biomeId: 'crypt', startDepth: 18 }), cfg, {})).toBe('Новый забег с этажа 18?\nСложность: <b>Лёгкая</b> · Склеп');
    expect(runVoteQuestion(vote({ difficultyId: 'easy', biomeId: 'crypt', startDepth: 1 }), cfg, {})).toBe('Новый забег?\nСложность: <b>Лёгкая</b> · Склеп');
  });

  it('открытость тира ≡ isDifficultyUnlocked ядра (на строках схемы) и C#-правило на голых строках', () => {
    const d = cfg.difficulties;
    expect(runDifficultyUnlocked(d, 0, {})).toBe(true);
    expect([runDifficultyUnlocked(d, 1, {}), runDifficultyUnlocked(d, 1, { easy: 5, normal: 9 })]).toEqual([false, true]);
    expect(runDifficultyUnlocked(d, 2, { easy: 5, normal: 9 })).toBe(false);
    expect(runDifficultyUnlocked(d, 9, {})).toBe(true);
    const reg = new ConfigRegistry(); reg.loadAll();
    const diffs = reg.get('difficulties');
    const sets: Record<string, number>[] = [{}, { easy: 5 }, { easy: 99, normal: 9 }, { easy: 99, normal: 99, hard: 99 }];
    for (const p of sets)
      for (let i = 0; i < diffs.length; i++) expect(runDifficultyUnlocked(diffs, i, p)).toBe(isDifficultyUnlocked(diffs, i, p));
    // сервер зовёт с реестром — имена из конфига
    expect(runVoteQuestion(vote({ difficultyId: 'normal', biomeId: 'crypt', modifiers: [] }), reg, {})).toBe(`Новый забег?\nСложность: <b>${diffs.find((x) => x.id === 'normal')!.name}</b> · ${reg.get('biomes').find((b) => b.id === 'crypt')!.name}`);
  });
});

describe('С-views: округления .NET и язык конфига', () => {
  it('csRound — к чётному (Math.Round C#), csFixed — 15 знаков и «от нуля» (ToString("0.00") C#)', async () => {
    const { csRound, csFixed } = await import('./runCommon.js');
    expect([csRound(12.5), csRound(13.5), csRound(-0.5), csRound(2.4999), csRound(20.000000000000018)]).toEqual([12, 14, 0, 2, 20]);
    expect([csFixed(1.005, 2), csFixed(1.125, 2), csFixed(1.2, 2), csFixed(1.15, 2), csFixed(2, 2), csFixed(0.004, 2), csFixed(12.345678, 2)])
      .toEqual(['1.01', '1.13', '1.20', '1.15', '2.00', '0.00', '12.35']);
  });

  it('lang: имена из конфига идут через Localizer (`cfg:`-ключи), фразы окна — русские; ru — бит в бит исходник', async () => {
    const { runPortalView } = await import('./runPortal.js');
    const reg = new ConfigRegistry(); reg.loadAll();
    const s = { level: 1, equipment: {}, masteries: {}, inventory: [], belt: [], difficultyProgress: {} } as unknown as Parameters<typeof runPortalView>[1];
    const ru = runPortalView(reg, s);
    const en = runPortalView(reg, s, {}, { lang: 'en' });
    expect(ru.biomes[0]!.name).toBe(reg.get('biomes').find((b) => b.id === 'crypt')!.name);
    expect(en.biomes[0]!.name).toBe('Necropolis of the Dead Crown');
    expect(en.tiers[0]!.name).toBe('Normal');
    expect(en.head).toBe(ru.head);
    expect(runVoteQuestion(vote({ difficultyId: 'normal', biomeId: 'crypt' }), reg, {}, { lang: 'en' })).toBe('Новый забег?\nСложность: <b>Normal</b> · Necropolis of the Dead Crown');
  });
});

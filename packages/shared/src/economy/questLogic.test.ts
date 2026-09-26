import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { newBotSave } from '../sim/playerBot.js';
import { createRng } from '../formulas/rng.js';
import type { QuestDef } from '../types/quest.js';
import { acceptQuest, trackObjective, trackFloor, turnInQuest, ensureMainQuest, generateBoard, boardTemplateOf, questFromTemplate, pruneBoardQuests, questRival } from './questLogic.js';
import type { SaveState } from '../types/save.js';
import type { RandomQuestTemplate } from '../types/quest.js';

function reg(): ConfigRegistry {
  const r = new ConfigRegistry();
  r.loadAll();
  return r;
}

const killQuest: QuestDef = {
  id: 'q-kill',
  name: 'Тест-убийство',
  description: '',
  objectives: [{ id: 'o1', type: 'kill', target: 'skeleton', amount: 2 }],
  reward: { gold: 50 },
};

describe('questLogic (авторитетно, чистые функции)', () => {
  it('accept → трек убийства → выполнено → сдача выдаёт награду один раз', () => {
    const r = reg();
    const save = newBotSave(r, 'warrior');
    expect(acceptQuest(save, killQuest).ok).toBe(true);
    expect(acceptQuest(save, killQuest).ok).toBe(false); // повторный приём

    expect(trackObjective(save, 'kill', 'goblin').changed).toBe(false); // чужая цель
    expect(trackObjective(save, 'kill', 'skeleton').completed).toEqual([]); // 1/2
    expect(trackObjective(save, 'kill', 'skeleton').completed).toEqual(['q-kill']); // 2/2 → выполнено

    const prog = save.quests.find((q) => q.questId === 'q-kill')!;
    expect(prog.status).toBe('completed');

    const gold0 = save.gold;
    expect(turnInQuest(r, save, 'q-kill').ok).toBe(true);
    expect(save.gold).toBe(gold0 + 50);
    expect(prog.status).toBe('turned-in');
    expect(turnInQuest(r, save, 'q-kill').ok).toBe(false); // повторная сдача запрещена
  });

  it('reach-floor трекается по глубине, а не по каждому шагу', () => {
    const r = reg();
    const save = newBotSave(r, 'warrior');
    acceptQuest(save, {
      id: 'q-floor', name: 'F', description: '',
      objectives: [{ id: 'o1', type: 'reach-floor', amount: 3 }], reward: { gold: 10 },
    });
    expect(trackFloor(save, 2).changed).toBe(false); // недостаточно глубоко
    expect(trackFloor(save, 3).completed).toEqual(['q-floor']);
  });

  it('ensureMainQuest выдаёт цепочку один раз; доска непустая', () => {
    const r = reg();
    const save = newBotSave(r, 'warrior');
    expect(ensureMainQuest(r, save)).not.toBeNull();
    expect(ensureMainQuest(r, save)).toBeNull(); // повторно не выдаёт
    expect(generateBoard(r, createRng(1)).length).toBeGreaterThan(0);
  });
});

/**
 * ⚠ R3-10: квота доски — одно задание ШАБЛОНА за срок доски, по сейву берущего. Доска — сток героя-хозяина комнаты,
 * и герой ходил по комнатам своих альтов, собирая «достичь этажа» с каждой: одно достижение закрывало все разом.
 */
describe('⚠ R3-10: квота доски в сейве', () => {
  const r = reg();
  const tpls = r.get('quests.random') as RandomQuestTemplate[];
  const WINDOW = 600_000;
  const t0 = 1_800_000_000_000;

  it('шаблон читается из id квеста доски; квест цепочки — не с доски', () => {
    for (const tpl of tpls) {
      const q = questFromTemplate(tpl, createRng(3), `${t0.toString(36)}12`);
      expect(boardTemplateOf(q.id), q.id).toBe(tpl.id);
    }
    expect(boardTemplateOf('main-1')).toBeUndefined();
    expect(boardTemplateOf('q-kill')).toBeUndefined();
  });

  it('⭐ второе задание того же шаблона за срок — отказ (сейв не тронут); другой шаблон — можно; срок вышел — можно', () => {
    const save = newBotSave(r, 'warrior');
    const [a, b] = [1, 2].map((i) => generateBoard(r, createRng(i)));
    const tpl = tpls[0]!;
    const first = a!.find((q) => boardTemplateOf(q.id) === tpl.id)!;
    const second = { ...b!.find((q) => boardTemplateOf(q.id) === tpl.id)!, id: `rnd_${tpl.id}_other1` };
    expect(acceptQuest(save, first, { now: t0, windowMs: WINDOW })).toEqual({ ok: true });
    expect(save.quests.at(-1)!.acceptedAt, 'время принятия записано').toBe(t0);
    const before = JSON.stringify(save);
    const refused = acceptQuest(save, second, { now: t0 + WINDOW - 1, windowMs: WINDOW });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBeTruthy();
    expect(JSON.stringify(save)).toBe(before);
    // Метка «из будущего» (часы нод разошлись) квоту раньше срока не открывает.
    expect(acceptQuest(save, second, { now: t0 - 5_000, windowMs: WINDOW }).ok).toBe(false);
    const other = tpls[1] ? a!.find((q) => boardTemplateOf(q.id) === tpls[1]!.id) : undefined;
    if (other) expect(acceptQuest(save, other, { now: t0 + 1, windowMs: WINDOW }).ok, 'другой шаблон').toBe(true);
    expect(acceptQuest(save, second, { now: t0 + WINDOW, windowMs: WINDOW }).ok, 'срок вышел').toBe(true);
  });

  it('без квоты (цепочка) и с нулевым сроком доски — как раньше; квест, принятый до правки (без метки), квоту не держит', () => {
    const save = newBotSave(r, 'warrior');
    const board = generateBoard(r, createRng(5));
    const q = board[0]!;
    expect(acceptQuest(save, q).ok).toBe(true);
    expect(save.quests.at(-1)!.acceptedAt, 'без квоты метки нет').toBeUndefined();
    const again = { ...q, id: `${q.id}x` };
    expect(acceptQuest(save, again, { now: t0, windowMs: WINDOW }).ok, 'старый квест без метки не держит').toBe(true);
    const zero = { ...q, id: `${q.id}y` };
    expect(acceptQuest(save, zero, { now: t0, windowMs: 0 }).ok, 'срок доски 0 — квоты нет').toBe(true);
  });
});

/**
 * ⚠ R4-33: квота считается ПОКОЛЕНИЯМИ ДОСКИ, а не временем принятия. Доска катается раз в срок (`townRestockSec`);
 * принял задание на 9-й минуте доски — на 10-й она честно обновилась, и то же задание с новой доски берётся сразу, а
 * не ещё девять минут «доска обновится позже» (которая уже обновилась).
 */
describe('⚠ R4-33: квота доски — по поколению доски', () => {
  const r = reg();
  const tpls = r.get('quests.random') as RandomQuestTemplate[];
  const W = 600_000, MIN = 60_000;
  const t0 = 1_800_000_000_000;
  const tpl = tpls[0]!;
  const board = (i: number): QuestDef => ({ ...generateBoard(r, createRng(i)).find((q) => boardTemplateOf(q.id) === tpl.id)!, id: `rnd_${tpl.id}_gen${i}` });

  it('⭐ взял на 9-й минуте доски, сдал; доска обновилась на 10-й — то же задание с новой доски берётся сразу', () => {
    const save = newBotSave(r, 'warrior');
    expect(acceptQuest(save, board(1), { now: t0 + 9 * MIN, windowMs: W, boardAt: t0 })).toEqual({ ok: true });
    expect(save.quests.at(-1)!.boardAt, 'поколение доски записано').toBe(t0);
    save.quests.at(-1)!.status = 'turned-in';
    const fresh = acceptQuest(save, board(2), { now: t0 + 10 * MIN, windowMs: W, boardAt: t0 + 10 * MIN });
    expect(fresh, 'раньше — «доска обновится позже» до 19-й минуты').toEqual({ ok: true });
  });

  it('⭐ доска альта, катанная в пределах срока от первой, — отказ, как и прежде (R3-10)', () => {
    const save = newBotSave(r, 'warrior');
    expect(acceptQuest(save, board(1), { now: t0 + MIN, windowMs: W, boardAt: t0 }).ok).toBe(true);
    const before = JSON.stringify(save);
    const alt = acceptQuest(save, board(3), { now: t0 + 6 * MIN, windowMs: W, boardAt: t0 + 5 * MIN });
    expect(alt.ok).toBe(false);
    expect(alt.reason).toBeTruthy();
    expect(JSON.stringify(save)).toBe(before);
  });

  it('⭐ доска, пережившая свой срок (в город не заходили), — как катанная сейчас: поколения «в запас» не копятся', () => {
    const save = newBotSave(r, 'warrior');
    expect(acceptQuest(save, board(1), { now: t0 + 26 * MIN, windowMs: W, boardAt: t0 + 25 * MIN }).ok).toBe(true);
    // Альт держал открытой доску, катанную на нулевой минуте: по её метке до первой 25 минут — прошло бы.
    const stale = acceptQuest(save, board(4), { now: t0 + 27 * MIN, windowMs: W, boardAt: t0 });
    expect(stale.ok).toBe(false);
    // Метка «из будущего» — тоже как сейчас.
    expect(acceptQuest(save, board(5), { now: t0 + 28 * MIN, windowMs: W, boardAt: t0 + 60 * MIN }).ok).toBe(false);
    expect(acceptQuest(save, board(6), { now: t0 + 36 * MIN, windowMs: W, boardAt: t0 + 35 * MIN }).ok, 'следующее поколение').toBe(true);
  });

  it('прогресс до правки (только время принятия) — поколением считается время принятия', () => {
    const save = newBotSave(r, 'warrior');
    save.quests.push({ questId: `rnd_${tpl.id}_old1`, status: 'turned-in', counters: {}, acceptedAt: t0 + 9 * MIN });
    expect(acceptQuest(save, board(7), { now: t0 + 10 * MIN, windowMs: W, boardAt: t0 + 10 * MIN }).ok).toBe(false);
    expect(acceptQuest(save, board(7), { now: t0 + 20 * MIN, windowMs: W, boardAt: t0 + 20 * MIN }).ok).toBe(true);
  });
});

/**
 * ⚠ R5-20: ЖУРНАЛ ДОСКИ НЕ РАСТЁТ БЕЗ КОНЦА. Каждое принятое задание доски клало в сейв полное определение (~300 Б) и
 * строку прогресса, а сдача лишь меняла статус: за сотни часов — тысячи строк (2–3 МБ), и весь сейв писался в базу каждым
 * автосейвом и уходил клиенту каждым `saveUpdate`. Сданное с доски теперь убирается (его поколение для квоты остаётся в
 * `boardQuota`), а от шаблона в журнале живёт одно задание: новое поколение заменяет невыполненное прежнее.
 */
describe('⚠ R5-20: журнал доски не растёт без конца', () => {
  const r = reg();
  const tpls = r.get('quests.random') as RandomQuestTemplate[];
  const W = 600_000;
  const t0 = 1_800_000_000_000;
  /** Задание шаблона `tpl` с доски поколения `g` (id уникален на поколение, как у `generateBoard`). */
  const gen = (tpl: RandomQuestTemplate, g: number): QuestDef =>
    ({ ...generateBoard(r, createRng(g + 1)).find((q) => boardTemplateOf(q.id) === tpl.id)!, id: `rnd_${tpl.id}_g${g.toString(36)}` });
  const quota = (g: number, dt = 0) => ({ now: t0 + g * W + dt, windowMs: W, boardAt: t0 + g * W + dt });
  /** Выполнить задание честным трекингом. */
  function complete(save: SaveState, q: QuestDef): void {
    const o = q.objectives[0]!;
    if (o.type === 'reach-floor') trackFloor(save, o.amount);
    else for (let i = 0; i < o.amount; i++) trackObjective(save, o.type as 'kill' | 'collect-item', o.target!);
  }

  it('⭐ 250 поколений доски «принял — выполнил — сдал»: журнал не длиннее «шаблонов × 2», квота держит поколение', () => {
    const save = newBotSave(r, 'warrior');
    ensureMainQuest(r, save);
    const main = save.quests.length;
    for (let g = 0; g < 250; g++) {
      for (const tpl of tpls) {
        const q = gen(tpl, g);
        expect(acceptQuest(save, q, quota(g)), `поколение ${g}`).toEqual({ ok: true });
        complete(save, q);
        save.inventory = [];                                   // награда-вещь не должна упереться в полную сумку
        expect(turnInQuest(r, save, q.id).ok, `сдача ${g}`).toBe(true);
        // Доска альта в пределах срока — отказ, хотя сданное уже убрано из журнала: поколение помнит квота.
        const alt = { ...gen(tpl, g), id: `rnd_${tpl.id}_a${g.toString(36)}` };
        expect(acceptQuest(save, alt, quota(g, W / 2)).ok, `альт ${g}`).toBe(false);
      }
      expect(save.quests.length, `строк прогресса, поколение ${g}`).toBeLessThanOrEqual(main + tpls.length * 2);
      expect(save.activeQuestDefs.length, `определений, поколение ${g}`).toBeLessThanOrEqual(main + tpls.length * 2);
    }
    expect(save.quests.filter((q) => q.questId.startsWith('main-')).length, 'цепочка не тронута').toBe(main);
  });

  it('⭐ принял и бросил: новое поколение ЗАМЕНЯЕТ невыполненное прежнее — и копить «достичь этажа» на один спуск нельзя', () => {
    const save = newBotSave(r, 'warrior');
    const delve = tpls.find((t) => t.objectiveType === 'reach-floor')!;
    for (let g = 0; g < 50; g++) expect(acceptQuest(save, gen(delve, g), quota(g)).ok).toBe(true);
    expect(save.quests.length, 'от шаблона — одно задание').toBe(1);
    expect(save.activeQuestDefs.length).toBe(1);
    expect(save.quests[0]!.questId).toBe(gen(delve, 49).id);
    expect(trackFloor(save, 99).completed, 'один спуск закрывает одно задание, а не пятьдесят').toHaveLength(1);
  });

  it('выполненное, но не сданное — новое того же шаблона не берётся, пока не сдашь (награда не пропадает)', () => {
    const save = newBotSave(r, 'warrior');
    const delve = tpls.find((t) => t.objectiveType === 'reach-floor')!;
    const first = gen(delve, 0);
    expect(acceptQuest(save, first, quota(0)).ok).toBe(true);
    complete(save, first);
    const before = JSON.stringify(save);
    const next = acceptQuest(save, gen(delve, 1), quota(1));
    expect(next.ok).toBe(false);
    expect(next.reason).toMatch(/сдай/i);
    expect(JSON.stringify(save), 'сейв не тронут').toBe(before);
    expect(turnInQuest(r, save, first.id).ok).toBe(true);
    expect(acceptQuest(save, gen(delve, 1), quota(1)).ok, 'сдал — следующее поколение берётся').toBe(true);
  });

  it('старый сейв с тысячами сданных строк чистится при входе (`pruneBoardQuests`); квота помнит их поколения', () => {
    const save = newBotSave(r, 'warrior');
    ensureMainQuest(r, save);
    const cull = tpls.find((t) => t.objectiveType === 'kill')!;
    for (let g = 0; g < 3000; g++) {
      const q = gen(cull, g);
      save.activeQuestDefs.push(q);
      save.quests.push({ questId: q.id, status: 'turned-in', counters: { o1: 0 }, acceptedAt: t0 + g * W, boardAt: t0 + g * W });
    }
    const active = gen(cull, 3000);
    expect(acceptQuest(save, active, quota(3000)).ok).toBe(true);    // принятие само чистит сданное
    const legacy = gen(cull, 3001);
    save.activeQuestDefs.push(legacy);
    save.quests.push({ questId: legacy.id, status: 'turned-in', counters: { o1: 0 }, boardAt: t0 + 3001 * W });
    pruneBoardQuests(save);
    expect(save.quests.map((q) => q.questId).filter((id) => !id.startsWith('main-')), 'осталось только живое').toEqual([active.id]);
    expect(save.activeQuestDefs.filter((d) => d.id.startsWith('rnd_')).map((d) => d.id)).toEqual([active.id]);
    expect(save.quests.some((q) => q.questId.startsWith('main-')), 'цепочка на месте').toBe(true);
    // Сданное поколение 3001 из журнала ушло, но квота его помнит: доска альта того же срока — отказ.
    save.quests = save.quests.filter((q) => q.questId !== active.id);
    expect(acceptQuest(save, { ...gen(cull, 3001), id: `rnd_${cull.id}_z1` }, quota(3001, W / 3)).ok).toBe(false);
    expect(acceptQuest(save, gen(cull, 3002), quota(3002)).ok, 'следующее поколение — можно').toBe(true);
  });
});

/**
 * ⚠ R6-13: НОВОЕ ПОКОЛЕНИЕ НЕ СТИРАЕТ НАЧАТОЕ ЗАДАНИЕ МОЛЧА. Правка R5-20 вытесняла любое активное задание того же шаблона:
 * «Уничтожить 12» на 11 из 12, через срок доски «Взять» ещё одну зачистку — сервер «ок», журнал «Квест принят», а прежнее
 * пропадало с прогрессом и наградой. Шаблонов на доске два, так что попадала любая повторная зачистка. Теперь начатое
 * (хоть один счётчик > 0) держит место: без согласия игрока (`replace`) — отказ с его именем; не начатое вытесняется, как
 * в R5-20 (терять нечего, а «достичь этажа» всё так же не копится).
 */
describe('⚠ R6-13: начатое задание доски не пропадает молча', () => {
  const r = reg();
  const W = 600_000;
  const t0 = 1_800_000_000_000;
  const cull = (id: string, target: string, amount: number): QuestDef => ({
    id, name: `Уничтожить ${amount} (${target})`, description: 'Случайное задание с доски.',
    objectives: [{ id: 'o1', type: 'kill', target, amount }], reward: { gold: 100 },
  });
  const A = cull('rnd_rnd-cull_aaa0', 'zombie-archer', 12);
  const B = cull('rnd_rnd-cull_bbb0', 'zombie', 5);
  const at = (t: number) => ({ now: t, windowMs: W, boardAt: t });

  it('⭐ 11 из 12, доска обновилась — «Взять» того же вида: отказ с именем, прогресс и определение на месте', () => {
    const save = newBotSave(r, 'warrior');
    expect(acceptQuest(save, A, at(t0)).ok).toBe(true);
    for (let i = 0; i < 11; i++) trackObjective(save, 'kill', 'zombie-archer');
    expect(questRival(save, B)?.questId, 'клиенту есть о чём спросить').toBe(A.id);
    const before = JSON.stringify(save);
    const res = acceptQuest(save, B, at(t0 + W + 60_000));
    expect(res.ok, 'было: ok, а «11 из 12» исчезало').toBe(false);
    expect(res.reason).toContain(A.name);
    expect(JSON.stringify(save), 'журнал не тронут').toBe(before);
    expect(save.quests.find((q) => q.questId === A.id)?.counters.o1).toBe(11);
  });

  it('⭐ с согласием игрока (`replace`) — новое вместо прежнего; не начатое заменяется и без согласия (R5-20)', () => {
    const save = newBotSave(r, 'warrior');
    expect(acceptQuest(save, A, at(t0)).ok).toBe(true);
    trackObjective(save, 'kill', 'zombie-archer');
    expect(acceptQuest(save, B, at(t0 + W + 1), true)).toEqual({ ok: true });
    expect(save.quests.map((q) => q.questId)).toEqual([B.id]);
    expect(save.activeQuestDefs.map((d) => d.id)).toEqual([B.id]);
    const C = cull('rnd_rnd-cull_ccc0', 'skeleton', 7);
    expect(questRival(save, C), 'B не начато — спрашивать не о чем').toBeUndefined();
    expect(acceptQuest(save, C, at(t0 + 2 * W + 2)).ok, 'не начатое вытесняется, как в R5-20').toBe(true);
    expect(save.quests.map((q) => q.questId)).toEqual([C.id]);
  });
});

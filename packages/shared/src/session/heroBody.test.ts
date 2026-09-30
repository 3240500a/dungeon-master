import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { newBotSave } from '../sim/playerBot.js';
import { makeGrid, Cell, cellToWorld } from '../world/grid.js';
import { GameSession } from './session.js';
import { agedBody, arenaAwayBody, arenaReturn, bodyOf, cooldownsForSave, keepLaterCooldowns, putBody, savedCooldowns, vitalsForSave } from './heroBody.js';

/**
 * ⭐ D4: ТЕЛО ГЕРОЯ ВНЕ МИРА (`heroBody.ts`) — общий код комнаты (`server/net/room.ts`) и фаззера правил. Откаты — героя, а не тела:
 * через конец арены, уход с неё и сейв (`vitals.cd`) они не становятся готовыми даром. Переходы комнаты целиком — `room.d4server.test.ts`.
 */
function rig() {
  const r = new ConfigRegistry();
  r.loadAll();
  const s = new GameSession(r, 5, 'normal');
  const p = s.addPlayer('p1', newBotSave(r, 'warrior'));
  s.enterFloor(0, { grid: makeGrid(10, 10, Cell.Floor), spawn: cellToWorld(4, 4), monsters: [] });
  return { r, s, p };
}

describe('⭐ D4: тело героя — откаты героя, а не тела', () => {
  it('более поздний откат: чужой длиннее — берётся, короче — нет; пустой — ничего', () => {
    const cd: Record<string, number> = { a: 5, b: 1 };
    keepLaterCooldowns(cd, { a: 3, b: 4, c: 2 });
    expect(cd).toEqual({ a: 5, b: 4, c: 2 });
    keepLaterCooldowns(cd, undefined);
    expect(cd).toEqual({ a: 5, b: 4, c: 2 });
  });

  it('тело ухода и возврат — те же таймеры (время для ушедшего стоит), дебаффы остатком; мёртвый — мёртв', () => {
    const { s, p } = rig();
    p.skillCd = { x: 7 }; p.skillBuffs = { x: 3 }; p.hp = 10;
    const body = bodyOf(p, s.world.timeMs);
    p.skillCd = {}; p.skillBuffs = {}; p.hp = 1;
    expect(putBody(p, body, s.world.timeMs + 5000)).toBe(false);
    expect([p.skillCd, p.skillBuffs, p.hp]).toEqual([{ x: 7 }, { x: 3 }, 10]);
    expect(putBody(p, { ...body, alive: false }, s.world.timeMs)).toBe(true);
    expect([p.alive, p.hp]).toEqual([false, 0]);
  });

  it('конец арены: баффы и откаты города стареют временем боя, откат, взятый на арене, — остаётся (раньше: откаты города)', () => {
    const { r, s, p } = rig();
    p.skillCd = { town: 10, both: 3 }; p.skillBuffs = { town: 6 };
    const home = bodyOf(p, s.world.timeMs);
    p.skillCd = { arena: 12, both: 9, town: 8 }; p.skillBuffs = { arena: 5 };   // тело арены: своё
    arenaReturn(r, p, home, 4, s.world.timeMs, true);
    expect(p.skillBuffs, 'бафф арены в город не идёт; бафф города — минус время боя').toEqual({ town: 2 });
    expect(p.skillCd, 'откаты — более поздние из города (минус бой) и арены').toEqual({ town: 8, both: 9, arena: 12 });
  });

  it('ушедший с арены раньше: запись ухода — тело города без точки, откаты — более поздние из тела города и арены', () => {
    const { s, p } = rig();
    p.skillCd = { a: 2 };
    const home = bodyOf(p, s.world.timeMs);
    const arenaLeft = { ...bodyOf(p, s.world.timeMs), skillCd: { a: 1, b: 9 } };
    const got = arenaAwayBody({ body: home, sec: 0 }, arenaLeft);
    expect(got.pos).toBeUndefined();
    expect(got.skillCd).toEqual({ a: 2, b: 9 });
    expect(home.skillCd, 'тело города не тронуто').toEqual({ a: 2 });
  });

  it('откаты в сейв и из сейва: на арене — более поздние из обоих тел; из сейва — минус время вне игры, истёкшие и битые — мимо', () => {
    const { s, p } = rig();
    p.skillCd = { a: 4, b: 0 };
    const home = { ...bodyOf(p, s.world.timeMs), skillCd: { a: 1, c: 6 } };
    expect(cooldownsForSave(p, { body: home, sec: 0 })).toEqual({ a: 4, c: 6 });
    p.skillCd = {};
    expect(cooldownsForSave(p), 'нечего — нет поля').toBeUndefined();
    const v = { cd: { a: 4, c: 6, bad: Number.NaN }, at: 1_000_000 };
    expect(savedCooldowns(v, 1_003_000)).toEqual({ a: 1, c: 3 });
    expect(savedCooldowns(v, 1_010_000)).toEqual({});
    expect(savedCooldowns({ cd: { a: 4 } }, 5), 'без метки — как записано').toEqual({ a: 4 });
    expect(savedCooldowns(undefined, 5)).toEqual({});
    const a = savedCooldowns(v, 1_000_000), b = savedCooldowns(v, 1_000_000);
    expect(a).not.toBe(b);   // новый объект: тикающие откаты сущности не делят его с записью
  });
});

/**
 * ⚠ R23-05: ТЕЛО ГОРОДА НА ВРЕМЯ АРЕНЫ СТАРЕЕТ ВРЕМЕНЕМ ГЕРОЯ — у сейва с арены (`vitalsForSave`) и у записи ушедшего (`arenaAwayBody`) так же,
 * как у дождавшегося конца (`arenaReturn`). Раньше оба несли его застывшим на входе в арену: клич, по времени героя давно готовый, — в откате.
 */
describe('⚠ R23-05: тело города стареет временем арены — у сейва и у ушедшего, как у конца арены', () => {
  it('сейв с арены: откаты города минус время арены (кончившиеся — долой), более поздние с ареной; пулы — города, без регена', () => {
    const { s, p } = rig();
    p.skillCd = { cry: 13.5, long: 25 }; p.hp = 40;
    const home = bodyOf(p, s.world.timeMs);
    p.skillCd = { arena: 3, long: 2 }; p.hp = 999;   // тело арены
    expect(cooldownsForSave(p, { body: home, sec: 20 }), 'клич города прошёл за 20 с арены').toEqual({ arena: 3, long: 5 });
    expect(cooldownsForSave(p, { body: home, sec: 5 })).toEqual({ cry: 8.5, arena: 3, long: 20 });
    const v = vitalsForSave(p, { body: home, sec: 20 }, 1_000);
    expect(v?.hp, 'пулы — тела города').toBe(40);
    expect(v?.cd).toEqual({ arena: 3, long: 5 });
    expect(home.skillCd, 'тело города не тронуто').toEqual({ cry: 13.5, long: 25 });
  });

  it('ушедший с арены: тело города минус время до ухода — откаты, баффы, таймеры; пулы — как были; более поздние с записью арены', () => {
    const { s, p } = rig();
    p.skillCd = { cry: 13.5 }; p.skillBuffs = { cry: 8 }; p.attackCd = 0.5; p.combatTimer = 4; p.hp = 40;
    const home = bodyOf(p, s.world.timeMs);
    const arenaLeft = { ...bodyOf(p, s.world.timeMs), skillCd: { b: 9 }, skillBuffs: { arena: 5 } };
    const got = arenaAwayBody({ body: home, sec: 5 }, arenaLeft);
    expect(got.skillCd).toEqual({ cry: 8.5, b: 9 });
    expect(got.skillBuffs, 'бафф города — минус время арены (не застывший: иначе постаревший откат дал бы второе окно); бафф арены — не его').toEqual({ cry: 3 });
    expect([got.attackCd, got.combatTimer, got.hp, got.pos]).toEqual([0, 0, 40, undefined]);
    expect(arenaAwayBody({ body: home, sec: 20 }).skillCd, 'за 20 с — клич готов').toEqual({});
  });

  it('конец арены и старение — одно правило: `arenaReturn` без пулов = тело города `agedBody` + более поздние откаты арены', () => {
    const { r, s, p } = rig();
    p.skillCd = { cry: 13.5, x: 2 }; p.skillBuffs = { cry: 8 }; p.dodgeCd = 1;
    const home = bodyOf(p, s.world.timeMs);
    p.skillCd = { x: 7 }; p.skillBuffs = {};
    arenaReturn(r, p, home, 6, s.world.timeMs, false);
    const want = agedBody(home, 6);
    keepLaterCooldowns(want.skillCd, { x: 7 });
    expect([p.skillCd, p.skillBuffs, p.dodgeCd]).toEqual([want.skillCd, want.skillBuffs, want.dodgeCd]);
  });
});

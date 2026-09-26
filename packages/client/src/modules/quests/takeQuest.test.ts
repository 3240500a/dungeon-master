import { describe, it, expect, afterEach } from 'vitest';
import { ConfigRegistry, acceptQuest, newBotSave, parseTownCommand, trackObjective, type QuestDef, type SaveState, type TownCommand } from '@dm/shared';
import type { App } from '../../core/app.js';
import { takeQuest } from './questLogPanel.js';

/**
 * ⚠ R6-13: «Взять» зачистку, когда своя зачистка уже на 11 из 12. Сервер R5-20 молча стирал начатое; теперь он начатое не
 * трогает без согласия (`replace`), а клиент спрашивает — и шлёт согласие только после «да».
 */
const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const cull = (id: string, target: string, amount: number): QuestDef => ({
  id, name: `Уничтожить ${amount} (${target})`, description: '', objectives: [{ id: 'o1', type: 'kill', target, amount }], reward: { gold: 10 },
});
const A = cull('rnd_rnd-cull_aaa0', 'zombie-archer', 12);
const B = cull('rnd_rnd-cull_bbb0', 'zombie', 5);

function fake(save: SaveState) {
  const sent: TownCommand[] = [];
  const app = { state: { save }, sendCmd: (c: TownCommand) => { sent.push(c); return sent.length; } } as unknown as App;
  return { app, sent };
}

describe('⚠ R6-13: «Взять» при начатом задании того же вида', () => {
  const G = globalThis as unknown as { window?: unknown };
  afterEach(() => { delete G.window; });

  it('⭐ начатое есть: спросить; «нет» — ничего не ушло; «да» — ушло с согласием, и провод его пропускает', () => {
    const save = newBotSave(reg, 'warrior');
    expect(acceptQuest(save, A).ok).toBe(true);
    for (let i = 0; i < 11; i++) trackObjective(save, 'kill', 'zombie-archer');
    const { app, sent } = fake(save);
    const asked: string[] = [];
    G.window = { confirm: (t: string) => { asked.push(t); return false; } };
    takeQuest(app, B);
    expect(sent, 'отказался — команды нет').toEqual([]);
    expect(asked[0]).toContain('11/12');
    G.window = { confirm: () => true };
    takeQuest(app, B);
    expect(sent).toEqual([{ cmd: 'acceptQuest', questId: B.id, replace: true }]);
    expect(parseTownCommand(sent[0]).ok).toBe(true);
  });

  it('начатого нет — без вопроса и без флага (как было)', () => {
    const save = newBotSave(reg, 'warrior');
    expect(acceptQuest(save, A).ok).toBe(true);   // принято, но ни одного убийства
    const { app, sent } = fake(save);
    let asked = 0;
    G.window = { confirm: () => { asked++; return true; } };
    takeQuest(app, B);
    expect(asked).toBe(0);
    expect(sent).toEqual([{ cmd: 'acceptQuest', questId: B.id }]);
  });
});

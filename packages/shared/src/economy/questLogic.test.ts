import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { newBotSave } from '../sim/playerBot.js';
import { createRng } from '../formulas/rng.js';
import type { QuestDef } from '../types/quest.js';
import { acceptQuest, trackObjective, trackFloor, turnInQuest, ensureMainQuest, generateBoard } from './questLogic.js';

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

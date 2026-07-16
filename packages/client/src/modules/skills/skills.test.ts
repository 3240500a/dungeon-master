import { describe, it, expect, beforeEach } from 'vitest';
import { ConfigRegistry, SAVE_VERSION, type SaveState } from '@dm/shared';
import { GameState } from '../../core/gameState.js';
import { allocateActive } from '../skills-active/allocate.js';
import { allocatePassive } from '../skills-passive/allocate.js';
import { passiveModifiers } from '../skills-passive/passiveStats.js';

const reg = new ConfigRegistry();
reg.loadAll();

function makeState(): GameState {
  const save: SaveState = {
    version: SAVE_VERSION,
    name: 'Тест', charId: 't', createdAt: 0,
    classId: 'warrior',
    level: 30,
    xp: 0,
    gold: 2000,
    attributes: { strength: 20, dexterity: 15, intelligence: 10, vitality: 20 },
    unspentAttributePoints: 0,
    unspentSkillPoints: 5,
    unspentPassivePoints: 5,
    activeSkills: {},
    passiveSkills: {},
    belt: [],
    equipment: {},
    inventory: [],
    stash: [],
    mouseLeft: 'attack',
    mouseRight: null,
    hotbar: [null, null, null],
    quests: [],
    activeQuestDefs: [],
    maxDepth: 0,
    difficultyProgress: {},
    lastDifficulty: 'normal',
  };
  const state = new GameState(save);
  state.passiveModsProvider = () => passiveModifiers(reg, state.save.passiveSkills);
  return state;
}

// Заглушка App для allocatePassive (нужны только config).
const appStub = { config: reg } as unknown as import('../../core/app.js').App;

describe('активные скиллы (единое древо, смежность + класс-гейт)', () => {
  let state: GameState;
  beforeEach(() => { state = makeState(); });

  const tree = reg.get('skill-tree');
  const nbrs = (id: string): string[] => tree.edges.flatMap(([a, b]) => (a === id ? [b] : b === id ? [a] : []));
  const uni = tree.branches.find((b) => !b.classId)!; // универсальная ветка (для всех)
  const entry = uni.entryNode;

  it('вход ветки качается за очки', () => {
    const res = allocateActive(reg, state, entry);
    expect(res.ok).toBe(true);
    expect(state.save.activeSkills[entry]).toBe(1);
    expect(state.save.unspentSkillPoints).toBe(4);
  });

  it('доступность по смежности: дальний узел заблокирован без вложенного соседа', () => {
    const nb1 = nbrs(entry)[0]!;
    const far = nbrs(nb1).find((id) => id !== entry && !nbrs(entry).includes(id))!;
    expect(allocateActive(reg, state, far).ok).toBe(false); // не смежен ничему вложенному
    allocateActive(reg, state, entry);
    expect(allocateActive(reg, state, nb1).ok).toBe(true);   // сосед входа — открыт
  });

  it('активный узел при первом вложении уходит в хотбар', () => {
    const actNb = nbrs(entry).find((id) => tree.nodes.find((n) => n.id === id)?.effect.active);
    if (actNb) {
      allocateActive(reg, state, entry);
      allocateActive(reg, state, actNb);
      expect(state.save.hotbar).toContain(actNb);
    }
  });

  it('класс-ветка чужого класса недоступна', () => {
    const other = tree.branches.find((b) => b.classId && b.classId !== 'warrior');
    if (other) expect(allocateActive(reg, state, other.entryNode).ok).toBe(false);
  });
});

describe('пассивные скиллы (граф со смежностью)', () => {
  it('качается только по смежности, за золото, и модифицирует статы', () => {
    const state = makeState(); // gold 2000
    const tree = reg.get('skills-passive');
    const nbrs = (id: string): string[] => tree.edges.flatMap(([a, b]) => (a === id ? [b] : b === id ? [a] : []));
    // Вход, его сосед (1 хоп) и узел в 2 хопах (не смежен входу) — id-независимо.
    const entry = tree.entryNodes[0]!;
    const nb1 = nbrs(entry)[0]!;
    const nb2 = nbrs(nb1).find((id) => id !== entry && !nbrs(entry).includes(id))!;
    expect(passiveModifiers(reg, state.save.passiveSkills).length).toBe(0);

    expect(allocatePassive(appStub, state, nb2).ok).toBe(false); // 2 хопа — без пути нельзя
    expect(allocatePassive(appStub, state, entry).ok).toBe(true); // вход открыт всегда
    expect(allocatePassive(appStub, state, nb1).ok).toBe(true);   // сосед входа
    expect(allocatePassive(appStub, state, nb2).ok).toBe(true);   // теперь путь есть
    expect(passiveModifiers(reg, state.save.passiveSkills).length).toBeGreaterThan(0);
  });

  it('без золота прокачать нельзя', () => {
    const state = makeState();
    state.save.gold = 0;
    expect(allocatePassive(appStub, state, 'p-str').ok).toBe(false);
  });
});

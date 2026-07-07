import { describe, it, expect, beforeEach } from 'vitest';
import { ConfigRegistry, SAVE_VERSION, type SaveState } from '@dm/shared';
import { GameState } from '../../core/gameState.js';
import { activeTreeFor, allocateActive } from '../skills-active/allocate.js';
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
    gold: 300,
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

describe('активные скиллы', () => {
  let state: GameState;
  beforeEach(() => {
    state = makeState();
  });

  it('качается за очки и уходит в хотбар', () => {
    const res = allocateActive(reg, state, 'a-warrior-fury-t0');
    expect(res.ok).toBe(true);
    expect(state.save.activeSkills['a-warrior-fury-t0']).toBe(1);
    expect(state.save.unspentSkillPoints).toBe(4);
    expect(state.save.hotbar[0]).toBe('a-warrior-fury-t0');
  });

  it('узел с невыполненным требованием заблокирован', () => {
    const res = allocateActive(reg, state, 'a-warrior-fury-m1'); // требует t0
    expect(res.ok).toBe(false);
    allocateActive(reg, state, 'a-warrior-fury-t0');
    expect(allocateActive(reg, state, 'a-warrior-fury-m1').ok).toBe(true);
  });

  it('узел заблокирован по уровню', () => {
    state.save.level = 3; // t0 требует ур.1 (ок), m1 требует ур.6
    expect(allocateActive(reg, state, 'a-warrior-fury-t0').ok).toBe(true);
    const r = allocateActive(reg, state, 'a-warrior-fury-m1');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('уровень');
  });

  it('дерево класса найдено', () => {
    expect(activeTreeFor(reg, 'warrior')?.classId).toBe('warrior');
  });
});

describe('пассивные скиллы (граф со смежностью)', () => {
  it('качается только по смежности, за золото, и модифицирует статы', () => {
    const state = makeState(); // gold 300
    const hpBefore = state.derived().maxHp;

    // Узел вглубь недоступен без пути.
    expect(allocatePassive(appStub, state, 'p-str-r1-0').ok).toBe(false);
    // Вход открыт всегда.
    expect(allocatePassive(appStub, state, 'p-str').ok).toBe(true);
    // Сосед входа.
    expect(allocatePassive(appStub, state, 'p-str-r0-0').ok).toBe(true);
    // Сосед предыдущего — даёт +20 HP (малый узел здоровья, ранг 1).
    expect(allocatePassive(appStub, state, 'p-str-r1-0').ok).toBe(true);
    expect(state.derived().maxHp).toBe(hpBefore + 20);
  });

  it('без золота прокачать нельзя', () => {
    const state = makeState();
    state.save.gold = 0;
    expect(allocatePassive(appStub, state, 'p-str').ok).toBe(false);
  });
});

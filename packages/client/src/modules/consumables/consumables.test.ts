import { describe, it, expect } from 'vitest';
import { ConfigRegistry, SAVE_VERSION, itemFromBaseId, addDebuffStack, newDebuffState, type SaveState, type Item } from '@dm/shared';
import { GameState } from '../../core/gameState.js';
import type { App } from '../../core/app.js';
import { applyUse, beltCapacity, useBeltSlot, useInventoryConsumable, moveInventoryToBelt } from './index.js';

const reg = new ConfigRegistry();
reg.loadAll();
const base = reg.get('items.base');
const pot = (id: string): Item => itemFromBaseId(base, id)!;

function makeApp(over: Partial<SaveState> = {}): { app: App; state: GameState } {
  const save: SaveState = {
    version: SAVE_VERSION, name: 'T', charId: 't', createdAt: 0,
    classId: 'warrior', level: 5, xp: 0, gold: 0,
    attributes: { strength: 20, dexterity: 15, intelligence: 10, vitality: 20 },
    unspentAttributePoints: 0, unspentSkillPoints: 0, unspentMasteryPoints: 0,
    skills: {}, masteries: {}, belt: [], equipment: {}, inventory: [], stash: [],
    mouseLeft: 'attack', mouseRight: null, hotbar: [null, null, null],
    quests: [], activeQuestDefs: [], maxDepth: 0, difficultyProgress: {}, lastDifficulty: 'normal',
    ...over,
  };
  const state = new GameState(save);
  const app = { config: reg, state, bus: { emit: () => {} } } as unknown as App;
  return { app, state };
}

describe('расходники', () => {
  it('лечение клампится по макс. HP и не тратится при полном HP', () => {
    const { app, state } = makeApp();
    const max = state.derived().maxHp;
    state.hp = 10;
    expect(applyUse(app, pot('healing-potion'))).toBe(true);
    expect(state.hp).toBe(max); // heal 140 + 40% → с запасом, кламп по максимуму

    state.hp = max;
    expect(applyUse(app, pot('healing-potion'))).toBe(false); // полное HP — эффекта нет
    expect(state.hp).toBe(max);
  });

  it('зелье маны восстанавливает ману', () => {
    const { app, state } = makeApp();
    state.mana = 0;
    expect(applyUse(app, pot('mana-potion'))).toBe(true);
    expect(state.mana).toBeGreaterThan(0);
  });

  it('противоядие снимает дебаффы', () => {
    const { app, state } = makeApp();
    state.debuffs = newDebuffState();
    addDebuffStack(state.debuffs, { kind: 'poison', chance: 1, maxStacks: 5, durationMs: 5000, mag: 3 }, 0);
    expect(Object.keys(state.debuffs).length).toBeGreaterThan(0);
    expect(applyUse(app, pot('antidote'))).toBe(true);
    expect(Object.keys(state.debuffs).length).toBe(0);
  });

  it('пояс: питьё слота расходует и автопополняет из инвентаря', () => {
    const { app, state } = makeApp();
    state.save.equipment.belt = pot('leather-belt'); // beltSlots = 4
    expect(beltCapacity(app)).toBe(4);
    const max = state.derived().maxHp;
    state.hp = 10;
    state.save.belt = [pot('healing-potion'), null, null, null];
    state.save.inventory = [pot('healing-potion')]; // запас для автопополнения

    expect(useBeltSlot(app, 0)).toBe(true);
    expect(state.hp).toBe(max);
    expect(state.save.belt[0]).not.toBeNull();       // слот пополнен
    expect(state.save.inventory.length).toBe(0);     // запас израсходован
  });

  it('питьё из инвентаря расходует предмет', () => {
    const { app, state } = makeApp();
    const p = pot('healing-potion');
    state.save.inventory = [p];
    state.hp = 10;
    expect(useInventoryConsumable(app, p)).toBe(true);
    expect(state.save.inventory.length).toBe(0);
  });

  it('перенос расходника в слот пояса из инвентаря', () => {
    const { app, state } = makeApp();
    state.save.equipment.belt = pot('leather-belt');
    state.save.belt = [null, null, null, null];
    const p = pot('mana-potion');
    state.save.inventory = [p];
    expect(moveInventoryToBelt(app, p, 1)).toBe(true);
    expect(state.save.belt[1]?.baseId).toBe('mana-potion');
    expect(state.save.inventory.length).toBe(0);
  });
});

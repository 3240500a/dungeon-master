import type { ConfigRegistry } from '../config/registry.js';
import { itemFromBaseId } from '../formulas/itemgen.js';
import { packInventory } from '../inventory/grid.js';
import { SAVE_VERSION, type SaveState } from '../types/save.js';
import type { Item } from '../types/items.js';

/** Базовая броня любого нового персонажа (поверх оружия класса). */
const STARTER_ARMOR = ['leather-cap', 'leather-armor', 'leather-boots', 'leather-belt'];

/**
 * АВТОРИТЕТНЫЙ стартовый сейв нового персонажа из конфига (класс → атрибуты + стартовый
 * набор оружие+броня). ЕДИНАЯ истина создания персонажа: СЕРВЕР строит по нему состояние,
 * когда в БД ещё нет записи по `charId` (клиент не может «нафабриковать» золото/статы/
 * предметы — они игнорируются). Тот же билдер зовёт клиент для локального ростера.
 */
export function newCharacterSave(reg: ConfigRegistry, classId: string, name: string, charId: string): SaveState {
  const cls = reg.get('classes').find((c) => c.id === classId) ?? reg.get('classes')[0]!;
  const equipment: SaveState['equipment'] = {};
  const inventory: Item[] = [];
  for (const id of [cls.startWeaponId, ...STARTER_ARMOR]) {
    const item = itemFromBaseId(reg.get('items.base'), id, reg.get('item-tiers'));
    if (!item) continue;
    if (item.slot && !equipment[item.slot]) { item.pos = null; equipment[item.slot] = item; }
    else inventory.push(item);
  }
  packInventory(inventory, reg.get('balance').inventory);
  return {
    version: SAVE_VERSION,
    name: name.trim() || 'Герой',
    charId,
    createdAt: Date.now(),
    classId: cls.id,
    level: 1, xp: 0, gold: 0,
    attributes: { ...cls.startAttributes },
    unspentAttributePoints: 0, unspentSkillPoints: 0, unspentPassivePoints: 0,
    activeSkills: {}, passiveSkills: {},
    equipment, inventory, stash: [], belt: [],
    mouseLeft: 'attack', mouseRight: null,
    hotbar: [null, null, null],
    quests: [], activeQuestDefs: [], maxDepth: 0,
    difficultyProgress: {}, lastDifficulty: 'normal',
  };
}

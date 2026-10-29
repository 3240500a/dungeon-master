import {
  equipRefusal,
  offhandRefusal,
  type ConfigRegistry,
  type EquipSlot,
  type Item,
  type SaveState,
  type TownCommand,
} from '@dm/shared';

/**
 * ⭐ R11-02: КОМАНДА ПУПСИКА на клик по ячейке `cell` с вещью на курсоре — или причина отказа строкой. Ячейка второй руки шлёт
 * ЦЕЛЬ (`slot: 'offhand'`): без неё сервер надевал вещь в родной слот, и кинжал, брошенный в левую ячейку, менял меч в
 * основной руке. Что встанет во вторую руку, решает то же правило, что у сервера (`offhandRefusal`): раньше своя проверка
 * пупсика не пускала щит под полуторный, который сервер надевает (§25). Требования и место — `paperdollEquip`.
 */
export function paperdollCommand(item: Item, cell: EquipSlot, main: Item | undefined): TownCommand | string {
  if (cell === 'offhand') return offhandRefusal(item, main) ?? { cmd: 'equip', uid: item.uid, slot: 'offhand' };
  return item.slot === cell ? { cmd: 'equip', uid: item.uid } : 'Этот предмет не для этого слота';
}

/**
 * ⭐ R16-08: РЕШЕНИЕ ПУПСИКА ЦЕЛИКОМ — команда `paperdollCommand`, если сервер её исполнит, иначе его причина отказа (`equipRefusal`
 * ядра: требования ПОСЛЕ смены — без уходящей вещи и снятой второй руки, всего надетого, и место под снятое). Раньше пупсик мерил
 * требования, сняв с героя только вещь целевой ячейки (`effectiveAttributes`): двуручник, которому хватало Силы лишь со щитом (щит он
 * снимает), слетал с курсора, а сервер отказывал — окно молчало. `save` — сейв, который видит клиент.
 */
export function paperdollEquip(reg: ConfigRegistry, save: SaveState, item: Item, cell: EquipSlot): TownCommand | string {
  const cmd = paperdollCommand(item, cell, save.equipment.weapon);
  if (typeof cmd === 'string' || cmd.cmd !== 'equip') return cmd;
  return equipRefusal(reg, save, cmd.uid, cmd.slot) ?? cmd;
}

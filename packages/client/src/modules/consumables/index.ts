import { applyConsumable, type Item } from '@dm/shared';
import type { App } from '../../core/app.js';

/**
 * Расходники (зелья/колбы) + D2-пояс быстрых слотов. Эффект применяется к живому
 * `GameState` (hp/мана/дебаффы/временные бафф-моды через `potionBuffs`). Пояс —
 * массив `save.belt` длиной = `beltSlots` надетого пояса; клавиши 1-4 пьют слот,
 * пустой слот автопополняется таким же зельем из инвентаря (как в Diablo 2).
 */

function commit(app: App): void {
  app.bus.emit('state:changed', {}); // сейв персистит сервер; локально только перерисовка
}

/** Ёмкость пояса = beltSlots надетого пояса (0, если пояса нет). */
export function beltCapacity(app: App): number {
  return app.state?.save.equipment.belt?.beltSlots ?? 0;
}

/**
 * Приводит длину `save.belt` к ёмкости пояса: дополняет null или возвращает
 * лишние зелья в инвентарь (при снятии/смене пояса). Вызывать после экип пояса.
 */
export function syncBeltLength(app: App): void {
  const state = app.state;
  if (!state) return;
  const cap = beltCapacity(app);
  const belt = state.save.belt;
  while (belt.length < cap) belt.push(null);
  if (belt.length > cap) {
    for (const it of belt.splice(cap)) if (it) state.save.inventory.push(it);
  }
}

/** Применяет эффект зелья к игроку. Возвращает false, если ничего не изменилось
 * (полное HP у чистого лечения — не тратим зелье). */
export function applyUse(app: App, item: Item): boolean {
  const state = app.state;
  if (!state || !item.use) return false;
  const d = state.derived();
  const u = item.use;
  // Мгновенный эффект (лечение/мана/снятие статусов) — общий с сервером.
  let did = applyConsumable(state, u, d.maxHp, d.maxMana);
  // Временный бафф — клиентский канал potionBuffs (у сервера свой).
  if (u.buffMods?.length && (u.buffDurationSec ?? 0) > 0) {
    state.potionBuffs.push({ mods: u.buffMods.map((m) => ({ ...m })), remaining: u.buffDurationSec! });
    did = true;
  }
  return did;
}

/** Достаёт из инвентаря первый расходник с данным baseId (или null). */
function takeFromInventory(app: App, baseId: string): Item | null {
  const inv = app.state!.save.inventory;
  const idx = inv.findIndex((it) => it.baseId === baseId);
  return idx >= 0 ? inv.splice(idx, 1)[0]! : null;
}

/** Пьёт зелье из слота пояса i: применяет, расходует и автопополняет из инвентаря. */
export function useBeltSlot(app: App, i: number): boolean {
  const state = app.state;
  if (!state) return false;
  const item = state.save.belt[i];
  if (!item || !applyUse(app, item)) return false;
  state.save.belt[i] = takeFromInventory(app, item.baseId);
  commit(app);
  return true;
}

/** Пьёт зелье прямо из инвентаря (клик в панели), расходуя его. */
export function useInventoryConsumable(app: App, item: Item): boolean {
  const state = app.state;
  if (!state || item.kind !== 'consumable') return false;
  if (!applyUse(app, item)) return false;
  const idx = state.save.inventory.findIndex((it) => it.uid === item.uid);
  if (idx >= 0) state.save.inventory.splice(idx, 1);
  commit(app);
  return true;
}

/** Кладёт расходник из инвентаря в слот пояса i (DnD). Прежнее содержимое — в инвентарь. */
export function moveInventoryToBelt(app: App, item: Item, i: number): boolean {
  const state = app.state;
  if (!state || item.kind !== 'consumable' || i < 0 || i >= beltCapacity(app)) return false;
  const idx = state.save.inventory.findIndex((it) => it.uid === item.uid);
  if (idx < 0) return false;
  state.save.inventory.splice(idx, 1);
  const prev = state.save.belt[i] ?? null;
  state.save.belt[i] = item;
  if (prev) state.save.inventory.push(prev);
  commit(app);
  return true;
}

/** Кладёт расходник в первый пустой слот пояса. false — пояса нет/полон. */
export function addConsumableToBelt(app: App, item: Item): boolean {
  const cap = beltCapacity(app);
  const belt = app.state!.save.belt;
  for (let i = 0; i < cap; i++) if (!belt[i]) return moveInventoryToBelt(app, item, i);
  return false;
}

/** Автозаполнение пустых слотов пояса зельями из инвентаря (D2: подбор/открытие). */
export function autofillBelt(app: App): void {
  const state = app.state;
  if (!state) return;
  syncBeltLength(app);
  for (let i = 0; i < state.save.belt.length; i++) {
    if (state.save.belt[i]) continue;
    const pot = state.save.inventory.find((it) => it.kind === 'consumable');
    if (!pot) break;
    state.save.belt[i] = takeFromInventory(app, pot.baseId);
  }
}

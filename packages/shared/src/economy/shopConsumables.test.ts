import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { newCharacterSave } from './newCharacter.js';
import * as town from './townActions.js';
import * as runner from '../session/runner.js';

/**
 * ⭐ R11-13: ЗЕЛЬЯ ЛАВКИ — ТОЛЬКО ВКЛЮЧЁННЫЕ БАЗЫ. Выключенная в редакторе база (`items.base`, `enabled: false`) с монстров не
 * падала, а лавка раскладывала её по пять на каждый заход в город и продавала; бот прогона баланса покупал её в пояс — сим
 * считал зелье, которого в игре нет. Список один на сервер и бота (`shopConsumableIds`).
 */
const reg = (off: string[] = []): ConfigRegistry => {
  const r = new ConfigRegistry();
  r.loadAll();
  if (off.length) r.reload({ 'items.base': structuredClone(r.get('items.base')).map((b) => (off.includes(b.id) ? { ...b, enabled: false } : b)) } as never);
  return r;
};
const ids = (r: ConfigRegistry): string[] => (town as unknown as { shopConsumableIds(r: ConfigRegistry): string[] }).shopConsumableIds(r);
const stock = (r: ConfigRegistry, save: ReturnType<typeof newCharacterSave>): number =>
  (runner as unknown as { stockBeltFromShop(r: ConfigRegistry, s: typeof save): number }).stockBeltFromShop(r, save);

describe('⭐ R11-13: зелья лавки — только включённые базы', () => {
  it('поставочные данные — все четыре зелья лавки', () => {
    expect(ids(reg())).toEqual([...town.SHOP_CONSUMABLES]);
  });

  it('выключенная база в список лавки не идёт', () => {
    expect(ids(reg(['mana-potion']))).toEqual(town.SHOP_CONSUMABLES.filter((id) => id !== 'mana-potion'));
  });

  it('бот прогона: «healing-potion» выключена — пояс только из малых', () => {
    const r = reg(['healing-potion']);
    const save = newCharacterSave(r, 'warrior', 'Bot', 'r11-bot');
    save.gold = 1_000_000;
    save.belt = [];
    const spent = stock(r, save);
    const bought = save.belt.filter(Boolean).map((i) => i!.baseId);
    expect(bought.length).toBe(town.SHOP_CONSUMABLE_STOCK);
    expect(new Set(bought)).toEqual(new Set(['minor-healing-potion']));
    expect(spent).toBeGreaterThan(0);
  });

  it('контроль: с поставочными данными пояс — сперва лечебные, остаток малыми', () => {
    const r = reg();
    const save = newCharacterSave(r, 'warrior', 'Bot', 'r11-bot2');
    save.gold = 1_000_000;
    save.belt = [];
    stock(r, save);
    const bought = save.belt.filter(Boolean).map((i) => i!.baseId);
    expect(bought.filter((b) => b === 'healing-potion').length).toBe(town.SHOP_CONSUMABLE_STOCK);
    expect(bought.length).toBe(6);
  });
});

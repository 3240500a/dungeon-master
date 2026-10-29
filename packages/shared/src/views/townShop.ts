/**
 * ⭐ ВИД «ПРИЛАВОК» (лавка зелий и вкладка «🛒 Купить» кузницы) — сервером: цена покупки и «купит ли» по каждой вещи стока, цена скупки и
 * вопросы перед продажей по каждой вещи сумки.
 *
 * Заменяет C# `DmItem.BuyPrice` (запасная оценка без кадра), `DmItem.SellPrice` (порт `shopSellPrice` с полом `SalvageWorth`),
 * `DmTown.CanBuy` и `DmTown.DisposePrompts(…, "sell", …, цена)` (ShopPanel.cs, ForgePanel.DrawBuy). Правила — @dm/shared: `shopBuyPrice`,
 * `canBuy`, `shopSellPrice` — те же, которыми сервер исполняет `buy` (`buyItem` → `priceRaised` по `maxGold`) и `sell` (`sellItem` →
 * `priceDropped` по `minGold`): `price` вида — согласие команды (`maxGold` / `minGold`), и оно = факт.
 */
import type { ConfigRegistry } from '../config/registry.js';
import type { Item, SaveState } from '../types/index.js';
import { canBuy, shopBuyPrice, shopSellPrice } from '../economy/townActions.js';
import { disposePrompts } from './townSalvage.js';
import { journalOf, type StashView } from './townItem.js';

/** Товар прилавка: цена (→ `maxGold` команды `buy`) и почему не купит (`null` — купит). DTO Unity — новый класс `ShopOffer`. */
export interface ShopOffer { price: number; refusal: string | null }
/** Вещь сумки на продажу: цена (→ `minGold` команды `sell`; подпись «+N»), отказ (печать), вопросы перед продажей. DTO — `SellOffer`. */
export interface SellOffer { price: number; refusal: string | null; prompts: string[] }
/** C# DTO `ShopView`: словари по `uid` (Newtonsoft: `Dictionary<string, ShopOffer>`). */
export interface ShopView { buy: Record<string, ShopOffer>; sell: Record<string, SellOffer> }

/** Отказ продажи до цены — тот же, что у `sellItem` (печать не товар, Ф5-1). */
const SEAL_NOT_SOLD = 'Печать не продаётся — её тратят на алтаре';

/** Цена покупки и «купит ли» (`canBuy`: золото и место в сумке) — один товар. */
export function shopOffer(reg: ConfigRegistry, save: SaveState, item: Item): ShopOffer {
  const price = shopBuyPrice(reg, item);
  const can = canBuy(reg, save, item, price);
  return { price, refusal: can.ok ? null : can.reason ?? 'нельзя' };
}

/** Цена скупки и вопросы перед продажей — одна вещь сумки. `journal` — журнал кузнеца (что засчитал бы разбор у кузнеца). */
export function sellOffer(reg: ConfigRegistry, item: Item, journal: Parameters<typeof disposePrompts>[3]): SellOffer {
  const price = shopSellPrice(reg, item);
  if (item.kind === 'seal') return { price, refusal: SEAL_NOT_SOLD, prompts: [] };
  return { price, refusal: null, prompts: disposePrompts(reg, item, 'sell', journal, price) };
}

/**
 * ⭐ ПРИЛАВОК ЦЕЛИКОМ: `stock` — то, что сервер выставил этому герою (зелья комнаты + сток кузнеца), сумка — `save.inventory`.
 */
export function shopView(reg: ConfigRegistry, save: SaveState, stash: StashView, stock: readonly Item[]): ShopView {
  const journal = journalOf(stash);
  return {
    buy: Object.fromEntries(stock.map((it) => [it.uid, shopOffer(reg, save, it)])),
    sell: Object.fromEntries(save.inventory.map((it) => [it.uid, sellOffer(reg, it, journal)])),
  };
}

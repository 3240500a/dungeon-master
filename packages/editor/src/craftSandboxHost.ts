import {
  craftAction, createRng, enchantAction, fullJournal, sketchAction,
  type AccountStash, type ConfigRegistry, type Item, type SaveState,
} from '@dm/shared';
import type { CraftHost } from '@dm/client/modules/town/craftPanel.js';
import type { CraftSandbox } from './craft.js';

// Хозяин окна ковки песочницы — отдельным модулем без DOM и без `@dm/client` в рантайме: иначе правило «песочница
// ≡ игра» не проверить в node-прогоне (`craftSandbox.test.ts`).

const INF = 99999;
function infiniteWallet(reg: ConfigRegistry): Record<string, number> {
  return Object.fromEntries(reg.get('craft-materials').map((m) => [m.id, INF]));
}

/**
 * Хозяин окна ковки в песочнице: ковка и зачарование — ТЕ ЖЕ действия, что зовёт сервер
 * (`craftAction` / `enchantAction`), а не своя копия списания. Сундуком им служат кошелёк и журнал
 * песочницы, сумкой — черновая: скованная вещь живёт в окне, а не в сумке героя. «Бесконечное сырьё» —
 * черновой кошелёк на один вызов, настоящий при этом не тратится.
 */
export function sandboxHost(reg: ConfigRegistry, sb: CraftSandbox, save: SaveState): CraftHost {
  /** Черновая сумка и сундук на один вызов: действие пишет в них, песочница забирает нужное. */
  const scratch = (items: Item[]): { bag: SaveState; stash: AccountStash } => ({
    bag: { ...save, inventory: items, gold: host.gold() },
    stash: { version: 1, tabs: [], materials: sb.infinite ? infiniteWallet(reg) : sb.wallet, forgeJournal: sb.journal, craftNonces: [] },
  });
  const host: CraftHost = {
    wallet: () => (sb.infinite ? infiniteWallet(reg) : sb.wallet),
    gold: () => (sb.infinite ? 9_999_999 : sb.gold),
    journal: () => (sb.fullJournal ? fullJournal(reg) : sb.journal),
    save: () => save,
    allowDisabledMaterials: sb.showDisabled,
    craft: (input) => {
      // Ковка = тот же расчёт, что предпросмотр, плюс бросок базы (`rng`): до ковки окно видит вилку.
      const { bag, stash } = scratch([]);
      const r = craftAction(reg, bag, stash, `sandbox-${sb.seed}`, input, createRng(sb.seed++),
        { fullJournal: sb.fullJournal, allowDisabledMaterials: sb.showDisabled });
      const item = r.ok ? bag.inventory.find((i) => i.uid === r.uid) : undefined;
      if (!item) return { ok: false, reason: r.reason };
      if (!sb.infinite) { sb.gold = bag.gold; sb.wallet = stash.materials ?? {}; }
      // Кодекс «сковал» пишет ядро — песочница только забирает журнал обратно.
      if (stash.forgeJournal) sb.journal = stash.forgeJournal;
      sb.drop = null; sb.fight = null;
      return { ok: true, item: { ...item, pos: null } };
    },
    enchant: (item, rarity) => {
      const { bag } = scratch([{ ...item }]);
      const r = enchantAction(reg, bag, item.uid, rarity, createRng(sb.seed++));
      const next = r.ok ? bag.inventory.find((i) => i.uid === r.uid) : undefined;
      if (!next) return { ok: false, reason: r.reason };
      if (!sb.infinite) sb.gold = bag.gold;
      sb.drop = null; sb.fight = null;
      return { ok: true, item: { ...next, pos: null } };
    },
    // R3-11: эскиз — тем же ядром, что у сервера (`sketchAction`), над журналом песочницы.
    sketch: (variantId) => {
      const stash: AccountStash = { version: 1, tabs: [], materials: {}, forgeJournal: sb.journal, craftNonces: [] };
      const r = sketchAction(reg, stash, variantId);
      if (!r.ok) return { ok: false, reason: r.reason };
      if (stash.forgeJournal) sb.journal = stash.forgeJournal;
      return { ok: true, reason: r.unlocked?.join(' · ') };
    },
    equip: (item) => { save.equipment.weapon = item; sb.fight = null; },
    // ⭐ Где скованная вещь — как в игре (R1-26): надетая «не в сумке», и окно гасит зачарование той же причиной,
    // что сервер (`enchantAction` берёт только из сумки). Без этого зачаровывалась копия, а в руках оставалась
    // прежняя — и «в руках против скованного» сравнивало не то оружие. Сумки у песочницы нет: не надетая —
    // та, что в окне.
    find: (uid) => {
      const worn = save.equipment.weapon;
      if (worn?.uid === uid) return { item: worn, inBag: false };
      const own = sb.win?.crafted;
      return own?.uid === uid ? { item: own, inBag: true } : null;
    },
  };
  return host;
}

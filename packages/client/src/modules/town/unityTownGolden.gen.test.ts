/**
 * ПРОДЮСЕР golden-эталона ГОРОДА для Unity-клиента (R2-35, R2-36). На каждом `npm test` перегенерирует
 * `__golden__/unity_town.json` из ТЕКУЩЕГО веб-кода (веб = источник истины), как эталон походки. Unity сверяет с
 * ним свои порты: цену скупки лавкой (`DmItem.SellPrice` ≡ `shopSellPrice`) и «куда ляжет брошенный предмет»
 * (`DmHeld.DropCell` ≡ `heldItem.dropCell`). Меню Unity: DM ▸ Verify Town Parity. Правили веб осознанно — эталон
 * обновится здесь, потом скопировать в Assets/DM/UI/Tests/unity_town_golden.json.
 * Цену ПОКУПКИ Unity не считает вовсе — её шлёт сервер в кадре `shop` (`prices`), сверять нечего.
 * ⭐ R11-02: раздел `offhand` — «что встанет во вторую руку» (`offhandRefusal`: щит / дуал-вилд) для порта пупсика Unity.
 * ⭐ U3 (Unity — основной клиент): разделы `forge` — цена работы кузнеца (`forgeGold`), сырьё подъёма (`upgradeCost`), ворота
 * (`canUpgradeItem` / `canRerollItem`) и имя следующей ступени (`nextTierOf`); `equip` — решение пупсика целиком (`paperdollEquip`:
 * ячейка, вторая рука, требования после смены, место под снятое); `fees` — согласие сбросов и узла мастерства (`skillRespecFee`,
 * `passiveRespecFee`, `passiveNodeCost`). Unity шлёт эти числа серверу как `maxGold`/`maxMaterials` и гасит по ним кнопки.
 */
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  CRAFT_SLOT_LIST, ConfigRegistry, MATERIAL_STEPS, affixSlotsFillable, canRerollItem, canUpgradeItem, craftWeapon, createRng, enchantItem, forgeGold,
  generateItem, itemFromBaseId, keySlotOf, keyVariantsByBase, materialItem, newCharacterSave, nextTierOf, offhandRefusal, parseTownCommand,
  passiveRespecFee, repairCost, rerollMaterials, salvageWorth, shapeFoundWeapon, shopSellPrice, skillRespecFee, stashDims, tierOfSteps, UNIQUE_NO_UPGRADE, upgradeCost,
  upgradedItem, variantsFor,
  type CraftParts, type EquipSlot, type Item, type SaveState,
} from '@dm/shared';
import { dropCell } from '../inventory/heldItem.js';
import { paperdollEquip } from '../inventory/equip.js';
import { passiveNodeCost } from '../skills-passive/allocate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Выключенная копия ключевой детали меча — её записывает на найденный меч раздел `forge` (R6-10). */
const OFF_PART = 'sw-s-xxii-off';
/**
 * Эталонный конфиг = боевой + две ВЫКЛЮЧЕННЫЕ приманки, мимо которых порт обязан пройти так же, как ядро: копия сырья `iron-3` прямо ПЕРЕД
 * ним (лестница подъёма берёт первое ВКЛЮЧЁННОЕ сырьё семьи и ступени) и копия ключевой детали меча (R6-10: записанная на найденную вещь
 * деталь, выключенная после находки, на новую ступень не переезжает — «Эта форма выше не куётся»). Прочие расчёты приманок не видят.
 */
const reg = (() => {
  const r = new ConfigRegistry();
  r.loadAll();
  const mats = r.get('craft-materials');
  const parts = r.get('weapon-parts');
  const blade = parts.find((p) => p.id === 'sw-s-xxii')!;
  r.reload({
    'craft-materials': mats.flatMap((m) => (m.id === 'iron-3' ? [{ ...m, id: 'iron-3-off', enabled: false }, m] : [m])),
    'weapon-parts': [...parts, { ...blade, id: OFF_PART, enabled: false }],
  });
  return r;
})();

/** Вещи для цены скупки: все ступени × редкости, уник, зелье, сырьё разной длины стека и без счётчика, стартовый комплект (R5-23). */
function sellItems(): Item[] {
  const out: Item[] = [];
  const bal = reg.get('balance');
  const weapons = reg.get('items.base').filter((b) => b.kind === 'weapon' && b.enabled !== false);
  const armor = reg.get('items.base').filter((b) => b.kind === 'armor' && b.enabled !== false);
  let seed = 1;
  for (const tier of reg.get('item-tiers')) {
    for (const rarity of ['normal', 'magic', 'rare', 'unique'] as const) {
      for (const pool of [weapons, armor]) {
        const lvl = tier.minItemLevel + 2;
        const it = generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'), {
          dropBias: 1, itemLevel: lvl, tierLevel: lvl, baseId: pool[seed % pool.length]!.id, tiers: reg.get('item-tiers'),
          rarities: reg.get('rarities'), forceRarity: rarity, maxReqTotal: bal.maxTotalRequirement, baseRoll: bal.loot.baseRoll, origin: 'drop',
        }, createRng(seed++));
        out.push(it);
      }
    }
  }
  const potion = itemFromBaseId(reg.get('items.base'), 'healing-potion', undefined, 'shop');
  if (potion) out.push(potion);
  const mats = reg.get('craft-materials');
  for (const [i, m] of [mats[0]!, mats[7]!, mats.at(-1)!].entries()) {
    for (const n of [1, 7, 50]) out.push(materialItem(m, n, `mat-${i}-${n}`));
  }
  const noCount = materialItem(mats[3]!, 1, 'mat-nocount') as Item & { count?: number };
  delete noCount.count;
  out.push(noCount);
  // ⭐ R5-23: стартовый комплект КАЖДОГО класса — нетронутый (`origin: 'start'`, лавка берёт за 1: R3-04) и оружие,
  // поднятое у кузнеца (`tierForged`, цена по формуле: R4-34). Без них сверка Unity не видела правила комплекта вовсе.
  let forged = false;
  for (const cls of reg.get('classes').filter((c) => c.enabled !== false)) {
    const kit = newCharacterSave(reg, cls.id, 'golden', 'golden');
    for (const it of [...Object.values(kit.equipment), ...kit.inventory]) if (it) out.push(it);
    const up = !forged && kit.equipment.weapon ? upgradedItem(reg, kit.equipment.weapon) : undefined;
    if (up) { out.push(up); forged = true; }
  }
  // ⭐ D4 (06.10): скупка не дешевле выхода разбора у кузнеца (`salvageWorth`) — у скованных пол включается (переплавка возвращает долю
  // заплаченного сырья, а формула вещи о нём не знает): без них сверка Unity пола не видела вовсе.
  for (const [cls, hands] of [['sword', 1], ['axe', 2], ['staff', 2]] as const) {
    for (const step of [1, 3, 5]) { const w = forgedWeapon(cls, hands, step); if (w) out.push(w); }
  }
  // uid — постоянный: эталон не должен меняться от прогона к прогону.
  return out.map((it, i) => ({ ...it, uid: `golden-${i}` }));
}

/** Броски предмета: размеры × точки захвата × клетки у краёв сумки и вкладки сундука. */
function dropCases(): { cols: number; rows: number; w: number; h: number; grabOx: number; grabOy: number; col: number; row: number; cell: { x: number; y: number } | null }[] {
  const out = [];
  const bag = reg.get('balance').inventory;
  for (const dims of [{ cols: bag.cols, rows: bag.rows }, stashDims(reg)]) {
    const cols = [0, 1, dims.cols - 2, dims.cols - 1], rows = [0, 1, dims.rows - 2, dims.rows - 1];
    for (const [w, h] of [[1, 1], [1, 2], [2, 2], [2, 3], [1, 4]] as const) {
      for (let gx = 0; gx < w; gx++) for (let gy = 0; gy < h; gy++) {
        for (const col of cols) for (const row of rows) {
          out.push({ cols: dims.cols, rows: dims.rows, w, h, grabOx: gx, grabOy: gy, col, row, cell: dropCell({ gridW: w, gridH: h }, gx, gy, col, row, dims) });
        }
      }
    }
  }
  return out;
}

/** ⭐ R11-02: основная рука × вещь → отказ второй руки (`offhandRefusal`) или `null`. Только поля, которые правило читает. */
function offhandCases(): { main: HandView | null; item: HandView; refusal: string | null }[] {
  const view = (it: Item): HandView => ({ slot: it.slot ?? null, hands: it.hands ?? 1, versatile: !!it.versatile });
  const items = ['short-sword', 'dagger', 'hand-crossbow', 'apprentice-wand', 'greatsword', 'claymore', 'wooden-shield', 'leather-cap']
    .map((id) => itemFromBaseId(reg.get('items.base'), id, undefined, 'drop')!);
  const out = new Map<string, { main: HandView | null; item: HandView; refusal: string | null }>();
  for (const main of [undefined, ...items.filter((it) => it.slot === 'weapon')]) {
    for (const item of items) {
      const c = { main: main ? view(main) : null, item: view(item), refusal: offhandRefusal(item, main) };
      out.set(JSON.stringify([c.main, c.item]), c);   // разные базы с одинаковыми руками — один случай
    }
  }
  return [...out.values()];
}
type HandView = { slot: string | null; hands: number; versatile: boolean };

/** Поля объекта по списку (нет поля — нет и ключа): в эталон — ровно то, что читает порт Unity, в той же форме, что `/api/config`. */
function pick(o: object, keys: readonly string[]): Record<string, unknown> {
  const src = o as Record<string, unknown>;
  return Object.fromEntries(keys.filter((k) => src[k] !== undefined).map((k) => [k, src[k]]));
}

/** Скованное оружие семейства `cls`×`hands` целиком из материала ступени `step` (как сторож разбора) — или `undefined`, если не собрать. */
function forgedWeapon(cls: string, hands: number, step: number): Item | undefined {
  const keySlot = keySlotOf(reg, cls);
  const group = keyVariantsByBase(reg, cls, hands).find((g) => g.variants.some((p) => p.stepMin <= step && step <= p.stepMax));
  if (!group) return undefined;
  const parts = {} as CraftParts;
  for (const slot of CRAFT_SLOT_LIST) {
    const pool = slot === keySlot ? group.variants : variantsFor(reg, cls, slot, hands);
    const p = pool.find((v) => v.stepMin <= step && step <= v.stepMax);
    if (!p) return undefined;
    parts[slot] = { id: p.id, step };
  }
  const pv = craftWeapon(reg, { weaponClass: cls, hands, parts }, { rng: createRng(5) });
  return pv.ok ? pv.item : undefined;
}

/**
 * ⭐ U3: ВЕЩИ ДЛЯ КУЗНИЦЫ — какими они бывают в игре. Найденные — через `shapeFoundWeapon` (детали записаны, как у дропа сессии):
 * каждая включённая база (оружие, броня, щит, украшение) — на нижней, средней или верхней ступени своего окна по кругу, редкость тоже
 * по кругу. Плюс копии без поля тира (сейв старше Ч5: тир выводится по статам), сломанные, с исчерпанными перекатками; стартовый
 * комплект и поднятое у кузнеца; скованные трёх семейств на трёх ступенях материала и их зачарованные (ёмкость, пул аффиксов); форма
 * без цены, пул, который форму не наберёт, вещь неизвестной базы.
 */
function forgeItems(): Item[] {
  const out: Item[] = [];
  const bal = reg.get('balance');
  const tiers = [...reg.get('item-tiers')].sort((a, b) => a.minItemLevel - b.minItemLevel);
  const rarities = ['normal', 'magic', 'rare', 'unique'] as const;
  let seed = 101;
  for (const [n, base] of reg.get('items.base').filter((b) => b.enabled !== false && b.kind !== 'consumable').entries()) {
    const lo = Math.max(0, tiers.findIndex((t) => t.id === base.minTier));
    const hiAt = tiers.findIndex((t) => t.id === base.maxTier);
    const hi = hiAt < 0 ? tiers.length - 1 : hiAt;
    const lvl = tiers[[lo, Math.round((lo + hi) / 2), hi][n % 3]!]!.minItemLevel + 1;
    const raw = generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'), {
      dropBias: 1, itemLevel: lvl, tierLevel: lvl, baseId: base.id, tiers: reg.get('item-tiers'), rarities: reg.get('rarities'),
      forceRarity: rarities[seed % rarities.length]!, maxReqTotal: bal.maxTotalRequirement, baseRoll: bal.loot.baseRoll, origin: 'drop',
    }, createRng(seed++));
    out.push(shapeFoundWeapon(reg, raw));
  }
  const found = [...out];
  for (const [i, it] of found.entries()) {
    if (i % 4 === 0) { const old: Item = { ...it }; delete old.tier; out.push(old); }   // сейв старше поля тира
    if (i % 9 === 1) out.push({ ...it, broken: true });
    if (i % 9 === 2) out.push({ ...it, rerolls: bal.forgePrices.rerollLimit });
    if (i % 9 === 3) out.push({ ...it, rerolls: bal.forgePrices.rerollLimit - 1 });
  }
  // Найденный меч с коротким клинком (окно ступеней до 3) на t5: t6 из его деталей не собрать — «Эта форма выше не куётся» (R4-31).
  const sword = found.find((it) => it.baseId === 'short-sword' && it.foundParts);
  if (sword?.foundParts) out.push({ ...sword, tier: 't5', foundParts: { ...sword.foundParts, strike: { id: 'sw-s-xxii', step: 3 } } });
  // R6-10: ключевая деталь найденного меча выключена после находки — подъёма нет, хотя те же ступени собрались бы.
  if (sword?.foundParts) out.push({ ...sword, foundParts: { ...sword.foundParts, strike: { id: OFF_PART, step: sword.foundParts.strike.step } } });
  const kitSeen = new Set<string>();
  for (const cls of reg.get('classes').filter((c) => c.enabled !== false)) {
    const kit = newCharacterSave(reg, cls.id, 'golden', 'golden');
    for (const it of [...Object.values(kit.equipment), ...kit.inventory]) {
      if (!it || kitSeen.has(it.baseId)) continue;   // комплекты классов делят броню — одна вещь на базу
      kitSeen.add(it.baseId);
      out.push(it);
      const up = canUpgradeItem(reg, it).ok ? upgradedItem(reg, it) : undefined;
      if (up) out.push(up);
    }
  }
  const crafted: Item[] = [];
  for (const [cls, hands] of [['sword', 1], ['axe', 2], ['staff', 2]] as const) {
    for (const step of [1, 3, 5]) {
      const w = forgedWeapon(cls, hands, step);
      if (!w) continue;
      crafted.push(w);
      for (const r of ['magic', 'rare'] as const) { const e = enchantItem(reg, w, r, createRng(seed++)); if (e) crafted.push(e); }
    }
  }
  out.push(...crafted);
  const rare = crafted.find((it) => it.rarity === 'rare');
  if (rare) {
    out.push({ ...rare, affixCap: { prefix: 3, suffix: 3 } });   // форма без строки в `craft.formMult`
    out.push({ ...rare, itemLevel: 0 });                          // пул пуст: форму не набрать
    out.push({ ...rare, broken: true });
  }
  out.push({ ...found[0]!, baseId: 'no-such-base' });
  return out.map((it, i) => ({ ...it, uid: `forge-${i}` }));
}

/** Поля вещи, которые читают правила кузницы (цена, ворота, сырьё, имя ступени): в эталон — только они, как в разделе `offhand`. */
const FORGE_FIELDS = ['uid', 'baseId', 'name', 'kind', 'slot', 'armorClass', 'weaponClass', 'rarity', 'tier', 'itemLevel', 'baseStats', 'baseRoll',
  'spreadMult', 'broken', 'rerolls', 'parts', 'foundParts', 'affixCap', 'origin', 'tierForged', 'bornTier'] as const;
/** Поля вещи, которые читает решение пупсика (`equipPlan`): ячейка, руки, требования и прибавки, место в сумке, ёмкость пояса. */
const EQUIP_FIELDS = ['uid', 'baseId', 'name', 'kind', 'slot', 'hands', 'versatile', 'broken', 'requirements', 'baseStats', 'affixes', 'gridW', 'gridH',
  'pos', 'beltSlots'] as const;
const equipView = (it: Item | null | undefined): Record<string, unknown> | null =>
  it ? { ...pick(it, EQUIP_FIELDS), affixes: it.affixes.filter((a) => a.modifier).map((a) => ({ modifier: a.modifier })) } : null;

/** Ответ кузницы на вещь: отказ строкой или `null` (можно); цена — число, у формы без цены (`NaN`) — `null`. */
function forgeCase(item: Item) {
  const gold = (op: 'upgrade' | 'reroll' | 'repair'): number | null => { const g = forgeGold(reg, item, op); return Number.isFinite(g) ? g : null; };
  const up = canUpgradeItem(reg, item), rr = canRerollItem(reg, item);
  return {
    item: pick(item, FORGE_FIELDS),
    upgrade: up.ok ? null : up.reason ?? '',
    reroll: rr.ok ? null : rr.reason ?? '',
    // ⭐ §7: сырьё подъёма — по целевой ступени (основа = верх вилки разбора как находки + расходник I), починки — по нынешней.
    cost: upgradeCost(reg, item),
    repairCost: repairCost(reg, item),
    // ⭐ §6.2: эссенция перекатки (половина зачарования до редкости вещи) — согласие `maxMaterials` команды `forgeReroll`.
    rerollEssence: rerollMaterials(reg, item),
    gold: { upgrade: gold('upgrade'), reroll: gold('reroll'), repair: gold('repair') },
    next: nextTierOf(reg, item)?.name ?? null,
  };
}

type EquipView = Pick<SaveState, 'attributes' | 'equipment' | 'inventory' | 'belt'>;
const DOLL: readonly EquipSlot[] = ['weapon', 'offhand', 'helm', 'chest', 'gloves', 'boots', 'belt', 'ring', 'amulet'];

/**
 * ⭐ U3: РЕШЕНИЕ ПУПСИКА (`paperdollEquip`: ячейка + `offhandRefusal` + `equipRefusal`) — команда или причина отказа строкой. Сейв — только
 * то, что читает правило (атрибуты, надетое, сумка, пояс), вещь — её поля для правила. Три класса: комплект и пачка вещей в сумке × ячейки
 * (у первого — все девять; со своими атрибутами класса и со щитом в руке — руки); особые сейвы —
 * сломанное, требования, которые держит уходящая вещь (кольцо, щит), пояс меньше колб, полная сумка, вещь не из сумки.
 */
function equipCases() {
  const base = (id: string): Item => ({ ...itemFromBaseId(reg.get('items.base'), id, undefined, 'drop')! });
  const view = (s: SaveState): EquipView => structuredClone({ attributes: s.attributes, equipment: s.equipment, inventory: s.inventory, belt: s.belt });
  const dims = reg.get('balance').inventory;
  const put = (s: EquipView, it: Item): Item => {
    for (let y = 0; y + it.gridH <= dims.rows; y++) for (let x = 0; x + it.gridW <= dims.cols; x++) {
      const free = s.inventory.every((o) => !o.pos || x >= o.pos.x + o.gridW || x + it.gridW <= o.pos.x || y >= o.pos.y + o.gridH || y + it.gridH <= o.pos.y);
      if (free) { const placed = { ...it, pos: { x, y } }; s.inventory.push(placed); return placed; }
    }
    throw new Error(`эталон: «${it.name}» не лёг в сумку`);
  };
  /** Ячейки на вещь: все девять — или своя, вторая рука, основная и заведомо чужая (кольцо). */
  const all = (s: EquipView, cells?: readonly EquipSlot[]): { uid: string; cell: EquipSlot }[] => s.inventory.flatMap((it) =>
    [...new Set<EquipSlot>(cells ?? [it.slot ?? 'belt', 'offhand', 'weapon', 'ring'])].map((cell) => ({ uid: it.uid, cell })));
  const run = (s: EquipView, list: { uid: string; cell: EquipSlot }[]) => ({
    save: {
      attributes: s.attributes,
      equipment: Object.fromEntries(Object.entries(s.equipment).filter(([, v]) => v).map(([k, v]) => [k, equipView(v)])),
      inventory: s.inventory.map(equipView),
      belt: s.belt.map(equipView),
    },
    checks: list.map(({ uid, cell }) => {
      const own = s.inventory.find((i) => i.uid === uid);
      const item = own ?? { ...base('short-sword'), uid };   // вещь не из сумки (с курсора из сундука) — она в кейсе
      return { uid, cell, result: paperdollEquip(reg, s as SaveState, item, cell), ...(own ? {} : { item: equipView(item) }) };
    }),
  });
  const out: ReturnType<typeof run>[] = [];
  let n = 0;
  const uidOf = (it: Item): Item => ({ ...it, uid: `eq-${n++}` });
  const pack = ['short-sword', 'dagger', 'hand-crossbow', 'apprentice-wand', 'greatsword', 'claymore', 'wooden-shield', 'leather-cap', 'healing-potion'];
  for (const [ci, cls] of reg.get('classes').filter((c) => c.enabled !== false).slice(0, 3).entries()) {
    const s = view(newCharacterSave(reg, cls.id, 'golden', 'golden'));
    s.inventory = s.inventory.map(uidOf);
    for (const k of Object.keys(s.equipment) as EquipSlot[]) if (s.equipment[k]) s.equipment[k] = uidOf(s.equipment[k]!);
    for (const id of pack) put(s, uidOf(base(id)));
    s.attributes = { strength: 60, dexterity: 60, intelligence: 60, vitality: 60 };
    out.push(run(s, all(s, ci === 0 ? DOLL : undefined)));
    // Тот же сейв с атрибутами класса: двуручник и полуторный — «Недостаточно атрибутов».
    out.push(run({ ...s, attributes: { ...cls.startAttributes } }, all(s, ['weapon', 'offhand'])));
    // Со щитом в руке: полуторный встаёт (щит остаётся), двуручник снимает щит — нужно место под него.
    const shielded = structuredClone(s);
    shielded.equipment.offhand = uidOf(base('wooden-shield'));
    out.push(run(shielded, all(shielded, ['weapon', 'offhand'])));
  }
  // Требования держит уходящая вещь: меч стоит на кольце и щите (+10 Силы каждый); двуручник снимает щит.
  {
    const s = view(newCharacterSave(reg, 'warrior', 'golden', 'golden'));
    s.inventory = [];
    s.attributes = { strength: 20, dexterity: 20, intelligence: 20, vitality: 20 };
    const ringA = { ...uidOf(base('simple-ring')), baseStats: [{ stat: 'strength', kind: 'flat' as const, value: 10 }], requirements: {} };
    const sword = { ...uidOf(base('short-sword')), requirements: { strength: 40 } };   // держится на кольце И щите
    const shield = { ...uidOf(base('wooden-shield')), baseStats: [{ stat: 'strength', kind: 'flat' as const, value: 10 }], requirements: {} };
    s.equipment = { ring: ringA, weapon: sword, offhand: shield };
    put(s, uidOf(base('simple-ring')));
    put(s, { ...uidOf(base('greatsword')), requirements: { strength: 30 } });   // полуторный: щит остаётся
    put(s, { ...uidOf(base('claymore')), requirements: { strength: 35 } });     // двуручник снимает щит — Силы не хватит
    put(s, { ...uidOf(base('dagger')), requirements: {} });
    put(s, { ...uidOf(base('short-sword')), broken: true });
    put(s, { ...uidOf(base('leather-cap')), requirements: { intelligence: 21 } });
    out.push(run(s, [...all(s), { uid: 'not-in-bag', cell: 'weapon' }]));
  }
  // Пояс меньше колб (лишние — в сумку), и то же с полной сумкой; полная сумка под двуручником со щитом.
  {
    const s = view(newCharacterSave(reg, 'warrior', 'golden', 'golden'));
    s.inventory = [];
    s.attributes = { strength: 60, dexterity: 60, intelligence: 60, vitality: 60 };
    const bigBelt = uidOf(base('leather-belt'));
    s.equipment = { belt: { ...bigBelt, beltSlots: 4 }, weapon: uidOf(base('greatsword')) };
    s.belt = [uidOf(base('healing-potion')), uidOf(base('healing-potion')), uidOf(base('mana-potion')), null];
    put(s, { ...uidOf(base('cloth-sash')), beltSlots: 1 });
    put(s, uidOf(base('wooden-shield')));
    put(s, uidOf(base('dagger')));
    out.push(run(s, all(s)));
    const full = structuredClone(s);
    for (;;) { try { put(full, uidOf(base('healing-potion'))); } catch { break; } }
    out.push(run(full, all(full).filter((c) => full.inventory.find((i) => i.uid === c.uid)?.kind !== 'consumable')));
  }
  return out;
}

/** ⭐ U3: ступень вещи из ступеней материала деталей (`tierOfSteps`, §11) — все 5⁴ сочетаний: на ней держится подъём найденного (R4-31). */
function stepCases(): { steps: number[]; tier: number }[] {
  const out: { steps: number[]; tier: number }[] = [];
  for (let a = 1; a <= MATERIAL_STEPS; a++) for (let b = 1; b <= MATERIAL_STEPS; b++) for (let c = 1; c <= MATERIAL_STEPS; c++) for (let d = 1; d <= MATERIAL_STEPS; d++) {
    out.push({ steps: [a, b, c, d], tier: tierOfSteps(reg, { strike: { step: a }, grip: { step: b }, bind: { step: c }, head: { step: d } }).tier });
  }
  return out;
}

/**
 * ⭐ U3: наберёт ли пул оплаченную форму при любом броске (`affixSlotsFillable`, §17) — на случайных малых пулах (тёзки по id, общие
 * группы, перекос сторон): живой пул аффиксов велик, и худшие случаи сторон в нём не встречаются.
 */
function fillableCases() {
  const rng = createRng(77);
  const out: { pool: { id: string; kind: 'prefix' | 'suffix'; group?: string }[]; slots: { minAffixes: number; maxAffixes: number; maxPrefix: number; maxSuffix: number }; fillable: boolean }[] = [];
  for (let i = 0; i < 160; i++) {
    const pool = Array.from({ length: rng.int(0, 8) }, () => ({
      id: `a${rng.int(0, 6)}`, kind: (rng.chance(0.5) ? 'prefix' : 'suffix') as 'prefix' | 'suffix', ...(rng.chance(0.5) ? { group: `g${rng.int(0, 3)}` } : {}),
    }));
    const P = rng.int(0, 3), S = rng.int(0, 3), total = rng.int(0, P + S);
    const slots = { minAffixes: rng.chance(0.85) ? total : rng.int(0, 7), maxAffixes: total, maxPrefix: P, maxSuffix: S };
    out.push({ pool, slots, fillable: affixSlotsFillable(pool, slots) });
  }
  return out;
}

/** ⭐ U3: согласие сбросов и узла мастерства — комиссия за вложенные ранги и цена следующего ранга узла. */
function feeCases() {
  const tree = reg.get('mastery-tree');
  const gold = tree.nodes.filter((nd) => nd.cost.type === 'gold');
  const amounts = [...new Set(gold.map((nd) => nd.cost.amount))].sort((a, b) => a - b);
  const pickNodes = [gold[0]!, gold[1]!, ...amounts.slice(-3).map((a) => gold.find((nd) => nd.cost.amount === a)!)];
  const skillIds = reg.get('skill-tree').nodes.slice(0, 4).map((nd) => nd.id);
  const saves: { skills: Record<string, number>; masteries: Record<string, number> }[] = [
    { skills: {}, masteries: {} },
    { skills: { [skillIds[0]!]: 1 }, masteries: { [pickNodes[0]!.id]: 1 } },
    { skills: { [skillIds[0]!]: 3, [skillIds[1]!]: 2, [skillIds[2]!]: 0 }, masteries: { [pickNodes[1]!.id]: 3, [pickNodes[2]!.id]: 2, 'no-such-node': 4 } },
    { skills: { [skillIds[3]!]: 7 }, masteries: Object.fromEntries(pickNodes.map((nd, i) => [nd.id, i + 1])) },
  ];
  const mult = reg.get('balance').passiveRankCostMult;
  return {
    nodes: pickNodes.map((nd) => pick(nd, ['id', 'cost'])),
    respec: saves.map((s) => ({ ...s, skillFee: skillRespecFee(reg, s as SaveState), passiveFee: passiveRespecFee(reg, s as SaveState) })),
    nodeCost: amounts.flatMap((amount) => [0, 1, 2, 3, 5].map((rank) => ({ amount, rank, cost: passiveNodeCost(amount, rank, mult) }))),
  };
}

describe('unityTownGolden — продюсер эталона (пишет __golden__/unity_town.json)', () => {
  it('генерит эталон цены скупки и бросков и пишет на диск', () => {
    const sell = sellItems().map((item) => ({ item, price: shopSellPrice(reg, item) }));
    expect(sell.length).toBeGreaterThan(50);
    expect(sell.every((c) => Number.isInteger(c.price) && c.price >= 1)).toBe(true);
    expect(sell.some((c) => c.item.kind === 'material' && c.price > 7), 'сырьё — поштучно, а не «7 за стек»').toBe(true);
    // ⭐ R5-23: стартовый комплект — за 1 (R3-04), а поднятый у кузнеца — уже по формуле (R4-34). Без этих вещей в эталоне
    // Unity показывал «+7» за нетронутый комплект, а сервер платил 1, и сверка паритета этого не видела.
    expect(sell.some((c) => c.item.origin === 'start' && !c.item.tierForged && c.price === 1), 'нетронутый стартовый комплект').toBe(true);
    expect(sell.some((c) => c.item.origin === 'start' && c.item.tierForged && c.price > 1), 'комплект, поднятый у кузнеца').toBe(true);
    expect(sell.some((c) => c.item.parts && c.price === salvageWorth(reg, c.item) && c.price > 1), 'скованное — по полу выхода разбора (D4)').toBe(true);
    const drop = dropCases();
    expect(drop.some((c) => c.cell === null) && drop.some((c) => c.cell !== null)).toBe(true);
    // Каждая клетка, которую dropCell разрешает, проходит строгую схему сервера (R2-35).
    for (const c of drop) if (c.cell) expect(parseTownCommand({ cmd: 'moveItem', uid: 'u', ...c.cell }).ok).toBe(true);
    const offhand = offhandCases();
    expect(offhand.some((c) => c.refusal === null && c.item.slot === 'weapon'), 'дуал-вилд есть').toBe(true);
    expect(offhand.some((c) => c.refusal !== null) && offhand.some((c) => c.refusal === null && c.item.slot === 'offhand')).toBe(true);
    // ⭐ U3: кузница — каждый отказ подъёма и перекатки, который бывает у вещей игры, в эталоне есть (иначе порт Unity его не сверит).
    const forge = forgeItems().map(forgeCase);
    const ups = new Set(forge.map((c) => c.upgrade)), rrs = new Set(forge.map((c) => c.reroll));
    for (const r of [null, 'Сперва почини', 'Кузнец не знает такой вещи', 'Скованную вещь поднимает замена детали, а не подъём тира',
      'Ступень этой вещи ничего не меняет', 'Лучше эту вещь уже не сделать', 'Эта форма выше не куётся', UNIQUE_NO_UPGRADE]) expect(ups.has(r), `подъём: ${r}`).toBe(true);
    for (const r of [null, 'Сперва почини', 'Эту вещь перекатывать больше нельзя', 'Уникальные вещи не перекатываются', 'У обычной вещи нечего перекатывать',
      'Кузнецу не хватит свойств на форму этой вещи', 'Форма без цены — кузнец её сейчас не куёт']) expect(rrs.has(r), `перекатка: ${r}`).toBe(true);
    expect(forge.some((c) => c.gold.reroll === null), 'перекатка формы без цены — без числа').toBe(true);
    expect(forge.some((c) => c.upgrade === null && Object.keys(c.cost).length >= 3), 'основа подъёма оружия по деталям + расходник').toBe(true);
    expect(forge.some((c) => Object.keys(c.rerollEssence).length > 0), 'эссенция перекатки').toBe(true);
    // ⭐ U3: пупсик — команда во вторую руку, обычная и каждая причина отказа ядра.
    const equip = equipCases();
    const results = equip.flatMap((e) => e.checks.map((c) => c.result));
    const reasons = new Set(results.filter((r): r is string => typeof r === 'string'));
    expect(results.some((r) => typeof r === 'object' && (r as { slot?: string }).slot === 'offhand'), 'во вторую руку').toBe(true);
    expect(results.some((r) => typeof r === 'object' && !(r as { slot?: string }).slot), 'в родной слот').toBe(true);
    for (const r of ['Этот предмет не для этого слота', 'Занято двумя руками', 'Двуручное оружие во вторую руку не взять',
      'Полуторное оружие одной рукой носят только со щитом', 'Сломано — почини у кузнеца', 'Недостаточно атрибутов', 'Нет места для снятого',
      'Предмет не в инвентаре']) expect(reasons.has(r), `пупсик: ${r}`).toBe(true);
    expect([...reasons].some((r) => r.startsWith('Не хватит атрибутов на «')), 'пупсик: уходящая вещь держала требования').toBe(true);
    const fees = feeCases();
    expect(fees.respec.some((c) => c.skillFee > 0) && fees.respec.some((c) => c.passiveFee > 0)).toBe(true);
    const steps = stepCases();
    expect(new Set(steps.map((c) => c.tier)).size, 'ступени из деталей — вся лестница').toBe(reg.get('item-tiers').length);
    const fillable = fillableCases();
    expect(fillable.some((c) => c.fillable) && fillable.some((c) => !c.fillable)).toBe(true);
    // Приманки (R6-10, выключенное сырьё) ядро обошло: найденный меч с выключенной ключевой деталью не поднимается, лестница их не берёт.
    expect(forge.some((c) => c.item.foundParts && (c.item.foundParts as CraftParts).strike.id === OFF_PART && c.upgrade === 'Эта форма выше не куётся')).toBe(true);
    expect(forge.every((c) => !('iron-3-off' in c.cost))).toBe(true);
    const golden = {
      note: 'Эталон паритета Unity ↔ веб для города (R2-35, R2-36, R11-02, U3). Генерит packages/client/src/modules/town/unityTownGolden.gen.test.ts.',
      // Ровно те разделы /api/config (и поля в них), которые читают порты Unity: цены лавки и кузницы, ворота кузницы, пупсик, сбросы.
      config: {
        rarities: reg.get('rarities').map((r) => pick(r, ['id', 'priceMult', 'minAffixes', 'maxAffixes', 'maxPrefix', 'maxSuffix'])),
        'craft-materials': reg.get('craft-materials').map((m) => pick(m, ['id', 'name', 'family', 'tier', 'enabled', 'sellPrice'])),
        'items.base': reg.get('items.base').map((b) => pick(b, ['id', 'kind', 'enabled', 'slot', 'minTier', 'maxTier', 'baseStats', 'weaponClass', 'hands', 'attackType', 'damageKind'])),
        'item-tiers': reg.get('item-tiers').map((t) => pick(t, ['id', 'name', 'minItemLevel', 'statMult', 'reqMult', 'enabled'])),
        'salvage-rules': reg.get('salvage-rules').map((r) => ({ ...pick(r, ['id', 'enabled', 'kind', 'weaponClass', 'armorClass', 'slot']), yields: (r.yields ?? []).map((y) => pick(y, ['materialId', 'min', 'max'])) })),
        // ⭐ §7 (06.10): основа подъёма оружия — семьи его деталей (`partFamily`: своя у варианта или гнезда анатомии), а у вещи без записанных
        // деталей (стартовый набор) — детали выводом от uid (`deriveParts`: ключевые формы базы по таблице типов и тегам) — поэтому анатомия,
        // типы и теги/семьи деталей целиком.
        'weapon-parts': reg.get('weapon-parts').map((p) => pick(p, ['id', 'enabled', 'slot', 'classes', 'hands', 'stepMin', 'stepMax', 'rarity', 'geom', 'family', 'tags'])),
        'weapon-anatomy': reg.get('weapon-anatomy'),
        'weapon-types': reg.get('weapon-types'),
        affixes: reg.get('affixes').map((a) => pick(a, ['id', 'enabled', 'kind', 'group', 'onMagic', 'onRare', 'appliesTo', 'exclude', 'stat', 'tiers', 'mods', 'proc'])),
        'mastery-tree': { nodes: fees.nodes },
        balance: (() => {
          const b = reg.get('balance');
          return {
            // ⭐ §7 (06.10): подъём и починка — по СТУПЕНИ, а не по редкости: лестницы `salvage.rarityTier` / `forgePrices.ladderByRarity` больше
            // нет. Цена подъёма — верх вилки разбора вещи как находки целевой ступени (рецепт `salvage.recipeByTier`, единицы деталей
            // `craft.salvage.units`, правила `salvage-rules` с вилками) × `forgePrices.upgradeMaterials.baseShare` + расходник I; починка —
            // `forgePrices.repairMaterials`. Порт Unity (`DmTown.UpgradeCost`) переводится на эти ключи (или берёт цену из кадра сервера).
            forgePrices: b.forgePrices, loot: { baseRoll: b.loot.baseRoll }, salvage: b.salvage,
            craft: {
              tierFromParts: b.craft.tierFromParts, formMult: b.craft.formMult, rarityWeight: b.craft.rarityWeight, salvage: b.craft.salvage,
              // D4: скупка скованного — по полу выхода переплавки (`meltReturn`: доля `melt.share` заплаченного, без записи — единицы гнёзд).
              cost: { essence: b.craft.cost.essence, units: b.craft.cost.units }, foundEvenness: b.craft.foundEvenness, melt: b.craft.melt,
            },
            inventory: b.inventory, skillRespecCostPerPoint: b.skillRespecCostPerPoint, passiveRespecCostPct: b.passiveRespecCostPct,
            passiveRankCostMult: b.passiveRankCostMult,
          };
        })(),
      },
      sell,
      drop,
      offhand,
      forge,
      steps,
      fillable,
      equip,
      fees: { respec: fees.respec, nodeCost: fees.nodeCost },
    };
    const dir = join(HERE, '__golden__');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'unity_town.json'), JSON.stringify(golden));
  });
});

/**
 * ПРОДЮСЕР эталона КАРТОЧКИ РАЗБОРА для Unity-клиента (предложение «Разбор, сырьё и чары» §15.2): четыре строки — сырьё, эссенция, каталог,
 * эскиз — и заголовок, вилка выхода, отказ с причиной (`salvagePreview`, salvagePreview.ts), у кузнеца и в поле. Unity показывает её на
 * верстаке и в меню разбора; веб — источник правила.
 *
 * Вещи — какими они бывают в игре: найденные по каждой включённой базе оружия (дроп, сундук, босс; редкость по кругу; детали записаны
 * при рождении, как у дропа сессии) и их копии — купленные, награды, без происхождения (сейв старше поля), с непонятным происхождением,
 * поднятые кузнецом (с `bornTier` и до него), сломанные, без записанных деталей (сейв старше §26); найденный мифик и купленный мифик;
 * оружие выключенной базы (путь по правилу); стартовый набор (только каталог); скованные трёх семейств (переплавка); броня, щит,
 * украшение; сырьё. Журналы — нет кадра, пустой, «всё из вещи», без детали, без базы, всё, на шаг до эскиза; Unity строит их сама по
 * `parts`, `type`, `tierIndex` вещи и `fullJournal` эталона.
 *
 * Эталон: `__golden__/unity_salvage.json` → Unity `Assets/DM/UI/Tests/unity_salvage_golden.json` (`tools/unity-check/golden_sync.py`),
 * проверка — `SalvagePreviewCheck`. Перезапись: `npx vitest run packages/shared/src/economy/unitySalvageGolden.gen.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ConfigRegistry } from '../config/registry.js';
import {
  baseTierRange, craftTiers, craftWeapon, emptyJournal, fullJournal, keyVariantsByBase, partsOf, shapeFoundWeapon, tierIndexOfItem,
  typeOfItem, variantsFor, type CraftJournal,
} from '../formulas/craft.js';
import { CRAFT_SLOT_LIST, keySlotOf } from '../formulas/craftType.js';
import { generateItem } from '../formulas/itemgen.js';
import { createRng } from '../formulas/rng.js';
import { newCharacterSave } from './newCharacter.js';
import { materialItem } from './materials.js';
import { itemOriginNote, salvagePreview } from './salvagePreview.js';
import { upgradedItem } from './townActions.js';
import type { CraftParts, Item } from '../types/items.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();

/** Поля объекта по списку (нет поля — нет и ключа). */
function pick(o: object, keys: readonly string[]): Record<string, unknown> {
  const src = o as Record<string, unknown>;
  return Object.fromEntries(keys.filter((k) => src[k] !== undefined).map((k) => [k, src[k]]));
}

/** Найденная вещь базы `baseId` на уровне `lvl` редкости `rarity` — как её катает дроп сессии (детали записаны при рождении). */
function found(baseId: string, lvl: number, rarity: Item['rarity'], origin: NonNullable<Item['origin']>, seed: number): Item {
  const bal = reg.get('balance');
  return shapeFoundWeapon(reg, generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'), {
    dropBias: 1, itemLevel: lvl, tierLevel: lvl, baseId, tiers: reg.get('item-tiers'), rarities: reg.get('rarities'),
    forceRarity: rarity, maxReqTotal: bal.maxTotalRequirement, baseRoll: bal.loot.baseRoll, origin,
  }, createRng(seed)));
}

/** Скованное оружие семейства `cls`×`hands` целиком из материала ступени `step` — или `undefined`, если не собрать. */
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

/** Найденный МИФИК (последняя ступень) с пола. */
function mythicDrop(): Item {
  const last = craftTiers(reg).length - 1;
  const base = reg.get('items.base').find((b) => b.kind === 'weapon' && b.enabled !== false && baseTierRange(reg, b).hi === last)!;
  for (let s = 1; s < 400; s++) {
    const it = found(base.id, 99, 'normal', 'drop', s);
    if (tierIndexOfItem(reg, it) === last && partsOf(reg, it)) return it;
  }
  throw new Error('мифик не выкатился');
}

function items(): Item[] {
  const out: Item[] = [];
  const tiers = [...reg.get('item-tiers')].sort((a, b) => a.minItemLevel - b.minItemLevel);
  const rarities = ['normal', 'magic', 'rare', 'unique'] as const;
  const origins = ['drop', 'chest', 'boss'] as const;
  let seed = 701;
  const weapons = reg.get('items.base').filter((b) => b.kind === 'weapon' && b.enabled !== false);
  for (const [n, base] of weapons.entries()) {
    const lo = Math.max(0, tiers.findIndex((t) => t.id === base.minTier));
    const hiAt = tiers.findIndex((t) => t.id === base.maxTier);
    const hi = hiAt < 0 ? tiers.length - 1 : hiAt;
    const lvl = tiers[[lo, Math.round((lo + hi) / 2), hi][n % 3]!]!.minItemLevel + 1;
    out.push(found(base.id, lvl, rarities[seed % rarities.length]!, origins[n % 3]!, seed++));
  }
  const first = [...out];
  for (const [i, it] of first.entries()) {
    if (it.rarity === 'unique') continue;
    if (i % 3 === 0) out.push({ ...it, origin: 'shop' });
    if (i % 5 === 1) out.push({ ...it, origin: 'quest' });
    if (i % 5 === 3 || i % 7 === 0) { const none: Item = { ...it }; delete none.origin; out.push(none); }
    if (i % 9 === 3) out.push({ ...it, origin: 'mystery' as Item['origin'] });   // поле из будущего — «вещь не найдена»
    if (i % 7 === 4) out.push({ ...it, tierForged: true });
    if (i % 6 === 5) out.push({ ...it, broken: true });
    if (i % 8 === 6 && it.foundParts) { const old: Item = { ...it }; delete old.foundParts; out.push(old); }   // детали — выводом от uid
  }
  const m = mythicDrop();
  out.push(m, { ...m, origin: 'shop' }, { ...m, tierForged: true });
  // Поднятые кузнецом по-настоящему (`upgradedItem` пишет `bornTier`): разбор — по исходной ступени.
  for (const it of first.slice(0, 6)) {
    if (it.rarity === 'unique') continue;
    const up = upgradedItem(reg, it);
    if (up) out.push(up);
  }
  // Выключенная база (гладиус): деталей кузнеца у неё нет — разбор по редкости.
  const off = reg.get('items.base').find((b) => b.kind === 'weapon' && b.enabled === false);
  if (off) out.push(found(off.id, 5, 'magic', 'drop', seed++), found(off.id, 5, 'normal', 'shop', seed++));
  // Стартовый набор — разбор запрещён.
  const kit = newCharacterSave(reg, 'warrior', 'golden', 'golden');
  for (const it of [...Object.values(kit.equipment), ...kit.inventory]) if (it) out.push(it);
  for (const [cls, hands, step] of [['sword', 1, 1], ['axe', 2, 3], ['staff', 2, 5]] as const) {
    const w = forgedWeapon(cls, hands, step);
    if (w) out.push(w);
  }
  for (const kind of ['armor', 'shield', 'jewelry'] as const) {
    const gear = reg.get('items.base').filter((b) => b.kind === kind && b.enabled !== false);
    for (const [i, b] of gear.slice(0, 3).entries()) {
      out.push(found(b.id, [5, 35, 80][i]!, (['normal', 'magic', 'rare'] as const)[i]!, 'drop', seed++));
      out.push(found(b.id, 50, 'rare', 'shop', seed++));
    }
  }
  out.push(materialItem(reg.get('craft-materials')[0]!, 7, 'mat'));
  return out.map((it, i) => ({ ...it, uid: `sv-${i}` }));
}

/** Журналы (как `journalsFor` unityPanelsGolden): по деталям, типу и ступени вещи и полному журналу. */
function journalsFor(item: Item): { name: string; j: CraftJournal | null }[] {
  const out: { name: string; j: CraftJournal | null }[] = [{ name: 'null', j: null }, { name: 'empty', j: emptyJournal() }];
  const parts = partsOf(reg, item);
  if (!parts || item.kind !== 'weapon') return out;
  const typeId = typeOfItem(reg, item)?.typeId;
  const types = typeId ? [typeId] : [];
  const variants = CRAFT_SLOT_LIST.map((s) => parts[s].id);
  const known: CraftJournal = { ...emptyJournal(), bases: [item.baseId], variants, tierHi: tierIndexOfItem(reg, item), typesSeen: types };
  const all: CraftJournal = { ...fullJournal(reg), typesSeen: types };
  const k = reg.get('balance').craft.journal;
  const base = reg.get('items.base').find((b) => b.id === item.baseId);
  const sk = base?.kind === 'weapon' ? { [base.weaponClass]: k.sketchAfter - 1 } : {};
  out.push(
    { name: 'known', j: known },
    { name: 'no-variant', j: { ...known, variants: variants.slice(1) } },
    { name: 'no-base', j: { ...known, bases: [] } },
    { name: 'all', j: all },
    { name: 'all-gate', j: { ...all, mythic: 0 } },
    { name: 'sketch', j: { ...known, classSalvages: sk } },
    { name: 'sketch-all', j: { ...all, classSalvages: sk } },
  );
  return out;
}

/** Имя ступени по id — резолвер строки происхождения (`itemOriginNote`), как его ставит клиент из `item-tiers`. */
const tierName = (id: string): string | undefined => reg.get('item-tiers').find((t) => t.id === id)?.name;

describe('unitySalvageGolden — продюсер эталона карточки разбора (пишет __golden__/unity_salvage.json)', () => {
  it('генерит эталон и пишет на диск', () => {
    const cases = items().map((item) => {
      const type = typeOfItem(reg, item);
      return {
        item,
        parts: partsOf(reg, item), type: type ? { id: type.typeId ?? null, name: type.name } : null, tierIndex: tierIndexOfItem(reg, item),
        // ⭐ §15.3: строка происхождения подсказки вещи (`itemOriginNote`) — Unity `DmItem` показывает ту же.
        origin: itemOriginNote(item, tierName),
        journals: journalsFor(item).map(({ name, j }) => ({ name, smith: salvagePreview(reg, item, j, false), field: salvagePreview(reg, item, j, true) })),
      };
    });
    const smith = cases.flatMap((c) => c.journals.map((j) => j.smith));
    const field = cases.flatMap((c) => c.journals.map((j) => j.field));
    const all = [...smith, ...field];
    // Каждый исход карточки — хотя бы раз: разбор и переплавка, отказ, эссенция и её отсутствие по каждой причине, каталог «новое/всё есть».
    expect(new Set(all.map((p) => p.verb))).toEqual(new Set(['salvage', 'melt']));
    expect(all.some((p) => !p.ok) && all.some((p) => p.ok)).toBe(true);
    for (const t of ['+ ', '≈ ', 'нет — вещь куплена', 'нет — вещь из прежней версии', 'нет — стартовый набор', 'нет — переплавка эссенцию не возвращает', 'нет — у обычной вещи чар нет']) {
      expect(all.some((p) => p.essence.text.startsWith(t)), `эссенция: ${t}`).toBe(true);
    }
    expect(smith.some((p) => p.catalog?.tone === 'gain') && smith.some((p) => p.catalog?.tone === 'dim'), 'каталог: новое и «уже в каталоге»').toBe(true);
    expect(smith.some((p) => /уже в каталоге/.test(p.catalog?.text ?? ''))).toBe(true);
    expect(field.every((p) => p.catalog === null), 'в поле каталог не пишется — и строки нет (D2)').toBe(true);
    expect(smith.every((p) => p.catalog !== null), 'у кузнеца строка каталога есть всегда').toBe(true);
    expect(field.some((p) => p.hint?.includes('втрое больше')), 'подсказка поля').toBe(true);
    expect(new Set(cases.map((c) => c.origin)), 'строка происхождения: все варианты').toEqual(new Set([
      null, 'Куплено в лавке', 'Награда за задание', 'Стартовый набор', 'Скована кузнецом', 'Вещь из прежней версии',
      ...cases.map((c) => c.origin).filter((o): o is string => !!o && /поднята кузнецом/.test(o)),
    ]));
    expect(cases.some((c) => /^Ступень поднята кузнецом \(была «/.test(c.origin ?? '')), 'поднятая — с исходной ступенью').toBe(true);
    expect(smith.some((p) => p.sketch?.text === 'копят только находки') && smith.some((p) => p.sketch?.tone === 'gain'), 'эскиз: только находки и сам эскиз').toBe(true);
    expect(smith.some((p) => p.materials.text.includes('не выше III сорта')), 'потолок сорта не-находки').toBe(true);
    expect(smith.some((p) => p.materials.text.includes('ступень поднята кузнецом')), 'поднятая — по исходной ступени').toBe(true);
    expect(smith.some((p) => p.materials.text === 'сырья нет — стартовый набор бесплатный')).toBe(true);
    expect(new Set(all.filter((p) => !p.ok).map((p) => p.reason)).size, 'причины отказа разные').toBeGreaterThan(2);
    const golden = {
      note: 'Эталон паритета Unity ↔ веб карточки разбора (сырьё, эссенция, каталог, эскиз; у кузнеца и в поле). Генерит packages/shared/src/economy/unitySalvageGolden.gen.test.ts.',
      config: {
        rarities: reg.get('rarities').map((r) => pick(r, ['id', 'priceMult', 'minAffixes', 'maxAffixes', 'maxPrefix', 'maxSuffix'])),
        'craft-materials': reg.get('craft-materials').map((m) => pick(m, ['id', 'name', 'family', 'tier', 'enabled', 'sellPrice'])),
        'items.base': reg.get('items.base').map((b) => pick(b, ['id', 'name', 'kind', 'enabled', 'slot', 'minTier', 'maxTier', 'baseStats', 'weaponClass', 'hands', 'attackType', 'damageKind', 'gender'])),
        'item-tiers': reg.get('item-tiers').map((t) => pick(t, ['id', 'name', 'minItemLevel', 'statMult', 'reqMult', 'enabled'])),
        'salvage-rules': reg.get('salvage-rules'),
        'weapon-parts': reg.get('weapon-parts').map((p) => pick(p, ['id', 'name', 'enabled', 'slot', 'classes', 'hands', 'stepMin', 'stepMax', 'rarity', 'geom', 'family', 'tags'])),
        'weapon-anatomy': reg.get('weapon-anatomy'),
        'weapon-types': reg.get('weapon-types'),
        balance: (() => {
          const b = reg.get('balance');
          return {
            loot: { baseRoll: b.loot.baseRoll }, salvage: b.salvage, inventory: b.inventory,
            craft: {
              live: b.craft.live, tierFromParts: b.craft.tierFromParts, formMult: b.craft.formMult, rarityWeight: b.craft.rarityWeight,
              cost: b.craft.cost, melt: b.craft.melt, salvage: b.craft.salvage, journal: b.craft.journal, foundEvenness: b.craft.foundEvenness,
            },
            forgePrices: { upgradeReqDiscount: b.forgePrices.upgradeReqDiscount },
          };
        })(),
      },
      fullJournal: fullJournal(reg),
      cases,
    };
    const dir = join(HERE, '__golden__');
    mkdirSync(dir, { recursive: true });
    // uid вещей, рождённых часами (стартовый набор, скованные), — постоянными по порядку появления: эталон не меняется от прогона к прогону.
    const uids = new Map<string, string>();
    const stable = (k: string, v: unknown): unknown => {
      if (k !== 'uid' || typeof v !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(v)) return v;
      if (!uids.has(v)) uids.set(v, `u-${uids.size}`);
      return uids.get(v);
    };
    writeFileSync(join(dir, 'unity_salvage.json'), JSON.stringify(golden, stable));
  });
});

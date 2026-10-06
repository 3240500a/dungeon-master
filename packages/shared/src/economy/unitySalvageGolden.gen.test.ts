/**
 * ПРОДЮСЕР эталона «РАЗБЕРЁШЬ — ЧТО ОТКРОЕТСЯ» для Unity-клиента: строка карточки «♻ Разобрать» у кузнеца ДО разбора
 * (`salvageJournalPreview`, `salvageJournalGains` — salvagePreview.ts). Unity показывает её на верстаке; веб — источник правила.
 *
 * Вещи — какими они бывают в игре: найденные по каждой включённой базе оружия (дроп, сундук, босс; редкость по кругу; детали записаны
 * при рождении, как у дропа сессии) и их копии — купленные, награды, без происхождения (сейв старше поля), с непонятным происхождением,
 * поднятые кузнецом, сломанные, без записанных деталей (сейв старше §26); найденный мифик и купленный мифик; оружие выключенной базы
 * (путь «по редкости»); стартовый набор (разбор запрещён); скованные трёх семейств (переплавка); броня, сырьё. Журналы — те же, что у
 * вопросов панели (`journalsFor` unityPanelsGolden): нет кадра, пустой, «всё из вещи», без детали, без базы, всё, всё без ворот, на шаг
 * до эскиза; Unity строит их сама по `parts`, `type`, `tierIndex` вещи и `fullJournal` эталона.
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
import { salvageJournalPreview } from './salvagePreview.js';
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
  const armor = reg.get('items.base').find((b) => b.kind === 'armor' && b.enabled !== false)!;
  out.push(found(armor.id, 5, 'magic', 'drop', seed++));
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

describe('unitySalvageGolden — продюсер эталона строки разбора у кузнеца (пишет __golden__/unity_salvage.json)', () => {
  it('генерит эталон и пишет на диск', () => {
    const cases = items().map((item) => {
      const type = typeOfItem(reg, item);
      return {
        item,
        parts: partsOf(reg, item), type: type ? { id: type.typeId ?? null, name: type.name } : null, tierIndex: tierIndexOfItem(reg, item),
        journals: journalsFor(item).map(({ name, j }) => ({ name, preview: salvageJournalPreview(reg, item, j) })),
      };
    });
    const all = cases.flatMap((c) => c.journals.map((j) => j.preview));
    // Каждый исход строки — хотя бы раз, и каждое «почему».
    expect(new Set(all.map((p) => p.kind))).toEqual(new Set(['found', 'known', 'typeOnly', 'melt', 'rules', 'none']));
    expect(new Set(all.filter((p) => p.why).map((p) => p.why))).toEqual(new Set([
      'вещь куплена', 'вещь — награда за задание', 'вещь без происхождения (из старого сейва)', 'вещь не найдена',
    ]));
    expect(all.some((p) => p.kind === 'typeOnly' && p.gains.length > 0), 'купленная открывает тип').toBe(true);
    expect(all.some((p) => p.kind === 'typeOnly' && p.gains.length === 0), 'купленная — тип уже открыт').toBe(true);
    for (const w of ['тип', 'деталь', 'кодекс', 'ступень', 'мифик', 'эскиз']) {
      expect(all.some((p) => p.kind === 'found' && p.gains.some((g) => g.startsWith(w))), `находка: ${w}`).toBe(true);
    }
    const golden = {
      note: 'Эталон паритета Unity ↔ веб строки разбора у кузнеца («Откроет: …» / «Детали не откроются: …»). Генерит packages/shared/src/economy/unitySalvageGolden.gen.test.ts.',
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

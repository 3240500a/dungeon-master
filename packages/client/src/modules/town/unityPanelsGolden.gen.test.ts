/**
 * ПРОДЮСЕР И СТОРОЖ эталона НЕДОСТАЮЩИХ ПАНЕЛЕЙ для Unity-клиента (U6a): верстак кузнеца целиком (починка, улучшение, перекатка,
 * зачарование, разбор — карточки с причинами, `benchActions`), выход разбора (`salvageYield` / `salvageRange` / `salvageMean`,
 * `canSalvageItem`, `fieldSalvageFits`), вопросы перед тем, как вещь исчезнет (`journalGainsOf`, `disposePrompts`), вкладка «Ресурсы»
 * сундука (`materialsModel`: сорта I–V, эссенция плашкой, подсказки; и подсказка стопки сырья `materialNote`), карточка разбора в поле
 * у пункта меню (`fieldSalvageLines`), гнёзда и вставки скилов (`socketsView`: `socketsOpen`, `insertRank`, `insertFits`, `resolveActive`), меню
 * предмета инвентаря, атрибуты пачкой (`attrAllocCommands`) и сброс (`attrRespecRefund`, `respecRefusal`), задания с заменой
 * (`questRival`) и их строки, пояс по размеру, таблички и полоса статусов (`debuffIcon`, `debuffLabel`, `activeToggleInfos`), гейт оружия
 * панели биндов (`skillWeaponAllowed`).
 *
 * Unity — основной клиент, веб — источник истины по правилам. Настоящими функциями веба считаются все, что экспортированы (`@dm/shared`,
 * `forgeActions.ts`, `disposeConfirm.ts`, `materialsModel.ts`, `allocAttrs.ts`, подпись клетки сетки `glyphOf` из `heldItem.ts`). Разметка окон живёт в замыканиях и DOM (`socketsView.ts`, `materialsView.ts`,
 * `inventoryPanel.ts`, `questLogPanel.ts`, `stashPanel.ts`, `bindBar.ts`, `beltBar.ts`, `hud3d.ts`, `online3d.ts`) — здесь она повторена
 * копией, и каждая копия СТОРОЖИТСЯ строкой исходника (`SRC`): правило поменяли — тест падает, пока копию, эталон и порт Unity не обновят.
 *
 * Эталон: `__golden__/unity_panels.json` → Unity `Assets/DM/UI/Tests/unity_panels_golden.json` (`tools/unity-check/golden_sync.py`),
 * проверка — `PanelsCheck`. Перезапись: `npx vitest run packages/client/src/modules/town/unityPanelsGolden.gen.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  ATTRIBUTES, ALLOC_ATTR_MAX, CRAFT_SLOT_LIST, ESSENCE_ID, ConfigRegistry, activeToggleInfos, attrRespecRefund, baseTierRange, canEnchantItem,
  FIELD_SALVAGE_FULL, STARTER_FIELD, UNIQUE_NO_SALVAGE, canRepairItem, canSalvageItem, carriedMaterials, equipRefusal, craftTiers, craftWeapon, createRng, debuffIcon, debuffLabel, enchantCost, enchantItem,
  enchantMaterials, rerollMaterials,
  fieldSalvageFits, fullJournal, emptyJournal, generateBoard, generateItem, insertById, insertFits, insertRank, insertUnlocked,
  itemFromBaseId, keySlotOf, keyVariantsByBase, materialItem, newCharacterSave, partsOf, questRival, repairCost, resolveActive,
  respecRefusal, salvageMean, salvageRange, salvageYield, shapeFoundWeapon, skillWeaponAllowed, socketsOpen, tierIndexOfItem,
  typeOfItem, variantsFor,
  type Attribute, type CraftJournal, type CraftParts, type DebuffKind, type Item, type QuestDef, type SalvageRng, type SaveState,
} from '@dm/shared';
import { benchActions, benchTarget, benchTargetLabel } from './forgeActions.js';
import { disposePrompts, fieldSalvageEntry, fieldSalvageLines, journalGainsOf } from '../inventory/disposeConfirm.js';
import { materialNote, materialsModel } from '../inventory/materialsModel.js';
import { attrAllocCommands } from '../progression/allocAttrs.js';
import { elementOf } from '../skills/skillIcon.js';
import { glyphOf } from '../inventory/heldItem.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(join(HERE, rel), 'utf8');
const SOCKETS = read('../skills/socketsView.ts');
const MATS = read('../inventory/materialsView.ts');
const STASH = read('./stashPanel.ts');
const INV = read('../inventory/inventoryPanel.ts');
const QUESTS = read('../quests/questLogPanel.ts');
const BIND = read('../../ui/bindBar.ts');
const BELT = read('../consumables/index.ts');
const HUD = read('../../render3d/hud3d.ts');
const ONLINE3D = read('../../render3d/online3d.ts');
const SKILLTREE = read('../skills/skillTreeView.ts');
const PASSIVE = read('../skills-passive/treeView.ts');
const RESPEC = read('../progression/respecAttrs.ts');
const ICON = read('../skills/skillIcon.ts');

/** Строки исходников, повторённые ниже копией. Нет строки — правило веба поменялось: обновить копию, эталон и порт Unity. */
const SRC: [string, string][] = [
  // гнёзда скилов (socketsView.ts)
  [SOCKETS, "const POOL_SHORT: Record<'mana' | 'stamina', string> = { mana: 'маны', stamina: 'выносл.' };"],
  [SOCKETS, "if (!ins.cost) return 'бесплатно';"],
  [SOCKETS, "const pool = ins.costPool === 'carrier' ? carrier : ins.costPool;"],
  [SOCKETS, "return `${ins.cost > 0 ? '+' : ''}${ins.cost} ${pool ? POOL_SHORT[pool] : 'ресурса скила'}`;"],
  [SOCKETS, '.filter((n) => n.effect.active && socketsOpen(cfg, save.skills[n.id] ?? 0) > 0);'],
  [SOCKETS, '`Гнёзда открываются рангом скила: ${ranks.join(\' / \')}. Вложите очко в активный скил.`));'],
  [SOCKETS, 'const filled = (save.sockets?.[n.id] ?? []).filter(Boolean).length;'],
  [SOCKETS, 'b.textContent = `${n.name} ${filled}/${open}`;'],
  [SOCKETS, "cell.append(mk('div', `font-size:10px;color:${COLORS.dim}`, ins ? typeName(ins.type) : `Гнездо ${i + 1}`));"],
  [SOCKETS, "ins ? `${ins.name} · ${rk}` : '— пусто —'));"],
  [SOCKETS, "line.innerHTML = `Стоимость: ${d(b.manaCost, a.manaCost)} ${POOL_SHORT[a.resource]}`"],
  [SOCKETS, "+ (r.extraCost ? ` <span style=\"color:${COLORS.bad}\">+ ${r.extraCost.amount} ${POOL_SHORT[r.extraCost.pool]}</span>` : '')"],
  [SOCKETS, '+ ` · откат: ${d(b.cooldown, a.cooldown)} с`'],
  [SOCKETS, "+ (r.procs.length ? ` · доп. эффектов: ${r.procs.length}` : '');"],
  [SOCKETS, 'const weaponClass = save.equipment.weapon?.weaponClass;'],
  [SOCKETS, 'const others = (save.sockets?.[node.id] ?? []).slice(0, open).filter((_, i) => i !== slot);'],
  [SOCKETS, "if (cur) item('✕ Вынуть', COLORS.bad, () => app.sendCmd({ cmd: 'socketClear', nodeId: node.id, slot }));"],
  [SOCKETS, 'if (ins.enabled === false || ins.id === cur) continue;'],
  [SOCKETS, 'if (!insertUnlocked(cfg, save, ins.id)) continue;'],
  [SOCKETS, 'if (!insertFits(ins, base, weaponClass)) continue;'],
  [SOCKETS, 'if (usedTypes.has(ins.type)) continue;'],
  [SOCKETS, 'item(`${typeName(ins.type)} · ${ins.name}`, COLORS.text,'],
  // «Ресурсы» сундука: модель — настоящая функция (`materialsModel`, materialsModel.ts), здесь сторожатся только вид и вкладка
  // (materialsView.ts, stashPanel.ts): клетка — сундук и «+N» в сумке, эссенция — плашкой «✦ имя: N».
  [MATS, 'const m = materialsModel(app.config, stashWallet, app.state!.save.inventory);'],
  [MATS, "plate.append(mk('span', '', `✦ ${e.name}:`), mk('b', '', String(e.stash)));"],
  [MATS, "if (e.hand > 0) plate.append(mk('span', 'font-size:10px;color:#7fd07f', `+${e.hand}`));"],
  [MATS, "el.append(mk('b', '', String(c.stash)));"],
  [MATS, "if (c.hand > 0) el.append(mk('span', 'font-size:10px;color:#7fd07f', `+${c.hand}`));"],
  [STASH, "['mats', carried > 0 ? `Ресурсы (+${carried})` : 'Ресурсы'] as const,"],
  [STASH, '...Array.from({ length: tabCount }, (_, i) => [String(i), `Вкладка ${i + 1}`] as const),'],
  [STASH, "row.append(button(carried > 0 ? `Сдать всё сырьё (${carried})` : 'В сумке сырья нет',"],
  // меню предмета (inventoryPanel.ts)
  [INV, "{ label: 'Выпить', run: () => app.sendCmd({ cmd: 'useConsumable', uid: item.uid }) },"],
  [INV, "{ label: 'В пояс', run: () => app.sendCmd({ cmd: 'moveBelt', uid: item.uid }) },"],
  [INV, "? [{ label: 'Сломано — к кузнецу', run: () => {}, disabled: true }]"],
  [INV, '? [{ label: `Надеть нельзя: ${wear}`, run: () => {}, disabled: true }]'],
  [INV, ": [{ label: 'Надеть', run: () => { app.sendCmd({ cmd: 'equip', uid: item.uid }); } }];"],
  [INV, "actions.push({ label: 'Выбросить', run: () => app.sendCmd({ cmd: 'drop', uid: item.uid }) });"],
  [INV, "if (app.state!.area !== 'town') {"],
  // пункт разбора в поле — настоящая функция (`fieldSalvageEntry`, disposeConfirm.ts): «Разобрать здесь» или погашенный «Разобрать нельзя: …»
  [INV, 'const entry = fieldSalvageEntry(app.config, app.state!.save.inventory, item);'],
  [INV, 'if (entry?.ok) actions.push({ label: entry.label, run: () => { void salvageInField(app, item); }, tip: () => fieldSalvageTip(app, item) });'],
  [INV, 'else if (entry) actions.push({ label: entry.label, run: () => {}, disabled: true, tip: () => fieldSalvageTip(app, item, entry.reason) });'],
  [INV, 'return fieldSalvageLines(app.config, item, app.stash?.forgeJournal, refusal).map((l, i) =>'],
  // задания (questLogPanel.ts)
  [QUESTS, "? '<span style=\"color:#8aa84a\">выполнено</span>'"],
  [QUESTS, "? '<span style=\"color:#8f897c\">сдано</span>'"],
  [QUESTS, 'line.textContent = `• ${obj.type}${obj.target ? ` ${obj.target}` : \'\'}: ${cur}/${obj.amount}`;'],
  [QUESTS, "const reward = [r.gold && `${r.gold} зол.`, r.xp && `~${Math.round(r.xp / 10)}% ур. опыта`, r.skillPoints && `${r.skillPoints} очк.`, r.itemBaseId && 'предмет']"],
  [QUESTS, "const active = state.save.quests.filter((q) => q.status !== 'turned-in');"],
  [QUESTS, "if (prog.status === 'completed') {"],
  [QUESTS, "if (!(await askHere(state.area === 'town', `У тебя уже есть «${rival.name}» (${rival.progress}).\\nВзять новое — прежнее пропадёт вместе с прогрессом и наградой?`, ask))) return false;"],
  [QUESTS, "app.sendCmd({ cmd: 'acceptQuest', questId: def.id, ...(rival ? { replace: true as const } : {}) });"],
  // бинды (bindBar.ts, skillIcon.ts)
  [BIND, "if (!b || b === 'attack') return true;"],
  [BIND, "if (!active || (active.category !== 'attack' && active.category !== 'cast' && active.category !== 'curse')) return true;"],
  [BIND, 'return skillWeaponAllowed(active, eq.weapon, eq.offhand);'],
  [BIND, "if (b === 'attack') return true;"],
  [BIND, "return nodeById(app, b)?.effect.active?.category === 'attack';"],
  [BIND, 'const grey = unfit || (locked && frac === 0 && isAttackLike(app, b));'],
  [BIND, 'menu.append(opt(`${abbrev(n.name)} · ${n.name} (ур.${rank})`, elementColor(elementOf(n)), n.id));'],
  [BIND, 'o.textContent = `${abbrev(n.name)} · ${n.name} — не то оружие`;'],
  [BIND, 'return (tree?.nodes ?? []).filter((n) => (save.skills[n.id] ?? 0) > 0 && n.effect.active);'],
  [ICON, "return name.replace(/^Мастерство:\\s*/, '').slice(0, 2);"],
  // пояс (consumables/index.ts)
  [BELT, 'return app.state?.save.equipment.belt?.beltSlots ?? 0;'],
  // табличка монстра и полоса статусов (online3d.ts, hud3d.ts)
  [ONLINE3D, "a.hp.setDebuffs(hasDeb ? (Object.keys(mv.debuffs) as DebuffKind[]).filter((k) => mv.debuffs[k]).map((k) => `${debuffIcon(dcfg, k)}${mv.debuffs[k]!.stacks > 1 ? mv.debuffs[k]!.stacks : ''}`).join(' ') : '');"],
  [ONLINE3D, "if (curStun) { g.fillStyle = '#ffe27a'; g.fillText('✷', W / 2 + g.measureText(name).width / 2 + 10, 10); }"],
  [HUD, "wound: '#c86a5a', bleed: '#d8583e', sunder: '#c0956a', daze: '#c9b46a',"],
  [HUD, "burn: '#ff7a2a', poison: '#6ecb3f', shock: '#ffe24a', freeze: '#59a8ff',"],
  [HUD, 'const active = (Object.keys(st.debuffs) as DebuffKind[]).filter((k) => st.debuffs[k]);'],
  [HUD, 'b.title = `${debuffLabel(debuffsCfg, k)}${d.stacks > 1 ? ` ×${d.stacks}` : \'\'}`;'],
  [HUD, "auraLine.textContent = auras.length ? '◈ ' + auras.map((a) => a.name).join('   ◈ ') : '';"],
  // вопросы сбросов (skillTreeView.ts, treeView.ts, respecAttrs.ts)
  [SKILLTREE, 'if (!(await askHere(state.area === \'town\', `Сбросить ВСЕ скиллы?\\nВернётся ${ranks} очков скиллов, комиссия ${fee} зол.\\nБинды скиллов будут очищены.`))) return false;'],
  [PASSIVE, 'if (!window.confirm(`Сбросить ВСЕ мастерства?\\nВернётся ${ranks} очков мастерства.\\nЗолото за узлы НЕ возвращается, комиссия: ${fee} зол.`)) return;'],
  [RESPEC, 'if (!window.confirm(`Сбросить атрибуты?\\nВернётся ${refund} очк. атрибутов, цена ${cost} зол.`)) return;'],
];

/** Выключенная копия ключевой детали меча — её записывает на найденный меч (R6-10). */
const OFF_PART = 'sw-s-xxii-off';
/** Вещи рождаются боевым конфигом (ковка на ступени 5 — из того сырья, что было в игре), а правила считаются конфигом эталона. */
const reg0 = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
/**
 * Конфиг эталона = боевой + три приманки, мимо которых порт обязан пройти так же, как ядро: выключенная копия `iron-3` ПЕРЕД ним (лестница
 * сырья берёт первое ВКЛЮЧЁННОЕ), выключенное `iron-5` (R2-28: разбор и переплавка выключенного не выдают — ступень спускается до ближайшей
 * включённой той же семьи) и выключенная копия ключевой детали меча (записанная на найденный меч деталь, выключенная после находки).
 */
const reg = (() => {
  const r = new ConfigRegistry();
  r.loadAll();
  const mats = r.get('craft-materials');
  const parts = r.get('weapon-parts');
  const blade = parts.find((p) => p.id === 'sw-s-xxii')!;
  r.reload({
    'craft-materials': mats.flatMap((m) => (m.id === 'iron-3' ? [{ ...m, id: 'iron-3-off', enabled: false }, m]
      : m.id === 'iron-5' ? [{ ...m, enabled: false }] : [m])),
    'weapon-parts': [...parts, { ...blade, id: OFF_PART, enabled: false }],
  });
  return r;
})();

/** Поля объекта по списку (нет поля — нет и ключа). */
function pick(o: object, keys: readonly string[]): Record<string, unknown> {
  const src = o as Record<string, unknown>;
  return Object.fromEntries(keys.filter((k) => src[k] !== undefined).map((k) => [k, src[k]]));
}
/** NaN и бесконечность — `null` (JSON их не держит): у формы без цены цены нет. */
const num = (v: number): number | null => (Number.isFinite(v) ? v : null);

/** Скованное оружие семейства `cls`×`hands` целиком из материала ступени `step` — или `undefined`, если не собрать. */
function forgedWeapon(cls: string, hands: number, step: number): Item | undefined {
  const keySlot = keySlotOf(reg0, cls);
  const group = keyVariantsByBase(reg0, cls, hands).find((g) => g.variants.some((p) => p.stepMin <= step && step <= p.stepMax));
  if (!group) return undefined;
  const parts = {} as CraftParts;
  for (const slot of CRAFT_SLOT_LIST) {
    const pool = slot === keySlot ? group.variants : variantsFor(reg0, cls, slot, hands);
    const p = pool.find((v) => v.stepMin <= step && step <= v.stepMax);
    if (!p) return undefined;
    parts[slot] = { id: p.id, step };
  }
  const pv = craftWeapon(reg0, { weaponClass: cls, hands, parts }, { rng: createRng(5) });
  return pv.ok ? pv.item : undefined;
}

/** Найденный МИФИК (последняя ступень) с пола — как его катает дроп. */
function mythicDrop(): Item {
  const last = craftTiers(reg0).length - 1;
  const base = reg0.get('items.base').find((b) => b.kind === 'weapon' && b.enabled !== false && baseTierRange(reg0, b).hi === last)!;
  const bal = reg0.get('balance');
  for (let s = 1; s < 400; s++) {
    const it = shapeFoundWeapon(reg0, generateItem(reg0.get('items.base'), reg0.get('affixes'), reg0.get('uniques'), {
      dropBias: 1, itemLevel: 99, tierLevel: 99, baseId: base.id, tiers: reg0.get('item-tiers'), rarities: reg0.get('rarities'),
      forceRarity: 'normal', maxReqTotal: bal.maxTotalRequirement, baseRoll: bal.loot.baseRoll, origin: 'drop',
    }, createRng(s)));
    if (tierIndexOfItem(reg0, it) === last && partsOf(reg0, it)) return it;
  }
  throw new Error('мифик не выкатился');
}

/**
 * ВЕЩИ ВЕРСТАКА — какими они бывают в игре: найденные (детали записаны, как у дропа сессии) по каждой включённой базе на нижней, средней
 * или верхней ступени окна, редкость по кругу; копии без поля тира, без записанных деталей (сейв старше §26 — детали выводятся сидом от uid),
 * купленные, без происхождения, поднятые кузнецом, сломанные, с кончившимися перекатками; мифик с пола; стартовый комплект; скованные трёх
 * семейств на трёх ступенях и их зачарованные, без записи заплаченного, с мусором в ней, с формой без цены, сломанные; сырьё, зелье.
 */
function forgeItems(): Item[] {
  const out: Item[] = [];
  const bal = reg0.get('balance');
  const tiers = [...reg0.get('item-tiers')].sort((a, b) => a.minItemLevel - b.minItemLevel);
  const rarities = ['normal', 'magic', 'rare', 'unique'] as const;
  let seed = 301;
  for (const [n, base] of reg0.get('items.base').filter((b) => b.enabled !== false && b.kind !== 'consumable').entries()) {
    const lo = Math.max(0, tiers.findIndex((t) => t.id === base.minTier));
    const hiAt = tiers.findIndex((t) => t.id === base.maxTier);
    const hi = hiAt < 0 ? tiers.length - 1 : hiAt;
    const lvl = tiers[[lo, Math.round((lo + hi) / 2), hi][n % 3]!]!.minItemLevel + 1;
    const raw = generateItem(reg0.get('items.base'), reg0.get('affixes'), reg0.get('uniques'), {
      dropBias: 1, itemLevel: lvl, tierLevel: lvl, baseId: base.id, tiers: reg0.get('item-tiers'), rarities: reg0.get('rarities'),
      forceRarity: rarities[seed % rarities.length]!, maxReqTotal: bal.maxTotalRequirement, baseRoll: bal.loot.baseRoll,
      origin: (['drop', 'chest', 'boss'] as const)[n % 3]!,
    }, createRng(seed++));
    out.push(shapeFoundWeapon(reg0, raw));
  }
  const found = [...out];
  for (const [i, it] of found.entries()) {
    if (i % 5 === 0) { const old: Item = { ...it }; delete old.tier; out.push(old); }                 // сейв старше поля тира
    if (i % 4 === 1 && it.foundParts) { const old: Item = { ...it }; delete old.foundParts; out.push(old); }   // сейв старше §26
    if (i % 7 === 2) out.push({ ...it, origin: 'shop' });
    if (i % 7 === 3) { const none: Item = { ...it }; delete none.origin; out.push(none); }
    if (i % 11 === 4) out.push({ ...it, tierForged: true });
    if (i % 6 === 5) out.push({ ...it, broken: true });
    if (i % 13 === 6) out.push({ ...it, rerolls: bal.forgePrices.rerollLimit });
  }
  const uni = found.find((it) => it.rarity === 'unique');
  if (uni) out.push({ ...uni, broken: true });   // R7-19: сломанный уник из старого сейва — кузнец не чинит
  const sword = found.find((it) => it.baseId === 'short-sword' && it.foundParts);
  if (sword?.foundParts) out.push({ ...sword, foundParts: { ...sword.foundParts, strike: { id: OFF_PART, step: sword.foundParts.strike.step } } });
  const m = mythicDrop();
  out.push(m, { ...m, origin: 'shop' }, { ...m, tierForged: true });
  const kitSeen = new Set<string>();
  for (const cls of reg0.get('classes').filter((c) => c.enabled !== false)) {
    const kit = newCharacterSave(reg0, cls.id, 'golden', 'golden');
    for (const it of [...Object.values(kit.equipment), ...kit.inventory]) {
      if (!it || kitSeen.has(it.baseId)) continue;
      kitSeen.add(it.baseId);
      out.push(it, { ...it, broken: true });
    }
  }
  const crafted: Item[] = [];
  for (const [cls, hands] of [['sword', 1], ['axe', 2], ['staff', 2]] as const) {
    for (const step of [1, 3, 5]) {
      const w = forgedWeapon(cls, hands, step);
      if (!w) continue;
      crafted.push(w);
      for (const r of ['magic', 'rare'] as const) { const e = enchantItem(reg0, w, r, createRng(seed++)); if (e) crafted.push(e); }
    }
  }
  out.push(...crafted);
  const plain = crafted.find((it) => it.rarity === 'normal')!;
  const rare = crafted.find((it) => it.rarity === 'rare')!;
  { const noPaid: Item = { ...plain }; delete noPaid.craftPaid; out.push(noPaid); }
  out.push({ ...plain, craftPaid: [{ id: 'iron-2', n: 9.9 }, { id: '__proto__', n: 9 }, { id: 'iron-1', n: -3 }, { id: 'wood-1', n: Number.NaN }] as Item['craftPaid'] });
  out.push({ ...plain, broken: true }, { ...rare, broken: true });
  { const noPaid: Item = { ...rare, affixCap: { prefix: 3, suffix: 3 } }; delete noPaid.craftPaid; out.push(noPaid); }   // форма без цены
  out.push({ ...rare, itemLevel: 0 }, { ...plain, itemLevel: 0 });   // пул пуст: форму не набрать (и зачарованию тоже)
  out.push({ ...plain, affixCap: { prefix: 3, suffix: 3 } });          // зачарование до редкой катало бы форму без цены
  out.push({ ...found[0]!, baseId: 'no-such-base' });
  const mats = reg0.get('craft-materials');
  out.push(materialItem(mats[0]!, 12, 'mat'), itemFromBaseId(reg0.get('items.base'), 'healing-potion', undefined, 'shop')!);
  return out.map((it, i) => ({ ...it, uid: `pn-${i}` }));
}

/** Бросок «путь, без выхода» (как `disposeConfirm`): путь разбора от кубика не зависит. */
const NO_ROLL: SalvageRng = { int: (a) => a, chance: () => false };

/** Сырьё в сумке: по стеку каждого включённого материала (`count`) — клетки идут подряд, как кладёт сервер. */
function matStacks(count: number, only?: (id: string) => boolean): Item[] {
  const dims = reg.get('balance').inventory;
  return reg.get('craft-materials').filter((m) => m.enabled && (!only || only(m.id))).map((m, i) => ({
    ...materialItem(m, count, `st-${m.id}`), pos: { x: i % dims.cols, y: Math.floor(i / dims.cols) },
  }));
}
/** Сумка, забитая зельями 1×1 вокруг вещи (и стеков). */
function fullBag(items: Item[]): Item[] {
  const dims = reg.get('balance').inventory;
  const bag = items.map((it) => ({ ...it }));
  const potion = itemFromBaseId(reg0.get('items.base'), 'healing-potion', undefined, 'shop')!;
  let k = 0;
  for (let y = 0; y < dims.rows; y++) for (let x = 0; x < dims.cols; x++) {
    const free = bag.every((o) => !o.pos || x >= o.pos.x + o.gridW || x + 1 <= o.pos.x || y >= o.pos.y + o.gridH || y + 1 <= o.pos.y);
    if (free) bag.push({ ...potion, uid: `fill-${k++}`, pos: { x, y } });
  }
  return bag;
}

/**
 * Журналы для вопроса «что засчитал бы кузнец»: нет кадра, пустой, всё открыто (`known` — ровно детали, база, тип и ступень вещи), без детали,
 * без базы, «всё» (`fullJournal` + тип вещи), «всё» без ступени и ворот мифика, без ворот, на шаг до эскиза. Unity строит те же по `parts`,
 * `type`, `tierIndex` вещи и `fullJournal` эталона.
 */
function journalsFor(item: Item): { name: string; j: CraftJournal | null }[] {
  const parts = partsOf(reg, item);
  const typeId = typeOfItem(reg, item)?.typeId;
  const types = typeId ? [typeId] : [];
  const out: { name: string; j: CraftJournal | null }[] = [{ name: 'null', j: null }, { name: 'empty', j: emptyJournal() }];
  if (!parts) return out;
  const variants = CRAFT_SLOT_LIST.map((s) => parts[s].id);
  const known: CraftJournal = { ...emptyJournal(), bases: [item.baseId], variants, tierHi: tierIndexOfItem(reg, item), typesSeen: types };
  const all: CraftJournal = { ...fullJournal(reg), typesSeen: types };
  const k = reg.get('balance').craft.journal;
  const base = reg.get('items.base').find((b) => b.id === item.baseId);
  out.push(
    { name: 'known', j: known },
    { name: 'no-variant', j: { ...known, variants: variants.slice(1) } },
    { name: 'no-base', j: { ...known, bases: [] } },
    { name: 'all', j: all },
    { name: 'all-low', j: { ...all, tierHi: 0, mythic: 0 } },
    { name: 'all-gate', j: { ...all, mythic: 0 } },
    { name: 'sketch', j: { ...known, classSalvages: base?.kind === 'weapon' ? { [base.weaponClass]: k.sketchAfter - 1 } : {} } },
    { name: 'sketch-all', j: { ...all, classSalvages: base?.kind === 'weapon' ? { [base.weaponClass]: k.sketchAfter - 1 } : {} } },
  );
  return out;
}

/** Карточка верстака — ровно поля `BenchAction` (без `undefined`). */
const benchView = (a: ReturnType<typeof benchActions>[number]): Record<string, unknown> =>
  pick(a, ['id', 'cmd', 'rarity', 'title', 'sub', 'lines', 'enabled', 'primary', 'tip', 'gold', 'materials', 'minYield', 'avgYield']);

/** ⭐ Раздел `items`: по вещи — починка, зачарование, разбор (у кузнеца и в поле), карточки верстака в трёх кошельках, вопросы. */
function itemCases() {
  const rich = Object.fromEntries(reg.get('craft-materials').map((m) => [m.id, 1000]));
  const wallets: { name: string; gold: number; extra: Item[]; wallet: Record<string, number> }[] = [
    { name: 'broke', gold: 0, extra: [], wallet: {} },
    { name: 'rich', gold: 10_000_000, extra: matStacks(200), wallet: rich },
    { name: 'some', gold: 500, extra: matStacks(3, (id) => id.endsWith('-1')), wallet: { 'iron-1': 5, 'plate-1': 30, 'iron-2': 1 } },
  ];
  return forgeItems().map((item) => {
    const bagItem = { ...item, pos: { x: 9, y: 5 } };
    const salvage = (inField: boolean) => {
      const can = canSalvageItem(reg, item, inField);
      const rng = salvageRange(reg, item, inField);
      return {
        can: can.ok ? null : can.reason ?? '', range: rng.range, mean: salvageMean(reg, item, inField),
        source: salvageYield(reg, item, NO_ROLL, inField).source ?? null,
      };
    };
    const target = benchTarget(reg, item);
    const isWeapon = item.kind === 'weapon';
    const type = typeOfItem(reg, item);
    return {
      item,
      // Из чего сделана вещь (`partsOf`: записанное или выведенное сидом), её тип (`typeOfItem`) и ступень (`tierIndexOfItem`): по ним же Unity
      // строит журналы вопроса (`journalsFor`) — сами журналы в эталон не кладутся (полный журнал на 220 вещей — мегабайты).
      parts: partsOf(reg, item), type: type ? { id: type.typeId ?? null, name: type.name } : null, tierIndex: tierIndexOfItem(reg, item),
      // ⭐ §7: сырьё починки — по ступени вещи (расходник I + главный сорт), §6.2: эссенция зачарования и перекатки.
      repair: (() => { const c = canRepairItem(reg, item); return { can: c.ok ? null : c.reason ?? '', cost: repairCost(reg, item) }; })(),
      enchant: Object.fromEntries((['magic', 'rare'] as const).map((r) => {
        const c = canEnchantItem(reg, item, r);
        return [r, { can: c.ok ? null : c.reason ?? '', cost: num(enchantCost(reg, item, r)), essence: enchantMaterials(reg, item, r) }];
      })),
      rerollEssence: rerollMaterials(reg, item),
      forge: salvage(false),
      field: salvage(true),
      fits: {
        alone: fieldSalvageFits(reg, [bagItem], bagItem),
        full: fieldSalvageFits(reg, fullBag([bagItem]), bagItem),
        stacked: fieldSalvageFits(reg, fullBag([bagItem, ...matStacks(150)]), bagItem),
      },
      label: benchTargetLabel(reg, item, target),
      glyph: glyphOf(item),   // подпись клетки сетки и слота верстака (heldItem.ts `glyphOf`): у сырья — число в стеке
      bench: wallets.map((w) => ({
        wallet: w.name,
        actions: benchActions(reg, item, w.gold, [bagItem, ...w.extra], w.wallet).map(benchView),
      })),
      journal: (isWeapon ? journalsFor(item) : [{ name: 'empty', j: emptyJournal() }]).map(({ name, j }) => ({ name, gains: journalGainsOf(reg, item, j) })),
      prompts: {
        field: disposePrompts(reg, item, 'field', emptyJournal()),
        forge: disposePrompts(reg, item, 'forge', emptyJournal()),
        sell: disposePrompts(reg, item, 'sell', emptyJournal(), 37),
        sellNull: disposePrompts(reg, item, 'sell', null),
      },
    };
  });
}

// ── Гнёзда скилов (socketsView.ts) ────────────────────────────────────────────────────────────────
const POOL_SHORT: Record<'mana' | 'stamina', string> = { mana: 'маны', stamina: 'выносл.' };
const priceText = (ins: { cost: number; costPool: 'carrier' | 'mana' | 'stamina' }, carrier?: 'mana' | 'stamina'): string => {
  if (!ins.cost) return 'бесплатно';
  const pool = ins.costPool === 'carrier' ? carrier : ins.costPool;
  return `${ins.cost > 0 ? '+' : ''}${ins.cost} ${pool ? POOL_SHORT[pool] : 'ресурса скила'}`;
};

/** Сейвы для гнёзд: выученные активки на разных рангах, доноры вставок, гнёзда с годным, чужим, выключенным, лишним; разное оружие. */
function socketSaves(): { name: string; save: SaveState }[] {
  const tree = reg.get('skill-tree');
  const actives = tree.nodes.filter((n) => n.effect.active);
  const donors = tree.nodes.filter((n) => n.effect.grantsInsert);
  const inserts = reg.get('skill-inserts');
  const base = (): SaveState => newCharacterSave(reg, 'warrior', 'golden', 'golden');
  const weapon = (id: string): Item => itemFromBaseId(reg.get('items.base'), id, undefined, 'drop')!;
  const out: { name: string; save: SaveState }[] = [];
  out.push({ name: 'fresh', save: base() });
  const ranks = [1, 6, 12, 20, 3];
  for (const [k, w] of ['short-sword', 'apprentice-wand', 'short-bow', 'greatsword'].entries()) {
    const s = base();
    s.equipment.weapon = weapon(w) ?? s.equipment.weapon;
    for (const [i, n] of actives.slice(k * 7, k * 7 + 9).entries()) s.skills[n.id] = ranks[i % ranks.length]!;
    for (const [i, d] of donors.entries()) if ((i + k) % 3 !== 0) s.skills[d.id] = 1 + ((i * 3 + k) % 9);   // ранги 1–9: цена и откат вставки дробные
    const learned = actives.filter((n) => (s.skills[n.id] ?? 0) > 0);
    s.sockets = {};
    for (const [i, n] of learned.entries()) {
      const pickIns = (j: number): string | null => (j % 5 === 4 ? null : inserts[(i * 3 + j + k) % inserts.length]!.id);
      s.sockets[n.id] = [pickIns(0), pickIns(1), pickIns(2), ...(i % 2 ? ['no-such-insert'] : [])];
    }
    out.push({ name: `w${k}-${w}`, save: s });
  }
  return out;
}

function socketCases() {
  const cfg = reg;
  const tree = cfg.get('skill-tree');
  const typeName = (id: string): string => cfg.get('skill-insert-types').find((t) => t.id === id)?.name ?? id;
  return socketSaves().map(({ name, save }) => {
    const learned = tree.nodes.filter((n) => n.effect.active && socketsOpen(cfg, save.skills[n.id] ?? 0) > 0);
    return {
      name,
      save: pick(save, ['classId', 'skills', 'sockets', 'equipment']),
      learned: learned.map((n) => {
        const base = n.effect.active!;
        const open = socketsOpen(cfg, save.skills[n.id] ?? 0);
        const slots = save.sockets?.[n.id] ?? [];
        const weaponClass = save.equipment.weapon?.weaponClass;
        const r = resolveActive(cfg, save, n.id);
        const b = base as { manaCost: number; cooldown: number };
        return {
          id: n.id,
          label: `${n.name} ${(save.sockets?.[n.id] ?? []).filter(Boolean).length}/${open}`,
          cells: Array.from({ length: open }, (_, i) => {
            const cur = slots[i] ?? null;
            const ins = cur ? insertById(cfg, cur) : undefined;
            const rk = ins ? insertRank(cfg, save, ins.id) : 0;
            const others = (save.sockets?.[n.id] ?? []).slice(0, open).filter((_, j) => j !== i);
            const usedTypes = new Set(others.map((id) => (id ? insertById(cfg, id)?.type : undefined)).filter(Boolean) as string[]);
            const options: { label: string; insertId: string | null }[] = cur ? [{ label: '✕ Вынуть', insertId: null }] : [];
            for (const x of cfg.get('skill-inserts')) {
              if (x.enabled === false || x.id === cur) continue;
              if (!insertUnlocked(cfg, save, x.id)) continue;
              if (!insertFits(x, base, weaponClass)) continue;
              if (usedTypes.has(x.type)) continue;
              options.push({ label: `${typeName(x.type)} · ${x.name}`, insertId: x.id });
            }
            return {
              head: ins ? typeName(ins.type) : `Гнездо ${i + 1}`,
              text: ins ? `${ins.name} · ${rk}` : '— пусто —',
              price: ins ? priceText(ins, base.resource) : null,
              options,
            };
          }),
          summary: r ? {
            baseCost: b.manaCost, cost: (r.active as { manaCost: number }).manaCost, baseCd: b.cooldown, cd: (r.active as { cooldown: number }).cooldown,
            resource: r.active.resource, extra: r.extraCost ?? null, procs: r.procs.length,
          } : null,
        };
      }),
    };
  });
}

// ── Атрибуты и сброс ──────────────────────────────────────────────────────────────────────────────
function attrCases() {
  const pend = (s: number, d: number, i: number, v: number): Record<Attribute, number> => ({ strength: s, dexterity: d, intelligence: i, vitality: v });
  const alloc = [pend(0, 0, 0, 0), pend(1, 0, 0, 0), pend(3, 2, 0, 5), pend(ALLOC_ATTR_MAX, 0, 1, 0), pend(2 * ALLOC_ATTR_MAX + 7, 0, 0, 1),
    pend(-3, 0, 0, 2), pend(1.7, 0, 0, 0)].map((p) => ({ pending: p, cmds: attrAllocCommands(p) }));
  const cost = reg.get('balance').respecCost;
  const save = (f: (s: SaveState) => void): SaveState => { const s = newCharacterSave(reg, 'warrior', 'golden', 'golden'); f(s); return s; };
  const saves: { name: string; save: SaveState }[] = [
    { name: 'fresh', save: save(() => {}) },
    { name: 'invested', save: save((s) => { s.attributes.strength += 12; s.attributes.vitality += 3; s.gold = 10_000; }) },
    { name: 'poor', save: save((s) => { s.attributes.dexterity += 5; s.gold = cost - 1; }) },
    { name: 'worn', save: save((s) => {
      s.attributes.strength += 30; s.gold = 10_000;
      s.equipment.helm = { ...itemFromBaseId(reg.get('items.base'), 'leather-cap', undefined, 'drop')!, requirements: { strength: s.attributes.strength } };
    }) },
    { name: 'legacy', save: save((s) => { delete s.startAttributes; s.attributes.intelligence += 8; s.gold = 10_000; }) },
    { name: 'no-class', save: save((s) => { delete s.startAttributes; s.classId = 'no-such-class'; s.attributes.strength += 1; s.gold = 10_000; }) },
    { name: 'below-start', save: save((s) => { s.attributes.strength -= 2; s.attributes.vitality += 1.6; s.gold = 10_000; }) },
  ];
  return {
    alloc,
    respec: saves.map(({ name, save: s }) => ({
      name, save: pick(s, ['classId', 'attributes', 'startAttributes', 'gold', 'equipment']),
      refund: attrRespecRefund(reg, s), refusal: respecRefusal(reg, s, cost), refusalHigh: respecRefusal(reg, s, cost - 1),
    })),
  };
}

// ── Задания (questLogPanel.ts) ───────────────────────────────────────────────────────────────────
function questLines(def: QuestDef, prog: { status: string; counters: Record<string, number> } | undefined) {
  const r = def.reward;
  return {
    status: prog?.status === 'completed' ? 'выполнено' : prog?.status === 'turned-in' ? 'сдано' : '',
    objectives: def.objectives.map((obj) => `• ${obj.type}${obj.target ? ` ${obj.target}` : ''}: ${prog?.counters[obj.id] ?? 0}/${obj.amount}`),
    reward: [r.gold && `${r.gold} зол.`, r.xp && `~${Math.round(r.xp / 10)}% ур. опыта`, r.skillPoints && `${r.skillPoints} очк.`, r.itemBaseId && 'предмет']
      .filter(Boolean).join(', '),
  };
}
function questCases() {
  const board: QuestDef[] = [];
  for (let s = 1; s <= 4; s++) board.push(...generateBoard(reg, createRng(s), 1_700_000_000_000 + s * 1000));
  const s0 = newCharacterSave(reg, 'warrior', 'golden', 'golden');
  const mains = s0.activeQuestDefs;
  const saves: { name: string; save: Pick<SaveState, 'quests' | 'activeQuestDefs'> }[] = [];
  const mk = (name: string, prog: { def: QuestDef; status: 'active' | 'completed' | 'turned-in'; n: number }[]): void => {
    saves.push({ name, save: {
      activeQuestDefs: [...mains, ...prog.map((p) => p.def)],
      quests: [...s0.quests, ...prog.map((p) => ({ questId: p.def.id, status: p.status, counters: Object.fromEntries(p.def.objectives.map((o) => [o.id, p.n])) }))],
    } });
  };
  // Начатое задание того же шаблона с прогрессом — соперник; без прогресса, выполненное, сданное — нет.
  const sameTpl = (d: QuestDef): QuestDef | undefined => board.find((x) => x.id !== d.id && x.id.replace(/_[0-9a-z]+$/, '') === d.id.replace(/_[0-9a-z]+$/, ''));
  const a = board[0]!, b = sameTpl(a) ?? board[1]!;
  mk('none', []);
  mk('rival', [{ def: b, status: 'active', n: 1 }]);
  mk('rival-zero', [{ def: b, status: 'active', n: 0 }]);
  mk('rival-done', [{ def: b, status: 'completed', n: 99 }]);
  mk('same', [{ def: a, status: 'active', n: 2 }]);
  mk('mixed', board.slice(2, 6).map((d, i) => ({ def: d, status: (['active', 'completed', 'turned-in', 'active'] as const)[i]!, n: i })));
  return {
    board,
    saves: saves.map(({ name, save }) => ({
      name, save,
      rival: board.map((d) => questRival(save as SaveState, d) ?? null),
      blocks: save.quests.filter((q) => q.status !== 'turned-in').map((q) => {
        const def = save.activeQuestDefs.find((d) => d.id === q.questId);
        return def ? { questId: q.questId, ...questLines(def, q) } : null;
      }),
    })),
    boardBlocks: board.map((d) => questLines(d, undefined)),
  };
}

// ── «Ресурсы» сундука (materialsModel.ts — настоящая функция, не копия) ───────────────────────────────────────────────────────
/**
 * ⭐ §15.1: столбцы — сорта I–V («I сорт» + мелко «с каких вещей» из рецепта `salvage.recipeByTier`), металлическая шкала цветов без
 * цветов редкостей, клетка `null` — сорта у семьи нет (выключен): столбцы не съезжают; эссенция — плашкой под сеткой; строка-правило;
 * подсказки строками (первая — заголовок цветом сорта). Плюс подсказка стопки сырья в сумке (`materialNote`) по каждому материалу.
 */
function materialsCases() {
  const defs = reg.get('craft-materials').filter((d) => d.enabled);
  const view = (wallet: Record<string, number>, inventory: Item[]) => {
    const total = Object.values(carriedMaterials(inventory)).reduce((x, y) => x + y, 0);
    return {
      tab: total > 0 ? `Ресурсы (+${total})` : 'Ресурсы',
      deposit: total > 0 ? `Сдать всё сырьё (${total})` : 'В сумке сырья нет',
      ...materialsModel(reg, wallet, inventory),
    };
  };
  const pot = itemFromBaseId(reg0.get('items.base'), 'healing-potion', undefined, 'shop')!;
  const cases: { wallet: Record<string, number>; inventory: Item[] }[] = [
    { wallet: {}, inventory: [] },
    { wallet: { 'iron-1': 40, 'iron-2': 3, 'plate-1': 12, 'cloth-4': 1, 'iron-5': 6, 'no-such': 2, [ESSENCE_ID]: 9 }, inventory: [pot] },
    { wallet: { 'wood-1': 7 }, inventory: [...matStacks(17, (id) => /-(1|3)$/.test(id) || id === ESSENCE_ID), { ...materialItem(defs[0]!, 1, 'nc'), count: undefined } as unknown as Item, pot] },
  ];
  return {
    cases: cases.map((c) => ({ ...c, view: view(c.wallet, c.inventory) })),
    notes: reg.get('craft-materials').map((m) => ({ id: m.id, note: materialNote(reg, { kind: 'material', materialId: m.id }) })),
  };
}

// ── Меню предмета инвентаря (inventoryPanel.ts) ─────────────────────────────────────────────────
function menuCases(items: Item[]) {
  const s0 = newCharacterSave(reg, 'warrior', 'golden', 'golden');
  const out = [];
  for (const [k, item] of items.entries()) {
    // Треть вещей хватает: меню решают те же правила. Зелья, сырьё и каждая вещь с отказом разбора в поле — все: пункт «Разобрать нельзя: …».
    if (k % 3 !== 0 && item.kind !== 'consumable' && item.kind !== 'material' && canSalvageItem(reg, item, true).ok) continue;
    const bagItem = { ...item, pos: { x: 9, y: 5 } };
    for (const [bagName, bag] of [['alone', [bagItem]], ['full', fullBag([bagItem])]] as [string, Item[]][]) {
      const save: SaveState = { ...s0, inventory: bag, attributes: { strength: 40, dexterity: 40, intelligence: 40, vitality: 40 } };
      for (const town of [true, false]) {
        const wear = item.slot ? reqRefusal(save, item) : null;
        // Пункт и живой ли он: пункт-пояснение («Сломано…», «Надеть нельзя: …», «Разобрать нельзя: …») погашен — у Unity действие `null`.
        const rows: [string, boolean][] = item.kind === 'consumable' ? [['Выпить', true], ['В пояс', true]]
          : item.broken ? [['Сломано — к кузнецу', false]] : !item.slot ? [] : wear ? [[`Надеть нельзя: ${wear}`, false]] : [['Надеть', true]];
        rows.push(['Выбросить', true]);
        const entry = town ? null : fieldSalvageEntry(reg, save.inventory, bagItem);
        if (entry) rows.push([entry.label, entry.ok]);
        // ⭐ §15.2: подсказка пункта разбора — карточка разбора в поле (без строки каталога, D2), журнала нет — как пустой; у погашенного —
        // «Разобрать нельзя» и причина; «сумка полна» (карточка сама не знает — `refusal`) — причина и карточка целиком.
        const tip = entry ? fieldSalvageLines(reg, item, null, entry.reason) : null;
        out.push({ uid: item.uid, bag: bagName, town, attributes: save.attributes, labels: rows.map((r) => r[0]), live: rows.map((r) => r[1]), ...(tip ? { tip } : {}) });
      }
    }
  }
  return out;
}
/** «Надеть» меню — `equipRefusal` ядра (его порт Unity уже сверяет эталон города); здесь — та же функция. */
const reqRefusal = (save: SaveState, item: Item): string | null => equipRefusal(reg, save, item.uid);

// ── Пояс, таблички, статусы, бинды ───────────────────────────────────────────────────────────────
function beltCases() {
  const belt = (n?: number): Item | undefined => (n === undefined ? undefined : { ...itemFromBaseId(reg.get('items.base'), 'leather-belt', undefined, 'drop')!, beltSlots: n });
  return [undefined, 0, 1, 2, 4].map((n) => {
    const b = belt(n);
    const eq = b ? { belt: b } : {};
    return { equipment: eq, capacity: (eq as { belt?: Item }).belt?.beltSlots ?? 0 };
  });
}

const DEBUFF_COLOR: Record<DebuffKind, string> = {
  wound: '#c86a5a', bleed: '#d8583e', sunder: '#c0956a', daze: '#c9b46a',
  burn: '#ff7a2a', poison: '#6ecb3f', shock: '#ffe24a', freeze: '#59a8ff',
};
function debuffCases() {
  const dcfg = reg.get('debuffs');
  const d = (stacks: number) => ({ stacks, maxStacks: 5, expiresAt: 1 });
  const states: Record<string, unknown>[] = [
    {}, { bleed: d(1) }, { burn: d(3), freeze: d(1) }, { poison: d(2), wound: d(1), shock: d(1), daze: d(4), sunder: d(2) },
    { freeze: d(1), burn: null, bleed: d(5) },
  ];
  return states.map((debuffs) => {
    const ks = (Object.keys(debuffs) as DebuffKind[]).filter((k) => debuffs[k]);
    const st = (k: DebuffKind) => debuffs[k] as { stacks: number };
    return {
      debuffs,
      plate: ks.length ? ks.map((k) => `${debuffIcon(dcfg, k)}${st(k).stacks > 1 ? st(k).stacks : ''}`).join(' ') : '',
      strip: ks.map((k) => ({ kind: k, icon: debuffIcon(dcfg, k), title: `${debuffLabel(dcfg, k)}${st(k).stacks > 1 ? ` ×${st(k).stacks}` : ''}`, stacks: st(k).stacks, color: DEBUFF_COLOR[k] })),
    };
  });
}
function auraCases() {
  const toggles = reg.get('skill-tree').nodes.filter((n) => n.effect.active && (n.effect.active.category === 'aura' || n.effect.active.category === 'stance')).map((n) => n.id);
  return [[], toggles.slice(0, 1), toggles.slice(1, 4), ['no-such-node', ...toggles.slice(4, 5)]].map((t) => {
    const auras = activeToggleInfos(reg, t);
    return { toggles: t, line: auras.length ? '◈ ' + auras.map((a) => a.name).join('   ◈ ') : '' };
  });
}
function bindCases() {
  const nodes = reg.get('skill-tree').nodes.filter((n) => n.effect.active);
  const w = (id: string): Item => itemFromBaseId(reg.get('items.base'), id, undefined, 'drop')!;
  const kits: { name: string; weapon?: Item; offhand?: Item }[] = [
    { name: 'none' }, { name: 'sword', weapon: w('short-sword') }, { name: 'sword+shield', weapon: w('short-sword'), offhand: w('wooden-shield') },
    { name: 'dual', weapon: w('short-sword'), offhand: w('dagger') }, { name: 'greatsword', weapon: w('greatsword') },
    { name: 'greatsword+shield', weapon: w('greatsword'), offhand: w('wooden-shield') }, { name: 'bow', weapon: w('short-bow') },
    { name: 'wand', weapon: w('apprentice-wand') }, { name: 'staff', weapon: w('apprentice-staff') ?? w('apprentice-wand') },
  ];
  const fits = (n: (typeof nodes)[number], k: (typeof kits)[number]): boolean => {
    const active = n.effect.active!;
    if (active.category !== 'attack' && active.category !== 'cast' && active.category !== 'curse') return true;
    return skillWeaponAllowed(active, k.weapon, k.offhand);
  };
  return {
    kits: kits.map((k) => ({ name: k.name, weapon: k.weapon ?? null, offhand: k.offhand ?? null })),
    nodes: nodes.map((n) => ({
      id: n.id, abbrev: n.name.replace(/^Мастерство:\s*/, '').slice(0, 2), attackLike: n.effect.active!.category === 'attack', element: elementOf(n),
      fits: kits.map((k) => fits(n, k)),
    })),
  };
}

describe('unityPanelsGolden — продюсер эталона панелей (пишет __golden__/unity_panels.json)', () => {
  it('копии разметки окон сторожатся строками исходника', () => {
    for (const [src, line] of SRC) expect(src.includes(line), `нет строки исходника: ${line}`).toBe(true);
  });

  it('генерит эталон и пишет на диск', () => {
    const items = itemCases();
    // Эталон обязан покрыть каждый отказ верстака, который бывает у вещей игры: иначе порт Unity его не сверит.
    const reasons = (f: (c: (typeof items)[number]) => (string | null)[]) => new Set(items.flatMap(f));
    const rep = reasons((c) => [c.repair.can]);
    for (const r of [null, 'Вещь цела', 'Уникальную вещь кузнец не чинит']) expect(rep.has(r), `починка: ${r}`).toBe(true);
    const ench = reasons((c) => [c.enchant.magic!.can, c.enchant.rare!.can]);
    for (const r of [null, 'Зачаровать можно только скованную вещь', 'Вещь уже зачарована', 'Сперва почини', 'Кузнецу не хватит свойств на форму этой вещи'])
      expect(ench.has(r), `зачарование: ${r}`).toBe(true);
    const salv = reasons((c) => [c.forge.can, c.field.can]);
    // Отказы разбора (предложение «Разбор, сырьё и чары»): уник; стартовый набор в поле (у кузнеца он идёт в каталог — `catalog`).
    for (const r of [null, UNIQUE_NO_SALVAGE, STARTER_FIELD, 'Эту вещь не из чего разбирать'])
      expect(salv.has(r), `разбор: ${r}`).toBe(true);
    expect(new Set(items.map((c) => c.forge.source))).toEqual(new Set(['melt', 'parts', 'rules', 'catalog', null]));
    expect(items.some((c) => c.fits.alone && !c.fits.full), 'полная сумка отказывает разбор в поле').toBe(true);
    expect(items.some((c) => c.field.mean && Object.values(c.field.mean).some((v) => !Number.isInteger(v))), 'дробный средний выход').toBe(true);
    expect(items.some((c) => c.journal.some((j) => j.gains.some((g) => g.startsWith('эскиз')))), 'эскиз в вопросе').toBe(true);
    // Мифика и ступени в вопросе нет: ковку держит только сырьё (решение D3).
    expect(items.some((c) => c.journal.some((j) => j.gains.some((g) => /^(мифик|ступень)/.test(g)))), 'мифика и ступени в вопросе нет').toBe(false);
    expect(items.some((c) => c.journal.some((j) => j.gains.some((g) => g.startsWith('снаряжение')))), 'снаряжение в вопросе').toBe(true);
    expect(items.some((c) => c.journal.some((j) => j.gains.some((g) => g.startsWith('кодекс')))), 'кодекс в вопросе').toBe(true);
    expect(items.some((c) => c.prompts.forge.length === 2), 'скованное у кузнеца — два вопроса').toBe(true);
    // R2-28: разбор и переплавка выключенного не выдают — ступень спускается (`iron-5` → `iron-4`).
    expect(items.every((c) => !('iron-5' in c.forge.range) && !('iron-5' in c.field.range))).toBe(true);
    expect(items.some((c) => c.bench.some((b) => b.actions.some((a) => a.id === 'enchant' && a.enabled)))).toBe(true);
    // §6.2: эссенция — строкой карточки и согласием `materials` у перекатки и зачарования; без неё («бедный» кошелёк) карточка гаснет.
    expect(items.some((c) => c.bench.some((b) => b.actions.some((a) => a.id === 'reroll' && a.materials && Object.keys(a.materials as object).length)))).toBe(true);
    expect(items.some((c) => c.bench.some((b) => b.wallet === 'broke' && b.actions.some((a) => a.id === 'enchant' && !a.enabled)))).toBe(true);
    const sockets = socketCases();
    expect(sockets.some((s) => s.learned.some((l) => l.summary?.extra))).toBe(true);
    expect(sockets.some((s) => s.learned.some((l) => l.cells.some((c) => c.options.length > 2)))).toBe(true);
    const attrs = attrCases();
    expect(new Set(attrs.respec.map((r) => r.refusal)).size).toBeGreaterThan(3);
    const quests = questCases();
    expect(quests.saves.some((s) => s.rival.some((r) => r))).toBe(true);
    // ⭐ §15.1: склад — сорта I–V, эссенция плашкой (не строкой сетки), выключенный сорт — пустая клетка на своём месте.
    const materials = materialsCases();
    const v0 = materials.cases[0]!.view, v1 = materials.cases[1]!.view;
    expect(v0.heads.map((h) => h.label)).toEqual(['I сорт', 'II сорт', 'III сорт', 'IV сорт', 'V сорт']);
    expect(v0.heads[0]!.sub).toMatch(/тела монстров$/);
    expect(v0.heads.some((h) => h.sub.includes('(боевая часть)'))).toBe(true);
    expect(v0.rows.some((r) => r.family === 'ench'), 'эссенция — не строка сетки').toBe(false);
    expect(v0.rows.find((r) => r.family === 'iron')!.cells[4], 'iron-5 выключен — клетка пуста, столбцы не съехали').toBeNull();
    expect(v1.essence?.stash).toBe(9);
    expect(materials.cases[2]!.view.essence?.hand).toBe(17);
    expect(v1.rule).toBe('Разбор: сырьё — по ступени вещи, эссенция — по редкости, детали — в каталог (у кузнеца)');
    expect(materials.notes.every((n) => n.note && n.note.lines.length > 2)).toBe(true);
    // Стопка эссенции: вид говорит `describeItem` («Валюта чар · в стеке N»), здесь — откуда, куда, цена, без «Не сырьё».
    expect(materials.notes.find((n) => n.id === ESSENCE_ID)!.note!.lines.some((l) => /сырь/i.test(l))).toBe(false);
    // Отказ разбора в поле — пунктом с причиной и подсказкой, а не пропавшим пунктом: стартовый набор, уник, сумка полна.
    const menu = menuCases(items.map((c) => c.item));
    for (const r of [STARTER_FIELD, UNIQUE_NO_SALVAGE, 'сумка полна'])
      expect(menu.some((m) => m.labels.at(-1) === `Разобрать нельзя: ${r}` && m.live.at(-1) === false && m.tip), `меню: ${r}`).toBe(true);
    // Подсказка погашенного — заголовок по отказу («… нельзя», не «Разобрать здесь (30 %)»); разбор невозможен — только он и причина из
    // подписи (как верстак кузницы), «сумка полна» — причина и карточка целиком (разбор возможен, мешает место).
    for (const m of menu.filter((x) => x.live.at(-1) === false && x.labels.at(-1)!.startsWith('Разобрать нельзя: '))) {
      const why = m.labels.at(-1)!.slice('Разобрать нельзя: '.length);
      expect(m.tip![0]!.text, m.uid).toMatch(/^(Разобрать|Переплавить) нельзя$/);
      if (why === 'сумка полна') expect(m.tip!.length > 2 && m.tip![1]!.text === FIELD_SALVAGE_FULL, m.uid).toBe(true);
      else expect(m.tip!.slice(1), m.uid).toEqual([{ text: why, tone: 'warn' }]);
    }
    const golden = {
      note: 'Эталон паритета Unity ↔ веб для недостающих панелей (U6a). Генерит packages/client/src/modules/town/unityPanelsGolden.gen.test.ts.',
      config: {
        rarities: reg.get('rarities').map((r) => pick(r, ['id', 'priceMult', 'minAffixes', 'maxAffixes', 'maxPrefix', 'maxSuffix'])),
        'craft-materials': reg.get('craft-materials').map((m) => pick(m, ['id', 'name', 'family', 'tier', 'enabled', 'sellPrice'])),
        'items.base': reg.get('items.base').map((b) => pick(b, ['id', 'name', 'kind', 'enabled', 'slot', 'minTier', 'maxTier', 'baseStats', 'weaponClass', 'hands', 'attackType', 'damageKind', 'gender'])),
        'item-tiers': reg.get('item-tiers').map((t) => pick(t, ['id', 'name', 'minItemLevel', 'statMult', 'reqMult', 'enabled'])),
        'salvage-rules': reg.get('salvage-rules'),
        'weapon-parts': reg.get('weapon-parts').map((p) => pick(p, ['id', 'name', 'enabled', 'slot', 'classes', 'hands', 'stepMin', 'stepMax', 'rarity', 'geom', 'family', 'tags'])),
        'weapon-anatomy': reg.get('weapon-anatomy'),
        'weapon-types': reg.get('weapon-types'),
        affixes: reg.get('affixes').map((a) => pick(a, ['id', 'enabled', 'kind', 'group', 'onMagic', 'onRare', 'appliesTo', 'exclude', 'stat', 'tiers', 'mods', 'proc'])),
        classes: reg.get('classes').map((c) => pick(c, ['id', 'enabled', 'startAttributes'])),
        'skill-tree': { nodes: reg.get('skill-tree').nodes.map((n) => pick(n, ['id', 'name', 'effect'])) },
        'skill-inserts': reg.get('skill-inserts'),
        'skill-insert-types': reg.get('skill-insert-types').map((t) => pick(t, ['id', 'name'])),
        debuffs: reg.get('debuffs').map((d) => pick(d, ['id', 'name', 'icon'])),
        balance: (() => {
          const b = reg.get('balance');
          return {
            forgePrices: b.forgePrices, loot: { baseRoll: b.loot.baseRoll }, salvage: b.salvage, inventory: b.inventory, respecCost: b.respecCost,
            skillSocketRanks: b.skillSocketRanks,
            craft: {
              live: b.craft.live, tierFromParts: b.craft.tierFromParts, formMult: b.craft.formMult, rarityWeight: b.craft.rarityWeight,
              cost: b.craft.cost, melt: b.craft.melt, salvage: b.craft.salvage, journal: b.craft.journal, foundEvenness: b.craft.foundEvenness,
            },
          };
        })(),
      },
      items,
      fullJournal: fullJournal(reg),
      // Сумки карточек и меню: вещь лежит в (9, 5), стеки — подряд с (0, 0); «полная» — свободные клетки забиты зельями 1×1 (Unity строит сама).
      bags: { stacks200: matStacks(200), stacks150: matStacks(150), some: matStacks(3, (id) => id.endsWith('-1')) },
      menuSave: pick(newCharacterSave(reg, 'warrior', 'golden', 'golden'), ['equipment', 'belt']),
      sockets,
      prices: reg.get('skill-inserts').flatMap((ins) => (['mana', 'stamina'] as const).map((carrier) => ({ id: ins.id, carrier, text: priceText(ins, carrier) }))),
      attrs,
      quests,
      materials,
      menu,
      belt: beltCases(),
      debuffs: debuffCases(),
      auras: auraCases(),
      bind: bindCases(),
      attributes: [...ATTRIBUTES],
    };
    const dir = join(HERE, '__golden__');
    mkdirSync(dir, { recursive: true });
    // uid вещей, рождённых часами (uuidv7 у `newCharacterSave`, `itemFromBaseId`), — постоянными по порядку появления: эталон не должен
    // меняться от прогона к прогону (правила uid не читают; вещи верстака и так `pn-N`).
    const uids = new Map<string, string>();
    const stable = (k: string, v: unknown): unknown => {
      if (k !== 'uid' || typeof v !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(v)) return v;
      if (!uids.has(v)) uids.set(v, `u-${uids.size}`);
      return uids.get(v);
    };
    writeFileSync(join(dir, 'unity_panels.json'), JSON.stringify(golden, stable));
  });
});

import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { createRng } from '../formulas/rng.js';
import { generateItem } from '../formulas/itemgen.js';
import { newBotSave } from '../sim/playerBot.js';
import { acceptQuest, boardTemplateOf, generateBoard, turnInQuest } from './questLogic.js';
import { newCharacterSave } from './newCharacter.js';
import { unequip } from './townActions.js';
import { saveStateSchema } from '../validation/save.js';
import type { Item } from '../types/items.js';
import type { QuestDef } from '../types/quest.js';
import type { SaveState } from '../types/save.js';

/**
 * ⚠ R13-12: ВЫКЛЮЧЕННАЯ БАЗА НЕ ВХОДИТ В ИГРУ НИКАКИМ ПУТЁМ. Галка редактора `items.base.enabled: false` — «не выпадает и не в
 * магазине», а R11-13 закрыл только зелья лавки. Ещё два пути раздавали её дальше: награда доски (`questFromTemplate` брал из
 * `rewardItemPool` без проверки, `turnInQuest` строил вещь по id) — 200 из 200 сдач «зачистки» при выключенных кольце и шапке;
 * и уники (`generateItem` отбирал включённые уники, а базу искал среди всех) — 128 из 384 уников за 20 000 дропов лежали на
 * выключенной секире палача. Сегодня ни пул наград, ни уник на выключенную базу не ссылаются — дыру открывает правка хозяина.
 */

const live = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();

const offCache = new Map<string, ConfigRegistry>();
/** Живой конфиг, где базы `ids` выключены — ровно та правка, что делает галка редактора (`/api/dev/config` → `reload`). */
function basesOff(...ids: string[]): ConfigRegistry {
  const key = [...ids].sort().join(',');
  const hit = offCache.get(key);
  if (hit) return hit;
  const r = new ConfigRegistry();
  r.loadAll();
  for (const id of ids) expect(r.get('items.base').some((b) => b.id === id), `база ${id} есть в конфиге`).toBe(true);
  r.reload({ 'items.base': r.get('items.base').map((b) => (ids.includes(b.id) ? { ...b, enabled: false } : b)) });
  offCache.set(key, r);
  return r;
}

/** Шаблон доски с вещью в награде и его пул (живые данные: «зачистка» — шапка и кольцо). */
const tpl = live.get('quests.random').find((t) => t.enabled !== false && (t.rewardItemPool?.length ?? 0) > 1)!;
const pool = tpl.rewardItemPool!;

/** Задание шаблона с доски сида `s`, принятое и выполненное в свежем сейве (пустая сумка). */
function doneFromBoard(reg: ConfigRegistry, s: number): { save: SaveState; quest: QuestDef } {
  const quest = generateBoard(reg, createRng(s), 1_000_000 + s).find((q) => boardTemplateOf(q.id) === tpl.id)!;
  const save = newBotSave(reg, 'warrior');
  save.inventory = [];
  expect(acceptQuest(save, quest).ok).toBe(true);
  save.quests.find((q) => q.questId === quest.id)!.status = 'completed';
  return { save, quest };
}

describe('⚠ R13-12: выключенная база — не награда доски', () => {
  it('живой шаблон с вещью в награде есть, и его пул — включённые базы (иначе мерить нечего)', () => {
    expect(tpl).toBeDefined();
    for (const id of pool) expect(live.get('items.base').find((b) => b.id === id)?.enabled, id).not.toBe(false);
  });

  it('⭐ весь пул выключен — доска вещь не обещает, сдача даёт золото и опыт, а вещи нет', () => {
    const reg = basesOff(...pool);
    for (let s = 1; s <= 200; s++) {
      const { save, quest } = doneFromBoard(reg, s);
      expect(quest.reward.itemBaseId, `доска ${s}`).toBeUndefined();
      const gold0 = save.gold;
      expect(turnInQuest(reg, save, quest.id).ok).toBe(true);
      expect(save.gold).toBeGreaterThan(gold0);
      expect(save.inventory.filter((i) => pool.includes(i.baseId)), `сдача ${s}`).toEqual([]);
    }
  });

  it('выключена часть пула — доска даёт только оставшееся, и оно по-прежнему выпадает', () => {
    const [off, ...rest] = pool;
    const reg = basesOff(off!);
    const seen = new Set<string>();
    for (let s = 1; s <= 200; s++) {
      const { save, quest } = doneFromBoard(reg, s);
      expect(quest.reward.itemBaseId, `доска ${s}`).not.toBe(off);
      expect(turnInQuest(reg, save, quest.id).ok).toBe(true);
      expect(save.inventory.some((i) => i.baseId === off), `сдача ${s}`).toBe(false);
      for (const i of save.inventory) seen.add(i.baseId);
    }
    for (const id of rest) expect(seen.has(id), id).toBe(true);
  });

  it('⚠ старая доска: задание, принятое ДО выключения, сдаётся без вещи — и полная сумка его не держит', () => {
    const { save, quest } = doneFromBoard(live, 7);
    const baseId = quest.reward.itemBaseId!;
    expect(pool).toContain(baseId);
    const reg = basesOff(baseId);
    // Сумка забита под завязку: выдавать нечего — значит, и места не нужно.
    const filler = newBotSave(live, 'warrior').equipment.weapon!;
    const dims = live.get('balance').inventory;
    for (let y = 0; y < dims.rows; y++) {
      for (let x = 0; x < dims.cols; x++) save.inventory.push({ ...filler, uid: `f${x}_${y}`, gridW: 1, gridH: 1, pos: { x, y } });
    }
    const gold0 = save.gold;
    const n0 = save.inventory.length;
    expect(turnInQuest(reg, save, quest.id).ok).toBe(true);
    expect(save.gold).toBeGreaterThan(gold0);
    expect(save.inventory).toHaveLength(n0);
    expect(save.inventory.some((i) => i.baseId === baseId)).toBe(false);
  });

  it('включённая база награды выдаётся, как прежде (честная сдача не изменилась)', () => {
    let got = 0;
    for (let s = 1; s <= 50; s++) {
      const { save, quest } = doneFromBoard(live, s);
      expect(pool).toContain(quest.reward.itemBaseId);
      expect(turnInQuest(live, save, quest.id).ok).toBe(true);
      if (save.inventory.some((i) => i.baseId === quest.reward.itemBaseId && i.origin === 'quest')) got++;
    }
    expect(got).toBe(50);
  });
});

describe('⚠ R13-12: уник на выключенной базе не падает', () => {
  const uniques = live.get('uniques').filter((u) => u.enabled !== false);
  const bal = live.get('balance');
  const roll = (reg: ConfigRegistry, seed: number, forceRarity?: 'unique') => generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'), {
    dropBias: 1, itemLevel: 40, tiers: reg.get('item-tiers'), rarities: reg.get('rarities'), categoryWeights: bal.loot.categoryWeights,
    rareNames: reg.get('rare-names'), maxReqTotal: bal.maxTotalRequirement, baseRoll: bal.loot.baseRoll, forceRarity, origin: 'drop',
  }, createRng(seed));

  it('живые уники есть, и их базы включены (иначе мерить нечего)', () => {
    expect(uniques.length).toBeGreaterThan(1);
    for (const u of uniques) expect(live.get('items.base').find((b) => b.id === u.baseId)?.enabled, u.id).not.toBe(false);
  });

  it('⭐ база уника выключена — с тела, из сундука и с прилавка он не выходит, остальные уники падают', () => {
    const off = uniques[1]!.baseId;
    const reg = basesOff(off);
    const seen = new Set<string>();
    for (let s = 1; s <= 3000; s++) {
      const it = roll(reg, s, 'unique');
      expect(reg.get('items.base').find((b) => b.id === it.baseId)?.enabled, `бросок ${s}: ${it.baseId}`).not.toBe(false);
      if (it.rarity === 'unique') seen.add(it.baseId);
    }
    expect(seen.has(off)).toBe(false);
    for (const u of uniques) if (u.baseId !== off) expect(seen.has(u.baseId), u.id).toBe(true);
  });

  it('обычный дроп с весами категорий: 20 000 бросков — ни одной вещи на выключенной базе', () => {
    const off = uniques[1]!.baseId;
    const reg = basesOff(off);
    let u = 0;
    for (let s = 1; s <= 20_000; s++) {
      const it = roll(reg, s);
      expect(it.baseId === off, `бросок ${s}: ${it.rarity}`).toBe(false);
      if (it.rarity === 'unique') u++;
    }
    expect(u).toBeGreaterThan(0);
  });

  it('базы всех уников выключены — выпавший «уник» становится редкой вещью включённой базы', () => {
    const reg = basesOff(...new Set(uniques.map((x) => x.baseId)));
    let rare = 0;
    for (let s = 1; s <= 300; s++) {
      const it = roll(reg, s, 'unique');
      const base = reg.get('items.base').find((b) => b.id === it.baseId);
      expect(base?.enabled, it.baseId).not.toBe(false);
      // Как и при выключенных всех униках: снаряжение — редким, колба (веса категорий её допускают) — обычной.
      expect(it.rarity).toBe(base?.kind === 'consumable' ? 'normal' : 'rare');
      if (it.rarity === 'rare') rare++;
    }
    expect(rare).toBeGreaterThan(0);
  });

  it('живой конфиг: поток бросков не сдвинулся — уник тот же, что давал прежний отбор', () => {
    // Прежний отбор: включённые уники, база — среди всех. На живых данных он совпадает с новым, значит и броски те же.
    const legacy = live.get('uniques').filter((u) => u.enabled !== false);
    for (let s = 1; s <= 300; s++) {
      const it = roll(live, s, 'unique');
      expect(it.rarity).toBe('unique');
      expect(it.baseId).toBe(createRng(s).pick(legacy).baseId);
    }
  });
});

/**
 * ⚠ R14-08: СТАРТОВЫЙ КОМПЛЕКТ — ТОЛЬКО БАЗЫ В ИГРЕ. R13-12 закрыл награды и уники, а новый герой по-прежнему получал оружие класса
 * (`classes.startWeaponId`) и четыре кожаные вещи по id, не глядя на галку базы: выключи хозяин ручной топор или кожаный пояс —
 * каждый новый герой нёс их как настоящие вещи, кузнец их поднимал, а после подъёма они продавались и разбирались (в журнал —
 * выключенная база). Теперь выключенная кожаная вещь не выдаётся, а оружие заменяет включённая база той же семьи и хвата.
 */
describe('⚠ R14-08: выключенная база — не стартовый комплект', () => {
  const classes = live.get('classes').filter((c) => c.enabled !== false);
  const STARTER = ['leather-cap', 'leather-armor', 'leather-boots', 'leather-belt'];
  const kitOf = (s: SaveState): Item[] => [...Object.values(s.equipment).filter((i): i is Item => !!i), ...s.inventory];
  const baseOf = (reg: ConfigRegistry, id: string) => reg.get('items.base').find((b) => b.id === id);

  it('⭐ выключены пояс и оружие каждого класса — у нового героя (и у бота прогона) ни одной выключенной базы, оружие той же семьи', () => {
    expect(classes.length).toBeGreaterThan(1);
    const reg = basesOff('leather-belt', ...new Set(classes.map((c) => c.startWeaponId)));
    for (const cls of classes) {
      const save = newCharacterSave(reg, cls.id, 'Альт', `r14-08-${cls.id}`);
      for (const it of kitOf(save)) expect(baseOf(reg, it.baseId)?.enabled, `${cls.id}: ${it.baseId}`).not.toBe(false);
      expect(kitOf(save).map((i) => i.baseId).sort(), cls.id).toEqual(STARTER.filter((id) => id !== 'leather-belt').concat(save.equipment.weapon!.baseId).sort());
      const was = baseOf(live, cls.startWeaponId)!;
      const w = save.equipment.weapon!;
      if (was.kind !== 'weapon' || w.kind !== 'weapon') throw new Error(`${cls.id}: не оружие`);
      expect(w.baseId, cls.id).not.toBe(cls.startWeaponId);
      expect(w.weaponClass, cls.id).toBe(was.weaponClass);
      expect(w.hands ?? 1, cls.id).toBe(was.hands ?? 1);
      expect(w.origin, cls.id).toBe('start');
      expect(saveStateSchema.safeParse(save).success, cls.id).toBe(true);
      // Кузнец поднимал выключенную базу — теперь в комплекте её нет вовсе, а замена — обычная стартовая вещь.
      for (const slot of Object.keys(save.equipment)) expect(unequip(reg, save, slot).ok).toBe(true);
      for (const it of save.inventory) expect(baseOf(reg, it.baseId)?.enabled, `${cls.id}: ${it.baseId}`).not.toBe(false);
      const bot = newBotSave(reg, cls.id);
      expect(bot.equipment.weapon?.baseId, `бот ${cls.id}`).toBe(w.baseId);
    }
  });

  it('вся семья оружия класса выключена — герой без оружия, а не с выключенной базой (сейв валиден)', () => {
    const cls = classes[0]!;
    const was = baseOf(live, cls.startWeaponId)!;
    if (was.kind !== 'weapon') throw new Error('не оружие');
    const family = live.get('items.base').filter((b) => b.kind === 'weapon' && b.weaponClass === was.weaponClass && (b.hands ?? 1) === (was.hands ?? 1));
    const reg = basesOff(...family.map((b) => b.id));
    const save = newCharacterSave(reg, cls.id, 'Альт', 'r14-08-none');
    expect(save.equipment.weapon).toBeUndefined();
    for (const it of kitOf(save)) expect(baseOf(reg, it.baseId)?.enabled, it.baseId).not.toBe(false);
    expect(kitOf(save).map((i) => i.baseId).sort()).toEqual([...STARTER].sort());
    expect(saveStateSchema.safeParse(save).success).toBe(true);
    expect(newBotSave(reg, cls.id).equipment.weapon).toBeUndefined();
  });

  it('живой конфиг: комплект прежний — оружие класса надето, четыре кожаные вещи, всё `start`', () => {
    for (const cls of classes) {
      const save = newCharacterSave(live, cls.id, 'Альт', `r14-08-live-${cls.id}`);
      expect(save.equipment.weapon?.baseId, cls.id).toBe(cls.startWeaponId);
      expect(kitOf(save).map((i) => i.baseId).sort(), cls.id).toEqual([cls.startWeaponId, ...STARTER].sort());
      for (const it of kitOf(save)) expect(it.origin).toBe('start');
      expect(newBotSave(live, cls.id).equipment.weapon?.baseId, `бот ${cls.id}`).toBe(cls.startWeaponId);
    }
  });

  it('живые данные: оружие каждого класса и кожаный комплект — включённые базы (сторож файлов данных)', () => {
    for (const c of live.get('classes')) expect(baseOf(live, c.startWeaponId)?.enabled, `${c.id}: ${c.startWeaponId}`).toBe(true);
    for (const id of STARTER) expect(baseOf(live, id)?.enabled, id).toBe(true);
  });
});

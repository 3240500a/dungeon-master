import type { ConfigRegistry } from '../config/registry.js';
import { baseInGame, itemFromBaseId } from '../formulas/itemgen.js';
import { shapeFoundWeapon, tierIndex } from '../formulas/craft.js';
import { packInventory } from '../inventory/grid.js';
import { SAVE_VERSION, type SaveState } from '../types/save.js';
import type { Attribute, Attributes } from '../types/attributes.js';
import type { Item } from '../types/items.js';

/** Базовая броня любого нового персонажа (поверх оружия класса). */
const STARTER_ARMOR = ['leather-cap', 'leather-armor', 'leather-boots', 'leather-belt'];

/**
 * ⚠ V-B2-02: ВЕЩЬ КОМПЛЕКТА — ПО РУКЕ СВОЕМУ КЛАССУ. Правило R4-08 «требования держатся всё время ношения» комплект нарушал с
 * первой секунды: требования ступени t0 (`items.base`, лестница весов) и стартовые атрибуты (`classes.startAttributes`) правятся
 * порознь, и пять классов из семи выходили в оружии, которое сами надеть не могут (Ловчая — короткий лук на 29 Ловкости при
 * 17, Вольный стрелок — арбалет 14/26 при 12/15). Бой брал его в полную силу, а снятое обратно не надевалось: герой без оружия
 * до второго–четвёртого уровня. Совпадения двух таблиц не держит ни одна проверка (правка хозяина живьём, замена выключенной
 * базы родственной — `startWeaponBaseId`), поэтому держит выдача: каждое требование вещи комплекта — не выше стартового
 * атрибута её класса. База, ступень, статы, детали — прежние, у вещи, которую класс и так держал, не меняется ни байта.
 * Скидка живёт только на НЕТРОНУТОЙ вещи комплекта (обычная, ступень — как у находки той же базы): подъём у кузнеца пересобирает
 * требования от базы (`retierItem`), зачаровать (только скованное) и разобрать комплект нельзя, лавка берёт его за 1 (R3-04) —
 * сильнее она не становится ни в чьих руках, в том числе у другого героя аккаунта через сундук.
 */
export function fitToClass(item: Item, start: Attributes): Item {
  // Требование — целое (как у любой вещи), и не выше атрибута: дробный атрибут из редактора округляется вниз.
  const cap = (a: string): number => { const v = start[a as Attribute]; return Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0; };
  if (!Object.entries(item.requirements).some(([a, v]) => v !== undefined && v > cap(a))) return item;
  const requirements: Item['requirements'] = {};
  for (const [a, v] of Object.entries(item.requirements)) {
    if (v === undefined) continue;
    const n = Math.min(v, cap(a));
    if (n > 0) requirements[a as Attribute] = n;
  }
  return { ...item, requirements };
}

/**
 * Вещь стартового комплекта класса `cls` по id базы: как найденная (§12.1, §26 — детали записаны на вещь, клинок с геометрией
 * несёт свои статы), происхождение `start` (R3-04), требования — по руке классу (`fitToClass`, V-B2-02). `null` — базы нет.
 * Одна сборка на героя игры (`newCharacterSave`) и бота прогона баланса (`newBotSave`).
 */
export function starterItem(reg: ConfigRegistry, cls: { startAttributes: Attributes }, baseId: string): Item | null {
  const raw = itemFromBaseId(reg.get('items.base'), baseId, reg.get('item-tiers'), 'start');
  // Броню `shapeFoundWeapon` не трогает.
  return raw ? fitToClass(shapeFoundWeapon(reg, raw), cls.startAttributes) : null;
}

/**
 * ⚠ R14-08: ОРУЖИЕ НОВОГО ГЕРОЯ — БАЗА В ИГРЕ (`baseInGame`). `classes.startWeaponId` — голый id, и выключенную в редакторе базу
 * герой получал как настоящую вещь: кузнец её поднимал, поднятую лавка покупала, а разбор писал её в журнал. Выключена — берётся
 * включённая база той же семьи, хвата и слота: ниже ступенью, затем легче по требованиям (новому герою её держать), затем по
 * порядку конфига. Нет такой (или базы нет в конфиге вовсе) — герой без оружия, как и прежде при неизвестном id.
 * Одна истина — игре (`newCharacterSave`) и боту прогона баланса (`newBotSave`).
 */
export function startWeaponBaseId(reg: ConfigRegistry, cls: { startWeaponId: string }): string | undefined {
  const bases = reg.get('items.base');
  const inGame = baseInGame(bases);
  if (inGame(cls.startWeaponId)) return cls.startWeaponId;
  const was = bases.find((b) => b.id === cls.startWeaponId);
  if (!was || was.kind !== 'weapon') return undefined;
  const reqSum = (b: { requirements: Record<string, number | undefined> }): number => Object.values(b.requirements).reduce<number>((s, v) => s + (v ?? 0), 0);
  const kin = bases.filter((b): b is typeof was => b.kind === 'weapon' && inGame(b.id)
    && b.weaponClass === was.weaponClass && (b.hands ?? 1) === (was.hands ?? 1) && b.slot === was.slot);
  kin.sort((a, b) => Math.max(0, tierIndex(reg, a.minTier)) - Math.max(0, tierIndex(reg, b.minTier)) || reqSum(a) - reqSum(b));
  return kin[0]?.id;
}

/**
 * АВТОРИТЕТНЫЙ стартовый сейв нового персонажа из конфига (класс → атрибуты + стартовый
 * набор оружие+броня). ЕДИНАЯ истина создания персонажа: СЕРВЕР строит по нему состояние,
 * когда в БД ещё нет записи по `charId` (клиент не может «нафабриковать» золото/статы/
 * предметы — они игнорируются). Тот же билдер зовёт клиент для локального ростера.
 */
export function newCharacterSave(reg: ConfigRegistry, classId: string, name: string, charId: string): SaveState {
  const classes = reg.get('classes');
  // Точный класс по id; фолбэк на первый ВКЛЮЧЁННЫЙ (а не на выключенный [0]), иначе на первый вообще.
  const cls = classes.find((c) => c.id === classId) ?? classes.find((c) => c.enabled !== false) ?? classes[0]!;
  const equipment: SaveState['equipment'] = {};
  const inventory: Item[] = [];
  // ⚠ R14-08: только базы в игре — выключенная кожаная вещь не выдаётся, оружие класса заменяет родственное (`startWeaponBaseId`).
  const inGame = baseInGame(reg.get('items.base'));
  const weaponId = startWeaponBaseId(reg, cls);
  for (const id of [...(weaponId ? [weaponId] : []), ...STARTER_ARMOR.filter(inGame)]) {
    // Стартовый меч — как найденный (§12.1, §26): детали записаны на вещь, клинок с геометрией несёт свои
    // статы — карточка и бой видят то же, что у находки той же базы. Броню не трогает.
    // ⚠ R3-04: комплект бесплатен и бесконечен (создал → переложил → удалил), поэтому `origin: 'start'` лавка берёт
    // за 1, а кузнец не разбирает вовсе (`shopSellPrice`, `salvagePlan`).
    // ⚠ V-B2-02: надетое держится на стартовых атрибутах — требования вещи по руке классу (`starterItem` → `fitToClass`).
    const item = starterItem(reg, cls, id);
    if (!item) continue;
    if (item.slot && !equipment[item.slot]) { item.pos = null; equipment[item.slot] = item; }
    else inventory.push(item);
  }
  packInventory(inventory, reg.get('balance').inventory);
  return {
    version: SAVE_VERSION,
    name: name.trim() || 'Герой',
    charId,
    createdAt: Date.now(),
    classId: cls.id,
    level: 1, xp: 0, gold: 0,
    attributes: { ...cls.startAttributes },
    // ⚠ R18-07: старт, с которым создан, — сброс атрибутов меряет вложенное от него, а не от нынешней строки класса.
    startAttributes: { ...cls.startAttributes },
    // ⭐ D2: книга заработанного — с нуля; дальше её пишет только выдача (`gainXp`, награда задания).
    earned: { attributePoints: 0, skillPoints: 0, masteryPoints: 0 },
    unspentAttributePoints: 0, unspentSkillPoints: 0, unspentMasteryPoints: 0,
    skills: {}, masteries: {},
    equipment, inventory, stash: [], belt: [],
    mouseLeft: 'attack', mouseRight: null,
    hotbar: [null, null, null],
    quests: [], activeQuestDefs: [], maxDepth: 0,
    difficultyProgress: {}, lastDifficulty: 'normal',
  };
}

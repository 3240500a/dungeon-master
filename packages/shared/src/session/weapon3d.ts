import type { ConfigRegistry } from '../config/registry.js';
import type { CraftParts, Item } from '../types/items.js';
import { MATERIAL_STEPS, partsOf } from '../formulas/craft.js';
import { CRAFT_SLOT_LIST } from '../formulas/craftType.js';
import type { WeaponLook, WeaponLookHand } from './netTypes.js';

/** Структурный минимум для маппинга 3D-ключа: подходит и игроцкий Item, и гир монстра (GearWeapon/GearShield). */
type Weaponish = { weaponClass?: string; hands?: number; kind?: string; versatile?: boolean };

/** Ключ одноручного оружия по weaponClass (для офф-руки: дуал). null — не одноручное/неизвестно. */
function oneHandKey(weaponClass: string | undefined): string | null {
  switch (weaponClass) {
    case 'sword': return 'sword'; case 'axe': return 'axe'; case 'mace': return 'mace';
    case 'dagger': return 'dagger'; case 'spear': return 'spear'; case 'wand': case 'staff': return 'staff';
    default: return null;
  }
}

/**
 * 3D-ключ оружия из ЭКИПИРОВКИ (для сетевого снапшота и рендера): слот weapon → база (по weaponClass/hands);
 * одноручное + офф-рука → `база+shield` ИЛИ `база+второе` (дуал). Нет/неизвестное оружие → `null`
 * (вызывающий подставит класс-дефолт). Чистая функция — единый источник маппинга для сервера (снапшот)
 * и клиента (рендер 3D).
 */
export function weapon3dKeyFromEquipment(weapon: Weaponish | undefined, offhand: Weaponish | undefined): string | null {
  // ⭐⭐ ГЛАВНАЯ РУКА ПУСТА, А ОФФ-РУКА ЗАНЯТА — это `none+<предмет>`, а НЕ «оружия нет».
  //
  // Жалоба: «в игре снимаешь оружие — щит тоже пропадает с модели». Именно отсюда: функция
  // возвращала `null` («ключа нет»), клиент подставлял КЛАСС-ДЕФОЛТ, и получалось оружие, которого
  // на игроке нет, и щит, который на нём есть, — оба мимо. Удар при этом честно уходит в безоружный:
  // `weaponChain('none+shield')` даёт `none`, то есть бьём правой рукой и без ничего.
  if (!weapon) {
    if (offhand?.kind === 'shield') return 'none+shield';
    if (offhand?.kind === 'weapon' && (offhand.hands ?? 1) < 2) { const ob = oneHandKey(offhand.weaponClass); if (ob) return 'none+' + ob; }
    return null;
  }
  // ⚠ Ключ анимации — по ФАКТИЧЕСКОМУ хвату: полуторное со щитом держат одной рукой, и набор
  // двуручных взмахов на нём смотрелся бы ложью.
  const two = (weapon.hands ?? 1) >= 2 && !(weapon.versatile && offhand);
  let base: string;
  switch (weapon.weaponClass) {
    case 'sword': base = two ? 'greatsword' : 'sword'; break;
    case 'axe': base = two ? 'greataxe' : 'axe'; break;
    case 'mace': base = two ? 'greatmaul' : 'mace'; break;
    case 'dagger': base = 'dagger'; break;
    case 'spear': base = 'spear'; break;
    case 'halberd': base = 'halberd'; break;
    case 'bow': base = 'bow'; break;
    case 'crossbow': base = 'crossbow'; break;
    case 'wand': case 'staff': base = 'staff'; break;
    default: return null;   // нет/неизвестный класс — клиент подставит класс-дефолт
  }
  if (!two && !base.includes('+')) {   // одноручное → показать офф-руку
    if (offhand?.kind === 'shield') base += '+shield';                                                   // щит
    else if (offhand?.kind === 'weapon' && (offhand.hands ?? 1) < 2) { const ob = oneHandKey(offhand.weaponClass); if (ob) base += '+' + ob; }   // дуал (второе одноручное)
  }
  return base;
}

// ── Вид оружия из деталей (D22, К6) ──────────────────────────────────────────────────────────────

/** Потолок длины id в виде оружия. Реальные id — до 22 символов; длиннее — вещь битая, руку не шлём. */
const LOOK_ID_MAX = 64;

/**
 * Детали СТАРЫХ вещей (без `parts` и `foundParts`) выводятся перебором 625 четвёрок ступеней — это
 * миллисекунды на вещь. `peerInfo` рассылается после КАЖДОЙ успешной команды города, а команды идут до
 * 80 в секунду с соединения: без памяти любой игрок со старым мечом в руках грел бы процесс перебором
 * на каждого игрока комнаты. Поэтому вывод запоминается по всему, от чего он зависит: по вещи (ключ) и по
 * конфигу (таблицы сравниваются по ссылке — `reload` их заменяет, и память тогда сбрасывается целиком).
 * Память одна на процесс (реестр у комнат общий): 4096 записей — с запасом на 1000 игроков по две руки
 * (≈ 2 МБ); меньший потолок на полном сервере сбрасывался бы по кругу и возвращал перебор на каждую рассылку.
 * Новых «старых» вещей не бывает — любое найденное оружие рождается с `foundParts` (D17).
 */
const DERIVED_KEEP = 4096;
const DERIVED_DEPS = ['items.base', 'item-tiers', 'balance', 'weapon-parts', 'weapon-anatomy', 'weapon-types'] as const;
const derivedMemo = new WeakMap<ConfigRegistry, { deps: unknown[]; map: Map<string, CraftParts | null> }>();

function lookParts(reg: ConfigRegistry, item: Item): CraftParts | null {
  if (item.parts) return item.parts;
  if (item.foundParts) return item.foundParts;
  const deps = DERIVED_DEPS.map((k) => reg.get(k) as unknown);
  let memo = derivedMemo.get(reg);
  if (!memo || memo.deps.some((d, i) => d !== deps[i])) { memo = { deps, map: new Map() }; derivedMemo.set(reg, memo); }
  // Всё, что читает вывод: uid и база (сид), ступень — записанная или угаданная по статам с броском и формой.
  const key = `${item.uid}|${item.baseId}|${item.tier ?? ''}|${item.itemLevel}|${item.spreadMult ?? ''}|${JSON.stringify(item.baseRoll ?? null)}|${JSON.stringify(item.baseStats ?? null)}`;
  const hit = memo.map.get(key);
  if (hit !== undefined) return hit;
  const parts = partsOf(reg, item);
  if (memo.map.size >= DERIVED_KEEP) memo.map.clear();
  memo.map.set(key, parts);
  return parts;
}

/**
 * Одна рука вида: база + четыре детали, СОБРАННЫЕ ЗАНОВО из id и ступени. Из предмета наружу не уходит
 * больше ничего — ни лишний ключ детали, ни статы; битая запись (не строка, ступень вне 1…5, id-простыня)
 * руку просто не даёт, и клиент рисует процедурный меш. Уникальные — без вида: они собраны руками, деталей
 * у них нет (разбор их не принимает, `shapeFoundWeapon` не трогает).
 */
function lookHand(reg: ConfigRegistry, item: Item | undefined): WeaponLookHand | undefined {
  if (!item || item.kind !== 'weapon' || item.rarity === 'unique') return undefined;
  if (typeof item.baseId !== 'string' || !item.baseId || item.baseId.length > LOOK_ID_MAX) return undefined;
  const parts = lookParts(reg, item);
  if (!parts || typeof parts !== 'object') return undefined;
  const out = {} as CraftParts;
  for (const slot of CRAFT_SLOT_LIST) {
    const p = (parts as Partial<CraftParts>)[slot];
    if (!p || typeof p.id !== 'string' || !p.id || p.id.length > LOOK_ID_MAX) return undefined;
    if (!Number.isInteger(p.step) || p.step < 1 || p.step > MATERIAL_STEPS) return undefined;
    out[slot] = { id: p.id, step: p.step };
  }
  return { baseId: item.baseId, parts: out };
}

/**
 * ⭐ ВИД ОРУЖИЯ В РУКАХ ИЗ ЭКИПИРОВКИ (D22) — один на сервер (кадр `peerInfo` для всех) и клиент (своя кукла
 * из сейва): «себя и других рисуем одним путём». Детали — `partsOf`: у скованной записанные, у найденной
 * замороженные при рождении, у старой — выведенные.
 *
 * Руки — СТРОГО те, что рисует `weapon3dKeyFromEquipment`: вторая только если ключ её показывает (дуал), и
 * никакой, если ключа нет (клиент подставит класс-дефолт — чужие детали на нём были бы ложью).
 *
 * ⚠ Никогда не бросает: зовётся на входе игрока и после каждой команды — сбой здесь сорвал бы вход или
 * рассылку статики. Любая ошибка → рука без вида (процедурный меш), не больше.
 */
export function weaponLookOf(reg: ConfigRegistry, weapon: Item | undefined, offhand: Item | undefined): WeaponLook | undefined {
  try {
    const key = weapon3dKeyFromEquipment(weapon, offhand);
    if (!key) return undefined;
    const plus = key.lastIndexOf('+');
    const mainShown = !!weapon && !key.startsWith('none');
    const offShown = plus > 0 && key.slice(plus + 1) !== 'shield';
    const main = mainShown ? lookHand(reg, weapon) : undefined;
    const off = offShown ? lookHand(reg, offhand) : undefined;
    if (!main && !off) return undefined;
    const out: WeaponLook = {};
    if (main) out.main = main;
    if (off) out.off = off;
    return out;
  } catch {
    return undefined;
  }
}

/**
 * Подпись руки — по ней кукла решает «пересобрать модель или нет» и по ней же клиент кэширует меш. Только
 * база и детали по гнёздам в ФИКСИРОВАННОМ порядке (порядок ключей в JSON не важен). Нет вида — ''.
 * Зовётся и на данных с провода (кукла пира), поэтому битая рука даёт подпись, а не исключение.
 */
export function weaponLookSig(hand: WeaponLookHand | undefined): string {
  if (!hand || typeof hand !== 'object') return '';
  const parts = (hand.parts && typeof hand.parts === 'object' ? hand.parts : {}) as Partial<CraftParts>;
  return `${String(hand.baseId)}|${CRAFT_SLOT_LIST.map((s) => `${String(parts[s]?.id ?? '')}:${String(parts[s]?.step ?? '')}`).join('|')}`;
}

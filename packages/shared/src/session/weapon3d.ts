import type { Item } from '../types/items.js';

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
export function weapon3dKeyFromEquipment(weapon: Item | undefined, offhand: Item | undefined): string | null {
  if (!weapon) return null;
  const two = (weapon.hands ?? 1) >= 2;
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

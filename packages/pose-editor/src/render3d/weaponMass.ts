/**
 * ⭐ МАССЫ ОРУЖИЯ И РУК — ЧИСТАЯ ТАБЛИЦА, БЕЗ THREE И БЕЗ DOM.
 *
 * Вынесено из `humanoidRagdoll` по одной причине: тот модуль тянет сцену и `document`, и в
 * node-vitest не грузится вовсе — значит покрыть сторожем «пустая рука ничего не весит» было нечем.
 * Логика здесь целиком строковая, ей физика не нужна.
 */
export const WEAPON_MASS: Record<string, number> = {
  sword: 6, dagger: 3, axe: 12, mace: 13, staff: 5, spear: 8, greatsword: 15, greataxe: 20, greatmaul: 24,
  halberd: 16, bow: 4, crossbow: 9, shield: 11,
};
/** Масса рук [правая, левая] по ключу оружия main(+off). Обобщённо: главное → правая, офф (щит/оружие) → левая. */
export function weaponHandMasses(weapon: string): [number, number] {
  if (weapon === 'dual') weapon = 'sword+dagger';
  if (!weapon || weapon === 'none') return [0, 0];
  if (weapon === 'bow') return [0, WEAPON_MASS.bow!];            // лук в левой руке
  if (weapon === 'crossbow') return [WEAPON_MASS.crossbow!, 0];  // арбалет в правой (меш там же)
  if (weapon === 'shield') return [0, WEAPON_MASS.shield!];      // одинокий щит — левая
  const i = weapon.lastIndexOf('+');
  if (i > 0) {
    const m = weapon.slice(0, i), o = weapon.slice(i + 1);
    // ⚠ Пустая рука не весит НИЧЕГО. Раньше `none` не находился в таблице и получал дефолтные 6 —
    // то есть при щите без оружия правая рука тянулась вниз фантомным грузом.
    return [m === 'none' ? 0 : WEAPON_MASS[m] ?? 6, o === 'none' ? 0 : WEAPON_MASS[o] ?? 6];
  }
  return [WEAPON_MASS[weapon] ?? 6, 0];
}

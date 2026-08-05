import type { ConfigShapes } from '../config/schemas.js';

/**
 * Авто-заполнение требований предмета ПО ВЕСУ (только для кнопки «Заполнить по весу» в редакторе —
 * НЕ влияет на игру напрямую; живое требование = `base.requirements`×тир, кап `maxTotalRequirement`).
 * Оружие: В КАКОЙ атрибут — доли Сила/Ловк/Инт из `weapon-weights` (те же, что скейлят урон), СКОЛЬКО —
 * `weapon-weights.reqBase` (магнитуда 1H, крутится в конфиге) ×`twoHandMult` для 2H. Броня:
 * `armor-classes.reqBase`×слот, доли `reqStr/reqDex` (всё крутится в конфиге). Щиты — по классу.
 */
type WeaponWeights = ConfigShapes['weapon-weights'];
type ArmorClasses = ConfigShapes['armor-classes'];
type Req = Partial<Record<'strength' | 'dexterity' | 'intelligence', number>>;

/** Дефолт множителя требования для двуручного оружия (если не передан из `balance.twoHandReqMult`). */
export const TWO_HAND_REQ_MULT = 1.6;
/** Доля магнитуды требования брони по слоту (грудь = 1.0 — эталон). */
const SLOT_MULT: Record<string, number> = { chest: 1, helm: 0.8, gloves: 0.75, boots: 0.75, belt: 0.7 };
/** Требования щитов по классу (лёгкий = ловк, средний = сила+ловк, тяжёлый = сила). */
const SHIELD_REQ: Record<string, Req> = { light: { dexterity: 12 }, medium: { strength: 6, dexterity: 6 }, heavy: { strength: 24 } };

const clean = (o: Req): Req => {
  const r: Req = {};
  for (const k of ['strength', 'dexterity', 'intelligence'] as const) { const v = Math.round(o[k] ?? 0); if (v > 0) r[k] = v; }
  return r;
};

/** Базовые требования предмета по схеме веса/класса (для авто-заполнения). Пусто — если веса/класса нет в конфиге. */
export function schemeRequirements(
  base: { kind: string; weight?: string; hands?: number; armorClass?: string; slot?: string; shieldClass?: string },
  weaponWeights: WeaponWeights,
  armorClasses: ArmorClasses,
  twoHandMult: number = TWO_HAND_REQ_MULT,
): Req {
  if (base.kind === 'weapon') {
    const w = weaponWeights.find((x) => x.id === base.weight);
    if (!w) return {};
    const m = w.reqBase * (base.hands === 2 ? twoHandMult : 1); // магнитуда «сколько» из конфига веса
    return clean({ strength: m * w.strength, dexterity: m * w.dexterity, intelligence: m * w.intelligence });
  }
  if (base.kind === 'armor') {
    const a = armorClasses.find((x) => x.id === base.armorClass);
    if (!a || !a.reqBase) return {};
    const m = a.reqBase * (SLOT_MULT[base.slot ?? ''] ?? 0.8);
    return clean({ strength: m * a.reqStr, dexterity: m * a.reqDex });
  }
  if (base.kind === 'shield') return clean(SHIELD_REQ[base.shieldClass ?? ''] ?? {});
  return {};
}

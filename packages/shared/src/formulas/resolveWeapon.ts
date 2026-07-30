import type { DebuffApply, DebuffKind } from '../world/debuffs.js';
import type { Item, WeaponWeight } from '../types/items.js';
import { packetTotal, type DamagePacket, type DamageType } from '../types/combat.js';
import type { ConfigShapes } from '../config/schemas.js';

/** Физ-статусы (подтип оружия): держатся только если в ударе есть физ. урон (гаснут при полной конверсии в стихию). */
const PHYS_DEBUFF_KINDS = new Set<DebuffKind>(['wound', 'bleed', 'sunder', 'daze']);

type PhysSubtypes = ConfigShapes['phys-subtypes'];
type WeaponWeights = ConfigShapes['weapon-weights'];
type MagicSubtypes = ConfigShapes['magic-subtypes'];

/**
 * Вывод боевых свойств оружия из осей (вес/подтип урона). Таблицы весов
 * (`weapon-weights`: power/finesse/доли Сила-Ловк) и подтипов (`phys-subtypes`)
 * — data-driven, правятся в редакторе. Чистые функции — общие для игры/сима/сервера.
 */

function weightOf(weights: WeaponWeights, id: WeaponWeight | undefined): WeaponWeights[number] | undefined {
  return id ? weights.find((w) => w.id === id) : undefined;
}

/** Доли скейла урона по весу: сколько от Силы / Ловкости / Интеллекта (magical-вес = Инт). */
export function weightScaleSplit(weight: WeaponWeight, weights: WeaponWeights): { strength: number; dexterity: number; intelligence: number } {
  const w = weightOf(weights, weight);
  return w ? { strength: w.strength, dexterity: w.dexterity, intelligence: w.intelligence } : { strength: 1, dexterity: 0, intelligence: 0 };
}

/**
 * Стаковые дебаффы удара оружием (по подтипу физ. урона). База шанса/силы/длительности ВШИТА в подтип
 * (`phys-subtypes`, блок `weapon`), БЕЗ веса-множителей — скейлинг статусов идёт от скиллов (ailment-статы).
 * `magPerDamage` (DoT: кровотечение) — доля от урона удара, добавляется к силе при наложении.
 */
export function weaponDebuffs(item: Item, physSubs: PhysSubtypes): DebuffApply[] {
  if (!item.physSub) return [];
  const sub = physSubs.find((s) => s.id === item.physSub);
  if (!sub) return [];
  const w = sub.weapon;
  const out: DebuffApply = { kind: sub.kind, chance: Math.min(1, w.chance), maxStacks: w.maxStacks, durationMs: w.durationMs, mag: w.mag };
  if (w.mag2 != null) out.mag2 = w.mag2;
  if (w.magPerDamage != null) out.magPerDamage = w.magPerDamage;
  return [out];
}

/**
 * Стих. статусы удара: для КАЖДОГО маг. подтипа (стихии) в пакете с ненулевой долей —
 * с шансом наложить его статус (огонь→поджиг, холод→заморозка, молния→шок, яд→отравление).
 * Шанс/длит./сила ВШИТЫ в подтип (`magic-subtypes`, блок `weapon`); DoT (поджиг/яд) — `magPerDamage`
 * (доля от урона удара/сек), freeze/shock — `mag`/`mag2` флэт. Скейлинг статусов — от ailment-статов игрока.
 * Данные-driven: правится в редакторе; тот же источник читает игра/сим/сервер.
 */
export function elementDebuffs(packet: DamagePacket, magicSubtypes: MagicSubtypes): DebuffApply[] {
  const out: DebuffApply[] = [];
  for (const sub of magicSubtypes) {
    if ((packet[sub.id] ?? 0) <= 0) continue;                // этого подтипа нет в ударе
    const w = sub.weapon;
    const a: DebuffApply = { kind: sub.ailment, chance: Math.min(1, w.chance), maxStacks: w.maxStacks, durationMs: w.durationMs, mag: w.mag };
    if (w.mag2 != null) a.mag2 = w.mag2;
    if (w.magPerDamage != null) a.magPerDamage = w.magPerDamage;
    out.push(a);
  }
  return out;
}

export interface SkillDamageShape {
  /** Множитель урона (damageMult × ранг). */
  mult: number;
  /** К чему применять множитель: `base` — только базовый тип оружия (стихии гира не раздуваются), `all` — весь пакет. */
  multScope: 'base' | 'all';
  /** Добавить эту долю базового (пост-множитель) урона как стихию `element`. */
  addElementPct: number;
  /** Слить эту долю всего урона в стихию `element` (0..1). */
  convertPct: number;
  /** Базовый тип урона оружия (обычно физический; у жезла — стихия). */
  baseType: DamageType;
  /** Стихия скилла — цель добавки/конверсии. */
  element: DamageType;
}

/**
 * Форма урона скилла (мутирует пакет): множитель по scope → добавка стихии (addElementPct доли базового урона →
 * element) → конверсия (convertPct доли всего урона → element). Задаёт 3 режима: обычный удар (multScope=base),
 * «всё в стихию» (convertPct=1), «добавить стихию сверху» (addElementPct>0). Чистая — общий шаг attack/cast.
 */
export function shapeSkillPacket(packet: DamagePacket, s: SkillDamageShape): void {
  if (s.multScope === 'all') { for (const t of Object.keys(packet) as DamageType[]) packet[t] *= s.mult; }
  else packet[s.baseType] *= s.mult;
  if (s.addElementPct > 0) packet[s.element] += packet[s.baseType] * s.addElementPct;
  if (s.convertPct > 0) {
    const converted = packetTotal(packet) * s.convertPct;
    for (const t of Object.keys(packet) as DamageType[]) packet[t] *= (1 - s.convertPct);
    packet[s.element] += converted;
  }
}

/**
 * Итоговый onHit по СОСТАВУ пакета: физ-статусы подтипа (`baseOnHit`) держатся лишь при наличии физ. урона
 * (при полной конверсии в стихию — гаснут), плюс авто стих-проки по стихиям в ударе (дедуп по виду —
 * присутствующий в базе вид не задваивается). Чистая: общий шаг для базовой атаки и скиллов.
 */
export function mergeElementOnHit(baseOnHit: DebuffApply[], packet: DamagePacket, magicSubtypes: MagicSubtypes): DebuffApply[] {
  const kept = (packet.physical ?? 0) > 0 ? baseOnHit : baseOnHit.filter((d) => !PHYS_DEBUFF_KINDS.has(d.kind));
  const have = new Set<DebuffKind>(kept.map((d) => d.kind));
  return [...kept, ...elementDebuffs(packet, magicSubtypes).filter((d) => !have.has(d.kind))];
}

import type { StatModifier } from '../types/attributes.js';
import type { Item } from '../types/items.js';
import type { DebuffKind } from '../world/debuffs.js';
import type { ConfigShapes } from '../config/schemas.js';

/**
 * Класс брони → штрафы подвижности + шум (стелс) + выдержка к физ-статусам.
 * Таблица data-driven (конфиг `armor-classes`) — правится в редакторе, никакого
 * хардкода. Чистые функции, общие для игры/сима/сервера.
 */

type ArmorClasses = ConfigShapes['armor-classes'];
type ArmorClassDef = ArmorClasses[number];

/** Ищет описание класса брони по id (или undefined). */
function classOf(classes: ArmorClasses, id: string | undefined): ArmorClassDef | undefined {
  return id ? classes.find((c) => c.id === id) : undefined;
}

/** Суммарные модификаторы от классов надетой брони (штрафы бега/атаки/уворота). */
export function armorClassModifiers(items: Pick<Item, 'armorClass'>[], classes: ArmorClasses): StatModifier[] {
  let move = 0, atk = 0, evade = 0;
  for (const it of items) {
    const p = classOf(classes, it.armorClass);
    if (p) { move += p.move; atk += p.atk; evade += p.evade; }
  }
  move = Math.max(-0.45, move);
  atk = Math.max(-0.40, atk);
  const mods: StatModifier[] = [];
  if (move) mods.push({ stat: 'moveSpeed', kind: 'increased', value: move });
  if (atk) mods.push({ stat: 'attackSpeed', kind: 'increased', value: atk });
  if (evade) mods.push({ stat: 'evade', kind: 'increased', value: evade });
  return mods;
}

/** «Громкость» игрока для слуха монстров: 1 + Σ(шум частей), кламп [0.6, 1.8]. */
export function armorNoise(items: Pick<Item, 'armorClass'>[], classes: ArmorClasses): number {
  let n = 1;
  for (const it of items) { const p = classOf(classes, it.armorClass); if (p) n += p.noise; }
  return Math.max(0.6, Math.min(1.8, n));
}

/**
 * Выдержка: суммарное снижение шанса И длительности дебаффа `kind` на игроке от
 * надетой брони (каждый класс лучше держит свой тип). Кап 60%. Только для ФИЗИЧЕСКИХ
 * статусов (рана/кровот./увечье/ошеломл.) — стихийные держатся сопротивлениями.
 */
export function armorPoise(items: Pick<Item, 'armorClass'>[], kind: DebuffKind, classes: ArmorClasses): number {
  let p = 0;
  for (const it of items) {
    const cls = classOf(classes, it.armorClass);
    if (cls) p += (cls.poise as Record<string, number>)[kind] ?? 0;
  }
  return Math.min(0.6, p);
}

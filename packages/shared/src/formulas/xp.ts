/**
 * Уровень, соответствующий накопленному опыту, по таблице balance.xpTable.
 * ⚠ R20-05: по ступеньке кривой (порог не выше прежнего, минус, NaN) не лезет — негодную кривую отвергает схема, это вторая линия:
 * кривая, прошедшая мимо схемы, подняла бы героя одним очком опыта через весь участок. На годной (строго растущей) — то же, что прежде.
 */
export function levelForXp(totalXp: number, xpTable: number[]): number {
  let level = 1;
  for (let i = 2; i < xpTable.length; i++) {
    if (totalXp >= xpTable[i]! && xpTable[i]! > xpTable[i - 1]!) level = i;
    else break;
  }
  return level;
}

/** Опыт, требуемый для достижения уровня. За пределами таблицы — последнее значение. */
export function xpForLevel(level: number, xpTable: number[]): number {
  if (level < 1) return 0;
  return xpTable[Math.min(level, xpTable.length - 1)]!;
}

/** Максимальный уровень, заданный таблицей. */
export function maxLevel(xpTable: number[]): number {
  return xpTable.length - 1;
}

/** Уровень, соответствующий накопленному опыту, по таблице balance.xpTable. */
export function levelForXp(totalXp: number, xpTable: number[]): number {
  let level = 1;
  for (let i = 2; i < xpTable.length; i++) {
    if (totalXp >= xpTable[i]!) level = i;
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

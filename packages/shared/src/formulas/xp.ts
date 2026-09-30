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

/**
 * ⭐ D2: ПОЛОСА ОПЫТА СВОЕГО УРОВНЯ — терпит сейв, которого нынешняя кривая «не узнаёт» (правка конфига уровней не отнимает, R9-05):
 * уровень на потолке или выше него (потолок опустили) — полная, `max`; опыт ниже порога своего уровня (кривая стала медленнее) — пустая, с
 * нуля, а не минусом; опыт выше следующего порога (кривая быстрее, уровень придёт со следующим опытом) — полная. Одна истина окну персонажа
 * и полосам HUD (2D и 3D).
 */
export function xpProgress(level: number, xp: number, xpTable: number[]): { into: number; need: number; frac: number; max: boolean } {
  const cur = xpForLevel(level, xpTable), next = xpForLevel(level + 1, xpTable);
  if (!(next > cur)) return { into: 0, need: 0, frac: 1, max: true };
  const need = next - cur;
  const into = Math.max(0, Math.min(need, Number.isFinite(xp) ? xp - cur : 0));
  return { into, need, frac: into / need, max: false };
}

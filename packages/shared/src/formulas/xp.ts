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

// ── Г6 (14.10): СКОЛЬКО ОПЫТА ДОХОДИТ ДО ГЕРОЯ ──────────────────────────────

/** Поля баланса, нужные дележу опыта (структурно ⊆ `balance.xpShare`). */
export interface XpShareBalance {
  safeBase: number;
  safePerLevel: number;
  refBonus: number;
  diffPow: number;
  multPow: number;
  floor: number;
  partyBonusPerMember: number;
}

/**
 * ⭐⭐ Г6: ШТРАФ ЗА РАЗНИЦУ УРОВНЕЙ — ФОРМА PATH OF EXILE (решение владельца, docs библиотеки «Глубина и вейпоинты»).
 *
 *   safe = floor(safeBase + уровень × safePerLevel)          — полоса БЕЗ штрафа (3 + L/16: на 20 ур. ±4, на 80 ±8)
 *   over = max(0, |уровень монстра − уровень героя| − safe)
 *   mult = ((L + refBonus) / (L + refBonus + over^diffPow))^multPow, но не ниже `floor`
 *
 * ⚠⚠ ЗАЧЕМ ВООБЩЕ. До Г6 штрафа не было ВОВСЕ, и опыт не делился: самой выгодной игрой было стоять в углу, пока тебя
 * тащат по глубине. С Г1 уровень монстра — это НОМЕР ЭТАЖА, то есть «тащат» теперь означает «посадили на этаж, который
 * тебе не по зубам», и без штрафа низкий герой снимал бы там полный опыт этажа. Обратная сторона та же: герой 80-го
 * уровня, фармящий 10-й этаж, обязан получать крохи — иначе глубина не нужна.
 *
 * ⚠ ПОЧЕМУ ФОРМА PoE, А НЕ D2. У D2 обрыв: ±5 уровней — полный опыт, дальше сразу 5 %. Это заставляет держать партию
 * в узкой вилке и чинить мир под каждого (путь D4 — масштабирование мира), а у нас мир один и бесконечный. У PoE спад
 * ПЛАВНЫЙ и с полом 1 %: разница в 10 уровней — не ноль, а честно мало.
 *
 * ⚠ ПОЛ (`floor`) — НЕ НОЛЬ НАМЕРЕННО. Ноль превратил бы «не по зубам» в «бессмысленно», а игрок обязан видеть, что
 * действие вообще считается: полоса ползёт, просто медленно. Это же поле — единственная ручка, которой владелец
 * выключит штраф целиком (`floor: 1`), не трогая код.
 *
 * ⚠ `safe` ЦЕЛОЕ (как в PoE): иначе на каждом уровне полоса ехала бы дробью, и игрок не мог бы назвать своё окно.
 */
export function xpLevelMult(playerLevel: number, monsterLevel: number, b: XpShareBalance): number {
  const L = Number.isFinite(playerLevel) ? Math.max(1, Math.floor(playerLevel)) : 1;
  const M = Number.isFinite(monsterLevel) ? Math.max(1, Math.floor(monsterLevel)) : 1;
  const safe = Math.max(0, Math.floor(b.safeBase + L * b.safePerLevel));
  const over = Math.max(0, Math.abs(M - L) - safe);
  if (over === 0) return 1;
  const ref = L + b.refBonus;
  const mult = Math.pow(ref / (ref + Math.pow(over, b.diffPow)), b.multPow);
  return Math.min(1, Math.max(b.floor, Number.isFinite(mult) ? mult : b.floor));
}

/**
 * ⭐⭐ Г6: ДОЛЯ ОДНОГО УЧАСТНИКА ПРИ ДЕЛЕЖЕ НА ПАТИ. Один — всё (1). Больше — `(1 + bonus × (n − 1)) / n`:
 * `partyBonusPerMember` = 0 даёт честное `1/n`, 1 — «каждому полный опыт» (дележа нет).
 *
 * ⚠ ПОЧЕМУ БОНУС ЕСТЬ, ХОТЯ УМОЛЧАНИЕ 0. В PoE пати получает надбавку за размер, иначе играть вместе чисто
 * арифметически невыгодно. Ставить её сейчас, не померив кооп на глубине, — угадывание; поле заведено, чтобы правка
 * была ОДНИМ ЧИСЛОМ в конфиге, а не правкой кода. Доля никогда не больше 1: пати не печатает опыт из воздуха.
 */
export function xpPartyShare(members: number, b: XpShareBalance): number {
  const n = Number.isFinite(members) ? Math.max(1, Math.floor(members)) : 1;
  if (n === 1) return 1;
  const bonus = Math.max(0, Math.min(1, b.partyBonusPerMember));
  return Math.min(1, (1 + bonus * (n - 1)) / n);
}

/**
 * ⭐⭐ Г6: ОПЫТ, КОТОРЫЙ ПОЛУЧИТ ЭТОТ ГЕРОЙ, — один шов на сервер, сим и порт. Округление ВНИЗ, но не ниже 1, если
 * монстр вообще давал опыт: иначе на мелких монстрах большая пати получала бы ноль и полоса стояла бы на месте
 * (замер: xp монстра 12 на пятерых при штрафе 0.05 — 0.12 → 0).
 */
export function xpForKill(monsterXp: number, playerLevel: number, monsterLevel: number, members: number, b: XpShareBalance): number {
  const base = Number.isFinite(monsterXp) ? Math.max(0, monsterXp) : 0;
  if (base <= 0) return 0;
  const got = base * xpLevelMult(playerLevel, monsterLevel, b) * xpPartyShare(members, b);
  return Math.max(1, Math.floor(got));
}

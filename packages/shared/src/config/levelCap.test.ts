import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from './registry.js';
import { levelForXp, xpForLevel, maxLevel, xpProgress } from '../formulas/xp.js';
import { gainXp } from '../economy/progression.js';
import { newCharacterSave } from '../economy/newCharacter.js';

/**
 * ⭐⭐ 14.10 (Г3, В8): ПОТОЛОК ГЕРОЯ — 99 (решение владельца, как в D2).
 *
 * `balance.xpTable` — таблица «уровень → нужный суммарный опыт», индекс = уровень, поэтому потолок = длина − 1.
 * Было 91 строка (максимум 90), стало 100 (максимум 99). Хвост продлён ПО ЗАКОНУ САМОЙ КРИВОЙ, а не «на глазок»:
 * множитель шага на 90-м уровне 1.017283, и он гаснет примерно на 0.000235 за уровень (на 80-м был 1.019931), —
 * продолжение считано этим же законом, поэтому на стыке 90→91 нет ни ступеньки, ни излома.
 *
 * ⚠ ПОЧЕМУ СТОРОЖ, А НЕ «ПОСМОТРЕЛИ ГЛАЗАМИ». Потолок — это ДЛИНА таблицы, то есть его легко сдвинуть случайно:
 * любая правка кривой в редакторе, любой оверрайд баланса из базы (`upgradeXpTable` умеет ОТРЕЗАТЬ хвост) и любая
 * «подгонка пейсинга» меняют длину молча. А по R9-05 выданные уровни не отнимаются — то есть ошибка в длине
 * необратима для тех, кто её успел проехать.
 *
 * ⚠ МУТАЦИИ, КОТОРЫЕ ЭТОТ ФАЙЛ ОБЯЗАН ВАЛИТЬ (каждая проверена руками 14.10: наложить → прогнать → вернуть, md5
 * сверен):
 *  • отрезать хвост `xpTable` (вернуть 91 строку) — валит «потолок = 99» и «герой доходит до 99»;
 *  • дописать 101-ю строку — валит «потолок = 99»;
 *  • ступенька в хвосте (`xpTable[95] = xpTable[94]`) — валит «кривая строго растёт» (и схему реестра, R20-05);
 *  • излом в хвосте (`xpTable[95] += 3_000_000`) — валит «на стыке 90→91 нет излома» и «множитель шага гаснет
 *    монотонно»;
 *  • `maxLevel` → `xpTable.length` (сдвиг на единицу) — валит «потолок = 99»;
 *  • зажим уровня числом в `gainXp` (`Math.min(90, levelForXp(...))`) — валит «герой доходит до 99»;
 *  • `gainXp` опускает уровень по опыту (`if (save.level > target) save.level = target`) — валит «старый сейв
 *    90-го уровня не ломается»: опущенный потолок отнял бы уровни (R9-05).
 */
const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const table = (): number[] => reg.get('balance').xpTable;

describe('⭐⭐ Г3 (В8): потолок героя — 99', () => {
  it('⭐ потолок = 99: таблица из 100 строк, индекс = уровень', () => {
    const t = table();
    expect(t.length, 'строк в xpTable (индекс = уровень)').toBe(100);
    expect(maxLevel(t), 'потолок уровня').toBe(99);
    expect(t[0]).toBe(0);
    expect(t[1], 'первый уровень даром').toBe(0);
    expect(t[99], 'порог 99-го уровня').toBe(53_197_737);
    expect(xpForLevel(99, t)).toBe(t[99]);
    expect(xpForLevel(100, t), 'за потолком — последнее значение').toBe(t[99]);
  });

  it('⭐ кривая строго растёт (R20-05) — и хвост не ступенька', () => {
    const t = table();
    for (let i = 2; i < t.length; i++) {
      expect(t[i]!, `xpTable[${i}] выше xpTable[${i - 1}]`).toBeGreaterThan(t[i - 1]!);
    }
    // Реестр ту же кривую обязан принимать (вторая линия после прямой проверки выше).
    const r = new ConfigRegistry();
    r.loadAll();
    expect(() => r.reload({ balance: { ...r.get('balance'), xpTable: [...t] } })).not.toThrow();
  });

  /**
   * ⭐ ГЛАДКОСТЬ ХВОСТА. Мера — множитель ШАГА: `шаг(L) / шаг(L−1)`. У этой кривой он монотонно гаснет, и гашение
   * ровное (~0.000235 за уровень на хвосте). Стык 90→91 обязан быть ничем не примечательным уровнем: если бы хвост
   * дописали «на глазок», здесь был бы скачок или перелом.
   */
  it('⭐ на стыке 90→91 нет излома: множитель шага гаснет монотонно и ровно', () => {
    const t = table();
    const step = (L: number): number => t[L]! - t[L - 1]!;
    const ratio = (L: number): number => step(L) / step(L - 1);
    const rows: string[] = [];
    for (let L = 85; L <= 99; L++) {
      rows.push(`ур. ${L}: порог ${String(t[L]).padStart(9)} · шаг ${String(step(L)).padStart(8)} · множитель ${ratio(L).toFixed(6)} · гашение ${(ratio(L - 1) - ratio(L)).toFixed(6)}`);
    }
    console.log(`\nХВОСТ КРИВОЙ ОПЫТА (замер 14.10)\n${rows.join('\n')}`);

    // Монотонность: множитель шага только гаснет — по всему хвосту, через стык.
    for (let L = 81; L <= 99; L++) {
      expect(ratio(L), `ур. ${L}: множитель шага ниже предыдущего`).toBeLessThan(ratio(L - 1));
      expect(ratio(L), `ур. ${L}: кривая всё ещё ускоряется`).toBeGreaterThan(1);
    }
    // Ровность гашения: на стыке оно не выделяется среди соседей хвоста (замер: 0.000235…0.000250).
    for (let L = 82; L <= 99; L++) {
      const decay = ratio(L - 1) - ratio(L);
      expect(decay, `ур. ${L}: гашение множителя в полосе хвоста`).toBeGreaterThan(0.00020);
      expect(decay, `ур. ${L}: гашение множителя в полосе хвоста`).toBeLessThan(0.00030);
    }
    // Числа стыка — замеренные, а не предсказанные.
    expect(ratio(90)).toBeCloseTo(1.017283, 6);
    expect(ratio(91)).toBeCloseTo(1.017049, 6);
    expect(ratio(99)).toBeCloseTo(1.015170, 6);
  });

  it('⭐ герой доходит до 99 и НЕ выше', () => {
    const t = table();
    const bal = reg.get('balance');
    const s = newCharacterSave(reg, 'warrior', 'Cap', 'char-cap-99');
    gainXp(s, bal, t[99]!);
    expect(s.level, 'ровно порог 99-го уровня').toBe(99);
    gainXp(s, bal, 10 * t[99]!);
    expect(s.level, 'десятикратный опыт потолка выше не поднимает').toBe(99);
    expect(levelForXp(Number.MAX_SAFE_INTEGER, t)).toBe(99);
    // Полоса опыта на потолке — полная, без «нужно ещё N» (`xpProgress`).
    expect(xpProgress(99, s.xp, t)).toEqual({ into: 0, need: 0, frac: 1, max: true });
    // Шаг 98 → 99 реально платится (а не достаётся заодно с 98-м).
    const s2 = newCharacterSave(reg, 'warrior', 'Cap2', 'char-cap-98');
    gainXp(s2, bal, t[99]! - 1);
    expect(s2.level).toBe(98);
  });

  it('⭐ старый сейв 90-го уровня не ломается (R9-05: уровни не отнимаются)', () => {
    const t = table();
    const bal = reg.get('balance');
    const s = newCharacterSave(reg, 'warrior', 'Old', 'char-cap-old');
    // Герой, стоявший на прежнем потолке: уровень 90, опыт — ровно его порог.
    gainXp(s, bal, t[90]!);
    expect(s.level).toBe(90);
    const pointsAt90 = s.unspentSkillPoints;
    // Полоса больше не «полная»: впереди 91-й — и это ровно то, что игрок увидит.
    const bar = xpProgress(s.level, s.xp, t);
    expect(bar.max, 'на 90-м потолка больше нет').toBe(false);
    expect(bar.need, 'до 91-го — шаг кривой').toBe(t[91]! - t[90]!);
    // Добор опыта поднимает дальше — и очки за новые уровни выдаются по разу.
    gainXp(s, bal, t[99]! - t[90]!);
    expect(s.level).toBe(99);
    expect(s.unspentSkillPoints - pointsAt90, 'очки скилов за 9 новых уровней').toBe(9 * bal.skillPointsPerLevel);
    // ⚠ Потолок ОПУСТИЛИ (кривая 91 строка, как до 14.10) — уровень 99 у героя остаётся: его считает `save.level`,
    // а не опыт (`levelForXp` в сейв не пишет никто, кроме `gainXp`, и только вверх).
    const old = t.slice(0, 91);
    expect(maxLevel(old)).toBe(90);
    expect(xpProgress(99, s.xp, old), 'выше потолка — полоса полная, не минусом').toEqual({ into: 0, need: 0, frac: 1, max: true });
    gainXp(s, { ...bal, xpTable: old }, 1_000_000);
    expect(s.level, 'опущенный потолок уровень не отнимает').toBe(99);
  });

  it('требования уровня в данных не уезжают за потолок', () => {
    const cap = maxLevel(table());
    const reqs: { where: string; level: number }[] = [];
    for (const n of reg.get('skill-tree').nodes) if (n.levelReq) reqs.push({ where: `skill-tree/${n.id}`, level: n.levelReq });
    for (const n of reg.get('mastery-tree').nodes) if (n.levelReq) reqs.push({ where: `mastery-tree/${n.id}`, level: n.levelReq });
    const worst = reqs.reduce((m, r) => (r.level > m.level ? r : m), { where: '—', level: 0 });
    console.log(`\nСАМОЕ ВЫСОКОЕ ТРЕБОВАНИЕ УРОВНЯ В ДАННЫХ: ${worst.where} = ${worst.level} (потолок ${cap})`);
    for (const r of reqs) expect(r.level, `${r.where}: требование уровня не выше потолка`).toBeLessThanOrEqual(cap);
  });
});

import { describe, it, expect } from 'vitest';
import {
  defaultConfigData, ConfigRegistry, Cell, createRng, generateMonster, makeGrid, monsterCombatStats, spawnPacksEl,
  type DungeonLayout, type ScaledMonster,
} from '@dm/shared';
import { regFromData } from './classNumbers.js';
import {
  LEVEL_BY_POWER, RARITIES, bindArchetypes, floorMonsterLevel, leadingIds, monsterCard, monsterNumbers, subtypeTable,
  type MonsterRarity, type MonsterNumbers,
} from './monsterNumbers.js';
import cryptJson from './seed/crypt.json';
import type { CryptDraft } from './seed.js';

/**
 * ⭐ 16.10 (Артбук): ЧИСЛА МОНСТРОВ ВКЛАДКИ — ТЕ ЖЕ, ЧТО У ИГРЫ. Два сторожа от «своей арифметики»:
 *  • прямой вызов `generateMonster` + `monsterCombatStats` с теми же входами, уровнем, редкостью и сидом — каждая строка таблицы;
 *  • ОРАКУЛ ЗАСЕЛЕНИЯ: обычный монстр, которого сервер (`spawnPacksEl`) ставит на этаж N, — ровно строка артбука «этаж N».
 *    Он ловит то, чего прямой вызов не видит: другой уровень этажа или новый вход генератора у заселения.
 */
const crypt = cryptJson as unknown as CryptDraft;
const reg = (data: Record<string, unknown> = defaultConfigData): ConfigRegistry => regFromData(data);
const monstersOf = (r: ConfigRegistry): { id: string; name: string; faction: string; subfaction: string }[] => r.get('monsters');

/** Поля сверки: всё, что артбук печатает в таблице и карточке. */
const KEYS = ['shownName', 'level', 'rarity', 'hp', 'minDamage', 'maxDamage', 'attackSpeed', 'armor', 'accuracy', 'evade',
  'blockChance', 'critChance', 'moveSpeed', 'xp', 'damageType'] as const;
/** Та же сводка — из ЭКЗЕМПЛЯРА игры (`monsterCombatStats` — то, что видит `resolveAttack`). */
const pick = (m: ScaledMonster): Record<string, unknown> => {
  const cs = monsterCombatStats(m);
  const src: Record<string, unknown> = { ...m, ...cs, shownName: m.name, attackSpeed: Math.round(m.attackSpeed * 100) / 100 };
  return Object.fromEntries(KEYS.map((k) => [k, src[k]]));
};
const sameAs = (n: MonsterNumbers): Record<string, unknown> => Object.fromEntries(KEYS.map((k) => [k, n[k]]));

/** Входы генератора — выписаны здесь заново, как их собирает заселение (`spawnPacksEl`), а не взяты у артбука. */
function directRoll(r: ConfigRegistry, id: string, level: number, rarity: MonsterRarity, seed = 1): ScaledMonster {
  const extra: Record<string, unknown> = {};
  try { extra.gearTiers = (r.get as (this: ConfigRegistry, k: string) => unknown).call(r, 'monster-gear-tiers'); } catch { /* до лестницы ступеней */ }
  return generateMonster(r.get('monsters'), r.get('monster-gear'), r.get('monster-affixes'), {
    baseId: id, depth: level - 1, uniqueXpMult: r.get('balance').uniqueXpMult, mderive: r.get('monster-derive'),
    itemAffixes: r.get('monster-item-affixes'), rarities: r.get('rarities'), rarity, monsterRarity: r.get('monster-rarity'),
    monsterUniques: r.get('monster-uniques'), ...extra,
  }, createRng(seed));
}

/** Этаж из комнат-коробок (без входа и босса): заселение ставит в них пачки. */
function boxLayout(rooms = 6): DungeonLayout {
  const w = 12, cols = rooms * (w + 1) + 1, rows = w + 2;
  const grid = makeGrid(cols, rows, Cell.Wall);
  const list: DungeonLayout['rooms'] = [];
  for (let i = 0; i < rooms; i++) {
    const x = 1 + i * (w + 1);
    for (let cy = 1; cy <= w; cy++) for (let cx = x; cx < x + w; cx++) grid[cy]![cx] = Cell.Floor;
    list.push({ x, y: 1, w, h: w, type: i % 2 ? 'large' : 'small' });
  }
  return { grid, rooms: list, spawn: { x: 0, y: 0 }, stairsDown: { x: 0, y: 0 }, exits: [], decor: [], doors: [], levers: [], chests: [] };
}

/** Заселение сервера пулом из ОДНОГО монстра — та же форма вызова, что у комнаты (`room.ts`), в обеих версиях шва. */
function serverSpawns(r: ConfigRegistry, id: string, floor: number, difficulty = 'normal'): ScaledMonster[] {
  const call = spawnPacksEl as unknown as (...a: unknown[]) => { def: ScaledMonster }[];
  const rng = createRng(1234 + floor);
  const out = LEVEL_BY_POWER ? call(r, boxLayout(), floor, difficulty, rng, 1, [id]) : call(r, boxLayout(), floor, difficulty, rng, [id]);
  return out.map((s) => s.def);
}

describe('artbook: кто в подтипе и какой архетип', () => {
  it('id в начале строки черновика — привязка; заметка «готового монстра нет … zombie-shaman» — нет', () => {
    const known = new Set(['zombie-crossbow', 'zombie-bolter', 'zombie-shaman', 'zombie-fighter']);
    expect(leadingIds('zombie-crossbow и zombie-bolter — арбалеты, только средневековый слой', known)).toEqual(['zombie-crossbow', 'zombie-bolter']);
    expect(leadingIds('zombie-fighter (ветеранский вариант, medium, меч + щит)', known)).toEqual(['zombie-fighter']);
    expect(leadingIds('zombie-shaman по описанию «баффы/хилл»', known)).toEqual(['zombie-shaman']);
    expect(leadingIds('готового монстра нет; ближе всего по роли zombie-shaman', known)).toEqual([]);
    expect(leadingIds('zombie-nope — опечатка', known)).toEqual([]);
  });

  it('нынешние 19 зомби — Европа: архетипы средневекового подтипа и двое без архетипа', () => {
    const r = reg();
    const b = bindArchetypes(crypt, 'medieval', monstersOf(r));
    expect([...b.byArch.values()].flat().length + b.unbound.length).toBeGreaterThanOrEqual(19);
    expect(b.byArch.get('rank_and_file')).toEqual(['zombie-raider', 'zombie-fighter', 'zombie-crusher']);
    expect(b.byArch.get('archer')).toEqual(['zombie-archer', 'zombie-crossbow', 'zombie-bolter']);
    expect(b.byArch.get('herald'), 'знаменосца в конфиге нет — шаман ему не приписан').toEqual([]);
    expect(b.byArch.get('me_pavisier')).toEqual(['zombie-crossbow']);
    expect(b.byArch.get('me_dead_king')).toEqual([]);
    expect(b.unbound.sort()).toEqual(['zombie-berserker', 'zombie-spearman']);
    const all = new Set([...[...b.byArch.values()].flat(), ...b.unbound]);
    for (const m of monstersOf(r)) expect(all.has(m.id), m.id).toBe(true);
  });

  it('прочие подтипы пусты, у пустой строки — прообраз из черновика', () => {
    const r = reg();
    for (const sub of ['mesopotamia', 'egypt', 'greece', 'rome', 'vikings']) {
      const t = subtypeTable(r, crypt, sub, { floor: 5, difficulty: 'normal', rarity: 'normal' });
      expect(t.rows.every((x) => !x.monsterId), sub).toBe(true);
      expect(t.extra, sub).toEqual([]);
    }
    const gr = subtypeTable(r, crypt, 'greece', { floor: 5, difficulty: 'normal', rarity: 'normal' });
    expect(gr.rows.find((x) => x.archId === 'gr_sarissophoros')?.proto?.id).toBe('zombie-spearman');
    expect(gr.rows.find((x) => x.archId === 'rank_and_file')?.name).toBe('Посеянный');
  });

  it('монстр с подтипом в конфиге уходит в свой подтип и встаёт к архетипу по имени', () => {
    const monsters = JSON.parse(JSON.stringify(defaultConfigData.monsters)) as { id: string; name: string; subfaction: string }[];
    const src = monsters.find((m) => m.id === 'zombie-raider')!;
    monsters.push({ ...src, id: 'sown-one', name: 'Посеянный', subfaction: 'greece' });
    const r = reg({ ...defaultConfigData, monsters });
    expect(bindArchetypes(crypt, 'greece', monstersOf(r)).byArch.get('rank_and_file')).toEqual(['sown-one']);
    const med = bindArchetypes(crypt, 'medieval', monstersOf(r));
    expect([...med.byArch.values()].flat()).not.toContain('sown-one');
    expect(med.unbound).not.toContain('sown-one');
    const gr = subtypeTable(r, crypt, 'greece', { floor: 3, difficulty: 'normal', rarity: 'normal' });
    expect(gr.rows.find((x) => x.archId === 'rank_and_file')?.n?.hp).toBeGreaterThan(0);
  });
});

describe('artbook: числа монстров = игра', () => {
  it('каждая строка таблицы = generateMonster + monsterCombatStats на том же уровне, редкости и сиде', () => {
    const r = reg();
    for (const floor of [1, 10, 40]) for (const rarity of RARITIES) {
      const t = subtypeTable(r, crypt, 'medieval', { floor, difficulty: 'normal', rarity, seed: 7 });
      const filled = [...t.rows.filter((x) => x.n).map((x) => ({ id: x.monsterId!, n: x.n! })), ...t.extra];
      expect(filled.length).toBeGreaterThanOrEqual(19);
      for (const { id, n } of filled) {
        const m = directRoll(r, id, t.level, rarity, 7);
        expect(sameAs(n), `${id} этаж ${floor} ${rarity}`).toEqual(pick(m));
        expect(n.weapon).toBe(m.gearRolls?.find((g) => g.slot === 'weapon')?.name);
      }
    }
  });

  it('ОРАКУЛ: обычный монстр, которого сервер заселяет на этаж N, — строка артбука «этаж N»', () => {
    const r = reg();
    for (const id of ['zombie', 'zombie-raider', 'zombie-knight', 'zombie-archer', 'zombie-warlock', 'zombie-lord']) {
      for (const floor of [1, 7, 30]) {
        const normal = serverSpawns(r, id, floor).filter((m) => m.rarity === 'normal');
        expect(normal.length, `${id} этаж ${floor}: обычных нет`).toBeGreaterThan(0);
        const n = monsterNumbers(r, id, floorMonsterLevel(r, 'normal', floor), 'normal')!;
        for (const m of normal) expect(sameAs(n), `${id} этаж ${floor}`).toEqual(pick(m));
      }
    }
  });

  it('этаж и сложность двигают уровень, как у заселения; глубже — толще', () => {
    const r = reg();
    const l1 = floorMonsterLevel(r, 'normal', 1), l10 = floorMonsterLevel(r, 'normal', 10);
    expect(l10).toBeGreaterThan(l1);
    expect(l1).toBe(LEVEL_BY_POWER ? 2 : 1);   // до Г1 заселение давало монстру уровень на 1 выше этажа
    expect(floorMonsterLevel(r, 'hard', 10)).toBeGreaterThan(l10);
    expect(floorMonsterLevel(r, 'нет-такой', 10), 'неизвестная сложность — как средняя').toBe(l10);
    const hp = (f: number): number => monsterNumbers(r, 'zombie-knight', floorMonsterLevel(r, 'normal', f), 'normal')!.hp;
    expect(hp(20)).toBeGreaterThan(hp(1));
  });

  it('бросок детерминирован: тот же сид — те же числа; обычный монстр от сида не зависит', () => {
    const r = reg();
    expect(monsterNumbers(r, 'zombie-knight', 30, 'rare', 5)).toEqual(monsterNumbers(r, 'zombie-knight', 30, 'rare', 5));
    expect(monsterNumbers(r, 'zombie-knight', 30, 'normal', 5)).toEqual(monsterNumbers(r, 'zombie-knight', 30, 'normal', 99));
    const u = monsterNumbers(r, 'zombie-lord', 30, 'unique')!;
    const n = monsterNumbers(r, 'zombie-lord', 30, 'normal')!;
    expect(u.hp).toBeGreaterThan(n.hp);
    expect(u.shownName).not.toBe(n.name);
  });

  it('выключенный в конфиге монстр остаётся в таблице с пометкой', () => {
    const monsters = JSON.parse(JSON.stringify(defaultConfigData.monsters)) as { id: string; enabled: boolean }[];
    monsters.find((m) => m.id === 'zombie-knight')!.enabled = false;
    const t = subtypeTable(reg({ ...defaultConfigData, monsters }), crypt, 'medieval', { floor: 3, difficulty: 'normal', rarity: 'normal' });
    expect(t.rows.filter((x) => x.monsterId === 'zombie-knight').every((x) => x.off && x.n)).toBe(true);
    expect(t.rows.find((x) => x.monsterId === 'zombie-guard')?.off).toBeUndefined();
  });

  it('правка конфига видна сразу: живучесть ×2 — жизнь растёт', () => {
    const before = monsterNumbers(reg(), 'zombie-raider', 10, 'normal')!.hp;
    const monsters = JSON.parse(JSON.stringify(defaultConfigData.monsters)) as { id: string; vit: number }[];
    monsters.find((m) => m.id === 'zombie-raider')!.vit *= 2;
    expect(monsterNumbers(reg({ ...defaultConfigData, monsters }), 'zombie-raider', 10, 'normal')!.hp).toBeGreaterThan(before);
  });

  it('карточка: атрибуты заготовки, весь гир с классом и числами, умения (статус удара, блок щитом)', () => {
    const r = reg();
    const c = monsterCard(r, 'zombie-knight', 12, 'normal')!;
    const tpl = r.get('monsters').find((m) => m.id === 'zombie-knight')!;
    expect(c.attrs).toEqual({ str: tpl.str, dex: tpl.dex, int: tpl.int, vit: tpl.vit });
    expect(c.gear.map((g) => g.id).sort()).toEqual([tpl.weapon, tpl.armor, tpl.offhand, ...(tpl.helm ? [tpl.helm] : [])].filter(Boolean).sort());
    const w = c.gear.find((g) => g.slot === 'weapon')!;
    expect(w.cls).toBe('меч');
    expect(w.damage).toMatch(/^\d+–\d+$/);
    expect(c.gear.find((g) => g.slot === 'armor')?.defense).toBeGreaterThan(0);
    expect(c.skills.map((s) => s.name)).toEqual(expect.arrayContaining(['Атака', 'Блок щитом', 'Удар: Кровотечение']));
    expect(c.n).toEqual(monsterNumbers(r, 'zombie-knight', 12, 'normal'));
    const rare = monsterCard(r, 'zombie-knight', 40, 'rare', 3)!;
    expect(rare.gear.some((g) => g.mods.length > 0), 'у редкого есть накатанные свойства').toBe(true);
  });

  it('монстра нет — null, а не падение', () => {
    expect(monsterNumbers(reg(), 'нет-такого', 5, 'normal')).toBeNull();
    expect(monsterCard(reg(), 'нет-такого', 5, 'normal')).toBeNull();
  });
});

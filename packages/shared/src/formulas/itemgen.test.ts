import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import {
  pickDropBase, generateItem, rollRarity, rollAffixes, itemFromBase,
  DEFAULT_ROLL_SPREAD, bakedExtras, baseStatRange, fixedBaseRoll, inferTierId, retierItem, scaleBaseStats, shapedBaseStats, shapeOfItem,
} from './itemgen.js';
import { createRng } from './rng.js';

const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const bases = reg.get('items.base');
const affixes = reg.get('affixes');
const uniques = reg.get('uniques');
const rarities = reg.get('rarities');
const tiers = reg.get('item-tiers');

function distribution(weights: Record<string, number>, n: number): Record<string, number> {
  const rng = createRng(12345);
  const counts: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const b = pickDropBase(bases, weights, rng);
    counts[b.kind] = (counts[b.kind] ?? 0) + 1;
  }
  return counts;
}

describe('buildItem: 3D modelId несётся с базы на инстанс (регресс: gearFields ронял его → броня не отображалась)', () => {
  it('armor/weapon/shield инстанс получает modelId базы', () => {
    for (const kind of ['armor', 'weapon', 'shield'] as const) {
      const base = bases.find((b) => b.kind === kind);
      if (!base) continue;
      const it = itemFromBase({ ...base, modelId: 'test_model_01' } as typeof base, tiers);
      expect((it as { modelId?: string }).modelId).toBe('test_model_01');
    }
  });
});

describe('pickDropBase (взвешенный дроп по категориям)', () => {
  it('щиты выпадают при shield>0', () => {
    const d = distribution({ weapon: 10, armor: 10, shield: 40, jewelry: 5, consumable: 5 }, 3000);
    expect(d.shield ?? 0).toBeGreaterThan(0);
  });

  it('категория с весом 0 не выпадает', () => {
    const d = distribution({ weapon: 0, armor: 10, shield: 10, jewelry: 10, consumable: 0 }, 3000);
    expect(d.weapon ?? 0).toBe(0);
    expect(d.consumable ?? 0).toBe(0);
  });

  it('вес категории задаёт её долю', () => {
    const d = distribution({ weapon: 10, armor: 10, shield: 80, jewelry: 0, consumable: 0 }, 5000);
    const total = Object.values(d).reduce((s, n) => s + n, 0);
    expect((d.shield ?? 0) / total).toBeGreaterThan(0.5); // 80/100 ≈ 0.8
  });

  it('нулевые веса → фолбэк на равномерный (не падает)', () => {
    const d = distribution({}, 500);
    expect(Object.values(d).reduce((s, n) => s + n, 0)).toBe(500);
  });
});

describe('enabled-фильтры генерации (тумблер активно/неактивно)', () => {
  it('rollRarity: выключенная редкость не выпадает (порог пропускается)', () => {
    const rng = createRng(42);
    const noRare = rarities.map((r) => (r.id === 'rare' ? { ...r, enabled: false } : r));
    for (let i = 0; i < 4000; i++) expect(rollRarity(1.5, rng, noRare)).not.toBe('rare');
  });

  it('rollAffixes: все аффиксы выключены → пустой ролл', () => {
    const rng = createRng(7);
    const off = affixes.map((a) => ({ ...a, enabled: false }));
    const slots = { minAffixes: 3, maxAffixes: 3, maxPrefix: 3, maxSuffix: 3 };
    expect(rollAffixes(off, { kind: 'weapon', slot: 'weapon', attackType: 'melee', damageKind: 'physical' }, 'rare', slots, 99, rng)).toEqual([]);
  });

  describe('rollAffixes: правила D2', () => {
    const wpn = { kind: 'weapon', slot: 'weapon', attackType: 'melee', damageKind: 'physical' };
    const magic = { minAffixes: 2, maxAffixes: 2, maxPrefix: 1, maxSuffix: 1 };
    const rare = { minAffixes: 6, maxAffixes: 6, maxPrefix: 3, maxSuffix: 3 };
    const kindOf = (id: string): string => affixes.find((a) => a.id === id)?.kind ?? '';
    const counts = (r: ReturnType<typeof rollAffixes>): { p: number; s: number } => {
      const ids = new Set(r.map((a) => a.affixId));
      return { p: [...ids].filter((id) => kindOf(id) === 'prefix').length, s: [...ids].filter((id) => kindOf(id) === 'suffix').length };
    };

    it('лимиты префикс/суффикс: magic ≤1+≤1, rare ≤3+3', () => {
      const rng = createRng(11);
      for (let i = 0; i < 300; i++) {
        const m = counts(rollAffixes(affixes, wpn, 'magic', magic, 99, rng));
        expect(m.p).toBeLessThanOrEqual(1); expect(m.s).toBeLessThanOrEqual(1);
        const r = counts(rollAffixes(affixes, wpn, 'rare', rare, 99, rng));
        expect(r.p).toBeLessThanOrEqual(3); expect(r.s).toBeLessThanOrEqual(3);
      }
    });

    it('appliesTo: аффикс только для брони не падает на оружие', () => {
      const armorOnly = affixes.map((a) => (a.kind === 'prefix' ? { ...a, appliesTo: ['armor'] } : a));
      const rng = createRng(5);
      for (let i = 0; i < 100; i++) {
        const r = rollAffixes(armorOnly, wpn, 'rare', rare, 99, rng);
        expect(r.every((x) => armorOnly.find((a) => a.id === x.affixId)?.kind !== 'prefix')).toBe(true);
      }
    });

    it('группа: не больше одного аффикса из одной группы', () => {
      const grouped = affixes.map((a) => (a.kind === 'suffix' ? { ...a, group: 'g1' } : a));
      const rng = createRng(9);
      for (let i = 0; i < 100; i++) {
        const r = rollAffixes(grouped, wpn, 'rare', rare, 99, rng);
        const suf = new Set(r.filter((x) => grouped.find((a) => a.id === x.affixId)?.kind === 'suffix').map((x) => x.affixId));
        expect(suf.size).toBeLessThanOrEqual(1);
      }
    });

    it('имена рарные: имя базы + титул «основа эпитет» из двух пулов', () => {
      const rng = createRng(42);
      const rareNames = reg.get('rare-names');
      let sawRare = false;
      for (let i = 0; i < 2000 && !sawRare; i++) {
        const item = generateItem(bases, affixes, uniques, { dropBias: 4, itemLevel: 40, tiers, rarities, rareNames }, rng);
        if (item.rarity === 'rare') {
          sawRare = true;
          // заканчивается «<основа> <эпитет>» из пулов nouns×epithets (перед ним — имя базы)
          const titled = rareNames.nouns.some((n) => rareNames.epithets.some((e) => item.name.endsWith(`${n.t} ${e.t}`)));
          expect(titled).toBe(true);
        }
      }
      expect(sawRare).toBe(true);
    });

    type RN = { nouns: { t: string; themes: string[] }[]; epithets: { t: string; groups: string[] }[] };
    const nounsWithTheme = (rn: RN, theme: string): string[] => rn.nouns.filter((w) => w.themes.includes(theme)).map((w) => w.t);
    const epithetsWithGroup = (rn: RN, group: string): string[] => rn.epithets.filter((w) => w.groups.includes(group)).map((w) => w.t);
    // прогон N роллов на заданном пуле аффиксов; колбэк проверяет предметы с нужным статом
    const rollForStat = (pool: typeof affixes, mustStat: string, seed: number, check: (name: string) => void): void => {
      const rng = createRng(seed);
      let checked = 0;
      for (let i = 0; i < 300; i++) {
        const item = generateItem(bases, pool, uniques,
          { dropBias: 4, itemLevel: 40, baseId: 'short-sword', tiers, rarities, rareNames: reg.get('rare-names'), forceRarity: 'rare' }, rng);
        if (!item.affixes.some((a) => a.modifier?.stat === mustStat)) continue;
        checked++; check(item.name);
      }
      expect(checked).toBeGreaterThan(0);
    };
    const only = (...ids: string[]) => affixes.filter((a) => ids.includes(a.id));

    it('основа по стихии: холодный предмет не получает огненную основу', () => {
      const fireNouns = nounsWithTheme(reg.get('rare-names'), 'fire');
      expect(fireNouns.length).toBeGreaterThan(0);
      rollForStat(only('frozen', 'of-strength'), 'addCold', 123, (name) => {
        for (const fn of fireNouns) expect(name.includes(fn)).toBe(false);
      });
    });

    it('основа по стихии: физ-предмет не получает стихийную основу', () => {
      const elemNouns = ['fire', 'cold', 'lightning', 'poison'].flatMap((t) => nounsWithTheme(reg.get('rare-names'), t));
      expect(elemNouns.length).toBeGreaterThan(0);
      rollForStat(only('sharp', 'of-strength'), 'maxDamage', 321, (name) => {
        for (const en of elemNouns) expect(name.includes(en)).toBe(false);
      });
    });

    it('основа отражает урон: молниевый предмет → молниевая основа', () => {
      const lightNouns = nounsWithTheme(reg.get('rare-names'), 'lightning');
      expect(lightNouns.length).toBeGreaterThan(0);
      rollForStat(only('shocking', 'of-strength'), 'addLightning', 77, (name) => {
        expect(lightNouns.some((n) => name.includes(n))).toBe(true);
      });
    });

    it('эпитет отражает свойство: вампиризм → эпитет группы leech', () => {
      const leechEps = epithetsWithGroup(reg.get('rare-names'), 'leech');
      expect(leechEps.length).toBeGreaterThan(0);
      rollForStat(only('shocking', 'of-leech'), 'lifeLeechPct', 88, (name) => {
        expect(leechEps.some((e) => name.includes(e))).toBe(true);
      });
    });
  });

  it('generateItem: все уники выключены → редкость никогда не unique (даунгрейд до rare)', () => {
    const rng = createRng(3);
    const off = uniques.map((u) => ({ ...u, enabled: false }));
    for (let i = 0; i < 2000; i++) {
      const it = generateItem(bases, affixes, off,
        { dropBias: 50, itemLevel: 80, tiers, rarities, categoryWeights: { weapon: 100, armor: 0, shield: 0, jewelry: 0, consumable: 0 } }, rng);
      expect(it.rarity).not.toBe('unique');
    }
  });

  it('item-tiers: выключенный высший тир не выбирается (нет «Мифического» при отключённом t6)', () => {
    const cw = { weapon: 50, armor: 50, shield: 0, jewelry: 0, consumable: 0 };
    const namesFor = (ts: typeof tiers, seed: number): string => {
      const rng = createRng(seed);
      const s = new Set<string>();
      for (let i = 0; i < 500; i++) s.add(generateItem(bases, affixes, uniques, { dropBias: 1, itemLevel: 95, tiers: ts, rarities, categoryWeights: cw }, rng).name);
      return [...s].join('|');
    };
    expect(namesFor(tiers, 99)).toContain('Мифическ'); // t6 достижим при ilvl 95
    const noT6 = tiers.map((t) => (t.id === 't6' ? { ...t, enabled: false } : t));
    expect(namesFor(noT6, 99)).not.toContain('Мифическ'); // выключён → не выбирается
  });
});

describe('generateItem: колбы дропаются normal без аффиксов', () => {
  it('consumable-вес → выпадают колбы (normal, без аффиксов)', () => {
    const rng = createRng(777);
    let sawConsumable = false;
    for (let i = 0; i < 1500; i++) {
      const it = generateItem(bases, affixes, uniques,
        { dropBias: 1, itemLevel: 3, tiers, rarities, categoryWeights: { weapon: 0, armor: 0, shield: 0, jewelry: 0, consumable: 100 } }, rng);
      if (it.kind === 'consumable') { // (редкий рулон unique остаётся экипом — терпим)
        expect(it.rarity).toBe('normal');
        expect(it.affixes.length).toBe(0);
        sawConsumable = true;
      }
    }
    expect(sawConsumable).toBe(true);
  });
});

describe('сочетания аффиксов: теги базы (PoE2) + роли слотов', () => {
  it('теги базы: стихийный урон чаще на магическом оружии, чем на физическом', () => {
    const rareSlots = { minAffixes: 6, maxAffixes: 6, maxPrefix: 3, maxSuffix: 3 };
    const elemental = new Set(['flaming', 'frozen', 'shocking', 'venomous']);
    const countElem = (damageKind: string): number => {
      const rng = createRng(5);
      const target = { kind: 'weapon', slot: 'weapon', attackType: 'melee', damageKind } as const;
      let n = 0;
      for (let i = 0; i < 400; i++) if (rollAffixes(affixes, target, 'rare', rareSlots, 40, rng).some((a) => elemental.has(a.affixId))) n++;
      return n;
    };
    expect(countElem('magical')).toBeGreaterThan(countElem('physical')); // tagWeight ×2 на weapon.magical
  });

  it('роли слотов (PoE2): чистый урон = префикс, резисты/атрибуты = суффикс', () => {
    const OFFENSE = new Set(['minDamage', 'maxDamage', 'physPct', 'damagePct', 'addFire', 'addCold', 'addLightning', 'addPoison']);
    const RESATTR = new Set(['resFire', 'resCold', 'resLightning', 'resPoison', 'strength', 'dexterity', 'intelligence', 'vitality']);
    const statsOf = (a: (typeof affixes)[number]): string[] => (a.mods?.length ? a.mods.map((m) => m.stat) : a.stat ? [a.stat] : []);
    for (const a of affixes) {
      const st = statsOf(a);
      const hasOff = st.some((s) => OFFENSE.has(s));
      const hasRA = st.some((s) => RESATTR.has(s));
      if (hasOff && !hasRA) expect(a.kind).toBe('prefix'); // чистый урон — только префикс
      if (hasRA && !hasOff) expect(a.kind).toBe('suffix'); // резист/атрибут — только суффикс
    }
  });
});

describe('кап суммы требований (maxTotalRequirement)', () => {
  const sum = (it: { requirements: Record<string, number | undefined> }): number =>
    Object.values(it.requirements).reduce<number>((s, v) => s + (v ?? 0), 0);
  const mk = (cap: number): ReturnType<typeof generateItem> =>
    generateItem(bases, affixes, uniques,
      { dropBias: 0, itemLevel: 90, baseId: 'maul', tiers, rarities, forceRarity: 'normal', maxReqTotal: cap },
      createRng(3));

  it('heavy-2H на высоком тире не превышает кап; меньший кап → меньше требований', () => {
    const a = mk(180), b = mk(90);
    expect(sum(a)).toBeLessThanOrEqual(180);
    expect(sum(b)).toBeLessThanOrEqual(90);
    expect(sum(b)).toBeLessThan(sum(a)); // кап 90 реально ужимает
    expect(Object.keys(a.requirements)).toEqual(['strength']); // тяжёлое = только сила → весь кап в силу
  });
});

describe('⭐ форма чисел базы от клинка (docs/CRAFT_WEAPONS.md §26)', () => {
  const swords = bases.filter((b) => b.kind === 'weapon' && b.weaponClass === 'sword');
  type Mods = { stat: string; kind: string; value: number }[];
  const val = (st: Mods, stat: string): number => st.find((m) => m.stat === stat && m.kind === 'flat')!.value;
  const rest = (st: Mods): Mods => st.filter((m) => m.stat !== 'minDamage' && m.stat !== 'maxDamage');
  const R = DEFAULT_ROLL_SPREAD;

  it('shapedBaseStats: середина та же, полуразмах ×s, прочие статы не трогаются; без формы и ×1 — тот же массив', () => {
    expect(swords.length).toBeGreaterThan(0);
    for (const b of swords) {
      const mid0 = (val(b.baseStats, 'minDamage') + val(b.baseStats, 'maxDamage')) / 2;
      const half0 = (val(b.baseStats, 'maxDamage') - val(b.baseStats, 'minDamage')) / 2;
      for (const s of [0.4, 0.7, 1.3, 1.6]) {
        const out = shapedBaseStats(b.baseStats, { spread: s });
        expect((val(out, 'minDamage') + val(out, 'maxDamage')) / 2, `${b.id} ×${s}`).toBeCloseTo(mid0, 12);
        expect((val(out, 'maxDamage') - val(out, 'minDamage')) / 2, `${b.id} ×${s}`).toBeCloseTo(half0 * s, 12);
        expect(rest(out), `${b.id} ×${s}`).toEqual(rest(b.baseStats));
      }
      expect(shapedBaseStats(b.baseStats)).toBe(b.baseStats);
      expect(shapedBaseStats(b.baseStats, { spread: 1 })).toBe(b.baseStats);
    }
    // Мелкая база под узким клинком: мин не падает ниже 0.5 — удара в ноль не бывает.
    const tiny = [{ stat: 'minDamage', kind: 'flat', value: 1 }, { stat: 'maxDamage', kind: 'flat', value: 9 }] as Parameters<typeof shapedBaseStats>[0];
    expect(val(shapedBaseStats(tiny, { spread: 1.6 }), 'minDamage')).toBe(0.5);
    expect(tiny[0]!.value).toBe(1); // вход не мутирует
  });
  it('shapeOfItem: ×1 и отсутствие поля — формы нет', () => {
    expect(shapeOfItem({})).toBeUndefined();
    expect(shapeOfItem({ spreadMult: 1 })).toBeUndefined();
    expect(shapeOfItem({ spreadMult: 0.6 })).toEqual({ spread: 0.6 });
  });
  it('baseStatRange с формой: края вилки = числа при доле пола и 1 С ФОРМОЙ; широкий сужает вилку с обеих сторон, узкий — расширяет', () => {
    for (const b of swords) for (const t of tiers) for (const s of [0.4, 1.6]) {
      const shape = { spread: s };
      const at = (q: number) => scaleBaseStats(b.baseStats, t.statMult, fixedBaseRoll(b, q), R, shape);
      const r = baseStatRange(b, t.statMult, R, 0, shape);
      const plain = baseStatRange(b, t.statMult, R);
      for (const st of ['minDamage', 'maxDamage'] as const) expect(r[st], `${b.id} ${t.id} ×${s} ${st}`).toEqual([val(at(0), st), val(at(1), st)]);
      const tag = `${b.id} ${t.id} ×${s}`;
      if (s < 1) {
        expect(r.minDamage![0], tag).toBeGreaterThanOrEqual(plain.minDamage![0]);
        expect(r.maxDamage![1], tag).toBeLessThanOrEqual(plain.maxDamage![1]);
      } else {
        expect(r.minDamage![0], tag).toBeLessThanOrEqual(plain.minDamage![0]);
        expect(r.maxDamage![1], tag).toBeGreaterThanOrEqual(plain.maxDamage![1]);
      }
      // Пол доводки поднимает низ вилки и с формой.
      expect(baseStatRange(b, t.statMult, R, 0.5, shape).maxDamage![0], tag).toBe(val(at(0.5), 'maxDamage'));
    }
  });
  it('inferTierId: вещь с формой клинка без поля tier читается СВОИМ тиром — и в середине, и на краях вилки', () => {
    for (const b of swords) for (const t of tiers) for (const s of [0.4, 1.6]) for (const q of [0, 0.5, 1]) {
      const baseRoll = fixedBaseRoll(b, q);
      const it = { baseStats: scaleBaseStats(b.baseStats, t.statMult, baseRoll, R, { spread: s }), itemLevel: 1, baseRoll, spreadMult: s };
      expect(inferTierId(tiers, b, it, R), `${b.id} ${t.id} ×${s} q=${q}`).toBe(t.id);
    }
  });
  it('bakedExtras: вклад деталей сверх базы — по паре (стат, вид) с вычёркиванием; правка базы после выпадения срез не сдвигает', () => {
    const base = [
      { stat: 'minDamage', kind: 'flat', value: 7 }, { stat: 'maxDamage', kind: 'flat', value: 13 },
      { stat: 'blockChance', kind: 'flat', value: 0.08 },
    ] as Parameters<typeof bakedExtras>[0];
    const item = [
      { stat: 'minDamage', kind: 'flat', value: 20 }, { stat: 'maxDamage', kind: 'flat', value: 30 },
      { stat: 'blockChance', kind: 'flat', value: 0.08 },
      { stat: 'attackSpeed', kind: 'flat', value: -0.05 }, { stat: 'blockChance', kind: 'flat', value: 0.01 }, { stat: 'bleedChancePct', kind: 'flat', value: -0.03 },
    ] as Parameters<typeof bakedExtras>[1];
    const want = item.slice(3);
    expect(bakedExtras(base, item)).toEqual(want);
    // В базу дописали стат, которого у старой вещи нет, — вклад всё равно тот же, а не «съехавший» на соседа.
    expect(bakedExtras([...base, { stat: 'accuracy', kind: 'flat', value: 12 }] as typeof base, item)).toEqual(want);
    expect(bakedExtras(base, item)[0]).not.toBe(item[3]); // копии, а не ссылки в вещь
  });
  it('retierItem держит форму клинка: числа нового тира вокруг той же формы; вклад деталей — от базы заново, не вычитанием', () => {
    const b = swords.find((x) => x.id === 'long-sword')!;
    const [lo, hi] = [tiers[0]!, tiers[3]!];
    const baseRoll = { minDamage: 0.8, maxDamage: 0.3 };
    const shape = { spread: 0.5 };
    const extras = [{ stat: 'attackSpeed', kind: 'flat', value: -0.05 }, { stat: 'blockChance', kind: 'flat', value: 0.01 }] as Parameters<typeof bakedExtras>[1];
    const item = { ...itemFromBase(b, tiers), tier: lo.id, baseRoll, spreadMult: 0.5, baseStats: [...scaleBaseStats(b.baseStats, lo.statMult, baseRoll, R, shape), ...extras] };
    const up = retierItem(b, item, hi, { spread: R });
    expect(up.spreadMult).toBe(0.5);
    expect(up.baseRoll).toEqual(baseRoll);
    // Статы — от базы, как у любой вещи: вклад деталей возвращает `upgradedItem` → `shapeFoundWeapon` от ДЕТАЛЕЙ.
    // Вычитание «что сверх базы» застревало бы навсегда, если базу правили после выпадения вещи.
    expect(up.baseStats).toEqual(scaleBaseStats(b.baseStats, hi.statMult, baseRoll, R, shape));
    // Обратный путь на исходный тир — числа базы исходного тира с той же формой: ничего не копится.
    expect(retierItem(b, up, lo, { spread: R }).baseStats).toEqual(scaleBaseStats(b.baseStats, lo.statMult, baseRoll, R, shape));
  });
});

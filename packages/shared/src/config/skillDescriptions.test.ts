import { describe, it, expect, beforeAll } from 'vitest';
import { ConfigRegistry } from './registry.js';
import { allStatKeys } from '../formulas/stats.js';
import { masteryModText } from '../views/townHero.js';

/**
 * ⭐⭐ ОПИСАНИЯ УЗЛОВ НЕ ВРУТ ЧИСЛАМИ (i18n Ф3, этап 2, 07.11).
 *
 * Перевод на английский поймал то, что читал и русский игрок: «+200% strength за ранг» у плоских +2 атрибута, «+1000% к мане»
 * у плоских +10, «+400% addFire», «Отбрасывает на 0» при 0.35, «+2%» при 1.5 % и «стоимость ×1.2» у вставок, цена которых давно
 * плоская (+2 ресурса скила). Генератор считал всё процентами, подпись брал «или сырой id», числа округлял до целых.
 *
 * Сторожим ДАННЫЕ, а не генератор: дерево правят и в редакторе (`POST /api/dev/config-file`), и описание там легко разойтись
 * с числом. Проверка не требует слово в слово совпасть с генератором — только чтобы каждый мод узла был назван СВОИМ числом
 * и своей подписью. Фразы берутся из того же модуля, что пишет генератор (`scripts/skillText.mjs`), — расходиться нечему.
 */
interface Mod { stat: string; kind: string; value: number }
interface SkillText {
  STAT_TEXT: Record<string, [string, 'frac' | 'abs']>;
  statText(stat: string): { label: string; unit: 'frac' | 'abs' };
  modAmount(stat: string, kind: string, value: number): string;
  modPhrase(m: Mod): string;
  num(x: number): string;
  plural(n: number, one: string, few: string, many: string): string;
  describeAbility(a: Record<string, unknown>): string;
  describePassive(mods: Mod[], fallback?: string): string;
}
// Модуль лежит вне `src` (его зовёт и голый node): грузим по URL, а не статическим импортом — иначе tsc потребует его в rootDir.
const TEXT_URL = new URL('../../../../scripts/skillText.mjs', import.meta.url).href;

let cfg: ConfigRegistry;
let T: SkillText;
beforeAll(async () => {
  cfg = new ConfigRegistry(); cfg.loadAll();
  T = (await import(/* @vite-ignore */ TEXT_URL)) as SkillText;
});

/** Число как отдельный токен: «10» не находится в «+1000%», «8%» — в «0.8%»; точка в конце фразы — не дробь. */
const token = (amount: string): string => `(?<![\\d.])${amount.replace(/[.%]/g, (c) => `\\${c}`)}(?!\\d|\\.\\d|%)`;
const hasAmount = (text: string, amount: string): boolean => new RegExp(token(amount)).test(text);

describe('текст генератора: род стата, подписи, числа', () => {
  it('у каждого стата игры есть подпись и род (иначе генератор упадёт на новом стате, а не напишет сырой id)', () => {
    const missing = allStatKeys().filter((k) => !T.STAT_TEXT[k]);
    expect(missing, 'добавь в STAT_TEXT (scripts/skillText.mjs)').toEqual([]);
    expect(() => T.statText('noSuchStat')).toThrow(/noSuchStat/);
  });

  it('плоский абсолют — число, доля и increased — проценты с десятой', () => {
    expect(T.modPhrase({ stat: 'strength', kind: 'flat', value: 2 })).toBe('+2 к силе');            // было «+200% strength»
    expect(T.modPhrase({ stat: 'maxMana', kind: 'flat', value: 10 })).toBe('+10 к мане');           // было «+1000% к мане»
    expect(T.modPhrase({ stat: 'addFire', kind: 'flat', value: 4 })).toBe('+4 урона огнём');        // было «+400% addFire»
    expect(T.modPhrase({ stat: 'critChance', kind: 'flat', value: 0.008 })).toBe('+0.8% к шансу крита');   // было «+1%»
    expect(T.modPhrase({ stat: 'attackSpeed', kind: 'increased', value: 0.015 })).toBe('+1.5% к скорости атаки');   // было «+2%»
    expect(T.modPhrase({ stat: 'minDamage', kind: 'increased', value: 0.02 })).toBe('+2% к мин. урону');   // было «+2% minDamage»
    expect(T.modPhrase({ stat: 'armor', kind: 'increased', value: -0.3 })).toBe('−30% к броне');
    expect(T.modPhrase({ stat: 'hpRegen', kind: 'flat', value: 0.3 })).toBe('+0.3 к регену HP');
  });

  it('отброс дробный не округляется в ноль; число по-русски согласовано', () => {
    expect(T.describeAbility({ category: 'attack', damageMult: 1.4, knockback: 0.35 })).toContain('Отбрасывает на 0.35.');
    expect(T.describeAbility({ category: 'attack', damageMult: 0.5, count: 5 })).toContain('5 снарядов веером');   // было «5 снаряда»
    expect(['1', '2', '4', '5', '11', '21', '22', '25'].map((n) => `${n} ${T.plural(+n, 'удар', 'удара', 'ударов')}`))
      .toEqual(['1 удар', '2 удара', '4 удара', '5 ударов', '11 ударов', '21 удар', '22 удара', '25 ударов']);
  });
});

describe('описания древа скилов и мастерства — своими числами', () => {
  const trees = (): Array<[string, { nodes: { id: string; name: string; description: string; effect: Record<string, unknown> }[] }]> =>
    [['skill-tree', cfg.get('skill-tree')], ['mastery-tree', cfg.get('mastery-tree')]];

  it('ни одного латинского слова в русском имени и описании (сырой id стата вроде «addFire», «minDamage»)', () => {
    const bad: string[] = [];
    for (const [t, tree] of trees()) {
      for (const n of tree.nodes) {
        for (const s of [n.name, n.description]) {
          const latin = (s.match(/[A-Za-z]+/g) ?? []).filter((w) => w !== 'HP');
          if (latin.length || /NaN|undefined|Infinity| {2}/.test(s)) bad.push(`${t}/${n.id}: «${s}»`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('каждый мод пассива и бафа назван своим числом и подписью (древо скилов)', () => {
    const bad: string[] = [];
    for (const n of cfg.get('skill-tree').nodes) {
      const mods = [...(n.effect.modifiers ?? []), ...(n.effect.active && 'buffMods' in n.effect.active ? n.effect.active.buffMods ?? [] : [])];
      for (const m of mods) {
        const phrase = T.modPhrase(m);
        if (!n.description.includes(phrase)) bad.push(`${n.id}: нет «${phrase}» в «${n.description}»`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('каждый мод узла мастерства назван своим числом (входы веера — тоже)', () => {
    const bad: string[] = [];
    for (const n of cfg.get('mastery-tree').nodes) {
      for (const m of n.effect.modifiers ?? []) {
        const amount = T.modAmount(m.stat, m.kind, m.value);
        if (!hasAmount(n.description, amount)) bad.push(`${n.id}: нет «${amount}» в «${n.description}»`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('число снарядов и ударов согласовано («5 снарядов», а не «5 снаряда»)', () => {
    const bad: string[] = [];
    for (const n of cfg.get('skill-tree').nodes) {
      for (const [, k, w] of n.description.matchAll(/(\d+) (снаряд\p{L}*|удар\p{L}*) (?:веером|подряд)/gu)) {
        const want = w!.startsWith('снаряд') ? T.plural(+k!, 'снаряд', 'снаряда', 'снарядов') : T.plural(+k!, 'удар', 'удара', 'ударов');
        if (w !== want) bad.push(`${n.id}: «${k} ${w}» — нужно «${k} ${want}»`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('строка модов подсказки мастерства — подписью стата и тем же числом, что в описании (было «+0.044000000000000004 physPct»)', () => {
    const bad: string[] = [];
    for (const n of cfg.get('mastery-tree').nodes) {
      for (const m of n.effect.modifiers ?? []) {
        const line = masteryModText(m);
        const want = `${m.value < 0 ? '−' : '+'}${T.modAmount(m.stat, m.kind, m.value)} `;
        if (!line.startsWith(want) || /[A-Za-z]/.test(line.replace(/\bHP\b/g, ''))) bad.push(`${n.id}: «${line}», ждали «${want}…»`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('отброс назван своим числом, а не округлён', () => {
    const bad: string[] = [];
    for (const n of cfg.get('skill-tree').nodes) {
      const a = n.effect.active as { knockback?: number } | undefined;
      if (!a?.knockback) continue;
      if (!new RegExp(`тбрасывает на ${token(T.num(a.knockback))}`).test(n.description)) bad.push(`${n.id}: ${a.knockback} → «${n.description}»`);
    }
    expect(bad).toEqual([]);
  });

  it('узел-вставка называет НЫНЕШНЮЮ цену вставки (плоскую, в её пуле), а не прежний множитель «стоимость ×»', () => {
    const bad: string[] = [];
    for (const n of cfg.get('skill-tree').nodes) {
      if (!n.effect.grantsInsert) continue;
      const ins = cfg.get('skill-inserts').find((i) => i.id === n.effect.grantsInsert)!;
      if (/стоимость ×/.test(n.description)) bad.push(`${n.id}: множитель цены, которого в данных нет — «${n.description}»`);
      if (ins.cost) {
        const amount = `${ins.cost < 0 ? '−' : '+'}${T.num(Math.abs(ins.cost))}`;
        const want = ins.costPool === 'carrier' ? `стоимость ${amount}` : `${amount} ${ins.costPool === 'mana' ? 'маны' : 'выносливости'}`;
        if (!n.description.includes(want)) bad.push(`${n.id}: нет «${want}» в «${n.description}»`);
      }
      if (ins.cooldownMult !== 1 && !n.description.includes(`откат ×${T.num(ins.cooldownMult)}`)) bad.push(`${n.id}: откат ×${ins.cooldownMult}`);
    }
    expect(bad).toEqual([]);
  });
});

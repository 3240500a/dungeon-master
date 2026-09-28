import { describe, it, expect, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { ConfigRegistry } from '../config/registry.js';
import { generateItem, itemFromBaseId } from '../formulas/itemgen.js';
import { createRng } from '../formulas/rng.js';
import { unmetWorn } from '../formulas/stats.js';
import { newCharacterSave } from './newCharacter.js';
import { equip, moveToBelt, unequip } from './townActions.js';
import type { Item } from '../types/items.js';

/**
 * ⭐ B2: ФАЗЗЕР ЭКОНОМИКИ. Вместо ручного обзора круг за кругом — случайные цепочки НАСТОЯЩИХ действий города по модели
 * аккаунта (два героя, общий сундук, лавка, доска, находки, живые правки конфига) с инвариантами целостности после каждого
 * шага: отказ ничего не трогает, числа целые и конечные, uid уникальны, золото/сырьё/вещи приходят только своими путями и ровно
 * по показанной цене, петли с прибылью нет, журнал кузнеца двигает только разбор годной находки и эскиз, сейв проходит схему.
 * Модель и инварианты — `fuzz/economyFuzz.ts`.
 *
 * Умолчание — постоянный набор сидов (быстро, в полном прогоне). Больше: `DM_FUZZ_SEEDS=2000` (сколько цепочек),
 * `DM_FUZZ_FROM` (первый сид), `DM_FUZZ_LEN` (шагов в цепочке), `DM_FUZZ_OUT` (JSON-сводка нарушений в файл).
 * Нарушение печатается сидом и СЖАТОЙ цепочкой (`shrink`): выброшено всё, без чего оно не воспроизводится.
 */

// uid вещей — счётчиком, а не временем и `Math.random` (`uuidv7`): детали найденного оружия выводятся из uid, и повтор цепочки
// при сжатии обязан собрать тот же мир байт в байт.
const uid = vi.hoisted(() => ({ n: 0 }));
vi.mock('../formulas/uuid.js', async (orig) => {
  const real = await orig<typeof import('../formulas/uuid.js')>();
  return { ...real, uuidv7: (): string => `00000000-0000-7000-8000-${(++uid.n).toString(16).padStart(12, '0')}` };
});

const { OP_WEIGHTS, genOps, runOps, shrink, violationKey } = await import('./fuzz/economyFuzz.js');
type Op = import('./fuzz/economyFuzz.js').Op;
type RunOut = import('./fuzz/economyFuzz.js').RunOut;

const env = (k: string, d: number): number => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? Math.floor(v) : d; };
const SEEDS = env('DM_FUZZ_SEEDS', 24);
const FROM = env('DM_FUZZ_FROM', 1);
const LEN = env('DM_FUZZ_LEN', 90);
const hooks = { resetUids: (): void => { uid.n = 0; } };
/**
 * Профиль весов шагов (`DM_FUZZ_PROFILE`): умолчание — город целиком; `forge` — кузница и живой конфиг чаще (ковка, разбор,
 * зачарование, подъём, перекатка, починка, эскиз, правки хозяина), остальное — фоном.
 */
const FORGE = new Set(['craft', 'enchant', 'sketch', 'forgeSalvage', 'fieldSalvage', 'upgrade', 'reroll', 'repair', 'lootMats', 'loot', 'config', 'clientSync', 'deposit']);
const WEIGHTS = process.env.DM_FUZZ_PROFILE === 'forge'
  ? Object.fromEntries(Object.entries(OP_WEIGHTS).map(([k, v]) => [k, FORGE.has(k) ? v * 3 : v]))
  : OP_WEIGHTS;

/**
 * ИЗВЕСТНЫЕ НАРУШЕНИЯ — найдены фаззером, ждут правки ядра (шаг «исправить»). Ключ — `инвариант:код:шаг` (`violationKey`) по
 * образцу, значение — id нарушения в отчёте (у каждого — своё воспроизведение `it.fails` ниже). После правки строку убрать и
 * `it.fails` сделать `it`: фаззер снова стережёт этот ключ.
 */
const KNOWN: [RegExp, string][] = [];
const knownId = (key: string): string | undefined => KNOWN.find(([re]) => re.test(key))?.[1];
/** `DM_FUZZ_ALL=1` — известные не пропускать: большой прогон печатает и их (свести с отчётом). */
const REPORT_KNOWN = !!process.env.DM_FUZZ_ALL;

interface Hit { seed: number; ops: Op[]; out: RunOut }

function report(key: string, h: Hit): string {
  const f = h.out.found!;
  return [
    `✗ ${key} — сид ${h.seed}, шагов в сжатой цепочке: ${h.ops.length}`,
    `  ${f.v.inv}/${f.v.code}: ${f.v.msg}`,
    `  цепочка: ${JSON.stringify(h.ops)}`,
    ...f.log.map((l) => `    ${l}`),
  ].join('\n');
}

type World = import('./fuzz/economyFuzz.js').FuzzWorld;
type Res = import('./fuzz/economyFuzz.js').Res;

/**
 * У СТОРОЖА ЕСТЬ ЗУБЫ: после шага подкладывается «баг» — и фаззер обязан поймать его ТЕМ инвариантом, что его стережёт.
 * Иначе зелёный прогон значил бы только «проверки ничего не видят».
 */
const BUGS: { name: string; want: string; bug: (w: World, op: Op, res: Res) => void }[] = [
  { name: 'продажа дала на 1 золото больше', want: 'I4:gold-delta:sell', bug: (w, op, res) => { if (op.k === 'sell' && res.ok) w.heroes[op.h].gold += 1; } },
  { name: 'покупка не взяла золота', want: 'I4:gold-delta:buy', bug: (w, op, res) => { if (op.k === 'buy' && res.ok) w.heroes[op.h].gold += 1_000_000; } },
  {
    name: 'ковка не списала сырьё', want: 'I4:mats-delta:craft',
    bug: (w, op, res) => { if (op.k === 'craft' && res.ok) { const m = w.stash.materials!; m['iron-1'] = (m['iron-1'] ?? 0) + 7; } },
  },
  { name: 'отказ тронул сейв', want: 'I1:refusal-mutates:sell', bug: (w, op, res) => { if (op.k === 'sell' && !res.ok) w.heroes[op.h].xp += 1; } },
  {
    name: 'перекладка в сундук задвоила вещь', want: 'I3:dup-uid:stashMove',
    bug: (w, op, res) => { if (op.k === 'stashMove' && res.ok) { const it = w.stash.tabs.flat()[0] ?? w.heroes[op.h].inventory[0]; if (it) w.heroes[op.h].inventory.push({ ...it }); } },
  },
  {
    name: 'надевание поправило вещь', want: 'I4:item-mutated:equip',
    bug: (w, op, res) => { if (op.k === 'equip' && res.ok) { const it = w.heroes[op.h].inventory.find((i) => i.kind !== 'material') ?? w.stash.tabs.flat()[0]; if (it) it.itemLevel += 1; } },
  },
  {
    name: 'разбор засчитал мифик', want: 'I6:journal:forgeSalvage',
    bug: (w, op, res) => { if (op.k === 'forgeSalvage' && res.ok && w.stash.forgeJournal) w.stash.forgeJournal = { ...w.stash.forgeJournal, mythic: w.stash.forgeJournal.mythic + 1 }; },
  },
  {
    name: 'подъём сделал вещь дороже, чем заплачено', want: 'I5:ledger:upgrade',
    bug: (w, op, res) => { if (op.k === 'upgrade' && res.ok) { const it = w.heroes[op.h].inventory.find((i) => i.tierForged); if (it) it.itemLevel += 5_000; } },
  },
  {
    name: 'добыча — дробный стек', want: 'I2:count:loot',
    bug: (w, op, res) => { if (op.k === 'loot' && res.ok) { const it = w.heroes[op.h].inventory.at(-1); if (it) it.count = 1.5; } },
  },
  // C-02: числа заданий — на доске и в журнале героя.
  { name: 'доска: награда задания с минусом', want: 'I2:quest-reward:restock', bug: (w, op, res) => { if (op.k === 'restock' && res.ok && w.board[0]) w.board[0].reward.gold = -450; } },
  {
    name: 'принятое задание: цель «0 из 0»', want: 'I2:quest-amount:acceptQuest',
    bug: (w, op, res) => { if (op.k === 'acceptQuest' && res.ok) { const o = w.heroes[op.h].activeQuestDefs.at(-1)?.objectives[0]; if (o) o.amount = 0; } },
  },
  // C-13: цель, которую игра не считает («talk-npc» — схема её пускала), — задание не закрыть никогда.
  {
    name: 'доска: цель, которую игра не считает', want: 'I2:quest-untracked:restock',
    bug: (w, op, res) => { const o = op.k === 'restock' && res.ok ? w.board[0]?.objectives[0] : undefined; if (o) o.type = 'talk-npc' as typeof o.type; },
  },
];

/** Воспроизведение известного нарушения: `it.fails`, пока не поправлено; `DM_FUZZ_SHOW_KNOWN=1` — обычный `it` (показать, как падает). */
const itKnown = process.env.DM_FUZZ_SHOW_KNOWN ? it : it.fails;

describe('⭐ B2: у сторожа есть зубы — подложенный баг ловится своим инвариантом', () => {
  for (const b of BUGS) {
    it(b.name, () => {
      const got = new Set<string>();
      for (let seed = 1; seed <= 40 && !got.has(b.want); seed++) {
        const out = runOps(seed, genOps(seed, 90), { ...hooks, afterRun: b.bug }, b.want);
        if (out.found) got.add(violationKey(out.found));
      }
      expect([...got], `ждали ${b.want}`).toContain(b.want);
    });
  }
});

describe('⭐ B2: фаззер экономики — инварианты целостности после каждого шага', () => {
  it(`${SEEDS} цепочек по ${LEN} шагов (сиды ${FROM}…${FROM + SEEDS - 1}): ни одного нарушения, кроме известных`, () => {
    const found = new Map<string, Hit>();
    const initHits = new Map<string, { seed: number; msg: string }>();
    const stats: Record<string, { ok: number; no: number; why: Record<string, number> }> = {};
    let crashes = 0;
    for (let seed = FROM; seed < FROM + SEEDS; seed++) {
      const ops = genOps(seed, LEN, WEIGHTS);
      // Нарушение останавливает цепочку — повторяем её мимо уже найденных ключей, пока она не пройдёт до конца: одно частое
      // нарушение не должно заслонять редкие дальше по той же цепочке.
      const skip = new Set(found.keys());
      for (let pass = 0; pass < 8; pass++) {
        const out = runOps(seed, ops, hooks, undefined, (k) => skip.has(k) || (!REPORT_KNOWN && !!knownId(k)));
        if (pass === 0) {
          for (const v of out.init) { const k = `${v.inv}:${v.code}:init`; if (!initHits.has(k)) initHits.set(k, { seed, msg: v.msg }); }
          for (const [k, v] of Object.entries(out.stats)) {
            const t = (stats[k] ??= { ok: 0, no: 0, why: {} });
            t.ok += v.ok; t.no += v.no;
            for (const [r, n] of Object.entries(v.why)) t.why[r] = (t.why[r] ?? 0) + n;
          }
        }
        if (!out.found) break;
        if (out.found.v.inv === 'crash') crashes++;
        const key = violationKey(out.found);
        const had = found.get(key);
        // Копим по ключу кратчайшую цепочку-кандидата: сжимать дешевле.
        if (!had || out.found.at < had.out.found!.at) found.set(key, { seed, ops, out });
        skip.add(key);
      }
    }
    const shrunk = new Map<string, Hit>();
    for (const [key, h] of found) {
      const s = shrink(h.seed, h.ops, key, hooks);
      shrunk.set(key, { seed: h.seed, ops: s.ops, out: s.out.found ? s.out : h.out });
    }
    const lines = [
      ...[...initHits].filter(([k]) => REPORT_KNOWN || !knownId(k)).map(([k, h]) => `✗ ${k} — стартовое состояние сида ${h.seed} (законная история, до первого шага)\n  ${h.msg}`),
      ...[...shrunk].map(([k, h]) => report(k, h)),
    ];
    if (lines.length) console.log(lines.join('\n\n'));
    if (process.env.DM_FUZZ_VERBOSE) {
      for (const [k, v] of Object.entries(stats).sort()) {
        const why = Object.entries(v.why).sort((a, b) => b[1] - a[1]).slice(0, process.env.DM_FUZZ_VERBOSE === '2' ? 16 : 4).map(([r, n]) => `${n}×${r}`).join(' | ');
        console.log(`${k.padEnd(15)} ок ${String(v.ok).padStart(5)}  отказ ${String(v.no).padStart(5)}  ${why}`);
      }
    }
    if (process.env.DM_FUZZ_OUT) {
      writeFileSync(process.env.DM_FUZZ_OUT, JSON.stringify({
        from: FROM, seeds: SEEDS, len: LEN, crashes, stats,
        init: [...initHits].map(([k, h]) => ({ key: k, ...h })),
        found: [...shrunk].map(([k, h]) => ({ key: k, seed: h.seed, ops: h.ops, v: h.out.found!.v, log: h.out.found!.log })),
      }, null, 1));
    }
    // Шаги действительно исполняются, а не отказывают все подряд (иначе фаззер стерёг бы пустоту).
    for (const k of ['buy', 'sell', 'craft', 'forgeSalvage', 'stashMove', 'equip', 'upgrade'] as const) {
      if (SEEDS >= 20) expect(stats[k]?.ok ?? 0, `успешных «${k}» за прогон`).toBeGreaterThan(0);
    }
    const unknown = [...initHits.keys(), ...shrunk.keys()].filter((k) => !knownId(k));
    expect(unknown, lines.join('\n\n')).toEqual([]);
  }, Math.max(600_000, SEEDS * LEN * 20));   // большой прогон — потолок по числу шагов (итог печатается только в конце)
});

/**
 * ⚠ C-02: ПРАВКА ЗАДАНИЙ ЖИВЬЁМ — свой профиль весов: конфиг, доска, приём, прогресс и сдача чаще прочего. Хозяин правит вилки
 * доски и награды цепочки, в том числе с опечатками (минус, дробь, ноль целей, перевёрнутая вилка): негодное обязана отвергнуть
 * схема, пропущенное ловят числа заданий и героя (I2). В общем профиле правка заданий — одна из сотен шагов, и до правки схемы
 * «цель 0 из 0» и «награду −450» он находил раз на полсотни цепочек; этот — в первых же. ⚠ C-13: и тип цели — из схемы, «talk-npc»
 * и мусор: цель, которую игра не считает, схема обязана отвергнуть (со схемой, пускавшей «talk-npc», — 3 цепочки из 24, и одна из
 * них — вставшая цепочка основных заданий).
 */
describe('⚠ C-02: фаззер — правка заданий живьём', () => {
  type OpKind = import('./fuzz/economyFuzz.js').OpKind;
  const QUESTS: Partial<Record<OpKind, number>> = {
    config: 12, restock: 5, acceptQuest: 8, questProgress: 8, turnIn: 8, ensureMain: 2, clientSync: 1, gold: 1, xp: 2, allocSkill: 1, respecSkills: 1, death: 1,
  };
  it('24 цепочки по 60 шагов: ни одного нарушения; правки заданий и проходили, и отвергались схемой', () => {
    const hits: string[] = [];
    let accepted = 0, refused = 0, turnedIn = 0, typeRefused = 0;
    for (let seed = 1; seed <= 24; seed++) {
      const out = runOps(seed, genOps(seed, 60, QUESTS), hooks, undefined, (k) => !REPORT_KNOWN && !!knownId(k));
      if (out.found) hits.push(`✗ ${violationKey(out.found)} — сид ${seed}: ${out.found.v.msg}\n    ${out.found.log.slice(-8).join('\n    ')}`);
      for (const l of out.log) if (l.includes('конфиг: задания:')) { if (l.includes('отказ схемы')) refused++; else accepted++; if (/type → (talk-npc|open-chest) — отказ схемы/i.test(l)) typeRefused++; }
      turnedIn += out.stats.turnIn?.ok ?? 0;
    }
    expect(hits, hits.join('\n\n')).toEqual([]);
    expect(refused, 'опечатки доходят до схемы').toBeGreaterThan(0);
    expect(typeRefused, 'C-13: цель, которую игра не считает («talk-npc»), схема отвергает').toBeGreaterThan(0);
    expect(accepted, 'годные правки проходят').toBeGreaterThan(0);
    expect(turnedIn, 'задания сдаются').toBeGreaterThan(0);
  });
});

/**
 * НАЙДЕННОЕ ФАЗЗЕРОМ — МИНИМАЛЬНЫЕ ВОСПРОИЗВЕДЕНИЯ (`it.fails`, пока ядро не поправлено; id — как в `KNOWN` и в отчёте). Каждое
 * утверждает ПРАВИЛЬНОЕ поведение: после правки тест начнёт проходить, `it.fails` его провалит — снять метку и строку `KNOWN`.
 * Поправленные (V-B2-01, V-B2-02, V-B2-03) остаются здесь обычными `it` — сторожами регресса.
 */
describe('B2: нарушения, найденные фаззером (до правки ядра)', () => {
  const reg = new ConfigRegistry();
  reg.loadAll();

  // I1. ✅ ПОПРАВЛЕНО: `moveToBelt` добивал пояс пустыми ячейками ДО проверок — отказ («Предмет не в инвентаре», «Не расходник»,
  // «Пояс полон») менял сейв. Теперь сперва проверки, пояс добивается только перед укладкой. Сторож регресса.
  it('V-B2-01: отказ «в пояс» не трогает сейв (пояс не добивается ячейками до проверок)', () => {
    const s = newCharacterSave(reg, 'warrior', 'Ф', 'v-b2-01');
    const cap = s.equipment.belt?.beltSlots ?? 0;
    expect(cap, 'на герое пояс с ячейками').toBeGreaterThan(0);
    s.belt = [];
    const refused = (uid: string, why: string): void => {
      const before = JSON.stringify(s);
      const r = moveToBelt(s, uid);
      expect(r, why).toEqual({ ok: false, reason: why });
      expect(JSON.stringify(s), `отказ «${why}» изменил сейв`).toBe(before);
    };
    refused('нет-такой-вещи', 'Предмет не в инвентаре');
    const gear: Item = { ...s.equipment.weapon!, uid: 'v-b2-01-gear', pos: null };
    s.inventory.push(gear);
    refused(gear.uid, 'Не расходник');
    // Честный путь не изменился: колба ложится в первую ячейку, пояс добит до ёмкости.
    const potion = (n: string): Item => ({ ...itemFromBaseId(reg.get('items.base'), 'minor-healing-potion')!, uid: `v-b2-01-${n}`, pos: null });
    s.inventory.push(potion('a'));
    expect(moveToBelt(s, 'v-b2-01-a')).toEqual({ ok: true });
    expect(s.belt.map((x) => x?.uid ?? null)).toEqual(['v-b2-01-a', ...Array<null>(cap - 1).fill(null)]);
    expect(s.inventory.some((i) => i.uid === 'v-b2-01-a'), 'колба ушла из сумки').toBe(false);
    // Пояс полон — отказ, сейв тот же; ячейка ЗА ёмкостью (старый сейв длиннее пояса) — не место, колба туда не ляжет.
    s.belt = s.belt.map((x, i) => x ?? potion(`fill-${i}`));
    s.belt.push(null);
    s.inventory.push(potion('extra'));
    refused('v-b2-01-extra', 'Пояс полон');
  });

  // ✅ ПОПРАВЛЕНО: правило R4-08 «требования держатся всё время ношения» стартовый комплект нарушал с первой секунды — пять классов
  // из семи были надеты в оружие, которое сами надеть не могут; снял — обратно не надеть. Теперь вещь комплекта выдаётся по руке
  // классу (`fitToClass` в `newCharacter.ts`); правки хозяина и замену выключенной базы стережёт `starterKit.test.ts`. Сторож регресса.
  it('V-B2-02: стартовое оружие каждого класса герой держит своими атрибутами (снял — надел обратно)', () => {
    const bad: string[] = [];
    for (const c of reg.get('classes').filter((x) => x.enabled !== false)) {
      const s = newCharacterSave(reg, c.id, 'Ф', `v-b2-02-${c.id}`);
      const w = s.equipment.weapon;
      const unmet = unmetWorn(s.attributes, Object.values(s.equipment).filter(Boolean) as Item[]);
      if (unmet.length) bad.push(`${c.id}: ${unmet.map((i) => `${i.baseId} ${JSON.stringify(i.requirements)}`).join(', ')} при ${JSON.stringify(s.attributes)}`);
      if (w && unequip(reg, s, 'weapon').ok && !equip(reg, s, w.uid).ok) bad.push(`${c.id}: снятое стартовое оружие обратно не надеть`);
    }
    expect(bad).toEqual([]);
  });

  // ✅ ПОПРАВЛЕНО: потолок суммы требований (`balance.maxTotalRequirement`) держался по доле, а округление — по атрибуту:
  // 66.5 + 123.5 → 67 + 124 = 191. Теперь ужатые доли округляются наибольшим остатком (`scaleReqs`). Сторож регресса.
  it('V-B2-03: сумма требований любой вещи не выше balance.maxTotalRequirement', () => {
    const cap = reg.get('balance').maxTotalRequirement;
    const over: string[] = [];
    for (const b of reg.get('items.base').filter((x) => x.kind !== 'consumable' && x.enabled !== false)) {
      const it = generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'), {
        dropBias: 1, itemLevel: 95, tierLevel: 95, baseId: b.id, tiers: reg.get('item-tiers'), rarities: reg.get('rarities'),
        forceRarity: 'normal', maxReqTotal: cap,
      }, createRng(1));
      const sum = Object.values(it.requirements).reduce<number>((n, v) => n + (v ?? 0), 0);
      if (sum > cap) over.push(`${b.id} ${it.tier}: ${JSON.stringify(it.requirements)} = ${sum}`);
    }
    expect(over).toEqual([]);
  });
});

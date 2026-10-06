import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { defaultConfigData } from '../config/defaults.js';
import type { ConfigShapes } from '../config/schemas.js';
import { baseTierRange, craftTiers, craftWeapon, keyVariantsByBase, shapeFoundWeapon, variantsFor, type CraftInput } from '../formulas/craft.js';
import { CRAFT_SLOT_LIST, keySlotOf } from '../formulas/craftType.js';
import { generateItem } from '../formulas/itemgen.js';
import { createRng } from '../formulas/rng.js';
import type { SalvageRng } from '../formulas/salvage.js';
import { newBotSave } from '../sim/playerBot.js';
import { parseTownCommand } from '../session/netSchemas.js';
import { carriedMaterials } from './materials.js';
import { emptyStash } from './stashActions.js';
import { fieldSalvage, forgeSalvage, salvageMean, salvageRange, salvageYield } from './townActions.js';
import type { CraftParts, Item, Rarity } from '../types/items.js';
import type { SaveState } from '../types/save.js';

/**
 * ⚠ R9-03 / R9-04: РАЗБОР — ОДИН БРОСОК, И СОГЛАСИЕ ВИДИТ ПРАВКУ ДОЛИ.
 *
 * R9-03: отказ «Разбор ничего не дал бы» решался ПОСЛЕ броска выхода и оставлял вещь в сумке, а следующий клик катал
 * заново (`townRng()` на команду). Пояс в поле (2–3 × 0.4 × 0.3 = 0.24–0.36) отказывал в 70 % бросков — «жми, пока не
 * выйдет» давало ровно единицу вместо трети: правило «поле — 30 % от кузницы» (docs/ECONOMY.md) не держалось. Теперь отказ —
 * только когда вещь не дала бы ничего и при ЛУЧШЕМ броске; пустой бросок разбирает вещь в ничто (вилка «0–1» это и обещала).
 *
 * R9-04: вилка «от–до» у таких вещей была пустой (низ — пустой бросок), и согласие `minYield` уходило `{}`; а низ дробной
 * доли — 0 при любой правке. Правка `fieldYield` живьём резала выход вшестеро — без «Цена изменилась». Теперь карточка шлёт
 * ещё и СРЕДНИЙ выход (`avgYield`), который она показала: меньше по любому материалу — отказ, вещь цела.
 */

type Data = Record<string, unknown> & typeof defaultConfigData;
type Bal = { salvage: { fieldYield: number; armorSlotMult: Record<string, number> } };
function regWith(patch: (d: Data) => void = () => {}): ConfigRegistry {
  const d = structuredClone(defaultConfigData) as Data;
  patch(d);
  const r = new ConfigRegistry();
  r.loadAll(d);
  return r;
}
const reg = regWith();
type Base = ConfigShapes['items.base'][number];
const tiers = craftTiers(reg);
/** Лучший бросок — как `ROLL_HI` ядра: кубик на верх, доля округляется вверх, если она есть. */
const HI: SalvageRng = { int: (_a, b) => b, chance: (p) => p > 1e-9 };
const LO: SalvageRng = { int: (a) => a, chance: () => false };

/** Находка с пола: дроп-генератор + форма найденного оружия, как у сессии. */
function foundItem(r: ConfigRegistry, baseId: string, rarity: Rarity, seed = 31, uid = 'sr-item'): Item {
  const base = r.get('items.base').find((b) => b.id === baseId)!;
  const { lo } = baseTierRange(r, base);
  const t = craftTiers(r)[lo]!;
  const it = shapeFoundWeapon(r, generateItem(r.get('items.base'), r.get('affixes'), r.get('uniques'), {
    dropBias: 1.3, itemLevel: t.minItemLevel + 5, tierLevel: t.minItemLevel, baseId, tiers: r.get('item-tiers'), rarities: r.get('rarities'),
    rareNames: r.get('rare-names'), forceRarity: rarity, maxReqTotal: r.get('balance').maxTotalRequirement,
    baseRoll: r.get('balance').loot.baseRoll, origin: 'drop',
  }, createRng(seed)));
  return { ...it, uid, pos: { x: 0, y: 0 } };
}

/** Скованный меч ступени `step` — у него переплавка (`melt`). */
function forged(step: number): Item {
  const keySlot = keySlotOf(reg, 'sword');
  const group = keyVariantsByBase(reg, 'sword', 1).find((g) => g.variants.some((p) => p.stepMin <= step && step <= p.stepMax))!;
  const parts = {} as CraftParts;
  for (const slot of CRAFT_SLOT_LIST) {
    const pool = slot === keySlot ? group.variants : variantsFor(reg, 'sword', slot, 1);
    const p = pool.find((v) => v.stepMin <= step && step <= v.stepMax)!;
    parts[slot] = { id: p.id, step };
  }
  const input: CraftInput = { weaponClass: 'sword', hands: 1, parts };
  return { ...craftWeapon(reg, input, { rng: createRng(5) }).item!, uid: 'sr-item', pos: { x: 0, y: 0 } };
}

/** Разбираемые вещи: каждая включённая база × редкость (найденные) и скованные мечи. */
function samples(): { it: Item; label: string }[] {
  const out: { it: Item; label: string }[] = [];
  const bases = reg.get('items.base').filter((b: Base) => b.kind !== 'consumable' && b.enabled !== false);
  let seed = 1;
  for (const base of bases) {
    for (const rarity of ['normal', 'magic', 'rare'] as const) {
      const it = foundItem(reg, base.id, rarity, seed++);
      if (it.rarity !== 'unique') out.push({ it, label: `${base.id} ${rarity}` });
    }
  }
  for (const step of [1, 3, 5]) out.push({ it: forged(step), label: `меч скованный ${step}` });
  return out;
}

const units = (s: SaveState): number => Object.values(carriedMaterials(s.inventory)).reduce((a, b) => a + b, 0);
const heroWith = (r: ConfigRegistry, it: Item): SaveState => { const s = newBotSave(r, r.get('classes')[0]!.id); s.inventory = [{ ...it }]; return s; };
const inBag = (s: SaveState, uid: string): boolean => s.inventory.some((i) => i.uid === uid);

describe('⚠ R9-03: отказ разбора не зависит от броска — повтор не перекатывает выход', () => {
  it('⭐ каждая база × редкость × {поле, кузница}: бросок либо всегда разбирает, либо всегда отказывает', () => {
    const bad: string[] = [];
    let checked = 0;
    for (const { it, label } of samples()) {
      for (const inField of [true, false]) {
        const hi = salvageYield(reg, it, HI, inField).ok;
        const rolls: SalvageRng[] = [LO, ...Array.from({ length: 40 }, (_, k) => createRng(1000 + k))];
        for (const [k, rng] of rolls.entries()) {
          const got = salvageYield(reg, it, rng, inField);
          if (got.ok !== hi) { bad.push(`${label} ${inField ? 'поле' : 'кузница'} бросок ${k}: ${got.ok ? 'разбор' : got.reason} при лучшем «${hi ? 'разбор' : 'отказ'}»`); break; }
        }
        checked++;
      }
    }
    expect(bad, bad.slice(0, 12).join('\n')).toEqual([]);
    expect(checked, 'сторож видит и находки, и скованное, и оба места').toBeGreaterThan(400);
  });

  it('⭐ пояс в поле: «жми, пока не выйдет» даёт треть единицы, а не единицу — вещь уходит с ПЕРВОГО клика', () => {
    let got = 0, extra = 0;
    const N = 600;
    for (let k = 0; k < N; k++) {
      const s = heroWith(reg, foundItem(reg, 'leather-belt', 'normal', 7, `belt-${k}`));
      const u0 = units(s);
      // Честный клиент без согласия и изменённый — одно и то же: повтор — новый `townRng()` на команду.
      for (let click = 0; click < 50 && inBag(s, `belt-${k}`); click++) {
        const r = fieldSalvage(reg, s, `belt-${k}`, createRng(k * 97 + click + 1));
        if (click > 0) extra++;
        if (!r.ok) expect(r.reason, 'отказ — только «ничего не дал бы»').toBe('Разбор ничего не дал бы');
      }
      expect(inBag(s, `belt-${k}`), 'вещь разобрана').toBe(false);
      got += units(s) - u0;
    }
    expect(extra, 'было: 70 % поясов отказывали и перекатывались повтором').toBe(0);
    // Замысел: (2..3) × 0.4 × 0.3 = 0.3 в среднем. Было 1.00 ровно — повтор снимал все пустые броски.
    expect(got / N).toBeGreaterThan(0.2);
    expect(got / N).toBeLessThan(0.4);
  });

  it('пояс у кузнеца: пустой бросок (10 %) тоже разбирает — повтором средний выход не поднять выше замысла', () => {
    let got = 0;
    const N = 600;
    for (let k = 0; k < N; k++) {
      const s = heroWith(reg, foundItem(reg, 'leather-belt', 'normal', 7, `belt-${k}`));
      const st = emptyStash(reg);
      const r = forgeSalvage(reg, s, st, `belt-${k}`, createRng(k * 131 + 3));
      expect(r.ok, `пояс ${k}: ${r.reason}`).toBe(true);
      expect(inBag(s, `belt-${k}`)).toBe(false);
      got += units(s) + Object.values(st.materials ?? {}).reduce((a, b) => a + b, 0);   // сумка была — один пояс
    }
    // Замысел — среднее правила × 0.4: кожа (2..3) × 0.4 = 1.0 и побочный китовый ус (0..1) × 0.4 = 0.2 (рецензия 06.10: Плечи не только с
    // луков). Было +0.11 сверх замысла — повтор снимал пустые броски.
    const rule = reg.get('salvage-rules').find((r) => r.id === 'a-leather')!;
    const design = rule.yields.reduce((a, y) => a + (y.min + y.max) / 2, 0) * reg.get('balance').salvage.armorSlotMult.belt;
    expect(got / N).toBeGreaterThan(design - 0.08);
    expect(got / N).toBeLessThan(design + 0.08);
  });

  it('вещь, которой и лучший бросок не дал бы ничего, — отказ по-прежнему, и вещь цела', () => {
    // Правило кожаной брони «0–0»: ни один бросок ничего не даст.
    const zero = regWith((d) => {
      for (const rule of d['salvage-rules'] as { id: string; yields: { min: number; max: number }[] }[]) {
        if (rule.id === 'a-leather') for (const y of rule.yields) { y.min = 0; y.max = 0; }
      }
    });
    const s = heroWith(zero, foundItem(zero, 'leather-belt', 'normal', 7));
    const snap = JSON.stringify(s);
    const r = fieldSalvage(zero, s, 'sr-item', createRng(1));
    expect(r).toEqual({ ok: false, reason: 'Разбор ничего не дал бы' });
    expect(JSON.stringify(s)).toBe(snap);
    expect(salvageRange(zero, s.inventory[0]!, true)).toMatchObject({ ok: false, range: {} });
  });
});

describe('⚠ R9-04: согласие на выход разбора видит правку доли', () => {
  const belt = foundItem(reg, 'leather-belt', 'normal', 7);
  const sword = foundItem(reg, 'long-sword', 'normal', 11);
  const gloves = foundItem(reg, 'leather-gloves', 'normal', 13);
  /** Согласие так, как его шлёт клиент: низ вилки и средний выход по СВОЕМУ конфигу. */
  const consentOf = (r: ConfigRegistry, it: Item, inField: boolean): { minYield: Record<string, number>; avgYield: Record<string, number> } => ({
    minYield: Object.fromEntries(Object.entries(salvageRange(r, it, inField).range).map(([id, v]) => [id, v.min])),
    avgYield: salvageMean(r, it, inField)!,
  });

  it('⭐ вилка мелкой вещи в поле — «0–1», а не пустая: пояс, перчатки; у кузнеца — «0–2»', () => {
    // Кожаная броня даёт и побочные Плечи (китовый ус, «0–1» в правиле): у мелкой вещи — «0–1» и у кузнеца, и в поле.
    expect(salvageRange(reg, belt, true)).toEqual({ ok: true, range: { 'hide-1': { min: 0, max: 1 }, 'stave-1': { min: 0, max: 1 } } });
    expect(salvageRange(reg, gloves, true)).toEqual({ ok: true, range: { 'hide-1': { min: 0, max: 1 }, 'stave-1': { min: 0, max: 1 } } });
    expect(salvageRange(reg, belt, false)).toEqual({ ok: true, range: { 'hide-1': { min: 0, max: 2 }, 'stave-1': { min: 0, max: 1 } } });
    const sw = salvageRange(reg, sword, true);
    expect(sw.ok).toBe(true);
    expect(Object.keys(sw.range).length, 'у обычного меча в поле вилка по каждой детали').toBeGreaterThan(0);
    for (const v of Object.values(sw.range)) expect(v.min).toBe(0);
  });

  it('⭐ средний выход — ожидание НАСТОЯЩЕГО броска (сверка с тысячами бросков)', () => {
    for (const [it, inField, label] of [[belt, true, 'пояс поле'], [belt, false, 'пояс кузница'], [sword, true, 'меч поле'], [sword, false, 'меч кузница'], [forged(3), true, 'скованный поле']] as const) {
      const mean = salvageMean(reg, it, inField)!;
      expect(mean, label).toBeTruthy();
      const rng = createRng(4242);
      const N = 20_000;
      const sum: Record<string, number> = {};
      for (let i = 0; i < N; i++) for (const [id, n] of Object.entries(salvageYield(reg, it, rng, inField).gains)) sum[id] = (sum[id] ?? 0) + n;
      for (const id of new Set([...Object.keys(mean), ...Object.keys(sum)])) {
        expect(Math.abs((sum[id] ?? 0) / N - (mean[id] ?? 0)), `${label} ${id}`).toBeLessThan(0.03);
      }
    }
    expect(salvageMean(reg, belt, true)!['hide-1']).toBeCloseTo(0.3, 9);
    expect(salvageMean(reg, belt, false)!['hide-1']).toBeCloseTo(1.0, 9);
  });

  it('⭐ правка `fieldYield` 0.3 → 0.05 живьём: меч и пояс в поле по согласию старой карточки — «Цена изменилась», вещь цела', () => {
    const lean = regWith((d) => { (d.balance as unknown as Bal).salvage.fieldYield = 0.05; });
    for (const it of [sword, belt]) {
      const shown = consentOf(reg, it, true);
      const s = heroWith(lean, it);
      const snap = JSON.stringify(s);
      const r = fieldSalvage(lean, s, it.uid, createRng(1), shown.minYield, shown.avgYield);
      expect(r.ok, `${it.baseId}: было — разбор за шестую часть обещанного`).toBe(false);
      expect(r.reason).toMatch(/^Цена изменилась: /);
      expect(JSON.stringify(s), 'отказ — до разбора').toBe(snap);
      const now = consentOf(lean, it, true);
      expect(fieldSalvage(lean, s, it.uid, createRng(1), now.minYield, now.avgYield).ok, `${it.baseId}: по новой карточке`).toBe(true);
    }
  });

  it('⭐ правка `armorSlotMult` перчаток и пояса у кузнеца — отказ по старой карточке; по новой — разбор', () => {
    const lean = regWith((d) => { const m = (d.balance as unknown as Bal).salvage.armorSlotMult; m.gloves = 0.1; m.belt = 0.1; });
    for (const it of [gloves, belt]) {
      const shown = consentOf(reg, it, false);
      const s = heroWith(lean, it);
      const st = emptyStash(lean);
      const snap = JSON.stringify([s, st]);
      const r = forgeSalvage(lean, s, st, it.uid, createRng(1), shown.minYield, shown.avgYield);
      expect(r.ok, `${it.baseId}: было — молча меньше`).toBe(false);
      expect(r.reason).toMatch(/^Цена изменилась: /);
      expect(JSON.stringify([s, st])).toBe(snap);
      const now = consentOf(lean, it, false);
      expect(forgeSalvage(lean, s, st, it.uid, createRng(1), now.minYield, now.avgYield).ok).toBe(true);
    }
  });

  it('тот же конфиг — не отказ; выход больше показанного — не отказ; без поля (Unity) — как раньше; кривое — отказ', () => {
    const rich = regWith((d) => { (d.balance as unknown as Bal).salvage.fieldYield = 0.6; });
    for (const [r, label] of [[reg, 'тот же'], [rich, 'щедрее']] as const) {
      const shown = consentOf(reg, belt, true);
      const s = heroWith(r, belt);
      expect(fieldSalvage(r, s, belt.uid, createRng(2), shown.minYield, shown.avgYield).ok, label).toBe(true);
    }
    expect(fieldSalvage(reg, heroWith(reg, belt), belt.uid, createRng(2)).ok, 'без согласия').toBe(true);
    for (const bad of [{ 'hide-1': Number.NaN }, { 'hide-1': -0.1 }, { 'hide-1': Number.POSITIVE_INFINITY }]) {
      const s = heroWith(reg, belt);
      expect(fieldSalvage(reg, s, belt.uid, createRng(2), undefined, bad).ok, JSON.stringify(bad)).toBe(false);
      expect(inBag(s, belt.uid)).toBe(true);
    }
  });

  it('на проводе: `avgYield` — у разборов, дробное ≥ 0; чужим командам и кривому — отказ схемы', () => {
    for (const c of [{ cmd: 'forgeSalvage', uid: 'u' }, { cmd: 'salvage', uid: 'u' }]) {
      expect(parseTownCommand({ ...c, avgYield: { 'hide-1': 0.3, 'iron-1': 2 } }).ok, c.cmd).toBe(true);
      expect(parseTownCommand({ ...c, minYield: { 'hide-1': 0 }, avgYield: {} }).ok, c.cmd).toBe(true);
      for (const bad of [{ 'hide-1': -0.1 }, { 'hide-1': '0.3' }, [0.3], 'x', null]) {
        expect(parseTownCommand({ ...c, avgYield: bad }).ok, `${c.cmd} ${JSON.stringify(bad)}`).toBe(false);
      }
    }
    expect(parseTownCommand({ cmd: 'forgeUpgrade', uid: 'u', avgYield: { 'hide-1': 0.3 } }).ok, 'чужая команда').toBe(false);
    const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`m-${i}`, 0.5]));
    expect(parseTownCommand({ cmd: 'salvage', uid: 'u', avgYield: many }).ok, 'раздутый словарь').toBe(false);
  });
});

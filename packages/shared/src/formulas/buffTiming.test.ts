import { describe, it, expect, afterEach } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { configCrossIssues, type ConfigShapes } from '../config/schemas.js';
import { upgradeStoredOverride } from '../config/storedOverride.js';
import { abilityCooldown } from './combat.js';
import {
  buffNodeCooldown, buffRestFloor, buffTimingIssues, buffTimingOk, buffUptimeBound, clampBuffCooldown, insertCooldownMult, insertGain,
  setBuffTimingWarn,
} from './buffTiming.js';

/**
 * ⭐ D4: ОДНО ПРАВИЛО ВРЕМЕНИ БАФФА — откат на КАЖДОМ ранге не короче действия с отдыхом (`balance.buffMinRest`). Здесь — само правило,
 * схема поверх таблиц (реестр не пускает нарушение, всё или ничего), приведение старых оверрайдов и зажим ядра со строкой в лог.
 * Ядро и фаззер — `session/session.test.ts`, `session/rulesFuzz.test.ts`; переходы комнаты — `server/net/room.d4server.test.ts`.
 */
function reg(): ConfigRegistry {
  const r = new ConfigRegistry();
  r.loadAll();
  return r;
}
const tables = (r: ConfigRegistry): Parameters<typeof buffTimingIssues>[0] =>
  ({ balance: r.get('balance'), 'skill-tree': r.get('skill-tree'), 'skill-inserts': r.get('skill-inserts') });
type Tree = ConfigShapes['skill-tree'];
type Buff = { cooldown: number; durationSec: number };
const buffOf = (t: Tree, id: string): Buff => t.nodes.find((n) => n.id === id)!.effect.active as unknown as Buff;
const nodeOf = (t: Tree, id: string): Tree['nodes'][number] => t.nodes.find((n) => n.id === id)!;
const WARCRY = 'b-class-warrior-a5';
const CHARM = 'b-class-vorozheya-a1';

let restore: ((l: string) => void) | undefined;
afterEach(() => { if (restore) setBuffTimingWarn(restore); restore = undefined; });

describe('⭐ D4: правило времени баффа — формулы', () => {
  it('пол отката — действие с отдыхом, в сотых вверх; потолок доли времени — 1 / (1 + отдых)', () => {
    expect(buffRestFloor(8, 0.25)).toBe(10);
    expect(buffRestFloor(4 * insertGain(0.12, 10), 0.25), 'хвост плавающей точки не уводит вверх на сотую').toBe(10.4);
    expect(buffRestFloor(10.001, 0.25)).toBe(12.51);
    expect(buffUptimeBound(0.25)).toBeCloseTo(0.8, 12);
    expect(buffTimingOk(10, 8, 0.25)).toBe(true);
    expect(buffTimingOk(9.99, 8, 0.25)).toBe(false);
    expect(buffTimingOk(8, 8, 0.05), 'откат, равный действию, — никогда').toBe(false);
  });

  it('откат узла по рангу — `abilityCooldown`; ранг выше потолка узла откат не режет', () => {
    for (let r = 1; r <= 8; r++) expect(buffNodeCooldown(13.5, r, 8)).toBe(abilityCooldown(13.5, r));
    expect(buffNodeCooldown(13.5, 20, 8)).toBe(abilityCooldown(13.5, 8));
    expect(buffNodeCooldown(13.5, 0, 8), 'ранг 0 — как первый').toBe(13.5);
  });

  it('формулы вставки — те же, что у сборки скила (`inserts.ts`): прибавка по рангу донора, надбавка к откату тает', () => {
    expect(insertGain(0.12, 1)).toBe(1);
    expect(insertGain(0.12, 10)).toBeCloseTo(2.08, 12);
    expect(insertCooldownMult(1.2, 0.1, 1)).toBeCloseTo(1.2, 12);
    expect(insertCooldownMult(1.2, 0.1, 11)).toBe(1);
    expect(insertCooldownMult(0.8, 0.1, 1), 'скидка сильнее всего на первом ранге').toBeCloseTo(0.8, 12);
  });
});

describe('⭐ D4: правило времени баффа — данные и схема', () => {
  it('данные игры держат правило на каждом ранге: ни одного нарушения', () => {
    expect(buffTimingIssues(tables(reg()))).toEqual([]);
  });

  it('⭐ замысел данных: средняя по рангам доля времени под баффом — как в описании (±2 п.), без замысла — ≤ 60 % на высшем ранге', () => {
    const r = reg();
    const m = r.get('balance').buffMinRest;
    // Замысел — действие/откат из описания данных до правила (R19-03 и раньше): 8/12, 8/12, 6/10, 10/14. «Огненные чары» (12 с на 12 с) и печати
    // (откат 0) замысла не показывали — 100 % времени и было нарушением.
    const intent: Record<string, number> = { [WARCRY]: 8 / 12, 'b-class-vyuga-a2': 8 / 12, 'b-class-arbalest-a2': 6 / 10, 'b-class-vorozheya-a3': 10 / 14 };
    for (const n of r.get('skill-tree').nodes) {
      const a = n.effect.active;
      if (a?.category !== 'buff') continue;
      const ups = Array.from({ length: n.maxRank }, (_, i) => a.durationSec / buffNodeCooldown(a.cooldown, i + 1, n.maxRank));
      expect(Math.max(...ups), `${n.id}: не выше правила`).toBeLessThanOrEqual(buffUptimeBound(m) + 1e-9);
      const want = intent[n.id];
      if (want !== undefined) expect(Math.abs(ups.reduce((s, x) => s + x, 0) / ups.length - want), `${n.id}: среднее по рангам — как замысел`).toBeLessThanOrEqual(0.02);
      else expect(ups[ups.length - 1], `${n.id}: без замысла — не выше 60 % на высшем ранге`).toBeLessThanOrEqual(0.6);
    }
    for (const ins of r.get('skill-inserts')) {
      const ab = ins.proc?.ability;
      if (ab?.category !== 'buff') continue;
      const top = r.get('skill-tree').nodes.find((nd) => nd.effect.grantsInsert === ins.id)!.maxRank;
      expect(ab.durationSec * insertGain(ins.perRank.gain, top) / ab.cooldown, `${ins.id}: печать — не выше 60 % на высшем ранге донора`).toBeLessThanOrEqual(0.6);
    }
  });

  it('реестр не пускает бафф, нарушающий правило хоть на одном ранге, — отказ валидации с подсказкой; живое не тронуто', () => {
    const r = reg();
    const before = r.revision();
    const tree = structuredClone(r.get('skill-tree'));
    nodeOf(tree, WARCRY).maxRank = 20;   // как до D4: 20 рангов при откате 13.5 с — с 10-го короче правила
    expect(() => r.reload({ 'skill-tree': tree })).toThrow(/Конфиг "skill-tree" не прошёл валидацию[\s\S]*Боевой клич[\s\S]*ранге 10[\s\S]*потолок ранга не выше 9/);
    expect(r.revision(), 'всё или ничего').toBe(before);
    const one = structuredClone(r.get('skill-tree'));
    buffOf(one, CHARM).cooldown = 12;   // «Огненные чары» R19-03: 12 с на 12 с — короче правила с первого ранга
    expect(() => r.reload({ 'skill-tree': one })).toThrow(/Огненные чары[\s\S]*ранге 1:/);
  });

  it('и печать без отката, и отдых баланса выше, чем держат данные, — отказ (таблица правки — в ошибке)', () => {
    const r = reg();
    const ins = structuredClone(r.get('skill-inserts'));
    const ward = ins.find((i) => i.id === 'ins-ward')!.proc!.ability as unknown as Buff;
    ward.cooldown = 0;
    expect(() => r.reload({ 'skill-inserts': ins })).toThrow(/Конфиг "skill-inserts" не прошёл валидацию[\s\S]*Оберег[\s\S]*не короче 10\.4 с/);
    expect(() => r.reload({ balance: { ...r.get('balance'), buffMinRest: 1 } })).toThrow(/Конфиг "balance" не прошёл валидацию[\s\S]*отдых 100 %/);
    expect(() => r.reload({ balance: { ...r.get('balance'), buffMinRest: 0 } }), 'отдых — строго больше нуля (схема)').toThrow(/не прошёл валидацию/);
  });

  it('худшая сборка вставок в гнёздах баффа: вставка со скидкой отката, влезающая в бафф, — и её откат держит правило', () => {
    const r = reg();
    const ins = structuredClone(r.get('skill-inserts'));
    const haste = { ...structuredClone(ins.find((i) => i.id === 'ins-quickening')!), id: 'ins-test-haste', type: 'test-haste', fits: { categories: ['buff'] }, cooldownMult: 0.5, proc: undefined, tune: undefined };
    const tree = structuredClone(r.get('skill-tree'));
    const donor = structuredClone(tree.nodes.find((n) => n.effect.grantsInsert === 'ins-quickening')!);
    donor.id = 'test-haste-donor'; donor.effect = { grantsInsert: 'ins-test-haste' };
    tree.nodes.push(donor);
    const issues = configCrossIssues((k) => ({ balance: r.get('balance'), 'skill-tree': tree, 'skill-inserts': [...ins, haste] } as Record<string, unknown>)[k]);
    expect(issues.length, 'откат баффов ×0.5 в гнезде — короче правила').toBeGreaterThan(0);
    expect(issues[0]!.msg).toMatch(/со вставками в гнёздах: откат ×0\.5/);
    expect(configCrossIssues((k) => ({ balance: r.get('balance'), 'skill-tree': tree, 'skill-inserts': [...ins, { ...haste, enabled: false }] } as Record<string, unknown>)[k]), 'выключенная — не в счёт').toEqual([]);
  });
});

describe('⭐ D4: старый оверрайд — зажим правила в данных, вслух', () => {
  it('древо до правила (20 рангов, 12 с; «Огненные чары» 12 на 12): потолок ранга — до последнего годного, первый ранг — откат до правила', () => {
    const r = reg();
    const old = structuredClone(r.get('skill-tree')) as Tree;
    for (const n of old.nodes) if (n.effect.active?.category === 'buff') { n.maxRank = 20; (n.effect.active as unknown as Buff).cooldown = n.id === 'b-class-arbalest-a2' ? 10 : n.id === 'b-class-vorozheya-a3' ? 14 : 12; }
    const { value, fixes } = upgradeStoredOverride('skill-tree', old, r);
    const up = value as Tree;
    expect(nodeOf(up, WARCRY).maxRank, 'клич: 12 с × (1 − 3 %·5) = 10.2 ≥ 10 — годен до 6-го').toBe(6);
    expect(buffOf(up, WARCRY).cooldown, 'база клича — как у хозяина').toBe(12);
    expect(buffOf(up, CHARM).cooldown, 'чары: первый ранг — до правила').toBe(15);
    expect(nodeOf(up, CHARM).maxRank).toBe(1);
    expect(fixes.some((f) => /b-class-warrior-a5\.maxRank: 20 → 6/.test(f))).toBe(true);
    expect(fixes.some((f) => /b-class-vorozheya-a1\.effect\.active\.cooldown: 12 → 15/.test(f))).toBe(true);
    expect(buffOf(old, CHARM).cooldown, 'исходное не тронуто').toBe(12);
    expect(() => r.reload({ 'skill-tree': value }), 'приведённое проходит схему').not.toThrow();
    // Как зажим R19-03 в ядре: на каждом вложенном ранге откат приведённого — max(ранг, правило) прежних данных.
    for (let rank = 1; rank <= 20; rank++) {
      const was = Math.max(abilityCooldown(12, rank), buffRestFloor(8, 0.25));
      expect(buffNodeCooldown(buffOf(up, WARCRY).cooldown, rank, nodeOf(up, WARCRY).maxRank), `клич, ранг ${rank}`).toBeGreaterThanOrEqual(was - 1e-9);
    }
  });

  it('печать до правила (откат 0) — откат до правила на высшем ранге донора; годное и негодное схеме — как было', () => {
    const r = reg();
    const old = structuredClone(r.get('skill-inserts'));
    (old.find((i) => i.id === 'ins-ward')!.proc!.ability as unknown as Buff).cooldown = 0;
    const { value, fixes } = upgradeStoredOverride('skill-inserts', old, r);
    expect(((value as typeof old).find((i) => i.id === 'ins-ward')!.proc!.ability as unknown as Buff).cooldown).toBe(10.4);
    expect(fixes).toEqual([expect.stringMatching(/ins-ward\.proc\.ability\.cooldown: 0 → 10\.4/)]);
    const same = r.get('skill-inserts');
    expect(upgradeStoredOverride('skill-inserts', same, r)).toEqual({ value: same, fixes: [] });
    const junk = { nodes: 'нет' };
    expect(upgradeStoredOverride('skill-tree', junk, r), 'негодное схеме — пропуск инцидентом, как прежде').toEqual({ value: junk, fixes: [] });
    expect(upgradeStoredOverride('skill-inserts', old).fixes.length, 'без живого конфига — поверх файлов данных').toBe(1);
  });
});

describe('⭐ D4: зажим ядра — со строкой в лог, раз на бафф', () => {
  it('годный откат — как есть и молча; короче правила — до правила, одна строка на бафф и числа', () => {
    const lines: string[] = [];
    restore = setBuffTimingWarn((l) => lines.push(l));
    expect(clampBuffCooldown(10.67, 8, 0.25, 'x')).toBe(10.67);
    expect(lines).toEqual([]);
    expect(clampBuffCooldown(3, 8, 0.25, 'x')).toBe(10);
    expect(clampBuffCooldown(3, 8, 0.25, 'x')).toBe(10);
    expect(clampBuffCooldown(0, 4, 0.25, 'ins:y')).toBe(5);
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatch(/«x» 3 с короче правила[\s\S]*зажат до 10 с/);
  });
});

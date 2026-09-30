import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { xpForLevel } from '../formulas/xp.js';
import { ATTRIBUTES } from '../types/attributes.js';
import type { QuestDef } from '../types/quest.js';
import type { SaveState } from '../types/save.js';
import { newCharacterSave } from './newCharacter.js';
import { gainXp } from './progression.js';
import { turnInQuest } from './questLogic.js';
import {
  allocActive, allocAttr, allocPassive, attrRespecRefund, passiveEntriesFor, pointsHeld, respec, respecPassives, respecSkills, settleEarned,
} from './townActions.js';

/**
 * ⭐ D2: ОДНО ПРАВИЛО ДЛЯ ЖИВОЙ ПРАВКИ КОНФИГА И ГЕРОЕВ, КОТОРЫЕ УЖЕ ЕСТЬ. Правка хозяина (живьём или деплоем) не чеканит и не отнимает
 * заработанного: сейв помнит, что герою выдано (старт при создании — R18-07, очки атрибутов/скилов/мастерства за каждый уровень — как их
 * выдали, `save.earned`); сброс возвращает ровно вложенное (вложено − старт) независимо от живого конфига; уровень не опускается (R9-05);
 * новые числа — только будущим выдачам. Сейв старше правила дописывается ОДИН раз из того, что у героя есть (`settleEarned`), дальше заморожен.
 */
const fresh = (): ConfigRegistry => { const r = new ConfigRegistry(); r.loadAll(); return r; };
const setBalance = (r: ConfigRegistry, patch: Record<string, unknown>): void => { r.reload({ balance: { ...r.get('balance'), ...patch } }); };
const editClass = (r: ConfigRegistry, id: string, start: Partial<SaveState['attributes']>): void => {
  r.reload({ classes: r.get('classes').map((c) => (c.id === id ? { ...c, startAttributes: { ...c.startAttributes, ...start } } : c)) });
};
/** Итог героя по пулам — вложенное + свободное (атрибуты — Σ целиком: сброс их переносит). */
const totals = (s: SaveState): number[] => [
  ATTRIBUTES.reduce((n, a) => n + s.attributes[a], 0) + s.unspentAttributePoints,
  Object.values(s.skills).reduce((n, v) => n + v, 0) + s.unspentSkillPoints,
  Object.values(s.masteries).reduce((n, v) => n + v, 0) + s.unspentMasteryPoints,
];
/** Воин уровня `lvl`: очки атрибутов вложены в Силу, скилов и мастерства — сколько возьмут входы древ; надетого нет, золото есть. */
function hero(r: ConfigRegistry, lvl: number, id: string): SaveState {
  const s = newCharacterSave(r, 'warrior', 'Герой', id);
  gainXp(s, r.get('balance'), xpForLevel(lvl, r.get('balance').xpTable));
  expect(s.level).toBe(lvl);
  expect(allocAttr(s, 'strength', s.unspentAttributePoints).ok).toBe(true);
  s.equipment = {}; s.belt = []; s.gold = 10_000_000;
  const tree = r.get('skill-tree');
  const mine = tree.entryNodes.filter((id) => {
    const b = tree.branches.find((x) => x.id === tree.nodes.find((n) => n.id === id)?.branchId);
    return !b?.classId || b.classId === s.classId;
  });
  for (const id of mine) while (s.unspentSkillPoints > 0 && allocActive(r, s, id).ok);
  for (const id of passiveEntriesFor(r)) while (s.unspentMasteryPoints > 0 && allocPassive(r, s, id).ok);
  const [, sk = 0, ms = 0] = totals(s);
  expect(sk - s.unspentSkillPoints, 'очки скилов вложены').toBeGreaterThan(0);
  expect(ms - s.unspentMasteryPoints, 'очки мастерства вложены').toBeGreaterThan(0);
  return s;
}

describe('⭐ D2: книга заработанного — пишет только выдача', () => {
  it('новый герой — нули; уровни пишутся по очкам за уровень ТОГО мига; правка очков за уровень выданного не трогает', () => {
    const r = fresh();
    const b0 = r.get('balance');
    const s = newCharacterSave(r, 'warrior', 'Н', 'd2-a');
    expect(s.earned).toEqual({ attributePoints: 0, skillPoints: 0, masteryPoints: 0 });
    gainXp(s, b0, xpForLevel(10, b0.xpTable));
    const at10 = { attributePoints: 9 * b0.attributePointsPerLevel, skillPoints: 9 * b0.skillPointsPerLevel, masteryPoints: 9 * b0.masteryPointsPerLevel };
    expect(s.earned).toEqual(at10);
    setBalance(r, { attributePointsPerLevel: b0.attributePointsPerLevel + 3, skillPointsPerLevel: 0, masteryPointsPerLevel: b0.masteryPointsPerLevel + 1 });
    expect(s.earned, 'правка конфига выданного не пересчитывает').toEqual(at10);
    const b1 = r.get('balance');
    gainXp(s, b1, xpForLevel(11, b1.xpTable) - s.xp);
    expect(s.level).toBe(11);
    expect(s.earned, 'новые числа — только будущему уровню').toEqual({
      attributePoints: at10.attributePoints + b1.attributePointsPerLevel, skillPoints: at10.skillPoints, masteryPoints: at10.masteryPoints + b1.masteryPointsPerLevel,
    });
    expect(pointsHeld(s, s.startAttributes!), 'вложенное + свободное = выдано').toEqual(s.earned);
  });

  it('награда задания очками скилов — тоже заработанное', () => {
    const r = fresh();
    const s = newCharacterSave(r, 'warrior', 'Н', 'd2-q');
    const def: QuestDef = { id: 'd2-quest', title: 'Т', description: '', objectives: [], reward: { skillPoints: 3 } } as unknown as QuestDef;
    s.activeQuestDefs = [def];
    s.quests = [{ questId: def.id, status: 'completed', counters: {} }];
    expect(turnInQuest(r, s, def.id).ok).toBe(true);
    expect(s.earned?.skillPoints).toBe(3);
    expect(pointsHeld(s, s.startAttributes!)).toEqual(s.earned);
  });

  it('уровень правкой кривой не опускается и очки его уровней второй раз не платятся (R9-05)', () => {
    const r = fresh();
    const s = hero(r, 30, 'd2-lvl');
    const earned = structuredClone(s.earned);
    setBalance(r, { xpTable: r.get('balance').xpTable.map((v) => Math.round(v * 1.25)) });
    gainXp(s, r.get('balance'), 1);
    expect(s.level, 'кривая медленнее — уровень тот же').toBe(30);
    expect(s.earned).toEqual(earned);
    setBalance(r, { xpTable: r.get('balance').xpTable.slice(0, 21) });
    gainXp(s, r.get('balance'), 1_000_000);
    expect(s.level, 'потолок ниже — уровень выше потолка остаётся').toBe(30);
    expect(s.earned).toEqual(earned);
  });
});

describe('⭐ D2: сброс возвращает ровно вложенное — независимо от живого конфига', () => {
  const edits: [string, (r: ConfigRegistry) => void][] = [
    ['очков атрибутов за уровень −2', (r) => setBalance(r, { attributePointsPerLevel: r.get('balance').attributePointsPerLevel - 2 })],
    ['очков скилов и мастерства за уровень 0', (r) => setBalance(r, { skillPointsPerLevel: 0, masteryPointsPerLevel: 0 })],
    ['старт воина: Сила −5, Живучесть +7', (r) => { const st = r.get('classes').find((c) => c.id === 'warrior')!.startAttributes; editClass(r, 'warrior', { strength: st.strength - 5, vitality: st.vitality + 7 }); }],
    ['кривая медленнее', (r) => setBalance(r, { xpTable: r.get('balance').xpTable.map((v) => Math.round(v * 1.3)) })],
    ['древа: узлы, куда вложено, убраны', (r) => {
      const st = r.get('skill-tree'), mt = r.get('mastery-tree');
      const gone = new Set([...st.entryNodes, ...mt.entryNodes]);
      r.reload({
        'skill-tree': { ...st, nodes: st.nodes.filter((n) => !gone.has(n.id)), edges: st.edges.filter(([a, b]) => !gone.has(a) && !gone.has(b)), entryNodes: [] },
        'mastery-tree': { ...mt, nodes: mt.nodes.filter((n) => !gone.has(n.id)), edges: mt.edges.filter(([a, b]) => !gone.has(a) && !gone.has(b)), entryNodes: [] },
      });
    }],
  ];
  for (const [what, edit] of edits) {
    it(`${what}: три сброса — итог и книга те же, возврат — ровно вложенное`, () => {
      const r = fresh();
      const s = hero(r, 25, `d2-r-${what}`);
      const t0 = totals(s);
      const e0 = structuredClone(s.earned);
      const invested = ATTRIBUTES.reduce((n, a) => n + s.attributes[a] - s.startAttributes![a], 0);
      expect(invested).toBeGreaterThan(0);
      edit(r);
      expect(attrRespecRefund(r, s), 'возврат — вложено − старт, а не от живой строки').toBe(invested);
      expect(respec(r, s).ok, what).toBe(true);
      expect(respecSkills(r, s).ok, what).toBe(true);
      expect(respecPassives(r, s).ok, what).toBe(true);
      expect(totals(s), `${what}: ни очка не пропало и не взялось из воздуха`).toEqual(t0);
      expect(s.earned, `${what}: книга та же`).toEqual(e0);
      expect(pointsHeld(s, s.startAttributes!), `${what}: всё свободно`).toEqual(e0);
    });
  }
});

describe('⭐ D2: сброс сейва со стартом строки класса не спрашивает', () => {
  it('строку класса убрали (id сменили) — сброс возвращает вложенное, как прежде; сейву без старта и без строки — отказ без траты', () => {
    const r = fresh();
    const s = hero(r, 10, 'd2-nocls');
    const invested = ATTRIBUTES.reduce((n, a) => n + s.attributes[a] - s.startAttributes![a], 0);
    r.reload({ classes: r.get('classes').map((c) => (c.id === 'warrior' ? { ...c, id: 'warrior-2' } : c)) });
    expect(attrRespecRefund(r, s)).toBe(invested);
    expect(respec(r, s).ok).toBe(true);
    expect(s.unspentAttributePoints).toBe(invested);
    const old = hero(fresh(), 10, 'd2-nocls-old');
    delete old.startAttributes; delete old.earned;
    const before = JSON.stringify(old);
    expect(respec(r, old)).toEqual({ ok: false, reason: 'Класс не найден' });
    expect(JSON.stringify(old)).toBe(before);
  });
});

describe('⭐ D2: сейв старше правила — дописка один раз, дальше заморожено', () => {
  it('сейв без старта и без книги (старше R18-07): старт — R19-01, книга — из того, что есть; правка после дописи не доходит', () => {
    const r = fresh();
    const s = hero(r, 20, 'd2-old');
    delete s.startAttributes; delete s.earned;
    const born = { ...r.get('classes').find((c) => c.id === 'warrior')!.startAttributes };
    editClass(r, 'warrior', { strength: born.strength - 4 });   // правка хозяина ДО входа героя
    const t0 = totals(s);
    expect(settleEarned(r, s)).toBe(true);
    expect(s.startAttributes).toEqual({ ...born, strength: born.strength - 4 });
    expect(s.earned).toEqual(pointsHeld(s, s.startAttributes!));
    const frozen = structuredClone({ start: s.startAttributes, earned: s.earned });
    editClass(r, 'warrior', { strength: born.strength + 9, vitality: born.vitality + 9 });
    setBalance(r, { attributePointsPerLevel: 1, skillPointsPerLevel: 7 });
    expect(settleEarned(r, s), 'второй вход — ничего').toBe(false);
    expect({ start: s.startAttributes, earned: s.earned }, 'заморожено').toEqual(frozen);
    expect(respec(r, s).ok).toBe(true);
    expect(totals(s)).toEqual(t0);
    expect(s.earned).toEqual(frozen.earned);
  });

  it('сейв со стартом, но без книги (после R18-07, до D2): книга — из того, что есть; старт не трогается', () => {
    const r = fresh();
    const s = hero(r, 15, 'd2-mid');
    const want = structuredClone(s.earned);
    const start = structuredClone(s.startAttributes);
    delete s.earned;
    setBalance(r, { attributePointsPerLevel: 99, skillPointsPerLevel: 99, masteryPointsPerLevel: 99 });
    editClass(r, 'warrior', { strength: 1 });
    expect(settleEarned(r, s)).toBe(true);
    expect(s.startAttributes).toEqual(start);
    expect(s.earned, 'правка очков за уровень не влияет: книга — из вложенного и свободного').toEqual(want);
  });

  it('сброс атрибутов сейва старше правки сам дописывает книгу — ту же, что дописал бы вход', () => {
    const r = fresh();
    const s = hero(r, 12, 'd2-respec');
    delete s.startAttributes; delete s.earned;
    const viaEntry = structuredClone(s);
    settleEarned(r, viaEntry);
    expect(respec(r, s).ok).toBe(true);
    expect(s.earned).toEqual(viaEntry.earned);
    expect(s.startAttributes).toEqual(viaEntry.startAttributes);
  });

  it('отказ сброса дописку не пишет (отказ не трогает сейв), неизвестный класс без старта — дописывать нечего', () => {
    const r = fresh();
    const s = newCharacterSave(r, 'warrior', 'Н', 'd2-refuse');
    delete s.startAttributes; delete s.earned;
    const before = JSON.stringify(s);
    expect(respec(r, s).ok).toBe(false);
    expect(JSON.stringify(s)).toBe(before);
    s.classId = 'нет-такого';
    expect(settleEarned(r, s)).toBe(false);
    expect(s.earned).toBeUndefined();
  });
});

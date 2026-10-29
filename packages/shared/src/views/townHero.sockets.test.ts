/**
 * ⭐ С-аудит (29.10): ВИД ГНЁЗД (`socketsView`) — ЛИНЕЙНЫЙ И БАЙТ В БАЙТ ПРЕЖНИЙ. Раньше каждая клетка перебирала все вставки и на каждую
 * звала `insertUnlocked`/`insertRank` (проход по всему древу): поздний билд — 5–8 мс и 130–200 КБ за запрос ценой в 1 токен. Вид переписан
 * на один проход по древу; сторож — ПРЕЖНИЙ перебор (оракул ниже, той же логикой и теми же функциями `session/inserts`) против нового на
 * больших сборках каждого класса: клетки и варианты — до буквы. И цена вида в лимите — по числу выученных активок с гнёздами (`socketNodes`).
 */
import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import type { SaveState } from '../types/save.js';
import { newCharacterSave } from '../economy/newCharacter.js';
import { allocActive, socketInsert } from '../economy/townActions.js';
import { insertById, insertFits, insertRank, insertUnlocked, socketsOpen } from '../session/inserts.js';
import { insertCooldownMult } from '../formulas/buffTiming.js';
import { priceText, socketNodes, socketsView, type InsertTip, type SocketCell, type SocketOption } from './townHero.js';

const cfg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();

/** Оракул: клетки узла прежним перебором (до правки — тело `socketsView`). */
function oracleCells(reg: ConfigRegistry, save: SaveState, nodeId: string): SocketCell[] {
  const tree = reg.get('skill-tree');
  const n = tree.nodes.find((x) => x.id === nodeId)!;
  const typeName = (id: string): string => reg.get('skill-insert-types').find((t) => t.id === id)?.name ?? id;
  const tipOf = (x: { id: string; name: string; description: string; cooldownMult: number; perRank: { cooldownDecay: number } }): InsertTip =>
    ({ name: x.name, desc: x.description, cooldownMult: insertCooldownMult(x.cooldownMult, x.perRank.cooldownDecay, insertRank(reg, save, x.id)) });
  const base = n.effect.active!;
  const open = socketsOpen(reg, save.skills[n.id] ?? 0);
  const slots = save.sockets?.[n.id] ?? [];
  const weaponClass = save.equipment.weapon?.weaponClass;
  const branch = tree.branches.find((br) => br.id === n.branchId);
  const foreign = !!branch?.classId && branch.classId !== save.classId;
  return Array.from({ length: open }, (_, i): SocketCell => {
    const cur = slots[i] ?? null;
    const ins = cur ? insertById(reg, cur) : undefined;
    const others = slots.filter((_, j) => j !== i);
    const usedTypes = new Set(others.map((id) => (id ? insertById(reg, id)?.type : undefined)).filter(Boolean) as string[]);
    const options: SocketOption[] = cur && !foreign ? [{ label: '✕ Вынуть', insertId: null, price: null, tip: null }] : [];
    if (!foreign) for (const x of reg.get('skill-inserts')) {
      if (x.enabled === false || x.id === cur) continue;
      if (!insertUnlocked(reg, save, x.id)) continue;
      if (!insertFits(x, base, weaponClass)) continue;
      if (usedTypes.has(x.type)) continue;
      options.push({ label: `${typeName(x.type)} · ${x.name}`, insertId: x.id, price: priceText(x, base.resource), tip: tipOf(x) });
    }
    return {
      head: ins ? typeName(ins.type) : `Гнездо ${i + 1}`,
      text: ins ? `${ins.name} · ${insertRank(reg, save, ins.id)}` : '— пусто —',
      price: ins ? priceText(ins, base.resource) : null,
      insertId: ins ? ins.id : null,
      rank: ins ? insertRank(reg, save, ins.id) : 0,
      tip: ins ? tipOf(ins) : null,
      options,
    };
  });
}

/** Большая сборка: уровень 100, `pts` очков — жадно в доноров вставок и активки (по смежности, командой `allocActive`), вставки — в гнёзда. */
function bigBuild(classId: string, pts: number, donorsFirst: boolean): SaveState {
  const tree = cfg.get('skill-tree');
  const save = newCharacterSave(cfg, classId, 'Билд', `c-${classId}-${pts}`);
  save.level = 100; save.unspentSkillPoints = pts;
  for (let guard = 0; guard < 2000 && save.unspentSkillPoints > 0; guard++) {
    const fresh = tree.nodes.filter((n) => (save.skills[n.id] ?? 0) === 0);
    const donors = fresh.filter((n) => n.effect.grantsInsert), actives = fresh.filter((n) => n.effect.active);
    const pref = donorsFirst ? [...donors, ...actives, ...fresh] : [...actives, ...donors, ...fresh];
    if (!pref.some((n) => allocActive(cfg, save, n.id).ok)) break;
  }
  let k = 0;
  for (const n of tree.nodes) {
    if (!n.effect.active || !((save.skills[n.id] ?? 0) > 0)) continue;
    for (const ins of cfg.get('skill-inserts')) if (insertUnlocked(cfg, save, ins.id)) socketInsert(cfg, save, n.id, (k++) % 3, ins.id);
  }
  // гнездо за пределом открытых (осталось от прежних порогов) и выключенная вставка — ветки «тип уже стоит» и «вставки нет»
  const first = socketNodes(cfg, save)[0];
  if (first) save.sockets = { ...(save.sockets ?? {}), [first.id]: [...(save.sockets?.[first.id] ?? []), null, null, 'нет-такой-вставки'] };
  return save;
}

describe('⭐ С-аудит: вид гнёзд — линейный, ответ прежний', () => {
  const classes = cfg.get('classes').map((c) => c.id);

  it('клетки и варианты — до буквы прежнего перебора на больших сборках каждого класса', () => {
    let cells = 0;
    for (const cls of classes) for (const pts of [12, 60, 110]) for (const donorsFirst of [true, false]) {
      const save = bigBuild(cls, pts, donorsFirst);
      const v = socketsView(cfg, save);
      expect(v.learned.map((l) => l.id), `${cls}/${pts}: узлы`).toEqual(socketNodes(cfg, save).map((n) => n.id));
      for (const l of v.learned) {
        expect(JSON.stringify(l.cells), `${cls}/${pts}/${l.id}`).toBe(JSON.stringify(oracleCells(cfg, save, l.id)));
        cells += l.cells.length;
      }
    }
    expect(cells, 'клеток в сверке').toBeGreaterThan(500);
  });

  it('пустой сейв — подсказка, ни одного узла; число узлов — цена вида в лимите (`Room.viewCost`: 1 + ⌈n/8⌉)', () => {
    const fresh = newCharacterSave(cfg, classes[0]!, 'Новичок', 'c-fresh');
    expect(socketsView(cfg, fresh)).toMatchObject({ learned: [], hint: expect.stringContaining('Гнёзда открываются') });
    expect(socketNodes(cfg, fresh)).toEqual([]);
    const big = bigBuild(classes[0]!, 110, false);
    expect(socketNodes(cfg, big).length).toBe(socketsView(cfg, big).learned.length);
    expect(socketNodes(cfg, big).length, 'поздний билд — десятки активок').toBeGreaterThan(20);
  });

  it('большая сборка — заметно быстрее прежнего перебора (замер: ≈ 0.4 мс против ≈ 2.3 мс на 36 активках)', () => {
    const save = bigBuild(classes[0]!, 110, false);
    const nodes = socketNodes(cfg, save);
    const time = (f: () => void): number => { f(); const t0 = performance.now(); for (let i = 0; i < 10; i++) f(); return performance.now() - t0; };
    const now = time(() => socketsView(cfg, save));
    const was = time(() => { for (const n of nodes) oracleCells(cfg, save, n.id); });
    // относительно, а не в миллисекундах: под нагрузкой полного прогона медленнее оба
    expect(now * 2, `новый ${now.toFixed(1)} мс против прежних клеток ${was.toFixed(1)} мс (×10)`).toBeLessThan(was);
  });
});

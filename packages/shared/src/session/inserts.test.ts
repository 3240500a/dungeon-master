import { describe, it, expect, beforeAll } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { newCharacterSave } from '../economy/newCharacter.js';
import type { SaveState } from '../types/save.js';
import { resolveActive, socketsOpen, insertFits, insertById, insertUnlocked } from './inserts.js';

/**
 * Модульные скилы: гнёзда и вставки. Проверяется РЕЗОЛВ — чистая функция, через которую проходит
 * вся система. Комбинаций «149 скилов × 17 вставок» никто перебирать не будет и не должен:
 * правила живут в одном месте, и проверять надо их, а не декартово произведение.
 */
let cfg: ConfigRegistry;
/** Сужение union'а до атакующей формы — в тесте мы точно знаем категорию, а писать гарды на каждое поле — шум. */
type Off = { element?: string; addElementPct: number; damageMult: number; manaCost: number; cooldown: number };
const off = (a: unknown): Off => a as Off;
/** Узел дерева, у которого есть активка нужной категории. */
const nodeWithActive = (category: string): string =>
  cfg.get('skill-tree').nodes.find((n) => n.effect.active?.category === category)!.id;

/** Сейв с выученным узлом заданного ранга и открытыми вставками (через узлы-доноры). */
function saveWith(nodeId: string, rank: number, sockets: (string | null)[] = [], unlock: string[] = []): SaveState {
  const s = newCharacterSave(cfg, cfg.get('classes')[0]!.id, 'Hero', 'c1');
  s.skills[nodeId] = rank;
  if (sockets.length) s.sockets = { [nodeId]: sockets };
  // Открываем вставки, вкладывая очко в НАСТОЯЩИЙ узел-донор из дерева.
  const tree = cfg.get('skill-tree');
  for (const id of unlock) {
    const donor = tree.nodes.find((n) => n.effect.grantsInsert === id);
    if (donor) s.skills[donor.id] = 1;
  }
  return s;
}

beforeAll(() => { cfg = new ConfigRegistry(); cfg.loadAll(); });

describe('гнёзда открываются рангом', () => {
  it('0 на невыученном, дальше по порогам из баланса', () => {
    const ranks = cfg.get('balance').skillSocketRanks;
    expect(socketsOpen(cfg, 0)).toBe(0);
    expect(socketsOpen(cfg, ranks[0]!)).toBe(1);
    expect(socketsOpen(cfg, ranks[1]! - 1)).toBe(1);
    expect(socketsOpen(cfg, ranks[1]!)).toBe(2);
    expect(socketsOpen(cfg, 99)).toBe(ranks.length);   // выше потолка не растёт
  });
});

describe('ИНВАРИАНТ НЕТРОНУТОСТИ', () => {
  /**
   * Ради этого всё и устроено швом: система включается, не трогая ни одной из существующих активок.
   * Сравнение ПО ССЫЛКЕ — самое строгое из возможных: без вставок мы не клонируем и не правим ничего.
   */
  it('пустые гнёзда дают ТОТ ЖЕ объект способности — все узлы дерева', () => {
    const save = newCharacterSave(cfg, cfg.get('classes')[0]!.id, 'Hero', 'c1');
    const actives = cfg.get('skill-tree').nodes.filter((n) => n.effect.active);
    expect(actives.length).toBeGreaterThan(100);   // защита от «тест зелёный, потому что список пуст»
    for (const n of actives) {
      save.skills[n.id] = 20;                       // ранг максимальный: гнёзда открыты, но пусты
      expect(resolveActive(cfg, save, n.id)!.active, n.id).toBe(n.effect.active);
    }
  });

  it('узел без активки — undefined, а не пустая заглушка', () => {
    const plain = cfg.get('skill-tree').nodes.find((n) => !n.effect.active)!;
    expect(resolveActive(cfg, saveWith(plain.id, 5), plain.id)).toBeUndefined();
  });
});

describe('вставки меняют носителя', () => {
  it('стихия и статус приходят из вставки, стоимость и КД растут', () => {
    const id = nodeWithActive('attack');
    const base = cfg.get('skill-tree').nodes.find((n) => n.id === id)!.effect.active!;
    const save = saveWith(id, 20, ['ins-flame-edge'], ['ins-flame-edge']);
    const r = resolveActive(cfg, save, id)!;
    expect(off(r.active).element).toBe('fire');
    expect(off(r.active).addElementPct).toBeGreaterThan(0);
    expect(r.active.manaCost).toBeCloseTo(off(base).manaCost * 1.25, 2);
    expect(r.active.cooldown).toBeCloseTo(off(base).cooldown * 1.1, 2);
    expect(off(base).element, 'исходный конфиг НЕ мутирован').not.toBe('fire');
  });

  it('множители ПЕРЕМНОЖАЮТСЯ — три вставки дороже, а не «плюс немного»', () => {
    const id = nodeWithActive('attack');
    const base = cfg.get('skill-tree').nodes.find((n) => n.id === id)!.effect.active!;
    const ids = ['ins-flame-edge', 'ins-kindling', 'ins-wide-arc'];
    const r = resolveActive(cfg, saveWith(id, 20, ids, ids), id)!;
    expect(r.applied.length, 'все три разного типа — влезли').toBe(3);
    expect(r.active.manaCost).toBeCloseTo(off(base).manaCost * 1.25 * 1.2 * 1.25, 1);
  });

  it('ОДНА ВСТАВКА КАЖДОГО ТИПА: вторая того же типа отбрасывается, другого — принимается', () => {
    const id = nodeWithActive('attack');
    const same = ['ins-flame-edge', 'ins-frost-edge'];          // обе типа damage
    expect(resolveActive(cfg, saveWith(id, 20, same, same), id)!.applied.map((i) => i.id)).toEqual(['ins-flame-edge']);
    const diff = ['ins-flame-edge', 'ins-kindling'];            // damage + ailment
    expect(resolveActive(cfg, saveWith(id, 20, diff, diff), id)!.applied.length).toBe(2);
  });

  it('ГНЕЗДО СВЕРХ РАНГА не считается', () => {
    const id = nodeWithActive('attack');
    const ids = ['ins-flame-edge', 'ins-kindling', 'ins-wide-arc'];
    const r = resolveActive(cfg, saveWith(id, 1, ids, ids), id)!;   // ранг 1 → одно гнездо
    expect(r.applied.map((i) => i.id)).toEqual(['ins-flame-edge']);
  });

  it('НЕОТКРЫТАЯ вставка не работает, даже если лежит в сейве', () => {
    const id = nodeWithActive('attack');
    const r = resolveActive(cfg, saveWith(id, 20, ['ins-flame-edge'], []), id)!;   // не открывали
    expect(r.applied).toEqual([]);
    expect(off(r.active).element).not.toBe('fire');
  });
});

describe('proc-вставки', () => {
  it('дают отдельный эффект, а не правят носителя', () => {
    const id = nodeWithActive('attack');
    const base = cfg.get('skill-tree').nodes.find((n) => n.id === id)!.effect.active!;
    const r = resolveActive(cfg, saveWith(id, 20, ['ins-cold-wave'], ['ins-cold-wave']), id)!;
    expect(r.procs.length).toBe(1);
    expect(r.procs[0]!.on).toBe('cast');
    expect(r.procs[0]!.ability.category).toBe('cast');
    expect(off(r.active).damageMult, 'урон носителя не тронут').toBe(off(base).damageMult);
    expect(r.active.manaCost, 'а цена — да').toBeGreaterThan(off(base).manaCost);
  });
});

describe('fits отсекает бессмыслицу', () => {
  it('вставка не своей категории и не своего оружия не влезает', () => {
    const attack = cfg.get('skill-tree').nodes.find((n) => n.effect.active?.category === 'attack')!.effect.active!;
    const aura = cfg.get('skill-tree').nodes.find((n) => n.effect.active?.category === 'aura')!.effect.active!;
    const wave = insertById(cfg, 'ins-cold-wave')!;
    expect(insertFits(wave, attack)).toBe(true);
    expect(insertFits(wave, aura), 'волна вокруг в ауру — бессмыслица').toBe(false);
    const pierce = insertById(cfg, 'ins-piercing')!;
    expect(insertFits(pierce, attack, 'bow')).toBe(true);
    expect(insertFits(pierce, attack, 'sword'), 'пробитие мечом — не то').toBe(false);
    expect(insertFits(pierce, attack), 'оружие неизвестно — не отказываем, решит сервер').toBe(true);
  });

  it('выключенная дизайнером вставка в игру не попадает', () => {
    const list = cfg.get('skill-inserts');
    const victim = list.find((i) => i.id === 'ins-shove')!;
    victim.enabled = false;
    try {
      expect(insertById(cfg, 'ins-shove')).toBeUndefined();
      const id = nodeWithActive('attack');
      expect(resolveActive(cfg, saveWith(id, 20, ['ins-shove'], ['ins-shove']), id)!.applied).toEqual([]);
    } finally { victim.enabled = true; }
  });
});

describe('открытость считается по дереву', () => {
  it('вставка открыта, пока у узла-донора есть ранг', () => {
    const save = saveWith(nodeWithActive('attack'), 20, [], ['ins-thrift']);
    expect(insertUnlocked(cfg, save, 'ins-thrift')).toBe(true);
    expect(insertUnlocked(cfg, save, 'ins-ward'), 'чужая — закрыта').toBe(false);
  });
});

/**
 * РАЗДАЧА ПО ДЕРЕВУ. Механика без доноров мертва: вставки существуют, а открыть их нечем.
 * Это и проверяется — не «функция работает», а «до неё можно дотянуться из игры».
 */
describe('вставки достижимы из дерева', () => {
  const donors = (): { node: string; insert: string; branch: string }[] =>
    cfg.get('skill-tree').nodes
      .filter((n) => n.effect.grantsInsert)
      .map((n) => ({ node: n.id, insert: n.effect.grantsInsert!, branch: n.branchId }));

  it('у КАЖДОЙ вставки ровно один донор, и лишних доноров нет', () => {
    const list = cfg.get('skill-inserts').map((i) => i.id).sort();
    const granted = donors().map((d) => d.insert).sort();
    expect(granted).toEqual(list);   // равенство МАССИВОВ ловит и пропуск, и дубль
  });

  it('доноры — пассивные узлы БЕСКЛАССОВЫХ веток', () => {
    const tree = cfg.get('skill-tree');
    for (const d of donors()) {
      const node = tree.nodes.find((n) => n.id === d.node)!;
      // Активка-донор означала бы «узел даёт скил И вставку» — лишняя связность там, где её не ждут.
      expect(node.effect.active, d.node).toBeUndefined();
      // Классовая ветка сделала бы вставку недостижимой для остальных классов — дыра в раздаче.
      expect(tree.branches.find((b) => b.id === d.branch)!.classId, d.node).toBeUndefined();
    }
  });

  it('СКВОЗНО: вложил очко в донора — вставка встала в скил', () => {
    const tree = cfg.get('skill-tree');
    for (const d of donors()) {
      const ins = insertById(cfg, d.insert)!;
      // Носитель — узел, в который эта вставка вообще влезает по категории.
      const carrier = tree.nodes.find((n) => n.effect.active && insertFits(ins, n.effect.active))!;
      const save = newCharacterSave(cfg, cfg.get('classes')[0]!.id, 'Hero', 'c1');
      save.skills[carrier.id] = 20;
      expect(insertUnlocked(cfg, save, d.insert), `${d.insert}: без очка в ${d.node} закрыта`).toBe(false);
      save.skills[d.node] = 1;
      expect(insertUnlocked(cfg, save, d.insert), `${d.insert}: с очком в ${d.node} открыта`).toBe(true);
      save.sockets = { [carrier.id]: [d.insert] };
      expect(resolveActive(cfg, save, carrier.id)!.applied.map((i) => i.id), d.insert).toEqual([d.insert]);
    }
  });
});

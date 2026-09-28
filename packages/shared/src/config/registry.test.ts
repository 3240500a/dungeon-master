import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from './registry.js';
import { EventBus } from '../events/index.js';
import { parseClientFrame, parseTownCommand, validateInput } from '../session/netSchemas.js';
import {
  WIRE_BELT_SLOTS, WIRE_CELL_MAX, WIRE_DIFFICULTY_ID_MAX, WIRE_FINISH_ROWS, WIRE_ID_MAX, WIRE_QUEST_TEMPLATE_ID_MAX,
  WIRE_RUN_MODIFIERS_MAX, WIRE_SOCKETS, WIRE_STASH_TABS,
} from '../session/wireLimits.js';
import { isSafeKey } from '../formulas/craft.js';
import { questFromTemplate } from '../economy/questLogic.js';
import { createRng } from '../formulas/rng.js';

describe('ConfigRegistry', () => {
  it('загружает и валидирует все встроенные конфиги', () => {
    const reg = new ConfigRegistry();
    expect(() => reg.loadAll()).not.toThrow();
    expect(reg.get('classes')).toHaveLength(7);
    expect(reg.get('balance').xpTable[0]).toBe(0);
  });

  it('reload эмитит config:reloaded с изменёнными ключами', () => {
    const bus = new EventBus();
    const reg = new ConfigRegistry(bus);
    reg.loadAll();
    let received: string[] = [];
    bus.on('config:reloaded', (p) => (received = p.keys));
    reg.reload({ balance: { ...reg.get('balance'), respecCost: 999 } });
    expect(received).toEqual(['balance']);
    expect(reg.get('balance').respecCost).toBe(999);
  });

  it('бросает на невалидном конфиге', () => {
    const reg = new ConfigRegistry();
    reg.loadAll();
    expect(() => reg.reload({ balance: { broken: true } })).toThrow();
  });

  it('D19: шанс прока статуса (debuffs.weapon/monster) — доля [0, 1]: 1.2 не пройдёт ни в файле, ни из редактора', () => {
    const reg = new ConfigRegistry();
    reg.loadAll();
    const rows = reg.get('debuffs');
    for (const d of rows) {
      expect(d.weapon.chance, `${d.id}.weapon`).toBeLessThanOrEqual(1);
      expect(d.monster.chance, `${d.id}.monster`).toBeLessThanOrEqual(1);
    }
    for (const side of ['weapon', 'monster'] as const) {
      const bad = structuredClone(rows);
      bad[0]![side].chance = 1.2;
      expect(() => reg.reload({ debuffs: bad }), side).toThrow();
      const edge = structuredClone(rows);
      edge[0]![side].chance = 1;
      expect(() => reg.reload({ debuffs: edge }), `${side}: ровно 1 — можно`).not.toThrow();
    }
  });

  /**
   * ⚠ R2-27: потолки ПРОВОДА (`session/wireLimits.ts`) — они же потолки конфига. Иначе дизайнер заводил тир
   * сложности с id длиннее 32 — и «Войти» молча не делало ничего (кадр `descend` отбрасывался без ответа),
   * 33-я строка доводки получала «Неверная команда», а скилл с id длиннее 64 ронял весь кадр ввода.
   * Сторож с обеих сторон: ровно на потолке конфиг грузится И провод пропускает; на единицу выше — конфиг отвергает.
   */
  describe('⚠ R2-27: конфиг не пропускает того, что отвергнет провод', () => {
    const reg = new ConfigRegistry();
    reg.loadAll();
    const id = (n: number): string => 'x'.repeat(n);
    type Case = { what: string; key: Parameters<ConfigRegistry['get']>[0]; at: (d: any, n: number) => void; cap: number };
    const cases: Case[] = [
      { what: 'id тира сложности', key: 'difficulties', cap: WIRE_DIFFICULTY_ID_MAX, at: (d, n) => { d[0].id = id(n); } },
      { what: 'строк доводки', key: 'balance', cap: WIRE_FINISH_ROWS, at: (d, n) => { d.craft.finish = Array.from({ length: n }, (_, i) => ({ ...d.craft.finish[0], id: `f${i}` })); } },
      { what: 'id узла древа скилов', key: 'skill-tree', cap: WIRE_ID_MAX, at: (d, n) => { d.nodes[0].id = id(n); } },
      { what: 'id узла мастерства', key: 'mastery-tree', cap: WIRE_ID_MAX, at: (d, n) => { d.nodes[0].id = id(n); } },
      { what: 'id вставки', key: 'skill-inserts', cap: WIRE_ID_MAX, at: (d, n) => { d[0].id = id(n); } },
      { what: 'id детали оружия', key: 'weapon-parts', cap: WIRE_ID_MAX, at: (d, n) => { d[0].id = id(n); } },
      { what: 'id биома', key: 'biomes', cap: WIRE_ID_MAX, at: (d, n) => { d[0].id = id(n); } },
      { what: 'id шаблона забега', key: 'run-templates', cap: WIRE_ID_MAX, at: (d, n) => { d[0].id = id(n); } },
      { what: 'id модификатора', key: 'run-modifiers', cap: WIRE_ID_MAX, at: (d, n) => { d[0].id = id(n); } },
      { what: 'модификаторов забега', key: 'run-modifiers', cap: WIRE_RUN_MODIFIERS_MAX, at: (d, n) => { const r = d[0]; d.length = 0; for (let i = 0; i < n; i++) d.push({ ...r, id: `m${i}` }); } },
      { what: 'id основного квеста', key: 'quests.main', cap: WIRE_ID_MAX, at: (d, n) => { d[0].id = id(n); } },
      { what: 'вкладок сундука', key: 'balance', cap: WIRE_STASH_TABS, at: (d, n) => { d.stash.tabs = n; } },
      { what: 'столбцов сумки', key: 'balance', cap: WIRE_CELL_MAX + 1, at: (d, n) => { d.inventory.cols = n; } },
      { what: 'строк сундука', key: 'balance', cap: WIRE_CELL_MAX + 1, at: (d, n) => { d.stash.rows = n; } },
      { what: 'гнёзд скила', key: 'balance', cap: WIRE_SOCKETS, at: (d, n) => { d.skillSocketRanks = Array.from({ length: n }, (_, i) => i + 1); } },
    ];
    for (const c of cases) {
      it(`${c.what}: ${c.cap} — можно, ${c.cap + 1} — отказ`, () => {
        const edge = structuredClone(reg.get(c.key)) as any;
        c.at(edge, c.cap);
        expect(() => reg.reload({ [c.key]: edge }), 'ровно потолок').not.toThrow();
        const over = structuredClone(reg.get(c.key)) as any;
        c.at(over, c.cap + 1);
        expect(() => reg.reload({ [c.key]: over }), 'на единицу выше').toThrow();
        reg.loadAll();
      });
    }

    it('шаблон случайного квеста: id в пределах, чтобы и собранный из него id квеста влез в провод', () => {
      const tpl = reg.get('quests.random');
      const ok = structuredClone(tpl) as any;
      ok[0].id = id(WIRE_QUEST_TEMPLATE_ID_MAX);
      expect(() => reg.reload({ 'quests.random': ok })).not.toThrow();
      const q = questFromTemplate(reg.get('quests.random')[0]!, createRng(1), `${Date.now().toString(36)}99`);
      expect(parseTownCommand({ cmd: 'acceptQuest', questId: q.id }).ok, q.id).toBe(true);
      const over = structuredClone(tpl) as any;
      over[0].id = id(WIRE_QUEST_TEMPLATE_ID_MAX + 1);
      expect(() => reg.reload({ 'quests.random': over })).toThrow();
      reg.loadAll();
    });

    it('пояс: слотов не больше, чем номеров на проводе', () => {
      const base = structuredClone(reg.get('items.base')) as any[];
      const belt = base.find((b) => b.kind === 'armor' && b.slot === 'belt');
      belt.beltSlots = WIRE_BELT_SLOTS;
      expect(() => reg.reload({ 'items.base': base })).not.toThrow();
      belt.beltSlots = WIRE_BELT_SLOTS + 1;
      expect(() => reg.reload({ 'items.base': base })).toThrow();
      reg.loadAll();
    });

    it('провод пропускает значения РОВНО на потолке', () => {
      expect(parseClientFrame(JSON.stringify({ t: 'descend', difficultyId: id(WIRE_DIFFICULTY_ID_MAX) }))).not.toBeNull();
      const mods = Array.from({ length: WIRE_RUN_MODIFIERS_MAX }, () => id(WIRE_ID_MAX));
      expect(parseClientFrame(JSON.stringify({ t: 'descend', runConfig: { biomeId: id(WIRE_ID_MAX), templateId: id(WIRE_ID_MAX), modifiers: mods } }))).not.toBeNull();
      expect(validateInput({ move: { x: 0, y: 0 }, facing: 0, attack: false, interact: false, cast: id(WIRE_ID_MAX), useBelt: WIRE_BELT_SLOTS - 1 })).not.toBeNull();
      const pick = { id: id(WIRE_ID_MAX), step: 1 };
      const craft = { cmd: 'craft', nonce: 'nonce-0001', input: { weaponClass: 'sword', hands: 1, parts: { strike: pick, grip: pick, bind: pick, head: pick }, finish: WIRE_FINISH_ROWS - 1 } };
      for (const cmd of [
        craft,
        { cmd: 'allocSkill', nodeId: id(WIRE_ID_MAX) }, { cmd: 'allocPassive', nodeId: id(WIRE_ID_MAX) },
        { cmd: 'bind', slot: 0, value: id(WIRE_ID_MAX) },
        { cmd: 'socketInsert', nodeId: id(WIRE_ID_MAX), slot: WIRE_SOCKETS - 1, insertId: id(WIRE_ID_MAX) },
        { cmd: 'stashMove', uid: 'a', dst: WIRE_STASH_TABS - 1, x: WIRE_CELL_MAX, y: WIRE_CELL_MAX },
        { cmd: 'moveItem', uid: 'a', x: WIRE_CELL_MAX, y: WIRE_CELL_MAX },
        { cmd: 'acceptQuest', questId: id(WIRE_ID_MAX) },
      ]) expect(parseTownCommand(cmd).ok, JSON.stringify(cmd).slice(0, 60)).toBe(true);
    });
  });
});

/**
 * ⚠ R6-17: УЗЕЛ ДРЕВА СКИЛОВ СТОИТ РОВНО ОДНО ОЧКО ЗА РАНГ. Вложение списывало `cost.amount`, а сброс (`respecSkills`)
 * возвращает очко за ранг: узел за 0 очков (редактор это разрешал) печатал очки скилов за золото без предела, узел за 2 терял
 * половину вложенного на сбросе. Схема дерева держит ставку, на которой стоит сброс.
 */
describe('⚠ R6-17: цена узла древа скилов', () => {
  const withCost = (cost: unknown) => {
    const r = new ConfigRegistry();
    r.loadAll();
    const tree = structuredClone(r.get('skill-tree')) as { nodes: { cost: unknown }[] };
    tree.nodes[0]!.cost = cost;
    return () => r.reload({ 'skill-tree': tree });
  };
  it('⭐ 0 очков, 2 очка, дробь и «золото» — отказ валидации; 1 очко — как в данных', () => {
    for (const bad of [{ type: 'points', amount: 0 }, { type: 'points', amount: 2 }, { type: 'points', amount: 0.5 }, { type: 'gold', amount: 1 }]) {
      expect(withCost(bad), JSON.stringify(bad)).toThrow(/Узел древа скилов стоит ровно 1 очко/);
    }
    expect(withCost({ type: 'points', amount: 1 })).not.toThrow();
  });
});

/**
 * ⚠ R7-20: ОКНО РЕКОННЕКТА — НЕ ДОЛЬШЕ ТАЙМЕРА NODE. Окно заводит `setTimeout` комнаты, а он держит не больше 2^31−1 мс
 * (~24,8 суток): дольше — срабатывание через 1 мс, и щедрое окно «на 30 суток» из редактора хоронило каждого отвалившегося
 * в подземелье сразу (штраф смерти, снятый забег). Схема держит потолок 2 000 000 с (~23 суток).
 */
describe('⚠ R7-20: потолок окна реконнекта', () => {
  const withGrace = (sec: number) => {
    const r = new ConfigRegistry();
    r.loadAll();
    return () => r.reload({ balance: { ...r.get('balance'), reconnectGraceSec: sec } });
  };
  it('⭐ 3 000 000 и 30 суток — отказ валидации; ровно 2 000 000 и час из данных — можно', () => {
    expect(withGrace(3_000_000)).toThrow();
    expect(withGrace(30 * 24 * 3600)).toThrow();
    expect(withGrace(2_000_000)).not.toThrow();
    expect(withGrace(3600)).not.toThrow();
    expect(2_000_000 * 1000, 'потолок схемы укладывается в таймер Node').toBeLessThanOrEqual(2 ** 31 - 1);
  });
});

/**
 * ⚠ R10-10: id МАТЕРИАЛА КРАФТА И ШАБЛОНА ДОСКИ — ТОЛЬКО БЕЗОПАСНЫЙ КЛЮЧ (`isSafeKey`: латиница, цифры, `_` и `-`, не ключ
 * прототипа). Ими ключуются кошелёк сырья аккаунта, оплата ковки (`craftPaid`) и квота доски (`boardQuota`), а сторожа формы
 * из базы (`cleanWallet`, `meltReturn`, `noteGeneration`) всё прочее молча отбрасывают. Схема пускала любой текст: материал
 * «руда-1» из редактора стирался из кошелька при каждой загрузке сундука, переплавка его не возвращала, а шаблон «вылазка» не
 * держал квоту — то же задание тут же бралось с доски альта (R3-10 снова). Теперь такой id не пропустит редактор.
 */
describe('⚠ R10-10: id материала и шаблона доски — безопасный ключ', () => {
  /** Свежий реестр на каждую попытку: принятая правка не должна течь в соседнюю проверку. */
  const fresh = (): ConfigRegistry => { const x = new ConfigRegistry(); x.loadAll(); return x; };
  const withMaterial = (id: string) => () => {
    const x = fresh();
    const mats = structuredClone(x.get('craft-materials'));
    mats.push({ ...mats[0]!, id, family: 'ore' });
    x.reload({ 'craft-materials': mats });
  };
  const withTemplate = (id: string) => () => {
    const x = fresh();
    const tpls = structuredClone(x.get('quests.random'));
    tpls[0]!.id = id;
    x.reload({ 'quests.random': tpls });
  };

  it('⭐ материал «руда-1», «ore.1», «ore 1», «__proto__» — отказ валидации; «ore-1» и «ore_1» — можно', () => {
    for (const bad of ['руда-1', 'ore.1', 'ore 1', '__proto__', 'constructor', '']) expect(withMaterial(bad), bad).toThrow();
    for (const ok of ['ore-1', 'ore_1']) expect(withMaterial(ok), ok).not.toThrow();
  });

  it('⭐ шаблон доски «rnd.delve», «вылазка», «__proto__» — отказ валидации; «rnd_delve» — можно', () => {
    for (const bad of ['rnd.delve', 'вылазка', 'rnd delve', '__proto__']) expect(withTemplate(bad), bad).toThrow();
    expect(withTemplate('rnd_delve')).not.toThrow();
  });

  it('встроенные данные — все такие', () => {
    const r = fresh();
    for (const m of r.get('craft-materials')) expect(isSafeKey(m.id), m.id).toBe(true);
    for (const t of r.get('quests.random')) expect(isSafeKey(t.id), t.id).toBe(true);
  });
});

/**
 * ⚠ C-02: НАГРАДА И ВИЛКИ ЗАДАНИЙ — ЦЕЛЫЕ, НЕ МЕНЬШЕ НУЛЯ, ВИЛКА НЕ ПЕРЕВЁРНУТА. Схемы `quests.main`/`quests.random` пускали любое
 * число: опечатка знака в редакторе (`rewardGoldRange` [−500, −400]) — и каждая сдача задания этого шаблона уводила золото героя в
 * минус (100 → −353), `skillPoints` 0.5 в цепочке давал дробные очки скилов, и всё это писалось в базу. `amountRange` [0, 0] собирал
 * задание, которое не выполнить никогда: счётчик «0 из 0» не сдвигается, и «выполнено» не наступает.
 */
describe('⚠ C-02: награда и вилки заданий', () => {
  /** Свежий реестр на каждую попытку: принятая правка не должна течь в соседнюю проверку. */
  const fresh = (): ConfigRegistry => { const x = new ConfigRegistry(); x.loadAll(); return x; };
  type RangeKey = 'amountRange' | 'rewardGoldRange' | 'rewardXpRange';
  const withRange = (key: RangeKey, v: unknown) => () => {
    const x = fresh();
    const tpls = structuredClone(x.get('quests.random')) as unknown as Record<string, unknown>[];
    tpls[0]![key] = v;
    x.reload({ 'quests.random': tpls });
  };
  const withReward = (patch: Record<string, unknown>) => () => {
    const x = fresh();
    const main = structuredClone(x.get('quests.main'));
    main[0]!.reward = { ...main[0]!.reward, ...patch };
    x.reload({ 'quests.main': main });
  };

  it('⭐ вилка доски: минус, дробь, перевёрнутая, ноль заданий — отказ валидации; целые по порядку — можно', () => {
    const bad: [RangeKey, unknown][] = [
      ['rewardGoldRange', [-500, -400]], ['rewardGoldRange', [10.5, 20]], ['rewardGoldRange', [200, 80]], ['rewardGoldRange', [-1, 5]],
      ['rewardXpRange', [-10, 5]], ['rewardXpRange', [80, 180.5]], ['rewardXpRange', [240, 110]],
      ['amountRange', [0, 0]], ['amountRange', [0, 3]], ['amountRange', [1.5, 3]], ['amountRange', [12, 5]], ['amountRange', [-2, 3]],
    ];
    for (const [key, v] of bad) expect(withRange(key, v), `${key} ${JSON.stringify(v)}`).toThrow();
    const ok: [RangeKey, unknown][] = [
      ['rewardGoldRange', [0, 0]], ['rewardGoldRange', [7, 7]], ['rewardXpRange', [0, 0]], ['amountRange', [1, 1]], ['amountRange', [2, 9]],
    ];
    for (const [key, v] of ok) expect(withRange(key, v), `${key} ${JSON.stringify(v)}`).not.toThrow();
  });

  it('⭐ награда цепочки: золото −1000.25 и −1, очки 0.5 и −1, опыт −5 и 1.5 — отказ валидации; ноль и целые — можно', () => {
    for (const bad of [{ gold: -1000.25 }, { gold: -1 }, { gold: 10.5 }, { skillPoints: 0.5 }, { skillPoints: -1 }, { xp: -5 }, { xp: 1.5 }]) {
      expect(withReward(bad), JSON.stringify(bad)).toThrow();
    }
    for (const ok of [{ gold: 0 }, { gold: 100 }, { skillPoints: 0 }, { skillPoints: 2 }, { xp: 0 }, { xp: 250 }]) {
      expect(withReward(ok), JSON.stringify(ok)).not.toThrow();
    }
  });

  it('встроенные данные — все такие; задание с доски из любого шаблона выполнимо, награда — целые не меньше нуля', () => {
    const r = fresh();
    for (const q of r.get('quests.main')) {
      for (const k of ['gold', 'xp', 'skillPoints'] as const) {
        const v = q.reward[k];
        if (v !== undefined) expect(Number.isSafeInteger(v) && v >= 0, `${q.id}.${k}=${v}`).toBe(true);
      }
    }
    for (const tpl of r.get('quests.random')) {
      for (let seed = 1; seed <= 50; seed++) {
        const q = questFromTemplate(tpl, createRng(seed), `c02${seed}`);
        for (const o of q.objectives) expect(Number.isSafeInteger(o.amount) && o.amount >= 1, `${q.id} ${o.id}=${o.amount}`).toBe(true);
        for (const v of [q.reward.gold, q.reward.xp]) expect(Number.isSafeInteger(v) && v! >= 0, `${q.id} ${JSON.stringify(q.reward)}`).toBe(true);
      }
    }
  });
});

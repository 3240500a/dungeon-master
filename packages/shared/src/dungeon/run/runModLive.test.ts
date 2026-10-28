import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../../config/registry.js';
import { createRng } from '../../formulas/rng.js';
import { newBotSave } from '../../sim/playerBot.js';
import { generateMonster } from '../../formulas/monstergen.js';
import { GameSession } from '../../session/session.js';
import { Cell, makeGrid, cellToWorld } from '../../world/grid.js';
import { spawnPacksEl, applyMonsterBuffs } from '../floor.js';
import { runModBuffs, runModCount, RUN_MOD_STAT_LIST, NO_RUN_BUFFS, liveModStats } from './runModEffects.js';
import { altarModifiers } from './runModifiers.js';
import { generateRunPlan, defaultRunConfig } from './generateRunPlan.js';
import { RUN_MOD_LIVE_STATS, runModifierLive } from './runModifiers.js';
import type { DungeonLayout } from '../floorCommon.js';

/**
 * ⭐⭐ Ф5-0 (16.10): У КАЖДОГО ЖИВОГО СТАТА ЕСТЬ ШОВ — И ОН ДЕЙСТВУЕТ.
 *
 * ⚠⚠ ЗАЧЕМ ЭТОТ СТОРОЖ. До Ф5-0 `RUN_MOD_LIVE_STATS` было пустым, и это было ЧЕСТНО: ни один эффект не применялся
 * нигде, поэтому алтарь не предлагал ничего. Главная опасность теперь обратная — внести стат в список и забыть шов:
 * тогда алтарь (а за ним и печати Ф5) снова начнёт обещать несделанное, но уже молча. Поэтому список живых статов
 * сверяется с ИСХОДОМ: на каждый стат — замер «с модификатором против без», в нужную сторону.
 *
 * ⚠ Поток случайности при этом не сдвигается: размер пачки берётся одним броском в изменённых границах, редкость —
 * одним `rr` на монстра против изменённого порога. Поэтому сравнение идёт на ОДНОМ сиде.
 */
const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();

/** Этаж-заготовка: одна комната на сплошном полу (spawnPacksEl читает только rooms+grid). */
function oneRoom(): DungeonLayout {
  const grid = makeGrid(24, 24, Cell.Floor);
  return { grid, rooms: [{ x: 2, y: 2, w: 12, h: 12, type: 'small', content: undefined }] } as unknown as DungeonLayout;
}

/** Конфиг с одним модификатором: стат `stat`, множитель `value`. */
function withMod(stat: string, value: number): ConfigRegistry {
  const r = new ConfigRegistry();
  r.loadAll();
  r.reload({
    'run-modifiers': [{
      id: 'probe', name: 'Проба', kind: 'suffix', tier: 1, scope: 'run', enabled: true, tags: ['danger'], weight: 1,
      desc: 'Проба шва', effects: [{ stat, op: 'mul', value }],
    }],
  });
  return r;
}

function spawn(r: ConfigRegistry, ids: string[], seed = 4242): ReturnType<typeof spawnPacksEl> {
  const buffs = runModBuffs(r.get('run-modifiers'), ids);
  return spawnPacksEl(r, oneRoom(), 7, 'normal', createRng(seed), r.get('biomes')[0]!.monsterPool, 1, 'crypt-halls', 1, undefined, buffs);
}

describe('⭐⭐ Ф5-0: живые статы модификаторов действуют', () => {
  it('⭐⭐ список живых статов = тот, у которого есть шов (и он не пуст)', () => {
    expect([...RUN_MOD_LIVE_STATS].sort()).toEqual([...RUN_MOD_STAT_LIST].sort());
    expect(RUN_MOD_LIVE_STATS.size, 'пустой список = алтарь ничего не предлагает (так было до Ф5-0)').toBe(12);
  });

  it('⭐⭐ ЗАСЕЛЕНИЕ: packSize множит пачку, monsterRarity — долю небычных', () => {
    const big = withMod('packSize', 2);
    const plain = spawn(big, []).length;
    const more = spawn(big, ['probe']).length;
    console.log(`Ф5-0 packSize ×2: монстров ${plain} → ${more}`);
    expect(more, 'пачки крупнее').toBeGreaterThan(plain);

    const rare = withMod('monsterRarity', 6);
    const share = (ids: string[]): number => {
      const m = spawn(rare, ids);
      return m.filter((s) => (s.def as { rarity?: string }).rarity !== 'normal').length / Math.max(1, m.length);
    };
    const a = share([]), b = share(['probe']);
    console.log(`Ф5-0 monsterRarity ×6: доля небычных ${(a * 100).toFixed(1)} % → ${(b * 100).toFixed(1)} %`);
    expect(b, 'редких и магических стало больше').toBeGreaterThan(a);
  });

  /**
   * ⚠⚠ 23.10: СТОРОЖ МЕРИТ ПОЛЯ, КОТОРЫЕ ЧИТАЕТ БОЙ, А НЕ ПРОИЗВОДНЫЕ. До этой правки случай смотрел
   * на `def.damage` — СРЕДНЕЕ «для совместимости со старым кодом», — и был зелёным, пока шов правил то же самое
   * поле: удар монстра катается по `minDamage..maxDamage` (`buildMonsterPacket`), и множитель урона НЕ ДЕЛАЛ
   * НИЧЕГО (замер: ×1.25…×3 давали один и тот же бой, ttk 7.0 с во всех пяти точках), а печать «Яростные»
   * была ЧИСТОЙ НАГРАДОЙ. Поэтому урон проверяется ЕЩЁ И НАСТОЯЩИМ БОЕМ — как награда ниже.
   */
  it('⭐⭐ МОНСТР: жизнь, урон, скорость атаки и хода — в полях, которые ЧИТАЕТ бой', () => {
    const rows: string[] = [];
    for (const [stat, fields] of [
      ['monsterHp', ['hp']], ['monsterDamage', ['minDamage', 'maxDamage']],
      ['monsterAttackSpeed', ['attackSpeed']], ['monsterMoveSpeed', ['moveSpeed']],
    ] as const) {
      const r = withMod(stat, 2);
      const before = spawn(r, [])[0]!.def as unknown as Record<string, number>;
      const after = spawn(r, ['probe'])[0]!.def as unknown as Record<string, number>;
      for (const field of fields) {
        rows.push(`${stat.padEnd(18)} ${field}: ${before[field]} → ${after[field]}`);
        expect(after[field], `${stat} действует (${field})`).toBeGreaterThan(before[field]!);
      }
    }
    console.log('Ф5-0 МОНСТР (×2)\n  ' + rows.join('\n  '));
  });

  it('⭐⭐ УРОН МОНСТРА — НАСТОЯЩИМ БОЕМ: первый его удар по игроку больнее', () => {
    /** Первый прошедший удар монстра по стоящему игроку (один сид — один и тот же бросок в вилке урона). */
    const firstHit = (ids: string[]): number => {
      const r = withMod('monsterDamage', 2);
      const s = new GameSession(r, 99, 'normal');
      const p = s.addPlayer('p1', newBotSave(r, 'warrior'));
      const mrng = createRng(4);
      const def = generateMonster(r.get('monsters'), r.get('monster-gear'), r.get('monster-affixes'),
        { baseId: r.get('biomes')[0]!.monsterPool[0]!, depth: 3 }, mrng);
      applyMonsterBuffs(def, runModBuffs(r.get('run-modifiers'), ids));
      def.hp = 1e6;   // мерим ЕГО удар, а не скорость своей смерти
      const grid = makeGrid(20, 12, Cell.Floor);
      const mpos = cellToWorld(7, 6);
      s.enterFloor(3, { grid, spawn: cellToWorld(6, 6), monsters: [{ def, x: mpos.x, y: mpos.y }] } as never);
      for (let i = 0; i < 600 && p.alive; i++) {
        for (const e of s.tick(1 / 30, { p1: { move: { x: 0, y: 0 }, facing: 0, attack: false, cast: null, interact: false } as never })) {
          if (e.type === 'hit' && e.target === 'player' && e.hit && !e.blocked && e.amount > 0) return e.amount;
        }
      }
      return 0;
    };
    const plain = firstHit([]);
    const buffed = firstHit(['probe']);
    console.log(`Ф5-0 УРОН МОНСТРА (×2): первый удар ${plain.toFixed(1)} → ${buffed.toFixed(1)}`);
    expect(plain, 'без модификатора монстр всё равно бьёт').toBeGreaterThan(0);
    expect(buffed, 'множитель урона доходит до удара (было: правили производное `damage`, и бой его не видел)').toBeGreaterThan(plain * 1.5);
  });

  /**
   * ⭐⭐ Ф5-6″ (23.10): ДВА СЧЁТНЫХ ШВА — «ЛОГОВО» И «СТОРОЖЕВОЙ». Правило файла то же: внёс стат в живой список —
   * покажи ИСХОД. У этих швов исход виден В ЗАСЕЛЕНИИ: у логова вся пачка выбранной комнаты становится РЕДКОЙ,
   * у сторожевого в пачке появляется УНИК с надбавкой уровня.
   *
   * ⚠ И проверяется ещё одно, чего у множителей нет: ОСНОВНОЕ ЗАСЕЛЕНИЕ НЕ СДВИНУЛОСЬ. События работают ПОСЛЕ
   * него именно для этого — число монстров и их места обязаны остаться теми же, иначе печать собирала бы не «тот
   * же этаж, но злее», а другой этаж.
   */
  it('⭐⭐ СОБЫТИЯ: логово делает комнату редкой, сторожевой ставит чемпиона — и раскладка не поехала', () => {
    const lair = withMod('elitePacks', 1 + reg.get('run-mod-stats').find((s) => s.id === 'elitePacks')!.perUnit);
    const plain = spawn(lair, []);
    const withLair = spawn(lair, ['probe']);
    expect(withLair.length, 'монстров столько же: событие не меняет раскладку').toBe(plain.length);
    for (let i = 0; i < plain.length; i++) {
      expect({ x: withLair[i]!.x, y: withLair[i]!.y }, `место монстра ${i}`).toEqual({ x: plain[i]!.x, y: plain[i]!.y });
    }
    const rareBefore = plain.filter((s) => (s.def as { rarity?: string }).rarity === 'rare').length;
    const rareAfter = withLair.filter((s) => (s.def as { rarity?: string }).rarity === 'rare').length;
    console.log(`Ф5-6″ ЛОГОВО: редких в раскладке ${rareBefore} → ${rareAfter} (монстров ${plain.length})`);
    expect(rareAfter, 'логово обязано добавить редких').toBeGreaterThan(rareBefore);

    const warden = withMod('miniBosses', 1 + reg.get('run-mod-stats').find((s) => s.id === 'miniBosses')!.perUnit);
    const noChamp = spawn(warden, []);
    const champ = spawn(warden, ['probe']);
    expect(champ.length, 'чемпион встаёт В ПАЧКУ, а не добавляется сверх неё').toBe(noChamp.length);
    const uniqAfter = champ.filter((s) => (s.def as { rarity?: string }).rarity === 'unique');
    console.log(`Ф5-6″ СТОРОЖЕВОЙ: уников ${noChamp.filter((s) => (s.def as { rarity?: string }).rarity === 'unique').length} → ${uniqAfter.length}, уровень чемпиона ${uniqAfter[0] ? (uniqAfter[0].def as { level: number }).level : '—'} против этажа ${(noChamp[0]!.def as { level: number }).level}`);
    expect(uniqAfter.length, 'сторожевой обязан поставить уника').toBeGreaterThan(0);
    expect((uniqAfter[0]!.def as { level: number }).level, 'чемпион глубже этажа (надбавка ранга «мини»)')
      .toBeGreaterThan((noChamp[0]!.def as { level: number }).level);
  });

  /**
   * ⭐⭐ Ф5-6″: ПРАВИЛО СЧЁТА — ТАБЛИЦЕЙ, И ТА ЖЕ ТАБЛИЦА СТОИТ В UNITY (`Altar.RunModCount`,
   * случай `PortalCheck`). Расхождение на одну штуку — это окно, обещающее два логова, и этаж с одним.
   *
   * ⚠ Порог четверти — не красота: доля ниже половины округлилась бы в НОЛЬ, и печать, зажатая
   * допуском связки, молча не давала бы ничего — игрок заплатил и не получил.
   */
  it('⭐⭐ правило счёта событий — та же таблица, что в Unity', () => {
    // ⭐⭐ 23.10 (правка по ревизии): СКОЛЬКО ЦЕН ОПЛАТИЛ — СТОЛЬКО СОБЫТИЙ. Прежний «спасательный
    // порог 0.25» дарил событие дешевле цены (замер: зачтено 0.6, выдано логово ценой 1.4), и его больше нет.
    const table: [number, number, number][] = [
      [1, 1, 0], [1.99, 1, 0], [2, 1, 1], [2.99, 1, 1], [3, 1, 2], [3.5, 1, 2],
      [1.9, 0.9, 1], [2.8, 0.9, 2], [3.7, 0.9, 3], [1.89, 0.9, 0],
      [2.4, 1.4, 1], [3.8, 1.4, 2], [2.39, 1.4, 0],
      [0.5, 1, 0],
    ];
    for (const [mul, per, want] of table) expect(runModCount(mul, per), `runModCount(${mul}, ${per})`).toBe(want);
    expect(runModCount(2), 'без цены — цена один').toBe(1);
    expect(runModCount(Number.NaN), 'мусор — ноль, а не событие из воздуха').toBe(0);
    expect(runModCount(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('⭐ счётный стат: цена события делит прибавку — «одна печать = одно событие»', () => {
    const per = reg.get('run-mod-stats').find((s) => s.id === 'elitePacks')!.perUnit;
    // Ровно цена → одно событие; вдвое → два; меньше четверти цены → ни одного.
    const rooms = (add: number): number => {
      const r = withMod('elitePacks', 1 + add);
      const before = spawn(r, []);
      const after = spawn(r, ['probe']);
      let changed = 0;
      for (let i = 0; i < before.length; i++) {
        if ((before[i]!.def as { rarity?: string }).rarity !== (after[i]!.def as { rarity?: string }).rarity) changed++;
      }
      return changed;
    };
    const one = rooms(per);
    const none = rooms(per * 0.1);
    console.log(`Ф5-6″ ЦЕНА СОБЫТИЯ (${per} ед. опасности за комнату): по цене изменено монстров ${one}, на десятой доле ${none}`);
    expect(one, 'по цене события комната обязана стать элитной').toBeGreaterThan(0);
    expect(none, 'доля меньше четверти цены события не даёт ничего').toBe(0);
  });

  it('⭐⭐ НАГРАДА: золото и опыт за убийство — настоящим боем, а не подменой внутренностей', () => {
    /** Один бой: герой добивает монстра, считаем выпавшее золото и начисленный опыт. */
    const fight = (stat: string, mult: number, ids: string[]): { gold: number; xp: number } => {
      const r = withMod(stat, mult);
      const s = new GameSession(r, 777, 'normal');
      const save = newBotSave(r, 'warrior');
      const p = s.addPlayer('p1', save);
      const l = r.get('balance').loot as { goldChance: number; dropChance: number; materials: { chance: number }; potions: { chance: number } };
      l.goldChance = 1; l.dropChance = 0; l.materials.chance = 0; l.potions.chance = 0;   // мерим ровно золото и опыт
      const mrng = createRng(4);
      const def = generateMonster(r.get('monsters'), r.get('monster-gear'), r.get('monster-affixes'),
        { baseId: r.get('biomes')[0]!.monsterPool[0]!, depth: 7 }, mrng);
      def.hp = 1; def.armor = 0;
      const grid = makeGrid(20, 12, Cell.Floor);
      const mpos = cellToWorld(7, 6);
      s.enterFloor(7, { grid, spawn: cellToWorld(6, 6), monsters: [{ def, x: mpos.x, y: mpos.y }], floorModifiers: ids } as never);
      const before = p.save.xp;
      for (let i = 0; i < 300 && s.monstersAlive > 0; i++) {
        const m = s.world.monsters[0]!;
        const facing = Math.atan2(m.pos.y - p.pos.y, m.pos.x - p.pos.x);
        s.tick(1 / 30, { p1: { move: { x: 0, y: 0 }, facing, attack: true, cast: null, interact: false } as never });
      }
      const gold = s.world.drops.filter((d) => d.kind === 'gold').reduce((a, d) => a + ((d as { gold: number }).gold ?? 0), 0);
      return { gold, xp: (p.save.xp) - before };
    };

    const g0 = fight('gold', 3, []).gold, g1 = fight('gold', 3, ['probe']).gold;
    const x0 = fight('xp', 3, []).xp, x1 = fight('xp', 3, ['probe']).xp;
    console.log(`Ф5-0 НАГРАДА: золото ${g0} → ${g1} (×3), опыт ${x0} → ${x1} (×3)`);
    expect(g1, 'золото модификатора действует').toBeGreaterThan(g0);
    expect(x1, 'опыт модификатора действует').toBeGreaterThan(x0);
  });

  it('⭐ алтарь снова предлагает модификаторы — те, все эффекты которых живы', () => {
    const live = reg.get('run-modifiers').filter((m) => runModifierLive(m));
    console.log(`Ф5-0 АЛТАРЬ: действующих модификаторов ${live.length} из ${reg.get('run-modifiers').length}`);
    expect(live.length, 'до Ф5-0 их было 0').toBeGreaterThan(0);
    for (const m of live) for (const e of m.effects) expect(RUN_MOD_LIVE_STATS.has(e.stat), `${m.id}: стат ${e.stat}`).toBe(true);
  });

  /**
   * ⭐⭐ 16.10 (просьба владельца «чтобы было в конфигах, а не в коде»): ЧТО ИГРА ПРИМЕНЯЕТ — РЕШАЕТ ТАБЛИЦА
   * `run-mod-stats`, и она правится в редакторе. Код держит только СПИСОК ШВОВ: выключить стат данными можно,
   * выдумать несуществующий — нет (схема принимает лишь id из `RUN_MOD_STAT_SEAMS`).
   */
  it('⭐⭐ КОНФИГ РЕШАЕТ: выключил стат в таблице — модификатор исчез из алтаря и из плана', () => {
    const r = new ConfigRegistry();
    r.loadAll();
    const allowed = r.get('balance').dungeonAccess.allowedModifiers;
    const before = altarModifiers(r.get('run-modifiers'), allowed, liveModStats(r)).map((m) => m.id);
    expect(before, 'пока всё включено — алтарь предлагает').toContain('pack-swarm');

    r.reload({ 'run-mod-stats': r.get('run-mod-stats').map((s) => (s.id === 'packSize' ? { ...s, enabled: false } : s)) });
    const after = altarModifiers(r.get('run-modifiers'), allowed, liveModStats(r)).map((m) => m.id);
    console.log(`КОНФИГ: packSize выключен — алтарь ${before.length} → ${after.length} (${after.join(', ')})`);
    expect(after, 'модификатор выключенного стата исчез').not.toContain('pack-swarm');
    expect(after.length, 'остальные остались').toBeGreaterThan(0);

    // И в план он тоже не доедет: правило одно на алтарь и на генератор.
    const plan = generateRunPlan(r, { ...defaultRunConfig(r, 7), modifiers: ['pack-swarm', 'hardened-foes'] });
    expect(plan.runModifiers, 'выключенный стат не доезжает до забега').not.toContain('pack-swarm');
  });

  it('⚠ сторож сторожа: без модификаторов множители нейтральны, и исход тот же', () => {
    expect(runModBuffs(reg.get('run-modifiers'), [])).toEqual(NO_RUN_BUFFS);
    expect(runModBuffs(reg.get('run-modifiers'), ['нет-такого'])).toEqual(NO_RUN_BUFFS);
    const r = withMod('monsterHp', 2);
    expect(spawn(r, []).map((s) => s.def.hp)).toEqual(spawn(r, []).map((s) => s.def.hp));
  });
});

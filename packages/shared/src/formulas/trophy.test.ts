import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { trophyBaseFor, trophyScore, trophyProfile, monsterTrophyBase, type TrophyCandidate } from './trophy.js';
import { createRng } from './rng.js';
import type { MonsterGearRoll } from '../types/world.js';
import { spawnPacksEl } from '../dungeon/floor.js';
import { resolveMonsterPool } from '../dungeon/floorSpec.js';
import type { DungeonLayout } from '../dungeon/floorCommon.js';
import { Cell, makeGrid } from '../world/grid.js';

/**
 * ⭐ Смысл всей затеи: у монстров свой маленький пул снаряжения, у игрока свой большой, и падать
 * с трупа обязана вещь, которую игрок МОЖЕТ НАДЕТЬ. Тесты стерегут именно это — что для каждой
 * записи снаряжения находится осмысленная замена, а не «что-нибудь».
 */

const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
/** Детерминированный выбор среди равных — тест не должен зависеть от везения. */
const first = { int: (lo: number) => lo };

describe('трофей: снаряжение монстра → база игрока', () => {
  it('класс перевешивает всё остальное: топор становится топором', () => {
    const bases = reg.get('items.base');
    const axe = reg.get('monster-gear').find((g) => g.id === 'u-axe1h')!;
    const got = bases.find((b) => b.id === trophyBaseFor(axe, bases, first))!;
    expect(got.kind).toBe('weapon');
    expect(got.kind === 'weapon' && got.weaponClass).toBe('axe');
    expect(got.kind === 'weapon' && got.hands).toBe(1);
  });

  it('двуручное остаётся двуручным', () => {
    const bases = reg.get('items.base');
    const axe2 = reg.get('monster-gear').find((g) => g.id === 'u-axe2h')!;
    const got = bases.find((b) => b.id === trophyBaseFor(axe2, bases, first))!;
    expect(got.kind === 'weapon' && got.weaponClass).toBe('axe');
    expect(got.kind === 'weapon' && got.hands).toBe(2);
  });

  it('броня сходится по классу И слоту: ржавый койф → шлем-кольчуга', () => {
    const bases = reg.get('items.base');
    const coif = reg.get('monster-gear').find((g) => g.id === 'u-coif')!;
    const got = bases.find((b) => b.id === trophyBaseFor(coif, bases, first))!;
    expect(got.kind).toBe('armor');
    expect(got.kind === 'armor' && got.armorClass).toBe('chain');
    expect('slot' in got && got.slot).toBe('helm');
  });

  it('броня монстра БЕЗ слота — это нагрудник', () => {
    const bases = reg.get('items.base');
    const mail = reg.get('monster-gear').find((g) => g.id === 'u-chain')!;
    const got = bases.find((b) => b.id === trophyBaseFor(mail, bases, first))!;
    expect('slot' in got && got.slot).toBe('chest');
    expect(got.kind === 'armor' && got.armorClass).toBe('chain');
  });

  it('⭐ точного соответствия нет — берём ПОХОЖЕЕ, а не случайное', () => {
    // Метательный топор зомби дальнобойный, а дальнобойных топоров у игрока нет вовсе.
    const bases = reg.get('items.base');
    const thrown = reg.get('monster-gear').find((g) => g.id === 'u-throwaxe')!;
    const got = bases.find((b) => b.id === trophyBaseFor(thrown, bases, first))!;
    expect(got.kind === 'weapon' && got.weaponClass).toBe('axe'); // класс сохранён
    expect(got.kind === 'weapon' && got.hands).toBe(1);           // и число рук тоже
  });

  it('⚠ вид вещи не подменяется никогда: броня не станет оружием', () => {
    const onlyWeapons: TrophyCandidate[] = [{ id: 'w', kind: 'weapon', weaponClass: 'sword' }];
    const mail = reg.get('monster-gear').find((g) => g.id === 'u-chain')!;
    expect(trophyBaseFor(mail, onlyWeapons, first)).toBeUndefined();
  });

  it('явная замена в конфиге перебивает автоподбор', () => {
    const bases = reg.get('items.base');
    const target = bases.find((b) => b.kind === 'weapon')!;
    const src = { kind: 'weapon', weaponClass: 'sword', hands: 1, trophyBase: target.id };
    expect(trophyBaseFor(src, bases, first)).toBe(target.id);
    // ...но только если такая база вообще есть — иначе молча подберём похожее
    expect(trophyBaseFor({ ...src, trophyBase: 'нет-такой' }, bases, first)).not.toBe('нет-такой');
  });

  it('выключенная база в трофеи не попадает', () => {
    const cands: TrophyCandidate[] = [
      { id: 'off', kind: 'weapon', weaponClass: 'axe', hands: 1, enabled: false },
      { id: 'on', kind: 'weapon', weaponClass: 'sword', hands: 1 },
    ];
    expect(trophyBaseFor({ kind: 'weapon', weaponClass: 'axe', hands: 1 }, cands, first)).toBe('on');
  });

  it('⭐ КАЖДОЙ из записей снаряжения монстров есть замена среди вещей игрока', () => {
    const bases = reg.get('items.base');
    for (const g of reg.get('monster-gear')) {
      const id = trophyBaseFor(g, bases, first);
      expect(id, `${g.id} (${g.name}) — нечего уронить с трупа`).toBeTruthy();
      const b = bases.find((x) => x.id === id)!;
      expect(b.kind, `${g.id} → вид не совпал`).toBe(g.kind);
      expect('slot' in b && b.slot, `${g.id} → вещь без слота, надеть нельзя`).toBeTruthy();
    }
  });

  it('⭐ у КАЖДОГО включённого класса оружия есть носитель в снаряжении монстров', () => {
    // `trophyChance` = 1: вещь с трупа — всегда трофей по носимому. Класса, которого не носит никто,
    // с тел не бывает вовсе — и его детали не откроются в журнале ковки (docs/CRAFT_WEAPONS.md §20).
    const bases = reg.get('items.base');
    const classes = new Set<string>();
    for (const b of bases) if (b.kind === 'weapon' && b.enabled !== false && b.weaponClass) classes.add(b.weaponClass);
    for (const a of reg.get('weapon-anatomy')) if (a.enabled !== false) classes.add(a.id);
    expect(classes.size).toBeGreaterThanOrEqual(10);
    const gear = reg.get('monster-gear').filter((g) => g.kind === 'weapon' && g.enabled !== false);
    for (const c of classes) {
      const carriers = gear.filter((g) => g.kind === 'weapon' && g.weaponClass === c);
      expect(carriers.length, `класс «${c}» не носит ни один монстр`).toBeGreaterThan(0);
      // …и носимое переводится в базу ТОГО ЖЕ класса, а не в «похожее по рукам».
      for (const g of carriers) {
        const id = trophyBaseFor(g, bases, first);
        const b = bases.find((x) => x.id === id);
        expect(b && b.kind === 'weapon' ? b.weaponClass : undefined, `${g.id} → трофей чужого класса`).toBe(c);
      }
    }
  });

  it('⭐⭐ КАЖДЫЙ класс оружия ПАДАЕТ с монстра, который реально спавнится в каком-то включённом биоме', () => {
    // ⚠ Запись в `monster-gear` — ещё не носитель, и монстр в `monsterPool` — ещё не спавн: пачки берут
    // монстров ПО РОЛЯМ (`packs.json`), и роль, которой нет ни в одной пачке, не выходит никогда. Замер
    // до F2: в крипте спавнились только scout/warrior/thrower — булава (охранник), посох (колдун, шаман)
    // и арбалет (арбалетчик) лежали в пуле и не падали вовсе, как и копьё, алебарда и жезл без носителей.
    // Поэтому здесь НАСТОЯЩИЙ спавн (`spawnPacksEl` — тот же, что у сервера), по всем включённым биомам,
    // их этажам и тирам глубины, а не чтение пулов.
    const bases = reg.get('items.base');
    const gear = reg.get('monster-gear');
    const classes = new Set<string>();
    for (const b of bases) if (b.kind === 'weapon' && b.enabled !== false && b.weaponClass) classes.add(b.weaponClass);
    for (const a of reg.get('weapon-anatomy')) if (a.enabled !== false) classes.add(a.id);
    const rooms = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ x: 2 + (i % 4) * 16, y: 2 + Math.floor(i / 4) * 16, w: 12, h: 12, type: i % 2 ? 'large' : 'small' }));
    const layout = { grid: makeGrid(68, 36, Cell.Floor), rooms } as unknown as DungeonLayout;
    const dropped = new Map<string, string>();   // класс трофея → кто его уронил (для сообщения)
    for (const biome of reg.get('biomes').filter((b) => b.enabled !== false)) {
      const floorIds = ['', ...reg.get('floors').filter((f) => f.biomeId === biome.id && f.enabled !== false).map((f) => f.id)];
      for (const depth of [1, 4, 7, 11, 16, 23]) {
        for (const floorId of floorIds) {
          for (let seed = 1; seed <= 4; seed++) {
            const spawns = spawnPacksEl(reg, layout, depth, 'normal', createRng(seed * 7919 + depth), depth,
              resolveMonsterPool(biome, depth), 1, floorId);
            for (const s of spawns) {
              const worn = s.def.gearRolls?.find((r) => r.slot === 'weapon')?.gearId;
              const g = worn ? gear.find((x) => x.id === worn) : undefined;
              if (!g) continue;
              const b = bases.find((x) => x.id === trophyBaseFor(g, bases, first));
              if (b?.kind === 'weapon' && !dropped.has(b.weaponClass)) dropped.set(b.weaponClass, `${biome.id}/${s.def.id}`);
            }
          }
        }
      }
    }
    for (const c of classes) expect(dropped.has(c), `класс «${c}» не падает ни с одного монстра, который спавнится`).toBe(true);
  });

  it('счёт сходства: одинаковый класс важнее одинакового числа рук', () => {
    const src = { kind: 'weapon', weaponClass: 'axe', hands: 2 };
    const sameClass = trophyScore(src, { id: 'a', kind: 'weapon', weaponClass: 'axe', hands: 1 });
    const sameHands = trophyScore(src, { id: 'b', kind: 'weapon', weaponClass: 'sword', hands: 2 });
    expect(sameClass).toBeGreaterThan(sameHands);
  });
});

describe('⭐ трофей по ВСЕМ слотам, но в СТИЛЕ монстра', () => {
  const bases = reg.get('items.base');
  const gear = (id: string) => reg.get('monster-gear').find((g) => g.id === id);
  /** Монстр в заданном снаряжении. */
  const worn = (...ids: string[]): MonsterGearRoll[] =>
    ids.map((gearId, i) => ({ slot: i === 0 ? 'weapon' : 'armor', gearId, name: gearId, rarity: 'normal', affixes: [], mods: [], base: {} } as MonsterGearRoll));

  it('профиль берёт класс НАГРУДНИКА, а шлем — только запасной вариант', () => {
    expect(trophyProfile(worn('u-sword1h', 'u-leather', 'u-helm-plate'), gear).armorClass).toBe('leather');
    expect(trophyProfile(worn('u-sword1h', 'u-helm-plate'), gear).armorClass).toBe('plate');
    expect(trophyProfile(worn('u-sword1h'), gear).armorClass).toBeUndefined();
  });

  it('⭐ с кожаного зомби НЕ падают латные перчатки', () => {
    const rolls = worn('u-sword1h', 'u-leather');
    const rng = createRng(5);
    const seen = new Set<string>();
    for (let i = 0; i < 600; i++) {
      const id = monsterTrophyBase(rolls, gear, bases, rng, reg.get('balance').loot.categoryWeights);
      const b = bases.find((x) => x.id === id)!;
      if (b.kind === 'armor') { seen.add(b.armorClass); }
    }
    expect(seen.size).toBeGreaterThan(0);
    expect([...seen]).toEqual(['leather']);     // ровно его класс, без примесей
  });

  it('⭐ закрыты ВСЕ слоты, включая те, что монстр не носит', () => {
    const rolls = worn('u-sword1h', 'u-chain');
    const rng = createRng(9);
    const slots = new Set<string>();
    for (let i = 0; i < 3000; i++) {
      const id = monsterTrophyBase(rolls, gear, bases, rng, reg.get('balance').loot.categoryWeights);
      const b = bases.find((x) => x.id === id)!;
      slots.add('slot' in b && b.slot ? b.slot : '?');
    }
    // до этого с монстров падали только weapon/chest/offhand — пяти слотов не было вовсе
    for (const s of ['weapon', 'chest', 'helm', 'gloves', 'boots', 'belt', 'ring', 'amulet', 'offhand']) {
      expect(slots.has(s), `слот ${s} не выпадает вовсе`).toBe(true);
    }
  });

  it('надетое по-прежнему зеркалится: у лучника падает лук', () => {
    const rolls = worn('u-bow', 'u-quilted');
    const rng = createRng(3);
    const wc = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const id = monsterTrophyBase(rolls, gear, bases, rng, { weapon: 100 });
      const b = bases.find((x) => x.id === id)!;
      if (b.kind === 'weapon') wc.add(b.weaponClass);
    }
    expect([...wc]).toEqual(['bow']);
  });

  it('без снаряжения вовсе трофей всё равно есть — просто без стиля', () => {
    const rng = createRng(1);
    const id = monsterTrophyBase(undefined, gear, bases, rng, reg.get('balance').loot.categoryWeights);
    expect(id).toBeTruthy();
  });
});

import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { createRng } from './rng.js';
import { generateMonster } from './monstergen.js';
import { pickGearTier, tierWeapon, tierArmor, tierShield } from './monsterGearTier.js';

const reg = new ConfigRegistry();
reg.loadAll();
const monsters = reg.get('monsters');
const gear = reg.get('monster-gear');
const affixes = reg.get('monster-affixes');
const ladder = reg.get('monster-gear-tiers');

/** Монстр на уровне L. `tiers` = передать лестницу (как в игре) или нет (как было до ступеней). */
const mon = (id: string, level: number, tiers = true, seed = 1) =>
  generateMonster(monsters, gear, affixes, { baseId: id, depth: level - 1, mderive: reg.get('monster-derive'), ...(tiers ? { gearTiers: ladder } : {}) }, createRng(seed));

const byId = (id: string) => gear.find((g) => g.id === id)!;
const sword = byId('u-sword1h') as Extract<(typeof gear)[number], { kind: 'weapon' }>;
const plate = byId('u-plate') as Extract<(typeof gear)[number], { kind: 'armor' }>;
const shield = byId('u-shield') as Extract<(typeof gear)[number], { kind: 'shield' }>;
/** Ступень по id — для проверки множителей против самой лестницы, а не против зашитых чисел. */
const multOf = (id: string): number => ladder.find((t) => t.id === id)!.statMult;

describe('pickGearTier — ступень снаряжения монстра по его уровню', () => {
  it('ступень берётся по порогу СВОЕЙ строки (fromLevel), а не по лестнице игрока', () => {
    // Ожидания читаются из КОНФИГА, а не из зашитых чисел: правка порогов не валит тест ложно.
    const rungs = [...ladder].sort((a, b) => a.fromLevel - b.fromLevel);
    for (let i = 0; i < rungs.length; i++) {
      const at = rungs[i]!.fromLevel;
      expect(pickGearTier(ladder, sword, at)!.id, `ступень ${rungs[i]!.id} с уровня ${at}`).toBe(rungs[i]!.id);
      expect(pickGearTier(ladder, sword, at)!.statMult).toBe(rungs[i]!.statMult);
      if (i > 0) expect(pickGearTier(ladder, sword, at - 1)!.id, `на ${at - 1} ещё прежняя`).toBe(rungs[i - 1]!.id);
    }
  });

  it('⚠ лестница монстров НЕ совпадает с игроковой: ни порогами, ни длиной', () => {
    // Сторож на саму причину отдельной лестницы (12.10): пороги совпадали с игроковыми, и весь
    // этаж дорожал на +44 % ровно в тот уровень, когда игрок только начал собирать новую ступень.
    // Плюс лестница игрока кончается на 80-м, а забег идёт глубже.
    const player = [...reg.get('item-tiers')].sort((a, b) => a.minItemLevel - b.minItemLevel);
    const mon = [...ladder].sort((a, b) => a.fromLevel - b.fromLevel);
    expect(mon.length, 'ступеней у монстров больше').toBeGreaterThan(player.length);
    expect(mon[1]!.fromLevel, 'первая смена — позже, чем у игрока').toBeGreaterThan(player[1]!.minItemLevel);
    expect(mon[mon.length - 1]!.fromLevel, 'лестница тянется глубже 80-го').toBeGreaterThan(player[player.length - 1]!.minItemLevel);
  });

  /**
   * ⭐ 13.10 (шаг 4 плана «Монстры: план по силе»): ШАГ ЛЕСТНИЦЫ ОДИН И ТОТ ЖЕ НА ВСЕХ СТУПЕНЯХ.
   *
   * Засеянная лестница была неровной: до m6 шаг был ×1.30…×1.39, а после — ×1.07 (затухала). Игрок
   * видел это как «круто до 60, плоско после». Решение владельца: скачок каждые 10 уровней, и каждый — ОДИНАКОВЫЙ
   * новый вызов («девятнадцать ступеней за игру вместо двух скачков D2»). Поэтому сторож на РАВНОМЕРНОСТЬ шага,
   * а не на совпадение с игроком: раннюю игру удерживает первая ступень (×1) и порог второй, а не его таблица.
   */
  it('⭐ шаг лестницы РОВНЫЙ: одно и то же отношение на каждой ступени выше первой', () => {
    const mon = [...ladder].sort((a, b) => a.fromLevel - b.fromLevel);
    expect(mon[0]!.statMult, 'первая ступень — без множителя').toBe(1);
    const steps = mon.slice(2).map((t, i) => t.statMult / mon[i + 1]!.statMult);
    expect(steps.length, 'сторож что-то мерит').toBeGreaterThan(10);
    const off = steps.map((v, i) => ({ i: i + 2, v })).filter((x) => Math.abs(x.v / steps[0]! - 1) > 0.02);
    expect(off.map((x) => `m${x.i}: ×${x.v.toFixed(3)} против ×${steps[0]!.toFixed(3)}`), 'шаг расходится больше чем на 2 %').toEqual([]);
    // И пороги ровные — каждые 10 уровней («новый вызов 19 раз за игру»).
    const gaps = mon.slice(2).map((t, i) => t.fromLevel - mon[i + 1]!.fromLevel);
    expect([...new Set(gaps)], 'пороги идут ровным шагом').toEqual([gaps[0]]);
  });

  it('⚠ лестницы нет в вызове → undefined, и НИЧЕГО не множится (поведение до ступеней)', () => {
    // Сторож на главный риск поставки: сотня существующих тестов и старых инструментов зовут
    // generateMonster без `gearTiers`. Если бы ступень включалась умолчанием, они бы поехали молча.
    expect(pickGearTier(undefined, sword, 80)).toBeUndefined();
    expect(pickGearTier([], sword, 80)).toBeUndefined();
    expect(tierWeapon(sword, undefined)).toBe(sword);          // та же ссылка — ноль аллокаций
    expect(tierArmor(plate, undefined)).toBe(plate);
  });

  it('⚠ maxTier вещи — потолок: уровень 200 не поднимает её выше своего ряда', () => {
    const pinned = { ...sword, minGearTier: 'm0', maxGearTier: 'm1' };
    expect(pickGearTier(ladder, pinned, 200)!.id).toBe('m1');
    expect(pickGearTier(ladder, pinned, 1)!.id).toBe('m0');
  });

  it('⚠ minTier — пол: вещь не опускается ниже своего ряда даже на 1 уровне', () => {
    expect(pickGearTier(ladder, { ...sword, minGearTier: 'm3', maxGearTier: 'm19' }, 1)!.id).toBe('m3');
  });

  it('withLevel:false приколачивает вещь к minTier на любой глубине', () => {
    const junk = { ...sword, minGearTier: 'm0', maxGearTier: 'm19', withLevel: false };
    expect(pickGearTier(ladder, junk, 1)!.id).toBe('m0');
    expect(pickGearTier(ladder, junk, 200)!.id).toBe('m0');
  });
});

describe('tier* — что множится, а что нет', () => {
  it('⚠ урон множится ТОЧНО, без округления на шве: целые делает деривация', () => {
    // Сторож на починку дефекта 12.10: округление здесь давало двойникам разную ошибку середины
    // вилки (меч 7.50 против булавы 8.00 при точных 7.8 у обоих) и выводило их за правило ±5 %.
    const t = { id: 't2', name: 'x', statMult: multOf('m2') };
    const w = tierWeapon(sword, t);
    expect(w.minDamage).toBe(sword.minDamage * t.statMult);
    expect(w.maxDamage).toBe(sword.maxDamage * t.statMult);
    expect(Number.isInteger(w.minDamage) && Number.isInteger(w.maxDamage)).toBe(false); // именно дробь
    expect(w.attackSpeed).toBe(sword.attackSpeed);   // скорость ступенью не трогается (как у игрока)
  });

  it('⚠ БЛОК щита ступенью НЕ множится — это процент, а не стат базы', () => {
    // Мутация «домножить block» прошла бы незаметно на малых ступенях, а на t6 дала бы 108% блока:
    // блок — один из трёх перемножающихся слоёв снижения, лестница не имеет права его двигать.
    const t = { id: 't6', name: 'x', statMult: multOf('m6') };
    const s = tierShield(shield, t);
    expect(s.block).toBe(shield.block);
    expect(s.defense).toBe(shield.defense * t.statMult);
    expect(s.block).toBeLessThanOrEqual(1);
  });

  it('⚠ мин и макс округляются ПОРОЗНЬ, макс не ниже мина, и ЛЕСТНИЦА НЕПРЕРЫВНА (ноль остаётся нулём)', () => {
    // Этот фаззер уже отработал: на `Math.max(1, …)` он поймал разрыв — оружие с minDamage 0
    // на t0 оставалось нулём, а на t1 ступень выдумывала ему 1 урона. Флор снят, сторож остался.
    const rng = createRng(7);
    const sorted = [...ladder].sort((a, b) => a.statMult - b.statMult);
    for (let i = 0; i < 300; i++) {
      const lo = rng.int(0, 30);
      const w = { ...sword, minDamage: lo, maxDamage: lo + rng.int(0, 9) };
      let prevMin = -1, prevMax = -1;
      for (const t of sorted) {
        const r = tierWeapon(w, { id: t.id, name: t.name, statMult: t.statMult });
        expect(r.maxDamage).toBeGreaterThanOrEqual(r.minDamage);
        expect(r.minDamage).toBeGreaterThanOrEqual(prevMin);   // монотонно по ступени
        expect(r.maxDamage).toBeGreaterThanOrEqual(prevMax);
        if (lo === 0) expect(r.minDamage).toBe(0);             // ступень не создаёт урон из ничего
        expect(r.minDamage).toBeCloseTo(w.minDamage * t.statMult, 10); // точно, без квантования
        prevMin = r.minDamage; prevMax = r.maxDamage;
      }
    }
  });

  it('пол урона монстра (не ниже 1) стоит в деривации, а не в ступени — безоружный всё равно бьёт', () => {
    const zero = { ...sword, id: '__zero', minDamage: 0, maxDamage: 0 };
    const tpl = { ...monsters.find((m) => m.id === 'zombie')!, id: '__z0', weapon: '__zero' };
    const m = generateMonster([tpl], [...gear, zero], affixes, { baseId: '__z0', depth: 39, gearTiers: ladder }, createRng(1));
    expect(m.minDamage).toBe(1);
  });

  it('защита 0 не «масштабируется» в 0 новым объектом (пустой слот остаётся тем же)', () => {
    const empty = { ...plate, defense: 0 };
    expect(tierArmor(empty, { id: 't6', name: 'x', statMult: 6 })).toBe(empty);
  });
});

describe('generateMonster — ступень доезжает до боевых статов и до тултипа', () => {
  it('⭐ ОСНОВНОЕ: урон монстра на лестнице уровней растёт сильнее, чем без ступеней', () => {
    // Жалоба владельца: «Зомби 40 уровня бьёт тем же, чем Зомби 2 уровня». Сторож именно на неё.
    const lo = mon('zombie-knight', 2), hiOld = mon('zombie-knight', 40, false), hiNew = mon('zombie-knight', 40);
    const grow = (a: typeof lo, b: typeof lo) => b.damage / a.damage;
    expect(grow(lo, hiNew)).toBeGreaterThan(grow(lo, hiOld) * 1.8);
    expect(hiNew.damage).toBeGreaterThan(hiOld.damage);
  });

  it('⚠ ступень применяется ДО деривации: броня монстра включает УМНОЖЕННУЮ защиту вещи', () => {
    // Мутация «домножить готовые статы монстра в конце» дала бы другое число: вклад `armorPerStr`
    // тоже оказался бы умноженным. Считаем ожидание из конфига, а не из зашитой константы.
    const L = 40, d = reg.get('monster-derive');
    const tpl = monsters.find((m) => m.id === 'zombie-knight')!;
    const g = 1 + (L - 1) * d.levelGrowth;
    const tA = pickGearTier(ladder, plate, L)!, tS = pickGearTier(ladder, shield, L)!;
    // ⚠ Одно округление, и оно В ДЕРИВАЦИИ: защита вещей складывается ТОЧНОЙ, вклад силы — тоже.
    const want = Math.round(plate.defense * tA.statMult + shield.defense * tS.statMult + tpl.str * g * d.armorPerStr);
    expect(mon('zombie-knight', L).armor).toBe(want);
  });

  it('тултип снаряжения несёт ступень и УЖЕ умноженные числа базы', () => {
    const L = 40;
    const m = generateMonster(monsters, gear, affixes, {
      baseId: 'zombie-knight', depth: L - 1, mderive: reg.get('monster-derive'), gearTiers: ladder,
      itemAffixes: reg.get('monster-item-affixes'), rarities: reg.get('rarities'), rarity: 'normal',
    }, createRng(1));
    const w = m.gearRolls!.find((r) => r.slot === 'weapon')!;
    const t = pickGearTier(ladder, sword, L)!;
    expect(w.tier).toBe(t.id);
    expect(w.tierName).toBe(t.name);
    expect(w.base.minDamage).toBe(Math.round(sword.minDamage * t.statMult));
    // ⚠ Без лестницы полей ступени быть НЕ должно: иначе тултип соврёт «t0» там, где ступеней нет вовсе.
    const noLadder = generateMonster(monsters, gear, affixes, {
      baseId: 'zombie-knight', depth: L - 1, itemAffixes: reg.get('monster-item-affixes'), rarities: reg.get('rarities'), rarity: 'normal',
    }, createRng(1));
    expect(noLadder.gearRolls!.find((r) => r.slot === 'weapon')!.tier).toBeUndefined();
  });

  it('⚠ кулаки (фолбэк без оружия) ступенью не растут', () => {
    // `FISTS` стоит `withLevel:false`: безоружный монстр на 80 уровне не обязан бить как мечник.
    const fisted = { ...monsters.find((m) => m.id === 'zombie')!, id: '__t', weapon: 'нет-такого' };
    const mk = (L: number) => generateMonster([fisted], gear, affixes, { baseId: '__t', depth: L - 1, gearTiers: ladder }, createRng(1));
    expect(mk(80).gearRolls).toBeUndefined();            // без itemAffixes роллов нет
    const w = (L: number) => mk(L).minDamage / mk(1).minDamage;
    // урон всё ещё растёт — но ТОЛЬКО от атрибутов, без вклада ступени
    expect(mk(80).minDamage).toBe(Math.round(1 * (1 + (fisted.dex * (1 + 79 * reg.get('monster-derive').levelGrowth)) * reg.get('monster-derive').dmgPerAttr)));
    expect(w(80)).toBeGreaterThan(1);
  });

  it('ступень монотонна по уровню: урон и броня монстра не падают с ростом уровня', () => {
    let prevD = 0, prevA = 0;
    for (const L of [1, 5, 11, 18, 30, 45, 62, 80, 120]) {
      const m = mon('zombie-fighter', L);
      expect(m.damage).toBeGreaterThanOrEqual(prevD);
      expect(m.armor).toBeGreaterThanOrEqual(prevA);
      prevD = m.damage; prevA = m.armor;
    }
  });

  it('⚠ каждая запись monster-gear ссылается на СУЩЕСТВУЮЩИЕ ступени ряда', () => {
    // Опечатка в minTier/maxTier не падает (`pickTierClamped` открывает границу), а молча
    // снимает потолок — вещь уезжает на t6. Ловим сторожем, а не глазами в редакторе.
    const ids = new Set(ladder.map((t) => t.id));
    for (const g of gear) {
      expect(ids.has(g.minGearTier), `${g.id}.minGearTier=${g.minGearTier}`).toBe(true);
      expect(ids.has(g.maxGearTier), `${g.id}.maxGearTier=${g.maxGearTier}`).toBe(true);
      const li = (id: string) => ladder.find((t) => t.id === id)!.fromLevel;
      expect(li(g.minGearTier), `${g.id}: minGearTier выше maxGearTier`).toBeLessThanOrEqual(li(g.maxGearTier));
    }
  });
});

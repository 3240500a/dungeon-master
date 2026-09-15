import { describe, it, expect } from 'vitest';
import { readAnimCfg, defaultStanceName, type AnimStore } from './animConfig.js';
import { resolveStancePose } from './poseLayers.js';
import type { Pose } from './clipModel.js';

/**
 * КОНФИГ КОНТРОЛЛЕРА (`pe_anim`).
 *
 * Два требования, оба сформулированы заказчиком дословно.
 *
 * «Переименовывать ничего не надо — это всё будет настраиваться в контроллере»: клип привязывается
 * ПО ССЫЛКЕ, поэтому `idle_axe_relax` может быть стойкой топора, оставаясь `idle_axe_relax`.
 *
 * «Надо сделать так, чтобы одноручное смешивалось с тем, что в правой руке, и можно было настроить
 * силу смешивания»: тип оверлея, рука и сила — поля предмета.
 *
 * И главный инвариант: ПУСТОЙ конфиг обязан давать ровно сегодняшнее поведение. Иначе заведение
 * файла станет отдельным риском, и заводить его никто не будет.
 */
describe('умолчания: пустой конфиг = как было', () => {
  const cfg = readAnimCfg({}, 'warrior');

  it('⭐ имена стоек — `действие_оружие_состояние`', () => {
    // ⚠ КОНВЕНЦИЯ СМЕНЕНА ПО ПРОСЬБЕ АВТОРА: было `idle_<оружие>` / `combat_idle_<оружие>`, стало
    // `idle_<оружие>_relax` / `idle_<оружие>_incombat` — спокойная и боевая это одно действие в двух
    // состояниях, и так они лежат рядом в списке. Удары конвенции не касаются: они по умолчанию
    // боевые и собираются префиксом `hit_`.
    expect(cfg.clipName('idle', 'none')).toBe('idle_none_relax');
    expect(cfg.clipName('idle', 'sword')).toBe('idle_sword_relax');
    expect(cfg.clipName('combat_idle', 'axe')).toBe('idle_axe_incombat');
    expect(defaultStanceName('idle', 'shield')).toBe('idle_shield_relax');
  });

  it('⚠ ИСТОРИЧЕСКИЕ ИМЕНА ПРОДОЛЖАЮТ НАХОДИТЬСЯ — смена конвенции не обнуляет чужую работу', () => {
    expect(cfg.clipNames('idle', 'sword')).toEqual(['idle_sword_relax', 'idle_sword']);
    expect(cfg.clipNames('combat_idle', 'axe')).toEqual(['idle_axe_incombat', 'combat_idle_axe']);
  });

  it('⚠ ПРИВЯЗКА БЬЁТ ЛЮБУЮ КОНВЕНЦИЮ и идёт первой', () => {
    const b = readAnimCfg({ warrior: { items: { sword: { idle: 'моя_стойка' } } } }, 'warrior');
    expect(b.clipNames('idle', 'sword')[0]).toBe('моя_стойка');
    expect(b.clipNames('idle', 'sword')).toContain('idle_sword_relax');
  });

  it('тип оверлея — по типу предмета', () => {
    expect(cfg.kindOf('sword')).toBe('additive');
    expect(cfg.kindOf('shield')).toBe('additive');
    expect(cfg.kindOf('greatsword')).toBe('override');
    expect(cfg.kindOf('bow')).toBe('override');
  });

  it('рука не навязана, сила — полная', () => {
    expect(cfg.handOf('sword')).toBeUndefined();
    expect(cfg.weightOf('sword')).toBe(1);
    expect(cfg.has('sword')).toBe(false);
  });
});

describe('привязка клипа по ссылке — без переименований', () => {
  const store: AnimStore = {
    warrior: {
      base: { idle: 'idle_relax', combatIdle: 'idle_incombat' },
      items: { axe: { idle: 'idle_axe_relax', combatIdle: 'idle_axe_combat' } },
    },
  };
  const cfg = readAnimCfg(store, 'warrior');

  it('базовые стойки берутся по заданным именам', () => {
    expect(cfg.clipName('idle', 'none')).toBe('idle_relax');
    expect(cfg.clipName('combat_idle', 'none')).toBe('idle_incombat');
  });

  it('имена вне конвенции работают как стойки предмета', () => {
    // Ровно те клипы, что лежат в библиотеке сейчас и стойками НЕ считались.
    expect(cfg.clipName('idle', 'axe')).toBe('idle_axe_relax');
    expect(cfg.clipName('combat_idle', 'axe')).toBe('idle_axe_combat');
  });

  it('предмет без записи всё равно идёт по конвенции', () => {
    expect(cfg.clipName('idle', 'sword')).toBe('idle_sword_relax');
  });
});

describe('настройка подмешивания', () => {
  const cfg = readAnimCfg({
    warrior: { items: {
      shield: { weight: 0.6 },
      torch: { hand: 'off' },
      spear: { kind: 'additive' },      // копьё держат одной рукой в этом сеттинге
      dagger: { weight: 5 },            // за пределами 0..1
      mace: { weight: Number.NaN },
    } },
  } as AnimStore, 'warrior');

  it('сила читается и зажимается в 0..1', () => {
    expect(cfg.weightOf('shield')).toBe(0.6);
    expect(cfg.weightOf('dagger'), 'выше единицы не бывает').toBe(1);
    expect(cfg.weightOf('mace'), 'мусор → умолчание').toBe(1);
  });

  it('тип можно переопределить вопреки списку двуручного', () => {
    expect(cfg.kindOf('spear')).toBe('additive');
    expect(cfg.kindOf('halberd'), 'не переопределён — остаётся override').toBe('override');
  });

  it('рука задаётся явно', () => {
    expect(cfg.handOf('torch')).toBe('off');
    expect(cfg.handOf('shield')).toBeUndefined();
  });
});

describe('битые данные не роняют анимацию', () => {
  it('мусор вместо конфига читается как пустой', () => {
    for (const raw of [null, undefined, 42, 'нет', [], { warrior: 7 }]) {
      const c = readAnimCfg(raw, 'warrior');
      expect(c.clipName('idle', 'sword')).toBe('idle_sword_relax');
      expect(c.weightOf('sword')).toBe(1);
    }
  });

  it('фолбэк на другого персонажа (монстры → воин)', () => {
    const c = readAnimCfg({ warrior: { items: { sword: { weight: 0.25 } } } } as AnimStore, 'zombie', 'warrior');
    expect(c.weightOf('sword')).toBe(0.25);
  });
});

describe('конфиг реально доезжает до стойки', () => {
  const BASE: Pose = { RightUpperArm: [-0.2, 0, 0.3], LeftUpperArm: [-0.2, 0, -0.3], Chest: [0, 0, 0] };
  const SWORD: Pose = { ...BASE, RightUpperArm: [-0.9, 0.2, 0.5] };
  const SHIELD: Pose = { ...BASE, LeftUpperArm: [-1.1, -0.1, -0.6] };
  const find = (k: 'idle' | 'combat_idle', i: string): Pose | null =>
    ({ 'idle|none': BASE, 'idle|sword': SWORD, 'idle|shield': SHIELD } as Record<string, Pose>)[k + '|' + i] ?? null;
  const dist = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

  it('сила щита 0 — левая рука остаётся базовой, меч не тронут', () => {
    const cfg = readAnimCfg({ warrior: { items: { shield: { weight: 0 } } } } as AnimStore, 'warrior');
    const got = resolveStancePose(find, 'sword+shield', 0, { weight: (i) => cfg.weightOf(i), kind: (i) => cfg.kindOf(i), hand: (i) => cfg.handOf(i) })!;
    expect(dist(got['LeftUpperArm']!, BASE['LeftUpperArm']!)).toBeLessThan(1e-6);
    expect(dist(got['RightUpperArm']!, SWORD['RightUpperArm']!)).toBeLessThan(1e-6);
  });

  it('сила щита 0.5 — левая рука на полпути', () => {
    const cfg = readAnimCfg({ warrior: { items: { shield: { weight: 0.5 } } } } as AnimStore, 'warrior');
    const got = resolveStancePose(find, 'sword+shield', 0, { weight: (i) => cfg.weightOf(i), kind: (i) => cfg.kindOf(i) })!;
    const half = dist(got['LeftUpperArm']!, BASE['LeftUpperArm']!), full = dist(SHIELD['LeftUpperArm']!, BASE['LeftUpperArm']!);
    expect(half).toBeGreaterThan(full * 0.3);
    expect(half).toBeLessThan(full * 0.7);
  });

  it('одноручный меч, объявленный `override`, забирает верх целиком', () => {
    const cfg = readAnimCfg({ warrior: { items: { sword: { kind: 'override' } } } } as AnimStore, 'warrior');
    const got = resolveStancePose(find, 'sword+shield', 0, { weight: (i) => cfg.weightOf(i), kind: (i) => cfg.kindOf(i) })!;
    // Щит теперь не участвует — рука занята мечом (так же, как у двуручного).
    expect(dist(got['LeftUpperArm']!, BASE['LeftUpperArm']!)).toBeLessThan(1e-6);
  });
});

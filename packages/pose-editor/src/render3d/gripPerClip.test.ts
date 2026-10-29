import { describe, it, expect } from 'vitest';
import { effectiveWeaponGrip, resolveGripPose, EMPTY_GRIP_CONFIG } from './gripPoses.js';
import type { GripConfig } from './gripPoses.js';

/**
 * ⭐ ХВАТ ОТДЕЛЬНО НА КЛИП.
 *
 * Жалоба: «настроил для релакс-idle хват, потом для incombat — а он применяется ко всему, надо
 * чтобы отдельно было». Так и было: хват ключевался ТОЛЬКО персонажем и оружием.
 *
 * Теперь цепочка КЛИП → ОРУЖИЕ → АВТО, и ⚠ ПО ПОЛЯМ, а не целиком записью: клип, у которого снята
 * только правая кисть, не должен терять настройку левой, сделанную на уровне оружия.
 */
describe('хват на клип', () => {
  const cfg = (): GripConfig => {
    const c = EMPTY_GRIP_CONFIG();
    // ⚠ id хватов должны быть НАСТОЯЩИМИ (их знает `findGrip`), иначе обе ветки дадут прямую кисть
    // и тест станет зелёным впустую — на этом он уже один раз и провалился.
    c.byWeapon['warrior'] = { sword: { L: 'sword', R: 'sword', closeL: 0.4, closeR: 0.2 } };
    c.byClip = { warrior: { idle_sword_incombat: { R: 'axe', closeR: 1 } } };
    return c;
  };

  it('⭐ у клипа свой хват — он и действует', () => {
    const e = effectiveWeaponGrip(cfg(), 'warrior', 'sword', 'idle_sword_incombat');
    // ⚠ Мутация «игнорировать byClip» валит именно это.
    expect(e.R, '⚠ хват клипа не применился — снова «одно на всё оружие»').toBe('axe');
    expect(e.closeR).toBe(1);
  });

  it('⚠ ПО ПОЛЯМ: не тронутое клипом берётся с уровня оружия', () => {
    const e = effectiveWeaponGrip(cfg(), 'warrior', 'sword', 'idle_sword_incombat');
    expect(e.L, '⚠ клип затёр левую кисть целиком — настройка оружия потеряна').toBe('sword');
    expect(e.closeL).toBe(0.4);
  });

  it('у клипа записи нет — действует уровень оружия (прежнее поведение)', () => {
    const e = effectiveWeaponGrip(cfg(), 'warrior', 'sword', 'idle_sword_relax');
    expect(e.R).toBe('sword');
    expect(e.closeR).toBe(0.2);
  });

  it('имя клипа не передали (старый вызов) — тоже уровень оружия, бит в бит', () => {
    const a = effectiveWeaponGrip(cfg(), 'warrior', 'sword');
    const b = effectiveWeaponGrip(cfg(), 'warrior', 'sword', 'idle_sword_relax');
    expect(a).toEqual(b);
  });

  it('⭐ поза пальцев тоже расходится по клипам (резолвер пробрасывает имя)', () => {
    const c = cfg();
    const relax = resolveGripPose(c, 'warrior', 'sword', null, 'idle_sword_relax');
    const combat = resolveGripPose(c, 'warrior', 'sword', null, 'idle_sword_incombat');
    const keys = Object.keys(relax).filter((k) => k.startsWith('Right'));
    expect(keys.length, 'подстраховка: поза правой кисти вообще собралась').toBeGreaterThan(0);
    const diff = keys.some((k) => (relax[k]?.[0] ?? 0) !== (combat[k]?.[0] ?? 0));
    expect(diff, '⚠ обе стойки дали ОДИН хват — имя клипа до резолвера не доехало').toBe(true);
  });
});

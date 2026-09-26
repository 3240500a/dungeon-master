import { describe, it, expect } from 'vitest';
import { ConfigRegistry, defaultParts, emptyJournal, enchantAction, createRng, newBotSave, type Item, type SaveState } from '@dm/shared';
import type { CraftSandbox } from './craft.js';
import { sandboxHost } from './craftSandboxHost.js';

/**
 * ⭐ ПЕСОЧНИЦА КОВКИ ≡ ИГРА (R1-26): окно ковки одно (`craftWindow`), и гаснут его кнопки по тому, что хозяин
 * говорит о скованной вещи — в сумке она или надета (`CraftHost.find`). У песочницы этого метода не было, окно
 * считало вещь «в сумке» всегда: надетую можно было зачаровать (сервер откажет — `enchantAction` берёт только из
 * сумки), и зачаровывалась КОПИЯ, а в руках оставалась прежняя — сравнение и бой «в руках» проверяли не то оружие.
 *
 * `craft.ts` в node не грузится (тянет `@dm/client` и DOM), поэтому состояние песочницы — здесь, как в `sandbox`.
 */

const reg = new ConfigRegistry();
reg.loadAll();
const PARTS = defaultParts(reg, 'sword', 1, 2)!;

function fresh(): { sb: CraftSandbox; save: SaveState } {
  const sb: CraftSandbox = {
    tab: 'forge', heroClass: reg.get('classes')[0]!.id, level: 40, preset: 'hybrid', bonusDmg: 0, bonusSpd: 0,
    infinite: true, wallet: {}, gold: 5000, fullJournal: true, journal: emptyJournal(), showDisabled: true,
    blockLadder: false, rangedEdge: false, monsterId: '', pack: 3,
    win: { weaponClass: 'sword', hands: 1, parts: structuredClone(PARTS), crafted: null, message: '' },
    fight: null, drop: null, drops: [], log: [], seed: 1,
  };
  return { sb, save: newBotSave(reg, sb.heroClass) };
}
/** Сковать меч хозяином песочницы и положить в окно — как это делает `craftWindow`. */
function craft(sb: CraftSandbox, save: SaveState): Item {
  const r = sandboxHost(reg, sb, save).craft({ weaponClass: 'sword', hands: 1, parts: structuredClone(PARTS) });
  if ('then' in r) throw new Error('песочница отвечает сразу');
  expect(r.ok, r.reason).toBe(true);
  sb.win!.crafted = r.item!;
  return r.item!;
}

describe('R1-26: песочница говорит окну, где скованная вещь — как игра', () => {
  it('⭐ скованная — в сумке; надели — «надета»: окно гасит зачарование той же причиной, что игра', () => {
    const { sb, save } = fresh();
    const item = craft(sb, save);
    const host = sandboxHost(reg, sb, save);
    expect(host.find, 'окно спрашивает хозяина, где вещь').toBeTypeOf('function');
    expect(host.find!(item.uid)).toEqual({ item, inBag: true });

    host.equip!(item);
    expect(save.equipment.weapon).toBe(item);
    // Перерисовка создаёт хозяина заново — ответ тот же.
    expect(sandboxHost(reg, sb, save).find!(item.uid), 'надетую не зачаровать — как в игре').toEqual({ item, inBag: false });
    // Сервер по тем же правилам: надетое `enchantAction` не находит.
    expect(enchantAction(reg, save, item.uid, 'rare', createRng(1)).ok).toBe(false);
  });

  it('новая ковка после «надеть» — снова в сумке; вещи нет ни в окне, ни в руках — её нет', () => {
    const { sb, save } = fresh();
    const a = craft(sb, save);
    sandboxHost(reg, sb, save).equip!(a);
    const b = craft(sb, save);
    expect(b.uid).not.toBe(a.uid);
    const host = sandboxHost(reg, sb, save);
    expect(host.find!(b.uid)).toEqual({ item: b, inBag: true });
    expect(host.find!(a.uid), 'надетая прежняя').toEqual({ item: a, inBag: false });
    expect(host.find!('нет-такой')).toBeNull();
  });
});

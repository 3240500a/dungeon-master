import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../../config/registry.js';
import { generateRunPlan, defaultRunConfig } from './generateRunPlan.js';
import { RUN_MOD_LIVE_STATS, altarModifiers, pickRunModifiers, runModifierLive } from './runModifiers.js';

const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const mods = reg.get('run-modifiers');
/** Все статы эффектов данных — «как если бы игра применяла каждый»: правила выбора проверяются без подключённых эффектов. */
const allLive: ReadonlySet<string> = new Set(mods.flatMap((m) => m.effects.map((e) => e.stat)));

/**
 * ⚠ R8-12: МОДИФИКАТОРЫ АЛТАРЯ НЕ ДЕЙСТВОВАЛИ. Алтарь обещал «+10% здоровья», «золото +25%», «пачки +30%», а `effects` не
 * читал никто: id ехали только подписью этажа. И выбор не проверялся на дубли и цену: 32 копии «Реликвии алчности» доезжали
 * до каждого этажа, благо без опасности проходило всегда — подключи эффект умножением, и это ×1.15^32 к находкам.
 */
describe('⚠ R8-12: модификаторы забега — только действующие, каждый один раз, благо — не даром', () => {
  it('⭐ сторож: алтарь предлагает только модификаторы, чей КАЖДЫЙ эффект игра применяет; сейчас не применяет ни один', () => {
    // Подключил стат — внеси его в `RUN_MOD_LIVE_STATS` и сюда, вместе с тестом, что эффект действует.
    expect([...RUN_MOD_LIVE_STATS], 'подключённые статы эффектов').toEqual([]);
    for (const tpl of reg.get('run-templates')) {
      const offered = altarModifiers(mods, tpl.allowedModifiers);
      for (const m of offered) expect(m.effects.every((e) => RUN_MOD_LIVE_STATS.has(e.stat)), m.id).toBe(true);
      expect(offered.map((m) => m.id), `алтарь «${tpl.id}» — секция скрыта`).toEqual([]);
    }
  });

  it('⭐ 32 копии «Реликвии алчности» — ни в конфиг забега, ни в план, ни в этажи (эффект не подключён)', () => {
    const picked = Array(32).fill('relic-greed');
    expect(pickRunModifiers(mods, [], picked)).toEqual([]);
    const plan = generateRunPlan(reg, { ...defaultRunConfig(reg, 'crypt-short', 7), modifiers: picked });
    expect(plan.runModifiers).toEqual([]);
    for (const n of plan.nodes) expect(n.floorSpec.modifiers.filter((id) => id === 'relic-greed'), n.id).toEqual([]);
  });

  it('действующие: каждый — один раз, в порядке выбора', () => {
    const picked = ['pack-swarm', 'hardened-foes', 'pack-swarm', ...Array(30).fill('hardened-foes')];
    expect(pickRunModifiers(mods, [], picked, allLive)).toEqual(['pack-swarm', 'hardened-foes']);
  });

  it('благо — только в паре с опасностью: одни блага — ничего; лишние сверх опасностей — по порядку выбора', () => {
    expect(pickRunModifiers(mods, [], ['relic-greed', 'relic-vitality', 'greedy-vault'], allLive), 'одни блага').toEqual([]);
    expect(pickRunModifiers(mods, [], ['relic-greed', ...Array(32).fill('relic-greed'), 'pack-swarm'], allLive)).toEqual(['relic-greed', 'pack-swarm']);
    expect(pickRunModifiers(mods, [], ['relic-greed', 'gilded-fortune', 'savage-blows', 'relic-vitality'], allLive), 'два блага на одну опасность')
      .toEqual(['relic-greed', 'savage-blows']);
    expect(pickRunModifiers(mods, [], ['relic-greed', 'gilded-fortune', 'savage-blows', 'pack-swarm'], allLive))
      .toEqual(['relic-greed', 'gilded-fortune', 'savage-blows', 'pack-swarm']);
  });

  it('мусор выбора — мимо: не строки, чужие, выключенные, узловые, запрещённые шаблоном', () => {
    expect(pickRunModifiers(mods, [], 'relic-greed', allLive), 'не массив').toEqual([]);
    expect(pickRunModifiers(mods, [], [1, null, {}, 'no-such', 'affliction-frenzy', 'pack-swarm'], allLive)).toEqual(['pack-swarm']);
    const off = mods.map((m) => (m.id === 'pack-swarm' ? { ...m, enabled: false } : m));
    expect(pickRunModifiers(off, [], ['pack-swarm', 'hardened-foes'], allLive)).toEqual(['hardened-foes']);
    expect(pickRunModifiers(mods, ['hardened-foes'], ['pack-swarm', 'hardened-foes'], allLive)).toEqual(['hardened-foes']);
    expect(runModifierLive({ ...mods[0]!, effects: [] }, allLive), 'без эффектов — не действует').toBe(false);
  });
});

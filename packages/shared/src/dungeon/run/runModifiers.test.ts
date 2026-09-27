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

/**
 * ⚠ R10-15: УЗЛОВЫЕ МОДИФИКАТОРЫ — ТЕМ ЖЕ ПРАВИЛОМ R8-12. Алтарь с R8-12 предлагает только действующие, а план по-прежнему
 * вешал узловые («Лихорадка» +20 % к скорости атаки, «Закалка» +25 % здоровья, «Тайник» ×1.5 к находкам) на ~29 % узлов, и
 * карта забега рисовала им ★ — хотя эффект не применяет никто. Игрок выбирал ветку за обещанный тайник и получал обычную
 * комнату. ⚠ Бросок узла и выбор модификатора остались на месте: план забега из сейва регенерится от сида, и сдвиг потока
 * случайности перестроил бы граф каждого запаркованного забега (`currentNodeId`, `run_ledger`). Отбрасывается только результат.
 */
describe('⚠ R10-15: узловые модификаторы — только действующие', () => {
  /** Каждый включённый шаблон × включённый биом × `seeds` сидов. */
  const configs = (seeds: number) => reg.get('run-templates').filter((t) => t.enabled !== false).flatMap((t) =>
    reg.get('biomes').filter((b) => b.enabled !== false).flatMap((b) =>
      Array.from({ length: seeds }, (_, i) => ({ ...defaultRunConfig(reg, t.id, i * 7919 + 13), biomeId: b.id }))));
  const shape = (p: ReturnType<typeof generateRunPlan>) =>
    p.nodes.map((n) => [n.id, n.type, n.depth, n.lane, n.edges.map((e) => e.to), n.floorSpec.floorId, n.floorSpec.seed]);

  it('⭐ пока ни один узловой эффект не подключён — ни у одного узла нет модификатора и ★', () => {
    let nodes = 0;
    for (const c of configs(20)) {
      for (const n of generateRunPlan(reg, c).nodes) {
        expect(n.modifiers, `${c.templateId}/${c.biomeId}/${c.seed} ${n.id}`).toEqual([]);
        expect(n.floorSpec.modifiers).toEqual([]);
        nodes++;
      }
    }
    expect(nodes).toBeGreaterThan(500);
  });

  it('⭐ граф забега — тот же, что до правки: со всеми статами «действующими» те же узлы получают модификаторы', () => {
    let modded = 0;
    for (const c of configs(20)) {
      const now = generateRunPlan(reg, c);
      const all = generateRunPlan(reg, c, allLive);   // = план до правки: тогда годился любой узловой модификатор
      expect(shape(now), `${c.templateId}/${c.biomeId}/${c.seed}`).toEqual(shape(all));
      modded += all.nodes.filter((n) => n.modifiers.length > 0).length;
    }
    expect(modded, 'сторож сравнения: модификаторы у узлов были').toBeGreaterThan(100);
  });

  it('подключили стат — его узлы возвращаются сами: `dropBias` → «Тайник», а «Лихорадки» и «Закалки» по-прежнему нет', () => {
    const live: ReadonlySet<string> = new Set(['dropBias']);
    const seen = new Set<string>();
    for (const c of configs(20)) for (const n of generateRunPlan(reg, c, live).nodes) for (const id of n.modifiers) seen.add(id);
    expect([...seen]).toEqual(['boon-cache']);
  });
});

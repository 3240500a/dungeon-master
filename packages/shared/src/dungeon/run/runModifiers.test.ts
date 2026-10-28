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
  /**
   * ⭐⭐ Ф5-0 (16.10): ТЕПЕРЬ ПРИМЕНЯЕТ. Раньше `RUN_MOD_LIVE_STATS` было пустым и сторож требовал пустой секции —
   * это было честно: эффекты не читал никто. С Ф5-0 живы десять статов, у которых есть шов, и правило осталось тем
   * же: алтарь предлагает РОВНО те модификаторы, у которых КАЖДЫЙ эффект применяется. Проверяем обе стороны —
   * предложенное действует, непредложенное отброшено за мёртвый стат.
   */
  it('⭐⭐ Ф5-0: алтарь предлагает только модификаторы, чей КАЖДЫЙ эффект игра применяет — и их уже не ноль', () => {
    expect([...RUN_MOD_LIVE_STATS].sort(), 'подключённые статы эффектов').toEqual(
      // ⭐⭐ Ф5-6″ (23.10): + два СЧЁТНЫХ шва-события (`elitePacks`, `miniBosses`) под печати «Логово» и
      // «Сторожевой». Список здесь — ПЕРЕПИСЬ, а не фильтр: новый стат обязан приехать сюда вместе со своим
      // замером исхода (`runModLive.test.ts`), иначе алтарь снова начнёт обещать несделанное.
      ['dropBias', 'elitePacks', 'gold', 'itemRolls', 'miniBosses', 'monsterAttackSpeed', 'monsterDamage',
        'monsterHp', 'monsterMoveSpeed', 'monsterRarity', 'packSize', 'xp']);
    const allowed = reg.get('balance').dungeonAccess.allowedModifiers;
    const offered = altarModifiers(mods, allowed);
    for (const m of offered) expect(m.effects.every((e) => RUN_MOD_LIVE_STATS.has(e.stat)), m.id).toBe(true);
    expect(offered.length, 'секция алтаря больше не пуста (до Ф5-0 была)').toBeGreaterThan(0);
    const runMods = mods.filter((m) => m.scope === 'run' && m.enabled !== false && (!allowed.length || allowed.includes(m.id)));
    const dead = runMods.filter((m) => !m.effects.length || m.effects.some((e) => !RUN_MOD_LIVE_STATS.has(e.stat)));
    for (const m of dead) expect(offered.some((o) => o.id === m.id), `${m.id}: мёртвый стат — не предлагаем`).toBe(false);
    console.log(`Ф5-0 АЛТАРЬ: предложено ${offered.length} из ${runMods.length} забеговых (${offered.map((m) => m.id).join(', ')})`);
  });

  it('⭐ 32 копии «Реликвии алчности» — в забег попадает НЕ БОЛЬШЕ ОДНОЙ, и только в паре с опасностью', () => {
    const picked = Array(32).fill('relic-greed');
    // ⚠ Ф5-0: эффект подключён, поэтому модификатор больше не отбрасывается «за мёртвый стат». Правило
    // осталось другим и более сильным: дублей нет, а благо без опасности не проходит (`pickRunModifiers`).
    expect(pickRunModifiers(mods, [], picked), 'благо в одиночку — не проходит').toEqual([]);
    const plan = generateRunPlan(reg, { ...defaultRunConfig(reg, 7), modifiers: picked });
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
  /**
   * Каждый включённый шаблон × включённый биом × `seeds` сидов.
   *
   * ⚠ Г8-4 (15.10): ШАБЛОН ТЕПЕРЬ ОДИН (выбор с алтаря снят), и выборка сторожей просела втрое — 375 узлов против
   * прежних 500+. Это не «модификаторов стало меньше», а «конфигов стало втрое меньше». Пороги НЕ снижаем (это
   * спрятало бы потерю покрытия) — возвращаем размер ВЫБОРКИ сидами.
   */
  const configs = (seeds: number) => [{ id: 'спуск' }].flatMap((t) =>
    reg.get('biomes').filter((b) => b.enabled !== false).flatMap((b) =>
      Array.from({ length: seeds }, (_, i) => ({ ...defaultRunConfig(reg, i * 7919 + 13), biomeId: b.id }))));
  const shape = (p: ReturnType<typeof generateRunPlan>) =>
    p.nodes.map((n) => [n.id, n.type, n.depth, n.lane, n.edges.map((e) => e.to), n.floorSpec.floorId, n.floorSpec.seed]);
  /**
   * ⭐⭐ 13.10 (Г2): окно слоёв ЯВНОЕ. Умолчание генератора — 3 слоя (`balance.dungeonAccess.lookahead`), и выборка
   * сторожей просела бы втрое (280 узлов против прежних 500+) — не потому, что модификаторов стало меньше, а потому,
   * что забег больше не строится целиком. Берём 12 слоёв: примерно столько и давал прежний «длинный» шаблон.
   */
  const WIN = { from: 1, to: 12 };

  /**
   * ⭐⭐ Ф5-0 (16.10): УЗЛОВЫЕ ОСТАЛИСЬ ВЫКЛЮЧЕННЫМИ, и это решение, а не недосмотр. Забеговые статы ожили
   * (их выбирает игрок и платит опасностью), а узловые вешает генератор сам — среди них есть чистое благо
   * `boon-cache` (`dropBias ×1.5`), которое дало бы бесплатную награду и обошло правило владельца.
   */
  it('⭐⭐ Ф5-0: узловые эффекты по-прежнему не подключены — ни у одного узла нет модификатора и ★', () => {
    let nodes = 0;
    for (const c of configs(60)) {
      for (const n of generateRunPlan(reg, c, undefined, WIN).nodes) {
        expect(n.modifiers, `${c.biomeId}/${c.seed} ${n.id}`).toEqual([]);
        expect(n.floorSpec.modifiers).toEqual([]);
        nodes++;
      }
    }
    expect(nodes).toBeGreaterThan(500);
  });

  it('⭐ граф забега — тот же, что до правки: со всеми статами «действующими» те же узлы получают модификаторы', () => {
    let modded = 0;
    for (const c of configs(60)) {
      const now = generateRunPlan(reg, c, undefined, WIN);
      const all = generateRunPlan(reg, c, allLive, WIN, allLive);   // = план до правки: годился любой узловой модификатор
      expect(shape(now), `${c.biomeId}/${c.seed}`).toEqual(shape(all));
      modded += all.nodes.filter((n) => n.modifiers.length > 0).length;
    }
    expect(modded, 'сторож сравнения: модификаторы у узлов были').toBeGreaterThan(100);
  });

  it('подключили стат — его узлы возвращаются сами: `dropBias` → «Тайник», а «Лихорадки» и «Закалки» по-прежнему нет', () => {
    const live: ReadonlySet<string> = new Set(['dropBias']);
    const seen = new Set<string>();
    // ⚠ Ф5-0: узловым нужен ИХ набор — забеговый (`live`) их больше не открывает.
    for (const c of configs(60)) for (const n of generateRunPlan(reg, c, live, WIN, live).nodes) for (const id of n.modifiers) seen.add(id);
    expect([...seen]).toEqual(['boon-cache']);
  });
});

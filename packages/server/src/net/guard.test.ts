import { describe, it, expect, beforeAll } from 'vitest';
import {
  ConfigRegistry, generateRunPlan, defaultRunConfig, generateFloor, resolveFloorSpec,
  type DungeonLayout, type TownCommand,
} from '@dm/shared';
import { cmdAllowedIn, CommandDedup } from './guard.js';

/**
 * Санитарные проверки команд (Ф3.1) и дедупликация (Ф2.5).
 *
 * Смысл этих тестов — зафиксировать ГРАНИЦУ. Слишком строгая карта мест ломает честного
 * игрока (поднял уровень на этаже — не может потратить очко), слишком свободная возвращает
 * дыру, ради которой всё и делалось: сундук посреди подземелья.
 */
describe('место команды', () => {
  it('лавка, кузница и сундук — только из города', () => {
    for (const cmd of ['buy', 'sell', 'forgeUpgrade', 'forgeReroll', 'forgeRepair', 'forgeSalvage', 'depositMaterials',
      'craft', 'forgeEnchant', 'stashOpen', 'stashMove'] as const) {
      expect(cmdAllowedIn(cmd, 'town'), `${cmd} в городе`).toBe(true);
      expect(cmdAllowedIn(cmd, 'dungeon'), `${cmd} в подземелье`).toBe(false);
      expect(cmdAllowedIn(cmd, 'arena'), `${cmd} на арене`).toBe(false);
    }
  });

  it('⭐ ковка — только у кузнеца: сковать или зачаровать из подземелья нельзя, а разобрать на месте можно', () => {
    // Ковка тратит сырьё сундука аккаунта и кладёт вещь в сумку: из подземелья это был бы тот же
    // сундук посреди этажа. Полевой разбор — наоборот, смысл его ровно в том, чтобы не возвращаться.
    for (const area of ['dungeon', 'arena'] as const) {
      expect(cmdAllowedIn('craft', area), `craft: ${area}`).toBe(false);
      expect(cmdAllowedIn('forgeEnchant', area), `forgeEnchant: ${area}`).toBe(false);
      expect(cmdAllowedIn('forgeSalvage', area), `forgeSalvage: ${area}`).toBe(false);
      expect(cmdAllowedIn('salvage', area), `salvage: ${area}`).toBe(true);
    }
  });

  it('сундук из подземелья закрыт — это обнуляло бы риск забега', () => {
    // Отдельным тестом, потому что это и есть главная причина задачи: донести добычу
    // до города — часть игры, а сундук на этаже делает смерть бесплатной.
    expect(cmdAllowedIn('stashMove', 'dungeon')).toBe(false);
  });

  it('панели, открытые горячей клавишей, работают везде', () => {
    // Эти команды шлёт обычный клиент прямо из подземелья: дерево скилов, пояс, экипировка,
    // подбор и питьё зелья. Запрет здесь сломал бы игру, а не читера.
    for (const cmd of ['equip', 'unequip', 'allocAttr', 'allocSkill', 'allocPassive', 'respec',
      'moveBelt', 'moveItem', 'bind', 'drop', 'pickup', 'useConsumable',
      'acceptQuest', 'turnInQuest'] as const) {
      expect(cmdAllowedIn(cmd, 'dungeon'), `${cmd} в подземелье`).toBe(true);
    }
  });

  it('неизвестная команда считается городской — строгая сторона по умолчанию', () => {
    expect(cmdAllowedIn('чего-то новое' as never, 'dungeon')).toBe(false);
    expect(cmdAllowedIn('чего-то новое' as never, 'town')).toBe(true);
  });
});

/**
 * ⭐ R7-11: ОБЪЕКТ ГОРОДА В ПОДЗЕМЕЛЬЕ — ЛОЖНАЯ КНОПКА И ЛОЖНЫЙ СИГНАЛ ЧИТА. Карта мест выше закрывает сундук вне города, а
 * генератор ставил его на каждый rest-узел забега (`townFloor` — всегда, `features.stash` четырёх этажей-привалов — ещё
 * и в данных): оба клиента рисовали «[E] Общий сундук», окно слало `stashOpen`, сервер отвечал «только в городе» и
 * считал каждый честный клик в `dm_cmd_out_of_place_total` — сигнал, который по замыслу честный клиент не зажигает.
 * Правило одно: объект, чьи команды в подземелье закрыты, в подземелье не рождается. Сверка — по живому конфигу: каждый
 * узел каждого включённого шаблона в каждом включённом биоме и каждый включённый этаж.
 */
describe('⭐ R7-11: объекты города не рождаются там, где их команды закрыты', () => {
  /** Декор-объект → команды его окна (сундук — открыть, переложить, сдать сырьё; лавка — прилавок). */
  const OBJECT_CMDS: Record<string, readonly TownCommand['cmd'][]> = {
    stash: ['stashOpen', 'stashMove', 'depositMaterials'],
    shop: ['buy', 'sell'],
  };
  let reg: ConfigRegistry;
  beforeAll(() => { reg = new ConfigRegistry(); reg.loadAll(); });
  /** Объекты этажа, у которых хоть одна команда в подземелье закрыта. */
  const closed = (L: DungeonLayout): string[] =>
    L.decor.filter((d) => (OBJECT_CMDS[d.kind] ?? []).some((c) => !cmdAllowedIn(c, 'dungeon'))).map((d) => d.kind);

  it('ни на одном узле забега; rest-узел — портал в город, а сундук — в городе', () => {
    let rests = 0;
    for (const tpl of reg.get('run-templates').filter((t) => t.enabled !== false)) {
      for (const biome of reg.get('biomes').filter((b) => b.enabled !== false)) {
        for (const seed of [1, 2]) {
          const plan = generateRunPlan(reg, { ...defaultRunConfig(reg, tpl.id, seed), biomeId: biome.id });
          for (const n of plan.nodes) {
            const L = generateFloor(n.floorSpec);
            const at = `${tpl.id}/${biome.id}/${seed}/${n.id} (${n.type}, ${n.floorSpec.floorId})`;
            expect(closed(L), at).toEqual([]);
            if (n.type === 'rest') {
              rests++;
              expect(L.decor.some((d) => d.kind === 'portal'), `${at}: дорога к сундуку — портал в город`).toBe(true);
            }
          }
        }
      }
    }
    expect(rests, 'тест имеет смысл, только пока привалы в забегах есть').toBeGreaterThan(0);
  });

  it('ни на одном включённом этаже, какой бы роли он ни был', () => {
    for (const f of reg.get('floors').filter((x) => x.enabled !== false)) {
      const biome = reg.get('biomes').find((b) => b.id === f.biomeId);
      if (!biome) continue;
      for (const exitCount of [0, 1, 2]) {
        const L = generateFloor(resolveFloorSpec(biome, f, f.minDepth, 7, [], { exitCount }));
        expect(closed(L), `${f.id} (${f.role}), выходов ${exitCount}`).toEqual([]);
      }
    }
  });
});

describe('повтор команды', () => {
  it('одна команда, отправленная трижды, выполняется один раз', () => {
    const d = new CommandDedup();
    expect(d.accept(7)).toBe(true);
    expect(d.accept(7)).toBe(false);
    expect(d.accept(7)).toBe(false);
  });

  it('разные номера выполняются все', () => {
    const d = new CommandDedup();
    for (let i = 1; i <= 10; i++) expect(d.accept(i)).toBe(true);
  });

  it('клиент без нумерации обслуживается как раньше', () => {
    // Старая вкладка не знает про номера. Отказывать живому игроку из-за отсутствия поля
    // хуже, чем изредка выполнить его повтор — на такой случай есть версия сейва (Ф0.3).
    const d = new CommandDedup();
    expect(d.accept(undefined)).toBe(true);
    expect(d.accept(undefined)).toBe(true);
  });

  it('⭐ повтор получает ТОТ ЖЕ итог, что оригинал — в том числе отказ', () => {
    const d = new CommandDedup<{ ok: boolean; reason?: string }>();
    expect(d.accept(3)).toBe(true);
    expect(d.outcome(3), 'пока итог не записан — его нет').toBeUndefined();
    d.settle(3, { ok: false, reason: 'Недостаточно золота' });
    expect(d.accept(3)).toBe(false);
    expect(d.outcome(3)).toEqual({ ok: false, reason: 'Недостаточно золота' });
    d.settle(99, { ok: true });                       // номер, которого не было, — не заводится
    expect(d.outcome(99)).toBeUndefined();
    expect(d.accept(99), 'и не мешает выполнить его потом').toBe(true);
  });

  it('окно памяти ограничено: очень старый номер забывается', () => {
    const d = new CommandDedup(4);
    d.accept(1);
    for (const n of [2, 3, 4, 5]) d.accept(n);
    expect(d.accept(1), 'номер 1 вытеснен из окна').toBe(true);
    expect(d.accept(5), 'свежий номер помнится').toBe(false);
  });

  /**
   * ⭐ R6-24: ОКНО НОМЕРОВ — ШИРЕ ВСПЛЕСКА КОМАНД. Окно было 64 номера, а потолок команд города — всплеск 120: перекатка
   * встала за медленной записью, за ней в очереди соединения — 64 перекладывания вещей, и повтор перекатки ТЕМ ЖЕ номером
   * (верстак после «нет ответа») находил номер уже вытесненным — вторая перекатка за вторую цену.
   */
  it('⭐ R6-24: номер, за которым приняты сотни других, всё ещё помнится — повтор не исполняется', () => {
    const d = new CommandDedup<{ ok: boolean }>();
    expect(d.accept(17)).toBe(true);
    d.settle(17, { ok: true });
    for (let i = 1000; i < 1300; i++) expect(d.accept(i)).toBe(true);
    expect(d.accept(17), 'повтор после 300 других — всё ещё повтор').toBe(false);
    expect(d.outcome(17)).toEqual({ ok: true });
  });

  it('⭐ R6-24: окно — по времени: номер старше срока забывается, моложе — нет', () => {
    let t = 0;
    const d = new CommandDedup(undefined, 120_000, () => t);
    d.accept(1);
    t = 119_000;
    d.accept(2);
    expect(d.accept(1), 'в пределах срока — повтор').toBe(false);
    t = 121_000;
    d.accept(3);
    expect(d.accept(1), 'срок вышел — номер забыт').toBe(true);
    expect(d.accept(2), 'младший — ещё в окне').toBe(false);
  });
});

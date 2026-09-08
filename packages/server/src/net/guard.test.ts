import { describe, it, expect } from 'vitest';
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
    for (const cmd of ['buy', 'sell', 'forgeUpgrade', 'forgeReroll', 'stashOpen', 'stashMove'] as const) {
      expect(cmdAllowedIn(cmd, 'town'), `${cmd} в городе`).toBe(true);
      expect(cmdAllowedIn(cmd, 'dungeon'), `${cmd} в подземелье`).toBe(false);
      expect(cmdAllowedIn(cmd, 'arena'), `${cmd} на арене`).toBe(false);
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

  it('окно памяти ограничено: очень старый номер забывается', () => {
    const d = new CommandDedup(4);
    d.accept(1);
    for (const n of [2, 3, 4, 5]) d.accept(n);
    expect(d.accept(1), 'номер 1 вытеснен из окна').toBe(true);
    expect(d.accept(5), 'свежий номер помнится').toBe(false);
  });
});

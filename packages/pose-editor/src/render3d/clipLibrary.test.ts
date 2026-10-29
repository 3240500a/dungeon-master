import { describe, it, expect } from 'vitest';
import { clipKey, duplicateClipKeys, freeClipNameIn, type Clip } from './clipModel.js';

/**
 * БИБЛИОТЕКА КЛИПОВ НЕ ДОЛЖНА ПЛОДИТЬ ДУБЛИ.
 *
 * Игра ищет стойку и удар РОВНО по тройке `имя + персонаж + оружие` и берёт ПЕРВОЕ совпадение
 * (`localStorageContent.find`). Значит вторая запись с той же тройкой недостижима навсегда — а
 * редактор при этом может править как раз её, и выглядит это как «я поправил, а в игре не изменилось».
 *
 * Замер на опубликованных данных перед правкой: `idle_dual` — ВОСЕМЬ копий, `hit_dual` — восемь,
 * `idle_axe+dagger` — две. Натекли они потому, что `library.push` стоял в дюжине мест, и у трёх из
 * них (оба пути ИИ-клипа, импорт JSON, запекание физики) проверки не было вовсе.
 *
 * Здесь проверяется ЧИСТОЕ ЯДРО шва. Сам `putClip` живёт в редакторе и работает с живой библиотекой
 * и `confirm`, но вся его арифметика — эти три функции.
 */
const c = (name: string, character = 'warrior', weapon = 'sword'): Clip =>
  ({ name, character, weapon, loop: false, keys: [] });

describe('ключ клипа', () => {
  it('это тройка имя+персонаж+оружие, а не одно имя', () => {
    expect(clipKey(c('idle_sword'))).toBe('idle_sword|warrior|sword');
    // Одно имя на разном оружии — РАЗНЫЕ клипы, это нормально и дублем не считается.
    expect(clipKey(c('idle_dual', 'warrior', 'sword+dagger'))).not.toBe(clipKey(c('idle_dual', 'warrior', 'axe+dagger')));
    // Одно имя у разных персонажей — тоже разные.
    expect(clipKey(c('idle_sword', 'mage'))).not.toBe(clipKey(c('idle_sword', 'warrior')));
  });
});

describe('поиск дублей', () => {
  it('чистая библиотека — пусто', () => {
    expect(duplicateClipKeys([c('idle_sword'), c('hit_sword'), c('idle_axe', 'warrior', 'axe')])).toEqual([]);
  });

  it('находит повтор тройки и называет его', () => {
    expect(duplicateClipKeys([c('idle_dual'), c('hit_dual'), c('idle_dual')])).toEqual(['idle_dual|warrior|sword']);
  });

  it('восемь копий — это ОДНА жалоба, а не семь', () => {
    const lib = Array.from({ length: 8 }, () => c('idle_dual'));
    expect(duplicateClipKeys(lib)).toEqual(['idle_dual|warrior|sword']);
  });

  it('совпадение имени при разном оружии дублем НЕ считается', () => {
    expect(duplicateClipKeys([c('idle_dual', 'warrior', 'sword+dagger'), c('idle_dual', 'warrior', 'axe+dagger')])).toEqual([]);
  });
});

describe('свободное имя', () => {
  it('пустое место — имя как есть', () => {
    expect(freeClipNameIn([], 'idle_none', 'warrior', 'none')).toBe('idle_none');
  });

  it('занято — следующий номер, и так далее', () => {
    const lib = [c('idle_none', 'warrior', 'none')];
    expect(freeClipNameIn(lib, 'idle_none', 'warrior', 'none')).toBe('idle_none_2');
    lib.push(c('idle_none_2', 'warrior', 'none'));
    expect(freeClipNameIn(lib, 'idle_none', 'warrior', 'none')).toBe('idle_none_3');
  });

  it('занято на ДРУГОМ оружии — имя свободно', () => {
    expect(freeClipNameIn([c('idle_none', 'warrior', 'sword')], 'idle_none', 'warrior', 'none')).toBe('idle_none');
  });

  it('повторный импорт одного файла N раз даёт N клипов и НИ ОДНОГО дубля', () => {
    // Ровно тот путь, которым пользуются: подгрузил FBX, назвал, повторил. Раньше часть путей
    // записи просто пушила — отсюда и восемь копий.
    const lib: Clip[] = [];
    for (let i = 0; i < 8; i++) lib.push(c(freeClipNameIn(lib, 'idle_none', 'warrior', 'none'), 'warrior', 'none'));
    expect(lib.map((x) => x.name)).toEqual(['idle_none', 'idle_none_2', 'idle_none_3', 'idle_none_4', 'idle_none_5', 'idle_none_6', 'idle_none_7', 'idle_none_8']);
    expect(duplicateClipKeys(lib)).toEqual([]);
  });
});

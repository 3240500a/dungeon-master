import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { localStorageContent, weaponChain } from './poseRuntime.js';
import type { Clip } from './clipModel.js';

/**
 * НАСЛЕДОВАНИЕ УДАРОВ ПО КЛЮЧУ ОРУЖИЯ.
 *
 * Жалоба: «сделал стойку и удар мечом, взял щит — удар мечом пропадает». Он не пропадал: игра ищет
 * удары по ЦЕПОЧКЕ `sword+shield → sword` и находит их там же, а щит подмешивается отдельным
 * оверлеем. Пустым был СПИСОК В РЕДАКТОРЕ — он фильтровал строго по точному ключу.
 *
 * Именно это правило делает библиотеку конечной: удары на каждую пару рук авторить не надо.
 */
const clip = (name: string, weapon: string): Clip =>
  ({ name, character: 'warrior', weapon, loop: false, keys: [{ pose: {}, t: 0 }] });

const withClips = (list: Clip[]): void => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => (k === 'pe_clips' ? JSON.stringify(list) : null),
    setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0,
  } as Storage;
};

describe('цепочка ключа оружия', () => {
  it('щит снимается: со щитом играют удары БЕЗ щита', () => {
    expect(weaponChain('sword+shield')).toEqual(['sword+shield', 'sword']);
  });

  it('вторая рука тоже снимается — до главной', () => {
    expect(weaponChain('sword+dagger')).toEqual(['sword+dagger', 'sword']);
  });

  it('одиночное оружие наследовать не от кого', () => {
    expect(weaponChain('sword')).toEqual(['sword']);
    expect(weaponChain('none')).toEqual(['none']);
  });
});

describe('что игра сыграет на ключе со щитом', () => {
  afterEach(() => { delete (globalThis as unknown as { localStorage?: Storage }).localStorage; });

  it('⭐ своих ударов нет → играют удары главной руки', () => {
    withClips([clip('hit_sword_01', 'sword'), clip('hit_sword_02', 'sword')]);
    const got = localStorageContent('warrior').attackClips('sword+shield');
    expect(got.map((c) => c.name)).toEqual(['hit_sword_01', 'hit_sword_02']);
  });

  it('⚠ наследование ВСЁ-ИЛИ-НИЧЕГО: один свой удар отключает унаследованные', () => {
    // Это и есть ловушка, ради которой в панели стоит предупреждение. «Добавлю один удар со щитом»
    // тихо выключает оба меча — автор ждёт три удара, а получает один.
    withClips([clip('hit_sword_01', 'sword'), clip('hit_sword_02', 'sword'), clip('hit_sword+shield_01', 'sword+shield')]);
    const got = localStorageContent('warrior').attackClips('sword+shield');
    expect(got.map((c) => c.name)).toEqual(['hit_sword+shield_01']);
  });

  it('порядок стабилен (по имени) — чередование ударов не скачет от кадра к кадру', () => {
    withClips([clip('hit_sword_02', 'sword'), clip('hit_sword_01', 'sword')]);
    expect(localStorageContent('warrior').attackClips('sword+shield').map((c) => c.name))
      .toEqual(['hit_sword_01', 'hit_sword_02']);
  });

  it('не путает соседние ключи: удары топора не попадают к мечу', () => {
    withClips([clip('hit_axe_01', 'axe')]);
    expect(localStorageContent('warrior').attackClips('sword+shield')).toEqual([]);
  });
});

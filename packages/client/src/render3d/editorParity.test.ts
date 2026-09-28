/**
 * ⭐⭐ РЕДАКТОР ≡ ИГРА: настройки, которые автор крутит в поз-редакторе, обязаны ДОЕЗЖАТЬ до игры.
 *
 * Два ключа читались ТОЛЬКО редактором, и это ловилось глазами как «в редакторе одно, в игре другое»:
 * `pe_morph` (телосложение) и `pe_attacks` (какие клипы удары и в каком порядке).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { loadMorph, localStorageContent } from './poseRuntime.js';
import type { Clip } from './clipModel.js';

const store: Record<string, string> = {};
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => { store[k] = v; },
  removeItem: (k: string) => { delete store[k]; }, clear: () => { for (const k in store) delete store[k]; },
  key: () => null, length: 0,
} as unknown as Storage;
afterEach(() => { for (const k in store) delete store[k]; });

const clip = (name: string, character = 'warrior', weapon = 'sword'): Clip =>
  ({ name, character, weapon, keys: [{ t: 0, pose: {} }] } as unknown as Clip);

describe('телосложение доезжает до игры', () => {
  it('⚠ БЕЗ записи — ничего не навязываем (прежнее поведение бит в бит)', () => {
    expect(loadMorph('warrior')).toEqual({});
    store['pe_morph'] = JSON.stringify({ warrior: {} });
    expect(loadMorph('warrior'), 'пустая запись — тоже «не трогай»').toEqual({});
  });

  it('⭐⭐ ЕСТЬ запись — игра получает профиль, телосложение и пер-костные множители', () => {
    store['pe_morph'] = JSON.stringify({ warrior: { height: 1.1, legs: 1.2, shoulders: 1.15 } });
    const m = loadMorph('warrior');
    expect(m.profile, 'профиль пропорций').toBeTruthy();
    expect(m.build, 'телосложение').toBeTruthy();
    expect(m.boneScale, 'пер-костные множители').toBeTruthy();
  });

  it('донор работает так же, как у остальных ключей', () => {
    store['pe_morph'] = JSON.stringify({ warrior: { height: 1.1 } });
    expect(loadMorph('c_custom', 'warrior').profile, 'фолбэк на донора').toBeTruthy();
    expect(loadMorph('c_custom').profile, 'без донора — пусто').toBeUndefined();
  });

  it('⚠ МУСОР в ключе не роняет игру', () => {
    store['pe_morph'] = '{ не json';
    expect(loadMorph('warrior')).toEqual({});
  });
});

describe('авторский список ударов доезжает до игры', () => {
  // ⚠ Контент — СНИМОК localStorage на момент сборки, поэтому библиотеку кладём В ХРАНИЛИЩЕ, а не аргументом.
  const lib = [clip('hit_sword'), clip('hit_sword_2'), clip('zamah'), clip('tychok')];
  const content = (): ReturnType<typeof localStorageContent> => {
    store['pe_clips'] = JSON.stringify(lib);
    return localStorageContent('warrior');
  };

  it('⚠ БЕЗ списка — конвенция имён, как было: все `hit_*` по алфавиту', () => {
    expect(content().attackClips('sword').map((c) => c.name)).toEqual(['hit_sword', 'hit_sword_2']);
  });

  it('⭐⭐ СО списком — играет ВЫБОР АВТОРА и в ЕГО порядке', () => {
    store['pe_attacks'] = JSON.stringify({ warrior: { sword: ['zamah', 'tychok'] } });
    expect(content().attackClips('sword').map((c) => c.name), 'имя вне конвенции тоже удар').toEqual(['zamah', 'tychok']);
  });

  it('⚠ ПОРЯДОК НЕ СОРТИРУЕТСЯ — он и есть последовательность серии', () => {
    store['pe_attacks'] = JSON.stringify({ warrior: { sword: ['hit_sword_2', 'hit_sword'] } });
    expect(content().attackClips('sword').map((c) => c.name)).toEqual(['hit_sword_2', 'hit_sword']);
  });

  it('пустой или битый список = «автор не отмечал», а не «ударов нет»', () => {
    store['pe_attacks'] = JSON.stringify({ warrior: { sword: [] } });
    expect(content().attackClips('sword').map((c) => c.name)).toEqual(['hit_sword', 'hit_sword_2']);
    store['pe_attacks'] = JSON.stringify({ warrior: { sword: ['нет-такого-клипа'] } });
    expect(content().attackClips('sword').map((c) => c.name), 'ссылка в никуда не должна гасить удары').toEqual(['hit_sword', 'hit_sword_2']);
  });
});

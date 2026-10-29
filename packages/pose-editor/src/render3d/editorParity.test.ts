/**
 * ⭐⭐ РЕДАКТОР ≡ ИГРА: настройки, которые автор крутит в поз-редакторе, обязаны ДОЕЗЖАТЬ до игры.
 *
 * Два ключа читались ТОЛЬКО редактором, и это ловилось глазами как «в редакторе одно, в игре другое»:
 * `pe_morph` (телосложение) и `pe_attacks` (какие клипы удары и в каком порядке).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { loadMorph, localStorageContent } from './poseRuntime.js';
import { composeProfile, composeBuild, composeBoneScale } from './bodyMorph.js';
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
    expect(loadMorph('warrior')).toBeNull();
    store['pe_morph'] = JSON.stringify({ warrior: {} });
    expect(loadMorph('warrior'), 'пустая запись — тоже «не трогай»').toBeNull();
  });

  it('⭐⭐ ЕСТЬ запись — игра её видит', () => {
    store['pe_morph'] = JSON.stringify({ warrior: { height: 1.1, legs: 1.2, shoulders: 1.15 } });
    expect(loadMorph('warrior')?.legs).toBe(1.2);
  });

  it('донор работает так же, как у остальных ключей', () => {
    store['pe_morph'] = JSON.stringify({ warrior: { height: 1.1 } });
    expect(loadMorph('c_custom', 'warrior'), 'фолбэк на донора').toBeTruthy();
    expect(loadMorph('c_custom'), 'без донора — пусто').toBeNull();
  });

  it('⚠ МУСОР в ключе не роняет игру', () => {
    store['pe_morph'] = '{ не json';
    expect(loadMorph('warrior')).toBeNull();
  });

  /**
   * ⚠⚠ ГЛАВНОЕ: МОРФ ПЕРЕМНОЖАЕТСЯ С ПРОПОРЦИЯМИ МОДЕЛИ, А НЕ ЗАМЕНЯЕТ ИХ. Первая врезка сделала
   * «взять морф, если своего нет» — и не работала вовсе: игра ВСЕГДА передаёт профиль модели
   * (`resolvePlayerLook`), поэтому морф не брался никогда, и длина ног в игре не менялась.
   */
  it('⭐⭐ ДЛИНА ЕДЕТ ЧЕРЕЗ ПРОФИЛЬ и перемножается с моделью', () => {
    const model = { height: 1.05, leg: 0.9, arm: 1, torso: 1, girth: 1 };
    const p = composeProfile(model, { legs: 1.2 });
    expect(p.leg, 'нога модели × нога морфа').toBeCloseTo(0.9 * 1.2, 6);
    expect(p.height, 'рост модели сохранён').toBeCloseTo(1.05, 6);
    expect(composeProfile(undefined, { legs: 1.2 }).leg, 'без модели — чистый морф').toBeCloseTo(1.2, 6);
    expect(composeProfile(model, {}).leg, 'пустой морф модель не трогает').toBeCloseTo(0.9, 6);
  });

  it('толщина и пер-костные множители тоже перемножаются', () => {
    expect(composeBuild({ arm: 1.2 }, { armGirth: 1.5, weight: 1 }).arm).toBeCloseTo(1.2 * 1.5, 6);
    const bs = composeBoneScale({ Neck: 1.1 }, { shoulders: 1.3 });
    expect(bs?.Neck, 'атласная кость сохранена').toBeCloseTo(1.1, 6);
    expect(bs?.LeftShoulder, 'кость морфа добавлена').toBeCloseTo(1.3, 6);
    expect(composeBoneScale(undefined, {}), 'пусто — undefined, чтобы не навязывать рецепту лишнего').toBeUndefined();
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

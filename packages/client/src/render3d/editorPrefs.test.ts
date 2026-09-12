import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { POSE_KEYS } from './poseServer.js';

/**
 * ЛИЧНЫЕ НАСТРОЙКИ ИНСТРУМЕНТА (`pe_prefs`) — и главное правило вокруг них.
 *
 * Правило из шапки `editorPrefs.ts`: этот ключ НИКОГДА не публикуется. Настройка рабочего места
 * (шаг гизмо, тумблеры вьюпорта) не влияет на то, как выглядит игра, и уехав на сервер она
 * перетёрла бы соседу его вид — ровно та беда, из-за которой файл и появился. Нарушение тихое:
 * достаточно дописать `'pe_prefs'` в `POSE_KEYS`.
 *
 * ⚠ Модуль читает словарь ОДИН РАЗ ЗА СЕССИЮ и дальше держит в памяти (так и задумано — настройка
 * не должна стоить парсинга на каждый кадр). Поэтому каждому случаю нужен СВЕЖИЙ модуль, иначе
 * значения текут между тестами: первая же проверка «пустое хранилище» увидела 2.5 от предыдущей.
 */
let store: Record<string, string>;

beforeEach(() => {
  vi.resetModules();                        // сбрасываем кэш словаря вместе с модулем
  store = {};
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { store = {}; }, key: () => null, length: 0,
  } as Storage;
});
afterEach(() => { delete (globalThis as unknown as { localStorage?: Storage }).localStorage; });

const fresh = async (): Promise<typeof import('./editorPrefs.js')> => import('./editorPrefs.js');

describe('⚠ личные настройки не публикуются', () => {
  it('`pe_prefs` нет в списке публикуемых ключей', () => {
    expect(POSE_KEYS as readonly string[]).not.toContain('pe_prefs');
  });

  it('сторож не пустой — список ключей вообще непуст', () => {
    expect(POSE_KEYS.length).toBeGreaterThan(5);
  });
});

describe('шаг гизмо переживает перезагрузку', () => {
  it('записанное значение читается обратно', async () => {
    const { getPref, setPref } = await fresh();
    setPref('snapMove', 2.5); setPref('snapRot', 15); setPref('snap', false);
    expect(getPref('snapMove', 1)).toBe(2.5);
    expect(getPref('snapRot', 5)).toBe(15);
    expect(getPref('snap', true)).toBe(false);
  });

  it('и ПЕРЕЖИВАЕТ перезагрузку страницы — значение уходит в localStorage, а не только в память', async () => {
    const a = await fresh();
    a.setPref('snapMove', 3.5);
    vi.resetModules();                       // как будто F5: модуль поднялся заново
    const b = await fresh();
    expect(b.getPref('snapMove', 1)).toBe(3.5);
  });

  it('пустое хранилище отдаёт умолчание — 1 ед и 5°, как было зашито в коде', async () => {
    const { getPref } = await fresh();
    expect(getPref('snapMove', 1)).toBe(1);
    expect(getPref('snapRot', 5)).toBe(5);
    expect(getPref('snap', true)).toBe(true);
  });

  it('ноль сохраняется как ноль, а не подменяется умолчанием', async () => {
    // Ноль = «без шага по этой оси». Если бы `getPref` считал его отсутствием, выключить шаг
    // только для поворота было бы нельзя.
    const { getPref, setPref } = await fresh();
    setPref('snapRot', 0);
    expect(getPref('snapRot', 5)).toBe(0);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { offSlotKey } from './poseLayers.js';
import { localStorageContent } from './poseRuntime.js';
import type { Pose } from './clipModel.js';

/**
 * ⭐⭐ ПРЕДМЕТ ОФФ-РУКИ, НАСТРОЕННЫЙ БЕЗ ОРУЖИЯ, ОБЯЗАН ПОДМЕШИВАТЬСЯ КО ВСЕМ ОРУЖИЯМ.
 *
 * Жалоба: «сделал два idle щиту без оружия, а к мечу не прицепилось». Причина оказалась чисто
 * ключевой: панель редактора собирает ключ из ДВУХ слотов и при пустой главной руке пишет
 * **`none+shield`**, а слой предметов, разобрав `sword+shield`, ищет офф-руку под ключом
 * **`shield`**. Имена не совпадали — и щит не подмешивался НИ К ОДНОМУ оружию.
 *
 * ⚠ Лечится СИНОНИМОМ ключа, а не переименованием: уже сделанные клипы остаются как есть.
 * ⚠ Точная настройка на пару сохраняется: авторская поза на `sword+shield` по-прежнему бьёт сборку.
 */
describe('офф-рука без оружия едет ко всем оружиям', () => {
  const store: Record<string, string> = {};
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => store[k] ?? null, setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0,
    } as Storage;
  });
  afterEach(() => { delete (globalThis as unknown as { localStorage?: Storage }).localStorage; });

  /**
   * Клип стойки: имя по конвенции `idle_<ключ>`. Поза содержит ОБЕ руки — как настоящая стойка:
   * дельта предмета считается относительно базы, и если канала нет в базе, слоям не от чего считать.
   */
  const pose2 = (l: number, r: number): Pose => ({ LeftUpperArm: [0, 0, l], RightUpperArm: [0, 0, r] } as unknown as Pose);
  const stance = (key: string, l: number, r: number, kind = 'idle'): unknown => ({
    name: kind + '_' + key, character: 'w', weapon: key, loop: false,
    keys: [{ t: 0, pose: pose2(l, r) }],
  });

  it('ключ «предмет в слоте офф-руки»', () => {
    expect(offSlotKey('shield')).toBe('none+shield');
    expect(offSlotKey('dagger')).toBe('none+dagger');
  });

  it('⭐⭐ ЩИТ, НАСТРОЕННЫЙ БЕЗ ОРУЖИЯ, ПРИЕЗЖАЕТ К МЕЧУ', () => {
    // ⚠ Мутация «искать только по точному ключу» валит это — так и было до правки.
    store['pe_clips'] = JSON.stringify([
      stance('none', 0, 0),
      stance('sword', 0, 0.8),
      stance('none+shield', 0.7, 0),     // ← сделано при ПУСТОЙ главной руке
    ]);
    const c = localStorageContent('w');
    const pose = c.resolveUpper('sword+shield', 0, 0)?.pose;
    expect(pose, 'стойка пары не собралась вовсе').toBeTruthy();
    expect(pose!['LeftUpperArm']![2], '⚠ ЩИТ НЕ ПРИЦЕПИЛСЯ к мечу').toBeCloseTo(0.7, 6);
    expect(pose!['RightUpperArm']![2], '⚠ потерялась главная рука').toBeCloseTo(0.8, 6);
  });

  it('⭐ ТО ЖЕ ДЛЯ ЛЮБОГО ПРЕДМЕТА ОФФ-РУКИ, не только щита', () => {
    store['pe_clips'] = JSON.stringify([
      stance('none', 0, 0),
      stance('axe', 0, 0.5),
      stance('none+dagger', -0.6, 0),
    ]);
    const pose = localStorageContent('w').resolveUpper('axe+dagger', 0, 0)?.pose;
    expect(pose!['LeftUpperArm']![2], '⚠ кинжал во второй руке не приехал').toBeCloseTo(-0.6, 6);
  });

  it('⭐ и наоборот: предмет, сделанный под ключом `shield`, тоже находится', () => {
    store['pe_clips'] = JSON.stringify([
      stance('none', 0, 0),
      stance('sword', 0, 0.8),
      stance('shield', 0.4, 0),          // ← без «none+»
    ]);
    const pose = localStorageContent('w').resolveUpper('sword+shield', 0, 0)?.pose;
    expect(pose!['LeftUpperArm']![2]).toBeCloseTo(0.4, 6);
  });

  it('⭐⭐ ТОЧНАЯ НАСТРОЙКА НА ПАРУ СИЛЬНЕЕ СБОРКИ — возможность «доделать отдельно» цела', () => {
    // Ровно то, что просили: общее правило работает само, а частный случай можно переопределить.
    store['pe_clips'] = JSON.stringify([
      stance('none', 0, 0),
      stance('sword', 0, 0.8),
      stance('none+shield', 0.7, 0),
      stance('sword+shield', 1.3, 0),   // авторская на точный ключ
    ]);
    const pose = localStorageContent('w').resolveUpper('sword+shield', 0, 0)?.pose;
    expect(pose!['LeftUpperArm']![2], '⚠ авторская поза пары проиграла сборке').toBeCloseTo(1.3, 6);
  });

  it('⚠ нет клипа офф-руки — стойка всё равно собирается, без него', () => {
    store['pe_clips'] = JSON.stringify([stance('none', 0, 0), stance('sword', 0, 0.8)]);
    const pose = localStorageContent('w').resolveUpper('sword+shield', 0, 0)?.pose;
    expect(pose!['RightUpperArm']![2]).toBeCloseTo(0.8, 6);
    expect(pose!['LeftUpperArm']![2]).toBeCloseTo(0, 6);
  });

  it('⚠ БОЕВАЯ СТОЙКА ЩИТА ТОЖЕ НАХОДИТСЯ по синониму', () => {
    store['pe_clips'] = JSON.stringify([
      stance('none', 0, 0), stance('none', 0, 0, 'combat_idle'),
      stance('sword', 0, 0.8), stance('sword', 0, 0.8, 'combat_idle'),
      stance('none+shield', 1.1, 0, 'combat_idle'),
    ]);
    const pose = localStorageContent('w').resolveUpper('sword+shield', 1, 0)?.pose;
    expect(pose!['LeftUpperArm']![2], '⚠ боевая стойка щита не нашлась').toBeCloseTo(1.1, 6);
  });
});

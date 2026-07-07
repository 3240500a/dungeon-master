import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { saveStateSchema } from '../validation/save.js';
import { newCharacterSave } from './newCharacter.js';

function reg(): ConfigRegistry {
  const r = new ConfigRegistry();
  r.loadAll();
  return r;
}

describe('newCharacterSave (авторитетный стартовый персонаж)', () => {
  it('строит валидный сейв уровня 1 из конфига класса', () => {
    const r = reg();
    const cls = r.get('classes')[0]!;
    const save = newCharacterSave(r, cls.id, '  Тест  ', 'char-1');
    expect(save.charId).toBe('char-1');
    expect(save.name).toBe('Тест'); // имя тримится
    expect(save.classId).toBe(cls.id);
    expect(save.level).toBe(1);
    expect(save.gold).toBe(0);
    expect(save.attributes).toEqual(cls.startAttributes);
    expect(save.equipment.weapon?.baseId).toBe(cls.startWeaponId); // оружие класса надето
    // Проходит серверную валидацию (иначе сервер пересоздал бы персонажа на входе).
    expect(saveStateSchema.safeParse(save).success).toBe(true);
  });

  it('пустое имя → «Герой», неизвестный класс → первый класс', () => {
    const r = reg();
    const save = newCharacterSave(r, 'no-such-class', '', 'c2');
    expect(save.name).toBe('Герой');
    expect(save.classId).toBe(r.get('classes')[0]!.id);
  });
});

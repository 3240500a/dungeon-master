import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from './registry.js';
import { objectsSchema, OBJECT_FX_KINDS } from './schemas.js';
import { gameView } from './configRev.js';

/**
 * ⭐ 08.10: ОГОНЬ ОБЪЕКТА (`objects[].fx`) — частицы и звук огня в Unity (`Assets/DM/Fx/FireFx.cs`, префабы `Assets/DM/Fx/Fire`).
 * Сервер и веб поле не читают; здесь — форма поля, живые значения крипты и то, что в игровой вид таблицы оно не попадает.
 */
describe('⭐ objects[].fx — огонь объекта', () => {
  const obj = (o: Record<string, unknown>) => objectsSchema.element.parse({ id: 'x', ...o });

  it('вид обязателен и из списка; размер и сдвиг — с нейтральными умолчаниями', () => {
    expect(obj({ fx: { kind: 'fire_small' } }).fx).toEqual({ kind: 'fire_small', scale: 1, offset: [0, 0, 0] });
    expect(obj({}).fx).toBeUndefined();
    for (const kind of OBJECT_FX_KINDS) expect(obj({ fx: { kind } }).fx?.kind).toBe(kind);
    expect(() => obj({ fx: { kind: 'fire_huge' } })).toThrow();
    expect(() => obj({ fx: { scale: 2 } })).toThrow();   // без вида — не огонь (редактор снимает поле целиком)
    expect(() => obj({ fx: { kind: 'fire_big', scale: 0 } })).toThrow();
    expect(() => obj({ fx: { kind: 'fire_big', offset: [0, 1] } })).toThrow();
  });

  // ⭐ 08.10 (живой тест владельца): огонь пола — плоский язык на земле, с камеры сверху «горит плоскость»; костёр — объёмный fire_medium
  it('крипта: факел — малый огонь в маркере, костры — объёмный огонь, опущенный к углям', () => {
    const reg = new ConfigRegistry();
    reg.loadAll();
    const by = new Map(reg.get('objects').map((o) => [o.id, o]));
    expect(by.get('crypt_wall_torch_01')?.fx).toEqual({ kind: 'fire_small', scale: 1, offset: [0, -0.12, 0] });
    // ⭐ 08.10: пламя — из углей (замер по мешам: угли факела на 1.718 при маркере 1.779; костров ~0.2–0.33 при маркерах 0.56 / 0.75)
    expect(by.get('crypt_fire_pit_01')?.fx).toEqual({ kind: 'fire_medium', scale: 0.7, offset: [0, -0.45, 0] });
    expect(by.get('crypt_fire_pit_02')?.fx).toEqual({ kind: 'fire_medium', scale: 0.7, offset: [0, -0.6, 0] });
    // огонь — только у объектов со светом: пламя без лампы в тёмной крипте читалось бы наклейкой
    for (const o of reg.get('objects')) if (o.fx) expect(o.light, o.id).toBeDefined();
  });

  it('огонь — картинка: в игровой вид объектов не входит', () => {
    const reg = new ConfigRegistry();
    reg.loadAll();
    const view = gameView('objects', reg.get('objects')) as Record<string, unknown>[];
    expect(view.length).toBeGreaterThan(0);
    for (const row of view) expect(row).not.toHaveProperty('fx');
  });
});

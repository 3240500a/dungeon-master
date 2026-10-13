import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from './registry.js';
import { environmentSchema } from './schemas.js';
import { gameView } from './configRev.js';
import { placeableObjects } from '../dungeon/decor.js';

/**
 * ⭐ 13.10 (владелец: «у нас есть модель сундука с крышкой открывающейся, давай его тоже добавим вместо заглушки»): МОДЕЛЬ СУНДУКА ЛУТА
 * биома — `environment[].chestModel`, ключ модели каталога Unity. Рисует её только Unity (`ChestRules`/`WorldProps`: крышка откидывается
 * по `chest-opened`, сундук остаётся); сервер и веб-3D поле не читают. Здесь — форма поля, живое значение крипты, что ключ — модель
 * каталога, а не декор (паспорта нет, сервер её не расставляет), и что выбор модели игровую ревизию не сдвигает.
 */
describe('⭐ 13.10 environment[].chestModel — модель сундука лута биома', () => {
  const env = (o: Record<string, unknown>) => environmentSchema.element.parse({ id: 'x', biomeId: 'x', ...o });
  const fresh = (): ConfigRegistry => { const reg = new ConfigRegistry(); reg.loadAll(); return reg; };

  it('поле необязательное: нет — нет (заглушка), строка — как есть', () => {
    expect(env({}).chestModel).toBeUndefined();
    expect(env({ chestModel: 'crypt_wooden_chest_01' }).chestModel).toBe('crypt_wooden_chest_01');
    expect(env({ chestModel: '' }).chestModel).toBe('');
    expect(() => env({ chestModel: 5 })).toThrow();
  });

  it('крипта — crypt_wooden_chest_01: модель каталога Unity (env, не material), не декор', () => {
    const reg = fresh();
    const crypt = reg.get('environment').find((e) => e.biomeId === 'crypt' && e.enabled);
    expect(crypt?.chestModel).toBe('crypt_wooden_chest_01');
    const rows = reg.get('art').filter((a) => a.id === 'crypt_wooden_chest_01');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.kind).toBe('env');
    // модель сундука лута — не декор: паспорта нет, неявным объектом сервер её не ставит, строки `objects` на неё нет
    expect(rows.every((a) => !a.decor)).toBe(true);
    expect(reg.get('objects').some((o) => o.modelId === 'crypt_wooden_chest_01' || o.id === 'crypt_wooden_chest_01')).toBe(false);
    const placeable = placeableObjects(reg.get('objects') as never, reg.get('art') as never);
    expect(placeable.some((o) => o.modelId === 'crypt_wooden_chest_01')).toBe(false);
    // у прочих биомов поля нет — сундуки на боксах, как было
    for (const e of reg.get('environment')) if (e.biomeId !== 'crypt') expect(e.chestModel, e.biomeId).toBeUndefined();
  });

  it('выбор модели — картинка: игровой вид `environment` пуст, игровая ревизия не сдвигается, полная — да', () => {
    const reg = fresh();
    expect(gameView('environment', reg.get('environment'))).toBeNull();
    const full = reg.revision(), game = reg.gameRevision();
    const t = structuredClone(reg.get('environment'));
    t.find((e) => e.biomeId === 'crypt')!.chestModel = 'crypt_wooden_crate_01';
    reg.reload({ environment: t });
    expect(reg.revision()).not.toBe(full);
    expect(reg.gameRevision()).toBe(game);
  });
});

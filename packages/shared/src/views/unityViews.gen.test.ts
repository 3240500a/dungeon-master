/**
 * ⭐ С2/С4–С6 (29.10): ПРОДЮСЕР ЭТАЛОНА «ВИДЫ СЕРВЕРА → МОДЕЛИ ОКОН UNITY». Сервер шлёт окнам Unity модели (кадры `hero` и `view`), а
 * Unity разбирает их в свои классы (`JToken.ToObject<T>()`): этот файл кладёт образцы ровно тех моделей, что отдаёт сервер, — их считают
 * функции `views/` от настоящего конфига, — и Unity-сторож `ViewsCheck` разбирает каждый в свой класс и сверяет, что ни одно поле не
 * потерялось. Правил здесь нет: только образцы провода.
 *
 * Сейв-образец «богатый»: вещи в сумке (оружие и броня разных редкостей), стопки сырья, печати, кошелёк сундука, план забега — чтобы у каждой
 * модели были заполнены все ветки (пустой список Newtonsoft разберёт и в класс без нужного поля, и потерю никто не увидит).
 *
 * Эталон: `__golden__/unity_views.json` → Unity `Assets/DM/UI/Tests/unity_views_golden.json` (`tools/unity-check/golden_sync.py`).
 * Перезапись: `npx vitest run packages/shared/src/views/unityViews.gen.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigRegistry } from '../config/registry.js';
import { unityViewsSample } from './unityViews.testkit.js';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('эталон моделей окон для Unity (виды сервера)', () => {
  it('пишет __golden__/unity_views.json', () => {
    const cfg = new ConfigRegistry();
    cfg.loadAll();
    // ⭐ i18n Ф2 (06.11): образец собирает тесткит — его же рендерит сторож утечек псевдоязыка
    const { out } = unityViewsSample(cfg);
    expect(out.sheet.blocks.length).toBeGreaterThan(3);
    expect(out.tree.nodes.length).toBeGreaterThan(10);
    expect(out.town.bench, 'верстак по оружию из сумки').not.toBeNull();
    expect(Object.keys(out.town.tips.tips).length).toBeGreaterThan(4);
    expect(Object.keys(out.town.tips.worn).length, 'есть сравнение с надетым').toBeGreaterThan(0);
    expect(Object.values(out.town.tips.tips).some((t) => t.wornSlot !== null) && Object.values(out.town.tips.tips).some((t) => t.wornSlot === null)).toBe(true);
    expect(out.hero.melee, 'конус взмаха').not.toBeNull();
    expect(out.run.map.nodes.length).toBeGreaterThan(3);
    const file = join(HERE, '__golden__', 'unity_views.json');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
  });
});

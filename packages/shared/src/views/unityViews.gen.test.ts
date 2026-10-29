/**
 * ⭐ С2/С4–С6 (29.10): ПРОДЮСЕР ЭТАЛОНА «ВИДЫ СЕРВЕРА → МОДЕЛИ ОКОН UNITY». Сервер шлёт окнам Unity модели (кадры `hero` и `view`), а
 * Unity разбирает их в свои классы (`JToken.ToObject<T>()`): этот файл кладёт образцы ровно тех моделей, что отдаёт сервер, — их считают
 * функции `views/` от настоящего конфига, — и Unity-сторож `ViewsCheck` разбирает каждый в свой класс и сверяет, что ни одно поле не
 * потерялось. Правил здесь нет: только образцы провода.
 *
 * Эталон: `__golden__/unity_views.json` → Unity `Assets/DM/UI/Tests/unity_views_golden.json` (`tools/unity-check/golden_sync.py`).
 * Перезапись: `npx vitest run packages/shared/src/views/unityViews.gen.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigRegistry } from '../config/registry.js';
import { newCharacterSave } from '../economy/newCharacter.js';
import { xpProgress } from '../formulas/xp.js';
import { heroNumbers, masterBlock, hudInfo, sheetView, skillTreeView } from './hero.js';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('эталон моделей окон для Unity (виды сервера)', () => {
  it('пишет __golden__/unity_views.json', () => {
    const cfg = new ConfigRegistry();
    cfg.loadAll();
    const cls = cfg.get('classes').find((c) => c.enabled !== false) ?? cfg.get('classes')[0]!;
    const save = newCharacterSave(cfg, cls.id, 'Образец', 'char-views-golden');
    save.unspentAttributePoints = 3;
    const live = { hp: 30, mana: 10, stamina: 20 };
    const floor = { area: 'town' as const, depth: 0, difficultyId: cfg.get('difficulties')[0]!.id, challengeLevel: null };
    const out = {
      note: 'Образцы моделей окон, которые шлёт сервер (виды `packages/shared/src/views`). Генерит packages/shared/src/views/unityViews.gen.test.ts; сторож Unity — Assets/DM/UI/Tests/ViewsCheck.cs.',
      hero: {
        numbers: heroNumbers(cfg, save, []), master: masterBlock(cfg, save, []), hudInfo: hudInfo(cfg, save, floor),
        xp: xpProgress(save.level, save.xp, cfg.get('balance').xpTable), toggles: [],
      },
      sheet: { blocks: sheetView(cfg, save, [], live, { lastTarget: { name: 'Зомби', accuracy: 40, evade: 20 } }) },
      sheetPending: { blocks: sheetView(cfg, save, [], live, { pending: { strength: 2, vitality: 1 } }) },
      tree: skillTreeView(cfg, save),
    };
    expect(out.sheet.blocks.length).toBeGreaterThan(3);
    expect(out.tree.nodes.length).toBeGreaterThan(10);
    const file = join(HERE, '__golden__', 'unity_views.json');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
  });
});

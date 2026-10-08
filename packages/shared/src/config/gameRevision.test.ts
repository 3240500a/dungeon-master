import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from './registry.js';
import { gameView, VISUAL_ONLY_KEYS } from './configRev.js';
import { configChanged } from '../economy/townActions.js';
import { PRICE_CHANGED } from '../economy/townActions.js';

/**
 * ⭐ 08.10 (Д1): ИГРОВАЯ РЕВИЗИЯ КОНФИГА. Полная ревизия (`revision`) сдвигалась от ЛЮБОЙ правки — текстуры, материала, вида модели, фейда
 * стен, — и согласие команд кузницы и лавки (`configChanged`) отказывало всем игрокам «Цена изменилась», хотя исход команды не менялся
 * (`configSync.ts`). Игровая ревизия (`gameRevision`) считается по игровому виду таблиц: визуальные таблицы в неё не входят, а у смешанных
 * (`models`, `objects`) — только поля, которые читает серверная игра (расстановка и коллизия декора, `decorSpecsFor`).
 */
function fresh(): ConfigRegistry {
  const reg = new ConfigRegistry();
  reg.loadAll();
  return reg;
}

describe('⭐ Д1: игровая ревизия конфига', () => {
  it('правка картинки не сдвигает игровую ревизию, но сдвигает полную', () => {
    const edits: Array<(r: ConfigRegistry) => void> = [
      (r) => { const t = structuredClone(r.get('textures')); t[0]!.aniso = (t[0]!.aniso ?? 0) + 1; r.reload({ textures: t }); },
      (r) => { const t = structuredClone(r.get('materials')); t[0]!.smoothness = 0.123; r.reload({ materials: t }); },
      (r) => { const t = structuredClone(r.get('environment')); t[0]!.fade.start += 5; r.reload({ environment: t }); },
      // вид модели: ссылка, слоты, материалы сабмешей, кости
      (r) => { const t = structuredClone(r.get('models')); t[0]!.url = '/assets/other.glb'; t[0]!.submeshMaterials = { a: 'b' }; t[0]!.boneMap = { Hips: 'X' }; r.reload({ models: t }); },
      // вид объекта: материал, имя
      (r) => { const t = structuredClone(r.get('objects')); t[0]!.materialId = 'mat_x'; t[0]!.name = 'другое имя'; r.reload({ objects: t }); },
      // 08.10: новый .mat библиотеки Unity в манифесте арта (строка вида material) и материал брони по ступени — картинка
      (r) => { const t = structuredClone(r.get('art')); t.push({ id: 'mat_new', kind: 'material', group: 'mat_x', meshes: [], bones: [], sockets: [], lights: [] }); r.reload({ art: t }); },
    ];
    for (const [i, edit] of edits.entries()) {
      const reg = fresh();
      const full = reg.revision(), game = reg.gameRevision();
      edit(reg);
      expect(reg.revision(), `правка ${i}: полная`).not.toBe(full);
      expect(reg.gameRevision(), `правка ${i}: игровая`).toBe(game);
    }
  });

  it('правка того, что читает серверная игра, сдвигает игровую ревизию', () => {
    const edits: Array<(r: ConfigRegistry) => void> = [
      (r) => { const t = structuredClone(r.get('models')); t[0]!.collider = { shape: 'circle', r: 0.3 }; r.reload({ models: t }); },
      (r) => { const t = structuredClone(r.get('objects')); t[0]!.blocks = !t[0]!.blocks; r.reload({ objects: t }); },
      (r) => { const t = structuredClone(r.get('objects')); t[0]!.spawnChance = 0.77; r.reload({ objects: t }); },
      (r) => { const t = structuredClone(r.get('objects')); t[0]!.footprint = { w: 2, h: 2 }; r.reload({ objects: t }); },
      (r) => { const t = structuredClone(r.get('objects')); t[0]!.modelId = 'другая_модель'; r.reload({ objects: t }); },   // коллайдер — модели
      (r) => { const b = structuredClone(r.get('balance')); b.craft.cost.enchantGold += 7; r.reload({ balance: b }); },
    ];
    for (const [i, edit] of edits.entries()) {
      const reg = fresh();
      const game = reg.gameRevision();
      edit(reg);
      expect(reg.gameRevision(), `правка ${i}`).not.toBe(game);
    }
  });

  it('согласие кузницы и лавки: годятся и полная, и игровая ревизия; правка картинки старому окну не отказ', () => {
    const reg = fresh();
    const full = reg.revision(), game = reg.gameRevision();
    expect(configChanged(reg, full)).toBeNull();
    expect(configChanged(reg, game)).toBeNull();
    expect(configChanged(reg, undefined)).toBeNull();
    const t = structuredClone(reg.get('textures')); t[0]!.aniso = (t[0]!.aniso ?? 0) + 3; reg.reload({ textures: t });
    expect(configChanged(reg, game), 'окно с игровой ревизией — картинка не в счёт').toBeNull();
    expect(configChanged(reg, full)?.reason?.startsWith(PRICE_CHANGED), 'окно с полной — как прежде').toBe(true);
    const b = structuredClone(reg.get('balance')); b.craft.cost.enchantGold += 1; reg.reload({ balance: b });
    expect(configChanged(reg, game)?.reason?.startsWith(PRICE_CHANGED), 'игровая правка — отказ').toBe(true);
  });

  it('клиент, прочитавший тело `/api/config`, видит ту же игровую ревизию, что сервер', () => {
    const server = fresh();
    const m = structuredClone(server.get('models')); m[0]!.collider = { shape: 'box', w: 0.5, h: 0.25 }; server.reload({ models: m });
    const client = new ConfigRegistry();
    client.loadAll(JSON.parse(JSON.stringify(server.snapshot())) as Record<string, unknown>);
    expect(client.gameRevision()).toBe(server.gameRevision());
  });

  it('игровой вид: визуальная таблица — null, смешанная — только игровые поля, память по объекту таблицы', () => {
    const reg = fresh();
    for (const k of VISUAL_ONLY_KEYS) expect(gameView(k, reg.get(k as 'textures'))).toBeNull();
    const objects = reg.get('objects');
    const view = gameView('objects', objects) as Record<string, unknown>[];
    expect(gameView('objects', objects)).toBe(view);
    expect(Object.keys(view[0]!)).not.toContain('materialId');
    expect(Object.keys(view[0]!)).toContain('blocks');
    const models = gameView('models', reg.get('models')) as Record<string, unknown>[];
    for (const row of models) for (const k of Object.keys(row)) expect(['id', 'collider']).toContain(k);
    expect(gameView('balance', reg.get('balance'))).toBe(reg.get('balance'));
  });
});

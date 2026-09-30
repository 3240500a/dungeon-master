import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { ConfigRegistry, PROTOCOL_VERSION } from '@dm/shared';

/**
 * ⭐ R10-12: ПОСТРОИТЕЛЬ МОДЕЛИ КОВКИ НЕ ЗАГРУЗИЛСЯ (деплой сменил хэши кусков, вкладка прежняя).
 *
 * `craftMesh` — ленивый кусок сборки (тот же файл, что окно ковки). После деплоя без перезагрузки вкладки его `import()`
 * просит файл, которого больше нет: раньше каждое оружие из деталей — своё и чужое — молча оставалось процедурным на
 * всю сессию, и никто не говорил игроку нажать F5. Теперь сбой — «код вкладки устарел»: `App` пишет в лог игры
 * `PROTOCOL_STALE` ОДИН раз на страницу, сколько бы кукол ни попросили модель; рука остаётся процедурной, без исключения.
 *
 * Кусок «не грузится» — `vi.mock` с броском: так `import()` отказывает, как в браузере на 404.
 */
const loads = vi.hoisted(() => ({ n: 0 }));
vi.mock('../modules/town/craftMesh/index.js', () => {
  loads.n++;
  throw new TypeError('Failed to fetch dynamically imported module: https://game.example/assets/forgeCraftTab-KtW2feJZ.js');
});
// env3d тянет DOM/GLTFLoader — руке оружия он не нужен (как в craftWeapon3d.test.ts).
vi.mock('./env3d.js', () => ({ WALL_H: 96 }));

import { applyCraftLooks, loadCraftMeshLib } from './craftWeapon3d.js';
import { App } from '../core/app.js';
import { PROTOCOL_STALE } from '../net/versionGate.js';

describe('⭐ R10-12: модель ковки не загрузилась — «перезагрузите» один раз, рука процедурная', () => {
  const G = globalThis as unknown as { fetch?: unknown };
  let savedFetch: unknown;
  beforeEach(() => {
    savedFetch = G.fetch;
    G.fetch = () => Promise.reject(new Error('сервер перезапускается'));   // `App` тянет `/api/config` — здесь он не нужен
    vi.spyOn(console, 'warn').mockImplementation(() => { });
  });
  afterEach(() => { G.fetch = savedFetch; vi.restoreAllMocks(); });

  it('⭐ сбой загрузки построителя — строка в лог игры один раз на страницу; повтор и чужие куклы второй не дают', async () => {
    expect(PROTOCOL_VERSION, 'протокол не менялся — `joined.v` вкладку не выдаст').toBe(1);
    const app = new App();
    const logs: string[] = [];
    app.bus.on('log:message', (m) => { logs.push(m.text); });
    const reg = new ConfigRegistry();
    reg.loadAll();

    expect(await loadCraftMeshLib(), 'кусок не загрузился — null, без исключения').toBeNull();
    expect(logs, 'было: молча, модели на всю сессию процедурные').toEqual([PROTOCOL_STALE]);

    // Следующие куклы (свой новый меч, пиры с оружием из деталей) — снова просят; сказано уже, строка одна.
    const g = new THREE.Group();
    g.userData.craftLook = { baseId: 'x', parts: {} };
    const child = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    g.add(child);
    await applyCraftLooks([g], reg);
    await applyCraftLooks([g], reg);
    expect(loads.n, 'повтор просит кусок снова (мигнувшая связь могла вернуться)').toBeGreaterThanOrEqual(2);
    expect(g.children, 'рука осталась процедурной').toEqual([child]);
    expect(logs, 'одна строка на страницу').toEqual([PROTOCOL_STALE]);
  });
});

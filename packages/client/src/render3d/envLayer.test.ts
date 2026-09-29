import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rebuildEnvLayer, clearGroup } from './envLayer.js';
import { removeProp } from './propDispose.js';

/**
 * ⭐ R15-01: ДОГРУЗКА ТАЙЛСЕТА БИОМА ПЕРЕСОБИРАЕТ ТОЛЬКО ОКРУЖЕНИЕ — ДВЕРИ, РЫЧАГИ, СУНДУКИ, ВЫХОДЫ И ПОРТАЛЫ ЦЕЛЫ.
 *
 * На первом узле крипты за страницу кита окружения ещё нет: `buildArea` рисует пол боксами, запускает загрузку GLB и
 * кладёт в ту же группу пола свои предметы (лестницы выходов, портал возврата, створки дверей, рычаги, сундуки; в городе —
 * столбики NPC и портал). Загрузка всегда кончается ПОСЛЕ `buildArea`, и её обработчик сносил группу пола целиком, а
 * `buildEnvironment` перерисовывал только сетку, декор и `stairsDown` (`doors: []`). До смены области запертая дверь
 * выглядела полом (сервер держал клетку — невидимая стена), рычаги, сундуки, портал возврата и выходы развилки пропадали,
 * а их `[E]` и метки миникарты оставались на пустом месте; `removeProp` по снятым мешам больше ничего не делал.
 *
 * `online3d` в node не собирается (WebGL, Jolt; `env3d` рисует канвас при загрузке модуля), поэтому поведение пересборки
 * проверено на настоящих группах three с подставным `buildEnvironment` и отложенной загрузкой кита, а проводка
 * `online3d` — по исходнику, как остальные швы (`propDispose.test.ts`, `online3dNet.test.ts`).
 */
type Layout = { doors: unknown[]; stairsDown?: { x: number; y: number } };
type Kit = { tag: string };
/** Подстава `env3d.buildEnvironment`: пол (кит или бокс) + лестница вниз в переданную группу; возвращает «факелы». */
function fakeBuildEnvironment(parent: THREE.Object3D, layout: Layout, kit?: Kit): string[] {
  const floor = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  floor.name = kit ? `floor:${kit.tag}` : 'floor:boxes';
  parent.add(floor);
  if (layout.stairsDown) { const st = new THREE.Group(); st.name = 'stairsDown'; parent.add(st); }
  return [floor.name];
}
const prop = (name: string): THREE.Mesh => { const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()); m.name = name; return m; };

describe('⭐ R15-01: тайлсет биома догрузился — предметы области на месте', () => {
  it('⭐ отложенный кит: пересобрано окружение, а дверь, рычаг, сундук, выход и портал возврата — в своей группе и сцене', async () => {
    const scene = new THREE.Scene();
    const envGroup = new THREE.Group(); scene.add(envGroup);
    const floorGroup = new THREE.Group(); scene.add(floorGroup);
    const layout: Layout = { doors: [], stairsDown: { x: 0, y: 0 } };

    // buildArea: кита нет — окружение боксами, загрузка кита запущена, предметы области — в своей группе.
    let torches = rebuildEnvLayer(envGroup, (g) => fakeBuildEnvironment(g, layout, undefined));
    let resolveKit!: (k: Kit) => void;
    const kitLoaded = new Promise<Kit>((r) => { resolveKit = r; }).then((k) => {
      torches = rebuildEnvLayer(envGroup, (g) => fakeBuildEnvironment(g, layout, k));   // как обработчик `loadEnvForBiome`
    });
    const door = prop('door'), lever = prop('lever'), chest = prop('chest'), exit = prop('exit'), back = prop('returnPortal');
    floorGroup.add(exit, back, door, lever, chest);
    const boxFloor = envGroup.getObjectByName('floor:boxes') as THREE.Mesh;
    const boxDispose = vi.spyOn(boxFloor.geometry, 'dispose');
    const propDispose = [door, lever, chest, exit, back].map((m) => vi.spyOn(m.geometry, 'dispose'));

    resolveKit({ tag: 'crypt' });
    await kitLoaded;

    for (const m of [door, lever, chest, exit, back]) {
      expect(m.parent, `было: «${m.name}» снят пересборкой окружения`).toBe(floorGroup);
      expect(scene.getObjectById(m.id), `«${m.name}» в графе сцены`).toBe(m);
    }
    for (const s of propDispose) expect(s, 'буферы предметов области не освобождены').not.toHaveBeenCalled();
    expect(envGroup.children.map((c) => c.name)).toEqual(['floor:crypt', 'stairsDown']);
    expect(boxFloor.parent, 'пол боксами снят').toBeNull();
    expect(boxDispose, 'и его геометрия освобождена').toHaveBeenCalledTimes(1);
    expect(torches).toEqual(['floor:crypt']);

    // Дверь открылась после догрузки: `removeProp` снимает меш со сцены (было: меш уже вне группы — ничего не делал).
    const matDispose = vi.spyOn(door.material as THREE.Material, 'dispose');
    removeProp(floorGroup, door);
    expect(door.parent).toBeNull();
    expect(matDispose).toHaveBeenCalledTimes(1);
    expect(floorGroup.children).toEqual([exit, back, lever, chest]);
  });

  it('смена области сносит обе группы; пересборка окружения — только свою', () => {
    const envGroup = new THREE.Group(), floorGroup = new THREE.Group();
    rebuildEnvLayer(envGroup, (g) => fakeBuildEnvironment(g, { doors: [] }));
    floorGroup.add(prop('chest'));
    rebuildEnvLayer(envGroup, (g) => fakeBuildEnvironment(g, { doors: [] }, { tag: 'crypt' }));
    expect(envGroup.children).toHaveLength(1);
    expect(floorGroup.children).toHaveLength(1);
    clearGroup(floorGroup); clearGroup(envGroup);
    expect(envGroup.children).toEqual([]);
    expect(floorGroup.children).toEqual([]);
  });

  it('веб-3D: окружение — своя группа; пересобирают её все три пути, группу предметов сносит одна смена области', () => {
    const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'online3d.ts'), 'utf8');
    expect(SRC).toMatch(/const envGroup = new THREE\.Group\(\); scene\.add\(envGroup\);/);
    // Каждый вызов `buildEnvironment` — через пересборку слоя окружения: `buildArea`, догрузка кита, DEV `rebuildEnv`.
    const calls = SRC.match(/buildEnvironment\(/g) ?? [];
    const viaLayer = SRC.match(/rebuildEnvLayer\(envGroup, \(g\) => buildEnvironment\(g, /g) ?? [];
    expect(viaLayer.length, 'buildArea + догрузка кита + rebuildEnv').toBe(3);
    expect(calls.length, '⚠ окружение строится мимо своей группы').toBe(viaLayer.length);
    expect(SRC, '⚠ предмет области положен в группу окружения — его снесёт догрузка кита').not.toMatch(/envGroup\.add\(/);
    // Группа предметов (двери/рычаги/сундуки/выходы/порталы/NPC) сносится только сменой области.
    const wipes = SRC.match(/clearGroup\(floorGroup\)/g) ?? [];
    expect(wipes.length, 'было: догрузка кита и rebuildEnv сносили группу пола целиком').toBe(1);
    const buildArea = SRC.slice(SRC.indexOf('function buildArea(floor: FloorInit): void {'), SRC.indexOf('function descendExit('));
    expect(buildArea).toContain('clearGroup(floorGroup)');
    const at = SRC.indexOf('function loadEnvForBiome(');
    const loader = SRC.slice(at, SRC.indexOf('\n  }\n', at));
    expect(loader).toMatch(/rebuildEnvLayer\(envGroup, /);
    expect(loader).not.toMatch(/clearGroup\(/);
  });
});

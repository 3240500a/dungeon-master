import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ConfigRegistry, defaultParts, familiesOf, weaponLookSig } from '@dm/shared';
import { CRAFT_MESH_DEPS } from '../../../client/src/modules/town/craftMesh/configVersion.js';
import { bakeCraftGlb, depsRegistry, CRAFT_GLB_FORMAT } from './bake.js';

/**
 * U6b: ПЕЧЬ GLB — тот же построитель, что у веба, в node. Сторожа контракта файла (docs/CRAFT_WEAPONS.md §21.1): GLB грузится,
 * геометрия есть, корень `craftWeapon` с четырьмя гнёздами, рукоять в начале координат, рабочий конец в −Y, материалы названы
 * `семья:ступень`; и печь читает ТОЛЬКО таблицы модели — иначе ключ кэша по их ревизии не увидел бы правку.
 */
const reg = new ConfigRegistry();
reg.loadAll();
const CLASSES = reg.get('weapon-anatomy').map((a) => a.id);
const baseOf = (cls: string, hands: number) =>
  reg.get('items.base').find((b) => b.kind === 'weapon' && b.weaponClass === cls && (b.hands ?? 1) === hands);

/** Печь видит ровно таблицы модели — как в потоке (`worker.ts`). */
const bakeReg = depsRegistry(Object.fromEntries(CRAFT_MESH_DEPS.map((k) => [k, reg.get(k)])));

async function load(glb: Uint8Array): Promise<{ scene: THREE.Group; json: Record<string, unknown> }> {
  const ab = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer;
  const len = new DataView(ab).getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, 20, len))) as Record<string, unknown>;
  const gltf = await new GLTFLoader().parseAsync(ab, '');
  return { scene: gltf.scene, json };
}

const MAT_NAME = /^(?:[a-z]+:[1-5](?::glow=[0-9a-f]{6})?|fixed:[0-9a-f]{6})$/;

describe('печь GLB модели из деталей', () => {
  it('⭐ каждое семейство всех классов: GLB грузится, вершины есть, материалы названы, гнёзда на месте', async () => {
    let n = 0;
    for (const cls of CLASSES) for (const hands of familiesOf(reg, cls)) {
      const parts = defaultParts(reg, cls, hands, 3)!;
      const look = weaponLookSig({ baseId: baseOf(cls, hands)?.id ?? '', parts });
      const glb = await bakeCraftGlb(bakeReg, cls, hands, parts, { look, rev: 'r-test' });
      expect(glb, `${cls}/${hands}`).toBeTruthy();
      expect(String.fromCharCode(...glb!.slice(0, 4)), 'магия GLB').toBe('glTF');
      const { scene, json } = await load(glb!);
      let verts = 0;
      const mats = new Set<string>();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        verts += m.geometry.getAttribute('position').count;
        for (const mm of [m.material].flat()) mats.add(mm.name);
      });
      expect(verts, `${cls}/${hands}: вершины`).toBeGreaterThan(100);
      expect([...mats].filter((x) => !MAT_NAME.test(x)), `${cls}/${hands}: имена материалов`).toEqual([]);
      const root = scene.getObjectByName('craftWeapon')!;
      expect(root, 'корень craftWeapon').toBeTruthy();
      expect(root.children.map((c) => c.name).sort()).toEqual(['bind', 'grip', 'head', 'strike']);
      const nodes = json.nodes as { name?: string; extras?: Record<string, unknown> }[];
      expect(nodes.find((x) => x.name === 'craftWeapon')?.extras).toEqual({
        dmCraftMesh: { v: CRAFT_GLB_FORMAT, units: 'cm', grip: 'origin', workingEnd: '-Y', look, rev: 'r-test' },
      });
      n++;
    }
    expect(n, 'все 15 семейств').toBe(15);
  });

  it('контракт осей в файле: рукоять у начала координат, рабочий конец — в −Y, единицы — сантиметры', async () => {
    const parts = defaultParts(reg, 'sword', 2, 3)!;
    const { scene } = await load((await bakeCraftGlb(bakeReg, 'sword', 2, parts, { look: 'x', rev: 'r' }))!);
    scene.updateWorldMatrix(true, true);
    const box = (name: string) => new THREE.Box3().setFromObject(scene.getObjectByName(name)!);
    const grip = box('grip'), strike = box('strike');
    expect(grip.clone().expandByScalar(5).containsPoint(new THREE.Vector3()), 'хват у начала координат').toBe(true);
    expect((strike.min.y + strike.max.y) / 2, 'клинок ниже рукояти').toBeLessThan((grip.min.y + grip.max.y) / 2 - 1);
    const len = new THREE.Box3().setFromObject(scene).getSize(new THREE.Vector3()).y;
    expect(len, 'двуручный меч — сантиметры (не метры и не юниты игры)').toBeGreaterThan(90);
    expect(len).toBeLessThan(200);
  });

  it('свечение навершия — в имени материала (Unity ставит свой материал, цвет стихии не теряется)', async () => {
    // 06.10: навершие посоха и жезла — Прибор (снятый «Фокус» светился сам), свечение стихии — на материале навершия любой семьи.
    const hands = familiesOf(reg, 'staff')[0]!;
    const { scene } = await load((await bakeCraftGlb(bakeReg, 'staff', hands, defaultParts(reg, 'staff', hands, 3)!, { look: 'x', rev: 'r' }))!);
    const names = new Set<string>();
    scene.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) names.add((m.material as THREE.Material).name); });
    expect([...names].some((x) => /^trim:[1-5]:glow=[0-9a-f]{6}$/.test(x)), [...names].join(', ')).toBe(true);
    expect([...names].some((x) => /^(focus|stave):/.test(x)), 'снятых семей в материалах нет').toBe(false);
  });

  it('⚠ печь читает только таблицы модели (CRAFT_MESH_DEPS): иначе правка чужой таблицы не сменила бы ключ кэша', async () => {
    // Реестр печи бросает на любой таблице вне списка — значит, ВСЕ варианты гнезда собираются на нём без сбоя.
    for (const cls of CLASSES) for (const hands of familiesOf(reg, cls)) {
      for (const step of [1, 5]) {
        const parts = defaultParts(reg, cls, hands, step)!;
        await expect(bakeCraftGlb(bakeReg, cls, hands, parts, { look: 'x', rev: 'r' }), `${cls}/${hands}@${step}`).resolves.toBeTruthy();
      }
    }
    expect(() => bakeReg.get('monsters')).toThrow(/не загружен/);
  });

  it('⭐ ступень ВНЕ окна материалов (вещь старше правки окна) печётся: путь отказа `resolveParts` тоже читает только таблицы модели', async () => {
    // Живой стенд: ось с обвязкой «Две пары» на ступени 1 (окно 2–5) отвечала 422 — подпись отказа `resolveParts` (`stepLabel`) читает
    // `craft-materials`, а её не было в CRAFT_MESH_DEPS: строгий реестр печи бросал. Сырые ступени 1 и 5 во ВСЕХ гнёздах, без зажима в окно.
    let outside = 0;
    for (const cls of CLASSES) for (const hands of familiesOf(reg, cls)) {
      for (const step of [1, 5]) {
        const parts = defaultParts(reg, cls, hands, 3)!;
        for (const slot of ['strike', 'grip', 'bind', 'head'] as const) parts[slot] = { ...parts[slot], step };
        const p = reg.get('weapon-parts');
        if ((['strike', 'grip', 'bind', 'head'] as const).some((s) => { const x = p.find((q) => q.id === parts[s].id)!; return step < x.stepMin || step > x.stepMax; })) outside++;
        await expect(bakeCraftGlb(bakeReg, cls, hands, parts, { look: 'x', rev: 'r' }), `${cls}/${hands}@${step}`).resolves.toBeTruthy();
      }
    }
    expect(outside, 'прогон действительно ходил мимо окна').toBeGreaterThan(5);
  });

  it('несобираемое — null или бросок построителя, а не пустой файл', async () => {
    const parts = defaultParts(reg, 'sword', 1, 3)!;
    parts.strike = { id: 'no-such-part', step: 3 };
    await expect(bakeCraftGlb(bakeReg, 'sword', 1, parts, { look: 'x', rev: 'r' })).resolves.toBeNull();
    await expect(bakeCraftGlb(bakeReg, 'no-such-class', 1, defaultParts(reg, 'sword', 1, 3)!, { look: 'x', rev: 'r' })).resolves.toBeNull();
  });
});

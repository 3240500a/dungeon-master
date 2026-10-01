/**
 * ПРОДЮСЕР golden-эталона МАТЕРИАЛОВ для Unity-клиента (U-материалы). На каждом `npm test` перегенерирует
 * `__golden__/unity_materials.json` из ТЕКУЩЕГО кода и конфига веба. КАНОН материала — инспектор URP Lit (schemas.ts
 * `materialsSchema`/`texturesSchema`): и веб (`assetCache.buildMaterial` → three), и Unity (`UrpLit.Map` → сток URP/Lit)
 * ПЕРЕВОДЯТ одну и ту же запись конфига. Эталон фиксирует, как её прочитал веб, — Unity сверяет своё чтение
 * (`Assets/DM/Net/Tests/MaterialsCheck.cs`, меню DM ▸ Verify Materials):
 *  • `schema` — поля и значения перечислений схем: новое поле/значение веба без порта в Unity проваливает сверку;
 *  • `defaults` — запись без необязательных полей и она же после zod: умолчания порта = умолчания схемы;
 *  • `materials` — боевые материалы + синтетика на каждое значение surface/blend/cull/alphaClip/карт, с чтением веба
 *    (`web`: прозрачность, запись глубины, alphaTest, сторона, смешение, цвета, металл/шероховатость, эмиссия, AO,
 *    карты по id текстуры, масштаб нормали с флипом зелёного, тайлинг);
 *  • `textures` — боевые + синтетические текстуры и как их собрал веб (цветовое пространство, wrap, фильтры, aniso, мипы);
 *  • `env` — какие объекты биома веб берёт в тайлсет пола/стен/колонн (правило `objSpecs` из online3d.ts) на боевых
 *    объектах + приманках (выключенный, россыпь пола, чужой биом, без модели, без материала, prop/decor).
 * Скопировать в Unity: `python tools/unity-check/golden_sync.py` (репо Unity) → Assets/DM/Net/Tests/unity_materials_golden.json.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as THREE from 'three';
import { z } from 'zod';
import { ConfigRegistry, materialsSchema, objectsSchema, texturesSchema } from '@dm/shared';
import { buildMaterial, clearAssetCache, getTexture, type MaterialCfg, type TextureCfg } from './assetCache.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// TextureLoader в node: three берёт <img> у document. Заглушка без загрузки — эталону нужны настройки текстуры, не пиксели.
const g = globalThis as { document?: unknown };
let hadDocument = false;
beforeAll(() => {
  hadDocument = 'document' in g;
  if (!hadDocument) g.document = { createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, src: '' }) };
});
afterAll(() => { if (!hadDocument) delete g.document; clearAssetCache(); });

const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();

/** Поля и значения перечислений схемы-массива (z.array(z.object)) — сквозь default/optional. */
function schemaOf(arr: z.ZodArray<z.ZodObject<z.ZodRawShape>>): { fields: string[]; enums: Record<string, string[]> } {
  const shape = arr.element.shape;
  const enums: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(shape)) {
    let t: z.ZodTypeAny = v as z.ZodTypeAny;
    for (;;) {
      if (t instanceof z.ZodDefault) t = t.removeDefault();
      else if (t instanceof z.ZodOptional) t = t.unwrap();
      else break;
    }
    if (t instanceof z.ZodEnum) enums[k] = [...(t.options as string[])];
  }
  return { fields: Object.keys(shape), enums };
}

const tex = (o: Record<string, unknown>): TextureCfg => texturesSchema.element.parse(o) as TextureCfg;
const mat = (o: Record<string, unknown>): MaterialCfg => materialsSchema.element.parse(o) as MaterialCfg;

/** Синтетические текстуры: каждое значение type/wrapMode/filterMode, aniso 0 и 8, без мипов, флип зелёного. */
const SYN_TEX: TextureCfg[] = [
  tex({ id: 't_albedo', url: '/assets/t/albedo.png' }),
  tex({ id: 't_normal_flip', url: '/assets/t/n_flip.png', type: 'normalMap', sRGB: false, flipGreenChannel: true, wrapMode: 'clamp', filterMode: 'trilinear', aniso: 8 }),
  tex({ id: 't_normal', url: '/assets/t/n.png', type: 'normalMap', sRGB: false, filterMode: 'point', aniso: 0, mipmaps: false }),
  tex({ id: 't_mask', url: '/assets/t/mask.png', sRGB: false, wrapMode: 'clamp', filterMode: 'trilinear', mipmaps: false, compression: 'high' }),
  tex({ id: 't_emis', url: '/assets/t/emis.png', filterMode: 'point', compression: 'none' }),
  // Нормалмап с галкой sRGB: импортёр Unity её для нормалмапа не показывает и грузит linear — веб читает как есть (sRGB).
  tex({ id: 't_normal_srgb', url: '/assets/t/n_srgb.png', type: 'normalMap', sRGB: true }),
];

/** Синтетические материалы: умолчания, полный непрозрачный, вырез, каждое смешение прозрачного, отсутствующие текстуры… */
const SYN_MAT: MaterialCfg[] = [
  mat({ id: 'm_default' }),
  mat({
    id: 'm_full_opaque', baseMap: 't_albedo', baseColor: [0.5, 0.6, 0.7, 1], maskMap: 't_mask', metallic: 0.7, smoothness: 0.9,
    occlusionMap: 't_mask', occlusionStrength: 0.6, bumpMap: 't_normal_flip', bumpScale: 0.8,
    emissionMap: 't_emis', emissionColor: [1, 0.5, 0.25], emissionIntensity: 2, tiling: [2, 3], offset: [0.25, 0.5],
  }),
  mat({ id: 'm_clip', alphaClip: true, cutoff: 0.3, cull: 'off', baseMap: 't_albedo' }),
  mat({ id: 'm_clip_zero', alphaClip: true, cutoff: 0 }),
  mat({ id: 'm_trans_alpha', surface: 'transparent', blend: 'alpha', baseColor: [1, 1, 1, 0.5], cull: 'front' }),
  mat({ id: 'm_trans_premul', surface: 'transparent', blend: 'premultiply', baseColor: [0.2, 0.3, 0.4, 0.6], baseMap: 't_albedo' }),
  mat({ id: 'm_trans_add', surface: 'transparent', blend: 'additive', emissionColor: [0.1, 0.2, 0.3] }),
  mat({ id: 'm_trans_mul_clip', surface: 'transparent', blend: 'multiply', alphaClip: true, cutoff: 0.7 }),
  mat({ id: 'm_opaque_blend_ignored', surface: 'opaque', blend: 'additive' }),
  mat({ id: 'm_missing_tex', baseMap: 'нет-такой', bumpMap: 'нет-такой-n', maskMap: 'нет-маски' }),
  mat({ id: 'm_normal_noflip_neg', bumpMap: 't_normal', bumpScale: -1, tiling: [4, 4] }),
  mat({ id: 'm_black_emission_map', emissionMap: 't_emis', emissionColor: [0, 0, 0], emissionIntensity: 5 }),
  mat({ id: 'm_mask_only', maskMap: 't_mask', smoothness: 0.25 }),
  mat({ id: 'm_ao_only', occlusionMap: 't_mask', occlusionStrength: 0.4, offset: [0.5, 0] }),
];

const SIDE: Record<number, string> = { [THREE.FrontSide]: 'front', [THREE.BackSide]: 'back', [THREE.DoubleSide]: 'double' };
const BLEND: Record<number, string> = {
  [THREE.NoBlending]: 'none', [THREE.NormalBlending]: 'normal', [THREE.AdditiveBlending]: 'additive',
  [THREE.SubtractiveBlending]: 'subtractive', [THREE.MultiplyBlending]: 'multiply', [THREE.CustomBlending]: 'custom',
};
const FILTER: Record<number, string> = {
  [THREE.NearestFilter]: 'nearest', [THREE.LinearFilter]: 'linear',
  [THREE.NearestMipmapNearestFilter]: 'nearestMipNearest', [THREE.NearestMipmapLinearFilter]: 'nearestMipLinear',
  [THREE.LinearMipmapNearestFilter]: 'linearMipNearest', [THREE.LinearMipmapLinearFilter]: 'linearMipLinear',
};
const WRAP: Record<number, string> = { [THREE.RepeatWrapping]: 'repeat', [THREE.ClampToEdgeWrapping]: 'clamp', [THREE.MirroredRepeatWrapping]: 'mirror' };
const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;

describe('unityMaterialsGolden — продюсер эталона (пишет __golden__/unity_materials.json)', () => {
  it('генерит эталон чтения материалов/текстур веба и правила тайлсета биома и пишет на диск', () => {
    clearAssetCache();
    const textures: TextureCfg[] = [...(reg.get('textures') as TextureCfg[]), ...SYN_TEX];
    const materials: MaterialCfg[] = [...(reg.get('materials') as MaterialCfg[]), ...SYN_MAT];
    const cfg = { materials, textures };

    // Текстура веба → id конфига: клон под тайлинг делит source с базовой, поэтому опознаём по source.
    const bySource = new Map<unknown, string>();
    const texReading: Record<string, unknown> = {};
    for (const t of textures) {
      const w = getTexture(textures, t.id)!;
      bySource.set(w.source, t.id);
      texReading[t.id] = {
        linear: w.colorSpace === THREE.LinearSRGBColorSpace, wrapS: WRAP[w.wrapS], wrapT: WRAP[w.wrapT],
        magFilter: FILTER[w.magFilter], minFilter: FILTER[w.minFilter], anisotropy: w.anisotropy, mipmaps: w.generateMipmaps,
      };
    }
    const idOf = (t: THREE.Texture | null): string | null => (t ? bySource.get(t.source) ?? '?' : null);

    const matCases = materials.map((m) => {
      const w = buildMaterial(cfg, m.id) as THREE.MeshStandardMaterial;
      const maps = {
        map: idOf(w.map), normalMap: idOf(w.normalMap), metalnessMap: idOf(w.metalnessMap), roughnessMap: idOf(w.roughnessMap),
        aoMap: idOf(w.aoMap), emissiveMap: idOf(w.emissiveMap),
      };
      const first = [w.map, w.normalMap, w.metalnessMap, w.aoMap, w.emissiveMap].find((t) => t) ?? null;
      const web = {
        transparent: w.transparent, depthWrite: w.depthWrite, alphaTest: r6(w.alphaTest), side: SIDE[w.side], blending: BLEND[w.blending],
        premultipliedAlpha: w.premultipliedAlpha,
        color: [r6(w.color.r), r6(w.color.g), r6(w.color.b)], opacity: r6(w.opacity),
        metalness: r6(w.metalness), roughness: r6(w.roughness),
        emissive: [r6(w.emissive.r), r6(w.emissive.g), r6(w.emissive.b)], emissiveIntensity: r6(w.emissiveIntensity),
        aoMapIntensity: r6(w.aoMapIntensity), maps,
        normalScale: w.normalMap ? [r6(w.normalScale.x), r6(w.normalScale.y)] as [number, number] : null,
        st: first ? [r6(first.repeat.x), r6(first.repeat.y), r6(first.offset.x), r6(first.offset.y)] : null,
      };
      w.dispose();
      return { cfg: m, web };
    });
    // Синтетика накрыла то, ради чего заведена.
    const webs = matCases.map((c) => c.web);
    for (const b of ['normal', 'additive', 'multiply']) expect(webs.some((x) => x.transparent && x.blending === b), `смешение ${b}`).toBe(true);
    expect(webs.some((x) => x.premultipliedAlpha)).toBe(true);
    for (const s of ['front', 'back', 'double']) expect(webs.some((x) => x.side === s), `сторона ${s}`).toBe(true);
    expect(webs.some((x) => x.normalScale && x.normalScale[1] === -x.normalScale[0] && x.normalScale[0] !== 0), 'флип зелёного').toBe(true);
    expect(webs.some((x) => x.maps.map === null && matCases.find((c) => c.web === x)!.cfg.baseMap), 'нет текстуры в конфиге → без карты').toBe(true);
    for (const f of ['nearest', 'linearMipNearest', 'linearMipLinear', 'linear']) expect(Object.values(texReading).some((t) => (t as { minFilter: string }).minFilter === f), `фильтр ${f}`).toBe(true);

    // ── Тайлсет биома: правило objSpecs из online3d.ts (базовый пол без россыпи, стены, колонны; модель обязана быть) ──
    type Obj = z.infer<typeof objectsSchema>[number];
    const obj = (o: Record<string, unknown>): Obj => objectsSchema.element.parse(o);
    const decoys: Obj[] = [
      obj({ id: 'dec_wall_off', enabled: false, role: 'wall', biomes: ['crypt'], modelId: 'crypt_wall_base_01', materialId: 'crypt_floor_base_01' }),
      obj({ id: 'dec_floor_scatter', role: 'floor', biomes: ['caves'], modelId: 'crypt_floor_grille_01', materialId: 'crypt_floor_grille_01', footprint: { w: 2, h: 2 } }),
      obj({ id: 'dec_floor_caves_nomat', role: 'floor', biomes: ['caves'], modelId: 'crypt_floor_base_01', materialId: '' }),
      obj({ id: 'dec_floor_caves', role: 'floor', biomes: ['caves', 'dungeon'], modelId: 'crypt_floor_base_01', materialId: 'crypt_wall_base_01' }),
      obj({ id: 'dec_wall_nomodel', role: 'wall', biomes: ['caves'], modelId: 'нет-модели', materialId: 'crypt_column_01' }),
      obj({ id: 'dec_wall_caves', role: 'wall', biomes: ['caves'], modelId: 'crypt_wall_base_01', materialId: 'crypt_column_01' }),
      obj({ id: 'dec_floor_tall', role: 'floor', biomes: ['dungeon'], modelId: 'crypt_floor_base_01', materialId: 'crypt_floor_grille_01', footprint: { w: 1, h: 3 } }),
      obj({ id: 'dec_pillar_lab', role: 'pillar', biomes: ['labyrinth'], modelId: 'crypt_column_01', materialId: 'crypt_column_01' }),
      obj({ id: 'dec_prop', role: 'prop', biomes: ['crypt'], modelId: 'crypt_column_01', materialId: 'crypt_column_01' }),
      obj({ id: 'dec_decor', role: 'decor', biomes: ['crypt'], modelId: 'crypt_column_01', materialId: 'crypt_column_01' }),
      obj({ id: 'dec_no_biome', role: 'wall', biomes: [], modelId: 'crypt_wall_base_01', materialId: 'crypt_floor_base_01' }),
    ];
    const objects: Obj[] = [decoys[0]!, ...reg.get('objects'), ...decoys.slice(1)];
    const models = reg.get('models').map((m) => ({ id: m.id, url: m.url }));
    const biomes = [...reg.get('biomes').map((b) => b.id), 'nowhere'];
    const modelUrl = (id: string): string => models.find((m) => m.id === id)?.url ?? '';
    const isScatterFloor = (o: Obj): boolean => o.role === 'floor' && !!o.footprint && (o.footprint.w > 1 || o.footprint.h > 1);
    const objSpecs = (biomeId: string, role: string): { objectId: string; materialId: string }[] => objects
      .filter((o) => o.enabled && o.role === role && o.biomes.includes(biomeId) && !(role === 'floor' && isScatterFloor(o)))
      .map((o) => ({ objectId: o.id, url: modelUrl(o.modelId), materialId: o.materialId }))
      .filter((s) => s.url)
      .map(({ objectId, materialId }) => ({ objectId, materialId }));
    const expectEnv: Record<string, unknown> = {};
    for (const b of biomes) {
      const floor = objSpecs(b, 'floor'), wall = objSpecs(b, 'wall'), pillar = objSpecs(b, 'pillar');
      expectEnv[b] = { floor, wall, pillar, kit: floor.length > 0 || wall.length > 0 };   // нет ни пола, ни стен — веб остаётся на боксах
    }
    expect((expectEnv.crypt as { kit: boolean }).kit, 'у склепа есть тайлсет').toBe(true);
    expect((expectEnv.labyrinth as { kit: boolean; pillar: unknown[] }).pillar.length > 0 && !(expectEnv.labyrinth as { kit: boolean }).kit, 'колонны без пола и стен — боксы').toBe(true);

    const golden = {
      note: 'Эталон паритета Unity ↔ веб для материалов (U-материалы): чтение канона URP Lit вебом и тайлсет биома. Генерит packages/client/src/render3d/unityMaterialsGolden.gen.test.ts.',
      schema: {
        textures: schemaOf(texturesSchema as unknown as z.ZodArray<z.ZodObject<z.ZodRawShape>>),
        materials: schemaOf(materialsSchema as unknown as z.ZodArray<z.ZodObject<z.ZodRawShape>>),
      },
      // Умолчания схемы: запись без необязательных полей (raw) и она же после zod (parsed) — порт обязан прочитать их одинаково.
      defaults: {
        texture: { raw: { id: 'd_tex', url: '/assets/d.png' }, parsed: tex({ id: 'd_tex', url: '/assets/d.png' }) },
        material: { raw: { id: 'd_mat' }, parsed: mat({ id: 'd_mat' }) },
      },
      textures: textures.map((t) => ({ cfg: t, web: texReading[t.id] })),
      materials: matCases,
      env: { objects, models, biomes, expect: expectEnv },
    };
    const dir = join(HERE, '__golden__');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'unity_materials.json'), JSON.stringify(golden));
  });
});

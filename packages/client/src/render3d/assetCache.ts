/**
 * КЭШ 3D-АССЕТОВ (текстуры/материалы). КАНОН — **Unity URP Lit**: config-секции `textures`/`materials` описывают
 * материал ровно как инспектор URP (см. schemas.ts), а ЗДЕСЬ он ПЕРЕВОДИТСЯ в three.js — веб является ведомым
 * клиентом, Unity ставит те же поля на сток `Universal Render Pipeline/Lit`.
 *
 * Ключевые расхождения three ↔ URP, которые тут закрываются:
 *  • МАСКА (`maskMap`) в URP = **R:metallic, G:AO, A:smoothness**, а three читает metalness из `.b`, roughness из
 *    `.g`, ao из `.r` → подменяем каналы патчем шейдер-чанков (`applyUrpMask`).
 *  • `_Smoothness` при наличии маски — МНОЖИТЕЛЬ канала A (а не самостоятельное значение).
 *  • Тайлинг в URP пер-МАТЕРИАЛЬНЫЙ (`_BaseMap_ST`), в three живёт на ТЕКСТУРЕ → при tiling/offset ≠ identity
 *    отдаём клон текстуры (клон делит `source`, лишней GPU-загрузки нет).
 *  • «Flip Green Channel» — настройка ТЕКСТУРЫ (как в Unity), в three реализуется как `normalScale.y = −y`.
 *
 * Объекты переиспользуются (общий `Map` по id): один материал/текстура на все меши. `clearAssetCache()` — на
 * `config:reloaded` (правка материала в редакторе → пересборка).
 */
import * as THREE from 'three';

// Структурные типы = форма config-секций (schemas.ts texturesSchema/materialsSchema). Не тянем @dm/shared в рантайм.
export interface TextureCfg {
  id: string; url: string;
  type: 'default' | 'normalMap'; sRGB: boolean; flipGreenChannel: boolean;
  wrapMode: 'repeat' | 'clamp'; filterMode: 'point' | 'bilinear' | 'trilinear';
  aniso: number; mipmaps: boolean; compression: 'none' | 'normal' | 'high';
}
export interface MaterialCfg {
  id: string;
  surface: 'opaque' | 'transparent'; blend: 'alpha' | 'premultiply' | 'additive' | 'multiply';
  alphaClip: boolean; cutoff: number; cull: 'back' | 'front' | 'off';
  baseMap?: string; baseColor: [number, number, number, number];
  maskMap?: string; metallic: number; smoothness: number;
  occlusionMap?: string; occlusionStrength: number;
  bumpMap?: string; bumpScale: number;
  emissionMap?: string; emissionColor: [number, number, number]; emissionIntensity: number;
  tiling: [number, number]; offset: [number, number];
}

const textureCache = new Map<string, THREE.Texture>();
const materialCache = new Map<string, THREE.Material>();
const loader = new THREE.TextureLoader();

const MAG = { point: THREE.NearestFilter, bilinear: THREE.LinearFilter, trilinear: THREE.LinearFilter } as const;
const MIN_MIP = { point: THREE.NearestMipmapNearestFilter, bilinear: THREE.LinearMipmapNearestFilter, trilinear: THREE.LinearMipmapLinearFilter } as const;

/** Собрать текстуру из config-записи (настройки импорта Unity → сэмплер three). */
function buildTexture(c: TextureCfg): THREE.Texture {
  const tex = loader.load(c.url);
  tex.colorSpace = c.sRGB ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
  tex.flipY = false;                                      // glTF-конвенция (Unity флипает UV меша; у нас модели — GLB)
  const w = c.wrapMode === 'repeat' ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.wrapS = w; tex.wrapT = w;
  tex.generateMipmaps = c.mipmaps;
  tex.magFilter = MAG[c.filterMode] ?? THREE.LinearFilter;
  tex.minFilter = c.mipmaps ? (MIN_MIP[c.filterMode] ?? THREE.LinearMipmapLinearFilter) : (MAG[c.filterMode] ?? THREE.LinearFilter);
  tex.anisotropy = Math.max(1, Math.trunc(c.aniso) || 1);
  return tex;
}

const IDENTITY_ST = (st?: [number, number, number, number]): boolean => !st || (st[0] === 1 && st[1] === 1 && st[2] === 0 && st[3] === 0);

/** Текстура по id + (опц.) UV-трансформация материала `[tileX, tileY, offX, offY]` (URP `_BaseMap_ST`).
 *  ST ≠ identity → КЛОН (в three repeat/offset живут на текстуре, в URP — на материале). null — нет в конфиге. */
export function getTexture(textures: TextureCfg[], id: string, st?: [number, number, number, number]): THREE.Texture | null {
  const c = textures.find((t) => t.id === id); if (!c) return null;
  let base = textureCache.get(id);
  if (!base) { base = buildTexture(c); textureCache.set(id, base); }
  if (IDENTITY_ST(st)) return base;
  const key = `${id}|st:${st!.join(',')}`;
  const hit = textureCache.get(key); if (hit) return hit;
  const t = base.clone();                                  // делит source → без повторной загрузки
  t.repeat.set(st![0], st![1]); t.offset.set(st![2], st![3]); t.needsUpdate = true;
  textureCache.set(key, t);
  return t;
}

/** Подмена каналов под раскладку URP: metallic ← `.r`, roughness ← `1 − .a × smoothness`, AO ← `.g`
 *  (three по умолчанию читает `.b` / `.g` / `.r`). Цепляется к существующему `onBeforeCompile` (напр. фейд стен).
 *  ⚠ `customProgramCacheKey` обязателен: three кэширует программы и без него материал с маской может получить
 *  НЕпатченную программу от материала без маски. */
export function applyUrpMask(mat: THREE.Material, hasMask: boolean, hasAo: boolean, smoothness: number): void {
  if (!hasMask && !hasAo) return;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer): void => {
    prev?.(shader, renderer);
    let fs = shader.fragmentShader;
    if (hasMask) {
      fs = 'uniform float uSmoothness;\n' + fs
        .replace('#include <metalnessmap_fragment>',
          'float metalnessFactor = metalness;\n#ifdef USE_METALNESSMAP\n\tmetalnessFactor = texture2D( metalnessMap, vMetalnessMapUv ).r;\n#endif')
        .replace('#include <roughnessmap_fragment>',
          'float roughnessFactor = roughness;\n#ifdef USE_ROUGHNESSMAP\n\troughnessFactor = clamp( 1.0 - texture2D( roughnessMap, vRoughnessMapUv ).a * uSmoothness, 0.0, 1.0 );\n#endif');
      shader.uniforms.uSmoothness = { value: smoothness };
    }
    if (hasAo) fs = fs.replace('texture2D( aoMap, vAoMapUv ).r', 'texture2D( aoMap, vAoMapUv ).g');
    shader.fragmentShader = fs;
  };
  mat.customProgramCacheKey = (): string => `urp:${hasMask ? 1 : 0}${hasAo ? 1 : 0}`;
  mat.needsUpdate = true;
}

/** Собрать НОВЫЙ материал из config-описания, БЕЗ кэша (текстуры при этом кэшируются как обычно).
 *  Используется `getMaterial` и превью-сферой редактора — чтобы у редактора и игры был ОДИН перевод URP → three. */
export function buildMaterial(cfg: { materials: MaterialCfg[]; textures: TextureCfg[] }, id: string): THREE.Material | null {
  const m = cfg.materials.find((x) => x.id === id); if (!m) return null;
  const st: [number, number, number, number] = [m.tiling[0], m.tiling[1], m.offset[0], m.offset[1]];
  const tex = (tid?: string): THREE.Texture | null => (tid ? getTexture(cfg.textures, tid, st) : null);
  const transparent = m.surface === 'transparent';
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(m.baseColor[0], m.baseColor[1], m.baseColor[2]),
    opacity: m.baseColor[3],
    transparent,
    depthWrite: !transparent,                              // URP у прозрачных ставит ZWrite 0
    alphaTest: m.alphaClip ? m.cutoff : 0,
    side: m.cull === 'off' ? THREE.DoubleSide : m.cull === 'front' ? THREE.BackSide : THREE.FrontSide,
    metalness: m.metallic,
    roughness: 1 - m.smoothness,                           // URP авторит гладкость, three — шероховатость
    emissive: new THREE.Color(m.emissionColor[0], m.emissionColor[1], m.emissionColor[2]),
    emissiveIntensity: m.emissionIntensity,
    aoMapIntensity: m.occlusionStrength,
  });
  if (transparent) {
    if (m.blend === 'additive') mat.blending = THREE.AdditiveBlending;
    else if (m.blend === 'multiply') mat.blending = THREE.MultiplyBlending;
    else if (m.blend === 'premultiply') mat.premultipliedAlpha = true;
  }
  if (m.baseMap) mat.map = tex(m.baseMap);
  if (m.bumpMap) {
    mat.normalMap = tex(m.bumpMap);
    const flip = cfg.textures.find((t) => t.id === m.bumpMap)?.flipGreenChannel;   // Unity «Flip Green Channel»
    mat.normalScale.set(m.bumpScale, flip ? -m.bumpScale : m.bumpScale);
  }
  if (m.maskMap) { const t = tex(m.maskMap); mat.metalnessMap = t; mat.roughnessMap = t; }   // каналы правит applyUrpMask
  if (m.occlusionMap) mat.aoMap = tex(m.occlusionMap);
  if (m.emissionMap) mat.emissiveMap = tex(m.emissionMap);
  applyUrpMask(mat, !!m.maskMap, !!m.occlusionMap, m.smoothness);
  return mat;
}

/** Материал по id — из кэша или строится. ПЕРЕИСПОЛЬЗУЕМЫЙ (один инстанс на все меши). */
export function getMaterial(cfg: { materials: MaterialCfg[]; textures: TextureCfg[] }, id: string): THREE.Material | null {
  const hit = materialCache.get(id); if (hit) return hit;
  const mat = buildMaterial(cfg, id); if (!mat) return null;
  materialCache.set(id, mat);
  return mat;
}

/** Сбросить кэш (на config:reloaded — правка материала/текстуры пересоберёт). Dispose раздельно (текстура ≠ материал). */
export function clearAssetCache(): void {
  for (const m of materialCache.values()) m.dispose();
  for (const t of textureCache.values()) t.dispose();
  materialCache.clear(); textureCache.clear();
}

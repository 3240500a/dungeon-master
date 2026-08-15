/**
 * КЭШ 3D-АССЕТОВ (текстуры/материалы) — строит THREE-объекты из config-секций `textures`/`materials` и
 * ПЕРЕИСПОЛЬЗУЕТ их (общий `Map` по id): один материал/текстура на все меши (экономия памяти/драв-коллов, как
 * рекомендует three). Материал (metallic-roughness, glTF-модель) ссылается на текстуры по id → тоже из кэша.
 * `clearAssetCache()` зовётся на `config:reloaded` (правка материала в редакторе → пересборка).
 */
import * as THREE from 'three';

// Структурные типы = форма config-секций (schemas.ts texturesSchema/materialsSchema). Не тянем @dm/shared в рантайм.
export interface TextureCfg { id: string; url: string; colorSpace: 'srgb' | 'linear'; wrapS: 'repeat' | 'clamp'; wrapT: 'repeat' | 'clamp'; flipY: boolean }
export interface MaterialCfg {
  id: string; baseColor: [number, number, number]; opacity: number; metalness: number; roughness: number;
  emissive: [number, number, number]; emissiveIntensity: number; normalScale: number; normalFlipY?: boolean;
  map?: string; normalMap?: string; roughnessMap?: string; metalnessMap?: string; emissiveMap?: string; aoMap?: string;
}

const textureCache = new Map<string, THREE.Texture>();
const materialCache = new Map<string, THREE.Material>();
const loader = new THREE.TextureLoader();

/** Текстура по id (из config) — из кэша или грузится (TextureLoader по url + colorSpace/wrap/flipY). null — нет в конфиге. */
export function getTexture(textures: TextureCfg[], id: string): THREE.Texture | null {
  const hit = textureCache.get(id); if (hit) return hit;
  const c = textures.find((t) => t.id === id); if (!c) return null;
  const tex = loader.load(c.url);
  tex.colorSpace = c.colorSpace === 'srgb' ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
  tex.wrapS = c.wrapS === 'repeat' ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.wrapT = c.wrapT === 'repeat' ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.flipY = c.flipY;
  textureCache.set(id, tex);
  return tex;
}

/** Материал по id — из кэша или строится (MeshStandardMaterial из config-материала + map-ссылки). ПЕРЕИСПОЛЬЗУЕМЫЙ. */
export function getMaterial(cfg: { materials: MaterialCfg[]; textures: TextureCfg[] }, id: string): THREE.Material | null {
  const hit = materialCache.get(id); if (hit) return hit;
  const m = cfg.materials.find((x) => x.id === id); if (!m) return null;
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(m.baseColor[0], m.baseColor[1], m.baseColor[2]),
    opacity: m.opacity, transparent: m.opacity < 0.999,
    metalness: m.metalness, roughness: m.roughness,
    emissive: new THREE.Color(m.emissive[0], m.emissive[1], m.emissive[2]), emissiveIntensity: m.emissiveIntensity,
  });
  const tex = (tid?: string): THREE.Texture | null => (tid ? getTexture(cfg.textures, tid) : null);
  if (m.map) mat.map = tex(m.map);
  if (m.normalMap) { mat.normalMap = tex(m.normalMap); mat.normalScale.set(m.normalScale, m.normalFlipY ? -m.normalScale : m.normalScale); }   // flip Y = зелёный DirectX(3ds Max)→OpenGL
  if (m.roughnessMap) mat.roughnessMap = tex(m.roughnessMap);
  if (m.metalnessMap) mat.metalnessMap = tex(m.metalnessMap);
  if (m.emissiveMap) mat.emissiveMap = tex(m.emissiveMap);
  if (m.aoMap) mat.aoMap = tex(m.aoMap);
  materialCache.set(id, mat);
  return mat;
}

/** Сбросить кэш (на config:reloaded — правка материала/текстуры пересоберёт). Dispose раздельно (текстура ≠ материал). */
export function clearAssetCache(): void {
  for (const m of materialCache.values()) m.dispose();
  for (const t of textureCache.values()) t.dispose();
  materialCache.clear(); textureCache.clear();
}

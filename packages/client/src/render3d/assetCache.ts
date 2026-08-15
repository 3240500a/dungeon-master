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
  emissive: [number, number, number]; emissiveIntensity: number; normalScale: number; normalFlipY?: boolean; roughnessIsSmoothness?: boolean;
  roughnessOffset?: number; metalnessOffset?: number;
  map?: string; normalMap?: string; roughnessMap?: string; metalnessMap?: string; emissiveMap?: string; aoMap?: string;
}

/** Смещение roughness/metalness ПОВЕРХ карты через шейдер: `factor = clamp(factor + offset, 0, 1)`. Ноль → не трогаем.
 *  Цепляется к существующему onBeforeCompile (напр. фейд стен), чтобы не затирать его. */
export function applyPbrOffset(mat: THREE.Material, roughOff: number, metalOff: number): void {
  if (!roughOff && !metalOff) return;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader): void => {
    prev?.(shader, undefined as never);
    shader.fragmentShader = 'uniform float uRoughOff;\nuniform float uMetalOff;\n' + shader.fragmentShader
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = clamp(roughnessFactor + uRoughOff, 0.0, 1.0);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = clamp(metalnessFactor + uMetalOff, 0.0, 1.0);');
    shader.uniforms.uRoughOff = { value: roughOff };
    shader.uniforms.uMetalOff = { value: metalOff };
  };
  mat.needsUpdate = true;
}

const textureCache = new Map<string, THREE.Texture>();
const materialCache = new Map<string, THREE.Material>();
const loader = new THREE.TextureLoader();

/** Текстура-инверсия (RGB → 1−value) через canvas — для Smoothness-карты (Unity), читаемой как Roughness (glTF). */
function loadInvertedTexture(url: string): THREE.Texture {
  const canvas = document.createElement('canvas');
  const tex = new THREE.CanvasTexture(canvas);
  const img = new Image(); img.crossOrigin = 'anonymous';
  img.onload = (): void => {
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const g = canvas.getContext('2d'); if (!g) return;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, canvas.width, canvas.height), px = d.data;
    for (let i = 0; i < px.length; i += 4) { px[i] = 255 - px[i]!; px[i + 1] = 255 - px[i + 1]!; px[i + 2] = 255 - px[i + 2]!; }
    g.putImageData(d, 0, 0); tex.needsUpdate = true;
  };
  img.src = url;
  return tex;
}

/** Текстура по id (из config) — из кэша или грузится (TextureLoader по url + colorSpace/wrap/flipY). `invert` → инверсия
 *  значения (Smoothness→Roughness). null — нет в конфиге. */
export function getTexture(textures: TextureCfg[], id: string, invert = false): THREE.Texture | null {
  const key = invert ? id + '|inv' : id;
  const hit = textureCache.get(key); if (hit) return hit;
  const c = textures.find((t) => t.id === id); if (!c) return null;
  const tex = invert ? loadInvertedTexture(c.url) : loader.load(c.url);
  tex.colorSpace = c.colorSpace === 'srgb' ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
  tex.wrapS = c.wrapS === 'repeat' ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.wrapT = c.wrapT === 'repeat' ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.flipY = c.flipY;
  textureCache.set(key, tex);
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
  if (m.roughnessMap) mat.roughnessMap = m.roughnessIsSmoothness ? getTexture(cfg.textures, m.roughnessMap, true) : tex(m.roughnessMap);   // Smoothness-карта → инверсия в Roughness
  if (m.metalnessMap) mat.metalnessMap = tex(m.metalnessMap);
  if (m.emissiveMap) mat.emissiveMap = tex(m.emissiveMap);
  if (m.aoMap) mat.aoMap = tex(m.aoMap);
  applyPbrOffset(mat, m.roughnessOffset ?? 0, m.metalnessOffset ?? 0);   // смещение roughness/metalness поверх карты
  materialCache.set(id, mat);
  return mat;
}

/** Сбросить кэш (на config:reloaded — правка материала/текстуры пересоберёт). Dispose раздельно (текстура ≠ материал). */
export function clearAssetCache(): void {
  for (const m of materialCache.values()) m.dispose();
  for (const t of textureCache.values()) t.dispose();
  materialCache.clear(); textureCache.clear();
}

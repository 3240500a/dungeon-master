import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { getMaterial, clearAssetCache, type MaterialCfg, type TextureCfg } from './assetCache.js';

// Материал в КАНОНЕ URP Lit (см. schemas.ts materialsSchema): авторится smoothness, цвет с альфой, cull/surface.
const mat = (o: Partial<MaterialCfg> = {}): MaterialCfg => ({
  id: 'm1', surface: 'opaque', blend: 'alpha', alphaClip: false, cutoff: 0.5, cull: 'back',
  baseColor: [1, 0, 0, 1], metallic: 0.3, smoothness: 0.3, occlusionStrength: 1, bumpScale: 1,
  emissionColor: [0, 0, 0], emissionIntensity: 1, tiling: [1, 1], offset: [0, 0], ...o,
});
const cfg = (materials: MaterialCfg[], textures: TextureCfg[] = []): { materials: MaterialCfg[]; textures: TextureCfg[] } => ({ materials, textures });

describe('assetCache — материалы (переиспользование)', () => {
  it('строит MeshStandardMaterial из config-материала (URP → three)', () => {
    clearAssetCache();
    const m = getMaterial(cfg([mat({ baseColor: [0.2, 0.4, 0.6, 1], metallic: 0.5, smoothness: 0.75 })]), 'm1') as THREE.MeshStandardMaterial;
    expect(m).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(m.metalness).toBeCloseTo(0.5, 4);
    expect(m.roughness).toBeCloseTo(0.25, 4);   // roughness = 1 − smoothness
    expect(m.color.r).toBeCloseTo(0.2, 3);
    expect(m.color.b).toBeCloseTo(0.6, 3);
  });

  it('surface/cull/alphaClip → transparent/side/alphaTest', () => {
    clearAssetCache();
    const o = getMaterial(cfg([mat()]), 'm1') as THREE.MeshStandardMaterial;
    expect(o.transparent).toBe(false);
    expect(o.side).toBe(THREE.FrontSide);
    expect(o.alphaTest).toBe(0);
    clearAssetCache();
    const t = getMaterial(cfg([mat({ surface: 'transparent', cull: 'off', alphaClip: true, cutoff: 0.3, baseColor: [1, 1, 1, 0.5] })]), 'm1') as THREE.MeshStandardMaterial;
    expect(t.transparent).toBe(true);
    expect(t.depthWrite).toBe(false);            // URP: ZWrite 0 у прозрачных
    expect(t.side).toBe(THREE.DoubleSide);
    expect(t.alphaTest).toBeCloseTo(0.3, 4);
    expect(t.opacity).toBeCloseTo(0.5, 4);
  });

  it('ПЕРЕИСПОЛЬЗУЕТ: тот же id → тот же инстанс (общий на все меши)', () => {
    clearAssetCache();
    const c = cfg([mat()]);
    const a = getMaterial(c, 'm1'); const b = getMaterial(c, 'm1');
    expect(a).toBe(b);   // один инстанс из кэша
  });

  it('clearAssetCache → пересборка нового инстанса', () => {
    clearAssetCache();
    const c = cfg([mat()]);
    const a = getMaterial(c, 'm1');
    clearAssetCache();
    const b = getMaterial(c, 'm1');
    expect(a).not.toBe(b);
  });

  it('нет материала в конфиге → null', () => {
    clearAssetCache();
    expect(getMaterial(cfg([mat()]), 'нет-такого')).toBeNull();
  });
});

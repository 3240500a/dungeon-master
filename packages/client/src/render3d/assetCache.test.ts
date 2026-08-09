import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { getMaterial, clearAssetCache, type MaterialCfg, type TextureCfg } from './assetCache.js';

const mat = (o: Partial<MaterialCfg> = {}): MaterialCfg => ({
  id: 'm1', baseColor: [1, 0, 0], opacity: 1, metalness: 0.3, roughness: 0.7,
  emissive: [0, 0, 0], emissiveIntensity: 1, normalScale: 1, ...o,
});
const cfg = (materials: MaterialCfg[], textures: TextureCfg[] = []): { materials: MaterialCfg[]; textures: TextureCfg[] } => ({ materials, textures });

describe('assetCache — материалы (переиспользование)', () => {
  it('строит MeshStandardMaterial из config-материала (PBR-параметры)', () => {
    clearAssetCache();
    const m = getMaterial(cfg([mat({ baseColor: [0.2, 0.4, 0.6], metalness: 0.5, roughness: 0.25 })]), 'm1') as THREE.MeshStandardMaterial;
    expect(m).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(m.metalness).toBeCloseTo(0.5, 4);
    expect(m.roughness).toBeCloseTo(0.25, 4);
    expect(m.color.r).toBeCloseTo(0.2, 3);
    expect(m.color.b).toBeCloseTo(0.6, 3);
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

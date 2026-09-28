import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { fadeMesh, fadeTree, withOpaque } from './meshAlpha.js';

/**
 * ПРОЗРАЧНОСТЬ ИМПОРТНОЙ МОДЕЛИ НЕ ИМЕЕТ ПРАВА ПОРТИТЬ ЧУЖОЙ МАТЕРИАЛ.
 *
 * `getMaterial` (assetCache) отдаёт ОДИН инстанс на `materialId`: он висит и на игровой кукле вкладки «Тест»,
 * и на превью материалов, и на других деталях. Погасив его напрямую, гасишь половину страницы — а потом
 * ещё и экспортируешь прозрачность в GLB. Отсюда все сторожа ниже.
 */
const mk = (mat?: THREE.Material): THREE.Mesh => new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat ?? new THREE.MeshStandardMaterial());

describe('гасим КЛОН, а не общий материал', () => {
  it('⭐⭐ исходный материал не тронут — он общий на пол-страницы', () => {
    const shared = new THREE.MeshStandardMaterial();
    const a = mk(shared), b = mk(shared);
    fadeMesh(a, 0.3);
    expect(shared.opacity, 'общий материал остался непрозрачным').toBe(1);
    expect(shared.transparent).toBe(false);
    expect(b.material, 'соседний меш на том же материале не изменился').toBe(shared);
    expect(a.material).not.toBe(shared);
    expect((a.material as THREE.MeshStandardMaterial).opacity).toBe(0.3);
  });

  it('⭐ возврат в 1 отдаёт мешу ТОТ ЖЕ исходный материал (иначе экспорт уедет с прозрачностью)', () => {
    const shared = new THREE.MeshStandardMaterial();
    const m = mk(shared);
    fadeMesh(m, 0.2);
    fadeMesh(m, 1);
    expect(m.material, 'ровно тот же инстанс, а не копия').toBe(shared);
  });

  it('повторная правка НЕ клонирует заново — правится только число', () => {
    const m = mk();
    fadeMesh(m, 0.5);
    const first = m.material;
    fadeMesh(m, 0.4); fadeMesh(m, 0.35);
    expect(m.material, 'тот же клон').toBe(first);
    expect((m.material as THREE.MeshStandardMaterial).opacity).toBe(0.35);
  });
});

describe('свойства гашения', () => {
  it('⚠ alphaTest снят: иначе alpha-clip меш (волосы, ремешки) ИСЧЕЗАЕТ целиком, а не бледнеет', () => {
    const src = new THREE.MeshStandardMaterial(); src.alphaTest = 0.5;
    const m = mk(src);
    fadeMesh(m, 0.3);
    expect((m.material as THREE.MeshStandardMaterial).alphaTest).toBe(0);
    expect(src.alphaTest, 'у оригинала порог на месте').toBe(0.5);
  });

  it('⚠ depthWrite снят: иначе полупрозрачный меш закроет собой то, ради чего его и гасили', () => {
    const m = mk();
    fadeMesh(m, 0.3);
    expect((m.material as THREE.MeshStandardMaterial).depthWrite).toBe(false);
    expect((m.material as THREE.MeshStandardMaterial).transparent).toBe(true);
  });

  it('порог «непрозрачно» — тот же 0.999, что у прозрачности скелета', () => {
    const src = new THREE.MeshStandardMaterial();
    const m = mk(src);
    fadeMesh(m, 0.9995);
    expect(m.material, 'почти единица — это единица: не платим за сортировку зря').toBe(src);
  });

  it('несколько материалов на меше (мультиматериал) гасятся все', () => {
    const m = mk();
    m.material = [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()];
    fadeMesh(m, 0.25);
    const cur = m.material as THREE.Material[];
    expect(cur).toHaveLength(2);
    for (const one of cur) expect((one as THREE.MeshStandardMaterial).opacity).toBe(0.25);
  });
});

describe('экспорт не должен увезти прозрачность в игру', () => {
  it('⭐⭐ на время экспорта меши отдают ОРИГИНАЛЫ, после — снова гашение', () => {
    const src = new THREE.MeshStandardMaterial();
    const root = new THREE.Group(); const m = mk(src); root.add(m);
    fadeMesh(m, 0.3);
    const back = withOpaque(root);
    expect(m.material, 'GLTFExporter увидит непрозрачный оригинал — без alphaMode:BLEND в GLB').toBe(src);
    back();
    expect((m.material as THREE.MeshStandardMaterial).opacity, 'вид редактора вернулся').toBe(0.3);
  });

  it('негашёные меши не трогаются вовсе', () => {
    const src = new THREE.MeshStandardMaterial();
    const root = new THREE.Group(); const m = mk(src); root.add(m);
    withOpaque(root)();
    expect(m.material).toBe(src);
  });

  /**
   * ⚠ Учёт живёт в WeakMap, а не в `userData`: `Object3D.copy` гоняет `userData` через JSON, и материал
   * доехал бы до копии ПЛОСКИМ объектом — возврат подсунул бы мешу бумажную копию вместо материала.
   */
  it('⚠ в userData меша материалов не остаётся (его клонируют через JSON)', () => {
    const m = mk();
    fadeMesh(m, 0.3);
    expect(JSON.stringify(m.userData), 'userData обязан переживать JSON-клон целым').toBe('{}');
  });
});

describe('обход поддерева', () => {
  it('накрывает все меши и считает их; пустой корень — ноль и никаких бросков', () => {
    const root = new THREE.Group();
    const inner = new THREE.Group(); root.add(inner);
    inner.add(mk(), mk()); root.add(mk());
    expect(fadeTree(root, 0.4)).toBe(3);
    expect(fadeTree(null, 0.4)).toBe(0);
    root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) expect((m.material as THREE.MeshStandardMaterial).opacity).toBe(0.4); });
  });
});

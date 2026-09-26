import type * as THREE from 'three';

/**
 * ⭐ R4-38: СНЯТЬ ПРЕДМЕТ ПОЛА СО СЦЕНЫ И ОСВОБОДИТЬ ЕГО БУФЕРЫ GPU — открытый сундук, открытая дверь, дёрнутый рычаг.
 *
 * У каждого такого предмета своя геометрия и свой материал (`online3d.buildArea`). Голый `group.remove` оставлял их в
 * памяти навсегда: смена области освобождает только оставшихся детей группы пола (`clearGroup`), снятого там уже нет.
 * С L1 событие `chest-opened` доходит до веб-3D — и каждый открытый сундук за сессию оставался висеть буферами.
 *
 * ⚠ Только для предметов со СВОИМИ ресурсами: общие (модели окружения из кэша) так не снимают.
 */
export function removeProp(group: THREE.Object3D, obj: THREE.Object3D): void {
  if (obj.parent !== group) return;   // уже снят — второй `dispose` не нужен
  group.remove(obj);
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose?.();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) for (const x of mat) x.dispose(); else mat?.dispose?.();
  });
}

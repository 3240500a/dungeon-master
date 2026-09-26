import * as THREE from 'three';

/**
 * ⭐ R6-12: СНАРЯДЫ И ДРОПЫ НА ЗЕМЛЕ (веб-3D) — МЕШИ БЕЗ СВОИХ БУФЕРОВ GPU.
 *
 * Раньше каждый снаряд снапшота получал свою `SphereGeometry` и свой материал, каждый дроп — свой `OctahedronGeometry` и
 * материал, а ушедший из снапшота (и все разом — на смене области и переподключении, `clearActors`) снимался с группы
 * голым `remove`. В three геометрия держит VAO и буферы GL до `dispose`: час лука, жезла или этажа стрелков — десятки
 * тысяч неосвобождённых геометрий, рост памяти GPU, на слабых видеокартах — фризы и потеря контекста (класс R4-38, но
 * на каждый выстрел). Теперь геометрия одна на вид, материал — один на цвет (цветов конечное число: владелец/тип урона
 * снаряда, вид дропа); своего у меша нет ничего, и снимать его — голым `remove`, без `dispose`.
 *
 * ⚠ Общее: не освобождать и не менять (цвет, прозрачность) у одного меша — поменяется у всех того же цвета.
 */
const PROJ_GEOM = new THREE.SphereGeometry(5, 8, 8);
const GEM_GEOM = new THREE.OctahedronGeometry(6);
const projMats = new Map<number, THREE.MeshStandardMaterial>();
const gemMats = new Map<number, THREE.MeshStandardMaterial>();

/** Самосветящийся материал цвета `tint` — один на цвет в своём кэше. */
function glowMat(cache: Map<number, THREE.MeshStandardMaterial>, tint: number, intensity: number): THREE.MeshStandardMaterial {
  let m = cache.get(tint);
  if (!m) { m = new THREE.MeshStandardMaterial({ color: tint, emissive: tint, emissiveIntensity: intensity }); cache.set(tint, m); }
  return m;
}

/** Снаряд цвета `tint`: общая сфера r=5, самосвет 0.7. */
export function projMesh(tint: number): THREE.Mesh {
  return new THREE.Mesh(PROJ_GEOM, glowMat(projMats, tint, 0.7));
}

/**
 * Дроп цвета `col`: группа (её ставят в точку дропа) с гемом-октаэдром r=6 на высоте 12, самосвет 0.9. Гем светится сам —
 * БЕЗ PointLight: каждый дроп-свет менял число света в сцене → Three.js перекомпилировал ВСЕ материалы (синхронный хитч
 * в главном потоке на каждый спавн/деспаун лута).
 */
export function dropMesh(col: number): THREE.Group {
  const g = new THREE.Group();
  const gem = new THREE.Mesh(GEM_GEOM, glowMat(gemMats, col, 0.9));
  gem.position.y = 12; g.add(gem);
  return g;
}

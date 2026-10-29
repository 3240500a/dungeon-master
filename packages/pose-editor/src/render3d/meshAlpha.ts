import * as THREE from 'three';

/**
 * ПРОЗРАЧНОСТЬ ЧУЖОГО МЕША (импортная модель) — БЕЗ ПОРЧИ ЕГО МАТЕРИАЛА.
 *
 * ЗАЧЕМ ОТДЕЛЬНО ОТ `applyAlpha` РЕДАКТОРА. Манекен и хелперы редактор строит сам, и гасить их можно прямо
 * в материале. У импортной модели материал ЧУЖОЙ и ОБЩИЙ: `getMaterial` (`assetCache`) отдаёт ОДИН инстанс
 * на `materialId`, и он же висит на игровой кукле вкладки «Тест», на превью материалов и на других деталях.
 * Опустив ему `opacity`, погасишь половину страницы, а вернув — не факт что вернёшь: материал переживает
 * пересборку скина. Поэтому гасим КЛОН, а оригинал держим на меше и возвращаем, как только ручка снова 1.
 *
 * ⚠ ТРИ ГРАБЛИ, КАЖДАЯ ПРОВЕРЕНА СТОРОЖЕМ:
 *  • `alphaTest` СЪЕДАЕТ МЕШ ЦЕЛИКОМ. В three `diffuseColor.a = opacity × texel.a`, и как только альфа падает
 *    ниже `alphaTest` (у alpha-clip материалов — волосы, ремешки), меш ИСЧЕЗАЕТ, а не бледнеет. У клона его
 *    снимаем.
 *  • `depthWrite` ОБЯЗАН УЙТИ. Иначе полупрозрачный меш пишет глубину и закрывает собой то, ради чего его и
 *    гасили (физ-тела внутри), — именно этот приём уже применён у скелета (`applyAlpha`).
 *  • `needsUpdate` — ТОЛЬКО НА ПЕРЕКЛЮЧЕНИИ ФЛАГА. У материалов атласа висит `onBeforeCompile` +
 *    `customProgramCacheKey`: ставить `needsUpdate` на каждый тик ползунка — это пересборка шейдерных
 *    программ на десятках материалов, то есть фриз на каждое движение мыши.
 */

/**
 * Учёт «оригинал ↔ наш клон» — В WeakMap, А НЕ В `userData` МЕША.
 *
 * ⚠ `THREE.Object3D.copy` клонирует `userData` через `JSON.parse(JSON.stringify(...))`, а экспорт по слотам и
 * онион-призраки как раз клонируют поддеревья. Материал, положенный в `userData`, доехал бы до копии ПЛОСКИМ
 * JSON-объектом, и возврат «как было» подсунул бы мешу не материал, а его бумажную копию. WeakMap не копируется
 * вместе с объектом и освобождается сама, когда меш выброшен.
 */
interface Faded { orig: THREE.Material | THREE.Material[]; fade: THREE.Material | THREE.Material[] }
const faded = new WeakMap<THREE.Mesh, Faded>();

const OPAQUE = 0.999;   // выше этого — «непрозрачно»: тот же порог, что у `applyAlpha` редактора

function fadeOne(src: THREE.Material, a: number): THREE.Material {
  const m = src.clone() as THREE.MeshStandardMaterial;
  m.transparent = true;
  m.opacity = a;
  m.depthWrite = false;
  m.alphaTest = 0;      // иначе alpha-clip меш пропадёт целиком, а не побледнеет
  return m;
}

/**
 * Поставить мешу прозрачность `a` (1 — вернуть как было). Идемпотентна: повторный вызов с тем же числом
 * ничего не пересобирает, только правит `opacity` уже созданного клона.
 */
export function fadeMesh(mesh: THREE.Mesh, a: number): void {
  const cur = faded.get(mesh);
  if (a >= OPAQUE) {
    if (cur) { mesh.material = cur.orig; disposeFade(cur.fade); faded.delete(mesh); }
    return;
  }
  if (!cur) {
    const src = mesh.material;
    const fade = Array.isArray(src) ? src.map((m) => fadeOne(m, a)) : fadeOne(src, a);
    faded.set(mesh, { orig: src, fade });
    mesh.material = fade;
    return;
  }
  // Клон уже есть — правим ТОЛЬКО число: ни клонов, ни перекомпиляции шейдера на каждый тик ползунка.
  if (Array.isArray(cur.fade)) for (const m of cur.fade) m.opacity = a;
  else cur.fade.opacity = a;
  mesh.material = cur.fade;   // материал могли переназначить извне (пересборка скина) — возвращаем наш клон
}

/**
 * ⭐ НА ВРЕМЯ ЭКСПОРТА — ТОЛЬКО ОРИГИНАЛЫ. Возвращает «вернуть как было».
 *
 * ⚠ Иначе прозрачность уезжает В ИГРУ: `exportGLB` гоняет `GLTFExporter` по тем же мешам, и материал с
 * `transparent: true, opacity < 1` записывается в GLB как `alphaMode: BLEND`. Опубликованная деталь стала бы
 * полупрозрачной у всех игроков — из-за ползунка вида в редакторе. Один шов на ВСЕ пути экспорта.
 */
export function withOpaque(root: THREE.Object3D): () => void {
  const back: { mesh: THREE.Mesh; fade: THREE.Material | THREE.Material[] }[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const f = mesh.isMesh ? faded.get(mesh) : undefined;
    if (!f) return;
    back.push({ mesh, fade: f.fade });
    mesh.material = f.orig;
  });
  return () => { for (const b of back) b.mesh.material = b.fade; };
}

/** Пройти по поддереву. Возвращает, сколько мешей тронуто (для читаута и сторожей). */
export function fadeTree(root: THREE.Object3D | null | undefined, a: number): number {
  if (!root) return 0;
  let n = 0;
  root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { fadeMesh(m, a); n++; } });
  return n;
}

function disposeFade(f: THREE.Material | THREE.Material[] | undefined): void {
  if (!f) return;
  if (Array.isArray(f)) for (const m of f) m.dispose();
  else f.dispose();
}

/**
 * Окружение 3D-клиента: процедурные текстуры (спокойный серый камень), сборка этажа из
 * DungeonLayout (пол/стены/двери/пропсы), факелы с партикл-пламенем и точечным светом,
 * освещение «карманный свет». Мир (x,y) → 3D (x, h, z=y). TILE=32u=1 м, стена 3 м.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { TILE, Cell, type DungeonLayout } from '@dm/shared';

export const WALL_H = 96;

function tex(c: HTMLCanvasElement): THREE.Texture {
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; t.colorSpace = THREE.SRGBColorSpace; return t;
}
function flagstoneTexture(): THREE.Texture {
  const S = 256, c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d')!;
  g.fillStyle = '#4c4e4d'; g.fillRect(0, 0, S, S);
  const n = 2, cell = S / n;
  for (let ry = 0; ry < n; ry++) for (let rx = 0; rx < n; rx++) {
    const L = 52 + (Math.random() * 8 - 4), bx = rx * cell + 3, by = ry * cell + 3, bw = cell - 6, bh = cell - 6;
    g.fillStyle = `hsl(150,3%,${L}%)`; g.fillRect(bx, by, bw, bh);
    g.strokeStyle = 'rgba(255,255,255,0.05)'; g.lineWidth = 2; g.beginPath(); g.moveTo(bx, by + bh); g.lineTo(bx, by); g.lineTo(bx + bw, by); g.stroke();
    g.strokeStyle = 'rgba(0,0,0,0.12)'; g.beginPath(); g.moveTo(bx + bw, by); g.lineTo(bx + bw, by + bh); g.lineTo(bx, by + bh); g.stroke();
  }
  g.fillStyle = 'rgba(120,122,120,0.05)'; for (let i = 0; i < 500; i++) g.fillRect(Math.random() * S, Math.random() * S, 2, 2);
  return tex(c);
}
function masonryTexture(): THREE.Texture {
  const S = 256, c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d')!;
  g.fillStyle = '#4a4c4c'; g.fillRect(0, 0, S, S);
  const rows = 4, rh = S / rows;
  for (let r = 0; r < rows; r++) {
    const y = r * rh; let x = -(r % 2) * (S / 6);
    while (x < S) {
      const w = (S / 3) * (0.85 + Math.random() * 0.3), L = 56 + (Math.random() * 6 - 3), bx = x + 2, by = y + 2, bw = w - 3, bh = rh - 3;
      const grad = g.createLinearGradient(bx, by, bx, by + bh); grad.addColorStop(0, `hsl(200,4%,${L + 5}%)`); grad.addColorStop(1, `hsl(200,4%,${L - 5}%)`);
      g.fillStyle = grad; g.fillRect(bx, by, bw, bh);
      g.strokeStyle = 'rgba(40,42,44,0.5)'; g.lineWidth = 1; g.strokeRect(bx, by, bw, bh);
      g.strokeStyle = 'rgba(255,255,255,0.05)'; g.beginPath(); g.moveTo(bx, by + bh); g.lineTo(bx, by); g.lineTo(bx + bw, by); g.stroke();
      x += w;
    }
  }
  return tex(c);
}
function flameTexture(): THREE.Texture {
  const S = 64, c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.4, 'rgba(255,220,150,0.7)'); grad.addColorStop(1, 'rgba(255,140,40,0)');
  g.fillStyle = grad; g.fillRect(0, 0, S, S); return new THREE.CanvasTexture(c);
}

const floorTex = flagstoneTexture();
const wallTex = masonryTexture(); wallTex.repeat.set(1, 2);
const FLAME_TEX = flameTexture();
const matStone = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, map: floorTex });
const matWall = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, map: wallTex });
const matWood = new THREE.MeshStandardMaterial({ color: 0x5a3d24, roughness: 0.85 });
const matMetal = new THREE.MeshStandardMaterial({ color: 0x8892a0, roughness: 0.5, metalness: 0.6 });
const matDark = new THREE.MeshStandardMaterial({ color: 0x2a2a33, roughness: 1 });

// ── Фейд стен-окклюдеров вокруг игрока (дизер) ──────────────────────────────────
// Стены между камерой и героем тают: плавный дизер (screen-door discard, без alpha-сортировки),
// гейт «только со стороны камеры» (dot(стена→игрок с направлением на камеру)). online3d обновляет
// поля каждый кадр (позиция игрока + направление на камеру из CAM.az) + радиусы из конфига.
// Фейд ближних стен по «ЛИЦУ» (как в D2): у каждой стены есть направление В КОМНАТУ (aFacing, per-instance).
// Ближняя к камере стена смотрит лицом ОТ камеры (в сцену) → её ВЕРХ дизер-тает (видно комнату); дальние стены
// (лицом К камере, задник) целы. Низ «по колено» не фейдится (граница читается). Ограничено мягким радиусом у игрока.
export const wallFade = {
  playerPos: new THREE.Vector3(0, 0, 0),                        // мир-позиция игрока (XZ важен)
  viewDir: new THREE.Vector2(0, -1),                           // горизонт. взгляд камеры (target−camPos, норм.) — online3d обновляет
  fade: new THREE.Vector2(190, 460),                           // радиус: x = зона фейда у игрока, y = снова видимо
  knee: new THREE.Vector2(20, 46),                             // высота: ниже x (по колено) НЕ фейдится, выше y — полный фейд верха
  on: 1,                                                       // 1 вкл / 0 выкл (для отладки)
  faceYaw: 0,                                                 // доп. разворот GLB-стены (рад): выставить лицевую сторону модели по «лицу в комнату» (тюн на глаз)
  colYaw: Math.PI / 2,                                       // доп. разворот КОЛОННЫ (рад) поверх поквадрантного 0/90/180/270: +90° против часовой (вид сверху). Тюн на глаз (±Math.PI/2).
};
// ЖИВОЙ ТЮН напольного декора/пропов (одинаково на ВСЕ модели, без авто-детекта): rotX — общий доворот вокруг X (Z-up→Y-up,
// если экспорт Z-up → −Math.PI/2), offY — подъём/опускание. Меняй `__o.propTune.rotX/offY` + `__o.rebuildEnv()` (без релога),
// потом скажи значения — впишу дефолт. Пивот модели НЕ трогаем (как в Максе).
export const propTune = { rotX: 0, offY: 0 };
const wallFadeU = {
  uPlayerPos: { value: wallFade.playerPos },
  uViewDir: { value: wallFade.viewDir },
  uFade: { value: wallFade.fade },
  uKnee: { value: wallFade.knee },
  uFadeOn: { value: wallFade.on },
};
/** Навесить дизер-фейд по «лицу» на материал стены (процедурный matWall ИЛИ материал GLB-стены). `facingGate=false`
 *  (для КОЛОНН — они симметричны, «лица» нет) → фейдим радиально+по высоте у игрока БЕЗ гейта «стена смотрит от камеры». */
export function applyWallFade(mat: THREE.Material, facingGate = true): void {
  const prev = mat.onBeforeCompile;   // цепляемся (не затираем) — сохраняем возможный offset roughness/metalness из getMaterial
  mat.onBeforeCompile = (shader): void => {
    prev?.(shader, undefined as never);
    Object.assign(shader.uniforms, wallFadeU);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorldW;\nvarying float vFaceDot;\nattribute vec2 aFacing;\nuniform vec2 uViewDir;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n{ vec4 wpW = vec4(transformed,1.0);\n#ifdef USE_INSTANCING\n wpW = instanceMatrix * wpW;\n#endif\n vWorldW = (modelMatrix * wpW).xyz; }\n vFaceDot = dot(aFacing, uViewDir);   // >0 = лицо стены смотрит от камеры (ближняя, загораживает)');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorldW;\nvarying float vFaceDot;\nuniform vec3 uPlayerPos;\nuniform vec2 uFade;\nuniform vec2 uKnee;\nuniform float uFadeOn;')
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>
        if (uFadeOn > 0.5) {
          float near = ${facingGate ? 'smoothstep(0.0, 0.35, vFaceDot)' : '1.0'};                     // 1 = ближняя стена (лицо от камеры), 0 = задник (лицом к камере); колонна — всегда 1
          float top = smoothstep(uKnee.x, uKnee.y, vWorldW.y);              // 0 ниже «колена» (не фейдим), 1 выше (фейдим верх)
          float radial = 1.0 - smoothstep(uFade.x, uFade.y, distance(vWorldW.xz, uPlayerPos.xz));   // только у игрока
          float fadeAmt = near * top * radial;                             // 1 = полностью прозрачно
          float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));   // интерлив-градиент-шум (плавный дизер)
          if (fadeAmt > ign) discard;
        }`);
  };
}
applyWallFade(matWall);

// ── Тайлсет окружения из GLB (пол/стена вместо процедурных боксов) ───────────────────────────────
// ПОЛ: каждый меш GLB = отдельный ВАРИАНТ (9 тайлов — рандом по клетке + поворот 0/90/180/270 против тайлинга).
// СТЕНА: варианты по 2 меша (низ `lo` не фейдится + верх `hi` тает) — группируем по имени, ставим ОБЕ части вместе.
// Экспорт из Max: Z-up (детект по геометрии) + любой масштаб (нормируем полом к TILE). Пусто → процедурка.
export interface EnvTile { geo: THREE.BufferGeometry; mat: THREE.Material }
export interface WallPart { geo: THREE.BufferGeometry; mat: THREE.Material; fade: boolean }   // fade: верх (true) / низ-база (false)
export interface WallVariant { parts: WallPart[] }
/** Параметры точечного света из маркера `light*` (config objects[].light). */
export interface LightCfg { color: string; intensity: number; distance: number; flicker: boolean }
/** Напольный декор-объект: набор мешей (низ на y=0, центр XZ в точке размещения) + локальные точки света из `light*` + их параметры.
 *  `coversFloor` (role floor россыпь) — базовый пол пропускается в занятых клетках (модель = плитки+декор запечены). */
export interface PropVariant { parts: EnvTile[]; lights: THREE.Vector3[]; light?: LightCfg; coversFloor?: boolean }
export interface EnvKit { floors: EnvTile[]; walls: WallVariant[]; columns: WallVariant[]; props: Map<string, PropVariant> }

interface RawTile { geo: THREE.BufferGeometry; mat: THREE.Material; name: string }

/** Вспом-меши по конвенции имён (невидимы в игре): `collider*` = форма коллизии (сервер), `light*` = точка света. */
function isColliderName(n: string): boolean { return /^collider/i.test(n); }
function isLightName(n: string): boolean { return /^light/i.test(n); }

/** Детерминированный хэш клетки → неотрицательное 32-бит (для выбора варианта/поворота, стабилен между пересборками). */
function cellHash(x: number, y: number, seed: number): number { return (((x * 73856093) ^ (y * 19349663) ^ (seed * 83492791)) >>> 0); }

// Токены имени меша, помечающие часть стены «низ»/«верх» (регистронезависимо, по «словам» имени).
const LO_TOK = ['lo', 'low', 'bottom', 'base', 'btm', 'bot', 'down'];
const HI_TOK = ['hi', 'high', 'top', 'upper', 'up'];
function wallPart(name: string): 'lo' | 'hi' | null {
  const toks = name.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (toks.some((t) => LO_TOK.includes(t))) return 'lo';
  if (toks.some((t) => HI_TOK.includes(t))) return 'hi';
  return null;
}
/** База имени без токенов lo/hi → ключ группировки пары (напр. `wall_01_lo`+`wall_01_hi` → `wall_01`). */
function wallBase(name: string): string {
  return name.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t && !LO_TOK.includes(t) && !HI_TOK.includes(t)).join('_');
}

/** Все ВИДИМЫЕ меши GLTF-сцены как тайлы (мир-трансформы применены, атрибуты почищены под инстансинг, имя сохранено).
 *  Вспом-меши `collider*` (форма коллизии, считает сервер) и `light*` (точка света) — пропускаем (не рисуем). */
function collectTiles(scene: THREE.Object3D): RawTile[] {
  scene.updateMatrixWorld(true);
  const out: RawTile[] = [];
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!(m as { isMesh?: boolean }).isMesh || !m.geometry) return;
    if (isColliderName(m.name) || isLightName(m.name)) return;   // невидимые маркеры — не в рендер
    let g = m.geometry.clone(); g.applyMatrix4(m.matrixWorld);
    for (const a of ['tangent', 'color']) g.deleteAttribute(a);
    if (g.index) g = g.toNonIndexed();
    out.push({ geo: g, mat: (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.Material, name: m.name || '' });
  });
  return out;
}

/** Мировые (модель-пространство) позиции маркеров `light*` GLTF-сцены — точки, где ставить источник света. */
function collectLightMarkers(scene: THREE.Object3D): THREE.Vector3[] {
  scene.updateMatrixWorld(true);
  const out: THREE.Vector3[] = [];
  scene.traverse((o) => { if (isLightName(o.name)) out.push(o.getWorldPosition(new THREE.Vector3())); });
  return out;
}

/** Пол: центр XZ, НИЗ/КРОМКА (= пивот Z=0 из Макса) на y=0. ВАЖНО: заземляем по bb.MIN.y, а не max.y. У тайлов
 *  кромки опущены к Z=0, центр вспучен вверх (рельеф-«подушка», у разных тайлов 2.1..3.6). Если ставить верх на 0
 *  (max.y), кромки проваливаются на РАЗНУЮ глубину → канавы-щели + ступеньки на стыках + зазор у стен. По min.y
 *  (пивот) кромки ВСЕХ тайлов ложатся на y=0 → швы вровень, а вспучивание уходит вверх (декор). */
function normalizeFloorGeo(geo: THREE.BufferGeometry, unitScale: number): void {
  geo.computeBoundingBox(); const ext = new THREE.Vector3(); geo.boundingBox!.getSize(ext);
  if (ext.z < ext.y) geo.rotateX(-Math.PI / 2);                 // пол: тоньше по Z = Z-up → в Y-up
  geo.scale(unitScale, unitScale, unitScale);
  geo.computeBoundingBox(); const bb = geo.boundingBox!;
  geo.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);   // кромка/пивот на y=0
}
/** Вариант стены (1-2 меша) нормируем как ЦЕЛОЕ: общий Z-up-детект и общий сдвиг низа на y=0 — чтобы низ/верх остались
 * состыкованными по высоте. XZ-пивот модели (центр лицевой стороны) сохраняем — стену ставим на край тайла к комнате. */
function normalizeWallVariant(geos: THREE.BufferGeometry[], unitScale: number): void {
  const comb = new THREE.Box3();
  for (const g of geos) { g.computeBoundingBox(); comb.union(g.boundingBox!); }
  const ext = new THREE.Vector3(); comb.getSize(ext);
  const zUp = ext.z > ext.y;                                    // стена: выше по Z = Z-up
  for (const g of geos) { if (zUp) g.rotateX(-Math.PI / 2); g.scale(unitScale, unitScale, unitScale); }
  const comb2 = new THREE.Box3();
  for (const g of geos) { g.computeBoundingBox(); comb2.union(g.boundingBox!); }
  for (const g of geos) g.translate(0, -comb2.min.y, 0);        // общий низ пары на y=0
}

/** ПОЛНОСТЬЮ ИГНОРИРУЕМ запечённый PBR из GLB-материала окружения (он ненадёжен: metallicFactor по дефолту glTF=1.0 +
 *  ненулевой B-канал metalRough-карты + roughnessFactor резал шероховатость → ложный металл-глянец по швам, в Unity камень
 *  матовый). Оставляем только «вид»: albedo (`map`) + рельеф (`normalMap`); metal/rough/AO/emissive-карты и факторы —
 *  выкидываем, задаём МАТОВЫЙ ДИЭЛЕКТРИК (metalness=0, roughness=0.9). Металл/блеск объекта — через materialId в конфиге
 *  (override минует эту нормализацию). Мутирует материал на месте (инстанс общий на вариант). */
function normEnvMat(mat: THREE.Material): THREE.Material {
  const m = mat as THREE.MeshStandardMaterial;
  if (!('metalness' in m)) return m;   // не Standard/Physical — не трогаем
  m.metalness = 0; m.roughness = 0.9;                                   // матовый диэлектрик
  m.metalnessMap = null; m.roughnessMap = null; m.aoMap = null;         // выкинуть ненадёжные PBR-карты
  m.emissive = new THREE.Color(0, 0, 0); m.emissiveMap = null;          // без эмиссии
  m.needsUpdate = true;
  return m;
}

/** Спека объекта окружения: url GLB + опц. материал-override (общий инстанс на роль — дешевле для слабых ПК; null = из GLB). */
export interface EnvSpec { url: string; mat?: THREE.Material | null }
/** Спека расставляемого объекта: как EnvSpec + `objectId` (ключ серверного `DecorObject`) + свет (`light*`) + `coversFloor` (россыпь пола). */
export interface PropSpec { objectId: string; url: string; mat?: THREE.Material | null; light?: LightCfg; coversFloor?: boolean }

/** Footprint-масштаб из первого тайла пола (плоский тайл → наибольшая сторона = 1 м → TILE). */
function floorUnitScale(tile: THREE.BufferGeometry): number {
  tile.computeBoundingBox(); const e = new THREE.Vector3(); tile.boundingBox!.getSize(e);
  const foot = Math.max(e.x, e.y, e.z);
  return foot > 1e-4 ? TILE / foot : 1;
}

/** Меши одного стен-GLB → варианты (пара lo+hi). baseMat≠null → общий материал (низ + клон-с-фейдом на верх), иначе из GLB. */
function buildWallVariants(rawWalls: RawTile[], unitScale: number, baseMat: THREE.Material | null): WallVariant[] {
  const fadeMat = baseMat ? baseMat.clone() : null;   // override: один общий верх-с-фейдом на все варианты этого GLB
  if (fadeMat) applyWallFade(fadeMat);
  const hasParts = rawWalls.some((t) => wallPart(t.name) !== null);
  const groups = new Map<string, RawTile[]>();
  rawWalls.forEach((t, i) => {
    const key = hasParts ? (wallBase(t.name) || `__v${i}`) : `__v${i}`;   // пара lo+hi по базе имени; нет токенов → каждый меш вариант
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(t);
  });
  return [...groups.values()].map((tiles) => {
    normalizeWallVariant(tiles.map((t) => t.geo), unitScale);
    const parts: WallPart[] = tiles.map((t) => {
      const fade = wallPart(t.name) !== 'lo';   // низ (lo) не фейдится, всё прочее (hi/одиночный меш) — тает
      let mat: THREE.Material;
      if (baseMat) { mat = fade ? fadeMat! : baseMat; }        // override: общий инстанс на роль
      else { mat = normEnvMat(t.mat); if (fade) applyWallFade(mat); }   // из GLB: диэлектрик-нормализация + фейд на верх
      return { geo: t.geo, mat, fade };
    });
    return { parts };
  });
}

/** Меши колонны-GLB → варианты (пара lo+hi, как стена, но БЕЗ фейда — колонна не окклюдер). XZ-пивот сохраняется
 *  (normalizeWallVariant не центрирует XZ), у колонны он смещён в угол-стык стен — ставим колонну по этому пивоту. */
function buildColumnVariants(rawCols: RawTile[], unitScale: number, baseMat: THREE.Material | null): WallVariant[] {
  const fadeMat = baseMat ? baseMat.clone() : null;   // общий верх-с-фейдом на все варианты (override)
  if (fadeMat) applyWallFade(fadeMat);                // верх колонны тает как стена (по «лицу»=диагональ угла, aFacing задаём при расстановке)
  const hasParts = rawCols.some((t) => wallPart(t.name) !== null);
  const groups = new Map<string, RawTile[]>();
  rawCols.forEach((t, i) => { const key = hasParts ? (wallBase(t.name) || `__c${i}`) : `__c${i}`; (groups.get(key) ?? groups.set(key, []).get(key)!).push(t); });
  return [...groups.values()].map((tiles) => {
    normalizeWallVariant(tiles.map((t) => t.geo), unitScale);   // Z-up + масштаб + низ на y=0, XZ-пивот (стык) сохранён
    const parts: WallPart[] = tiles.map((t) => {
      const fade = wallPart(t.name) !== 'lo';                   // низ (lo) не тает, верх (hi/одиночный) — тает у игрока
      let mat: THREE.Material;
      if (baseMat) { mat = fade ? fadeMat! : baseMat; }
      else { mat = normEnvMat(t.mat); if (fade) applyWallFade(mat); }
      return { geo: t.geo, mat, fade };
    });
    return { parts };
  });
}

/** Меши декор-GLB → PropVariant. БЕЗ ДЕТЕКТОВ/центровок/заземлений: геометрия СЫРАЯ как из Макса (collectTiles уже
 *  запёк matrixWorld) + ТОЛЬКО масштаб под тайл. Пивот модели сохранён (origin). Общий доворот `propTune.rotX` и подъём
 *  `propTune.offY` применяются пер-инстанс в `buildEnvironment` (живой тюн, одинаково на все модели). `lightsModel` —
 *  маркеры `light*` в локаль пропа (масштаб; доворот применится вместе с инстансом). */
function buildPropVariant(render: RawTile[], lightsModel: THREE.Vector3[], unitScale: number, baseMat: THREE.Material | null): PropVariant {
  for (const r of render) r.geo.scale(unitScale, unitScale, unitScale);   // только размер под тайл; ориентация/пивот — как в Максе
  const lights = lightsModel.map((v) => v.clone().multiplyScalar(unitScale));
  const parts: EnvTile[] = render.map((r) => ({ geo: r.geo, mat: baseMat ?? normEnvMat(r.mat) }));
  return { parts, lights };
}

/** Загрузить тайлсет окружения из СПИСКОВ объектов (пол/стена/колонна + напольный декор). Каждый спек = ОДИН GLB (может
 *  нести варианты-меши): floor-GLB → пул пола, wall-GLB → стены, pillar-GLB → колонны (углы), decor/prop-GLB → пропы
 *  (по objectId). Масштаб — из первого тайла первого пола. Материал per-объект (null = из GLB). Нет пола → пустой кит → боксы. */
export async function loadEnvKitFromObjects(floorSpecs: EnvSpec[], wallSpecs: EnvSpec[], columnSpecs: EnvSpec[] = [], propSpecs: PropSpec[] = []): Promise<EnvKit> {
  const loader = new GLTFLoader();
  const kit: EnvKit = { floors: [], walls: [], columns: [], props: new Map() };
  const load = (specs: EnvSpec[]): Promise<({ tiles: RawTile[]; mat: THREE.Material | null } | null)[]> =>
    Promise.all(specs.map((s) => loader.loadAsync(s.url).then((g) => ({ tiles: collectTiles(g.scene), mat: s.mat ?? null })).catch((e) => { console.warn('[env] не загрузился', s.url, e); return null; })));
  const loadProps = (specs: PropSpec[]): Promise<({ objectId: string; tiles: RawTile[]; lights: THREE.Vector3[]; mat: THREE.Material | null; light?: LightCfg; coversFloor?: boolean } | null)[]> =>
    Promise.all(specs.map((s) => loader.loadAsync(s.url).then((g) => ({ objectId: s.objectId, tiles: collectTiles(g.scene), lights: collectLightMarkers(g.scene), mat: s.mat ?? null, light: s.light, coversFloor: s.coversFloor })).catch((e) => { console.warn('[env] проп не загрузился', s.url, e); return null; })));
  const [floorLoaded, wallLoaded, columnLoaded, propLoaded] = await Promise.all([load(floorSpecs), load(wallSpecs), load(columnSpecs), loadProps(propSpecs)]);
  const firstFloor = floorLoaded.find((f) => f && f.tiles.length);
  if (!firstFloor) return kit;   // без пола нет масштаба → фолбэк боксы
  const unitScale = floorUnitScale(firstFloor.tiles[0]!.geo);
  for (const f of floorLoaded) {
    if (!f) continue;
    for (const t of f.tiles) { normalizeFloorGeo(t.geo, unitScale); kit.floors.push({ geo: t.geo, mat: f.mat ?? normEnvMat(t.mat) }); }
  }
  for (const w of wallLoaded) { if (w) kit.walls.push(...buildWallVariants(w.tiles, unitScale, w.mat)); }
  for (const c of columnLoaded) { if (c) kit.columns.push(...buildColumnVariants(c.tiles, unitScale, c.mat)); }
  for (const p of propLoaded) { if (p && p.tiles.length) { const pv = buildPropVariant(p.tiles, p.lights, unitScale, p.mat); pv.light = p.light; pv.coversFloor = p.coversFloor; kit.props.set(p.objectId, pv); } }
  return kit;
}

// Факел: мир-позиция + данные пламени. Света СВОЕГО нет — светят лишь TORCH_POOL_N ближайших через общий пул
// (перф: 20-50 факелов на этаж = столько же PointLight → PBR считал КАЖДЫЙ на каждый фрагмент = дикая фрагментная цена;
//  пул фиксированного размера → фрагментная цена ограничена И число света постоянно = нет перекомпиляции материалов).
// Источник света этажа. Факел (kind:'torch') несёт пламя-Points (attr/pos/life/seed/group/flame); свет-маркер `light*`
// декора — только точечный свет (y/color/dist), поля пламени пусты. Общий пул PointLight светит ближайшим к игроку.
export interface Torch { x: number; z: number; base: number; d2: number; on: boolean; y?: number; color?: number; dist?: number; intensity?: number; flicker?: boolean; attr?: THREE.BufferAttribute; pos?: Float32Array; life?: Float32Array; seed?: Float32Array; group?: THREE.Object3D; flame?: THREE.Points }
const FLAME_N = 20;
export const TORCH_POOL_N = 10;   // сколько факелов светят одновременно (ближайшие к игроку); пламя-спрайт есть у всех
// Дальше этой дистанции факел ПОЛНОСТЬЮ в тумане (FogExp2 0.0012 → почти сплошной цвет к ~2000u) → прячем группу
// (столбик + пламя-Points): убираем зря рисуемый прозрачный additive-овердро дальних пламён. См. updateTorches.
const FLAME_CULL2 = 1800 * 1800;

/** Пул света факелов — создаётся ОДИН раз на сессию (постоянное число PointLight → ноль перекомпиляций). */
export function createTorchPool(scene: THREE.Scene): THREE.PointLight[] {
  const pool: THREE.PointLight[] = [];
  for (let i = 0; i < TORCH_POOL_N; i++) {
    const l = new THREE.PointLight(0xff7a2a, 0, 380, 2);
    l.shadow.mapSize.set(512, 512); l.shadow.camera.near = 8; l.shadow.camera.far = 380; l.shadow.bias = -0.004;   // конфиг теней (вкл. по тумблеру)
    scene.add(l); pool.push(l);
  }
  return pool;
}


export function setFog(scene: THREE.Scene): void {
  scene.background = new THREE.Color('#06070c'); scene.fog = new THREE.FogExp2(0x06070c, 0.0012);
}
export function makeSceneLighting(scene: THREE.Scene): void {
  scene.add(new THREE.AmbientLight(0x20222e, 0.5));
  scene.add(new THREE.HemisphereLight(0x34384e, 0x141014, 0.35));
  const dir = new THREE.DirectionalLight(0xb8c2dc, 0.2); dir.position.set(0.5, 1, 0.35); scene.add(dir);
}

const cw = (c: number): number => c * TILE + TILE / 2;

/** Строит этаж из layout в `parent`; возвращает факелы для анимации в цикле. `kit` — GLB-тайлсет (пол/стена) вместо боксов. */
export function buildEnvironment(parent: THREE.Object3D, layout: DungeonLayout, kit?: EnvKit): Torch[] {
  const grid = layout.grid, rows = grid.length, cols = grid[0]!.length;
  const walk = (x: number, y: number): boolean => grid[y]?.[x] !== undefined && grid[y]![x] !== Cell.Wall;
  const dummy = new THREE.Object3D();
  // Общие геометрии повторяющихся пропсов (реюз вместо `new` на КАЖДЫЙ факел/сундук): меньше аллокаций и
  // GPU-буферов. Живут на время этажа; clearGroup при смене области их dispose (реюз в пределах этажа — ок).
  const postGeo = new THREE.CylinderGeometry(1.4, 2, 48, 6);
  const chestBodyGeo = new THREE.BoxGeometry(20, 12, 14), chestLidGeo = new THREE.BoxGeometry(21, 6, 15);

  // Клетки, накрытые floor-россыпью (модель = плитки+декор запечены) → базовый пол там НЕ тайлим (без двойного пола/z-fight).
  const coveredFloor = new Set<string>();
  if (kit?.props?.size) for (const d of layout.decor) {
    if (d.kind !== 'obj' || !d.objectId || !kit.props.get(d.objectId)?.coversFloor) continue;
    const fw = Math.max(1, d.footprint?.w ?? 1), fh = Math.max(1, d.footprint?.h ?? 1);
    const cx0 = Math.round((d.x - (fw * TILE) / 2) / TILE), cy0 = Math.round((d.y - (fh * TILE) / 2) / TILE);
    for (let yy = cy0; yy < cy0 + fh; yy++) for (let xx = cx0; xx < cx0 + fw; xx++) coveredFloor.add(`${xx},${yy}`);
  }
  const floorCells: [number, number][] = [];
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (walk(x, y) && !coveredFloor.has(`${x},${y}`)) floorCells.push([x, y]);
  if (kit?.floors.length) {
    // GLB-варианты пола: вариант + поворот 0/90/180/270 по клетке (детерминированный хэш) → минимум тайлинга.
    const nV = kit.floors.length, cnt = new Array<number>(nV).fill(0), ks = new Array<number>(nV).fill(0);
    for (const [x, y] of floorCells) cnt[cellHash(x, y, 101) % nV]!++;
    const ims = kit.floors.map((t, v) => { const im = new THREE.InstancedMesh(t.geo, t.mat, cnt[v]!); im.receiveShadow = true; parent.add(im); return im; });
    floorCells.forEach(([x, y]) => {
      const v = cellHash(x, y, 101) % nV;
      dummy.position.set(cw(x), 0, cw(y)); dummy.rotation.set(0, (cellHash(x, y, 202) % 4) * Math.PI / 2, 0); dummy.updateMatrix();
      ims[v]!.setMatrixAt(ks[v]!++, dummy.matrix);
    });
    dummy.rotation.set(0, 0, 0);
  } else {
    const fm = new THREE.InstancedMesh(new THREE.BoxGeometry(TILE, 4, TILE), matStone, floorCells.length);
    fm.receiveShadow = true;   // тени от факелов (вкл. по тумблеру) — пол принимает
    floorCells.forEach(([x, y], i) => { dummy.position.set(cw(x), -2, cw(y)); dummy.updateMatrix(); fm.setMatrixAt(i, dummy.matrix); });
    parent.add(fm);
  }

  const wallCells: [number, number][] = [];
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    if (grid[y]![x] !== Cell.Wall) continue;
    let near = false; for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1; dx++) if (walk(x + dx, y + dy)) { near = true; break; }
    if (near) wallCells.push([x, y]);
  }
  // «Лицо» стены = направление в комнату (сумма к смежным проходимым клеткам, 4-соседа; если нет — 8). Ближняя к камере стена
  // смотрит лицом ОТ камеры → её верх тает (aFacing per-instance, см. applyWallFade). Мир z = сетка y.
  const N4: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const N8: [number, number][] = [...N4, [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const facingOf = (x: number, y: number): [number, number] => {
    let fx = 0, fz = 0; for (const [dx, dy] of N4) if (walk(x + dx, y + dy)) { fx += dx; fz += dy; }
    if (fx === 0 && fz === 0) for (const [dx, dy] of N8) if (walk(x + dx, y + dy)) { fx += dx; fz += dy; }
    const len = Math.hypot(fx, fz) || 1; return [fx / len, fz / len];
  };
  if (kit?.walls.length) {
    // GLB-варианты стены. Сегмент на КАЖДУЮ открытую грань стен-клетки (сосед по 4-направлениям проходим). Прямая
    // стена → 1 грань; ВНУТРЕННИЙ УГОЛ → 2 грани (буквой «Г», угол заполнен); полуостров → 3. Так стены доходят до
    // конца и углы не зияют. Пивот (край лицевой стороны) ставим на КРАЙ тайла к комнате (+dir·½), разворот лицом в комнату.
    const nV = kit.walls.length;
    const place: { x: number; y: number; fx: number; fz: number; v: number }[] = [];
    for (const [x, y] of wallCells) {
      const v = cellHash(x, y, 303) % nV;   // вариант — по клетке (обе грани угла из одного набора)
      for (const [dx, dy] of N4) if (walk(x + dx, y + dy)) place.push({ x, y, fx: dx, fz: dy, v });
    }
    for (let v = 0; v < nV; v++) {
      const cells = place.filter((p) => p.v === v);
      if (!cells.length) continue;
      const facing = new Float32Array(cells.length * 2), mats: THREE.Matrix4[] = [];
      cells.forEach((p, i) => {
        facing[i * 2] = p.fx; facing[i * 2 + 1] = p.fz;
        dummy.position.set(cw(p.x) + p.fx * TILE / 2, 0, cw(p.y) + p.fz * TILE / 2);
        dummy.rotation.set(0, Math.atan2(p.fx, p.fz) + wallFade.faceYaw, 0); dummy.updateMatrix();
        mats.push(dummy.matrix.clone());
      });
      for (const part of kit.walls[v]!.parts) {   // ставим ВСЕ части варианта (низ+верх) на общие трансформы
        const geo = part.geo.clone();
        const im = new THREE.InstancedMesh(geo, part.mat, cells.length); im.castShadow = im.receiveShadow = true;
        mats.forEach((mtx, i) => im.setMatrixAt(i, mtx));
        if (part.fade) geo.setAttribute('aFacing', new THREE.InstancedBufferAttribute(facing.slice(), 2));   // aFacing нужен лишь фейд-шейдеру верха
        parent.add(im);
      }
    }
    dummy.rotation.set(0, 0, 0);
  } else {
    const wallGeo = new THREE.BoxGeometry(TILE, WALL_H, TILE), facing = new Float32Array(wallCells.length * 2);
    const wm = new THREE.InstancedMesh(wallGeo, matWall, wallCells.length); wm.castShadow = wm.receiveShadow = true;
    wallCells.forEach(([x, y], i) => { const [fx, fz] = facingOf(x, y); facing[i * 2] = fx; facing[i * 2 + 1] = fz; dummy.position.set(cw(x), WALL_H / 2, cw(y)); dummy.updateMatrix(); wm.setMatrixAt(i, dummy.matrix); });
    wallGeo.setAttribute('aFacing', new THREE.InstancedBufferAttribute(facing, 2)); parent.add(wm);
  }

  // КОЛОННЫ НА ВНУТРЕННИХ УГЛАХ (стен-клетка с 2 ПЕРПЕНДИКУЛЯРНЫМИ открытыми гранями — там стыкуются 2 стены). Пивот
  // колонны смещён в стык → ставим её в точку угла (центр клетки + диагональ·½TILE), крутим ПОКВАДРАНТНО 0/90/180/270
  // (по диагонали к комнате) + доп. тюн `wallFade.colYaw` (юзер довернёт на глаз). Противоположные грани (сквозная
  // тонкая стена) — не угол, пропускаем.
  if (kit?.columns?.length) {
    const nV = kit.columns.length;
    const place: { x: number; y: number; dx: number; dz: number; v: number }[] = [];
    const DIAG: [number, number][] = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
    for (const [x, y] of wallCells) {
      const v = cellHash(x, y, 404) % nV;
      for (const [dx, dz] of DIAG) {
        const eA = walk(x + dx, y), eB = walk(x, y + dz), diag = walk(x + dx, y + dz);
        const convex = diag && !eA && !eB;   // выпуклый угол комнаты: комната по диагонали, обе прилегающие грани — стены (две прямые стены сходятся тут)
        const concave = eA && eB;            // вогнутый локоть (L): обе перпендикулярные грани этой клетки открыты в комнату
        if (convex || concave) place.push({ x, y, dx, dz, v });   // столб в точке угла (cellCenter+диагональ·½), поворот по квадранту
      }
    }
    // Квадрант угла → индекс поворота ×90°. Анти-диагонали (СВ diag(−1,+1) / ЮЗ diag(+1,−1)) развёрнуты на 180°
    // относительно диагоналей (СЗ/ЮВ) — по правке юзера (модель садится верно только так). Итог с colYaw +90°:
    // СЗ(+,+)=90°, СВ(−,+)=0°, ЮВ(−,−)=270°, ЮЗ(+,−)=180°.
    const quad = (dx: number, dz: number): number => (dx < 0 ? (dz < 0 ? 2 : 3) : (dz < 0 ? 1 : 0)) * (Math.PI / 2);
    for (let v = 0; v < nV; v++) {
      const cells = place.filter((p) => p.v === v);
      if (!cells.length) continue;
      const mats: THREE.Matrix4[] = [];
      const facing = new Float32Array(cells.length * 2);
      cells.forEach((p, i) => {
        const fl = Math.hypot(p.dx, p.dz) || 1; facing[i * 2] = p.dx / fl; facing[i * 2 + 1] = p.dz / fl;   // «лицо» колонны = диагональ к комнате (для фейд-шейдера верха)
        dummy.position.set(cw(p.x) + p.dx * TILE / 2, 0, cw(p.y) + p.dz * TILE / 2);
        dummy.rotation.set(0, quad(p.dx, p.dz) + wallFade.colYaw, 0); dummy.updateMatrix();
        mats.push(dummy.matrix.clone());
      });
      for (const part of kit.columns[v]!.parts) {   // все части (низ+верх) на общие трансформы
        const geo = part.geo.clone();
        const im = new THREE.InstancedMesh(geo, part.mat, cells.length); im.castShadow = im.receiveShadow = true;
        mats.forEach((mtx, i) => im.setMatrixAt(i, mtx));
        if (part.fade) geo.setAttribute('aFacing', new THREE.InstancedBufferAttribute(facing.slice(), 2));   // aFacing нужен фейд-шейдеру верха (иначе не тает)
        parent.add(im);
      }
    }
    dummy.rotation.set(0, 0, 0);
  }

  // Колонны — из ГРИДА (Cell.Pillar непроходим на сервере: blocked()). Рисуем ВСЕ такие клетки (и декоративные из
  // decorate, и «зал» из carveRoomShaped) — иначе они были невидимыми стенами (рендерились как пол → «непроходимые тайлы»).
  const pillarCells: [number, number][] = [];
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (grid[y]![x] === Cell.Pillar) pillarCells.push([x, y]);
  if (pillarCells.length) {
    const pillarGeo = new THREE.CylinderGeometry(9, 10, WALL_H, 12);
    const pm = new THREE.InstancedMesh(pillarGeo, matWall, pillarCells.length);
    pm.castShadow = true; pm.receiveShadow = true;
    pillarCells.forEach(([x, y], i) => { dummy.position.set(cw(x), WALL_H / 2, cw(y)); dummy.updateMatrix(); pm.setMatrixAt(i, dummy.matrix); });
    pillarGeo.setAttribute('aFacing', new THREE.InstancedBufferAttribute(new Float32Array(pillarCells.length * 2), 2));   // нулевое лицо → колонны не фейдятся (matWall шейдер читает aFacing)
    parent.add(pm);
  }

  for (const d of layout.doors) for (const c of d.cells) {
    const vertical = walk(c.cx - 1, c.cy) || walk(c.cx + 1, c.cy);
    const geo = vertical ? new THREE.BoxGeometry(8, WALL_H * 0.85, TILE) : new THREE.BoxGeometry(TILE, WALL_H * 0.85, 8);
    const m = new THREE.Mesh(geo, matWood); m.position.set(cw(c.cx), WALL_H * 0.85 / 2, cw(c.cy)); parent.add(m);
  }

  const torches: Torch[] = [];

  // НАПОЛЬНЫЙ ДЕКОР (kind:'obj') — сервер разместил и посчитал коллизию; клиент лишь рисует GLB по objectId (x,y,rot).
  // Группируем по objectId → один InstancedMesh на (объект, часть-меш). Свет из light*-маркеров ставится ниже (updateTorches/Ф4).
  if (kit?.props?.size) {
    const byId = new Map<string, typeof layout.decor>();
    for (const d of layout.decor) if (d.kind === 'obj' && d.objectId && kit.props.has(d.objectId)) (byId.get(d.objectId) ?? byId.set(d.objectId, []).get(d.objectId)!).push(d);
    for (const [oid, list] of byId) {
      const pv = kit.props.get(oid)!;
      // Инстанс = ОБЩИЙ доворот propTune.rotX (одинаково на все) + yaw объекта d.rot + подъём propTune.offY. Пивот в origin.
      const mats = list.map((d) => { dummy.position.set(d.x, propTune.offY, d.y); dummy.rotation.set(propTune.rotX, d.rot ?? 0, 0); dummy.updateMatrix(); return dummy.matrix.clone(); });
      for (const part of pv.parts) {
        const im = new THREE.InstancedMesh(part.geo, part.mat, list.length); im.castShadow = im.receiveShadow = true;
        mats.forEach((m, i) => im.setMatrixAt(i, m));
        parent.add(im);
      }
      // Свет из `light*`-маркеров: PointLight в мир (полный поворот инстанса на локаль маркера + позиция). Кормит общий пул.
      if (pv.lights.length) {
        const lc = pv.light;
        const col = lc ? new THREE.Color(lc.color).getHex() : 0xffa860;
        for (let i = 0; i < list.length; i++) {
          const d = list[i]!;
          const rm = new THREE.Matrix4().extractRotation(mats[i]!);
          for (const lp of pv.lights) {
            const wp = lp.clone().applyMatrix4(rm);
            const wx = d.x + wp.x, wz = d.y + wp.z, wy = propTune.offY + wp.y;
            torches.push({ x: wx, z: wz, y: wy, base: (wx * 0.017 + wz * 0.013) % 6.283, color: col, intensity: lc?.intensity ?? 1500, dist: lc?.distance ?? 380, flicker: lc?.flicker ?? true, d2: 0, on: false });
          }
        }
      }
    }
    dummy.rotation.set(0, 0, 0);
  }
  for (const o of layout.decor) {
    if (o.kind === 'pillar') {
      // Колонны уже отрисованы из грида (Cell.Pillar) выше — пропускаем, иначе двойной меш.
    } else if (o.kind === 'chest') {
      const g = new THREE.Group();
      const body = new THREE.Mesh(chestBodyGeo, matWood); body.position.y = 6;
      const lid = new THREE.Mesh(chestLidGeo, matWood); lid.position.y = 14; g.add(body, lid); g.position.set(o.x, 0, o.y); parent.add(g);
    } else if (o.kind === 'torch') {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(postGeo, matWood).translateY(24));
      const geo = new THREE.BufferGeometry();   // света своего НЕТ — назначит пул (updateTorches) ближайшим к игроку
      const pos = new Float32Array(FLAME_N * 3), life = new Float32Array(FLAME_N), seed = new Float32Array(FLAME_N);
      for (let i = 0; i < FLAME_N; i++) { life[i] = Math.random(); seed[i] = Math.random() * 6.283; pos[i * 3 + 1] = 52; }
      const attr = new THREE.BufferAttribute(pos, 3); geo.setAttribute('position', attr);
      const flame = new THREE.Points(geo, new THREE.PointsMaterial({ map: FLAME_TEX, color: 0xffa848, size: 16, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      g.add(flame);
      g.position.set(o.x, 0, o.y); parent.add(g);
      torches.push({ x: o.x, z: o.y, base: 1500, attr, pos, life, seed, d2: 0, on: false, group: g, flame });
    } else if (o.kind === 'portal') {
      // Портал узла забега (rest → возврат в город; финал → завершение). Аметистовое кольцо + свечение.
      const g = new THREE.Group();
      const ring = new THREE.Mesh(new THREE.TorusGeometry(18, 4, 10, 24), new THREE.MeshStandardMaterial({ color: 0x8a5cff, emissive: 0x4a2aa0, emissiveIntensity: 0.9 }));
      ring.rotation.x = Math.PI / 2; ring.position.y = 20; g.add(ring);
      const glow = new THREE.PointLight(0x8a5cff, 900, 260, 2); glow.position.y = 22; g.add(glow);
      g.position.set(o.x, 0, o.y); parent.add(g);
    } else if (o.kind === 'stash') {
      // Общий сундук (крупнее обычного, тёмное золото).
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(28, 16, 18), matWood); body.position.y = 8;
      const lid = new THREE.Mesh(new THREE.BoxGeometry(29, 7, 19), matMetal); lid.position.y = 19;
      g.add(body, lid); g.position.set(o.x, 0, o.y); parent.add(g);
    } else if (o.kind === 'shop') {
      // Лавка: стойка + навес.
      const g = new THREE.Group();
      const counter = new THREE.Mesh(new THREE.BoxGeometry(30, 18, 16), matWood); counter.position.y = 9;
      const awning = new THREE.Mesh(new THREE.BoxGeometry(34, 3, 20), new THREE.MeshStandardMaterial({ color: 0x4a8f6a, roughness: 0.8 })); awning.position.y = 34;
      const post = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 34, 6), matWood); post.position.set(14, 17, 0);
      g.add(counter, awning, post); g.position.set(o.x, 0, o.y); parent.add(g);
    }
  }
  if (layout.stairsDown) {
    const g = new THREE.Group();
    for (let i = 0; i < 5; i++) { const s = new THREE.Mesh(new THREE.BoxGeometry(TILE * 0.9, 5, TILE - i * 4), matDark); s.position.set(0, -i * 5 - 2.5, i * 3); g.add(s); }
    g.position.set(layout.stairsDown.x, 0, layout.stairsDown.y); parent.add(g);
  }
  return torches;
}

/**
 * Свет + пламя факелов: пул из TORCH_POOL_N PointLight назначается TORCH_POOL_N БЛИЖАЙШИМ к игроку факелам
 * (мерцание), остальные — интенсивность 0 (но остаются в сцене → число света постоянно, нет перекомпиляции).
 * Пламя анимируем только у СВЕТЯЩИХ (ближних) — дальние в тумане/за кадром замирают (экономим буфер-аплоады).
 * Выбор ближайших — O(pool·torches) без аллокаций (транзиентные d2/on на факеле).
 */
export function updateTorches(torches: Torch[], pool: THREE.PointLight[], px: number, pz: number, t: number, intensity = 1500): void {
  for (const tr of torches) { const dx = tr.x - px, dz = tr.z - pz; tr.d2 = dx * dx + dz * dz; tr.on = false; if (tr.group) tr.group.visible = tr.d2 < FLAME_CULL2; }   // туман-кулинг пламени; свет-маркеры без группы
  for (let k = 0; k < pool.length; k++) {
    let best = -1, bd = Infinity;
    for (let i = 0; i < torches.length; i++) { const tr = torches[i]!; if (!tr.on && tr.d2 < bd) { bd = tr.d2; best = i; } }
    const l = pool[k]!;
    if (best < 0) { l.intensity = 0; continue; }   // источников меньше, чем ламп в пуле
    const tr = torches[best]!; tr.on = true;
    l.position.set(tr.x, tr.y ?? 58, tr.z);
    l.color.setHex(tr.color ?? 0xff7a2a);          // факел — оранжевый по умолчанию; декор-свет — свой цвет из конфига
    l.distance = tr.dist ?? 380;
    const base = tr.intensity ?? intensity;
    const flick = tr.flicker === false ? 1 : (0.78 + Math.sin(t * 11 + tr.base) * 0.12 + Math.random() * 0.12);   // мерцание (tr.base — сид фазы); ровный свет при flicker:false
    l.intensity = base * flick;
  }
  for (const tr of torches) {
    if (!tr.on || !tr.attr || !tr.pos || !tr.life || !tr.seed) continue;   // пламя есть только у факелов; дальние заморожены
    for (let i = 0; i < FLAME_N; i++) {
      let lf = (tr.life[i] ?? 0) + 0.02 + (i % 3) * 0.004; if (lf > 1) lf -= 1; tr.life[i] = lf;
      const spread = lf * 7, b = i * 3, sd = tr.seed[i] ?? 0;
      tr.pos[b] = Math.sin(sd + t * 6) * spread; tr.pos[b + 1] = 52 + lf * 28; tr.pos[b + 2] = Math.cos(sd * 1.3 + t * 6) * spread;
    }
    tr.attr.needsUpdate = true;
  }
}

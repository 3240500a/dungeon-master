/**
 * LIVE-РЕТАРГЕТ: наша ПРОЦЕДУРНАЯ поза (`Humanoid`, rest = identity/T-поза) ведёт кости ИМПОРТНОГО скелета
 * (AccuRIG/CC/Mixamo/Unreal glTF) каждый кадр. Наш риг остаётся драйвером (физика/позы/бег/пределы не трогаем),
 * импортный SkinnedMesh — визуальный слой. ЛЁГКО по CPU: оффсеты (bind-позы) считаются ОДИН РАЗ при загрузке,
 * per-кадр = ~21 кватернион-умножение (без матрична-декомпозиции; НЕ three SkeletonUtils.retarget, он тяжелее).
 *
 * Математика: наш bone rest world = I (T-поза позициями). Хотим, чтобы у цели было ТО ЖЕ мировое вращение-от-rest.
 *   targetWorld = W_src · R_restTarget   (W_src — мировой кватернион нашей кости; R_restTarget — bind цели).
 * Затем в локаль цели: targetLocal = parentTargetWorld⁻¹ · targetWorld. Разница bind-поз учтена R_restTarget.
 */
import * as THREE from 'three';
import { findTwistChains, driveTwistChains, twistReport, type TwistChain } from './twistBones.js';
import { buildHumanoid, type Humanoid } from './humanoid.js';
import { mapFingerBones, allFingerBones, FINGER_CHAINS, FINGER_SEGMENTS } from './boneNames.js';

// Эталонный скелет БЕЗ профиля (дефолтные длины) — знаменатель относительного конформа. Строим один раз.
let _baseH: Humanoid | null = null;
const baseHumanoid = (): Humanoid => { if (!_baseH) { _baseH = buildHumanoid(); _baseH.root.updateMatrixWorld(true); } return _baseH; };

/** Наши 21 гуманоид-кость (порядок родитель→ребёнок) — источник ретаргета. */
export const OUR_BONES = [
  'Hips', 'Spine', 'Chest', 'UpperChest', 'Neck', 'Head',
  'LeftShoulder', 'LeftUpperArm', 'LeftLowerArm', 'LeftHand',
  'RightShoulder', 'RightUpperArm', 'RightLowerArm', 'RightHand',
  'LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot', 'LeftToes',
  'RightUpperLeg', 'RightLowerLeg', 'RightFoot', 'RightToes',
] as const;
export type OurBone = typeof OUR_BONES[number];

/** 30 пальцевых костей (канон Unity Humanoid). НЕ входят в `OUR_BONES` осознанно:
 *  по OUR_BONES итерируют замеры пропорций, T-позное выпрямление и конформ длин — для фаланг всё это
 *  лишнее и вредное («канонического направления пальца» не существует). Пальцы только ВРАЩАЮТСЯ. */
export const OUR_FINGERS: readonly string[] = allFingerBones();
/** Порядок ведения ретаргета: родитель раньше ребёнка (фаланги — дети кисти, поэтому после). */
const DRIVE_ORDER: readonly string[] = [...OUR_BONES, ...OUR_FINGERS];
const IS_FINGER = new Set<string>(OUR_FINGERS);

/**
 * Родитель фаланги в НАШЕЙ цепи (Ф14.2). Нужен ровно для одного — замера офсетов по модели.
 * Без него `measureBoneOffsets` пропускал пальцы, наш скелет падал на хардкод `FINGER_GEO`, и от
 * правильного (замеренного) запястья висела ЧУЖАЯ процедурная кисть.
 * Выпрямление T-позы и конформ длин пальцев по-прежнему НЕ касаются — там они вредны.
 */
export const FINGER_PARENT: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const side of ['Left', 'Right'] as const) {
    for (const ch of FINGER_CHAINS) {
      for (let i = 0; i < 3; i++) {
        out[side + ch + FINGER_SEGMENTS[i]] = i === 0 ? side + 'Hand' : side + ch + FINGER_SEGMENTS[i - 1];
      }
    }
  }
  return out;
})();
/** Родитель любой нашей кости (тело + фаланги) — одна точка правды для замеров. */
export const parentOfOur = (our: string): string | undefined => OUR_PARENT[our as OurBone] ?? FINGER_PARENT[our];

/** Родитель в цепи ретаргета (для конформа длин звеньев: segment = parent→child). */
const OUR_PARENT: Partial<Record<OurBone, OurBone>> = {
  Spine: 'Hips', Chest: 'Spine', UpperChest: 'Chest', Neck: 'UpperChest', Head: 'Neck',
  LeftShoulder: 'UpperChest', LeftUpperArm: 'LeftShoulder', LeftLowerArm: 'LeftUpperArm', LeftHand: 'LeftLowerArm',
  RightShoulder: 'UpperChest', RightUpperArm: 'RightShoulder', RightLowerArm: 'RightUpperArm', RightHand: 'RightLowerArm',
  LeftUpperLeg: 'Hips', LeftLowerLeg: 'LeftUpperLeg', LeftFoot: 'LeftLowerLeg', LeftToes: 'LeftFoot',
  RightUpperLeg: 'Hips', RightLowerLeg: 'RightUpperLeg', RightFoot: 'RightLowerLeg', RightToes: 'RightFoot',
};

// Синонимы имён костей у разных ригов. Сторона детектится ДО стрипа разделителей (иначе _l/_r слипаются с ядром).
const stripPrefix = (s: string): string => s.toLowerCase().replace(/^(cc_base_|mixamorig:?|bip01_?|bip_?|b_|armature\|)/, '');   // b_ = Explosive (B_Pelvis/B_L_UpperArm…)
const SEP = '[_.:| -]';   // разделители сегментов имени кости
// Сторона: явный сегмент l/r (в разделителях или на краях) ЛИБО слово left/right.
const sideOf = (raw: string): '' | 'l' | 'r' => {
  const s = stripPrefix(raw);
  if (/left|lft/.test(s) || new RegExp(`(^|${SEP})l($|${SEP})`).test(s)) return 'l';
  if (/right|rgt/.test(s) || new RegExp(`(^|${SEP})r($|${SEP})`).test(s)) return 'r';
  return '';
};
// Ядро (без стороны и разделителей): убираем left/right и одиночные l/r-сегменты, потом все разделители.
const coreOf = (raw: string): string => stripPrefix(raw)
  .replace(/left|right|lft|rgt/g, '')
  .replace(new RegExp(`(^|${SEP})[lr]($|${SEP})`, 'g'), '$1')
  .replace(/[\s_.:|-]/g, '');
// Ядро-имена (без стороны) → наши кости [центр, левая, правая].
const CORE: Record<string, [OurBone] | [null, OurBone, OurBone]> = {
  hips: ['Hips'], hip: ['Hips'], pelvis: ['Hips'],   // НЕ мапим 'root' на Hips: арм底-рут (RL_BoneRoot/Bip01) стоит у стоп, не таз → ретаргет пинил бы не ту кость (парение)
  // Спина: конвенция Spine/Spine1/Spine2 (Mixamo/Explosive: бара «spine» первая, 1/2 ниже) → Spine/Chest/UpperChest.
  //  Конвенция spine_01/02/03 (Unreal/CC: нумерация с 01) отдельными ключами. Длиннейшее совпадение выигрывает (spine2>spine).
  spine: ['Spine'], spine01: ['Spine'],
  chest: ['Chest'], spine02: ['Chest'], spine1: ['Chest'],
  upperchest: ['UpperChest'], spine03: ['UpperChest'], spine2: ['UpperChest'], spine3: ['UpperChest'],
  neck: ['Neck'], necktwist01: ['Neck'], head: ['Head'],
  shoulder: [null, 'LeftShoulder', 'RightShoulder'], clavicle: [null, 'LeftShoulder', 'RightShoulder'],
  upperarm: [null, 'LeftUpperArm', 'RightUpperArm'], arm: [null, 'LeftUpperArm', 'RightUpperArm'],
  forearm: [null, 'LeftLowerArm', 'RightLowerArm'], lowerarm: [null, 'LeftLowerArm', 'RightLowerArm'], foarm: [null, 'LeftLowerArm', 'RightLowerArm'],
  hand: [null, 'LeftHand', 'RightHand'],
  thigh: [null, 'LeftUpperLeg', 'RightUpperLeg'], upleg: [null, 'LeftUpperLeg', 'RightUpperLeg'], upperleg: [null, 'LeftUpperLeg', 'RightUpperLeg'],
  calf: [null, 'LeftLowerLeg', 'RightLowerLeg'], shin: [null, 'LeftLowerLeg', 'RightLowerLeg'], leg: [null, 'LeftLowerLeg', 'RightLowerLeg'], lowerleg: [null, 'LeftLowerLeg', 'RightLowerLeg'],
  foot: [null, 'LeftFoot', 'RightFoot'], ankle: [null, 'LeftFoot', 'RightFoot'],
  toe: [null, 'LeftToes', 'RightToes'], toebase: [null, 'LeftToes', 'RightToes'], ball: [null, 'LeftToes', 'RightToes'],
};

/** Авто-карта: имена костей импорт-скелета → наши имена (эвристика по названиям; правится вручную в редакторе).
 *  Пальцы мапятся ОТДЕЛЬНЫМ разбором (`boneNames.mapFingerBones`): у них свои конвенции сегментов,
 *  которые плоская таблица подстрок разобрать не может (4 сегмента у Mixamo, Metacarpal у VRM и т.д.). */
export function autoBoneMap(importedBoneNames: string[]): Record<string, string> {
  const out = {} as Record<string, string>;
  // Кость считается пальцем только если она РЕАЛЬНО заняла слот в карте пальцев, а не «похожа на палец».
  // Иначе любое ложное срабатывание синонима ТИХО выкидывает настоящую кость из основной карты.
  const fingers = mapFingerBones(importedBoneNames);
  const fingerRaw = new Set(Object.values(fingers));
  for (const raw of importedBoneNames) {
    if (fingerRaw.has(raw)) continue;           // уже разобрана как фаланга
    const side = sideOf(raw); const core = coreOf(raw);
    // ищем ядро как подстроку (самое длинное совпадение — точнее)
    let best: string | null = null;
    for (const key of Object.keys(CORE)) if (core.includes(key) && (!best || key.length > best.length)) best = key;
    if (!best) continue;
    const map = CORE[best]!;
    const our = map.length === 1 ? map[0]! : (side === 'r' ? map[2]! : map[1]!);   // центр / L / R
    if (our && !out[our]) out[our] = raw;   // первое совпадение выигрывает (двойников избегаем)
  }
  Object.assign(out, fingers);
  return out;
}

/** Отчёт по покрытию карты — чтобы редактор говорил «смаплено 48/52», а не молча терял кости. */
export function boneMapReport(map: Record<string, string>): { core: number; coreTotal: number; fingers: number; missing: string[] } {
  const missing = OUR_BONES.filter((b) => !map[b]);
  return {
    core: OUR_BONES.length - missing.length, coreTotal: OUR_BONES.length,
    fingers: OUR_FINGERS.filter((b) => map[b]).length, missing,
  };
}

export interface RetargetRig {
  root: THREE.Object3D;                              // корень импортной модели (добавить в сцену)
  drive(source: Humanoid): void;                     // per-кадр: наша поза → импортный скелет + позиция от Hips
  boneMap: Record<string, string>;                   // наша кость → имя кости цели
  setBone(our: OurBone, targetName: string): void;   // ручная правка карты (пересчёт оффсета)
  targetBoneNames(): string[];
  targetBone(our: string): THREE.Object3D | null;    // кость ИМПОРТНОГО скелета по нашему имени (для крепления оружия к видимой кисти)
  twistBones(): { bone: string; gain: number }[];    // найденные твист-кости и их доли оборота (диагностика)
  dispose(): void;
}

const _q = new THREE.Quaternion(), _pq = new THREE.Quaternion(), _sw = new THREE.Quaternion(), _v = new THREE.Vector3();
const _wp = new THREE.Vector3(), _m = new THREE.Matrix4();   // для позиц-ведения костей (точное совпадение суставов)
const IDENT = new THREE.Quaternion();

/** Кости ЗАГРУЖЕННОЙ модели имя→кость. CC/AccuRIG glTF часто дублирует имена: реальная ДРАЙВ-иерархия
 *  (RL_BoneRoot→…→Upperarm→Forearm→…, вращаешь её — двигается меш) плюс отдельные ЛИСТЬЯ-референсы skin.joints, висящие под
 *  ней (напр. 204 нода при 100 skin.joints). Обычный traverse-byName (last-wins) может резолвить лист (нет детей → вращение
 *  впустую) → замеры/аим/ретаргет бьют мимо. Берём кость С КОСТЯМИ-ДЕТЬМИ (узел реальной иерархии), иначе — последнюю. */
export function boneIndex(loaded: THREE.Object3D): Map<string, THREE.Bone> {
  const cand = new Map<string, THREE.Bone[]>();
  loaded.traverse((o) => { if ((o as THREE.Bone).isBone) { const a = cand.get(o.name) ?? []; a.push(o as THREE.Bone); cand.set(o.name, a); } });
  // Анимация-ФБХ без скина (Explosive и т.п.): нет isBone → «кости» = именованные Object3D-узлы. Собираем не-меш узлы как
  // кандидатов (Bone структурно = Object3D; используются только getWorld*/quaternion/parent/children). Дубль-логика ниже целится.
  if (cand.size === 0) loaded.traverse((o) => { if (o.name && !(o as THREE.Mesh).isMesh) { const a = cand.get(o.name) ?? []; a.push(o as unknown as THREE.Bone); cand.set(o.name, a); } });   // isMesh покрывает и SkinnedMesh
  const m = new Map<string, THREE.Bone>();
  for (const [name, arr] of cand) {
    const withKids = arr.find((b) => b.children.some((c) => (c as THREE.Bone).isBone || !!(c as THREE.Object3D).name));   // узел реальной иерархии (кость ИЛИ именованный узел)
    m.set(name, withKids ?? arr[arr.length - 1]!);
  }
  return m;
}

/** Снять ПЕР-КОСТНЫЕ множители длины с импорт-ФБХ (относительно ДЕФОЛТНОГО скелета, нормируя на осевую длину тела).
 *  Наш процедурный скелет, построенный с этими scale (buildHumanoid.boneScale), ПОВТОРЯЕТ пропорции модели 1:1 →
 *  физ-аватар совпадает с мешем. Ось-инвариантно (мировые расстояния сегментов, поза/ось не важны). Правую сторону
 *  buildHumanoid зеркалит с левой (boneScaleOf), поэтому меряем по нашим 22 костям как есть. */
export function measureBoneScales(loaded: THREE.Object3D, boneMap: Record<string, string>): Record<string, number> {
  loaded.updateMatrixWorld(true);
  const byName = boneIndex(loaded);
  const base = baseHumanoid();
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  const segF: Record<string, number> = {}, segB: Record<string, number> = {};
  for (const our of OUR_BONES) {
    const p = OUR_PARENT[our]; if (!p) continue;
    const cb = byName.get(boneMap[our] ?? ''), pb = byName.get(boneMap[p] ?? '');
    const bc = base.bones.get(our), bp = base.bones.get(p);
    if (cb && pb) segF[our] = cb.getWorldPosition(a).distanceTo(pb.getWorldPosition(b));
    if (bc && bp) segB[our] = bc.getWorldPosition(a).distanceTo(bp.getWorldPosition(b));
  }
  const AXIAL = ['LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot', 'Spine', 'Chest', 'UpperChest', 'Neck', 'Head'];   // ось-инвариантный масштаб тела
  const refF = AXIAL.reduce((t, k) => t + (segF[k] ?? 0), 0), refB = AXIAL.reduce((t, k) => t + (segB[k] ?? 0), 0);
  const out: Record<string, number> = {};
  if (refF > 1e-3 && refB > 1e-3) for (const our of OUR_BONES) { const f = segF[our], bs = segB[our]; if (f && bs) out[our] = +(((f / refF) / (bs / refB)).toFixed(3)); }
  return out;
}

/** Снять ПОЛНЫЕ rest-ОФСЕТЫ костей ФБХ (вектор направление+длина в НАШЕЙ Y-up системе, нормировано к росту ~57u) →
 *  наш скелет строится ИМИ (buildHumanoid.boneOffsets) и повторяет геометрию ФБХ 1:1 (в отличие от boneScale-скаляра,
 *  который искажал направление: узкий-вниз хип-джойнт ФБХ превращался в широкий). ФБХ риганы в T-позе → офсеты
 *  переносятся в наши T-позные без миграции. Авто-детект Z-up (CC/AccuRIG) → доворот. Hips = высота таза (заземление). */
export function measureBoneOffsets(loaded: THREE.Object3D, boneMap: Record<string, string>): Record<string, [number, number, number]> {
  const r0 = loaded.rotation.clone();
  loaded.rotation.set(0, 0, 0); loaded.updateMatrixWorld(true);
  const byName = boneIndex(loaded);
  const w = (our: string): THREE.Vector3 | null => { const b = byName.get(boneMap[our] ?? ''); return b ? b.getWorldPosition(new THREE.Vector3()) : null; };
  const hip0 = w('Hips'), head0 = w('Head');
  // ЗНАКО-ЗАВИСИМЫЙ доворот к Y-up: +Z-up→−90°X, −Z-up→+90°X (CC/AccuRIG обычно −Z, иначе замер вверх ногами), перевёрнутый Y→180°X.
  if (hip0 && head0) { const dy = head0.y - hip0.y, dz = head0.z - hip0.z; const ax = Math.abs(dz) > Math.abs(dy) ? (dz > 0 ? -Math.PI / 2 : Math.PI / 2) : (dy < 0 ? Math.PI : 0); if (ax) { loaded.rotation.set(ax, 0, 0); loaded.updateMatrixWorld(true); } }
  const hip = w('Hips'), head = w('Head'), foot = w('LeftFoot');
  const fbxH = (head && foot) ? (head.y - foot.y) : 0;
  // Нормировка к РАЗМАХУ БАЗОВОГО РИГА (голова→лодыжка), а не к литералу 57: 57 — это Y головы, а размах
  // базы = 56, и любой импорт получался на 1.8% крупнее базы. Пропорции модели нормировка сохраняет
  // (один множитель на всё), абсолютный размер всё равно задаёт `scaleToSource` при сборке рига.
  const scale = fbxH > 1e-3 ? baseSpanY() / fbxH : 1;
  const out: Record<string, [number, number, number]> = {};
  const legDrop = (hip && foot) ? (hip.y - foot.y) * scale : 32;
  const chain = [...OUR_BONES, ...OUR_FINGERS] as string[];

  // ── ШАГ 1: мировые позиции СМАПЛЕННЫХ костей в нормированном масштабе ────────────────────────────
  const pos = new Map<string, THREE.Vector3>();
  for (const our of chain) { const p = w(our); if (p) pos.set(our, p.multiplyScalar(scale)); }

  // ── ШАГ 2: НЕСМАПЛЕННЫЕ ПРОМЕЖУТОЧНЫЕ — интерполяция по долям базового рига ─────────────────────
  // Зачем: у CC/AccuRIG всего два спайна, `UpperChest` не мапится — и раньше это молча убивало офсеты
  // ВСЕХ его детей (`Neck`, обе ключицы), потому что цикл делал `continue` при несмапленном родителе.
  // Замерено на knight_05: 4 кости из 22 падали на хардкод-таблицу ровно посреди торса.
  // Делаем как FK-цепи в UE: недостающее звено ставится по ДОЛЕ ДЛИНЫ вдоль отрезка «ближайший
  // смапленный предок → ближайший смапленный потомок», доля берётся из базового рига.
  const kids = new Map<string, string[]>();
  for (const our of chain) { const p = parentOfOur(our); if (p) (kids.get(p) ?? kids.set(p, []).get(p)!).push(our); }
  for (const our of chain) {
    if (pos.has(our) || our === 'Hips') continue;
    let anc = parentOfOur(our); while (anc && !pos.has(anc)) anc = parentOfOur(anc);
    if (!anc) continue;
    let dsc: string | undefined;                          // первый смапленный потомок вниз по цепи
    for (let q: string[] = kids.get(our) ?? [], guard = 0; q.length && guard < 8; guard++) {
      const hit = q.find((n) => pos.has(n)); if (hit) { dsc = hit; break; }
      q = q.flatMap((n) => kids.get(n) ?? []);
    }
    if (!dsc) continue;
    const full = baseDist(anc, dsc), part = baseDist(anc, our);
    if (!(full > 1e-6)) continue;
    pos.set(our, pos.get(anc)!.clone().lerp(pos.get(dsc)!, Math.min(1, part / full)));
  }

  // ── ШАГ 3: офсеты = разница с родителем ─────────────────────────────────────────────────────────
  // Ф14.2: пальцы ЗАМЕРЯЕМ (позиции и длины — из модели), но НЕ выпрямляем и не конформим.
  const baseAnkle = baseAnkleY();
  for (const our of chain) {
    if (our === 'Hips') { out['Hips'] = [0, +(legDrop + baseAnkle).toFixed(2), 0]; continue; }   // высота таза = дроп ноги + высота лодыжки базы
    const p = parentOfOur(our); if (!p) continue;
    const c = pos.get(our), pp = pos.get(p);
    if (c && pp) out[our] = [+((c.x - pp.x)).toFixed(2), +((c.y - pp.y)).toFixed(2), +((c.z - pp.z)).toFixed(2)].map(Number) as [number, number, number];
  }
  loaded.rotation.copy(r0); loaded.updateMatrixWorld(true);
  return out;
}

/** Размах базового рига голова→лодыжка (эталон нормировки) и высота лодыжки над корнем. */
const _bw = new THREE.Vector3(), _bw2 = new THREE.Vector3();
function baseSpanY(): number {
  const b = baseHumanoid();
  const h = b.bones.get('Head')!.getWorldPosition(_bw).y, f = b.bones.get('LeftFoot')!.getWorldPosition(_bw2).y;
  return h - f;
}
function baseAnkleY(): number { return baseHumanoid().bones.get('LeftFoot')!.getWorldPosition(_bw).y; }
/** Расстояние между костями в БАЗОВОМ риге (доли для интерполяции недостающих звеньев). */
function baseDist(a: string, b: string): number {
  const h = baseHumanoid(); const ba = h.bones.get(a), bb = h.bones.get(b);
  return ba && bb ? ba.getWorldPosition(_bw).distanceTo(bb.getWorldPosition(_bw2)) : 0;
}

// «Enforce T-pose» — какую кость к какому ребёнку прицеливаем. По умолчанию ТОЛЬКО руки (главный источник A-позы в
// AccuRIG/CC; ноги/спину атласа не трогаем — там точная геометрия под конформ, канонизация коленей их бы поехала).
const AIM_CHILD: Partial<Record<OurBone, OurBone>> = {
  LeftShoulder: 'LeftUpperArm', LeftUpperArm: 'LeftLowerArm', LeftLowerArm: 'LeftHand',
  RightShoulder: 'RightUpperArm', RightUpperArm: 'RightLowerArm', RightLowerArm: 'RightHand',
};
/** Полная цепочка (руки+ноги+спина) — для ЗАПЕКАТЕЛЯ КЛИПОВ: приводим ЛЮБУЮ начальную позу источника анимации к канон-T
 *  перед снятием rest (иначе обратный ретаргет считает дельты от кадра-0/A-позы → «тело в T, руки/ноги мельницей»). Hips
 *  (корень) не целим. НЕ для атласа — там нужна точная геометрия ног/спины. */
export const FULL_AIM_CHILD: Partial<Record<OurBone, OurBone>> = {
  Spine: 'Chest', Chest: 'UpperChest', UpperChest: 'Neck', Neck: 'Head',
  LeftShoulder: 'LeftUpperArm', LeftUpperArm: 'LeftLowerArm', LeftLowerArm: 'LeftHand',
  RightShoulder: 'RightUpperArm', RightUpperArm: 'RightLowerArm', RightLowerArm: 'RightHand',
  LeftUpperLeg: 'LeftLowerLeg', LeftLowerLeg: 'LeftFoot', LeftFoot: 'LeftToes',
  RightUpperLeg: 'RightLowerLeg', RightLowerLeg: 'RightFoot', RightFoot: 'RightToes',
};

/** «Enforce T-pose» (как кнопка в настройке аватара Unity): доворачивает кости ЗАГРУЖЕННОГО скелета в нашу КАНОНИЧЕСКУЮ позу,
 *  независимо от того, в какой позе модель отдал AccuRIG/CC (A/T, скелет чуть гуляет от модели к модели — идеала не бывает).
 *  Прицеливаем НАПРАВЛЕНИЕ каждой кости (сустав→ребёнок) к канон-направлению (baseHumanoid), сверху вниз. Меняем ТОЛЬКО
 *  локальные повороты костей — up-axis/меш/скин не трогаем. Зовётся при импорте (poseModelsTab) ПОСЛЕ skeleton.pose() и ДО
 *  measureBoneOffsets/exportGLB → экспортный GLB несёт T-позу в нодах, замеры читают T, рантайм грузит уже T (как рыцарь).
 *  По умолчанию правим руки (AIM_CHILD). Локальные повороты инвариантны к ориентации корня → up-axis остаётся как был. */
export function enforceTPose(loaded: THREE.Object3D, boneMap: Record<string, string>, aimChild: Partial<Record<OurBone, OurBone>> = AIM_CHILD): void {
  const r0 = loaded.rotation.clone();
  loaded.rotation.set(0, 0, 0); loaded.updateMatrixWorld(true);
  const byName = boneIndex(loaded);
  const wp = (our: string): THREE.Vector3 | null => { const b = byName.get(boneMap[our] ?? ''); return b ? b.getWorldPosition(new THREE.Vector3()) : null; };
  // Временный up-fix к Y-up (та же логика, что в measureBoneOffsets) — чтобы канон-направления совпали по осям. Восстановим в конце.
  const hip0 = wp('Hips'), head0 = wp('Head');
  if (hip0 && head0) { const dy = head0.y - hip0.y, dz = head0.z - hip0.z; const ax = Math.abs(dz) > Math.abs(dy) ? (dz > 0 ? -Math.PI / 2 : Math.PI / 2) : (dy < 0 ? Math.PI : 0); if (ax) { loaded.rotation.set(ax, 0, 0); loaded.updateMatrixWorld(true); } }
  const base = baseHumanoid();
  const cur = new THREE.Vector3(), can = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3();
  const qw = new THREE.Quaternion(), curW = new THREE.Quaternion(), pw = new THREE.Quaternion();
  for (const our of Object.keys(aimChild) as OurBone[]) {
    const child = aimChild[our]; if (!child) continue;
    const ob = byName.get(boneMap[our] ?? ''), cb = byName.get(boneMap[child] ?? '');
    const sb = base.bones.get(our), scb = base.bones.get(child);
    if (!ob || !cb || !sb || !scb) continue;
    loaded.updateMatrixWorld(true);
    cur.copy(cb.getWorldPosition(b)).sub(ob.getWorldPosition(a)); if (cur.lengthSq() < 1e-9) continue; cur.normalize();   // текущее мир-направление кости
    can.copy(scb.getWorldPosition(b)).sub(sb.getWorldPosition(a)).normalize();                                          // канон-направление (эталон)
    qw.setFromUnitVectors(cur, can);                       // мир-доворот cur→can
    ob.getWorldQuaternion(curW); qw.multiply(curW);        // qw = новый мировой кватернион кости
    (ob.parent ? ob.parent.getWorldQuaternion(pw) : pw.identity());
    ob.quaternion.copy(pw.invert().multiply(qw));          // → в локаль родителя
    ob.updateMatrixWorld(true);
  }
  loaded.rotation.copy(r0); loaded.updateMatrixWorld(true);
}

/** Собрать ретаргет-риг из загруженной сцены (glTF/FBX) + карты костей. `scale` нормализует размер (наш TILE=32u=1м).
 *  `source` (опц.) — КОНФОРМ: длины звеньев импорта подгоняются под длины скелета source (наш риг с профилем) →
 *  повороты ложатся 1:1, меш морфится под пропорции source, контакты (стопы/кисти) совпадают. */
export function makeRetargetRig(loaded: THREE.Object3D, boneMap: Record<string, string>, scale = 1, source?: Humanoid): RetargetRig {
  loaded.scale.setScalar(scale);
  loaded.updateMatrixWorld(true);
  const byName = boneIndex(loaded);
  // КОНФОРМ ДЛИН к source (наш скелет). source строится с boneScale, снятым с ЭТОГО ЖЕ ФБХ (measureBoneScales) →
  // source ПОВТОРЯЕТ пропорции ФБХ → конформ = почти идентичность, но добивает ФБХ ТОЧНО на кости source (устраняет
  // остаток нормировки/масштаба) → меш ложится на физ-аватар 1:1. Множитель = srcLen/impLen. Порядок родитель→ребёнок.
  if (source) {
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    // Ф15.1: ФАЛАНГИ ТОЖЕ. Раньше цикл шёл только по телу, и морф ехал на наши пальцы, но не на пальцы
    // модели — замерено: тело сходилось ×1.000, а пальцы оставались ×1.06. Наша геометрия фаланг больше
    // не «прикидка» (Ф14.2 замеряет её с модели), поэтому конформить их безопасно и нужно.
    for (const our of [...OUR_BONES, ...OUR_FINGERS] as string[]) {
      const p = parentOfOur(our); if (!p) continue;
      const cb = byName.get(boneMap[our] ?? ''), pb = byName.get(boneMap[p] ?? '');
      const sc2 = source.bones.get(our), sp = source.bones.get(p);
      if (!cb || !pb || !sc2 || !sp) continue;
      loaded.updateMatrixWorld(true);
      const impLen = cb.getWorldPosition(a).distanceTo(pb.getWorldPosition(b));
      const srcLen = sc2.getWorldPosition(a).distanceTo(sp.getWorldPosition(b));
      if (impLen > 1e-3 && srcLen > 1e-3) {
        // Масштабируем ВЕСЬ под-сегмент cb..pb, включая ПРОМЕЖУТОЧНЫЕ кости ФБХ (Waist между Hip↔Spine01,
        // NeckTwist02 между NeckTwist01↔Head и т.п.). Раньше масштабировали только cb → промежуточные оставались
        // родной длины → остаток ~3u по спине/голове. Идём вверх cb→pb (не включая pb), максимум 8 шагов (страховка).
        const ratio = srcLen / impLen;
        let node: THREE.Object3D | null = cb;
        for (let step = 0; node && node !== pb && step < 8; step++) { node.position.multiplyScalar(ratio); node = node.parent; }
      }
    }
    loaded.updateMatrixWorld(true);
  }
  const restW = new Map<string, THREE.Quaternion>();   // bind мировой кватернион цели (оффсет, считается ОДИН РАЗ)
  const bake = (targetName: string): void => { const b = byName.get(targetName); if (b) restW.set(targetName, b.getWorldQuaternion(new THREE.Quaternion())); };
  for (const t of Object.values(boneMap)) bake(t);
  let hipRestY = 0; { const h = boneMap['Hips'] && byName.get(boneMap['Hips']); if (h) hipRestY = h.getWorldPosition(new THREE.Vector3()).y; }
  // ТВИСТ-КОСТИ модели (CC: `..._UpperarmTwist01/02`, `ForearmTwist`, `ThighTwist`, `CalfTwist`). Снимаются ЗДЕСЬ,
  // в бинд-позе: доли и оси берутся из фактических позиций. Их нет — массив пуст, поведение как раньше.
  const twistChains: TwistChain[] = findTwistChains(byName as Map<string, THREE.Object3D>, boneMap);
  const posDrive = !!source;   // conform (атлас/игра): ведём и ПОЗИЦИИ костей → меш подтягивается к КАНОН-скелету (руки горизонт,
  //   ноги вертикально) через плавную деформацию скина, независимо от бинда (A/T) модели. Длины уже сконформлены (блок выше).

  function drive(driver: Humanoid): void {
    driver.root.updateMatrixWorld(true);
    // Корень импорта на мир-таз источника — непривязанные кости (twist/Waist/пальцы) следуют иерархии.
    const hips = driver.bones.get('Hips'); if (hips) { hips.getWorldPosition(_v); loaded.position.set(_v.x, _v.y - hipRestY, _v.z); }
    loaded.updateMatrixWorld(true);
    // порядок родитель→ребёнок → parentWorld цели уже обновлён к моменту ребёнка (фаланги — после кисти)
    for (const our of DRIVE_ORDER) {
      const tName = boneMap[our]; if (!tName) continue;
      const tb = byName.get(tName); const sb = driver.bones.get(our); const rt = restW.get(tName);
      if (!tb || !sb || !rt) continue;
      sb.getWorldQuaternion(_q);                       // W_src
      _q.multiply(rt);                                 // targetWorld = W_src · R_restTarget
      const pw = tb.parent ? tb.parent.getWorldQuaternion(_pq) : _pq.copy(IDENT);
      tb.quaternion.copy(pw.invert().multiply(_q));    // ориентация → локаль цели
      // ПОЗИЦ-ВЕДЕНИЕ (conform): мир-позиция кости меша = мир-позиция кости КАНОН-скелета → суставы совпадают, меш ложится на
      // канон-аватар 1:1 (руки/ноги из бинд-позы A подтягиваются к канон-T плавной деформацией скина, БЕЗ спайка — длины уже
      // сконформлены). Непривязанные кости (twist/пальцы) остаются на иерархии.
      // Пальцам позиц-ведение НЕ даём: длины фаланг уже сконформлены (Ф15.1), а позиц-ведение сверху
      // тянуло бы суставы кисти на НАШ разброс пальцев (веер ладони у каждой модели свой).
      // Пальцы только вращаются — раскладка кисти остаётся родной.
      if (posDrive && tb.parent && !IS_FINGER.has(our)) { sb.getWorldPosition(_wp); _m.copy(tb.parent.matrixWorld).invert(); tb.position.copy(_wp).applyMatrix4(_m); }
      tb.updateMatrixWorld(false);                     // дети прочитают верный parentWorld
    }
    // ⚠ ПОСЛЕ основных костей: оборот сегмента растягивается по твист-костям, иначе меш скручивает «фантиком»
    // в одной точке (жалоба на замахе топором — плечу нужен полный оборот). Подробности — в `twistBones.ts`.
    driveTwistChains(twistChains, driver);
  }

  return {
    root: loaded, boneMap, drive,
    targetBoneNames: () => [...byName.keys()],
    twistBones: () => twistReport(twistChains),   // диагностика: какие твисты найдены и с какой долей
    targetBone: (our) => byName.get(boneMap[our] ?? '') ?? null,   // импортная кость по нашему имени
    setBone(our, targetName) { boneMap[our] = targetName; bake(targetName); },
    dispose() { loaded.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); }); },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ОБРАТНЫЙ РЕТАРГЕТ (запекатель клипов): анимированный ИМПОРТ-скелет → повороты НАШИХ костей.
// Инверсия makeRetargetRig: там targetLocal = pwᵀ⁻¹·(W_src·R_restTarget); решаем относительно W_src.
//   W_target = pwᵀ·targetLocal (мировой кватернион кости цели после кадра анимации)
//   W_our    = W_target · R_restTarget⁻¹        (наш риг rest-world = I → это и есть мировое вращение нашей кости)
//   localOur = parentOurWorld⁻¹ · W_our         (в локаль; parentOurWorld берём из УЖЕ посчитанных костей — сверху вниз)
// R_restTarget = бинд-мировой кватернион цели (captured ОДИН РАЗ на bind-позе, ДО проигрывания анимации).
// Точный обратный ход к drive → round-trip forward∘inverse ≈ identity (см. retarget3d.test.ts). Наследует
// систему координат makeRetargetRig: источник (наш риг) — канон Y-up/+Z, поэтому импорт нормализуй в Y-up ДО запекания.
// ─────────────────────────────────────────────────────────────────────────────
export interface BakeRig {
  boneMap: Record<string, string>;
  restW: Map<string, THREE.Quaternion>;               // бинд-мировые кватернионы цели (оффсет T-поз)
  /**
   * Снять ТЕКУЩУЮ позу импорт-скелета (после кадра анимации) в наши кости (пишет dst.bones[*].quaternion).
   * `fingers` — снимать ли ещё и 30 фаланг (мокап-хват). По умолчанию нет: у большинства мокапов пальцев
   * в треках нет вовсе, а наш хват авторится покадрово (`gripPoses.ts`) и мусорные фаланги его перетёрли бы.
   */
  sampleInto(dst: Humanoid, fingers?: boolean): void;
  /**
   * Смещение ТАЗА текущего кадра относительно бинда, пересчитанное в НАШИ юниты (по отношению высот таза).
   * `feetRelative` — вычесть среднюю ГОРИЗОНТАЛЬ стоп, то есть мерить таз ОТНОСИТЕЛЬНО ОПОРЫ: тогда перенос
   * веса (ноги стоят, таз ходит вперёд-назад) остаётся, а настоящий травел (бег, который едет вперёд)
   * вычитается ПО ПОСТРОЕНИЮ — без порогов и эвристик «это уже рут-моушен или ещё нет».
   * Вертикаль не трогаем никогда: присед/подскок — это движение тела, а не перенос персонажа.
   */
  /**
   * СЫРОЕ смещение таза от бинда, УЖЕ пересчитанное в наши юниты. Ничего не вычитает.
   * ⚠ Раньше здесь же вычиталась «опора» (средняя горизонталь стоп). ЗАМЕР показал, что это неверно
   * в принципе: у in-place источника таз стоит (0 на всех кадрах), едут только стопы, и любое покадровое
   * вычитание опоры ВЫДУМЫВАЕТ качание таза (среднее по двум стопам дало 3.95 юнита, по опорной — 21.7,
   * при истинных 0.00). Травел снимается ТРЕНДОМ по всему клипу — `footLock.detrendTravel`.
   */
  sampleHipsDelta(dst: Humanoid): [number, number, number] | null;
}

/** Собрать запекатель из импорт-скелета + карты костей. `restW` снимается ЗДЕСЬ (loaded должен быть в bind-позе:
 *  вызови `skeleton.pose()` перед конструированием, если модель приходит уже на кадре 0). */
export function makeBakeRig(loaded: THREE.Object3D, boneMap: Record<string, string>): BakeRig {
  // boneIndex: берёт кость-с-детьми (реальная драйв-иерархия) — CC/AccuRIG glTF дублирует скелет, traverse-last-wins попадал
  // в лист-референс (не анимируется микшером) → семпл читал статику → клип схлопывался в бинд/idle. Fallback — traverse (BVH/Group).
  const byName = new Map<string, THREE.Object3D>(boneIndex(loaded));
  if (byName.size === 0) loaded.traverse((o) => { if (o.name && !byName.has(o.name)) byName.set(o.name, o); });   // BVH/Group-риги без isBone
  loaded.updateMatrixWorld(true);
  const restW = new Map<string, THREE.Quaternion>();
  const restP = new Map<string, THREE.Vector3>();               // бинд-мировые ПОЗИЦИИ — точка отсчёта смещения таза
  for (const t of Object.values(boneMap)) {
    const b = byName.get(t); if (!b) continue;
    restW.set(t, b.getWorldQuaternion(new THREE.Quaternion()));
    restP.set(t, b.getWorldPosition(new THREE.Vector3()));
  }

  const _Wt = new THREE.Quaternion(), _rtI = new THREE.Quaternion(), _pwI = new THREE.Quaternion();
  const Wmap = new Map<string, THREE.Quaternion>();
  function sampleInto(dst: Humanoid, fingers = false): void {
    Wmap.clear();
    loaded.updateMatrixWorld(true);
    // Порядок родитель→ребёнок (parentOurWorld уже в Wmap). Фаланги — ПОСЛЕ тела: их родитель по цепочке
    // упирается в кисть, а она снимается в OUR_BONES; `OUR_FINGERS` сам идёт от проксимальной к дистальной.
    for (const our of fingers ? [...OUR_BONES, ...OUR_FINGERS] as string[] : OUR_BONES as readonly string[]) {
      const tName = boneMap[our]; if (!tName) continue;
      const tb = byName.get(tName), rt = restW.get(tName), db = dst.bones.get(our);
      if (!tb || !rt || !db) continue;
      tb.getWorldQuaternion(_Wt);                        // W_target
      const Wour = new THREE.Quaternion().copy(_Wt).multiply(_rtI.copy(rt).invert());   // W_our = W_target·R_restTarget⁻¹
      Wmap.set(our, Wour);
      const pName = parentOfOur(our);
      const pw = pName ? Wmap.get(pName) : undefined;   // мировой нашей родит-кости (или identity для Hips/непривязанных)
      db.quaternion.copy(pw ? _pwI.copy(pw).invert().multiply(Wour) : Wour);            // → локаль (rotation синхронизируется)
    }
  }
  const _hp = new THREE.Vector3();
  function sampleHipsDelta(dst: Humanoid): [number, number, number] | null {
    const hipName = boneMap['Hips']; if (!hipName) return null;
    const hb = byName.get(hipName), hr = restP.get(hipName);
    if (!hb || !hr) return null;
    loaded.updateMatrixWorld(true);
    hb.getWorldPosition(_hp).sub(hr);                            // смещение таза в юнитах ИСТОЧНИКА
    const k = Math.abs(hr.y) > 1e-6 ? dst.hipsRest.y / hr.y : 1; // масштаб источник→наши юниты по высоте таза
    return [_hp.x * k, _hp.y * k, _hp.z * k];
  }
  return { boneMap, restW, sampleInto, sampleHipsDelta };
}

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
 * ⚠⚠ КОСТИ, У КОТОРЫХ БЕРЁМ ТОЛЬКО ПОВОРОТ — ни конформа длины, ни позиц-ведения.
 *
 * НОСОК. Его офсет в нашем риге — ДЕФОЛТ БОЛВАНКИ `[0, −1, 6]` (длина 6.083), а не замер с модели:
 * профиль тела носок не мерит. Пока `LeftToes` по ошибке вёл кость-пустышку `*ShareBone`, конформ
 * настоящий носок не трогал; как только карта починилась, он потянул носок модели под НАШУ ДОГАДКУ —
 * ЗАМЕР: левая стопа→носок 5.553 → **6.698** при правой 5.553, то есть левая стопа стала на 20 %
 * длиннее правой. Ровно то же соображение уже записано у фаланг кисти: «веер ладони у каждой модели
 * свой». Поворот носка при этом ведётся как раньше — ради него всё и чинилось.
 */
const ROT_ONLY = new Set<string>(['LeftToes', 'RightToes']);

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
  // ⚠⚠ ПОБЕЖДАЕТ НЕ ПЕРВЫЙ, А БЛИЖАЙШИЙ К ЯДРУ. Раньше слот занимала ПЕРВАЯ подходящая кость, то есть
  // всё решал порядок костей В ФАЙЛЕ. У CC рядом с настоящей костью лежит вспомогалка скина `*ShareBone`
  // (ЛИСТ, детей нет, вести нечего), и у ЛЕВОЙ ноги она стоит в файле РАНЬШЕ настоящей:
  //   `LeftToes` → `CC_Base_L_ToeBaseShareBone`, а `RightToes` → `CC_Base_R_ToeBase`.
  // ЗАМЕР: поворот носка на +0.8 рад двигал носок модели СПРАВА и не двигал СЛЕВА ВООБЩЕ (0.0000).
  // Видно это стало только когда у носка появился свой канал (`GAIT.toeOff`) — до того кость носка
  // всегда стояла в нуле, и ошибка молчала.
  // Теперь сравниваем «лишние» символы вокруг ядра: `toebase` → 0 против `toebasesharebone` → 9,
  // `thigh` → 0 против `thightwist01` → 7. Равенство → первый, то есть прежнее поведение.
  const pick = new Map<string, { raw: string; slack: number }>();
  for (const raw of importedBoneNames) {
    if (fingerRaw.has(raw)) continue;           // уже разобрана как фаланга
    const side = sideOf(raw); const core = coreOf(raw);
    // ищем ядро как подстроку (самое длинное совпадение — точнее)
    let best: string | null = null;
    for (const key of Object.keys(CORE)) if (core.includes(key) && (!best || key.length > best.length)) best = key;
    if (!best) continue;
    const map = CORE[best]!;
    const our = map.length === 1 ? map[0]! : (side === 'r' ? map[2]! : map[1]!);   // центр / L / R
    if (!our) continue;
    const slack = core.length - best.length;    // сколько символов вокруг ядра: меньше — точнее кость
    const prev = pick.get(our);
    if (!prev || slack < prev.slack) pick.set(our, { raw, slack });
  }
  for (const [our, v] of pick) out[our] = v.raw;
  Object.assign(out, fingers);
  return out;
}

/**
 * Свести АВТО-карту с СОХРАНЁННОЙ (ручная правка в редакторе). Ручной выбор выигрывает — за тем он и
 * сохраняется, — КРОМЕ одного случая: ⚠ **ЛИСТ НЕ ПОДМЕНЯЕТ КОСТЬ-С-ДЕТЬМИ.** У CC рядом с настоящей
 * костью лежит вспомогалка скина `*ShareBone` без детей; СТАРАЯ авто-карта (первый-подходящий) её и
 * выбирала, а редактор потом СОХРАНЯЛ результат — поэтому починки одной эвристики мало: сохранённая
 * карта вернула бы кость-пустышку обратно (замер на `knight_06_modular_rig`: в конфиге лежало
 * `LeftToes: CC_Base_L_ToeBaseShareBone`).
 *
 * Имя, которого в ЭТОМ скелете нет, пропускается и так: экспорт-GLB суффиксит имена (`CC_Base_Hip_4`).
 */
export function mergeBoneMap(auto: Record<string, string>, stored: Record<string, string>, loaded: THREE.Object3D): Record<string, string> {
  const kids = new Map<string, number>();
  // ⚠ НЕ `isBone`: у анимаций-ФБХ без скина «кости» — обычные узлы (см. `skeletonBoneNames`). Меши в счёт
  // детей не идут — кость с одним только мешем в детях остаётся листом.
  loaded.traverse((o) => { if (o.name) kids.set(o.name, o.children.filter((c) => !(c as THREE.Mesh).isMesh).length); });
  const out: Record<string, string> = { ...auto };
  for (const [our, tgt] of Object.entries(stored)) {
    if (!tgt || !kids.has(tgt)) continue;
    const a = out[our];
    if (a && (kids.get(tgt) ?? 0) === 0 && (kids.get(a) ?? 0) > 0) continue;   // лист против кости-с-детьми
    out[our] = tgt;
  }
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
/**
 * УГОЛ ДОВОРОТА К Y-UP по скелету (таз→голова). Одно правило на всех, кто его применял ПО СВОЕЙ КОПИИ
 * (`measureBoneOffsets`, `enforceTPose`) — разъехавшись, они дали бы разные системы координат на одном файле.
 * Знако-зависимо: +Z-up→−90°X, −Z-up→+90°X (CC/AccuRIG обычно −Z), перевёрнутый Y→180°X. 0 — уже Y-up.
 */
export function upAxisAngle(loaded: THREE.Object3D, boneMap: Record<string, string>): number {
  const byName = boneIndex(loaded);
  const w = (our: string): THREE.Vector3 | null => { const b = byName.get(boneMap[our] ?? ''); return b ? b.getWorldPosition(new THREE.Vector3()) : null; };
  // Верх позвоночника: голова, а нет её — шея, нет и шеи — грудь. Так умела копия из `modelSkin`,
  // и это важно для ОТДЕЛЬНЫХ САБМЕШЕЙ: в куске брони головы может не быть вовсе.
  const hip = w('Hips'), head = w('Head') ?? w('Neck') ?? w('Chest');
  if (!hip || !head) {
    // Костей-ориентиров нет — знак определить нечем, судим по габариту: вытянут по Z → это Z-up.
    //
    // ⚠ СНАЧАЛА ПО КОСТЯМ, А ЕСЛИ КОСТЕЙ НЕТ ВООБЩЕ — ПО МЕШАМ. Именно этим и различались две копии
    // этого правила, которые я сводил: одна мерила облако костей (куски брони — там кости есть, а головы
    // нет), другая габарит мешей с запасом 1.4 (ОРУЖИЕ — у него костей нет ни одной). Сведя всё на костную
    // ветку, я сломал импорт оружия: пустая коробка давала 0, и молот приезжал лежащим на боку.
    const bones = new THREE.Box3(); const v = new THREE.Vector3();
    loaded.traverse((o) => { if ((o as THREE.Bone).isBone) bones.expandByPoint(o.getWorldPosition(v)); });
    if (!bones.isEmpty()) return (bones.max.z - bones.min.z) > (bones.max.y - bones.min.y) ? -Math.PI / 2 : 0;
    const box = new THREE.Box3().setFromObject(loaded);
    if (box.isEmpty()) return 0;
    // Запас 1.4 — из ветки оружия: без костей сигнал слабее, и разворачивать стоит только явно лежащее.
    return (box.max.z - box.min.z) > 1.4 * (box.max.y - box.min.y) ? -Math.PI / 2 : 0;
  }
  const dy = head.y - hip.y, dz = head.z - hip.z;
  return Math.abs(dz) > Math.abs(dy) ? (dz > 0 ? -Math.PI / 2 : Math.PI / 2) : (dy < 0 ? Math.PI : 0);
}

/**
 * ⭐ ПРИВЕСТИ МОДЕЛЬ К Y-UP ОДИН РАЗ И НАВСЕГДА (зовётся при импорте, ДО замеров и экспорта).
 *
 * Раньше доворот к Y-up был ВРЕМЕННЫМ: замер поднимал модель, мерил и клал обратно. В итоге файл жил
 * в своей системе (CC отдаёт Z-up), а в нашу его затаскивал ПОЗИЦИОННЫЙ ПРИВОД — покостно, каждый кадр.
 * Что привод не тащит, то и оставалось в чужой системе: ЗАМЕР — пальцы приезжали повёрнутыми на 81°
 * (направление фаланги оказывалось эталоном, повёрнутым ровно на 90° вокруг X). Отсюда «пальцы согнуты в T-позе».
 *
 * И это не наша прихоть: **glTF по спецификации Y-up**, так что Z-up GLB мы и экспортировали неверным.
 * Поворот кладём на корень — валидный glTF-узел; локальные повороты костей к нему инвариантны, меш и скин не трогаем.
 */
export function normalizeUpAxis(loaded: THREE.Object3D, boneMap: Record<string, string>): number {
  const ax = upAxisAngle(loaded, boneMap);
  if (ax) { loaded.rotation.x += ax; loaded.updateMatrixWorld(true); }
  return ax;
}

/**
 * НАСКОЛЬКО РУКИ ОТКЛОНЕНЫ ОТ ГОРИЗОНТАЛИ (градусы, максимум по двум рукам) — МЕРА «T-поза или A-поза».
 *
 * Нужна, чтобы решение «приводить ли к T» принималось по ЗАМЕРУ и автором, а не автоматикой по догадке.
 * Считается в Y-up-фрейме по направлению плечо→предплечье: 0° — идеальная T, ~45° — типичная A-поза.
 * Ничего не меняет.
 */
export function tPoseDeviation(loaded: THREE.Object3D, boneMap: Record<string, string>): number {
  const r0 = loaded.rotation.clone();
  const ax = upAxisAngle(loaded, boneMap);
  if (ax) { loaded.rotation.set(ax, 0, 0); loaded.updateMatrixWorld(true); }
  const byName = boneIndex(loaded);
  const w = (our: string): THREE.Vector3 | null => { const b = byName.get(boneMap[our] ?? ''); return b ? b.getWorldPosition(new THREE.Vector3()) : null; };
  let worst = 0;
  for (const [a, b, sgn] of [['LeftUpperArm', 'LeftLowerArm', 1], ['RightUpperArm', 'RightLowerArm', -1]] as [string, string, number][]) {
    const pa = w(a), pb = w(b); if (!pa || !pb) continue;
    const d = pb.clone().sub(pa); if (d.lengthSq() < 1e-9) continue;
    worst = Math.max(worst, d.normalize().angleTo(new THREE.Vector3(sgn, 0, 0)) * 180 / Math.PI);
  }
  loaded.rotation.copy(r0); loaded.updateMatrixWorld(true);
  return worst;
}

export function measureBoneOffsets(loaded: THREE.Object3D, boneMap: Record<string, string>): Record<string, [number, number, number]> {
  const r0 = loaded.rotation.clone();
  loaded.rotation.set(0, 0, 0); loaded.updateMatrixWorld(true);
  const byName = boneIndex(loaded);
  const w = (our: string): THREE.Vector3 | null => { const b = byName.get(boneMap[our] ?? ''); return b ? b.getWorldPosition(new THREE.Vector3()) : null; };
  { const ax = upAxisAngle(loaded, boneMap); if (ax) { loaded.rotation.set(ax, 0, 0); loaded.updateMatrixWorld(true); } }   // доворот к Y-up — ОДНО правило (`upAxisAngle`)
  const hip = w('Hips'), head = w('Head'), foot = w('LeftFoot');
  // ⚠ КОРЕНЬ АРМАТУРЫ = ПОЛ. У ригов CC/AccuRIG (и везде, где художник кладёт рут в ноль) самый
  // верхний узел скелета стоит ровно на полу — по нему и заземляем, вместо того чтобы подгонять таз
  // под лодыжку НАШЕГО базового рига. Замер на knight_05: рут 0.00, низшая вершина меша −0.00,
  // таз 34.91 — а подгонка давала 33.00, и меш тонул ровно на эти 1.9.
  //
  // ⚠ ИЩЕМ ПО СМЫСЛУ, А НЕ ПО ФЛАГУ `isBone`: в glTF узел становится костью, только если он входит
  // в суставы скина, а служебный рут туда не входит — после нашего же экспорта он приезжает обычным
  // узлом. Поэтому корень арматуры = самый верхний предок таза, В ПОДДЕРЕВЕ КОТОРОГО НЕТ МЕШЕЙ.
  // У ригов без отдельного рута (Mixamo: выше таза сразу сцена с мешами) подъём не случится вовсе,
  // и мы честно уйдём в фолбэк.
  const hipsBone = byName.get(boneMap['Hips'] ?? '');
  const hasMesh = (o: THREE.Object3D): boolean => {
    let found = false;
    o.traverse((c) => { if ((c as THREE.Mesh).isMesh) found = true; });
    return found;
  };
  let rootBone: THREE.Object3D | null = hipsBone ?? null;
  while (rootBone?.parent && rootBone.parent !== loaded && !hasMesh(rootBone.parent)) rootBone = rootBone.parent;
  const rootY = rootBone && rootBone !== hipsBone ? rootBone.getWorldPosition(new THREE.Vector3()).y : null;
  const fbxH = (head && foot) ? (head.y - foot.y) : 0;
  // Нормировка к РАЗМАХУ БАЗОВОГО РИГА (голова→лодыжка), а не к литералу 57: 57 — это Y головы, а размах
  // базы = 56, и любой импорт получался на 1.8% крупнее базы. Пропорции модели нормировка сохраняет
  // (один множитель на всё), абсолютный размер всё равно задаёт `scaleToSource` при сборке рига.
  const scale = fbxH > 1e-3 ? baseSpanY() / fbxH : 1;
  const out: Record<string, [number, number, number]> = {};
  const legDrop = (hip && foot) ? (hip.y - foot.y) * scale : 32;
  /**
   * ВЫСОТА ТАЗА НАД ПОЛОМ. Берём из модели: рут-кость стоит на полу, значит высота таза = `таз − рут`.
   * Фолбэк (рига без отдельного рута — например Mixamo, где верхняя кость и есть Hips) — прежняя
   * формула «дроп ноги + лодыжка базового рига»; она подгоняет модель под нашу геометрию и потому
   * годится только когда спросить у модели нечего.
   *
   * ⚠ Проверяем на вменяемость: рут ОБЯЗАН быть ниже таза и не выше лодыжки. Кривой рут (в центре
   * тела, под потолком) встречается, и молча заземлять по нему — хуже, чем честный фолбэк.
   */
  const rootOk = rootY !== null && hip !== null && foot !== null && hip.y - rootY > 1e-3 && rootY <= foot.y + 1e-3;
  const hipsAboveFloor = rootOk && hip ? (hip.y - rootY!) * scale : legDrop + baseAnkleY();
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
    // ⚠ БЕЗ ОКРУГЛЕНИЯ. Округление до сотых выглядит безобидно, но это ЕДИНСТВЕННЫЙ источник
    // расхождения, который остаётся после починки позы и оси: фаланга длиной 1.4 теряет на нём до
    // 0.4 % длины. ЗАМЕР сквозного аудита: с округлением 4.3e-1 %, без него 6.2e-7 % — машинный ноль.
    if (our === 'Hips') { out['Hips'] = [0, hipsAboveFloor, 0]; continue; }   // высота таза НАД ПОЛОМ — из модели (см. выше)
    const p = parentOfOur(our); if (!p) continue;
    const c = pos.get(our), pp = pos.get(p);
    if (c && pp) out[our] = [c.x - pp.x, c.y - pp.y, c.z - pp.z];
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
  // ⚠ КЛЮЧИЦЫ УБРАНЫ. Ни одно определение T-позы их не выпрямляет: у VRM 1.0 сказано «плечи расслаблены
  // и опущены», у человека ключица идёт вверх-наружу градусов на 13, и ровно на эти 13.3° наше приведение
  // и уводило руку (замер: 3.3 единицы сдвига). Unity в «Enforce T-Pose» ключицу тоже не трогает.
  LeftUpperArm: 'LeftLowerArm', LeftLowerArm: 'LeftHand',
  RightUpperArm: 'RightLowerArm', RightLowerArm: 'RightHand',
};

/**
 * КАНОН-НАПРАВЛЕНИЯ T-ПОЗЫ — В МИРОВЫХ ОСЯХ, А НЕ «КАК У НАШЕЙ БОЛВАНКИ».
 *
 * ⚠ РАДИ ЭТОГО И ЗАВЕДЕНО. Раньше целью служило направление кости в `baseHumanoid()` — нашем ПРОЦЕДУРНОМ
 * манекене-заглушке. То есть скелет художника гнули под пропорции болванки, а не под T-позу: у уже T-позной
 * модели рука «отклонялась» на 15.8° просто потому, что у болванки предплечье смотрит чуть иначе.
 *
 * Определение берём индустриальное (VRM 1.0 `tpose.md`, Definition 1.4): «руки вытянуты вдоль оси X и
 * параллельны земле». Ноги — вниз, позвоночник — вверх. Чего в таблице нет, у того цель по-прежнему
 * берётся из базового рига (так целятся, например, стопы, у которых мировой оси не назначишь).
 */
const CANON_DIR: Partial<Record<OurBone, [number, number, number]>> = {
  LeftUpperArm: [1, 0, 0], LeftLowerArm: [1, 0, 0],
  RightUpperArm: [-1, 0, 0], RightLowerArm: [-1, 0, 0],
  LeftUpperLeg: [0, -1, 0], LeftLowerLeg: [0, -1, 0],
  RightUpperLeg: [0, -1, 0], RightLowerLeg: [0, -1, 0],
  Spine: [0, 1, 0], Chest: [0, 1, 0], UpperChest: [0, 1, 0], Neck: [0, 1, 0],
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
/**
 * ПОРОГ ПРИВЕДЕНИЯ, градусы. Кость, уже стоящую верно, НЕ трогаем вовсе.
 *
 * Взят из Godot (`retarget/rest_fixer/fix_silhouette/threshold`, дефолт 15): без порога доворот
 * применяется ВСЕГДА, даже на расхождении 0.0001°, и генерирует шум ровно того порядка, на который
 * жалуется автор. Наш эталон при этом показывает 13.3° по ключице — то есть при пороге 15° приведение
 * этот файл не тронет ВООБЩЕ, даже если галку включить по ошибке.
 */
export const TPOSE_THRESHOLD_DEG = 15;

export function enforceTPose(loaded: THREE.Object3D, boneMap: Record<string, string>, aimChild: Partial<Record<OurBone, OurBone>> = AIM_CHILD, thresholdDeg = TPOSE_THRESHOLD_DEG): void {
  const r0 = loaded.rotation.clone();
  loaded.rotation.set(0, 0, 0); loaded.updateMatrixWorld(true);
  const byName = boneIndex(loaded);
  const wp = (our: string): THREE.Vector3 | null => { const b = byName.get(boneMap[our] ?? ''); return b ? b.getWorldPosition(new THREE.Vector3()) : null; };
  // Временный up-fix к Y-up (та же логика, что в measureBoneOffsets) — чтобы канон-направления совпали по осям. Восстановим в конце.
  { const ax = upAxisAngle(loaded, boneMap); if (ax) { loaded.rotation.set(ax, 0, 0); loaded.updateMatrixWorld(true); } }   // то же правило
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
    const cd = CANON_DIR[our];
    if (cd) can.set(cd[0], cd[1], cd[2]);                                                                              // канон T-позы в МИРОВЫХ осях
    else can.copy(scb.getWorldPosition(b)).sub(sb.getWorldPosition(a)).normalize();                                    // запасной вариант — базовый риг
    if (cur.angleTo(can) * 180 / Math.PI < thresholdDeg) continue;   // уже стоит верно — не трогаем (порог Godot)
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
      if (ROT_ONLY.has(our)) continue;                 // длину носка НЕ конформим: наша — дефолт болванки (см. ROT_ONLY)
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
      if (posDrive && tb.parent && !IS_FINGER.has(our) && !ROT_ONLY.has(our)) { sb.getWorldPosition(_wp); _m.copy(tb.parent.matrixWorld).invert(); tb.position.copy(_wp).applyMatrix4(_m); }
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

/**
 * НАСКОЛЬКО БИНД-ПОЗА РАСХОДИТСЯ С ПОЗОЙ УЗЛОВ (макс. сдвиг кости, в единицах файла).
 *
 * У аккуратного файла это ноль: узлы и `inverseBindMatrices` описывают одну позу. Расхождение
 * означает, что скелет двигали после привязки, — и тогда важно, ПО КАКОЙ из двух мерить риг.
 * Мерим по узлам (её показывает любой DCC и её автор считает правильной), а это число печатаем,
 * чтобы «файл странный» было видно, а не приходилось выяснять по кривому результату.
 * Ничего не меняет: бинд-позу снимает на копии скелета и возвращает как было.
 */
export function nodeVsBindGap(root: THREE.Object3D): number {
  root.updateMatrixWorld(true);
  const node = new Map<THREE.Object3D, THREE.Vector3>();
  root.traverse((o) => { if ((o as THREE.Bone).isBone) node.set(o, o.getWorldPosition(new THREE.Vector3())); });
  if (!node.size) return 0;
  const saved = new Map<THREE.Object3D, THREE.Matrix4>();
  for (const b of node.keys()) saved.set(b, b.matrix.clone());
  root.traverse((o) => { const s = (o as THREE.SkinnedMesh).skeleton; if (s) s.pose(); });
  root.updateMatrixWorld(true);
  let worst = 0;
  for (const [b, p] of node) worst = Math.max(worst, p.distanceTo(b.getWorldPosition(new THREE.Vector3())));
  for (const [b, m] of saved) { m.decompose(b.position, b.quaternion, b.scale); }
  root.updateMatrixWorld(true);
  return worst;
}

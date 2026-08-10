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
import { buildHumanoid, type Humanoid } from './humanoid.js';

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

/** Родитель в цепи ретаргета (для конформа длин звеньев: segment = parent→child). */
const OUR_PARENT: Partial<Record<OurBone, OurBone>> = {
  Spine: 'Hips', Chest: 'Spine', UpperChest: 'Chest', Neck: 'UpperChest', Head: 'Neck',
  LeftShoulder: 'UpperChest', LeftUpperArm: 'LeftShoulder', LeftLowerArm: 'LeftUpperArm', LeftHand: 'LeftLowerArm',
  RightShoulder: 'UpperChest', RightUpperArm: 'RightShoulder', RightLowerArm: 'RightUpperArm', RightHand: 'RightLowerArm',
  LeftUpperLeg: 'Hips', LeftLowerLeg: 'LeftUpperLeg', LeftFoot: 'LeftLowerLeg', LeftToes: 'LeftFoot',
  RightUpperLeg: 'Hips', RightLowerLeg: 'RightUpperLeg', RightFoot: 'RightLowerLeg', RightToes: 'RightFoot',
};

// Синонимы имён костей у разных ригов. Сторона детектится ДО стрипа разделителей (иначе _l/_r слипаются с ядром).
const stripPrefix = (s: string): string => s.toLowerCase().replace(/^(cc_base_|mixamorig:?|bip01_?|bip_?|armature\|)/, '');
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
  spine: ['Spine'], spine01: ['Spine'], spine1: ['Spine'],
  chest: ['Chest'], spine02: ['Chest'], spine2: ['Chest'],
  upperchest: ['UpperChest'], spine03: ['UpperChest'], spine3: ['UpperChest'],
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

/** Авто-карта: имена костей импорт-скелета → наши имена (эвристика по названиям; правится вручную в редакторе). */
export function autoBoneMap(importedBoneNames: string[]): Record<OurBone, string> {
  const out = {} as Record<OurBone, string>;
  for (const raw of importedBoneNames) {
    const side = sideOf(raw); const core = coreOf(raw);
    // ищем ядро как подстроку (самое длинное совпадение — точнее)
    let best: string | null = null;
    for (const key of Object.keys(CORE)) if (core.includes(key) && (!best || key.length > best.length)) best = key;
    if (!best) continue;
    const map = CORE[best]!;
    const our = map.length === 1 ? map[0]! : (side === 'r' ? map[2]! : map[1]!);   // центр / L / R
    if (our && !out[our]) out[our] = raw;   // первое совпадение выигрывает (двойников избегаем)
  }
  return out;
}

export interface RetargetRig {
  root: THREE.Object3D;                              // корень импортной модели (добавить в сцену)
  drive(source: Humanoid): void;                     // per-кадр: наша поза → импортный скелет + позиция от Hips
  boneMap: Record<string, string>;                   // наша кость → имя кости цели
  setBone(our: OurBone, targetName: string): void;   // ручная правка карты (пересчёт оффсета)
  targetBoneNames(): string[];
  dispose(): void;
}

const _q = new THREE.Quaternion(), _pq = new THREE.Quaternion(), _sw = new THREE.Quaternion(), _v = new THREE.Vector3();
const IDENT = new THREE.Quaternion();

/** Собрать ретаргет-риг из загруженной сцены (glTF/FBX) + карты костей. `scale` нормализует размер (наш TILE=32u=1м).
 *  `source` (опц.) — КОНФОРМ: длины звеньев импорта подгоняются под длины скелета source (наш риг с профилем) →
 *  повороты ложатся 1:1, меш морфится под пропорции source, контакты (стопы/кисти) совпадают. */
export function makeRetargetRig(loaded: THREE.Object3D, boneMap: Record<string, string>, scale = 1, source?: Humanoid): RetargetRig {
  loaded.scale.setScalar(scale);
  loaded.updateMatrixWorld(true);
  const byName = new Map<string, THREE.Bone>();
  loaded.traverse((o) => { if ((o as THREE.Bone).isBone) byName.set(o.name, o as THREE.Bone); });
  // КОНФОРМ ДЛИН — ОТНОСИТЕЛЬНЫЙ (профиль как множитель поверх РОДНЫХ длин ФБХ, НЕ подгон под наш скелет).
  // Множитель звена = srcLen/baseLen = (длина сегмента source-профиля)/(длина того же сегмента ДЕФОЛТНОГО скелета)
  // = сам множитель профиля (arm/leg/torso/height). При профиле=1 → ×1 → импорт-скелет НЕ трогаем (родные пропорции
  // художника, как в 3ds Max). Раньше делили на impLen (длину ФБХ) → ФБХ абсолютно переформовывался в наши пропорции
  // (при 1 куцые руки/ноги — «манекен»). Порядок родитель→ребёнок; длина поза-инвариантна.
  if (source) {
    const base = baseHumanoid();
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    for (const our of OUR_BONES) {
      const p = OUR_PARENT[our]; if (!p) continue;
      const cb = byName.get(boneMap[our] ?? '');
      const sc2 = source.bones.get(our), sp = source.bones.get(p);
      const bc = base.bones.get(our), bp = base.bones.get(p);
      if (!cb || !sc2 || !sp || !bc || !bp) continue;
      const srcLen = sc2.getWorldPosition(a).distanceTo(sp.getWorldPosition(b));   // сегмент профиля
      const baseLen = bc.getWorldPosition(a).distanceTo(bp.getWorldPosition(b));   // сегмент дефолта (профиль=1)
      if (baseLen > 1e-3 && srcLen > 1e-3) cb.position.multiplyScalar(srcLen / baseLen);   // = множитель профиля; ×1 при профиле=1
    }
    loaded.updateMatrixWorld(true);
  }
  const restW = new Map<string, THREE.Quaternion>();   // bind мировой кватернион цели (оффсет, считается ОДИН РАЗ)
  const bake = (targetName: string): void => { const b = byName.get(targetName); if (b) restW.set(targetName, b.getWorldQuaternion(new THREE.Quaternion())); };
  for (const t of Object.values(boneMap)) bake(t);
  let hipRestY = 0; { const h = boneMap['Hips'] && byName.get(boneMap['Hips']); if (h) hipRestY = h.getWorldPosition(new THREE.Vector3()).y; }

  function drive(source: Humanoid): void {
    source.root.updateMatrixWorld(true);
    // порядок родитель→ребёнок → parentWorld цели уже обновлён к моменту ребёнка
    for (const our of OUR_BONES) {
      const tName = boneMap[our]; if (!tName) continue;
      const tb = byName.get(tName); const sb = source.bones.get(our); const rt = restW.get(tName);
      if (!tb || !sb || !rt) continue;
      sb.getWorldQuaternion(_q);                       // W_src
      _q.multiply(rt);                                 // targetWorld = W_src · R_restTarget
      const pw = tb.parent ? tb.parent.getWorldQuaternion(_pq) : _pq.copy(IDENT);
      tb.quaternion.copy(pw.invert().multiply(_q));    // → локаль цели
      tb.updateMatrixWorld(false);                     // дети прочитают верный parentWorld
    }
    // позиция корня = мир-таз источника (как renderRagdollGhost ставит mesh.root). hipRestY уже в масштабе
    // (замерян ПОСЛЕ loaded.scale=scale при position=0) → вычитаем без повторного ×scale (иначе двойной масштаб → парение).
    const hips = source.bones.get('Hips'); if (hips) { hips.getWorldPosition(_v); loaded.position.set(_v.x, _v.y - hipRestY, _v.z); }
  }

  return {
    root: loaded, boneMap, drive,
    targetBoneNames: () => [...byName.keys()],
    setBone(our, targetName) { boneMap[our] = targetName; bake(targetName); },
    dispose() { loaded.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); }); },
  };
}

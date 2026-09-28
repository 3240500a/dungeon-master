import * as THREE from 'three';
import type { PhysShape, PhysSize, Vec3 } from './humanoidRagdoll.js';

/**
 * ПРАВКА ФИЗ-ТЕЛА ГИЗМО — ЧИСТАЯ МАТЕМАТИКА (без DOM, без Jolt, без сцены).
 *
 * ЗАЧЕМ ОТДЕЛЬНЫМ МОДУЛЕМ. Тело можно править двумя способами — ползунками панели и гизмо во вьюпорте, — и
 * оба обязаны писать ОДНО И ТО ЖЕ (`PHYS_SIZES[имя]`: `pos`/`rot`/`len`/`w`/`d`). Если перевод «драг → число»
 * живёт внутри обработчика мыши, он не проверяется ничем и расходится с панелью по осям и по знаку. Здесь он
 * чистый и покрыт тестами, а вьюпорт только подаёт кватернионы и забирает готовые поля.
 *
 * ⚠ ТРИ ПРОСТРАНСТВА, И ПУТАТЬ ИХ НЕЛЬЗЯ:
 *  • МИР — в нём живёт гизмо и приходит драг;
 *  • ОСИ КОСТИ — в них хранятся `pos` и `rot` (`shapeOff` складывает `off + pos`, `shapeRot` домножает
 *    авторский поворот СЛЕВА, то есть «вокруг X» значит вокруг X кости, а не формы);
 *  • ОСИ ФОРМЫ — в них живут размеры: `len` тянется ВДОЛЬ тела, `w`/`d` — поперёк. Разворот формы запечён
 *    в геометрию меша, поэтому собственные оси меша — это оси КОСТИ, и рамку формы надо строить отдельно
 *    (`shapeFrame`), иначе «растянуть в длину» на косой кости растягивает поперёк.
 */

/** Ось формы (0=X,1=Y,2=Z) → кватернион, ведущий +Y на неё: у круглых форм длина уже по Y, у бокса — по своей полуоси. */
const _AX: THREE.Vector3[] = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
const _Y = new THREE.Vector3(0, 1, 0);

/**
 * РАМКА ФОРМЫ В МИРЕ: +Y — вдоль тела, X/Z — поперёк. Ею ориентируется ручка масштаба, чтобы «тянуть за
 * верхнюю стрелку» значило «удлинить», какой бы формы тело ни было и как бы криво ни шла кость.
 *
 * `boneQuat` — кватернион САМОГО ТЕЛА в мире (он же кватернион призрак-меша), `shapeQuat` — разворот формы
 * внутри кости (`shapeRot`), `axis` — `bodyAxis` тела (у круглых форм не используется).
 */
export function shapeFrame(boneQuat: THREE.Quaternion, shapeQuat: THREE.Quaternion, kind: PhysShape['k'], axis: 0 | 1 | 2): THREE.Quaternion {
  const q = boneQuat.clone().multiply(shapeQuat);
  if (kind === 'box') q.multiply(new THREE.Quaternion().setFromUnitVectors(_Y, _AX[axis]!));
  return q;
}

/**
 * СДВИГ. Мировая дельта ручки → новое значение `pos` (оси кости). Прибавляем к УЖЕ записанному сдвигу:
 * гизмо даёт смещение от точки захвата, а не абсолютную позицию формы.
 */
export function dragPos(base: Vec3 | undefined, deltaWorld: THREE.Vector3, boneQuat: THREE.Quaternion): Vec3 {
  const d = deltaWorld.clone().applyQuaternion(boneQuat.clone().invert());
  const b = base ?? [0, 0, 0];
  return [round2(b[0] + d.x), round2(b[1] + d.y), round2(b[2] + d.z)];
}

/**
 * ПОВОРОТ. Кватернион ручки в мире → `rot` (эйлеры XYZ в осях кости).
 *
 * ⚠ Ручка при захвате ставится РОВНО в рамку кости (`boneQuat`), а НЕ в рамку формы: `shapeRot` домножает
 * авторский поворот слева именно в осях кости, и снимать его надо в тех же осях — иначе значение, введённое
 * ползунком, и значение, снятое с гизмо, окажутся разными числами для одной и той же картинки.
 */
export function dragRot(handleQuat: THREE.Quaternion, boneQuat: THREE.Quaternion, base: Vec3 | undefined): Vec3 {
  const local = boneQuat.clone().invert().multiply(handleQuat);
  const prev = base ?? [0, 0, 0];
  const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(prev[0], prev[1], prev[2])).premultiply(local), 'XYZ');
  return [round4(e.x), round4(e.y), round4(e.z)];
}

/**
 * МАСШТАБ. Вектор масштаба ручки (в рамке формы: Y — вдоль) → размеры оверрайда.
 *
 * `len` — АБСОЛЮТНАЯ полудлина (её и показывает ползунок «длина (½)»), поэтому множим текущую.
 * `w`/`d` — МНОЖИТЕЛИ каталожного поперечника, поэтому множим их.
 * У круглых форм поперечник ОДИН: обе поперечные стрелки ведут в `w` (берём ту, которую тянули сильнее),
 * а `d` у конуса — это СУЖЕНИЕ, геометрического смысла «толщины» не имеет и гизмо его не трогает.
 */
export function dragSize(kind: PhysShape['k'], curLen: number, ov: Pick<PhysSize, 'w' | 'd'>, scale: THREE.Vector3): { len?: number; w?: number; d?: number } {
  const w0 = ov.w ?? 1, d0 = ov.d ?? 1;
  const out: { len?: number; w?: number; d?: number } = {};
  if (kind !== 'sphere' && Math.abs(scale.y - 1) > 1e-4) out.len = clamp(round2(curLen * scale.y), 0.5, 20);
  if (kind === 'box') {
    if (Math.abs(scale.x - 1) > 1e-4) out.w = clamp(round2(w0 * scale.x), 0.3, 2.5);
    if (Math.abs(scale.z - 1) > 1e-4) out.d = clamp(round2(d0 * scale.z), 0.3, 2.5);
  } else {
    // Круглые: масштаб поперечника — по той стрелке, которую тянули дальше от единицы.
    const sx = Math.abs(scale.x - 1), sz = Math.abs(scale.z - 1);
    const s = sx >= sz ? scale.x : scale.z;
    if (Math.max(sx, sz) > 1e-4) out.w = clamp(round2(w0 * s), 0.3, 2.5);
  }
  return out;
}

/** Режим гизмо по зажатым клавишам — ОДИН разбор на вьюпорт и на подсказку в панели. */
export type PhysGizmoMode = 'translate' | 'rotate' | 'scale';
export function modeOf(mods: { shift?: boolean; alt?: boolean }): PhysGizmoMode {
  if (mods.alt) return 'scale';       // Alt важнее: Shift у гизмо ещё и шаг привязки
  if (mods.shift) return 'rotate';
  return 'translate';
}

const clamp = (x: number, a: number, b: number): number => Math.min(Math.max(x, a), b);
const round2 = (x: number): number => Math.round(x * 100) / 100;
const round4 = (x: number): number => Math.round(x * 10000) / 10000;

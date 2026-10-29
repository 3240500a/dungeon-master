/**
 * ⭐⭐ ЗАЖАТЬ КЛИП ПРЕДЕЛАМИ СУСТАВОВ — НА ИМПОРТЕ, ПО ВЫБРАННЫМ ЧАСТЯМ ТЕЛА.
 *
 * Жалоба: «при ударе мечом он голову в сторону поворачивает, видимо лимитов не хватает». ЗАМЕР
 * клипа `hit_sword_r_01`: на кадре 5 авторено **шея −52.3°** и **голова −38.1°** рыска — вместе
 * около −90°, при том что у самой головы в риге предел **±40°**. Голова уходила от прицела на 14.2°.
 *
 * ⚠ ПРЕДЕЛЫ ЕСТЬ, НО ИХ НЕ ПРИМЕНЯЛ НИКТО. Редактор клампит только когда кость крутят РУКАМИ
 * (гизмо, IK); проигрывание клипа, импорт и рантайм не проверяли ничего. То есть импортированный
 * мокап проносил через всю цепочку любую анатомию, и увидеть это можно было только глазами.
 *
 * ⚠ ЗАЖИМАЕМ НЕ ВСЁ ПОДРЯД, А ПО ЧАСТЯМ (галки в панели импорта). Предел — это не истина в
 * последней инстанции: он настроен под физику и под ручной позинг, и на ногах-руках зажать весь
 * мокап значит получить «не совсем корректно отыгранную» анимацию. Части те же, что у маски
 * импорта (`MASK_PARTS`), чтобы в панели не было двух разных списков тела.
 *
 * ⚠ ОТЧЁТ ОБЯЗАТЕЛЕН. Правка молча меняет авторскую работу, поэтому возвращаем, сколько каналов
 * тронуто и на сколько градусов — иначе «клип после импорта другой» не с чем сопоставить.
 */
import * as THREE from 'three';
import { MASK_PARTS, type MaskPart } from './boneMask.js';
import { clampLocalToLimit } from './jointClamp.js';
import type { LimitView } from './humanoidRagdoll.js';
import type { Clip, Pose } from './clipModel.js';

/** Откуда берётся предел кости. Передаётся снаружи: сами пределы живут в модуле, который в node не грузится. */
export type LimitSource = (bone: string) => LimitView | null;

export interface ClampReport {
  /** Сколько каналов реально изменилось. */
  changed: number;
  /** Худшая правка (градусы) и на какой кости. */
  worstDeg: number;
  worstBone: string;
  /** Правка по костям (градусы, только тронутые) — чтобы было видно, ЧТО именно зажалось. */
  byBone: Record<string, number>;
}

/** Кости выбранных частей. Пустой выбор — пустое множество (ничего не трогаем). */
export function clampBones(parts: readonly MaskPart[]): Set<string> {
  const want = new Set(parts);
  const out = new Set<string>();
  for (const p of MASK_PARTS) if (want.has(p.id)) for (const b of p.bones) out.add(b);
  return out;
}

const _q = new THREE.Quaternion(), _qc = new THREE.Quaternion(), _e = new THREE.Euler();

/**
 * Зажать каналы клипа пределами суставов ИН-ПЛЕЙС и вернуть отчёт.
 *
 * ⚠ ИН-ПЛЕЙС НАМЕРЕННО: зовётся на свежеиспечённом клипе внутри импорта, копировать там нечего и
 * незачем. Клип на диске правится только если импорт довели до сохранения.
 */
export function clampClip(clip: Clip, parts: readonly MaskPart[], limitOf: LimitSource): ClampReport {
  const rep: ClampReport = { changed: 0, worstDeg: 0, worstBone: '', byBone: {} };
  const bones = clampBones(parts);
  if (!bones.size) return rep;
  const views = new Map<string, LimitView | null>();
  for (const k of clip.keys) {
    const pose = k.pose as Pose;
    for (const nm in pose) {
      if (!bones.has(nm)) continue;
      if (!views.has(nm)) views.set(nm, limitOf(nm));
      const view = views.get(nm); if (!view) continue;          // нет предела у этой кости — не выдумываем
      const v = pose[nm]; if (!v || v.length < 3) continue;
      _e.set(v[0]!, v[1]!, v[2]!, 'XYZ'); _q.setFromEuler(_e);
      _qc.copy(clampLocalToLimit(_q, view));
      const deg = 2 * Math.acos(Math.min(1, Math.abs(_q.dot(_qc)))) * 180 / Math.PI;
      if (deg < 1e-4) continue;                                  // предел не тронул — не считаем правкой
      _e.setFromQuaternion(_qc, 'XYZ');
      pose[nm] = [_e.x, _e.y, _e.z];
      rep.changed++;
      rep.byBone[nm] = Math.max(rep.byBone[nm] ?? 0, deg);
      if (deg > rep.worstDeg) { rep.worstDeg = deg; rep.worstBone = nm; }
    }
  }
  return rep;
}

/** Короткая строка отчёта для панели импорта. */
export function clampSummary(rep: ClampReport): string {
  if (!rep.changed) return 'пределы ничего не тронули';
  const top = Object.entries(rep.byBone).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([b, d]) => `${b} ${d.toFixed(0)}°`).join(', ');
  return `зажато каналов: ${rep.changed}, худшая правка ${rep.worstDeg.toFixed(0)}° (${rep.worstBone}); ${top}`;
}

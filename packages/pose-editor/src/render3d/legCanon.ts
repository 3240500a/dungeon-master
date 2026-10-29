import * as THREE from 'three';

/**
 * ⭐⭐ РЕСТ НОГ МОДЕЛИ — В НАШ КАНОН (07.10, жалоба «пингвин, ноги согнуты больше, оси стопы сдвинуты»).
 *
 * Модель ведётся по правилу «ноль поворотов куклы = исходная поза модели» (`targetWorld = W_куклы · R_рест`), а наш риг берёт
 * геометрию ног из той же модели. Значит, любое отклонение исходной позы модели от канона садится в КАЖДЫЙ кадр любого клипа.
 * ЗАМЕР у рыцаря (`knight_06`): колено согнуто на ~3° (клип на нём гнёт колено на +3° на всех кадрах, таз ниже: 0.900 против
 * 0.915 длины ноги у оригинала мокапа), голень наклонена внутрь на 2.4°, носок развёрнут НАРУЖУ на 23.6° — даже «прямая» стопа
 * клипа на рыцаре смотрит наружу, а кольца поворота стопы в редакторе (они по канону) — мимо видимой стопы.
 *
 * ПРАВИЛО: ноль поворотов = ПРЯМЫЕ ноги (бедро и голень вертикально) и НОСОК ВПЕРЁД, на любой модели. Риг выпрямляется офсетами
 * (`humanoid.canonLegOffsets`, длины сохраняются), а модель — ПОПРАВКОЙ К РЕСТУ (`R_рест' = Q · R_рест`), сами кости не трогаем:
 * по позе узлов ищутся твист-цепи, и она должна остаться исходной. Та же математика у импорта мокапа (`canonRestLegs`), но там
 * кости источника правятся прямо — источник одноразовый.
 *
 * Здесь — чистая часть: по МИРОВЫМ позициям суставов модели (кадр Y-вверх, лицом по ходу) — мировые поправки костей ног.
 * Порт один-в-один — Unity `LegCanon.Fix` (сверка по эталону `unity_rig.json`, секция `legCanon`).
 */
export type V3 = readonly [number, number, number];
/** Позиции суставов ноги модели: бедро (сустав), колено, лодыжка, носок; L/R. Нет точки — нет и поправки этого звена. */
export interface LegCanonPoints { uL?: V3; kL?: V3; fL?: V3; tL?: V3; uR?: V3; kR?: V3; fR?: V3; tR?: V3 }
/** Доворот носка больше этого — не рест, а странный файл: стопу не трогаем. */
export const LEG_CANON_TOE_MAX_DEG = 45;
/** Носок почти вертикален (горизонталь меньше этой доли длины) — рыска не определить. */
const TOE_FLAT_MIN = 0.2;

const DOWN = new THREE.Vector3(0, -1, 0);
const v3 = (a: V3): THREE.Vector3 => new THREE.Vector3(a[0], a[1], a[2]);
const qa = (q: THREE.Quaternion): [number, number, number, number] => [q.x, q.y, q.z, q.w];

/**
 * Мировые поправки (кватернион x, y, z, w) для наших костей ног: `LeftUpperLeg` — бедро в вертикаль, `LeftLowerLeg` — то же
 * плюс голень в вертикаль, `LeftFoot`/`LeftToes` — ТОЛЬКО рыск носка вперёд. ⚠ Стопа за голенью НЕ поворачивается: в бинде она
 * стоит на полу плашмя, и выпрямление колена наклонило бы её (носок в пол или вверх на угол сгиба) — меняется лишь угол в
 * голеностопе. Перёд — `(бедро Л − бедро П) × вверх`, знак сверяется со средним носком (в Unity модель зеркальна по X, и
 * векторное произведение там смотрит назад).
 */
export function legCanonFix(p: LegCanonPoints): Record<string, [number, number, number, number]> {
  const out: Record<string, [number, number, number, number]> = {};
  type Side = { s: 'Left' | 'Right'; f?: THREE.Vector3; t?: THREE.Vector3 };
  const sides: Side[] = [];
  for (const s of ['Left', 'Right'] as const) {
    const k = s === 'Left' ? 'L' : 'R';
    const U = p[`u${k}`], K = p[`k${k}`], F = p[`f${k}`], T = p[`t${k}`];
    if (!U || !K) continue;
    const u = v3(U), kn = v3(K), f = F ? v3(F) : undefined, t = T ? v3(T) : undefined;
    // 1) бедро в вертикаль — поворот вокруг сустава бедра, тянет колено, лодыжку и носок
    const qT = new THREE.Quaternion().setFromUnitVectors(kn.clone().sub(u).normalize(), DOWN);
    const rot = (q: THREE.Quaternion, piv: THREE.Vector3, x?: THREE.Vector3): THREE.Vector3 | undefined => x && x.clone().sub(piv).applyQuaternion(q).add(piv);
    const k1 = rot(qT, u, kn)!, f1 = rot(qT, u, f);
    out[`${s}UpperLeg`] = qa(qT);
    if (!f1) continue;
    // 2) голень в вертикаль — вокруг колена; стопа своей мировой ориентации не меняет (носок — тот же вектор от лодыжки)
    const qK = new THREE.Quaternion().setFromUnitVectors(f1.clone().sub(k1).normalize(), DOWN);
    const f2 = rot(qK, k1, f1)!;
    out[`${s}LowerLeg`] = qa(qK.clone().multiply(qT));
    sides.push({ s, f: f2, t: t && f ? f2.clone().add(t.clone().sub(f)) : undefined });
  }
  // 3) носок вперёд — только рыск (вокруг вертикали), тангаж стопы — геометрия, не трогаем
  const uL = p.uL, uR = p.uR;
  if (!uL || !uR) return out;
  const lr = v3(uL).sub(v3(uR));
  const fwd = new THREE.Vector3(-lr.z, 0, lr.x);   // (L − R) × (0, 1, 0)
  if (fwd.lengthSq() < 1e-12) return out;
  fwd.normalize();
  const mean = new THREE.Vector3();
  for (const sd of sides) if (sd.f && sd.t) { const d = sd.t.clone().sub(sd.f); d.y = 0; if (d.lengthSq() > 1e-12) mean.add(d.normalize()); }
  if (mean.dot(fwd) < 0) fwd.negate();
  for (const sd of sides) {
    if (!sd.f || !sd.t) continue;
    const d = sd.t.clone().sub(sd.f), len = d.length();
    const h = new THREE.Vector3(d.x, 0, d.z);
    if (len < 1e-9 || h.length() < TOE_FLAT_MIN * len) continue;
    h.normalize();
    const ang = Math.atan2(h.clone().cross(fwd).y, h.dot(fwd));
    if (Math.abs(ang) * 180 / Math.PI > LEG_CANON_TOE_MAX_DEG) continue;
    const qF = new THREE.Quaternion().setFromUnitVectors(h, fwd);
    out[`${sd.s}Foot`] = qa(qF);
    out[`${sd.s}Toes`] = qa(qF);
  }
  return out;
}

/** Точки ноги из костей модели (мировые позиции): `bone(our)` — кость модели по нашему имени. */
export function legCanonPoints(bone: (our: string) => THREE.Object3D | null | undefined): LegCanonPoints {
  const w = (our: string): V3 | undefined => { const b = bone(our); if (!b) return undefined; const v = b.getWorldPosition(new THREE.Vector3()); return [v.x, v.y, v.z]; };
  return {
    uL: w('LeftUpperLeg'), kL: w('LeftLowerLeg'), fL: w('LeftFoot'), tL: w('LeftToes'),
    uR: w('RightUpperLeg'), kR: w('RightLowerLeg'), fR: w('RightFoot'), tR: w('RightToes'),
  };
}

/**
 * Офсеты НАШЕГО рига из геометрии модели — в тот же канон: колено точно под суставом бедра, лодыжка точно под коленом
 * (длины звеньев сохраняются), носок прямо вперёд (длина по горизонтали и наклон сохраняются). Остальное — как есть.
 *
 * ⚠ ПРЯМАЯ НОГА ВЫШЕ СОГНУТОЙ. Выпрямленная нога длиннее по вертикали на `|голень| + |бедро→колено| − их вертикаль в бинде`
 * (у A-позы 10° — на 0.39 ю, у рыцаря ~0.03), и с таз-высотой модели лодыжка ушла бы под её подошву. Поэтому таз поднимается
 * на этот прирост (среднее по ногам): лодыжка в покое стоит ровно там же, где у модели (`importFidelity` — «подошва сама
 * встаёт на пол»).
 * Порт — Unity `WebRig` (сверка по эталону G2: сценарии на геометрии рыцаря).
 */
export function canonLegOffsets(bo: Record<string, number[]> | undefined): Record<string, number[]> | undefined {
  if (!bo) return bo;
  const out: Record<string, number[]> = { ...bo };
  let gain = 0, n = 0;
  for (const s of ['Left', 'Right']) {
    let g = 0, any = false;
    for (const nm of [s + 'LowerLeg', s + 'Foot']) {
      const o = bo[nm];
      if (!o) continue;
      const len = Math.hypot(o[0] ?? 0, o[1] ?? 0, o[2] ?? 0);
      out[nm] = [0, -len, 0];
      g += len + (o[1] ?? 0); any = true;
    }
    if (any) { gain += g; n++; }
    const t = bo[s + 'Toes'];
    if (t) out[s + 'Toes'] = [0, t[1] ?? 0, Math.hypot(t[0] ?? 0, t[2] ?? 0)];
  }
  const h = bo['Hips'];
  if (h && n) out['Hips'] = [h[0] ?? 0, (h[1] ?? 0) + gain / n, h[2] ?? 0];
  return out;
}

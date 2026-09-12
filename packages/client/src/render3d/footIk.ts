// ── FOOT-IK ЗАЗЕМЛИТЕЛЬ (как Grounder/Final IK в Unity) ──────────────────────────────
// Рейкаст пола под каждой стопой → цель кости стопы = пол + подошва; 2-костный IK ноги догибает колено ровно на пол,
// таз опускается под нижнюю опору. Стопа не тонет и не висит. Только THREE + тип Humanoid (без физ-цепочки) → тестируемо.
import * as THREE from 'three';
import type { Humanoid } from './humanoid.js';

/** Запрос высоты пола (мир) в точке XZ. Сейчас плоский (floorY); позже — рейкаст по коллизии 3д-пола. */
export type GroundQuery = (x: number, z: number) => number;

const clamp = (x: number, a: number, b: number): number => Math.min(Math.max(x, a), b);
const SOLE = 1.5;                    // высота кости стопы над полом, когда подошва на полу (= FOOT_Y в pose.ts)
/**
 * Ф15.3: ДЛИНЫ НОГИ БЕРУТСЯ С РИГА, а не из констант.
 * Раньше тут стояло `IK_THIGH = 15, IK_SHIN = 14` «из BONES» — и на импортированной модели с другой ногой
 * солвер ставил колено на 15 юнитов вдоль бедра, которое не 15 длиной. Лодыжка не попадала в цель, остаток
 * каждый кадр уходил в СДВИГ КОРНЯ (`gs.off` ниже двигает весь скелет) — отсюда «заземление съезжает».
 * Нога длиннее 28.5 к тому же обрезалась клэмпом досягания.
 * Длины читаются из rest-офсетов костей (у нас анимируются только повороты, `.position` = rest) и кэшируются
 * на объекте `Humanoid`: пересборка манекена даёт новый объект → замер обновляется сам.
 */
export interface LegGeom { thigh: number; shin: number; max: number; min: number }
const _legCache = new WeakMap<Humanoid, LegGeom[]>();
function legGeom(mesh: Humanoid, i: number): LegGeom {
  let all = _legCache.get(mesh);
  if (!all) {
    all = IK_LEGS.map((L) => {
      const thigh = mesh.bones.get(L.l)?.position.length() ?? 15;   // офсет голени от бедра = длина бедра
      const shin = mesh.bones.get(L.f)?.position.length() ?? 14;    // офсет стопы от голени = длина голени
      return { thigh, shin, max: thigh + shin - 0.5, min: Math.abs(thigh - shin) + 0.5 };
    });
    _legCache.set(mesh, all);
  }
  return all[i]!;
}
const PLANT_MAX = 6;                 // стопа выше своего пола меньше этого → ОПОРНАЯ (планти на пол); выше → маховая (не трогаем)
const GROUND_LAG = 8;                // скорость сглаживания сдвига таза к полу (меньше → мягче/плавнее боб)
const IK_LEGS = [{ u: 'LeftUpperLeg', l: 'LeftLowerLeg', f: 'LeftFoot' }, { u: 'RightUpperLeg', l: 'RightLowerLeg', f: 'RightFoot' }];
const _DOWN = new THREE.Vector3(0, -1, 0), _UP = new THREE.Vector3(0, 1, 0);
const _iH = new THREE.Vector3(), _iT = new THREE.Vector3(), _iK = new THREE.Vector3(), _iDir = new THREE.Vector3();
const _iThigh = new THREE.Vector3(), _iShin = new THREE.Vector3(), _iBend = new THREE.Vector3(), _iPole = new THREE.Vector3(), _iFoot = new THREE.Vector3();
const _ipq = new THREE.Quaternion(), _iwq = new THREE.Quaternion(), _iFace = new THREE.Quaternion(), _iAxis = new THREE.Vector3(), _iFtFwd = new THREE.Vector3();
const _fFwdL = new THREE.Vector3(), _fThirdL = new THREE.Vector3(), _fDir = new THREE.Vector3(), _fFwdW = new THREE.Vector3(), _fThirdW = new THREE.Vector3();
const _mL = new THREE.Matrix4(), _mW = new THREE.Matrix4(), _FWD_L = new THREE.Vector3(0, 0, 1);

/** Прицелить кость ПОЛНЫМ ФРЕЙМОМ (не кратчайшей дугой): ось сегмента → `dir`, а «перёд» кости (лок. +Z, ортогонал. к сегменту)
 *  → `fwd` (спроецированный ⊥ dir). Так ТВИСТ вокруг ноги ЗАДАН → колено смотрит вперёд и не разворачивается наружу при
 *  боковом дотяге (кратчайшая дуга `setFromUnitVectors` твист не задавала → заземление крутило колени). child=null → фолбэк −Y. */
function aimBoneFrame(bone: THREE.Object3D, child: THREE.Object3D | null, dir: THREE.Vector3, fwd: THREE.Vector3): void {
  _iAxis.copy(child ? child.position : _DOWN); if (_iAxis.lengthSq() < 1e-9) _iAxis.copy(_DOWN); else _iAxis.normalize();   // сегмент (лок.)
  _fFwdL.copy(_FWD_L).addScaledVector(_iAxis, -_FWD_L.dot(_iAxis));                       // лок. «перёд» +Z ⊥ сегмента
  if (_fFwdL.lengthSq() < 1e-6) { _fFwdL.set(1, 0, 0).addScaledVector(_iAxis, -_iAxis.x); }
  _fFwdL.normalize(); _fThirdL.crossVectors(_iAxis, _fFwdL);
  _fDir.copy(dir).normalize();
  _fFwdW.copy(fwd).addScaledVector(_fDir, -fwd.dot(_fDir));                                // мир. «перёд» (pole) ⊥ dir
  if (_fFwdW.lengthSq() < 1e-6) { _fFwdW.set(1, 0, 0).addScaledVector(_fDir, -_fDir.x); }
  _fFwdW.normalize(); _fThirdW.crossVectors(_fDir, _fFwdW);
  _mL.makeBasis(_iAxis, _fFwdL, _fThirdL); _mW.makeBasis(_fDir, _fFwdW, _fThirdW);
  _mL.transpose(); _mW.multiply(_mL);                                                      // Q_world = worldFrame · localFrame⁻¹
  bone.parent!.getWorldQuaternion(_ipq);
  bone.quaternion.setFromRotationMatrix(_mW); bone.quaternion.premultiply(_ipq.invert());  // локальный = parent⁻¹ · Q_world
}

/** Аналитический 2-костный IK ноги: гнём бедро+колено так, чтобы кость стопы встала в targetWorld.
 *  pole — направление сгиба колена (вперёд). Стопу ВЫРАВНИВАЕМ по faceQuat (плоско + носок по фейсингу тела): иначе
 *  твист от aimBoneDown не задан и стопа висит в фикс. мировой стороне. Длины костей фиксированы, кламп разгиба. */
export function legGroundIK(upper: THREE.Object3D, lower: THREE.Object3D, foot: THREE.Object3D, targetWorld: THREE.Vector3, pole: THREE.Vector3, faceQuat: THREE.Quaternion, geom?: LegGeom): void {
  const g = geom ?? { thigh: 15, shin: 14, max: 28.5, min: 1.5 };
  upper.getWorldPosition(_iH);
  _iDir.subVectors(targetWorld, _iH);
  let dist = _iDir.length(); if (dist < 1e-3) return;
  dist = clamp(dist, g.min, g.max); _iDir.normalize();
  const a = Math.acos(clamp((g.thigh * g.thigh + dist * dist - g.shin * g.shin) / (2 * g.thigh * dist), -1, 1));
  _iBend.crossVectors(_iDir, pole);
  if (_iBend.lengthSq() < 1e-6) _iBend.set(1, 0, 0); else _iBend.normalize();
  _iThigh.copy(_iDir).applyAxisAngle(_iBend, a);       // бедро: линия к цели, отклонённая на a → колено вперёд
  aimBoneFrame(upper, lower, _iThigh, pole); upper.updateMatrixWorld(true);   // полный фрейм: колено смотрит на pole (не крутится наружу)
  _iK.copy(_iH).addScaledVector(_iThigh, g.thigh);     // колено в мире
  _iShin.subVectors(targetWorld, _iK).normalize();
  aimBoneFrame(lower, foot, _iShin, pole); lower.updateMatrixWorld(true);     // голень: тот же pole → без паразитного твиста
  lower.getWorldQuaternion(_ipq);                      // выровнять СТОПУ: мир-ориентация = faceQuat (плоско, носок по телу)
  foot.quaternion.copy(_ipq).invert().multiply(faceQuat);
  foot.updateMatrixWorld(true);
}

/**
 * Заземлить стопы меша (после физики+бленда+корня): пол под каждой стопой → цель = пол + SOLE. Таз поднимаем под самую
 * «провалившуюся» ОПОРНУЮ стопу (мгновенно вниз-провал, плавно оседая), затем per-foot IK плантит каждую опорную стопу
 * ровно на её пол + кладёт её плоско. МАХОВУЮ (в переносе) НЕ трогаем — её носок ведёт поза (иначе «лыжник»: стопа
 * плющится в воздухе на спуске). Опора = `support[i]` из позы (driver.swingLegs → !swing); нет позы → эвристика по высоте.
 * baseY = физ-Y таза; gs.off — сглаж. сдвиг корня.
 */
export function groundFeet(mesh: Humanoid, baseY: number, gs: { off: number }, dt: number, gnd: GroundQuery, support?: [boolean, boolean]): void {
  const hips = mesh.bones.get('Hips'); if (!hips) return;
  const sole = SOLE + (mesh.footLift ?? 0);   // подъём цели: кость-лодыжка выше на footLift → ПОДОШВА МЕША атласа на полу (не тонет)
  const tgt: number[] = [], sup: boolean[] = []; let worst = -Infinity;
  for (let i = 0; i < IK_LEGS.length; i++) {
    const fb = mesh.bones.get(IK_LEGS[i]!.f); if (!fb) { tgt.push(NaN); sup.push(false); continue; }
    fb.getWorldPosition(_iFoot);
    const ty = gnd(_iFoot.x, _iFoot.z) + sole; tgt.push(ty);
    const isSup = support ? support[i]! : (_iFoot.y - ty < PLANT_MAX);   // опора из позы (маховую не заземляем); фолбэк — по высоте
    sup.push(isSup);
    if (isSup) worst = Math.max(worst, ty - _iFoot.y);
  }
  // НЕТ ОПОРНОЙ СТОПЫ → СДВИГ ЗАТУХАЕТ (Ф26.1). Было: весь блок коррекции просто пропускался, а `gs.off`
  // продолжал прибавляться в `renderRagdollGhost` КАЖДЫЙ КАДР — и это САМОЗАПИРАЮЩИЙСЯ режим: чем выше
  // уехала фигура, тем дальше стопы от своего пола, тем вернее гейт `PLANT_MAX` считает ОБЕ маховыми —
  // и вернуться на пол уже нечем (жалоба «сходил на вкладку Бег, вернулся — персонаж висит»). В полёте/прыжке
  // опоры тоже нет — и там затухание ВЕРНОЕ: без опоры прижимать к полу нечего (так же ведёт себя ветка смерти,
  // `humanoidRagdoll.ts` — `if (!ground) gs.off += (0 - gs.off) * …`).
  if (!Number.isFinite(worst)) {
    gs.off += (0 - gs.off) * Math.min(1, dt * GROUND_LAG);
    mesh.setHipsWorldY(baseY + gs.off); mesh.root.updateMatrixWorld(true);
  }
  if (Number.isFinite(worst)) {
    // Сдвиг корня СГЛАЖЕН в обе стороны (мягкий боб): даже если таз догоняет медленно, per-foot IK ниже плантит опорную
    // стопу коленом → она НЕ проваливается, пока таз плавно едет. Раньше был мгновенный рывок вверх на провале — дёрганый боб.
    gs.off += (worst - 0) * Math.min(1, dt * GROUND_LAG);
    mesh.setHipsWorldY(baseY + gs.off); mesh.root.updateMatrixWorld(true);   // Root ≠ таз: целимся в МИРОВУЮ высоту ТАЗА, корень едет под него
  }
  for (let i = 0; i < IK_LEGS.length; i++) {                        // планти+кладём ТОЛЬКО опорные стопы; маховую ведёт поза
    if (!sup[i]) continue;
    const leg = IK_LEGS[i]!, ty = tgt[i]!; if (!Number.isFinite(ty)) continue;
    const ub = mesh.bones.get(leg.u), lb = mesh.bones.get(leg.l), fb = mesh.bones.get(leg.f);
    if (!ub || !lb || !fb) continue;
    // pole колена + рыск стопы БЕРЁМ ИЗ ПОЗЫ (перёд ПОЗИРОВАННОГО бедра/стопы), не из тела → заземление держит только ВЫСОТУ
    // и плоскость; рыск свободен (стопа крутится на полу за бедром при повороте вокруг вертикали). Раньше pole/рыск = фейсинг
    // ТЕЛА → заземление возвращало ногу к телу, теряя твист бедра.
    ub.getWorldQuaternion(_ipq); _iPole.set(0, 0, 1).applyQuaternion(_ipq); _iPole.y = 0;   // перёд бедра (лок +Z в мире, гориз.)
    if (_iPole.lengthSq() < 1e-6) _iPole.set(0, 0, 1); else _iPole.normalize();
    fb.getWorldQuaternion(_ipq); _iFtFwd.set(0, 0, 1).applyQuaternion(_ipq);                 // перёд стопы → её рыск
    if (_iFtFwd.x * _iFtFwd.x + _iFtFwd.z * _iFtFwd.z < 1e-8) _iFace.copy(_ipq);              // стопа вертикально → берём как есть
    else _iFace.setFromAxisAngle(_UP, Math.atan2(_iFtFwd.x, _iFtFwd.z));                      // плоско по полу, носок по позе-рыску
    fb.getWorldPosition(_iFoot);
    legGroundIK(ub, lb, fb, _iT.set(_iFoot.x, ty, _iFoot.z), _iPole, _iFace, legGeom(mesh, i));
  }
}

/**
 * Геометрия ноги с ЗАДАННЫМ запасом до полного выпрямления.
 * ⚠ Штатный `legGeom` держит запас 0.5 — чтобы колено в ИГРЕ не вставало в замок. Для ЗАПЕКАНИЯ это вредно:
 * наша rest-нога выпрямлена ровно на `thigh+shin`, и с запасом 0.5 приколотая стопа в покое уезжала бы
 * на полюнита каждый кадр (замерено падающим тестом). Здесь запас маленький — точность важнее.
 */
export function legGeomFor(mesh: Humanoid, i: number, guard = 0.02): LegGeom {
  const g = legGeom(mesh, i);
  return { thigh: g.thigh, shin: g.shin, max: g.thigh + g.shin - guard, min: g.min };
}
/**
 * ЧЕСТНАЯ длина ноги i (0=Л, 1=П) в юнитах: бедро+голень, длины С РИГА.
 * ⚠ Это НЕ `legGeom().max`: там `thigh+shin−0.5` — солверный запас, чтобы колено не вставало в замок.
 * Для «дотянется ли нога до цели» нужна именно полная длина, иначе в rest-позе (нога выпрямлена ровно на
 * `thigh+shin`) любой пин считался бы недосягаемым и таз дёргало бы на ровном месте.
 */
export function legReach(mesh: Humanoid, i: number): number {
  const L = IK_LEGS[i]!;
  return (mesh.bones.get(L.l)?.position.length() ?? 0) + (mesh.bones.get(L.f)?.position.length() ?? 0);
}
/** Имена костей ноги i — чтобы вызывающий не переписывал таблицу у себя. */
export const legBones = (i: number): { u: string; l: string; f: string } => IK_LEGS[i]!;
/** Сколько ног знает заземлитель (2). */
export const LEG_COUNT = IK_LEGS.length;
/** Высота кости стопы над полом при подошве на полу — публично, чтобы цели пинов можно было заземлить. */
export const FOOT_SOLE = SOLE;

/**
 * САМАЯ НИЗКАЯ ТОЧКА СКИНА среди вершин, взвешенных на нужные кости (мировые координаты).
 *
 * ⚠ `Box3.setFromObject` здесь НЕ ГОДИТСЯ: у скиннед-меша он считается от БИНД-позы и врёт — ровно
 * на эти грабли уже наступили в Unity-клиенте («SkinnedMesh.bounds врут бинд-позой», отчего
 * персонаж парил). Поэтому вершины гоняются через `applyBoneTransform` + `matrixWorld`: так не надо
 * угадывать ни бинд-матрицы, ни масштаб импорта — ретаргет и так ведёт кости модели на наши.
 *
 * ⚠ И берём НЕ низ всей модели, а только вершины СТОПЫ. У мага пола плаща висит ниже подошвы, и
 * «низ модели» поднял бы персонажа в воздух на длину полы.
 *
 * `keep` решает, считается ли кость стопой; вызывающий сам поднимается по родителям (у CC/UE-ригов
 * скин висит на твист-костях, которых в карте нет).
 */
export function lowestSkinY(meshes: readonly THREE.SkinnedMesh[], keep: (bone: THREE.Object3D) => boolean): number | null {
  const v = new THREE.Vector3();
  let lo = Infinity, seen = 0;
  for (const m of meshes) {
    const pos = m.geometry.getAttribute('position');
    const si = m.geometry.getAttribute('skinIndex'), sw = m.geometry.getAttribute('skinWeight');
    if (!pos || !si || !sw) continue;
    m.updateMatrixWorld(true);
    for (let i = 0; i < pos.count; i++) {
      // Доминирующая кость вершины — по наибольшему весу; скелет берём ЭТОГО меша (после дедупа
      // у меша может быть свой `Skeleton` поверх общих костей, глобального индекса нет).
      let bw = sw.getX(i), bi = si.getX(i);
      if (sw.getY(i) > bw) { bw = sw.getY(i); bi = si.getY(i); }
      if (sw.getZ(i) > bw) { bw = sw.getZ(i); bi = si.getZ(i); }
      if (sw.getW(i) > bw) { bw = sw.getW(i); bi = si.getW(i); }
      if (bw <= 0) continue;
      const bone = m.skeleton.bones[bi]; if (!bone || !keep(bone)) continue;
      v.fromBufferAttribute(pos, i); m.applyBoneTransform(i, v); v.applyMatrix4(m.matrixWorld);
      if (v.y < lo) lo = v.y;
      seen++;
    }
  }
  return seen > 0 && Number.isFinite(lo) ? lo : null;
}

/**
 * ОФСЕТ ЗАЗЕМЛЕНИЯ (`pe_phys.footLift`) ПО ЗАМЕРУ, а не на глаз.
 *
 * Заземление целит кость лодыжки в `пол + SOLE + footLift`. Значит чтобы ПОДОШВА МЕША легла на пол,
 * офсет обязан равняться «высота лодыжки над её собственной подошвой» минус наш процедурный `SOLE`.
 * У импортного атласа лодыжка сидит выше нашей — без офсета меш тонет.
 *
 * Мерить надо В ПОКОЕ (T-поза): в шаге стопа поднята, и замер поехал бы вместе с ней.
 */
export function measureFootLift(mesh: Humanoid, soleY: number): number | null {
  let ankle = Infinity;
  for (const L of IK_LEGS) {
    const fb = mesh.bones.get(L.f); if (!fb) continue;
    fb.updateMatrixWorld(true);
    ankle = Math.min(ankle, fb.getWorldPosition(new THREE.Vector3()).y);
  }
  if (!Number.isFinite(ankle)) return null;
  return (ankle - soleY) - SOLE;
}

const _gbFoot = new THREE.Vector3();
/**
 * ЗАЗЕМЛЕНИЕ ДЛЯ ЗАПЕКАНИЯ: на сколько ЮНИТОВ поднять таз, чтобы НИЖНЯЯ стопа встала на пол `floorY`.
 * Отличие от `groundFeet` — мгновенно и БЕЗ правки скелета: `groundFeet` живёт в кадре игры, у него
 * демпфер по `dt` и он догибает колени; здесь нужен один чистый ответ, который ляжет в `__hipsD` клипа.
 * Отрицательный результат (обе стопы висят) тоже возвращаем: клип с прыжком не должен «прилипать» к полу.
 */
export function groundBakeOffset(mesh: Humanoid, floorY = 0): number {
  const sole = SOLE + (mesh.footLift ?? 0);
  let worst = -Infinity;
  for (const L of IK_LEGS) {
    const fb = mesh.bones.get(L.f); if (!fb) continue;
    fb.getWorldPosition(_gbFoot);
    worst = Math.max(worst, floorY + sole - _gbFoot.y);
  }
  return Number.isFinite(worst) ? worst : 0;
}

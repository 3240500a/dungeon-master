/**
 * СХЛОПЫВАНИЕ ДУБЛИРОВАННЫХ СКЕЛЕТОВ ПРИ ЗАГРУЗКЕ МОДЕЛИ.
 *
 * НОРМА ИНДУСТРИИ — ОДИН скелет и много скиннед-мешей, которые на него ссылаются: в glTF несколько `meshes` с
 * ОДНИМ индексом `skin`, в three.js — общий `THREE.Skeleton`. Так собирают модульных персонажей везде, иначе смена
 * экипировки плодит скелеты пачками.
 *
 * ЧТО ПРИХОДИТ К НАМ. Конвертеры FBX→glTF часто выписывают КАЖДОМУ мешу свой скин. ЗАМЕР на нашем рыцаре:
 * 38 мешей → **38 скинов по 100 суставов, наборы не пересекаются**, 3844 ноды вместо ~100, причём копии ВЛОЖЕНЫ
 * друг в друга цепочкой (корни скинов на глубинах 12…49, максимум 54). В Максе скелет один — это артефакт экспорта.
 * Рендерится верно только потому, что вложенные копии пассивно наследуют движение внешней.
 *
 * ЧЕМ ВРЕДНО: 3800 матриц костей на персонажа вместо 100 и каскад `updateMatrixWorld` на 38 уровней; плюс любой
 * обход скелета натыкается на 38 одинаковых костей и должен угадывать «настоящую» (на этом уже взрывался меш —
 * см. `twistBones.ts`).
 *
 * ПОЧЕМУ СХЛОПЫВАТЬ БЕЗОПАСНО (проверено на файле, а не предположено): `inverseBindMatrices` копий совпадают с
 * первым скином БИТ-В-БИТ (расхождение 0.0), порядок суставов одинаков во всех скинах, и ни один меш не лежит
 * внутри костной иерархии — значит удаление копий ничего не уносит.
 *
 * Чистый модуль (только THREE) → тестируется на синтетической сцене.
 */
import * as THREE from 'three';

export interface DedupeReport {
  /** Сколько разных скелетов было. */
  skins: number;
  /** Сколько мешей пере-привязано. */
  rebound: number;
  bonesBefore: number;
  bonesAfter: number;
  /** Удалённые корни дублей (для диагностики). */
  removed: string[];
}

/** Имя без хвоста-номера копии (`..._7`). Номер В ИМЕНИ кости (`Twist01`, `Index1`) не трогаем — там нет `_`. */
const base = (n: string): string => n.replace(/_\d+$/, '');
const isBone = (o: THREE.Object3D): boolean => (o as THREE.Bone).isBone === true;
/** В поддереве нет ничего, кроме костей → его можно снять целиком. */
function bonesOnly(o: THREE.Object3D): boolean {
  if (!isBone(o)) return false;
  for (const c of o.children) if (!bonesOnly(c)) return false;
  return true;
}
const depthOf = (o: THREE.Object3D): number => { let d = 0, p = o.parent; while (p) { d++; p = p.parent; } return d; };

/**
 * Схлопнуть дубликаты скелетов в один. Возвращает отчёт (в т.ч. «дублей не было» — тогда ничего не трогали).
 * Зовётся СРАЗУ после парса модели, до любых правок позы: опирается на бинд-позу.
 */
export function dedupeSkeletons(root: THREE.Object3D): DedupeReport {
  const meshes: THREE.SkinnedMesh[] = [];
  root.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o as THREE.SkinnedMesh); });
  const skels = [...new Set(meshes.map((m) => m.skeleton).filter(Boolean))];
  const countBones = (): number => { let n = 0; root.traverse((o) => { if (isBone(o)) n++; }); return n; };
  const bonesBefore = countBones();
  if (skels.length < 2) return { skins: skels.length, rebound: 0, bonesBefore, bonesAfter: bonesBefore, removed: [] };

  // КАНОН — самый ВНЕШНИЙ скелет: копии вложены внутрь него, и ретаргет ведёт именно его
  // (`retarget3d.boneIndex` резолвит кость С ДЕТЬМИ, то есть тоже внешнюю).
  const canon = skels.reduce((a, b) => (depthOf(b.bones[0]!) < depthOf(a.bones[0]!) ? b : a));
  const canonByName = new Map<string, THREE.Bone>();
  for (const b of canon.bones) canonByName.set(base(b.name), b);

  let rebound = 0;
  for (const m of meshes) {
    if (m.skeleton === canon) continue;
    const src = m.skeleton.bones;
    const mapped = src.map((b) => canonByName.get(base(b.name)));
    if (mapped.some((b) => !b)) continue;                    // чужой скелет (не копия) — не трогаем
    const sameOrder = mapped.every((b, i) => b === canon.bones[i]);
    // Порядок совпал → сажаем на ОБЩИЙ скелет (одна матрица-палитра на всех мешей, максимум выигрыша).
    // Не совпал → свой `Skeleton` поверх ТЕХ ЖЕ костей: палитра своя, но дубли костей всё равно уходят.
    m.bind(sameOrder ? canon : new THREE.Skeleton(mapped as THREE.Bone[], m.skeleton.boneInverses.slice()), m.bindMatrix);
    rebound++;
  }

  // Снять поддеревья костей, которые больше никому не нужны. Дубли вложены друг в друга, поэтому снятие
  // самого внешнего уносит все внутренние; меши внутри костей не лежат (проверено на файле), но на всякий
  // случай трогаем только те поддеревья, где ОДНИ КОСТИ.
  const keep = new Set<THREE.Object3D>(canon.bones);
  for (const m of meshes) for (const b of m.skeleton.bones) keep.add(b);
  const removed: string[] = [];
  const sweep = (o: THREE.Object3D): void => {
    for (const c of [...o.children]) {
      if (isBone(c) && !keep.has(c) && bonesOnly(c)) { o.remove(c); removed.push(c.name); continue; }
      sweep(c);
    }
  };
  sweep(root);
  root.updateMatrixWorld(true);
  return { skins: skels.length, rebound, bonesBefore, bonesAfter: countBones(), removed };
}

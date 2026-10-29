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
/** В поддереве нет ничего, кроме костей → снять его нечему повредить (меши внутрь не попадут). */
function bonesOnly(o: THREE.Object3D): boolean {
  if (!isBone(o)) return false;
  for (const c of o.children) if (!bonesOnly(c)) return false;
  return true;
}
/**
 * Есть ли В ПОДДЕРЕВЕ хоть одна НУЖНАЯ кость.
 *
 * ⚠ РАДИ ЭТОГО И ЗАВЕДЕНО. Раньше решение принималось по ОДНОМУ корню поддерева: «сам не нужен и
 * внутри одни кости → снести». У CC/AccuRIG верхний узел скелета — `RL_BoneRoot`: он КОСТЬ, но в
 * суставы скина НЕ входит, поэтому «не нужен» — и снос уносил ВЕСЬ скелет вместе с канон-копией.
 * Замер на knight_05.fbx: 3801 кость → 0, и все 3800 остались висеть ВНЕ дерева. Дальше меш ведёт
 * скелет, которого нет в сцене (значит, он не обновляется), а экспорт пишет суставы, которых нет в
 * файле (`joints: [null…]`) — такой GLB не грузится ничем.
 */
function hasKept(o: THREE.Object3D, keep: ReadonlySet<THREE.Object3D>): boolean {
  if (keep.has(o)) return true;
  for (const c of o.children) if (hasKept(c, keep)) return true;
  return false;
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

  // ⭐ КАНОН СОБИРАЕТСЯ ИЗ ИЕРАРХИИ, А НЕ ИЗ КАКОГО-ТО ОДНОГО СКИНА.
  //
  // Раньше каноном назначался самый внешний СКИН, и от остальных требовалось, чтобы все их кости
  // нашлись в нём. Это работает, только когда копии ПОЛНЫЕ. Замер на knight_06: 38 скинов по 6…36
  // костей — каждый меш скинится ТОЛЬКО на те кости, которые ему нужны. Канон-скин из шести костей
  // не мог принять меш из тридцати шести, поэтому не схлопывалось НИЧЕГО: 584 кости, 38 скелетов,
  // меш ехал на случайной копии — и модель разлеталась.
  //
  // Берём по каждому ИМЕНИ самый ВНЕШНИЙ экземпляр из дерева. Копии вложены внутрь оригиналов
  // (замерено: 650 узлов на 100 уникальных имён), поэтому внешние образуют связную иерархию — ту
  // самую, которую ведёт ретаргет (`boneIndex` тоже резолвит кость С ДЕТЬМИ, то есть внешнюю).
  //
  // ⚠ Схлопывать по имени БЕЗОПАСНО, и это проверено на файле, а не предположено: одноимённые кости
  // стоят в ОДНОЙ мировой точке (расхождение 0.0000) и имеют идентичные обратные бинд-матрицы
  // (0.000000). Если бы расходились — схлопывание сдвинуло бы меш.
  //
  // ⚠ И только В ПРЕДЕЛАХ ОДНОЙ АРМАТУРЫ. Костных поддеревьев в сцене может быть несколько (в файле
  // это редкость, а вот в тесте — норма), и сливать РАЗНЫЕ скелеты в один нельзя: это уже не
  // схлопывание дублей, а склейка двух персонажей. Берём самое большое поддерево, остальные не трогаем.
  const tops: THREE.Bone[] = [];
  root.traverse((o) => { if (isBone(o) && !(o.parent && isBone(o.parent))) tops.push(o as THREE.Bone); });
  const sizeOf = (o: THREE.Object3D): number => { let n = 0; o.traverse((c) => { if (isBone(c)) n++; }); return n; };
  const armature = tops.reduce<THREE.Bone | null>((a, b) => (!a || sizeOf(b) > sizeOf(a) ? b : a), null);
  const canonByName = new Map<string, THREE.Bone>();
  armature?.traverse((o) => {
    if (!isBone(o)) return;
    const k = base(o.name), prev = canonByName.get(k);
    if (!prev || depthOf(o) < depthOf(prev)) canonByName.set(k, o as THREE.Bone);
  });

  // ── ОДИН СКЕЛЕТ НА ВСЕХ. ──────────────────────────────────────────────────────────────────────
  // Мало посадить меши на общие КОСТИ: если у каждого свой набор (как после макса — от 6 до 36),
  // то и `Skeleton` у каждого свой, и в экспорт уедет по скину на меш — ровно то, от чего уходим.
  // Поэтому строим ОБЩИЙ набор (объединение по иерархии, порядок обхода — устойчивый) и
  // ПЕРЕНУМEРОВЫВАЕМ `skinIndex` каждого меша под него. Это и есть норма индустрии: одна арматура,
  // много мешей, один skin.
  const fit: { m: THREE.SkinnedMesh; mapped: THREE.Bone[] }[] = [];
  for (const m of meshes) {
    const mapped = m.skeleton.bones.map((b) => canonByName.get(base(b.name)));
    if (mapped.some((b) => !b)) continue;                    // чужой скелет (не копия) — не трогаем
    fit.push({ m, mapped: mapped as THREE.Bone[] });
  }
  // ⚠ В ОБЩИЙ НАБОР ИДЁТ ВСЯ АРМАТУРА, А НЕ ТОЛЬКО КОСТИ С ВЕСАМИ.
  //
  // Соблазн взять «только те, что кто-то использует» стоил сломанных рук. У этой модели скин руки
  // сидит на ТВИСТАХ (`UpperarmTwist01/02`, `ForearmTwist01/02`), а сами `Upperarm`/`Forearm` весов
  // не несут — из 100 костей вес имеет 61. Выкинув остальные, мы выкинули их и из ЭКСПОРТА, а в glTF
  // костью при загрузке становится ТОЛЬКО сустав скина: `CC_Base_L_Upperarm` приезжал обычным узлом,
  // `autoBoneMap` его не находил, ретаргет руку не вёл — рука оставалась в бинде (замер: joints 61
  // против 100 у прежней модели).
  //
  // Лишние суставы в скине ничего не стоят, а скелет обязан приехать целиком.
  const union: THREE.Bone[] = [];
  armature?.traverse((o) => { if (isBone(o) && canonByName.get(base(o.name)) === o) union.push(o as THREE.Bone); });
  const slot = new Map<THREE.Bone, number>();
  union.forEach((b, i) => slot.set(b, i));

  // Обратные бинд-матрицы: у кости с весами берём готовую (одноимённые совпадают бит-в-бит —
  // замерено), у кости без весов считаем из бинд-позы, как это делает сам `Skeleton`.
  const inv: THREE.Matrix4[] = union.map(() => new THREE.Matrix4());
  const invSet = new Set<number>();
  for (const f of fit) {
    f.mapped.forEach((b, i) => { const s = slot.get(b); if (s !== undefined && !invSet.has(s)) { inv[s]!.copy(f.m.skeleton.boneInverses[i]!); invSet.add(s); } });
  }
  root.updateMatrixWorld(true);
  union.forEach((b, i) => { if (!invSet.has(i)) inv[i]!.copy(b.matrixWorld).invert(); });
  // Если чей-то скелет УЖЕ ровно этот набор в том же порядке — берём его, а не плодим новый:
  // иначе «пере-привязано» считало бы работой то, что и так сделано.
  const same = (s: THREE.Skeleton): boolean => s.bones.length === union.length && s.bones.every((b, i) => b === union[i]);
  const shared = union.length ? (fit.map((f) => f.m.skeleton).find(same) ?? new THREE.Skeleton(union, inv)) : null;

  let rebound = 0;
  for (const f of fit) {
    if (!shared) break;
    if (f.m.skeleton === shared) continue;
    // ПЕРЕНУМЕРАЦИЯ ВЕСОВ: `skinIndex` указывает в СВОЙ массив костей, а массив теперь общий.
    const si = f.m.geometry.getAttribute('skinIndex');
    if (si) {
      for (let v = 0; v < si.count; v++) {
        for (let k = 0; k < 4; k++) {
          const old = si.getComponent(v, k);
          const b = f.mapped[old];
          si.setComponent(v, k, b ? slot.get(b)! : 0);
        }
      }
      si.needsUpdate = true;
    }
    f.m.bind(shared, f.m.bindMatrix);
    rebound++;
  }

  // Снять поддеревья костей, которые больше никому не нужны. Дубли вложены друг в друга, поэтому снятие
  // самого внешнего уносит все внутренние; меши внутри костей не лежат (проверено на файле), но на всякий
  // случай трогаем только те поддеревья, где ОДНИ КОСТИ.
  const keep = new Set<THREE.Object3D>(canonByName.values());
  for (const m of meshes) for (const b of m.skeleton.bones) keep.add(b);
  const removed: string[] = [];
  const sweep = (o: THREE.Object3D): void => {
    for (const c of [...o.children]) {
      // Снимаем поддерево, только если НИ ОДНА кость внутри не нужна. Проверять один корень мало:
      // у скелета есть служебный верхний узел, которого нет в суставах скина (см. `hasKept`).
      if (isBone(c) && bonesOnly(c) && !hasKept(c, keep)) { o.remove(c); removed.push(c.name); continue; }
      sweep(c);
    }
  };
  sweep(root);
  root.updateMatrixWorld(true);
  return { skins: skels.length, rebound, bonesBefore, bonesAfter: countBones(), removed };
}

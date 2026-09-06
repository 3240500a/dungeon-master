/**
 * FULL-BODY IK С ПИНАМИ (Ф4) — модель Cascadeur: закрепил точки, тянешь другую, тело решается целиком.
 *
 * ЧТО БЫЛО. `pose-editor.solveRig` гонял ЧЕТЫРЕ независимые двухкостные цепи (закон косинусов), а «пин»
 * использовался ровно в одном месте — как фильтр в `moveHips`, то есть в решение не входил вообще.
 * Спина и ключицы не участвовали никогда. Отсюда и жалоба «кручу таз — ноги едут за ним».
 *
 * ЧТО СТАЛО. FABRIK по ДЕРЕВУ костей + приведение позиций обратно в повороты + клэмп по пределам сустава,
 * и так несколько итераций. Пины — цели, которые решатель обязан удержать; перетаскиваемый контроллер —
 * «якорь», его позиция авторитетна.
 *
 * ТРИ РЕШЕНИЯ, КОТОРЫЕ ЗДЕСЬ ВАЖНЫ:
 *
 * 1. ЦЕПЬ ПРОИЗВОЛЬНОЙ ДЛИНЫ — требование к ПЕРВОЙ версии, а не доработка. Двухкостный солвер намертво
 *    завязан на «нога = бедро+голень»; на дигитигр-ноге (лишнее звено), на пальце (три фаланги) и на
 *    спине (4 звена) он не работает. FABRIK длину цепи не знает и знать не хочет.
 *
 * 2. КЛЭМП ВНУТРИ ИТЕРАЦИИ, а не после. Если зажимать углы в конце, решатель «договорится» о позе,
 *    которую сустав не может принять, и результат уедет. Зажимаем каждую итерацию и пересчитываем FK —
 *    следующая итерация решает уже от достижимой позы.
 *
 * 3. ПОЗИЦИИ → ПОВОРОТЫ ЧЕРЕЗ ПЕРВОГО РЕБЁНКА. Кость поворачивается так, чтобы её ПЕРВЫЙ ребёнок попал
 *    в посчитанную точку. Для цепей это точно; для развилок (таз → спина + две ноги) таз доворачивается
 *    по спине, а ноги отрабатывают своими суставами — то, что и нужно.
 *
 * Файл ЧИСТЫЙ (THREE + наш скелет, без DOM) — тестируется в node.
 */
import * as THREE from 'three';
import type { Humanoid } from './humanoid.js';
import type { LimitView } from './humanoidRagdoll.js';
import { clampLocalToLimit } from './jointClamp.js';

export interface FbikOptions {
  /** Пределы сустава по имени кости; нет → кость не зажимается. */
  limits?: (bone: string) => LimitView | null;
  /** Сколько проходов FABRIK за вызов (по умолч. 8). */
  iterations?: number;
  /** Порог остановки: макс. промах цели в юнитах (по умолч. 0.05). */
  tolerance?: number;
}

interface Node {
  name: string;
  parent: number;          // −1 = корень
  children: number[];
  len: number;             // расстояние до родителя в rest (константа: это и есть длина кости)
}

export interface FbikRig {
  /** Имена костей в порядке «родитель раньше ребёнка». */
  readonly bones: readonly string[];
  /**
   * Решить позу.
   * @param targets  куда должны попасть кости (мировые точки) — сюда идут И пины, И перетаскиваемые эффекторы
   * @param anchor   кость, чья позиция авторитетна (перетаскиваемая); от неё идёт прямой проход
   * @returns макс. остаточный промах по целям (юниты)
   */
  solve(
    targets: Map<string, THREE.Vector3>,
    anchor?: { bone: string; pos: THREE.Vector3 } | null,
    /**
     * МАСКА АКТИВНЫХ КОСТЕЙ (Ф21.3) — аналог Chain Length в IK-констрейнте Blender.
     * Кость вне маски ЖЁСТКАЯ: не сеется, не участвует в FABRIK и НЕ получает новый кватернион —
     * авторская поза на ней сохраняется. `undefined` = весь скелет, как было до Ф21.
     *
     * Зачем: без маски решается ВЕСЬ скелет от перетаскиваемой точки. Замерено на knight_05:
     * тянешь ПРАВУЮ кисть на 3u — ЛЕВАЯ уезжает на 13.3u, голени на 6.5u, носки на 6.2u.
     * В Blender это же сказано прямым текстом: Chain Length = 0 гонит солвер до корня и тянет
     * спину с торсом — «обычно это не то, что нужно».
     */
    active?: ReadonlySet<string> | null,
    /**
     * ПОЛЮСЫ (Ф21.5): кость-шарнир (предплечье/голень) → направление, куда смотрит локоть/колено.
     * Без них сторона сгиба берётся из ЗНАКА ПРЕДЕЛА — то есть ручная докрутка сустава терялась
     * при первом же драге эффектора.
     */
    poles?: ReadonlyMap<string, THREE.Vector3> | null,
  ): number;
  /** Мировые позиции костей (после последнего solve). */
  worldPos(bone: string): THREE.Vector3 | null;
}

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const IDENT = new THREE.Quaternion();

export function makeFullBodyIk(human: Humanoid, opts: FbikOptions = {}): FbikRig {
  const iterations = opts.iterations ?? 12;   // 8 не дотягивал пины при боковой тяге таза (промах 1.4 юнита)
  const tolerance = opts.tolerance ?? 0.05;
  const limitOf = opts.limits;

  // ── топология: порядок родитель-раньше-ребёнка (в таблице скелета он уже такой) ──
  // Root ИСКЛЮЧЁН из решения: это позиция персонажа, а не сустав. Корень IK — таз.
  const names = human.boneNames.filter((n) => n !== 'Root');
  const index = new Map<string, number>(names.map((n, i) => [n, i]));
  const nodes: Node[] = names.map((n) => ({ name: n, parent: -1, children: [], len: 0 }));
  for (let i = 0; i < names.length; i++) {
    const b = human.bones.get(names[i]!)!;
    const p = b.parent && index.has(b.parent.name) ? index.get(b.parent.name)! : -1;
    nodes[i]!.parent = p;
    if (p >= 0) { nodes[p]!.children.push(i); nodes[i]!.len = b.position.length(); }
  }

  const pos: THREE.Vector3[] = names.map(() => new THREE.Vector3());
  const work: THREE.Vector3[] = names.map(() => new THREE.Vector3());
  const proposals: THREE.Vector3[][] = names.map(() => []);

  const hipsIdx = index.get('Hips') ?? 0;
  /** Активна ли кость в ТЕКУЩЕМ решении (см. `solve(…, active)`). Всё включено, пока маску не задали. */
  const on: boolean[] = names.map(() => true);
  const setMask = (active?: ReadonlySet<string> | null): void => {
    for (let i = 0; i < names.length; i++) on[i] = !active || active.has(names[i]!);
  };
  const readFk = (): void => {
    human.root.updateMatrixWorld(true);
    for (let i = 0; i < names.length; i++) human.bones.get(names[i]!)!.getWorldPosition(pos[i]!);
  };
  /**
   * Записать посчитанную позицию ТАЗА обратно в скелет.
   * Без этого шага солвер бесполезен: FK у нас чисто вращательный, единственная авторская ПОЗИЦИЯ —
   * офсет таза под Root. Раньше вычисленный `pos[Hips]` просто терялся, поэтому якорь не действовал,
   * а пины «уезжали» — тест на присед ловил промах 3.4 юнита.
   */
  function writeHipsPosition(): void {
    human.root.updateMatrixWorld(true);
    human.root.getWorldPosition(_v1);                       // Root без поворота → мировая = позиция персонажа
    human.hips.position.copy(pos[hipsIdx]!).sub(_v1);
    human.root.updateMatrixWorld(true);
  }

  /**
   * ЗАСЕВ ШАРНИРОВ. Из идеально прямой конечности FABRIK выбирает плоскость сгиба ПРОИЗВОЛЬНО:
   * замер показал колено, согнутое на −92.6° вокруг Z (вбок) при нулевом X. Дальше клэмп-шарнир,
   * разрешающий только X, выбрасывает всю эту компоненту — решение не сходится вовсе (промах рос
   * до 20 юнитов и застревал). Лечится не более сильным клэмпом, а НЕВЫРОЖДЕННЫМ СТАРТОМ: если сустав
   * почти прям, подгибаем его на пару градусов в разрешённую пределом сторону. Дальше FABRIK держит
   * эту плоскость сам, и клэмп с ним согласен.
   */
  function seedHinges(): void {
    if (!limitOf) return;
    for (let i = 0; i < names.length; i++) {
      if (!on[i]) continue;                                         // Ф21.3: жёсткую кость не подгибаем
      const nm = names[i]!;
      const view = limitOf(nm);
      if (!view || view.kind !== 'hinge' || !view.axis) continue;
      const b = human.bones.get(nm)!;
      if (b.quaternion.angleTo(IDENT) > 0.05) continue;             // уже согнут — не мешаем
      const lo = view.min ?? 0, hi = view.max ?? 0;
      const dir = Math.abs(hi) >= Math.abs(lo) ? 1 : -1;            // куда сустав реально гнётся
      const a = Math.min(0.12, Math.abs(dir > 0 ? hi : lo) * 0.5);
      if (a < 1e-4) continue;
      _v1.set(view.axis[0], view.axis[1], view.axis[2]).normalize();
      b.quaternion.setFromAxisAngle(_v1, dir * a);
    }
    human.root.updateMatrixWorld(true);
  }

  /** Один проход FABRIK по дереву: назад (от целей к корню) и вперёд (от якоря вниз). */
  function fabrikPass(targets: Map<number, THREE.Vector3>, anchorIdx: number, anchorPos: THREE.Vector3): void {
    for (const a of proposals) a.length = 0;
    for (let i = 0; i < names.length; i++) work[i]!.copy(pos[i]!);

    // НАЗАД: от листьев к корню. Цель тянет кость в свою точку, а родителю предлагается позиция
    // на расстоянии длины кости в сторону его ТЕКУЩЕГО положения. Развилки усредняют предложения детей.
    for (let i = names.length - 1; i >= 0; i--) {
      if (!on[i]) continue;                                         // Ф21.3: жёсткая кость остаётся там, где её выставила авторская поза
      const t = targets.get(i);
      if (t) work[i]!.copy(t);
      else if (proposals[i]!.length) {
        work[i]!.set(0, 0, 0);
        for (const p of proposals[i]!) work[i]!.add(p);
        work[i]!.multiplyScalar(1 / proposals[i]!.length);
      }
      const par = nodes[i]!.parent;
      if (par >= 0 && on[par]) {                                    // Ф21.3: за границу маски тяга не передаётся — это и есть «длина цепи»
        _v1.copy(pos[par]!).sub(work[i]!);
        const l = _v1.length();
        if (l > 1e-6) _v1.multiplyScalar(nodes[i]!.len / l); else _v1.set(0, nodes[i]!.len, 0);
        proposals[par]!.push(new THREE.Vector3().copy(work[i]!).add(_v1));
      }
    }

    // ВПЕРЁД: якорь стоит там, где сказано; дети восстанавливают длины костей по направлению к своей
    // цели из обратного прохода. Якорь — это перетаскиваемый контроллер (или корень, если ничего не тянут).
    for (let i = 0; i < names.length; i++) pos[i]!.copy(work[i]!);
    pos[anchorIdx]!.copy(anchorPos);
    const order: number[] = [];
    const push = (i: number): void => { if (!on[i]) return; order.push(i); for (const c of nodes[i]!.children) push(c); };
    // от якоря вниз по его поддереву
    push(anchorIdx);
    // остальные корни поддеревьев (если якорь не корень — вверх по родителям тоже надо восстановить)
    let up = nodes[anchorIdx]!.parent;
    let child = anchorIdx;
    while (up >= 0 && on[up]) {                                     // Ф21.3: подъём останавливается на границе маски
      _v1.copy(pos[up]!).sub(pos[child]!);
      const l = _v1.length();
      if (l > 1e-6) _v1.multiplyScalar(nodes[child]!.len / l); else _v1.set(0, nodes[child]!.len, 0);
      pos[up]!.copy(pos[child]!).add(_v1);
      for (const c of nodes[up]!.children) if (c !== child) push(c);
      child = up; up = nodes[up]!.parent;
    }
    for (const i of order) {
      const par = nodes[i]!.parent;
      if (par < 0) continue;
      _v1.copy(pos[i]!).sub(pos[par]!);
      const l = _v1.length();
      if (l > 1e-6) _v1.multiplyScalar(nodes[i]!.len / l); else _v1.set(0, nodes[i]!.len, 0);
      pos[i]!.copy(pos[par]!).add(_v1);
    }
  }

  /**
   * ПОЛЮС ДЛЯ ШАРНИРОВ. Колено/локоть — одна ось, и плоскость сгиба задана анатомией, а не солвером.
   * Чистый FABRIK этого не знает: из прямой ноги он сгибал колено ВБОК (замер: бедро Z+44°, голень Z−93°),
   * после чего клэмп-шарнир выбрасывал всю Z-компоненту, нога распрямлялась и решение застревало
   * с промахом 20 юнитов. Поэтому среднее звено таких цепей ставим АНАЛИТИЧЕСКИ: пересечение двух сфер,
   * выбранное в плоскости, перпендикулярной оси шарнира. Из двух решений берём ближнее к текущему —
   * вместе с засевом (seedHinges) это удерживает анатомическую сторону сгиба.
   * Остальные цепи (спина, пальцы, лишние звенья) по-прежнему решает FABRIK — длину цепи он не знает.
   */
  /** ПОЛЮСЫ текущего солва (Ф21.5). Живёт ровно один вызов `solve`. */
  let poleOf: ReadonlyMap<string, THREE.Vector3> | null = null;

  function placeHingeMids(): void {
    if (!limitOf) return;
    for (let m = 0; m < names.length; m++) {
      if (!on[m]) continue;                                         // Ф21.3
      const view = limitOf(names[m]!);
      if (!view || view.kind !== 'hinge' || !view.axis) continue;
      const r = nodes[m]!.parent, e = nodes[m]!.children[0];
      if (r < 0 || e === undefined || !on[r] || !on[e]) continue;   // оба соседа тоже должны быть в решении
      const L1 = nodes[m]!.len, L2 = nodes[e]!.len;
      if (L1 < 1e-6 || L2 < 1e-6) continue;

      _v1.copy(pos[e]!).sub(pos[r]!);                       // корень → конец
      let d = _v1.length();
      if (d < 1e-6) continue;
      d = Math.min(Math.max(d, Math.abs(L1 - L2) + 1e-3), L1 + L2 - 1e-3);
      _v1.normalize();

      // ось шарнира в мире — по ориентации РОДИТЕЛЯ звена (ось задана в локали самого звена)
      const parentBone = human.bones.get(names[m]!)!.parent;
      if (parentBone) parentBone.getWorldQuaternion(_q1); else _q1.identity();
      _v2.set(view.axis[0], view.axis[1], view.axis[2]).applyQuaternion(_q1).normalize();
      // СТОРОНА СГИБА — из РАЗРЕШЁННОГО ДИАПАЗОНА, а не по близости к текущему:
      // у прямой конечности оба решения равноудалены, и выбор по близости уводил колено НАЗАД (z=-10.5).
      // Положительный поворот звена вокруг оси уводит КОНЕЦ назад, то есть СРЕДНЕЕ ЗВЕНО — вперёд
      // по cross(направление, ось). Знак берём по тому, куда сустав вообще гнётся (|max| или |min| больше).
      // ПОЛЮС ИМЕЕТ ПРИОРИТЕТ (Ф21.5). До этого `e.pole` в FBIK-пути НЕ ЧИТАЛСЯ вовсе: оранжевые
      // ручки локтя/колена таскались, а сгиб не менялся. И так как `syncEff` снимает полюс С ЖИВОЙ
      // ПОЗЫ при каждом захвате, драг теперь СОХРАНЯЕТ авторскую сторону сгиба, а не сбрасывает
      // её в «куда разрешает предел». Знак предела остаётся фолбэком — он починил «колено назад» (Ф4).
      const pl = poleOf ? poleOf.get(names[m]!) : undefined;
      let aimed = false;
      if (pl) {
        _v3.copy(pl).addScaledVector(_v1, -pl.dot(_v1));     // компонента полюса перпендикулярно линии корень→конец
        if (_v3.lengthSq() > 1e-9) { _v3.normalize(); aimed = true; }
      }
      if (!aimed) {
        _v3.crossVectors(_v1, _v2);
        if (_v3.lengthSq() < 1e-9) continue;
        _v3.normalize();
        const lo = view.min ?? 0, hi = view.max ?? 0;
        if (Math.abs(lo) > Math.abs(hi)) _v3.negate();
      }

      const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
      const hgt = Math.sqrt(Math.max(0, L1 * L1 - a * a));
      pos[m]!.copy(pos[r]!).addScaledVector(_v1, a).addScaledVector(_v3, hgt);
    }
  }

  /** Позиции → повороты: каждая кость доворачивается так, чтобы её ПЕРВЫЙ ребёнок попал в цель. */
  function positionsToRotations(): void {
    if (on[hipsIdx]) writeHipsPosition();                           // таз вне маски — персонаж не едет
    for (let i = 0; i < names.length; i++) {
      const kid = nodes[i]!.children[0];
      if (kid === undefined) continue;
      // Ф21.3: кость вне маски НЕ получает новый кватернион. И если её ПЕРВЫЙ РЕБЁНОК
      // вне маски — тоже не получает: иначе кость доворачивалась бы на УСТАРЕВШУЮ точку.
      // Побочный и желанный эффект: кисть больше не «целится в первый палец» и не крутит оружие.
      if (!on[i] || !on[kid]) continue;
      const bone = human.bones.get(names[i]!)!;
      const kidBone = human.bones.get(names[kid]!)!;
      bone.updateMatrixWorld(true);
      bone.getWorldPosition(_v1);
      kidBone.getWorldPosition(_v2);
      _v2.sub(_v1);                                        // текущее направление на ребёнка
      _v3.copy(pos[kid]!).sub(pos[i]!);                    // желаемое
      if (_v2.lengthSq() < 1e-9 || _v3.lengthSq() < 1e-9) continue;
      _q1.setFromUnitVectors(_v2.normalize(), _v3.normalize());   // дельта в МИРЕ
      bone.getWorldQuaternion(_q2);
      _q1.multiply(_q2);                                   // новый мировой поворот кости
      const par = bone.parent;
      if (par) { par.getWorldQuaternion(_q2); _q1.premultiply(_q2.invert()); }
      const view = limitOf ? limitOf(names[i]!) : null;
      bone.quaternion.copy(view ? clampLocalToLimit(_q1, view) : _q1);
      bone.updateMatrixWorld(true);
    }
  }

  return {
    bones: names,
    worldPos(bone) { const i = index.get(bone); return i === undefined ? null : pos[i]!.clone(); },
    solve(targets, anchor, active, poles) {
      setMask(active);
      poleOf = poles ?? null;
      seedHinges();
      readFk();
      const tIdx = new Map<number, THREE.Vector3>();
      for (const [nm, p] of targets) { const i = index.get(nm); if (i !== undefined) tIdx.set(i, p); }
      const anchorIdx = anchor ? (index.get(anchor.bone) ?? 0) : 0;
      const anchorPos = anchor ? anchor.pos.clone() : pos[anchorIdx]!.clone();
      if (!tIdx.size) { return 0; }

      let worst = Infinity;
      for (let it = 0; it < iterations; it++) {
        fabrikPass(tIdx, anchorIdx, anchorPos);
        placeHingeMids();
        positionsToRotations();
        readFk();                                          // клэмп мог сместить кости — считаем промах по ФАКТУ
        worst = 0;
        for (const [i, t] of tIdx) worst = Math.max(worst, pos[i]!.distanceTo(t));
        if (worst <= tolerance) break;
      }
      return worst;
    },
  };
}

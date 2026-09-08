/**
 * ТВИСТ-КОСТИ (roll bones) — РАСТЯГИВАЮТ ОБОРОТ ПО ДЛИНЕ КОСТИ, ЧТОБЫ МЕШ НЕ СКРУЧИВАЛО «ФАНТИКОМ».
 *
 * ЗАЧЕМ. Оборот конечности физически сидит в ОДНОМ суставе (плечо крутит всю плечевую кость), а кожа так себя не
 * ведёт: у дельты она почти не крутится, у локтя крутится полностью. Если этого не распределить, скин у сустава
 * сжимается в «конфетный фантик» — юзер поймал это на замахе топором, где плечу нужен полный оборот.
 *
 * Такие кости УЖЕ ЕСТЬ в моделях (CC: `..._UpperarmTwist01/02`, `..._ForearmTwist01/02`, `ThighTwist`, `CalfTwist`),
 * в стоковых скелетах UE (`upperarm_twist_01`, `lowerarm_twist_01`) — это стандарт риггинга. Наш ретаргет их не вёл:
 * непривязанные кости «остаются на иерархии», то есть жёстко повторяют родителя и НИЧЕГО не распределяют.
 *
 * ПРАВИЛО ДОЛИ — по положению вдоль кости (формулировка Cascadeur: кость ровно посередине между плечом и локтем
 * получает 0.5, то есть 50% поворота). Считаем `frac` из ФАКТИЧЕСКИХ бинд-позиций, а не по номеру в имени: у разных
 * моделей твистов может быть один, два или ни одного.
 *
 * ДВА РЕЖИМА, и это не косметика — источник оборота у них РАЗНЫЙ:
 *   `untwist` (плечо, бедро): крутит САМ сегмент, кожа у корня крутиться не должна → у корня 0, у дальнего конца 100%.
 *      Кость наследует полный оборот от родителя, поэтому локально её надо ОТКРУТИТЬ на `(frac − 1)·roll`.
 *   `twist` (предплечье, голень): сегмент не крутится вовсе — пронацию несёт КИСТЬ (стопа). У локтя 0, у запястья
 *      100% → локально `+frac·roll` кисти.
 *
 * ⚠ ТВИСТЫ ВЛОЖЕНЫ ДРУГ В ДРУГА (CC: `Twist02` — ребёнок `Twist01`), поэтому доли применяются ПРИРАЩЕНИЯМИ:
 * иначе `Twist02` получил бы свою долю поверх уже применённой доли `Twist01` и оборот удвоился бы.
 *
 * Чистый модуль (только THREE) → тестируется на синтетическом скелете, без DOM и без загрузки моделей.
 */
import * as THREE from 'three';

/** Сегменты, вдоль которых бывают твист-кости: [наш сегмент, наш ребёнок (он же источник для `twist`), режим]. */
export const TWIST_SEGMENTS: readonly [string, string, 'untwist' | 'twist'][] = [
  ['LeftUpperArm', 'LeftLowerArm', 'untwist'], ['RightUpperArm', 'RightLowerArm', 'untwist'],
  ['LeftLowerArm', 'LeftHand', 'twist'], ['RightLowerArm', 'RightHand', 'twist'],
  ['LeftUpperLeg', 'LeftLowerLeg', 'untwist'], ['RightUpperLeg', 'RightLowerLeg', 'untwist'],
  ['LeftLowerLeg', 'LeftFoot', 'twist'], ['RightLowerLeg', 'RightFoot', 'twist'],
];

interface TwistNode {
  node: THREE.Object3D;
  restLocal: THREE.Quaternion;
  /** Ось сегмента в ЛОКАЛЬНОМ фрейме РОДИТЕЛЯ этой кости (родитель едет с сегментом → ось остаётся верной). */
  axis: THREE.Vector3;
  /** Сколько оборота эта кость должна нести СВЕРХ своего родителя-твиста (уже приращение). */
  gain: number;
}
export interface TwistChain {
  /** НАША кость, чей поворот даёт `roll` (сегмент для `untwist`, его ребёнок для `twist`). */
  ourSrc: string;
  /** НАШ сегмент — нужен, чтобы взять ось (направление на ребёнка в его локальном фрейме). */
  ourSeg: string;
  ourChild: string;
  nodes: TwistNode[];
  /** Крен прошлого кадра — для развёртки через ±180° (иначе кость делает оборот на ровном месте). */
  lastRoll: number;
}

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Quaternion(), _qi = new THREE.Quaternion();
const norm = (n: string): string => n.toLowerCase().replace(/[\s_.:|-]/g, '');
/**
 * Твист ЭТОГО сегмента? Убираем из имени `twist<NN>` и сравниваем с именем сегмента:
 *   `CC_Base_L_UpperarmTwist01` → `ccbaselupperarm` === `CC_Base_L_Upperarm` ✓
 *   `upperarm_twist_01_l`       → `upperarml`       === `upperarm_l`         ✓ (конвенция UE)
 *
 * ⚠ ЭТО НЕ ПРИДИРКА К ИМЕНАМ, А ЗАЩИТА ОТ ВЗРЫВА МОДЕЛИ. Раньше брали любой узел с «twist» в поддереве сегмента, и
 * на МОДУЛЬНОМ рыцаре обход от плеча собрал 76 костей: у CC под каждой ведомой костью висят КОПИИ под-скелета на
 * каждый сабмеш (`...Twist01_1` … `_37`), а под дублем сегмента лежит копия остального скелета — в цепь плеча
 * попадали даже твисты ног. Копии обязаны просто НАСЛЕДОВАТЬ родителя; стоит погнать в них свои доли — меш
 * разлетается. Суффикс `_N` не проходит проверку (`ccbaselupperarm5 ≠ ccbaselupperarm`), чужая конечность тоже.
 */
const isTwistOf = (name: string, segName: string): boolean =>
  // Токен `twist<NN>` вырезаем ДО нормализации — иначе разделитель пропадает и `Twist01_7` схлопывается в
  // `twist017`, `\d*` съедает номер КОПИИ вместе с номером твиста, и дубли сабмешей проходят проверку (поймано тестом).
  /twist/i.test(name) && norm(name.replace(/[\s_.:|-]*twist[\s_.:|-]*\d*/i, '')) === norm(segName);

/** Знаковый угол закрутки `q` вокруг `axis` (swing-twist, правый множитель).
 *  ⚠ Свой временный вектор `_w`: вызывающий передаёт сюда `_v`, и запись в него сложила бы скалярное
 *  произведение вектора С САМИМ СОБОЙ (поймано падающим тестом — доли получались произвольными). */
function rollAngle(q: THREE.Quaternion, axis: THREE.Vector3): number {
  const d = _w.set(q.x, q.y, q.z).dot(axis);
  const w = q.w;
  const l = Math.hypot(d, w);
  if (l < 1e-9) return 0;
  return 2 * Math.atan2(d / l, w / l);
}

/**
 * Найти твист-цепи в загруженном скелете. Зовётся ОДИН РАЗ на бинде (модель обязана стоять в бинд-позе:
 * доли и оси снимаются отсюда). Нет твист-костей — вернётся пустой массив, и всё работает как раньше.
 */
export function findTwistChains(
  byName: Map<string, THREE.Object3D>,
  boneMap: Record<string, string>,
): TwistChain[] {
  const out: TwistChain[] = [];
  for (const [ourSeg, ourChild, mode] of TWIST_SEGMENTS) {
    const seg = byName.get(boneMap[ourSeg] ?? ''), child = byName.get(boneMap[ourChild] ?? '');
    if (!seg || !child) continue;
    const segPos = seg.getWorldPosition(new THREE.Vector3());
    const dirW = child.getWorldPosition(new THREE.Vector3()).sub(segPos);
    const len = dirW.length(); if (len < 1e-4) continue;
    dirW.multiplyScalar(1 / len);
    // собрать твисты в поддереве сегмента, НЕ заходя в дочерний сегмент (там свои твисты и своя цепь)
    const found: { node: THREE.Object3D; frac: number; depth: number }[] = [];
    const segName = seg.name;
    const walk = (n: THREE.Object3D, depth: number): void => {
      if (depth > 6) return;                       // страховка от дублей-подскелетов CC
      for (const c of n.children) {
        if (c === child || norm(c.name) === norm(segName)) continue;   // дочерний сегмент и САМО-ДУБЛЬ не обходим
        if (isTwistOf(c.name, segName)) {
          const p = c.getWorldPosition(new THREE.Vector3()).sub(segPos);
          found.push({ node: c, frac: Math.min(1, Math.max(0, p.dot(dirW) / len)), depth });
        }
        walk(c, depth + 1);
      }
    };
    walk(seg, 0);
    if (!found.length) continue;
    found.sort((a, b) => a.depth - b.depth || a.frac - b.frac);
    // Доля по положению — если положения ОСМЫСЛЕННЫЕ. У CC они не такие: ЗАМЕР на рыцаре — `UpperarmTwist01`
    // стоит РОВНО в суставе (0%), `Twist02` в 3%; у них рампу делают веса скина, а костям нужны просто
    // градуированные повороты. Плюс конформ длин двигает сам сегмент, но не твист-цепь, так что положения ещё и
    // разъезжаются по масштабу. Поэтому: слиплись у корня → раскладываем РАВНОМЕРНО по порядку (1/3, 2/3 для двух).
    const anySpread = found.some((f) => f.frac > 0.15);
    const chain: TwistChain = {
      ourSrc: mode === 'untwist' ? ourSeg : ourChild, ourSeg, ourChild, nodes: [], lastRoll: 0,
    };
    let prev = 0;
    found.forEach((f, i) => {
      const frac = anySpread ? f.frac : (i + 1) / (found.length + 1);
      // untwist: хотим НЕСТИ frac от оборота, а наследуем полный → сверх родителя нужно (frac − 1);
      // twist:   сегмент оборота не несёт → сверх родителя нужно ровно frac.
      const want = mode === 'untwist' ? frac - 1 : frac;
      const parent = f.node.parent ?? f.node;
      chain.nodes.push({
        node: f.node,
        restLocal: f.node.quaternion.clone(),
        axis: dirW.clone().applyQuaternion(_qi.copy(parent.getWorldQuaternion(_q)).invert()).normalize(),
        gain: want - prev,
      });
      prev = want;
    });
    out.push(chain);
  }
  return out;
}

const TAU = Math.PI * 2;
/**
 * Разложить текущий оборот по твист-костям. Зовётся КАЖДЫЙ КАДР, после того как основные кости уже приведены.
 *
 * ⚠ КРЕН БЕРЁМ ИЗ НАШЕГО РИГА, А НЕ ИЗ КОСТЕЙ МОДЕЛИ. Сначала я мерил его как «поворот кости модели относительно её
 * БИНДА» — и получил закрутку ног и предплечья на ровном месте: бинд у CC это A-поза со своим хватом кисти и своим
 * поворотом стопы, так что базовый рассинхрон бинда с нашей канон-T целиком уезжал в твисты. У нашего рига рест =
 * identity, поэтому локальный кватернион кости И ЕСТЬ авторский поворот: в T-позе крен ровно 0, а дальше ровно то,
 * что задал аниматор.
 *
 * ⚠ РАЗВЁРТКА ЧЕРЕЗ ±180°. `2·atan2` даёт угол со скачком на 2π, и твист-кость делала полный оборот на ровном месте
 * (жалоба «при небольшом повороте делают оборот»). Приводим кватернион к кратчайшему знаку и разматываем к крену
 * прошлого кадра — шаг за кадр меньше π всегда.
 */
export function driveTwistChains(chains: readonly TwistChain[], driver: { bones: Map<string, THREE.Object3D> }): void {
  for (const ch of chains) {
    const src = driver.bones.get(ch.ourSrc), seg = driver.bones.get(ch.ourSeg), kid = driver.bones.get(ch.ourChild);
    if (!src || !seg || !kid) continue;
    _v.copy(kid.position).normalize();                       // ось сегмента в его локальном (рест) фрейме
    _q.copy(src.quaternion);
    if (_q.w < 0) { _q.x = -_q.x; _q.y = -_q.y; _q.z = -_q.z; _q.w = -_q.w; }   // кратчайшее представление
    let roll = rollAngle(_q, _v);
    roll += Math.round((ch.lastRoll - roll) / TAU) * TAU;    // развёртка к прошлому кадру
    ch.lastRoll = roll;
    for (const t of ch.nodes) {
      t.node.quaternion.copy(_qi.setFromAxisAngle(t.axis, t.gain * roll)).multiply(t.restLocal);
    }
  }
}

/** Отчёт для редактора/диагностики: какие твисты найдены и с какими долями. */
export function twistReport(chains: readonly TwistChain[]): { bone: string; gain: number }[] {
  const out: { bone: string; gain: number }[] = [];
  for (const ch of chains) for (const t of ch.nodes) out.push({ bone: t.node.name, gain: +t.gain.toFixed(3) });
  return out;
}

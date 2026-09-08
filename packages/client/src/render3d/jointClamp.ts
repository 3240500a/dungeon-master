/**
 * КЛЭМП ЛОКАЛЬНОГО ПОВОРОТА КОСТИ К ПРЕДЕЛУ СУСТАВА — ТОНКИЙ АДАПТЕР НАД `jointDof.ts`.
 *
 * ОДНА МОДЕЛЬ НА ВЕСЬ РЕДАКТОР. Раньше их было две: гизмо/клэмп жили в swing-лог-карте (rP,rN вокруг plane/normal
 * + твист), а после Ф2 драг кольца правит ЭЙЛЕРОВЫ СКАЛЯРЫ (`jointDof`). Области у них РАЗНЫЕ, и это ловилось живьём:
 * ИК уводил плечо в `plane = −143°` (swing-конус такое пускает), после чего ПЕРВОЕ ЖЕ касание кольца зажимало позу
 * до −97.4° — скачок 46°. Теперь параметризация ровно одна: солвер не может оставить кость там, где гизмо её не
 * удержит, а нарисованная зона предела (`poseLimitGizmo`) строится теми же углами → гизмо = клэмп = зона.
 *
 * НАКОПИТЕЛЯ БОЛЬШЕ НЕТ (был `lastValid`/`ACC_MARGIN`, память по кости). Он лечил СЛЕДСТВИЕ: разложение кватерниона
 * в цикле драга давало угол только в (−π,π], и «дотянул до 181°» читалось как −179°. В драге разложения больше нет
 * (углы копит сам редактор от точки захвата), а тут остались НЕ-интерактивные писатели — солверы, для которых
 * лимит обязан быть ЧИСТОЙ ФУНКЦИЕЙ, как в Blender. Память в итеративном солвере ещё и вредна: он зовёт клэмп
 * по несколько раз за один солв, и «шаги пользователя» ей мерещились бы на каждой итерации.
 *
 * Чистый модуль: только THREE + СТРУКТУРНЫЙ тип предела (тип импортится type-only → node-тест не тянет DOM env3d).
 * Rest-фрейм костей гуманоида = identity (T-поза), поэтому клэмпим локальный кватернион напрямую (= отклонение от покоя).
 */
import * as THREE from 'three';
import type { LimitView } from './humanoidRagdoll.js';
import { dofSpec, quatFromDof, dofFromQuat, type Dof } from './jointDof.js';
import { limitLocalV2 } from './jointLimitV2.js';

/**
 * ПЕРЕКЛЮЧАТЕЛЬ СИСТЕМЫ СУСТАВОВ (тумблер в редакторе, дефолт — v2).
 *   v1 — наша модель «скаляры это поза» (`jointDof`): кольцо правит скаляр, кватернион пересобирается;
 *   v2 — порт FinalIK (`jointLimitV2`): поза = кватернион, гизмо крутит свободно, предел ТОЛЬКО останавливает.
 * Живёт здесь, потому что через `clampLocalToLimit` ходят ВСЕ писатели (редактор ×8 + `fullBodyIk`), и переключать
 * надо их разом, иначе солвер и гизмо снова разъедутся по разным областям.
 */
let LIMIT_V = 2;
export function setLimitVersion(v: 1 | 2): void { LIMIT_V = v; }
export function limitVersion(): 1 | 2 { return LIMIT_V as 1 | 2; }

const TAU = Math.PI * 2;
/** Свернуть угол в (−π, π]. */
const wrapPi = (a: number): number => { const x = (a + Math.PI) % TAU; return (x < 0 ? x + TAU : x) - Math.PI; };
/**
 * Клэмп УГЛА к [min,max] ПО КРУГУ: за пределом выбираем границу, БЛИЖАЙШУЮ ПО ДУГЕ, а не численно.
 * Это буквально `clamp_angle` из Blender 4.2 (их фикс «непредсказуемые перевороты костей»).
 * ЗАЧЕМ: кватернион всегда отдаёт КРАТЧАЙШИЙ угол ∈ (−π,π], поэтому «дотянули на 181°» читается как −179°, и
 * наивный Math.min/max кидал кость к ПРОТИВОПОЛОЖНОМУ упору — локоть из полного сгиба щёлкал в переразгиб.
 * По дуге −179° лежит в 43° от max(137°) и в 173° от min(−6°) → упираемся в max, как и ожидает рука.
 *
 * В драге кольца это НЕ нужно (там угол непрерывный, свой накопитель) — там работает скалярный `clampDof`.
 */
export function clampAngle(a: number, min: number, max: number): number {
  if (a >= min && a <= max) return a;
  return Math.abs(wrapPi(a - min)) <= Math.abs(wrapPi(a - max)) ? min : max;
}

/** Клэмпнуть локальный кватернион `q` к пределу `view`. Возвращает НОВЫЙ THREE.Quaternion (q не мутируется). */
export function clampLocalToLimit(q: THREE.Quaternion, view: LimitView, key?: object): THREE.Quaternion {
  if (LIMIT_V === 2) return limitLocalV2(q, view, key);
  const s = dofSpec(view);
  const th = dofFromQuat(view, q);
  for (let i = 0; i < 3; i++) th[i] = s.locked[i] ? 0 : clampAngle(th[i]!, s.min[i]!, s.max[i]!);
  return quatFromDof(view, th);
}

/**
 * СОБРАТЬ кватернион из компонент сустава (rP, rN, twist) — обратная к `decomposeToLimit`.
 * Имена компонент историчны (rP=вокруг plane, rN=вокруг normal), смысл теперь эйлеров — см. `jointDof`.
 */
export function composeFromLimit(view: LimitView, a: { rP: number; rN: number; twist: number }): THREE.Quaternion {
  return quatFromDof(view, [a.rP, a.rN, a.twist]);
}

/** Разложить локальный кватернион на углы осей предела — для ИНДИКАТОРА текущего положения в гизмо и тестов. */
export function decomposeToLimit(q: THREE.Quaternion, view: LimitView): { rP: number; rN: number; twist: number } {
  const t: Dof = dofFromQuat(view, q);
  return { rP: t[0], rN: t[1], twist: t[2] };
}

// ── Оружие из деталей в руках куклы (D22, К6): модель ковки вместо процедурного меша ──
import * as THREE from 'three';
import { TILE, weaponLookSig, type ConfigRegistry, type WeaponLookHand } from '@dm/shared';
import type { CraftMeshResult } from '../modules/town/craftMesh/index.js';
import { craftMeshConfigVersion } from '../modules/town/craftMesh/configVersion.js';
import { markStaleBuild } from '../net/staleBuild.js';

/**
 * ⭐ ОДИН ПУТЬ ДЛЯ СЕБЯ И ДРУГИХ. Вид оружия (`weaponLook`: база + четыре детали по рукам) приходит у пиров
 * кадром `peerInfo`, у себя — из сейва той же функцией (`weaponLookOf`), и обе куклы строят модель здесь.
 *
 * - Модель ковки (`craftMesh`) — в САНТИМЕТРАХ, рукоять в начале координат, рабочий конец в −Y: тот же
 *   контракт, что у процедурного меша (`weapon3d.makeWeaponMesh`). Поэтому она встаёт в ту же группу руки
 *   вместо процедурных детей — хват, позы удара, вес руки и перенос на кисть атласа не меняются. Масштаб —
 *   на узле-посреднике (`TILE` = 32 u = 1 м → ×0.32): сама группа держит масштаб 1 (`hostWeaponOnHand`).
 * - Кэш по подписи (`weaponLookSig`): восемь игроков с одинаковым мечом делят одну геометрию и материалы.
 *   Счётчик ссылок; последняя рука отпустила — геометрия и материалы освобождаются. ⚠ В ключе — и версия
 *   конфига модели (`craftMeshConfigVersion`): реестр правится на месте, и без неё правка детали не доезжала бы
 *   до новых кукол, а сбой до прихода конфига залипал бы на сессию (R1-22).
 * - `craftMesh` — ≈ 5.6 тыс. строк, поэтому модуль грузится ДИНАМИЧЕСКИ при первом виде (тот же кусок, что у
 *   окна ковки). Пока не загрузился, в руке процедурный меш; загрузился — группы доснабжаются (`applyCraftLooks`).
 * - ⚠ ЛЮБОЙ СБОЙ — процедурный меш: нет модуля, нет детали в конфиге, построитель бросил. Вид — косметика,
 *   ронять из-за него кадр нельзя.
 */

type CraftMeshLib = typeof import('../modules/town/craftMesh/index.js');

/** 1 см модели ковки в юнитах игры: клетка `TILE` = 1 м. */
export const CRAFT_CM_TO_UNITS = TILE / 100;

let lib: CraftMeshLib | null = null;
let loading: Promise<CraftMeshLib | null> | null = null;

/**
 * Загрузить построитель (один раз). Не загрузился — null, следующий вид попробует снова. ⭐ R10-12: упавший кусок — почти
 * всегда деплой без перезагрузки вкладки (хэши кусков сменились): раньше оружие из деталей молча оставалось процедурным
 * на всю сессию, теперь игроку — «перезагрузите страницу» (`markStaleBuild`, один раз на страницу).
 */
export function loadCraftMeshLib(): Promise<CraftMeshLib | null> {
  if (lib) return Promise.resolve(lib);
  loading ??= import('../modules/town/craftMesh/index.js')
    .then((m) => (lib = m))
    .catch((e: unknown) => { loading = null; markStaleBuild('модель оружия из деталей', e); return null; });
  return loading;
}

interface Entry { res: CraftMeshResult; refs: number }
/**
 * Готовые модели по (версия конфига модели, подпись). Версия уникальна на страницу и своя у каждого реестра
 * (у редактора и игры он свой), и меняется с правкой любой таблицы модели. Модель старой версии живёт, пока её
 * держит хоть одна рука, и освобождается последним `release` — утечки нет.
 */
const cache = new Map<string, Entry>();
/**
 * Ключи, которые не строятся (нет детали, не тот класс, построитель бросил): не пересобирать на каждой смене. Ключ
 * с версией — правка конфига сбой не наследует: пришла деталь, и тот же вид строится (R1-22).
 */
const failed = new Set<string>();
const FAILED_KEEP = 256;

/** Сколько моделей держит кэш и сколько рук на них ссылается — для тестов и отладки утечек. */
export function craftMeshCacheStats(): { models: number; refs: number } {
  let refs = 0;
  for (const e of cache.values()) refs += e.refs;
  return { models: cache.size, refs };
}

/**
 * Взять экземпляр модели руки (узел со своим масштабом; геометрия и материалы — общие из кэша). null — модуль
 * ещё не загружен или модель не строится. Экземпляр ОБЯЗАТЕЛЬНО отпустить (`release`) — иначе кэш не освободится.
 */
export function acquireCraftMesh(reg: ConfigRegistry, hand: WeaponLookHand): { node: THREE.Object3D; release: () => void } | null {
  if (!lib) return null;
  const sig = weaponLookSig(hand);
  if (!sig) return null;
  const key = `${craftMeshConfigVersion(reg)}#${sig}`;
  let e = cache.get(key);
  if (!e) {
    if (failed.has(key)) return null;
    let res: CraftMeshResult | null = null;
    try {
      const base = reg.get('items.base').find((b) => b.id === hand.baseId);
      if (base && base.kind === 'weapon') res = lib.buildCraftMesh(reg, base.weaponClass, base.hands ?? 1, hand.parts);
    } catch { res = null; }
    if (!res) {
      if (failed.size >= FAILED_KEEP) failed.clear();
      failed.add(key);
      return null;
    }
    res.group.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });   // как GLB-оружие
    e = { res, refs: 0 };
    cache.set(key, e);
  }
  const entry = e;
  let copy: THREE.Object3D;
  try { copy = entry.res.group.clone(); }   // экземпляр: свои узлы, общие геометрия и материалы
  catch {
    if (entry.refs <= 0) { cache.delete(key); entry.res.dispose(); }   // свежая запись без рук — не оставлять висеть
    return null;
  }
  entry.refs++;
  const node = new THREE.Object3D();
  node.name = 'craftWeapon';
  node.scale.setScalar(CRAFT_CM_TO_UNITS);
  node.userData.craftShared = true;   // геометрия общая: чужой обход «освободить меши группы» её не трогает
  node.add(copy);
  let done = false;
  return {
    node,
    release: () => {
      if (done) return;   // двойной release не должен уронить счётчик чужой руки
      done = true;
      node.parent?.remove(node);
      if (--entry.refs <= 0 && cache.get(key) === entry) { cache.delete(key); entry.res.dispose(); }
    },
  };
}

/** Освободить СВОЮ геометрию поддерева; общие узлы модели ковки (`craftShared`) не трогать. */
export function disposeOwnGeometry(o: THREE.Object3D): void {
  if (o.userData.craftShared) return;
  const m = o as THREE.Mesh;
  if (m.geometry) m.geometry.dispose();
  for (const c of o.children) disposeOwnGeometry(c);
}

/**
 * Поставить модель из деталей в группу руки вместо процедурных детей. Синхронно: модуль уже загружен —
 * ставит сразу, нет — false (группа остаётся процедурной, её доснабдит `applyCraftLooks`).
 */
export function mountCraftLook(g: THREE.Group, reg: ConfigRegistry): boolean {
  const hand = g.userData.craftLook as WeaponLookHand | undefined;
  if (!hand || g.userData.stale || g.userData.craftRelease) return false;
  const inst = acquireCraftMesh(reg, hand);
  if (!inst) return false;
  for (let i = g.children.length - 1; i >= 0; i--) { const c = g.children[i]!; disposeOwnGeometry(c); g.remove(c); }   // снести процедурные дети
  g.add(inst.node);
  g.userData.craftRelease = inst.release;
  return true;
}

/** Отпустить модель руки (смена оружия, смерть куклы). Процедурный меш на её место не возвращается — группу сносят. */
export function releaseCraftLook(g: THREE.Group): void {
  const release = g.userData.craftRelease as (() => void) | undefined;
  g.userData.craftRelease = undefined;
  release?.();
}

/** Догрузить построитель и поставить модели во все группы с видом, которые ещё процедурные и не устарели. */
export async function applyCraftLooks(groups: readonly THREE.Group[], reg: ConfigRegistry): Promise<void> {
  if (!groups.some((g) => g.userData.craftLook && !g.userData.craftRelease)) return;
  if (!(await loadCraftMeshLib())) return;
  for (const g of groups) mountCraftLook(g, reg);
}

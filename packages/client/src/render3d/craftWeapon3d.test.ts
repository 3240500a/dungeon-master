import { describe, it, expect, vi, beforeAll } from 'vitest';
import * as THREE from 'three';

// env3d тянет DOM/GLTFLoader — физмиру от него нужна только высота стены (как в windowCull.test.ts).
vi.mock('./env3d.js', () => ({ WALL_H: 96 }));

import { ConfigRegistry, craftWeapon, defaultParts, createRng, type CraftParts, type WeaponLook, type WeaponLookHand } from '@dm/shared';
import { initPhysics, PhysWorld, jolt } from './ragdoll.js';
import { buildHumanoid } from './humanoid.js';
import { attachWeapons, disposeWeaponGroup, hostWeaponOnHand } from './weapon3d.js';
import { makeRetargetRig } from './retarget3d.js';
import { makeHumanoidDoll } from './gamePlayerDoll.js';
import { CRAFT_CM_TO_UNITS, acquireCraftMesh, applyCraftLooks, craftMeshCacheStats, disposeOwnGeometry, loadCraftMeshLib } from './craftWeapon3d.js';
import { craftMeshConfigVersion } from '../modules/town/craftMesh/configVersion.js';

/**
 * ⭐ ДРУГИЕ ИГРОКИ ВИДЯТ СКОВАННОЕ (D22, К6) — сторожа клиентской половины: рука с видом из деталей получает
 * модель ковки вместо процедурного меша, в ТОЙ ЖЕ группе (хват, позы, перенос на кисть не меняются), в
 * масштабе игры (см → ×0.32); одинаковый вид — одна геометрия на всех; модель освобождается, когда её больше
 * никто не держит; любой сбой — процедурный меш, без исключения.
 *
 * ⚠ Порядок тестов важен: первый проверяет состояние ДО загрузки построителя (модуль грузится один раз на файл).
 */

const reg = new ConfigRegistry();
reg.loadAll();

function handOf(cls: string, hands: number, step: number): WeaponLookHand {
  const parts = defaultParts(reg, cls, hands, step)!;
  const pv = craftWeapon(reg, { weaponClass: cls, hands, parts }, { rng: createRng(3) });
  expect(pv.ok, pv.reason).toBe(true);
  return { baseId: pv.item!.baseId, parts: structuredClone(parts) };
}
const craftNodes = (o: THREE.Object3D): THREE.Object3D[] => { const out: THREE.Object3D[] = []; o.traverse((x) => { if (x.name === 'craftWeapon') out.push(x); }); return out; };
const meshesOf = (o: THREE.Object3D): THREE.Mesh[] => { const out: THREE.Mesh[] = []; o.traverse((x) => { if ((x as THREE.Mesh).isMesh) out.push(x as THREE.Mesh); }); return out; };
const lengthY = (o: THREE.Object3D): number => { o.updateWorldMatrix(true, true); return new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3()).y; };

const SWORD = handOf('sword', 1, 3);
const SWORD_B: WeaponLookHand = handOf('sword', 1, 5);   // тот же класс — ключ `sword`, но детали (ступени) другие
const DAGGER = handOf('dagger', 1, 2);

describe('модель ковки в руке (D22)', () => {
  it('до загрузки построителя — процедурный меш; после — модель ковки в ТОЙ ЖЕ группе, хват не тронут', async () => {
    const h = buildHumanoid({});
    const [g] = attachWeapons(h, 'sword', { main: 'glb-sword' }, { reg, look: { main: SWORD } });
    expect(g!.userData.craftLook).toBe(SWORD);
    expect(g!.userData.weaponModelId, 'вид главнее GLB: иначе свой меч выглядел бы не так, как его видят другие').toBeUndefined();
    expect(craftNodes(g!).length, 'построитель ещё не загружен — в руке процедурка').toBe(0);
    const procedural = g!.children.length;
    expect(procedural).toBeGreaterThan(0);
    const rot = g!.rotation.clone(), baseRot = (g!.userData.baseRot as THREE.Euler).clone(), parent = g!.parent;

    await applyCraftLooks([g!], reg);
    expect(craftNodes(g!).length).toBe(1);
    expect(g!.children.length, 'процедурные дети сняты').toBe(1);
    expect(g!.children[0]!.name).toBe('craftWeapon');
    expect(g!.parent, 'группа на той же кисти').toBe(parent);
    expect(g!.rotation.equals(rot) && (g!.userData.baseRot as THREE.Euler).equals(baseRot), 'хват не тронут').toBe(true);
    expect(g!.scale.x, 'масштаб — на посреднике, группа держит 1 (hostWeaponOnHand)').toBe(1);
    disposeWeaponGroup(g!);
    expect(craftMeshCacheStats()).toEqual({ models: 0, refs: 0 });
  });

  it('см → юниты ×0.32 (TILE = 32 u = 1 м)', async () => {
    const lib = (await loadCraftMeshLib())!;
    const raw = lib.buildCraftMesh(reg, 'sword', 1, SWORD.parts)!;
    const cm = lengthY(raw.group);
    raw.dispose();
    const h = buildHumanoid({});
    const [g] = attachWeapons(h, 'sword', undefined, { reg, look: { main: SWORD } });
    const node = craftNodes(g!)[0]!;
    expect(CRAFT_CM_TO_UNITS).toBeCloseTo(0.32, 10);
    expect(node.scale.x).toBeCloseTo(0.32, 10);
    // Длина в осях группы: снимаем кисть, чтобы мерить только оружие.
    g!.removeFromParent(); g!.rotation.set(0, 0, 0); g!.position.set(0, 0, 0);
    expect(lengthY(g!)).toBeCloseTo(cm * 0.32, 3);
    disposeWeaponGroup(g!);
  });

  it('одинаковый вид — ОДНА геометрия на всех; отпустили все — освобождена', async () => {
    await loadCraftMeshLib();
    const g1 = attachWeapons(buildHumanoid({}), 'sword', undefined, { reg, look: { main: SWORD } })[0]!;
    const g2 = attachWeapons(buildHumanoid({}), 'sword', undefined, { reg, look: { main: SWORD } })[0]!;
    expect(craftMeshCacheStats()).toEqual({ models: 1, refs: 2 });
    const m1 = meshesOf(g1), m2 = meshesOf(g2);
    expect(m1.length).toBeGreaterThan(0);
    expect(m1.length).toBe(m2.length);
    m1.forEach((m, i) => { expect(m).not.toBe(m2[i]); expect(m.geometry).toBe(m2[i]!.geometry); expect(m.material).toBe(m2[i]!.material); });
    const geoms = new Set(m1.map((m) => m.geometry));   // построитель может делить геометрию и между своими мешами
    const disposed = new Set<THREE.BufferGeometry>();
    for (const geo of geoms) geo.addEventListener('dispose', () => { disposed.add(geo); });

    disposeWeaponGroup(g1);
    expect(disposed.size, 'вторая кукла ещё держит модель — геометрию не трогать').toBe(0);
    expect(craftMeshCacheStats()).toEqual({ models: 1, refs: 1 });
    disposeWeaponGroup(g1);   // повторный снос не роняет счётчик чужой руки
    expect(craftMeshCacheStats()).toEqual({ models: 1, refs: 1 });
    disposeWeaponGroup(g2);
    expect(disposed.size, 'последняя рука отпустила — вся геометрия освобождена').toBe(geoms.size);
    expect(craftMeshCacheStats()).toEqual({ models: 0, refs: 0 });
  });

  it('обход «освободить свою геометрию» не трогает общую модель ковки, даже если она ещё в группе', async () => {
    await loadCraftMeshLib();
    const g = attachWeapons(buildHumanoid({}), 'sword', undefined, { reg, look: { main: SWORD } })[0]!;
    const geoms = new Set(meshesOf(g).map((m) => m.geometry));
    const disposed = new Set<THREE.BufferGeometry>();
    for (const geo of geoms) geo.addEventListener('dispose', () => { disposed.add(geo); });
    disposeOwnGeometry(g);   // модель ещё висит в группе — например, чужой обход до release
    expect(disposed.size).toBe(0);
    disposeWeaponGroup(g);
    expect(disposed.size).toBe(geoms.size);
  });

  it('руки как у ключа: дуал — обе модели, щит — процедурный, лук — в левой, пустая рука пуста', async () => {
    await loadCraftMeshLib();
    const h = buildHumanoid({});
    const dual = attachWeapons(h, 'sword+dagger', undefined, { reg, look: { main: SWORD, off: DAGGER } });
    expect(dual.map((g) => craftNodes(g).length)).toEqual([1, 1]);
    const sh = attachWeapons(h, 'sword+shield', { off: 'glb-shield' }, { reg, look: { main: SWORD, off: DAGGER } });
    expect(craftNodes(sh[1]!).length, 'щит видом не бывает').toBe(0);
    expect(sh[1]!.userData.weaponModelId, 'GLB щита остаётся').toBe('glb-shield');
    const none = attachWeapons(h, 'none+dagger', undefined, { reg, look: { off: DAGGER } });
    expect(none[0]!.children.length).toBe(0);
    expect(craftNodes(none[1]!).length).toBe(1);
    const bow = handOf('bow', 2, 3);
    const b = attachWeapons(h, 'bow', undefined, { reg, look: { main: bow } });
    expect(b[0]!.parent).toBe(h.bones.get('LeftHand'));
    expect(craftNodes(b[0]!).length).toBe(1);
    for (const g of [...dual, ...sh, ...none, ...b]) disposeWeaponGroup(g);
    expect(craftMeshCacheStats()).toEqual({ models: 0, refs: 0 });
  });

  it('любой сбой — процедурный меш и никакого исключения', async () => {
    await loadCraftMeshLib();
    const h = buildHumanoid({});
    const bad: WeaponLookHand[] = [
      { baseId: 'нет-такой-базы', parts: SWORD.parts },
      { baseId: SWORD.baseId, parts: { ...SWORD.parts, strike: { id: 'нет-такой-детали', step: 3 } } },
      { baseId: SWORD.baseId, parts: { ...SWORD.parts, grip: undefined } as unknown as CraftParts },
      { baseId: SWORD.baseId, parts: null as unknown as CraftParts },
      { baseId: 'dagger', parts: { strike: { id: 1, step: 'x' } } as unknown as CraftParts },
    ];
    for (const look of bad) {
      let groups: THREE.Group[] = [];
      expect(() => { groups = attachWeapons(h, 'sword', undefined, { reg, look: { main: look } }); }, JSON.stringify(look)).not.toThrow();
      expect(craftNodes(groups[0]!).length, JSON.stringify(look)).toBe(0);
      expect(groups[0]!.children.length, 'процедурный меш на месте').toBeGreaterThan(0);
      await expect(applyCraftLooks(groups, reg)).resolves.toBeUndefined();
      for (const g of groups) disposeWeaponGroup(g);
    }
    // Реестр, который бросает, — тоже процедурка.
    const broken = { get: () => { throw new Error('нет конфига'); } } as unknown as ConfigRegistry;
    const g = attachWeapons(h, 'sword', undefined, { reg: broken, look: { main: SWORD } });
    expect(craftNodes(g[0]!).length).toBe(0);
    disposeWeaponGroup(g[0]!);
    expect(craftMeshCacheStats()).toEqual({ models: 0, refs: 0 });
  });

  it('без вида — всё как раньше (процедурный меш, GLB-тег)', () => {
    const h = buildHumanoid({});
    const [g] = attachWeapons(h, 'sword', { main: 'glb-sword' });
    expect(craftNodes(g!).length).toBe(0);
    expect(g!.userData.weaponModelId).toBe('glb-sword');
    const [g2] = attachWeapons(h, 'sword', undefined, { reg });   // реестр есть, вида нет
    expect(craftNodes(g2!).length).toBe(0);
    disposeWeaponGroup(g!); disposeWeaponGroup(g2!);
  });
});

describe('кукла: смена оружия по подписи деталей, а не только по ключу', () => {
  beforeAll(async () => { await initPhysics(); await loadCraftMeshLib(); });

  it('другой меч того же класса пересобирает модель; тот же — нет; null снимает; dispose отпускает', async () => {
    const pw = new PhysWorld(); pw.addGround(2000);
    const look = (main?: WeaponLookHand): WeaponLook => ({ main });
    const d = makeHumanoidDoll(pw, { x: 0, z: 0, weapon: 'sword', gaitId: 'monster', gaitFallback: 'warrior', weaponLook: look(SWORD), craftReg: reg });
    await applyCraftLooks([], reg);   // модуль уже загружен — кукла поставила модель синхронно
    const first = craftNodes(d.group);
    expect(first.length).toBe(1);
    expect(craftMeshCacheStats().refs).toBe(1);

    d.setWeapon?.('sword', undefined, look(structuredClone(SWORD)));   // та же подпись в новом объекте (новый кадр peerInfo)
    expect(craftNodes(d.group)[0], 'подпись та же — меш не пересобирается').toBe(first[0]);

    d.setWeapon?.('sword', undefined, look(SWORD_B));                   // ключ тот же (`sword`), детали другие
    const second = craftNodes(d.group);
    expect(second.length).toBe(1);
    expect(second[0]).not.toBe(first[0]);
    expect(first[0]!.parent, 'старая модель снята с куклы').toBe(null);
    expect(craftMeshCacheStats(), 'старый вид отпущен, новый взят').toEqual({ models: 1, refs: 1 });

    d.setWeapon?.('sword', undefined, undefined);                        // undefined — вид не трогаем
    expect(craftNodes(d.group)[0]).toBe(second[0]);

    d.setWeapon?.('sword+shield', undefined, undefined);                 // сменил только щит — вид тот же, из кэша
    expect(craftNodes(d.group).length).toBe(1);
    expect(craftMeshCacheStats()).toEqual({ models: 1, refs: 1 });

    d.setWeapon?.('sword', undefined, null);                             // null — вида нет: процедурный меш
    expect(craftNodes(d.group).length).toBe(0);
    expect(craftMeshCacheStats()).toEqual({ models: 0, refs: 0 });

    d.setWeapon?.('sword', undefined, look(SWORD));
    expect(craftNodes(d.group).length).toBe(1);
    d.dispose();
    expect(craftMeshCacheStats(), 'смерть куклы отпускает модель').toEqual({ models: 0, refs: 0 });
    jolt().destroy(pw.jolt);
  });

  it('догрузка доснабжает живые руки с видом и пропускает снятые (оружие сменили, пока модуль грузился)', async () => {
    // Рука с видом, но без модели — ровно то, что остаётся, пока построитель не загружен (здесь — битый реестр).
    const broken = { get: () => { throw new Error('нет конфига'); } } as unknown as ConfigRegistry;
    const live = attachWeapons(buildHumanoid({}), 'sword', undefined, { reg: broken, look: { main: SWORD } });
    const gone = attachWeapons(buildHumanoid({}), 'sword', undefined, { reg: broken, look: { main: SWORD } });
    expect([...live, ...gone].map((g) => craftNodes(g).length)).toEqual([0, 0]);
    for (const g of gone) disposeWeaponGroup(g);
    await applyCraftLooks([...live, ...gone], reg);
    expect(live.map((g) => craftNodes(g).length), 'живая рука получила модель').toEqual([1]);
    expect(gone.map((g) => craftNodes(g).length), 'снятая — нет (иначе утечка в кэше)').toEqual([0]);
    expect(craftMeshCacheStats()).toEqual({ models: 1, refs: 1 });
    for (const g of live) disposeWeaponGroup(g);
    expect(craftMeshCacheStats()).toEqual({ models: 0, refs: 0 });
  });
});

/**
 * ⭐ R1-22: РЕЕСТР ПРАВИТСЯ НА МЕСТЕ — И МОДЕЛЬ ЗА НИМ. Игра накатывает конфиг сервера и live-apply редактора в ТОТ
 * ЖЕ объект реестра (`reload`), а подпись вида — только база и id:ступень деталей. Ключ кэша «объект реестра +
 * подпись» правки не видел: сбой до прихода конфига залипал на сессию, а новые куклы брали модель старой формы.
 */
describe('R1-22: правка конфига (reload на месте) — новая модель, прежний сбой не залипает', () => {
  beforeAll(async () => { await loadCraftMeshLib(); });
  const freshReg = (): ConfigRegistry => { const r = new ConfigRegistry(); r.loadAll(); return r; };

  it('детали не было — вид не строится; деталь пришла в тот же реестр — строится', () => {
    const r = freshReg();
    const parts = r.get('weapon-parts');
    r.reload({ 'weapon-parts': parts.filter((p) => p.id !== SWORD.parts.strike.id) });
    expect(acquireCraftMesh(r, SWORD), 'детали нет — процедурка').toBeNull();
    r.reload({ 'weapon-parts': parts });
    const inst = acquireCraftMesh(r, SWORD);
    expect(inst, 'конфиг пришёл — прежний сбой не держит').not.toBeNull();
    inst!.release();
    expect(craftMeshCacheStats()).toEqual({ models: 0, refs: 0 });
  });

  it('деталь сменила форму — свежая рука получает НОВУЮ модель; живая держит свою до снятия', () => {
    const r = freshReg();
    const a = acquireCraftMesh(r, SWORD)!;
    const geoA = new Set(meshesOf(a.node).map((m) => m.geometry));
    const parts = structuredClone(r.get('weapon-parts'));
    const strike = parts.find((p) => p.id === SWORD.parts.strike.id)!;
    strike.axis = strike.axis === 1 ? -1 : 1;
    r.reload({ 'weapon-parts': parts });
    const b = acquireCraftMesh(r, SWORD)!;
    expect(meshesOf(b.node).some((m) => geoA.has(m.geometry)), 'после правки модель строится заново').toBe(false);
    expect(craftMeshCacheStats()).toEqual({ models: 2, refs: 2 });
    const disposed = new Set<THREE.BufferGeometry>();
    for (const g of geoA) g.addEventListener('dispose', () => { disposed.add(g); });
    a.release();
    expect(disposed.size, 'старая модель освобождена, когда её отпустила последняя рука').toBe(geoA.size);
    expect(craftMeshCacheStats()).toEqual({ models: 1, refs: 1 });
    b.release();
    expect(craftMeshCacheStats()).toEqual({ models: 0, refs: 0 });
  });

  it('правка ЧУЖОЙ таблицы (монстры) модель не пересобирает; версия меняется только от таблиц модели', () => {
    const r = freshReg();
    const v0 = craftMeshConfigVersion(r);
    const a = acquireCraftMesh(r, SWORD)!;
    r.reload({ monsters: r.get('monsters') });
    expect(craftMeshConfigVersion(r)).toBe(v0);
    const b = acquireCraftMesh(r, SWORD)!;
    expect(craftMeshCacheStats(), 'тот же вид — та же модель').toEqual({ models: 1, refs: 2 });
    r.reload({ 'weapon-anatomy': r.get('weapon-anatomy') });
    expect(craftMeshConfigVersion(r)).not.toBe(v0);
    expect(craftMeshConfigVersion(freshReg()), 'у другого реестра — своя версия').not.toBe(craftMeshConfigVersion(r));
    a.release(); b.release();
    expect(craftMeshCacheStats()).toEqual({ models: 0, refs: 0 });
  });
});

/**
 * ⭐ R1-23: СНОС ОДНОЙ КУКЛЫ НЕ ТРОГАЕТ ОБЩУЮ МОДЕЛЬ ДРУГИХ. Одинаковый вид — одна геометрия и одни материалы на
 * всех рук (кэш по подписи). Обходы «освободить всё под собой» — снос куклы (`dispose`) и снос скина атласа
 * (`modelSkin.clearWorn` → `rig.dispose`, в том числе на каждой смене брони) — доходили до модели в руке и
 * освобождали её у ВСЕХ: three сбрасывал буферы и программы, и каждая кукла с тем же мечом грузила их заново.
 */
describe('R1-23: снос куклы и скина не освобождает общую модель ковки', () => {
  beforeAll(async () => { await initPhysics(); await loadCraftMeshLib(); });
  /** Слушать `dispose` на геометрии и материалах модели ковки в группе. */
  function watchDispose(root: THREE.Object3D): { geo: Set<unknown>; mat: Set<unknown>; meshes: number } {
    const out = { geo: new Set<unknown>(), mat: new Set<unknown>(), meshes: 0 };
    for (const n of craftNodes(root)) {
      for (const m of meshesOf(n)) {
        out.meshes++;
        m.geometry.addEventListener('dispose', () => { out.geo.add(m.geometry); });
        for (const mm of Array.isArray(m.material) ? m.material : [m.material]) mm.addEventListener('dispose', () => { out.mat.add(mm); });
      }
    }
    return out;
  }

  it('⭐ две куклы с одним видом: снос первой не освобождает ни геометрию, ни материалы второй', () => {
    const pw = new PhysWorld(); pw.addGround(2000);
    const mk = (x: number) => makeHumanoidDoll(pw, { x, z: 0, weapon: 'sword', gaitId: 'monster', gaitFallback: 'warrior', weaponLook: { main: SWORD }, craftReg: reg });
    const a = mk(0), b = mk(50);
    expect(craftMeshCacheStats()).toEqual({ models: 1, refs: 2 });
    const w = watchDispose(b.group);
    expect(w.meshes).toBeGreaterThan(0);
    a.dispose();
    expect(craftMeshCacheStats(), 'первая кукла отпустила свою руку').toEqual({ models: 1, refs: 1 });
    expect(w.geo.size, 'геометрия второй куклы цела').toBe(0);
    expect(w.mat.size, 'материалы второй куклы целы').toBe(0);
    b.dispose();
    expect(craftMeshCacheStats()).toEqual({ models: 0, refs: 0 });
    expect(w.geo.size, 'последняя рука отпустила — освобождено').toBeGreaterThan(0);
    jolt().destroy(pw.jolt);
  });

  it('снос рига атласа (смена брони, снос куклы) не освобождает модель, висящую на его кисти', () => {
    const gA = attachWeapons(buildHumanoid({}), 'sword', undefined, { reg, look: { main: SWORD } })[0]!;
    const hB = buildHumanoid({});
    const gB = attachWeapons(hB, 'sword', undefined, { reg, look: { main: SWORD } })[0]!;
    expect(craftMeshCacheStats()).toEqual({ models: 1, refs: 2 });
    // Скелет «атласа»: оружие куклы A висит на его кисти — как `hostWeaponOnHand` вешает его в игре.
    const loaded = new THREE.Group();
    const hips = new THREE.Bone(); hips.name = 'Hips'; loaded.add(hips);
    const hand = new THREE.Bone(); hand.name = 'RightHand'; hand.position.set(10, 0, 0); hips.add(hand);
    const skinGeo = new THREE.BoxGeometry(1, 1, 1);
    hips.add(new THREE.Mesh(skinGeo));   // своя геометрия атласа — её снос рига обязан освободить
    const rig = makeRetargetRig(loaded, { Hips: 'Hips', RightHand: 'RightHand' }, 1);
    hostWeaponOnHand(gA, rig.targetBone('RightHand'), hB.bones.get('RightHand')!);
    let under = false;
    for (let p: THREE.Object3D | null = gA; p; p = p.parent) if (p === loaded) under = true;
    expect(under, 'рука A висит под атласом').toBe(true);
    const w = watchDispose(gB);
    let skinDisposed = false;
    skinGeo.addEventListener('dispose', () => { skinDisposed = true; });
    rig.dispose();
    expect(skinDisposed, 'своё риг освобождает').toBe(true);
    expect(w.geo.size, 'общую модель ковки — нет').toBe(0);
    disposeWeaponGroup(gA); disposeWeaponGroup(gB);
    expect(craftMeshCacheStats()).toEqual({ models: 0, refs: 0 });
  });
});

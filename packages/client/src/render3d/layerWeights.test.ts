import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as THREE from 'three';
import { buildHumanoid, type Humanoid } from './humanoid.js';
import { PosePlayer, localStorageContent, emptyGrid, setLocoMixOverride, setLayerSource, layerTrace, getLayerBakeOverride, type PoseContent, type UpperPose } from './poseRuntime.js';
import { bakeGaitToClip, GAIT_PRESETS } from './clipBake.js';
import { clipPoseAt, type Clip, type Pose } from './clipModel.js';
import { GAIT } from './pose.js';
import { lookupLayers, resolveLayers, newResolvedLayers, entryFromSway, ensureLayerEntry, layerCell, setLayerCell, clearLayerCell,
  readLayerStore, layerEditKey, LAYER_PARTS, LAYER_PART_OF, LAYER_LEGACY_DEFAULT, type LayerEntry, type LayerStore } from './layerWeights.js';

/**
 * ⭐⭐ ВЕСА СЛОЁВ ПО ЧАСТЯМ ТЕЛА (`pe_layers`) — сторожа.
 *
 * Жалоба автора: «при беге руки почти не дрыгаются — берётся почти на 100 % idle-поза, если оружие в руке и щит».
 * ЗАМЕР (опубликованный воин, бег 120, «только клипы», размах плеча): `none` 30.0°, `sword`/`sword+shield` 13.8°
 * (умолчание 0.2), при весе 1 — 56.0°. И вторая причина, найденная тем же замером: стойка ЗАПЕКАЛАСЬ в руки клипа
 * (опубликованный `run_fwd` 60.1° = свежий съём при sway 0.5; чистый мах — 119.1°), то есть вес ложился дважды.
 *
 * Что здесь стережётся: (1) без `pe_layers` всё бит в бит — и в смешанном режиме, и в «только клипы»; (2) вес части
 * двигает ТОЛЬКО кости этой части; (3) ходьба/бег и колонка боя; (4) поиск ключа один на игру и редактор; (5) запекание
 * снимает верх чистым и от `sway` не зависит.
 */
const GX = { armDown: 1.35, elbowBend: 0.25 };
/** Стойка, заведомо не похожая ни на клип, ни на мах походки, — с кистями, грудью и головой. */
const STANCE: Pose = {
  LeftUpperArm: [0.3, 0.1, -0.6], RightUpperArm: [0.25, -0.1, 0.7], LeftLowerArm: [0, -0.9, 0], RightLowerArm: [0, 1.1, 0],
  LeftShoulder: [0.05, 0, -0.1], RightShoulder: [0.05, 0, 0.12], LeftHand: [0.2, 0.1, 0.3], RightHand: [-0.3, 0.2, -0.25],
  Chest: [0.1, 0.05, 0], UpperChest: [0.08, -0.04, 0.02], Neck: [0.12, 0.1, 0], Head: [-0.1, 0.15, 0.05],
};
const ALL_BONES = Object.keys(STANCE);

let lib: Map<string, Clip>;
beforeAll(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: () => null, setItem: () => { /* */ }, removeItem: () => { /* */ }, clear: () => { /* */ }, key: () => null, length: 0,
  } as Storage;
  // Набор хода — как кнопка редактора, без стойки (чистый мах в руках клипа).
  const h = buildHumanoid({});
  const p = new PosePlayer(h, () => [], localStorageContent('warrior'), 'none', GX, emptyGrid());
  lib = new Map();
  for (const s of GAIT_PRESETS) lib.set(s.name, bakeGaitToClip(p, h, s, { character: 'warrior', weapon: 'none' }).clip);
});
afterAll(() => { delete (globalThis as unknown as { localStorage?: Storage }).localStorage; });
afterEach(() => { setLocoMixOverride(null); setLayerSource(null); layerTrace.on = false; });

const content = (up: Partial<UpperPose>): PoseContent => ({
  ...localStorageContent('warrior'),
  locoClip: (names: readonly string[]) => { for (const n of names) { const c = lib.get(n); if (c) return c; } return null; },
  resolveUpper: () => ({ swing: 0.2, pose: STANCE, ...up }),
});
type Snap = Record<string, THREE.Quaternion>;
/** Прогон и снимок локальных поворотов верха на последнем кадре. Детерминирован: одни входы → одна поза. */
const run = (up: Partial<UpperPose>, o: { mix: number; spd: number; combat?: boolean; frames?: number }): { snap: Snap; h: Humanoid } => {
  const h = buildHumanoid({});
  const p = new PosePlayer(h, () => [], content(up), 'none', GX, emptyGrid());
  setLocoMixOverride(o.mix);
  p.setYaw(0); p.snapYaw(); p.setVel(0, o.spd); p.setCombat(!!o.combat);
  for (let i = 0; i < (o.frames ?? 200); i++) p.step(1 / 60);
  const snap: Snap = {};
  for (const b of ALL_BONES) snap[b] = h.bones.get(b)!.quaternion.clone();
  // Таз — позицией (в `w` ноль): вес головы в «только клипы» зовёт общий шов клипа второй раз, и тот НЕ должен
  // довести офсет таза к цели ещё раз.
  const hp = h.bones.get('Hips')!.position;
  snap['#hips'] = new THREE.Quaternion(hp.x, hp.y, hp.z, 0);
  return { snap, h };
};
const D = 180 / Math.PI;
const diff = (a: Snap, b: Snap, bone: string): number => a[bone]!.angleTo(b[bone]!) * D;
const sameBone = (a: Snap, b: Snap, n: string): boolean => {
  const x = a[n]!, y = b[n]!;
  return x.x === y.x && x.y === y.y && x.z === y.z && x.w === y.w;
};
/**
 * Кости, сдвинувшиеся ХОТЬ НА БИТ. ⚠ Именно покомпонентно, а не `angleTo > eps`: у двух бит-в-бит равных кватернионов
 * `angleTo` даёт 1.7e−6…3.8e−6° (acos возле единицы), и порог по углу либо врёт про «сдвиг», либо пропускает настоящий.
 */
const SNAP_KEYS = [...ALL_BONES, '#hips'];
const moved = (a: Snap, b: Snap): string[] => SNAP_KEYS.filter((n) => !sameBone(a, b, n)).sort();
const same = (a: Snap, b: Snap): boolean => SNAP_KEYS.every((n) => sameBone(a, b, n));

describe('pe_layers: разбор данных', () => {
  it('⭐ ПОИСК: свой точный → своё базовое → фолбэк точный → фолбэк базовое → умолчание; запись бьёт легаси на том же ключе', () => {
    const sway = { warrior: { none: 0.5, sword: 0.3 }, wolf: { 'sword+shield': 0.9 } };
    const e: LayerEntry = { run: { chest: 0.8 } };
    expect(lookupLayers({}, sway, 'warrior', 'sword+shield')).toMatchObject({ source: 'sway', swing: 0.3, weapon: 'sword', entry: null });
    expect(lookupLayers({}, sway, 'wolf', 'sword+shield', 'warrior'), 'свой точный раньше фолбэка').toMatchObject({ swing: 0.9, charId: 'wolf', weapon: 'sword+shield' });
    expect(lookupLayers({}, sway, 'rat', 'sword+shield', 'warrior'), 'монстр без своих — базовое оружие фолбэка').toMatchObject({ swing: 0.3, charId: 'warrior', weapon: 'sword' });
    // ⚠ СВОЁ БАЗОВОЕ РАНЬШЕ ЧУЖОГО ТОЧНОГО: настроенное автором ЭТОМУ персонажу бьёт настройку другого.
    expect(lookupLayers({}, { wolf: { sword: 0.7 }, warrior: { 'sword+shield': 0.9 } }, 'wolf', 'sword+shield', 'warrior'))
      .toMatchObject({ swing: 0.7, charId: 'wolf', weapon: 'sword' });
    expect(lookupLayers({}, sway, 'warrior', 'axe')).toMatchObject({ source: 'default', swing: LAYER_LEGACY_DEFAULT, entry: null });
    expect(lookupLayers({ warrior: { sword: e } }, sway, 'warrior', 'sword+shield')).toMatchObject({ source: 'layers', weapon: 'sword', swing: 0.3 });
    expect(lookupLayers({ warrior: { sword: e } }, sway, 'warrior', 'sword+shield').entry, 'живая запись, а не копия').toBe(e);
    expect(lookupLayers({ warrior: { 'sword+shield': {} } }, sway, 'warrior', 'sword+shield'), 'точный ключ бьёт базовое').toMatchObject({ weapon: 'sword+shield', swing: LAYER_LEGACY_DEFAULT });
  });

  it('⭐ ОПУБЛИКОВАННЫЕ ДАННЫЕ ДАЮТ ТО ЖЕ, ЧТО ИГРАЛА ИГРА: none и none+shield — 0.5, меч и меч+щит — 0.2', () => {
    const sway = { warrior: { none: 0.5 } };
    const got = ['none', 'none+shield', 'sword', 'sword+shield'].map((w) => lookupLayers(null, sway, 'warrior', w).swing);
    expect(got).toEqual([0.5, 0.5, 0.2, 0.2]);
  });

  it('веса кадра: без записи — пять частей = легаси, голова = умолчание режима; ходьба↔бег по sb', () => {
    const out = newResolvedLayers();
    expect(resolveLayers(null, 0.37, 0.6, 0.45, 1, out)).toEqual({ chest: 0.45, head: 1 });
    expect(resolveLayers(null, 0.37, 0, 0.45, 0, out).head, 'в «только клипы» головой владеет стойка').toBe(0);
    const e: LayerEntry = { walk: { chest: 0.2 }, run: { chest: 0.8 } };
    expect(resolveLayers(e, 0, 0, 0.5, 0, out).chest).toBeCloseTo(0.2, 12);
    expect(resolveLayers(e, 1, 0, 0.5, 0, out).chest).toBeCloseTo(0.8, 12);
    expect(resolveLayers(e, 0.5, 0, 0.5, 0, out).chest).toBeCloseTo(0.5, 12);
    expect(resolveLayers({}, 0.5, 0, 0.5, 0, out).chest, 'часть без записи — умолчание').toBe(0.5);
    expect(resolveLayers(e, 0.5, 0, 0.5, 0, out).head, '…а у головы умолчание СВОЁ, по режиму').toBe(0);
  });

  it('⭐ КОЛОНКА БОЯ РАЗРЕЖЕНА ПО КЛЮЧУ: пропуск наследует релакс ТОЙ ЖЕ скорости, а не ноль', () => {
    const out = newResolvedLayers();
    const e: LayerEntry = { walk: { chest: 0.2 }, run: { chest: 0.8 }, combat: { run: { chest: 0.1 } } };
    expect(resolveLayers(e, 1, 1, 0.5, 0, out).chest, 'бег в бою — своя запись').toBeCloseTo(0.1, 12);
    expect(resolveLayers(e, 0, 1, 0.5, 0, out).chest, 'ходьба в бою — записи нет → релакс ходьбы').toBeCloseTo(0.2, 12);
    expect(resolveLayers(e, 1, 0.5, 0.5, 0, out).chest, 'на полпути кроссфейда боя').toBeCloseTo(0.45, 12);
    expect(resolveLayers(e, 1, 1, 0.5, 1, out).head, 'чужая часть боем не тронута').toBe(1);
  });

  it('легаси-число → запись: пять частей на обеих скоростях, ГОЛОВЫ НЕТ (sway ею не управлял)', () => {
    const e = entryFromSway(0.45);
    expect(e.walk).toEqual({ chest: 0.45 });
    expect(e.run).toEqual(e.walk);
    expect(e.walk!.head, '`sway` головой никогда не управлял').toBeUndefined();
  });

  it('⭐ ПЕРВОЕ КАСАНИЕ НЕ СБРАСЫВАЕТ ОСТАЛЬНОЕ: запись под точным ключом заводится КОПИЕЙ действующей', () => {
    const layers: LayerStore = {};
    const sway = { warrior: { sword: 0.3 } };
    const e = ensureLayerEntry(layers, sway, 'warrior', 'sword+shield');
    expect(layers.warrior!['sword+shield'], 'заведена под ТОЧНЫМ ключом').toBe(e);
    expect(e.run!.chest, 'действовало 0.3 базового меча — оно и скопировано').toBe(0.3);
    setLayerCell(e, 'chest', 'run', false, 0.8);
    const out = newResolvedLayers();
    const lk = lookupLayers(layers, sway, 'warrior', 'sword+shield');
    expect(resolveLayers(lk.entry, 1, 0, lk.swing, 0, out)).toMatchObject({ chest: 0.8 });
    expect(ensureLayerEntry(layers, sway, 'warrior', 'sword+shield'), 'повторный вызов отдаёт ту же запись').toBe(e);
    // Копия чужой ЗАПИСИ — глубокая: правка меча+щита не портит меч.
    const base: LayerEntry = { run: { chest: 0.6 } };
    const l2: LayerStore = { warrior: { sword: base } };
    setLayerCell(ensureLayerEntry(l2, null, 'warrior', 'sword+shield'), 'chest', 'run', false, 0.1);
    expect(base.run!.chest).toBe(0.6);
  });

  it('⭐ КЛЮЧ ПРАВКИ ПАНЕЛИ: под щитом правится ОБЩАЯ запись меча, пока свою не отделили явно', () => {
    const layers: LayerStore = {};
    expect(layerEditKey(layers, 'warrior', 'sword+shield')).toEqual({ key: 'sword', own: false, base: 'sword' });
    // Правка общей записи доезжает и до меча, и до меча со щитом.
    setLayerCell(ensureLayerEntry(layers, null, 'warrior', 'sword'), 'chest', 'run', false, 0.8);
    expect(lookupLayers(layers, null, 'warrior', 'sword+shield').entry!.run!.chest).toBe(0.8);
    expect(layerEditKey(layers, 'warrior', 'sword+shield').key, 'общая запись ключ правки не меняет').toBe('sword');
    // Отделили свою — дальше правится она, и меч от неё не зависит.
    ensureLayerEntry(layers, null, 'warrior', 'sword+shield');
    expect(layerEditKey(layers, 'warrior', 'sword+shield')).toEqual({ key: 'sword+shield', own: true, base: 'sword' });
    expect(layers.warrior!['sword+shield']!.run!.chest, 'своя заведена копией действовавшей').toBe(0.8);
    expect(layerEditKey(layers, 'warrior', 'sword'), 'у оружия без щита «своя» и «общая» — одно и то же').toEqual({ key: 'sword', own: false, base: 'sword' });
  });

  it('ячейка панели показывает то, что РЕАЛЬНО сработает; снятие записи возвращает уровень ниже и не оставляет мусора', () => {
    const e: LayerEntry = {};
    expect(layerCell(e, 'chest', 'run', false, 0.2, 0)).toEqual({ value: 0.2, own: false });
    expect(layerCell(e, 'head', 'run', false, 0.2, 0), 'у головы своё умолчание').toEqual({ value: 0, own: false });
    setLayerCell(e, 'chest', 'run', false, 0.7);
    expect(layerCell(e, 'chest', 'run', true, 0.2, 0), 'бой без записи показывает релакс').toEqual({ value: 0.7, own: false });
    setLayerCell(e, 'chest', 'run', true, 1.7);
    expect(layerCell(e, 'chest', 'run', true, 0.2, 0), 'значение зажато').toEqual({ value: 1, own: true });
    clearLayerCell(e, 'chest', 'run', true);
    expect(e.combat, 'пустая колонка боя убрана').toBeUndefined();
    clearLayerCell(e, 'chest', 'run', false);
    expect(e).toEqual({});
  });

  it('чужой JSON: мусор отброшен, числа зажаты, неизвестные части не едут', () => {
    const s = readLayerStore({ warrior: { sword: { run: { chest: 3, tail: 1, head: 'x' }, walk: 7, combat: { walk: { chest: -1 } } }, junk: 5 }, bad: null });
    expect(s).toEqual({ warrior: { sword: { run: { chest: 1 }, combat: { walk: { chest: 0 } } } } });
    expect(readLayerStore(null)).toEqual({});
  });

  it('каждая кость части известна таблице «кость → часть», и части не пересекаются', () => {
    const seen = new Set<string>();
    for (const p of LAYER_PARTS) for (const b of p.bones) { expect(seen.has(b), b).toBe(false); seen.add(b); expect(LAYER_PART_OF[b]).toBe(p.id); }
    // ⚠ РУК ЗДЕСЬ БОЛЬШЕ НЕТ: ключом им служил ЦЕЛЫЙ КЛЮЧ ОРУЖИЯ, и обе руки получали одно число (замер: под мечом
    // пустая левая душилась наравне с занятой правой). Они переехали в `pe_swing` — ключ ПРЕДМЕТ И РУКА,
    // сторожа в `armSwing.test.ts`. Здесь остались части, которые предмету не принадлежат.
    expect([...seen].sort()).toEqual(['Chest', 'Head', 'Neck', 'UpperChest']);
    for (const arm of ['LeftUpperArm', 'RightUpperArm', 'LeftHand', 'RightHand']) {
      expect(LAYER_PART_OF[arm], `⚠ ${arm} снова в pe_layers — ось настройки рук уехала бы обратно на ключ оружия`).toBeUndefined();
    }
  });
});

describe('pe_layers: рантайм', () => {
  for (const [name, mix] of [['смешанный (планировщик)', 0], ['«только клипы»', 1]] as const) {
    it(`⭐⭐ БЕЗ ЗАПИСИ — БИТ В БИТ, ${name}: одно число на верх ≡ те же пять весов записью`, () => {
      for (const spd of [40, 80, 120]) {
        const legacy = run({ swing: 0.45 }, { mix, spd }).snap;
        const entry = run({ swing: 0.2, layers: entryFromSway(0.45) }, { mix, spd }).snap;
        expect(same(legacy, entry), `${spd} u/с: запись из легаси-числа обязана дать ту же позу`).toBe(true);
        const nul = run({ swing: 0.45, layers: null }, { mix, spd }).snap;
        expect(same(legacy, nul), `${spd} u/с: layers = null — как нет поля`).toBe(true);
      }
    });

    it(`⭐⭐ ВЕС ЧАСТИ ДВИГАЕТ ТОЛЬКО СВОИ КОСТИ, ${name}`, () => {
      const base = run({ swing: 0.2 }, { mix, spd: 120 }).snap;
      for (const p of LAYER_PARTS) {
        // В смешанном режиме голова по умолчанию УЖЕ у походки (вес 1) — двигаем её вниз; остальное — вверх.
        const v = p.id === 'head' ? (mix ? 0.9 : 0.1) : 0.9;
        const got = run({ swing: 0.2, layers: { walk: { [p.id]: v }, run: { [p.id]: v } } }, { mix, spd: 120 }).snap;
        // ⚠ ГРУДЬ ТЯНЕТ ЗА СОБОЙ ЛОКАЛЬНЫЙ ПОВОРОТ `Head` — и это не протечка веса: взгляд на прицел (`applyHeadLookAt`)
        // держит голову в МИРОВОМ курсе, то есть доворачивает её ровно на столько, на сколько ушла грудь под ней.
        const want = p.id === 'chest' ? [...p.bones, 'Head'] : [...p.bones];   // голову за грудью тянет look-at
        expect(moved(base, got), `часть «${p.label}»`).toEqual(want.sort());
      }
    });
  }

  it('⭐ УМОЛЧАНИЕ ГОЛОВЫ ЗАВИСИТ ОТ РЕЖИМА — и оно сегодняшнее: смешанный 1 (ручки походки), «только клипы» 0 (стойка)', () => {
    // Сравнение «легаси ≡ запись из легаси» умолчание головы НЕ ловит (оно у обеих сторон одно). Поэтому явный вес,
    // равный умолчанию режима, обязан дать позу бит в бит с «записи нет», а противоположный — сдвинуть голову.
    const head = (v: number): LayerEntry => ({ walk: { head: v }, run: { head: v } });
    const m0 = run({ swing: 0.2 }, { mix: 0, spd: 120 }).snap, c0 = run({ swing: 0.2 }, { mix: 1, spd: 120 }).snap;
    expect(same(m0, run({ swing: 0.2, layers: head(1) }, { mix: 0, spd: 120 }).snap), 'смешанный: голова по умолчанию = 1').toBe(true);
    expect(same(c0, run({ swing: 0.2, layers: head(0) }, { mix: 1, spd: 120 }).snap), '«только клипы»: голова по умолчанию = 0').toBe(true);
    expect(diff(m0, run({ swing: 0.2, layers: head(0) }, { mix: 0, spd: 120 }).snap, 'Neck')).toBeGreaterThan(1);
    expect(diff(c0, run({ swing: 0.2, layers: head(1) }, { mix: 1, spd: 120 }).snap, 'Neck')).toBeGreaterThan(1);
  });

  it('⭐ ВЕС ГОЛОВЫ НЕ ДВИГАЕТ ТАЗ — И НА РАЗГОНЕ ДОЛИ КЛИПА ТОЖЕ', () => {
    // Голову из клипа кладёт общий шов клипа (`blendClipBones`), а он же тянет офсет таза к цели весом слоя. На полной
    // доле второй вызов безвреден (таз уже в цели), поэтому ловится это ТОЛЬКО на разгоне: 6 кадров — доля 0.4.
    const head: LayerEntry = { walk: { head: 1 }, run: { head: 1 } };
    const a = run({ swing: 0.2 }, { mix: 1, spd: 120, frames: 6 }).snap, b = run({ swing: 0.2, layers: head }, { mix: 1, spd: 120, frames: 6 }).snap;
    expect(moved(a, b)).toEqual(['Head', 'Neck']);
  });

  it('⭐ ХОДЬБА И БЕГ — РАЗНЫЕ ВЕСА: вес бега не трогает ходьбу на 40 u/с, вес ходьбы не трогает бег на 120', () => {
    const w0 = run({ swing: 0.2 }, { mix: 1, spd: 40 }).snap, r0 = run({ swing: 0.2 }, { mix: 1, spd: 120 }).snap;
    const onlyRun: LayerEntry = { run: { chest: 0.9 } }, onlyWalk: LayerEntry = { walk: { chest: 0.9 } };
    expect(same(w0, run({ swing: 0.2, layers: onlyRun }, { mix: 1, spd: 40 }).snap), 'ходьба 40: вес бега молчит').toBe(true);
    expect(diff(r0, run({ swing: 0.2, layers: onlyRun }, { mix: 1, spd: 120 }).snap, 'Chest'), 'бег 120: вес бега работает').toBeGreaterThan(1);
    expect(same(r0, run({ swing: 0.2, layers: onlyWalk }, { mix: 1, spd: 120 }).snap), 'бег 120: вес ходьбы молчит').toBe(true);
    expect(diff(w0, run({ swing: 0.2, layers: onlyWalk }, { mix: 1, spd: 40 }).snap, 'Chest'), 'ходьба 40: вес ходьбы работает').toBeGreaterThan(1);
  });

  it('⭐ КОЛОНКА БОЯ: в бою — свой вес, в релаксе она молчит', () => {
    const e: LayerEntry = { combat: { run: { chest: 0.95 } } };
    const relax0 = run({ swing: 0.2 }, { mix: 1, spd: 120 }).snap;
    expect(same(relax0, run({ swing: 0.2, layers: e }, { mix: 1, spd: 120 }).snap), 'релакс: колонка боя не читается').toBe(true);
    const c0 = run({ swing: 0.2 }, { mix: 1, spd: 120, combat: true }).snap, c1 = run({ swing: 0.2, layers: e }, { mix: 1, spd: 120, combat: true }).snap;
    expect(moved(c0, c1), 'бой: сдвинулась грудь (и голова за ней — её держит look-at)').toEqual(['Chest', 'Head', 'UpperChest']);
  });

  it('⭐ СТОЯ СТОЙКА ВЛАДЕЕТ ВСЕМ при любых весах: вес — доля ЛОКОМОЦИИ, а локомоции стоя нет', () => {
    const one: LayerEntry = { walk: { chest: 1, head: 1 }, run: { chest: 1, head: 1 } };
    for (const mix of [0, 1]) {
      const a = run({ swing: 0.2 }, { mix, spd: 0 }).snap, b = run({ swing: 0.2, layers: one }, { mix, spd: 0 }).snap;
      expect(same(a, b), `стоя, доля клипа ${mix}`).toBe(true);
    }
  });

  it('трасса слоёв: строка «ПОЗА ВЕРХА» как была + строка на каждую часть, числа — доля локомоции этого кадра', () => {
    layerTrace.on = true;
    run({ swing: 0.2, layers: { run: { chest: 0.8 }, walk: { chest: 0.8 } } }, { mix: 1, spd: 120 });
    const row = (n: string): number => layerTrace.rows.find((r) => r.layer === n)!.w;
    // Руки в трассе — по ПРЕДМЕТУ в них (контент стенда рук не занимает → обе пусты → мах клипа целиком).
    expect(row('↳ рука П'), 'пустая рука машет клипом').toBeCloseTo(1, 6);
    expect(row('↳ рука Л')).toBeCloseTo(1, 6);
    expect(row('↳ грудь')).toBeCloseTo(0.8, 6);
    expect(row('↳ голова'), 'в «только клипы» головой владеет стойка').toBe(0);
    expect(layerTrace.rows.find((r) => r.layer === '↳ рука П')!.src, 'в подписи видно, что рука пуста').toContain('пуста');
  });
});

/** Вторая стойка — другие руки, кисти и грудь: чистый клип обязан не зависеть и от ПОЗЫ стойки, не только от веса. */
const STANCE_B: Pose = { ...STANCE,
  LeftUpperArm: [-0.4, 0.3, -1.1], RightUpperArm: [0.6, 0.2, 0.2], LeftLowerArm: [0, -0.2, 0], RightLowerArm: [0, 1.9, 0],
  LeftShoulder: [0, 0.1, 0.1], RightShoulder: [-0.1, 0, 0], LeftHand: [-0.4, 0, 0], RightHand: [0.5, -0.3, 0.2],
  Chest: [-0.2, 0.2, 0.1], UpperChest: [0.2, 0.1, -0.1] };
const UPPER = ['LeftShoulder', 'LeftUpperArm', 'LeftLowerArm', 'RightShoulder', 'RightUpperArm', 'RightLowerArm', 'LeftHand', 'RightHand', 'Chest', 'UpperChest'];
/** Каналы верха по всем ключам клипа — строкой, для сравнения бит в бит. */
const upperOf = (c: Clip): string => JSON.stringify(c.keys.map((k) => UPPER.map((b) => k.pose[b])));

describe('pe_layers: запекание снимает верх ЧИСТЫМ', () => {
  const RUN = GAIT_PRESETS.find((s) => s.name === 'run_fwd')!;
  const IDLE = GAIT_PRESETS.find((s) => s.name === 'idle')!;
  const bake = (up: Partial<UpperPose>, spec = RUN): Clip => {
    const h = buildHumanoid({});
    const p = new PosePlayer(h, () => [], content(up), 'none', GX, emptyGrid());
    return bakeGaitToClip(p, h, spec, { character: 'warrior', weapon: 'none' }).clip;
  };
  const arcOf = (c: Clip, bone: string): number => {
    const qs: THREE.Quaternion[] = [];
    for (let i = 0; i < 40; i++) { const e = clipPoseAt(c, i / 40)[bone]!; qs.push(new THREE.Quaternion().setFromEuler(new THREE.Euler(e[0], e[1], e[2], 'XYZ'))); }
    let m = 0; for (const a of qs) for (const b of qs) m = Math.max(m, a.angleTo(b));
    return m * D;
  };

  it('⭐⭐ КЛИП ХОДА НЕ ЗАВИСИТ ОТ ВЕСА СТОЙКИ: съём при sway 0 / 0.2 / 1 и при любой записи — одни и те же ключи', () => {
    // ⚠ БЫЛО: размах плеча клипа 0.0° / 24.1° / 119.1° при sway 0 / 0.2 / 1 — стойка запекалась в руки долей `1 − sway`,
    // а при проигрывании клип смешивался со стойкой ВТОРОЙ раз (под мечом от маха оставалось 10 %).
    const a = bake({ swing: 0 }), b = bake({ swing: 0.2 }), c = bake({ swing: 1 });
    const d = bake({ swing: 0.2, layers: { run: { chest: 0.9 }, walk: { head: 0 } } });
    expect(JSON.stringify(b.keys)).toBe(JSON.stringify(a.keys));
    expect(JSON.stringify(c.keys)).toBe(JSON.stringify(a.keys));
    expect(JSON.stringify(d.keys)).toBe(JSON.stringify(a.keys));
    expect(upperOf(bake({ swing: 0.2, pose: STANCE_B })), 'и от ПОЗЫ стойки верх клипа не зависит').toBe(upperOf(a));
    expect(arcOf(a, 'RightUpperArm'), 'и это ПОЛНЫЙ мах походки, а не ноль').toBeGreaterThan(20);
    expect(a.upperPure, 'метка «верх чистый» — по ней редактор предложит перезапечь старые клипы').toBe(true);
  });

  it('⭐ ЧИСТОТА КЛИПА НЕ ЗАВИСИТ ОТ `speedWalk`: ходьба снимается на 40 u/с, и при пороге 50 ход = 0.8 — стойка не течёт', () => {
    // Ворота по ходу (`moveMag` = скорость / speedWalk) при съёме ходьбы равны 1 только пока `speedWalk ≤ 40`.
    // Подними автор порог — и без прибитых ворот в клип ходьбы вернулись бы 20 % стойки.
    const was = GAIT.speedWalk;
    try {
      GAIT.speedWalk = 50;
      const WALK = GAIT_PRESETS.find((s) => s.name === 'walk_fwd')!;
      // ⚠ Сравниваем ПОЗЫ стойки, а не веса: под перекрытием вес и так единица, и протечка 20 % была бы у обоих
      // съёмов одинаковой. Голова и поясница сюда не входят: их ворота — общий `moveMag`, как и до весов слоёв.
      expect(upperOf(bake({ swing: 0.2, pose: STANCE_B }, WALK))).toBe(upperOf(bake({ swing: 0.2 }, WALK)));
    } finally { GAIT.speedWalk = was; }
  });

  it('стойка `idle` по-прежнему снимается СТОЙКОЙ (стоя локомоции нет), и метки хода у неё нет', () => {
    const c = bake({ swing: 0.2 }, IDLE);
    const e = clipPoseAt(c, 0)['RightUpperArm']!;
    const want = STANCE['RightUpperArm']!;
    const q = (v: readonly number[]): THREE.Quaternion => new THREE.Quaternion().setFromEuler(new THREE.Euler(v[0]!, v[1]!, v[2]!, 'XYZ'));
    expect(q(e).angleTo(q(want)) * D, 'рука стойки').toBeLessThan(0.1);
    expect(c.upperPure).toBeUndefined();
  });

  it('перекрытие запекания снято после съёма — и после съёма, который УПАЛ', () => {
    bake({ swing: 0.2 });
    expect(getLayerBakeOverride()).toBe(false);
    const h = buildHumanoid({});
    const p = new PosePlayer(h, () => [], content({}), 'none', GX, emptyGrid());
    expect(() => bakeGaitToClip(p, h, RUN, { character: 'warrior', weapon: 'none', readPose: () => { throw new Error('сбой чтения'); } })).toThrow('сбой чтения');
    expect(getLayerBakeOverride(), 'иначе игра после неудачного съёма играла бы без стойки в руках').toBe(false);
  });
});

describe('pe_layers: контент игры', () => {
  const withStore = (data: Record<string, unknown>, fn: () => void): void => {
    const was = globalThis.localStorage;
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => (k in data ? JSON.stringify(data[k]) : null), setItem: () => { /* */ }, removeItem: () => { /* */ }, clear: () => { /* */ }, key: () => null, length: 0,
    } as unknown as Storage;
    try { fn(); } finally { (globalThis as unknown as { localStorage: Storage }).localStorage = was; }
  };
  const idle = (w: string): Clip => ({ name: 'idle_' + w + '_relax', character: 'warrior', weapon: w, loop: false, keys: [{ t: 0, pose: STANCE }] });

  it('⭐ ИГРА ЧИТАЕТ `pe_layers` ТЕМ ЖЕ ПОИСКОМ: меч+щит без своей записи берёт запись меча, легаси — умолчанием частей', () => {
    const entry: LayerEntry = { run: { chest: 0.8 } };
    withStore({ pe_clips: [idle('none'), idle('sword')], pe_sway: { warrior: { none: 0.5, sword: 0.3 } }, pe_layers: { warrior: { sword: entry } } }, () => {
      const c = localStorageContent('warrior');
      expect(c.resolveUpper('sword+shield')).toMatchObject({ swing: 0.3, layers: entry });
      expect(c.resolveUpper('none')).toMatchObject({ swing: 0.5, layers: null });
      // ⚠ РАНЬШЕ редактор показывал здесь 0.2 (нашёл полную стойку по привязке), а игра играла 0.5 (искала по
      // историческому имени `idle_<w>` и не находила). Теперь поиск один.
      expect(c.resolveUpper('none+shield')).toMatchObject({ swing: 0.5, layers: null });
    });
  });

  it('⭐ КУКЛА ВКЛАДКИ «ТЕСТ» ВИДИТ ПРАВКУ ПАНЕЛИ БЕЗ ПЕРЕСБОРКИ: живой источник бьёт снимок, в игре источника нет', () => {
    // Контент игровой куклы — снимок localStorage на момент сборки. Панель весов стоит рядом с ЭТОЙ куклой, и без
    // живого источника ползунок начинал бы действовать только после «в центр» (пересборка: физика + GLB).
    withStore({ pe_clips: [idle('none'), idle('sword')], pe_sway: { warrior: { sword: 0.3 } } }, () => {
      const c = localStorageContent('warrior');
      expect(c.resolveUpper('sword')).toMatchObject({ swing: 0.3, layers: null });
      const live: LayerStore = {};
      let sway = { warrior: { sword: 0.3 } };
      setLayerSource(() => ({ layers: live, sway }));
      const e: LayerEntry = { run: { chest: 0.9 } };
      (live.warrior ??= {}).sword = e;                                     // «потянули ползунок»
      expect(c.resolveUpper('sword')!.layers, 'тот же контент, та же кукла — запись уже видна').toBe(e);
      sway = { warrior: { sword: 0.7 } };                                  // редактор ПЕРЕПРИСВОИЛ стор (подтянул с сервера)
      expect(c.resolveUpper('sword')!.swing, 'источник — функция: переприсвоенный стор тоже виден').toBe(0.7);
      setLayerSource(null);
      expect(c.resolveUpper('sword'), 'источника нет (игра) — снимок, как и было').toMatchObject({ swing: 0.3, layers: null });
    });
  });
});

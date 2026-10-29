import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { gaitToHumanoid, emptyGrid, localStorageContent } from './poseRuntime.js';
import type { PoseContent } from './poseRuntime.js';
import { buildHumanoid } from './humanoid.js';
import { PoseDriver } from './stepPlanner.js';
import type { Pose, Clip } from './clipModel.js';
import { fingersAnimated } from './clipModel.js';

/**
 * ⭐⭐ ХВАТ (ФАЛАНГИ) ОБЯЗАН ДОЕЗЖАТЬ ДО ИГРЫ.
 *
 * Жалоба: «хват не доезжает до анимаций — я во всех идлах сделал и в ударах тоже, а пальцы прямые
 * и в игре, и во вкладке Тест».
 *
 * Хват уезжает в игру ЗАПЕЧЁННЫМ В КЛИПЫ (запекание на публикации), и оно РАБОТАЕТ — ЗАМЕР
 * опубликованных клипов: по **30 каналов фаланг в кадре**. Причин, почему пальцы всё равно прямые,
 * было ДВЕ, и обе молчаливые:
 *  • у игровой куклы НЕ БЫЛО КОСТЕЙ ПАЛЬЦЕВ (`buildHumanoid` без `fingers`) — `bones.get(...)`
 *    отдаёт `undefined`, и канал теряется без единого следа;
 *  • слои позы и удара идут по ЯВНЫМ спискам костей (`UPPER_BONES` — ровно 6, `ATK_BONES` — 11),
 *    фаланг в них нет вовсе.
 *
 * ⚠ ВЕС 1, А НЕ ВЕС СЛОЯ: хват — статичная поза кисти. Блендить его к нулю по ходу значило бы
 * распрямлять пальцы тем сильнее, чем быстрее бежишь.
 */
describe('хват доезжает до рантайма', () => {
  const FINGER = 'LeftIndexProximal';
  const GRIP = 0.77;
  const stance = (): Pose => ({ [FINGER]: [GRIP, 0, 0] } as unknown as Pose);
  const content = (): PoseContent => ({ resolveUpper: () => ({ pose: stance(), swing: 0 }) });

  const run = (fingers: boolean, moveMag: number): number | null => {
    const h = buildHumanoid({ style: 'skeleton', fingers });
    const d = new PoseDriver();
    d.setMove(moveMag); d.setWorld(0, 0, 0, 0, 0); d.update(1 / 60);
    gaitToHumanoid(h, [], { armDown: 1.35, elbowBend: 0.25 }, moveMag, d.out, content(), 'none',
      { clip: null, t: -1 }, moveMag, true);
    return h.bones.get(FINGER)?.rotation.x ?? null;
  };

  it('⭐ поза стойки КЛАДЁТ фалангу (канал больше не теряется)', () => {
    // ⚠ Мутация «убрать applyGripChannels из слоя позы» валит именно это.
    expect(run(true, 0), '⚠ ХВАТ НЕ ДОЕХАЛ: фаланга осталась прямой').toBeCloseTo(GRIP, 6);
  });

  it('⭐ хват НЕ РАЗБАВЛЯЕТСЯ ходом — на бегу он тот же', () => {
    // ⚠ Мутация «блендить хват весом слоя» валит это: на бегу пальцы распрямились бы.
    expect(run(true, 1), '⚠ хват поехал вместе с махом — пальцы распрямляются на бегу').toBeCloseTo(GRIP, 6);
  });

  it('⚠ без костей пальцев канал просто некуда класть — так и было в игре', () => {
    expect(run(false, 0), 'подстраховка: без `fingers` кости нет вовсе').toBe(null);
  });

  it('⚠ в solid-стиле у фаланг НЕТ мешей — иначе на руках повисли бы процедурные сегменты', () => {
    const solid = buildHumanoid({ style: 'solid', fingers: true });
    expect(solid.bones.has(FINGER), 'кость обязана быть').toBe(true);
    const fingerMeshes = solid.meshes.filter((m) => /(Thumb|Index|Middle|Ring|Little)(Proximal|Intermediate|Distal)$/.test(String(m.userData.bone ?? '')));
    expect(fingerMeshes.length, '⚠ у фаланг появилась геометрия — её никто не прячет картой слотов').toBe(0);
  });
});
void THREE;

/**
 * ⭐⭐ ЖИВОЙ ХВАТ: ИГРА ЧИТАЕТ КОНФИГ САМА (продолжение той же жалобы — «хват так и не появился нигде»).
 *
 * Запекание в клип работает, но доезжает только ДО СЕРВЕРА. ЗАМЕР: в опубликованных клипах по 30
 * ненулевых каналов фаланг, в ЛОКАЛЬНОМ `pe_clips` — 0, а игра и вкладка «Тест» читают клипы именно
 * из localStorage. То есть запечённый хват физически не появлялся ни там, ни там.
 */
describe('живой хват из конфига', () => {
  const FINGER = 'LeftIndexProximal';
  const LIVE = 0.41, BAKED = 0.13;
  const livePose = (): Pose => ({ [FINGER]: [LIVE, 0, 0] } as unknown as Pose);

  /** Прогнать кадр и вернуть угол фаланги. */
  const frame = (content: PoseContent, atk: { clip: Clip | null; t: number } = { clip: null, t: -1 }): number => {
    const h = buildHumanoid({ style: 'skeleton', fingers: true });
    const d = new PoseDriver();
    d.setMove(0); d.setWorld(0, 0, 0, 0, 0); d.update(1 / 60);
    gaitToHumanoid(h, [], { armDown: 1.35, elbowBend: 0.25 }, 0, d.out, content, 'sword', atk, 0, true);
    return h.bones.get(FINGER)!.rotation.x;
  };

  it('⭐⭐ В КЛИПЕ ФАЛАНГ НЕТ — хват всё равно на месте (ровно случай локальной рабочей копии)', () => {
    // ⚠ Мутация «убрать applyGripChannels(liveGrip(...)) из applyUpper» валит это: пальцы прямые,
    // как и было в игре и во вкладке «Тест».
    const content: PoseContent = {
      resolveUpper: () => ({ pose: {} as Pose, swing: 0 }),
      gripPose: () => livePose(),
    };
    expect(frame(content), '⚠ ХВАТ НЕ ДОЕХАЛ: в клипе фаланг нет, а конфиг не спросили').toBeCloseTo(LIVE, 6);
  });

  it('⭐ ЖИВОЙ КОНФИГ СИЛЬНЕЕ ЗАПЕЧЁННОГО — иначе правка не видна, пока не опубликуешь заново', () => {
    const content: PoseContent = {
      resolveUpper: () => ({ pose: { [FINGER]: [BAKED, 0, 0] } as unknown as Pose, swing: 0 }),
      gripPose: () => livePose(),
    };
    expect(frame(content), '⚠ победил слепок из клипа — настройка хвата протухла').toBeCloseTo(LIVE, 6);
  });

  it('⚠ АНИМАЦИЯ ПАЛЬЦЕВ СИЛЬНЕЕ КОНФИГА — статичный хват не имеет права её затирать', () => {
    // ⚠ Мутация «игнорировать fingersAnimated» валит это: снятое с мокапа движение кисти подменилось бы позой.
    const content: PoseContent = {
      resolveUpper: () => ({ pose: { [FINGER]: [BAKED, 0, 0] } as unknown as Pose, swing: 0, fingersAnimated: true }),
      gripPose: () => livePose(),
    };
    expect(frame(content), '⚠ живой хват затёр анимацию пальцев').toBeCloseTo(BAKED, 6);
  });

  it('контент без метода хвата ведёт себя РОВНО как раньше', () => {
    const content: PoseContent = { resolveUpper: () => ({ pose: { [FINGER]: [BAKED, 0, 0] } as unknown as Pose, swing: 0 }) };
    expect(frame(content)).toBeCloseTo(BAKED, 6);
  });

  it('⭐ УДАР тоже берёт живой хват — он ложится ПОВЕРХ позы удара', () => {
    // ⚠ Мутация «не передавать хват в overlayAttack» валит это: в ударе пальцы распрямлялись бы.
    // ⚠ В КАДРАХ УДАРА ЛЕЖИТ ЗАПЕЧЁННЫЙ (СТАРЫЙ) ХВАТ — одинаковый в обоих кадрах, то есть не анимация.
    // Без передачи хвата в `overlayAttack` победил бы именно он, и тест бы этого не заметил, если бы
    // кадры удара были пустыми: там осталась бы величина от стойки.
    const stale = { [FINGER]: [BAKED, 0, 0] } as unknown as Pose;
    const clip: Clip = { name: 'hit_sword_r_01', character: 'warrior', weapon: 'sword',
      keys: [{ t: 0, pose: stale }, { t: 0.3, pose: stale }] } as unknown as Clip;
    const content: PoseContent = {
      resolveUpper: () => ({ pose: {} as Pose, swing: 0 }),
      gripPose: () => livePose(),
    };
    expect(frame(content, { clip, t: 0.15 }), '⚠ в ударе хвата нет').toBeCloseTo(LIVE, 6);
  });

  it('⭐⭐ СКВОЗНОЙ ПУТЬ: конфиг лежит в localStorage — пальцы гнутся', () => {
    // Ровно то, что делает игра: `localStorageContent` читает `pe_gripposes` тем же ключом, что редактор.
    const store: Record<string, string> = {
      pe_clips: JSON.stringify([{ name: 'idle_sword', character: 'warrior', weapon: 'sword', keys: [{ t: 0, pose: {} }] }]),
      pe_gripposes: JSON.stringify({ custom: {}, byWeapon: { warrior: { sword: { R: 'fist', closeR: 1 } } } }),
    };
    const prev = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      value: { getItem: (k: string) => store[k] ?? null, setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0 },
      configurable: true,
    });
    try {
      const content = localStorageContent('warrior');
      const h = buildHumanoid({ style: 'skeleton', fingers: true });
      const d = new PoseDriver();
      d.setMove(0); d.setWorld(0, 0, 0, 0, 0); d.update(1 / 60);
      gaitToHumanoid(h, [], { armDown: 1.35, elbowBend: 0.25 }, 0, d.out, content, 'sword', { clip: null, t: -1 }, 0, true);
      const curl = Math.abs(h.bones.get('RightIndexProximal')!.rotation.z);
      expect(curl, '⚠ хват из localStorage не доехал до кости — пальцы прямые').toBeGreaterThan(0.3);
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { value: prev, configurable: true });
    }
  });
});

describe('анимация пальцев в клипе', () => {
  const k = (v: number): { t: number; pose: Pose } => ({ t: 0, pose: { LeftIndexProximal: [v, 0, 0] } as unknown as Pose });
  it('один кадр — это не анимация', () => {
    expect(fingersAnimated({ keys: [k(0.5)] })).toBe(false);
  });
  it('одинаковые кадры — запечённый статичный хват, не анимация', () => {
    expect(fingersAnimated({ keys: [k(0.5), k(0.5), k(0.5)] })).toBe(false);
  });
  it('⭐ каналы РАЗЛИЧАЮТСЯ — это движение кисти, его трогать нельзя', () => {
    expect(fingersAnimated({ keys: [k(0.5), k(0.9)] })).toBe(true);
  });
  it('канал пропал в другом кадре — тоже изменение', () => {
    expect(fingersAnimated({ keys: [k(0.5), { t: 1, pose: {} as Pose }] })).toBe(true);
  });
  it('не-фаланги не считаются', () => {
    const a = { t: 0, pose: { Spine: [0, 0, 0] } as unknown as Pose }, b = { t: 1, pose: { Spine: [1, 0, 0] } as unknown as Pose };
    expect(fingersAnimated({ keys: [a, b] })).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { gaitToHumanoid, emptyGrid } from './poseRuntime.js';
import type { PoseContent } from './poseRuntime.js';
import { buildHumanoid } from './humanoid.js';
import { PoseDriver } from './pose.js';
import type { Pose } from './clipModel.js';

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

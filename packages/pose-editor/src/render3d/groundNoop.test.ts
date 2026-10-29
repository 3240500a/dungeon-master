import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { buildHumanoid } from './humanoid.js';
import { groundFeet } from './footIk.js';

/**
 * ⭐ ЗАЗЕМЛЕНИЕ НА ДОСТИЖИМОЙ ЦЕЛИ ОБЯЗАНО БЫТЬ ТОЖДЕСТВЕННЫМ.
 *
 * Жалоба: «включаю заземление — ноги чуть поднимаются над землёй и сгибаются колени, а должна
 * сохраняться поза; если рут на нуле, тумблер вообще не должен давать разницы».
 *
 * ПРИЧИНА была в запасе досягаемости: `legGeom` отдавал `max = thigh + shin − 0.5`, а рест-нога рига
 * выпрямлена практически на всю длину. Кламп в солвере (`dist = clamp(dist, g.min, g.max)`) резал
 * цель, и косинусная теорема выдавала ненулевой угол ДАЖЕ когда стопа уже стояла ровно в цели.
 *
 * ЗАМЕР на рыцаре (T-поза, пол ровный, рут на нуле): сустав бедра 31.379, лодыжка 2.892 → пролёт
 * 28.4866 при потолке 28.009. Кламп резал 0.4775 — стопа поднималась на 0.468, колено гнулось на
 * 18.3°, подошва меша уезжала −0.021 → +0.439. Ровно то, что пользователь видел глазами.
 *
 * ⚠ Ровно эта беда уже была найдена для ЗАПЕКАНИЯ (`legGeomFor`, запас 0.02, «стопа в покое уезжала
 * бы на полюнита каждый кадр»), но игровой и редакторский путь чинить забыли.
 */
describe('заземление: цель достижима → поза не меняется', () => {
  /** Манекен с ПРЯМОЙ ногой: именно на ней кламп и кусался. */
  function mk(): ReturnType<typeof buildHumanoid> {
    const h = buildHumanoid({ style: 'skeleton' });
    h.reset();
    h.root.updateMatrixWorld(true);
    return h;
  }
  const LEGS = ['LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot', 'RightUpperLeg', 'RightLowerLeg', 'RightFoot'];
  const snap = (h: ReturnType<typeof buildHumanoid>): THREE.Quaternion[] =>
    LEGS.map((n) => h.bones.get(n)!.quaternion.clone());
  const worstDeg = (a: THREE.Quaternion[], b: THREE.Quaternion[]): number => {
    let w = 0;
    for (let i = 0; i < a.length; i++) w = Math.max(w, 2 * Math.acos(Math.min(1, Math.abs(a[i]!.dot(b[i]!)))) * 180 / Math.PI);
    return w;
  };
  const footY = (h: ReturnType<typeof buildHumanoid>, n: string): number => {
    h.root.updateMatrixWorld(true);
    return h.bones.get(n)!.getWorldPosition(new THREE.Vector3()).y;
  };

  it('⭐ стопа УЖЕ в цели → нога почти не шевелится (было 18.3°)', () => {
    const h = mk();
    // Пол ставим ровно туда, где стопа и так стоит: заземлять нечего.
    const sole = h.ankleRest ?? 1.5;
    const y0 = footY(h, 'LeftFoot');
    const before = snap(h);
    groundFeet(h, h.hipsWorldY(), { off: 0 }, 1e3, () => y0 - sole, [true, true]);
    const after = snap(h);
    // ⚠ НЕ РОВНО 0, и это честный порог, а не послабление. `legGroundIK` собирает кватернионы С НУЛЯ
    // (`aimBoneFrame`) и кладёт стопу плашмя, поэтому у ПРОЦЕДУРНОГО манекена (ноги чуть разведены) остаётся ~4° на
    // реконструкции твиста. НА ЖИВОЙ МОДЕЛИ ЗАМЕР ДАЁТ РОВНЫЙ 0.00° (T-поза, тумблер вкл/выкл —
    // подошва −0.0208, лодыжка 2.8925, колени 0.00° в обоих состояниях). Порог ловит регресс клампа: он давал 18.3°.
    expect(worstDeg(before, after), '⚠ заземление гнёт ногу на достижимой цели — вернулся кламп досягаемости').toBeLessThan(6);
  });

  it('⭐ и стопа не уезжает вверх (та самая «полюнита»)', () => {
    const h = mk();
    const sole = h.ankleRest ?? 1.5;
    const y0 = footY(h, 'LeftFoot');
    groundFeet(h, h.hipsWorldY(), { off: 0 }, 1e3, () => y0 - sole, [true, true]);
    expect(Math.abs(footY(h, 'LeftFoot') - y0), '⚠ стопа уехала от собственной цели').toBeLessThan(0.05);
  });

  it('детерминировано: кадр за кадром один и тот же ответ', () => {
    // ТАК ЭТО ЗОВЁТСЯ НА САМОМ ДЕЛЕ: `renderRagdollGhost` каждый кадр делает `mesh.reset()` и собирает
    // позу заново, а редакторский `groundManikin` ещё и откатывает кватернионы после себя.
    // ⚠ БЕЗ `reset` между вызовами нога МЕДЛЕННО ПРОКАТЫВАЕТСЯ вокруг своей оси (замер: 1.76° на
    // втором вызове, 0.73° на девятом, стопа при этом стоит намёртво) — полюс колена берётся из ТЕКУЩЕГО
    // бедра, то есть сам из себя. В рендере не копится из-за reset, но зависеть от этого не стоит.
    const runOnce = (): THREE.Quaternion[] => {
      const h = mk();
      const sole = h.ankleRest ?? 1.5;
      const y0 = footY(h, 'LeftFoot');
      groundFeet(h, h.hipsWorldY(), { off: 0 }, 1e3, () => y0 - sole, [true, true]);
      return snap(h);
    };
    // Порог — тысячная градуса: метрика через `acos` у единицы усиливает флоат-шум (замер: 2.4e−6°).
    expect(worstDeg(runOnce(), runOnce()), '⚠ заземление недетерминировано').toBeLessThan(1e-3);
  });

  it('заземление ВСЁ ЕЩЁ РАБОТАЕТ: пол ниже стопы → стопа идёт вниз', () => {
    // Сторож против «починили тождественность, заодно выключив заземление».
    const h = mk();
    const sole = h.ankleRest ?? 1.5;
    const y0 = footY(h, 'LeftFoot');
    groundFeet(h, h.hipsWorldY(), { off: 0 }, 1e3, () => y0 - sole - 3, [true, true]);
    expect(footY(h, 'LeftFoot'), '⚠ заземление перестало опускать стопу к полу').toBeLessThan(y0 - 0.5);
  });
});

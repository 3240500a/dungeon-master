import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  BUILTIN_GRIPS, findGrip, gripToPose, gripToPoseBoth, handBones, isHandBone, straightHandPose,
  resolveGripPose, defaultWeaponGrip, effectiveWeaponGrip, applyGripPose, mirrorHandPose, EMPTY_GRIP_CONFIG, type GripConfig,
} from './gripPoses.js';
import { buildHumanoid } from './humanoid.js';
import { allFingerBones } from './boneNames.js';
import { extraLimitView } from './jointLimits.js';
import { decomposeToLimit } from './jointClamp.js';
import { mirrorSide, type Pose } from './clipModel.js';
import { canonicalFingerAxes, type FingerAxes } from './fingerAxes.js';

/**
 * Ф14.4: сгиб живёт на ВЫВЕДЕННОЙ оси, а не в фиксированной компоненте эйлера, поэтому проверяем
 * СМЫСЛ (сколько согнуто вокруг своей оси), а не число в ячейке. Раньше тесты смотрели в `[1]` (Y),
 * и после переноса оси они бы либо падали, либо — хуже — молча позеленели бы на нулях.
 */
const _q = new THREE.Quaternion(), _e = new THREE.Euler();
const dec = (p: Pose, bone: string): { rP: number; rN: number; twist: number } => {
  const v = p[bone]!; const view = extraLimitView(bone)!;
  _q.setFromEuler(_e.set(v[0], v[1], v[2], 'XYZ'));
  return decomposeToLimit(_q, view);
};
/** Сгиб «в кулак» вокруг собственной оси пальца (положительный = к ладони). */
const curl = (p: Pose, bone: string): number => dec(p, bone).rP;

describe('gripPoses — раскрытие пресета в позу', () => {
  it('кисть = 15 фаланг, обе кисти = 30', () => {
    expect(handBones('Left').length).toBe(15);
    expect(new Set([...handBones('Left'), ...handBones('Right')]).size).toBe(30);
    expect(allFingerBones().every(isHandBone)).toBe(true);
    expect(isHandBone('LeftHand')).toBe(false);
    expect(isHandBone('Spine')).toBe(false);
  });

  it('«открытая» — все углы нулевые', () => {
    const p = gripToPose(findGrip('open')!, 'Left');
    for (const k in p) for (const c of p[k]!) expect(Math.abs(c)).toBeLessThan(1e-9);
  });

  it('«кулак» реально сгибает пальцы К ЛАДОНИ, а не разводит вбок', () => {
    const p = gripToPose(findGrip('fist')!, 'Left');
    expect(curl(p, 'LeftIndexProximal')).toBeGreaterThan(1);
    expect(curl(p, 'LeftLittleIntermediate')).toBeGreaterThan(1);
    expect(curl(p, 'LeftThumbProximal')).toBeGreaterThan(0.5);
    expect(Math.abs(dec(p, 'LeftIndexProximal').rN)).toBeLessThan(1e-4);   // боковой развод — ноль (1e-4 = округление позы до 5 знаков)
  });

  it('ГЛАВНОЕ: правая кисть — точное зеркало левой (канон-зеркало `mirrorSide`)', () => {
    // Этот тест — спецификация знаков. Ось сгиба сама зеркальна (plane_R = −plane_L), поэтому у сгиба
    // пер-стороннего множителя быть НЕ должно; ось твиста полярна, поэтому у противопоставления — должен.
    for (const g of BUILTIN_GRIPS) {
      const l = gripToPose(g, 'Left'), r = gripToPose(g, 'Right');
      const m = mirrorSide(l, 'Left');
      for (const k in r) for (let i = 0; i < 3; i++) expect(r[k]![i]!, `${g.id}/${k}[${i}]`).toBeCloseTo(m[k]![i]!, 6);
    }
  });

  it('обе кисти сгибаются в кулак ОДИНАКОВО (знак сидит в оси, а не в множителе)', () => {
    const both = gripToPoseBoth(findGrip('fist')!, findGrip('fist')!);
    expect(curl(both, 'LeftIndexProximal')).toBeGreaterThan(1);
    expect(curl(both, 'RightIndexProximal')).toBeGreaterThan(1);
  });

  it('слайдер «сжатие» линейно масштабирует хват', () => {
    const full = gripToPose(findGrip('fist')!, 'Left', 1);
    const half = gripToPose(findGrip('fist')!, 'Left', 0.5);
    const none = gripToPose(findGrip('fist')!, 'Left', 0);
    expect(curl(half, 'LeftIndexProximal')).toBeCloseTo(curl(full, 'LeftIndexProximal') / 2, 5);
    expect(curl(none, 'LeftIndexProximal')).toBeCloseTo(0, 9);
  });

  it('«указ. палец» оставляет указательный прямым, остальные сжаты', () => {
    const p = gripToPose(findGrip('point')!, 'Left');
    expect(Math.abs(curl(p, 'LeftIndexProximal'))).toBeLessThan(1e-9);
    expect(curl(p, 'LeftMiddleProximal')).toBeGreaterThan(1);
  });

  it('«лук — тетива» цепляет указательный/средний, мизинец почти свободен', () => {
    const p = gripToPose(findGrip('bow_draw')!, 'Left');
    expect(curl(p, 'LeftIndexProximal')).toBeGreaterThan(curl(p, 'LeftLittleProximal') * 2);
  });

  it('у большого пальца есть противопоставление (твист вокруг своей оси), у прочих — нет', () => {
    const p = gripToPose(findGrip('fist')!, 'Left');
    expect(Math.abs(dec(p, 'LeftThumbProximal').twist)).toBeGreaterThan(0.1);
    expect(Math.abs(dec(p, 'LeftIndexProximal').twist)).toBeLessThan(1e-4);   // 1e-4 = округление позы до 5 знаков
  });

  it('все встроенные пресеты раскрываются в 15 костей и имеют уникальные id', () => {
    expect(new Set(BUILTIN_GRIPS.map((g) => g.id)).size).toBe(BUILTIN_GRIPS.length);
    for (const g of BUILTIN_GRIPS) expect(Object.keys(gripToPose(g, 'Right')).length, g.id).toBe(15);
  });
});

describe('gripPoses — привязка к оружию', () => {
  it('дефолт угадывается по имени оружия', () => {
    expect(defaultWeaponGrip('bow').R).toBe('bow_grip');
    expect(defaultWeaponGrip('axe').R).toBe('axe');
    expect(defaultWeaponGrip('staff').R).toBe('staff');
    expect(defaultWeaponGrip('sword+shield').R).toBe('sword');
    expect(defaultWeaponGrip('sword+shield').L).toBe('shield');
    expect(defaultWeaponGrip('sword').L).toBe('relaxed');   // пустая офф-рука
  });

  it('resolveGripPose даёт обе кисти без всякой настройки', () => {
    const p = resolveGripPose(EMPTY_GRIP_CONFIG(), 'warrior', 'sword+shield');
    expect(Object.keys(p).length).toBe(30);
    expect(curl(p, 'RightIndexProximal')).toBeGreaterThan(0.5);   // меч в правой
    expect(curl(p, 'LeftIndexProximal')).toBeGreaterThan(0.5);    // щит в левой
  });

  it('привязка персонажа перекрывает дефолт', () => {
    const cfg: GripConfig = EMPTY_GRIP_CONFIG();
    cfg.byWeapon['warrior'] = { axe: { R: 'open', L: 'open' } };
    const p = resolveGripPose(cfg, 'warrior', 'axe');
    for (const k in p) for (const c of p[k]!) expect(Math.abs(c)).toBeLessThan(1e-9);
  });

  it('Ф17: база всегда пересчитывается от ОРУЖИЯ, оверрайд — только точечный', () => {
    // Раньше панель писала в конфиг весь `defaultWeaponGrip` при первом показе — и смена
    // оружия переставала менять хват вообще.
    const cfg: GripConfig = EMPTY_GRIP_CONFIG();
    cfg.byWeapon['w'] = { bow: { closeR: 0.3 } };            // только сжатие, без id
    const e = effectiveWeaponGrip(cfg, 'w', 'bow');
    expect(e.R).toBe('bow_grip');                            // тип взялся от оружия
    expect(e.closeR).toBe(0.3);                              // а сжатие — из оверрайда
    expect(effectiveWeaponGrip(cfg, 'w', 'axe').R).toBe('axe');
    expect(effectiveWeaponGrip(cfg, 'w', 'axe').closeR).toBe(1);
  });

  it('свой хват (готовые углы) берётся вместо встроенного, только кости своей кисти', () => {
    const cfg: GripConfig = EMPTY_GRIP_CONFIG();
    cfg.custom['my'] = { id: 'my', label: 'мой', pose: { LeftIndexProximal: [0, -0.4, 0], RightIndexProximal: [0, 9, 0] } };
    cfg.byWeapon['w'] = { sword: { L: 'my', R: 'open' } };
    const p = resolveGripPose(cfg, 'w', 'sword');
    expect(p['LeftIndexProximal']).toEqual([0, -0.4, 0]);
    for (const c of p['RightIndexProximal']!) expect(c).toBe(0);   // из встроенного 'open', а не 9 из чужой кисти
  });

  it('сжатие из привязки применяется', () => {
    const cfg: GripConfig = EMPTY_GRIP_CONFIG();
    cfg.byWeapon['w'] = { sword: { R: 'fist', closeR: 0.25 } };
    const p = resolveGripPose(cfg, 'w', 'sword');
    const full = gripToPose(findGrip('fist')!, 'Right');
    expect(curl(p, 'RightIndexProximal')).toBeCloseTo(curl(full, 'RightIndexProximal') * 0.25, 5);
  });
});

describe('gripPoses — наложение на скелет', () => {
  it('на гуманоиде С пальцами хват применяется и кончик уходит К ЛАДОНИ', () => {
    const h = buildHumanoid({ fingers: true });
    const tipBefore = h.bones.get('LeftIndexDistal')!.getWorldPosition(new THREE.Vector3());
    applyGripPose(h.bones, gripToPose(findGrip('fist')!, 'Left'));
    h.root.updateMatrixWorld(true);
    const tipAfter = h.bones.get('LeftIndexDistal')!.getWorldPosition(new THREE.Vector3());
    expect(tipAfter.y).toBeLessThan(tipBefore.y - 0.5);            // вниз, к ладони (она смотрит в −Y)
    expect(Math.abs(tipAfter.z - tipBefore.z)).toBeLessThan(1.0);  // а не вбок, как было при сгибе вокруг Y
  });

  it('на гуманоиде БЕЗ пальцев — тихий no-op (игра не платит за хват)', () => {
    const h = buildHumanoid({});
    expect(h.bones.get('LeftIndexProximal')).toBeUndefined();
    expect(() => applyGripPose(h.bones, gripToPose(findGrip('fist')!, 'Left'))).not.toThrow();
  });

  it('хват НЕ трогает кости вне кисти', () => {
    const h = buildHumanoid({ fingers: true });
    h.bones.get('LeftHand')!.rotation.set(0.3, 0.2, 0.1);
    applyGripPose(h.bones, { ...gripToPose(findGrip('fist')!, 'Left'), LeftHand: [9, 9, 9], Spine: [9, 9, 9] });
    expect(h.bones.get('LeftHand')!.rotation.x).toBeCloseTo(0.3, 6);
    expect(h.bones.get('Spine')!.rotation.x).toBeCloseTo(0, 6);
  });

  it('встроенные хваты укладываются В ПРЕДЕЛЫ суставов пальцев (по их собственным осям)', () => {
    // Раньше этот тест мерил |euler.y| против 100° и после смены оси стал бы вечнозелёным нулём.
    // Теперь он раскладывает поворот по осям сустава и сверяет с реальными planeMin/planeMax.
    for (const g of BUILTIN_GRIPS) {
      for (const side of ['Left', 'Right'] as const) {
        const p = gripToPose(g, side);
        for (const k in p) {
          const view = extraLimitView(k)!;
          const d = dec(p, k);
          expect(d.rP, `${g.id}/${k} сгиб`).toBeLessThanOrEqual(view.planeMax! + 1e-6);
          expect(d.rP, `${g.id}/${k} переразгиб`).toBeGreaterThanOrEqual(view.planeMin! - 1e-6);
          expect(Math.abs(d.twist), `${g.id}/${k} твист`).toBeLessThanOrEqual(Math.max(Math.abs(view.twistMin!), Math.abs(view.twistMax!)) + 1e-6);
        }
      }
    }
  });
});

describe('gripPoses — концы слайдера снимаются РУКАМИ (Ф18)', () => {
  /** Поза кисти из 15 фаланг с заданным углом вокруг X (просто что-то узнаваемое). */
  const handPose = (side: 'Left' | 'Right', v: [number, number, number]): Pose => {
    const out: Pose = {}; for (const b of handBones(side)) out[b] = [...v] as [number, number, number]; return out;
  };
  const cfgWith = (openPose: Pose | null, fistPose: Pose | null): GripConfig => {
    const cfg: GripConfig = EMPTY_GRIP_CONFIG();
    const e: Record<string, unknown> = {};
    if (openPose) { cfg.custom['o'] = { id: 'o', label: 'ладонь', pose: openPose }; e['openR'] = 'o'; }
    if (fistPose) { cfg.custom['f'] = { id: 'f', label: 'кулак', pose: fistPose }; e['R'] = 'f'; }
    cfg.byWeapon['w'] = { axe: e };
    return cfg;
  };

  it('ГЛАВНОЕ: на концах слайдера — РОВНО то, что сняли, бит-в-бит', () => {
    // Смысл фичи: никакой процедурной математики ПОВЕРХ снятого — ни вычитания бинда,
    // ни клэмпов. Иначе «выставил глазами и снял» перестаёт быть предсказуемым.
    const openP = handPose('Right', [0.1, 0.2, -0.3]), fistP = handPose('Right', [-0.4, 0.5, 1.1]);
    const cfg = cfgWith(openP, fistP);
    cfg.byWeapon['w']!['axe']!.closeR = 0;
    const at0 = resolveGripPose(cfg, 'w', 'axe');
    cfg.byWeapon['w']!['axe']!.closeR = 1;
    const at1 = resolveGripPose(cfg, 'w', 'axe');
    for (const b of handBones('Right')) {
      for (let i = 0; i < 3; i++) {
        expect(at0[b]![i]!, `0/${b}[${i}]`).toBeCloseTo(openP[b]![i]!, 4);
        expect(at1[b]![i]!, `1/${b}[${i}]`).toBeCloseTo(fistP[b]![i]!, 4);
      }
    }
  });

  it('середина — между двумя снятыми позами, а не в какой-то третьей точке', () => {
    const openP = handPose('Right', [0, 0, 0]), fistP = handPose('Right', [0, 0, 1.0]);
    const cfg = cfgWith(openP, fistP);
    cfg.byWeapon['w']!['axe']!.closeR = 0.5;
    const mid = resolveGripPose(cfg, 'w', 'axe');
    expect(mid['RightIndexProximal']![2]!).toBeCloseTo(0.5, 3);
  });

  it('снят только КУЛАК — открытый конец остаётся выпрямленной кистью', () => {
    const fistP = handPose('Right', [0, 0, 0.9]);
    const cfg = cfgWith(null, fistP);
    cfg.byWeapon['w']!['axe']!.closeR = 0;
    const at0 = resolveGripPose(cfg, 'w', 'axe');
    const straight = straightHandPose('Right');
    for (const b of handBones('Right')) for (let i = 0; i < 3; i++) expect(at0[b]![i]!, b).toBeCloseTo(straight[b]![i]!, 4);
  });

  it('снятая ПРАВАЯ не трогает левую — та остаётся авто-пресетом по оружию', () => {
    const cfg = cfgWith(handPose('Right', [0, 0, 0]), handPose('Right', [0, 0, 1]));
    const p = resolveGripPose(cfg, 'w', 'axe');
    expect(Object.keys(p).length).toBe(30);
    // пустая офф-рука топора → авто-пресет 'relaxed' (Index 0.3 × CURL_MAX 1.45)
    expect(curl(p, 'LeftIndexProximal')).toBeCloseTo(0.3 * 1.45, 2);
  });
});

describe('jointLimits — большой палец уводится В СТОРОНУ (Ф18)', () => {
  it('ГЛАВНОЕ: у большого разгиб ВДВОЕ+ шире, чем у прочих — им ставится раскрытая ладонь', () => {
    // У прочих пальцев отрицательная сторона — крохотный переразгиб, а у большого это
    // ЛУЧЕВОЕ ОТВЕДЕНИЕ. Со старыми −25° клин предела уходил почти весь в сгиб, и FK-клэмп
    // не давал отвести большой в сторону вообще.
    const th = extraLimitView('LeftThumbProximal')!, ix = extraLimitView('LeftIndexProximal')!;
    expect(th.planeMin!).toBeLessThan(-55 * Math.PI / 180);
    expect(th.planeMin!).toBeLessThan(ix.planeMin! * 2);
    expect(Math.abs(th.normalMin!)).toBeGreaterThan(Math.abs(ix.normalMin!) * 2);   // ладонное отведение тоже шире
  });

  it('межфаланговый большого переразгибается заметно, а у прочих — почти нет', () => {
    expect(extraLimitView('LeftThumbIntermediate')!.planeMin!).toBeLessThan(-15 * Math.PI / 180);
    expect(extraLimitView('LeftIndexIntermediate')!.planeMin!).toBeGreaterThan(-10 * Math.PI / 180);
  });

  it('расширение НЕ сломало верхнюю границу: кулак по-прежнему в зоне', () => {
    for (const side of ['Left', 'Right'] as const) {
      const p = gripToPose(findGrip('fist')!, side);
      for (const k in p) {
        const view = extraLimitView(k)!;
        const v = p[k]!;
        _q.setFromEuler(_e.set(v[0], v[1], v[2], 'XYZ'));
        expect(decomposeToLimit(_q, view).rP, k).toBeLessThanOrEqual(view.planeMax! + 1e-6);
      }
    }
  });
});

describe('gripPoses — хват укладывается в пределы НА ЛЮБОМ бинде (Ф17)', () => {
  it('ГЛАВНОЕ: на поджатой кисти и выпрямление, и кулак ОСТАЮТСЯ В ЗОНЕ', () => {
    // До Ф17 числа предела брались КАК ЕСТЬ, то есть отсчитывались от БИНДА модели, а не от
    // прямого пальца — и выпрямление (локальный −over) вылетало за planeMin на первой же модели CC.
    const c = canonicalFingerAxes(); const bent: Record<string, FingerAxes> = {};
    for (const k in c) bent[k] = { ...c[k]!, bindCurl: c[k]!.bindCurl + (k.startsWith('Left') ? 0.23 : 0.53) };
    for (const g of BUILTIN_GRIPS) {
      for (const side of ['Left', 'Right'] as const) {
        for (const close of [0, 0.5, 1]) {
          const p = gripToPose(g, side, close, bent);
          for (const k in p) {
            const view = extraLimitView(k, bent)!;
            const v = p[k]!;
            _q.setFromEuler(_e.set(v[0], v[1], v[2], 'XYZ'));
            const d = decomposeToLimit(_q, view);
            expect(d.rP, `${g.id}/${k}/close=${close} сгиб`).toBeLessThanOrEqual(view.planeMax! + 1e-6);
            expect(d.rP, `${g.id}/${k}/close=${close} переразгиб`).toBeGreaterThanOrEqual(view.planeMin! - 1e-6);
          }
        }
      }
    }
  });

  it('зона едет ЗА биндом, а не стоит на месте', () => {
    const c = canonicalFingerAxes(); const bent: Record<string, FingerAxes> = {};
    for (const k in c) bent[k] = { ...c[k]!, bindCurl: c[k]!.bindCurl + 0.4 };
    const straight = extraLimitView('LeftIndexProximal')!;
    const shifted = extraLimitView('LeftIndexProximal', bent)!;
    expect(shifted.planeMin!).toBeCloseTo(straight.planeMin! - 0.4, 6);
    expect(shifted.planeMax!).toBeCloseTo(straight.planeMax! - 0.4, 6);
    expect(shifted.normalMin!).toBe(straight.normalMin!);   // боковой развод не сдвигается — его не выпрямляют
  });
});

describe('gripPoses — пальцы выпрямляются принудительно (Ф16)', () => {
  /** Кисть с бинд-сгибом: геометрия (оси) каноническая, сдвинут только избыток — тогда
   *  `curl()` можно раскладывать канон-осями и читать его как чистый локальный доворот. */
  const bindBent = (over: number): Record<string, FingerAxes> => {
    const c = canonicalFingerAxes(); const out: Record<string, FingerAxes> = {};
    for (const k in c) out[k] = { ...c[k]!, bindCurl: c[k]!.bindCurl + over };
    return out;
  };

  it('ГЛАВНОЕ: на нуле слайдера палец ВЫПРЯМЛЯЕТСЯ, а не остаётся в бинде', () => {
    // Раньше «открытая» значила «бинд как есть» — и две кисти одной модели с разным биндом
    // на нуле выглядели по-разному. Теперь нуль — это отрицательный доворот на весь избыток.
    const p = gripToPose(findGrip('fist')!, 'Left', 0, bindBent(0.5));
    for (const nm of ['LeftIndexProximal', 'LeftMiddleIntermediate', 'LeftLittleDistal']) {
      expect(curl(p, nm), nm).toBeCloseTo(-0.5, 2);
    }
  });

  it('ЛЕВАЯ И ПРАВАЯ с РАЗНЫМ биндом приходят в ОДИН абсолютный угол на ОБОИХ концах', () => {
    // Ровно то, что замерено на knight_05: MCP указательного 13.2° слева и 21.7° справа.
    const c = canonicalFingerAxes(); const mixed: Record<string, FingerAxes> = {};
    for (const k in c) mixed[k] = { ...c[k]!, bindCurl: c[k]!.bindCurl + (k.startsWith('Left') ? 0.23 : 0.38) };
    for (const close of [0, 0.5, 1]) {
      const p = gripToPoseBoth(findGrip('fist')!, findGrip('fist')!, close, close, mixed);
      // Абсолютный сгиб = бинд-избыток + локальный доворот; у обеих кистей он обязан совпасть.
      const absL = 0.23 + curl(p, 'LeftIndexProximal'), absR = 0.38 + curl(p, 'RightIndexProximal');
      expect(absR, `close=${close}`).toBeCloseTo(absL, 4);
      expect(absL, `close=${close}`).toBeCloseTo(1.45 * close, 4);   // и ровно в угол пресета
    }
  });

  it('на полусогнутой бинд-кисти «кулак» не переизгибает палец', () => {
    const straight = canonicalFingerAxes();
    const pStraight = gripToPose(findGrip('fist')!, 'Left', 1, straight);
    const pBent = gripToPose(findGrip('fist')!, 'Left', 1, bindBent(0.5));
    for (const nm of ['LeftIndexProximal', 'LeftIndexIntermediate', 'LeftIndexDistal']) {
      expect(curl(pBent, nm), nm).toBeCloseTo(curl(pStraight, nm) - 0.5, 2);
    }
  });

  it('кисть, поджатая СИЛЬНЕЕ пресета, РАЗГИБАЕТСЯ до его угла, а не замирает на нуле', () => {
    // Старый клэмп `Math.max(0, …)` оставлял такую кисть пережатой — и снова расходил Л с П.
    const p = gripToPose(findGrip('relaxed')!, 'Left', 1, bindBent(1.2));
    expect(curl(p, 'LeftIndexProximal')).toBeLessThan(0);
    expect(1.2 + curl(p, 'LeftIndexProximal')).toBeCloseTo(1.45 * 0.3, 4);   // relaxed.Index = 0.3
  });

  it('ЗЕРКАЛО кисти учитывает, что Л и П поджаты ПО-РАЗНОМУ', () => {
    // Модель с асимметричным биндом (как knight_05). Голое зеркало углов дало бы кисти с разным
    // АБСОЛЮТНЫМ сгибом — визуально кисти были бы разные, хотя числа «зеркальные».
    const c = canonicalFingerAxes(); const mixed: Record<string, FingerAxes> = {};
    for (const k in c) mixed[k] = { ...c[k]!, bindCurl: c[k]!.bindCurl + (k.startsWith('Left') ? 0.23 : 0.38) };
    const right = gripToPose(findGrip('fist')!, 'Right', 1, mixed);
    const left = mirrorHandPose(right, 'Right', mixed);
    expect(Object.keys(left).length).toBe(15);
    for (const f of ['Index', 'Middle', 'Little'] as const) {
      const nm = f + 'Proximal';
      expect(0.38 + curl(right, 'Right' + nm), nm).toBeCloseTo(0.23 + curl(left, 'Left' + nm), 4);
    }
  });

  it('зеркало на СИММЕТРИЧНОМ бинде — ровно канон-зеркало `[x, −y, −z]`', () => {
    const right = gripToPose(findGrip('sword')!, 'Right');
    const left = mirrorHandPose(right, 'Right');
    const want = mirrorSide(right, 'Right');
    for (const k in left) for (let i = 0; i < 3; i++) expect(left[k]![i]!, `${k}[${i}]`).toBeCloseTo(want[k]![i]!, 5);
  });

  it('straightHandPose на своём риге — чистые нули (выпрямлять нечего)', () => {
    const p = straightHandPose('Left');
    expect(Object.keys(p).length).toBe(15);
    for (const k in p) for (const c of p[k]!) expect(Math.abs(c), k).toBeLessThan(1e-9);
  });

  it('СВОЙ хват (готовые углы) тоже слушается слайдера', () => {
    // Раньше слайдер на своём хвате молча не делал ничего.
    const cfg: GripConfig = EMPTY_GRIP_CONFIG();
    cfg.custom['my'] = { id: 'my', label: 'мой', pose: gripToPose(findGrip('fist')!, 'Right') };
    cfg.byWeapon['w'] = { sword: { R: 'my', closeR: 1 } };
    const full = curl(resolveGripPose(cfg, 'w', 'sword'), 'RightIndexProximal');
    cfg.byWeapon['w']!['sword']!.closeR = 0;
    const none = curl(resolveGripPose(cfg, 'w', 'sword'), 'RightIndexProximal');
    cfg.byWeapon['w']!['sword']!.closeR = 0.5;
    const half = curl(resolveGripPose(cfg, 'w', 'sword'), 'RightIndexProximal');
    expect(full).toBeGreaterThan(1);
    expect(Math.abs(none)).toBeLessThan(1e-4);        // на своём риге выпрямленная кисть = нули
    expect(half).toBeGreaterThan(full * 0.4);
    expect(half).toBeLessThan(full * 0.6);
  });
});

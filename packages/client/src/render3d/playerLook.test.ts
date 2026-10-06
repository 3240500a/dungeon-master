import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildHumanoid } from './humanoid.js';
import { resolvePlayerLook, type ClassLook } from './modelSkin.js';

/**
 * ВНЕШНОСТЬ КУКЛЫ — ОДИН ШОВ НА ИГРУ И НА ВКЛАДКУ «ТЕСТ».
 *
 * Жалоба, из которой это выросло: во вкладке «Тест» ноги «покоробило», и модель выглядела не так, как в
 * веб-клиенте. Причина оказалась не в позе и не в настройках: кукла там собиралась ЧЕТЫРЬМЯ аргументами,
 * а в игре — девятью. Пропущенные `boneOffsets`/`boneScale`/`profile`/`baseAppearance` — не «чуть другие
 * пропорции»: кости встают по встроенным числам, а меш остаётся модельным.
 *
 * ⚠ Урок шире этого бага: ОДНОЙ общей функции построения МАЛО, если её зовут с разными входами. Вкладка
 * честно звала ту же `makeGamePlayerDoll`, что игра, — и всё равно расходилась. Входы это такая же часть
 * шва, как код, поэтому ниже стоит сторож и на них.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const src = (f: string): string => readFileSync(join(HERE, f), 'utf8');

/** Офсеты «как из ФБХ»: голени и стопы разведены в стороны — это и есть splay бинда. */
const SPLAYED = (): Record<string, [number, number, number]> => ({
  LeftLowerLeg: [1.8, -14, 0.3], RightLowerLeg: [-1.8, -14, 0.3],
  LeftFoot: [0.9, -13, 0.5], RightFoot: [-0.9, -13, 0.5],
});

const atlasCfg = (classId: string) => ({
  models: [{
    id: 'm1', kind: 'character', url: '/a.glb', classId,
    body: { height: 1.07, leg: 1.03 },
    boneScale: { LeftUpperLeg: 1.04 },
    boneOffsets: SPLAYED(),
  }],
  materials: [], textures: [],
// eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any);

const CLASSES: ClassLook[] = [
  { id: 'warrior', baseAppearance: { hair: 'hair_01', body: 'armor_01' } },
  { id: 'mage', baseAppearance: { hair: 'hair_09' } },
];

describe('resolvePlayerLook — разбор один, источники разные', () => {
  it('отдаёт ВСЕ ЧЕТЫРЕ входа куклы, а не часть', () => {
    const look = resolvePlayerLook(atlasCfg('warrior'), CLASSES, 'warrior');
    expect(Object.keys(look).sort()).toEqual(['baseAppearance', 'boneOffsets', 'boneScale', 'profile']);
    expect(look.boneOffsets).toBeTruthy();
    expect(look.boneScale).toBeTruthy();
    expect(look.profile).toBeTruthy();
    expect(look.baseAppearance).toEqual({ hair: 'hair_01', body: 'armor_01' });
  });

  it('атлас берётся ПО КЛАССУ: у каждого свой, чужой не подставляется', () => {
    const cfg = atlasCfg('warrior');
    // Есть атлас воина и нет атласа мага → магу достаётся фолбэк (одиночный атлас работает как раньше),
    // но базовый вид всё равно ЕГО собственный, а не воинский.
    expect(resolvePlayerLook(cfg, CLASSES, 'mage').baseAppearance).toEqual({ hair: 'hair_09' });
  });

  it('класса нет в конфиге — базового вида нет, но геометрия всё равно приходит', () => {
    const look = resolvePlayerLook(atlasCfg('warrior'), CLASSES, 'ghost');
    expect(look.baseAppearance).toBeUndefined();
    expect(look.boneOffsets, 'фолбэк-атлас не должен пропадать вместе с классом').toBeTruthy();
  });
});

describe('чем именно «коробило ноги» — замер, а не описание', () => {
  it('⭐⭐ С развалом бинда в офсетах ноги рига ВСЁ РАВНО прямые — канон ног, длины модели (07.10, `canonLegOffsets`)', () => {
    // Раньше риг повторял развал бинда, и его добирал `applyLegAdduct` — только боковой и почти выключенный в «только клипы».
    // Теперь «ноль поворотов» = прямые ноги и у рига, и у меша (рест модели правится той же поправкой — `legRest.ts`).
    const h = buildHumanoid({ boneOffsets: SPLAYED() });
    h.root.updateMatrixWorld(true);
    const p = (n: string): THREE.Vector3 => h.bones.get(n)!.getWorldPosition(new THREE.Vector3());
    for (const [a, b] of [['LeftUpperLeg', 'LeftLowerLeg'], ['LeftLowerLeg', 'LeftFoot']] as const) {
      const dir = p(b).sub(p(a)).normalize();
      expect(dir.y, `${a}→${b} вертикально`).toBeLessThan(-0.99999);
    }
    expect(p('LeftLowerLeg').distanceTo(p('LeftUpperLeg')), 'длина бедра — модели').toBeCloseTo(Math.hypot(1.8, 14, 0.3), 9);
  });

  it('скелет без офсетов и с офсетами — РАЗНАЯ геометрия, расхождение видно числом', () => {
    const foot = (h: ReturnType<typeof buildHumanoid>): THREE.Vector3 => {
      h.root.updateMatrixWorld(true);
      return h.bones.get('LeftFoot')!.getWorldPosition(new THREE.Vector3());
    };
    const gap = foot(buildHumanoid({})).distanceTo(foot(buildHumanoid({ boneOffsets: SPLAYED() })));
    // Порог намеренно грубый: важно не точное число, а что расхождение НЕ микроскопическое —
    // то есть меш действительно тянется скином в другое место.
    expect(gap).toBeGreaterThan(1);
  });
});

describe('сторож: оба хоста строят куклу ОДНИМ разбором', () => {
  const GAME = 'online3d.ts', TEST = 'testTab.ts';

  for (const f of [GAME, TEST]) {
    it(`${f} зовёт resolvePlayerLook`, () => {
      expect(src(f)).toContain('resolvePlayerLook');
    });

    it(`${f} не собирает внешность руками в вызове куклы`, () => {
      // Ключи внешности не должны появляться у `makeGamePlayerDoll` россыпью: как только их пишут
      // по одному, второй хост неминуемо отстаёт — с этого и начался баг.
      const call = src(f).match(/makeGamePlayerDoll\(pw,\s*\{[^}]*\}/g) ?? [];
      expect(call.length, 'вызов куклы должен находиться').toBeGreaterThan(0);
      for (const c of call) {
        for (const k of ['profile:', 'boneScale:', 'boneOffsets:', 'baseAppearance:']) {
          expect(c, `${k} обязан приходить спредом из resolvePlayerLook`).not.toContain(k);
        }
        // ⚠ Мало проверить, что внешность НЕ пишут руками: её можно просто не передать вовсе — именно так
        // вкладка и жила. Поэтому требуем СПРЕД в самом вызове, а не упоминание функции где-то в файле.
        expect(c, 'внешность обязана доезжать до куклы спредом').toMatch(/\.\.\.\s*(look|playerLook\()/);
      }
    });
  }
});

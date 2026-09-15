import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { groundFeet } from './footIk.js';
import { buildHumanoid } from './humanoid.js';

/**
 * ⭐ ПРИСТАВНОЙ ШАГ СТОЯ ИДЁТ «ИЗ IDLE-ПОЗЫ В IDLE-ПОЗУ».
 *
 * Жалоба: «когда перешаги делает и крутится — ноги распрямляет и таз поднимает, а потом в idle
 * приседает; надо, чтобы он всегда старался idle-позу держать: повернул на 40° — из idle сразу
 * в idle, а не в какую-то промежуточную».
 *
 * ПРИЧИНА: высоту таза в заземлении задаёт ХУДШАЯ опорная стопа (`worst`). Пока обе на полу, это
 * стабильно; как только одна уходит в перенос, остаётся другая — и таз ВСПЛЫВАЕТ (ту ногу, что
 * тянула вниз, унесли), а на постановке приседает обратно. Планировщик тут ни при чём: его
 * `bobY` за весь разворот на 40° не шелохнулся (замер: ровно 33.353 на всех кадрах).
 *
 * ⚠ ЛЕЧИМ ТОЛЬКО ВЫСОТУ ТАЗА. Стопы планируются и кладутся как обычно — это другой блок
 * `groundFeet`: держим ПОЗУ, а не отключаем заземление.
 */
describe('приставной шаг стоя держит idle-позу', () => {
  const mk = (): THREE.Object3D => {
    const h = buildHumanoid({ style: 'skeleton' });
    h.reset(); h.root.updateMatrixWorld(true);
    return h.root;
  };
  /** Прогон заземления: N кадров с заданной опорой; вернуть мировую высоту таза. */
  const run = (support: [boolean, boolean], still: boolean, frames: number, gs: { off: number }): number => {
    const h = buildHumanoid({ style: 'skeleton' });
    h.reset(); h.root.updateMatrixWorld(true);
    const base = h.bones.get('Hips')!.getWorldPosition(new THREE.Vector3()).y;
    for (let i = 0; i < frames; i++) {
      groundFeet(h, base, gs, 1 / 60, () => 0, support, { w: [support[0] ? 1 : 0, support[1] ? 1 : 0], lag: 12, still });
    }
    return h.bones.get('Hips')!.getWorldPosition(new THREE.Vector3()).y;
  };

  it('⭐ СТОЯ на ОДНОЙ опоре таз не переезжает (шаг не меняет позу)', () => {
    const gs = { off: 0 };
    const both = run([true, true], true, 90, gs);          // устоялись на двух ногах
    const offAfterBoth = gs.off;
    const one = run([true, false], true, 90, gs);          // одна нога ушла в перенос
    // ⚠ Мутация «убрать hold» валит именно это: на одной опоре таз всплывёт.
    expect(gs.off, '⚠ ТАЗ ПОЕХАЛ на приставном шаге — поза уже не idle').toBeCloseTo(offAfterBoth, 9);
    expect(one, '⚠ высота таза изменилась на одной опоре').toBeCloseTo(both, 6);
  });

  it('на ДВУХ опорах стоя таз по-прежнему считается (заземление не выключено)', () => {
    const gs = { off: 0 };
    const y0 = run([true, true], true, 1, gs);
    const y1 = run([true, true], true, 120, gs);
    expect(Math.abs(y1 - y0) + Math.abs(gs.off), '⚠ стоя заземление вообще перестало двигать таз').toBeGreaterThan(0);
  });

  it('⭐ СТОЯ таз ВОЗВРАЩАЕТСЯ к авторской посадке, а не остаётся где осел', () => {
    // ⚠ `gs.off` — накопитель БЕЗ притяжения: когда стопы достали до пола, равновесна любая высота.
    // ЗАМЕР на живом воине: шесть разворотов подряд 33.334 → 33.152 при стопах ровно на полу.
    const gs = { off: -1.5 };                              // как будто таз уже осел
    run([true, true], true, 240, gs);
    expect(Math.abs(gs.off), '⚠ ТАЗ ТАК И ОСТАЛСЯ ОСЕВШИМ — idle-посадка не возвращается').toBeLessThan(0.05);
  });

  it('⚠ на ходу возврата НЕТ — там сдвиг и есть боб (ход не трогаем)', () => {
    const gs = { off: -1.5 };
    run([true, true], false, 240, gs);
    expect(Math.abs(gs.off), '⚠ ходовую ветку тоже потянуло к нулю').toBeGreaterThan(0.05);
  });

  it('НА ХОДУ (`still` не задан) поведение прежнее: одна опора таз двигает', () => {
    const gs = { off: 0 };
    run([true, true], false, 90, gs);
    const before = gs.off;
    run([true, false], false, 90, gs);
    expect(gs.off, '⚠ ходовая ветка тоже замерла — приставной шаг подменил обычный ход').not.toBeCloseTo(before, 9);
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { resetGaitScope, type GaitSpeedKey } from './poseRuntime.js';

/**
 * ⭐⭐ СБРОС НАСТРОЕК БЕГА — ТОЛЬКО ВЫБРАННЫЙ РЕЖИМ И ТОЛЬКО ВЫБРАННАЯ СКОРОСТЬ (просьба автора 20.09).
 *
 * Было: пять кнопок «сброс страйфа / страйфа Л / страйфа П / назад / бой» уносили СВОЮ КОЛОНКУ ЦЕЛИКОМ
 * (обе скорости разом, что бы ни было выбрано), а «сброс настроек бега» сносил у персонажа вообще всё.
 * Стало: одна кнопка, область которой написана прямо на ней — «сбросить: СТРАЙФ Л · бег».
 *
 * ⚠ МУТАЦИИ, каждая валит СВОЙ случай (проверено правкой исходника и откатом):
 *   M1. `poseRuntime.ts`: `const key = kw;` (скорость не смотрится) → «чистится ключ ВЫБРАННОЙ скорости».
 *   M2. `poseRuntime.ts`: в ветке колонки `o.column[key] = 0` вместо `delete` → «ключ УДАЛЯЕТСЯ, а не пишется».
 *   M3. `pose-editor.ts`: `column: colMapOf(gaitDir)` без тернарника → «ВПЕРЁД» писал бы в колонку страйфа.
 *   M4. `poseRuntime.ts`: `const pair = key;` (суффикс колонки потерян) → «пара Л/П чистится СВОЯ».
 *   M5. `pose-editor.ts`: в подписи кнопки убрана скорость → «подпись называет область».
 *   M6. `pose-editor.ts`: `row2` не кладёт ключи в `speedKeys` → «область берётся из самих ручек».
 */

const SRC_ED = readFileSync(path.join(__dirname, 'pose-editor.ts'), 'utf8');

/** Пробный набор: две ручки с парой скоростей и одна без run-твина. */
const probe = (): { gait: Record<string, number>; pose: Record<string, number>; keys: GaitSpeedKey[] } => {
  const gait = { stepWalk: 11, stepRun: 22, liftWalk: 3, liftRun: 4, cadence: 9 };
  const pose = { armSh: 1, armShRun: 2 };
  const keys: GaitSpeedKey[] = [
    { obj: gait, kw: 'stepWalk', kr: 'stepRun' },
    { obj: gait, kw: 'liftWalk', kr: 'liftRun' },
    { obj: gait, kw: 'cadence', kr: null },      // ручка одна на обе скорости
    { obj: pose, kw: 'armSh', kr: 'armShRun' },
  ];
  return { gait, pose, keys };
};
const DEFAULTS: Record<string, number> = { stepWalk: 100, stepRun: 200, liftWalk: 30, liftRun: 40, cadence: 90, armSh: 0.5 };
const defOf = (): Record<string, number> => DEFAULTS;

describe('сброс по выбору: колонка', () => {
  it('⭐⭐ ЧИСТИТСЯ РОВНО КЛЮЧ ВЫБРАННОЙ СКОРОСТИ, и только в выбранной колонке (мутации M1, M3)', () => {
    const { keys } = probe();
    // Колонки заполнены ВСЕ и на ОБЕИХ скоростях — так видно любую протечку.
    const strafeR = { stepWalk: 1, stepRun: 2, liftWalk: 3, liftRun: 4, cadence: 5, armSh: 6, armShRun: 7 };
    const strafeL = { ...strafeR }, strafe = { ...strafeR }, back = { ...strafeR }, combat = { ...strafeR };
    const asym: Record<string, [number, number]> = {};
    const n = resetGaitScope(keys, { run: true, column: strafeR, sfx: '@sr', asym, defOf });
    // Бег трогает: stepRun, liftRun, armShRun и ручку без твина (cadence). Ходьбовые ключи — на месте.
    expect(Object.keys(strafeR).sort()).toEqual(['armSh', 'liftWalk', 'stepWalk']);
    expect(n).toBe(4);
    for (const [nm, m] of [['strafeL', strafeL], ['strafe', strafe], ['back', back], ['combat', combat]] as const) {
      expect(Object.keys(m).length, `чужая колонка ${nm} не тронута`).toBe(7);
    }
  });

  it('⭐⭐ КЛЮЧ УДАЛЯЕТСЯ, А НЕ ПИШЕТСЯ ДЕФОЛТОМ — иначе колонка перестаёт откатываться (мутация M2)', () => {
    const { keys } = probe();
    const col: Record<string, number> = { stepRun: 2 };
    resetGaitScope(keys, { run: true, column: col, sfx: '@sr', asym: {}, defOf });
    expect('stepRun' in col, 'ключа НЕТ, а не «ключ = дефолт»').toBe(false);
    expect(col['stepRun']).toBeUndefined();
  });

  it('⭐ ПАРА Л/П ЧИСТИТСЯ СВОЯ: колонка — по своему суффиксу, база — без суффикса (мутация M4)', () => {
    const { keys } = probe();
    const asym: Record<string, [number, number]> = {
      'stepRun': [1, 2], 'stepRun@s': [1, 2], 'stepRun@sr': [1, 2], 'stepRun@sl': [1, 2], 'stepRun@b': [1, 2],
    };
    resetGaitScope(keys, { run: true, column: {}, sfx: '@sr', asym, defOf });
    expect(Object.keys(asym).sort()).toEqual(['stepRun', 'stepRun@b', 'stepRun@s', 'stepRun@sl']);
  });

  it('ходьба чистит ходьбовые ключи, а беговые оставляет', () => {
    const { keys } = probe();
    const col = { stepWalk: 1, stepRun: 2, liftWalk: 3, liftRun: 4, cadence: 5 };
    resetGaitScope(keys, { run: false, column: col, sfx: '@s', asym: {}, defOf });
    expect(Object.keys(col).sort()).toEqual(['liftRun', 'stepRun']);
  });
});

describe('сброс по выбору: база («ВПЕРЁД»)', () => {
  it('⭐⭐ ВОЗВРАЩАЕТ ДЕФОЛТ ТОЛЬКО ВЫБРАННОЙ СКОРОСТИ И НЕ ТРОГАЕТ КОЛОНКИ (мутации M1, M3)', () => {
    const { gait, pose, keys } = probe();
    const col = { stepWalk: 1, stepRun: 2 };
    resetGaitScope(keys, { run: true, column: null, sfx: '', asym: {}, defOf });
    expect(gait['stepRun'], 'бег → дефолт').toBe(200);
    expect(gait['stepWalk'], 'ходьба не тронута').toBe(11);
    expect(gait['liftRun']).toBe(40);
    expect(gait['liftWalk']).toBe(3);
    expect(gait['cadence'], 'ручка без твина живёт на обеих скоростях').toBe(90);
    expect(pose['armShRun']).toBe(0.5);      // своего дефолта у твина нет → дефолт ходьбы, как сажает панель
    expect(pose['armSh'], 'ходьбовый ключ на месте').toBe(1);
    expect(col, 'колонки база не трогает').toEqual({ stepWalk: 1, stepRun: 2 });
  });

  it('ключ, у которого дефолта нет вовсе, остаётся как был (а не превращается в undefined)', () => {
    const obj: Record<string, number> = { mystery: 7 };
    const n = resetGaitScope([{ obj, kw: 'mystery', kr: null }], { run: false, column: null, sfx: '', asym: {}, defOf: () => ({}) });
    expect(obj['mystery']).toBe(7);
    expect(n).toBe(0);
  });
});

describe('⭐⭐ РЕДАКТОР: проводка кнопки сброса', () => {
  it('область берётся ИЗ САМИХ РУЧЕК — `row2` кладёт свою пару в `speedKeys` (мутация M6)', () => {
    expect(SRC_ED).toMatch(/const speedKeys: \{ obj: NumRec; kw: string; kr: string \| null \}\[\] = \[\];/);
    expect(SRC_ED).toMatch(/speedKeys\.push\(\{ obj, kw, kr \}\);/);
    // Ручки БЕЗ пары скоростей (`one1`) в список не попадают — у них нет половины на эту скорость.
    const i = SRC_ED.indexOf('const one1 = (label: string');
    expect(i).toBeGreaterThan(0);
    expect(SRC_ED.slice(i, SRC_ED.indexOf('\n  };', i))).not.toMatch(/speedKeys\.push/);
  });

  it('кнопка зовёт общий шов и пишет тем же сохранением, что ползунок', () => {
    const i = SRC_ED.indexOf('const resetScope = (): void => {');
    expect(i).toBeGreaterThan(0);
    const body = SRC_ED.slice(i, SRC_ED.indexOf('\n  };', i));
    expect(body).toMatch(/rtResetGaitScope\(speedKeys, \{/);
    expect(body).toMatch(/run: gaitSpeed === 'run',/);
    expect(body).toMatch(/column: onCol \? colMapOf\(gaitDir\) : null,/);
    expect(body).toMatch(/sfx: onCol \? colSfxOf\(gaitDir\) : '',/);
    expect(body).toMatch(/saveGaitCfg\(\); renderLoco\(\);/);
  });

  it('⭐ ПОДПИСЬ НАЗЫВАЕТ ОБЛАСТЬ — режим И скорость, до нажатия (мутация M5)', () => {
    expect(SRC_ED).toMatch(/pbtn\(`сбросить: \$\{scopeName\(\)\} · \$\{gaitSpeed === 'run' \? 'бег' : 'ходьба'\}`, resetScope\)/);
    expect(SRC_ED).toMatch(/const scopeName = \(\): string => \(gaitDir === 'cbt' \? 'БОЙ' : gaitDir === 'back' \? 'НАЗАД'/);
    expect(SRC_ED).toMatch(/: gaitDir === 'fwd' \? 'ВПЕРЁД \(база\)'/);
    expect(SRC_ED).toMatch(/gaitStrSide === 'L' \? 'СТРАЙФ Л' : gaitStrSide === 'R' \? 'СТРАЙФ П' : 'СТРАЙФ'\)/);
  });

  it('⚠ «СБРОС АСИММЕТРИИ» ОСТАЛСЯ ОТДЕЛЬНОЙ КНОПКОЙ (решение автора), а «снести всё» названо вслух', () => {
    expect(SRC_ED).toMatch(/сброс асимметрии \(\$\{asymN\}\)/);
    expect(SRC_ED).toMatch(/снести ВСЕ настройки бега персонажа \(все режимы и обе скорости\)/);
    // Прежних пяти поколоночных кнопок (обе скорости разом) больше нет.
    expect(SRC_ED).not.toMatch(/colReset\(/);
  });
});

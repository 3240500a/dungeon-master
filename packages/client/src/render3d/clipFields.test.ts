import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { migrateClip, type Clip, type Pose } from './clipModel.js';

/**
 * ⚠⚠ КАЖДОЕ ПОЛЕ КЛИПА ОБЯЗАНО ПЕРЕЖИТЬ ЧТЕНИЕ И КОПИРОВАНИЕ.
 *
 * `migrateClip` пересобирает клип ПО ЯВНОМУ СПИСКУ полей. Про эту граблю в самом файле написано
 * предупреждение — и я на неё всё равно наступил: завёл 19.09 `upperPure` и `swingRef` и не дописал их сюда.
 *
 * Разрушение отложенное, и потому незаметное: игра читает `pe_clips` спредом и оба поля видит, а редактор
 * читает через `migrateClip`. То есть свежезапечённый набор жил правильно ровно до перезагрузки страницы
 * редактора — после неё панель покрытия объявляла только что снятые клипы `dirty_upper`+`no_ref`, а первый
 * же `saveLib()` писал ОБРЕЗАННУЮ копию обратно в localStorage, и тогда поля терял и рантайм.
 *
 * Поэтому сторож не перечисляет поля руками, а ЧИТАЕТ ИХ ИЗ ИНТЕРФЕЙСА. Новое поле, не описанное здесь,
 * валит тест с прямой инструкцией — список не может отстать от типа.
 */
const SRC = (f: string): string => readFileSync(path.join(__dirname, f), 'utf8');

/** Имена полей `interface Clip` — из исходника, а не из головы. */
const clipFields = (): string[] => {
  const src = SRC('clipModel.ts');
  const i = src.indexOf('export interface Clip {');
  expect(i, '⚠ разбор `interface Clip` сломался').toBeGreaterThan(0);
  const body = src.slice(i + 'export interface Clip {'.length, src.indexOf('\n}', i));
  const clean = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');   // без комментариев
  const out: string[] = [];
  for (const m of clean.matchAll(/(?:^|[;{\n])\s*([A-Za-z_][A-Za-z0-9_]*)\s*\??\s*:/g)) out.push(m[1]!);
  return [...new Set(out)];
};

/**
 * Значение-образец на каждое поле. Оно НАРОЧНО отличается от умолчания (`false`/`undefined`/пусто),
 * иначе «поле выжило» не отличить от «поле потерялось и совпало с дефолтом».
 */
const SAMPLE: Record<string, unknown> = {
  name: 'run_fwd', character: 'warrior', weapon: 'none', loop: true,
  keys: [{ t: 0, pose: { Hips: [0.1, 0.2, 0.3] } as Pose }, { t: 0.5, pose: { Hips: [0.4, 0.5, 0.6] } as Pose }],
  idleEnds: true, idleEndsFrom: 'combat',
  rootYaw: true, rootPos: true,
  bakeSpeed: 120, bakeRev: 3, bakeId: 1758300000000,
  bakeSrc: 'mocap',            // ⭐ источник клипа: захват против нашего запекателя — от него зависит вердикт аудита
  upperPure: true,
  swingRef: { RightUpperArm: [0.11, 0.22, 0.33], LeftUpperArm: [-0.11, -0.22, -0.33] } as Pose,
  hipsYawDeg: -12.5, hipsYawW: [0.5, 0.3, 0.2],
};

describe('поля клипа не теряются', () => {
  it('⚠⚠ СПИСОК ОБРАЗЦОВ НЕ ОТСТАЁТ ОТ ТИПА', () => {
    const missing = clipFields().filter((f) => !(f in SAMPLE));
    expect(missing,
      '⚠ в `interface Clip` появилось поле, которого нет в этом тесте. Допиши образец СЮДА и само поле — ' +
      'в `migrateClip` (clipModel.ts) и проверь `cloneClipTo` (pose-editor.ts). Иначе оно потеряется молча.',
    ).toEqual([]);
  });

  it('⚠⚠ КАЖДОЕ ПОЛЕ ПЕРЕЖИВАЕТ `migrateClip` (чтение библиотеки редактором)', () => {
    const fields = clipFields();
    const src = Object.fromEntries(fields.map((f) => [f, SAMPLE[f]])) as unknown as Clip;
    const back = migrateClip(JSON.parse(JSON.stringify(src)));
    const lost = fields.filter((f) => JSON.stringify((back as unknown as Record<string, unknown>)[f]) !== JSON.stringify(SAMPLE[f]));
    expect(lost, '⚠ поля потерялись при чтении — допиши их в `migrateClip`').toEqual([]);
  });

  it('⭐ `upperPure` и `swingRef` — именно та пара, на которой это уже ломалось', () => {
    const back = migrateClip({ name: 'run_fwd', character: 'warrior', weapon: 'none', loop: true, keys: [],
      upperPure: true, swingRef: { RightUpperArm: [0.11, 0.22, 0.33] } });
    expect(back.upperPure, '⚠ чистый верх потерялся → панель покрытия объявит свежий набор протухшим').toBe(true);
    expect(back.swingRef?.['RightUpperArm'], '⚠ нейтраль маха потерялась → рантайм считает её лениво каждый раз').toEqual([0.11, 0.22, 0.33]);
  });

  it('мусор вместо нейтрали маха отбрасывается, а не роняет чтение', () => {
    expect(migrateClip({ name: 'x', character: 'a', weapon: 'none', loop: false, keys: [], swingRef: 7 }).swingRef).toBeUndefined();
    expect(migrateClip({ name: 'x', character: 'a', weapon: 'none', loop: false, keys: [], upperPure: 'да' }).upperPure).toBeUndefined();
  });

  it('⭐ нейтраль маха — КОПИЯ, а не ссылка на исходный объект', () => {
    const src = { name: 'x', character: 'a', weapon: 'none', loop: false, keys: [], swingRef: { Hips: [1, 2, 3] } };
    const back = migrateClip(src);
    back.swingRef!['Hips'] = [9, 9, 9];
    expect(src.swingRef['Hips'], '⚠ правка прочитанного клипа задела исходный JSON').toEqual([1, 2, 3]);
  });

  it('⚠⚠ `cloneClipTo` КОПИРУЕТ СПРЕДОМ (перечисление полей уже теряло метаданные съёма)', () => {
    // Редакторский `cloneClipTo` живёт в DOM-модуле и в node не импортируется — проверяем по исходнику.
    const src = SRC('pose-editor.ts');
    const i = src.indexOf('const cloneClipTo = ');
    expect(i, '⚠ `cloneClipTo` не найден').toBeGreaterThan(0);
    const fn = src.slice(i, i + 700);
    expect(fn.includes('...c,'),
      '⚠ копия клипа снова перечисляет поля руками: приёмник потеряет bakeSpeed (цикл ±20 %), bakeRev ' +
      '(выключатся сектора доворота), upperPure, swingRef и hipsYawW').toBe(true);
    expect(fn.includes('marks'), '⚠ разметка ключа (шаги, удары) обязана ехать вместе с ключом').toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { RUNTIME_GAIT_KEYS, BOTH_GAIT_KEYS } from './gaitKnobs.js';

/**
 * ⭐⭐ ПАНЕЛЬ ОБЯЗАНА ГОВОРИТЬ ПРАВДУ, КОГДА ПРАВКА ДОЕЗЖАЕТ ДО ИГРЫ.
 *
 * Шапка вкладки «Бег» утверждает: «правка ручек походки доезжает до игры только через перезапекание».
 * ЗАМЕР по исходникам: из 89 ручек это верно для 74, а **12 правят ЖИВОЙ кадр игры** — то есть тезис
 * врал для каждой седьмой. Автор крутит такую ручку, видит перемену сразу и делает неверный вывод
 * о том, как устроена система.
 *
 * ⚠⚠ ПОЧЕМУ ПОМЕТКА, А НЕ ПЕРЕЕЗД В ДРУГОЕ ХРАНИЛИЩЕ (как требовал план). Замер показал четыре
 * регрессии, см. шапку `RUNTIME_GAIT_KEYS`. Главная: все стенды доворота мутируют ГЛОБАЛЬНЫЙ `GAIT`,
 * и после переезда конфига в контент они ПРОЙДУТ МОЛЧА, не проверяя ничего.
 *
 * Сторож ПЕРЕСЧИТЫВАЕТ разделение по исходникам: список не может отстать от кода молча.
 */
const DIR = __dirname;
const SRC = (f: string): string => readFileSync(path.join(DIR, f), 'utf8');
const code = (f: string): string => SRC(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');

/** Ключи, которые панель «Бег» вообще показывает. */
const gaitKeys = (): string[] => {
  const m = /const GAIT_KEYS[^=]*=\s*\[([\s\S]*?)\]/.exec(SRC('pose-editor.ts'));
  expect(m, '⚠ разбор GAIT_KEYS сломался').toBeTruthy();
  return [...new Set([...m![1]!.matchAll(/'([A-Za-z0-9_]+)'/g)].map((x) => x[1]!))];
};
/** Читает ли этот текст такую ручку. */
const reads = (t: string, k: string): boolean =>
  new RegExp(`GAIT\\.${k}\\b`).test(t) || new RegExp(`'${k}'`).test(t);

describe('рантаймовые ручки походки', () => {
  it('⭐⭐ СПИСОК `RUNTIME_GAIT_KEYS` СОВПАДАЕТ С ТЕМ, ЧТО РЕАЛЬНО ЧИТАЕТ ЖИВОЙ КАДР', () => {
    // Живой кадр игры = рантайм позы + кукла (она читает `GAIT.gndLag` на рендере призрака).
    const live = code('poseRuntime.ts') + code('gamePlayerDoll.ts');
    const shown = gaitKeys();
    const actual = shown.filter((k) => reads(live, k)).sort();
    expect(actual, '⚠ состав рантаймовых ручек изменился. Это НЕ мелочь: такая ручка действует в игре ' +
      'СРАЗУ, а в запечённом клипе — только после перезапекания, и две картинки разойдутся. Обнови ' +
      '`RUNTIME_GAIT_KEYS` в `gaitKnobs.ts` — панель берёт пометку оттуда.')
      .toEqual([...RUNTIME_GAIT_KEYS].sort());
  });

  it('⭐ «ЧИТАЮТ ОБА» — ПОДМНОЖЕСТВО РАНТАЙМОВЫХ, и планировщик их действительно читает', () => {
    const plan = code('stepPlanner.ts');
    for (const k of BOTH_GAIT_KEYS) {
      expect(RUNTIME_GAIT_KEYS.includes(k), `${k} обязан быть и в рантаймовых`).toBe(true);
      expect(reads(plan, k), `⚠ ${k} помечен «читают оба», но планировщик его не читает`).toBe(true);
    }
    // …а чисто рантаймовые планировщик НЕ читает — иначе пометка ⚡ врёт про «перезапекания не требует».
    for (const k of RUNTIME_GAIT_KEYS.filter((x) => !BOTH_GAIT_KEYS.includes(x))) {
      expect(reads(plan, k), `⚠ ${k} помечен чисто рантаймовым, а планировщик его читает`).toBe(false);
    }
  });

  it('⭐⭐ ПАНЕЛЬ СТАВИТ ПОМЕТКУ ИЗ СПИСКА, А НЕ РУКАМИ', () => {
    const ed = SRC('pose-editor.ts');
    expect(ed.includes('RUNTIME_GAIT_KEYS.includes(key)'), 'пометка выводится из списка').toBe(true);
    expect(ed.includes('const rm = rtMark(key); if (rm) nm.append(rm);'), 'и реально вешается на строку').toBe(true);
  });

  /**
   * ⚠ ЭТО ИСПРАВЛЕНИЕ МОЕЙ ЖЕ ОШИБКИ, СДЕЛАННОЙ ЧАСОМ РАНЬШЕ. В Э14 я подписал `gndLag` как
   * «только редактор» вместе с `gndIn`/`gndOut`/`footPlant`. Но они разные: те три идут через
   * `groundWeights`/`plantWeights` (в игре жёстко [1,1]), а `gndLag` передаётся В ИГРЕ напрямую в
   * `renderRagdollGhost` — то есть действует. Замер списком и поймал расхождение.
   */
  it('⚠ `gndLag` ДЕЙСТВУЕТ В ИГРЕ, а `gndIn`/`gndOut`/`footPlant` — нет', () => {
    expect(RUNTIME_GAIT_KEYS.includes('gndLag'), 'gndLag рантаймовый').toBe(true);
    expect(SRC('gamePlayerDoll.ts').includes('lag: GAIT.gndLag'), 'и это видно в кукле игры').toBe(true);
    for (const k of ['gndIn', 'gndOut', 'footPlant']) {
      expect(RUNTIME_GAIT_KEYS.includes(k), `${k} в игре не действует`).toBe(false);
    }
    const ed = SRC('pose-editor.ts');
    const i = ed.indexOf("'gndLag'");
    const line = ed.slice(ed.lastIndexOf('\n', i) + 1, ed.indexOf('\n', i));
    expect(line.includes('только редактор'), '⚠ ошибочная подпись «только редактор» вернулась на gndLag').toBe(false);
  });

  it('⭐ ЧЕТЫРЕ РУЧКИ ДОВОРОТА ОСТАЛИСЬ В `pe_gait` — и это ЗАМЕРЕННОЕ решение, а не забывчивость', () => {
    // Перенос в `pe_anim` убил бы живую правку (GAIT — модульный синглтон, pe_anim читается один раз
    // при сборке куклы), сломал бы сброс при смене персонажа и обесточил бы ~10 стендов доворота.
    for (const k of ['warpOn', 'warpMax', 'warpSmooth', 'warpRate']) {
      expect(RUNTIME_GAIT_KEYS.includes(k), `${k} помечен рантаймовым`).toBe(true);
    }
    const ed = SRC('pose-editor.ts');
    const m = /const GAIT_KEYS[^=]*=\s*\[([\s\S]*?)\]/.exec(ed)![1]!;
    for (const k of ['warpOn', 'warpMax', 'warpSmooth', 'warpRate']) {
      expect(m.includes(`'${k}'`), `⚠ ${k} убран из GAIT_KEYS — сломается СБРОС при смене персонажа, ` +
        'и значение потечёт от класса к классу (игра сбрасывает по полному GAIT_BASE, редактор — нет)').toBe(true);
    }
  });
});

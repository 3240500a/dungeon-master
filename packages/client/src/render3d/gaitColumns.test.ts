import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { PoseDriver, GAIT, POSE, BACK, STRAFE, STRAFE_R, STRAFE_L, COMBAT, ASYM } from './pose.js';

/**
 * ⭐⭐ КОЛОНКИ НАПРАВЛЕНИЯ: ползунок, который редактор показывает, ОБЯЗАН читаться.
 *
 * Жалоба автора (19.09): «на назад половина настроек не работает; и если написано «не задано и берётся с переди»,
 * то вообще странно себя ведёт, пока не подёргаешь туда-сюда ползунок».
 *
 * Нашлось три независимые беды, и каждая стережётся отдельно:
 *  1. ШЕСТЬ РУЧЕК ЧИТАЛИСЬ `sideLerp`, а не `locoVal`. У `sideLerp` нет `LocoMix` в принципе — то есть колонку
 *     направления они не спрашивали ВОВСЕ. Редактор при этом честно рисовал их на «НАЗАД»/«СТРАЙФ»/«БОЙ», запись
 *     уходила в карту колонки, и её никто не читал: ползунок был мёртвым.
 *  2. ЗАТРАВКА ПОЛЗУНКА бралась из базы, а не тем же правилом, что у рантайма: если в колонке задана одна скорость,
 *     она играет на обеих, и ползунок второй показывал базу. Первое касание → скачок.
 *  3. `put()` ЗВАЛ `renderLoco()`, а тот начинается с `body.innerHTML = ''` — ползунок удалялся из DOM под пальцем.
 */
const SRC = (f: string): string => readFileSync(path.join(__dirname, f), 'utf8');

/** Ключи, которые панель «Бег» показывает В КОЛОНКЕ (через `row2`) — читаются прямо из исходника редактора. */
const columnKeys = (): { kw: string; kr: string | null }[] => {
  const src = SRC('pose-editor.ts');
  const out: { kw: string; kr: string | null }[] = [];
  // row2('подпись', OBJ, 'kw', 'kr' | null, …)
  const re = /\brow2\(\s*'[^']*'\s*,\s*\w+\s*,\s*'([A-Za-z0-9_]+)'\s*,\s*(?:'([A-Za-z0-9_]+)'|null)/g;
  for (let m = re.exec(src); m; m = re.exec(src)) out.push({ kw: m[1]!, kr: m[2] ?? null });
  return out;
};
/**
 * Ключи, которые рантайм читает ЧЕРЕЗ КОЛОНКУ.
 *
 * ⚠ НЕ ТОЛЬКО буквальный `locoVal('kw','kr')`: половина ручек идёт через ОБЁРТКИ вида
 * `const body = (kw, kr, bw, br): number => locoVal(kw, kr, bw, br, 0, m)`. Сторож, который их не видит,
 * объявляет мёртвыми 11 ИСПРАВНЫХ ручек — и чинить бросаются работающее (проверено на себе). Поэтому имена
 * обёрток находятся здесь же, ПО ИХ ОПРЕДЕЛЕНИЮ, а не перечисляются руками: список растёт вместе с кодом.
 */
const columnAware = (): Set<string> => {
  const src = SRC('pose.ts') + SRC('poseRuntime.ts');
  const out = new Set<string>();
  const names = ['locoVal'];
  const wrap = /\bconst\s+([A-Za-z0-9_]+)\s*=\s*\([^)]*\)\s*:\s*number\s*=>\s*locoVal\(/g;
  for (let m = wrap.exec(src); m; m = wrap.exec(src)) names.push(m[1]!);
  for (const n of names) {
    const re = new RegExp('\\b' + n + "\\(\\s*'([A-Za-z0-9_]+)'\\s*,\\s*'([A-Za-z0-9_]+)'", 'g');
    for (let m = re.exec(src); m; m = re.exec(src)) { out.add(m[1]!); out.add(m[2]!); }
  }
  return out;
};

afterEach(() => {
  for (const map of [BACK, STRAFE, STRAFE_R, STRAFE_L, COMBAT]) for (const k of Object.keys(map)) delete map[k];
  for (const k of Object.keys(ASYM)) delete ASYM[k];
});

describe('мёртвых ползунков нет', () => {
  it('⭐⭐ КАЖДАЯ РУЧКА, ПОКАЗАННАЯ В КОЛОНКЕ, ЧИТАЕТСЯ ЧЕРЕЗ КОЛОНКУ', () => {
    const shown = columnKeys();
    const aware = columnAware();
    expect(shown.length, 'разбор панели сломался — ручек не найдено').toBeGreaterThan(20);
    const dead = shown.filter((k) => !aware.has(k.kw)).map((k) => k.kw);
    // ⚠ ЭТО ГЛАВНЫЙ СТОРОЖ ФАЙЛА. Было мертво шесть: shoUp, shoLift, shoFwd, shoSwing, shoTw (все читались
    // `sideLerp` в `pose.ts`) и armDown (читался `sideLerp` в `poseRuntime.applyUpper`). Если список снова
    // непустой — значит ручку показали в колонке, а читать её колонкой забыли.
    expect([...new Set(dead)], 'ручки показаны в колонке, но колонку не читают').toEqual([]);
  });

  it('пара «ходьба/бег» у колоночной ручки читается целиком: обе половины через `locoVal`', () => {
    const aware = columnAware();
    const half = columnKeys().filter((k) => k.kr && aware.has(k.kw) !== aware.has(k.kr));
    expect(half.map((k) => k.kw + '/' + k.kr), 'одна половина пары читает колонку, другая нет').toEqual([]);
  });
});

describe('колонка НАЗАД реально правит позу', () => {
  /** Прогон планировщика ходом СПИНОЙ; возвращает цели позы последнего кадра. */
  const runBack = (): PoseDriver['out'] => {
    // ⚠ `setWorld(x, z, yaw, vx, vz)`: ход СПИНОЙ — это ОТРИЦАТЕЛЬНАЯ `vz` при курсе 0, а не просто убывающая `z`.
    // С положительной `vz` доля колонки «назад» остаётся нулевой, и сторож молча меряет ход ВПЕРЁД, показывая
    // «ручка не работает» там, где её просто не спросили (поймано на себе).
    const d = new PoseDriver();
    let z = 0;
    for (let i = 0; i < 180; i++) { z -= 115 / 60; d.setWorld(0, z, 0, 0, -115); d.update(1 / 60); }
    const out = { ...d.update(1 / 60) };
    expect(out.mix?.bt ?? 0, 'прогон обязан идти СПИНОЙ — иначе колонка «назад» не участвует').toBeGreaterThan(0.9);
    return out;
  };

  it('⭐⭐ ШЕСТЬ ОЖИВЛЁННЫХ РУЧЕК: запись в колонку НАЗАД двигает позу', () => {
    const before = runBack();
    const moved: string[] = [];
    for (const [kw, kr, out] of [
      ['shoUp', 'shoUpRun', 'shoLZ'], ['shoFwd', 'shoFwdRun', 'shoLY'], ['shoTw', 'shoTwRun', 'shoLX'],
    ] as const) {
      BACK[kw] = (POSE as unknown as Record<string, number>)[kw]! + 0.5;
      BACK[kr] = (POSE as unknown as Record<string, number>)[kr]! + 0.5;
      const after = runBack();
      if (Math.abs((after[out] ?? 0) - (before[out] ?? 0)) > 1e-3) moved.push(kw);
      delete BACK[kw]; delete BACK[kr];
    }
    expect(moved, 'ручки пояса обязаны слушаться колонки НАЗАД').toEqual(['shoUp', 'shoFwd', 'shoTw']);
  });

  it('⭐ МНОЖИТЕЛИ ПОЯСА (`shoLift`/`shoSwing`) тоже слушаются колонки — они множатся на отклонение руки', () => {
    const before = runBack();
    BACK['shoSwing'] = 1.2; BACK['shoSwingRun'] = 1.2;
    const after = runBack();
    expect(Math.abs((after.shoLY ?? 0) - (before.shoLY ?? 0)), 'качание пояса за рукой').toBeGreaterThan(1e-3);
  });

  it('пустая колонка не меняет НИЧЕГО — бит в бит', () => {
    const a = runBack(), b = runBack();
    for (const k of Object.keys(a) as (keyof PoseDriver['out'])[]) {
      if (k === 'mix') continue;
      expect(a[k], k).toBe(b[k]);
    }
  });
});

describe('редактор: показ не расходится с расчётом', () => {
  it('⭐⭐ ПОЛЗУНОК НЕ ПЕРЕРИСОВЫВАЕТ ПАНЕЛЬ ИЗ ОБРАБОТЧИКА ВВОДА', () => {
    // `renderLoco` начинается с `body.innerHTML = ''`: вызов из `oninput` удаляет из DOM тот самый ползунок,
    // который тянут, браузер теряет захват указателя, и перетаскивание обрывается на первом шаге.
    const src = SRC('pose-editor.ts');
    const put = src.slice(src.indexOf('const put = (nv: number): void =>'));
    // ⚠ БЕЗ КОММЕНТАРИЕВ: внутри `put` стоит пояснение, ПОЧЕМУ там больше нет `renderLoco()`, и наивный поиск
    // подстроки находил бы его в этом же тексте — сторож ловил бы собственное объяснение (поймано на себе).
    const body = put.slice(0, put.indexOf('sl.oninput')).replace(/\/\/[^\n]*/g, '');
    expect(body.includes('renderLoco()'), '⚠ перерисовка панели вернулась в обработчик ввода ползунка').toBe(false);
    expect(body.includes('markSet()'), 'метка «задан» обязана обновляться НА МЕСТЕ').toBe(true);
  });

  it('⭐ ЗАТРАВКА ПОЛЗУНКА берётся правилом колонки, а не базой', () => {
    const src = SRC('pose-editor.ts');
    const i = src.indexOf('const seed = onCol');
    expect(i, '⚠ затравка снова считается из базы — ползунок будет врать про то, что играет').toBeGreaterThan(0);
    const seed = src.slice(i, i + 400);
    expect(seed.includes('seedOf(sparse, sfx)'), 'сначала спрашивается СВОЯ колонка').toBe(true);
  });
});

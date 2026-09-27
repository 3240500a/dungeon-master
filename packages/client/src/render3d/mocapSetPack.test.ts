import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { openBakeSource, bakeFromSource, type BakeSource } from './clipBaker.js';
import { isStaticBake, loopSeamGap } from './clipImport.js';
import { MOCAP_SET, matchMocapSet, type MocapTake } from './mocapSetMap.js';
import { ROOT_YAW } from './clipModel.js';

/**
 * ⭐⭐ ТАБЛИЦА НАБОРА ПРОТИВ САМОГО ПАКЕТА — прогон, который проверяет ДАННЫЕ, а не код.
 *
 * Пакет Kubold лежит вне репозитория (и обязан там лежать: перераспространять его лицензия запрещает),
 * поэтому тест ЯВНО СКИПАЕТСЯ с сообщением, если папки нет. Молча проходить он не имеет права: «зелено,
 * потому что ничего не проверялось» — худший из возможных ответов (та же грабля, что у стенда паритета).
 *
 * Путь можно задать переменной окружения `MAP_DIR`.
 *
 * Что он держит:
 *  1. в таблице нет опечаток — каждый тейк существует в пакете;
 *  2. `rootYaw` стоит РОВНО там, где в файле есть дорожка `Root.quaternion` (замер: 7 тейков из 66, и у
 *     стартов значения имени не соответствуют — см. шапку `mocapSetMap.ts`);
 *  3. ядро реально запекается: не статика, скорость съёма в замеренной полосе, метаданные набора на месте.
 */
const DIR = process.env['MAP_DIR']
  ?? 'C:/work/Games_Art/Games_Art/top_down/dungeon/Assets/MovementAnimsetPro/Animations';
const HAVE = existsSync(DIR) && readdirSync(DIR).some((f) => f.toLowerCase().endsWith('.fbx'));
const D = 180 / Math.PI;

/** Замеренные скорости съёма ядра (u/с, наши юниты) — полоса ±3 % на случай правок ретаргета. */
const CORE_SPEED: Record<string, number> = {
  walk_fwd: 55.7, walk_back: 55.7, walk_strafe_L: 55.7, walk_strafe_R: 55.7,
  run_fwd: 121.1, run_back: 74.0, run_strafe_L: 72.4, run_strafe_R: 75.8,
};
/**
 * Замеренные углы поворотов (°, наша конвенция: L отрицательный). Снимаются ИЗ ОПОРНОЙ СТОПЫ — в корне их нет.
 * Полоса ±6°: недобор до номинала (88 вместо 90) — это честное содержимое тейка, выпрямлять его нельзя.
 */
const TURN_DEG: Record<string, number> = {
  turn_L_90: -88, turn_R_90: 88, turn_L_180: -169, turn_R_180: 165, turn_L_45: -43, turn_R_45: 43,
};

describe.skipIf(!HAVE)('набор мокапа: таблица против пакета', () => {
  if (!HAVE) {
    it.skip(`ПАКЕТ НЕ НАЙДЕН (${DIR}) — прогон пропущен, а не «пройден». Путь задаётся MAP_DIR.`, () => {});
    return;
  }
  const opened: { file: string; src: BakeSource }[] = [];

  it('открыть все FBX пакета', async () => {
    (globalThis as unknown as { window?: unknown }).window ??= { innerWidth: 1920, innerHeight: 1080 };
    // FBXLoader шумит камерами Motionbuilder и многослойными стеками — к делу это не относится.
    const warn = console.warn; console.warn = (): void => {};
    try {
      for (const f of readdirSync(DIR).filter((x) => x.toLowerCase().endsWith('.fbx')).sort()) {
        const buf = readFileSync(path.join(DIR, f));
        opened.push({ file: f, src: await openBakeSource(new File([buf as unknown as BlobPart], f)) });
      }
    } finally { console.warn = warn; }
    expect(opened.length, 'в папке нет ни одного разобранного FBX').toBeGreaterThan(0);
  }, 900000);

  it('⭐⭐ В ТАБЛИЦЕ НЕТ ОПЕЧАТОК: каждый тейк есть в пакете', () => {
    const all = new Set(opened.flatMap((o) => o.src.animations.map((a) => a.name)));
    const missing = MOCAP_SET.filter((t) => !all.has(t.take)).map((t) => `${t.take} (→ ${t.clip})`);
    expect(missing, '⚠ таблица ссылается на тейки, которых в пакете нет').toEqual([]);
  });

  /**
   * ⚠⚠ ГЛАВНЫЙ СТОРОЖ ДАННЫХ. Снять частичный рыск ХУЖЕ, чем не снимать: `pelvisPoseToChar` вычитает его
   * из таза, то есть портит саму позу на эти градусы. Замер: `WalkFwdStart180_L` несёт 33°, `_R` −146° —
   * ни то, ни другое не 180°, значит имени доверять нельзя, а файлу — можно только там, где поворот полный.
   */
  it('⭐⭐ `rootYaw` СТОИТ ТОЛЬКО ТАМ, ГДЕ В ФАЙЛЕ ЕСТЬ ДОРОЖКА ПОВОРОТА', () => {
    const hasYaw = new Map<string, boolean>();
    for (const { src } of opened) {
      for (const a of src.animations) {
        if (hasYaw.has(a.name)) continue;
        hasYaw.set(a.name, a.tracks.some((t) => t.name === 'Root.quaternion' && t.times.length > 1));
      }
    }
    // Рыск ИЗ ТАЗА требует дорожки в файле; рыск ИЗ СТОП — нет, он на то и заведён (вращение корня вычтено).
    const wrong = MOCAP_SET.filter((t) => t.rootYaw && !t.yawFromFeet && !hasYaw.get(t.take)).map((t) => t.take);
    expect(wrong, '⚠ снимаем рыск из таза у тейка, в котором дорожки поворота нет — в клип уйдут нули').toEqual([]);
    // …а из стоп — только у поворотов на месте: на едущем тейке метод копит ошибку (замер: бег −26°, старты до 378°).
    const feet = MOCAP_SET.filter((t) => t.yawFromFeet).map((t) => t.clip);
    expect(feet.every((c) => c.startsWith('turn_')), '⚠ съём из стоп у едущего тейка').toBe(true);
    // Контроль: тейк с полным поворотом известен и он ОДИН — если пакет обновят, тест это покажет.
    const carry = [...hasYaw].filter(([n, v]) => v && MOCAP_SET.some((t) => t.take === n)).map(([n]) => n);
    expect(carry.length, 'поворот несут 7 тейков таблицы (замер 27.09.2026)').toBe(7);
  });

  it('⭐⭐ ЯДРО ЗАПЕКАЕТСЯ: не статика, скорость съёма в полосе, метаданные набора на месте', () => {
    const seen = new Set<string>();
    for (const { src } of opened) {
      const m = matchMocapSet(src.animations.map((a) => a.name));
      for (const t of m.core) {
        if (seen.has(t.clip)) continue;
        seen.add(t.clip);
        const r = bake(src, t);
        expect(isStaticBake(r.stats), `${t.clip}: СТАТИКА — карта костей или дубль скелета`).toBe(false);
        const want = CORE_SPEED[t.clip];
        if (want === undefined) continue;                            // idle: травела нет, полосы тоже
        expect(r.clip.bakeSpeed, `${t.clip}: скорость съёма`).toBeGreaterThan(want * 0.97);
        expect(r.clip.bakeSpeed, `${t.clip}: скорость съёма`).toBeLessThan(want * 1.03);
        expect(r.clip.upperPure, `${t.clip}: верх мокапа безоружный — флаг обязан стоять`).toBe(true);
        expect(r.clip.swingRef?.['RightUpperArm'], `${t.clip}: нейтраль маха`).toBeTruthy();
      }
    }
    expect([...seen].sort(), 'ядро собирается из трёх файлов пакета и закрывает ВСЕ 15 имён движка').toEqual(
      ['idle', 'run_back', 'run_fwd', 'run_strafe_L', 'run_strafe_R',
        'turn_L_180', 'turn_L_45', 'turn_L_90', 'turn_R_180', 'turn_R_45', 'turn_R_90',
        'walk_back', 'walk_fwd', 'walk_strafe_L', 'walk_strafe_R']);
  }, 900000);

  /**
   * ⚠ ШВЫ ЦИКЛОВ — не приёмка, а СПИСОК К ПРАВКЕ. Большинство циклов пакета сходятся (0.0–0.1°), но у
   * четырёх шов заметный: замер `run_back` 5.7°, `mocap_run_diag_L135`/`R135` 5.8°, `mocap_walk_diag_R135` 7.6°.
   * Порог 10° ловит настоящую поломку (перепутанный тейк, обрезка не туда), а сами 5–8° сводятся в редакторе
   * (`clipImport.closeLoopSeam`) — тест печатает их, чтобы список был, а не всплывал глазами.
   */
  it('⚠ швы циклов: ни один не хуже 10°', () => {
    const bad: string[] = [];
    for (const { src } of opened) {
      const m = matchMocapSet(src.animations.map((a) => a.name));
      for (const t of [...m.core, ...m.extra]) {
        if (!t.cyclic) continue;
        const c = bake(src, t).clip;
        const g = loopSeamGap(c);
        if (g.deg > 1) bad.push(`${t.clip} ${g.deg.toFixed(1)}° (${g.bone})`);
        expect(g.deg, `${t.clip}: шов цикла`).toBeLessThan(10);
      }
    }
    if (bad.length) console.log('швы, которые стоит свести: ' + bad.join(', '));
  }, 900000);

  /**
   * ⭐⭐ ПОВОРОТЫ ДОНОСЯТ УГОЛ ДО КАНАЛА, И СО ЗНАКОМ. Это и есть проверка съёма из опорной стопы: в корне у
   * этих тейков поворота нет вовсе, так что ненулевой `__rootY` мог взяться только из ног.
   * ⚠ Знак — наша конвенция (`TURN_PRESETS`: L отрицательный, R положительный). Перепутать его значит
   * получить персонажа, который на поворот влево крутится вправо, и ни один другой сторож этого не увидит.
   */
  it('⭐⭐ ВСЕ ШЕСТЬ ПОВОРОТОВ НЕСУТ СВОЙ УГОЛ (снят из стоп) И СО ВЕРНЫМ ЗНАКОМ', () => {
    const seen: string[] = [];
    for (const { src } of opened) {
      const m = matchMocapSet(src.animations.map((a) => a.name));
      for (const t of m.core) {
        const want = TURN_DEG[t.clip];
        if (want === undefined || seen.includes(t.clip)) continue;
        seen.push(t.clip);
        const k = bake(src, t).clip.keys;
        const got = (k[k.length - 1]!.pose[ROOT_YAW]?.[0] ?? 0) * D;
        expect(Math.sign(got), `${t.clip}: знак поворота (L отрицательный, R положительный)`).toBe(Math.sign(want));
        expect(Math.abs(got - want), `${t.clip}: угол ${got.toFixed(0)}° против замеренных ${want}°`).toBeLessThan(6);
      }
    }
    expect(seen.sort(), 'проверены все шесть').toEqual(['turn_L_180', 'turn_L_45', 'turn_L_90', 'turn_R_180', 'turn_R_45', 'turn_R_90']);
  }, 900000);

  /** Запечь тейк ровно так, как это делает кнопка переноса набора в панели импорта. */
  function bake(src: BakeSource, t: MocapTake): ReturnType<typeof bakeFromSource> {
    const i = src.animations.findIndex((a) => a.name === t.take);
    const dur = src.animations[i]!.duration;
    return bakeFromSource(src, {
      character: 'mocap', weapon: 'none', animationIndex: i, name: t.clip, loop: t.cyclic,
      locoSet: true, bakeId: 1, anchorIdle: false, fps: 60, epsDeg: 3,
      hips: 'full', ground: true, head: 'mocap',
      rootYaw: t.rootYaw ?? false, yawFromFeet: t.yawFromFeet ?? false, rootPos: true,
      startSec: t.trim ? t.trim[0] * dur : undefined, endSec: t.trim ? t.trim[1] * dur : undefined,
    });
  }
});

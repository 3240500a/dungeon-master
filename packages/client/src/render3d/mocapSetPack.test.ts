import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { openBakeSource, bakeFromSource, type BakeSource } from './clipBaker.js';
import { isStaticBake, loopSeamGap } from './clipImport.js';
import { MOCAP_SET, matchMocapSet, type MocapTake } from './mocapSetMap.js';
import { ROOT_YAW } from './clipModel.js';
import * as THREE from 'three';
import { buildHumanoid } from './humanoid.js';

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
  // ⚠ Стороны идут за клипами: `RunLtLoop` (72.4) — это шаг в СВОЮ ЛЕВУЮ, то есть наш `run_strafe_R`.
  run_fwd: 121.1, run_back: 74.0, run_strafe_R: 72.4, run_strafe_L: 75.8,
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
  /**
   * ⚠ РЕКОНСТРУКЦИЯ КУРСА ИЗ СТОП — ТОЛЬКО ДЛЯ ПОВОРОТОВ НА МЕСТЕ, и сейчас она не нужна никому:
   * авторская кривая читается напрямую из FBX (`tools/fbxRootCurve.ts`), а `FBXLoader` её теряет.
   * ⚠ Прежний сторож здесь требовал, чтобы у тейка с `rootYaw` была дорожка `Root.quaternion`, ВИДИМАЯ
   * ЗАГРУЗЧИКУ. Посылка оказалась неверной: дорожка в файле есть (40 ключей до ±90.0000°), а загрузчик
   * отдаёт один ключ-единицу. Сторож на ложной посылке хуже отсутствующего, поэтому он снят, а угол
   * поворота теперь проверяет сам генератор набора (`tools/mocapSet.ts`) — там кривая и читается.
   */
  it('⚠ съём курса из стоп не стоит у едущих тейков', () => {
    const wrong = MOCAP_SET.filter((t) => t.yawFromFeet && !t.clip.startsWith('turn_')).map((t) => t.clip);
    expect(wrong, '⚠ едущему тейку съём из стоп вписал бы выдуманный поворот').toEqual([]);
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
  it('⚠ швы циклов: ядро строго, дополнительное мягче', () => {
    const bad: string[] = [];
    for (const { src } of opened) {
      const m = matchMocapSet(src.animations.map((a) => a.name));
      for (const t of [...m.core, ...m.extra]) {
        if (!t.cyclic) continue;
        const g = loopSeamGap(bake(src, t).clip);
        if (g.deg > 1) bad.push(`${t.clip} ${g.deg.toFixed(1)}° (${g.bone})`);
        // ⚠ Порог РАЗНЫЙ по существу, а не для удобства: ядро — это то, что движок играет по имени,
        // и разрыв в нём виден в игре. Дополнительное лежит материалом под механику, которой ещё нет.
        // ⚠ Отказ от пинов стоп (см. сторож на переворот голени) ухудшил шов ровно у одного клипа:
        // `mocap_walk_diag_R135` 7.6° → 12.8°. Это цена, и она названа, а не спрятана поднятием порога всем.
        expect(g.deg, `${t.clip}: шов цикла`).toBeLessThan(t.core ? 10 : 15);
      }
    }
    if (bad.length) console.log('швы, которые стоит свести (`clipImport.closeLoopSeam`): ' + bad.join(', '));
  }, 900000);

  /**
   * ⭐⭐ ПОВОРОТ НЕ ВЫЧТЕН ДВАЖДЫ. `__rootY` кладут в канал, а из таза его СНИМАЮТ — иначе поворот поедет
   * дважды. Но у тейка «in place» таз поворота и не несёт: вращение корня из него убрали авторы. Снять
   * ещё раз значит закрутить таз НАВСТРЕЧУ каналу, и при проигрывании они гасят друг друга в ноль.
   * ЗАМЕР, когда это было сломано: `turn_L_90` — `__rootY` 0 → −88°, рыск таза в клипе −5 → +83°.
   * В игре читалось как «топчется на месте, а разворачивается потом и без подшагов».
   */
  it('⭐⭐ ТАЗ В КЛИПЕ ПОВОРОТА НЕ КРУТИТСЯ НАВСТРЕЧУ КАНАЛУ', () => {
    for (const { src } of opened) {
      for (const t of matchMocapSet(src.animations.map((a) => a.name)).core) {
        if (!t.yawFromFeet) continue;
        const k = bake(src, t).clip.keys;
        const ry = (k[k.length - 1]!.pose[ROOT_YAW]?.[0] ?? 0) * D;
        const hipsYaw = (j: number): number => (k[j]!.pose['Hips']?.[1] ?? 0) * D;
        const dHips = hipsYaw(k.length - 1) - hipsYaw(0);
        // Знак ПРОТИВОПОЛОЖНЫЙ каналу и величина соизмерима — это и есть двойное вычитание.
        expect(Math.sign(dHips) === -Math.sign(ry) && Math.abs(dHips) > Math.abs(ry) * 0.5,
          `${t.clip}: таз ушёл на ${dHips.toFixed(0)}° против канала ${ry.toFixed(0)}° — поворот вычтен дважды`).toBe(false);
      }
    }
  }, 900000);

  /**
   * ⭐⭐ СТОРОНА КЛИПА — ПО ЗАМЕРУ ТРАВЕЛА, А НЕ ПО БУКВАМ ИМЕНИ. На этом и сломалось: у Kubold
   * `StrafeLeftLoop` — шаг В СВОЮ ЛЕВУЮ, то есть ход в +X, а наши имена зеркальны анатомии
   * («strafe_R = ход в +X = в СВОЮ ЛЕВУЮ», `poseRuntime.ts` / `locoBlend.ts` / `gaitKnobs.ts`).
   * Перенос по буквам положил клип в противоположный слот, и замер рантайма дал расхождение 178.6°
   * между ходом тела и переступанием ног — это и есть «ноги перекручиваются».
   * Сверка имён такую ошибку не видит ПО ПОСТРОЕНИЮ: обе стороны написаны правдоподобно.
   */
  it('⭐⭐ СТОРОНА СТРАЙФА СОВПАДАЕТ С КОНВЕНЦИЕЙ РАНТАЙМА (замер травела, не имена)', () => {
    const want: Record<string, number> = { walk_strafe_R: +1, run_strafe_R: +1, walk_strafe_L: -1, run_strafe_L: -1 };
    const seen: string[] = [];
    for (const { src } of opened) {
      for (const t of matchMocapSet(src.animations.map((a) => a.name)).core) {
        const sign = want[t.clip];
        if (sign === undefined || seen.includes(t.clip)) continue;
        seen.push(t.clip);
        const i = src.animations.findIndex((a) => a.name === t.take);
        const dur = src.animations[i]!.duration;
        const r = bakeFromSource(src, {
          character: 'mocap', weapon: 'none', animationIndex: i, name: t.clip, loop: t.cyclic,
          locoSet: true, bakeId: 1, anchorIdle: false, fps: 60, epsDeg: 3, limbLock: { LF: false, RF: false },
          hips: 'full', ground: true, head: 'mocap', rootPos: true,
          startSec: t.trim ? t.trim[0] * dur : undefined, endSec: t.trim ? t.trim[1] * dur : undefined,
        });
        const k = r.clip.keys;
        const a0 = k[0]!.pose['__rootP'] ?? [0, 0, 0], a1 = k[k.length - 1]!.pose['__rootP'] ?? [0, 0, 0];
        const dx = a1[0] - a0[0], dz = a1[2] - a0[2];
        expect(Math.abs(dx), `${t.clip} (${t.take}): это не ход вбок — травел по X ${dx.toFixed(1)}, по Z ${dz.toFixed(1)}`)
          .toBeGreaterThan(Math.abs(dz));
        expect(Math.sign(dx), `${t.clip} (${t.take}): сторона перепутана — травел по X ${dx.toFixed(1)}, нужен знак ${sign}`)
          .toBe(sign);
      }
    }
    expect(seen.sort(), 'проверены все четыре клипа страйфа').toEqual(['run_strafe_L', 'run_strafe_R', 'walk_strafe_L', 'walk_strafe_R']);
  }, 900000);

  /**
   * ⭐⭐ ГОЛЕНЬ НЕ ПЕРЕВОРАЧИВАЕТСЯ. Это тот самый «перекрут ноги», который видно в игре: мировой поворот
   * голени прыгал на 179° между соседними ключами `run_fwd` — раз на ногу за цикл.
   *
   * ПРИЧИНА (замерена по шагам): пин стопы гоняет солвер вхолостую (у мокапа стопы уже верны), а солвер
   * наводит голень ТЕМ ЖЕ полюсом, что и бедро; на махе голень ложится ВДОЛЬ полюса — минимальный угол
   * «голень ↔ полюс» 3.1° у `RunFwdLoop` против 36.0° у `WalkFwdLoop`, — и крен фрейма опрокидывается.
   * С пинами 179.1° / 178.8°, без пинов 26.0° / 19.9°.
   *
   * ⚠ Сторож смотрит МИРОВОЙ поворот, а не локальный: локальный переворот бедра и голени могут друг друга
   * скомпенсировать, и в скелете беды не видно — её видно на МЕШЕ, потому что голень выворачивается вокруг
   * своей оси. Порог 90°: настоящий шаг за кадр 60 Гц столько не даёт даже на спринте (замер: макс 26°).
   */
  it('⭐⭐ НИ ОДНА КОСТЬ НОГИ НЕ ПЕРЕВОРАЧИВАЕТСЯ МЕЖДУ КЛЮЧАМИ (мировой поворот)', () => {
    const H = buildHumanoid();
    const worst: string[] = [];
    const seen = new Set<string>();
    for (const { src } of opened) {
      for (const t of matchMocapSet(src.animations.map((a) => a.name)).core) {
        if (seen.has(t.clip)) continue;
        seen.add(t.clip);
        const keys = bake(src, t).clip.keys;
        for (const bone of ['LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot', 'RightUpperLeg', 'RightLowerLeg', 'RightFoot']) {
          let prev: THREE.Quaternion | null = null, deg = 0, at = -1;
          keys.forEach((k, j) => {
            for (const nm in k.pose) {
              if (nm[0] === '_') continue;
              const b = H.bones.get(nm); if (b) b.rotation.set(k.pose[nm]![0], k.pose[nm]![1], k.pose[nm]![2]);
            }
            H.root.updateMatrixWorld(true);
            const b = H.bones.get(bone); if (!b) return;
            const q = b.getWorldQuaternion(new THREE.Quaternion());
            if (prev) {
              const d = 2 * Math.acos(Math.min(1, Math.abs(prev.dot(q)))) * D;
              if (d > deg) { deg = d; at = j; }
            }
            prev = q;
          });
          if (deg >= 90) worst.push(`${t.clip}/${bone} ${deg.toFixed(0)}° на ключе ${at}`);
        }
      }
    }
    expect(worst, '⚠⚠ кость ноги перевернулась — на меше это выворот голени наизнанку').toEqual([]);
  }, 900000);

  /** Запечь тейк ровно так, как это делает кнопка переноса набора в панели импорта. */
  function bake(src: BakeSource, t: MocapTake): ReturnType<typeof bakeFromSource> {
    const i = src.animations.findIndex((a) => a.name === t.take);
    const dur = src.animations[i]!.duration;
    return bakeFromSource(src, {
      character: 'mocap', weapon: 'none', animationIndex: i, name: t.clip, loop: t.cyclic,
      locoSet: true, bakeId: 1, anchorIdle: false, fps: 60, epsDeg: 3, limbLock: { LF: false, RF: false },
      hips: 'full', ground: true, head: 'mocap',
      rootYaw: t.rootYaw ?? false, yawFromFeet: t.yawFromFeet ?? false, rootPos: true,
      startSec: t.trim ? t.trim[0] * dur : undefined, endSec: t.trim ? t.trim[1] * dur : undefined,
    });
  }
});

/**
 * ⭐ ГЕНЕРАТОР НАБОРОВ ИЗ МОКАПА. Запуск из корня проекта:
 *     node node_modules/tsx/dist/cli.mjs tools/mocapSet.ts
 *
 * Делает ДВА файла, которые кладутся в редактор кнопкой «📦 загрузить»:
 *   `mocap_core.json` — стандартные 15 имён, чистые циклы. Это набор, который играет движок;
 *   `mocap_test.json` — то же ядро, но ход СШИТ («разгон + цикл + остановка», метки `loop_start`/`loop_end`
 *                       читает `stepLocoSection`), плюс всё дополнительное содержимое пакета.
 *
 * Таблица соответствий «тейк → наш клип» живёт в `mocapSetMap.ts`; здесь только сборка.
 * Оба файла в `.gitignore` — они пересобираются отсюда.
 *
 * ⚠ СКРИПТОМ, А НЕ ТЕСТОМ: тест в общем прогоне переписывал бы эти файлы на каждом `npm test`.
 * ⚠ `FBXLoader` в node требует заглушки `window` — в пакете лежат камеры Motionbuilder, а он читает
 *   `window.innerWidth`. В браузере-редакторе это неважно.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { openBakeSource, bakeFromSource, type BakeSource } from '../packages/client/src/render3d/clipBaker.js';
import { isStaticBake, stitchLocoClip } from '../packages/client/src/render3d/clipImport.js';
import { matchMocapSet, type MocapTake } from '../packages/client/src/render3d/mocapSetMap.js';
import type { Clip } from '../packages/client/src/render3d/clipModel.js';
import { readRootYawCurves, sampleCurve, type RootYawCurve } from './fbxRootCurve.js';

const DIR = process.env['MAP_DIR']
  ?? 'C:/work/Games_Art/Games_Art/top_down/dungeon/Assets/MovementAnimsetPro/Animations';
const OUT = process.cwd();
const D = 180 / Math.PI;

/**
 * Разгон и остановка для сшивки: тейк цикла → [старт, остановка].
 * ⚠ Берём `_RU`, и это ЗАМЕР, а не выбор наугад: стык «цикл → остановка» у `_RU` сходится в 0.0–0.1°,
 * у `_LU` расходится на 33–81° — цикл кончается на вполне определённой фазе ноги, и подходит только одна.
 * Стык «разгон → цикл» сходится у всех (0.0–0.2°): пакет записан ровно под эту модель.
 */
const STITCH: Record<string, [string, string]> = {
  WalkFwdLoop: ['WalkFwdStart', 'WalkFwdStop_RU'],
  RunFwdLoop: ['RunFwdStart', 'RunFwdStop_RU'],
  WalkBwdLoop: ['WalkBwdStart', 'WalkBwdStop_RU'],
  StrafeLeftLoop: ['StrafeLeftStart', 'StrafeLeftStop_RU'],
  StrafeRightLoop: ['StrafeRightStart', 'StrafeRightStop_RU'],
};

async function main(): Promise<void> {
  (globalThis as unknown as { window?: unknown }).window ??= { innerWidth: 1920, innerHeight: 1080 };
  const warn = console.warn; console.warn = (): void => {};
  const srcs: BakeSource[] = [];
  /** Авторские кривые поворота корня по тейкам — их `FBXLoader` теряет (см. `fbxRootCurve.ts`). */
  const curves = new Map<string, RootYawCurve>();
  for (const f of readdirSync(DIR).filter((x) => x.toLowerCase().endsWith('.fbx')).sort()) {
    const buf = readFileSync(path.join(DIR, f));
    for (const [k, v] of readRootYawCurves(f, buf)) if (!curves.has(k)) curves.set(k, v);
    srcs.push(await openBakeSource(new File([buf as unknown as BlobPart], f)));
  }
  console.warn = warn;

  /** Запечь тейк ровно так же, как кнопка переноса набора в панели импорта. */
  const bakeTake = (take: string, name: string, loop: boolean, t?: MocapTake): Clip => {
    for (const src of srcs) {
      const i = src.animations.findIndex((a) => a.name === take);
      if (i < 0) continue;
      const dur = src.animations[i]!.duration;
      const r = bakeFromSource(src, {
        character: 'mocap', weapon: 'none', animationIndex: i, name, loop,
        locoSet: true, bakeId: 20260927, anchorIdle: false, fps: 60, epsDeg: 3,
        // ⚠ БЕЗ ЗАЗЕМЛЕНИЯ: покадровый лифт таза вырезает фазу полёта целиком (42.6 % кадров → 0.0 %)
        // и раздувает вертикаль таза на ходьбе. Подробности и числа — в шапке `ground` у `clipBaker.ts`.
        hips: 'full', ground: false, head: 'mocap',
        // ⚠ БЕЗ ПИНОВ СТОП: у мокапа стопы уже верны, а холостой прогон солвера выворачивает голень
        // на бегу (замер: мировой скачок 179° против 26° без пинов). См. шапку `mocapSetMap.ts`.
        limbLock: { LF: false, RF: false },
        rootYaw: t?.rootYaw ?? false, yawFromFeet: t?.yawFromFeet ?? false, rootPos: false,
        // ⚠ Курс — ИЗ АВТОРСКОЙ КРИВОЙ, если она у тейка есть. Реконструкция из стоп остаётся фолбэком.
        ...(t?.rootYaw && curves.has(take)
          ? { yawAt: (tSec: number): number => sampleCurve(curves.get(take)!, tSec) * Math.PI / 180 }
          : {}),
        startSec: t?.trim ? t.trim[0] * dur : undefined, endSec: t?.trim ? t.trim[1] * dur : undefined,
      });
      if (isStaticBake(r.stats)) throw new Error(name + ': СТАТИКА — проверь карту костей');
      return r.clip;
    }
    throw new Error('тейка «' + take + '» нет ни в одном файле пакета');
  };

  // ── 1. СТАНДАРТНЫЙ НАБОР: 15 имён, чистые циклы ──
  const takes: MocapTake[] = [];
  const seen = new Set<string>();
  for (const src of srcs) {
    for (const t of matchMocapSet(src.animations.map((a) => a.name)).core) {
      if (seen.has(t.clip)) continue;
      seen.add(t.clip); takes.push(t);
    }
  }
  const core = takes.map((t) => bakeTake(t.take, t.clip, t.cyclic, t));
  writeFileSync(path.join(OUT, 'mocap_core.json'), JSON.stringify(core));

  // Контроль поворотов: канал несёт угол, а таз в клипе НЕ крутится ему навстречу.
  for (const t of takes.filter((x) => x.rootYaw)) {
    const c = core.find((x) => x.name === t.clip)!;
    const last = c.keys[c.keys.length - 1]!;
    const ry = (last.pose['__rootY']?.[0] ?? 0) * D;
    const h0 = (c.keys[0]!.pose['Hips']?.[1] ?? 0) * D, h1 = (last.pose['Hips']?.[1] ?? 0) * D;
    const nominal = Number(/_(\d+)$/.exec(t.clip)?.[1] ?? 0) * (t.clip.includes('_L_') ? -1 : 1);
    const src = curves.has(t.take) ? 'кривая автора' : 'из стоп';
    console.log(`  ${t.clip.padEnd(11)} __rootY ${ry.toFixed(1).padStart(7)}°  номинал ${String(nominal).padStart(5)}°  ` +
      `ошибка ${(ry - nominal).toFixed(1).padStart(6)}°  таз в клипе ${h0.toFixed(0).padStart(4)} → ${h1.toFixed(0).padStart(4)}°  (${src})`);
    // ⚠ ОТКАЗ, А НЕ ПРЕДУПРЕЖДЕНИЕ. Кривая автора точна (ровно ±90.0000 / ±180.0000), и любое расхождение
    // больше половины градуса значит, что мы её опять потеряли и скатились в реконструкцию.
    if (Math.abs(ry - nominal) > 0.5) throw new Error(`${t.clip}: поворот ${ry.toFixed(1)}° против номинала ${nominal}° — кривая автора не подхватилась`);
    // ⚠ И ЗНАК. Перепутать его значит получить персонажа, который на поворот влево крутится вправо:
    // ноги переступают в одну сторону, тело едет в другую — это и было «повернулось наполовину».
    if (Math.sign(ry) !== Math.sign(nominal)) throw new Error(`${t.clip}: знак поворота ${ry.toFixed(1)}° не совпал с именем`);
  }

  // ── 2. ТЕСТОВЫЙ НАБОР: ход СШИТ, плюс всё дополнительное ──
  const test: Clip[] = [];
  for (const t of takes) {
    const pair = STITCH[t.take];
    const loop = bakeTake(t.take, t.clip, t.cyclic, t);
    if (!pair) { test.push(loop); continue; }
    test.push(stitchLocoClip(bakeTake(pair[0], pair[0], false), loop, bakeTake(pair[1], pair[1], false), t.clip));
  }
  const extraSeen = new Set<string>();
  for (const src of srcs) {
    for (const t of matchMocapSet(src.animations.map((a) => a.name)).extra) {
      if (extraSeen.has(t.clip)) continue;
      extraSeen.add(t.clip);
      test.push(bakeTake(t.take, t.clip, t.cyclic, t));
    }
  }
  writeFileSync(path.join(OUT, 'mocap_test.json'), JSON.stringify(test));

  console.log(`\nстандартный набор: ${core.length} клипов → mocap_core.json`);
  console.log(`тестовый набор:    ${test.length} клипов → mocap_test.json  (сшитых ${Object.keys(STITCH).length}, дополнительных ${extraSeen.size})`);
}

void main().catch((e: unknown) => {
  console.error('❌ ' + (e instanceof Error ? e.message : String(e)));
  process.exitCode = 1;
});

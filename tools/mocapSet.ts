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
  for (const f of readdirSync(DIR).filter((x) => x.toLowerCase().endsWith('.fbx')).sort()) {
    const buf = readFileSync(path.join(DIR, f));
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
        hips: 'full', ground: true, head: 'mocap',
        // ⚠ БЕЗ ПИНОВ СТОП: у мокапа стопы уже верны, а холостой прогон солвера выворачивает голень
        // на бегу (замер: мировой скачок 179° против 26° без пинов). См. шапку `mocapSetMap.ts`.
        limbLock: { LF: false, RF: false },
        rootYaw: t?.rootYaw ?? false, yawFromFeet: t?.yawFromFeet ?? false, rootPos: false,
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
  for (const t of takes.filter((x) => x.yawFromFeet)) {
    const c = core.find((x) => x.name === t.clip)!;
    const last = c.keys[c.keys.length - 1]!;
    const ry = (last.pose['__rootY']?.[0] ?? 0) * D;
    const h0 = (c.keys[0]!.pose['Hips']?.[1] ?? 0) * D, h1 = (last.pose['Hips']?.[1] ?? 0) * D;
    console.log(`  ${t.clip.padEnd(11)} __rootY ${ry.toFixed(0).padStart(5)}°   таз в клипе ${h0.toFixed(0).padStart(4)} → ${h1.toFixed(0).padStart(4)}°`);
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

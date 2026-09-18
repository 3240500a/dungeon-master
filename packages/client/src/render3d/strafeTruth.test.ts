import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildHumanoid, type Humanoid } from './humanoid.js';
import { PosePlayer, localStorageContent, emptyGrid, type PlantGrid } from './poseRuntime.js';
import { GAIT_PRESETS } from './clipBake.js';
import { blendLocoPose, type LocoDir } from './locoBlend.js';
import { CAM_AZ, moveFromKeys } from './playerInput.js';
import { CAMERA_FALLBACK, placeCamera } from './cameraRig.js';
import {
  ASYM, STRAFE, STRAFE_R, STRAFE_L, locoVal, strafeMix, strafeSide, strafeSideOf, type LocoMix,
} from './pose.js';

/**
 * ⭐⭐⭐ ТАБЛИЦА ИСТИНЫ «СТОРОНА СТРАЙФА» — ОДНА ЦЕПЬ ОТ ЭКРАНА ДО ЯЧЕЙКИ ПЛАНТА.
 *
 * Жалоба автора (20.09): «настройки сторон страйфа ведут себя странно, лево и право будто перепутаны».
 * ЗАМЕР показал: функционально цепь СОГЛАСОВАНА (что настраиваешь — то и играет), а перепутаны ИМЕНА.
 * Весь исторический словарь зовёт локальный +X «вправо», хотя +X — сторона костей `Left*`, то есть
 * СВОЯ ЛЕВАЯ сторона персонажа. Полная таблица и три источника замера — «ТАБЛИЦА ИСТИНЫ «СТОРОНА»»
 * в `pose.ts`; здесь она ЗАКРЕПЛЕНА КОДОМ, звено за звеном:
 *
 *   знак боковой → своя сторона → карта/суффикс → клип → пресет съёма → ячейка планта → индекс ноги.
 *
 * ⚠ МУТАЦИИ, каждая валит СВОЙ случай (проверено правкой исходника и откатом):
 *   A. `humanoid.ts`: `LeftUpperLeg pos:[-4,…]` / `RightUpperLeg pos:[4,…]` → «риг: кости `Left*` на +X».
 *   B. `locoBlend.ts`: `col(latPlusX ? 'strafe_L' : 'strafe_R')` → «клип по знаку боковой».
 *   C. `pose.ts`: `strafeSide` возвращает `1 - u…` → «карта по знаку боковой» и «доля стороны».
 *   D. `clipBake.ts`: знаки `vx` у `walk_strafe_L`/`walk_strafe_R` местами → «пресет съёма».
 *   E. `poseRuntime.ts`: `Math.atan2(-latC, fwdC)` в выборе ячейки → «ячейка планта 2 / 6».
 *   F. `pose.ts`: `sideOf` читает `ASYM[key]?.[1 - i]` → «индекс ноги 0 = левая».
 *   G. `playerInput.ts`: `CAM_AZ = +Math.PI / 4` → «экран игры: +X вправо».
 *   H. `pose-editor.ts`: `locoVx = ownRight ? v : -v` / `plantDirSel = ownRight ? 2 : 6` → проводка редактора.
 */

const DT = 1 / 60;
const GX = { armDown: 1.35, elbowBend: 0.25 };
const SRC = (f: string): string => readFileSync(path.join(__dirname, f), 'utf8');
const SRC_ED = SRC('pose-editor.ts');
const SRC_RT = SRC('poseRuntime.ts');

const clearCols = (): void => {
  for (const m of [ASYM as unknown as Record<string, unknown>, STRAFE, STRAFE_R, STRAFE_L]) for (const k of Object.keys(m)) delete m[k];
};
afterEach(clearCols);

beforeAll(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: () => null, setItem: () => { /* */ }, removeItem: () => { /* */ }, clear: () => { /* */ }, key: () => null, length: 0,
  } as Storage;
});

/** Мировой X кости в рест-позе свежесобранного рига. */
const boneX = (h: Humanoid, name: string): number => {
  h.root.updateMatrixWorld(true);
  return h.bones.get(name)!.getWorldPosition(new THREE.Vector3()).x;
};

/**
 * Прогнать плеер `sec` секунд с этой скоростью и вернуть СРЕДНИЙ мировой X каждой стопы за вторую половину
 * прогона (первая — разгон). Среднее, а не мгновенный кадр: за цикл стопа ходит вперёд-назад, и один кадр
 * шумит на всю амплитуду маха. Тело едет по X, поэтому X стопы берётся ОТНОСИТЕЛЬНО таза.
 */
function feetAfter(vx: number, vz: number, sec: number, tune?: (p: PosePlayer, h: Humanoid) => void): { l: number; r: number } {
  const h = buildHumanoid({});
  const p = new PosePlayer(h, () => [], localStorageContent('warrior'), 'none', GX, emptyGrid());
  tune?.(p, h);
  p.setYaw(0); p.snapYaw(); p.resetPos();
  const n = Math.round(sec / DT);
  let l = 0, r = 0, k = 0;
  const pos = (name: string): number => h.bones.get(name)!.getWorldPosition(new THREE.Vector3()).x;
  for (let i = 0; i < n; i++) {
    p.setVel(vx, vz); p.step(DT);
    if (i * 2 < n) continue;
    h.root.updateMatrixWorld(true);
    const hips = pos('Hips');
    l += pos('LeftFoot') - hips; r += pos('RightFoot') - hips; k++;
  }
  return { l: l / k, r: r / k };
}

// ── 1. АНАТОМИЯ: +X — ЭТО СВОЯ ЛЕВАЯ ──────────────────────────────────────────────────────────────

describe('анатомия: локальный +X — сторона костей `Left*`, то есть СВОЯ ЛЕВАЯ сторона персонажа', () => {
  it('⭐⭐ РИГ: все `Left*` ноги на +X, `Right*` на −X (мутация A валит)', () => {
    const h = buildHumanoid({});
    for (const n of ['LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot']) expect(boneX(h, n), n).toBeGreaterThan(0);
    for (const n of ['RightUpperLeg', 'RightLowerLeg', 'RightFoot']) expect(boneX(h, n), n).toBeLessThan(0);
    expect(boneX(h, 'LeftShoulder')).toBeGreaterThan(0);
    expect(boneX(h, 'RightShoulder')).toBeLessThan(0);
  });

  it('⭐ ПЕРСОНАЖ СМОТРИТ В +Z, а в правой тройке Three у смотрящего в +Z своя ЛЕВАЯ — на +X', () => {
    // `right = forward × up`. Для forward = +Z, up = +Y это ровно −X, значит левая — +X.
    const right = new THREE.Vector3(0, 0, 1).cross(new THREE.Vector3(0, 1, 0));
    expect(right.x).toBeCloseTo(-1, 12);
    // Носок впереди пятки — курс тела действительно +Z (тот же замер, что на атласе рыцаря: `CC_Base_L_ToeBase`
    // z ≈ +12.3 против `CC_Base_L_Foot` z ≈ −0.78, а `CC_Base_L_Foot` x = +8.93).
    const h = buildHumanoid({});
    h.root.updateMatrixWorld(true);
    const foot = h.bones.get('LeftFoot')!.getWorldPosition(new THREE.Vector3());
    const toe = h.bones.get('LeftToes')!.getWorldPosition(new THREE.Vector3());
    expect(toe.z).toBeGreaterThan(foot.z);
  });
});

// ── 2. ЭКРАН ──────────────────────────────────────────────────────────────────────────────────────

/** Экранное «вправо» в мировых осях: столбец X матрицы камеры, поставленной боевой формулой. */
function gameScreenRight(): THREE.Vector3 {
  const cam = new THREE.PerspectiveCamera(CAMERA_FALLBACK.fovDeg, 1, 1, CAMERA_FALLBACK.farClip);
  placeCamera(cam, new THREE.Vector3(0, 0, 0), CAMERA_FALLBACK.startDist, CAMERA_FALLBACK);
  cam.updateMatrixWorld(true);
  return new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).normalize();
}

describe('экран: куда едет персонаж, когда автор жмёт «вправо»', () => {
  it('⭐⭐ ИГРА: экранное «вправо» = мировой (+X, +Z)/√2, и это ровно клавиша D (мутация G валит)', () => {
    const sr = gameScreenRight();
    expect(sr.x).toBeCloseTo(Math.SQRT1_2, 9);
    expect(sr.y).toBeCloseTo(0, 9);
    expect(sr.z).toBeCloseTo(Math.SQRT1_2, 9);
    const d = moveFromKeys(new Set(['KeyD']), CAM_AZ);
    const dir = new THREE.Vector3(d.x, 0, d.y).normalize();
    expect(dir.dot(sr), 'D — это ровно экранное «вправо»').toBeCloseTo(1, 9);
    expect(sr.x, 'мировой +X виден на экране СПРАВА').toBeGreaterThan(0);
  });

  it('⭐⭐ ИГРА: бежишь ВПРАВО ПО ЭКРАНУ лицом ОТ камеры — это ход в −X, то есть в СВОЮ ПРАВУЮ (клип `strafe_L`)', () => {
    // Лицом «вглубь экрана» = по клавише W; курс таза `yaw` задан как forward = (sin yaw, cos yaw).
    const w = moveFromKeys(new Set(['KeyW']), CAM_AZ);
    const yaw = Math.atan2(w.x, w.y);
    const d = moveFromKeys(new Set(['KeyD']), CAM_AZ);
    // Тот же разбор, что в `PosePlayer.step`: fwdC/latC в осях довёрнутого таза.
    const latC = d.x * Math.cos(yaw) - d.y * Math.sin(yaw);
    expect(latC, 'экранное «вправо» при взгляде от камеры — отрицательная боковая').toBeLessThan(0);
    expect(latC >= 0 ? 'strafe_R' : 'strafe_L').toBe('strafe_L');
  });

  it('⭐ РЕДАКТОР: камера стоит по +Z, значит экранное «вправо» — чистый +X; манекен смотрит В КАМЕРУ', () => {
    // Числа — те же, что в исходнике вьюпорта (проверяем и их, иначе замер отвяжется от кода).
    expect(SRC_ED).toMatch(/camera\.position\.set\(0, 44, 150\)/);
    expect(SRC_ED).toMatch(/orbit\.target\.set\(0, 34, 0\)/);
    const cam = new THREE.PerspectiveCamera(45, 1, 1, 4000);
    cam.position.set(0, 44, 150); cam.lookAt(0, 34, 0); cam.updateMatrixWorld(true);
    const sr = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).normalize();
    expect(sr.x).toBeCloseTo(1, 6);
    expect(Math.abs(sr.z)).toBeLessThan(1e-6);
    // Манекен смотрит в +Z, камера стоит в +Z → видим ЛИЦО, и своя левая сторона (+X) видна справа на экране.
    expect(SRC_ED, 'манекен смотрит в +Z — это записано у кадрирования').toMatch(/манекен смотрит в \+Z/);
  });
});

// ── 3. ЗНАК БОКОВОЙ → КАРТА, КЛИП, ПРЕСЕТ, ЯЧЕЙКА ────────────────────────────────────────────────

/** Имена клипов, которые попросит бленд при этом знаке боковой скорости. */
function clipNamesFor(latPlusX: boolean): string[] {
  const seen: string[] = [];
  blendLocoPose<string>(
    (dir: LocoDir, fast: boolean) => { const n = `${fast ? 'run' : 'walk'}_${dir}`; seen.push(n); return n; },
    { sb: 1, st: 1, bt: 0 }, latPlusX, (a) => a,
  );
  return seen;
}

describe('знак боковой скорости ведёт ВСЮ цепочку — и на +X, и на −X', () => {
  const CASES = [
    { side: 'СВОЯ ЛЕВАЯ', lat: +1, clip: 'run_strafe_R', preset: 'run_strafe_R', cell: 2, map: STRAFE_R, sfx: '@sr' },
    { side: 'СВОЯ ПРАВАЯ', lat: -1, clip: 'run_strafe_L', preset: 'run_strafe_L', cell: 6, map: STRAFE_L, sfx: '@sl' },
  ] as const;

  for (const c of CASES) {
    it(`⭐⭐ ${c.side} (боковая ${c.lat > 0 ? '+' : '−'}, ось ${c.lat > 0 ? '+X' : '−X'}) → клип ${c.clip}, колонка ${c.sfx}, ячейка ${c.cell}`, () => {
      // КЛИП (мутация B).
      expect(clipNamesFor(c.lat >= 0)).toContain(c.clip);
      // ПРЕСЕТ СЪЁМА: клип с этим именем снимается с боковой ТОГО ЖЕ знака — и на ходьбе, и на беге (мутация D).
      for (const nm of [c.preset, c.preset.replace('run_', 'walk_')]) {
        const spec = GAIT_PRESETS.find((s) => s.name === nm)!;
        expect(spec, nm).toBeTruthy();
        expect(Math.sign(spec.vx), `${nm}.vx`).toBe(Math.sign(c.lat));
        expect(spec.vz, `${nm}.vz`).toBe(0);
      }
      // КАРТА НАСТРОЕК (мутация C): доля именно этой стороны на чистом боку равна 1.
      const sr = strafeSide(c.lat);
      const st = strafeMix(0, c.lat);
      const m: LocoMix = { sb: 1, st, stR: st * sr, stL: st * (1 - sr), bt: 0, ct: 0 };
      expect(st).toBe(1);
      expect(c.lat > 0 ? m.stR : m.stL, 'своя доля').toBe(1);
      expect(c.lat > 0 ? m.stL : m.stR, 'чужая доля').toBe(0);
      c.map['stepRun'] = 77;
      expect(locoVal('stepWalk', 'stepRun', 10, 20, 0, m), 'играет своя карта').toBe(77);
      // Обратная сторона той же монеты: у ЧУЖОЙ карты тот же ключ не читается.
      const other = c.lat > 0 ? STRAFE_L : STRAFE_R;
      other['stepRun'] = 999;
      expect(locoVal('stepWalk', 'stepRun', 10, 20, 0, m)).toBe(77);
      // СУФФИКС ПАРЫ Л/П той же карты.
      ASYM[`stepRun${c.sfx}`] = [11, 22];
      expect(strafeSideOf('stepRun', c.lat > 0, 0)).toBe(11);
      expect(strafeSideOf('stepRun', c.lat > 0, 1)).toBe(22);
    });
  }

  it('⭐⭐ ЯЧЕЙКА ПЛАНТА ЧИТАЕТСЯ ПО ТОМУ ЖЕ ЗНАКУ: +X → 2, −X → 6 (замер по стопам; мутация E валит)', () => {
    const LAT = 26;                       // боковой офсет планта, ед. — заведомо больше шума походки
    const grid = (cell: number): ((p: PosePlayer) => void) => (p: PosePlayer): void => {
      const g: PlantGrid = p.plant;
      for (const sp of ['walk', 'run'] as const) g[sp][cell] = { l: [0, LAT], r: [0, LAT], lVia: [], rVia: [] };
    };
    const SEC = 3;
    for (const [lat, own, foreign] of [[+120, 2, 6], [-120, 6, 2]] as const) {
      const base = feetAfter(lat, 0, SEC);
      const hit = feetAfter(lat, 0, SEC, grid(own));
      const miss = feetAfter(lat, 0, SEC, grid(foreign));
      const dHit = Math.abs(hit.l - base.l) + Math.abs(hit.r - base.r);
      const dMiss = Math.abs(miss.l - base.l) + Math.abs(miss.r - base.r);
      expect(dHit, `боковая ${lat}: ячейка ${own} читается`).toBeGreaterThan(LAT / 2);
      expect(dMiss, `боковая ${lat}: ячейка ${foreign} НЕ читается`).toBeLessThan(1e-6);
    }
  });

  it('⭐ ЯЧЕЙКИ СЕТКИ — РОВНО ПО ЭТОЙ ФОРМУЛЕ (шов в `poseRuntime`, чтобы замер выше не отвязался от кода)', () => {
    expect(SRC_RT).toMatch(/let ang = Math\.atan2\(latC, fwdC\) \/ DIR_STEP;/);
    const idx = (fwd: number, lat: number): number => ((Math.round(Math.atan2(lat, fwd) / (Math.PI / 4)) % 8) + 8) % 8;
    expect(idx(1, 0), 'вперёд').toBe(0);
    expect(idx(0, 1), '+X').toBe(2);
    expect(idx(-1, 0), 'назад').toBe(4);
    expect(idx(0, -1), '−X').toBe(6);
  });
});

// ── 4. ИНДЕКС НОГИ В ПАРЕ Л/П ────────────────────────────────────────────────────────────────────

describe('пара Л/П у ползунка — это НОГА, и индекс 0 — левая (кость `LeftUpperLeg` на +X)', () => {
  it('⭐⭐ ШИРЕ ПОСТАВЛЕННАЯ СТОРОНА 0 РАЗВОДИТ ИМЕННО ЛЕВУЮ СТОПУ (мутация F валит)', () => {
    const wide = (i: 0 | 1) => (): void => { ASYM['stanceWidth'] = i === 0 ? [22, 0] : [0, 22]; ASYM['stanceWidthRun'] = i === 0 ? [22, 0] : [0, 22]; };
    const a = feetAfter(0, 90, 3, wide(0)); clearCols();
    const b = feetAfter(0, 90, 3, wide(1)); clearCols();
    expect(a.l, 'индекс 0 развёл ЛЕВУЮ (на +X)').toBeGreaterThan(b.l);
    expect(b.r, 'индекс 1 развёл ПРАВУЮ (на −X)').toBeLessThan(a.r);
  });
});

// ── 5. ПРОВОДКА РЕДАКТОРА ────────────────────────────────────────────────────────────────────────

describe('⭐⭐ РЕДАКТОР: ярлык «Л» = СВОЯ ЛЕВАЯ сторона персонажа на всех звеньях сразу', () => {
  it('превью: «Л» → боковая +X и ячейка 2, «П» → −X и ячейка 6 (мутация H валит)', () => {
    const i = SRC_ED.indexOf('const applyView = (): void => {');
    expect(i).toBeGreaterThan(0);
    const body = SRC_ED.slice(i, SRC_ED.indexOf('\n  };', i));
    expect(body).toMatch(/const ownRight = gaitStrSide === 'R';/);
    expect(body).toMatch(/locoVx = ownRight \? -v : v; locoVz = 0; plantDirSel = ownRight \? 6 : 2;/);
    // «обе» стоит на той же стороне, что и до 20.09 (+X, ячейка 2) — ячейка автора никуда не переехала.
    expect(body, '«обе» не уводит ячейку планта').not.toMatch(/gaitStrSide === 'both' \? 6/);
    expect(SRC_ED, 'переключатель стороны зовёт тот же `applyView`').toMatch(/const setStrSide = \(s: 'both' \| 'L' \| 'R'\): void => \{ gaitStrSide = s; applyView\(\); \};/);
  });

  it('колонка и суффикс: «Л» → `STRAFE_R`/`@sr`, «П» → `STRAFE_L`/`@sl` — и это ОДНИ И ТЕ ЖЕ объекты, что читает игра', () => {
    expect(SRC_ED).toMatch(/const gaitStrafeOwnL = STRAFE_R;/);
    expect(SRC_ED).toMatch(/const gaitStrafeOwnR = STRAFE_L;/);
    expect(SRC_ED).toMatch(/: gaitStrSide === 'L' \? gaitStrafeOwnL : gaitStrSide === 'R' \? gaitStrafeOwnR : gaitStrafe\)/);
    expect(SRC_ED).toMatch(/: gaitStrSide === 'L' \? '@sr' : gaitStrSide === 'R' \? '@sl' : '@s'\)/);
    // Кнопка сброса ходит по тем же двум швам, поэтому её область совпадает со стороной автоматически,
    // а подпись зовёт стороны теми же буквами.
    expect(SRC_ED, 'сброс берёт колонку из общего шва').toMatch(/column: onCol \? colMapOf\(gaitDir\) : null,/);
    expect(SRC_ED, 'и суффикс оттуда же').toMatch(/sfx: onCol \? colSfxOf\(gaitDir\) : '',/);
    expect(SRC_ED, 'подпись сброса').toMatch(/gaitStrSide === 'L' \? 'СТРАЙФ Л' : gaitStrSide === 'R' \? 'СТРАЙФ П' : 'СТРАЙФ'\)/);
  });

  it('⚠ РАЗДЕЛЫ `pe_gait` НЕ ПЕРЕИМЕНОВАНЫ: `strafeR` ↔ `STRAFE_R`, `strafeL` ↔ `STRAFE_L` — данные автора на месте', () => {
    expect(SRC_ED).toMatch(/const strafeR: NumRec = \{ \.\.\.STRAFE_R \};/);
    expect(SRC_ED).toMatch(/const strafeL: NumRec = \{ \.\.\.STRAFE_L \};/);
    expect(SRC_ED).toMatch(/for \(const \[k, v\] of Object\.entries\(c\?\.strafeR \?\? \{\}\)\) if \(typeof v === 'number'\) STRAFE_R\[k\] = v;/);
    expect(SRC_ED).toMatch(/for \(const \[k, v\] of Object\.entries\(c\?\.strafeL \?\? \{\}\)\) if \(typeof v === 'number'\) STRAFE_L\[k\] = v;/);
  });

  it('имена ячеек и буквы на паде — по анатомии: ячейка 2 = «влево», +X нарисован справа', () => {
    expect(SRC_ED).toMatch(/const DIR8 = \['вперёд', 'вп-влево', 'влево', 'назад-влево', 'назад', 'назад-вправо', 'вправо', 'вп-вправо'\];/);
    expect(SRC_ED, "'Л' — у правого края пада (там +X)").toMatch(/fillText\('Л', PAD - PADM - 8, PAD \/ 2 - 3\); ctx\.fillText\('П', PADM \+ 2, PAD \/ 2 - 3\);/);
  });

  it('⭐ ЗЕРКАЛО НАЗВАНО ВСЛУХ: автор видит строку про то, что манекен смотрит на него', () => {
    expect(SRC_ED).toMatch(/Манекен смотрит НА ТЕБЯ/);
  });

  it('клипы НЕ переименованы — набор съёма остаётся `*_strafe_L` / `*_strafe_R`', () => {
    expect(GAIT_PRESETS.map((s) => s.name)).toEqual([
      'idle', 'walk_fwd', 'walk_back', 'walk_strafe_L', 'walk_strafe_R',
      'run_fwd', 'run_back', 'run_strafe_L', 'run_strafe_R',
    ]);
  });
});

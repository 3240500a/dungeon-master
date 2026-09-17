import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * ПРОВОДКА ПРАВКИ КАДРА В `pose-editor.ts` — сторож СТРУКТУРЫ (как `onionOwner.test.ts`).
 *
 * Поведение (таз ключа, оседание призрака, шов цикла, каналы ключа, взгляд) проверяет `frameEdit.test.ts` на чистых
 * функциях. Здесь — что редактор зовёт ИМЕННО их и в нужных местах: кадровый цикл редактора тянет DOM и физику,
 * поведенческий тест там невозможен, а каждый из этих регрессов уже случался ровно так — копией кода рядом.
 */
const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'pose-editor.ts'), 'utf8');

/** Тело функции/стрелки по фигурным скобкам — от заголовка до парной `}`. */
function bodyAt(from: number, what: string): string {
  expect(from, `${what} должна существовать`).toBeGreaterThanOrEqual(0);
  let i = SRC.indexOf('{', from), depth = 0;
  for (; i < SRC.length; i++) { if (SRC[i] === '{') depth++; else if (SRC[i] === '}' && --depth === 0) break; }
  return SRC.slice(from, i + 1);
}
const fn = (name: string): string => { const m = new RegExp(`function ${name}\\([^)]*\\)[^{]*\\{`).exec(SRC); return bodyAt(m ? m.index : -1, `функция ${name}`); };

describe('призраки соседних кадров', () => {
  it('⭐ applyPoseTo НЕ берёт таз с манекена — поза ключа ставится общим poseRig', () => {
    const b = fn('applyPoseTo');
    expect(b, 'таз призрака копировался с манекена текущего кадра — стопы соседа уезжали на разницу __hipsD')
      .not.toMatch(/human\.(bones\.get\(['"]Hips['"]\)|hips)/);
    expect(b).toMatch(/poseRig\(h, p\)/);
    expect(b, 'корень — как после goFrame').toMatch(/h\.root\.position\.set\(0, 0, 0\)/);
  });
  it('заземляется, только когда видно заземлённое тело, и так же, как оседает физ-призрак', () => {
    const b = fn('applyPoseTo');
    expect(b).toMatch(/if \(!groundedView\(\)\) return/);
    expect(b).toMatch(/h\.footLift = physFootLift/);
    expect(b).toMatch(/settleLikePhysGhost\(h, GAIT\.gndLag\)/);
  });
  it('манекен ставит позу ключа тем же poseRig', () => {
    expect(fn('applyPose')).toMatch(/poseRig\(human, p\)/);
  });
  it('условие «видно заземлённое тело» — то же, что у рендера: физика, призрак, заземление стоп', () => {
    const m = /const groundedView = \(\): boolean => ([^;]+);/.exec(SRC);
    expect(m).toBeTruthy();
    for (const part of ['physOn', 'ghostHuman', 'footGround']) expect(m![1]).toContain(part);
    expect(m![1], '«манекен на полу» двигает только оверлей скелета').not.toContain('manGroundView');
  });
  it('призраки пересчитываются при смене физики и тумблере заземления', () => {
    expect(fn('setPhys')).toMatch(/updateOnion\(\)/);
    const line = SRC.split('\n').find((l) => l.includes("'заземл. стоп: вкл'"));
    expect(line).toBeTruthy();
    expect(line!).toMatch(/updateOnion\(\)/);
  });
});

describe('запись кадра', () => {
  it('⭐ один шов: кнопка и клавиша идут через recordFrame → writeKeyPose, прямой записи readPoseFull в ключ нет', () => {
    expect(fn('recordFrame')).toMatch(/writeKeyPose\(c, frameIdx, readPoseFull\(\)\)/);
    expect(SRC, 'вторая копия записи кадра').not.toMatch(/\.pose = readPoseFull\(\)/);
    expect(SRC, 'кнопка «записать кадр» зовёт тот же recordFrame').toMatch(/'◉ записать кадр', \(\) => recordFrame\(\)\)/);
  });
  it('поза, показанная превью между ключами, в ключ не пишется', () => {
    // Отказ ДО записи. Было `/offKeyTime\(c\)[\s\S]*return/` — ревью-мутация `if (off !== null && false)` его проходила.
    expect(fn('recordFrame')).toMatch(/const off = offKeyTime\(c\);\s*if \(off !== null\) \{ alert\(offKeyHint\(c, off\)\); return; \}\s*histLib\('записать кадр'/);
    expect(fn('offKeyTime'), 'гейт — чистый previewOffKey (тест в frameEdit.test.ts)').toMatch(/return previewOffKey\(c, frameIdx, previewT\)/);
    expect(fn('preview')).toMatch(/if \(!seg\) return;\s*previewT = time;/);
    expect(fn('goFrame')).toMatch(/previewT = null/);
    const scrub = bodyAt(SRC.indexOf('onScrub: (t) =>'), 'onScrub');
    expect(scrub, 'клик по линейке на ключ = выбор кадра').toMatch(/keyAtTime\(c, t\)[\s\S]*if \(c && k >= 0\) \{ playT = c\.keys\[k\]!\.t; goFrame\(k\); return; \}/);
  });
  it('проигрывание, вставшее на ключ, выбирает его (и кнопкой ⏸, и автостопом в конце клипа)', () => {
    // Ревью-мутация «инверсия `k >= 0`» проходила прежние тесты.
    expect(fn('settlePlayStop')).toMatch(/const k = keyAtTime\(c, playT\);\s*if \(k >= 0\) goFrame\(k\); else refreshPose\(\);/);
    expect(SRC.match(/if \(!playing\) \{ if \(ikOn\) captureRig\(\); settlePlayStop\(\); \}/g)?.length, 'playBtn + автостоп в loop').toBe(2);
  });
  it('новый клип из показанной позы не наследует превью прошлого клипа', () => {
    const line = SRC.split('\n').find((l) => l.includes("histLib('новый клип'"));
    expect(line).toBeTruthy();
    expect(line!).toMatch(/frameIdx = 0; previewT = null;/);
  });
  it('заземление в записанной позе — только при видимом заземлённом теле (Ф20.5)', () => {
    expect(fn('readPoseFull')).toMatch(/groundedView\(\) \? groundManikin\(/);
  });
  it('взгляд переснимается при замене позы, а не тянет новый кадр к старой точке', () => {
    expect(fn('onPoseReplaced')).toMatch(/gazeRecapture\(\)/);
    const g = fn('gazeRecapture');
    expect(g).toMatch(/faceTarget\(human, 'Head', GAZE_FWD, GAZE_DIST, gazeTarget\)/);
    expect(g).toMatch(/captureAimOffsets\(/);
  });
});

describe('хват', () => {
  it('lerpPose кладёт хват, как applyPose (ломаные клипы не выпрямляют ладонь)', () => {
    expect(fn('lerpPose')).toMatch(/applyGripOver\(\);\s*onPoseReplaced\(\);\s*\}$/);
  });
  it('контент редактора отдаёт ЖИВОЙ хват тем же резолвером, без кэша', () => {
    const b = bodyAt(SRC.indexOf('const editorContent: PoseContent = {'), 'editorContent');
    expect(b).toMatch(/gripPose: \(w, axes, clipName\) => resolveGripPose\(gripCfg, curCharId, w, axes, clipName\)/);
  });
  it('запекатель походки не пишет фаланги', () => {
    expect(SRC).toMatch(/readPose: bakeReadPose\(human\)/);
    expect(SRC).not.toMatch(/readPose: defaultReadPose\(human\)/);
    expect(fn('bakeReadPose')).toMatch(/dropFingers\(read\(\)\)/);
    expect(fn('dropFingers')).toMatch(/isHandBone\(nm\)\) delete p\[nm\]/);
  });
  it('публикация вырезает фаланги ДО впекания хвата (нули на сервере заменяются)', () => {
    const b = bodyAt(SRC.indexOf('setPublishPrepare('), 'setPublishPrepare');
    expect(b).toMatch(/pose: dropFingers\(clonePose\(k\.pose\)\)[\s\S]*resolveGripPose/);
  });
});

describe('скорости и сглаживание таза (общий контракт с планировщиком и клипами)', () => {
  it('темп шага превью — по скорости самого клипа', () => {
    expect(SRC).toMatch(/bakedLocoSpeed\(c\) \/ Math\.max\(1, GAIT\.speedRun\)/);
    expect(SRC).not.toMatch(/bakedLocoSpeed\(c\.name\)/);
  });
  it('ползунок «сглаж. высоты таза» на вкладке Бег и оба ключа сохраняются в pe_gait', () => {
    expect(SRC).toContain("row2('сглаж. высоты таза, u/с', GAITo, 'bobSlew', 'bobSlewRun', 0, 120, 1)");
    const keys = /const GAIT_KEYS = \[([\s\S]*?)\] as const;/.exec(SRC)![1]!;
    expect(keys).toContain("'bobSlew'");
    expect(keys).toContain("'bobSlewRun'");
  });
});

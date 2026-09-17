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

/**
 * ⭐ ПРЕДПРОСМОТР КОРНЯ — галки «корень: поворот / смещение» (17.09.2026). Поведение чистых частей (сэмплер = игра, вид
 * не течёт в запись, призраки и физ-призрак на месте, перенос правки) — `rootPreview.test.ts`. Здесь — что редактор держит
 * корень ВНЕ позы и везде, где пишутся мировые данные, ставит его в ноль.
 */
describe('⭐ предпросмотр корня (галки «корень: поворот / смещение»)', () => {
  it('манекен висит под шарниром корня, а не в сцене', () => {
    expect(SRC, 'манекен прямо в сцене — шарнир его не повернёт').not.toMatch(/scene\.(add|remove)\(human\.root\)/);
    expect(SRC.match(/rootTurn\.add\(human\.root\)/g)?.length, 'applyChar + rebuildManikin').toBe(2);
    expect(SRC.match(/rootTurn\.remove\(human\.root\)/g)?.length).toBe(2);
  });
  it('⭐ запись кадра и чтение/постановка позы о показе корня не знают', () => {
    for (const f of ['readPoseFull', 'recordFrame', 'applyPose', 'lerpPose']) expect(fn(f), f).not.toMatch(/rootTurn|rootShown|rootView|RootView/);
    expect(fn('snapshot')).toMatch(/pose: readPoseFull\(\)/);
    // шарнир ставят ровно два места: `putRootTurn` (через него `syncRootView` и сэмплинг траектории)
    expect(SRC.match(/placeRootView\(rootTurn/g)?.length).toBe(1);
    expect(SRC).not.toMatch(/rootTurn\.(rotation|position|quaternion)\.(set|copy)/);
    expect(fn('putRootTurn')).toMatch(/placeRootView\(rootTurn, v\)/);
  });
  it('корень — на том же времени, что поза: превью, переход на кадр, перерисовка, цикл кадра', () => {
    expect(fn('preview'), 'из цикла кадра корень отставал бы от проигрывания').toMatch(/else lerpPose\(seg\.a\.pose, seg\.b\.pose, seg\.u\);\s*syncRootView\(c\);[^\n]*\s*\}$/);
    expect(fn('preview'), 'ранний return обошёл бы корень').not.toMatch(/applyPose\([^)]*\)\); return;|\); return; \}/);
    expect(fn('goFrame')).toMatch(/previewT = null; \}[^\n]*\n\s*syncRootView\(\);/);
    expect(fn('refreshAll')).toMatch(/^function refreshAll\(\): void \{ syncRootView\(\);/);
    expect(fn('loop'), 'клип цикла — тот же, что увидит корень: `curClip` второй раз не фильтрует библиотеку').toMatch(/last = now;\s*const c = curClip\(\);\s*syncRootView\(c\);/);
  });
  it('гейт: только «Анимация», не в превью бега/поворотов, не в тесте, не под удержанием; время — превью или ключ', () => {
    const g = fn('rootViewGate');
    for (const part of ['rootViewHold === 0', "tab === 'anim'", '!locoOn', '!testTab.active']) expect(g).toContain(part);
    const n = fn('rootViewNow');
    expect(n).toMatch(/const t = clip \? rootViewTime\(clip, frameIdx, previewT\) : null;/);
    expect(n).toMatch(/rootPreviewAt\(clip, t, rootViewWant\(\), _rootNext\)/);
  });
  it('⭐ кадр цикла без аллокаций (ревью 17.09): без галок — ни клипа, ни сэмпла; с галкой — только каналы корня в общий объект', () => {
    const n = fn('rootViewNow');
    // выход ДО `curClip` и сэмпла — `syncRootView` зовётся на каждом кадре цикла и ещё раз из `preview`
    expect(n).toMatch(/\{\s*if \(\(!rootYawOn && !rootPosOn\) \|\| !rootViewGate\(\)\) return ROOT_VIEW_ZERO;\s*const clip = c === undefined \? curClip\(\) : c;/);
    expect(n, 'объект на кадр').not.toMatch(/\{ \.\.\.ROOT_VIEW_ZERO \}|\{ yaw:/);
    for (const f of ['rootViewNow', 'rootViewWant', 'syncRootView']) expect(fn(f), `${f}: скан всех ключей клипа на кадр`).not.toMatch(/clipRootChannels|clipPoseAt/);
    expect(fn('rootViewWant')).toMatch(/_rootWant\.yaw = rootYawOn; _rootWant\.pos = rootPosOn; return _rootWant;/);
    const s = fn('syncRootView');
    expect(s).toMatch(/rootViewDelta\(rootShown, next, _rootDelta\)/);
    expect(s).toMatch(/copyRootView\(rootShown, next\); putRootTurn\(rootShown\);/);
    expect(SRC, 'показанный корень — один объект, переписывается на месте').toMatch(/const rootShown: RootView = \{ \.\.\.ROOT_VIEW_ZERO \};/);
  });
  it('⭐ мировые данные пишутся с корнем в нуле: запекание физики, подгонка физ-тел, набор походки, экспорт GLB', () => {
    expect(fn('bakeCurrentClip'), 'снятие запечённой позы — под удержанием').toMatch(/withRootViewOff\([\s\S]*rag\.readBakedPose\(\)[\s\S]*return out;\s*\}\);\s*histLib/);
    expect(fn('fitPhysToBones')).toMatch(/\{ withRootViewOff\(fitPhysToBonesAt0\); \}/);
    expect(SRC).toMatch(/function fitPhysToMesh\([^\n]*\{ return withRootViewOff\(\(\) => fitPhysToMeshAt0\(inflate, pct\)\); \}/);
    expect(SRC.match(/fitPhysToBonesAt0/g)?.length, 'голой подгонки мимо обёртки нет').toBe(2);
    expect(SRC.match(/fitPhysToMeshAt0/g)?.length).toBe(2);
    expect(SRC).toMatch(/const out = withRootViewOff\(\(\) => \[\s*\.\.\.bakeGaitSet\(/);
    expect(SRC).toMatch(/rootViewHold\+\+; syncRootView\(\); if \(tgt\) modelsTab\.drive\(human\);\s*const target = tgt/);
    expect(SRC).toMatch(/\.finally\(\(\) => \{ rootViewHold--;/);
    expect(SRC.match(/rootViewHold--/g)?.length, 'удержание снимают только `withRootViewOff` и `finally` экспорта').toBe(2);
    expect(SRC, 'удержание снимается и при исключении').toMatch(/function withRootViewOff<T>\(fn: \(\) => T\): T \{\s*rootViewHold\+\+; syncRootView\(\);\s*try \{ return fn\(\); \} finally \{ rootViewHold--; syncRootView\(\); \}/);
  });
  it('физ-призрак: цель с рыском корня — и моторам, и бленду призрака; на скачке — на позу', () => {
    const b = fn('stepPhysics');
    expect(b).toMatch(/const target = turnHipsTarget\(human\.readPose\(\), rootShown\.yaw\);\s*ragdoll\.setPoseTarget\(target\);/);
    expect(b).toMatch(/rMatch > 0\.001 \? target : null/);
    expect(b.match(/human\.readPose\(\)/g)?.length, 'голая поза манекена в бленд — призрак довернулся бы на ~15%').toBe(1);
    expect(b).toMatch(/if \(rootViewJump\(physRootAt, rootShown\) && !physDead\) ragdoll\.snapToPose\(\);\s*copyRootView\(physRootAt, rootShown\);/);
    expect(SRC, '⚠ ссылка на `rootShown` (он переписывается на месте) — скачок сравнивал бы корень с самим собой, и кукла не вставала бы на позу').not.toMatch(/physRootAt = rootShown/);
    expect(SRC, 'память физ-призрака — свой объект, не ссылка').toMatch(/const physRootAt: RootView = \{ \.\.\.ROOT_VIEW_ZERO \};/);
  });
  it('призрак соседнего кадра — на СВОЁМ корне, до раннего выхода без заземления', () => {
    expect(fn('applyPoseTo')).toMatch(/h\.root\.position\.set\(0, 0, 0\);[\s\S]*composeRootView\(h\.root, rootViewGate\(\) \? rootViewOfPose\(p, rootViewWant\(\)\) : ROOT_VIEW_ZERO\);\s*h\.root\.updateMatrixWorld\(true\);\s*if \(!groundedView\(\)\) return/);
  });
  it('траектория — с корнем каждого сэмпла, шарнир возвращается на показанный корень', () => {
    const b = fn('updateTrajectory');
    expect(b).toMatch(/const want = rootViewGate\(\) \? rootViewWant\(\) : null;/);
    expect(b).toMatch(/poseRig\(human, pose\);[^\n]*\n\s*if \(want\) putRootTurn\(rootPreviewAt\(c, smp\.t, want\)\);/);
    expect(b).toMatch(/human\.hips\.position\.copy\(snapHip\); putRootTurn\(rootShown\);/);
  });
  it('мир → локальный таз: драг таза, ручка вращения, кламп по пинам, баланс', () => {
    expect(fn('moveHips')).toMatch(/rig\.hipsPos\.add\(rootLocalDir\(delta\.clone\(\)\)\);[^\n]*e\.target\.add\(delta\)/);
    expect(fn('clampHipsToPins')).toMatch(/human\.hips\.position\.addScaledVector\(rootLocalDir\(r\.sub\(L\.goal\)/);
    expect(SRC).toMatch(/com: \(\) => \{ const \{ p \} = massCenter\(\); rootLocal\(p\); return/);
    expect(SRC, 'опора — в кадре персонажа (у `supportRect` в типе возврата скобки — `fn` его не режет)').toMatch(/function supportRect\(\)[\s\S]{0,400}const p = rootLocal\(f\.getWorldPosition\(V\(\)\)\);/);
    expect(SRC.match(/rootQuatToWorld\(rig\.hipsHandle\.quaternion\.copy\(rig\.hipsQuat\), rootShown\)/g)?.length, 'клик по ручке, отпускание Shift, кнопка «таз: вращать»').toBe(3);
    expect(SRC).toMatch(/else rootQuatToLocal\(rig\.hipsQuat\.copy\(rig\.hipsHandle\.quaternion\), rootShown\);/);
    expect(SRC.match(/rig\.hipsHandle\.quaternion\.copy\(rig\.hipsQuat\)/g)?.length, 'мировой поворот ручки мимо перевода').toBe(3);
    expect(SRC.match(/rig\.hipsQuat\.copy\(rig\.hipsHandle\.quaternion\)/g)?.length).toBe(1);
    // ⚠ баланс: центр масс и опора уже в кадре персонажа — сдвиг таза пишется в `hips.position` КАК ЕСТЬ, второй перевод увёл бы его
    expect(SRC).toMatch(/move: \(dx, dz\) => \{ human\.hips\.position\.x \+= dx; human\.hips\.position\.z \+= dz; human\.root\.updateMatrixWorld\(true\); \},/);
  });
  it('⭐ мир ↔ кадр персонажа — ТОЛЬКО через чистые функции `frameEdit` (их математику меряет `rootPreview.test.ts` против three)', () => {
    expect(fn('rootLocal')).toMatch(/\{ return rootPointToLocal\(v, rootShown\); \}/);
    expect(fn('rootWorld')).toMatch(/\{ return rootPointToWorld\(v, rootShown\); \}/);
    expect(fn('rootLocalDir')).toMatch(/\{ return rootDirToLocal\(v, rootShown\); \}/);
    expect(SRC, 'своя формула рядом (матрица/кватернион шарнира)').not.toMatch(/rootTurn\.(quaternion|matrixWorld|matrix)\b/);
    expect(fn('setGaze'), 'точка взгляда — «вперёд» персонажа').toMatch(/gazeTarget\.copy\(hd\.getWorldPosition\(V\(\)\)\)\.add\(rootDirToWorld\(new THREE\.Vector3\(0, 0, GAZE_DIST\), rootShown\)\);/);
  });
  it('⭐ мировое состояние правки едет за корнем; undo хранит его в кадре персонажа', () => {
    const s = fn('syncRootView');
    expect(s).toMatch(/if \(sameRootView\(next, rootShown\)\) return;\s*const d = rootViewDelta\(rootShown, next, _rootDelta\);/);
    for (const part of ['e.target.applyMatrix4(d.m)', 'e.prev.applyMatrix4(d.m)', 'e.pole.applyQuaternion(d.q)', 'e.footQuat.premultiply(d.q)', 'gazeTarget.applyMatrix4(d.m)', 'rig.hipsHandle.quaternion.premultiply(d.q)']) expect(s).toContain(part);
    const sn = fn('snapshot'), rs = fn('restore');
    expect(sn).toMatch(/t: rootLocal\(e\.target\.clone\(\)\)/);
    expect(sn).toMatch(/fq: rootQuatToLocal\(e\.footQuat\.clone\(\), rootShown\)/);
    expect(sn).toMatch(/pl: rootDirToLocal\(e\.pole\.clone\(\), rootShown\)/);
    expect(rs).toMatch(/rootWorld\(e\.target\.fromArray\(d\.t\)\)/);
    expect(rs).toMatch(/rootQuatToWorld\(e\.footQuat\.fromArray\(d\.fq\), rootShown\)/);
    expect(rs).toMatch(/rootDirToWorld\(e\.pole\.fromArray\(d\.pl\), rootShown\)/);
  });
  it('галки — личные настройки pe_prefs (дефолт выкл), только у клипов с каналами корня', () => {
    expect(SRC).toMatch(/let rootYawOn = getPref\('rootYawView', false\), rootPosOn = getPref\('rootPosView', false\);/);
    expect(SRC).toMatch(/const ch = clipRootChannels\(c\);\s*if \(ch\.yaw \|\| ch\.pos\) \{/);
    expect(SRC).toMatch(/if \(ch\.yaw\) rr\.append\(chk\('корень: поворот', rootYawOn, \(v\) => \{ rootYawOn = v; setPref\('rootYawView', v\); \}/);
    expect(SRC).toMatch(/if \(ch\.pos\) rr\.append\(chk\('корень: смещение', rootPosOn, \(v\) => \{ rootPosOn = v; setPref\('rootPosView', v\); \}/);
    expect(SRC).toMatch(/cb\.onchange = \(\) => \{ set\(cb\.checked\); syncRootView\(\); refreshAll\(\); \}/);
  });
  it('⚠ таз клипа поворота: где показ ≠ игра, свиток клипа предупреждает цифрой, и подсказка «как в игре» не обещает', () => {
    expect(SRC).toMatch(/if \(ch\.yaw && TURN_NAMES\.includes\(c\.name\)\) \{\s*const g = clipTurnPelvisGap\(c, human\.hipsRest\);\s*if \(g\.deg > TURN_GAP_DEG \|\| g\.u > TURN_GAP_U\) \{/);
    expect(SRC).toMatch(/hn\.textContent = `⚠ в игре таз этого поворота ляжет иначе: до \$\{g\.deg\.toFixed\(0\)\}° \/ \$\{g\.u\.toFixed\(1\)\}u`;\s*hn\.title = [\s\S]*?;\s*rr\.append\(hn\);/);
    const hint = /chk\('корень: поворот'[\s\S]*?\)\);/.exec(SRC)?.[0] ?? '';
    expect(hint).toContain('turnYawAt');
    expect(hint, 'обещание «как в игре» без оговорки — ровно то, что ревью поймало на тазе').not.toMatch(/как в игре/);
  });
  it('новый ключ и «из пред./след./середина» — корень и опора с таймлайна клипа, а не пусто и не от соседа', () => {
    expect(SRC).toMatch(/const pose = seedMotionChannels\(readPoseFull\(\), c, nt\);\s*c\.keys\.splice\(insAt, 0, \{ pose, t: nt \}\)/);
    expect(SRC).toMatch(/kk\.pose = seedMotionChannels\(get\(\), c, kk\.t\)/);
  });
  it('меш модели ведётся МИРОВЫМ корнем манекена (`poseModelsTab.driveAsm`)', () => {
    const M = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'poseModelsTab.ts'), 'utf8');
    const m = /function driveAsm\([^)]*\): void \{[\s\S]*?\n {2}\}/.exec(M);
    expect(m).toBeTruthy();
    const b = m![0];
    expect(b).toMatch(/source\.root\.updateWorldMatrix\(true, false\);\s*source\.root\.matrixWorld\.decompose\(_wp, asmSrc\.root\.quaternion, _ws\);\s*asmSrc\.root\.position\.copy\(_wp\);/);
    expect(b, 'локальная копия корня оставляла меш на месте').not.toMatch(/asmSrc\.root\.position\.copy\(source\.root\.position\)/);
    expect(b.indexOf('matrixWorld.decompose'), 'после копии поворотов: кость Root перетёрла бы мировой корень локальным').toBeGreaterThan(b.indexOf('tb.rotation.copy(sb.rotation)'));
  });
});

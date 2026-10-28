/**
 * ПРОДЮСЕР И СТОРОЖ эталона ОКОН ЗАБЕГА v2 И КАМЕРЫ для Unity-клиента (U5b): карта забега (M), алтарь у портала (биом, шаблон,
 * модификаторы, тиры с замками, мощь героя, арена), вопрос голосования, окно смерти, наблюдение за союзником (Tab), камера из
 * `balance.camera`, затухание стен между камерой и героем.
 *
 * Unity — основной клиент, веб — источник истины по правилам. Настоящими функциями веба считаются: `voteQuestion`, `DeathWindow`,
 * `cameraCfg`/`camElevation`/`placeCamera`/`camZoom`/`camDir`, `effectiveLevel`/`carriedGear`/`floorMonsterLevel`/`altarModifiers`/
 * `isDifficultyUnlocked`, подписи и цвета узлов (`runLabels`), планы `generateRunPlan`. Раскладка карты (`runMapPanel.ts`), модель алтаря
 * (`difficultyPanel.ts`), наблюдение (`online3d.ts`) и затухание стен (`env3d.ts`: лицо стены и формула шейдера) живут в замыканиях и DOM/
 * WebGL — здесь они повторены копией, и каждая копия СТОРОЖИТСЯ строкой исходника (`SRC`): правило поменяли — тест падает, пока копию,
 * эталон и порт Unity не обновят осознанно.
 *
 * ⚠ ЗАМКИ ТИРОВ — НА СИНТЕТИЧЕСКОМ КОНФИГЕ (`synAltarCfg` + сейвы `synLocked`/`synOpen`), а не на живых данных: в
 * `difficulties.json` сейчас включён ОДИН тир с порогом 0, поэтому в боевом конфиге запертых карточек не рождается вовсе
 * и эталон молча терял и их, и подписи «🔒 Пройди этаж N на «тир» (сейчас M)». Покрытие держат ассерты раздела
 * «покрытие» ниже — живые данные могут включать и выключать тиры, замки от этого больше не зависят.
 *
 * Эталон: `__golden__/unity_run_ui.json` → Unity `Assets/DM/UI/Tests/unity_run_ui_golden.json` (`tools/unity-check/golden_sync.py`),
 * проверка — `RunUiCheck`. Перезапись: `npx vitest run -u packages/client/src/modules/run/unityRunUiGolden.gen.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ConfigRegistry, Cell, defaultRunConfig, generateRunPlan, effectiveLevel, carriedGear, floorMonsterLevel, isDifficultyUnlocked,
  altarModifiers, openWaypoints, WAYPOINT_ENTRY_DEPTH, RUN_MOD_LIVE_STATS, type RunPlan, type SaveState,
} from '@dm/shared';
import { voteQuestion, type VoteStartFrame } from '../../ui/voteText.js';
import { DeathWindow, type DeathDock, type DeathView, type DiedFrame } from '../../ui/deathWindow.js';
import { RUN_NODE_COLOR, runNodeLabel, bossLadderText } from './runLabels.js';
import { LEGEND_TYPES, MAP_GEOM, runMapView } from './runMapLayout.js';
// ⭐⭐ Г8-3: раскладку ЦЕПИ МЕТОК на алтаре эталон ЗОВЁТ, а не копирует (как раскладку карты забега с Г5).
import { altarChainView, BOSS_RANK_MARK } from '../town/altarMapLayout.js';
import { cameraCfg, camElevation, placeCamera, camZoom, camDir } from '../../render3d/cameraRig.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(join(HERE, rel), 'utf8');
const ONLINE3D = read('../../render3d/online3d.ts');
const ENV3D = read('../../render3d/env3d.ts');
const RUNMAP = read('./runMapPanel.ts');

/** Строки исходников, повторённые ниже копией. Нет строки — правило веба поменялось: обновить копию, эталон и порт Unity. */
const SRC: [string, string][] = [
  // ⭐⭐ Г5: РАСКЛАДКУ КАРТЫ СТОРОЖИТЬ СТРОКАМИ БОЛЬШЕ НЕ НАДО — она в чистом `runMapLayout.ts`, и эталон ниже
  // зовёт ЕЁ ЖЕ (`runMapView`), а не копию. Остались строки, которые живут в самой панели (DOM): подпись «забега
  // нет», кнопка конца забега с её пояснением и список легенды.
  // ⚠ Строка «забега нет» сторожа не требует: с Г5 она живёт в раскладке (MAP_EMPTY в runMapLayout.ts), и эталон получает её оттуда же вызовом.
  [RUNMAP, "fin.append(button('Завершить забег (голосование)', () => { app.net.send({ t: 'finish' }); }, 'danger'));"],
  [RUNMAP, "'Жать у портала привала или у точки входа. Уход в город порталом забег ПАРКУЕТ — его можно продолжить с того же узла; «Завершить» снимает забег у всей пати, и следующий спуск начнётся с выбранной на алтаре метки.'));"],
  [RUNMAP, "const view = runMapView(run?.plan, run?.currentNodeId, access.portalsAt, access.contentCycle);"],
  // алтарь (difficultyPanel.ts)
  // ⭐⭐ Г8-4: СЕКЦИИ «Шаблон забега» БОЛЬШЕ НЕТ — забег один, выбирать нечего. Сторожим ИМЕННО ОТСУТСТВИЕ:
  // вернётся выбор — вернётся и возможность молча отменить боссов круга, с которой всё и началось.
  // ⭐⭐ 14.10 (Г3, В6): выбор стартовой МЕТКИ — те же чистые функции, что у сервера (`openWaypoints`), и уровень монстров метки `floorMonsterLevel`
  // ⭐⭐ Г8-3: вместо списка чипов — ЦЕПЬ МЕТОК сверху вниз. Раскладку сторожить строками не надо (она в чистом
  // `altarMapLayout.ts`, и эталон зовёт её же); сторожатся строки, которые живут в самой панели (DOM/SVG).
  // голосование и смерть: проводка 3D (online3d.ts)
  [ONLINE3D, 'function showVote(f: VoteStartFrame): void { if (voteBox) return; const q = voteQuestion(f, app.config, app.state?.save.difficultyProgress);'],
  [ONLINE3D, "app.net.on('voteUpdate', (f) => { const t = voteBox?.querySelector('.tally'); if (t) t.textContent = `${f.yes}/${f.total}`; });"],
  [ONLINE3D, "app.net.on('voteEnd', () => closeVote());"],
  [ONLINE3D, "{ wait: 'Ожидайте: пати спустится — там возродитесь.', spectate: 'Смотреть' });"],
  [ONLINE3D, "deathBox.querySelector('[data-a=\"spec\"]')?.addEventListener('click', () => deathWin.dismiss());"],
  // наблюдение за союзником (online3d.ts)
  [ONLINE3D, "if (e.key !== 'Tab' || !latest) return;"], [ONLINE3D, 'if (!me || me.alive) return;'],
  [ONLINE3D, 'const living = latest.players.filter((p) => p.id !== myId && p.alive);'], [ONLINE3D, 'if (living.length < 2) return;'],
  [ONLINE3D, 'const idx = living.findIndex((p) => p.id === spectateId);'], [ONLINE3D, 'spectateId = living[(idx + 1) % living.length]!.id;'],
  [ONLINE3D, 'if (!spectateId || !living.some((p) => p.id === spectateId)) spectateId = living[0]!.id;'],
  [ONLINE3D, "fx = tgt.x; fy = tgt.y; showSpectateHint(tgt.name || 'союзник');"],
  [ONLINE3D, '} else { fx = smoothX; fy = smoothZ; hideSpectateHint(); }'], [ONLINE3D, '} else { spectateId = null; hideSpectateHint(); }'],
  [ONLINE3D, 'spectHint.textContent = `💀 Наблюдаете за ${name} · Tab — сменить`;'],
  [ONLINE3D, 'if (!hasSmooth || Math.hypot(tX - smoothX, tZ - smoothZ) > 120) { smoothX = tX; smoothZ = tZ; hasSmooth = true; }'],
  [ONLINE3D, 'else if (mine.alive) { smoothX = tX; smoothZ = tZ; }'],
  [ONLINE3D, 'else { const k = 1 - Math.exp(-dt / 0.045); smoothX += (tX - smoothX) * k; smoothZ += (tZ - smoothZ) * k; }'],
  // камера: проводка (online3d.ts)
  [ONLINE3D, 'const orbit = { target: new THREE.Vector3(), dist: CAM.startDist };'],
  [ONLINE3D, "canvas.addEventListener('wheel', (e) => { e.preventDefault(); orbit.dist = camZoom(orbit.dist, e.deltaY, CAM); }, { passive: false });"],
  [ONLINE3D, 'orbit.dist = Math.min(CAM.maxDist, Math.max(CAM.minDist, orbit.dist));'],
  [ONLINE3D, 'placeCamera(camera, orbit.target, orbit.dist, CAM);'], [ONLINE3D, 'orbit.target.set(smoothX, 20, smoothZ);'],
  // затухание стен: параметры биома (online3d.ts) и шейдер / лицо стены (env3d.ts)
  [ONLINE3D, "const cfg = biomeId ? (app.config.get('environment') as EnvFade[] | undefined)?.find((e) => e.enabled && e.biomeId === biomeId) : undefined;"],
  [ONLINE3D, 'const f = cfg?.fade; if (!f) return;'],
  [ONLINE3D, 'wallFade.fade.set(f.start, f.end); wallFade.knee.set(f.kneeLow, f.kneeHigh); wallFade.faceYaw = f.faceYaw;'],
  [ONLINE3D, 'applyEnvFade(floor.biomeId);'],
  [ONLINE3D, 'wallFade.playerPos.set(smoothX, 20, smoothZ); wallFade.viewDir.set(smoothX - camera.position.x, smoothZ - camera.position.z).normalize();'],
  [ENV3D, 'fade: new THREE.Vector2(190, 460),'], [ENV3D, 'knee: new THREE.Vector2(20, 46),'],
  [ENV3D, 'const walk = (x: number, y: number): boolean => grid[y]?.[x] !== undefined && grid[y]![x] !== Cell.Wall;'],
  [ENV3D, 'const N4: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];'],
  [ENV3D, 'const N8: [number, number][] = [...N4, [1, 1], [1, -1], [-1, 1], [-1, -1]];'],
  [ENV3D, 'let fx = 0, fz = 0; for (const [dx, dy] of N4) if (walk(x + dx, y + dy)) { fx += dx; fz += dy; }'],
  [ENV3D, 'if (fx === 0 && fz === 0) for (const [dx, dy] of N8) if (walk(x + dx, y + dy)) { fx += dx; fz += dy; }'],
  [ENV3D, 'const len = Math.hypot(fx, fz) || 1; return [fx / len, fz / len];'],
  [ENV3D, 'vFaceDot = dot(aFacing, uViewDir);'],
  [ENV3D, "float near = ${facingGate ? 'smoothstep(0.0, 0.35, vFaceDot)' : '1.0'};"],
  [ENV3D, 'float top = smoothstep(uKnee.x, uKnee.y, vWorldW.y);'],
  [ENV3D, 'float radial = 1.0 - smoothstep(uFade.x, uFade.y, distance(vWorldW.xz, uPlayerPos.xz));'],
  [ENV3D, 'float fadeAmt = near * top * radial;'],
  [ENV3D, 'float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));'],
  [ENV3D, 'if (fadeAmt > ign) discard;'],
  [ENV3D, "pillarGeo.setAttribute('aFacing', new THREE.InstancedBufferAttribute(new Float32Array(pillarCells.length * 2), 2));"],
];

// ── общее ─────────────────────────────────────────────────────────────────────
const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
type Cfg = Record<string, unknown>;
/** `ConfigRegistry`-заглушка над голым объектом (синтетический конфиг эталона). */
const stub = (o: Cfg): ConfigRegistry => ({ get: (k: string) => o[k] ?? [] }) as unknown as ConfigRegistry;
const decode = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
/** HTML веба → видимый текст (`<br>` — перенос строки, теги прочь, сущности — символами). */
const plain = (html: string): string => decode(html.replace(/<br>/g, '\n').replace(/<[^>]+>/g, ''));
const bolds = (html: string): string[] => [...html.matchAll(/<b(?: [^>]*)?>(.*?)<\/b>/g)].map((m) => plain(m[1]!));

// ── 1. вопрос голосования (ui/voteText.ts) ──────────────────────────────────
const realVoteCfg: Cfg = {
  difficulties: reg.get('difficulties').map((d) => ({ id: d.id, name: d.name, unlockFloor: d.unlockFloor, enabled: d.enabled })),
  biomes: reg.get('biomes').map((b) => ({ id: b.id, name: b.name })),
  'run-modifiers': reg.get('run-modifiers').map((m) => ({ id: m.id, name: m.name })),
};
const synVoteCfg: Cfg = {
  difficulties: [
    { id: 'easy', name: 'Лёгкая', unlockFloor: 0 }, { id: 'normal', name: 'Средняя <i>', unlockFloor: 5 },
    { id: 'hard', name: 'A & B "q" \'s\'', unlockFloor: 10 }, { id: 'nm', unlockFloor: 12 }, { id: 'zero', name: '', unlockFloor: 3 },
  ],
  biomes: [{ id: 'b1', name: 'Склеп' }],
  'run-modifiers': [{ id: 'm1', name: 'Стеклянные кости' }, { id: 'm2', name: '<b>Рой</b>' }],
};
const VOTE_CFGS: Record<string, Cfg> = { real: realVoteCfg, syn: synVoteCfg };
const vf = (o: Partial<VoteStartFrame>): VoteStartFrame => ({ t: 'voteStart', kind: 'descend', by: 'p1', needed: 2, ...o } as VoteStartFrame);
const VOTES: { cfg: string; frame: VoteStartFrame; progress: Record<string, number> | null }[] = [];
for (const kind of ['town', 'arena'] as const) VOTES.push({ cfg: 'real', frame: vf({ kind }), progress: {} });
VOTES.push({ cfg: 'real', frame: vf({ finish: true } as Partial<VoteStartFrame>), progress: {} });
VOTES.push({ cfg: 'real', frame: vf({ finish: true, targetNodeType: 'boss' } as Partial<VoteStartFrame>), progress: {} });
for (const t of [...Object.keys(RUN_NODE_COLOR), 'mystery', '<i>x</i>', 'a&b']) VOTES.push({ cfg: 'real', frame: vf({ targetNodeId: 'n7', targetNodeType: t }), progress: {} });
VOTES.push({ cfg: 'real', frame: vf({}), progress: {} });
VOTES.push({ cfg: 'real', frame: vf({ targetNodeId: 'n7' }), progress: null });
const realDiffs = reg.get('difficulties');
const progSets: (Record<string, number> | null)[] = [null, {}, { easy: 5 }, { easy: 99, normal: 9 }, { easy: 99, normal: 99, hard: 99 }];
for (const d of realDiffs) for (const p of progSets) {
  VOTES.push({ cfg: 'real', frame: vf({ difficultyId: d.id, biomeId: 'crypt', modifiers: [] } as Partial<VoteStartFrame>), progress: p });
}
VOTES.push({ cfg: 'real', frame: vf({ difficultyId: 'hard', biomeId: 'caves', modifiers: ['pack-swarm', 'relic-greed', 'nope'] } as Partial<VoteStartFrame>), progress: { easy: 5 } });
VOTES.push({ cfg: 'real', frame: vf({ difficultyId: 'normal', biomeId: 'labyrinth', modifiers: [], resume: { host: 'Стенд', depth: 4 } } as Partial<VoteStartFrame>), progress: {} });
VOTES.push({ cfg: 'real', frame: vf({ difficultyId: 'ghost-tier', modifiers: [] } as Partial<VoteStartFrame>), progress: {} });
VOTES.push({ cfg: 'syn', frame: vf({ difficultyId: 'normal', biomeId: 'b1', modifiers: ['m1', 'm2'], resume: { host: '<b>Ник</b> & "Ко"', depth: 12 } } as Partial<VoteStartFrame>), progress: {} });
VOTES.push({ cfg: 'syn', frame: vf({ difficultyId: 'hard', biomeId: 'b1' } as Partial<VoteStartFrame>), progress: { normal: 3 } });
VOTES.push({ cfg: 'syn', frame: vf({ difficultyId: 'nm', biomeId: 'b1', modifiers: ['m2'] } as Partial<VoteStartFrame>), progress: { hard: 12 } });
VOTES.push({ cfg: 'syn', frame: vf({ difficultyId: 'zero', biomeId: 'b1', modifiers: [] } as Partial<VoteStartFrame>), progress: {} });

// ── 2. окно смерти (ui/deathWindow.ts, класс DeathWindow — как его водит online3d) ─────────────
const LABELS = { wait: 'Ожидайте: пати спустится — там возродитесь.', spectate: 'Смотреть' };
const died = (o: Partial<DiedFrame>): DiedFrame => ({ t: 'died', goldLost: 0, itemsLost: 0, toTown: false, ...o } as DiedFrame);
type Step = { died: DiedFrame } | { dismiss: true } | { reset: true };
const DEATH_SEQS: { name: string; steps: Step[] }[] = [
  { name: 'смерть, «Смотреть», статусы не открывают окно', steps: [{ died: died({ goldLost: 350, itemsLost: 2 }) }, { dismiss: true }, { died: died({ toTown: true, status: true }) }, { died: died({ status: true }) }] },
  { name: 'окно открыто — статус «в город» меняет только режим', steps: [{ died: died({ goldLost: 350, itemsLost: 2 }) }, { died: died({ toTown: true, status: true }) }] },
  { name: 'canLeave в окне', steps: [{ died: died({ goldLost: 10 }) }, { died: died({ status: true, canLeave: true }) }] },
  { name: 'вошёл мёртвым', steps: [{ died: died({ status: true }) }, { died: died({ status: true, canLeave: true }) }, { dismiss: true }] },
  { name: 'вайп соло', steps: [{ died: died({ goldLost: 5, itemsLost: 1, toTown: true }) }] },
  { name: 'арена', steps: [{ died: died({ pvp: true }) }, { died: died({ pvp: true, status: true }) }, { dismiss: true }, { reset: true }] },
  { name: 'R14-03: «Смотреть», потом canLeave — плашка; напарник вернулся — плашка прочь', steps: [
    { died: died({ goldLost: 350, itemsLost: 2 }) }, { dismiss: true }, { died: died({ status: true, canLeave: true }) }, { died: died({ status: true }) },
    { died: died({ status: true, canLeave: true }) }, { died: died({ status: true, toTown: true }) }] },
  { name: 'canLeave до «Смотреть», затем «Смотреть» — плашка', steps: [{ died: died({ goldLost: 7, itemsLost: 0, canLeave: true }) }, { dismiss: true }, { reset: true }, { died: died({ status: true }) }] },
  { name: 'новая смерть после статусов — свежие потери', steps: [{ died: died({ goldLost: 1, itemsLost: 1 }) }, { died: died({ status: true }) }, { died: died({ goldLost: 40, itemsLost: 3 }) }] },
  { name: 'dismiss без смерти', steps: [{ dismiss: true }, { reset: true }] },
];
function runDeath(steps: Step[]): unknown[] {
  let shown: DeathView | null = null, hidden = false, dock: DeathDock | null | undefined;
  const win = new DeathWindow({ show: (v) => { shown = v; }, hide: () => { hidden = true; }, dock: (v) => { dock = v; } }, LABELS);
  return steps.map((s) => {
    shown = null; hidden = false; dock = undefined;
    if ('died' in s) win.onDied(s.died); else if ('dismiss' in s) win.dismiss(); else win.reset();
    const st = win.state;
    return { shown, hidden, dock: dock === undefined ? 'нет вызова' : dock, state: st ? { ...st, losses: st.losses ? { ...st.losses } : null } : null };
  });
}

// ── 3. алтарь: СНЯТ ИЗ ЭТАЛОНА (Ф3, 16.10) ───────────────────────────────────
// ⭐⭐ Решение владельца 16.10: «веб клиент 2д и 3д уже не актуальны, нам все делаем только в юнити… эталоны тоже».
// Окно маршрута («Портал» города) переписано ПРЯМО В UNITY и сторожится там же — `Assets/DM/UI/Tests/PortalCheck.cs`
// против ОБЩИХ данных и формул (`packages/shared`), а не против копии веб-панели. Снятая отсюда копия модели и
// последовательности действий больше не нужны: веб-панель `difficultyPanel.ts` остаётся как есть и не развивается.
// ⚠ Остальные разделы эталона (голосование, окно смерти, карта забега, камера, затухание стен, наблюдение) живут
// по-прежнему — они сторожат ОБЩИЕ правила, а не внешний вид окна.

// ── 4. карта забега — ОБЩАЯ раскладка (`runMapLayout.runMapView`), не копия ───────────────────────
// ⭐⭐ Г5: эталон порта Unity снимается с той самой функции, которую зовёт панель. Прежде здесь лежала копия
// раскладки, а от расхождения сторожил список строк `SRC`: числа, которые сверяет Unity, имели два источника.
const hex = (n: number): string => '#' + n.toString(16).padStart(6, '0');
const mnode = (id: string, type: string, depth: number, lane: number, to: string[], mods: string[] = []): RunPlan['nodes'][number] =>
  ({ id, type, depth, lane, biomeId: 'crypt', floorSpec: {}, modifiers: mods, edges: to.map((t) => ({ to: t })) } as unknown as RunPlan['nodes'][number]);
const SYN_MAP: RunPlan = {
  biomeId: 'crypt', tier: 'normal', seed: 1, startId: 's', runModifiers: [],
  nodes: [
    mnode('s', 'start', 0, 0, ['a', 'b', 'c']), mnode('c', 'mystery', 1, 2, ['d']), mnode('a', 'shop', 1, 0, ['d'], ['boon-cache']), mnode('b', 'boss', 1, 1, ['d', 'ghost']),
    mnode('d', 'combat', 2, 0, ['f']), mnode('f', 'boss', 4, 0, []), mnode('e1', 'elite', 3, 5, []), mnode('e0', 'rest', 3, 5, ['f']),
  ],
};
const MAP_PLANS: RunPlan[] = [SYN_MAP];
// ⭐⭐ 13.10 (Г2): планы — ОКНОМ слоёв, и окно задаём явно: умолчание генератора (3 слоя) оставило бы эталону
// огрызок без развилок и привалов, а глубокое окно заодно стережёт раскладку «столбцы от первого слоя».
// ⚠ Г8-4 (15.10): шаблон стал ОДИН, и выборка планов упала с 12 до 4 — сверок RunUiCheck стало на 2440 меньше.
// Это потеря ПОКРЫТИЯ, а не правила: возвращаем размер сидами, а не смиряемся с меньшим эталоном.
for (const t of [{ id: 'спуск' }]) for (const seed of [7, 4242, 31337, 90210, 777, 12345, 5150, 8080, 606, 1234567, 99, 31415]) {
  MAP_PLANS.push(generateRunPlan(reg, defaultRunConfig(reg, seed), undefined, { from: 1, to: 9 }));
  MAP_PLANS.push(generateRunPlan(reg, defaultRunConfig(reg, seed), undefined, { from: 500, to: 504 }));
}

// ── 5. камера (render3d/cameraRig.ts) ──────────────────────────────────────────
const CAM_BALANCES: unknown[] = [
  undefined, {}, { camera: {} }, { camera: reg.get('balance').camera },
  { camera: { minDist: 200 } }, { camera: { minDist: 300, maxDist: 100 } }, { camera: { zoomStep: 1 } }, { camera: { zoomStep: 1.5, startDist: 50 } },
  { camera: { elNearDeg: 10, elFarDeg: 80, azimuthDeg: 30, fovDeg: 70, farClip: 900 } }, { camera: { azimuthDeg: 180, minDist: 1, maxDist: 2 } },
];
function camCase(balance: unknown): unknown {
  const c = cameraCfg(balance);
  const target = new THREE.Vector3(100, 20, 50);
  const dists = [c.minDist - 10, c.minDist, (c.minDist + c.maxDist) / 2, c.maxDist, c.maxDist + 10, c.startDist];
  const cam = new THREE.PerspectiveCamera();
  const place = dists.map((d) => { placeCamera(cam, target, d, c); return { dist: d, el: camElevation(d, c), pos: [cam.position.x, cam.position.y, cam.position.z] }; });
  let d = c.startDist;
  const zoomDeltas = [-1, -1, -1, 1, 1, -100, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, -1];
  const zoom = zoomDeltas.map((dy) => (d = camZoom(d, dy, c)));
  return { balance: balance === undefined ? null : balance, cfg: c, dir: camDir(c), place, zoomDeltas, zoom };
}

// ── 6. затухание стен (env3d.ts лицо + шейдер; online3d.ts параметры биома) — копии, сторожатся `SRC` ─────────
function facingOf(grid: number[][], x: number, y: number): [number, number] {
  const walk = (xx: number, yy: number): boolean => grid[yy]?.[xx] !== undefined && grid[yy]![xx] !== Cell.Wall;
  const N4: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const N8: [number, number][] = [...N4, [1, 1], [1, -1], [-1, 1], [-1, -1]];
  let fx = 0, fz = 0; for (const [dx, dy] of N4) if (walk(x + dx, y + dy)) { fx += dx; fz += dy; }
  if (fx === 0 && fz === 0) for (const [dx, dy] of N8) if (walk(x + dx, y + dy)) { fx += dx; fz += dy; }
  const len = Math.hypot(fx, fz) || 1; return [fx / len, fz / len];
}
const smoothstep = (e0: number, e1: number, x: number): number => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const fract = (v: number): number => v - Math.floor(v);
type Fade = { start: number; end: number; kneeLow: number; kneeHigh: number };
const FADE_DEFAULT: Fade = { start: 190, end: 460, kneeLow: 20, kneeHigh: 46 };
/** `applyEnvFade`: запись биома — её параметры; нет записи (или выключена, или биома нет) — прежние остаются. */
function envFade(env: unknown, biomeId: string | undefined, prev: Fade): Fade {
  const cfg = biomeId ? (env as { enabled?: boolean; biomeId: string; fade?: Fade }[] | undefined)?.find((e) => e.enabled && e.biomeId === biomeId) : undefined;
  const f = cfg?.fade; if (!f) return prev;
  return { start: f.start, end: f.end, kneeLow: f.kneeLow, kneeHigh: f.kneeHigh };
}
/** Доля прозрачности фрагмента стены (`fadeAmt`) — формула шейдера; `facing` — лицо стены, `view` — горизонт камера→герой. */
function fadeAmt(p: [number, number, number], facing: [number, number], view: [number, number], player: [number, number], f: Fade, gate: boolean): number {
  const faceDot = facing[0] * view[0] + facing[1] * view[1];
  const near = gate ? smoothstep(0, 0.35, faceDot) : 1;
  const top = smoothstep(f.kneeLow, f.kneeHigh, p[1]);
  const radial = 1 - smoothstep(f.start, f.end, Math.hypot(p[0] - player[0], p[2] - player[1]));
  return near * top * radial;
}
const ign = (x: number, y: number): number => fract(52.9829189 * fract(x * 0.06711056 + y * 0.00583715));
const W = Cell.Wall, F = Cell.Floor, D = Cell.Door, P = Cell.Pillar;
const FADE_GRIDS: number[][][] = [
  [[W, W, W, W, W], [W, F, F, F, W], [W, F, P, F, W], [W, F, F, F, W], [W, W, D, W, W], [W, F, F, F, W], [W, W, W, W, W]],
  [[W, W, W, W, W, W], [W, F, W, F, F, W], [W, F, W, W, F, W], [W, F, F, W, F, W], [W, W, W, W, W, W], [W, W, W, W, W, W]],
  [[F, W, F], [W, W, W], [F, W, F]],
  [[W]],
  [[W, W, W, W], [W, D, P, W], [W, W, W, W]],   // стены вокруг двери и колонны: проходимы для «лица» (не стена — значит проход)
];
function fadeSection(): unknown {
  const grids = FADE_GRIDS.map((grid) => {
    const facing: { x: number; y: number; f: [number, number] }[] = [];
    for (let y = 0; y < grid.length; y++) for (let x = 0; x < grid[y]!.length; x++) if (grid[y]![x] === Cell.Wall) facing.push({ x, y, f: facingOf(grid, x, y) });
    return { grid, facing };
  });
  const env = reg.get('environment');
  const envSyn = [{ id: 'a', biomeId: 'crypt', enabled: false, fade: { start: 1, end: 2, kneeLow: 3, kneeHigh: 4, faceYaw: 0 } },
    { id: 'b', biomeId: 'crypt', enabled: true, fade: { start: 100, end: 300, kneeLow: 10, kneeHigh: 30, faceYaw: 0.5 } },
    { id: 'c', biomeId: 'caves', enabled: true }, { id: 'd', biomeId: 'labyrinth', fade: { start: 5, end: 6, kneeLow: 7, kneeHigh: 8, faceYaw: 0 } }];
  const prevAlt: Fade = { start: 11, end: 22, kneeLow: 33, kneeHigh: 44 };
  const envCases: unknown[] = [];
  for (const [name, e] of [['боевой', env], ['синтетика', envSyn], ['нет секции', undefined]] as const) {
    for (const b of ['crypt', 'caves', 'dungeon', 'labyrinth', 'ghost', undefined]) {
      for (const prev of [FADE_DEFAULT, prevAlt]) envCases.push({ env: name, biome: b ?? null, prev, fade: envFade(e, b, prev) });
    }
  }
  // Взгляд камеры — НАСТОЯЩАЯ постановка камеры веба: горизонт от камеры к герою (как `wallFade.viewDir` в online3d).
  const cam = new THREE.PerspectiveCamera();
  const views: { camBalance: string; balance: unknown; dist: number; player: [number, number]; view: [number, number] }[] = [];
  for (const [nm, bal] of [['боевой', { camera: reg.get('balance').camera }], ['азимут 30°', { camera: { azimuthDeg: 30 } }]] as const) {
    const c = cameraCfg(bal);
    for (const d of [c.minDist, c.maxDist]) {
      const player: [number, number] = [400, 300];
      placeCamera(cam, new THREE.Vector3(player[0], 20, player[1]), d, c);
      const v = new THREE.Vector2(player[0] - cam.position.x, player[1] - cam.position.z).normalize();
      views.push({ camBalance: nm, balance: bal, dist: d, player, view: [v.x, v.y] });
    }
  }
  // Опрос формулы: точка × лицо × взгляд (индексы в `pts`/`facings`/`views`) × гейт по лицу; параметры — `fades`.
  const samples: unknown[] = [];
  const facings: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1], [Math.SQRT1_2, Math.SQRT1_2], [0, 0], [0.2, 0]];
  const pts: [number, number, number][] = [[400, 0, 300], [400, 20, 300], [400, 33, 300], [400, 46, 300], [400, 96, 300], [500, 60, 300], [590, 60, 300], [700, 60, 320], [860, 60, 300], [300, 40, 150], [420, 30, 310]];
  const fades: Fade[] = [FADE_DEFAULT, { start: 100, end: 300, kneeLow: 10, kneeHigh: 30 }];
  for (let vi = 0; vi < views.length; vi++) for (let fi = 0; fi < facings.length; fi++) for (let pi = 0; pi < pts.length; pi++) for (const gate of [true, false]) for (let k = 0; k < fades.length; k++) {
    if (k === 1 && (vi > 0 || !gate)) continue;
    const v = views[vi]!;
    samples.push({ p: pi, f: fi, v: vi, k, gate, amt: fadeAmt(pts[pi]!, facings[fi]!, v.view, v.player, fades[k]!, gate) });
  }
  const frags: [number, number][] = [[0.5, 0.5], [1.5, 0.5], [100.5, 37.5], [1919.5, 1079.5], [640.5, 360.5], [3.5, 211.5]];
  return { defaults: FADE_DEFAULT, wallCell: Cell.Wall, pillarFacing: [0, 0], grids, env: { 'боевой': env, 'синтетика': envSyn }, envCases, views, pts, facings, fades, samples,
    ign: frags.map(([x, y]) => ({ x, y, ign: ign(x, y) })) };
}

// ── 7. наблюдение за союзником (online3d.ts) — копия, сторожится `SRC` ─────────────────────────
type Pl = { id: string; alive: boolean; name: string };
/** Кадр мира: за кем камера (мёртв — живой союзник, Tab циклит), подпись. `me` нет в кадре — как у веба (ни слежки, ни подписи). */
function spectFrame(players: Pl[], myId: string, spectateId: string | null): { spectateId: string | null; focus: string | null; hint: string | null } {
  const mine = players.find((p) => p.id === myId);
  if (!mine) return { spectateId, focus: null, hint: null };
  if (!mine.alive) {
    const living = players.filter((p) => p.id !== myId && p.alive);
    if (living.length) {
      if (!spectateId || !living.some((p) => p.id === spectateId)) spectateId = living[0]!.id;
      const tgt = living.find((p) => p.id === spectateId)!;
      return { spectateId, focus: tgt.id, hint: `💀 Наблюдаете за ${tgt.name || 'союзник'} · Tab — сменить` };
    }
    return { spectateId, focus: null, hint: null };
  }
  return { spectateId: null, focus: myId, hint: null };
}
function spectTab(players: Pl[], myId: string, spectateId: string | null): { spectateId: string | null; used: boolean } {
  const me = players.find((p) => p.id === myId);
  if (!me || me.alive) return { spectateId, used: false };
  const living = players.filter((p) => p.id !== myId && p.alive);
  if (living.length < 2) return { spectateId, used: false };
  const idx = living.findIndex((p) => p.id === spectateId);
  return { spectateId: living[(idx + 1) % living.length]!.id, used: true };
}
type SpOp = { frame: Pl[] } | { tab: Pl[] };
const pl = (id: string, alive: boolean, name = id.toUpperCase()): Pl => ({ id, alive, name });
const SPECT_SEQS: { name: string; ops: SpOp[] }[] = [
  { name: 'жив — за собой', ops: [{ frame: [pl('me', true), pl('a', true)] }, { tab: [pl('me', true), pl('a', true), pl('b', true)] }] },
  { name: 'мёртв, один живой — за ним, Tab не переключает', ops: [{ frame: [pl('me', false), pl('a', true)] }, { tab: [pl('me', false), pl('a', true)] }, { frame: [pl('me', false), pl('a', true)] }] },
  { name: 'мёртв, трое — Tab по кругу; выбранный погиб — первый живой', ops: [
    { frame: [pl('me', false), pl('a', true), pl('b', true, ''), pl('c', true)] }, { tab: [pl('me', false), pl('a', true), pl('b', true, ''), pl('c', true)] },
    { frame: [pl('me', false), pl('a', true), pl('b', true, ''), pl('c', true)] }, { tab: [pl('me', false), pl('a', true), pl('b', true, ''), pl('c', true)] },
    { tab: [pl('me', false), pl('a', true), pl('b', true, ''), pl('c', true)] }, { frame: [pl('me', false), pl('a', true), pl('b', true, ''), pl('c', true)] },
    { frame: [pl('me', false), pl('a', false), pl('b', true, ''), pl('c', true)] }, { tab: [pl('me', false), pl('a', false), pl('b', true, ''), pl('c', false)] },
    { frame: [pl('me', false), pl('a', false), pl('b', false), pl('c', false)] }, { frame: [pl('me', true), pl('b', true)] }] },
  { name: 'своего героя нет в кадре', ops: [{ frame: [pl('a', true)] }, { tab: [pl('a', true), pl('b', true)] }] },
];
function runSpect(ops: SpOp[]): unknown[] {
  let id: string | null = null;
  return ops.map((op) => {
    if ('frame' in op) { const r = spectFrame(op.frame, 'me', id); id = r.spectateId; return { op: 'frame', players: op.frame, ...r }; }
    const r = spectTab(op.tab, 'me', id); id = r.spectateId; return { op: 'tab', players: op.tab, ...r };
  });
}
/** Сглаживание фокуса камеры: прыжок > 120 u или первый кадр — сразу; жив — сразу; мёртв — экспонента 0.045 с. */
function smoothSteps(): unknown[] {
  const out: unknown[] = [];
  let sx = 0, sz = 0, has = false;
  const steps: [number, number, boolean, number][] = [[10, 20, false, 0.016], [50, 20, false, 0.016], [50, 20, false, 0.1], [60, 30, false, 0.007], [300, 30, false, 0.016],
    [310, 40, true, 0.016], [320, 40, false, 1 / 144], [430, 40, false, 0.016], [430, 40, false, 0.016], [430, 160.5, false, 0.016], [430, 280.4, false, 0.016]];
  for (const [tX, tZ, alive, dt] of steps) {
    if (!has || Math.hypot(tX - sx, tZ - sz) > 120) { sx = tX; sz = tZ; has = true; }
    else if (alive) { sx = tX; sz = tZ; }
    else { const k = 1 - Math.exp(-dt / 0.045); sx += (tX - sx) * k; sz += (tZ - sz) * k; }
    out.push({ t: [tX, tZ], alive, dt, s: [sx, sz] });
  }
  return out;
}

function build(): unknown {
  return {
    note: 'генерит packages/client/src/modules/run/unityRunUiGolden.gen.test.ts (веб = источник истины); проверка Unity — RunUiCheck',
    vote: {
      cfgs: VOTE_CFGS,
      cases: VOTES.map((v) => {
        const html = voteQuestion(v.frame, stub(VOTE_CFGS[v.cfg]!), v.progress ?? undefined);
        const warn = /<b style="color:(#[0-9a-f]{6})">/.exec(html);
        return { cfg: v.cfg, frame: v.frame, progress: v.progress, html, plain: plain(html), bold: bolds(html), warnColor: warn ? warn[1] : null };
      }),
    },
    death: { labels: LABELS, seqs: DEATH_SEQS.map((s) => ({ name: s.name, steps: s.steps, out: runDeath(s.steps) })) },
    runMap: {
      ...MAP_GEOM,
      // План, как его читает карта: шапка и узлы (id, тип, слой, полоса, модификаторы, рёбра) — остальное карта не читает.
      plans: MAP_PLANS.map((p) => ({ biomeId: p.biomeId, tier: p.tier, startId: p.startId,
        nodes: p.nodes.map((n) => ({ id: n.id, type: n.type, depth: n.depth, lane: n.lane, modifiers: n.modifiers, edges: n.edges.map((e) => ({ to: e.to })) })) })),
      // ⚠⚠ 14.10 (Г3, В6): «Финал» из легенды СНЯТ — узлов этого типа генератор не ставит с Г2 (подпись в `runLabels` жива).
      legend: LEGEND_TYPES.map((t) => ({ type: t, label: runNodeLabel(t), color: hex(RUN_NODE_COLOR[t]) })),
      // ⭐⭐ 14.10 (Г3, В5): «Завершить забег» живёт в этой панели (у портала второе действие недостижимо: [E] берёт ближайшее).
      finish: {
        label: 'Завершить забег (голосование)', variant: 'danger', act: 'finish',
        note: 'Жать у портала привала или у точки входа. Уход в город порталом забег ПАРКУЕТ — его можно продолжить с того же узла; «Завершить» снимает забег у всей пати, и следующий спуск начнётся с выбранной на алтаре метки.',
      },
      // ⭐ Г5: КАЖДЫЙ СЛУЧАЙ НЕСЁТ СВОЙ ШАГ КАДЕНЦИИ. Полоса номеров помечает столбцы-привалов этой каденцией, и шапка
      // ею же считает «до метки N эт.»: шаг — число баланса, и порт обязан брать его из конфига, а не знать наизусть.
      cases: [
        // ⭐⭐ Г8-2: у случая СВОЙ цикл — метка считается по МЕСТУ В ПОЛОСЕ, и порт обязан брать оба числа из
        // конфига. Набор `[шаг, цикл]`: живая пара (3, 20), прежнее правило без цикла (3, 0) и мелкий круг (2, 5).
        // ⭐⭐ Г8-3: `places` — настройка КАК ЕСТЬ: список мест (живая схема) либо число (прежняя короткая форма
        // «каждое место, кратное N»). Порт Unity читает оба вида одним швом (`Altar.PortalPlacesOf`), и эталон
        // обязан держать оба: иначе совместимость со старым конфигом/оверрайдом проверять нечем.
        { plan: null, current: null, places: 3, cycle: 20, out: runMapView(null, null, 3, 20) },
        ...MAP_PLANS.flatMap((p, k) => [p.startId, p.nodes[Math.floor(p.nodes.length / 2)]!.id, p.nodes[p.nodes.length - 1]!.id, 'ghost', null]
          .flatMap((cur) => ([[[3, 6, 9, 12, 15, 18, 20], 20], [3, 20], [3, 0], [2, 5]] as const)
            .map(([places, cycle]) => ({ plan: k, current: cur, places, cycle, out: runMapView(p, cur, places, cycle) })))),
      ],
    },
    camera: CAM_BALANCES.map(camCase),
    wallFade: fadeSection(),
    spectate: { seqs: SPECT_SEQS.map((s) => ({ name: s.name, out: runSpect(s.ops) })), smooth: smoothSteps() },
  };
}

describe('unityRunUiGolden — продюсер эталона окон забега и камеры (пишет __golden__/unity_run_ui.json)', () => {
  it('копии правил (карта, алтарь, наблюдение, затухание стен, проводка 3D) совпадают с исходником', () => {
    for (const [src, line] of SRC) expect(src.includes(line), `нет строки исходника: ${line}`).toBe(true);
  });

  it('покрытие: плашка смерти, развилки карты, Tab по кругу, затухание и целые стены', () => {
    const g = build() as {
      death: { seqs: { out: { dock: unknown }[] }[] };
      runMap: { cases: { out: { nodes?: { ring: unknown }[]; edges?: { width: number }[] } }[] }; spectate: { seqs: { out: { used?: boolean }[] }[] };
      wallFade: { samples: { amt: number }[] };
    };
    // ⚠⚠ Ф3 (16.10): ПОКРЫТИЕ ОКНА МАРШРУТА УЕХАЛО В UNITY. Замки тиров, цепь меток, скрытый ряд, боссы на
    // звеньях и ветвление сторожит `Assets/DM/UI/Tests/PortalCheck.cs` — там живёт само окно. Здесь остаётся
    // покрытие того, что по-прежнему общее: плашка смерти, развилки карты забега, наблюдение, затухание стен.
    expect(g.death.seqs.some((s) => s.out.some((o) => o.dock && o.dock !== 'нет вызова'))).toBe(true);
    expect(g.runMap.cases.some((c) => c.out.edges?.some((e) => e.width === 2.5))).toBe(true);
    expect(g.spectate.seqs.some((s) => s.out.some((o) => o.used))).toBe(true);
    const amts = g.wallFade.samples.map((s) => s.amt);
    expect(amts.some((a) => a === 0) && amts.some((a) => a > 0.99) && amts.some((a) => a > 0 && a < 0.99)).toBe(true);
  });

  it('эталон на диске совпадает с правилами веба (иначе: перезаписать -u и отдать порту Unity)', async () => {
    await expect(JSON.stringify(build(), null, 1) + '\n', 'правило окон забега поменялось: npx vitest run -u packages/client/src/modules/run/unityRunUiGolden.gen.test.ts, '
      + 'затем python tools/unity-check/golden_sync.py в Unity и догнать порт (RunUiCheck)')
      .toMatchFileSnapshot('./__golden__/unity_run_ui.json');
  });
});

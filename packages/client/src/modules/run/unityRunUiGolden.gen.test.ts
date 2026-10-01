/**
 * ПРОДЮСЕР И СТОРОЖ эталона ОКОН ЗАБЕГА v2 И КАМЕРЫ для Unity-клиента (U5b): карта забега (M), алтарь у портала (биом, шаблон,
 * модификаторы, тиры с замками, мощь героя, арена), вопрос голосования, окно смерти, наблюдение за союзником (Tab), камера из
 * `balance.camera`, затухание стен между камерой и героем.
 *
 * Unity — основной клиент, веб — источник истины по правилам. Настоящими функциями веба считаются: `voteQuestion`, `DeathWindow`,
 * `cameraCfg`/`camElevation`/`placeCamera`/`camZoom`/`camDir`, `effectiveLevel`/`carriedGear`/`startChallenge`/`altarModifiers`/
 * `isDifficultyUnlocked`, подписи и цвета узлов (`runLabels`), планы `generateRunPlan`. Раскладка карты (`runMapPanel.ts`), модель алтаря
 * (`difficultyPanel.ts`), наблюдение (`online3d.ts`) и затухание стен (`env3d.ts`: лицо стены и формула шейдера) живут в замыканиях и DOM/
 * WebGL — здесь они повторены копией, и каждая копия СТОРОЖИТСЯ строкой исходника (`SRC`): правило поменяли — тест падает, пока копию,
 * эталон и порт Unity не обновят осознанно.
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
  ConfigRegistry, Cell, defaultRunConfig, generateRunPlan, effectiveLevel, carriedGear, startChallenge, isDifficultyUnlocked,
  altarModifiers, RUN_MOD_LIVE_STATS, type RunPlan, type SaveState,
} from '@dm/shared';
import { voteQuestion, type VoteStartFrame } from '../../ui/voteText.js';
import { DeathWindow, type DeathDock, type DeathView, type DiedFrame } from '../../ui/deathWindow.js';
import { RUN_NODE_COLOR, runNodeLabel } from './runLabels.js';
import { cameraCfg, camElevation, placeCamera, camZoom, camDir } from '../../render3d/cameraRig.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(join(HERE, rel), 'utf8');
const ONLINE3D = read('../../render3d/online3d.ts');
const ENV3D = read('../../render3d/env3d.ts');
const RUNMAP = read('./runMapPanel.ts');
const ALTAR = read('../town/difficultyPanel.ts');

/** Строки исходников, повторённые ниже копией. Нет строки — правило веба поменялось: обновить копию, эталон и порт Unity. */
const SRC: [string, string][] = [
  // карта забега (runMapPanel.ts)
  [RUNMAP, 'const COL_W = 96;'], [RUNMAP, 'const ROW_H = 66;'], [RUNMAP, 'const PAD = 28;'], [RUNMAP, 'const R = 16;'],
  [RUNMAP, "'Забег не активен — карта появится в подземелье.'"],
  [RUNMAP, '`Шаблон <b style="color:${COLORS.gold}">${plan.templateId}</b> · биом <b>${plan.biomeId}</b> · тир <b>${plan.tier}</b>` +'],
  [RUNMAP, '` <span style="color:${COLORS.dim}">· ${plan.nodes.length} узлов</span>`;'],
  [RUNMAP, 'for (const a of byDepth.values()) a.sort((p, q) => p.lane - q.lane);'],
  [RUNMAP, 'const maxDepth = Math.max(...plan.nodes.map((n) => n.depth));'],
  [RUNMAP, 'const maxCol = Math.max(...[...byDepth.values()].map((a) => a.length));'],
  [RUNMAP, 'const width = PAD * 2 + maxDepth * COL_W;'], [RUNMAP, 'const height = PAD * 2 + (maxCol - 1) * ROW_H;'],
  [RUNMAP, 'const midY = PAD + (maxCol - 1) * ROW_H / 2;'], [RUNMAP, 'const x = PAD + depth * COL_W;'],
  [RUNMAP, 'const y = midY + (i - (arr.length - 1) / 2) * ROW_H;'],
  [RUNMAP, 'const nextIds = new Set(cur?.edges.map((e) => e.to) ?? []);'],
  [RUNMAP, 'const hot = n.id === currentNodeId;'],
  [RUNMAP, "stroke: hot ? COLORS.gold : '#4a4640', 'stroke-width': hot ? 2.5 : 1.5, 'stroke-opacity': hot ? 0.9 : 0.5,"],
  [RUNMAP, 'const col = hex(RUN_NODE_COLOR[n.type] ?? 0x8a8f9a);'],
  [RUNMAP, "if (isCur) g.append(svgEl('circle', { cx: p.x, cy: p.y, r: R + 6, fill: 'none', stroke: COLORS.gold, 'stroke-width': 3 }));"],
  [RUNMAP, "stroke: isNext ? COLORS.gold : '#1a1a1a', 'stroke-width': isNext ? 2.5 : 1.5,"],
  [RUNMAP, "'fill-opacity': isCur || isNext ? 1 : 0.82,"],
  [RUNMAP, "x: p.x, y: p.y + R + 13, 'text-anchor': 'middle', 'font-size': 10, fill: isCur ? COLORS.gold : '#c4bca8', 'font-family': 'system-ui',"],
  [RUNMAP, 'label.textContent = runNodeLabel(n.type);'], [RUNMAP, 'if (n.modifiers.length) {'], [RUNMAP, "badge.textContent = '★';"],
  [RUNMAP, "for (const t of ['combat', 'elite', 'boss', 'treasure', 'rest', 'finale'] as const) {"],
  // алтарь (difficultyPanel.ts)
  [ALTAR, "const pw = effectiveLevel(state.save, app.config.get('balance').power, carriedGear(state.save), app.config.get('item-tiers'));"],
  [ALTAR, "const biomes = app.config.get('biomes').filter((b) => b.enabled !== false);"],
  [ALTAR, "const templates = app.config.get('run-templates').filter((t) => t.enabled !== false);"],
  [ALTAR, 'if (biomes.length && !biomes.some((b) => b.id === selBiome)) selBiome = biomes[0]!.id;'],
  [ALTAR, 'if (templates.length && !templates.some((t) => t.id === selTpl)) selTpl = templates[0]!.id;'],
  [ALTAR, '`Мощь персонажа: <b style="color:${COLORS.gold}">${pw.total}</b> ` +'],
  [ALTAR, '`<span style="color:${COLORS.dim}">(ур. ${pw.level} + гир +${pw.gearBonus} + мастерства +${pw.passiveBonus})</span>`;'],
  [ALTAR, "pvpRow.append(button('⚔ PvP-арена (дуэль на алтаре)', () => {"], [ALTAR, "app.net.send({ t: 'arena' });"],
  [ALTAR, "'Круглый зал: спавн в разных концах, урон по друг другу, гибель без потерь.'"],
  [ALTAR, "body.append(sectionLabel('Биом (павшая империя)'));"],
  [ALTAR, 'for (const b of biomes) row.append(chip(b.name, b.id === selBiome, () => { selBiome = b.id; redraw(); }, b.tagline || b.desc || undefined));'],
  [ALTAR, 'if (cur?.tagline || cur?.desc) body.append(mk(\'div\', `font-size:11px;color:${COLORS.dim};margin-top:4px;font-style:italic`, cur.tagline || cur.desc));'],
  [ALTAR, "body.append(sectionLabel('Шаблон забега'));"],
  [ALTAR, "const title = `слоёв ${t.length.min}–${t.length.max} · ширина до ${t.width.max} · босс каждые ${t.bossEvery || '—'}`;"],
  [ALTAR, 'const mods = altarModifiers(runMods, tpl?.allowedModifiers);'],
  [ALTAR, 'for (const id of [...selMods]) if (!mods.some((m) => m.id === id)) selMods.delete(id);'],
  [ALTAR, "body.append(sectionLabel('Модификаторы'));"], [ALTAR, "'Благо — только в паре с опасностью: лишние блага алтарь отбросит.'"],
  [ALTAR, 'row.append(chip(m.name, selMods.has(m.id), () => { if (selMods.has(m.id)) selMods.delete(m.id); else selMods.add(m.id); redraw(); }, m.desc || undefined));'],
  [ALTAR, "body.append(sectionLabel('Сложность (тир) — жмите «Войти»'));"], [ALTAR, 'if (diff.enabled === false) return;'],
  [ALTAR, 'const unlocked = isDifficultyUnlocked(diffs, i, state.save.difficultyProgress);'], [ALTAR, 'const startCL = startChallenge(pw.total, diff);'],
  [ALTAR, '`золото ×${diff.goldMult} · редкость ×${diff.magicFind}`));'], [ALTAR, '`Монстры на 1-м этаже ≈ ур. ${startCL}, глубже — сложнее.`));'],
  [ALTAR, "app.net.send({ t: 'descend', difficultyId: diff.id, runConfig: { biomeId: selBiome, templateId: selTpl, modifiers: [...selMods] } });"],
  [ALTAR, "}, i >= 2 ? 'danger' : 'primary'));"], [ALTAR, "const have = state.save.difficultyProgress[prev?.id ?? ''] ?? 0;"],
  [ALTAR, '`🔒 Пройди этаж ${diff.unlockFloor} на «${prev?.name ?? \'—\'}» (сейчас ${have})`));'],
  [ALTAR, "const panel: Panel = { title: 'Алтарь забега', render(body) { bodyRef = body; draw(body); } };"],
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
  'run-templates': reg.get('run-templates').map((t) => ({ id: t.id, name: t.name })),
  biomes: reg.get('biomes').map((b) => ({ id: b.id, name: b.name })),
  'run-modifiers': reg.get('run-modifiers').map((m) => ({ id: m.id, name: m.name })),
};
const synVoteCfg: Cfg = {
  difficulties: [
    { id: 'easy', name: 'Лёгкая', unlockFloor: 0 }, { id: 'normal', name: 'Средняя <i>', unlockFloor: 5 },
    { id: 'hard', name: 'A & B "q" \'s\'', unlockFloor: 10 }, { id: 'nm', unlockFloor: 12 }, { id: 'zero', name: '', unlockFloor: 3 },
  ],
  'run-templates': [{ id: 't1', name: 'Глубокая <экспедиция>' }],
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
  VOTES.push({ cfg: 'real', frame: vf({ difficultyId: d.id, templateId: 'deep-expedition', biomeId: 'crypt', modifiers: [] } as Partial<VoteStartFrame>), progress: p });
}
VOTES.push({ cfg: 'real', frame: vf({ difficultyId: 'hard', templateId: 'crypt-short', biomeId: 'caves', modifiers: ['pack-swarm', 'relic-greed', 'nope'] } as Partial<VoteStartFrame>), progress: { easy: 5 } });
VOTES.push({ cfg: 'real', frame: vf({ difficultyId: 'normal', templateId: 'dungeon-standard', biomeId: 'labyrinth', modifiers: [], resume: { host: 'Стенд', depth: 4 } } as Partial<VoteStartFrame>), progress: {} });
VOTES.push({ cfg: 'real', frame: vf({ difficultyId: 'ghost-tier', templateId: 'ghost-tpl', modifiers: [] } as Partial<VoteStartFrame>), progress: {} });
VOTES.push({ cfg: 'syn', frame: vf({ difficultyId: 'normal', templateId: 't1', biomeId: 'b1', modifiers: ['m1', 'm2'], resume: { host: '<b>Ник</b> & "Ко"', depth: 12 } } as Partial<VoteStartFrame>), progress: {} });
VOTES.push({ cfg: 'syn', frame: vf({ difficultyId: 'hard', templateId: 't1', biomeId: 'b1' } as Partial<VoteStartFrame>), progress: { normal: 3 } });
VOTES.push({ cfg: 'syn', frame: vf({ difficultyId: 'nm', templateId: 't1', biomeId: 'b1', modifiers: ['m2'] } as Partial<VoteStartFrame>), progress: { hard: 12 } });
VOTES.push({ cfg: 'syn', frame: vf({ difficultyId: 'zero', templateId: 't1', biomeId: 'b1', modifiers: [] } as Partial<VoteStartFrame>), progress: {} });

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

// ── 3. алтарь (town/difficultyPanel.ts) — копия модели окна, сторожится `SRC` ─────────────────
type AltarSel = { biome?: string; tpl?: string; mods: Set<string> };
/** Что рисует `draw` алтаря при этом выборе (выбор правится так же, как в окне: умолчания и чистка модификаторов). */
function altarModel(cfg: ConfigRegistry, save: SaveState, sel: AltarSel, live: ReadonlySet<string>): unknown {
  const diffs = cfg.get('difficulties');
  const pw = effectiveLevel(save, cfg.get('balance').power, carriedGear(save), cfg.get('item-tiers'));
  const biomes = cfg.get('biomes').filter((b) => b.enabled !== false);
  const templates = cfg.get('run-templates').filter((t) => t.enabled !== false);
  const runMods = cfg.get('run-modifiers');
  if (biomes.length && !biomes.some((b) => b.id === sel.biome)) sel.biome = biomes[0]!.id;
  if (templates.length && !templates.some((t) => t.id === sel.tpl)) sel.tpl = templates[0]!.id;
  const cur = biomes.find((b) => b.id === sel.biome);
  const tpl = templates.find((t) => t.id === sel.tpl);
  const mods = altarModifiers(runMods, tpl?.allowedModifiers, live);
  for (const id of [...sel.mods]) if (!mods.some((m) => m.id === id)) sel.mods.delete(id);
  const tiers: unknown[] = [];
  diffs.forEach((diff, i) => {
    if (diff.enabled === false) return;
    const unlocked = isDifficultyUnlocked(diffs, i, save.difficultyProgress);
    const startCL = startChallenge(pw.total, diff);
    const prev = diffs[i - 1];
    const have = save.difficultyProgress[prev?.id ?? ''] ?? 0;
    tiers.push({
      id: diff.id, name: diff.name, unlocked,
      meta: `золото ×${diff.goldMult} · редкость ×${diff.magicFind}`,
      line: `Монстры на 1-м этаже ≈ ур. ${startCL}, глубже — сложнее.`,
      variant: unlocked ? (i >= 2 ? 'danger' : 'primary') : null,
      descend: unlocked ? JSON.parse(JSON.stringify({ t: 'descend', difficultyId: diff.id, runConfig: { biomeId: sel.biome, templateId: sel.tpl, modifiers: [...sel.mods] } })) : null,
      lock: unlocked ? null : `🔒 Пройди этаж ${diff.unlockFloor} на «${prev?.name ?? '—'}» (сейчас ${have})`,
    });
  });
  return {
    power: pw,
    head: `Мощь персонажа: ${pw.total} (ур. ${pw.level} + гир +${pw.gearBonus} + мастерства +${pw.passiveBonus})`,
    biomes: biomes.map((b) => ({ id: b.id, name: b.name, active: b.id === sel.biome, title: b.tagline || b.desc || null })),
    biomeNote: cur?.tagline || cur?.desc || null,
    templates: templates.map((t) => ({ id: t.id, name: t.name, active: t.id === sel.tpl, title: `слоёв ${t.length.min}–${t.length.max} · ширина до ${t.width.max} · босс каждые ${t.bossEvery || '—'}` })),
    mods: mods.map((m) => ({ id: m.id, name: m.name, active: sel.mods.has(m.id), title: m.desc || null })),
    tiers,
    sel: { biome: sel.biome ?? null, tpl: sel.tpl ?? null, mods: [...sel.mods] },
  };
}

/** Вещь сейва для мощи (поля, которые читают `effectiveLevel` и `unmetWorn`). */
let uidN = 0;
const item = (o: Record<string, unknown>): Record<string, unknown> => ({
  uid: `u${++uidN}`, baseId: 'b', name: `Вещь ${uidN}`, rarity: 'normal', itemLevel: 1, requirements: {}, affixes: [], baseStats: [], gridW: 1, gridH: 1, ...o,
});
const DMG = [{ stat: 'minDamage', kind: 'flat', value: 3 }, { stat: 'maxDamage', kind: 'flat', value: 6 }];
const ARM = [{ stat: 'armor', kind: 'flat', value: 4 }];
const save = (o: Record<string, unknown>): SaveState => ({
  level: 1, gold: 0, attributes: { strength: 10, dexterity: 10, intelligence: 10, vitality: 10 }, unspentAttributePoints: 0,
  equipment: {}, inventory: [], belt: [], masteries: {}, difficultyProgress: {}, ...o,
} as unknown as SaveState);
const SAVES: Record<string, SaveState> = {
  fresh: save({ equipment: { weapon: item({ slot: 'weapon', baseStats: DMG }), chest: item({ slot: 'chest', baseStats: ARM }) } }),
  mid: save({
    level: 20, difficultyProgress: { easy: 5, normal: 9 }, masteries: { a: 12, b: 9, c: 3 },
    equipment: {
      weapon: item({ slot: 'weapon', rarity: 'rare', itemLevel: 18, tier: 't4', baseStats: DMG }),
      helm: item({ slot: 'helm', rarity: 'magic', itemLevel: 5, tier: 't4', baseStats: ARM }),
      ring1: item({ slot: 'ring1', rarity: 'unique', itemLevel: 5, tier: 't5', baseStats: [{ stat: 'strength', kind: 'flat', value: 5 }] }),
      chest: null,
    },
  }),
  spare: save({
    level: 30, attributes: { strength: 20, dexterity: 15, intelligence: 10, vitality: 10 }, unspentAttributePoints: 5,
    respecPeak: { strength: 40, dexterity: 0, intelligence: 0, vitality: 0 }, masteries: { a: 90 }, difficultyProgress: { easy: 12, normal: 12, hard: 12 },
    equipment: { weapon: item({ slot: 'weapon', rarity: 'magic', itemLevel: 10, baseStats: DMG }), offhand: item({ slot: 'offhand', kind: 'shield', rarity: 'normal', itemLevel: 30, baseStats: ARM }) },
    inventory: [
      item({ slot: 'weapon', hands: 2, rarity: 'unique', itemLevel: 30, baseStats: DMG, requirements: { strength: 44 } }),
      item({ slot: 'weapon', hands: 1, rarity: 'rare', itemLevel: 30, baseStats: DMG }),
      item({ slot: 'weapon', hands: 1, rarity: 'rare', itemLevel: 25, baseStats: DMG }),
      item({ slot: 'weapon', hands: 2, versatile: true, rarity: 'unique', itemLevel: 40, baseStats: DMG }),
      item({ slot: 'boots', rarity: 'unique', itemLevel: 30, baseStats: ARM, broken: true }),
      item({ slot: 'gloves', rarity: 'rare', itemLevel: 30, baseStats: ARM, requirements: { dexterity: 30 } }),
      item({ slot: 'amulet', rarity: 'rare', itemLevel: 30, baseStats: [{ stat: 'dexterity', kind: 'flat', value: 12 }] }),
      item({ name: 'Зелье', kind: 'consumable' }),
    ],
    belt: [item({ slot: 'belt', rarity: 'magic', itemLevel: 28, baseStats: ARM }), null],
  }),
  capped: save({
    level: 3, masteries: { a: 400 },
    equipment: Object.fromEntries(['weapon', 'offhand', 'helm', 'chest', 'gloves', 'boots', 'belt', 'ring1', 'ring2', 'amulet']
      .map((s) => [s, item({ slot: s, rarity: 'unique', itemLevel: 60, baseStats: s === 'weapon' ? DMG : ARM })])),
  }),
  versatile: save({
    level: 20,
    equipment: { weapon: item({ slot: 'weapon', hands: 2, versatile: true, rarity: 'unique', itemLevel: 20, baseStats: DMG }), offhand: item({ slot: 'offhand', kind: 'shield', rarity: 'rare', itemLevel: 20, baseStats: ARM }) },
    inventory: [item({ slot: 'weapon', hands: 1, rarity: 'normal', itemLevel: 20, baseStats: DMG })],
  }),
  dual: save({
    level: 12, attributes: { strength: 10, dexterity: 10, intelligence: 10, vitality: 10 },
    equipment: { weapon: item({ slot: 'weapon', rarity: 'rare', itemLevel: 12, baseStats: DMG }), offhand: item({ slot: 'weapon', hands: 1, rarity: 'rare', itemLevel: 12, baseStats: DMG }) },
    inventory: [item({ slot: 'weapon', hands: 2, rarity: 'rare', itemLevel: 12, baseStats: DMG, requirements: { strength: 15 } })],
  }),
};
const realAltarCfg = reg;
const synAltarCfg = stub({
  difficulties: [
    { id: 'd0', name: 'Первый', offsetMode: 'percent', offset: -0.25, floorStep: 1, goldMult: 0.9, magicFind: 0.85, unlockFloor: 0 },
    { id: 'd1', name: 'Выключенный', enabled: false, offsetMode: 'flat', offset: 2, floorStep: 1, goldMult: 1, magicFind: 1, unlockFloor: 3 },
    { id: 'd2', name: 'После выключенного', offsetMode: 'flat', offset: 3.5, floorStep: 1, goldMult: 1.333, magicFind: 1.1, unlockFloor: 4 },
    { id: 'd3', name: 'Без порога', offsetMode: 'flat', offset: -50, floorStep: 1, goldMult: 2, magicFind: 2.5, unlockFloor: 0 },
    { id: 'd4', name: 'Половина', offsetMode: 'percent', offset: 0.5, floorStep: 1, goldMult: 1e-7, magicFind: 0.30000000000000004, unlockFloor: 7 },
  ],
  biomes: [
    { id: 'off', name: 'Выкл', enabled: false, tagline: 'x', desc: 'y' },
    { id: 'b1', name: 'Первый биом', tagline: '', desc: 'Описание без слогана' },
    { id: 'b2', name: 'Второй', tagline: 'Слоган', desc: 'Описание' },
    { id: 'b3', name: 'Пустой', tagline: '', desc: '' },
  ],
  'run-templates': [
    { id: 'toff', name: 'Выкл', enabled: false, length: { min: 1, max: 2 }, width: { min: 1, max: 1 }, bossEvery: 1, allowedModifiers: [] },
    { id: 'tA', name: 'Все модификаторы', length: { min: 3, max: 5 }, width: { min: 1, max: 2 }, bossEvery: 0, allowedModifiers: [] },
    { id: 'tB', name: 'Только два', length: { min: 8, max: 11 }, width: { min: 2, max: 3 }, bossEvery: 5, allowedModifiers: ['live-danger', 'live-boon'] },
  ],
  'run-modifiers': [
    { id: 'live-danger', name: 'Опасность', scope: 'run', tags: ['danger'], effects: [{ stat: 'monsterHp', op: 'mul', value: 1.2 }], desc: 'Монстры крепче' },
    { id: 'live-boon', name: 'Благо', scope: 'run', tags: ['boon'], effects: [{ stat: 'gold', op: 'mul', value: 1.2 }] },
    { id: 'live-off', name: 'Выключенный', enabled: false, scope: 'run', tags: ['boon'], effects: [{ stat: 'gold', op: 'mul', value: 1.2 }] },
    { id: 'node-mod', name: 'Узловой', scope: 'node', tags: ['danger'], effects: [{ stat: 'monsterHp', op: 'mul', value: 1.2 }] },
    { id: 'dead', name: 'Не действует', scope: 'run', tags: ['danger'], effects: [{ stat: 'packSize', op: 'mul', value: 1.3 }] },
    { id: 'empty', name: 'Без эффектов', scope: 'run', tags: ['danger'], effects: [] },
    { id: 'mixed', name: 'Наполовину', scope: 'run', tags: ['reward'], effects: [{ stat: 'gold', op: 'mul', value: 1.1 }, { stat: 'packSize', op: 'mul', value: 1.1 }] },
  ],
  balance: { power: { gearRarityWeight: { normal: 1, magic: 2, rare: 3 }, gearDivisor: 3, gearMax: 5, passiveDivisor: 5, passiveMax: 2 } },
  'item-tiers': reg.get('item-tiers'),
});
const SYN_LIVE = new Set(['monsterHp', 'gold']);
type AltarAction = { a: 'open' } | { a: 'biome' | 'tpl' | 'mod'; id: string };
const ALTAR_SEQS: { name: string; cfg: 'real' | 'syn'; save: string; live: string[] | null; actions: AltarAction[] }[] = [
  { name: 'боевой конфиг, свежий герой', cfg: 'real', save: 'fresh', live: null, actions: [{ a: 'open' }, { a: 'biome', id: 'caves' }, { a: 'tpl', id: 'deep-expedition' }] },
  { name: 'боевой конфиг, середина', cfg: 'real', save: 'mid', live: null, actions: [{ a: 'open' }, { a: 'biome', id: 'labyrinth' }] },
  { name: 'боевой конфиг, запас в сумке и поясе', cfg: 'real', save: 'spare', live: null, actions: [{ a: 'open' }] },
  { name: 'боевой конфиг, потолок гира и мастерства', cfg: 'real', save: 'capped', live: null, actions: [{ a: 'open' }] },
  { name: 'боевой конфиг, два одноручника', cfg: 'real', save: 'dual', live: null, actions: [{ a: 'open' }] },
  { name: 'боевой конфиг, полуторный со щитом', cfg: 'real', save: 'versatile', live: null, actions: [{ a: 'open' }] },
  { name: 'боевой конфиг, все модификаторы «действуют»', cfg: 'real', save: 'mid', live: ['packSize', 'monsterHp', 'monsterDamage', 'gold', 'magicFind', 'playerMaxHp', 'dropBias'],
    actions: [{ a: 'open' }, { a: 'mod', id: 'pack-swarm' }, { a: 'mod', id: 'greedy-vault' }, { a: 'mod', id: 'relic-vitality' }, { a: 'tpl', id: 'crypt-short' }, { a: 'mod', id: 'pack-swarm' }, { a: 'tpl', id: 'deep-expedition' }] },
  { name: 'синтетика: выключенные, пустой слоган, чистка выбора', cfg: 'syn', save: 'mid', live: [...SYN_LIVE],
    actions: [{ a: 'open' }, { a: 'mod', id: 'live-danger' }, { a: 'mod', id: 'mixed' }, { a: 'mod', id: 'live-boon' }, { a: 'tpl', id: 'tB' }, { a: 'biome', id: 'b2' }, { a: 'biome', id: 'b3' },
      { a: 'biome', id: 'off' }, { a: 'tpl', id: 'toff' }, { a: 'mod', id: 'live-danger' }] },
  { name: 'синтетика: прогресс открывает тиры после выключенного', cfg: 'syn', save: 'spare', live: [], actions: [{ a: 'open' }] },
];
function runAltar(seq: (typeof ALTAR_SEQS)[number]): unknown[] {
  const cfg = seq.cfg === 'real' ? realAltarCfg : synAltarCfg;
  const live = seq.live ? new Set(seq.live) : RUN_MOD_LIVE_STATS;
  const sel: AltarSel = { mods: new Set() };
  return seq.actions.map((act) => {
    if (act.a === 'biome') sel.biome = act.id;
    else if (act.a === 'tpl') sel.tpl = act.id;
    else if (act.a === 'mod') { if (sel.mods.has(act.id)) sel.mods.delete(act.id); else sel.mods.add(act.id); }
    return altarModel(cfg, SAVES[seq.save]!, sel, live);
  });
}
/** Конфиг алтаря, как его видит Unity (`/api/config`): только читаемые окном таблицы. */
const altarCfgJson = (cfg: ConfigRegistry): unknown => ({
  difficulties: cfg.get('difficulties'), biomes: cfg.get('biomes'), 'run-templates': cfg.get('run-templates'), 'run-modifiers': cfg.get('run-modifiers'),
  balance: { power: cfg.get('balance').power }, 'item-tiers': cfg.get('item-tiers'),
});

// ── 4. карта забега (runMapPanel.ts) — копия раскладки, сторожится `SRC` ──────────────────────
const COL_W = 96, ROW_H = 66, PAD = 28, R = 16;
const GOLD = '#dca94b';
const hex = (n: number): string => '#' + n.toString(16).padStart(6, '0');
function runMap(plan: RunPlan | null, currentNodeId: string | null): unknown {
  if (!plan) return { empty: 'Забег не активен — карта появится в подземелье.' };
  const byDepth = new Map<number, RunPlan['nodes']>();
  for (const n of plan.nodes) { const a = byDepth.get(n.depth) ?? []; a.push(n); byDepth.set(n.depth, a); }
  for (const a of byDepth.values()) a.sort((p, q) => p.lane - q.lane);
  const maxDepth = Math.max(...plan.nodes.map((n) => n.depth));
  const maxCol = Math.max(...[...byDepth.values()].map((a) => a.length));
  const width = PAD * 2 + maxDepth * COL_W;
  const height = PAD * 2 + (maxCol - 1) * ROW_H;
  const midY = PAD + (maxCol - 1) * ROW_H / 2;
  const pos = new Map<string, { x: number; y: number }>();
  for (const [depth, arr] of byDepth) arr.forEach((n, i) => pos.set(n.id, { x: PAD + depth * COL_W, y: midY + (i - (arr.length - 1) / 2) * ROW_H }));
  const cur = plan.nodes.find((n) => n.id === currentNodeId);
  const nextIds = new Set(cur?.edges.map((e) => e.to) ?? []);
  const edges: unknown[] = [];
  for (const n of plan.nodes) {
    if (!pos.get(n.id)) continue;
    for (const e of n.edges) {
      if (!pos.get(e.to)) continue;
      const hot = n.id === currentNodeId;
      edges.push({ from: n.id, to: e.to, stroke: hot ? GOLD : '#4a4640', width: hot ? 2.5 : 1.5, opacity: hot ? 0.9 : 0.5 });
    }
  }
  const nodes = plan.nodes.filter((n) => pos.get(n.id)).map((n) => {
    const p = pos.get(n.id)!;
    const isCur = n.id === currentNodeId, isNext = nextIds.has(n.id);
    return {
      id: n.id, x: p.x, y: p.y, fill: hex(RUN_NODE_COLOR[n.type as keyof typeof RUN_NODE_COLOR] ?? 0x8a8f9a), ring: isCur ? { r: R + 6, stroke: GOLD, width: 3 } : null,
      stroke: isNext ? GOLD : '#1a1a1a', strokeWidth: isNext ? 2.5 : 1.5, fillOpacity: isCur || isNext ? 1 : 0.82,
      label: runNodeLabel(n.type), labelY: p.y + R + 13, labelColor: isCur ? GOLD : '#c4bca8', star: n.modifiers.length > 0,
    };
  });
  return { head: `Шаблон ${plan.templateId} · биом ${plan.biomeId} · тир ${plan.tier} · ${plan.nodes.length} узлов`, width, height, r: R, nodes, edges };
}
const mnode = (id: string, type: string, depth: number, lane: number, to: string[], mods: string[] = []): RunPlan['nodes'][number] =>
  ({ id, type, depth, lane, biomeId: 'crypt', floorSpec: {}, modifiers: mods, edges: to.map((t) => ({ to: t })) } as unknown as RunPlan['nodes'][number]);
const SYN_MAP: RunPlan = {
  templateId: 't<i>', biomeId: 'crypt', tier: 'normal', seed: 1, startId: 's', runModifiers: [],
  nodes: [
    mnode('s', 'start', 0, 0, ['a', 'b', 'c']), mnode('c', 'mystery', 1, 2, ['d']), mnode('a', 'shop', 1, 0, ['d'], ['boon-cache']), mnode('b', 'boss', 1, 1, ['d', 'ghost']),
    mnode('d', 'combat', 2, 0, ['f']), mnode('f', 'finale', 4, 0, []), mnode('e1', 'elite', 3, 5, []), mnode('e0', 'rest', 3, 5, ['f']),
  ],
};
const MAP_PLANS: RunPlan[] = [SYN_MAP];
for (const t of reg.get('run-templates').filter((x) => x.enabled !== false)) for (const seed of [7, 4242]) MAP_PLANS.push(generateRunPlan(reg, defaultRunConfig(reg, t.id, seed)));

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
    altar: {
      title: 'Алтарь забега', arena: '⚔ PvP-арена (дуэль на алтаре)', arenaNote: 'Круглый зал: спавн в разных концах, урон по друг другу, гибель без потерь.',
      sections: { biome: 'Биом (павшая империя)', template: 'Шаблон забега', mods: 'Модификаторы', modsNote: 'Благо — только в паре с опасностью: лишние блага алтарь отбросит.', tiers: 'Сложность (тир) — жмите «Войти»' },
      liveStats: [...RUN_MOD_LIVE_STATS],
      cfgs: { real: altarCfgJson(realAltarCfg), syn: altarCfgJson(synAltarCfg) },
      saves: SAVES,
      seqs: ALTAR_SEQS.map((s) => ({ ...s, out: runAltar(s) })),
    },
    runMap: {
      colW: COL_W, rowH: ROW_H, pad: PAD, r: R,
      // План, как его читает карта: шапка и узлы (id, тип, слой, полоса, модификаторы, рёбра) — остальное карта не читает.
      plans: MAP_PLANS.map((p) => ({ templateId: p.templateId, biomeId: p.biomeId, tier: p.tier, startId: p.startId,
        nodes: p.nodes.map((n) => ({ id: n.id, type: n.type, depth: n.depth, lane: n.lane, modifiers: n.modifiers, edges: n.edges.map((e) => ({ to: e.to })) })) })),
      legend: (['combat', 'elite', 'boss', 'treasure', 'rest', 'finale'] as const).map((t) => ({ type: t, label: runNodeLabel(t), color: hex(RUN_NODE_COLOR[t]) })),
      cases: [
        { plan: null, current: null, out: runMap(null, null) },
        ...MAP_PLANS.flatMap((p, k) => [p.startId, p.nodes[Math.floor(p.nodes.length / 2)]!.id, p.nodes[p.nodes.length - 1]!.id, 'ghost', null]
          .map((cur) => ({ plan: k, current: cur, out: runMap(p, cur) }))),
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

  it('покрытие: замки тиров, модификаторы алтаря, плашка смерти, развилки карты, Tab по кругу, затухание и целые стены', () => {
    const g = build() as {
      altar: { seqs: { out: { tiers: { unlocked: boolean }[]; mods: unknown[] }[] }[] }; death: { seqs: { out: { dock: unknown }[] }[] };
      runMap: { cases: { out: { nodes?: { ring: unknown }[]; edges?: { width: number }[] } }[] }; spectate: { seqs: { out: { used?: boolean }[] }[] };
      wallFade: { samples: { amt: number }[] };
    };
    const tiers = g.altar.seqs.flatMap((s) => s.out.flatMap((o) => o.tiers));
    expect(tiers.some((t) => t.unlocked) && tiers.some((t) => !t.unlocked)).toBe(true);
    expect(g.altar.seqs.some((s) => s.out.some((o) => o.mods.length > 0))).toBe(true);
    expect(g.altar.seqs[0]!.out[0]!.mods.length, 'боевой конфиг: модификаторов-действующих нет (R8-12)').toBe(0);
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

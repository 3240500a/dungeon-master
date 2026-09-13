import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { readFileSync, existsSync } from 'node:fs';
import { parseModel, exportGLB } from './modelAssets.js';
import { glbSkinReport } from './glbCheck.js';

/**
 * СКВОЗНОЙ ПРОГОН НАСТОЯЩЕГО ИСХОДНИКА: FBX → наш импорт → наш экспорт → наш импорт.
 *
 * Жалоба: «удалил все модели, импортнул заново — модель не отображается, атлас не распознаётся».
 * Ни один синтетический тест этого не ловил, потому что ломалось на КОНКРЕТНОЙ форме скелета из
 * AccuRIG/CC: верхний узел `RL_BoneRoot` — кость, но в суставы скина не входит. Схлопывание дублей
 * принимало решение по одному корню поддерева и уносило ВСЮ арматуру: 3801 кость → 0, все 3800
 * повисли вне дерева, экспорт записал 3800 ссылок в никуда.
 *
 * Поэтому здесь прогоняется файл художника целиком. Тест пропускается там, где исходника нет
 * (он живёт вне репозитория) — на машине, где ведётся работа, он есть, и это главное.
 */
const FBX = 'C:/work/Games_Art/Games_Art/top_down/model_ai/char/knight_01/Modular_01/fbx/knight_05_modular_rig.fbx';

class NodeFileReader {
  result: ArrayBuffer | null = null;
  onloadend: (() => void) | null = null;
  readAsArrayBuffer(b: Blob): void { void b.arrayBuffer().then((ab) => { this.result = ab; this.onloadend?.(); }); }
}
(globalThis as unknown as { FileReader: unknown }).FileReader ??= NodeFileReader;

const read = (p: string): ArrayBuffer => { const b = readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; };
interface Look { bones: number; skinned: number; skeletons: number; detached: number }
function look(root: THREE.Object3D): Look {
  const inTree = new Set<THREE.Object3D>();
  root.traverse((o) => inTree.add(o));
  const skels = new Set<THREE.Skeleton>();
  let bones = 0, skinned = 0, detached = 0;
  root.traverse((o) => {
    if ((o as THREE.Bone).isBone) bones++;
    const sm = o as THREE.SkinnedMesh;
    if (sm.isSkinnedMesh) { skinned++; skels.add(sm.skeleton); for (const b of sm.skeleton.bones) if (!inTree.has(b)) detached++; }
  });
  return { bones, skinned, skeletons: skels.size, detached };
}

describe.runIf(existsSync(FBX))('FBX художника проходит импорт и экспорт', () => {
  it('⭐ разбор: 38 копий скелета схлопываются в один, и НИ ОДНА ведущая кость не теряется', async () => {
    const root = await parseModel(read(FBX), 'fbx');
    const l = look(root);
    expect(l.skinned, 'части модели на месте').toBeGreaterThan(30);
    expect(l.skeletons, 'скелет ОДИН — как и положено модульному персонажу').toBe(1);
    expect(l.detached, '⚠ кость, которая ведёт меш, обязана быть В ДЕРЕВЕ').toBe(0);
    expect(l.bones, 'дубли ушли: было 3801').toBeLessThan(200);
    expect(l.bones, 'но сам скелет остался').toBeGreaterThan(50);
  });

  it('⭐ экспорт: файл валиден и устроен по норме — один скин на всех', async () => {
    const glb = await exportGLB(await parseModel(read(FBX), 'fbx'));   // бросит сам, если ссылки повисли
    const rep = glbSkinReport(glb);
    expect(rep.badJoints, 'висячих ссылок на суставы нет').toBe(0);
    expect(rep.skins, 'один скелет — ОДИН скин, а не по скину на каждую часть').toBe(1);
    expect(rep.bones, 'кости в файле').toBeGreaterThan(50);
    expect(rep.meshes, 'и все части').toBeGreaterThan(30);
  });

  it('⭐ и он грузится обратно — круг замкнут, схлопывать на загрузке уже нечего', async () => {
    const glb = await exportGLB(await parseModel(read(FBX), 'fbx'));
    const l = look(await parseModel(glb, 'glb'));
    expect(l.skeletons).toBe(1);
    expect(l.detached).toBe(0);
    expect(l.skinned).toBeGreaterThan(30);
  });
});

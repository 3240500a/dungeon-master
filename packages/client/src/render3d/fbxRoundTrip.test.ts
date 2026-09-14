import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { readFileSync, existsSync } from 'node:fs';
import { parseModel, exportGLB } from './modelAssets.js';
import { glbSkinReport } from './glbCheck.js';
import { autoBoneMap, measureBoneOffsets } from './retarget3d.js';

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
/** Тот же рыцарь, пересохранённый Максом: скины ЧАСТИЧНЫЕ (6…36 костей на меш) — другая форма файла. */
const FBX_MAX = FBX.replace('knight_05', 'knight_06');

class NodeFileReader {
  result: ArrayBuffer | null = null;
  onloadend: (() => void) | null = null;
  readAsArrayBuffer(b: Blob): void { void b.arrayBuffer().then((ab) => { this.result = ab; this.onloadend?.(); }); }
}
(globalThis as unknown as { FileReader: unknown }).FileReader ??= NodeFileReader;

const boneNames = (root: THREE.Object3D): string[] => { const out: string[] = []; root.traverse((o) => { if ((o as THREE.Bone).isBone) out.push(o.name); }); return out; };
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

  it('⭐ ЗАЗЕМЛЕНИЕ ЕДЕТ ИЗ МОДЕЛИ: высота таза = «таз − рут-кость», и круг её сохраняет', async () => {
    // Автор: «в максе есть рут-кость, она в нуле — по ней и заземляйте, ничего не подкручивая».
    // Так и делаем: рут стоит на полу, значит высота таза над полом берётся прямо из файла.
    // Замер knight_05: рут 0.00, низшая вершина меша −0.00, таз 34.91 — а подгонка под лодыжку
    // НАШЕГО базового рига давала 33.00, и меш тонул ровно на эти 1.9.
    const fromFbx = await parseModel(read(FBX), 'fbx');
    const hipsFbx = measureBoneOffsets(fromFbx, autoBoneMap(boneNames(fromFbx)))['Hips']![1];
    expect(hipsFbx, 'таз стоит на своей высоте из модели').toBeCloseTo(34.91, 1);

    // И ЭТО ЖЕ ЧИСЛО обязано получиться из нашего собственного экспорта — иначе переимпорт уже
    // нашего GLB дал бы другую модель. Рут-кость для этого должна пережить экспорт.
    const glb = await exportGLB(await parseModel(read(FBX), 'fbx'));
    const back = await parseModel(glb, 'glb');
    // ⚠ Корень арматуры ищем не по флагу кости: в glTF он приезжает обычным узлом (в суставы скина
    // он не входит), поэтому и замер ищет его по смыслу — «предок таза без мешей внутри».
    let names: string[] = [];
    back.traverse((o) => { if (/BoneRoot|^Root$/i.test(o.name)) names.push(o.name); });
    expect(names.length, 'корень арматуры обязан пережить экспорт').toBeGreaterThan(0);
    const hipsGlb = measureBoneOffsets(back, autoBoneMap(boneNames(back)))['Hips']![1];
    expect(hipsGlb, 'круг не меняет геометрию рига').toBeCloseTo(hipsFbx, 1);
  });

  it('⭐ и он грузится обратно — круг замкнут, схлопывать на загрузке уже нечего', async () => {
    const glb = await exportGLB(await parseModel(read(FBX), 'fbx'));
    const l = look(await parseModel(glb, 'glb'));
    expect(l.skeletons).toBe(1);
    expect(l.detached).toBe(0);
    expect(l.skinned).toBeGreaterThan(30);
  });

  it('⭐ КОСТЬ БЕЗ ВЕСОВ — ВСЁ РАВНО КОСТЬ: скин экспорта = ВСЯ арматура, а не только весящее', async () => {
    // Жалоба: «стало лучше, но поломались руки». Общий скелет собирался из костей, У КОТОРЫХ ЕСТЬ
    // ВЕСА, — а у CC/AccuRIG скин сидит на ТВИСТАХ (`UpperarmTwist01/02`, `ForearmTwist01/02`), и
    // сами `Upperarm`/`Forearm` не несут ни одной вершины. Замер ниже: таких ведущих костей ДЕВЯТЬ —
    // обе руки, обе ноги, пальцы ноги. В glTF костью становится ТОЛЬКО сустав скина, поэтому
    // выброшенные кости приезжали обратно обычными узлами, `autoBoneMap` их не находил, и ретаргет
    // просто переставал вести руку. Экспорт 05 давал 100 суставов, 06 — 61.
    for (const f of [FBX, FBX_MAX].filter((x) => existsSync(x))) await one(f);
  });

  async function one(file: string): Promise<void> {
    const src = await parseModel(read(file), 'fbx');
    const weighted = new Set<string>();
    src.traverse((o) => {
      const m = o as THREE.SkinnedMesh; if (!m.isSkinnedMesh) return;
      const si = m.geometry.getAttribute('skinIndex'), sw = m.geometry.getAttribute('skinWeight');
      for (let v = 0; v < si.count; v++) for (let k = 0; k < 4; k++) {
        if ((sw.getComponent(v, k) as number) > 1e-6) weighted.add(m.skeleton.bones[si.getComponent(v, k) as number]?.name ?? '');
      }
    });
    const before = autoBoneMap(boneNames(src));
    const driven = Object.values(before).filter((n): n is string => !!n);
    const dead = driven.filter((n) => !weighted.has(n));
    expect(dead.length, 'иначе тест пустой: у этой модели все ведущие кости и так весят').toBeGreaterThan(0);

    const back = await parseModel(await exportGLB(src), 'glb');
    const after = new Set(boneNames(back));
    const lost = driven.filter((n) => !after.has(n));
    expect(lost, `⚠ ${file.split('/').pop()}: ведущие кости пропали из скина: ${lost.join(', ')}`).toEqual([]);
  }
});

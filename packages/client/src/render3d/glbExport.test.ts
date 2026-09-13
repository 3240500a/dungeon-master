import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { glbSkinReport } from './glbCheck.js';
import { mergeIdenticalSkins } from './glbNormalize.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * ЭКСПОРТ АССЕТА НЕ ИМЕЕТ ПРАВА ПОТЕРЯТЬ СКЕЛЕТ.
 *
 * Жалоба: «удалил все модели, импортнул заново — модель не отображается, атлас не распознаётся».
 * Вскрытие залитого GLB: 38 мешей, и у ВСЕХ скинов `joints` = 100 × `null`, костей в файле нет вовсе.
 * Такой GLB не грузится ничем (`Cannot set properties of undefined (setting 'isBone')`).
 *
 * ⚠ НАСТОЯЩАЯ ПРИЧИНА БЫЛА В СХЛОПЫВАНИИ СКЕЛЕТОВ, а не здесь — см. `skeletonDedupe.test.ts`: снос
 * дублей уносил и канон-арматуру, кости оказывались ВНЕ экспортируемого дерева. Первая версия этого
 * файла объявляла причиной скрытый скелет; на GLB это воспроизводилось, на настоящем FBX — нет.
 * Тесты ниже описывают ВТОРОЙ, независимый способ потерять кости (он тоже реален, и `onlyVisible`
 * от него страхует) — и правило «один скелет = один скин», ради которого файл вообще нормализуется.
 */
/**
 * ⚠ `GLTFExporter` для бинарного GLB читает Blob через `FileReader`, а в node его нет. Шим в три
 * строки — дешевле, чем тащить jsdom ради одного класса; на проверяемое поведение он не влияет.
 */
class NodeFileReader {
  result: ArrayBuffer | null = null;
  onloadend: (() => void) | null = null;
  readAsArrayBuffer(b: Blob): void { void b.arrayBuffer().then((ab) => { this.result = ab; this.onloadend?.(); }); }
}
(globalThis as unknown as { FileReader: unknown }).FileReader ??= NodeFileReader;

const bone = (name: string, y: number): THREE.Bone => { const b = new THREE.Bone(); b.name = name; b.position.y = y; return b; };

/** Скиннед-меш на двух костях; `hide` прячет скелет — ровно как приходит из макса. */
function scene(hide: boolean): THREE.Object3D {
  const root = new THREE.Group();
  const b0 = bone('Hips', 0), b1 = bone('Spine', 1);
  b0.add(b1); root.add(b0);
  if (hide) b0.visible = false;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0], 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial());
  mesh.name = 'body_01';
  const skel = new THREE.Skeleton([b0, b1]);
  root.add(mesh); mesh.bind(skel);
  root.updateMatrixWorld(true);
  return root;
}
const save = (obj: THREE.Object3D, onlyVisible: boolean): Promise<ArrayBuffer> =>
  new Promise((res, rej) => new GLTFExporter().parse(obj, (r) => res(r as ArrayBuffer), rej, { binary: true, onlyVisible }));

describe('скелет переживает экспорт', () => {
  it('⚠ ВОТ КАК ЛОМАЛОСЬ: со скрытым скелетом и onlyVisible экспорт пишет joints = null', async () => {
    // Это не гипотеза, а воспроизведение: ровно такой файл и лежал на сервере.
    const rep = glbSkinReport(await save(scene(true), true));
    expect(rep.skins, 'скин в файле есть').toBe(1);
    expect(rep.badJoints, 'а суставы — битые').toBeGreaterThan(0);
    expect(rep.bones, 'костей в файле нет вовсе').toBe(0);
  });

  it('⭐ с onlyVisible=false кости на месте и ссылки целы', async () => {
    const rep = glbSkinReport(await save(scene(true), false));
    expect(rep.badJoints, 'ни одной висячей ссылки').toBe(0);
    expect(rep.bones, 'кости выгрузились').toBe(2);
  });

  it('видимый скелет цел в любом случае — старые ассеты не задеты', async () => {
    for (const ov of [true, false]) {
      const rep = glbSkinReport(await save(scene(false), ov));
      expect(rep.badJoints, `onlyVisible=${ov}`).toBe(0);
    }
  });
});

describe('один скелет — один скин (норма индустрии)', () => {
  /** Два меша на ОДНОМ скелете — ровно так собирают модульного персонажа. */
  function twoParts(): THREE.Object3D {
    const root = new THREE.Group();
    const b0 = bone('Hips', 0), b1 = bone('Spine', 1);
    b0.add(b1); root.add(b0);
    const skel = new THREE.Skeleton([b0, b1]);
    for (const nm of ['body_01', 'helm_01']) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
      geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0], 4));
      geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
      const m = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial());
      m.name = nm; root.add(m); m.bind(skel);
    }
    root.updateMatrixWorld(true);
    return root;
  }

  it('⚠ экспортёр заводит скин НА КАЖДЫЙ меш, даже когда скелет общий', async () => {
    // Не придирка к three: из такого файла при загрузке снова рождается N скелетов, и схлопывание
    // на загрузке начинает кормить само себя — файл остаётся неправильным сколько ни переэкспортируй.
    expect(glbSkinReport(await save(twoParts(), false)).skins).toBe(2);
  });

  it('⭐ схлопывание приводит файл к норме: один скин, ссылки целы', async () => {
    const { out, report } = mergeIdenticalSkins(await save(twoParts(), false));
    expect(report).toMatchObject({ before: 2, after: 1 });
    const rep = glbSkinReport(out);
    expect(rep, 'кости на месте, висячих ссылок нет').toMatchObject({ skins: 1, bones: 2, badJoints: 0, meshes: 2 });
  });

  it('⭐ и файл после этого ГРУЗИТСЯ: оба меша на одном скелете', async () => {
    const { out } = mergeIdenticalSkins(await save(twoParts(), false));
    const back: THREE.Group = await new Promise((res, rej) => new GLTFLoader().parse(out, '', (g) => res(g.scene as unknown as THREE.Group), rej));
    const skels = new Set<THREE.Skeleton>();
    let skinned = 0;
    back.traverse((o) => { const sm = o as THREE.SkinnedMesh; if (sm.isSkinnedMesh) { skinned++; skels.add(sm.skeleton); } });
    expect(skinned, 'обе части на месте').toBe(2);
    expect(skels.size, 'и скелет у них ОДИН — схлопывать на загрузке больше нечего').toBe(1);
  });

  it('разные скелеты НЕ схлопываются — это был бы уже не тот меш', async () => {
    const root = new THREE.Group();
    const a = scene(false), b = scene(false);
    b.traverse((o) => { if ((o as THREE.Bone).isBone) o.position.y += 5; });   // другая геометрия → другие бинд-матрицы
    root.add(a, b); root.updateMatrixWorld(true);
    const { report } = mergeIdenticalSkins(await save(root, false));
    expect(report.after, 'два разных скелета так и остались двумя').toBe(2);
  });
});

describe('проверка GLB ловит битый файл', () => {
  it('считает скины, кости и висячие ссылки', async () => {
    const ok = glbSkinReport(await save(scene(false), false));
    expect(ok).toMatchObject({ skins: 1, bones: 2, badJoints: 0 });
    expect(() => glbSkinReport(new ArrayBuffer(4))).toThrow();   // не GLB — не молчим
  });
});

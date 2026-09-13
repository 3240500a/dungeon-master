import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { glbSkinReport } from './glbCheck.js';

/**
 * ЭКСПОРТ АССЕТА НЕ ИМЕЕТ ПРАВА ПОТЕРЯТЬ СКЕЛЕТ.
 *
 * Жалоба: «удалил все модели, импортнул заново — модель не отображается, атлас не распознаётся».
 * Вскрытие залитого GLB: 38 мешей, 39 нод, и у ВСЕХ 38 скинов `joints` = 100 × `null`. То есть кости
 * в файл не попали вовсе, а ссылки на них остались — такой GLB не грузится ничем
 * (`Cannot set properties of undefined (setting 'isBone')`), поэтому и меша нет, и сабмеши не
 * классифицируются.
 *
 * ⚠ ПРИЧИНА — `onlyVisible`, который у `GLTFExporter` по умолчанию ВКЛЮЧЁН: ноды с `visible === false`
 * он пропускает, а `processSkin` всё равно пишет им ссылки — получаются `null`. Скелет приезжает
 * невидимым штатно: в максе его прячут, чтобы он не мешал, и FBX несёт этот флаг с собой.
 *
 * Для АССЕТА видимость — вопрос вьюпорта, а не данных: экспортируем всё.
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

describe('проверка GLB ловит битый файл', () => {
  it('считает скины, кости и висячие ссылки', async () => {
    const ok = glbSkinReport(await save(scene(false), false));
    expect(ok).toMatchObject({ skins: 1, bones: 2, badJoints: 0 });
    expect(() => glbSkinReport(new ArrayBuffer(4))).toThrow();   // не GLB — не молчим
  });
});

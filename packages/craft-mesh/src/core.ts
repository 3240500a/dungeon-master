import * as THREE from 'three';

/**
 * ПАРАМЕТРИЧЕСКИЙ МЕШ СКОВАННОГО ОРУЖИЯ — общий каркас (docs/CRAFT_WEAPONS.md §18, визуал Ф1).
 *
 * Модель собирается из ТЕХ ЖЕ деталей, что и вещь: форма клинка по типу Окшотта, своя гарда,
 * своё навершие; у топора полотно, щекавицы и обух; у лука рога и концы. Цвет — от материала
 * каждой детали. Ни одного файла модели: всё процедурно, поэтому 284 варианта не требуют 284 мешей.
 *
 * ⚠ КОНТРАКТ ДЛЯ ПОСТРОИТЕЛЕЙ (`blades.ts`, `hafted.ts`, `polearms.ts`, `ranged.ts`, `magic.ts`):
 * - единицы — САНТИМЕТРЫ реального оружия (длинный меч ≈ 95 см, пика ≈ 400 см);
 * - начало координат — место, где держит ОСНОВНАЯ рука; рабочий конец (клинок, било, перо, верх
 *   лука) уходит в −Y — так же, как у игрового `render3d/weapon3d.ts`;
 * - плоскость клинка/полотна — XY: лезвия вдоль ±X, толщина по Z; режущая кромка топора и
 *   алебарды смотрит в +X; у лука спина в +X, тетива со стороны −X; у арбалета ложе вдоль −Y,
 *   дуга поперёк по X;
 * - построитель возвращает группу, в которой РОВНО четыре дочерние группы с именами гнёзд
 *   `strike`, `grip`, `bind`, `head` (`slotGroups()` делает это за тебя). По ним тест меряет,
 *   что разные детали дают РАЗНУЮ геометрию, а превью — подписывает части.
 */

export type SlotName = 'strike' | 'grip' | 'bind' | 'head';
export const SLOT_NAMES: readonly SlotName[] = ['strike', 'grip', 'bind', 'head'];

/** Деталь глазами построителя: форма (ось, теги) и её материал. */
export interface PartView {
  id: string;
  name: string;
  /** −1…+1: у ударной части +1 — тяжёлая/крупная, −1 — лёгкая/тонкая. У остальных — своя ось гнезда. */
  axis: number;
  /** Ступень материала 1…5. */
  step: number;
  /** Семья материала этой детали (`iron`, `wood`, `trim`…), уже с учётом `family` варианта. */
  family: string;
  /** Теги-классификаторы варианта; отсутствующие дополнены умолчаниями словаря. */
  tags: Record<string, string>;
}

export interface MeshCtx {
  /** Класс оружия (`sword`, `axe`…). */
  cls: string;
  /** Хват семейства: 1 — одноручное, 2 — двуручное. */
  hands: number;
  /** База, которую выбрала ключевая деталь (`long-sword`, `claymore`…). */
  baseId: string;
  parts: Record<SlotName, PartView>;
  /** Значение тега детали (или '' если нет). */
  tag(slot: SlotName, key: string): string;
  /** Материал детали — по её семье и ступени. */
  mat(slot: SlotName): THREE.Material;
  /** Материал любой семьи и ступени (для второстепенных частей: оплётка, накладки, тетива). */
  matOf(family: string, step: number): THREE.Material;
  /** Постоянный материал для мелочи, которой нет в лестницах (рог нока, свинец, кость). */
  fixed(color: number, metalness?: number, roughness?: number): THREE.Material;
  /** Свечение стихии у магического оружия (молния, холод, яд, огонь, архимаг). 0 — не магия. */
  glow: number;
}

export type Builder = (ctx: MeshCtx) => THREE.Group;

// ── Материалы ────────────────────────────────────────────────────────────────────────────────────

/** Цвет ступеней 1…5 по семьям — от исторического материала (§10). */
export const FAMILY_TINT: Record<string, number[]> = {
  iron: [0x6b5a4e, 0x86837c, 0xa3aab0, 0x8f9aa8, 0xd2d8de],   // болотное → кричное → уклад → дамаск → булат
  wood: [0xb08a5a, 0xa98b62, 0x7a5638, 0x3a2e26, 0x6a5238],   // сосна → ясень → граб → морёный дуб → клееное
  // Воронёная сталь — синевато-серая, а не почти чёрная: на тёмном фоне превью гарда и обух иначе теряются.
  trim: [0x3a3a3c, 0x9c6b30, 0x4a5f78, 0xc8ccd2, 0xd4af37],   // чёрное железо → бронза → воронёная → серебро → золото
  hide: [0x8a6a4a, 0x6b4a2e, 0x4a3220, 0x3a2418, 0xc9c8c0],   // сыромять → дублёная → варёная → кордован → скат
  cloth: [0xb8a888, 0xd0c0a0, 0xe8e0c8, 0xf0ead8, 0xe0d6f0],  // пенька → жила → лён → шёлк → морской шёлк
  plate: [0x6b5a4e, 0x86837c, 0xa3aab0, 0x9aa6b4, 0xd2d8de],
};

/** Металлика и шероховатость семьи по ступени — чтобы булат блестел, а болотное железо — нет. */
function surfaceOf(family: string, step: number): { metalness: number; roughness: number; transparent?: boolean; opacity?: number } {
  const k = (step - 1) / 4;
  switch (family) {
    case 'iron': case 'plate': return { metalness: 0.75 + 0.2 * k, roughness: 0.62 - 0.4 * k };
    case 'trim': return { metalness: step === 1 ? 0.6 : 0.9, roughness: 0.5 - 0.3 * k };
    case 'hide': return { metalness: 0, roughness: 0.9 - 0.2 * k };
    case 'cloth': return { metalness: 0, roughness: 0.85 };
    default: return { metalness: 0, roughness: 0.8 - 0.2 * k }; // wood
  }
}

const hex6 = (c: number): string => c.toString(16).padStart(6, '0');

/**
 * Кэш материалов на одну сборку: одна и та же пара «семья × ступень» — один объект.
 * Имя материала — `семья:ступень` (у светящегося навершия — `:glow=rrggbb`), у мелочи вне лестниц — `fixed:rrggbb`: по нему
 * Unity ставит СВОЙ материал на модель из GLB сервера (`GET /api/craft-mesh.glb`, CRAFT_WEAPONS.md §21.1). Вебу имя не нужно.
 */
export class MatCache {
  private map = new Map<string, THREE.Material>();
  of(family: string, step: number, glow = 0): THREE.Material {
    const s = Math.max(1, Math.min(5, Math.round(step)));
    const key = `${family}|${s}|${glow}`;
    let m = this.map.get(key);
    if (!m) {
      const color = FAMILY_TINT[family]?.[s - 1] ?? 0x888888;
      const surf = surfaceOf(family, s);
      const mm = new THREE.MeshStandardMaterial({ color, ...surf });
      // Свечение стихии (навершие жезла и посоха): эмиссия поверх цвета ступени — металл Прибора читается, камень светится.
      if (glow) { mm.emissive.setHex(glow); mm.emissiveIntensity = 0.45; }
      mm.name = glow ? `${family}:${s}:glow=${hex6(glow)}` : `${family}:${s}`;
      m = mm;
      this.map.set(key, m);
    }
    return m;
  }
  fixed(color: number, metalness = 0, roughness = 0.7): THREE.Material {
    const key = `fixed|${color}|${metalness}|${roughness}`;
    let m = this.map.get(key);
    if (!m) { m = new THREE.MeshStandardMaterial({ color, metalness, roughness }); m.name = `fixed:${hex6(color)}`; this.map.set(key, m); }
    return m;
  }
  dispose(): void { for (const m of this.map.values()) m.dispose(); this.map.clear(); }
}

// ── Геометрия: примитивы ─────────────────────────────────────────────────────────────────────────

export type V2 = [number, number];

export function mesh(geo: THREE.BufferGeometry, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  return m;
}

/** Поставить объект: позиция и (необязательно) поворот в радианах. Возвращает его же. */
export function at<T extends THREE.Object3D>(o: T, x: number, y: number, z = 0, rx = 0, ry = 0, rz = 0): T {
  o.position.set(x, y, z);
  o.rotation.set(rx, ry, rz);
  return o;
}

export const box = (w: number, h: number, d: number, mat: THREE.Material): THREE.Mesh => mesh(new THREE.BoxGeometry(w, h, d), mat);
/** Цилиндр вдоль Y: радиус верха (+Y) и низа (−Y). */
export const cyl = (rTop: number, rBot: number, h: number, mat: THREE.Material, seg = 12): THREE.Mesh => mesh(new THREE.CylinderGeometry(rTop, rBot, h, seg), mat);
export const sphere = (r: number, mat: THREE.Material, seg = 14): THREE.Mesh => mesh(new THREE.SphereGeometry(r, seg, Math.max(6, Math.round(seg * 0.7))), mat);
/** Конус вдоль Y, остриём в +Y (поверни на π по Z, чтобы остриём в −Y). */
export const cone = (r: number, h: number, mat: THREE.Material, seg = 12): THREE.Mesh => mesh(new THREE.ConeGeometry(r, h, seg), mat);
/** Тор в плоскости XY. */
export const torus = (R: number, r: number, mat: THREE.Material, arc = Math.PI * 2, seg = 24): THREE.Mesh => mesh(new THREE.TorusGeometry(R, r, 8, seg, arc), mat);

/**
 * ТЕЛО ВРАЩЕНИЯ вокруг оси Y по профилю [радиус, y] — навершия, била, втулки, наконечники.
 * Профиль идёт по порядку y (сверху вниз или снизу вверх — неважно), радиусы ≥ 0.
 */
export function latheY(profile: V2[], mat: THREE.Material, segments = 18): THREE.Mesh {
  const pts = profile.map(([r, y]) => new THREE.Vector2(Math.max(0.001, r), y));
  return mesh(new THREE.LatheGeometry(pts, segments), mat);
}

/**
 * ПЛОСКАЯ ДЕТАЛЬ: контур в плоскости XY, выдавленный по Z на `depth` и отцентрованный по Z.
 * Контур — точки по кругу (любое направление), без повтора первой. `bevel` скругляет кромку и
 * делает её «лезвием»; `holes` — внутренние контуры (проушина, окно кольца).
 */
export function extrudeXY(outline: V2[], depth: number, mat: THREE.Material, opts: { bevel?: number; holes?: V2[][]; curveSegments?: number } = {}): THREE.Mesh {
  const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
  for (const h of opts.holes ?? []) shape.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
  const bevel = opts.bevel ?? 0;
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.01, depth - 2 * bevel),
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel * 0.9,
    bevelSegments: 2,
    curveSegments: opts.curveSegments ?? 8,
  });
  geo.translate(0, 0, -(depth - 2 * bevel) / 2);
  return mesh(geo, mat);
}

/** Трубка вдоль ломаной/кривой (кольца гарды, крюки, дужки, изгиб посоха, тетива). */
export function tube(points: [number, number, number][], radius: number, mat: THREE.Material, opts: { closed?: boolean; segments?: number; radial?: number } = {}): THREE.Mesh {
  const curve = new THREE.CatmullRomCurve3(points.map(([x, y, z]) => new THREE.Vector3(x, y, z)), opts.closed ?? false);
  return mesh(new THREE.TubeGeometry(curve, opts.segments ?? Math.max(12, points.length * 8), radius, opts.radial ?? 8, opts.closed ?? false), mat);
}

/** Зеркальная копия объекта по X (правая половина гарды → левая). */
export function mirrorX<T extends THREE.Object3D>(o: T): T {
  const c = o.clone() as T;
  c.position.x = -c.position.x;
  c.scale.x = -c.scale.x;
  c.rotation.y = -c.rotation.y;
  c.rotation.z = -c.rotation.z;
  return c;
}

// ── Клинок по профилю ────────────────────────────────────────────────────────────────────────────

export interface BladeSpec {
  /** Длина клинка от пяты до острия, см. */
  length: number;
  /** Где начинается клинок по Y (пята; клинок уходит в −Y). */
  y0: number;
  /** Толщина по Z, см (у пяты). */
  thick: number;
  /** Полуширина правой (+X) и левой (−X) стороны в точке t∈[0,1] от пяты к острию. */
  halfW: (t: number) => { r: number; l: number };
  /** Смещение осевой линии по X в точке t — изгиб сабли и фальшиона. */
  curve?: (t: number) => number;
  /** Волна лезвий (пламенеющий, крис): амплитуда, см, и число полуволн. */
  wave?: { amp: number; count: number; from?: number };
  /** Дол: доля длины от пяты, ширина, см. Рисуется тёмной полосой на обеих плоскостях. */
  fuller?: { to: number; width: number; mat: THREE.Material };
  /** Станций по длине (гладкость контура). */
  stations?: number;
}

/**
 * КЛИНОК ИЗ ПРОФИЛЯ: полуширины по длине, изгиб, волна и дол. Одна функция на мечи, кинжалы,
 * перья копий и полотна глеф — различаются только профилем. Возвращает группу (клинок + долы).
 */
export function blade(spec: BladeSpec, mat: THREE.Material): THREE.Group {
  const n = spec.stations ?? 28;
  const right: V2[] = [], left: V2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const { r, l } = spec.halfW(t);
    const c = spec.curve ? spec.curve(t) : 0;
    let wv = 0;
    if (spec.wave && t >= (spec.wave.from ?? 0.08) && t < 0.97) wv = spec.wave.amp * Math.sin(((t - (spec.wave.from ?? 0.08)) / (0.97 - (spec.wave.from ?? 0.08))) * Math.PI * spec.wave.count);
    const y = spec.y0 - t * spec.length;
    right.push([c + Math.max(0.02, r) + wv, y]);
    left.push([c - Math.max(0.02, l) + wv, y]);
  }
  const outline: V2[] = [...right, ...left.reverse()];
  const g = new THREE.Group();
  g.add(extrudeXY(outline, spec.thick, mat, { bevel: Math.min(spec.thick * 0.45, 0.35) }));
  if (spec.fuller) {
    const f = spec.fuller;
    const len = spec.length * f.to;
    for (const z of [1, -1]) {
      const strip = box(f.width, len, 0.05, f.mat);
      const c = spec.curve ? spec.curve(f.to / 2) : 0;
      strip.position.set(c, spec.y0 - len / 2 - spec.length * 0.02, z * (spec.thick / 2 + 0.01));
      g.add(strip);
    }
  }
  return g;
}

/** Обмотка рукояти: чередующиеся валики вдоль Y от yTop вниз на длину len. */
export function wrappedGrip(yTop: number, len: number, radius: number, mat: THREE.Material, bandMat?: THREE.Material, bands = 0): THREE.Group {
  const g = new THREE.Group();
  g.add(at(cyl(radius, radius * 0.96, len, mat, 12), 0, yTop - len / 2));
  for (let i = 0; i < bands; i++) {
    const y = yTop - (len * (i + 0.5)) / bands;
    g.add(at(torus(radius * 1.02, radius * 0.12, bandMat ?? mat, Math.PI * 2, 14), 0, y, 0, Math.PI / 2));
  }
  return g;
}

// ── Сборка ───────────────────────────────────────────────────────────────────────────────────────

/** Корень с четырьмя именованными группами гнёзд — обязательная форма результата построителя. */
export function slotGroups(): { root: THREE.Group; g: Record<SlotName, THREE.Group> } {
  const root = new THREE.Group();
  const g = {} as Record<SlotName, THREE.Group>;
  for (const s of SLOT_NAMES) { const x = new THREE.Group(); x.name = s; g[s] = x; root.add(x); }
  return { root, g };
}

/** Линейная интерполяция по оси детали: a при −1, b при +1. */
export const byAxis = (axis: number, a: number, b: number): number => a + ((b - a) * (Math.max(-1, Math.min(1, axis)) + 1)) / 2;

/** Простой детерминированный хэш строки → [0,1): чтобы у варианта была СВОЯ мелкая особенность. */
export function hash01(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return ((h >>> 0) % 10007) / 10007;
}

import type { Rng } from '../formulas/rng.js';
import { Cell, TILE, worldToCell } from '../world/grid.js';
import type { BiomeDressing } from '../config/schemas.js';
import type { DungeonLayout } from './floorCommon.js';
import { claimLayoutAnchors, claimsOf, type DecorSpec } from './decor.js';

/**
 * ⭐ 08.10: ОФОРМЛЕНИЕ БИОМА ПО ПРАВИЛУ (`biomes[].dressing`) — настенные факелы с шагом, статуи в нишах дальних стен, костры в
 * центре больших комнат. Образец — рукотворная комната владельца (крипта, Unity `top_down/dungeon`, сцена `test`): факел каждые
 * 3 м по каждой стене. Чистая детерминированная функция от раскладки и своего потока rng (`generateFloorParams`, сид ^ 0xd7e5);
 * зовётся ДО случайной россыпи (`placeFloorDecor`/`placeWallProps`), чтобы статуи и костры заняли место первыми, и отдаёт ей
 * занятые клетки и грани. Сетку НЕ меняет: статуя — на клетках-стенах, костёр — суб-тайловая преграда (`obstaclesFromDecor`).
 * Биом без `dressing` сюда не попадает — его этаж байт-в-байт прежний.
 *
 * ГРАНЬ — открытая сторона клетки-стены `W` с нормалью `n = (dx, dz)` к проходимой соседке `W+n` (как `placeWallProps` и сегмент
 * стены в рендере). Грань, чья соседка — дверь (`Cell.Door`), — КОСЯК: не берётся и рвёт пробег. ПРОБЕГ — максимальная цепочка
 * граней с одной нормалью, идущих подряд по касательной, у которых клетки перед гранью — в одной ЗОНЕ: комнате (`L.rooms`, клетка в
 * её прямоугольнике) или коридоре (ни в одной комнате). Концы пробега — углы и проёмы.
 *
 * ДАЛЬНЯЯ СТЕНА. Камера стоит от героя по горизонтали в `(sin az, cos az)` мира сервера (x — столбец, y — строка сетки): веб
 * `playerInput.camDirXZ` + `cameraRig.placeCamera`, Unity `CameraRig.Dir`/`Place` (зеркало X Unity — только визуал). Грань дальняя,
 * если смотрит лицом К камере: `dot(n, toCamera) > 0` — такая стена в своей комнате никогда не встаёт между камерой и героем. Сверка
 * с Unity `WallFadeRules.FadeAmount`: тает грань с `dot(n, камера→герой) > 0`, то есть ближняя — дальние не тают никогда. При
 * `azimuthDeg = −45` дальние — северные стены комнаты (`n = (0, +1)`, клетка-стена на строке выше комнаты) и восточные
 * (`n = (−1, 0)`, стена справа от комнаты). Сторож — `dressing.test.ts` и клиентский `render3d/dressingFarWall.test.ts`.
 */

/** Правила биома + азимут камеры (`balance.camera.azimuthDeg`) — всё, что нужно расстановке. */
export interface DressingOpts {
  rules: BiomeDressing;
  camAzimuthDeg: number;
}

/** Что заняло оформление: клетки пола «cx,cy» (обходит `placeFloorDecor`) и грани стен «x,y,dx,dz» (обходит `placeWallProps`). */
export interface DressingResult {
  floorCells: Set<string>;
  faces: Set<string>;
}

/** Горизонтальный единичный вектор ОТ героя К КАМЕРЕ в мире сервера (x — столбец, y — строка): `(sin az, cos az)`. */
export function toCameraXY(azimuthDeg: number): { x: number; y: number } {
  const az = (azimuthDeg * Math.PI) / 180;
  return { x: Math.sin(az), y: Math.cos(az) };
}

/** Грань с нормалью `(dx, dz)` смотрит лицом к камере — дальняя стена (в своей комнате не заслоняет героя). */
export function isFarFace(dx: number, dz: number, toCamera: { x: number; y: number }): boolean {
  return dx * toCamera.x + dz * toCamera.y > 1e-9;   // порог — от шума sin/cos на осевых азимутах (sin π ≈ 1e−16)
}

/** Оформление биома для генерации: нет `dressing` — `undefined` (этаж как прежде). Азимут — из `balance.camera`, как у камеры. */
export function dressingOf(
  biome: { dressing?: BiomeDressing } | undefined,
  balance: { camera?: { azimuthDeg?: number } } | undefined,
): DressingOpts | undefined {
  if (!biome?.dressing) return undefined;
  return { rules: biome.dressing, camAzimuthDeg: balance?.camera?.azimuthDeg ?? -45 };
}

/** Допуск сверки ширины ниши с моделью статуи, м (клетка = 1 м). */
export const STATUE_WIDTH_TOL = 0.05;

/**
 * ⭐ 08.10: ПРЕДУПРЕЖДЕНИЯ ОФОРМЛЕНИЯ (редактор, «Проверить конфиг»; сторож — `dressing.test.ts`). Ширина ниши `statues.width` (граней =
 * метров) обязана равняться ширине МОДЕЛИ статуи — её габариту по X в манифесте арта Unity (`art[].bounds`, модель в своём корне стоит
 * лицом по +Z, вдоль стены — X): модель статуи несёт свой кусок стены и заменяет ровно `width` сегментов. Шире — влезает в соседние
 * сегменты и фланговые факелы, уже — дыра в стене. У статуй крипты — 2 м. Модели нет в манифесте или у неё нет габарита — не судим.
 */
export function dressingWarnings(
  biomes: readonly { id: string; dressing?: BiomeDressing }[],
  objects: readonly { id: string; modelId?: string }[],
  art: readonly { id: string; kind?: string; bounds?: { min: number[]; max: number[] } }[],
): { biomeId: string; msg: string }[] {
  const model = new Map(objects.map((o) => [o.id, o.modelId ?? '']));
  // у ключа бывает две строки манифеста — модель и .mat библиотеки с тем же именем (`kind: 'material'`, без габарита): берём модель
  const bounds = new Map<string, { min: number[]; max: number[] }>();
  for (const a of art) if (a.bounds && a.kind !== 'material') bounds.set(a.id, a.bounds);
  const out: { biomeId: string; msg: string }[] = [];
  for (const b of biomes) {
    const st = b.dressing?.statues;
    if (!st) continue;
    const width = st.width ?? 2;
    for (const id of Array.isArray(st.objectIds) ? st.objectIds : []) {
      const bb = bounds.get(model.get(id) || id);
      const x0 = bb?.min?.[0], x1 = bb?.max?.[0];
      const w = typeof x0 === 'number' && typeof x1 === 'number' ? x1 - x0 : NaN;
      if (Number.isFinite(w) && Math.abs(w - width) > STATUE_WIDTH_TOL) {
        out.push({ biomeId: b.id, msg: `оформление: ширина ниши statues.width = ${width}, а модель статуи «${id}» шириной ${w.toFixed(2)} м — статуя ${w > width ? 'влезет в соседние сегменты стены и факелы' : 'оставит дыру в стене'}` });
      }
    }
  }
  return out;
}

/** Id объектов, которые ставит оформление: из случайной россыпи они выпадают ПРАВИЛОМ (ни броска на них). */
export function dressingObjectIds(rules: BiomeDressing): Set<string> {
  const out = new Set<string>();
  if (rules.torch?.objectId) out.add(rules.torch.objectId);
  for (const id of rules.statues?.objectIds ?? []) if (id) out.add(id);
  for (const id of rules.firePits?.objectIds ?? []) if (id) out.add(id);
  return out;
}

interface Face { x: number; y: number; dx: number; dz: number }
interface Run { faces: Face[]; dx: number; dz: number; zone: number }

const ck = (x: number, y: number): string => `${x},${y}`;
const fk = (f: Face): string => `${f.x},${f.y},${f.dx},${f.dz}`;
/** Точка грани в мире: центр клетки-стены + ½ клетки к проходимой соседке (TILE = 32) — как у `placeWallProps`. */
const facePoint = (f: Face): { x: number; y: number } => ({ x: f.x * TILE + TILE / 2 + (f.dx * TILE) / 2, y: f.y * TILE + TILE / 2 + (f.dz * TILE) / 2 });
// Порядок нормалей фиксирован (детерминизм потока): юг, север, восток, запад.
const N4: [number, number][] = [[0, 1], [0, -1], [1, 0], [-1, 0]];
const QUADS = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];

/** Пробеги граней этажа (порядок — построчный скан клетки начала, затем нормаль). */
export function wallRuns(L: DungeonLayout): Run[] {
  const rows = L.grid.length, cols = L.grid[0]?.length ?? 0;
  const at = (x: number, y: number): Cell | undefined => L.grid[y]?.[x];
  // Зона клетки: индекс комнаты, в прямоугольнике которой она лежит (первая), иначе −1 (коридор).
  const zone: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(-1));
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    zone[y]![x] = L.rooms.findIndex((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
  }
  const isFace = (x: number, y: number, dx: number, dz: number): boolean => {
    if (at(x, y) !== Cell.Wall) return false;
    const o = at(x + dx, y + dz);
    return o !== undefined && o !== Cell.Wall && o !== Cell.Door;   // проходимая соседка, но не косяк двери
  };
  const zoneOf = (f: Face): number => zone[f.y + f.dz]![f.x + f.dx]!;
  const runs: Run[] = [];
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    for (const [dx, dz] of N4) {
      if (!isFace(x, y, dx, dz)) continue;
      const tx = dz !== 0 ? 1 : 0, ty = dz !== 0 ? 0 : 1;   // касательная: вдоль x у горизонтальной стены, вдоль y у вертикальной
      const z = zoneOf({ x, y, dx, dz });
      // Начало пробега: предыдущая по касательной — не грань той же нормали и зоны.
      if (isFace(x - tx, y - ty, dx, dz) && zoneOf({ x: x - tx, y: y - ty, dx, dz }) === z) continue;
      const faces: Face[] = [];
      for (let k = 0; ; k++) {
        const f = { x: x + tx * k, y: y + ty * k, dx, dz };
        if (!isFace(f.x, f.y, dx, dz) || zoneOf(f) !== z) break;
        faces.push(f);
      }
      runs.push({ faces, dx, dz, zone: z });
    }
  }
  return runs;
}

/** Позиции (индексы в [a, b]) равномерного ряда с шагом `s`: `k` штук, узор по центру отрезка (остаток — пополам, вниз). */
function evenRow(a: number, b: number, s: number, k: number): number[] {
  if (k <= 0 || b < a) return [];
  const span = (k - 1) * s;
  const off = Math.floor((b - a - span) / 2);
  return Array.from({ length: k }, (_, j) => a + off + j * s);
}

/**
 * Расставляет оформление биома (пишет `DecorObject{kind:'obj'}` в `L.decor`). `specs` — расставляемые объекты биома
 * (`decorSpecsFor`): объект, которого там нет (выключен, другой биом), не ставится; нет `specs` — берутся id как есть.
 */
export function placeDressing(L: DungeonLayout, opts: DressingOpts, rng: Rng, specs?: ReadonlyMap<string, DecorSpec>): DressingResult {
  const res: DressingResult = { floorCells: new Set(), faces: new Set() };
  const ok = (id: string): boolean => !!id && (!specs || specs.has(id));
  const { rules } = opts;
  const toCam = toCameraXY(opts.camAzimuthDeg);
  const torchId = rules.torch && ok(rules.torch.objectId) ? rules.torch.objectId : '';
  const gap = rules.torch?.cornerGap ?? 1;
  const statueIds = (rules.statues?.objectIds ?? []).filter(ok);
  const pitIds = (rules.firePits?.objectIds ?? []).filter(ok);
  const runs = wallRuns(L);

  // Клетки, перед которыми нельзя ставить нишу и на которых нельзя ставить костёр: спавн, выходы, рычаги, прежний декор (портал,
  // лавка, арена, сундук сокровищницы); двери — отдельно (у них нельзя и вплотную).
  const poi = new Set<string>();
  const markWorld = (p: { x: number; y: number }): void => { const c = worldToCell(p.x, p.y); poi.add(ck(c.cx, c.cy)); };
  markWorld(L.spawn); markWorld(L.stairsDown);
  for (const e of L.exits) markWorld(e);
  for (const lv of L.levers) markWorld(lv);
  for (const d of L.decor) markWorld(d);
  const isDoor = (x: number, y: number): boolean => L.grid[y]?.[x] === Cell.Door;
  const nearDoor = (x: number, y: number): boolean => isDoor(x, y) || isDoor(x + 1, y) || isDoor(x - 1, y) || isDoor(x, y + 1) || isDoor(x, y - 1);

  const wallObj = (f: Face, objectId: string): void => {
    const p = facePoint(f);
    L.decor.push({ x: p.x, y: p.y, kind: 'obj', objectId, rot: Math.atan2(f.dx, f.dz), footprint: { w: 1, h: 1 } });
    res.faces.add(fk(f));
    res.floorCells.add(ck(f.x + f.dx, f.y + f.dz));
  };

  // ── 1. Статуи: блок [факел][статуя × width][факел] по центру дальнего пробега, в пределах отступа от концов ──
  const width = Math.max(1, rules.statues?.width ?? 2);
  const flanks = new Map<Run, [number, number]>();   // пробег → индексы фланговых факелов (для шага прочих факелов)
  const block = (r: Run): number => {
    const a = gap, b = r.faces.length - 1 - gap, len = width + 2;
    if (b - a + 1 < len) return -1;
    const start = a + Math.floor((b - a + 1 - len) / 2);
    for (let i = start; i < start + len; i++) {
      const f = r.faces[i]!, ox = f.x + f.dx, oy = f.y + f.dz;
      if (poi.has(ck(ox, oy)) || nearDoor(ox, oy)) return -1;   // не у дверей, выходов, рычагов, спавна
      if (res.floorCells.has(ck(ox, oy))) return -1;             // клетка перед гранью уже за другой нишей (угол при cornerGap 0)
    }
    return start;
  };
  const putStatue = (r: Run): void => {
    const start = block(r);
    if (start < 0) return;
    const faces = r.faces.slice(start + 1, start + 1 + width);
    const pts = faces.map(facePoint);
    const x = pts.reduce((s, p) => s + p.x, 0) / pts.length, y = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    L.decor.push({
      x, y, kind: 'obj', objectId: rng.pick(statueIds), rot: Math.atan2(r.dx, r.dz), footprint: { w: width, h: 1 },
      wallFaces: faces.map((f) => [f.x, f.y, f.dx, f.dz] as [number, number, number, number]),
    });
    for (const f of faces) { res.faces.add(fk(f)); res.floorCells.add(ck(f.x + f.dx, f.y + f.dz)); }
    if (torchId) { wallObj(r.faces[start]!, torchId); wallObj(r.faces[start + width + 1]!, torchId); }
    flanks.set(r, [start, start + width + 1]);
  };
  if (rules.statues && statueIds.length) {
    const st = rules.statues;
    const far = runs.filter((r) => isFarFace(r.dx, r.dz, toCam));
    for (let ri = 0; ri < L.rooms.length; ri++) {
      const want = rng.int(st.min, Math.max(st.min, st.max));
      const cands = far.filter((r) => r.zone === ri && block(r) >= 0);
      for (let i = cands.length - 1; i > 0; i--) { const j = rng.int(0, i); [cands[i], cands[j]] = [cands[j]!, cands[i]!]; }
      for (const r of cands.slice(0, want)) putStatue(r);
    }
    if (st.corridorChance > 0) {
      for (const r of far) if (r.zone < 0 && block(r) >= 0 && rng.chance(st.corridorChance)) putStatue(r);
    }
  }

  // ── 2. Факелы: шаг `spacing` в комнате (минимум один на пробег), `corridorSpacing` в коридоре; от концов — `cornerGap` ──
  if (rules.torch && torchId) {
    const t = rules.torch;
    for (const r of runs) {
      const s = r.zone >= 0 ? t.spacing : t.corridorSpacing;
      if (s <= 0) continue;
      const a = gap, b = r.faces.length - 1 - gap;
      if (b < a) continue;
      const fl = flanks.get(r);
      let at: number[];
      if (fl) {   // от фланговых факелов статуи — тем же шагом наружу, пока влезает
        at = [];
        for (let i = fl[0] - s; i >= a; i -= s) at.push(i);
        for (let i = fl[1] + s; i <= b; i += s) at.push(i);
      } else {
        const m = b - a + 1;
        const k = r.zone >= 0 ? Math.floor((m - 1) / s) + 1 : Math.floor(m / s);   // коридор: только целый шаг
        at = evenRow(a, b, s, k);
      }
      for (const i of at) wallObj(r.faces[i]!, t.objectId);
    }
  }

  // ── 3. Костры: центр большой комнаты (не входа), footprint + кольцо пола в клетку вокруг (обойти можно со всех сторон) ──
  // ⭐ 08.10: и отступ (`objects[].clearance`, `FloorClaims`): след + отступ костра не задевает стоящий напольный декор, и наоборот
  if (rules.firePits && pitIds.length) {
    const fp = rules.firePits;
    const claims = claimsOf(L.decor, specs);
    claimLayoutAnchors(claims, L);   // ⭐ 08.10: кольцо костра — не на выход и не на рычаг
    for (const room of L.rooms) {
      if (room.type === 'entrance' || Math.min(room.w, room.h) < fp.minRoom) continue;
      if (!rng.chance(fp.chance)) continue;
      const id = rng.pick(pitIds);
      const foot = specs?.get(id)?.footprint ?? { w: 2, h: 2 };
      const cx = room.x + room.w / 2, cy = room.y + room.h / 2;   // центр комнаты (клетки; у нечётной стороны — середина клетки)
      const x0 = Math.floor(cx - foot.w / 2), x1 = Math.ceil(cx + foot.w / 2) - 1;
      const y0 = Math.floor(cy - foot.h / 2), y1 = Math.ceil(cy + foot.h / 2) - 1;
      let fits = true;
      for (let y = y0 - 1; y <= y1 + 1 && fits; y++) for (let x = x0 - 1; x <= x1 + 1 && fits; x++) {
        const inside = x >= x0 && x <= x1 && y >= y0 && y <= y1;
        if (L.grid[y]?.[x] !== Cell.Floor || poi.has(ck(x, y)) || (inside && res.floorCells.has(ck(x, y)))) fits = false;
      }
      const rot = QUADS[rng.int(0, 3)]!;
      if (!fits) continue;
      const rect = { x0, y0, x1, y1 }, clear = specs?.get(id)?.clearance ?? 0;
      if (!claims.free(rect, clear)) continue;
      claims.claim(rect, clear);
      L.decor.push({ x: cx * TILE, y: cy * TILE, kind: 'obj', objectId: id, rot, footprint: { w: foot.w, h: foot.h } });
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) res.floorCells.add(ck(x, y));
    }
  }
  return res;
}

import type { Rng } from '../formulas/rng.js';
import { TILE } from '../world/grid.js';
import type { DecorObject } from './floorCommon.js';
import type { DecorSpec } from './decor.js';   // только типы: decor.ts зовёт отсюда setSpecsFor (предупреждения) — без кольца импортов

/**
 * ⭐ 13.10 (Ф4 «Наборы», план декора): НАБОРЫ-СЦЕНКИ — несколько пропов с авторской взаимной раскладкой (трапезная: стол и табуреты вокруг;
 * библиотека: полка и книги на ней; склад: два ящика и третий сверху). Набор собирается ПРЕФАБОМ в Unity (`Env/<биом>/sets/<id>/`), экспорт
 * манифеста пишет строку `art[]` вида `set` (схема `artSetSchema`; единственный писатель — Unity). Сервер РАЗВОРАЧИВАЕТ набор в отдельные пропы
 * (`setMemberRecords`): у каждого члена — своя запись декора, своя преграда и свой след, так что коллизия честная, а клиент рисует, что пришло.
 * Необязательных членов («оставить k из n» — группы `groups`) выбирает ТОЛЬКО сервер (`chooseMembers`): реши клиент сам, картинка разошлась бы с
 * коллизией. Член, стоящий на другом (`on`: штабель, сокет), едет с высотой основания `DecorObject.h` и не даёт ни преграды, ни занятого пола —
 * их даёт тот, кто под ним; хозяина не выбрали — нет и его.
 *
 * Здесь — чистая часть: строки манифеста → спеки набора биома (`setSpecsFor`, с правилами биома `dressing.props.sets` и проверкой членов), выбор
 * членов и развёртка в мир (4 четверти поворота × зеркало). Где набор встаёт — проход Р3 в `slots.ts`.
 *
 * РАМКА НАБОРА (как пишет экспорт Unity): клетка = 1 м; `x` — вдоль набора, `z` — лицом набора (у стены — в комнату), начало — центр следа
 * `footprint` (w — по x, h — по z); у набора у стены задний край следа (z = −h/2) — на линии стены, у углового — ещё и левый (x = −w/2) — на
 * второй стене. Курс члена `yaw` — градусы, как курс сервера (+Z модели смотрит в (sin, cos) рамки (x, z)). Набор с поворотом `q` четвертей:
 * точка рамки (x, z) → мир (x·c + z·s, −x·s + z·c) (c, s — косинус и синус q·90°), курс члена → q·90° + yaw; зеркало — x → −x, yaw → −yaw
 * (модель не отражается — только раскладка).
 *
 * ⭐ 14.10 (у статуи): якорь `statue` — набор перед нишей статуи оформления (Р1): задний край следа — на линии лица стены (как у стены), а по x
 * начало рамки — СЕРЕДИНА СТАТУИ, не центр габарита членов (камень у основания с одной стороны, ящик — с другой; сторона — зеркалом); центр
 * следа в мире — середина статуи на линии стены + h/2 по нормали в комнату. Ставит его свой проход после всего прочего (`slots.ts
 * placeStatueSets`); в Р3 такие наборы не идут.
 */

/** Якорь набора (имена — `DECOR_SET_ANCHORS` схемы и enum `DM.Art.DecorSetAnchor` Unity). */
export type SetAnchor = 'center' | 'againstWall' | 'corner' | 'farWall' | 'statue';
const ANCHORS: readonly SetAnchor[] = ['center', 'againstWall', 'corner', 'farWall', 'statue'];

/** Строка набора, как её читает расстановка: разобранная схемой или СЫРАЯ (рабочая копия редактора) — нет поля — умолчание схемы. */
export interface ArtSetLite {
  name?: string;
  anchor?: string;
  footprint?: { w?: number; h?: number };
  members?: readonly { key?: string; x?: number; z?: number; h?: number; yaw?: number; group?: string; on?: number }[];
  groups?: readonly { id?: string; min?: number; max?: number }[];
  rooms?: Readonly<Partial<Record<string, number>>>;
  minRoom?: number;
  weight?: number;
  perRoomMax?: number;
  perFloorMax?: number;
  tags?: readonly string[];
  biomes?: readonly string[];
}

/** Строка манифеста с набором (вид `set`). */
export interface ArtSetRowLite { id: string; kind?: string; group?: string; set?: ArtSetLite }

/** Правила наборов биома (`biomes[].dressing.props.sets`; сырые — нет поля — умолчание схемы). */
export interface SetRulesLite {
  on?: boolean;
  chance?: number;
  perRoom?: number;
  /** ⭐ 14.10: шанс набора у статуи (на каждую статую этажа); сырые без поля — 0 (наборов у статуй нет). */
  statueChance?: number;
  setIds?: readonly string[];
  setLimits?: readonly { id: string; weight?: number; perRoomMax?: number; perFloorMax?: number }[];
}

/** Член набора, готовый к развёртке: координаты рамки (клетки), высота основания (м), курс (РАДИАНЫ), группа ('' — обязателен), хозяин. */
export interface SetMember { key: string; x: number; z: number; h: number; yaw: number; group: string; on?: number; spec: DecorSpec }

/** Набор биома, готовый к расстановке (`setSpecsFor`). */
export interface SetSpec {
  id: string;
  name: string;
  anchor: SetAnchor;
  footprint: { w: number; h: number };
  members: SetMember[];
  groups: { id: string; min: number; max: number }[];
  rooms: Readonly<Partial<Record<string, number>>>;
  minRoom: number;
  weight: number;
  perRoomMax: number;
  perFloorMax: number;
  tags: readonly string[];
  /** Хоть один член высокий (паспорт `tall`): набор — только у дальних стен (угол — обе дальние), в центр — никогда. */
  tall: boolean;
  /** Отступ набора от другого напольного декора — наибольший у его членов (`clearance` спек). */
  clearance: number;
}

/** Набор встал: куда (центр полного следа в мире, ед.), поворот (четвертей) и зеркало. */
export interface SetPlace { cx: number; cy: number; q: number; mirror: boolean }

/** ⭐ 13.10: биомы набора — свои (`set.biomes`), а пусто — биом папки каталога (группа `biome_<id>`), как у паспорта (`passportBiomes`). */
export function setBiomes(row: ArtSetRowLite): string[] {
  const own = (row.set?.biomes ?? []).filter((b) => !!b);
  if (own.length) return [...own];
  const g = row.group ?? '';
  return g.startsWith('biome_') && g.length > 'biome_'.length ? [g.slice('biome_'.length)] : [];
}

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const int = (v: unknown, d: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.floor(num(v, d))));

/**
 * ⭐ 13.10 (Ф4): НАБОРЫ БИОМА `biomeId` — строки манифеста вида `set` своего биома (`setBiomes`), по ключу (порядок кодовых единиц: экспорт
 * переставляет строки манифеста, а порядок — это выбор по весу из rng), с правилами биома: `setIds` — какие (пусто — все), `setLimits` — вес и
 * лимиты по id поверх строки. Член — ключ модели, у которого в биоме есть расставляемый объект (`specs` — `decorSpecsFor`: неявный объект
 * паспорта, id = ключ); нет — набор не встаёт (проблема для «Проверить конфиг»). Проблемы строки (хозяин `on` не раньше члена, высота без
 * хозяина, группа без описания, пустой набор, якорь не из списка) — набор вне игры и строка в `problems`.
 */
export function setSpecsFor(art: readonly ArtSetRowLite[], biomeId: string, specs: readonly DecorSpec[], rules?: SetRulesLite): { sets: SetSpec[]; problems: { id: string; msg: string }[] } {
  const problems: { id: string; msg: string }[] = [];
  const sets: SetSpec[] = [];
  if (rules && rules.on === false) return { sets, problems };
  const only = new Set((rules?.setIds ?? []).filter((x) => !!x));
  const limits = new Map((rules?.setLimits ?? []).filter((l) => !!l?.id).map((l) => [l.id, l]));
  const byId = new Map(specs.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const rows = art.filter((a) => a.kind === 'set' && !!a.set && !!a.id && setBiomes(a).includes(biomeId))
    .filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)))
    .filter((a) => !only.size || only.has(a.id))
    .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  for (const row of rows) {
    const s = row.set!;
    const bad = (msg: string): void => { problems.push({ id: row.id, msg }); };
    const anchor = (s.anchor ?? 'center') as SetAnchor;
    if (!ANCHORS.includes(anchor)) { bad(`якорь «${s.anchor}» не из ${ANCHORS.join(' / ')}`); continue; }
    const raw = s.members ?? [];
    if (!raw.length) { bad('набор без членов'); continue; }
    const groups = (s.groups ?? []).filter((g) => !!g?.id).map((g) => {
      const min = int(g.min, 0, 0, 32), max = int(g.max, 1, 0, 32);
      return { id: g.id!, min: Math.min(min, max), max };
    });
    const gid = new Set(groups.map((g) => g.id));
    const members: SetMember[] = [];
    let ok = true;
    raw.forEach((m, i) => {
      const key = m.key ?? '';
      const spec = byId.get(key);
      const on = typeof m.on === 'number' ? Math.floor(m.on) : undefined;
      const h = Math.max(0, num(m.h, 0));
      const group = m.group ?? '';
      if (!spec) { bad(`член ${i} «${key}»: у биома ${biomeId} нет такого объекта (паспорт декора в Env/${biomeId}/ или строка «Объектов») — набор не встанет`); ok = false; return; }
      if (on !== undefined && !(on >= 0 && on < i)) { bad(`член ${i} «${key}»: хозяин on = ${m.on} — не раньше в списке`); ok = false; return; }
      if (on === undefined && h > 0) { bad(`член ${i} «${key}»: высота ${h} м без хозяина (on) — на полу высота 0`); ok = false; return; }
      if (group && !gid.has(group)) { bad(`член ${i} «${key}»: группа «${group}» не описана в groups`); ok = false; return; }
      members.push({ key, x: num(m.x, 0), z: num(m.z, 0), h: on === undefined ? 0 : h, yaw: (num(m.yaw, 0) * Math.PI) / 180, group, ...(on !== undefined ? { on } : {}), spec });
    });
    if (!ok) continue;
    const lim = limits.get(row.id);
    const floorMembers = members.filter((m) => m.on === undefined);
    sets.push({
      id: row.id, name: s.name ?? '', anchor,
      footprint: { w: int(s.footprint?.w, 1, 1, 16), h: int(s.footprint?.h, 1, 1, 16) },
      members, groups,
      rooms: s.rooms ?? {},
      minRoom: int(s.minRoom, 1, 1, 64),
      weight: Math.max(0, num(lim?.weight, num(s.weight, 1))),
      perRoomMax: int(lim?.perRoomMax, int(s.perRoomMax, 1, 0, 8), 0, 8),
      perFloorMax: int(lim?.perFloorMax, int(s.perFloorMax, 2, 0, 64), 0, 64),
      tags: s.tags ?? [],
      tall: members.some((m) => !!m.spec.passport?.tall),
      clearance: floorMembers.reduce((a, m) => Math.max(a, m.spec.clearance ?? 0), 0),
    });
  }
  return { sets, problems };
}

/** Вес набора в комнате типа `place`: вес × множитель `rooms` (нет записи — 1). */
export function setWeight(s: SetSpec, place: string): number {
  const m = s.rooms[place];
  return s.weight * (m === undefined ? 1 : Math.max(0, m));
}

/** Сколько членов набора обязательны (без группы и не на необязательном хозяине) — меньше этого бюджет комнаты не пустит набор. */
export function requiredCount(s: SetSpec): number {
  const keep = s.members.map((m) => !m.group);
  s.members.forEach((m, i) => { if (m.on !== undefined && !keep[m.on]) keep[i] = false; });
  return keep.filter(Boolean).length;
}

/**
 * ⭐ 13.10 (Ф4): ВЫБОР ЧЛЕНОВ — «оставить k из n» по группам: k — от min до max группы (бросок), какие — случайная выборка; обязательные (без
 * группы) — всегда; стоящий на другом (`on`) — только с хозяином. `budget` — сколько членов ещё пускает бюджет комнаты: k урезаются с последней
 * группы до их min; обязательные + min не помещаются — null. `minimal` — каждая группа на своём min (запасной состав, когда полный не встал).
 * Возвращает индексы членов по возрастанию.
 */
export function chooseMembers(s: SetSpec, rng: Rng, budget: number, minimal = false): number[] | null {
  const counts = s.groups.map((g) => {
    const n = s.members.filter((m) => m.group === g.id).length;
    const lo = Math.min(g.min, n), hi = Math.min(g.max, n);
    return { g, n, k: minimal ? lo : rng.int(lo, Math.max(lo, hi)), lo };
  });
  const req = s.members.filter((m) => !m.group).length;
  let total = req + counts.reduce((a, c) => a + c.k, 0);
  for (let i = counts.length - 1; i >= 0 && total > budget; i--) {
    const c = counts[i]!, cut = Math.min(c.k - c.lo, total - budget);
    c.k -= cut; total -= cut;
  }
  if (total > budget) return null;
  const keep = s.members.map((m) => !m.group);
  for (const c of counts) {
    const idx = s.members.map((m, i) => (m.group === c.g.id ? i : -1)).filter((i) => i >= 0);
    // частичное тасование Фишера — Йетса: первые k — выбранные
    for (let j = 0; j < c.k; j++) {
      const r = j + rng.int(0, idx.length - 1 - j);
      const t = idx[j]!; idx[j] = idx[r]!; idx[r] = t;
      keep[idx[j]!] = true;
    }
  }
  s.members.forEach((m, i) => { if (m.on !== undefined && !keep[m.on]) keep[i] = false; });
  return keep.map((k, i) => (k ? i : -1)).filter((i) => i >= 0);
}

/**
 * ⭐ 13.10 (Ф4): СОСТАВ НА ОДНОГО НЕОБЯЗАТЕЛЬНОГО МЕНЬШЕ — у ПОСЛЕДНЕЙ группы (по `groups`), где выбрано больше её min, прочь последний выбранный
 * член и стоящие на нём. Все группы на своих min — null. Запасной путь расстановки: состав не встал — меньший (писарский угол без ящика, но со
 * стулом), пока не встанет.
 */
export function shrinkMembers(s: SetSpec, chosen: readonly number[]): number[] | null {
  for (let g = s.groups.length - 1; g >= 0; g--) {
    const grp = s.groups[g]!;
    const mine = chosen.filter((i) => s.members[i]!.group === grp.id);
    if (mine.length <= grp.min) continue;
    const drop = mine[mine.length - 1]!;
    const keep = new Set(chosen.filter((i) => i !== drop));
    for (const i of [...keep].sort((a, b) => a - b)) { const on = s.members[i]!.on; if (on !== undefined && !keep.has(on)) keep.delete(i); }
    return [...keep].sort((a, b) => a - b);
  }
  return null;
}

/** cos / sin четверти `q` — точные (без шума `Math.cos(π/2)`). */
const QC = [1, 0, -1, 0], QS = [0, 1, 0, -1];

/** Угол в (−π, π] (запись поворота без «лишних оборотов», как `slots.ts normRot`). */
const normRot = (a: number): number => { const r = Math.atan2(Math.sin(a), Math.cos(a)); return Object.is(r, -0) ? 0 : r; };

/** Четверть поворота набора, чьё лицо (+z рамки) смотрит по нормали `n` (единичный вектор по оси сетки): (0, 1) — 0, (1, 0) — 1, (0, −1) — 2, (−1, 0) — 3. */
export function quarterOf(n: { x: number; y: number }): number {
  return n.y > 0 ? 0 : n.x > 0 ? 1 : n.y < 0 ? 2 : 3;
}

/** Стороны полного следа набора в осях сетки при повороте `q` (нечётная четверть меняет их местами). */
export function setFootprintAt(s: Pick<SetSpec, 'footprint'>, q: number): { w: number; h: number } {
  return q % 2 === 0 ? { w: s.footprint.w, h: s.footprint.h } : { w: s.footprint.h, h: s.footprint.w };
}

/**
 * ⭐ 14.10 (у статуи): ТОЧКА НАБОРА У СТАТУИ — центр полного следа в мире: середина граней ниши (`wallFaces` записи статуи: клетка-стена и нормаль
 * в комнату; точка грани — на линии лица стены, как у `placeDressing`) + h/2 следа по нормали; четверть — лицом по нормали (`quarterOf`). Начало
 * рамки по x — середина статуи (x = 0 рамки — посреди ниши), так что зеркало кладёт набор в другую сторону от той же статуи.
 */
export function statueSetPlace(faces: readonly (readonly [number, number, number, number])[], fpH: number, mirror: boolean): SetPlace {
  let x = 0, y = 0;
  for (const [fx, fy, dx, dz] of faces) { x += fx * TILE + TILE / 2 + (dx * TILE) / 2; y += fy * TILE + TILE / 2 + (dz * TILE) / 2; }
  const n = faces.length || 1, dx = faces[0]?.[2] ?? 0, dz = faces[0]?.[3] ?? 1;
  return { cx: x / n + (dx * fpH * TILE) / 2, cy: y / n + (dz * fpH * TILE) / 2, q: quarterOf({ x: dx, y: dz }), mirror };
}

/** Точка рамки набора → смещение в мире, клеток (поворот `q` и зеркало). */
export function setOffset(x: number, z: number, q: number, mirror: boolean): { x: number; y: number } {
  const lx = mirror ? -x : x, c = QC[((q % 4) + 4) % 4]!, s = QS[((q % 4) + 4) % 4]!;
  return { x: lx * c + z * s, y: -lx * s + z * c };
}

/**
 * ⭐ 13.10 (Ф4): РАЗВЁРТКА НАБОРА — записи декора выбранных членов (`chosen`, индексы) в точке `at`: точка — центр полного следа + смещение
 * члена (`setOffset`), курс — q·90° ± курс члена (зеркало — минус), след записи — паспорта члена (в осях модели, как у одиночек), `h` (ед. мира) —
 * только у стоящего на другом члене (`on`; книги на полке — `h: 0`, ящик на ящике — 0.75 м = 24 ед.): по полю расстановка и сервер знают, что у
 * записи нет ни преграды, ни занятого пола (`obstaclesFromDecor`, `claimsOf`), а Unity ставит модель на высоту. Порядок — порядок членов.
 */
export function setMemberRecords(s: SetSpec, chosen: readonly number[], at: SetPlace): DecorObject[] {
  const out: DecorObject[] = [];
  const base = (((at.q % 4) + 4) % 4) * (Math.PI / 2);
  for (const i of chosen) {
    const m = s.members[i]!;
    const o = setOffset(m.x, m.z, at.q, at.mirror);
    const d: DecorObject = {
      x: at.cx + o.x * TILE, y: at.cy + o.y * TILE, kind: 'obj', objectId: m.spec.id,
      rot: normRot(base + (at.mirror ? -m.yaw : m.yaw)), footprint: { w: m.spec.footprint.w, h: m.spec.footprint.h },
    };
    if (m.on !== undefined) d.h = m.h * TILE;
    out.push(d);
  }
  return out;
}

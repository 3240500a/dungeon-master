import type { WorldSnapshot, PlayerView, MonsterView, ProjView, DropView } from './netTypes.js';
import type { WorldDelta, PlayerPatch, MonsterPatch } from './delta.js';
import type { Item } from '../types/items.js';
import { dropPayload, type DropPayload } from '../types/world.js';
import type { DebuffState } from '../world/debuffs.js';

/**
 * Бинарный кадр мира (задача Ф1.4 плана доработки сервера).
 *
 * ЗАЧЕМ. После дельт (Ф1.3) и области интереса (Ф1.2) в кадре остались в основном патчи
 * монстров, и почти весь их объём — это имена ключей JSON: `{"id":123,"x":456.78,"y":...}`
 * весит около шестидесяти байт там, где полезных данных байт восемь. Бинарь убирает разметку.
 *
 * ПОЧЕМУ ИМЕННО ТАК:
 *
 * • Идентификаторы сущностей — 32 бита. `WorldState.nextId` НЕ сбрасывается между этажами
 *   и его жгут в том числе снаряды, поэтому 16-битного поля хватило бы на десятки минут игры,
 *   после чего сущности начали бы склеиваться по совпавшему id. Экономия двух байт того не стоит.
 *
 * • Идентификаторы игроков — строки, как есть. Их в кадре единицы (пати ≤ 8), а сжатие их
 *   в короткие слоты потребовало бы таблицы слотов на соединение и знания о ней в транспортном
 *   слое клиента. Выигрыш порядка 12 % кадра не стоит такой связанности; вернуться к идее
 *   можно, когда всё остальное будет выжато.
 *
 * • Квантование величин делает НЕ кодек, а `serializeWorld`: в снапшот кладутся уже те самые
 *   значения, которые переживут провод. Иначе сервер считал бы контрольную сумму по одним
 *   числам, а клиент восстанавливал бы другие, и сверка (Ф1.3) ловила бы несуществующие
 *   расхождения. Побочный выигрыш: дрожь ниже четверти пикселя больше не порождает патчей.
 *
 * • Управляющие кадры (`joined`, `peerInfo`, `events`, …) остаются текстовым JSON. WebSocket
 *   различает текст и двоичные данные сам, поэтому разделение бесплатно и не требует своего
 *   поля типа.
 */

/** Кадр несёт мир целиком (клиент заменяет своё состояние). */
export const WIRE_FULL = 1;
/** Кадр несёт изменения (клиент накладывает их на своё состояние). */
export const WIRE_DELTA = 2;

// Биты маски полей игрока.
const P_X = 1, P_Y = 2, P_FACING = 4, P_HP = 8, P_MANA = 16, P_STAMINA = 32,
  P_ALIVE = 64, P_DEBUFFS = 128, P_TOGGLES = 256, P_INCOMBAT = 512, P_STUN = 1024;
// Биты маски полей монстра.
const M_X = 1, M_Y = 2, M_FACING = 4, M_HP = 8, M_MAXHP = 16, M_ALIVE = 32,
  M_R = 64, M_AI = 128, M_DEBUFFS = 256, M_STUN = 512, M_DOWNED = 1024;

/**
 * У КАЖДОГО булева поля СВОЙ бит маски, хотя значения всех флагов едут в одном байте.
 *
 * Это не педантизм: в дельте флаги меняются независимо, и раньше один бит маски отвечал
 * сразу за все. Если в патче менялся только `alive`, кодер писал байт, где `inCombat`
 * оказывался нулём просто потому, что в патче его не было, — и декодер послушно гасил флаг
 * на клиенте. В игре это выглядело бы как «монстр числится живым, но не в бою» и наоборот.
 * Поймано сквозным тестом `wireRoundtrip`: расхождение на 132-м тике.
 */

/** Квантование координаты: четверть игрового пикселя. Мир до 2240 px укладывается в int16. */
export const posQ = (v: number): number => Math.max(-32768, Math.min(32767, Math.round(v * 4)));
export const posU = (q: number): number => q / 4;
/** Квантование угла: полный оборот на 65536 шагов (0,005°, глазом не различить). */
const TAU = Math.PI * 2;
export const angQ = (a: number): number => (Math.round(((a % TAU) + TAU) % TAU / TAU * 65536)) & 0xffff;
export const angU = (q: number): number => q / 65536 * TAU;

class Writer {
  private buf = new Uint8Array(1024);
  private view = new DataView(this.buf.buffer);
  private pos = 0;
  private grow(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.pos + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf);
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
  u8(v: number): void { this.grow(1); this.view.setUint8(this.pos, v); this.pos += 1; }
  u16(v: number): void { this.grow(2); this.view.setUint16(this.pos, v, true); this.pos += 2; }
  i16(v: number): void { this.grow(2); this.view.setInt16(this.pos, v, true); this.pos += 2; }
  u32(v: number): void { this.grow(4); this.view.setUint32(this.pos, v >>> 0, true); this.pos += 4; }
  i32(v: number): void { this.grow(4); this.view.setInt32(this.pos, v | 0, true); this.pos += 4; }
  str(v: string): void {
    const b = new TextEncoder().encode(v);
    this.u16(b.length);
    this.grow(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
  }
  json(v: unknown): void { this.str(JSON.stringify(v)); }
  done(): Uint8Array { return this.buf.subarray(0, this.pos); }
}

class Reader {
  private view: DataView;
  private pos = 0;
  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  u8(): number { const v = this.view.getUint8(this.pos); this.pos += 1; return v; }
  u16(): number { const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
  i16(): number { const v = this.view.getInt16(this.pos, true); this.pos += 2; return v; }
  u32(): number { const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
  i32(): number { const v = this.view.getInt32(this.pos, true); this.pos += 4; return v; }
  str(): string {
    const n = this.u16();
    const s = new TextDecoder().decode(this.buf.subarray(this.pos, this.pos + n));
    this.pos += n;
    return s;
  }
  json<T>(): T { return JSON.parse(this.str()) as T; }
}

/** Кадр мира: вид (полный/дельта), содержимое и контрольная сумма для сверки (Ф1.3). */
export interface WireFrame {
  kind: typeof WIRE_FULL | typeof WIRE_DELTA;
  delta: WorldDelta;
  sum: number;
}

/** Полный снапшот как «дельта от пустоты» — так обе стороны используют один путь применения. */
export function snapshotToDelta(s: WorldSnapshot): WorldDelta {
  return {
    t: s.tick,
    pu: s.players.length ? s.players.map((p) => ({ ...p })) : undefined,
    mu: s.monsters.length ? s.monsters.map((m) => ({ ...m })) : undefined,
    ru: s.projectiles.length ? s.projectiles : undefined,
    du: s.drops.length ? s.drops : undefined,
  };
}

/** Пустой мир — база, к которой применяется полный кадр. */
export function emptySnapshot(): WorldSnapshot {
  return { tick: 0, players: [], monsters: [], projectiles: [], drops: [] };
}

export function encodeWorldFrame(f: WireFrame): Uint8Array {
  const w = new Writer();
  const d = f.delta;
  w.u8(f.kind);
  w.u32(d.t);
  w.i32(f.sum);

  // ── игроки ──
  const pu = d.pu ?? [];
  w.u8(Math.min(255, pu.length));
  for (const p of pu.slice(0, 255)) {
    w.str(p.id);
    let mask = 0;
    if (p.x !== undefined) mask |= P_X;
    if (p.y !== undefined) mask |= P_Y;
    if (p.facing !== undefined) mask |= P_FACING;
    if (p.hp !== undefined) mask |= P_HP;
    if (p.mana !== undefined) mask |= P_MANA;
    if (p.stamina !== undefined) mask |= P_STAMINA;
    if (p.alive !== undefined) mask |= P_ALIVE;
    if (p.inCombat !== undefined) mask |= P_INCOMBAT;
    if (p.stun !== undefined) mask |= P_STUN;
    if (p.debuffs !== undefined) mask |= P_DEBUFFS;
    if (p.toggles !== undefined) mask |= P_TOGGLES;
    w.u16(mask);
    if (mask & P_X) w.i16(posQ(p.x!));
    if (mask & P_Y) w.i16(posQ(p.y!));
    if (mask & P_FACING) w.u16(angQ(p.facing!));
    if (mask & P_HP) w.u32(Math.max(0, Math.round(p.hp!)));
    if (mask & P_MANA) w.u32(Math.max(0, Math.round(p.mana!)));
    if (mask & P_STAMINA) w.u32(Math.max(0, Math.round(p.stamina!)));
    // Три флага живут в ОДНОМ байте: маска говорит, какие из них в этом патче осмысленны.
    if (mask & (P_ALIVE | P_INCOMBAT | P_STUN)) w.u8((p.alive ? 1 : 0) | (p.inCombat ? 2 : 0) | (p.stun ? 4 : 0));
    if (mask & P_DEBUFFS) w.json(p.debuffs);
    if (mask & P_TOGGLES) w.json(p.toggles);
  }
  const pd = d.pd ?? [];
  w.u8(Math.min(255, pd.length));
  for (const id of pd.slice(0, 255)) w.str(id);

  // ── монстры ──
  const mu = d.mu ?? [];
  w.u16(mu.length);
  for (const m of mu) {
    w.u32(m.id);
    let mask = 0;
    if (m.x !== undefined) mask |= M_X;
    if (m.y !== undefined) mask |= M_Y;
    if (m.facing !== undefined) mask |= M_FACING;
    if (m.hp !== undefined) mask |= M_HP;
    if (m.maxHp !== undefined) mask |= M_MAXHP;
    if (m.alive !== undefined) mask |= M_ALIVE;
    if (m.stun !== undefined) mask |= M_STUN;
    if (m.downed !== undefined) mask |= M_DOWNED;
    if (m.r !== undefined) mask |= M_R;
    if (m.aiState !== undefined) mask |= M_AI;
    if (m.debuffs !== undefined) mask |= M_DEBUFFS;
    w.u16(mask);
    if (mask & M_X) w.i16(posQ(m.x!));
    if (mask & M_Y) w.i16(posQ(m.y!));
    if (mask & M_FACING) w.u16(angQ(m.facing!));
    if (mask & M_HP) w.u32(Math.max(0, Math.round(m.hp!)));
    if (mask & M_MAXHP) w.u32(Math.max(0, Math.round(m.maxHp!)));
    if (mask & (M_ALIVE | M_STUN | M_DOWNED)) w.u8((m.alive ? 1 : 0) | (m.stun ? 2 : 0) | (m.downed ? 4 : 0));
    if (mask & M_R) w.u8(Math.max(0, Math.min(255, Math.round(m.r!))));
    if (mask & M_AI) w.u8(m.aiState === 'chase' ? 1 : 0);
    if (mask & M_DEBUFFS) w.json(m.debuffs);
  }
  const md = d.md ?? [];
  w.u16(md.length);
  for (const id of md) w.u32(id);

  // ── снаряды: всегда целиком (двигаются каждый кадр) ──
  const ru = d.ru ?? [];
  w.u16(ru.length);
  for (const r of ru) {
    w.u32(r.id);
    w.i16(posQ(r.x));
    w.i16(posQ(r.y));
    w.u8(r.owner === 'player' ? 0 : 1);
    w.str(r.dom);
    w.u8(Math.max(0, Math.min(255, Math.round(r.r))));
  }
  const rd = d.rd ?? [];
  w.u16(rd.length);
  for (const id of rd) w.u32(id);

  // ── дропы: только приход и уход ──
  const du = d.du ?? [];
  w.u16(du.length);
  for (const dr of du) {
    w.u32(dr.id);
    w.i16(posQ(dr.x));
    w.i16(posQ(dr.y));
    w.json(dropPayload(dr));
  }
  const dd = d.dd ?? [];
  w.u16(dd.length);
  for (const id of dd) w.u32(id);

  return w.done();
}

export function decodeWorldFrame(buf: Uint8Array): WireFrame {
  const r = new Reader(buf);
  const kind = r.u8() as typeof WIRE_FULL | typeof WIRE_DELTA;
  const t = r.u32();
  const sum = r.i32();
  const d: WorldDelta = { t };

  const puN = r.u8();
  if (puN) {
    const pu: PlayerPatch[] = [];
    for (let i = 0; i < puN; i++) {
      const id = r.str();
      const mask = r.u16();
      const p: PlayerPatch = { id };
      if (mask & P_X) p.x = posU(r.i16());
      if (mask & P_Y) p.y = posU(r.i16());
      if (mask & P_FACING) p.facing = angU(r.u16());
      if (mask & P_HP) p.hp = r.u32();
      if (mask & P_MANA) p.mana = r.u32();
      if (mask & P_STAMINA) p.stamina = r.u32();
      if (mask & (P_ALIVE | P_INCOMBAT | P_STUN)) {
        const f = r.u8();
        if (mask & P_ALIVE) p.alive = (f & 1) !== 0;
        if (mask & P_INCOMBAT) p.inCombat = (f & 2) !== 0;
        if (mask & P_STUN) p.stun = (f & 4) !== 0;
      }
      if (mask & P_DEBUFFS) p.debuffs = r.json<DebuffState>();
      if (mask & P_TOGGLES) p.toggles = r.json<string[]>();
      pu.push(p);
    }
    d.pu = pu;
  }
  const pdN = r.u8();
  if (pdN) { const pd: string[] = []; for (let i = 0; i < pdN; i++) pd.push(r.str()); d.pd = pd; }

  const muN = r.u16();
  if (muN) {
    const mu: MonsterPatch[] = [];
    for (let i = 0; i < muN; i++) {
      const id = r.u32();
      const mask = r.u16();
      const m: MonsterPatch = { id };
      if (mask & M_X) m.x = posU(r.i16());
      if (mask & M_Y) m.y = posU(r.i16());
      if (mask & M_FACING) m.facing = angU(r.u16());
      if (mask & M_HP) m.hp = r.u32();
      if (mask & M_MAXHP) m.maxHp = r.u32();
      if (mask & (M_ALIVE | M_STUN | M_DOWNED)) {
        const f = r.u8();
        if (mask & M_ALIVE) m.alive = (f & 1) !== 0;
        if (mask & M_STUN) m.stun = (f & 2) !== 0;
        if (mask & M_DOWNED) m.downed = (f & 4) !== 0;
      }
      if (mask & M_R) m.r = r.u8();
      if (mask & M_AI) m.aiState = r.u8() === 1 ? 'chase' : 'idle';
      if (mask & M_DEBUFFS) m.debuffs = r.json<DebuffState>();
      mu.push(m);
    }
    d.mu = mu;
  }
  const mdN = r.u16();
  if (mdN) { const md: number[] = []; for (let i = 0; i < mdN; i++) md.push(r.u32()); d.md = md; }

  const ruN = r.u16();
  if (ruN) {
    const ru: ProjView[] = [];
    for (let i = 0; i < ruN; i++) {
      const id = r.u32();
      const x = posU(r.i16());
      const y = posU(r.i16());
      const owner = r.u8() === 0 ? 'player' : 'monster';
      const dom = r.str();
      const rad = r.u8();
      ru.push({ id, x, y, owner, dom, r: rad } as ProjView);
    }
    d.ru = ru;
  }
  const rdN = r.u16();
  if (rdN) { const rd: number[] = []; for (let i = 0; i < rdN; i++) rd.push(r.u32()); d.rd = rd; }

  const duN = r.u16();
  if (duN) {
    const du: DropView[] = [];
    for (let i = 0; i < duN; i++) {
      const id = r.u32();
      const x = posU(r.i16());
      const y = posU(r.i16());
      du.push({ ...r.json<DropPayload>(), id, x, y });
    }
    d.du = du;
  }
  const ddN = r.u16();
  if (ddN) { const dd: number[] = []; for (let i = 0; i < ddN; i++) dd.push(r.u32()); d.dd = dd; }

  return { kind, delta: d, sum };
}

/** Полный кадр как снапшот: применяем «дельту от пустоты». Нужен только типизированный помощник. */
export type { PlayerView, MonsterView };

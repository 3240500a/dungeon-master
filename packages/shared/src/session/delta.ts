import type { WorldSnapshot, PlayerView, MonsterView, ProjView, DropView } from './netTypes.js';
import type { DebuffState } from '../world/debuffs.js';

/**
 * Дельта-снапшоты (задача Ф1.3 плана доработки сервера).
 *
 * ЗАЧЕМ. Каждый кадр вёз ВСЕХ монстров этажа целиком, хотя между кадрами меняются позиции
 * нескольких: остальные стоят в покое и не двигаются вовсе. На типовом этаже это 40 монстров
 * по ~11 полей там, где хватило бы нескольких записей по 4 поля.
 *
 * ПОЧЕМУ БЕЗ ПОДТВЕРЖДЕНИЙ. WebSocket работает поверх TCP: кадры приходят по порядку и без
 * потерь. Значит переспрашивать нечего — достаточно, чтобы ПЕРВЫЙ кадр каждого клиента был
 * полным, а дальше шли дельты. Плюс периодический полный кадр как страховка от расхождения
 * из-за возможной ошибки в самой дельте.
 *
 * ГЛАВНАЯ ГРАБЛЯ, на которую легко наступить: `serializeWorld` кладёт в снапшот ССЫЛКИ на живые
 * объекты (`debuffs` берётся у сущности как есть). Поэтому сравнивать новый снапшот с прошлым
 * НЕЛЬЗЯ — ссылка та же, а содержимое давно изменилось, и разница окажется невидимой. Базис
 * поэтому хранит скалярные копии полей и дешёвые сигнатуры для составных.
 */

/** Патч игрока: id обязателен, остальные поля — только изменившиеся. */
export type PlayerPatch = { id: string } & Partial<Omit<PlayerView, 'id'>>;
/** Патч монстра: id обязателен, остальные поля — только изменившиеся. */
export type MonsterPatch = { id: number } & Partial<Omit<MonsterView, 'id'>>;

/**
 * Дельта мира. Поля короткие намеренно: кадр уходит в сеть как JSON до Ф1.4, и на длинных
 * именах ключей уезжает заметная доля объёма.
 */
export interface WorldDelta {
  /** Номер тика — тот же смысл, что у `WorldSnapshot.tick`. */
  t: number;
  /** Игроки: изменения и ушедшие. */
  pu?: PlayerPatch[];
  pd?: string[];
  /** Монстры: изменения и ушедшие (труп убран из мира). */
  mu?: MonsterPatch[];
  md?: number[];
  /** Снаряды: живут доли секунды и двигаются каждый кадр, поэтому целиком. */
  ru?: ProjView[];
  rd?: number[];
  /** Дропы: после появления не меняются, поэтому только добавления и удаления. */
  du?: DropView[];
  dd?: number[];
}

/**
 * Сигнатура дебаффов. Пустое состояние — подавляющее большинство случаев, и оно стоит одну
 * проверку; непустое сериализуем ЦЕЛИКОМ и точно.
 *
 * Сигнатура обязана быть ТОЧНОЙ. Первая версия округляла время истечения до сотен миллисекунд
 * (и вдобавок читала несуществующее поле `until` вместо `expiresAt`) — из-за этого изменения
 * дебаффов не попадали в дельту, и реконструкция на клиенте расходилась с истиной. Поймал
 * нагрузочный стенд: 594 расхождения из 602 сверок. Экономить здесь нечего — непустых
 * состояний в кадре единицы.
 */
function debuffSig(d: DebuffState): string {
  for (const _k in d) return JSON.stringify(d); // есть хоть один ключ — сравниваем точно
  return '';
}


/** Хеш строки (для id игроков). */
function strHash(x: string): number {
  let h = 0;
  for (let i = 0; i < x.length; i++) h = (h * 31 + x.charCodeAt(i)) | 0;
  return h;
}
/** Квантование величины для контрольной суммы: 1/16 игрового пикселя. */
const q = (v: number): number => Math.round(v * 16) | 0;

/**
 * Контрольная сумма мира (Ф1.3) — для сверки реконструкции клиента с истиной сервера
 * НА ТОМ ЖЕ ТИКЕ. Сервер кладёт её в кадр дельты, клиент считает по своей копии.
 *
 * Почему именно так, а не «сравнить с ближайшим полным кадром»: полный кадр приходит ВМЕСТО
 * дельты, то есть описывает более поздний тик — сравнение с ним всегда показывает расхождение,
 * которого нет. На эти грабли я и наступил, когда впервые прикручивал проверку к стенду.
 *
 * Сумма коммутативна (складываем вклады сущностей), поэтому порядок сущностей не важен —
 * а он у реконструкции свой.
 */
export function worldChecksum(s: WorldSnapshot): number {
  let h = (s.players.length * 7919 + s.monsters.length * 104729 + s.drops.length * 31 + s.projectiles.length * 17) | 0;
  for (const p of s.players) {
    h = (h + strHash(p.id) + q(p.x) * 3 + q(p.y) * 5 + q(p.facing) * 9 + q(p.hp) * 7
      + (p.alive ? 11 : 0) + (p.inCombat ? 13 : 0) + p.toggles.length * 19) | 0;
  }
  for (const m of s.monsters) {
    h = (h + Math.imul(m.id, 2654435761) + q(m.x) * 3 + q(m.y) * 5 + q(m.facing) * 9 + q(m.hp) * 7
      + (m.alive ? 11 : 0) + (m.stun ? 13 : 0) + (m.downed ? 17 : 0)) | 0;
  }
  for (const d of s.drops) h = (h + Math.imul(d.id, 40503)) | 0;
  return h | 0;
}

interface PlayerBase {
  x: number; y: number; facing: number; hp: number; mana: number; stamina: number;
  alive: boolean; inCombat: boolean; dSig: string; tSig: string;
}
interface MonsterBase {
  x: number; y: number; facing: number; hp: number; maxHp: number; alive: boolean;
  stun: boolean; downed: boolean; r: number; aiState: string; dSig: string;
}

/**
 * Держит базис последнего отправленного состояния и считает от него дельту.
 * Один экземпляр на комнату: все клиенты комнаты получают одинаковые кадры (пока нет
 * области интереса — она сделает базис персональным, задача Ф1.2).
 */
export class SnapshotDelta {
  private players = new Map<string, PlayerBase>();
  private monsters = new Map<number, MonsterBase>();
  private projectiles = new Set<number>();
  private drops = new Set<number>();
  private primed = false;

  /** Есть ли базис. Пока нет — клиенту надо слать полный кадр. */
  get ready(): boolean { return this.primed; }

  /** Забыть базис: после смены области или перед отправкой полного кадра. */
  reset(): void {
    this.players.clear();
    this.monsters.clear();
    this.projectiles.clear();
    this.drops.clear();
    this.primed = false;
  }

  /** Принять снапшот как новый базис, ничего не считая (используется вместе с полным кадром). */
  prime(snap: WorldSnapshot): void {
    this.reset();
    this.absorb(snap);
    this.primed = true;
  }

  /**
   * Дельта от базиса к снапшоту; базис обновляется. Возвращает `null`, если базиса ещё нет —
   * тогда зовущая сторона обязана отправить полный кадр и позвать `prime`.
   */
  next(snap: WorldSnapshot): WorldDelta | null {
    if (!this.primed) return null;
    const d: WorldDelta = { t: snap.tick };

    // ── игроки ──
    const seenP = new Set<string>();
    for (const p of snap.players) {
      seenP.add(p.id);
      const b = this.players.get(p.id);
      const dSig = debuffSig(p.debuffs);
      const tSig = p.toggles.length ? p.toggles.join(',') : '';
      if (!b) {
        (d.pu ??= []).push({ ...p });
        continue;
      }
      const patch: PlayerPatch = { id: p.id };
      let changed = false;
      if (p.x !== b.x) { patch.x = p.x; changed = true; }
      if (p.y !== b.y) { patch.y = p.y; changed = true; }
      if (p.facing !== b.facing) { patch.facing = p.facing; changed = true; }
      if (p.hp !== b.hp) { patch.hp = p.hp; changed = true; }
      if (p.mana !== b.mana) { patch.mana = p.mana; changed = true; }
      if (p.stamina !== b.stamina) { patch.stamina = p.stamina; changed = true; }
      if (p.alive !== b.alive) { patch.alive = p.alive; changed = true; }
      if (p.inCombat !== b.inCombat) { patch.inCombat = p.inCombat; changed = true; }
      if (dSig !== b.dSig) { patch.debuffs = p.debuffs; changed = true; }
      if (tSig !== b.tSig) { patch.toggles = p.toggles; changed = true; }
      if (changed) (d.pu ??= []).push(patch);
    }
    for (const id of this.players.keys()) if (!seenP.has(id)) (d.pd ??= []).push(id);

    // ── монстры ──
    const seenM = new Set<number>();
    for (const m of snap.monsters) {
      seenM.add(m.id);
      const b = this.monsters.get(m.id);
      const dSig = debuffSig(m.debuffs);
      if (!b) {
        (d.mu ??= []).push({ ...m });
        continue;
      }
      const patch: MonsterPatch = { id: m.id };
      let changed = false;
      if (m.x !== b.x) { patch.x = m.x; changed = true; }
      if (m.y !== b.y) { patch.y = m.y; changed = true; }
      if (m.facing !== b.facing) { patch.facing = m.facing; changed = true; }
      if (m.hp !== b.hp) { patch.hp = m.hp; changed = true; }
      if (m.maxHp !== b.maxHp) { patch.maxHp = m.maxHp; changed = true; }
      if (m.alive !== b.alive) { patch.alive = m.alive; changed = true; }
      if (m.stun !== b.stun) { patch.stun = m.stun; changed = true; }
      if (m.downed !== b.downed) { patch.downed = m.downed; changed = true; }
      if (m.r !== b.r) { patch.r = m.r; changed = true; }
      if (m.aiState !== b.aiState) { patch.aiState = m.aiState; changed = true; }
      if (dSig !== b.dSig) { patch.debuffs = m.debuffs; changed = true; }
      if (changed) (d.mu ??= []).push(patch);
    }
    for (const id of this.monsters.keys()) if (!seenM.has(id)) (d.md ??= []).push(id);

    // ── снаряды: двигаются каждый кадр, патч был бы не короче целого ──
    if (snap.projectiles.length) d.ru = snap.projectiles;
    for (const id of this.projectiles) if (!snap.projectiles.some((r) => r.id === id)) (d.rd ??= []).push(id);

    // ── дропы: после появления неподвижны, поэтому только приход и уход ──
    for (const dr of snap.drops) if (!this.drops.has(dr.id)) (d.du ??= []).push(dr);
    for (const id of this.drops) if (!snap.drops.some((x) => x.id === id)) (d.dd ??= []).push(id);

    this.absorb(snap);
    return d;
  }

  /** Запомнить снапшот как базис. */
  private absorb(snap: WorldSnapshot): void {
    this.players.clear();
    for (const p of snap.players) {
      this.players.set(p.id, {
        x: p.x, y: p.y, facing: p.facing, hp: p.hp, mana: p.mana, stamina: p.stamina,
        alive: p.alive, inCombat: p.inCombat,
        dSig: debuffSig(p.debuffs), tSig: p.toggles.length ? p.toggles.join(',') : '',
      });
    }
    this.monsters.clear();
    for (const m of snap.monsters) {
      this.monsters.set(m.id, {
        x: m.x, y: m.y, facing: m.facing, hp: m.hp, maxHp: m.maxHp, alive: m.alive,
        stun: m.stun, downed: m.downed, r: m.r, aiState: m.aiState, dSig: debuffSig(m.debuffs),
      });
    }
    this.projectiles.clear();
    for (const r of snap.projectiles) this.projectiles.add(r.id);
    this.drops.clear();
    for (const dr of snap.drops) this.drops.add(dr.id);
  }
}

/**
 * Применить дельту к снапшоту (клиент). Возвращает НОВЫЙ снапшот; сущности, которых дельта
 * не касалась, переносятся по ссылке — это дешевле копирования и безопасно, потому что
 * на клиенте снапшоты только читаются.
 */
export function applyWorldDelta(prev: WorldSnapshot, d: WorldDelta): WorldSnapshot {
  const players = patchList(prev.players, d.pu, d.pd);
  const monsters = patchList(prev.monsters, d.mu, d.md);
  const drops = d.du || d.dd
    ? [...prev.drops.filter((x) => !d.dd?.includes(x.id)), ...(d.du ?? [])]
    : prev.drops;
  return {
    tick: d.t,
    players,
    monsters,
    projectiles: d.ru ?? (d.rd ? prev.projectiles.filter((r) => !d.rd!.includes(r.id)) : []),
    drops,
  };
}

/** Слить патчи и удаления в список сущностей по id. */
function patchList<T extends { id: K }, K, P extends { id: K }>(
  prev: readonly T[], upd: P[] | undefined, del: K[] | undefined,
): T[] {
  if (!upd && !del) return prev as T[];
  const byId = new Map<K, T>();
  for (const e of prev) byId.set(e.id, e);
  if (del) for (const id of del) byId.delete(id);
  if (upd) {
    for (const patch of upd) {
      const cur = byId.get(patch.id);
      byId.set(patch.id, (cur ? { ...cur, ...patch } : { ...patch }) as unknown as T);
    }
  }
  return [...byId.values()];
}

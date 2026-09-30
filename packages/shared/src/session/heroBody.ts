import type { ConfigRegistry } from '../config/registry.js';
import type { DebuffKind, DebuffState } from '../world/debuffs.js';
import type { PlayerEntity } from '../world/state.js';
import type { SaveState } from '../types/save.js';
import { playerSnapshot } from './derive.js';
import { effectivePool, reservedFrac, toggleBuffMods } from './toggles.js';

/**
 * ТЕЛО ГЕРОЯ ВНЕ МИРА — то, с чем он ушёл из сессии и с чем вернётся: запись ухода комнаты (R4-06: выход, обрыв, реконнект) и тело города на
 * время арены (R11-04: `arenaHome`). Раньше жило в `server/net/room.ts` (`stateOf`/`restoreLeft`/`leaveArena`); ⭐ D4 вынесено сюда, чтобы
 * фаззер правил (`session/fuzz/rulesFuzz.ts`: шаги `arena` и `reconnect`) гонял переходы тем же кодом, что комната.
 *
 * ⭐ D4: ОТКАТЫ — ГЕРОЯ, А НЕ ТЕЛА. Тело (здоровье, пулы, баффы, дебаффы, тоглы) у арены своё и в город не идёт, а откат умения — время
 * героя: применил на арене — он идёт и в городе (`keepLaterCooldowns`). Раньше конец арены возвращал откаты тела города (минус время боя), и
 * бафф, скастованный на арене, в городе был готов снова: круг «город ↔ арена» давал два окна баффа на откат — до 2·действие / (откат +
 * действие) времени под баффом, мимо правила времени баффа (`formulas/buffTiming.ts`).
 */
export interface HeroBody {
  /** Точка ухода — только на том же экземпляре этажа. */
  pos?: { x: number; y: number };
  alive: boolean;
  hp: number; mana: number; stamina: number;
  /** Дебаффы с ОСТАТКОМ длительности в `expiresAt` (мс). */
  debuffs: DebuffState;
  stunTimer: number; attackCd: number; dodgeCd: number; combatTimer: number;
  skillCd: Record<string, number>; toggles: string[]; skillBuffs: Record<string, number>;
}

/** R4-06: тело героя сейчас (как запись ухода); время для снятого стоит — дебаффы остатком. `nowMs` — время мира. */
export function bodyOf(p: PlayerEntity, nowMs: number): HeroBody {
  const debuffs: DebuffState = {};
  for (const [k, d] of Object.entries(p.debuffs)) if (d) debuffs[k as DebuffKind] = { ...d, expiresAt: Math.max(0, d.expiresAt - nowMs) };
  return {
    pos: { ...p.pos }, alive: p.alive, hp: p.hp, mana: p.mana, stamina: p.stamina, debuffs,
    stunTimer: p.stunTimer, attackCd: p.attackCd, dodgeCd: p.dodgeCd, combatTimer: p.combatTimer,
    skillCd: { ...p.skillCd }, toggles: [...p.toggles], skillBuffs: { ...p.skillBuffs },
  };
}

/**
 * R4-06: вернуть сущности героя тело `s`. `true` — ушёл мёртвым с этого же этажа: мёртв и сейчас.
 * ⭐ R9-14: здоровье, мана, выносливость — КАКИМИ УШЁЛ. Раньше они подрезались по максимуму свежей сущности, а тот посчитан без стойки и
 * баффов (`playerSnapshot` без рантайм-модов): воин в стойке +15% жизни с полным здоровьем после F5, обрыва или второй вкладки вставал на
 * ~87% настоящего максимума — посреди боя. Выше честного максимума не встанет ничего: первый же тик подрезает здоровье по максимуму со
 * стойкой и баффами (R5-02; тогл, чьих очков больше нет, он снимет раньше — R4-05), а ману и выносливость — в регене, по резерву тоглов.
 * Бесплатного лечения тоже нет (R4-06): ушёл раненым — вернулся раненым.
 */
export function putBody(p: PlayerEntity, s: HeroBody, nowMs: number): boolean {
  p.debuffs = {};
  for (const [k, d] of Object.entries(s.debuffs)) if (d) p.debuffs[k as DebuffKind] = { ...d, expiresAt: nowMs + d.expiresAt };
  p.stunTimer = s.stunTimer; p.attackCd = s.attackCd; p.dodgeCd = s.dodgeCd; p.combatTimer = s.combatTimer;
  p.skillCd = { ...s.skillCd }; p.toggles = [...s.toggles]; p.skillBuffs = { ...s.skillBuffs };
  p.hp = s.hp; p.mana = s.mana; p.stamina = s.stamina;
  if (s.alive) return false;
  p.alive = false; p.hp = 0;
  return true;
}

/**
 * ⚠ R23-05: ТЕЛО ГОРОДА НА ВРЕМЯ АРЕНЫ и сколько секунд арены прошло с его снятия (`Room.arenaHome`, у фаззера правил — `trip`). Тело снято
 * на входе в арену и стоит, а время героя идёт — бой на арене старит его откаты и баффы (`agedBody`), как у дождавшегося конца (`arenaReturn`).
 */
export interface ArenaHome { body: HeroBody; sec: number }

/** ⚠ R23-05: таймеры (остаток в секундах), постаревшие на `sec`: кончившиеся — долой. Новый объект. */
export function agedTimers(t: Readonly<Record<string, number>>, sec: number): Record<string, number> {
  const out: Record<string, number> = {};
  const dt = Math.max(0, sec);
  for (const [k, v] of Object.entries(t)) if (v - dt > 0) out[k] = v - dt;
  return out;
}

/**
 * ⚠ R23-05: ТЕЛО, ПРОЖИВШЕЕ `sec` СЕКУНД ГЕРОЯ ВНЕ МИРА (тело города, пока герой бился на арене): откаты умений, временные баффы (R16-07), лок
 * удара, рывок и «в бою» — минус это время. Пулы (реген) — не здесь: присутствующему их доливает `arenaReturn`, ушедшему — нет (R4-06). Новый объект.
 */
export function agedBody(s: HeroBody, sec: number): HeroBody {
  const dt = Math.max(0, sec);
  return {
    ...s, skillCd: agedTimers(s.skillCd, dt), skillBuffs: agedTimers(s.skillBuffs, dt),
    attackCd: Math.max(0, s.attackCd - dt), dodgeCd: Math.max(0, s.dodgeCd - dt), combatTimer: Math.max(0, s.combatTimer - dt),
  };
}

/** ⭐ D4: в `into` — более поздний из откатов (остаток в секундах): откат умения идёт по времени героя, в каком бы теле он его ни взял. */
export function keepLaterCooldowns(into: Record<string, number>, from: Readonly<Record<string, number>> | undefined): void {
  if (!from) return;
  for (const [k, left] of Object.entries(from)) if (left > (into[k] ?? 0)) into[k] = left;
}

/**
 * ⭐ D4: ОТКАТЫ ГЕРОЯ — В СЕЙВ (`save.vitals.cd`: остаток в секундах на миг `vitals.at`), рядом с пулами (R11-04): вход в ДРУГУЮ комнату
 * (новая — свежая сущность; запись ухода, которую обогнал сейв другой комнаты, R12-02) без них заводил героя со всеми откатами готовыми —
 * клич на арене, вход в комнату друга и назад по коду, и клич снова (до действие / (действие + время перехода) под баффом, мимо правила
 * времени баффа). Ключи — как у `skillCd`: узлы древа и печати вставок (`ins:`). В арене — более поздние из тела города и арены.
 * ⚠ R23-05: откаты тела города — постаревшие на время арены (`home.sec`): оно снято на входе и стоит, а время героя шло. Раньше сейв с арены
 * (уход до её конца, автосейв, дренаж ноды) нёс откаты города, застывшие на входе, — и вход в другую комнату заводил героя с кличем в откате,
 * хотя по его времени клич давно готов (до самого длинного отката — против игрока, но мимо правила D4).
 */
export function cooldownsForSave(p: PlayerEntity, home?: ArenaHome): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  if (home) keepLaterCooldowns(out, agedTimers(home.body.skillCd, home.sec));
  keepLaterCooldowns(out, p.skillCd);
  for (const [k, v] of Object.entries(out)) if (!(Number.isFinite(v) && v > 0)) delete out[k];
  return Object.keys(out).length ? out : undefined;
}

/**
 * ⭐ R11-04, D4: ЧТО КОМНАТА ПИШЕТ В СЕЙВ (`save.vitals`) о герое `p` на миг `nowMs` (часы сервера): пулы живого (на арене — тела города
 * `home`: полное тело арены из неё не уносится; без регена за время арены — как у записи ушедшего) и откаты героя (`cooldownsForSave`: откаты
 * тела города — постаревшие на время арены, R23-05). Нечего писать — `undefined`.
 * ⭐ R22-04: МЁРТВЫЙ — без пулов (оживёт полным: штраф взят), но С ОТКАТАМИ. Раньше мёртвый писался без `vitals` вовсе, и с пулами уходили откаты:
 * погибший в коопе, закрывший вкладку, пока ждал пати, возвращался после смены этажа (его мёртвую запись ухода она снимает) со всеми откатами
 * готовыми — полный откат баффа даром за каждую смерть (подключённый мёртвый оживает со своими). Одна функция — у комнаты и фаззера правил.
 */
export function vitalsForSave(p: PlayerEntity, home: ArenaHome | undefined, nowMs: number): SaveVitals | undefined {
  const s = home?.body ?? p;
  const cd = cooldownsForSave(p, home);
  if (s.alive) return { hp: s.hp, mana: s.mana, stamina: s.stamina, at: nowMs, ...(cd ? { cd } : {}) };
  return cd ? { at: nowMs, cd } : undefined;
}
/** Пулы и откаты героя в сейве (`SaveState.vitals`). */
type SaveVitals = NonNullable<SaveState['vitals']>;

/** ⭐ D4: откаты из сейва на миг `nowMs` (часы сервера): остаток минус время вне игры, как реген пулов (R11-04); битое — мимо. Новый объект. */
export function savedCooldowns(v: { cd?: Record<string, number>; at?: number } | undefined, nowMs: number): Record<string, number> {
  const out: Record<string, number> = {};
  if (!v?.cd || typeof v.cd !== 'object') return out;
  const dt = typeof v.at === 'number' && Number.isFinite(v.at) ? Math.max(0, nowMs - v.at) / 1000 : 0;
  for (const [k, left] of Object.entries(v.cd)) {
    const rest = typeof left === 'number' && Number.isFinite(left) ? left - dt : 0;
    if (rest > 0) out[k] = rest;
  }
  return out;
}

/**
 * ⭐ R11-04: КОНЕЦ АРЕНЫ ДЛЯ ПРИСУТСТВУЮЩЕГО — тело города (`home`, взятое на входе в арену) плюс время боя (`dtSec`), как если бы он стоял в
 * городе; урон арены (и её полное тело) в город не идёт. `pools` — есть ли у сущности снимок статов (у снятой с мира — нет: пулы как ушёл).
 * ⭐ R16-07: временные баффы (скилов, печатей `ins:`, зелий `pot:`) — тоже временем города: запись арены хранит их остатком, а арена их
 * снимает (`respawnPlayer`), и они стояли — бафф возвращался полным. ⭐ R15-09: потолок и реген — по герою города (с модами его тоглов), а не
 * по снимку арены (мёртвому телу реген не идёт). ⭐ D4: откаты — более поздние из города (минус время боя) и арены: применённое на арене в
 * городе не готово даром.
 */
export function arenaReturn(cfg: ConfigRegistry, p: PlayerEntity, home: HeroBody, dtSec: number, nowMs: number, pools: boolean): void {
  const arenaCd = { ...p.skillCd };
  const dt = Math.max(0, dtSec);
  putBody(p, agedBody(home, dt), nowMs);   // ⚠ R23-05: одно старение тела города — и здесь, и у сейва с арены, и у ушедшего (`arenaAwayBody`)
  if (pools && p.alive) {
    const d = playerSnapshot(p.save, cfg, toggleBuffMods(cfg, p.toggles)).derived;
    const cap = (have: number, max: number): number => Math.max(have, max);
    p.hp = Math.min(cap(p.hp, d.maxHp), p.hp + d.hpRegen * dt);
    p.mana = Math.min(cap(p.mana, effectivePool(d.maxMana, reservedFrac(cfg, p.toggles, 'mana'))), p.mana + d.manaRegen * dt);
    p.stamina = Math.min(cap(p.stamina, effectivePool(d.maxStamina, reservedFrac(cfg, p.toggles, 'stamina'))), p.stamina + d.staminaRegen * dt);
  }
  keepLaterCooldowns(p.skillCd, arenaCd);
}

/**
 * КОНЕЦ АРЕНЫ ДЛЯ УШЕДШЕГО С НЕЁ РАНЬШЕ — его запись ухода теперь тело города (`home` без точки ухода), без регена: время для ушедшего стоит
 * (R4-06). ⭐ D4: откаты — более поздние из тела города и записи ухода с арены (`arenaLeft`, если он ушёл уже с неё): взятое на арене не
 * возвращается готовым вместе с телом города. ⚠ R23-05: тело города — постаревшее на время, что он бился на арене ДО ухода (`home.sec`:
 * откаты, баффы, таймеры — `agedBody`); стоит время только после ухода. Раньше оно возвращалось застывшим на входе в арену: клич, готовый по
 * времени героя, снова в откате, — а постаревший без баффов откат открыл бы и второе окно застывшего баффа города.
 */
export function arenaAwayBody(home: ArenaHome, arenaLeft?: HeroBody): HeroBody {
  const s = agedBody(home.body, home.sec);
  delete s.pos;
  keepLaterCooldowns(s.skillCd, arenaLeft?.skillCd);
  return s;
}

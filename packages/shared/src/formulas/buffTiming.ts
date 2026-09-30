import type { ConfigShapes } from '../config/schemas.js';
import { abilityCooldown } from './combat.js';

/**
 * ⭐ D4: ОДНО ПРАВИЛО ВРЕМЕНИ БАФФА (решение владельца). Откат временного баффа на КАЖДОМ ранге не короче его действия на том же ранге
 * с отдыхом:
 *
 *     откат(ранг) ≥ действие(ранг) × (1 + balance.buffMinRest)
 *
 * — отдых после действия не короче доли `buffMinRest` (> 0, схема баланса) его действия, и откат СТРОГО длиннее действия. Под баффом —
 * не больше 1 / (1 + buffMinRest) времени (80 % при 0.25) на любом ранге, с любыми вставками, через арены и переподключения.
 *
 * ПОЧЕМУ ОДНО. Правило жило кусками и возвращалось: R6-15 (у баффа не было отката — повтор в кадр истечения, 100 % времени), R19-03 (ранг
 * режет откат, а не действие — с какого-то ранга откат снова ≤ действия; зажим в ядре, а данные и редактор о нём не знали: «Огненные чары»
 * 12 с на 12 с, клич воина с 13-го ранга). Теперь его спрашивают все из этого файла:
 *  — схема конфига (`buffTimingIssues` через `configCrossIssues`): реестр (`loadAll`/`reload`: файл, `/api/dev/config`, оверрайды базы) и
 *    редактор (`validatedKeys`) не пускают бафф, нарушающий правило хоть на одном ранге;
 *  — оверрайд из базы, сохранённый до правила, приводится (откат вверх до правила — `upgradeStoredOverride`, вслух в лог сервера);
 *  — ядро (`clampBuffCooldown`): откат, всё же короче правила (конфиг в обход реестра), зажимается до него — со строкой в лог, раз на бафф;
 *  — фаззер правил: доля времени под каждым баффом героя не выше 1 / (1 + buffMinRest) на долгих прогонах (`buff-uptime`).
 *
 * ЧЕЙ БАФФ. Узел древа (`category: 'buff'`): откат по рангу — общий `abilityCooldown` (−3 % базы за ранг); ранг ВЫШЕ ПОТОЛКА узла
 * (`maxRank`, снизили в редакторе — вложенное остаётся рангами до сброса) откат дальше не режет; действие рангом не растёт. Вставка в гнезде
 * баффа множит его откат (`insertCooldownMult`) — правило держит и худшую сборку. Печать вставки (прок-бафф `ins:<вставка>`, тип «Печать»):
 * действие растёт с рангом донора (`insertGain`), откат — свой (`proc.ability.cooldown`), один на все скилы с этой вставкой. Бафф зелья
 * (`pot:`) правилу не подчиняется: он расходный — ограничен колбами, а не временем.
 */

/** Сотые вверх: откат, округлённый до сотых (`abilityCooldown`), не выходит короче правила из-за хвоста плавающей точки. */
const ceil2 = (x: number): number => Math.ceil(x * 100 - 1e-6) / 100;
const r2 = (x: number): number => Math.round(x * 100) / 100;

/** Наименьший откат баффа, действующего `durationSec`: действие + отдых (`minRest` его доли), в сотых вверх. */
export function buffRestFloor(durationSec: number, minRest: number): number {
  return ceil2(Math.max(0, durationSec) * (1 + Math.max(0, minRest)));
}

/** Потолок доли времени под баффом по правилу: 1 / (1 + minRest). */
export function buffUptimeBound(minRest: number): number {
  return 1 / (1 + Math.max(0, minRest));
}

/** Откат не короче правила (допуск — шум плавающей точки). */
export function buffTimingOk(cooldown: number, durationSec: number, minRest: number): boolean {
  return cooldown >= buffRestFloor(durationSec, minRest) - 1e-9;
}

/**
 * Откат баффа-узла на ранге: `abilityCooldown` базы; ранг выше потолка узла — как потолок (ранг, вложенный до того, как потолок снизили,
 * откат ниже проверенного схемой не уводит).
 */
export function buffNodeCooldown(base: number, rank: number, maxRank: number): number {
  return abilityCooldown(base, Math.min(Math.max(1, rank), Math.max(1, maxRank)));
}

/** Прибавка вставки на ранге донора: × (1 + gain·(ранг−1)). Ранг 1 — ровно исходные числа. */
export function insertGain(gain: number, rank: number): number {
  return 1 + gain * (Math.max(1, rank) - 1);
}

/** Множитель отката носителя от вставки на ранге донора: надбавка (или скидка) тает с рангом (`cooldownDecay`), не ниже нуля. */
export function insertCooldownMult(cooldownMult: number, cooldownDecay: number, rank: number): number {
  return 1 + (cooldownMult - 1) * Math.max(0, 1 - cooldownDecay * (Math.max(1, rank) - 1));
}

/** Нарушение правила в конфиге: таблица, строка (id), первый ранг, где откат короче, и что поправить. */
export interface BuffTimingIssue {
  table: 'skill-tree' | 'skill-inserts';
  id: string;
  rank: number;
  cooldown: number;
  duration: number;
  floor: number;
  /**
   * Приведение старого оверрайда — ЗАЖИМ, как делал R19-03 в ядре, только в данных: узел — ранги выше последнего годного не режут откат
   * (`maxRank` — до него; первый ранг и так короче правила — откат 1-го ранга поднят до правила, и потолок по нему); печать — откат до
   * правила на высшем ранге донора.
   */
  repair: { cooldown: number; maxRank?: number };
  msg: string;
}

type Tables = { balance: Pick<ConfigShapes['balance'], 'buffMinRest' | 'skillSocketRanks'>; 'skill-tree': Pick<ConfigShapes['skill-tree'], 'nodes'>; 'skill-inserts': ConfigShapes['skill-inserts'] };
type Insert = ConfigShapes['skill-inserts'][number];

const pct = (m: number): string => `${Math.round(m * 1000) / 10} %`;

/** Наибольший ранг донора вставки в древе (0 — донора нет: вставку не открыть). */
function donorMaxRank(tree: Tables['skill-tree'], insertId: string): number {
  let best = 0;
  for (const n of tree.nodes) if (n.effect.grantsInsert === insertId) best = Math.max(best, n.maxRank);
  return best;
}

/** Влезает ли вставка в гнездо баффа (как `insertFits`: пустое ограничение — «куда угодно», фигуры — только у каста). */
function fitsBuff(ins: Insert): boolean {
  const f = ins.fits;
  if (f.categories?.length && !(f.categories as string[]).includes('buff')) return false;
  return !f.shapes?.length;
}

/**
 * Худшие множители отката баффа от вставок, по возрастанию: по одной вставке каждого типа (как `socketed`), из тех, что влезают в бафф,
 * включены и открываются донором; скидка вставки сильнее всего на первом ранге донора (надбавка тает с рангом). Надбавки (≥ 1) откат
 * только удлиняют — в худший случай не идут. Худшая сборка в `n` гнёздах — произведение первых `n`.
 */
function worstInsertMults(t: Tables): number[] {
  const byType = new Map<string, number>();
  for (const ins of t['skill-inserts']) {
    if (ins.enabled === false || !fitsBuff(ins)) continue;
    const top = donorMaxRank(t['skill-tree'], ins.id);
    if (top <= 0) continue;
    let low = 1;
    for (let r = 1; r <= top; r++) low = Math.min(low, insertCooldownMult(ins.cooldownMult, ins.perRank.cooldownDecay, r));
    byType.set(ins.type, Math.min(byType.get(ins.type) ?? 1, low));
  }
  return [...byType.values()].filter((k) => k < 1).sort((a, b) => a - b);
}

/** Наименьшая база отката (не ниже `from`), при которой бафф `durationSec` на ранге `rank` с множителем вставок `k` держит правило. */
function minBase(from: number, rank: number, k: number, durationSec: number, m: number): number {
  const f = Math.max(0.35, 1 - 0.03 * (Math.max(1, rank) - 1));
  let base = Math.max(from, ceil2(buffRestFloor(durationSec, m) / (k * f)));
  for (let i = 0; i < 1000 && !buffTimingOk(abilityCooldown(r2(base * k), rank), durationSec, m); i++) base = r2(base + 0.01);
  return base;
}

/** Сколько гнёзд открыто на ранге (как `socketsOpen`: пороги баланса). */
const socketsAt = (ranks: readonly number[], rank: number): number => ranks.filter((r) => rank >= r).length;

/**
 * ⭐ D4: НАРУШЕНИЯ ПРАВИЛА В КОНФИГЕ. Узлы-баффы древа — каждый ранг 1…`maxRank` (с худшей сборкой вставок в открытых гнёздах), печати
 * вставок — каждый ранг донора 1…потолок донора. На строку — первый ранг, где откат короче правила, и подсказка: какой откат, потолок ранга
 * или действие правило пропустит. Пусто — конфиг годен.
 */
export function buffTimingIssues(t: Tables): BuffTimingIssue[] {
  const m = t.balance.buffMinRest;
  const out: BuffTimingIssue[] = [];
  const rest = `отдых ${pct(m)} действия (balance.buffMinRest)`;
  const worst = worstInsertMults(t);
  const multAt = (rank: number): number => worst.slice(0, socketsAt(t.balance.skillSocketRanks, rank)).reduce((k, x) => k * x, 1);
  for (const n of t['skill-tree'].nodes) {
    const a = n.effect.active;
    if (a?.category !== 'buff') continue;
    const floor = buffRestFloor(a.durationSec, m);
    for (let rank = 1; rank <= n.maxRank; rank++) {
      const k = multAt(rank);
      const cd = abilityCooldown(r2(a.cooldown * k), rank);
      if (buffTimingOk(cd, a.durationSec, m)) continue;
      // Подсказки: наименьшая база, при которой проходит потолок; наибольший годный потолок; наибольшее годное действие.
      const base = minBase(a.cooldown, n.maxRank, multAt(n.maxRank), a.durationSec, m);
      const top = rank - 1;
      const dur = Math.floor((abilityCooldown(r2(a.cooldown * multAt(n.maxRank)), n.maxRank) / (1 + m)) * 100) / 100;
      const via = k < 1 ? ` (со вставками в гнёздах: откат ×${r2(k)})` : '';
      // Приведение (зажим R19-03 в данных): годен первый ранг — потолок до последнего годного; нет — откат 1-го ранга до правила.
      const base1 = top >= 1 ? a.cooldown : minBase(a.cooldown, 1, multAt(1), a.durationSec, m);
      let keep = 1;
      while (keep < n.maxRank && buffTimingOk(abilityCooldown(r2(base1 * multAt(keep + 1)), keep + 1), a.durationSec, m)) keep++;
      out.push({
        table: 'skill-tree', id: n.id, rank, cooldown: cd, duration: a.durationSec, floor, repair: { cooldown: base1, maxRank: keep },
        msg: `бафф «${n.name}» (${n.id}) на ранге ${rank}: откат ${cd} с${via} короче правила — действие ${a.durationSec} с + ${rest} = ${floor} с. `
          + `Поднять откат (1-й ранг) до ${base} с${top >= 1 ? `, или потолок ранга не выше ${top}` : ''}, или действие не длиннее ${dur} с.`,
      });
      break;
    }
  }
  for (const ins of t['skill-inserts']) {
    const ab = ins.proc?.ability;
    if (ins.enabled === false || ab?.category !== 'buff') continue;
    const top = Math.max(1, donorMaxRank(t['skill-tree'], ins.id));
    for (let rank = 1; rank <= top; rank++) {
      const dur = ab.durationSec * insertGain(ins.perRank.gain, rank);
      if (buffTimingOk(ab.cooldown, dur, m)) continue;
      const need = buffRestFloor(ab.durationSec * insertGain(ins.perRank.gain, top), m);
      out.push({
        table: 'skill-inserts', id: ins.id, rank, cooldown: ab.cooldown, duration: r2(dur), floor: buffRestFloor(dur, m), repair: { cooldown: Math.max(ab.cooldown, need) },
        msg: `печать «${ins.name}» (${ins.id}) на ранге донора ${rank}: откат ${ab.cooldown} с короче правила — действие ${r2(dur)} с + ${rest} = ${buffRestFloor(dur, m)} с. `
          + `Откат печати (proc.ability.cooldown) не короче ${need} с — столько держит и высший ранг донора (${top}).`,
      });
      break;
    }
  }
  return out;
}

// ── Ядро: зажим отката с предупреждением ─────────────────────────────────────────────────────────

let warnSink: (line: string) => void = (line) => console.warn(line);
const warned = new Set<string>();

/** Куда говорить о зажиме (умолчание — `console.warn`). Возвращает прежний приёмник. Для тестов и сервера. */
export function setBuffTimingWarn(fn: (line: string) => void): (line: string) => void {
  const was = warnSink;
  warnSink = fn;
  warned.clear();
  return was;
}

/**
 * ⭐ D4: ОТКАТ БАФФА В ЯДРЕ — не короче правила. Годный конфиг (схема, приведение оверрайдов) сюда короче правила не приходит; пришёл
 * (конфиг, собранный в обход реестра, — правка объекта таблицы на лету) — откат зажимается до правила, и это говорится вслух: раз на бафф
 * и числа, а не на каждый каст.
 */
export function clampBuffCooldown(cooldown: number, durationSec: number, minRest: number, id: string): number {
  if (buffTimingOk(cooldown, durationSec, minRest)) return cooldown;
  const floor = buffRestFloor(durationSec, minRest);
  const key = `${id}|${cooldown}|${durationSec}|${minRest}`;
  if (!warned.has(key)) {
    if (warned.size >= 1000) warned.clear();
    warned.add(key);
    warnSink(`[dm] ⭐ D4: откат баффа «${id}» ${cooldown} с короче правила (действие ${durationSec} с + отдых ${pct(minRest)}) — зажат до ${floor} с. Конфиг мимо схемы: сохранить заново из редактора.`);
  }
  return floor;
}

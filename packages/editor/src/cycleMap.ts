import {
  ConfigRegistry, bandDepth, isWaypoint, nextWaypointAfter, floorMonsterLevel, pickGearTier, pickTierClamped,
  type BossRank,
} from '@dm/shared';

/**
 * ⭐⭐ Г8-3 (15.10, просьба владельца): вкладка «🔄 Круг забега» — НАСТРОЙКА ТОЙ САМОЙ ТАБЛИЦЫ. «Давай в конфиг
 * редактор вынесем настройку этой таблицы, чтобы можно было всё настраивать и тюнить.»
 *
 * Что здесь правится (всё — в `balance.dungeonAccess`, то есть в рабочей копии редактора, живьём):
 *  • длина круга (`contentCycle`) и окно карты забега (`lookahead`);
 *  • МЕСТА круга — клик по месту крутит его: обычный → портал → мини → крепкий → актовый → обычный. Из этого
 *    собираются `portalsAt` (места порталов) и `bossLadder` (места боссов с рангом);
 *  • надбавки рангов (`bossRanks`): уровень, жизнь, размер этажа.
 *
 * ⚠⚠ НИ ОДНОГО ЧИСЛА СВОЕЙ ФОРМУЛОЙ. Карта этажей ниже считается ТЕМИ ЖЕ чистыми функциями, что игра и сервер:
 * место круга — `bandDepth`, метка — `isWaypoint`, уровень монстров — `floorMonsterLevel`, ступень снаряжения
 * монстра — `pickGearTier`, ступень находок игрока — `pickTierClamped`. Иначе страница стала бы вторым источником
 * правды и начала бы расходиться с игрой ровно в тот момент, когда по ней что-нибудь решают (память проекта:
 * «редактор и игра видят одно и то же»).
 *
 * ⚠ ПОЧЕМУ ОТДЕЛЬНАЯ СТРАНИЦА, А НЕ ПОЛЯ АВТО-ФОРМЫ. `portalsAt` и `bossLadder` — это ОДНА таблица, разрезанная на
 * два поля: место, попавшее и в порталы, и в лестницу, теряет БОССА (правило генератора: при совпадении уступает
 * босс). В авто-форме это два независимых списка чисел, и такую ошибку видно только в игре. Здесь место одно, у него
 * одно состояние — противоречие задать нечем.
 */

interface AccessShape {
  portalsAt: number[];
  lookahead: number;
  contentCycle: number;
  bossLadder: { at: number; rank: BossRank }[];
  bossRanks: Record<BossRank, { levelMult: number; hpMult: number; floorScale: number }>;
  stashEvery: number;
  stashJitter: number;
}

/** Состояние страницы (переживает перерисовку): сколько этажей показывать и для какого тира. */
let rows = 100;
let diffId: string | null = null;

const RANKS: readonly BossRank[] = ['mini', 'strong', 'act'];
const RANK_NAME: Record<BossRank, string> = { mini: 'мини-босс', strong: 'крепкий босс', act: 'актовый босс' };
const RANK_MARK: Record<BossRank, string> = { mini: '✦', strong: '✧✧', act: '★' };
/** Порядок, по которому клик крутит место круга. */
type PlaceKind = 'plain' | 'portal' | BossRank;
const CYCLE_ORDER: readonly PlaceKind[] = ['plain', 'portal', 'mini', 'strong', 'act'];

const CSS = {
  card: 'border:1px solid #2c2c3a;border-radius:8px;padding:12px 14px;background:#15151d;margin-bottom:12px',
  h: 'font-size:14px;font-weight:600;color:#e8e8f0;margin:0 0 2px',
  sub: 'font-size:11px;color:#8a8a9a;margin:0 0 10px;line-height:1.45',
  th: 'padding:3px 8px;text-align:right;color:#8a8a9a;font-weight:500;font-size:11px;white-space:nowrap',
  td: 'padding:2px 8px;text-align:right;font-variant-numeric:tabular-nums;font-size:12px;white-space:nowrap',
  warn: 'border:1px solid #6a4a20;border-radius:6px;padding:8px 10px;background:#241c10;color:#e0b070;font-size:12px;margin-bottom:8px',
  num: 'width:72px;background:#0e0e14;border:1px solid #2c2c3a;border-radius:4px;color:#e8e8f0;padding:3px 6px;font-size:12px;text-align:right',
};

const el = (tag: string, css = '', text = ''): HTMLElement => {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
};

function regFromData(data: Record<string, unknown>): ConfigRegistry {
  const reg = new ConfigRegistry();
  reg.loadAll(data, { cross: false });   // читатель рабочей копии (правило D4 — у записи)
  return reg;
}

/** Живая `dungeonAccess` рабочей копии: правим ЕЁ, а не копию — страница и игра смотрят в один объект. */
function accessOf(data: Record<string, unknown>): AccessShape {
  const bal = (data['balance'] ?? {}) as Record<string, unknown>;
  const acc = (bal['dungeonAccess'] ?? {}) as Partial<AccessShape>;
  if (!Array.isArray(acc.portalsAt)) acc.portalsAt = [3, 6, 9, 12, 15, 18, 20];
  if (!Array.isArray(acc.bossLadder)) acc.bossLadder = [];
  if (!acc.bossRanks) {
    acc.bossRanks = {
      mini: { levelMult: 1, hpMult: 1, floorScale: 1 },
      strong: { levelMult: 2, hpMult: 1.4, floorScale: 1.1 },
      act: { levelMult: 3, hpMult: 2.2, floorScale: 1.35 },
    };
  }
  if (typeof acc.contentCycle !== 'number') acc.contentCycle = 20;
  if (typeof acc.lookahead !== 'number') acc.lookahead = 2;
  bal['dungeonAccess'] = acc;
  data['balance'] = bal;
  return acc as AccessShape;
}

/** Что стоит на месте круга. ⚠ Правило генератора: место, попавшее и в порталы, и в лестницу, теряет БОССА. */
function kindOf(a: AccessShape, place: number): PlaceKind {
  if (a.portalsAt.includes(place)) return 'portal';
  return a.bossLadder.find((x) => x.at === place)?.rank ?? 'plain';
}
/** Поставить на место круга новое состояние — переписав оба поля таблицы так, чтобы противоречия не осталось. */
function setKind(a: AccessShape, place: number, kind: PlaceKind): void {
  a.portalsAt = a.portalsAt.filter((p) => p !== place).sort((x, y) => x - y);
  a.bossLadder = a.bossLadder.filter((x) => x.at !== place).sort((x, y) => x.at - y.at);
  if (kind === 'portal') a.portalsAt = [...a.portalsAt, place].sort((x, y) => x - y);
  else if (kind !== 'plain') a.bossLadder = [...a.bossLadder, { at: place, rank: kind }].sort((x, y) => x.at - y.at);
}

/**
 * Предупреждения по НАСТРОЙКЕ (не по коду): всё, что игра переживёт, но игрок почувствует как поломку.
 * Считаются теми же чистыми функциями, что в игре, — поэтому «предупреждения нет» значит «в игре так и будет».
 */
export function cycleWarnings(a: AccessShape): string[] {
  const out: string[] = [];
  const c = Math.max(1, Math.floor(a.contentCycle));
  if (!a.portalsAt.length) out.push('Порталов НЕТ НИ ОДНОГО: выйти в город с глубины будет нечем, а старт возможен только со входа.');
  for (const p of a.portalsAt) {
    if (p < 1 || p > c) out.push(`Место портала ${p} вне круга (1…${c}) — в игре его не будет.`);
  }
  for (const b of a.bossLadder) {
    if (b.at < 1 || b.at > c) out.push(`Место босса ${b.at} (${RANK_NAME[b.rank]}) вне круга (1…${c}) — босса не будет.`);
    if (a.portalsAt.includes(b.at)) out.push(`Место ${b.at}: портал и ${RANK_NAME[b.rank]} на одном месте — БОСС ПОТЕРЯН (при совпадении уступает он).`);
  }
  // Самый большой разрыв между метками — столько этажей игрок идёт без выхода в город.
  if (a.portalsAt.length) {
    const ps = [...a.portalsAt].sort((x, y) => x - y);
    let worst = ps[0]!, where = `вход → ${ps[0]}`;
    for (let i = 1; i < ps.length; i++) if (ps[i]! - ps[i - 1]! > worst) { worst = ps[i]! - ps[i - 1]!; where = `${ps[i - 1]} → ${ps[i]}`; }
    const seam = c - ps[ps.length - 1]! + ps[0]!;   // шов круга: от последнего места до первого следующего
    if (seam > worst) { worst = seam; where = `${ps[ps.length - 1]} → ${ps[0]} следующего круга`; }
    if (worst > 5) out.push(`Самый большой разрыв между метками — ${worst} этажей (${where}): столько игрок идёт без города и без права начать оттуда.`);
  }
  const act = a.bossLadder.find((x) => x.rank === 'act');
  if (!act) out.push('Актового босса в круге нет — круг нечем замкнуть.');
  else if (!a.portalsAt.includes(act.at + 1) && act.at !== c) {
    out.push(`За актовым боссом (место ${act.at}) сразу портала нет: игрок убьёт его и пойдёт дальше без города. Схема владельца — «на 19-м босс, 20-й портал и 21-й по новой всё».`);
  }
  for (const r of RANKS) {
    const v = a.bossRanks[r];
    if (v.hpMult < 1) out.push(`${RANK_NAME[r]}: множитель жизни ${v.hpMult} < 1 — босс слабее рядового монстра своей комнаты.`);
    if (v.floorScale > 2) out.push(`${RANK_NAME[r]}: размер этажа ×${v.floorScale} — сетка упрётся в потолок схемы (200 клеток) и этаж перестанет расти.`);
  }
  const prev = RANKS.map((r) => a.bossRanks[r].hpMult);
  if (!(prev[0]! <= prev[1]! && prev[1]! <= prev[2]!)) out.push('Жизнь рангов идёт не по возрастанию: мини окажется тяжелее актового.');
  return out;
}

/** Строка карты этажей — ровно те числа, которыми игра решает, что будет на этаже. */
interface MapRow {
  depth: number;
  place: number;
  kind: PlaceKind;
  level: number;
  /** Ступень снаряжения МОНСТРА (`monster-gear-tiers`) — меняется по его уровню. */
  mGear: string;
  /** Ступень находок ИГРОКА (`item-tiers`) по уровню вещи = уровню монстра. */
  pTier: string;
  /** Тир глубины (`depth-tiers`) — по нему берутся силовые типы монстров. */
  dTier: string;
  /**
   * Первый этаж новой ступени снаряжения РЯДОВЫХ монстров этажа.
   *
   * ⚠⚠ СЧИТАЕТСЯ ПО БАЗОВОМУ УРОВНЮ ЭТАЖА, А НЕ ПО УРОВНЮ БОССА. Надбавка ранга (`levelMult`) поднимает уровень
   * ОДНОГО босса, и на 19-м этаже он уже носит следующую ступень — а на 20-м рядовые снова носят прежнюю. Считай
   * подсветку по уровню строки — и «смена ступени» загоралась бы на 19 / 20 / 21 подряд, то есть ровно там, где
   * ничего со ступенью не произошло. Подсветка обещает «дальше ВСЕ монстры сильнее», и обещать это может только
   * базовый уровень этажа.
   */
  gearShift: boolean;
}

export function cycleMapRows(data: Record<string, unknown>, to: number, diff: string): MapRow[] {
  const reg = regFromData(data);
  const a = accessOf(data);
  const diffs = reg.get('difficulties');
  const d0 = diffs.find((x) => x.id === diff) ?? diffs[0]!;
  const mg = reg.get('monster-gear-tiers');
  const itemTiers = reg.get('item-tiers');
  const depthTiers = reg.get('depth-tiers');
  const c = Math.max(1, Math.floor(a.contentCycle));
  const out: MapRow[] = [];
  let prevGear = '';
  for (let depth = 1; depth <= to; depth++) {
    const place = bandDepth(depth, c);
    const kind = isWaypoint(depth, a.portalsAt, c)
      ? 'portal'
      : (a.bossLadder.find((x) => x.at === place)?.rank ?? 'plain');
    const level = floorMonsterLevel(d0, depth);
    // Уровень монстра босса поднимает ранг — ту же надбавку кладёт заселение (`spawnPacksEl`).
    const lvl = kind === 'portal' || kind === 'plain' ? level : level + Math.round(a.bossRanks[kind].levelMult);
    const mGear = pickGearTier(mg, {}, lvl)?.id ?? '—';
    const baseGear = pickGearTier(mg, {}, level)?.id ?? '—';   // ступень РЯДОВЫХ монстров этажа — см. `gearShift`
    const pTier = pickTierClamped(itemTiers, lvl, 't0', 't9')?.id ?? '—';
    // ⚠ Тир глубины живёт в окне `fromFloor..toFloor` и по МЕСТУ В КРУГЕ (Г8-1: сцена циклится, сила — нет).
    const dt = depthTiers.find((x) => place >= x.fromFloor && place <= x.toFloor);
    out.push({ depth, place, kind, level: lvl, mGear, pTier, dTier: dt?.id ?? '—', gearShift: baseGear !== prevGear && depth > 1 });
    prevGear = baseGear;
  }
  return out;
}

/**
 * Сохранение — тем же швом, что у вкладки «Ковка» (`toolIo`): страница-инструмент правит рабочую копию, а записью
 * (проверка zod → оверрайд в БД → файл `data/*.json`) распоряжается оболочка редактора.
 *
 * ⚠ КНОПКИ НУЖНЫ СВОИ. Кнопки в шапке редактора пишут ТЕКУЩУЮ СТРАНИЦУ-ФОРМУ (`current`), а вкладка-инструмент
 * страницей-формой не является: без своих кнопок правка круга осталась бы в рабочей копии и пропала бы на
 * перезагрузке — ровно то расхождение «в редакторе вижу, в игре нет», которого проект не допускает.
 */
export interface CycleIo {
  push(keys: readonly string[], onOk?: () => void): void;
  toFile(keys: readonly string[], onOk?: () => void): void;
}

export function renderCycleMapPage(host: HTMLElement, data: Record<string, unknown>, onChange?: () => void, cio?: CycleIo): void {
  host.innerHTML = '';
  const a = accessOf(data);
  const reg = regFromData(data);
  const diffs = reg.get('difficulties');
  if (!diffId || !diffs.some((d) => d.id === diffId)) diffId = diffs[0]?.id ?? 'normal';
  const redraw = (): void => { onChange?.(); renderCycleMapPage(host, data, onChange, cio); };

  const head = el('div', CSS.card);
  head.append(el('div', CSS.h, '🔄 Круг забега — порталы, боссы и ступени'),
    el('div', CSS.sub,
      'Спуск бесконечен, а КОНТЕНТ ходит по кругу: место в круге решает, что на этаже (портал, босс, обычный), '
      + 'а уровень монстров и всё, что от него едет, считает АБСОЛЮТНАЯ глубина. Жмите по месту, чтобы сменить его: '
      + 'обычный → портал → мини → крепкий → актовый. Числа ниже считают те же функции, что игра и сервер.'));
  if (cio) {
    const bar = el('div', 'display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap');
    const sbtn = (label: string, css: string, title: string, go: () => void): void => {
      const b = el('button', `padding:6px 12px;cursor:pointer;border-radius:6px;border:1px solid #2c2c3a;background:${css};color:#e8e8f0;font-size:12px;font-weight:600`, label);
      b.title = title;
      b.addEventListener('click', go);
      bar.append(b);
    };
    const said = el('span', 'font-size:11px;color:#8a8a9a');
    sbtn('✔ Применить на сервере', '#2a4a2a', 'Оверрайд в БД сервера: действует сразу и переживает рестарт, но в data/*.json не попадёт.',
      () => { said.textContent = 'отправлено…'; cio.push(['balance'], () => { said.textContent = 'принято сервером'; }); });
    sbtn('💾 Применить и записать в файл', '#26406a', 'То же плюс запись в data/balance.json — правка попадёт в git и на деплой.',
      () => { said.textContent = 'запись…'; cio.toFile(['balance'], () => { said.textContent = 'записано в файл'; }); });
    bar.append(said);
    head.append(bar);
  }
  host.append(head);

  // ── Предупреждения настройки ──
  const warns = cycleWarnings(a);
  if (warns.length) {
    const box = el('div', CSS.card);
    box.append(el('div', CSS.h, `⚠ Предупреждения настройки (${warns.length})`));
    for (const w of warns) box.append(el('div', CSS.warn, w));
    host.append(box);
  }

  // ── Длина круга и окно карты ──
  const nums = el('div', CSS.card);
  nums.append(el('div', CSS.h, 'Круг'));
  nums.append(el('div', CSS.sub, 'Длина круга — сколько мест в нём. Окно — сколько слоёв вперёд видит карта забега у игрока.'));
  const numRow = el('div', 'display:flex;gap:18px;align-items:center;flex-wrap:wrap');
  const numField = (label: string, get: () => number, set: (v: number) => void, min: number, max: number, step = 1): void => {
    const wrap = el('label', 'display:flex;gap:6px;align-items:center;font-size:12px;color:#b8b8c8');
    wrap.append(el('span', '', label));
    const inp = el('input', CSS.num) as HTMLInputElement;
    inp.type = 'number'; inp.min = String(min); inp.max = String(max); inp.step = String(step);
    inp.value = String(get());
    inp.addEventListener('change', () => {
      const v = Number(inp.value);
      if (Number.isFinite(v)) { set(Math.max(min, Math.min(max, v))); redraw(); }
    });
    wrap.append(inp);
    numRow.append(wrap);
  };
  numField('длина круга', () => a.contentCycle, (v) => { a.contentCycle = Math.round(v); }, 1, 200);
  numField('окно карты', () => a.lookahead, (v) => { a.lookahead = Math.round(v); }, 0, 10);
  numField('тайник каждые', () => a.stashEvery, (v) => { a.stashEvery = Math.round(v); }, 1, 50);
  numField('разброс тайника', () => a.stashJitter, (v) => { a.stashJitter = Math.round(v); }, 0, 20);
  nums.append(numRow);
  host.append(nums);

  // ── Места круга ──
  const places = el('div', CSS.card);
  places.append(el('div', CSS.h, `Места круга (1…${a.contentCycle})`));
  places.append(el('div', CSS.sub,
    `⌂ портал · ${RANK_MARK.mini} мини · ${RANK_MARK.strong} крепкий · ${RANK_MARK.act} актовый · · обычный. `
    + 'Клик крутит состояние места; одно место — одно состояние, поэтому «портал и босс сразу» задать нечем.'));
  const strip = el('div', 'display:flex;flex-wrap:wrap;gap:4px');
  for (let p = 1; p <= Math.max(1, Math.floor(a.contentCycle)); p++) {
    const kind = kindOf(a, p);
    const isP = kind === 'portal', isB = kind !== 'plain' && kind !== 'portal';
    const b = el('button',
      `width:40px;height:40px;border-radius:5px;cursor:pointer;font-size:10px;line-height:1.1;`
      + `display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;`
      + `border:1px solid ${isP ? '#6a5a28' : isB ? '#6a3030' : '#2c2c3a'};`
      + `background:${isP ? '#241f10' : isB ? '#2a1414' : '#1c1c26'};`
      + `color:${isP ? '#dca94b' : isB ? '#e0a090' : '#8a8a9a'}`);
    b.append(el('span', 'font-size:11px', isP ? '⌂' : isB ? RANK_MARK[kind as BossRank] : '·'));
    b.append(el('span', 'font-size:10px;font-weight:600', String(p)));
    b.title = `Место ${p}: ${isP ? 'портал' : isB ? RANK_NAME[kind as BossRank] : 'обычный этаж'} — клик сменит`;
    b.addEventListener('click', () => {
      const i = CYCLE_ORDER.indexOf(kind);
      setKind(a, p, CYCLE_ORDER[(i + 1) % CYCLE_ORDER.length]!);
      redraw();
    });
    strip.append(b);
  }
  places.append(strip);
  places.append(el('div', `${CSS.sub};margin:10px 0 0`,
    `Порталы: ${a.portalsAt.length ? a.portalsAt.join(', ') : '—'} · боссы: ${a.bossLadder.length ? a.bossLadder.map((x) => `${x.at} (${RANK_NAME[x.rank]})`).join(', ') : '—'}`
    + ` · первая метка от входа: ${nextWaypointAfter(0, a.portalsAt, a.contentCycle)}`));
  host.append(places);

  // ── Ранги боссов ──
  const ranksCard = el('div', CSS.card);
  ranksCard.append(el('div', CSS.h, 'Ранги боссов'));
  ranksCard.append(el('div', CSS.sub,
    'Уровень — надбавка к уровню этажа. Жизнь — множитель поверх жизни боссовой комнаты. Размер — во сколько раз '
    + 'крупнее сетка этажа (число комнат едет по площади, поэтому этаж крупнее, а не пустее).'));
  const rt = el('table', 'border-collapse:collapse');
  const rhead = el('tr');
  for (const h of ['ранг', 'уровень +', 'жизнь ×', 'размер ×']) rhead.append(el('th', CSS.th, h));
  rt.append(rhead);
  for (const r of RANKS) {
    const tr = el('tr');
    tr.append(el('td', `${CSS.td};text-align:left`, `${RANK_MARK[r]} ${RANK_NAME[r]}`));
    const cell = (get: () => number, set: (v: number) => void, min: number, max: number, step: number): void => {
      const td = el('td', CSS.td);
      const inp = el('input', CSS.num) as HTMLInputElement;
      inp.type = 'number'; inp.min = String(min); inp.max = String(max); inp.step = String(step);
      inp.value = String(get());
      inp.addEventListener('change', () => {
        const v = Number(inp.value);
        if (Number.isFinite(v)) { set(Math.max(min, Math.min(max, v))); redraw(); }
      });
      td.append(inp);
      tr.append(td);
    };
    cell(() => a.bossRanks[r].levelMult, (v) => { a.bossRanks[r].levelMult = v; }, 0, 50, 1);
    cell(() => a.bossRanks[r].hpMult, (v) => { a.bossRanks[r].hpMult = v; }, 1, 20, 0.1);
    cell(() => a.bossRanks[r].floorScale, (v) => { a.bossRanks[r].floorScale = v; }, 1, 3, 0.05);
    rt.append(tr);
  }
  ranksCard.append(rt);
  host.append(ranksCard);

  // ── Карта этажей ──
  const mapCard = el('div', CSS.card);
  mapCard.append(el('div', CSS.h, 'Карта этажей'));
  mapCard.append(el('div', CSS.sub,
    'Слева — круг и что на этаже, справа — числа, которые из глубины следуют: уровень монстров, их ступень '
    + 'снаряжения, ступень находок игрока и тир глубины. Строка ступени снаряжения подсвечена: это и есть «после '
    + 'босса монстры сильнее».'));
  const ctl = el('div', 'display:flex;gap:14px;align-items:center;margin-bottom:8px;flex-wrap:wrap');
  const rowsWrap = el('label', 'display:flex;gap:6px;align-items:center;font-size:12px;color:#b8b8c8');
  rowsWrap.append(el('span', '', 'этажей'));
  const rowsInp = el('input', CSS.num) as HTMLInputElement;
  rowsInp.type = 'number'; rowsInp.min = '1'; rowsInp.max = '400'; rowsInp.step = '10'; rowsInp.value = String(rows);
  rowsInp.addEventListener('change', () => { const v = Number(rowsInp.value); if (Number.isFinite(v)) { rows = Math.max(1, Math.min(400, Math.round(v))); redraw(); } });
  rowsWrap.append(rowsInp);
  ctl.append(rowsWrap);
  const dWrap = el('label', 'display:flex;gap:6px;align-items:center;font-size:12px;color:#b8b8c8');
  dWrap.append(el('span', '', 'тир'));
  const sel = el('select', `${CSS.num};width:auto;text-align:left`) as HTMLSelectElement;
  for (const d of diffs) { const o = document.createElement('option'); o.value = d.id; o.textContent = d.name; o.selected = d.id === diffId; sel.append(o); }
  sel.addEventListener('change', () => { diffId = sel.value; redraw(); });
  dWrap.append(sel);
  ctl.append(dWrap);
  mapCard.append(ctl);

  const table = el('table', 'border-collapse:collapse');
  const thead = el('tr');
  for (const h of ['этаж', 'место', 'что', 'ур. монстров', 'гир монстров', 'тир находок', 'тир глубины']) thead.append(el('th', CSS.th, h));
  table.append(thead);
  for (const r of cycleMapRows(data, rows, diffId!)) {
    const tr = el('tr', r.gearShift ? 'background:#1d1d12' : r.kind === 'portal' ? 'background:#14140f' : r.kind !== 'plain' ? 'background:#1a1212' : '');
    tr.append(el('td', CSS.td, String(r.depth)));
    tr.append(el('td', CSS.td, String(r.place)));
    tr.append(el('td', `${CSS.td};text-align:left`,
      r.kind === 'portal' ? '⌂ портал' : r.kind === 'plain' ? '·' : `${RANK_MARK[r.kind]} ${RANK_NAME[r.kind]}`));
    tr.append(el('td', CSS.td, String(r.level)));
    tr.append(el('td', CSS.td, r.gearShift ? `${r.mGear} ←` : r.mGear));
    tr.append(el('td', CSS.td, r.pTier));
    tr.append(el('td', CSS.td, r.dTier));
    table.append(tr);
  }
  const scroll = el('div', 'max-height:480px;overflow:auto');
  scroll.append(table);
  mapCard.append(scroll);
  host.append(mapCard);
}

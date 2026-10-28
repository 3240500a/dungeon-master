import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ConfigRegistry, newBotSave, floorMonsterLevel, isWaypoint, openWaypoints,
  nextWaypointAfter, waypointStart, waypointGap,
  type ClientFrame, type SaveState,
} from '@dm/shared';
import { difficultyPanel } from './difficultyPanel.js';
import { waypointHint } from '../run/runLabels.js';
import { COLORS } from '../../ui/kit.js';

/**
 * ⭐⭐ 14.10 (Г3, В6): АЛТАРЬ И HUD НЕ ВРУТ ПРО МЕТКИ.
 *
 * Алтарь предлагает СТАРТОВУЮ МЕТКУ, а разрешение считает сервер (`Room.startDepthOf` → `waypointStart` по сейвам всей
 * пати). Разойтись им нельзя: игрок, которому алтарь пообещал 18-й этаж, обязан попасть на 18-й, а не на 1-й. Поэтому
 * сторож мерит НАСТОЯЩУЮ панель (её DOM собран заглушкой — окружения DOM в прогоне нет) и сверяет её список с теми же
 * чистыми функциями, которыми судит сервер:
 *  • ⭐⭐ Г8-3: вместо чипов панель рисует КАРТУ КРУГА, и КЛИКАБЕЛЬНЫ на ней только ОТКРЫТЫЕ порталы — их список
 *    обязан совпасть с `openWaypoints(прогресс тира, тир, МЕСТА, ЦИКЛ)` бит в бит, по возрастанию. Клетки читаются
 *    по тултипу («Вход/Портал — этаж N, монстры ур. L. …»): он же несёт уровень монстров, которого в клетке 30×26
 *    не поместилось — и соврать им нельзя, это тот же `floorMonsterLevel`;
 *  • для КАЖДОЙ предложенной метки `waypointStart([прогресс], тир, шаг, 0, d) === d` (сервер начнёт ровно там);
 *  • для глубины, которой в списке НЕТ, сервер даёт другую — значит список не беднее и не богаче разрешённого;
 *  • «монстры ур. N» считает `floorMonsterLevel` (Г1: одна глубина), а не своя арифметика;
 *  • клик по чипу уходит в кадр `descend` полем `startDepth`.
 *
 * ⚠ В КООПЕ АЛТАРЬ ПОКАЗЫВАЕТ СПИСОК ПО СВОЕМУ РЕКОРДУ — рекордов напарников клиент не знает (`PeerInfo` их не
 * несёт), и это сказано в панели словами, а точную глубину называет окно голосования (`voteStart.startDepth`,
 * сторож — `server/net/room.g3start.test.ts`: «окно ≡ исход»). Код таким и остаётся — решение принято.
 *
 * ⭐⭐ 14.10 (правка 7): НО САМО РАСХОЖДЕНИЕ ТЕПЕРЬ ПОД СТОРОЖЕМ, А НЕ ПОД ПРОЗОЙ. До неё файл судил
 * ТОЛЬКО соло-правило, и обман в пати держала одна строка текста: замер — у пати с напарником-рекордом 20
 * алтарь героя с рекордом 60 показывает 21 метку, из которых 14 сервер не выполнит. Числа закреплены ниже:
 * вырасти расхождение тихо не сможет, а каждая «невыполнимая» метка обязана сводиться СВЕРХУ к разрешённой
 * глубине пати (ни глубже просимого, ни глубже слабейшего рекорда) — то есть обман всегда «в пользу
 * сервера»: игрок попадает МЕЛЬЧЕ обещанного, никогда глубже.
 *
 * HUD: «до метки N эт.» — один шов на оба клиента (`runLabels.waypointHint` → `waypointGap`), и его сверка с
 * каденцией тоже здесь: иначе 2D и 3D разъехались бы словами при одинаковых числах.
 */
/**
 * ⚠⚠ Г8-3: ЗАГЛУШКА ЗНАЕТ И SVG. Цепь меток рисуется `createElementNS` (у SVG своё пространство имён — через
 * `createElement` браузер не нарисует ничего), а тултип узла живёт не в атрибуте `title`, а в дочернем `<title>`.
 * Поэтому заглушка держит атрибуты (`setAttribute`) и отдаёт `title` узла так же, как его прочтёт глаз игрока.
 */
class El {
  children: El[] = []; style: Record<string, string> = {}; textContent = ''; disabled = false; type = '';
  value = ''; min = ''; max = ''; step = '';
  attrs: Record<string, string> = {};
  onclick: (() => void) | null = null;
  private html = '';
  private ownTitle = '';
  private on = new Map<string, (() => void)[]>();
  constructor(public tag: string) { }
  set innerHTML(v: string) { this.children = []; this.html = v; }
  get innerHTML(): string { return this.html; }
  /** `title` элемента: у HTML — атрибут, у SVG — дочерний `<title>` (его и читает подсказка). */
  set title(v: string) { this.ownTitle = v; }
  get title(): string {
    if (this.ownTitle) return this.ownTitle;
    const t = this.children.find((c) => c.tag === 'title');
    return t ? t.textContent : '';
  }
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  getAttribute(k: string): string | null { return k in this.attrs ? this.attrs[k]! : null; }
  addEventListener(t: string, f: () => void): void { this.on.set(t, [...(this.on.get(t) ?? []), f]); }
  append(...c: (El | string)[]): void { for (const x of c) { if (typeof x === 'string') continue; this.children.push(x); } }
  appendChild(c: El): El { this.append(c); return c; }
  click(): void { this.onclick?.(); for (const f of this.on.get('click') ?? []) f(); }
  /** Ввод с новым значением — так панель получает движение ползунка зума. */
  input(v: string): void { this.value = v; for (const f of this.on.get('input') ?? []) f(); }
  all(): El[] { return this.children.flatMap((c) => [c, ...c.all()]); }
}

const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const STEP = reg.get('balance').dungeonAccess.portalsAt;
/** ⭐⭐ Г8-2: длина цикла контента — метка стоит на МЕСТЕ В ПОЛОСЕ, и панель обязана считать тем же числом, что сервер. */
const CYCLE = reg.get('balance').dungeonAccess.contentCycle;
const TIER = reg.get('difficulties').find((d) => d.enabled !== false)!;

/** Настоящая панель алтаря, отрисованная в заглушку DOM: её тело и кадры, которые она шлёт. */
function altar(record: number): { body: El; sent: ClientFrame[] } {
  const save: SaveState = newBotSave(reg, 'warrior');
  save.difficultyProgress = record > 0 ? { [TIER.id]: record } : {};
  const sent: ClientFrame[] = [];
  const app = { config: reg, state: { save }, net: { send: (f: ClientFrame) => { sent.push(f); } } };
  const ui = { close: () => { } };
  const panel = difficultyPanel(app as never, ui as never);
  const body = new El('div');
  panel.render(body as never);
  return { body, sent };
}
/**
 * ⭐⭐ Г8-3: КЛИКАБЕЛЬНЫЕ КЛЕТКИ КАРТЫ КРУГА — только открытые порталы (кнопка). Закрытый портал и обычный этаж
 * рисуются `div`-ом намеренно: сервер старт всё равно зажмёт, и делать их нажимаемыми значило бы обещать то, чего
 * не будет. Клетка узнаётся по тултипу — он единственное место, где у неё есть и смысл, и глубина, и уровень.
 */
// ⚠ КЛИКАБЕЛЬНЫЙ СТАРТ — ОДНА ФОРМА ТУЛТИПА на обе формы показа: УЗЕЛ ЦЕПИ (`<g>` с `<title>`) и чип метки,
// не попавшей в цепь. Вместе они обязаны давать доступ ко ВСЕМ открытым меткам — иначе цепь отобрала бы у
// глубокого героя старты, которые плоский список давал (замер: рекорд 300 — открытых меток 106, в цепи 48).
const CELL_TITLE = /^(?:Вход|Портал) — этаж (\d+), монстры ур\. (\d+)/;
const CLICKABLE = new Set(['button', 'g']);
function markDepths(body: El): number[] {
  return markChips(body).map((e) => Number(CELL_TITLE.exec(e.title)![1])).sort((a, b) => a - b);
}
const markChips = (body: El): El[] =>
  body.all().filter((e) => CLICKABLE.has(e.tag) && CELL_TITLE.test(e.title) && e.title.includes('Можно начать отсюда.'));
/** Узел (или чип) открытой метки по глубине. */
const cellAt = (body: El, depth: number): El | undefined =>
  markChips(body).find((e) => Number(CELL_TITLE.exec(e.title)![1]) === depth);
const textOf = (body: El): string[] => body.all().map((e) => e.textContent).filter(Boolean);

describe('⭐⭐ Г3 (В6): список меток алтаря = то, что разрешит сервер', () => {
  const G = globalThis as unknown as { document?: unknown };
  beforeEach(() => {
    G.document = {
      createElement: (t: string) => new El(t),
      createElementNS: (_ns: string, t: string) => new El(t),   // ⭐ Г8-3: цепь рисуется SVG
      body: new El('body'),
    };
  });
  afterEach(() => { delete G.document; });

  it('⭐ ТАБЛИЦА РЕКОРДОВ: чипы метки совпадают с `openWaypoints`, и на каждую сервер начал бы ровно там', () => {
    const rows: string[] = [];
    for (const record of [0, 1, 2, 7, 20, 60, 300]) {
      const { body } = altar(record);
      const shown = markDepths(body);
      const pure = openWaypoints(record > 0 ? { [TIER.id]: record } : {}, TIER.id, STEP, CYCLE);
      expect(shown, `рекорд ${record}: список панели = чистая функция`).toEqual(pure);
      // Каждая предложенная метка — та, с которой сервер и начнёт (зажим `waypointStart` её не двигает).
      for (const d of shown) {
        expect(waypointStart([{ [TIER.id]: record }], TIER.id, STEP, CYCLE, d), `рекорд ${record}, метка ${d}`).toBe(d);
      }
      // А глубина за рекордом в списке не стоит — и сервер её зажал бы (то есть панель не обещает лишнего).
      // ⭐ Г8-3: «глубже рекорда» — это СЛЕДУЮЩАЯ МЕТКА за ним (места стоят неровно, прибавлять шаг нельзя).
      const beyond = nextWaypointAfter(Math.max(record, 0), STEP, CYCLE);
      expect(shown, `рекорд ${record}: глубины ${beyond} в списке нет`).not.toContain(beyond);
      expect(waypointStart([{ [TIER.id]: record }], TIER.id, STEP, CYCLE, beyond)).toBeLessThan(beyond);
      rows.push(`рекорд ${String(record).padStart(3)} → меток ${String(shown.length).padStart(3)}: ${shown.slice(0, 6).join(', ')}${shown.length > 6 ? `, … ${shown[shown.length - 1]}` : ''}`);
    }
    console.log(`\nМЕТКИ АЛТАРЯ (тир «${TIER.name}», шаг ${STEP}, замер 14.10)\n${rows.join('\n')}`);
  });

  it('⭐ «монстры ур. N» — `floorMonsterLevel`, и клик по чипу уходит в кадр `descend` полем `startDepth`', () => {
    const { body, sent } = altar(20);
    const chips = markChips(body);
    expect(chips.length, 'открытых порталов при рекорде 20: вход + 3/6/9/12/15/18/20')
      .toBe(openWaypoints({ [TIER.id]: 20 }, TIER.id, STEP, CYCLE).length);
    // ⭐ Г8-3: уровень монстров живёт в ТУЛТИПЕ клетки (в 30×26 он не читается) — и считан общей формулой, не «своей».
    for (const c of chips) {
      const [, ds, lvl] = CELL_TITLE.exec(c.title)!;
      const d = Number(ds);
      expect(Number(lvl), `клетка ${d}: уровень монстров — из floorMonsterLevel`).toBe(floorMonsterLevel(TIER, d));
      expect(c.title, `клетка ${d}: сказано, что отсюда можно начать`).toContain('Можно начать отсюда.');
    }
    // Умолчание — вход: панель без выбора обещает 1-й этаж и его же шлёт.
    expect(textOf(body).some((t) => t.startsWith(`Старт: этаж 1 · монстры ур. ${floorMonsterLevel(TIER, 1)}`)), 'строка старта — про вход').toBe(true);
    body.all().find((e) => e.tag === 'button' && e.textContent === 'Войти')!.click();
    expect(sent.at(-1)).toMatchObject({ t: 'descend', difficultyId: TIER.id, startDepth: 1 });

    // Выбрали глубокую метку — панель перерисовалась, и «Войти» шлёт именно её.
    const deep = cellAt(body, 18)!;
    expect(deep.title, 'тултип клетки называет этаж и уровень монстров')
      .toBe(`Портал — этаж 18, монстры ур. ${floorMonsterLevel(TIER, 18)}. Можно начать отсюда.`);
    deep.click();
    // ⭐ Г8-3: выбранный УЗЕЛ подсвечен золотом и несёт обводку выбора — это атрибуты SVG, а не cssText.
    const circles = cellAt(body, 18)!.children.filter((e) => e.tag === 'circle');
    expect(circles.length, 'у выбранного узла два круга: обводка и сам узел').toBe(2);
    expect(circles[1]!.getAttribute('stroke'), 'узел золотой').toBe(COLORS.gold);
    expect(circles[1]!.getAttribute('stroke-width'), 'и обведён толще').toBe('2');
    expect(textOf(body).some((t) => t.startsWith(`Старт: этаж 18 · монстры ур. ${floorMonsterLevel(TIER, 18)}`)), 'строка старта — про 18-й').toBe(true);
    body.all().find((e) => e.tag === 'button' && e.textContent === 'Войти')!.click();
    expect(sent.at(-1)).toMatchObject({ t: 'descend', difficultyId: TIER.id, startDepth: 18 });
  });

  /**
   * ⭐⭐ 14.10 (правка 7): КООП — СПИСОК АЛТАРЯ ПРОТИВ СЕРВЕРНОГО ПРАВИЛА С ДВУМЯ РЕКОРДАМИ.
   * Код панели не меняется (рекордов напарников клиент не знает, а точную глубину называет окно голосования),
   * но РАЗМЕР обмана и его НАПРАВЛЕНИЕ стережёт именно этот тест, а не строка прозы в панели.
   */
  it('⭐ КООП: из 19 меток алтаря сервер выполнит 7, а 12 сведёт ВНИЗ к разрешённой глубине пати', () => {
    const MINE = 60;      // рекорд героя, по которому алтарь строит список
    const PEER = 20;      // рекорд напарника, которого клиент НЕ ЗНАЕТ
    const party = [{ [TIER.id]: MINE }, { [TIER.id]: PEER }];
    const { body } = altar(MINE);
    const shown = markDepths(body);
    // Разрешение пати — самый слабый рекорд (тот же шов, что у `Room.startDepthOf`).
    const allow = waypointStart(party, TIER.id, STEP, CYCLE, Number.MAX_SAFE_INTEGER);
    const kept = shown.filter((d) => waypointStart(party, TIER.id, STEP, CYCLE, d) === d);
    const clamped = shown.filter((d) => waypointStart(party, TIER.id, STEP, CYCLE, d) !== d);
    console.log(`\nАЛТАРЬ В ПАТИ (свой рекорд ${MINE}, напарник ${PEER}, шаг ${STEP}, замер 14.10)`
      + `\nпоказано ${shown.length} меток; сервер выполнит ${kept.length} (${kept.join(', ')}), сведёт ${clamped.length} → ${allow}`);
    // ⚠ 15.10 (Г8-3): меток стало 22: последнее место круга — ТОЖЕ портал (схема владельца «19 босс, 20 портал,
    // 21 по новой»), поэтому к каждому кругу добавилась метка. Числа берутся у той же чистой функции, что и панель.
    expect(shown.length, 'открытых порталов на карте (по СВОЕМУ рекорду)').toBe(openWaypoints({ [TIER.id]: MINE }, TIER.id, STEP, CYCLE).length);
    // ⚠ Ф3 (16.10): вход из списка ушёл (он не метка, а кнопка портала), поэтому меток на одну меньше — 21.
    expect(shown.length, 'и это 21 метка').toBe(21);
    // ⚠ Разрешение пати — 20, а не 18: рекорд слабейшего 20, и 20-й этаж САМ метка (место 20 круга).
    expect(allow, 'разрешение пати — самый слабый рекорд, округлённый вниз к метке').toBe(20);
    expect(kept, 'выполнимые метки — ровно те, что не глубже разрешённой').toEqual([3, 6, 9, 12, 15, 18, 20]);
    expect(clamped.length, 'столько меток сервер НЕ выполнит').toBe(14);
    // ⚠ НАПРАВЛЕНИЕ ОБМАНА: каждая невыполнимая метка сводится РОВНО к разрешённой глубине
    // пати и никогда глубже выбранной: «попадёшь мельче, чем обещали» — именно то, что смягчается прозой
    // и окном голосования. Развернись знак — и пати уходила бы глубже рекорда слабейшего.
    for (const d of clamped) {
      const got = waypointStart(party, TIER.id, STEP, CYCLE, d);
      expect(got, `метка ${d}: сервер сводит ВНИЗ`).toBeLessThan(d);
      expect(got, `метка ${d}: и ровно к разрешённой пати`).toBe(allow);
    }
    // И сам кадр с глубокой меткой панель всё равно отправит (зажим — дело сервера, не клиента).
    // ⚠ 15.10 (Г8-2): берём САМУЮ ГЛУБОКУЮ ПОКАЗАННУЮ метку, а не «этаж = рекорд»: 60-й меткой больше не является
    // (его место в полосе — 20), и чипа с ним в панели нет. Правило теста от этого не зависит.
    const deepest = shown.at(-1)!;
    const { body: b2, sent } = altar(MINE);
    cellAt(b2, deepest)!.click();
    b2.all().find((e) => e.tag === 'button' && e.textContent === 'Войти')!.click();
    expect(sent.at(-1)).toMatchObject({ t: 'descend', startDepth: deepest });
    expect(waypointStart(party, TIER.id, STEP, CYCLE, deepest), 'а сервер начнёт с разрешённой').toBe(allow);
  });

  it('⚠ панель честно говорит, что список — ПО СВОЕМУ рекорду и в пати зажимается', () => {
    const { body } = altar(20);
    const prose = textOf(body).join(' | ');
    // ⭐ Г8-3: проза под картой объясняет ЗНАКИ клеток и свой рекорд (шага каденции больше нет — места неровные).
    expect(prose, 'названы знаки цепи').toContain('⌂ — портал (отсюда можно начать)');
    expect(prose, 'и что значат ветки').toContain('ветки — развилки этажей');
    expect(prose, 'и свой рекорд').toContain('Открыты метки не глубже ВАШЕГО рекорда (20)');
    expect(prose, 'и сказано про зажим пати').toContain('самому мелкому рекорду');
  });
});

describe('⭐ Г3 (В6): «до метки N эт.» в HUD — один шов и та же каденция', () => {
  it('подпись совпадает с каденцией на 20 этажах подряд; «метка здесь» ровно на метках', () => {
    const rows: string[] = [];
    for (let d = 1; d <= 20; d++) {
      const hint = waypointHint(d, STEP, CYCLE);
      rows.push(`${String(d).padStart(2)} → ${hint}`);
      if (isWaypoint(d, STEP, CYCLE)) expect(hint, `этаж ${d} — метка`).toBe('метка здесь');
      else expect(hint, `этаж ${d}`).toBe(`до метки ${waypointGap(d, STEP, CYCLE)} эт.`);
    }
    console.log(`\n«ДО МЕТКИ» В HUD (шаг ${STEP})\n${rows.join(' · ')}`);
  });

  it('⚠ ОДИН ШОВ: строку считают оба клиента одной функцией — своей арифметики ни у 2D, ни у 3D нет', () => {
    const src = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8');
    for (const [name, text] of [['UIScene (2D)', src('../../scenes/UIScene.ts')], ['hud3d (3D)', src('../../render3d/hud3d.ts')]] as const) {
      expect(text, `${name} зовёт общий шов`).toContain('waypointHint(');
      expect(text, `${name} не считает каденцию сам`).not.toContain('waypointStep ===');
      expect(text, `${name} не делит глубину руками`).not.toMatch(/depth\s*%\s*/);
    }
  });
});

import { bandDepth, isWaypoint, WAYPOINT_ENTRY_DEPTH, type BossRank, type WaypointPlaces } from '@dm/shared';

/**
 * ⭐⭐ Г8-3 (15.10, просьба владельца): КАРТА МЕТОК НА АЛТАРЕ — ОДНА ЦЕПЬ СВЕРХУ ВНИЗ. Слова владельца по макетам:
 * сперва «не пиши все этажи, а только карту вейпоинтов, сделай её со скролом, чтобы можно было приблизить, и сделай
 * сверху в них цепочку», затем «давай одну только сверху вниз, и пусть она чуть ветвится, не так ровно будет, а
 * кривая, короче посимпатичнее». Раскладка ЧИСТАЯ, без DOM: панель алтаря (`difficultyPanel.ts`) только рисует
 * посчитанное, эталон порта Unity зовёт ЭТУ ЖЕ функцию, а Unity рисует те же точки своим мешем.
 *
 * ⚠⚠ ПОЧЕМУ УЗЛЫ — ТОЛЬКО МЕТКИ, А НЕ ВСЕ ЭТАЖИ. Первый макет рисовал все 20 мест круга клетками. Из двадцати
 * клеток девятнадцать не несли ВЫБОРА — начать можно только с метки, — и строка рябила. Теперь узел = МЕСТО СТАРТА,
 * а что лежит между метками, говорит звено цепи: «2 эт.» либо знак босса с номером его этажа.
 *
 * ⚠⚠ ВЕТВЛЕНИЕ ЗВЕНА — ПРАВДА ПО СМЫСЛУ, НО НЕ ПО ЧИСЛУ. Слой метки и слой босса генератор форсит в ОДНУ полосу
 * (`generateRunPlan.layerWidth`), а промежуточные этажи бывают шире (`balance.dungeonAccess.width`), — поэтому цепь
 * сходится в узел на каждой метке и распускается между ними. Но СКОЛЬКО там будет полос, клиент знать не может:
 * ширина слоя — бросок потока забега, а забега ещё нет (сид родится на спуске). Поэтому число жил — устойчивое
 * украшение от глубины, ЗАЖАТОЕ потолком шаблона (`widthMax`): обещать больше развилок, чем шаблон разрешает,
 * нельзя, а обещать «здесь будет развилка» — честно. Шаблон шириной 1 даёт прямую цепь без ветвления.
 *
 * ⚠⚠ ГЕОМЕТРИЯ СЧИТАЕТСЯ БЕЗ sin/cos/pow — ТОЛЬКО +,−,×,÷ И ЦЕЛЫЕ. Это требование ПАРИТЕТА: у `+ − × ÷` над double
 * результат задан стандартом бит в бит и в JS, и в C#, а у тригонометрии — нет (точность платформозависима).
 * Возьми здесь `Math.sin` — и эталон Unity расходился бы на единицах пикселя там, где никто не виноват. Волну даёт
 * целая таблица `WAVE`, разброс — целый хеш глубины, кривую — кубическая Безье (тоже только +,−,×).
 */

/** Таблица «синуса» ×100, 16 отсчётов на период — замена `Math.sin` ради паритета (см. шапку). */
const WAVE = [0, 38, 71, 92, 100, 92, 71, 38, 0, -38, -71, -92, -100, -92, -71, -38] as const;

/** Геометрия цепи в пикселях модели (панель и Unity её масштабируют зумом, но числа одни). */
export const CHAIN_GEOM = {
  /** Ширина полотна: узел гуляет вокруг середины, справа место под подпись звена. */
  width: 300,
  /** Шаг между соседними метками по вертикали. */
  stepY: 66,
  /** Радиус узла-метки. */
  r: 14,
  /** Размах кривой (±, до 1.2× с разбросом) — «изгиб» из макета владельца. */
  amp: 32,
  /** Поля сверху и снизу. */
  pad: 34,
  /** Точек на жилу, включая концы: меньше — углы, больше — лишние числа в эталоне. */
  samples: 11,
  /** Сколько меток показывает цепь; те, что мельче, уходят в `hiddenMarks`. */
  maxMarks: 48,
} as const;

/** Точка полилинии жилы — целые пиксели модели. */
export interface ChainPoint { x: number; y: number }

/** Узел цепи — метка (место старта). */
export interface ChainNode {
  depth: number;
  /** Место глубины в круге (1…cycle) — по нему считаются знаки и разделители кругов. */
  place: number;
  x: number;
  y: number;
  /** Портал открыт: можно начать спуск отсюда (не глубже рекорда). */
  open: boolean;
  /** Этот узел выбран стартом. */
  pick: boolean;
  /** Вход (1-й этаж) — метка по отдельному правилу, подписан словом. */
  entry: boolean;
  level: number;
  label: string;
  title: string;
}

/** Знак босса на звене: что лежит между двумя метками. */
export interface ChainBoss {
  depth: number;
  rank: BossRank;
  mark: string;
  x: number;
  y: number;
  level: number;
  title: string;
}

/** Звено цепи между двумя соседними метками. */
export interface ChainLink {
  from: number;
  to: number;
  /** Жилы: у одной `main` (несущая, толще), остальные — развилки. Точки уже посчитаны. */
  strands: readonly { points: readonly ChainPoint[]; main: boolean }[];
  /** Босс на этом звене (жила тогда одна) либо null. */
  boss: ChainBoss | null;
  /** Подпись «N эт.» — сколько боевых этажей между метками (null, если там босс). */
  gap: { text: string; x: number; y: number } | null;
}

/** Разделитель круга — тонкая черта с подписью «круг N» перед первым местом круга. */
export interface ChainDivider { y: number; circle: number; label: string }

export interface AltarChainView {
  nodes: readonly ChainNode[];
  links: readonly ChainLink[];
  dividers: readonly ChainDivider[];
  width: number;
  height: number;
  r: number;
  cycle: number;
  record: number;
  /** Сколько порталов открыто (вход считается). */
  openCount: number;
  pick: number;
  /** Строка под цепью: что выбрано и чем это обернётся. */
  start: string;
  /** Метки мельче показанных — словами (null, если цепь влезла целиком). */
  hidden: string | null;
  /**
   * ⭐⭐ ОТКРЫТЫЕ МЕТКИ, НЕ ПОПАВШИЕ В ЦЕПЬ — чтобы они не стали НЕДОСТУПНЫ.
   *
   * ⚠ ЗАЧЕМ ПОЛЕ, А НЕ ТОЛЬКО СТРОКА `hidden`. Цепь показывает последние `maxMarks` меток, а рекорд сверху не
   * ограничен (10 000 — предел ДОВЕРИЯ, а не правило игры): при рекорде 300 открытых меток 106. Прежний плоский
   * список чипов давал доступ ко ВСЕМ, и карта не имеет права это отобрать.
   */
  hiddenMarks: readonly number[];
}

/** Подпись ранга босса — одна на весь клиент (панель, тултип, легенда). */
export const BOSS_RANK_NAME: Record<BossRank, string> = { mini: 'мини-босс', strong: 'крепкий босс', act: 'актовый босс' };
/** Знак ранга: три ступени читаются силуэтом, не чтением. */
export const BOSS_RANK_MARK: Record<BossRank, string> = { mini: '✦', strong: '✧✧', act: '★' };

/** Целый хеш глубины — замена случайности: одна глубина всегда даёт один и тот же изгиб, и так же в C#. */
export function chainHash(n: number): number {
  let h = Math.imul(n | 0, 2654435761) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519) >>> 0;
  h ^= h >>> 13;
  return h >>> 0;
}

/** Точка кубической Безье — только +,−,× (см. шапку про паритет). */
function bezier(p0: number, c0: number, c1: number, p1: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * c0 + 3 * u * t * t * c1 + t * t * t * p1;
}

/**
 * Цепь меток для одного тира сложности.
 *
 * `marks` — уже посчитанный тем же правилом, что у сервера, список открытых меток (`openWaypoints`): цепь НЕ решает
 * сама, что открыто, иначе появилось бы второе правило доступа. Она только раскладывает и подсвечивает.
 */
export function altarChainView(
  marks: readonly number[],
  record: number,
  places: WaypointPlaces,
  cycle: number,
  ladder: readonly { at: number; rank: BossRank }[],
  pick: number,
  levelOf: (depth: number) => number,
  widthMax = 3,
): AltarChainView {
  const G = CHAIN_GEOM;
  const c = Number.isFinite(cycle) ? Math.max(1, Math.floor(cycle)) : 1;
  const rec = Number.isFinite(record) ? Math.max(0, Math.floor(record)) : 0;
  const open = new Set(marks);
  const rankAt = new Map<number, BossRank>();
  // ⚠ Лестница может прийти не массивом (синтетика эталона, собранный руками оверрайд из БД): падать нельзя —
  // карта унесла бы с собой весь алтарь, то есть единственный способ начать забег.
  for (const x of Array.isArray(ladder) ? ladder : []) if (Number.isFinite(x?.at)) rankAt.set(Math.floor(x.at), x.rank);
  const lanesCap = Math.max(1, Math.min(3, Math.floor(Number.isFinite(widthMax) ? widthMax : 3)));

  // ⭐ ЦЕПЬ — ПОСЛЕДНИЕ `maxMarks` МЕТОК: глубокие игрок заработал ногами, мелкие уходят в ряд рядом с цепью.
  const all = [...marks].sort((a, b) => a - b);
  const shown = all.length > G.maxMarks ? all.slice(all.length - G.maxMarks) : all;
  const hiddenMarks = all.length > G.maxMarks ? all.slice(0, all.length - G.maxMarks) : [];

  const cx = G.width / 2;
  const nodes: ChainNode[] = [];
  for (let i = 0; i < shown.length; i++) {
    const depth = shown[i]!;
    const place = bandDepth(depth, c);
    // Волна по порядку узла + разброс по глубине: кривая «гуляет», но у одной глубины изгиб всегда один и тот же.
    const wave = WAVE[i % WAVE.length]!;
    const jitter = (chainHash(depth) % 41) - 20;              // −20…+20
    const x = Math.round(cx + (wave * G.amp * 3) / 400 + (jitter * G.amp) / 100);
    const y = G.pad + i * G.stepY;
    const level = levelOf(depth);
    const entry = depth === WAYPOINT_ENTRY_DEPTH;
    const isOpen = open.has(depth);
    nodes.push({
      depth, place, x, y, open: isOpen, pick: depth === pick, entry, level,
      label: String(depth),
      title: `${entry ? 'Вход' : 'Портал'} — этаж ${depth}, монстры ур. ${level}. `
        + (isOpen ? 'Можно начать отсюда.' : `Закрыт: ваш рекорд ${rec}.`),
    });
  }

  const links: ChainLink[] = [];
  const dividers: ChainDivider[] = [];
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1]!, b = nodes[i]!;
    // Босс между метками: место в круге ищется в лестнице. ⚠ При совпадении с порталом уступает БОСС — то же
    // правило, что у генератора (`bossRankAt`), поэтому на звене он либо есть, либо нет.
    let boss: ChainBoss | null = null;
    for (let d = a.depth + 1; d < b.depth; d++) {
      const rank = isWaypoint(d, places, c) ? undefined : rankAt.get(bandDepth(d, c));
      if (rank) {
        const lv = levelOf(d);
        boss = {
          depth: d, rank, mark: BOSS_RANK_MARK[rank], level: lv,
          x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2),
          title: `${BOSS_RANK_NAME[rank]} — этаж ${d}, монстры ур. ${lv}`,
        };
        break;
      }
    }
    const between = b.depth - a.depth - 1;
    // Жил столько, сколько разрешает шаблон; на звене с боссом — одна (его слой форсит ширину 1).
    const lanes = boss || between <= 0 ? 1 : 1 + (chainHash(b.depth * 3) % lanesCap);
    const strands: { points: ChainPoint[]; main: boolean }[] = [];
    const mainIdx = (lanes - 1) >> 1;
    for (let l = 0; l < lanes; l++) {
      const spread = 20 + (chainHash(b.depth + l) % 14);               // 20…33 — развод жил
      const off = Math.round((l - (lanes - 1) / 2) * spread);
      const x1 = a.x, y1 = a.y + G.r, x2 = b.x, y2 = b.y - G.r;
      const c1x = x1 + off, c1y = y1 + Math.round(G.stepY * 0.42);
      const c2x = x2 + off, c2y = y2 - Math.round(G.stepY * 0.42);
      const points: ChainPoint[] = [];
      for (let s = 0; s < G.samples; s++) {
        const t = s / (G.samples - 1);
        points.push({ x: Math.round(bezier(x1, c1x, c2x, x2, t)), y: Math.round(bezier(y1, c1y, c2y, y2, t)) });
      }
      strands.push({ points, main: l === mainIdx });
    }
    links.push({
      from: a.depth, to: b.depth, strands, boss,
      gap: boss || between <= 0 ? null
        : { text: `${between} эт.`, x: Math.round((a.x + b.x) / 2) + 20, y: Math.round((a.y + b.y) / 2) },
    });
    // Разделитель ставится на ЗВЕНО, ПЕРЕСЕКАЮЩЕЕ ГРАНИЦУ КРУГА, а не на узел первого места.
    // ⚠ УЗЛА С МЕСТОМ 1 НЕ БЫВАЕТ ВОВСЕ: узлы — только метки, а первое место круга порталом не является
    // (схема владельца: порталы 3/6/9/12/15/18/20). Проверяй здесь «место === 1» — и разделителей не было бы ни
    // одного (замер: при рекорде 100 — ноль черт на пять кругов).
    const cirA = Math.ceil(a.depth / c), cirB = Math.ceil(b.depth / c);
    if (cirB > cirA) {
      dividers.push({ y: Math.round((a.y + b.y) / 2), circle: cirB, label: `круг ${cirB}` });
    }
  }

  const height = nodes.length ? nodes[nodes.length - 1]!.y + G.pad : G.pad * 2;
  return {
    nodes, links, dividers,
    width: G.width, height, r: G.r,
    cycle: c, record: rec, openCount: marks.length, pick,
    start: `Старт: этаж ${pick} · монстры ур. ${levelOf(pick)}`
      + (marks.length > 1 ? ` · открыто меток: ${marks.length}` : ' · других меток пока нет'),
    hidden: hiddenMarks.length
      ? `Выше ещё меток: ${hiddenMarks.length} (этажи 1–${hiddenMarks[hiddenMarks.length - 1]})`
      : null,
    hiddenMarks,
  };
}

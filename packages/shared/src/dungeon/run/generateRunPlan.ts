import type { ConfigRegistry } from '../../config/registry.js';
import type { RunModifier, RunNodeType, Biome, Floor, FloorRole } from '../../config/schemas.js';
import { createRng, type Rng } from '../../formulas/rng.js';
import { resolveFloorSpec, pickFloorForRole, pickFloor, availableRoles, availableRolesAt } from '../floorSpec.js';
import { bandDepth, isWaypoint as isWaypointAt, bossRankAt as bossRankOf } from '../../formulas/power.js';
import { RUN_MOD_LIVE_STATS, pickRunModifiers, runModifierLive } from './runModifiers.js';
import { liveModStats, liveNodeModStats } from './runModEffects.js';
import type { BossRank, RunConfig, RunNode, RunPlan, RunWindow } from './types.js';

/** Взвешенный выбор из [{item, weight}] по rng. Возвращает null для пустого/нулевого. */
function weightedPick<T>(entries: { item: T; weight: number }[], rng: Rng): T | null {
  const total = entries.reduce((s, e) => s + Math.max(0, e.weight), 0);
  if (total <= 0) return null;
  let r = rng.next() * total;
  for (const e of entries) { r -= Math.max(0, e.weight); if (r <= 0) return e.item; }
  return entries[entries.length - 1]!.item;
}

/** Смешение сида забега и координат узла → детерминированный сид этажа. */
function nodeSeed(runSeed: number, depth: number, lane: number): number {
  return ((runSeed ^ ((depth + 1) * 0x9e3779b1) ^ ((lane + 1) * 0x85ebca77)) >>> 0) || 1;
}

/**
 * ⭐⭐ 13.10 (Г2, Р1): СИД СЛОЯ — ОТ ГЛУБИНЫ, А НЕ ОТ ПОРЯДКА. У каждого слоя свой поток случайностей, и слой 500
 * считается ровно так же и ровно столько же, сколько слой 1.
 *
 * ⚠ ПОЧЕМУ ЭТО КОРЕНЬ БЕСКОНЕЧНОГО СПУСКА. Прежде ширина слоя, роли и ветвление тянулись из ОДНОГО
 * последовательного потока `createRng(config.seed)`: чтобы узнать слой 50, нужно было проиграть слои 1..49 — и именно
 * это, а не поле `length` шаблона, делало бесконечный спуск невозможным (а цена графа — линейной по глубине).
 * Финализатор (xxhash-подобный, два умножения со сдвигами) обязателен: mulberry32 от близких сидов первым броском
 * почти не расходится, и соседние слои шли бы одной ширины.
 */
function layerSeed(runSeed: number, depth: number): number {
  let h = (runSeed ^ Math.imul(depth + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) || 1;
}

/** Роли, которые могут занять «боевой» слой (не boss/rest). */
const COMBAT_ROLES: FloorRole[] = ['combat', 'elite', 'treasure'];

/**
 * Генератор структуры забега v2 (макро): RunConfig → ветвящийся слоистый DAG. Форму задаёт шаблон
 * (ветвление/ширина/каденция босса), а СОДЕРЖИМОЕ каждого слота — подобранный конфиг этажа-члена шаблона
 * (по роли+биому+глубине). Слот роли генерится ТОЛЬКО если есть этаж этой роли: нет boss-этажа → босс-слота нет;
 * нет rest-этажа → нет привалов. Детерминировано от сида.
 * `live` — статы эффектов модификаторов, которые игра применяет (`RUN_MOD_LIVE_STATS`; другой набор — только тестам).
 *
 * ⭐⭐ 13.10 (Г2): СПУСК БЕСКОНЕЧЕН, ПОЭТОМУ ВОЗВРАЩАЕТСЯ ОКНО СЛОЁВ (Р2), а не весь граф: `window` — глубины
 * включительно, умолчание `{ from: 1, to: 1 + balance.dungeonAccess.lookahead }`. `startId` = `n{from}_0` (вход в
 * спуск = нулевая полоса того слоя, с которого начали). Финала (`finale`) и длины (`length`) больше нет вовсе (Р3):
 * забег кончается смертью или уходом в город через портал привала.
 *
 * ⚠ РЁБРА ПОСЛЕДНЕГО СЛОЯ ОКНА СМОТРЯТ ЗА ЕГО КРАЙ — это НЕ недосмотр, а условие Р1. Число выходов этажа =
 * число рёбер узла (`exitCount`), и обрежь мы рёбра по краю окна — у одного и того же узла этаж собирался бы
 * по-разному в зависимости от окна (а на краю — тупиком без выходов, то есть спуск упирался бы в стену каждые
 * `lookahead` слоёв). Поэтому рёбра — всегда в слой d+1 (его ширина считается своим сидом, без постройки узлов), а
 * читатель, уходя за край, достраивает слой сам (`Room.enterNode`, сим `runSessionSim`).
 */
export function generateRunPlan(
  reg: ConfigRegistry,
  config: RunConfig,
  /** Живые статы (умолчание — из конфига, таблица `run-mod-stats`); другой набор — только тестам. */
  live?: ReadonlySet<string>,
  window?: RunWindow,
  /**
   * ⭐⭐ Ф5-0 (16.10): живые статы УЗЛОВЫХ модификаторов — отдельный набор (по умолчанию пустой).
   * Узловой вешается генератором сам, без выбора игрока и без платы, и среди них есть чистое благо
   * (`boon-cache`): открой их общим списком — и правило «благо только в паре с опасностью» нарушится молча.
   * ⚠ Параметр ПОСЛЕДНИЙ намеренно: окно слоёв (`window`) у всех вызовов на своём месте, и порядок не поехал.
   */
  nodeLive?: ReadonlySet<string>,
): RunPlan {
  const biomes = reg.get('biomes') as Biome[];
  const floors = reg.get('floors') as Floor[];
  const mods = reg.get('run-modifiers') as RunModifier[];
  const access = reg.get('balance').dungeonAccess;
  // ⭐⭐ 16.10: ЧТО ИГРА ПРИМЕНЯЕТ — РЕШАЕТ КОНФИГ (`run-mod-stats`), а не константа кода.
  const liveSet = live ?? liveModStats(reg);
  const nodeLiveSet = nodeLive ?? liveNodeModStats(reg);

  const biome = biomes.find((b) => b.id === config.biomeId) ?? biomes[0]!;
  const seed = (config.seed >>> 0) || 1;

  // ⭐⭐ Ф1 (16.10): ФОРМА ЗАБЕГА — ИЗ БАЛАНСА. Шаблон растворён: ширина слоя, ветвистость и веса типов рядовых
  // узлов живут в `balance.dungeonAccess` одной настройкой на игру. `config` по-прежнему может их переопределить —
  // этим пользуются сим и сторожа, игрок в алтаре форму не трогает.
  const widthMax = config.widthMax ?? access.width.max;
  const widthMin = access.width.min;
  const branching = config.branching ?? access.branching;
  // ⭐⭐ Г8-2 (15.10): БОССЫ — ПО ЛЕСТНИЦЕ КРУГА, а не по каденции.
  // ⭐⭐ Г8-4: и ШАБЛОН БОЛЬШЕ НИЧЕГО О НИХ НЕ РЕШАЕТ — ни тумблером (снят), ни членством этажей (снято).
  // Ему остался вид РЯДОВОГО узла: ширина слоя, ветвистость, веса типов и список модификаторов алтаря.
  const portals = access.portalsAt;   // ⭐ Г8-3: места порталов в полосе — список, а не шаг
  const typeWeights = config.nodeTypeWeights ?? (access.nodeTypeWeights as Record<string, number>);

  // Окно слоёв (Р2): умолчание — текущий слой плюс `lookahead` вперёд (столько развилок видит карта забега).
  const from = Math.max(1, Math.floor(window?.from ?? 1));
  const to = Math.max(from, Math.floor(window?.to ?? from + Math.max(1, access.lookahead)));

  const nodeMods = mods.filter((m) => m.scope === 'node' && m.enabled !== false);
  // ⭐ R8-12: то же правило, что у сервера на старте забега (`pickRunModifiers`): действующие, без дублей, благо — в паре с
  // опасностью. И для забега, продолженного из сейва: записанное до правки (32 копии, одни блага) в план не доедет.
  const runModIds = pickRunModifiers(mods, access.allowedModifiers, config.modifiers, liveSet);

  /**
   * Боевые роли, из которых выбирается РЯДОВОЙ узел.
   *
   * ⭐⭐ Г8-5 (15.10): СЧИТАЮТСЯ ПО МЕСТУ КРУГА, А НЕ ОДИН РАЗ НА ЗАБЕГ. Окно глубины этажа (`minDepth..maxDepth`)
   * — это дизайнерское «где такой контент уместен», и пока роли брались без оглядки на место, окна были
   * декоративными: элита выпадала на 1-м месте круга, где её окно начинается с 3-го, и брала этаж фолбэком
   * «ближайшее окно». Теперь роль обязана иметь этаж ИМЕННО НА ЭТОМ МЕСТЕ.
   *
   * ⚠ Поток случайности не сдвигается: `weightedPick` берёт ОДИН бросок независимо от длины списка — ширина слоя и
   * адресация узлов те же, меняется только выбранный тип рядового узла там, где окно его не пускало.
   *
   * ⚠ Если на месте нет ни одной боевой роли (биом с одним этажом-привалом), падать нельзя: берём роли биома без
   * оглядки на окно, а в крайнем случае — `combat`. Узел обязан получить тип и этаж при любых данных.
   */
  const availAll = availableRoles(biome.id, floors);
  const rolesAtPlace = (place: number): FloorRole[] => {
    const here = availableRolesAt(biome.id, floors, place);
    const pick = (set: Set<FloorRole>): FloorRole[] => COMBAT_ROLES.filter((r) => set.has(r));
    const inWindow = pick(here);
    if (inWindow.length) return inWindow;
    const anyRole = pick(availAll);
    if (anyRole.length) return anyRole;
    const rest = [...availAll].filter((r) => r !== 'rest' && r !== 'boss');
    return rest.length ? rest : (['combat'] as FloorRole[]);
  };

  /**
   * ⭐ Г2 (Р4): КАДЕНЦИЯ — ЧИСТАЯ ФУНКЦИЯ ГЛУБИНЫ (иначе Р1 рушится: метку нельзя было бы узнать, не проиграв
   * предыдущие слои). Джиттера нет намеренно — привал обязан быть предсказуем игроку, как портал в D2.
   *
   * ⚠⚠ Г8-2 (15.10): ПРАВИЛО МЕТКИ ЗДЕСЬ НЕ ПОВТОРЯЕТСЯ, А ЗОВЁТСЯ ОБЩИМ ШВОМ (`formulas/power.isWaypoint`) — с
   * циклом контента: метка стоит на МЕСТЕ КРУГА из списка `portalsAt`. Прежде здесь лежала своя копия
   * `d % шаг === 0`, и она разошлась бы с алтарём, HUD и анти-читом сервера в первый же круг.
   *
   * ⚠⚠ Г8-4 (15.10, решение владельца): ТАБЛИЦА — ЕДИНСТВЕННЫЙ ИСТОЧНИК. «Надо сделать так, чтобы боссы появлялись
   * на этажах боссов, а вейпоинты на этажах вейпоинтов согласно нашей новой таблице.» Прежде и метку, и босса мог
   * ОТМЕНИТЬ шаблон: метка требовала этажа роли `rest`, БОССА — этажа роли `boss` ПЛЮС тумблера `bosses`, причём
   * «этаж есть» считалось с учётом членства этажа в шаблоне. Замер, который это поймал: `crypt-boss` состоял только
   * в `dungeon-standard` и `deep-expedition`, поэтому в «Короткой вылазке» у крипты боссового этажа не было вовсе —
   * и боссы лестницы пропадали МОЛЧА. Теперь место круга решает всё; чего не хватает в контенте биома, добирает
   * фолбэк выбора этажа, а про нехватку кричит сторож данных (`waypointWarnings`).
   */
  const isWaypoint = (d: number): boolean => isWaypointAt(d, portals, access.contentCycle);
  /**
   * ⭐⭐ Г8-2: ранг босса на этой глубине или `undefined`. Чистая функция глубины, как и метка: место в полосе
   * (`bandDepth`) ищется в лестнице `balance.dungeonAccess.bossLadder`.
   *
   * ⚠ НА ПРИВАЛЕ БОССА НЕТ — правило не изменилось: при совпадении уступает БОСС, а не метка. Со штатными числами
   * совпадения не бывает (места 5/14/20 не кратны шагу 3), но настройку никто не обязан держать в уме: метка —
   * чистая функция глубины, на ней стоят старт спуска с метки (Г3) и счёт «до метки N этажей», который игрок ведёт
   * сам. Потерять метку из-за босса нельзя, потерять одного босса из трёх — можно (это потеря контента, а не
   * обещания). Сторож на кривую настройку — `dungeon/bossLadder.test.ts`.
   */
  // ⚠ Ф5-2: само правило живёт в `formulas/power.ts` — его же спрашивает гарантия печати с босса.
  const bossRankAt = (d: number): BossRank | undefined =>
    bossRankOf(d, portals, access.contentCycle, access.bossLadder) as BossRank | undefined;
  const isBossAt = (d: number): boolean => bossRankAt(d) !== undefined;
  /**
   * Ширина слоя: привал и босс форсируют 1 (тоже чистая функция глубины), иначе — ПЕРВЫЙ бросок потока этого слоя.
   * ⚠ Бросок обязан быть первым: ширину слоя d+1 читают рёбра слоя d, не строя его узлов, — и оба пути должны взять
   * из потока ровно одно и то же число.
   */
  const layerWidth = (d: number, rng: Rng): number =>
    isWaypoint(d) || isBossAt(d) ? 1 : Math.max(1, Math.min(widthMax, rng.int(widthMin, widthMax)));
  const widthAt = (d: number): number => layerWidth(d, createRng(layerSeed(seed, d)));

  /**
   * ⭐⭐ Г8: СЦЕНА ЭТАЖА — ПО МЕСТУ В ПОЛОСЕ, а не по абсолютной глубине (`contentCycle`, умолчание 20). Циклится
   * ровно выбор контента: какой этаж биома взять (его окна `minDepth`/`maxDepth`) и какой вариант тайлсета. Уровень
   * монстров и всё, что от него едет (опыт, золото, ступень находок), по-прежнему считает АБСОЛЮТНАЯ глубина — иначе
   * за 20-м этажом игра стала бы вечным первым кругом.
   */
  const scene = (d: number): number => bandDepth(d, access.contentCycle);

  const makeNode = (rng: Rng, nodeType: RunNodeType, floorRole: FloorRole, depth: number, lane: number, bossRank?: BossRank): RunNode => {
    const nodeModIds: string[] = [];
    const canMod = nodeType === 'combat' || nodeType === 'elite' || nodeType === 'boss';
    if (canMod && nodeMods.length) {
      const chance = nodeType === 'boss' ? 0.9 : nodeType === 'elite' ? 0.6 : 0.3;
      if (rng.chance(chance)) {
        const picked = weightedPick(nodeMods.map((m) => ({ item: m, weight: m.weight })), rng);
        // ⚠ R10-15: только ДЕЙСТВУЮЩИЙ (`runModifierLive`, правило алтаря R8-12): эффект, который не применяет никто, рисовал
        // ★ на карте забега — обещанный «Тайник» оказывался обычной комнатой. ⚠ Бросок и выбор — как прежде, отбрасывается
        // только результат: отфильтруй `nodeMods` заранее — пустой пул пропустил бы броски, и граф каждого забега из сейва
        // (регенерится от сида) перестроился бы. Подключённый стат вернёт свои модификаторы сам.
        // ⭐⭐ Ф5-0 (16.10): УЗЛОВЫЕ — ПО СВОЕМУ НАБОРУ (пока пустому): они вешаются без выбора и без платы, и
        // среди них есть чистое благо (`boon-cache`), которое иначе нарушило бы правило «благо не даром».
        if (picked && runModifierLive(picked, nodeLiveSet)) nodeModIds.push(picked.id);   // узловые — своим набором из конфига
      }
    }
    const seedOfNode = nodeSeed(config.seed, depth, lane);
    // ⭐⭐ Г8: подбор этажа и вариант тайлсета — по МЕСТУ В ПОЛОСЕ (цикл 20), сам узел помнит настоящую глубину.
    const sd = scene(depth);
    // ⭐⭐ Ф2 (16.10): МЕСТО КРУГА решает смесь обычных этажей (`placeWeight`), а ранг — какой боссовый взять.
    const floor = pickFloorForRole(floorRole, biome.id, floors, sd, seedOfNode, { place: sd, cycle: access.contentCycle, ...(bossRank ? { bossRank } : {}) })
      ?? pickFloor(biome.id, floors, sd, seedOfNode);
    // ⭐⭐ Г8-3: боссовый этаж БОЛЬШЕ ПО РАЗМЕРУ — ранг даёт `floorScale`, растяжку делает общий шов `resolveFloorSpec`.
    const fs = bossRank ? (access.bossRanks[bossRank]?.floorScale ?? 1) : 1;
    const floorSpec = resolveFloorSpec(biome, floor, sd, seedOfNode, [...runModIds, ...nodeModIds], fs > 1 ? { floorScale: fs } : {});
    // ⭐⭐ Г8-2: РАНГ — ТОЛЬКО У БОССОВОГО УЗЛА, и поле добавляется лишь тогда: иначе кадр `runPlan` у всех узлов
    // потолстел бы на `undefined`, а сверка эталона Unity ловила бы лишний ключ.
    return { id: `n${depth}_${lane}`, type: nodeType, depth, lane, biomeId: biome.id, floorSpec, modifiers: nodeModIds, edges: [],
      ...(bossRank ? { bossRank } : {}) };
  };

  /** Положение полосы внутри слоя, 0..1 — по нему рёбра ищут ближайшую полосу следующего слоя. */
  const norm = (lane: number, width: number): number => (width <= 1 ? 0.5 : lane / (width - 1));

  const nodes: RunNode[] = [];
  for (let d = from; d <= to; d++) {
    // Один поток на слой: ширина → (по полосам: роль, бросок узлового модификатора, выбор) → рёбра. Порядок броска
    // в точности прежний — граф забега, уже лежащего в сейве, от Г2 не перестраивается сверх самой адресации.
    const rng = createRng(layerSeed(seed, d));
    const wp = isWaypoint(d), rank = bossRankAt(d), bs = rank !== undefined;
    const width = layerWidth(d, rng);
    const layer: RunNode[] = [];
    for (let lane = 0; lane < width; lane++) {
      // ⭐ Г8-5: роли рядового узла — по МЕСТУ КРУГА (сцена циклится, Г8-1), а не по абсолютной глубине.
      const here = rolesAtPlace(scene(d));
      const role: FloorRole = wp ? 'rest' : bs ? 'boss'
        : (weightedPick(here.map((t) => ({ item: t, weight: typeWeights[t] ?? 0 })), rng) ?? here[0]!);
      const node = makeNode(rng, role as RunNodeType, role, d, lane, rank);
      layer.push(node);
      nodes.push(node);
    }

    // Рёбра — в слой d+1 (его ширина известна своим сидом; узлы его не строятся) + гарантия входящего ребра.
    const nextWidth = widthAt(d + 1);
    const lanes = Array.from({ length: nextWidth }, (_, i) => i);
    const idOf = (lane: number): string => `n${d + 1}_${lane}`;
    const addEdge = (a: RunNode, lane: number): void => { const to2 = idOf(lane); if (!a.edges.some((e) => e.to === to2)) a.edges.push({ to: to2 }); };
    for (const a of layer) {
      const ax = norm(a.lane, width);
      const sorted = [...lanes].sort((p, q) => Math.abs(norm(p, nextWidth) - ax) - Math.abs(norm(q, nextWidth) - ax));
      addEdge(a, sorted[0]!);
      if (sorted[1] !== undefined && rng.chance(branching)) addEdge(a, sorted[1]);
    }
    for (const lane of lanes) {
      if (layer.some((a) => a.edges.some((e) => e.to === idOf(lane)))) continue;
      const bx = norm(lane, nextWidth);
      const src = [...layer].sort((p, q) => Math.abs(norm(p.lane, width) - bx) - Math.abs(norm(q.lane, width) - bx))[0]!;
      addEdge(src, lane);
    }
  }

  // Число выходов этажа = число исходящих рёбер узла (развилка → несколько выходов). Чистая функция глубины и полосы:
  // от окна не зависит, иначе один и тот же узел собирал бы разный этаж.
  for (const n of nodes) n.floorSpec.exitCount = n.edges.length;

  return {
    biomeId: biome.id,
    tier: config.tier,
    seed: config.seed,
    startId: `n${from}_0`,
    nodes,
    runModifiers: runModIds,
  };
}

/**
 * ⚠⚠ 13.10 (Г2, Р6): `runMaxDepth` УДАЛЕНА — «самого глубокого узла забега» не существует. Спуск бесконечен (окно
 * слоёв, любой слой адресуется своей глубиной), поэтому ни потолка глубины, ни запертого им тира сложности больше нет:
 * у `lockedDifficulties` снят аргумент `maxDepth` и причина `'depth'`. Прежняя формула (`length.max` + финал, дала бы
 * 15) умерла вместе с этими полями шаблона (Р3), а историю «Кошмар просил 20-й этаж при дне мира 15» и доказательство
 * «потолка нет» держит `config/difficultyReach.test.ts` (узел на 500 и 5000, порог любого тира достижим).
 */

/**
 * RunConfig по умолчанию (для редактора, сима и старта забега): первый биом и первый ВКЛЮЧЁННЫЙ тир.
 *
 * ⚠ Ф1 (16.10): аргумент `templateId` снят вместе с шаблонами — форму забега даёт `balance.dungeonAccess`, а тир
 * больше не приходит из строки шаблона (он выбирался там, где шаблона уже не было, — см. «костыли» плана).
 */
export function defaultRunConfig(reg: ConfigRegistry, seed: number): RunConfig {
  const biomes = reg.get('biomes') as Biome[];
  const tiers = reg.get('difficulties');
  const tier = tiers.find((d) => d.enabled !== false) ?? tiers[0]!;
  return {
    biomeId: biomes[0]!.id,
    tier: tier.id,
    seed,
    modifiers: [],
  };
}

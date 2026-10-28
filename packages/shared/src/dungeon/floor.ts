import type { ConfigRegistry } from '../config/registry.js';
import { type Rng } from '../formulas/rng.js';
import { generateMonster } from '../formulas/monstergen.js';
import { spawnWeightAt, weightedPickId, rarityAtDepth } from '../formulas/spawnWeight.js';
import { floorMonsterLevel, bandDepth } from '../formulas/power.js';
import { Cell, TILE, cellToWorld } from '../world/grid.js';
import { pushOutObstacle } from '../world/movement.js';
import type { MonsterSpawn } from '../session/session.js';
import type { ScaledMonster } from '../types/world.js';
import type { BossRank } from './run/types.js';
import { NO_RUN_BUFFS, runModCount, type RunModBuffs } from './run/runModEffects.js';
import { nearestFree, type DungeonLayout } from './floorCommon.js';
import { decorSpecsFor, obstaclesFromDecor } from './decor.js';

/**
 * ⭐⭐ МНОЖИТЕЛИ ОТРЕЗКА НА ОДНОГО МОНСТРА — ОДИН ШОВ (им же мерят потолки печатей, `economy/sealCaps.test.ts`).
 *
 * `hpExtra` — чужие множители жизни (кооп и ранг боссовой комнаты): они считаются снаружи, а сюда приезжают
 * одним числом — иначе округление шло бы дважды и жизнь босса расходилась бы с тем, что считал старый порядок.
 *
 * ⚠⚠ 23.10: УРОН УМНОЖАЕТСЯ В `minDamage`/`maxDamage`, А НЕ В `damage`. Поле `damage` — ПРОИЗВОДНОЕ среднее
 * (`monstergen` ставит его «для совместимости со старым кодом», сегодня его читает только сводка редактора), а удар монстра
 * и в движке, и в закрытой форме катается по `minDamage..maxDamage` (`buildMonsterPacket`). Правка одного `damage` делала стат
 * `monsterDamage` ПУСТЫМ ОБЕЩАНИЕМ — и печать «Яростные» становилась ЧИСТОЙ НАГРАДОЙ, то есть ломала правило 1 печатей
 * не в схеме, а В ШВЕ. Замер находки: ×1.25…×3 к урону давали бит-в-бит один и тот же бой (ttk 7.0 с во всех).
 * Сторож был зелёным, потому что мерил ТО ЖЕ производное поле; теперь он мерит ВХОДЯЩИЙ УРОН настоящим боем.
 */
export function applyMonsterBuffs(def: ScaledMonster, buffs: RunModBuffs, hpExtra = 1): void {
  const hpMul = hpExtra * buffs.monsterHp;
  if (hpMul !== 1) def.hp = Math.max(1, Math.round(def.hp * hpMul));
  if (buffs.monsterDamage !== 1) {
    def.minDamage = Math.max(1, Math.round(def.minDamage * buffs.monsterDamage));
    def.maxDamage = Math.max(def.minDamage, Math.round(def.maxDamage * buffs.monsterDamage));
    def.damage = Math.round((def.minDamage + def.maxDamage) / 2);   // производное среднее — так же, как его ставит `monstergen`
  }
  if (buffs.monsterAttackSpeed !== 1) def.attackSpeed = def.attackSpeed * buffs.monsterAttackSpeed;
  if (buffs.monsterMoveSpeed !== 1) def.moveSpeed = def.moveSpeed * buffs.monsterMoveSpeed;
}

/** Первая клетка-ПОЛ в прямоугольнике комнаты (фолбэк, если случайные промахи по стене/пустоте нерегулярной комнаты). */
function firstFloorCell(grid: DungeonLayout['grid'], r: DungeonLayout['rooms'][number]): { cx: number; cy: number } | null {
  for (let cy = r.y; cy < r.y + r.h; cy++) for (let cx = r.x; cx < r.x + r.w; cx++) if (grid[cy]?.[cx] === Cell.Floor) return { cx, cy };
  return null;
}

/**
 * ⭐⭐ 13.10 (Г1): УРОВЕНЬ МОНСТРОВ ЭТАЖА — ТОЛЬКО ОТ ГЛУБИНЫ узла (`floorMonsterLevel`: `startLevel` тира + рамп
 * `floorStep`). При живых данных (`normal` = 1/1) этаж N даёт монстров N уровня, и потолка нет.
 *
 * ⚠ Мощь героя (`el`) из этой формулы УБРАНА: раньше она была стартом («узел заселён по сильнейшему»), и уровень
 * монстра равнялся `el + depth`. Одна формула по-прежнему служит и заселению, и строке HUD (её везёт
 * `FloorInit.challengeLevel`), но расхождения клиента с сервером у неё больше нет вовсе: глубину оба знают одинаково,
 * и поле остаётся только потому, что источник истины — сервер.
 */
export function floorChallengeLevel(reg: ConfigRegistry, difficultyId: string, depth: number): number {
  const diffs = reg.get('difficulties');
  const diff = diffs.find((d) => d.id === difficultyId) ?? diffs.find((d) => d.id === 'normal') ?? diffs[0]!;
  return floorMonsterLevel(diff, depth);
}

/**
 * Ядро спавна пачек по ГЛУБИНЕ узла — без `SaveState` (имя с `El` осталось историческим: мощь героя заселение больше
 * не читает, 13.10). Позволяет редактору/симу/фаззеру заселить этаж, не собирая персонажа.
 * Пул монстров по умолчанию — из первого биома (`biomes[0]`); `poolOverride` перекрывает (биом узла).
 */
export function spawnPacksEl(
  reg: ConfigRegistry,
  layout: DungeonLayout,
  depth: number,
  difficultyId: string,
  rng: Rng,
  poolOverride?: string[],
  packDensity = 1,
  floorId = '',
  players = 1,
  bossRank?: BossRank,
  /** ⭐ Ф5-0: множители модификаторов отрезка (пусто — всё как обычно). */
  buffs: RunModBuffs = NO_RUN_BUFFS,
): MonsterSpawn[] {
  const monsters = reg.get('monsters');
  const enabledIds = new Set(monsters.filter((m) => m.enabled !== false).map((m) => m.id));
  const pool0 = poolOverride && poolOverride.length ? poolOverride : reg.get('biomes')[0]!.monsterPool;
  const pool = pool0.filter((id) => enabledIds.has(id)); // выключенные монстры не спавнятся
  if (!pool.length) return [];
  const monAffixes = reg.get('monster-affixes');
  const monsterGear = reg.get('monster-gear');
  const itemAffixes = reg.get('monster-item-affixes'); // редкость монстра = МОНСТРОВЫЕ item-афиксы на его гире (отдельный пул от лута)
  const rarities = reg.get('rarities');
  const monsterRarity = reg.get('monster-rarity'); // сколько слотов гира прокачано по редкости+уровню
  const monsterUniques = reg.get('monster-uniques'); // пул имён уникальных монстров (иначе дженерик «Уникальный X»)
  const packs = reg.get('packs');

  const balance = reg.get('balance');
  // ⭐⭐ 15.10 (Г6, кооп): множитель жизни по числу игроков — `1 + hpPerExtraPlayer × (n − 1)`, соло ровно 1.
  const hpCoop = 1 + Math.max(0, balance.coop.hpPerExtraPlayer) * Math.max(0, Math.floor(players) - 1);
  const access = balance.dungeonAccess;   // ⭐ Г8-2: лестница боссов и ранги — оттуда же, где цикл и шаг привала
  const floorCL = floorChallengeLevel(reg, difficultyId, depth);
  const uniqueXpMult = balance.uniqueXpMult;

  // Монстры пула, сгруппированные по РОЛИ (для состава пачки); фолбэк — любой из пула.
  const roleOf = new Map(monsters.map((m) => [m.id, m.role]));
  const monById = new Map(monsters.map((m) => [m.id, m]));
  const poolByRole = new Map<string, string[]>();
  for (const id of pool) { const r = roleOf.get(id) ?? ''; (poolByRole.get(r) ?? poolByRole.set(r, []).get(r)!).push(id); }
  // Вес спавна по ГЛУБИНЕ (тиры глубины): на этаже `depth` weak доминирует на мелководье, boss копится
  // к бездне. Выбор монстра в пуле/по роли взвешен этим (роль-состав пачки из packs.json — сверху).
  const depthTiers = reg.get('depth-tiers');
  const mderive = reg.get('monster-derive');
  const gearTiers = reg.get('monster-gear-tiers'); // ⭐ ступень снаряжения монстра по его уровню — та же лестница, что у игрока
  // ⭐⭐ Г8 (15.10): МЕШАНИНА ТИРОВ — ПО МЕСТУ В ПОЛОСЕ (`contentCycle`, 20 этажей), не по абсолютной глубине: за
  // краем настройки (`depth-tiers` расписаны на 20 этажей) состав застывал — на 500-м этаже ровно то же, что на 20-м,
  // и до конца времён. Сила монстров при этом едет по АБСОЛЮТНОЙ глубине (`floorCL` выше): 21-й этаж — первый круг
  // сцены с монстрами 21-го уровня.
  const sceneDepth = bandDepth(depth, balance.dungeonAccess.contentCycle);
  const weightAt = (id: string): number => { const m = monById.get(id); return m ? spawnWeightAt(m, depthTiers, sceneDepth) : 1; };
  const wpick = (ids: string[]): string => weightedPickId(ids, weightAt, rng.float(0, 1), (r) => ids[Math.floor(r * ids.length)] ?? pool[0]!);
  const pickByRole = (role: string): string => {
    const c = poolByRole.get(role);
    return c && c.length ? wpick(c) : wpick(pool);
  };

  // Пачка применима к этажу, если её список floors пуст (=любой этаж) или содержит id текущего этажа.
  const onFloor = (p: (typeof packs)[number]): boolean => !p.floors?.length || p.floors.includes(floorId);
  // Выбор пачки под комнату по убыванию приоритета: тип+этаж → тип → small+этаж → small (чтобы этаж не
  // остался пустым при неполной настройке). ВНУТРИ тира — СЛУЧАЙНЫЙ выбор: несколько пачек одного типа =
  // разнообразие составов (иначе бралась бы всегда первая, а остальные пачки были бы мертвы).
  const pickPack = (roomType: string): (typeof packs)[number] | undefined => {
    const tiers = [
      packs.filter((p) => p.roomType === roomType && onFloor(p)),
      packs.filter((p) => p.roomType === roomType),
      packs.filter((p) => p.roomType === 'small' && onFloor(p)),
      packs.filter((p) => p.roomType === 'small'),
    ];
    for (const t of tiers) if (t.length) return t.length === 1 ? t[0]! : t[rng.int(0, t.length - 1)]!;
    return undefined;
  };

  // ⚠ V-RF-05: не на преграду декора — те же коллайдеры, что получит сессия (`obstaclesFromDecor` по спекам `objects`), с тем же
  // запасом, что у сундука (R9-16). Монстр, заселённый в колонну, выдавливался из неё в первом же тике — и толчок, не видевший
  // стен, уводил его в стену и за диагональный шов. Клетка под преградой — ближайшая свободная той же комнаты БЕЗ броска:
  // поток `rng` тот же, и без преграждающего декора (сегодня его нет) заселение не меняется ни на монстра.
  // Раскладка из тестов и инструментов бывает без `decor` (заселение читало только `rooms` + `grid`) — тогда преград нет.
  const decor = (layout.decor as DungeonLayout['decor'] | undefined) ?? [];
  const decorSpecs = decor.length ? decorSpecsFor(reg.get('objects'), reg.get('models'), undefined, reg.get('art')) : [];
  const blockers = decorSpecs.length ? obstaclesFromDecor(decor, new Map(decorSpecs.map((s) => [s.id, s]))) : [];
  const underDecor = (cx: number, cy: number): boolean => {
    if (!blockers.length) return false;
    const w = cellToWorld(cx, cy);
    return blockers.some((o) => pushOutObstacle(w.x, w.y, TILE / 4, o) !== null);
  };
  const free = (cx: number, cy: number): boolean => layout.grid[cy]?.[cx] === Cell.Floor && !underDecor(cx, cy);

  const spawns: MonsterSpawn[] = [];
  // ⭐⭐ Ф5-6″: из какой комнаты каждый спавн и какой у неё базовый id монстра — нужно швам «Логово»/«Сторожевой»
  // (они работают ПОСЛЕ основного заселения, чтобы не сдвинуть его поток случайности ни на бросок).
  const roomOf: number[] = [];
  const baseOf: string[] = [];
  layout.rooms.forEach((room, roomIndex) => {
    if (room.type === 'entrance') return;
    const spec = pickPack(room.type);
    if (!spec) return;
    // Состав по ролям; фолбэк-состав, если entries пуст (устаревший конфиг).
    const entries0 = spec.entries.length ? spec.entries : [{ role: '', min: 2, max: 4, magicChance: 0.12, rareChance: 0.03 }];
    // ⭐⭐ Ф5-0 (16.10): МОДИФИКАТОРЫ ОТРЕЗКА ДЕЙСТВУЮТ ЗДЕСЬ. `packSize` множит размер пачки, `monsterRarity` —
    // шансы магического и редкого. ⚠ Поток случайности НЕ сдвигается: бросков столько же (размер пачки — один
    // бросок в прежних границах, редкость — один `rr` на монстра), меняются только ГРАНИЦЫ и ПОРОГИ. Иначе один и
    // тот же узел собирал бы разный мир с модификатором и без — а узел у нас чистая функция сида и глубины.
    // ⚠⚠ 23.10 (находка ревизии): `packSize` МНОЖИТ ОЖИДАНИЕ ПАЧКИ, А НЕ ГРАНИЦЫ БРОСКА. Было округление
    // границ (`min 2 → 2.4 → 2`, `max 4 → 4.8 → 5`), и замер показал ×1.10 вместо обещанных ×1.20, а на части
    // сидов монстров выходило МЕНЬШЕ, чем без печати. Теперь множитель применяется к готовому числу — бросок
    // идёт в ПРЕЖНИХ границах (его поток не сдвигается), а обещанное ×1.2 становится ×1.2 на любом сиде.
    const entries = buffs.monsterRarity === 1 ? entries0 : entries0.map((e) => ({
      ...e,
      magicChance: Math.min(1, (e.magicChance ?? 0) * buffs.monsterRarity),
      rareChance: Math.min(1, (e.rareChance ?? 0) * buffs.monsterRarity),
    }));
    // Спец-содержимое комнаты (фичи этажа): уник-комнаты и боссы форсируют редкость unique; босс — сложнее.
    const content = room.content;
    const forceUnique = content === 'unique' || content === 'boss' || room.type === 'boss';
    // ⚠ ОДИН НА ОДИН, НЕ ОШИБИСЬ НА ЕДИНИЦУ: `generateMonster` считает `level = max(0, depth) + 1`, то есть его `depth`
    // НОЛЬ-БАЗОВЫЙ. Чтобы уровень монстра на этаже N был ровно N (`floorCL`), кладём `floorCL - 1`.
    // Поправишь на `floorCL` — вся лестница уровней сдвинется на уровень вверх.
    // ⭐ 13.10: БОСС-КОМНАТА ГЛУБЖЕ ЭТАЖА ДОЛЕЙ (`bossRoomDepthPct`, минимум +1), а не плоскими «+3»: жизнь растёт
    // степенью, и одно и то же «+3» давало ×2.07 к жизни на 4-м уровне и ×1.04 на 200-м — босс был стеной на
    // мелководье и рядовым в бездне. Доля держит ×1.15…×1.33 на всём диапазоне (замер — в `monsterDerive.ts`).
    // ⭐⭐ Г8-2 (15.10): РАНГ БОССА МНОЖИТ НАДБАВКУ. Лестница полосы (`balance.dungeonAccess.bossLadder`) says
    // мини / крепкий / актовый, а `bossRanks[ранг].levelMult` — во сколько раз глубже обычной надбавки встаёт
    // комната. Минимум — сам множитель (чтобы «крепкий» всегда был хотя бы на +2 уровня, а не на +1 из округления).
    // Ранга нет (узел не боссовый, старый сервер, сим) — всё как было: одна доля.
    const rankLvl = bossRank ? Math.max(0, access.bossRanks[bossRank].levelMult) : 1;
    const bossBonus = Math.max(Math.max(1, Math.round(rankLvl)), Math.round(floorCL * mderive.bossRoomDepthPct * rankLvl));
    const mDepth = floorCL - 1 + (room.type === 'boss' || content === 'boss' ? bossBonus : 0);
    for (const entry of entries) {
      const count = Math.max(1, Math.round(rng.int(entry.min, entry.max) * packDensity * buffs.packSize));
      for (let i = 0; i < count; i++) {
        // Клетка спавна ДОЛЖНА быть полом: в нерегулярных комнатах (cellular/BSP) смещение в прямоугольнике комнаты
        // может попасть в стену/пустоту → монстр «за полом». Первый бросок — как раньше (детерминизм для прямоуг. комнат);
        // если не пол — перевыбираем, затем фолбэк на скан комнаты; нет пола вовсе → пропуск.
        let cx = rng.int(room.x + 1, room.x + room.w - 2);
        let cy = rng.int(room.y + 1, room.y + room.h - 2);
        for (let t = 0; t < 6 && layout.grid[cy]?.[cx] !== Cell.Floor; t++) { cx = rng.int(room.x + 1, room.x + room.w - 2); cy = rng.int(room.y + 1, room.y + room.h - 2); }
        if (layout.grid[cy]?.[cx] !== Cell.Floor) { const fc = firstFloorCell(layout.grid, room); if (!fc) continue; cx = fc.cx; cy = fc.cy; }
        // V-RF-05: свободной нет — остаётся, где был (толчок из преграды стен теперь не пересекает), и число монстров то же.
        if (underDecor(cx, cy)) { const fc = nearestFree(room, { cx, cy }, free); if (fc) { cx = fc.cx; cy = fc.cy; } }
        const w = cellToWorld(cx, cy);
        const id = entry.role ? pickByRole(entry.role) : wpick(pool);
        // Редкость монстра по «галкам роли» (шансы magic/rare пачки): rare первым, остаток — обычный.
        // Спец-комнаты (босс/уник) перекрывают → unique (топ-редкость). rng-бросок делаем всегда (стабильный поток).
        const rr = rng.float(0, 1);
        // ⭐ Глубина поднимает редкость (`loot.depthRarity`) — через неё же растёт ступень сырья
        // и качество трофеев. До `freeDepth` множитель равен 1, то есть обычные забеги не тронуты.
        const ch = rarityAtDepth(entry.magicChance ?? 0, entry.rareChance ?? 0, depth, balance.loot.depthRarity);
        const rolled: 'normal' | 'magic' | 'rare' = rr < ch.rare ? 'rare' : rr < ch.rare + ch.magic ? 'magic' : 'normal';
        const rarity: 'normal' | 'magic' | 'rare' | 'unique' = forceUnique ? 'unique' : rolled;
        const def = generateMonster(monsters, monsterGear, monAffixes, { baseId: id, depth: mDepth, uniqueXpMult, mderive, gearTiers, itemAffixes, rarities, rarity, monsterRarity, monsterUniques }, rng);
        // ⭐⭐ 15.10 (Г6, кооп): ЖИРНЕЕ ЗА КАЖДОГО ЛИШНЕГО ИГРОКА — только жизнь (`balance.coop.hpPerExtraPlayer`).
        // ⚠ ПОСЛЕ `generateMonster`, а не внутри: поток `rng` обязан остаться тем же, иначе один и тот же узел
        // собирал бы РАЗНЫЙ мир при разном числе игроков (у нас узел — чистая функция сида и глубины, Г2), и
        // продолжение забега вдвоём давало бы другие монстры, редкости и дроп, чем соло.
        // ⭐⭐ Г8-2: ЖИЗНЬ БОССОВОЙ КОМНАТЫ — ПО РАНГУ. ЗАМЕР 15.10: комната и так форсит `unique` (жизнь ×3), и на
        // её фоне разница рангов ТОЛЬКО по уровню не читалась (×8.4 / ×7.0 / ×7.5 к рядовому монстру этажа — мини на
        // 5-м «тяжелее» актового на 20-м). Со своим множителем ряд выходит ×5–8 / ×8–10 / ×14–16 и держится на всей
        // глубине. ⚠ Множитель — на ВСЮ боссовую комнату: её монстры и есть бой с боссом (комната форсит им `unique`).
        const hpBoss = bossRank && (room.type === 'boss' || content === 'boss') ? Math.max(1, access.bossRanks[bossRank].hpMult) : 1;
        // ⭐⭐ Ф5-0: модификаторы отрезка — ПОСЛЕ `generateMonster`, как и коп-множитель: поток `rng` тот же.
        applyMonsterBuffs(def, buffs, hpCoop * hpBoss);
        spawns.push({ def, x: w.x, y: w.y });
        roomOf.push(roomIndex);
        baseOf.push(id);
      }
    }
  });

  // ⭐⭐ Ф5-6″ (23.10): ДВА ШВА-СОБЫТИЯ ПЕЧАТЕЙ «ЛОГОВО» И «СТОРОЖЕВОЙ» (виды из плана Ф5).
  //
  // ⚠⚠ ПОЧЕМУ ПОСЛЕ ОСНОВНОГО ЗАСЕЛЕНИЯ, А НЕ ВНУТРИ. Внутри цикла они сдвинули бы поток случайности с первой
  // же комнаты (лишние броски на гир и афиксы уника), и один и тот же узел собирал бы с печатью совсем другой
  // этаж — не «тот же, но злее». Здесь основная раскладка уже готова БИТ В БИТ, а броски событий идут в хвост.
  //
  // ⚠ Комнаты выбираются БЕЗ БРОСКА — по площади, затем по порядку: выбор обязан быть чистой функцией этажа,
  // иначе он тоже стал бы сдвигом потока. Крупные комнаты первыми: логово в чулане читается как ошибка.
  // ⚠ Прибавка приходит в единицах ОПАСНОСТИ, а шву нужны ШТУКИ — делим на цену события из таблицы статов
  // (`run-mod-stats[].perUnit`, выведена замером мощи) ТЕМ ЖЕ правилом, которым её считает ядро (`runModCount`
  // в `sealBuffs`): одно число у заселения, у зачтённой опасности, у топлива дропа и у окна.
  // ⚠ 23.10 (страховка по ревизии): СОБЫТИЕ ВЫДАЁТСЯ ТОЛЬКО СЧЁТНОМУ СТАТУ (`unit: 'count'`). Правка данных,
  // снявшая единицу, иначе развела бы игру с окном: окно спрашивает `unit`, а шов делил бы всегда.
  const statRow = new Map(reg.get('run-mod-stats').map((s) => [s.id as string, s]));
  const countOf = (stat: 'elitePacks' | 'miniBosses', mul: number): number => {
    const row = statRow.get(stat);
    return row && row.unit === 'count' ? runModCount(mul, row.perUnit) : 0;
  };
  const extraElite = countOf('elitePacks', buffs.elitePacks);
  const champions = countOf('miniBosses', buffs.miniBosses);
  if (extraElite > 0 || champions > 0) {
    const cand = layout.rooms
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.type !== 'entrance' && r.type !== 'boss' && r.content !== 'unique' && r.content !== 'boss')
      .sort((a, b) => (b.r.w * b.r.h - a.r.w * a.r.h) || (a.i - b.i));
    const mDepthPlain = floorCL - 1;
    /** Новый монстр на место старого: то же место, тот же базовый вид — другая редкость и ранг. */
    const remake = (at: number, rarity: 'rare' | 'unique', hpExtra: number, depthAt: number): void => {
      const def = generateMonster(monsters, monsterGear, monAffixes,
        { baseId: baseOf[at]!, depth: depthAt, uniqueXpMult, mderive, gearTiers, itemAffixes, rarities, rarity, monsterRarity, monsterUniques }, rng);
      applyMonsterBuffs(def, buffs, hpCoop * hpExtra);
      spawns[at] = { ...spawns[at]!, def };
    };

    // ЛОГОВО: пачка выбранной комнаты становится ЭЛИТНОЙ — то же число монстров и те же места, но все РЕДКИЕ.
    //
    // ⚠⚠ ИМЕННО РЕДКИЕ, А НЕ УНИКИ — по замеру мощи: уник ×17.1 к обычному против ×12.4 у редкого, и комната
    // уников стоила бы +200 % мощи этажа против +140 % у редких. Разница не косметическая: уник — это ЧЕМПИОН
    // («Сторожевой»), и если логово тоже даёт уников, два вида печатей различаются только числом монстров.
    // ⚠ Пустую комнату пропускаем: «элита» без монстров была бы печатью, которая ничего не дала.
    let placedElite = 0;
    const lairRooms = new Set<number>();
    for (const { i } of cand) {
      if (placedElite >= extraElite) break;
      const mine = spawns.map((_, s) => s).filter((s) => roomOf[s] === i);
      if (!mine.length) continue;
      for (const s of mine) remake(s, 'rare', 1, mDepthPlain);
      lairRooms.add(i);
      placedElite++;
    }

    // СТОРОЖЕВОЙ: ЧЕМПИОН ранга «мини» — один монстр с надбавкой уровня и жизни боссовой комнаты этого ранга
    // (`bossRanks.mini`), встающий В ПАЧКУ (на место рядового, усиливая его): так он охраняет, а не стоит один.
    // ⚠ Ранг берём ИЗ ДАННЫХ, а не числом: лестница боссов настраивается, и «мини» обязан значить одно и то же
    // и здесь, и в боссовой комнате.
    const champRooms = new Set<number>();
    const mini = access.bossRanks.mini;
    const miniLvl = Math.max(0, mini.levelMult);
    const miniBonus = Math.max(Math.max(1, Math.round(miniLvl)), Math.round(floorCL * mderive.bossRoomDepthPct * miniLvl));
    // ⚠⚠ 23.10 (находка ревизии): ЧЕМПИОН НЕ ВСТАЁТ В ЛОГОВО. Оба события выбирали комнаты по одному списку с
    // начала, и на СЕМИ живых этажах из семи чемпион переделывал того самого монстра, которого логово только что
    // сделало редким: вторая печать связки отдавала половину обещанного (прибавка к жизни этажа +1.0 п.п. против
    // +2.1 в одиночку), а цена чемпиона мерена как «обычный → уник», а не «редкий → уник».
    // Сначала идём по комнатам БЕЗ логова (в том же порядке, без броска) и только если таких не осталось —
    // по остальным: лучше чемпион в логове, чем печать, не сделавшая ничего.
    let placedChamp = 0;
    const roomsFor = (skipLairs: boolean): number[] => cand
      .map(({ i }) => i)
      .filter((i) => (skipLairs ? !lairRooms.has(i) : lairRooms.has(i)));
    for (const i of [...roomsFor(true), ...roomsFor(false)]) {
      if (placedChamp >= champions) break;
      const mine = spawns.map((_, s) => s).filter((s) => roomOf[s] === i && !champRooms.has(i));
      if (!mine.length) continue;
      remake(mine[0]!, 'unique', Math.max(1, mini.hpMult), mDepthPlain + miniBonus);
      champRooms.add(i);
      placedChamp++;
    }
  }
  return spawns;   // без капа: этаж = сколько нагенерилось. Перф на клиенте решает окно-culling монстров (online3d).
}

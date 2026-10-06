import { describe, it, expect, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import type { AccountStash, Item, SaveState } from '@dm/shared';
import { STALE_WEIGHTS, bundleHook, cooldownHook, genOps, runSeq, setBuildHook, setSceneHook, shrinkSeq, type Hit, type Op, type RunOpts } from './uiParity.fuzzKit.js';
import { OnlineScene } from '../../scenes/OnlineScene.js';

/**
 * ⭐ B3: ФАЗЗЕР ПАРИТЕТА «ОКНО ≡ СЕРВЕР» (города). Модель и инварианты — `uiParity.fuzzKit.ts`: случайные сейвы, сундуки, журналы,
 * прилавки и живые правки конфига; на каждом шаге-окне НАСТОЯЩИЕ окна клиента (верстак, окно ковки, эскизы, лавка, «Купить»
 * кузницы, меню инвентаря, кнопка сброса атрибутов мастера — R19-07) говорят, что горит, почём и что выйдет, — и клик уходит
 * НАСТОЯЩИМ `App` / `NetClient` в НАСТОЯЩУЮ `Room.handleCmd` (мок базы ниже — маленькая честная база, как у `room.economyFuzz.test.ts`);
 * нечётные сиды — через настоящую 2D-сцену `OnlineScene` поверх `App` (R19-02, подмены Phaser ниже). Нарушение печатается с сидом и
 * СЖАТОЙ цепочкой шагов (выброшено всё, без чего оно не воспроизводится).
 *
 * Умолчание — 36 цепочек по 30 шагов (~10 с) на полный прогон. Больше — `DM_FUZZ_SEEDS=N` (с `DM_FUZZ_FROM` — первый сид, `DM_FUZZ_OPS`
 * — длина цепочки; 4 процесса по 600 цепочек параллельно — ~2.5 мин), сводка в файл — `DM_FUZZ_OUT`, без сжатия — `DM_FUZZ_SHRINK=0`,
 * сжимать и известные — `DM_FUZZ_SHRINK_KNOWN=1`, повтор одной цепочки — `DM_FUZZ_REPLAY='{"seed":N,"ops":[…]}'`, счётчики исходов
 * (горело/серое × исполнено/отказ, род отказа, строго/устаревший конфиг) — `DM_FUZZ_VERBOSE=1`. Найденное и не исправленное — в
 * `KNOWN` (главный прогон на нём не краснеет) и своим `it.fails` с минимальной цепочкой.
 *
 * ⭐ D3: второй прогон — профиль «устаревшая сборка / устаревший конфиг» (`RunOpts.profile = 'stale'`, инвариант (6) в `uiParity.fuzzKit.ts`):
 * `App` с сетью конфига, деплои кода цен в обе стороны и смены схемы конфига. Умолчание — 16 цепочек по 24 шага; больше — `DM_FUZZ_STALE_SEEDS=N`
 * (с `DM_FUZZ_FROM`, `DM_FUZZ_OPS`), повтор одной цепочки этого профиля — `DM_FUZZ_REPLAY='{"seed":N,"ops":[…],"profile":"stale"}'`.
 */
const env = (k: string, d: number): number => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? Math.floor(v) : d; };
const BIG = !!process.env.DM_FUZZ_SEEDS;
const SEEDS = env('DM_FUZZ_SEEDS', 36);
const FROM = env('DM_FUZZ_FROM', 1);
const LEN = env('DM_FUZZ_OPS', 30);
const SHRINK = process.env.DM_FUZZ_SHRINK !== '0';
const SHRINK_KNOWN = process.env.DM_FUZZ_SHRINK_KNOWN === '1';
/** ⭐ D3: профиль «устаревшая сборка / устаревший конфиг» — своё число цепочек (большой прогон — только им, `DM_FUZZ_STALE_SEEDS`). */
const STALE_BIG = !!process.env.DM_FUZZ_STALE_SEEDS;
const STALE_SEEDS = env('DM_FUZZ_STALE_SEEDS', 16);
const STALE_LEN = env('DM_FUZZ_OPS', 24);
const STALE: RunOpts = { profile: 'stale' };

// Большой прогон — потолок по числу цепочек (до ~1 с на цепочку под нагрузкой, сжатие — ещё до сотни прогонов на нарушение).
vi.setConfig({ testTimeout: Math.max(300_000, SEEDS * LEN * 60 + 600_000, STALE_SEEDS * STALE_LEN * 120 + 600_000) });

const db = vi.hoisted(() => ({
  saves: new Map<string, number>(),
  data: new Map<string, SaveState>(),
  stashes: new Map<string, { data: AccountStash; version: number }>(),
  /** ⭐ R22-03: правка конфига в окне команды сундука (`FakeDb.onStashRead`). */
  onStashRead: null as (() => boolean) | null,
}));
/** Бросок сервера (`townRng` сеется `randomInt`) — от сида цепочки: иначе сжатие не воспроизводило бы выход разбора и бросок ковки. */
const cryptoHook = vi.hoisted(() => ({ randomInt: undefined as undefined | ((a: number, b: number) => number) }));
vi.mock('node:crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:crypto')>();
  const randomInt = ((a: number, b?: number, cb?: unknown) => (cryptoHook.randomInt && typeof b === 'number' && cb === undefined
    ? cryptoHook.randomInt(a, b) : (real.randomInt as (...x: unknown[]) => number)(a, b, cb))) as typeof real.randomInt;
  return { ...real, default: { ...real, randomInt }, randomInt };
});
vi.mock('../../../../server/src/db/db.js', () => ({
  putCharacter: (charId: string, _u: string, data: SaveState, v: number) => {
    if (v !== (db.saves.get(charId) ?? 1)) return Promise.resolve(null);
    db.saves.set(charId, v + 1);
    db.data.set(charId, structuredClone(data));
    return Promise.resolve(v + 1);
  },
  putCharacterWithStash: (charId: string, userId: string, data: SaveState, v: number, stash: AccountStash, sv: number) => {
    if (v !== (db.saves.get(charId) ?? 1)) return Promise.resolve({ ok: false, conflict: 'save' });
    if (sv !== (db.stashes.get(userId)?.version ?? 0)) return Promise.resolve({ ok: false, conflict: 'stash' });
    db.saves.set(charId, v + 1);
    db.data.set(charId, structuredClone(data));
    db.stashes.set(userId, { data: structuredClone(stash), version: sv + 1 });
    return Promise.resolve({ ok: true, version: v + 1, stashVersion: sv + 1 });
  },
  createCharacter: () => Promise.resolve(1),
  getCharacter: () => Promise.resolve(null),
  getAccountStash: (userId: string) => {
    if (db.onStashRead?.()) db.onStashRead = null;   // ⭐ R22-03: окно между согласием команды и её исполнением
    const row = db.stashes.get(userId);
    return Promise.resolve(row ? { data: structuredClone(row.data), version: row.version } : null);
  },
  putAccountStash: () => Promise.resolve(),
  getRunLedger: () => Promise.resolve([]),
  mergeRunLedger: () => Promise.resolve(),
  landedVersion: () => Promise.resolve(null),
}));
vi.mock('../../../../server/src/db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));
/**
 * ⭐ R18-08: ДЕПЛОЙ СО СМЕНОЙ КОДА ЦЕН (шаг `deploy`, инвариант (5) в `uiParity.fuzzKit.ts`). `server` — штамп сборки сервера в `joined.build`
 * (null — настоящий, `serverBuild`); `drift` — формулы цен старого бандла вкладки: подмена `forgeGold` и `shopSellPrice` индекса `@dm/shared`
 * видна окнам клиента (верстак, «+N» лавки), а сервер считает их внутри `townActions.ts`, мимо индекса, — по-настоящему. `stamp: false` — вкладка
 * без штампа сборки (как до правки): фаззер обязан поймать молчаливый круг отказов (тест «зубов» ниже, `DM_FUZZ_SELFTEST=r1808` — на весь прогон).
 */
const buildHook = vi.hoisted(() => ({
  server: null as string | null,
  drift: null as null | { forge: number; sell: number },
  stamp: process.env.DM_FUZZ_SELFTEST !== 'r1808',
  /**
   * ⭐ D3, самопроверка инварианта (6) «списано не иначе, чем показано»: `consent: false` — вкладка не кладёт штамп сборки в команды согласия
   * (как до D3: `withConfigRev` без `build`), и сервер проводит команды старого кода, показавшего цену выше новой. `DM_FUZZ_SELFTEST=d3consent`.
   */
  consent: process.env.DM_FUZZ_SELFTEST !== 'd3consent',
}));
/**
 * ⭐ D3, самопроверка инварианта (6) «тупика нет»: `gateHook.blind` — правило версий не видит, что конфиг сервера вкладка не разбирает (как если бы
 * «негодный конфиг» снова говорил сам лишь раз на ETag, а отказы ценой о нём не знали). `DM_FUZZ_SELFTEST=d3blind` — на весь прогон.
 */
const gateHook = vi.hoisted(() => ({ blind: process.env.DM_FUZZ_SELFTEST === 'd3blind' }));
vi.mock('../../net/versionGate.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../net/versionGate.js')>();
  class VersionGate extends real.VersionGate {
    constructor(deps: ConstructorParameters<typeof real.VersionGate>[0]) {
      super({ ...deps, configUnreadable: () => !gateHook.blind && deps.configUnreadable() });
    }
  }
  return { ...real, VersionGate };
});
/**
 * ⭐ R19-07, самопроверка сторожа сброса атрибутов: `respecHook.old` возвращает прежнее гашение кнопки мастера (только «нечего сбрасывать» и
 * золото — без надетого, что держится на вложенных очках). Подмена `respecRefusal` индекса видна кнопке, а ядро `respec` сервера зовёт свои
 * проверки внутри `townActions.ts` — по-настоящему. Тест «зубов» ниже включает её на своих цепочках; `DM_FUZZ_SELFTEST=r1907` — на весь прогон.
 */
const respecHook = vi.hoisted(() => ({ old: process.env.DM_FUZZ_SELFTEST === 'r1907' }));
vi.mock('@dm/shared', async (importOriginal) => {
  const real = await importOriginal<typeof import('@dm/shared')>();
  const forgeGold: typeof real.forgeGold = (reg, item, op) => {
    const p = real.forgeGold(reg, item, op);
    return buildHook.drift ? Math.max(1, Math.floor(p * buildHook.drift.forge)) : p;
  };
  const shopSellPrice: typeof real.shopSellPrice = (reg, item) => {
    const p = real.shopSellPrice(reg, item);
    return buildHook.drift ? Math.ceil(p * buildHook.drift.sell) + 1 : p;
  };
  const respecRefusal: typeof real.respecRefusal = (reg, save, maxGold) => {
    if (!respecHook.old) return real.respecRefusal(reg, save, maxGold);
    if (real.attrRespecRefund(reg, save) === 0) return 'Атрибуты не вложены';
    return save.gold < reg.get('balance').respecCost ? 'Недостаточно золота' : null;
  };
  const withConfigRev: typeof real.withConfigRev = (rev, command, build) => real.withConfigRev(rev, command, buildHook.consent ? build : '');
  return { ...real, forgeGold, shopSellPrice, respecRefusal, withConfigRev };
});
vi.mock('../../../../server/src/buildStamp.js', async (importOriginal) => {
  const real = await importOriginal<{ serverBuild: () => string }>();
  return { ...real, serverBuild: () => buildHook.server ?? real.serverBuild() };
});
setBuildHook(buildHook);
/**
 * ⭐ R16-08, самопроверка сторожа пупсика: `paperdollHook.old` возвращает прежнюю пред-проверку (требования — сняв с героя только вещь
 * целевой ячейки, без второй руки под двуручником, без прочего надетого, без места под снятое). Тест «зубов» ниже включает её на своей
 * цепочке; `DM_FUZZ_SELFTEST=r1608` — на весь прогон (фаззер обязан найти `parity:enabled-refused:paperdoll`).
 */
const paperdollHook = vi.hoisted(() => ({ old: process.env.DM_FUZZ_SELFTEST === 'r1608' }));
vi.mock('../inventory/equip.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../inventory/equip.js')>();
  const { finalAttributes, meetsRequirements, modifiersFromItems } = await import('@dm/shared');
  const paperdollEquip: typeof real.paperdollEquip = (reg, save, item, cell) => {
    if (!paperdollHook.old) return real.paperdollEquip(reg, save, item, cell);
    const cmd = real.paperdollCommand(item, cell, save.equipment.weapon);
    if (typeof cmd === 'string') return cmd;
    const worn = Object.values(save.equipment).filter((i): i is Item => !!i && i.uid !== save.equipment[cell]?.uid);
    return meetsRequirements(item, finalAttributes(save.attributes, modifiersFromItems(worn))) ? cmd : 'Недостаточно атрибутов';
  };
  return { ...real, paperdollEquip };
});

/**
 * ⭐ R19-02: 2D-КЛИЕНТ В ПРОГОНЕ — настоящая сцена `OnlineScene` (нечётные сиды, `SceneHook` в `uiParity.fuzzKit.ts`). Phaser и модули-спрайты
 * подменены, как в `scenes/OnlineScene.test.ts`; маршрута у гейтвея нет (сокет открыт прогоном). `scene2d.legacyOff` — самопроверка сторожа:
 * прежний вход в сцену, снимавший обработчики кадров ОПТОМ (`NetClient.off(t)`), а с ними — подписку `App` на штамп сборки (R18-08). Тест «зубов»
 * ниже включает её на своих цепочках; `DM_FUZZ_SELFTEST=r1902` — на весь прогон (фаззер обязан найти `hint:*` у 2D-цепочек).
 */
const scene2d = vi.hoisted(() => ({ legacyOff: process.env.DM_FUZZ_SELFTEST === 'r1902' }));
vi.mock('phaser', () => ({
  default: {
    Scene: class { constructor(_key?: string) { } },
    Input: { Keyboard: { KeyCodes: { E: 69 }, JustDown: () => false } },
    Scenes: { Events: { SHUTDOWN: 'shutdown' } },
    Math: { Distance: { Between: (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by) } },
  },
}));
vi.mock('../movement/player.js', () => ({
  Player: class { x = 0; y = 0; cameraTarget = {}; setPos(): void { } update(): void { } destroy(): void { } },
}));
vi.mock('../../net/netDriver.js', () => ({
  NetDriver: class {
    setMyId(): void { } seedPeers(): void { } buildMonsters(): void { } resetInterpolation(): void { }
    resetWorld(): void { } update(): void { } destroy(): void { }
  },
}));
vi.mock('../../world/tileWorld.js', () => ({ renderGrid: () => ({ walls: { destroy: () => { } }, objects: [] }) }));
vi.mock('../../world/fogOfWar.js', () => ({ FogOfWar: class { revealSpawn(): void { } destroy(): void { } update(): void { } } }));
vi.mock('../../world/torch.js', () => ({ Torch: class { x = 0; y = 0; flicker = 1; destroy(): void { } update(): void { } } }));
vi.mock('../../world/lighting.js', () => ({ Lighting: class { destroy(): void { } update(): void { } } }));
vi.mock('../../net/netClient.js', async (orig) => ({ ...(await orig<typeof import('../../net/netClient.js')>()), routeToNode: undefined }));
/** Прежний вход в 2D-сцену снимал эти кадры оптом (до R19-02). */
const LEGACY_OFF = ['joined', 'areaChanged', 'doorOpened', 'died', 'voteStart', 'voteUpdate', 'voteEnd', 'runStatus', 'abandoned', 'error'];
setSceneHook({
  mount: (app) => {
    if (scene2d.legacyOff) for (const t of LEGACY_OFF) (app.net as unknown as { handlers: Map<string, unknown> }).handlers.delete(t);
    const chain: unknown = new Proxy(() => chain, { get: (_t, k) => (k === 'then' ? undefined : chain), apply: () => chain });
    const scene = new OnlineScene() as unknown as { create(): void };
    let shutdown: (() => void) | undefined;
    Object.assign(scene, {
      game: { registry: { get: () => app } },
      input: { keyboard: { addKey: () => ({}) }, activePointer: {} },
      add: chain, cameras: { main: { startFollow: () => { }, setZoom: () => { } } }, textures: { exists: () => false }, time: { now: 0 },
      scene: { start: () => { }, stop: () => { }, isActive: () => true, launch: () => { } },
      events: { once: (_e: string, cb: () => void) => { shutdown = cb; } },
    });
    scene.create();
    return () => shutdown?.();
  },
});

/**
 * ИЗВЕСТНЫЕ НАРУШЕНИЯ — ждут правки продукта (шаг правки). У каждого: образец ключа (главный прогон на нём не краснеет) и
 * минимальная цепочка, сжатая фаззером, — свой `it.fails` ниже: он «проходит», пока нарушение воспроизводится. После правки
 * `it.fails` покраснеет — тогда строку убрать отсюда, а тест перевести в `it` (он станет сторожем правки).
 */
interface Known { id: string; key: RegExp; what: string; repro: { seed: number; ops: Op[]; key: RegExp }[] }
const op = (k: Op['k'], s: number): Op => ({ k, s });
const KNOWN: Known[] = [];
const knownOf = (key: string): string | undefined => KNOWN.find((k) => k.key.test(key))?.id;

/**
 * ПОПРАВЛЕННЫЕ — те же минимальные цепочки, но обычным `it`: сторожа правки (главный прогон их ключи больше не прощает).
 */
const FIXED: Known[] = [
  {
    // Шов: `describeItem` — строка «Одной рукой» у предпросмотра вилкой по краям (`formulas/versatile.test.ts`).
    id: 'V-B3-01', key: /^(stale:)?range:craft-line:Одной рукой/,
    what: 'предпросмотр ковки полуторного оружия показывает «Одной рукой (со щитом)» вилкой, и скованная вещь в неё попадает',
    repro: [{ seed: 11430, ops: [op('fund', 1691763237), op('craft', 96317549)], key: /^range:craft-line:Одной рукой/ }],
  },
  {
    // Шов: `canBuy` — золото и место одним ответом для `buyItem` и ценника прилавка (лавка, «Купить» кузницы).
    id: 'V-B3-02', key: /^parity:enabled-refused:buy:space$/,
    what: 'прилавок: ценник «по карману» не смотрел на место в сумке — сервер отказывал «Нет места»',
    repro: [
      { seed: 11951, ops: [op('buy', 1039315961)], key: /^parity:enabled-refused:buy:space$/ },
      { seed: 1013, ops: [op('bagFill', 33933805), op('buy', 1710536177)], key: /^parity:enabled-refused:buy:space$/ },
    ],
  },
  {
    // Шов: `craftFits` — место ПОСЛЕ списания сырья одним ответом для `craftAction` и «Ковать» (сумка хозяина `CraftHost.bag`).
    id: 'V-B3-03', key: /^parity:enabled-refused:craft:space$/,
    what: 'окно ковки: «Ковать» горела при полной сумке — сервер отказывал «Нет места в сумке»',
    repro: [
      { seed: 10024, ops: [op('bagFill', 644189836), op('craft', 1325763302)], key: /^parity:enabled-refused:craft:space$/ },
      { seed: 11309, ops: [op('fund', 1438648595), op('craft', 1968629355)], key: /^parity:enabled-refused:craft:space$/ },
    ],
  },
  {
    // Шов: `fieldSalvageFits` — место по ЛУЧШЕМУ броску одним ответом для `fieldSalvage` и меню инвентаря.
    id: 'V-B3-04', key: /^parity:(enabled-refused:field:space|disabled-accepted:field)$/,
    what: 'меню инвентаря: «Разобрать здесь» предлагалось (со всеми вопросами), когда сырьё не влезет, — сервер отказывал «Сумка полна»',
    repro: [
      { seed: 12427, ops: [op('lootCrafted', 1233428131), op('fund', 1403730367), op('buy', 249656795), op('lootCrafted', 1453575374), op('field', 943540528)], key: /^parity:enabled-refused:field:space$/ },
      { seed: 1246, ops: [op('lootCrafted', 2119327025), op('bagFill', 1889245316), op('field', 1171421451)], key: /^parity:enabled-refused:field:space$/ },
    ],
  },
  {
    // Шов: строка эскиза окна — ровно `sketchable` сервера; форма закрытого здесь типа — с подсказкой, где ковать (`sketchElsewhere`).
    id: 'V-B3-05', key: /^parity:(disabled-accepted|enabled-refused):sketch/,
    what: 'эскизы: ключевая форма под 🔒 в одном семействе (его база закрыта), а сервер открывал её эскизом — та же форма ключ открытой базы другого хвата',
    repro: [{ seed: 10015, ops: [op('sketch', 40400573)], key: /^parity:disabled-accepted:sketch:locked$/ }],
  },
  {
    // Шов: `defaultParts` → null обрабатывают `initialCraftState` / `normalizeCraftState` (пустые гнёзда), окно — «Кузнец сейчас не куёт…».
    id: 'V-B3-06', key: /^ui-throw:craftWindow/,
    what: 'окно ковки падало (TypeError), если в конфиге выключены все варианты одного гнезда класса (`defaultParts` → null)',
    repro: [
      { seed: 10167, ops: [op('config', 1631806960), op('craft', 971281953)], key: /^ui-throw:craftWindow:Cannot read properties of null/ },
      { seed: 12206, ops: [op('config', 887772969), op('windowEnchant', 1823580486)], key: /^ui-throw:craftWindow:enchant:Cannot read properties of null/ },
      { seed: 10167, ops: [op('config', 1631806960), op('sketch', 1104816907)], key: /^ui-throw:craftWindow:sketch:Cannot read properties of null/ },
    ],
  },
  {
    // Шов: согласие на конфиг — `cfgRev` команд кузницы, скупки и разбора (`App.sendCmd` → `Room.runCmd` → `configChanged`).
    id: 'V-B3-07', key: /^stale:/,
    what: 'устаревший конфиг клиента: команда кузницы отказана «Цена изменилась» до исполнения, клиент перечитывает конфиг — исход не расходится с показанным',
    repro: [
      { seed: 11410, ops: [op('config', 483653893), op('fund', 998687216), op('craft', 1864701636)], key: /^stale:range:craft-hit$/ },
      { seed: 11995, ops: [op('fund', 1313658462), op('config', 691501595), op('craft', 1841287644)], key: /^stale:range:craft-req$/ },
      { seed: 11890, ops: [op('config', 949550270), op('windowEnchant', 1117953636)], key: /^stale:enabled-refused:windowEnchant:closed$/ },
    ],
  },
  {
    // Шов: `equipRefusal` — проверки `equip` без записи, одно решение для ядра и пупсика (`paperdollEquip`) и меню «Надеть».
    // Нашёл обзор (R16-08), цепочки — фаззер с прежней пред-проверкой (`paperdollHook.old`, тест «зубов» ниже).
    id: 'R16-08', key: /^(parity:(enabled-refused|disabled-accepted):paperdoll|ui:paperdoll)/,
    what: 'пупсик: вещь слетала с курсора, а сервер отказывал — двуручник, которому хватало атрибута лишь со второй рукой (он её снимает), сломанная вещь, снятому некуда лечь',
    repro: [
      { seed: 28, ops: [op('wear', 198088804), op('paperdoll', 1897979352)], key: /^parity:enabled-refused:paperdoll:Недостаточно атрибутов$/ },
      { seed: 5, ops: [op('paperdoll', 1454926767)], key: /^parity:enabled-refused:paperdoll:Сломано/ },
      // 06.10: цепочка переснята (`DM_FUZZ_SELFTEST=r1608`) — прежняя (сид 14) после правил трат кузницы (§6.2, §7) шла другой дорогой.
      { seed: 116, ops: [op('bagFill', 1323129844), op('paperdoll', 1617650102)], key: /^parity:enabled-refused:paperdoll:space$/ },
    ],
  },
  {
    // Шов: `Room.shopFrame` — прилавок в кадре собирается в миг отправки по правилу продажи (зелья — `shopConsumableIds`, снаряжение —
    // `gearOn`), ценник — по тому же списку. Нашёл фаззер на свежем диапазоне сидов (9 100 001…9 101 600).
    id: 'R17-04', key: /^parity:enabled-refused:buy:rule$/,
    what: 'лавка: базу зелья выключили живьём — после покупки другого зелья оно оставалось на прилавке с ценником, а сервер отказывал «нет в ассортименте»',
    repro: [{ seed: 9100067, ops: [op('config', 49817727), op('buy', 1421943494), op('buy', 648701762)], key: /^parity:enabled-refused:buy:rule$/ }],
  },
  {
    // Шов: штамп сборки (`buildStampOf` исходников shared: `__DM_BUILD__` бандла ↔ `joined.build` сервера) и правило версий у отказа
    // «Цена изменилась» (`VersionGate.refused`, D3; было `App.rereadCannotHelp`). Нашёл обзор (R18-08), цепочки — фаззер с вкладкой без штампа (`buildHook.stamp`, тест «зубов» ниже).
    id: 'R18-08', key: /^hint:/,
    what: 'деплой сменил код цен при том же конфиге: старая вкладка переподключилась сама и кликала в «Цена изменилась» (перечитывание — 304), ни разу не услышав «перезагрузите»',
    repro: [
      { seed: 4, ops: [op('deploy', 2001502154)], key: /^hint:deploy-untold$/ },
      { seed: 39, ops: [op('deploy', 1209977487), op('sell', 602148880)], key: /^hint:silent-price-loop:sell$/ },
      // 06.10: цепочка переснята (`DM_FUZZ_SELFTEST=r1808`) — прежняя (сид 5) после правил трат кузницы (§6.2, §7) шла другой дорогой.
      {
        seed: 2,
        ops: [op('loot', 59399032), op('deploy', 1910147214), op('goldEdge', 449644320), op('buy', 1287452780), op('wear', 1149690041), op('loot', 561930908),
          op('bench', 1909293600), op('bench', 1519415378)],
        key: /^hint:silent-price-loop:bench$/,
      },
    ],
  },
  {
    // Шов: подписки сети снимает только их владелец (`NetClient.on` → отписка; `off`/`clearLifecycle` убраны), 2D-сцена — свои (`offNet`).
    // Нашёл обзор (R19-02), цепочки — фаззер с 2D-сценой (нечётные сиды) и прежним входом в неё (`scene2d.legacyOff`, тест «зубов» ниже).
    id: 'R19-02', key: /^hint:/,
    what: '2D-сцена на входе снимала обработчики кадров оптом — и подписку App на штамп сборки: деплой со сменой кода цен 2D-вкладке не говорили',
    repro: [
      { seed: 5, ops: [op('deploy', 223633339)], key: /^hint:deploy-untold$/ },
      { seed: 39, ops: [op('deploy', 1209977487), op('sell', 602148880)], key: /^hint:silent-price-loop:sell$/ },
    ],
  },
  {
    // Шов: `respecRefusal` — проверки ядра `respec` без записи, одно решение для сервера и кнопки «Сбросить атрибуты» мастера.
    // Нашёл обзор (R19-07), цепочки — фаззер с прежним гашением кнопки (`respecHook.old`, тест «зубов» ниже).
    id: 'R19-07', key: /^(parity:(enabled-refused|disabled-accepted):respec|ui:respec)/,
    what: 'кнопка сброса атрибутов горела и спрашивала подтверждение, когда надетое держится на вложенных очках, — сервер отказывал «сперва сними её»',
    repro: [
      { seed: 4, ops: [op('respec', 404)], key: /^parity:enabled-refused:respec:После сброса/ },
      { seed: 3, ops: [op('respec', 404)], key: /^parity:enabled-refused:respec:После сброса/ },
      // 06.10: прежняя цепочка сида 1 (через верстак и ковку) после снятия «Плеч» и «Фокуса» катит другие броски — пересжата фаззером (`DM_FUZZ_SELFTEST=r1907`).
      { seed: 1, ops: [op('bagFill', 1907932303), op('respec', 1035640358)], key: /^parity:enabled-refused:respec:После сброса/ },
    ],
  },
  {
    // Шов: `joined.cooldowns` — откаты, с которыми сервер посадил героя (`GameSession.cooldownsOf`), → `App.applyJoinCooldowns` (одно место на оба
    // клиента; смена героя — `forgetSession`). Нашёл обзор (R21-05), цепочки — фаззер со страницей до правки (`cooldownHook.blind`, тест «зубов» ниже).
    id: 'R21-05', key: /^cd:/,
    what: 'откат, который сервер вернул на входе (другая вкладка героя, реконнект, другая комната), страница не знала: слот нарисован готовым, а каст сервер молча отбрасывал',
    repro: [
      { seed: 7, ops: [op('cdElsewhere', 2107497127)], key: /^cd:slot-ready-refused:node$/ },
      { seed: 8, ops: [op('cdElsewhere', 2107497127)], key: /^cd:slot-ready-refused:node$/ },
      { seed: 5, ops: [op('cdElsewhere', 223633339)], key: /^cd:slot-ready-refused:ins$/ },
    ],
  },
];

interface Found { seed: number; ops: Op[]; hit: Hit }

async function report(found: Map<string, Found>, opts: RunOpts = {}): Promise<string[]> {
  const lines: string[] = [];
  for (const [key, f] of found) {
    const known = knownOf(key);
    let ops = f.ops.slice(0, f.hit.at + 1);
    let log = f.hit.log;
    let msg = f.hit.msg;
    if (SHRINK && (!known || SHRINK_KNOWN)) {
      const s = await shrinkSeq(db, cryptoHook, f.seed, f.ops, key, 160, opts);
      if (s.out.hits.length) {
        ops = s.ops;
        const h = s.out.hits.find((x) => x.key === key)!;
        log = s.out.log;
        msg = h.msg;
      }
    }
    lines.push([
      `✗ ${key}${known ? ` (известное ${known})` : ''} — сид ${f.seed}, шагов в сжатой цепочке ${ops.length}`,
      `  ${msg}`,
      `  повтор: DM_FUZZ_REPLAY='${JSON.stringify({ seed: f.seed, ops, ...(opts.profile ? { profile: opts.profile } : {}) })}'`,
      ...log.map((l) => `    ${l}`),
    ].join('\n'));
  }
  return lines;
}

describe.skipIf(!!process.env.DM_FUZZ_REPLAY || (STALE_BIG && !BIG))('⭐ B3: паритет «окно ≡ сервер» — верстак, ковка, эскизы, лавка, разбор в поле', () => {
  it(`${SEEDS} цепочек по ${LEN} шагов (сиды ${FROM}…${FROM + SEEDS - 1})`, async () => {
    const found = new Map<string, Found>();
    const stats: Record<string, number> = {};
    const t0 = Date.now();
    for (let seed = FROM; seed < FROM + SEEDS; seed++) {
      const ops = genOps(seed, LEN);
      const out = await runSeq(db, cryptoHook, seed, ops);
      for (const [k, v] of Object.entries(out.stats)) stats[k] = (stats[k] ?? 0) + v;
      for (const h of out.hits) if (!found.has(h.key)) found.set(h.key, { seed, ops, hit: h });
      if (BIG && (seed - FROM + 1) % 100 === 0) console.log(`[B3] ${seed - FROM + 1}/${SEEDS} цепочек, ${Math.round((Date.now() - t0) / 1000)} с, нарушений ${found.size}`);
    }
    const lines = await report(found);
    // Известные печатаются только в большом прогоне и по `DM_FUZZ_VERBOSE`: в полном прогоне тестов их цепочки — `it.fails` ниже.
    const shown = BIG || process.env.DM_FUZZ_VERBOSE ? lines : lines.filter((l) => !l.split('\n')[0]!.includes('(известное V-'));
    if (shown.length) console.log(shown.join('\n\n'));
    if (process.env.DM_FUZZ_VERBOSE) console.log(Object.entries(stats).sort().map(([k, v]) => `${k.padEnd(34)} ${v}`).join('\n'));
    if (process.env.DM_FUZZ_OUT) {
      writeFileSync(process.env.DM_FUZZ_OUT, JSON.stringify({ from: FROM, seeds: SEEDS, len: LEN, stats, found: [...found.entries()].map(([k, f]) => ({ key: k, seed: f.seed, at: f.hit.at, msg: f.hit.msg, log: f.hit.log })) }, null, 1));
    }
    // Свойство не пустое: окна не только гаснут — сервер реально исполняет горящее.
    const sum = (re: RegExp): number => Object.entries(stats).filter(([k]) => re.test(k)).reduce((n, [, v]) => n + v, 0);
    // ⭐ Перепрогон Z2: порог — половина наблюдаемого, как у лавки. «Больше одной на цепочку» стоял у самого среднего: с шагом R21-05
    // (`cdElsewhere`) доля верстака в 30 шагах упала, и 1000 цепочек (сиды 56 100 001…) дали 954 исполненные карточки — большой прогон падал
    // на покрытии, а не на нарушении.
    expect(sum(/^bench:.*:on:ok$/), 'верстак: исполненные карточки').toBeGreaterThan(SEEDS / 2);
    expect(sum(/^craft:on:ok$/), 'ковка: скованные вещи').toBeGreaterThan(0);
    expect(sum(/^(buy|sell):on:ok$/), 'лавка: сделки').toBeGreaterThan(SEEDS / 2);
    // ⭐ R18-08: инвариант (5) не холостой — были отказы ценой, которые перечитывание не лечит (деплой со сменой кода цен).
    if (buildHook.stamp) expect(sum(/^hint:owed$/), 'деплой со сменой кода цен: отказы, за которыми обязано «перезагрузите»').toBeGreaterThan(0);
    // ⭐ R19-02: цепочки шли и через настоящую 2D-сцену; ⭐ R19-07: кнопка сброса атрибутов и горела, и сервер по ней сбрасывал.
    expect(sum(/^client:2d$/), '2D-сцена OnlineScene').toBeGreaterThan(0);
    expect(sum(/^respec:on:ok$/), 'сброс атрибутов: исполненные').toBeGreaterThan(0);
    // ⭐ R21-05: инвариант (7) не холостой — после входов были откаты сервера, и панель биндов их показала.
    if (!cooldownHook.blind) expect(sum(/^cd:shown$/), 'откаты сервера после входа — на слотах').toBeGreaterThan(0);
    const unknown = [...found.keys()].filter((k) => !knownOf(k));
    expect(unknown, shown.join('\n\n')).toEqual([]);
  });
});

/**
 * Известные нарушения — минимальные цепочки фаззера. `it.fails`: зелёный, пока нарушение воспроизводится (см. `KNOWN`).
 * Список пуст (всё поправлено) — блока нет: пустой `describe` vitest считает ошибкой («No test found in suite»).
 */
if (KNOWN.length) describe.skipIf(!!process.env.DM_FUZZ_REPLAY || BIG || STALE_BIG)('B3: известные нарушения воспроизводятся (ждут правки)', () => {
  for (const k of KNOWN) {
    for (const [i, r] of k.repro.entries()) {
      it.fails(`${k.id}${k.repro.length > 1 ? `.${i + 1}` : ''}: ${k.what}`, async () => {
        const out = await runSeq(db, cryptoHook, r.seed, r.ops);
        expect(out.hits.filter((h) => r.key.test(h.key)).map((h) => `${h.key}: ${h.msg}`), out.log.join(' ⏎ ')).toEqual([]);
      });
    }
  }
});

/** Поправленные нарушения — их минимальные цепочки больше не воспроизводят нарушение (см. `FIXED`). */
describe.skipIf(!!process.env.DM_FUZZ_REPLAY || BIG || STALE_BIG)('B3: поправленные нарушения не возвращаются', () => {
  for (const k of FIXED) {
    for (const [i, r] of k.repro.entries()) {
      it(`${k.id}${k.repro.length > 1 ? `.${i + 1}` : ''}: ${k.what}`, async () => {
        const out = await runSeq(db, cryptoHook, r.seed, r.ops);
        expect(out.hits.filter((h) => k.key.test(h.key)).map((h) => `${h.key}: ${h.msg}`), out.log.join(' ⏎ ')).toEqual([]);
      });
    }
  }
});

/**
 * ⭐ R16-08: У СТОРОЖА ПУПСИКА ЕСТЬ ЗУБЫ. Те же цепочки с прежней пред-проверкой пупсика (`paperdollHook.old`: требования — сняв только
 * вещь целевой ячейки) дают своё нарушение: вторая рука с «+Интеллект» под двуручным посохом, сломанная вещь, снятому некуда лечь.
 */
describe.skipIf(!!process.env.DM_FUZZ_REPLAY || BIG || paperdollHook.old)('R16-08: прежняя пред-проверка пупсика ловится своим ключом', () => {
  for (const [i, r] of FIXED.find((k) => k.id === 'R16-08')!.repro.entries()) {
    it(`R16-08.${i + 1}: ${r.key.source}`, async () => {
      paperdollHook.old = true;
      try {
        const out = await runSeq(db, cryptoHook, r.seed, r.ops);
        expect(out.hits.map((h) => h.key), out.log.join(' ⏎ ')).toContainEqual(expect.stringMatching(r.key));
      } finally {
        paperdollHook.old = false;
      }
    });
  }
});

/**
 * ⭐ R18-08: У ИНВАРИАНТА (5) ЕСТЬ ЗУБЫ. Те же цепочки с вкладкой БЕЗ штампа сборки (`buildHook.stamp = false` — как до правки: сравнивать
 * вкладке нечего) дают своё нарушение: деплой прошёл молча, отказы ценой при серверном конфиге — без «перезагрузите».
 */
describe.skipIf(!!process.env.DM_FUZZ_REPLAY || BIG || !buildHook.stamp)('R18-08: вкладка без штампа сборки ловится своим ключом', () => {
  for (const [i, r] of FIXED.find((k) => k.id === 'R18-08')!.repro.entries()) {
    it(`R18-08.${i + 1}: ${r.key.source}`, async () => {
      buildHook.stamp = false;
      try {
        const out = await runSeq(db, cryptoHook, r.seed, r.ops);
        expect(out.hits.map((h) => h.key), out.log.join(' ⏎ ')).toContainEqual(expect.stringMatching(r.key));
      } finally {
        buildHook.stamp = true;
      }
    });
  }
});

/**
 * ⭐ R19-02: У 2D-РЕЖИМА ПРОГОНА ЕСТЬ ЗУБЫ. Те же цепочки (нечётные сиды — через 2D-сцену) с прежним входом в неё (`scene2d.legacyOff`: обработчики
 * кадров сняты оптом, как `NetClient.off(t)`) дают своё нарушение: подписка `App` на штамп сборки снята, деплой и отказы ценой — молча.
 */
describe.skipIf(!!process.env.DM_FUZZ_REPLAY || BIG || scene2d.legacyOff)('R19-02: прежний вход в 2D-сцену ловится своим ключом', () => {
  for (const [i, r] of FIXED.find((k) => k.id === 'R19-02')!.repro.entries()) {
    it(`R19-02.${i + 1}: ${r.key.source}`, async () => {
      scene2d.legacyOff = true;
      try {
        const out = await runSeq(db, cryptoHook, r.seed, r.ops);
        expect(out.log[0], 'цепочка идёт через 2D-сцену').toMatch(/2D-сцена/);
        expect(out.hits.map((h) => h.key), out.log.join(' ⏎ ')).toContainEqual(expect.stringMatching(r.key));
      } finally {
        scene2d.legacyOff = false;
      }
    });
  }
});

/**
 * ⭐ R19-07: У СТОРОЖА СБРОСА АТРИБУТОВ ЕСТЬ ЗУБЫ. Те же цепочки с прежним гашением кнопки (`respecHook.old`: только «нечего сбрасывать» и золото)
 * дают своё нарушение: кнопка горит, а сервер отказывает «После сброса не хватит атрибутов на «…» — сперва сними её».
 */
describe.skipIf(!!process.env.DM_FUZZ_REPLAY || BIG || respecHook.old)('R19-07: прежнее гашение кнопки сброса ловится своим ключом', () => {
  for (const [i, r] of FIXED.find((k) => k.id === 'R19-07')!.repro.entries()) {
    it(`R19-07.${i + 1}: ${r.key.source}`, async () => {
      respecHook.old = true;
      try {
        const out = await runSeq(db, cryptoHook, r.seed, r.ops);
        expect(out.hits.map((h) => h.key), out.log.join(' ⏎ ')).toContainEqual(expect.stringMatching(r.key));
      } finally {
        respecHook.old = false;
      }
    });
  }
});

/**
 * ⭐ R21-05: У ИНВАРИАНТА (7) ЕСТЬ ЗУБЫ. Те же цепочки со страницей до правки (`cooldownHook.blind`: откатов кадра входа не читает, вход и смена героя
 * заливки не сбрасывают) дают своё нарушение: откат, который другая вкладка героя взяла и сервер вернул на входе, — слот нарисован готовым.
 */
describe.skipIf(!!process.env.DM_FUZZ_REPLAY || BIG || cooldownHook.blind)('R21-05: страница, не знающая откатов кадра входа, ловится своим ключом', () => {
  for (const [i, r] of FIXED.find((k) => k.id === 'R21-05')!.repro.entries()) {
    it(`R21-05.${i + 1}: ${r.key.source}`, async () => {
      cooldownHook.blind = true;
      try {
        const out = await runSeq(db, cryptoHook, r.seed, r.ops);
        expect(out.hits.map((h) => h.key), out.log.join(' ⏎ ')).toContainEqual(expect.stringMatching(r.key));
      } finally {
        cooldownHook.blind = false;
      }
    });
  }
});

/**
 * ⭐ D3: ПРОФИЛЬ «УСТАРЕВШАЯ СБОРКА / УСТАРЕВШИЙ КОНФИГ». Настоящий `App` с сетью конфига (подделка `/api/config` над конфигом сервера прогона),
 * деплои кода цен в обе стороны (`deploy`) и смены схемы конфига (`schema`, иногда с новым кодом); нечётные сиды — через 2D-сцену, чётные — голым
 * `App` (как веб-3D). Инвариант (6): тупика нет — на вход к серверу новее вкладки ровно одна строка «перезагрузите», на каждый отказ ценой, который
 * перечитывание не лечит, — она же, без расхождения версий — ни одной; и списано не иначе, чем показано — вкладка старше сервера не проводит ни одной
 * команды согласия, а проведённое — ровно по карточке. ⭐ R22-01, инвариант (9): треть цепочек — со сборкой, чьи встроенные файлы вместе нарушают
 * правило поверх таблиц (сервер их приводит и работает): страница обязана открыться и взять конфиг сервера.
 */
describe.skipIf(!!process.env.DM_FUZZ_REPLAY || (BIG && !STALE_BIG))('⭐ D3: профиль «устаревшая сборка / устаревший конфиг» — тупика нет, списано не иначе, чем показано', () => {
  it(`${STALE_SEEDS} цепочек по ${STALE_LEN} шагов (сиды ${FROM}…${FROM + STALE_SEEDS - 1})`, async () => {
    const found = new Map<string, Found>();
    const stats: Record<string, number> = {};
    const t0 = Date.now();
    for (let seed = FROM; seed < FROM + STALE_SEEDS; seed++) {
      const ops = genOps(seed, STALE_LEN, STALE_WEIGHTS);
      const out = await runSeq(db, cryptoHook, seed, ops, undefined, STALE);
      for (const [k, v] of Object.entries(out.stats)) stats[k] = (stats[k] ?? 0) + v;
      for (const h of out.hits) if (!found.has(h.key)) found.set(h.key, { seed, ops, hit: h });
      if (STALE_BIG && (seed - FROM + 1) % 50 === 0) console.log(`[D3] ${seed - FROM + 1}/${STALE_SEEDS} цепочек, ${Math.round((Date.now() - t0) / 1000)} с, нарушений ${found.size}`);
    }
    const lines = await report(found, STALE);
    if (lines.length) console.log(lines.join('\n\n'));
    if (process.env.DM_FUZZ_VERBOSE) console.log(Object.entries(stats).sort().map(([k, v]) => `${k.padEnd(34)} ${v}`).join('\n'));
    if (process.env.DM_FUZZ_OUT) {
      writeFileSync(process.env.DM_FUZZ_OUT, JSON.stringify({ profile: 'stale', from: FROM, seeds: STALE_SEEDS, len: STALE_LEN, stats, found: [...found.entries()].map(([k, f]) => ({ key: k, seed: f.seed, at: f.hit.at, msg: f.hit.msg, log: f.hit.log })) }, null, 1));
    }
    // Свойство не пустое: деплои кода и схемы были, входы к серверу новее вкладки — тоже, отказы, за которыми обязано «перезагрузите», — из обоих
    // источников; и после перезагрузки страницы сделки снова идут (профиль не сводится к «всё отказано»).
    const sum = (re: RegExp): number => Object.entries(stats).filter(([k]) => re.test(k)).reduce((n, [, v]) => n + v, 0);
    expect(sum(/^op:schema$/), 'деплои со сменой схемы конфига').toBeGreaterThan(0);
    expect(sum(/^op:deploy$/), 'деплои кода цен').toBeGreaterThan(0);
    expect(sum(/^stale:join$/), 'входы к серверу новее вкладки').toBeGreaterThan(STALE_SEEDS / 2);
    if (buildHook.stamp && !gateHook.blind) {
      expect(sum(/^hint:owed$/), 'отказы ценой, которые перечитывание не лечит').toBeGreaterThan(STALE_SEEDS / 2);
      expect(sum(/^hint:owed:schema$/), '…и из-за конфига, который вкладка не разбирает').toBeGreaterThan(0);
    }
    expect(sum(/^(bench:.*|sell|craft):on:ok$/), 'сделки согласия проходят, когда вкладка не старше').toBeGreaterThan(STALE_SEEDS);
    expect(sum(/^client:2d$/), '2D-сцена OnlineScene').toBeGreaterThan(0);
    expect(sum(/^bundle:cross$/), '⭐ R22-01: сборки, чьи файлы вместе нарушают D4 (сервер их приводит)').toBeGreaterThan(0);
    const unknown = [...found.keys()].filter((k) => !knownOf(k));
    expect(unknown, lines.join('\n\n')).toEqual([]);
  });
});

/**
 * ⭐ D3: У ИНВАРИАНТА (6) ЕСТЬ ЗУБЫ. Те же цепочки профиля с прежними правилами дают свои нарушения:
 *  • вкладка не кладёт штамп сборки в команды согласия (`buildHook.consent = false`, как до D3) — сервер проводит ковку и скупку старого кода, чья
 *    цена разошлась с новой в «выгодную» сторону: списано не то, что показано (`stale:consent-accepted`, `price:stale-charge`);
 *  • правило версий не видит негодного конфига (`gateHook.blind`) — вход и отказы ценой у вкладки, не разбирающей конфиг сервера, — молча (тупик);
 *  • ⭐ R22-01: конструктор `App` судит правило поверх таблиц над встроенными файлами (`bundleHook.strict`, как до правки) — сборка, чьи файлы
 *    вместе нарушают D4, а сервер их приводит и работает, не открывается (`boot:bundle-cross`, инвариант (9)).
 */
describe.skipIf(!!process.env.DM_FUZZ_REPLAY || BIG || STALE_BIG || !buildHook.consent || gateHook.blind || bundleHook.strict)('D3: прежние правила ловятся своими ключами', () => {
  const scan = async (key: RegExp): Promise<string[]> => {
    const keys: string[] = [];
    for (let seed = 1; seed <= STALE_SEEDS && !keys.some((k) => key.test(k)); seed++) {
      const out = await runSeq(db, cryptoHook, seed, genOps(seed, STALE_LEN, STALE_WEIGHTS), undefined, STALE);
      keys.push(...out.hits.map((h) => h.key));
    }
    return keys;
  };
  it('без согласия на сборку — вкладка старого кода платит не показанное', async () => {
    buildHook.consent = false;
    try {
      expect(await scan(/^(stale:consent-accepted|price:stale-charge):/)).toContainEqual(expect.stringMatching(/^(stale:consent-accepted|price:stale-charge):/));
    } finally {
      buildHook.consent = true;
    }
  });
  it('правило версий, слепое к негодному конфигу, — отказы ценой и вход без «перезагрузите»', async () => {
    gateHook.blind = true;
    try {
      expect(await scan(/^hint:(silent-price-loop|join-untold)/)).toContainEqual(expect.stringMatching(/^hint:(silent-price-loop|join-untold)/));
    } finally {
      gateHook.blind = false;
    }
  });
  it('⭐ R22-01: вкладка, судящая правило поверх таблиц над встроенными файлами, — не открывается над сборкой, с которой сервер работает', async () => {
    bundleHook.strict = true;
    try {
      expect(await scan(/^boot:bundle-cross$/)).toContain('boot:bundle-cross');
    } finally {
      bundleHook.strict = false;
    }
  });
});

describe.runIf(!!process.env.DM_FUZZ_REPLAY)('B3: повтор цепочки', () => {
  it('DM_FUZZ_REPLAY', async () => {
    const { seed, ops, profile } = JSON.parse(process.env.DM_FUZZ_REPLAY!) as { seed: number; ops: Op[]; profile?: RunOpts['profile'] };
    const out = await runSeq(db, cryptoHook, seed, ops, undefined, { profile });
    console.log(out.log.join('\n'));
    for (const h of out.hits) console.log(`✗ ${h.key} на шаге ${h.at}: ${h.msg}`);
  });
});

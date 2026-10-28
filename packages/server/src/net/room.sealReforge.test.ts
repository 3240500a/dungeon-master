import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import {
  ConfigRegistry, newCharacterSave, buildSeal, sealKey, carriedSealCount, carriedSeals, sealReforgeRules, sealRerollCost, sealTiers,
  PRICE_CHANGED, type Item, type SaveState, type ServerFrame,
} from '@dm/shared';

/**
 * ⭐⭐ Ф5-6 (17.10): ПЕРЕКОВКА ПЕЧАТЕЙ — КОМАНДА ГОРОДА, целиком через сервер.
 *
 * Ядро перековки и его правила сторожит `shared/economy/sealReforge.test.ts`. Здесь — ГРАНИЦА: доезжает ли
 * команда, кто платит, что видит клиент в `cmdResult`, и закрыты ли пути, которыми её можно было бы
 * использовать не по назначению (перековка в подземелье, перековка того, чего нет в сумке, старое окно
 * с другой пошлиной).
 *
 * База замокана: `db.ts` открывает пул к Postgres при импорте.
 */
const db = vi.hoisted(() => ({
  versions: new Map<string, number>(),
  data: new Map<string, unknown>(),
  // ⭐ Сундук АККАУНТА в моке: с 17.10 перековка берёт печати и оттуда, значит идёт через `withAccount`
  // и пишет сейв с сундуком ОДНОЙ транзакцией (D7/D8). Без живого мока всё кончалось «Не удалось сохранить».
  stash: { data: { version: 1, tabs: [[]] } as unknown, version: 1 },
}));
vi.mock('../db/db.js', () => ({
  putCharacter: async (charId: string, _u: string, data: SaveState, version: number) => {
    if (version !== (db.versions.get(charId) ?? 1)) return null;
    db.versions.set(charId, version + 1); db.data.set(charId, structuredClone(data));
    return version + 1;
  },
  putCharacterOwned: async () => null,
  putCharacterWithStash: async (charId: string, _u: string, data: unknown, v: number, stash: unknown, sv: number) => {
    if (v !== (db.versions.get(charId) ?? 1)) return { ok: false, conflict: 'save' };
    if (sv !== db.stash.version) return { ok: false, conflict: 'stash' };
    db.versions.set(charId, v + 1); db.data.set(charId, structuredClone(data));
    db.stash = { data: structuredClone(stash), version: sv + 1 };
    return { ok: true, version: v + 1, stashVersion: db.stash.version };
  },
  getCharacter: async () => null,
  getAccountStash: async () => ({ data: structuredClone(db.stash.data), version: db.stash.version }),
  putAccountStash: () => Promise.resolve(),
  getRunLedger: async () => [],
  mergeRunLedger: () => Promise.resolve(),
  landedVersion: async () => null,
}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));

type RoomIn = {
  area: string;
  addPlayer(ws: unknown, userId: string, save: SaveState, version: number): string;
  handleCmd(pid: string, command: unknown, seq?: number): Promise<unknown> | unknown;
  descend(pid: string, difficultyId?: string, targetNodeId?: string, cfg?: unknown, startDepth?: number): void;
  session: { world: { players: Record<string, { save: SaveState }> } };
  stop(): void;
};
let RoomCtor: new (code: string, cfg: ConfigRegistry, hooks: object) => RoomIn;
let cfg: ConfigRegistry;
beforeAll(async () => {
  const mod = (await import('./room.js')) as unknown as { Room: typeof RoomCtor };
  RoomCtor = mod.Room;
  cfg = new ConfigRegistry();
  cfg.loadAll();
});
const rooms: RoomIn[] = [];
/** ⚠ Конфиг у комнат общий: правки баланса в тесте откатываем, иначе соседний случай поедет. */
let balanceBak: unknown = null;
afterEach(() => {
  for (const r of rooms.splice(0)) r.stop();
  if (balanceBak) { cfg.reload({ balance: balanceBak }); balanceBak = null }
});
const setBalance = (patch: (b: ReturnType<ConfigRegistry['get']> extends never ? never : any) => unknown): void => {
  const b = cfg.get('balance');
  balanceBak = structuredClone(b);
  cfg.reload({ balance: patch(b) });
};

class FakeWs {
  open = true; readonly ip = '127.0.0.1';
  frames: ServerFrame[] = [];
  send(raw: string | Uint8Array): void { if (typeof raw === 'string') this.frames.push(JSON.parse(raw) as ServerFrame); }
  close(): void { this.open = false; } onMessage(): void {} onClose(): void {}
  /** Итоги команд по порядку — то, что видит игрок. */
  results(): { ok: boolean; reason?: string; summary?: string }[] {
    return this.frames.filter((f) => f.t === 'cmdResult') as unknown as { ok: boolean; reason?: string; summary?: string }[];
  }
  last(): { ok: boolean; reason?: string; summary?: string } {
    const r = this.results();
    if (!r.length) throw new Error('кадра `cmdResult` не было');
    return r[r.length - 1]!;
  }
}

/**
 * Сколько печатей ЭТОЙ СТУПЕНИ лежит в сумке.
 *
 * ⚠ Считаем по ступени, а не по виду: решением владельца 17.10 перековка идёт в режиме `sameTier` — отдаёшь
 * любые три одной ступени, а ВИД результата решает КУЗНЕЦ (как вейстоуны в PoE2). Сторож, который ждал бы
 * конкретный вид, сторожил бы бросок.
 */
function ofTier(inv: Item[], tierId: string): number {
  let n = 0;
  for (const [key, k] of Object.entries(carriedSeals(inv))) if (key.endsWith('@' + tierId)) n += k;
  return n;
}

/** Герой в городе с печатями в сумке. */
function stand(code: string, seals: [string, string, number][]): { room: RoomIn; ws: FakeWs; pid: string; save: SaveState } {
  const room = new RoomCtor(code, cfg, { onEmpty: () => {}, onGrace: () => {}, onUngrace: () => {}, onFarewell: () => {} });
  rooms.push(room);
  const charId = `char-${code}`;
  const save = newCharacterSave(cfg, 'warrior', 'Smith', charId);
  save.level = 30;
  save.gold = 5000;
  // ⚠ РЕКОРД ГЛУБИНЫ ОБЯЗАТЕЛЕН: с 17.10 перековка не выдаёт ступень, которую игрок ещё не мог бы
  // найти (`tiers[].minDepth` против рекорда) — иначе старшая сила собиралась бы в городе из мусора первых этажей.
  save.difficultyProgress = { [cfg.get('difficulties').find((d) => d.enabled !== false)!.id]: 200 };
  seals.forEach(([kind, tier, n], i) => {
    const it = buildSeal(cfg, kind, tier, n, `seal-${code}-${i}`) as Item;
    it.pos = { x: i, y: 5 };
    save.inventory.push(it);
  });
  db.versions.set(charId, 1); db.data.set(charId, structuredClone(save));
  const ws = new FakeWs();
  const pid = room.addPlayer(ws as never, `user-${charId}`, save, 1);
  return { room, ws, pid, save: room.session.world.players[pid]!.save };
}

describe('⭐⭐ Ф5-6: перековка печатей командой города', () => {
  const t1 = (): string => sealTiers(cfg)[0]!.id;
  const t2 = (): string => sealTiers(cfg)[1]!.id;
  const need = (): number => sealReforgeRules(cfg).need;

  it('⭐⭐ три печати I → одна II: сумка сошлась, игрок увидел итог словами', async () => {
    const { room, ws, pid, save } = stand('SR-OK', [['swarming', t1(), need() + 1]]);
    expect(room.area, 'перековка — дело города').toBe('town');
    await room.handleCmd(pid, { cmd: 'sealReforge', seals: { [sealKey('swarming', t1())]: need() } }, 1);
    const res = ws.last();
    expect(res.ok, res.reason).toBe(true);
    expect(res.summary, 'итог без слов — игрок не поймёт, что произошло').toBeTruthy();
    expect(carriedSealCount(save.inventory, 'swarming', t1()), 'списано ровно need').toBe(1);
    expect(ofTier(save.inventory, t2()), 'пришла одна ступенью выше').toBe(1);
  });

  it('⚠ ПЕЧАТЕЙ НЕТ — отказ, и сумка не тронута (кадр может прийти от кого угодно)', async () => {
    const { room, ws, pid, save } = stand('SR-NONE', [['swarming', t1(), 1]]);
    await room.handleCmd(pid, { cmd: 'sealReforge', seals: { [sealKey('swarming', t1())]: need() } }, 1);
    expect(ws.last().ok).toBe(false);
    expect(carriedSealCount(save.inventory, 'swarming', t1()), 'печать исчезла при отказе').toBe(1);
    expect(carriedSealCount(save.inventory, 'swarming', t2())).toBe(0);
  });

  it('⚠⚠ ВЫДУМАННЫЙ КЛЮЧ и смесь ступеней — отказ, ничего не списано', async () => {
    const { room, ws, pid, save } = stand('SR-FAKE', [['swarming', t1(), need()], ['swarming', t2(), need()]]);
    const before = JSON.stringify(save.inventory);
    await room.handleCmd(pid, { cmd: 'sealReforge', seals: { 'нет-вида@t1': need() } }, 1);
    expect(ws.last().ok, 'вид из воздуха').toBe(false);
    await room.handleCmd(pid, { cmd: 'sealReforge', seals: { [sealKey('swarming', t1())]: 1, [sealKey('swarming', t2())]: need() - 1 } }, 2);
    expect(ws.last().ok, 'смесь ступеней').toBe(false);
    expect(JSON.stringify(save.inventory), 'сумка изменилась при отказе').toBe(before);
  });

  it('⚠ В ПОДЗЕМЕЛЬЕ ПЕРЕКОВКИ НЕТ: верстак стоит в городе', async () => {
    const { room, ws, pid, save } = stand('SR-FIELD', [['swarming', t1(), need()]]);
    save.difficultyProgress = { [cfg.get('difficulties').find((d) => d.enabled !== false)!.id]: 40 };
    room.descend(pid, undefined, undefined, undefined, 1);
    expect(room.area).toBe('dungeon');
    await room.handleCmd(pid, { cmd: 'sealReforge', seals: { [sealKey('swarming', t1())]: need() } }, 1);
    expect(ws.last().ok).toBe(false);
    expect(carriedSealCount(save.inventory, 'swarming', t1()), 'в поле печати целы').toBe(need());
  });

  it('⭐ ПОШЛИНА: старое окно с прежней ценой получает «Цена изменилась», а не «не хватает»', async () => {
    setBalance((b) => ({ ...b, seals: { ...b.seals, reforge: { ...b.seals.reforge, goldCost: 300 } } }));
    const { room, ws, pid, save } = stand('SR-GOLD', [['swarming', t1(), need()]]);
    await room.handleCmd(pid, { cmd: 'sealReforge', seals: { [sealKey('swarming', t1())]: need() }, maxGold: 0 }, 1);
    const res = ws.last();
    expect(res.ok).toBe(false);
    expect(res.reason ?? '', res.reason).toContain(PRICE_CHANGED);
    expect(save.gold, 'золото не тронуто').toBe(5000);
    await room.handleCmd(pid, { cmd: 'sealReforge', seals: { [sealKey('swarming', t1())]: need() }, maxGold: 300 }, 2);
    expect(ws.last().ok, ws.last().reason).toBe(true);
    expect(save.gold, 'пошлина списана ровно по конфигу').toBe(4700);
  });

  it('⚠ выключенная в конфиге перековка не исполняется и на сервере', async () => {
    setBalance((b) => ({ ...b, seals: { ...b.seals, reforge: { ...b.seals.reforge, enabled: false } } }));
    const { room, ws, pid, save } = stand('SR-OFF', [['swarming', t1(), need()]]);
    await room.handleCmd(pid, { cmd: 'sealReforge', seals: { [sealKey('swarming', t1())]: need() } }, 1);
    expect(ws.last().ok).toBe(false);
    expect(carriedSealCount(save.inventory, 'swarming', t1())).toBe(need());
  });
});

describe('⭐⭐ Ф5-6: повтор заявки', () => {
  const t1 = (): string => sealTiers(cfg)[0]!.id;
  const t2 = (): string => sealTiers(cfg)[1]!.id;
  const need = (): number => sealReforgeRules(cfg).need;

  it('⭐⭐ ТОТ ЖЕ КЛЮЧ ЗАЯВКИ НЕ СПИСЫВАЕТ ПЕЧАТИ ВТОРОЙ РАЗ — ни на том же соединении, ни после обрыва', async () => {
    const { room, ws, pid, save } = stand('SR-NONCE', [['swarming', t1(), need() * 2]]);
    await room.handleCmd(pid, { cmd: 'sealReforge', seals: { [sealKey('swarming', t1())]: need() }, nonce: 'reforge-0001' }, 1);
    expect(ws.last().ok, ws.last().reason).toBe(true);
    const left = carriedSealCount(save.inventory, 'swarming', t1());
    expect(left).toBe(need());

    // ⚠ Дедуп соединения (`CommandDedup`) ловит повтор с ТЕМ ЖЕ номером; здесь номер ДРУГОЙ (так и приходит
    // повтор после обрыва: клиент перенумеровал), а ключ заявки тот же — и печати второй раз гореть не должны.
    await room.handleCmd(pid, { cmd: 'sealReforge', seals: { [sealKey('swarming', t1())]: need() }, nonce: 'reforge-0001' }, 7);
    expect(ws.last().ok, 'повтор обязан отвечать «уже исполнено», а не отказом').toBe(true);
    expect(carriedSealCount(save.inventory, 'swarming', t1()), '⚠ повтор сжёг печати второй раз').toBe(left);
    expect(ofTier(save.inventory, t2()), 'и вторая печать ступенью выше не появилась').toBe(1);

    // А ДРУГАЯ заявка (свой ключ) исполняется как обычно.
    await room.handleCmd(pid, { cmd: 'sealReforge', seals: { [sealKey('swarming', t1())]: need() }, nonce: 'reforge-0002' }, 8);
    expect(ws.last().ok, ws.last().reason).toBe(true);
    expect(ofTier(save.inventory, t2()), 'вторая заявка со своим ключом исполнилась').toBe(2);
  });
});

describe('⭐⭐ Решения владельца 17.10: сундук и право настройки', () => {
  const t1 = (): string => sealTiers(cfg)[0]!.id;
  const t2 = (): string => sealTiers(cfg)[1]!.id;
  const need = (): number => sealReforgeRules(cfg).need;

  it('⭐⭐ ПЕЧАТИ БЕРУТСЯ И ИЗ СУНДУКА: в сумке одна, в сундуке две — перековка проходит', async () => {
    // Сундук аккаунта кладём прямо в мок базы: его прочитает `withAccount` на исполнении команды.
    const extra = [
      buildSeal(cfg, 'swarming', t1(), 2, 'stash-seal-1') as Item,
    ];
    extra[0]!.pos = { x: 0, y: 0 };
    db.stash = { data: { version: 1, tabs: [extra] }, version: 1 };

    const { room, ws, pid, save } = stand('SR-STASH', [['swarming', t1(), 1]]);
    await room.handleCmd(pid, { cmd: 'sealReforge', seals: { [sealKey('swarming', t1())]: need() }, nonce: 'stash-0001' }, 1);
    const res = ws.last();
    expect(res.ok, res.reason).toBe(true);
    expect(carriedSealCount(save.inventory, 'swarming', t1()), 'сумка отдала свою печать первой').toBe(0);
    expect(ofTier(save.inventory, t2()), 'результат лёг в сумку').toBe(1);
    const left = (db.stash.data as { tabs: (Item | null)[][] }).tabs.flat().filter((it) => it && it.kind === 'seal');
    const inStash = left.reduce((n, it) => n + (it!.count ?? 1), 0);
    expect(inStash, 'из сундука списано ровно столько, сколько не хватило сумке').toBe(3 - need());
  });

  it('⚠⚠ ВСЁ ИЛИ НИЧЕГО ПО ОБОИМ МЕСТАМ: суммарно не хватает — ни сумка, ни сундук не тронуты', async () => {
    const one = [buildSeal(cfg, 'swarming', t1(), 1, 'stash-seal-2') as Item];
    one[0]!.pos = { x: 0, y: 0 };
    db.stash = { data: { version: 1, tabs: [one] }, version: 1 };

    const { room, ws, pid, save } = stand('SR-SHORT', [['swarming', t1(), 1]]);
    await room.handleCmd(pid, { cmd: 'sealReforge', seals: { [sealKey('swarming', t1())]: need() }, nonce: 'stash-0002' }, 1);
    expect(ws.last().ok, 'двух печатей на три не хватает').toBe(false);
    expect(carriedSealCount(save.inventory, 'swarming', t1()), 'сумка цела').toBe(1);
    const inStash = (db.stash.data as { tabs: (Item | null)[][] }).tabs.flat()
      .filter((it) => it && it.kind === 'seal').reduce((n, it) => n + (it!.count ?? 1), 0);
    expect(inStash, 'сундук цел').toBe(1);
  });
});

/**
 * ⭐⭐ Ф5-6′ (23.10): ПЕРЕКАТ ВИДА — ТА ЖЕ КОМАНДА ПРОВОДА (`op: 'reroll'`), другое правило обмена.
 *
 * ⚠ Почему сторожа здесь, а не в своём файле: у переката и перековки общее ВСЁ, кроме самого обмена — место
 * (кузница), лимит темпа, согласие на цену, ключ заявки, чтение сундука и одна транзакция «сейв + сундук».
 * Разведи их по файлам — и первая же забытая обвязка (например, `op` без лимита) приехала бы незамеченной.
 */
describe('⭐⭐ Ф5-6′: перекат вида командой города', () => {
  const t1 = (): string => sealTiers(cfg)[0]!.id;
  const cost = (): number => sealRerollCost(cfg, t1());

  it('⭐⭐ одна печать → другой вид ТОЙ ЖЕ ступени, золото списано, итог словами', async () => {
    const { room, ws, pid, save } = stand('RR-OK', [['swarming', t1(), 1]]);
    const gold = save.gold;
    await room.handleCmd(pid, { cmd: 'sealReforge', op: 'reroll', seals: { [sealKey('swarming', t1())]: 1 } }, 1);
    const res = ws.last();
    expect(res.ok, res.reason).toBe(true);
    expect(res.summary, 'итог без слов — игрок не поймёт, что вышло').toBeTruthy();
    expect(ofTier(save.inventory, t1()), 'штука одна: перекат не множит и не отнимает').toBe(1);
    expect(carriedSealCount(save.inventory, 'swarming', t1()), 'вид обязан стать другим').toBe(0);
    expect(gold - save.gold, 'пошлина по прейскуранту ступени').toBe(cost());
  });

  it('⚠ ДВЕ ПЕЧАТИ ЗА ОДНУ — отказ: это был бы обмен силы мимо перековки', async () => {
    const { room, ws, pid, save } = stand('RR-TWO', [['swarming', t1(), 2]]);
    const before = JSON.stringify(save.inventory);
    await room.handleCmd(pid, { cmd: 'sealReforge', op: 'reroll', seals: { [sealKey('swarming', t1())]: 2 } }, 1);
    expect(ws.last().ok).toBe(false);
    expect(JSON.stringify(save.inventory), 'сумка изменилась при отказе').toBe(before);
  });

  it('⭐ КЛЮЧ ЗАЯВКИ: повтор после обрыва не перекатывает второй раз', async () => {
    const { room, ws, pid, save } = stand('RR-NONCE', [['swarming', t1(), 1]]);
    const gold = save.gold;
    const nonce = 'reroll-0001';
    await room.handleCmd(pid, { cmd: 'sealReforge', op: 'reroll', seals: { [sealKey('swarming', t1())]: 1 }, nonce }, 1);
    expect(ws.last().ok, 'первая заявка').toBe(true);
    const after = JSON.stringify(save.inventory);
    await room.handleCmd(pid, { cmd: 'sealReforge', op: 'reroll', seals: { [sealKey('swarming', t1())]: 1 }, nonce }, 2);
    expect(ws.last().ok, 'повтор отвечает «уже исполнено», а не отказом').toBe(true);
    expect(JSON.stringify(save.inventory), 'повтор перекатил второй раз').toBe(after);
    expect(gold - save.gold, 'и пошлину взял один раз').toBe(cost());
  });

  it('⭐ ПОШЛИНА: старое окно с прежней ценой получает «Цена изменилась»', async () => {
    const { room, ws, pid, save } = stand('RR-GOLD', [['swarming', t1(), 1]]);
    await room.handleCmd(pid, { cmd: 'sealReforge', op: 'reroll', seals: { [sealKey('swarming', t1())]: 1 }, maxGold: 0 }, 1);
    const res = ws.last();
    expect(res.ok).toBe(false);
    // ⚠ Отказ несёт И САМУ ЦЕНУ («Цена изменилась: N золота») — именно это нужно окну, чтобы показать новую.
    expect(res.reason ?? '', 'отказ обязан отправить клиента перечитать конфиг').toContain(PRICE_CHANGED);
    expect(res.reason, 'цена переката — по ступени, а не базовая').toContain(String(cost()));
    expect(carriedSealCount(save.inventory, 'swarming', t1()), 'печать цела').toBe(1);
  });

  /**
   * ⭐⭐ 23.10 (находка ревизии, высокая): КЛЮЧ ЗАЯВКИ ПЕРЕЖИВАЕТ КОМНАТУ.
   *
   * ⚠⚠ Было: ключи жили в `Set` КОМНАТЫ и писались ПОСЛЕ транзакции — два пути двойного списания:
   * 64 успешных обмена вытесняли ключ по счёту, а смерть комнаты (или фиксация с неизвестным исходом) теряла его
   * вместе с памятью. Теперь ключ лежит В СУНДУКЕ (`AccountStash.sealNonces`) и пишется ТОЙ ЖЕ транзакцией,
   * что обмен — как у ковки: «запись легла» и «ключ помнится» стали одним фактом.
   */
  it('⭐⭐ КЛЮЧ В СУНДУКЕ: повтор в ДРУГОЙ комнате не сжигает печати второй раз', async () => {
    const need = (): number => sealReforgeRules(cfg).need;
    const t2 = (): string => sealTiers(cfg)[1]!.id;
    const nonce = 'cross-room-1';
    const a = stand('SR-X1', [['swarming', t1(), need()]]);
    await a.room.handleCmd(a.pid, { cmd: 'sealReforge', seals: { [sealKey('swarming', t1())]: need() }, nonce }, 1);
    expect(a.ws.last().ok, a.ws.last().reason).toBe(true);
    const afterFirst = ofTier(a.save.inventory, t2());
    expect(afterFirst, 'первая заявка дала ступень выше').toBe(1);

    // Другая комната (своя память ключей, тот же сундук в базе) и тот же ключ заявки.
    const b = stand('SR-X2', [['swarming', t1(), need()]]);
    await b.room.handleCmd(b.pid, { cmd: 'sealReforge', seals: { [sealKey('swarming', t1())]: need() }, nonce }, 1);
    const res = b.ws.last();
    expect(res.ok, 'повтор отвечает «уже исполнено»').toBe(true);
    expect(carriedSealCount(b.save.inventory, 'swarming', t1()), 'печати В ДРУГОЙ комнате целы').toBe(need());
    expect(ofTier(b.save.inventory, t2()), 'и второй печати ступенью выше не появилось').toBe(0);

    // И вид обмена — часть ключа: перекат с тем же ключом ИСПОЛНЯЕТСЯ, а не проходит как повтор.
    await b.room.handleCmd(b.pid, { cmd: 'sealReforge', op: 'reroll', seals: { [sealKey('swarming', t1())]: 1 }, nonce }, 2);
    expect(b.ws.last().ok, b.ws.last().reason).toBe(true);
    expect(carriedSealCount(b.save.inventory, 'swarming', t1()), 'перекат со своим видом ключа исполнился').toBe(need() - 1);
  });

  it('⚠ В ПОДЗЕМЕЛЬЕ ПЕРЕКАТА НЕТ: кузнец стоит в городе (одна команда — один `SCOPE`)', async () => {
    const { room, ws, pid, save } = stand('RR-FIELD', [['swarming', t1(), 1]]);
    save.difficultyProgress = { [cfg.get('difficulties').find((d) => d.enabled !== false)!.id]: 40 };
    room.descend(pid, undefined, undefined, undefined, 1);
    expect(room.area).toBe('dungeon');
    await room.handleCmd(pid, { cmd: 'sealReforge', op: 'reroll', seals: { [sealKey('swarming', t1())]: 1 } }, 1);
    expect(ws.last().ok).toBe(false);
    expect(carriedSealCount(save.inventory, 'swarming', t1()), 'в поле печать цела').toBe(1);
  });
});

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * ⭐ E2E 27.09: ВХОД ПО КОДУ — ТОЖЕ «НАПРАВЛЕН, НО ЕЩЁ НЕ УЧТЁН». Гейтвей прибавляет к игрокам ноды выданные с прошлого
 * сердцебиения направления (`issued`), иначе всплеск входов видит «везде по нулю» и уезжает на одну ноду. Но считал он только
 * новые входы — напарники хоста, пришедшие по коду комнаты, в поправку не шли. На живом кластере (2 ноды, 6 пати по 4,
 * `npm run loadtest -- --group=4`) это дало 5 комнат на одной ноде и 1 на другой: хосты следующих пати видели ноду первой
 * пати почти пустой. И та же сумма держит потолок кластера: поток входов по коду в окне между сердцебиениями видел одну и ту
 * же устаревшую сумму и проходил весь, мимо запаса ноды (R6-08). Здесь — настоящая ручка за настоящим express, а реестр
 * отдаёт показатели, которые «ещё не догнали» (сердцебиение не пришло).
 */
const db = vi.hoisted(() => {
  const TOKEN = 'a'.repeat(64);
  const CHAR = '0f8e0c5e-1c2b-4d6a-9e3f-1234567890ab';
  /** `beat` — время последнего сердцебиения нод по часам базы, мс; `undefined` — строка без него (как в старых моках). */
  const cluster: { players: number; nodes: number; claimTo: string; beat: number | undefined } = { players: 0, nodes: 2, claimTo: '', beat: undefined };
  /**
   * Задержка «базы», мс. Без неё ответы моков приходят микрозадачами, и обработчик одного запроса доходит до конца раньше,
   * чем прочитан следующий, — одновременности нет. Настоящая база отвечает через цикл событий, и запросы переплетаются.
   */
  const lag = { ms: 0 };
  const io = async <T>(v: T): Promise<T> => {
    if (lag.ms > 0) await new Promise((r) => setTimeout(r, lag.ms));
    return v;
  };
  return { TOKEN, CHAR, cluster, lag, io };
});
vi.mock('../db/db.js', () => ({
  getSession: async (t: string) => db.io(t === db.TOKEN ? 'user-1' : null),
  getCharacter: async (id: string) => db.io(id === db.CHAR ? { userId: 'user-1', data: {}, version: 1 } : null),
}));
vi.mock('../db/pool.js', () => ({ q: async () => db.io([]), q1: async () => db.io(null) }));
vi.mock('./registry.js', () => ({
  liveNodes: async () => db.io(Array.from({ length: db.cluster.nodes }, (_, i) => (
    { id: `node-${i}`, url: `ws://n${i}/ws`, players: db.cluster.players, rooms: 0, draining: false, cpu_seconds: 0, rss_bytes: '0', loop_p99_ms: 0, tick_hz: 30,
      ...(db.cluster.beat !== undefined ? { beat_ms: db.cluster.beat } : {}) }))),
  // Закрепление: обычно — выбранная нода; `claimTo` — герой уже закреплён за другой (второй вход тем же героем).
  claimChar: async (_c: string, n: string) => db.io(db.cluster.claimTo || n),
  sweepNodes: async () => 0,
  liveClaim: async () => db.io(null),
}));

/**
 * Поднять гейтвей с чистым счётом направлений. Сброс счёта (`setInterval` раз в 4 с) — под поддельными часами и никогда не
 * срабатывает: под нагрузкой полного прогона тест иначе мог попасть на сброс посреди всплеска и проверить не то.
 */
async function gateway(maxPlayers?: number, o: { keepFakeInterval?: boolean } = {}): Promise<{ route: (query: string) => Promise<{ status: number; node?: string }>; close: () => void }> {
  vi.resetModules();
  if (maxPlayers !== undefined) process.env.DM_MAX_PLAYERS = String(maxPlayers);
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  let installGatewayRoutes: typeof import('./gateway.js')['installGatewayRoutes'];
  try {
    ({ installGatewayRoutes } = await import('./gateway.js'));
  } finally {
    if (!o.keepFakeInterval) vi.useRealTimers();
    delete process.env.DM_MAX_PLAYERS;
  }
  const { limits } = await import('../net/rateLimit.js');
  const app = express();
  installGatewayRoutes(app);
  const server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    route: async (query: string) => {
      limits.route.reset('user-1');   // потолок маршрута (R4-21) проверяет свой тест — здесь он мешал бы всплеску
      const r = await fetch(`${base}/api/route?charId=${db.CHAR}${query}`, { headers: { Authorization: `Bearer ${db.TOKEN}` } });
      const json = (await r.json().catch(() => ({}))) as { node?: string };
      return { status: r.status, node: json.node };
    },
    close: () => server.close(),
  };
}

describe('⭐ E2E 27.09: вход по коду учитывается в поправке гейтвея', () => {
  let gw: Awaited<ReturnType<typeof gateway>>;
  beforeAll(async () => { db.cluster.players = 0; db.cluster.nodes = 2; gw = await gateway(); });
  afterAll(() => { gw.close(); db.cluster.claimTo = ''; });

  it('три напарника первой пати пришли по коду — третий хост уходит на ДРУГУЮ ноду, а не на «пустую» первую', async () => {
    expect((await gw.route('')).node, 'хост 1').toBe('node-0');
    expect((await gw.route('')).node, 'хост 2 — на свободную').toBe('node-1');
    for (let i = 0; i < 3; i++) expect((await gw.route('&roomCode=A2B3C4D5')).node, `напарник ${i + 1} хоста 1`).toBe('node-0');
    // На node-0 уже четверо (1 + 3 по коду), на node-1 — один: третьему хосту — node-1.
    expect((await gw.route('')).node, 'хост 3').toBe('node-1');
  });
});

describe('⭐ E2E 27.09: закреплённый за другой нодой учитывается там, куда ушёл', () => {
  let gw: Awaited<ReturnType<typeof gateway>>;
  beforeAll(async () => { db.cluster.players = 0; db.cluster.nodes = 2; gw = await gateway(); });
  afterAll(() => { gw.close(); db.cluster.claimTo = ''; });

  it('самой свободной была node-0, но герой закреплён за node-1 — следующий новичок идёт на node-0', async () => {
    db.cluster.claimTo = 'node-1';
    expect((await gw.route('')).node, 'закреплённый — к своей ноде').toBe('node-1');
    db.cluster.claimTo = '';
    // Раньше поправку получала выбранная node-0, а игрок ушёл на node-1: новичок видел node-0 «занятой».
    expect((await gw.route('')).node, 'новичок — на действительно свободную').toBe('node-0');
  });
});

/**
 * ⭐ E2E 27.09: ПОПРАВКА ЖИВЁТ ДО СЕРДЦЕБИЕНИЯ, КОТОРОЕ ЕЁ ОТРАЗИЛО, — А НЕ ДО СВОИХ ЧАСОВ. Счёт направлений сбрасывался таймером
 * раз в 4 с, не глядя на сердцебиения нод: сброс между выдачей адреса и сердцебиением, которое уже видит вошедших, — и они
 * пропадали из суммы, всплеск проходил сверх потолка (живой `poc:cluster --mode=queue`, потолок 30: впущено 33). А между
 * сердцебиением и сбросом те же игроки считались дважды — очередь вставала раньше потолка (25 из 30).
 */
describe('⭐ E2E 27.09: поправка гейтвея снимается сердцебиением ноды, а не таймером', () => {
  let gw: Awaited<ReturnType<typeof gateway>>;
  // Потолок 8, одна нода. Поддельный `setInterval` — на весь блок: прежний сброс по таймеру здесь можно «дождаться».
  beforeAll(async () => {
    db.cluster.players = 0; db.cluster.nodes = 1; db.cluster.beat = 1_000;
    gw = await gateway(8, { keepFakeInterval: true });
  });
  afterAll(() => { gw.close(); vi.useRealTimers(); db.cluster.players = 0; db.cluster.nodes = 2; db.cluster.beat = undefined; });

  it('восемь направлены, сердцебиение их ещё не видит — девятый в очереди и после 4 с, и после ОДНОГО сердцебиения', async () => {
    for (let i = 0; i < 8; i++) expect((await gw.route('')).status, `новичок ${i + 1}`).toBe(200);
    expect((await gw.route('')).status, 'девятый — очередь').toBe(503);
    vi.advanceTimersByTime(4_100);   // прежний сброс по таймеру
    expect((await gw.route('')).status, 'сброс по часам не пропускает сверх потолка').toBe(503);
    db.cluster.beat = 3_000;          // следующее сердцебиение: направленные могли войти ПОСЛЕ замера — ещё не отражены
    expect((await gw.route('')).status, 'одно сердцебиение — ещё не отражены').toBe(503);
  });

  it('второе сердцебиение отражает вошедших — они не считаются дважды; не вошедшие больше не держат мест', async () => {
    db.cluster.beat = 5_000; db.cluster.players = 8;
    expect((await gw.route('')).status, 'восемь в игре — потолок, но не больше (не 16)').toBe(503);
    db.cluster.players = 3;           // пятеро так и не вошли (закрыли вкладку) — их места свободны
    let admitted = 0;
    for (let i = 0; i < 6; i++) if ((await gw.route('')).status === 200) admitted++;
    expect(admitted, 'свободно ровно пять').toBe(5);
  });
});

/**
 * ⭐ E2E 27.09: ОДНОВРЕМЕННЫЕ МАРШРУТЫ. Обработчик ждёт базу (сессия, герой, реестр, закрепление, очередь), и запросы
 * всплеска переплетаются на этих ожиданиях. Выбор ноды и проверка потолка обязаны засчитывать направление В ТОМ ЖЕ шаге,
 * где считают сумму, — до следующего ожидания: иначе все одновременные видят одну и ту же сумму — едут на одну ноду и
 * проходят потолок все разом (перезапуск кластера — это как раз тысяча одновременных реконнектов).
 */
describe('⭐ E2E 27.09: одновременные маршруты засчитываются до ожиданий базы', () => {
  beforeAll(() => { db.lag.ms = 5; });
  afterAll(() => { db.lag.ms = 0; });
  it('десять новичков разом, две ноды — пять и пять, а не десять на одну', async () => {
    db.cluster.players = 0; db.cluster.nodes = 2;
    const gw = await gateway();
    try {
      const got = await Promise.all(Array.from({ length: 10 }, () => gw.route('')));
      const on0 = got.filter((r) => r.node === 'node-0').length, on1 = got.filter((r) => r.node === 'node-1').length;
      expect([on0, on1]).toEqual([5, 5]);
    } finally { gw.close(); }
  });

  it('двенадцать новичков разом при потолке 8 — впущено восемь, остальные в очереди', async () => {
    db.cluster.players = 0; db.cluster.nodes = 1;
    const gw = await gateway(8);
    try {
      const got = await Promise.all(Array.from({ length: 12 }, () => gw.route('')));
      expect(got.filter((r) => r.status === 200).length).toBe(8);
      expect(got.filter((r) => r.status === 503).length).toBe(4);
    } finally { gw.close(); db.cluster.nodes = 2; }
  });

  it('двенадцать по коду разом при потолке 8 и восьми в игре — проходит запас (четыре), не больше', async () => {
    db.cluster.players = 8; db.cluster.nodes = 1;
    const gw = await gateway(8);
    try {
      const got = await Promise.all(Array.from({ length: 12 }, () => gw.route('&roomCode=A2B3C4D5')));
      expect(got.filter((r) => r.status === 200).length).toBe(4);
    } finally { gw.close(); db.cluster.players = 0; db.cluster.nodes = 2; }
  });
});

describe('⭐ E2E 27.09: всплеск входов по коду не проходит потолок кластера целиком', () => {
  let gw: Awaited<ReturnType<typeof gateway>>;
  // Потолок 8, запас пати max(4, 8/4) = 4: по коду пускают, пока «игроки + направленные» меньше 12.
  beforeAll(async () => { db.cluster.players = 0; db.cluster.nodes = 1; gw = await gateway(8); });
  afterAll(() => { gw.close(); db.cluster.players = 0; db.cluster.nodes = 2; });

  it('реестр показывает 8 (сердцебиение не догнало) — из десяти входов по коду проходят четверо, дальше очередь', async () => {
    db.cluster.players = 8;
    let admitted = 0;
    for (let i = 0; i < 10; i++) if ((await gw.route('&roomCode=A2B3C4D5')).status === 200) admitted++;
    expect(admitted, 'в пределах запаса ноды').toBe(4);
  });
});

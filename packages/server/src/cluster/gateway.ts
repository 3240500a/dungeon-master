import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { WIRE_TOKEN_RE, WIRE_CHAR_ID_RE, ROOM_CODE_LEN } from '@dm/shared';
import { q, q1 } from '../db/pool.js';
import { getCharacter } from '../db/db.js';
import { limits } from '../net/rateLimit.js';
import { localCaller } from '../net/adminAccess.js';
import { cachedJson } from '../net/cachedJson.js';
import { queryText } from '../net/asyncRoute.js';
import { sessionUser, routePass } from '../net/authSession.js';
import { liveNodes, liveClaim, claimChar, sweepNodes, type NodeRow } from './registry.js';

/**
 * Гейтвей (Ф4.1, Ф4.4): раздаёт клиенту адрес игровой ноды и держит очередь на вход.
 *
 * ЧЕГО ГЕЙТВЕЙ НЕ ДЕЛАЕТ — он НЕ проксирует игру. Проксируй он кадры, вся работа, которую
 * мы только что разложили по процессам, снова сошлась бы в одном: он делал бы те же
 * отправки и приёмы, только дважды. Поэтому клиент спрашивает адрес один раз и дальше
 * говорит с нодой напрямую.
 *
 * КАК ВЫБИРАЕТСЯ НОДА (после очереди на вход — R5-13: и для входа по коду; R6-08: вход по коду — в пределах запаса ноды
 * сверх потолка, а герой с живым закреплением — сессия, грейс, прощальная запись — идёт к своей ноде мимо очереди):
 *  1. Заход по коду комнаты — по ПЕРВОЙ БУКВЕ кода. Код комнаты выдаёт нода и ставит в него
 *     свою букву, поэтому «зайти к другу» не требует ни одного запроса в базу.
 *  2. Возврат своего персонажа — на ноду, за которой он закреплён (`char_claims`). Это же
 *     закрытие глобального замка: второй вход тем же персонажем попадает на ТУ ЖЕ ноду,
 *     где выселение старой сессии уже работает с Ф0.3.
 *  3. Новый вход — на самую свободную живую ноду.
 */

/** Буква ноды в коде комнаты: `node-0` → `A`. По ней гейтвей и маршрутизирует. */
export function nodeLetter(nodeId: string): string {
  const idx = Number(/(\d+)$/.exec(nodeId)?.[1] ?? 0);
  return String.fromCharCode(65 + (idx % 26));
}

/** Потолок кластера. Сверх него — очередь, а не отказ и не «примем всех и ляжем». */
const MAX_PLAYERS = Number(process.env.DM_MAX_PLAYERS ?? 0);   // 0 = без потолка
/**
 * Билет в очереди живёт недолго после ПОСЛЕДНЕГО ОПРОСА (`seen_at`, R6-08): ушедший из очереди не должен держать место, а
 * ждущий честно (клиент опрашивает каждые 3 с) не теряет его, сколько бы ни ждал.
 */
const TICKET_TTL_SEC = 60;
/**
 * ⭐ R6-08: запас сверх потолка для входа к другу по коду — тот же, что держит нода (`RoomManager.admits`: потолок +
 * max(размер пати, четверть потолка)): пати на потолке не разрывается, а вход без кода на ноде всё равно упирается в
 * её потолок (R5-13), так что код-«пропуск» ничего не открывает.
 */
const PARTY_HEADROOM_MIN = 4;
const partyHeadroom = (cap: number): number => Math.max(PARTY_HEADROOM_MIN, Math.ceil(cap / 4));
/** R6-20: как долго состояние кластера (`/api/cluster`) отдаётся из кэша, мс. */
const CLUSTER_CACHE_MS = 1_000;

function bearer(req: Request): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(req.header('authorization') ?? '');
  return m ? m[1]! : null;
}

/** R4-21: билет очереди — ровно тот вид, что выдаёт `admit` (`randomUUID`). */
const TICKET_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** R4-21: код комнаты (без учёта регистра) — буквы и цифры, не длиннее кода ноды (R4-18). */
const ROOM_CODE_RE = new RegExp(`^[A-Z0-9]{1,${ROOM_CODE_LEN}}$`);

/**
 * Одно направление: когда выдано (монотонные часы гейтвея — только для запасного срока) и какое сердцебиение ноды гейтвей
 * видел в тот момент (`beat_ms`, часы базы).
 */
interface Issued { node: string; at: number; beat: number | undefined }
/**
 * Кого мы отправили на узел, а его показатели этого ещё не отражают (по ноде).
 *
 * БЕЗ ЭТОГО ВСПЛЕСК УХОДИТ НА ОДИН УЗЕЛ. Показатели приходят с сердцебиением раз в две
 * секунды; если за это время подключаются сорок человек, все сорок видят «везде по нулю»
 * и все едут на первый узел. Проверено на первом же прогоне: 4 узла, 14 игроков — все на
 * `node-0`. Поэтому к числу игроков прибавляем ещё не учтённые направления.
 */
const issued = new Map<string, Issued[]>();
/**
 * ⭐ E2E 27.09: ПОПРАВКА СНИМАЕТСЯ СЕРДЦЕБИЕНИЕМ, КОТОРОЕ ЕЁ ТОЧНО ОТРАЗИЛО, А НЕ ТАЙМЕРОМ. Раньше счёт обнулялся раз в 4 с по
 * своим часам: сброс между выдачей адреса и сердцебиением, которое уже видит вошедших, — и они выпадали из суммы (живой
 * `poc:cluster --mode=queue`, потолок 30: впущено 33); между сердцебиением и сбросом те же игроки считались дважды — очередь
 * вставала раньше потолка (25 из 30). Теперь направление живёт, пока сердцебиение ноды не ушло от увиденного при выдаче на
 * `ISSUED_REFLECT_MS` — это второе сердцебиение после выдачи (нода бьётся раз в 2 с, `node.ts`): первое могло быть замерено
 * раньше, чем клиент вошёл, второе видит всех, кто вошёл в пределах ~2 с. Сравниваются только значения часов базы между собой.
 * Кто не вошёл (закрыл вкладку), тоже снимается — места он не держит.
 */
const ISSUED_REFLECT_MS = 3_500;
/** Запасной срок направления — если сердцебиения ноды не видно (строка без `beat_ms`): монотонные часы гейтвея. */
const ISSUED_TTL_MS = 30_000;
const monotonicMs = (): number => performance.now();

/** Снять направления, которые сердцебиения нод уже отразили (или которые пережили запасной срок); ноды, выпавшие из живых, — целиком. */
function settleIssued(nodes: readonly NodeRow[]): void {
  const now = monotonicMs();
  const live = new Map(nodes.map((n) => [n.id, n]));
  for (const [id, list] of issued) {
    const beat = live.get(id)?.beat_ms;
    const kept = live.has(id)
      ? list.filter((e) => now - e.at < ISSUED_TTL_MS && !(beat !== undefined && e.beat !== undefined && beat - e.beat >= ISSUED_REFLECT_MS))
      : [];
    if (kept.length) issued.set(id, kept); else issued.delete(id);
  }
}

/** Сколько игроков направлено на ноду, но ещё не отражено в её показателях. */
function pendingOf(nodeId: string): number {
  return issued.get(nodeId)?.length ?? 0;
}

/** Сколько игроков направлено, но ещё не отражено в показателях узлов. */
function pendingIssued(): number {
  let n = 0;
  for (const v of issued.values()) n += v.length;
  return n;
}

/**
 * R7-05: лог отказов маршрутизации (база не ответила и т. п.) — не чаще раза в 10 с, с числом промолчанных (как `warnFrame` у
 * кадров): поток запросов в лежащую базу лог не топит.
 */
let routeWarnAt = 0;
let routeWarnMuted = 0;
function warnRoute(e: unknown): void {
  const now = Date.now();
  if (now - routeWarnAt < 10_000) { routeWarnMuted++; return; }
  const muted = routeWarnMuted ? ` (и ещё ${routeWarnMuted} с прошлого сообщения)` : '';
  routeWarnAt = now; routeWarnMuted = 0;
  console.error(`[гейтвей] отказ маршрутизации${muted}:`, e);
}

/** Самая свободная живая нода с учётом уже выданных, но ещё не учтённых направлений. */
function leastLoaded(nodes: NodeRow[]): NodeRow | undefined {
  const score = (n: NodeRow): number => n.players + pendingOf(n.id);
  return nodes.filter((n) => !n.draining).sort((a, b) => score(a) - score(b))[0];
}

/**
 * ⭐ E2E 27.09: направление засчитывается ТОЙ ноде, чей адрес ушёл клиенту, — на КАЖДОМ пути: новичок, вход по коду комнаты,
 * возврат к своей ноде. Раньше поправку получал только новичок и только выбранная «самая свободная»: напарники хоста по коду
 * в неё не шли (живой кластер, 2 ноды, 6 пати по 4 — 5 комнат на одной ноде и 1 на другой: хосты следующих пати видели
 * ноду первой почти пустой), герой, закреплённый за другой нодой, засчитывался не той, а поток входов по коду в окне между
 * сердцебиениями видел одну и ту же сумму и проходил потолок кластера целиком, мимо запаса ноды (R6-08).
 */
function noteIssued(node: NodeRow): Issued {
  const e: Issued = { node: node.id, at: monotonicMs(), beat: node.beat_ms };
  const list = issued.get(node.id) ?? [];
  list.push(e);
  issued.set(node.id, list);
  return e;
}

/** Снять направление (не впустили — место не держит). */
function dropIssued(e: Issued): void {
  const list = issued.get(e.node);
  const i = list ? list.indexOf(e) : -1;
  if (i < 0) return;
  list!.splice(i, 1);
  if (!list!.length) issued.delete(e.node);
}

/**
 * ⭐ E2E 27.09: направление ЗАСЧИТЫВАЕТСЯ В ТОМ ЖЕ ШАГЕ, ГДЕ СЧИТАЛИ СУММУ, — до следующего ожидания базы (очередь,
 * закрепление): одновременные маршруты переплетаются на ожиданиях, и засчитанное после них все видели «ещё не засчитанным» —
 * всплеск ехал на одну ноду и проходил потолок разом (перезапуск кластера — тысяча одновременных реконнектов). Узнали, что
 * нода другая (закрепление за другой, вход по коду), — направление переезжает туда.
 */
function moveIssued(e: Issued, node: NodeRow): void {
  if (e.node === node.id) return;
  dropIssued(e);
  const list = issued.get(node.id) ?? [];
  list.push({ ...e, node: node.id, beat: node.beat_ms });
  issued.set(node.id, list);
}

/**
 * ⭐ R13-08: АДРЕС НОДЫ — С ПРОПУСКОМ МАРШРУТА (`lp`): сессию этого токена гейтвей только что проверил, и лобби ноды не заставит её
 * платить бакет сети адреса наравне с чужими токенами (нода знает сессии только со своего старта). Ключа нет — адрес как есть.
 */
function withPass(url: string, token: string): string {
  const pass = routePass(token);
  return pass ? `${url}${url.includes('?') ? '&' : '?'}lp=${encodeURIComponent(pass)}` : url;
}

/**
 * `canRead` — кто может читать служебное состояние кластера (R6-20): по умолчанию — только прямой вызов с самой машины;
 * `index.ts` передаёт правило `/metrics` (и ключ чтения метрик, `internalReader`).
 */
export function installGatewayRoutes(
  app: Express,
  o: { canRead?: (req: Request) => boolean } = {},
): void {
  const canRead = o.canRead ?? ((req: Request): boolean => localCaller(req.headers, req.socket.remoteAddress, req.socket.remotePort));
  /**
   * Куда подключаться. Возвращает либо адрес ноды, либо место в очереди.
   * Клиент зовёт это ПЕРЕД открытием сокета и после каждого разрыва.
   */
  app.get('/api/route', (req: Request, res: Response) => {
    void (async () => {
      // ⭐ R4-21: СТРОКИ ЗАПРОСА — ДО БАЗЫ. Раньше `?charId=%00` (и такой же билет очереди) уходил в Postgres, тот отвергал
      // байт 0x00, и КАЖДЫЙ такой запрос любого вошедшего игрока давал 500 со стеком в логе — без лимита. Кривое — 4xx, базе
      // его не видать: токен — вид сессии, id героя — правило провода, билет — вид `randomUUID`, код комнаты — вид кода.
      const token = bearer(req);
      if (!token || !WIRE_TOKEN_RE.test(token)) return res.status(401).json({ error: 'Требуется вход' });
      // ⭐ R7-05: значение — только строкой (`queryText`): `?charId[toString]=1` разборщик express делает объектом, и `String()` на
      // нём бросал — 500 и стек в лог на каждый анонимный запрос (токен нужен лишь того вида, в базу до броска не ходили).
      const charId = queryText(req.query.charId);
      if (charId === undefined || !WIRE_CHAR_ID_RE.test(charId)) return res.status(400).json({ error: 'Неверный id персонажа' });
      const ticket = queryText(req.query.ticket);
      if (ticket === undefined || (ticket && !TICKET_RE.test(ticket))) return res.status(400).json({ error: 'Неверный билет очереди' });
      const code = queryText(req.query.roomCode)?.toUpperCase();
      if (code === undefined || (code && !ROOM_CODE_RE.test(code))) return res.status(400).json({ error: 'Неверный код комнаты' });

      // ⭐ R9-12: сессия — под бакетом сети адреса (`sessionUser`): потолок маршрута ниже держит аккаунт, то есть стоит ПОСЛЕ базы,
      // и поток случайных токенов правильного вида ходил в общую базу без предела.
      const userId = await sessionUser(req, res, token);
      if (!userId) return;
      // R4-21: каждый маршрут пишет закрепление героя в базу — не чаще потолка аккаунта.
      if (!limits.route.take(userId)) {
        res.setHeader('Retry-After', String(limits.route.retryAfterSec(userId)));
        return res.status(429).json({ error: 'Слишком часто. Попробуйте позже' });
      }

      const owned = await getCharacter(charId);
      if (!owned || owned.userId !== userId) return res.status(403).json({ error: 'Персонаж недоступен' });

      const nodes = await liveNodes();
      if (!nodes.length) return res.status(503).json({ error: 'Игровые узлы недоступны' });
      settleIssued(nodes);   // E2E 27.09: поправка — до всех сумм ниже (потолок, самая свободная)

      // ⭐ R5-13: код комнаты — только полный (буква ноды + знаки, R4-18). Раньше хватало одной буквы: `?roomCode=A` отдавал
      // адрес первой ноды мимо очереди, а дальше вход без кода туда же.
      if (code && code.length !== ROOM_CODE_LEN) return res.status(404).json({ error: 'Комната не найдена' });

      // 1. Очередь: считаем ПЕРЕД закреплением, иначе место занимает тот, кого не пустили. ⭐ R5-13: и ПЕРЕД маршрутом по коду
      // — раньше он отдавал адрес ноды до проверки потолка, и очередь обходилась входом «к другу».
      //
      // К числу игроков из реестра ОБЯЗАТЕЛЬНО прибавляем уже выданные направления: показатели
      // приходят раз в две секунды, а полсотни человек заходят за доли секунды. Без этой
      // поправки потолок не срабатывает вовсе — проверено, пропустило всех 50 при потолке 30.
      // Нода по коду комнаты (буква кода) — известна сразу, без базы.
      const byLetter = code ? nodes.find((n) => nodeLetter(n.id) === code[0]) : undefined;
      // Направление этого маршрута — засчитывается синхронно с суммой, до ожиданий базы (см. `moveIssued`).
      let mine: Issued | undefined;
      if (MAX_PLAYERS > 0) {
        // ⭐ R6-08: ВОЗВРАЩЕНИЕ — НЕ НОВЫЙ ВХОД. Клиенты спрашивают маршрут перед каждым подключением и реконнектом (R4-13), и
        // на потолке герой, чья связь моргнула посреди забега, вставал в очередь вместо своей грейс-комнаты (а пати тем
        // временем могла уйти с этажа, R4-14). Живое закрепление (сессия, грейс, прощальная запись) ведёт к своей ноде.
        const liveAt = await liveClaim(charId);
        const home = liveAt ? nodes.find((n) => n.id === liveAt) : undefined;
        if (home) {
          noteIssued(home);
          if (ticket) await dropTicket(ticket, userId);
          return res.json({ url: withPass(home.url, token), node: home.id, reason: 'закреплён за узлом' });
        }
        const total = nodes.reduce((a, n) => a + n.players, 0) + pendingIssued();
        // ⭐ R6-08: к другу по коду — в пределах запаса ноды, а не в общей очереди (см. `partyHeadroom`).
        if (code && total < MAX_PLAYERS + partyHeadroom(MAX_PLAYERS)) {
          if (byLetter) mine = noteIssued(byLetter);
          if (ticket) await dropTicket(ticket, userId);
        } else {
          const provisional = (code ? byLetter : leastLoaded(nodes)) ?? nodes[0]!;
          mine = noteIssued(provisional);
          const q1r = await admit(ticket, userId, MAX_PLAYERS - total);
          if (!q1r.admitted) { dropIssued(mine); return res.status(503).json(q1r.body); }
        }
      } else if (ticket) {
        await q('DELETE FROM login_queue WHERE ticket = $1', [ticket]);   // потолка нет — билет не нужен
      }

      // 2. По коду комнаты — к другу.
      if (code) {
        if (byLetter) {
          if (mine) moveIssued(mine, byLetter); else noteIssued(byLetter);
          return res.json({ url: withPass(byLetter.url, token), node: byLetter.id, reason: 'по коду комнаты' });
        }
        if (mine) dropIssued(mine);
        return res.status(404).json({ error: 'Комната не найдена: узел не отвечает' });
      }

      // 3. Свой персонаж возвращается на свою ноду; новый — на самую свободную. Засчитано до ожидания закрепления: выбор
      // «самой свободной» и счёт — один шаг, иначе одновременные новички видели бы одну и ту же картину.
      const free = (mine ? nodes.find((n) => n.id === mine!.node) : undefined) ?? leastLoaded(nodes) ?? nodes[0]!;
      mine ??= noteIssued(free);
      const nodeId = await claimChar(charId, free.id);
      const target = nodes.find((n) => n.id === nodeId) ?? free;
      moveIssued(mine, target);
      res.json({ url: withPass(target.url, token), node: target.id, reason: target.id === free.id ? 'самая свободная' : 'закреплён за узлом' });
    })().catch((e: unknown) => {
      warnRoute(e);
      if (!res.headersSent) res.status(500).json({ error: 'Внутренняя ошибка' });
    });
  });

  /**
   * Состояние кластера — для мониторинга и стенда.
   * ⭐ R6-20: ТОЛЬКО СЛУЖЕБНО (правило `/metrics`, R3-03: с самой машины или ключом чтения) и из кэша на секунду. Раньше
   * ручка отвечала любому — игроки, комнаты, слив, частота тика, лаг цикла, память и адреса нод, — и каждый анонимный
   * запрос шёл в базу за узлами.
   */
  const clusterBody = cachedJson(async () => {
    const nodes = await liveNodes();
    return {
      players: nodes.reduce((a, n) => a + n.players, 0),
      rooms: nodes.reduce((a, n) => a + n.rooms, 0),
      maxPlayers: MAX_PLAYERS || null,
      nodes: nodes.map((n) => ({
        id: n.id, url: n.url, players: n.players, rooms: n.rooms,
        draining: n.draining, tickHz: n.tick_hz, loopP99: n.loop_p99_ms,
        rssMb: Math.round(Number(n.rss_bytes) / 1048576),
      })),
    };
  }, CLUSTER_CACHE_MS);
  app.get('/api/cluster', (req: Request, res: Response) => {
    if (!canRead(req)) return res.status(403).end();
    void clusterBody.get()
      .then(({ body }) => { res.type('application/json').send(body); })
      .catch(() => { if (!res.headersSent) res.status(500).json({ error: 'Внутренняя ошибка' }); });
  });

  // Узлы, переставшие подавать признаки жизни, не должны копиться в реестре.
  setInterval(() => { void sweepNodes().catch(() => undefined); }, 30_000).unref();

  installNightlyAudit();
}

/**
 * Ночной аудит инвариантов (Ф2.6) — на гейтвее, потому что он в кластере один: гоняй его
 * каждая нода, проверка шла бы восемь раз за ночь и наперегонки.
 *
 * Час задаётся `DM_AUDIT_HOUR` (по умолчанию 4 утра — самое пустое время). Проверяем раз
 * в десять минут, наступил ли нужный час и не гоняли ли мы уже сегодня: это надёжнее
 * одного длинного таймера, который переживёт перевод часов и паузу процесса.
 *
 * НАХОДКА — НЕ ДЕЙСТВИЕ. Задача только считает и пишет в историю; чинить и наказывать
 * будет человек, глядя на выгрузку.
 */
function installNightlyAudit(): void {
  const hour = Number(process.env.DM_AUDIT_HOUR ?? 4);
  let lastDay = '';
  const tick = async (): Promise<void> => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getHours() !== hour || day === lastDay) return;
    lastDay = day;
    const { runAudit, formatAudit, saveAuditRun } = await import('../db/audit.js');
    const r = await runAudit();
    await saveAuditRun(r);
    // В лог отчёт уходит ЦЕЛИКОМ: если инцидент был, разбирать его будут по логу,
    // а не по одной строке «нашлось 3».
    console.log(`[аудит] ночной прогон
${formatAudit(r)}`);
    if (r.incidents > 0) {
      console.error(`[аудит] ИНЦИДЕНТ: нарушений инвариантов ${r.incidents} — требуется разбор человеком`);
    }
  };
  setInterval(() => { void tick().catch((e: unknown) => console.error('[аудит] прогон не удался:', e)); }, 10 * 60_000).unref();
}

/**
 * Очередь на вход. Билет выдаётся один раз, дальше клиент приходит с ним и получает своё
 * место. Пускаем столько, сколько освободилось мест, начиная с головы очереди.
 *
 * ⭐ R6-08: ПО МЕСТУ В ОЧЕРЕДИ. Раньше `admit` звался только на потолке и получал «свободных мест» ≤ 0 — по месту не пускали
 * никого; освободившееся место брал первый пришедший (новый вход без билета обгонял всех, кто ждал), а продление билета
 * `SET at = at` ничего не продлевало: через минуту честного ожидания билет исчезал, и клиент видел «1 из N» навсегда.
 * Теперь:
 *  • место — `at` (не меняется), срок — от последнего опроса (`seen_at`);
 *  • билет — только своего аккаунта (местом в голове очереди не поделиться), а потерянный (перезагрузка страницы) —
 *    находится по аккаунту: своё место не теряется и второе не занимается;
 *  • очередь не пуста — входит лишь тот, перед кем меньше людей, чем свободных мест; новичок без билета — в хвост.
 */
async function admit(ticket: string, userId: string, freeSlots: number)
  : Promise<{ admitted: boolean; body?: unknown }> {
  await q(`DELETE FROM login_queue WHERE seen_at < now() - ($1 || ' seconds')::interval`, [String(TICKET_TTL_SEC)]);

  let mine = ticket
    ? (await q1<{ ticket: string }>(
      'UPDATE login_queue SET seen_at = now() WHERE ticket = $1 AND user_id = $2 RETURNING ticket', [ticket, userId]))?.ticket
    : undefined;
  mine ??= (await q1<{ ticket: string }>(
    `UPDATE login_queue SET seen_at = now()
     WHERE ticket = (SELECT ticket FROM login_queue WHERE user_id = $1 ORDER BY at, ticket LIMIT 1)
     RETURNING ticket`, [userId]))?.ticket;
  if (!mine) {
    // Очереди нет и место есть — билет не нужен.
    if (freeSlots > 0 && !(await q1('SELECT 1 AS one FROM login_queue LIMIT 1'))) return { admitted: true };
    mine = randomUUID();
    await q('INSERT INTO login_queue (ticket, user_id) VALUES ($1, $2)', [mine, userId]);
  }
  const pos = await q1<{ n: string }>(
    `SELECT COUNT(*) n FROM login_queue
     WHERE (at, ticket) < (SELECT at, ticket FROM login_queue WHERE ticket = $1)`, [mine]);
  const ahead = Number(pos?.n ?? 0);
  if (ahead < freeSlots) {
    await q('DELETE FROM login_queue WHERE ticket = $1', [mine]);
    return { admitted: true };
  }
  const total = await q1<{ n: string }>('SELECT COUNT(*) n FROM login_queue');
  return { admitted: false, body: { queue: { ticket: mine, position: ahead + 1, total: Number(total?.n ?? 0) } } };
}

/** R6-08: билет больше не нужен (вошёл мимо очереди — возвращение, вход к другу). Только свой. */
async function dropTicket(ticket: string, userId: string): Promise<void> {
  await q('DELETE FROM login_queue WHERE ticket = $1 AND user_id = $2', [ticket, userId]);
}

/**
 * Метрики КЛАСТЕРА в формате Prometheus. Складываем показатели узлов из реестра: мониторинг
 * и нагрузочный стенд должны видеть работу всех процессов, а не того одного, который игру
 * как раз и не ведёт.
 *
 * Имена намеренно те же, что у одиночного процесса (`dm_cpu_*`, `dm_tick_hz`, `dm_rss_bytes`),
 * поэтому стенд и дашборд работают с кластером без единой правки.
 */
export async function clusterMetrics(): Promise<string> {
  const nodes = await liveNodes();
  const sum = (f: (n: NodeRow) => number): number => nodes.reduce((a, n) => a + f(n), 0);
  const players = sum((n) => n.players);
  const rooms = sum((n) => n.rooms);
  // Частота симуляции по кластеру — среднее по узлам, взвешенное по числу комнат:
  // узел без комнат не должен тянуть среднее вниз.
  const hz = rooms > 0 ? sum((n) => n.tick_hz * n.rooms) / rooms : 0;
  const out: string[] = [];
  const g = (name: string, help: string, v: number, type = 'gauge'): void => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, `${name} ${v}`);
  };
  g('dm_nodes', 'Живых игровых узлов в кластере', nodes.length);
  g('dm_nodes_draining', 'Узлов в состоянии слива', nodes.filter((n) => n.draining).length);
  g('dm_players', 'Игроков в кластере', players);
  g('dm_rooms', 'Комнат в кластере', rooms);
  g('dm_tick_hz', 'Частота симуляции, взвешенная по комнатам', Number(hz.toFixed(2)));
  g('dm_loop_delay_p99_ms', 'Худший лаг цикла среди узлов', Number(Math.max(0, ...nodes.map((n) => n.loop_p99_ms)).toFixed(2)));
  g('dm_rss_bytes', 'Суммарная резидентная память узлов', sum((n) => Number(n.rss_bytes)));
  // Процессорное время всех узлов вместе: стенд считает по нему загрузку кластера.
  g('dm_cpu_user_seconds_total', 'Процессорное время узлов (сумма)', Number(sum((n) => n.cpu_seconds).toFixed(3)), 'counter');
  g('dm_cpu_system_seconds_total', 'Учтено в dm_cpu_user_seconds_total', 0, 'counter');
  const queued = await q1<{ n: string }>('SELECT COUNT(*) n FROM login_queue');
  g('dm_login_queue', 'Игроков в очереди на вход', Number(queued?.n ?? 0));
  return `${out.join('\n')}\n`;
}

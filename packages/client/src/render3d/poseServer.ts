/**
 * РАБОЧАЯ КОПИЯ И ПУБЛИКАЦИЯ контента 3D поз-редактора (Ф12).
 *
 * ⭐ ГЛАВНОЕ ПРАВИЛО: **сервер НИКОГДА не затирает рабочую копию.** Локальное — истина редактора; на сервер
 * уходит только по кнопке «Опубликовать».
 *
 * ПОЧЕМУ ПЕРЕДЕЛАНО (замер, а не вкусовщина). Раньше здесь стояло «сервер выигрывает»: `syncPoseFromServer`
 * на КАЖДОЙ загрузке писал серверное значение поверх localStorage. Проверка живьём: записали в `pe_ui` поле
 * `__offlineProbe` и `aSkel = 0.11` без отправки на сервер → F5 → поле исчезло, `aSkel` вернулся в 0.5.
 * Любая правка, не долетевшая до сервера (сервер не запущен, POST упал, гонка fire-and-forget), пропадала
 * молча. Плюс `savePoseKey` шлёт ключ ЦЕЛИКОМ, поэтому вкладка со старым снимком при первом же сохранении
 * затирала на сервере всё, что появилось позже, — так пропал клип `hit_axe`.
 *
 * ТРИ УРОВНЯ ХРАНЕНИЯ (модель Unity: `ProjectSettings` в VCS, `UserSettings`/`Library` — никогда):
 *  • `pe_prefs` (см. `editorPrefs.ts`) — ЛИЧНЫЕ настройки инструмента, на сервер не уходят вообще;
 *  • `pe_*` — РАБОЧАЯ КОПИЯ контента: её читают редактор и локальная игра (ключи не переименованы намеренно —
 *    иначе пришлось бы править сотню мест чтения, а поведение чтения и так уже правильное);
 *  • сервер — опубликованное; его РЕВИЗИИ держим в `pe_sync`, а тела тянем по требованию.
 *
 * РЕВИЗИЯ = `pose_store.updatedAt` (уже есть в схеме БД, менять её не понадобилось). Публикация шлёт
 * `__baseRev` — ревизию, на которой основана рабочая копия; если на сервере новее, сервер отвечает **409 и
 * НИЧЕГО не пишет** (замок от затирания чужой правки). Это «версии, чтобы конкурентную правку было ВИДНО»
 * из offline-first — CRDT тут не нужен: автор один, конфликт редкий, но терять его молча нельзя.
 *
 * API сервера: `GET /api/pose` (тела), `GET /api/pose/rev` (ревизии), `POST /api/dev/pose` (DEV-only).
 *
 * ⚠ `pe_roadmap` — трекер вех проекта (вкладка «Роадмап» в конфиг-редакторе). Он тут, а НЕ в игровом
 * конфиге, намеренно: `ConfigRegistry.loadAll()` бросает исключение на невалидном ключе, то есть
 * опечатка в задаче проекта уронила бы игровой сервер. Здесь запись и так DEV-only, а связи с игрой нет.
 */
import { devFetch } from '../devAuth.js';   // публикация — инструментальный роут: нужен токен админа
export const POSE_KEYS = ['pe_gait', 'pe_clips', 'pe_sway', 'pe_phys', 'pe_ragdoll', 'pe_chars', 'pe_attacks', 'pe_loco', 'pe_appearance', 'pe_shield', 'pe_twist', 'pe_models', 'pe_grip', 'pe_ui', 'pe_gripposes', 'pe_morph', 'pe_morph_range', 'pe_poselib', 'pe_ai', 'pe_bonemaps', 'pe_roadmap', 'pe_anim'] as const;
export type PoseKey = typeof POSE_KEYS[number];

/** Состояние синка (ЛИЧНОЕ, на сервер не уходит): на какой ревизии основана рабочая копия и что в ней правлено. */
interface SyncState {
  /** ключ → `updatedAt` сервера, НА КОТОРОЙ основана наша рабочая копия (база для 409). */
  base: Record<string, number>;
  /** ключ → правлено локально после последней публикации. */
  dirty: Record<string, true>;
  /** ключ → `updatedAt`, увиденный на сервере последней проверкой (для бейджа «на сервере новее»). */
  seen: Record<string, number>;
}
const SYNC_KEY = 'pe_sync';
const readLS = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const writeLS = (k: string, v: string): void => { try { localStorage.setItem(k, v); } catch { /* приватный режим/переполнение */ } };

function readSync(): SyncState {
  try {
    const s = JSON.parse(readLS(SYNC_KEY) ?? '{}') as Partial<SyncState>;
    return { base: s.base ?? {}, dirty: s.dirty ?? {}, seen: s.seen ?? {} };
  } catch { return { base: {}, dirty: {}, seen: {} }; }
}
function writeSync(s: SyncState): void { writeLS(SYNC_KEY, JSON.stringify(s)); }

/** Есть ли у ключа рабочая копия (её отсутствие — единственный случай, когда серверное можно класть молча). */
const hasLocal = (key: string): boolean => readLS(key) !== null;

// ── Правки ───────────────────────────────────────────────────────────────────────────────────────
/**
 * Пометить ключ изменённым. Значение писать НЕ надо — вызывающий уже положил его в localStorage
 * (сигнатура сохранена ровно поэтому: 36 мест вызова в редакторе менять не пришлось).
 * ⚠ В сеть здесь больше НЕ ходим: публикация — отдельное осознанное действие.
 */
export function savePoseKey(key: string): void {
  const s = readSync(); s.dirty[key] = true; writeSync(s);
  notify();
}

/** Ключи с неопубликованными правками (счётчик на кнопке «Опубликовать»). */
export function dirtyKeys(): string[] { const s = readSync(); return Object.keys(s.dirty).filter((k) => s.dirty[k]); }

/** Ключи, где сервер ушёл вперёд относительно нашей базы (бейдж «на сервере новее»). */
export function serverAheadKeys(): string[] {
  const s = readSync();
  return Object.keys(s.seen).filter((k) => (s.seen[k] ?? 0) > (s.base[k] ?? 0));
}

/** Подписка на изменение состояния (кнопка публикации перерисовывает счётчик). */
type Listener = () => void;
const listeners = new Set<Listener>();
export function onSyncChange(fn: Listener): () => void { listeners.add(fn); return () => listeners.delete(fn); }
function notify(): void { for (const fn of listeners) { try { fn(); } catch { /* слушатель не должен ронять сохранение */ } } }
/** Дёрнуть слушателей извне: правки конфига живут в своём слое (`configEdits.ts`), а счётчик на кнопке
 *  публикации ОДИН на всё — двух разных «сохранить» в интерфейсе быть не должно. */
export const notifySyncChange = notify;

// ── Загрузка ─────────────────────────────────────────────────────────────────────────────────────
/**
 * Boot: узнать ревизии сервера и ДОЗАПОЛНИТЬ то, чего локально нет. Существующую рабочую копию не трогаем
 * НИКОГДА — в этом вся правка. Офлайн переживаем тихо (работаем на рабочей копии).
 */
export async function syncPoseFromServer(): Promise<void> {
  const revs = await fetchRevs();
  const missing = POSE_KEYS.filter((k) => !hasLocal(k));
  const s = readSync();
  if (revs) { s.seen = { ...s.seen, ...revs }; }

  if (missing.length) {
    // Первый запуск / новая машина: тел у нас нет, значит взять серверные — не затирание, а заполнение.
    const data = await fetchAll();
    if (data) {
      for (const k of missing) {
        if (k in data && data[k] !== undefined) {
          writeLS(k, JSON.stringify(data[k]));
          s.base[k] = revs?.[k] ?? 0;
          delete s.dirty[k];
        }
      }
    }
  }
  // Ключи, которые есть локально, но сервер о них не знает: считаем неопубликованными (иначе тихо потеряются).
  for (const k of POSE_KEYS) if (hasLocal(k) && revs && !(k in revs)) s.dirty[k] = true;
  for (const k of POSE_KEYS) {
    if (!revs || !(k in revs)) continue;
    // ПЕРВАЯ ВСТРЕЧА ключа: наша рабочая копия основана ровно на том, что сейчас на сервере, — фиксируем базу
    // даже для правленого. Иначе база оставалась 0 и бейдж «на сервере новее» горел бы ВСЕГДА (поймано живьём).
    if (s.base[k] === undefined) { s.base[k] = revs[k]!; continue; }
    // Дальше базу двигает только отсутствие своих правок: если мы ничего не меняли, спорить не о чем.
    if (!s.dirty[k]) s.base[k] = revs[k]!;
  }
  writeSync(s);
  notify();
}

/** Ревизии сервера: `{ключ: updatedAt}`. null — сервера нет. */
export async function fetchRevs(): Promise<Record<string, number> | null> {
  try {
    const res = await fetch('/api/pose/rev');
    if (!res.ok) return null;
    return await res.json() as Record<string, number>;
  } catch { return null; }
}

async function fetchAll(): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch('/api/pose');
    if (!res.ok) return null;
    return await res.json() as Record<string, unknown>;
  } catch { return null; }
}

/** Перепроверить сервер (кнопка «обновить»/периодически): обновляет `seen`, ничего не пишет в контент. */
export async function refreshServerRevs(): Promise<boolean> {
  const revs = await fetchRevs();
  if (!revs) return false;
  const s = readSync(); s.seen = { ...s.seen, ...revs }; writeSync(s); notify();
  return true;
}

/**
 * Взять серверное поверх рабочей копии — ЯВНОЕ действие («на сервере новее → взять серверное»).
 * Единственное место, где серверное значение перезаписывает локальное, и оно всегда по кнопке.
 */
export async function pullFromServer(keys: readonly string[]): Promise<string[]> {
  const [data, revs] = await Promise.all([fetchAll(), fetchRevs()]);
  if (!data) return [];
  const s = readSync(); const got: string[] = [];
  for (const k of keys) {
    if (!(k in data) || data[k] === undefined) continue;
    writeLS(k, JSON.stringify(data[k]));
    s.base[k] = revs?.[k] ?? 0; if (revs?.[k] !== undefined) s.seen[k] = revs[k]!;
    delete s.dirty[k]; got.push(k);
  }
  writeSync(s); notify();
  return got;
}

// ── Публикация ───────────────────────────────────────────────────────────────────────────────────
export interface PublishResult {
  ok: boolean;
  /** Опубликованные ключи. */
  saved: string[];
  /** Ключи, где на сервере оказалось новее: публикация ОТМЕНЕНА целиком, ничего не записано. */
  conflicts: string[];
  /** Человеческая причина неудачи (нет сервера, запрещено в проде, мусор в данных). */
  error?: string;
}

/**
 * ЧИСТЫЙ ЛИСТ: снести ВЕСЬ авторский контент — и рабочую копию, и опубликованное.
 *
 * Зачем такая кнопка вообще. Настройки копятся в десятке ключей (`pe_gait`, `pe_grip`, `pe_phys`,
 * `pe_anim`…), живут в трёх местах (рабочая копия, сервер, правки конфига) и переживают удаление
 * модели — поэтому «загрузил модель заново, а она садится как раньше» выглядит мистикой, хотя это
 * просто старые числа из прошлой жизни. Ручная чистка по ключу нереальна: их не видно.
 *
 * ⚠ Операция НЕОБРАТИМАЯ и спрашивается дважды в UI. Здесь только механика.
 *
 * Что сносится: все ключи `pe_*` в рабочей копии (кроме ЛИЧНЫХ `pe_prefs`/`pe_sync` — это настройки
 * инструмента, а не контент), все ключи на сервере и оверрайд секции `models` в конфиге (иначе
 * список моделей вернётся с сервера при первой же загрузке).
 */
export async function wipeAll(): Promise<{ local: string[]; server: string[]; failed: string[] }> {
  const server: string[] = [], failed: string[] = [];
  let revs: Record<string, number> = {};
  try { const r = await fetch('/api/pose/rev'); if (r.ok) revs = await r.json() as Record<string, number>; } catch { /* сервера нет — чистим локальное */ }
  for (const k of Object.keys(revs)) {
    try {
      const r = await devFetch('/api/dev/pose/' + encodeURIComponent(k), { method: 'DELETE' });
      if (r.ok) server.push(k); else failed.push(k + ' (' + r.status + ')');
    } catch { failed.push(k + ' (сеть)'); }
  }
  // ⚠ МОДЕЛИ: пишем ПУСТОЙ оверрайд, а не удаляем его. Удаление возвращает секцию к ДЕФОЛТУ, а дефолт
  // — это `models.json`, который запущенный сервер держит В ПАМЯТИ (файл перечитается только при
  // рестарте процесса). То есть «сбросить к дефолту» возвращало ровно тот список, который сносим.
  try {
    const r = await devFetch('/api/dev/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ models: [] }) });
    if (!r.ok) failed.push('config:models (' + r.status + ')');
  } catch { failed.push('config:models (сеть)'); }

  const local: string[] = [];
  try {
    const keep = new Set(['pe_prefs', SYNC_KEY]);            // личные настройки инструмента — не контент
    const all: string[] = [];
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('pe_') && !keep.has(k)) all.push(k); }
    for (const k of all) { localStorage.removeItem(k); local.push(k); }
    writeSync({ base: {}, dirty: {}, seen: {} });            // синк начинается с нуля
  } catch { /* приватный режим — нечего чистить */ }
  // ПРОВЕРКА, А НЕ НАДЕЖДА: если на сервере что-то осталось, редактор при следующей же загрузке
  // притащит это обратно (`syncPoseFromServer` тянет всё, чего нет локально). Молчать про такое нельзя.
  try {
    const r = await fetch('/api/pose/rev');
    if (r.ok) { const left = Object.keys(await r.json() as Record<string, number>); if (left.length) failed.push('на сервере осталось: ' + left.join(', ')); }
  } catch { /* сервера нет — проверять нечего */ }
  notify();
  return { local, server, failed };
}

/**
 * ПОДГОТОВКА ЗНАЧЕНИЯ К ОТПРАВКЕ. Рабочая копия и то, что уезжает в игру, — не всегда одно и то же:
 * есть каналы, которые в редакторе живут ОТДЕЛЬНО (чтобы их можно было править), а наружу обязаны
 * уехать ЗАПЕЧЁННЫМИ в данные. Так решено по хвату: «из редактора будут отправляться готовые
 * анимации». Локальную копию преобразование не трогает — только тело запроса.
 */
type PublishPrepare = (key: string, value: unknown) => unknown;
let prepare: PublishPrepare | null = null;
export function setPublishPrepare(fn: PublishPrepare | null): void { prepare = fn; }

/**
 * Опубликовать рабочую копию на сервер. Без аргумента — всё изменённое.
 * Шлём `__baseRev`, поэтому сервер отвергает публикацию поверх более новой чужой правки (409) вместо того,
 * чтобы молча её потерять.
 */
export async function publish(keys?: readonly string[]): Promise<PublishResult> {
  const s = readSync();
  const list = (keys ?? dirtyKeys()).filter((k) => hasLocal(k));
  if (!list.length) return { ok: true, saved: [], conflicts: [] };

  const body: Record<string, unknown> = { __baseRev: {} as Record<string, number> };
  const baseRev = body.__baseRev as Record<string, number>;
  for (const k of list) {
    try {
      const raw: unknown = JSON.parse(readLS(k) ?? 'null');
      body[k] = prepare ? prepare(k, raw) : raw;
    } catch { continue; }
    baseRev[k] = s.base[k] ?? 0;
  }

  let res: Response;
  try {
    res = await devFetch('/api/dev/pose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch { return { ok: false, saved: [], conflicts: [], error: 'сервер недоступен — правки остались локально' }; }

  if (res.status === 409) {
    let conflicts: string[] = [];
    try { conflicts = ((await res.json()) as { conflicts?: string[] }).conflicts ?? []; } catch { /* */ }
    void refreshServerRevs();
    return { ok: false, saved: [], conflicts, error: 'на сервере новее — публикация отменена' };
  }
  if (!res.ok) {
    let msg = 'сервер отказал (' + res.status + ')';
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* */ }
    return { ok: false, saved: [], conflicts: [], error: msg };
  }

  let rev: Record<string, number> = {};
  try { rev = ((await res.json()) as { rev?: Record<string, number> }).rev ?? {}; } catch { /* */ }
  const st = readSync();
  for (const k of list) { st.base[k] = rev[k] ?? Date.now(); st.seen[k] = st.base[k]; delete st.dirty[k]; }
  writeSync(st); notify();
  return { ok: true, saved: [...list], conflicts: [] };
}

// ── Конфиг (модели/материалы/текстуры) ───────────────────────────────────────────────────────────
/** Кэш эффективного СЕРВЕРНОГО конфига в `pe_config` — читают ростер, игра и вкладка «Модели» (синхронно).
 *  Правки конфига живут ОТДЕЛЬНО, в рабочей копии (`configEdits.ts`), и этот кэш не портят. */
export async function syncConfigFromServer(): Promise<void> {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) return;
    const snapshot = await res.json();
    writeLS('pe_config', JSON.stringify(snapshot));
  } catch { /* сервер недоступен — работаем на прежнем кэше/встроенных дефолтах */ }
}

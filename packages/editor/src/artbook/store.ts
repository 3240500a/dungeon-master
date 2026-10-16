/**
 * ⭐ 16.10 (Артбук): ХРАНЕНИЕ документа `pe_artbook` — правки текстов, картинки слотов, статусы.
 *
 * Как у «Роадмапа» (`roadmap.ts`): ключ живёт в `pose_store` (DEV-запись, с игрой не связан — игровой конфиг не трогаем),
 * пишется в localStorage СРАЗУ, на сервер — с задержкой 900 мс через `POST /api/dev/pose` (`devFetch`: токен админа).
 *
 * ОТЛИЧИЕ ОТ РОАДМАПА — СЛИЯНИЕ, А НЕ «ЛОКАЛЬНОЕ — ИСТИНА». Артбук правят с двух машин (картинки с одной, тексты с другой), а
 * документ — словари, где каждая запись живёт сама по себе (`mergeArtbook`), поэтому:
 *  • на загрузке локальная копия сливается с серверной; разошлись — слитое уходит на сервер;
 *  • запись идёт с замком `__baseRev` (как публикация поз-редактора): сервер новее → 409 → тянем серверное, сливаем, повторяем;
 *  • при возврате на вкладку сверяется ревизия (`/api/pose/rev`, мелкий ответ), тело тянется только если она ушла.
 * Кнопки «забрать с сервера» не нужно: потерять чужую правку тут нечем.
 *
 * Сервера нет / прав нет — работаем на локальной копии, в шапке честная надпись; ничего не падает.
 */
import { devFetch } from '@dm/client/devAuth.js';
import { EMPTY_ARTBOOK, canonArtbook, mergeArtbook, normalizeArtbook, type ArtbookDoc } from './model.js';

export const LS_KEY = 'pe_artbook';
/** Ревизия сервера, на которой основана локальная копия (замок записи). */
const LS_SEEN = 'pe_artbook_seen';

export type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'offline' | 'denied';
export const SAVE_LABEL: Record<SaveState, string> = {
  idle: '', pending: 'сохраняю…', saving: 'сохраняю…', saved: 'сохранено ✓',
  offline: '⚠ сервер недоступен — правки лежат в этом браузере',
  denied: '⚠ нет прав на запись (нужен вход администратора) — правки лежат в этом браузере',
};

type Kind = 'status' | 'content';
type Listener = (kind: Kind) => void;

let doc: ArtbookDoc = EMPTY_ARTBOOK();
let loaded = false;
let loading: Promise<void> | null = null;
let save: SaveState = 'idle';
let timer: ReturnType<typeof setTimeout> | null = null;
let lastCheck = 0;
const listeners = new Set<Listener>();

const emit = (kind: Kind): void => { for (const fn of listeners) { try { fn(kind); } catch { /* слушатель не роняет сохранение */ } } };
const setSave = (s: SaveState): void => { save = s; emit('status'); };

const readLocal = (): ArtbookDoc | null => {
  try { const s = localStorage.getItem(LS_KEY); return s ? normalizeArtbook(JSON.parse(s)) : null; } catch { return null; }
};
const writeLocal = (d: ArtbookDoc): void => { try { localStorage.setItem(LS_KEY, JSON.stringify(d)); } catch { /* приватный режим / переполнение */ } };
const seen = (): number => { try { return Number(localStorage.getItem(LS_SEEN) ?? 0) || 0; } catch { return 0; } };
const setSeen = (rev: number | undefined): void => { if (rev) { try { localStorage.setItem(LS_SEEN, String(rev)); } catch { /* */ } } };

/** Ревизия ключа на сервере: число, `0` — ключа нет, `null` — сервер недоступен. */
async function remoteRev(): Promise<number | null> {
  try {
    const r = await fetch('/api/pose/rev', { cache: 'no-store' });
    if (!r.ok) return null;
    const j = await r.json() as Record<string, number>;
    return j[LS_KEY] ?? 0;
  } catch { return null; }
}

/**
 * Тело с сервера. `null` — сервер недоступен; `{doc: null}` — ключа нет.
 * ⚠ Ревизия — СТРОГО ДО тела, не параллельно: вторая машина, записавшая между двумя чтениями, дала бы старое тело с новой
 * ревизией — замок записи (`__baseRev`) пропустил бы нас, и её правка ушла бы под слитое без неё. В этом порядке выходит
 * наоборот (новое тело, старая ревизия): запись получает 409 и сливает ещё раз — без потерь.
 */
async function remoteDoc(): Promise<{ doc: ArtbookDoc | null; rev: number } | null> {
  try {
    const rev = await remoteRev();
    if (rev === null) return null;
    const bodies = await fetch('/api/pose', { cache: 'no-store' }).then((r) => (r.ok ? r.json() as Promise<Record<string, unknown>> : null));
    if (!bodies) return null;
    const raw = bodies[LS_KEY];
    return { doc: raw === undefined ? null : normalizeArtbook(raw), rev };
  } catch { return null; }
}

/** Слить серверное в локальное. `true` — локальное изменилось (надо перерисовать). */
function absorb(remote: ArtbookDoc): boolean {
  const merged = mergeArtbook(doc, remote);
  if (canonArtbook(merged) === canonArtbook(doc)) return false;
  doc = merged;
  writeLocal(doc);
  return true;
}

async function loadOnce(): Promise<void> {
  doc = readLocal() ?? EMPTY_ARTBOOK();
  const remote = await remoteDoc();
  if (remote) {
    if (remote.doc) {
      const changed = absorb(remote.doc);
      setSeen(remote.rev);
      if (canonArtbook(doc) !== canonArtbook(remote.doc)) schedule();   // у нас есть то, чего нет на сервере
      if (changed) emit('content');
    } else if (Object.keys(doc.texts).length || Object.keys(doc.slots).length) schedule();   // ключа на сервере нет, а правки есть
  } else setSave('offline');
  loaded = true;
  lastCheck = Date.now();
}

function schedule(): void {
  if (save !== 'saving') setSave('pending');
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; void push(); }, 900);
}

async function push(attempt = 0): Promise<void> {
  setSave('saving');
  let r: Response;
  try {
    r = await devFetch('/api/dev/pose', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [LS_KEY]: doc, __baseRev: { [LS_KEY]: seen() } }),
    });
  } catch { setSave('offline'); return; }
  if (r.status === 409 && attempt < 2) {
    // На сервере новее (вторая машина): забрать, слить, записать слитое.
    const remote = await remoteDoc();
    if (!remote) { setSave('offline'); return; }
    if (remote.doc && absorb(remote.doc)) emit('content');
    setSeen(remote.rev);
    return push(attempt + 1);
  }
  if (r.status === 401 || r.status === 403) { setSave('denied'); return; }
  if (!r.ok) { setSave('offline'); return; }
  const j = await r.json().catch(() => ({})) as { rev?: Record<string, number> };
  setSeen(j.rev?.[LS_KEY]);
  if (timer) return;   // пока писали, пришла новая правка — её запишет следующий заход
  setSave('saved');
}

export const artbookStore = {
  /** Текущий документ (мутировать — функциями `model.ts`, затем `touch()`). */
  get doc(): ArtbookDoc { return doc; },
  get loaded(): boolean { return loaded; },
  get save(): SaveState { return save; },

  /** Загрузить один раз за жизнь страницы (повторные вызовы ждут ту же загрузку). */
  load(): Promise<void> { return (loading ??= loadOnce()); },

  /** Документ изменён: локально сразу, на сервер — через 900 мс. */
  touch(): void {
    doc.updatedAt = Date.now();
    writeLocal(doc);
    schedule();
  },

  /** Записать сейчас (не ждать задержки), если что-то ждёт записи. */
  async flush(): Promise<void> {
    if (!timer) return;
    clearTimeout(timer); timer = null;
    await push();
  },

  /**
   * Сверить с сервером (возврат на вкладку): дешёвая ревизия, тело — только если она ушла. Не чаще раза в 10 с.
   * `true` — пришли чужие правки (надо перерисовать).
   */
  async refresh(): Promise<boolean> {
    if (!loaded || Date.now() - lastCheck < 10_000) return false;
    lastCheck = Date.now();
    const rev = await remoteRev();
    if (rev === null || rev === 0 || rev === seen()) return false;
    const remote = await remoteDoc();
    if (!remote?.doc) return false;
    const changed = absorb(remote.doc);
    setSeen(remote.rev);
    if (canonArtbook(doc) !== canonArtbook(remote.doc)) schedule();
    if (changed) emit('content');
    return changed;
  },

  /** Подписка: `status` — сменилась надпись сохранения, `content` — пришли чужие правки. */
  subscribe(fn: Listener): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; },
};

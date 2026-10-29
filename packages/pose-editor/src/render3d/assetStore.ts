/**
 * ЛОКАЛЬНОЕ ХРАНИЛИЩЕ БИНАРЕЙ (IndexedDB) — чтобы редактор открывался и работал без сервера (Ф12.5).
 *
 * ЗАЧЕМ. Модели грузятся `fetch('/assets/<id>.glb')` с сервера. Без сервера «работа офлайн» получалась
 * половинчатой: настройки и клипы правятся, а модели нет — то есть настраивать сабмеши не на чем.
 * Теперь каждый успешно загруженный GLB оседает в IndexedDB и в следующий раз берётся оттуда.
 *
 * ПОЧЕМУ IndexedDB, А НЕ localStorage: там строки и общий бюджет (замер на этой машине — 761 КБ занято,
 * ~10 МБ потолок), а один персонажный GLB легко весит мегабайты. IndexedDB хранит `ArrayBuffer` как есть.
 *
 * Кэш — не истина: это ускорение и офлайн. Сеть, когда доступна, ВЫИГРЫВАЕТ (модель могли перезалить),
 * поэтому порядок «сеть → при неудаче кэш», а не наоборот.
 */
const DB_NAME = 'dm_assets';
const STORE = 'files';
const VERSION = 1;

let dbp: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  return (dbp ??= new Promise<IDBDatabase | null>((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);          // приватный режим/запрет — просто работаем без кэша
    } catch { resolve(null); }
  }));
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return open().then((db) => {
    if (!db) return null;
    return new Promise<T | null>((resolve) => {
      try {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
  });
}

/** Положить бинарь под ключ (обычно URL модели). Тихо не делает ничего, если хранилище недоступно. */
export async function putAsset(key: string, data: ArrayBuffer): Promise<void> {
  await tx('readwrite', (s) => s.put(data, key) as IDBRequest<IDBValidKey>);
}

/** Достать бинарь. null — нет в кэше (или хранилище недоступно). */
export async function getAsset(key: string): Promise<ArrayBuffer | null> {
  const v = await tx<ArrayBuffer>('readonly', (s) => s.get(key) as IDBRequest<ArrayBuffer>);
  return v instanceof ArrayBuffer ? v : null;
}

/** Что уже лежит локально (диагностика в панели: «моделей в офлайн-кэше: N»). */
export async function listAssets(): Promise<string[]> {
  const v = await tx<IDBValidKey[]>('readonly', (s) => s.getAllKeys() as IDBRequest<IDBValidKey[]>);
  return (v ?? []).map(String);
}

/** Сколько байт занимает кэш (та же диагностика). */
export async function assetBytes(): Promise<number> {
  const keys = await listAssets();
  let n = 0;
  for (const k of keys) { const b = await getAsset(k); n += b?.byteLength ?? 0; }
  return n;
}

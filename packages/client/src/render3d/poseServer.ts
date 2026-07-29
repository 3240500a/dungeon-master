/**
 * Синк контента 3D поз-редактора с СЕРВЕРОМ (единая истина). Сервер — источник, localStorage — кэш:
 *  • boot грузит контент с сервера в localStorage (`syncPoseFromServer`) ДО того, как редактор/игра его прочитают
 *    (внутренности не трогаем — они читают localStorage синхронно, как раньше);
 *  • сохранения редактора пишут И в localStorage, И на сервер (`savePoseKey`).
 * Оба вызова ТИХО переживают офлайн (нет сервера → работаем на локальном кэше). API: `/api/pose` GET,
 * `/api/dev/pose` POST (DEV-only) — Vite проксирует на :3001, прод — тот же origin.
 */
export const POSE_KEYS = ['pe_gait', 'pe_clips', 'pe_sway', 'pe_phys', 'pe_ragdoll', 'pe_chars', 'pe_attacks', 'pe_loco', 'pe_appearance', 'pe_shield'] as const;

/** Синк с сервером (звать ДО чтения редактором/игрой): сервер → localStorage; а ключи, которых на сервере ещё
 *  нет, но есть локально — РАЗОВО засеять на сервер (миграция уже накрученного контента). Офлайн — тихо на кэше. */
export async function syncPoseFromServer(): Promise<void> {
  let data: Record<string, unknown>;
  try {
    const res = await fetch('/api/pose');
    if (!res.ok) return;
    data = await res.json() as Record<string, unknown>;
  } catch { return; }   // сервер недоступен — работаем на локальном кэше
  const seed: Record<string, unknown> = {};
  for (const k of POSE_KEYS) {
    if (k in data && data[k] !== undefined) {
      try { localStorage.setItem(k, JSON.stringify(data[k])); } catch { /* */ }   // сервер → кэш (сервер выигрывает)
    } else {
      const local = localStorage.getItem(k);                                     // сервер не знает ключ, а локально есть → засеять
      if (local) { try { seed[k] = JSON.parse(local); } catch { /* */ } }
    }
  }
  if (Object.keys(seed).length) {
    void fetch('/api/dev/pose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(seed) }).catch(() => { /* */ });
  }
}

/** Кэш эффективного СЕРВЕРНОГО конфига (классы/монстры/баланс — единая истина) в localStorage['pe_config'].
 *  Звать в boot ДО импорта редактора/игры: ростер (chars3d) и меню классов (game3d) читают кэш синхронно.
 *  Форма ответа /api/config = ConfigRegistry.snapshot() (объект по ключам). Офлайн — тихо на прежнем кэше. */
export async function syncConfigFromServer(): Promise<void> {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) return;
    const snapshot = await res.json();
    try { localStorage.setItem('pe_config', JSON.stringify(snapshot)); } catch { /* */ }
  } catch { /* сервер недоступен — работаем на прежнем кэше/встроенных дефолтах */ }
}

/** Отправить один ключ (уже записанный в localStorage) на сервер (write-through). */
export function savePoseKey(key: string): void {
  let value: unknown;
  try { const s = localStorage.getItem(key); value = s ? JSON.parse(s) : null; } catch { return; }
  void fetch('/api/dev/pose', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [key]: value }),
  }).catch(() => { /* офлайн — уже сохранено локально */ });
}

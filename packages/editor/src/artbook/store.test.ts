import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { POSE_KEYS, WIPE_SPARED } from '@dm/pose-editor/render3d/poseServer.js';
import { POSE_EXCLUDED } from '../../../server/src/content/releaseManifest.js';
import { EMPTY_ARTBOOK, addImage, editText, normalizeArtbook, type ArtbookDoc } from './model.js';

/**
 * ⭐ 16.10 (Артбук): хранение `pe_artbook` — слияние с сервером вместо «локальное — истина»: на загрузке и на 409 серверное
 * сливается с локальным, и ни картинки одной машины, ни тексты другой не теряются. Сервер — подделка в памяти с той же
 * логикой замка `__baseRev`, что у `POST /api/dev/pose`.
 */
const posted: Record<string, unknown>[] = [];
let server: { doc?: ArtbookDoc; rev: number; down: boolean; status?: number };

vi.mock('@dm/pose-editor/devAuth.js', () => ({
  devFetch: async (url: string, init: RequestInit): Promise<Response> => {
    if (server.down) throw new Error('сеть');
    if (server.status) return new Response('{}', { status: server.status });
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    posted.push(body);
    const base = (body.__baseRev as Record<string, number> | undefined)?.pe_artbook ?? 0;
    if (url === '/api/dev/pose' && server.rev > base) return new Response(JSON.stringify({ error: 'новее', rev: { pe_artbook: server.rev } }), { status: 409 });
    server.doc = body.pe_artbook as ArtbookDoc;
    server.rev += 1;
    return new Response(JSON.stringify({ ok: true, rev: { pe_artbook: server.rev } }), { status: 200 });
  },
}));

class MemStorage {
  m = new Map<string, string>();
  getItem(k: string): string | null { return this.m.get(k) ?? null; }
  setItem(k: string, v: string): void { this.m.set(k, v); }
  removeItem(k: string): void { this.m.delete(k); }
}

const seed = { crypt: { subtypes: [{ id: 'rome', lore: 'сид' }] } };

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  posted.length = 0;
  server = { rev: 0, down: false };
  (globalThis as { localStorage?: unknown }).localStorage = new MemStorage();
  globalThis.fetch = (async (url: string): Promise<Response> => {
    if (server.down) throw new Error('сеть');
    if (url === '/api/pose/rev') return new Response(JSON.stringify(server.doc ? { pe_artbook: server.rev, pe_clips: 7 } : { pe_clips: 7 }));
    if (url === '/api/pose') return new Response(JSON.stringify(server.doc ? { pe_artbook: server.doc, pe_clips: [] } : { pe_clips: [] }));
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
});
afterEach(() => { vi.useRealTimers(); });

const fresh = async () => (await import('./store.js')).artbookStore;

describe('artbook: хранение pe_artbook', () => {
  it('ключ зарегистрирован как у роадмапа: в POSE_KEYS, «чистый лист» его не трогает, в релиз контента не идёт', () => {
    expect(POSE_KEYS as readonly string[]).toContain('pe_artbook');
    expect(WIPE_SPARED).toContain('pe_artbook');
    expect(WIPE_SPARED).toContain('pe_artbook_seen');
    expect(POSE_EXCLUDED.has('pe_artbook')).toBe(true);
  });

  it('загрузка: картинка этой машины + текст с сервера → оба; слитое уходит на сервер', async () => {
    const local = EMPTY_ARTBOOK();
    addImage(local, 'sub:rome:concept', { id: 'a', url: '/assets/artbook/a.png' }, 5);
    localStorage.setItem('pe_artbook', JSON.stringify(local));
    const remote = EMPTY_ARTBOOK();
    editText(remote, seed, 'crypt/subtypes/rome/lore', 'с другой машины', 6);
    server.doc = remote; server.rev = 100;
    const st = await fresh();
    await st.load();
    expect(st.doc.slots['sub:rome:concept']?.map((x) => x.id)).toEqual(['a']);
    expect(st.doc.texts['crypt/subtypes/rome/lore']?.text).toBe('с другой машины');
    await vi.advanceTimersByTimeAsync(1000);
    expect(posted.length).toBe(1);
    expect((posted[0]!.__baseRev as Record<string, number>).pe_artbook).toBe(100);
    expect(server.doc?.slots['sub:rome:concept']?.length).toBe(1);
    expect(server.doc?.texts['crypt/subtypes/rome/lore']?.text).toBe('с другой машины');
    expect(st.save).toBe('saved');
  });

  it('409: пока правили, вторая машина записала — серверное сливается, запись повторяется, ничего не потеряно', async () => {
    const st = await fresh();
    await st.load();
    addImage(st.doc, 'cls:mage:concept', { id: 'm', url: 'u/m' }, 10);
    st.touch();
    const other = EMPTY_ARTBOOK();
    addImage(other, 'loc:crypt:env', { id: 'e', url: 'u/e' }, 11);
    server.doc = other; server.rev = 200;               // запись второй машины до нашей
    await vi.advanceTimersByTimeAsync(1000);
    expect(posted.length, 'первая попытка отклонена, вторая — со слитым').toBe(2);
    expect(Object.keys(server.doc!.slots).sort()).toEqual(['cls:mage:concept', 'loc:crypt:env']);
    expect(Object.keys(st.doc.slots).sort()).toEqual(['cls:mage:concept', 'loc:crypt:env']);
    expect(JSON.parse(localStorage.getItem('pe_artbook')!).slots['loc:crypt:env']).toBeTruthy();
  });

  it('сервера нет — работаем на локальной копии, надпись «сервер недоступен»; прав нет — «нет прав»', async () => {
    const local = EMPTY_ARTBOOK();
    editText(local, seed, 'crypt/subtypes/rome/lore', 'офлайн', 1);
    localStorage.setItem('pe_artbook', JSON.stringify(local));
    server.down = true;
    const st = await fresh();
    await st.load();
    expect(st.doc.texts['crypt/subtypes/rome/lore']?.text).toBe('офлайн');
    expect(st.save).toBe('offline');
    st.touch();
    await vi.advanceTimersByTimeAsync(1000);
    expect(st.save).toBe('offline');
    server.down = false; server.status = 403;
    st.touch();
    await vi.advanceTimersByTimeAsync(1000);
    expect(st.save).toBe('denied');
    expect(JSON.parse(localStorage.getItem('pe_artbook')!).texts['crypt/subtypes/rome/lore'].text, 'правка цела локально').toBe('офлайн');
  });

  it('⭐ гонка: вторая машина пишет между нашими чтениями — её правка не теряется (ревизия читается ДО тела)', async () => {
    const remote = EMPTY_ARTBOOK();
    editText(remote, seed, 'crypt/subtypes/rome/lore', 'старое', 1);
    server.doc = remote; server.rev = 100;
    const local = EMPTY_ARTBOOK();
    addImage(local, 'sub:rome:concept', { id: 'a', url: 'u/a' }, 2);
    localStorage.setItem('pe_artbook', JSON.stringify(local));
    const base = globalThis.fetch;
    let hit = false;
    globalThis.fetch = ((url: string, init?: RequestInit): Promise<Response> => {
      const r = base(url, init);   // тело подделки собирается сразу, при вызове
      if (url === '/api/pose' && !hit) {   // тело отдано — и ровно сейчас пишет вторая машина
        hit = true;
        const other = normalizeArtbook(JSON.parse(JSON.stringify(server.doc)));
        editText(other, seed, 'crypt/subtypes/rome/lore', 'правка второй машины', 50);
        server.doc = other; server.rev = 101;
      }
      return r;
    }) as typeof fetch;
    const st = await fresh();
    await st.load();
    await vi.advanceTimersByTimeAsync(1000);
    expect(server.doc?.texts['crypt/subtypes/rome/lore']?.text, 'правка второй машины цела').toBe('правка второй машины');
    expect(server.doc?.slots['sub:rome:concept']?.length, 'и наша картинка').toBe(1);
    expect(st.doc.texts['crypt/subtypes/rome/lore']?.text).toBe('правка второй машины');
  });

  it('пустой документ без ключа на сервере — ничего не пишем', async () => {
    const st = await fresh();
    await st.load();
    await vi.advanceTimersByTimeAsync(1000);
    expect(posted.length).toBe(0);
  });
});

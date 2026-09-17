import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { savePoseKey, dirtyKeys, serverAheadKeys, publish, pullFromServer, syncPoseFromServer, refreshServerRevs, setPublishPrepare, wipeAll, POSE_KEYS } from './poseServer.js';
import { saveConfigSection, configEdits, configDirtyKeys, mergedConfig, publishConfigEdits } from './configEdits.js';

/** Мини-localStorage: тесты гоняют РЕАЛЬНУЮ логику хранения, поэтому подделка должна вести себя как настоящий. */
function fakeLS(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  } as unknown as Storage;
}

/** Сервер в памяти: тела + ревизии, поведение роутов 1:1 с `server/src/index.ts`. */
function fakeServer(init: Record<string, unknown> = {}, models: unknown[] = []) {
  const data: Record<string, unknown> = { ...init };
  const rev: Record<string, number> = {};
  let clock = 1000;
  for (const k of Object.keys(data)) rev[k] = ++clock;
  const state = {
    data, rev,
    /** правка «другой вкладкой» — то, из-за чего пропал hit_axe */
    poke(key: string, value: unknown) { data[key] = value; rev[key] = ++clock; },
    calls: [] as string[],
  };
  const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
    state.calls.push(url);
    if (url === '/api/pose') return { ok: true, status: 200, json: async () => ({ ...data }) } as Response;
    if (url === '/api/pose/rev') return { ok: true, status: 200, json: async () => ({ ...rev }) } as Response;
    if (url === '/api/config') return { ok: true, status: 200, json: async () => ({ models }) } as Response;
    if (url === '/api/dev/pose') {
      const body = JSON.parse(String(opts?.body ?? '{}')) as Record<string, unknown>;
      const base = body.__baseRev as Record<string, number> | undefined;
      const keys = Object.keys(body).filter((k) => k !== '__baseRev');
      if (base) {
        const conflicts = keys.filter((k) => (rev[k] ?? 0) > (base[k] ?? 0));
        if (conflicts.length) return { ok: false, status: 409, json: async () => ({ conflicts, rev }) } as Response;
      }
      const out: Record<string, number> = {};
      for (const k of keys) { data[k] = body[k]; out[k] = rev[k] = ++clock; }
      return { ok: true, status: 200, json: async () => ({ ok: true, saved: keys, rev: out }) } as Response;
    }
    if (url.startsWith('/api/dev/pose/') && opts?.method === 'DELETE') {
      const k = decodeURIComponent(url.slice('/api/dev/pose/'.length));
      delete data[k]; delete rev[k];
      return { ok: true, status: 200, json: async () => ({ ok: true, deleted: k }) } as Response;
    }
    if (url.startsWith('/api/dev/config')) return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  });
  return { state, fetchMock };
}

const G = globalThis as unknown as { localStorage: Storage; fetch: typeof fetch };
/** Синк РЕДАКТОРА: только он сверяет тела отставших ключей (игра — без этого, см. `syncPoseFromServer`). */
const ED = { compareBodies: true } as const;
/** Сколько раз за прогон качали ВСЁ тело `/api/pose` (0.82 МБ на опубликованном снимке). */
const bodyCalls = (calls: readonly string[]): number => calls.filter((u) => u === '/api/pose').length;

describe('рабочая копия: сервер не затирает локальное', () => {
  beforeEach(() => { G.localStorage = fakeLS(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('ПРАВКА, НЕ ДОЛЕТЕВШАЯ ДО СЕРВЕРА, ПЕРЕЖИВАЕТ ЗАГРУЗКУ (это и есть жалоба)', async () => {
    const { fetchMock } = fakeServer({ pe_ui: { aSkel: 0.5 }, pe_clips: [{ name: 'старый' }] });
    G.fetch = fetchMock as unknown as typeof fetch;

    // правка сделана локально и на сервер НЕ ушла (сервер лежал / POST упал / гонка)
    localStorage.setItem('pe_ui', JSON.stringify({ aSkel: 0.11, probe: 'моё' }));
    savePoseKey('pe_ui');

    await syncPoseFromServer();                       // ← раньше здесь серверное затирало локальное

    expect(JSON.parse(localStorage.getItem('pe_ui')!)).toEqual({ aSkel: 0.11, probe: 'моё' });
    expect(dirtyKeys()).toContain('pe_ui');
  });

  it('чего локально НЕТ — берётся с сервера (первый запуск, не затирание)', async () => {
    const { fetchMock } = fakeServer({ pe_clips: [{ name: 'с сервера' }] });
    G.fetch = fetchMock as unknown as typeof fetch;
    await syncPoseFromServer();
    expect(JSON.parse(localStorage.getItem('pe_clips')!)).toEqual([{ name: 'с сервера' }]);
    expect(dirtyKeys()).not.toContain('pe_clips');    // это не наша правка, публиковать нечего
  });

  it('офлайн переживается тихо: рабочая копия на месте, ничего не потеряно', async () => {
    G.fetch = vi.fn(async () => { throw new Error('нет сети'); }) as unknown as typeof fetch;
    localStorage.setItem('pe_clips', JSON.stringify([{ name: 'мой' }]));
    savePoseKey('pe_clips');
    await syncPoseFromServer();
    expect(JSON.parse(localStorage.getItem('pe_clips')!)).toEqual([{ name: 'мой' }]);
    expect(dirtyKeys()).toContain('pe_clips');
  });

  it('в сеть на сохранении не ходим вовсе — публикация отдельное действие', () => {
    const spy = vi.fn();
    G.fetch = spy as unknown as typeof fetch;
    localStorage.setItem('pe_gait', JSON.stringify({ a: 1 }));
    savePoseKey('pe_gait');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('публикация и замок от затирания', () => {
  beforeEach(() => { G.localStorage = fakeLS(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('публикует изменённое и снимает признак «не опубликовано»', async () => {
    const { state, fetchMock } = fakeServer({ pe_clips: [] });
    G.fetch = fetchMock as unknown as typeof fetch;
    await syncPoseFromServer();

    localStorage.setItem('pe_clips', JSON.stringify([{ name: 'новый' }]));
    savePoseKey('pe_clips');
    expect(dirtyKeys()).toEqual(['pe_clips']);

    const r = await publish();
    expect(r.ok).toBe(true);
    expect(r.saved).toEqual(['pe_clips']);
    expect(state.data.pe_clips).toEqual([{ name: 'новый' }]);
    expect(dirtyKeys()).toEqual([]);
  });

  it('⭐ наружу уезжает ПОДГОТОВЛЕННОЕ значение, локальная копия не тронута', async () => {
    // Решение автора по хвату: «из редактора будут отправляться готовые анимации». Канал хвата
    // остаётся правимым в редакторе, а в игру клипы уезжают с ЗАПЕЧЁННЫМИ пальцами — значит между
    // рабочей копией и телом запроса должен быть шов. Вот он.
    const { state, fetchMock } = fakeServer({ pe_clips: [] });
    G.fetch = fetchMock as unknown as typeof fetch;
    await syncPoseFromServer();
    localStorage.setItem('pe_clips', JSON.stringify([{ name: 'idle_none', keys: [{ pose: {} }] }]));
    localStorage.setItem('pe_sway', JSON.stringify({ warrior: {} }));
    savePoseKey('pe_clips'); savePoseKey('pe_sway');

    setPublishPrepare((key, value) => (key === 'pe_clips'
      ? (value as { keys: { pose: Record<string, number[]> }[] }[]).map((c) => ({ ...c, keys: c.keys.map((k) => ({ pose: { ...k.pose, LeftIndexProximal: [0.1, 0, 0] } })) }))
      : value));
    try {
      const r = await publish();
      expect(r.ok).toBe(true);
      const sent = state.data.pe_clips as { keys: { pose: Record<string, number[]> }[] }[];
      expect(sent[0]!.keys[0]!.pose.LeftIndexProximal, 'на сервер уехало запечённое').toEqual([0.1, 0, 0]);
      expect(state.data.pe_sway, 'чужие ключи преобразование не трогает').toEqual({ warrior: {} });
      const local = JSON.parse(localStorage.getItem('pe_clips')!) as { keys: { pose: Record<string, number[]> }[] }[];
      expect(local[0]!.keys[0]!.pose.LeftIndexProximal, '⚠ рабочая копия ОСТАЛАСЬ ЧИСТОЙ — канал ещё правится').toBeUndefined();
    } finally { setPublishPrepare(null); }
  });

  it('⭐ ПРОПАЖА hit_axe: вкладка со старым снимком получает 409 и НИЧЕГО не затирает', async () => {
    const { state, fetchMock } = fakeServer({ pe_clips: [{ name: 'hit_axe' }] });
    G.fetch = fetchMock as unknown as typeof fetch;
    await syncPoseFromServer();                                    // наша вкладка видела библиотеку без нового клипа

    state.poke('pe_clips', [{ name: 'hit_axe' }, { name: 'новый_из_другой_вкладки' }]);   // кто-то опубликовал позже

    localStorage.setItem('pe_clips', JSON.stringify([{ name: 'hit_axe' }, { name: 'моя_правка' }]));
    savePoseKey('pe_clips');
    const r = await publish();

    expect(r.ok).toBe(false);
    expect(r.conflicts).toEqual(['pe_clips']);
    expect(state.data.pe_clips).toEqual([{ name: 'hit_axe' }, { name: 'новый_из_другой_вкладки' }]);   // сервер цел
    expect(dirtyKeys()).toContain('pe_clips');                     // наша правка тоже цела, ждёт решения
  });

  it('«на сервере новее» ВИДНО до публикации, а не постфактум', async () => {
    const { state, fetchMock } = fakeServer({ pe_gait: { v: 1 } });
    G.fetch = fetchMock as unknown as typeof fetch;
    await syncPoseFromServer();
    expect(serverAheadKeys()).toEqual([]);

    localStorage.setItem('pe_gait', JSON.stringify({ v: 2 }));
    savePoseKey('pe_gait');
    state.poke('pe_gait', { v: 99 });
    await refreshServerRevs();

    expect(serverAheadKeys()).toEqual(['pe_gait']);
  });

  it('⭐ ЧИСТЫЙ КЛЮЧ, СЕРВЕР УШЁЛ ВПЕРЁД: загрузка НЕ сдвигает базу без тела — бейдж виден, правка поверх получает 409', async () => {
    // Сценарий перезапекания страйфов: машина A опубликовала новый `pe_clips`, машина B ничего не правила и
    // перезагрузилась. ⚠ Мутация «нет своих правок → база = сервер» валит это: бейджа нет, публикация B проходит
    // замок и молча возвращает на сервер старые клипы.
    const { state, fetchMock } = fakeServer({ pe_clips: [{ name: 'walk_strafe_R', bakeRev: 0 }] });
    G.fetch = fetchMock as unknown as typeof fetch;
    await syncPoseFromServer(ED);                                   // B: первая встреча, тело = серверное
    state.poke('pe_clips', [{ name: 'walk_strafe_R', bakeRev: 2 }]);  // A перезапёк и опубликовал
    await syncPoseFromServer(ED);                                   // B перезагрузился, своих правок нет

    expect(JSON.parse(localStorage.getItem('pe_clips')!), 'рабочую копию сервер по-прежнему не трогает').toEqual([{ name: 'walk_strafe_R', bakeRev: 0 }]);
    expect(serverAheadKeys(), 'старое тело при новой ревизии — это ВИДНО').toEqual(['pe_clips']);

    localStorage.setItem('pe_clips', JSON.stringify([{ name: 'walk_strafe_R', bakeRev: 0 }, { name: 'hit_axe' }]));
    savePoseKey('pe_clips');
    const r = await publish();
    expect(r.ok).toBe(false);
    expect(r.conflicts).toEqual(['pe_clips']);
    expect(state.data.pe_clips, 'перезапечённое на сервере цело').toEqual([{ name: 'walk_strafe_R', bakeRev: 2 }]);
  });

  it('⚠ ЧИСТЫЙ КЛЮЧ, ТЕЛО ТО ЖЕ: ревизия уехала, а содержимое совпадает — бейджа НЕТ и публикация проходит', async () => {
    // Оборотная сторона теста выше. Ключи пишет не только эта вкладка: `pe_roadmap` шлёт конфиг-редактор своим POST-ом
    // (ревизия растёт после каждой правки), да и «опубликовал ту же правку с другой машины» — обычное дело.
    // ⚠ Мутация «чистый ключ + сервер новее → всегда замораживать базу» валит это: бейдж «на сервере новее» горит,
    // ничего не правя, и первая же публикация упирается в 409.
    const { state, fetchMock } = fakeServer({ pe_gait: { warpOn: 1, hipsMode: 0 }, pe_roadmap: { v: 1 } });
    G.fetch = fetchMock as unknown as typeof fetch;
    await syncPoseFromServer(ED);
    state.poke('pe_gait', { hipsMode: 0, warpOn: 1 });   // то же тело, ДРУГОЙ порядок ключей и новая ревизия
    state.poke('pe_roadmap', { v: 2 });                  // чужая вкладка (WIPE_SPARED) — спорить не о чем
    await syncPoseFromServer(ED);

    expect(serverAheadKeys(), 'совпало по телу — бейджа нет').toEqual([]);
    localStorage.setItem('pe_gait', JSON.stringify({ warpOn: 1, hipsMode: 1 }));
    savePoseKey('pe_gait');
    const r = await publish();
    expect(r.ok, 'публикация поверх своей же ревизии проходит').toBe(true);
    expect(state.data.pe_gait).toEqual({ warpOn: 1, hipsMode: 1 });
  });

  it('⭐ ИГРОВОЙ BOOT НЕ СВЕРЯЕТ ТЕЛА: 0 загрузок и прежняя база, а в редакторе — 1 загрузка и бейдж', async () => {
    // ⚠ Сверка «база едет только при совпадении тела» имеет смысл там, где есть бейдж «на сервере новее» и кнопка
    // «взять серверное», то есть в редакторе. Игра (`game3d-boot.ts`) серверное тело в рабочую копию не пишет и
    // спорить не умеет: для неё это чистая загрузка 0.82 МБ (831 КБ `pe_clips`) плюс две канонические
    // сериализации на главном потоке ДО старта игры — и так на КАЖДОМ входе после каждой публикации автора.
    // ⚠ Мутация «сверять тела всегда» (убрать параметр) валит это.
    // Все ключи заранее лежат локально — `missing` пуст, и видна РОВНО цена сверки.
    const seedAll = (state: { data: Record<string, unknown> }): void => {
      for (const k of POSE_KEYS) localStorage.setItem(k, JSON.stringify(state.data[k] ?? {}));
    };
    const scenario = async (opts?: { compareBodies: boolean }): Promise<{ calls: number; ahead: string[] }> => {
      G.localStorage = fakeLS();
      const { state, fetchMock } = fakeServer(Object.fromEntries(POSE_KEYS.map((k) => [k, { v: 1 }])));
      G.fetch = fetchMock as unknown as typeof fetch;
      seedAll(state);
      await syncPoseFromServer(opts);                 // первый вход: тела уже лежат, качать нечего
      state.poke('pe_clips', { v: 2 });               // автор перезапёк и опубликовал
      state.calls.length = 0;
      await syncPoseFromServer(opts);                 // следующий вход
      return { calls: bodyCalls(state.calls), ahead: serverAheadKeys() };
    };

    const game = await scenario();
    expect(game.calls, 'игра тела не качает вовсе').toBe(0);
    expect(game.ahead, 'и спорить ей не о чем — база едет, как было').toEqual([]);

    const editor = await scenario({ compareBodies: true });
    expect(editor.calls, 'редактор качает тела РОВНО один раз').toBe(1);
    expect(editor.ahead, 'и показывает бейдж').toEqual(['pe_clips']);
  });

  it('⚠ ОДИН `/api/pose` НА ЗАГРУЗКУ: части ключей нет, а `pe_clips` отстал — оба условия сразу', async () => {
    // ⚠ Мутация «свой `fetchAll()` под `missing` и свой под `behind`» валит это: ≈ 1.8 МБ за один boot.
    const { state, fetchMock } = fakeServer({ pe_clips: [{ name: 'walk_strafe_R', bakeRev: 0 }], pe_gait: { v: 1 } });
    G.fetch = fetchMock as unknown as typeof fetch;
    await syncPoseFromServer(ED);                     // новая машина: тела приехали, база встала
    state.poke('pe_clips', [{ name: 'walk_strafe_R', bakeRev: 2 }]);
    localStorage.removeItem('pe_gait');               // ← ключ снова «отсутствует»: `missing` И `behind` в одном вызове
    state.calls.length = 0;
    await syncPoseFromServer(ED);

    expect(bodyCalls(state.calls), 'тела качаются РОВНО один раз').toBe(1);
    expect(JSON.parse(localStorage.getItem('pe_gait')!), 'отсутствующее дозаполнено').toEqual({ v: 1 });
    expect(serverAheadKeys(), 'отставшее с ДРУГИМ телом — видно').toEqual(['pe_clips']);
  });

  it('«забрать серверное» — единственное место, где серверное перезаписывает локальное', async () => {
    const { state, fetchMock } = fakeServer({ pe_gait: { v: 1 } });
    G.fetch = fetchMock as unknown as typeof fetch;
    await syncPoseFromServer();
    localStorage.setItem('pe_gait', JSON.stringify({ v: 2 }));
    savePoseKey('pe_gait');
    state.poke('pe_gait', { v: 99 });

    const got = await pullFromServer(['pe_gait']);
    expect(got).toEqual(['pe_gait']);
    expect(JSON.parse(localStorage.getItem('pe_gait')!)).toEqual({ v: 99 });
    expect(dirtyKeys()).toEqual([]);                               // расхождения больше нет
  });

  it('после «забрать серверное» публикация проходит (база обновилась)', async () => {
    const { state, fetchMock } = fakeServer({ pe_clips: [{ name: 'a' }] });
    G.fetch = fetchMock as unknown as typeof fetch;
    await syncPoseFromServer();
    state.poke('pe_clips', [{ name: 'a' }, { name: 'b' }]);

    localStorage.setItem('pe_clips', JSON.stringify([{ name: 'моё' }]));
    savePoseKey('pe_clips');
    expect((await publish()).ok).toBe(false);                      // сперва 409

    await pullFromServer(['pe_clips']);
    localStorage.setItem('pe_clips', JSON.stringify([{ name: 'a' }, { name: 'b' }, { name: 'моё' }]));
    savePoseKey('pe_clips');
    const r2 = await publish();
    expect(r2.ok).toBe(true);
    expect(state.data.pe_clips).toEqual([{ name: 'a' }, { name: 'b' }, { name: 'моё' }]);
  });

  it('нет сервера → публикация честно сообщает, правки остаются локально', async () => {
    G.fetch = vi.fn(async () => { throw new Error('нет сети'); }) as unknown as typeof fetch;
    localStorage.setItem('pe_clips', JSON.stringify([1]));
    savePoseKey('pe_clips');
    const r = await publish();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/недоступен/);
    expect(dirtyKeys()).toEqual(['pe_clips']);
  });
});

describe('конфиг моделей: правки живут локально', () => {
  beforeEach(() => { G.localStorage = fakeLS(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('настройка сабмеша сохраняется БЕЗ сервера и переживает перезагрузку', () => {
    const spy = vi.fn();
    G.fetch = spy as unknown as typeof fetch;
    saveConfigSection('models', [{ id: 'knight', submeshMaterials: { chest: 'steel' } }]);
    expect(spy).not.toHaveBeenCalled();                            // ни одного POST на каждый селект
    expect(configEdits().models).toEqual([{ id: 'knight', submeshMaterials: { chest: 'steel' } }]);
    expect(configDirtyKeys()).toEqual(['pe_config:models']);
    // «перезагрузка»: читаем то, что увидит редактор
    expect((mergedConfig() as { models: unknown[] }).models).toEqual([{ id: 'knight', submeshMaterials: { chest: 'steel' } }]);
  });

  it('локальные правки ложатся ПОВЕРХ серверного конфига', () => {
    G.fetch = vi.fn() as unknown as typeof fetch;
    saveConfigSection('models', [{ id: 'мой' }]);
    const merged = mergedConfig({ models: [{ id: 'серверный' }], materials: [{ id: 'm1' }] }) as Record<string, unknown>;
    expect(merged.models).toEqual([{ id: 'мой' }]);
    expect(merged.materials).toEqual([{ id: 'm1' }]);              // чужие секции не тронуты
  });

  it('публикация чистит локальный слой; при мёртвом сервере — не чистит', async () => {
    const { fetchMock } = fakeServer();
    G.fetch = fetchMock as unknown as typeof fetch;
    saveConfigSection('models', [{ id: 'a' }]);
    expect((await publishConfigEdits()).ok).toBe(true);
    expect(configDirtyKeys()).toEqual([]);

    G.fetch = vi.fn(async () => { throw new Error('нет сети'); }) as unknown as typeof fetch;
    saveConfigSection('models', [{ id: 'b' }]);
    const r = await publishConfigEdits();
    expect(r.ok).toBe(false);
    expect(configDirtyKeys()).toEqual(['pe_config:models']);       // не опубликовано → и не потеряно
  });
});


/**
 * ЧИСТЫЙ ЛИСТ. Жалоба: «нажал — а настройки и модели остались».
 *
 * ⚠ Причина была не в самой чистке (сервер она вычищала), а в ТРЁХ местах, откуда контент
 * возвращался сам: сид сервера (`pose-seed.json`), `models.json` в памяти процесса и АВТОПОСЕВ
 * в редакторе по флагу `pe_seeded4` — флаг лежал в тех же `pe_*`, сносился вместе с ними, и
 * редактор считал себя новым. Здесь проверяется механика самой чистки; автопосев убран в
 * `pose-editor.ts` (сид остался кнопкой).
 */
describe('чистый лист', () => {
  beforeEach(() => { G.localStorage = fakeLS(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('⭐ сносит рабочую копию И сервер, а личное и вход не трогает', async () => {
    const { state, fetchMock } = fakeServer({ pe_clips: [{ name: 'старый' }], pe_gait: { warrior: {} } });
    G.fetch = fetchMock as unknown as typeof fetch;
    localStorage.setItem('pe_clips', '[]');
    localStorage.setItem('pe_gait', '{}');
    localStorage.setItem('pe_prefs', '{"aSkel":0.3}');     // личные настройки инструмента
    localStorage.setItem('dm:auth', 'token');              // вход — не контент

    const r = await wipeAll();

    expect(r.server.sort(), 'ключи сервера удалены').toEqual(['pe_clips', 'pe_gait']);
    expect(Object.keys(state.rev), 'на сервере пусто').toEqual([]);
    expect(r.failed, 'без тихих осечек').toEqual([]);
    expect(localStorage.getItem('pe_clips'), 'рабочая копия очищена').toBeNull();
    expect(localStorage.getItem('pe_gait')).toBeNull();
    expect(localStorage.getItem('pe_prefs'), '⚠ личные настройки остаются').toBe('{"aSkel":0.3}');
    expect(localStorage.getItem('dm:auth'), '⚠ вход не трогаем — иначе выкинет из редактора').toBe('token');
  });

  it('⭐ из моделей уходят ТОЛЬКО персонажи — окружение и оружие остаются', async () => {
    // 14.09 секцию обнуляли целиком, и вместе с рыцарем ушли пол и стены крипты.
    // Сброс к дефолту тоже не годится: вернул бы `models.json`, который сервер держит в памяти.
    const models = [
      { id: 'knight', kind: 'character' },                               // легаси без category
      { id: 'zombie', kind: 'character', category: 'monster' },
      { id: 'crypt_floor', kind: 'part', category: 'tile' },
      { id: 'crypt_column', kind: 'part', category: 'decor' },
      { id: 'axe', kind: 'weapon', category: 'weapon' },
    ];
    const { fetchMock } = fakeServer({}, models);
    G.fetch = fetchMock as unknown as typeof fetch;
    const r = await wipeAll();
    const call = fetchMock.mock.calls.find((c) => String(c[0]).startsWith('/api/dev/config'));
    expect(call, 'конфиг моделей обязан быть тронут').toBeTruthy();
    expect(String(call![0]), 'именно POST на секцию, а не DELETE').toBe('/api/dev/config');
    const sent = JSON.parse(String((call![1] as RequestInit).body)) as { models: { id: string }[] };
    expect(sent.models.map((m) => m.id), 'остались окружение и оружие').toEqual(['crypt_floor', 'crypt_column', 'axe']);
    expect(r.failed).toEqual([]);
  });

  it('⭐ роадмап не трогается — ни на сервере, ни локально', async () => {
    // Трекер работ живёт в том же `pose_store` ради синхронизации, но к анимациям отношения не имеет.
    const { state, fetchMock } = fakeServer({ pe_clips: [{ name: 'старый' }], pe_roadmap: { milestones: [{ id: 'f1' }] } });
    G.fetch = fetchMock as unknown as typeof fetch;
    localStorage.setItem('pe_clips', '[]');
    localStorage.setItem('pe_roadmap', '{"milestones":[{"id":"f1"}]}');
    localStorage.setItem('pe_roadmap_seen', '1001');

    const r = await wipeAll();

    expect(r.server, 'удалён только контент').toEqual(['pe_clips']);
    expect(Object.keys(state.data), 'роадмап на сервере цел').toEqual(['pe_roadmap']);
    expect(localStorage.getItem('pe_roadmap'), 'и локально цел').toBe('{"milestones":[{"id":"f1"}]}');
    expect(localStorage.getItem('pe_roadmap_seen')).toBe('1001');
    expect(r.failed, 'оставшийся роадмап — не «осечка» чистки').toEqual([]);
  });

  it('⚠ список моделей не прочитан — секцию НЕ пишем (пустой список снёс бы окружение)', async () => {
    const { fetchMock } = fakeServer({});
    const noConfig = vi.fn(async (url: string, opts?: RequestInit) => (
      url === '/api/config' ? { ok: false, status: 500, json: async () => ({}) } as Response : fetchMock(url, opts)));
    G.fetch = noConfig as unknown as typeof fetch;
    const r = await wipeAll();
    expect(noConfig.mock.calls.some((c) => String(c[0]).startsWith('/api/dev/config')), 'записи не было').toBe(false);
    expect(r.failed.join(' '), 'и об этом сказано').toMatch(/модели не тронуты/);
  });

  it('⚠ если на сервере что-то осталось — говорим об этом, а не молчим', async () => {
    // Иначе редактор при следующей загрузке притащит остаток обратно, и чистка выглядит несработавшей.
    const { fetchMock } = fakeServer({ pe_clips: [] });
    const guarded = vi.fn(async (url: string, opts?: RequestInit) => (
      String(url).startsWith('/api/dev/pose/') ? { ok: false, status: 403, json: async () => ({}) } as Response
        : fetchMock(url, opts)));
    G.fetch = guarded as unknown as typeof fetch;
    const r = await wipeAll();
    expect(r.failed.join(' '), 'в отчёте видно и отказ, и остаток').toMatch(/403|осталось/);
  });
});

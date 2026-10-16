/**
 * ⭐ 16.10 (Артбук): ЧИСТОЕ ЯДРО вкладки «🎨 Артбук» — документ правок `pe_artbook`, слияние сида с правками владельца,
 * картинки в слотах. Без DOM → node-тесты (`model.test.ts`).
 *
 * ДВА СЛОЯ ТЕКСТА.
 *  • СИД — тексты в репозитории (`seed/*.json`, их пишет агент; обновляются коммитом).
 *  • ПРАВКИ — то, что владелец поправил прямо на странице. Лежат в `pe_artbook.texts` по ПУТИ поля, а не копией документа:
 *    новый сид доезжает до всех полей, которых владелец не трогал, а тронутые остаются его. Если сид под правкой поменялся
 *    (у правки записан `base` — текст сида на момент правки), поле помечается «сид обновился» — забрать новый можно кнопкой.
 *
 * ПУТЬ ПОЛЯ — сегменты через `/`. Первый — пространство сида (`crypt`, `classes`, `locations`), дальше ключи объекта; в массиве —
 * число (индекс) или ключ строки (`id` / `subtype` / `code`): `crypt/subtypes/greece/lore`, `crypt/decayLadder/rows/rome/body`,
 * `crypt/intro/purpose/0`. Ключ строки, а не индекс — чтобы правка не уехала на соседа, когда в сиде поменяется порядок.
 *
 * КАРТИНКИ — `pe_artbook.slots`: ключ слота → список картинок (файл на сервере `/assets/artbook/…`, подпись, статус, ★ главный).
 * Ключи слотов собирает `slotKey(...)`; соглашение — в `SLOT_KEYS` ниже.
 */

export type ImgStatus = 'none' | 'draft' | 'approved';
export const IMG_STATUSES: readonly ImgStatus[] = ['none', 'draft', 'approved'];
export const STATUS_LABEL: Record<ImgStatus, string> = { none: 'нет', draft: 'черновик', approved: 'утверждён' };

export interface SlotImage {
  /** id файла на сервере (он же имя файла без расширения). */
  id: string;
  /** Адрес картинки (`/assets/artbook/<id>.<ext>`). */
  url: string;
  caption: string;
  status: ImgStatus;
  /** ★ главный в слоте — ровно один (`setMain`). */
  main?: boolean;
  /** Имя исходного файла — подсказка, откуда картинка. */
  name?: string;
  /** Время последней правки записи (мс). */
  at: number;
  /** Когда правилось каждое поле — слияние двух машин берёт поле от более поздней правки, а не запись целиком. */
  ft?: Partial<Record<ImgField, number>>;
}
export type ImgField = 'caption' | 'status' | 'main';
const IMG_FIELDS: readonly ImgField[] = ['caption', 'status', 'main'];

export interface TextEdit {
  text: string;
  /** Текст СИДА на момент правки: сид потом поменялся — поле помечается «сид обновился». */
  base?: string;
  at: number;
}

export interface ArtbookDoc {
  v: 1;
  updatedAt: number;
  /** Путь поля → правка владельца. */
  texts: Record<string, TextEdit>;
  /** Ключ слота → картинки. */
  slots: Record<string, SlotImage[]>;
  /**
   * МЕТКИ УДАЛЕНИЯ для слияния двух машин (`mergeArtbook`): `txt:<путь>` — правку сняли, `img:<слот>|<id>` — картинку убрали;
   * значение — когда. Без них снятая на одной машине правка возвращалась бы со второй при первом же слиянии.
   */
  gone: Record<string, number>;
  /**
   * ⭐ 16.10: когда в слоте последний раз меняли ПОРЯДОК картинок (← →): слияние берёт порядок у копии с более поздней
   * перестановкой. Без отметки порядок брался у локальной копии, и вторая машина при первой же сверке записывала свой старый
   * порядок поверх переставленного.
   */
  ord: Record<string, number>;
}

export const EMPTY_ARTBOOK = (): ArtbookDoc => ({ v: 1, updatedAt: 0, texts: {}, slots: {}, gone: {}, ord: {} });

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const str = (x: unknown): string => (typeof x === 'string' ? x : '');
const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

/**
 * Документ из хранилища (localStorage / сервер) — терпимо: мусор не роняет вкладку, а превращается в пустое. Чужие поля
 * отбрасываются, картинка без адреса — тоже (её нечем показать).
 */
export function normalizeArtbook(raw: unknown): ArtbookDoc {
  const out = EMPTY_ARTBOOK();
  if (!isObj(raw)) return out;
  out.updatedAt = num(raw.updatedAt);
  if (isObj(raw.texts)) {
    for (const [path, e] of Object.entries(raw.texts)) {
      if (!isObj(e) || typeof e.text !== 'string') continue;
      const t: TextEdit = { text: e.text, at: num(e.at) };
      if (typeof e.base === 'string') t.base = e.base;
      out.texts[path] = t;
    }
  }
  if (isObj(raw.slots)) {
    for (const [key, list] of Object.entries(raw.slots)) {
      if (!Array.isArray(list)) continue;
      const imgs: SlotImage[] = [];
      for (const it of list) {
        if (!isObj(it) || !str(it.url) || !str(it.id)) continue;
        const status = IMG_STATUSES.includes(it.status as ImgStatus) ? it.status as ImgStatus : 'none';
        const img: SlotImage = { id: str(it.id), url: str(it.url), caption: str(it.caption), status, at: num(it.at) };
        if (it.main === true) img.main = true;
        if (str(it.name)) img.name = str(it.name);
        if (isObj(it.ft)) {
          const ft: Partial<Record<ImgField, number>> = {};
          for (const f of IMG_FIELDS) if (typeof it.ft[f] === 'number' && Number.isFinite(it.ft[f])) ft[f] = it.ft[f] as number;
          if (Object.keys(ft).length) img.ft = ft;
        }
        imgs.push(img);
      }
      fixMain(imgs);
      if (imgs.length) out.slots[key] = imgs;
    }
  }
  if (isObj(raw.gone)) for (const [k, t] of Object.entries(raw.gone)) if (typeof t === 'number' && Number.isFinite(t)) out.gone[k] = t;
  if (isObj(raw.ord)) for (const [k, t] of Object.entries(raw.ord)) if (typeof t === 'number' && Number.isFinite(t)) out.ord[k] = t;
  return out;
}

// ── Пути полей ───────────────────────────────────────────────────────────────────────────────────

/** Поля, по которым строка массива узнаётся в пути (первое совпавшее). */
export const ROW_KEYS = ['id', 'subtype', 'code'] as const;

export const splitPath = (path: string): string[] => path.split('/').filter((s) => s.length > 0);
export const joinPath = (...parts: (string | number)[]): string => parts.map(String).filter((s) => s.length > 0).join('/');

/** Индекс строки массива по сегменту пути: число — индекс, иначе ключ строки (`id`/`subtype`/`code`). −1 — нет такой. */
function rowIndex(arr: unknown[], seg: string): number {
  if (/^\d+$/.test(seg)) { const i = Number(seg); return i < arr.length ? i : -1; }
  for (const k of ROW_KEYS) {
    const i = arr.findIndex((row) => isObj(row) && row[k] === seg);
    if (i >= 0) return i;
  }
  return -1;
}

/** Значение по пути (или `undefined`, если путь не находится). */
export function getAt(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of splitPath(path)) {
    if (Array.isArray(cur)) { const i = rowIndex(cur, seg); if (i < 0) return undefined; cur = cur[i]; }
    else if (isObj(cur)) cur = cur[seg];
    else return undefined;
  }
  return cur;
}

/**
 * Записать значение по пути НА МЕСТЕ. Недостающие ключи объекта создаются (правка поля, которого в сиде ещё нет, —
 * например «заметки художнику» у биома); строку массива не создаёт — её узнают по ключу, а без строки нечего узнавать.
 * `false` — путь не находится.
 */
export function setAt(root: unknown, path: string, value: unknown): boolean {
  const segs = splitPath(path);
  if (!segs.length) return false;
  let cur: unknown = root;
  for (let s = 0; s < segs.length - 1; s++) {
    const seg = segs[s]!;
    if (Array.isArray(cur)) { const i = rowIndex(cur, seg); if (i < 0) return false; cur = cur[i]; }
    else if (isObj(cur)) {
      if (cur[seg] === undefined) cur[seg] = {};
      cur = cur[seg];
    } else return false;
  }
  const last = segs[segs.length - 1]!;
  if (Array.isArray(cur)) { const i = rowIndex(cur, last); if (i < 0) return false; cur[i] = value; return true; }
  if (isObj(cur)) { cur[last] = value; return true; }
  return false;
}

const goneText = (path: string): string => 'txt:' + path;
const goneImg = (key: string, id: string): string => 'img:' + key + '|' + id;

/** Глубокая копия JSON-данных сида (сид — чистый JSON, функций и дат в нём нет). */
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/**
 * СИД + ПРАВКИ → то, что видно на странице. Сид не мутируется. Правка, чей путь в сиде больше не находится (строку
 * убрали из сида), пропускается молча — она остаётся в документе и вернётся, если строка вернётся.
 */
export function applyTexts<T>(seed: T, texts: Record<string, TextEdit>): T {
  const out = clone(seed);
  for (const [path, e] of Object.entries(texts)) setAt(out, path, e.text);
  return out;
}

export interface TextState {
  /** Что показывать: правка владельца или текст сида. */
  value: string;
  /** Текст сида (нет поля в сиде — `undefined`). */
  seedValue: string | undefined;
  /** Поле правлено владельцем. */
  edited: boolean;
  /** Сид поменялся после правки владельца (правка остаётся, но стоит посмотреть новый текст). */
  stale: boolean;
}

export function textState(seed: unknown, doc: ArtbookDoc, path: string): TextState {
  const raw = getAt(seed, path);
  const seedValue = typeof raw === 'string' ? raw : (typeof raw === 'number' ? String(raw) : undefined);
  const e = doc.texts[path];
  if (!e) return { value: seedValue ?? '', seedValue, edited: false, stale: false };
  return { value: e.text, seedValue, edited: true, stale: e.base !== undefined && seedValue !== undefined && e.base !== seedValue };
}

/**
 * Правка текста. Совпала с сидом — правка снимается (поле снова «едет» с сидом). Пустая строка — тоже правка (владелец
 * мог сознательно стереть абзац). `true` — документ изменился.
 */
export function editText(doc: ArtbookDoc, seed: unknown, path: string, text: string, now: number): boolean {
  const raw = getAt(seed, path);
  const seedValue = typeof raw === 'string' ? raw : undefined;
  const prev = doc.texts[path];
  if (seedValue !== undefined && text === seedValue) {
    if (!prev) return false;
    delete doc.texts[path];
    doc.gone[goneText(path)] = now;
    return true;
  }
  if (seedValue === undefined && text === '' && !prev) return false;
  if (prev && prev.text === text && prev.base === seedValue) return false;
  const e: TextEdit = { text, at: now };
  if (seedValue !== undefined) e.base = seedValue;
  doc.texts[path] = e;
  return true;
}

/** Вернуть текст сида (снять правку). */
export function resetText(doc: ArtbookDoc, path: string, now: number): boolean {
  if (!(path in doc.texts)) return false;
  delete doc.texts[path];
  doc.gone[goneText(path)] = now;
  return true;
}

/** Принять, что сид обновился, но оставить свою правку: `base` сдвигается на нынешний сид — пометка гаснет. */
export function keepEdit(doc: ArtbookDoc, seed: unknown, path: string, now: number): boolean {
  const e = doc.texts[path];
  const raw = getAt(seed, path);
  if (!e || typeof raw !== 'string' || e.base === raw) return false;
  doc.texts[path] = { ...e, base: raw, at: now };
  return true;
}

/** Сколько правок владельца и сколько из них под обновившимся сидом — для шапки вкладки. */
export function editStats(seed: unknown, doc: ArtbookDoc): { edited: number; stale: number } {
  let stale = 0;
  for (const path of Object.keys(doc.texts)) if (textState(seed, doc, path).stale) stale++;
  return { edited: Object.keys(doc.texts).length, stale };
}

// ── Слоты картинок ───────────────────────────────────────────────────────────────────────────────

/**
 * Ключ слота: части через `:`. Двоеточие внутри части заменяется — ключ разбирается обратно однозначно.
 *
 * СОГЛАШЕНИЕ (держать в одном месте — по ним ищут миниатюры матрица и списки):
 *  • `loc:<биом>:<слот>`              — локация (`SLOT_SETS.location`);
 *  • `loc:<биом>:layer:<подтип>`      — концепт слоя крипты по глубине;
 *  • `sub:<подтип>:<слот>`            — подтип нежити (`SLOT_SETS.subtype`; `concept` — главный концепт и варианты);
 *  • `arch:<архетип>:<подтип>:<слот>` — архетип в подтипе (`SLOT_SETS.archetype`; у общего архетипа — свой на каждый подтип);
 *  • `cls:<класс>:<слот>`             — класс героя (`SLOT_SETS.cls`).
 */
export const slotKey = (...parts: string[]): string => parts.map((p) => p.replace(/:/g, '_')).join(':');

export interface SlotDef { id: string; title: string; hint?: string }

/** Наборы слотов по роду карточки. Подписи подтипа и архетипа — из черновика (`imageSlots`). */
export const SLOT_SETS = {
  location: [
    { id: 'mood', title: 'Мудборд локации', hint: 'настроение, свет, туман, материалы' },
    { id: 'env', title: 'Концепты окружения', hint: 'комнаты, коридоры, ключевые точки (портал, алтарь, лестница)' },
    { id: 'props', title: 'Декор и объекты', hint: 'факелы, статуи, саркофаги, сундуки, решётки' },
  ],
  layer: [
    { id: 'env', title: 'Концепт слоя', hint: 'как выглядит этот слой крипты' },
  ],
  subtype: [
    { id: 'concept', title: 'Главный концепт и варианты', hint: '★ — главный, остальные — варианты' },
    { id: 'mood', title: 'Мудборд подтипа' },
    { id: 'decay', title: 'Лист разложения' },
    { id: 'silhouettes', title: 'Лист силуэтов сверху (все архетипы в одном масштабе)' },
    { id: 'palette', title: 'Палитра и материалы' },
  ],
  archetype: [
    { id: 'concept', title: 'Концепт целиком (фронт и 3/4 сверху)' },
    { id: 'silhouette', title: 'Силуэт сверху в кадре игры (~155 px, 45°)' },
    { id: 'gear', title: 'Лист деталей и гира' },
  ],
  cls: [
    { id: 'concept', title: 'Концепт героя (фронт и 3/4 сверху)', hint: '★ — главный, остальные — варианты' },
    { id: 'silhouette', title: 'Силуэт сверху в кадре игры (~155 px, 45°)' },
    { id: 'gear', title: 'Лист снаряжения и деталей' },
  ],
} satisfies Record<string, SlotDef[]>;

/** ★ ровно один, если картинки есть: снятый главный переходит к первой. */
function fixMain(list: SlotImage[]): void {
  let seen = false;
  for (const img of list) { if (img.main && !seen) seen = true; else delete img.main; }
  if (!seen && list[0]) list[0].main = true;
}

export const slotImages = (doc: ArtbookDoc, key: string): SlotImage[] => doc.slots[key] ?? [];

const stamp = (img: SlotImage, f: ImgField, now: number): void => { (img.ft ??= {})[f] = now; };
/**
 * Когда правилось поле. Нет отметки — поле не правилось с рождения записи: у обеих копий оно одно и то же, и спорить не о чем
 * (0, а не `at`: `at` двигает правка ЛЮБОГО поля, и нетронутый статус «побеждал» бы чужую правку статуса).
 */
const fieldAt = (img: SlotImage, f: ImgField): number => img.ft?.[f] ?? 0;

/** Добавить картинку в слот (в конец). Первая в слоте становится главной. */
export function addImage(doc: ArtbookDoc, key: string, img: { id: string; url: string; caption?: string; name?: string; status?: ImgStatus }, now: number): SlotImage {
  const list = doc.slots[key] ?? (doc.slots[key] = []);
  const rec: SlotImage = { id: img.id, url: img.url, caption: img.caption ?? '', status: img.status ?? 'draft', at: now };
  if (img.name) rec.name = img.name;
  list.push(rec);
  fixMain(list);
  return rec;
}

/** Подпись / статус картинки. `true` — изменилось. */
export function updateImage(doc: ArtbookDoc, key: string, id: string, patch: { caption?: string; status?: ImgStatus }, now: number): boolean {
  const img = slotImages(doc, key).find((x) => x.id === id);
  if (!img) return false;
  let changed = false;
  if (patch.caption !== undefined && patch.caption !== img.caption) { img.caption = patch.caption; stamp(img, 'caption', now); changed = true; }
  if (patch.status !== undefined && patch.status !== img.status && IMG_STATUSES.includes(patch.status)) { img.status = patch.status; stamp(img, 'status', now); changed = true; }
  if (changed) img.at = now;
  return changed;
}

/** ★ — эту картинку главной (снимает ★ с прочих). */
export function setMain(doc: ArtbookDoc, key: string, id: string, now: number): boolean {
  const list = slotImages(doc, key);
  const img = list.find((x) => x.id === id);
  if (!img || img.main) return false;
  for (const x of list) if (x.main) { delete x.main; stamp(x, 'main', now); }
  img.main = true; img.at = now; stamp(img, 'main', now);
  return true;
}

/** Убрать картинку из слота (файл на сервере не трогаем — на него могли сослаться). Главная уходит — ★ у первой. */
export function removeImage(doc: ArtbookDoc, key: string, id: string, now: number): boolean {
  const list = doc.slots[key];
  if (!list) return false;
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) return false;
  list.splice(i, 1);
  if (!list.length) delete doc.slots[key];
  else fixMain(list);
  doc.gone[goneImg(key, id)] = now;
  return true;
}

/** Сдвинуть картинку в полосе вариантов (−1 влево, +1 вправо). Перестановка отмечается временем — её не перепишет вторая машина. */
export function moveImage(doc: ArtbookDoc, key: string, id: string, dir: -1 | 1, now: number): boolean {
  const list = doc.slots[key];
  if (!list) return false;
  const i = list.findIndex((x) => x.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return false;
  [list[i], list[j]] = [list[j]!, list[i]!];
  doc.ord[key] = now;
  return true;
}

/** Главная картинка слота (★, иначе первая). */
export const mainOf = (list: readonly SlotImage[]): SlotImage | undefined => list.find((x) => x.main) ?? list[0];

/**
 * ОБЛОЖКА для миниатюр (списки, матрица): утверждённая главная, иначе любая утверждённая. Черновик обложкой не бывает —
 * миниатюра обещает «концепт есть», а черновик — ещё не концепт.
 */
export const coverOf = (list: readonly SlotImage[]): SlotImage | undefined => {
  const m = mainOf(list);
  return m && m.status === 'approved' ? m : list.find((x) => x.status === 'approved');
};

/** Сводный статус слота: есть утверждённая → «утверждён»; есть картинки → «черновик»; пусто → «нет». */
export function slotState(list: readonly SlotImage[]): ImgStatus {
  if (list.some((x) => x.status === 'approved')) return 'approved';
  return list.length ? 'draft' : 'none';
}

// ── Загрузка файлов ──────────────────────────────────────────────────────────────────────────────

/**
 * Тип содержимого картинки для ручки `POST /api/dev/assets/<id>` (сервер принимает ровно эти три). `null` — не картинка.
 * Тип файла от браузера главнее расширения: gif / psd / tiff, переименованный в `.png`, — не картинка (сервер записал бы его под
 * чужим расширением); расширение решает, только когда браузер типа не знает.
 */
export function imageContentType(fileName: string, mime = ''): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  const m = mime.toLowerCase();
  if (m === 'image/png' || m === 'image/jpeg' || m === 'image/webp') return m;
  if (m === 'image/jpg' || m === 'image/pjpeg') return 'image/jpeg';   // нестандартные имена jpeg у части систем
  if (m.startsWith('image/')) return null;
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  return null;
}

/**
 * id файла на сервере. Сервер режет всё, кроме `[a-zA-Z0-9_-]`, поэтому id собираем сами из того же набора: префикс `ab`,
 * ключ слота латиницей (кириллица и `:` выпадают), время и соль — новый файл на каждую заливку (кэш браузера не покажет
 * старую картинку под тем же адресом).
 */
export function uploadId(key: string, now: number, salt: number): string {
  const slug = key.replace(/:/g, '-').replace(/[^a-zA-Z0-9_-]/g, '').replace(/-+/g, '-').slice(0, 48).replace(/^-|-$/g, '');
  const s = Math.abs(Math.floor(salt)).toString(36).slice(0, 4).padStart(4, '0');
  return `ab_${slug || 'slot'}_${Math.max(0, Math.floor(now)).toString(36)}${s}`;
}

/** Папка картинок артбука на сервере (`?dir=`). */
export const ARTBOOK_DIR = 'artbook';

/** Предел тела ручки загрузки на сервере (`express.raw({ limit: '64mb' })`). */
export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

/**
 * Проверка файла ДО заливки: тип (`imageContentType`), пустой файл и предел сервера — текстом для слота, без похода на сервер
 * (лишние 64+ МБ по сети ради отказа 413 не гоняем). `null` — можно лить.
 */
export function uploadProblem(fileName: string, mime: string, size: number): string | null {
  if (!imageContentType(fileName, mime)) return `«${fileName}» — не картинка png / jpg / webp`;
  if (!(size > 0)) return `«${fileName}» — пустой файл`;
  if (size > MAX_UPLOAD_BYTES) return `«${fileName}» — ${Math.round(size / 1048576)} МБ, больше предела сервера (64 МБ)`;
  return null;
}

// ── Слияние двух копий (две машины, вкладка и сервер) ─────────────────────────────────────────────

/**
 * СЛИЯНИЕ локальной копии и серверной — без потерь с обеих сторон. Документ — это словари (путь → правка, слот → картинки),
 * поэтому спорить почти не о чем: каждая запись живёт сама по себе, при встрече одной и той же берётся более поздняя (`at`),
 * удалённое (метка в `gone` не раньше записи) не воскресает. ★ — у самой поздней из отмеченных. Порядок картинок — у копии с
 * более поздней перестановкой (`ord`; поровну — у `a`), картинки, которых в ней нет, — в конец.
 *
 * Зачем не «локальное — истина» роадмапа: артбук правят с двух машин (картинки с одной, тексты с другой), и замена целиком
 * теряла бы чужие картинки; а слияние словарей тривиально и не требует кнопки «забрать».
 */
export function mergeArtbook(a: ArtbookDoc, b: ArtbookDoc): ArtbookDoc {
  const out = EMPTY_ARTBOOK();
  out.updatedAt = Math.max(a.updatedAt, b.updatedAt);
  for (const g of [a.gone, b.gone]) for (const [k, t] of Object.entries(g)) out.gone[k] = Math.max(out.gone[k] ?? 0, t);
  for (const o of [a.ord, b.ord]) for (const [k, t] of Object.entries(o)) out.ord[k] = Math.max(out.ord[k] ?? 0, t);
  for (const path of new Set([...Object.keys(a.texts), ...Object.keys(b.texts)])) {
    const x = a.texts[path], y = b.texts[path];
    const pick = !x ? y! : !y ? x : (y.at > x.at ? y : x);
    if ((out.gone[goneText(path)] ?? -1) >= pick.at) continue;
    out.texts[path] = { ...pick };
  }
  for (const key of new Set([...Object.keys(a.slots), ...Object.keys(b.slots)])) {
    const la = a.slots[key] ?? [], lb = b.slots[key] ?? [];
    const byId = new Map<string, SlotImage>();
    for (const img of [...la, ...lb]) {
      const prev = byId.get(img.id);
      byId.set(img.id, prev ? mergeImage(prev, img) : { ...img, ...(img.ft ? { ft: { ...img.ft } } : {}) });
    }
    const [first, second] = (b.ord[key] ?? 0) > (a.ord[key] ?? 0) ? [lb, la] : [la, lb];
    const order = [...first.map((x) => x.id), ...second.map((x) => x.id).filter((id) => !first.some((x) => x.id === id))];
    const list = order.map((id) => byId.get(id)!).filter((img) => (out.gone[goneImg(key, img.id)] ?? -1) < img.at);
    const flagged = list.filter((x) => x.main).sort((p, q) => fieldAt(q, 'main') - fieldAt(p, 'main'))[0];
    for (const x of list) delete x.main;
    if (flagged) flagged.main = true;
    fixMain(list);
    if (list.length) out.slots[key] = list;
  }
  return out;
}

/** Одна картинка из двух копий: адрес и имя — от более поздней записи, подпись/статус/★ — каждое от своей поздней правки. */
function mergeImage(x: SlotImage, y: SlotImage): SlotImage {
  const newer = y.at > x.at ? y : x;
  const out: SlotImage = { id: x.id, url: newer.url, caption: x.caption, status: x.status, at: Math.max(x.at, y.at) };
  if (newer.name) out.name = newer.name;
  const ft: Partial<Record<ImgField, number>> = {};
  for (const f of IMG_FIELDS) {
    const src = fieldAt(y, f) > fieldAt(x, f) ? y : x;
    if (f === 'caption') out.caption = src.caption;
    else if (f === 'status') out.status = src.status;
    else if (src.main) out.main = true;
    const t = src.ft?.[f];
    if (t !== undefined) ft[f] = t;
  }
  if (Object.keys(ft).length) out.ft = ft;
  return out;
}

/** Канонический вид для сравнения «одно и то же?» (порядок ключей объекта не важен, порядок картинок — важен). */
export function canonArtbook(d: ArtbookDoc): string {
  const sortObj = (o: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
  return JSON.stringify({
    texts: sortObj(Object.fromEntries(Object.entries(d.texts).map(([k, t]) => [k, sortObj({ ...t })]))),
    slots: sortObj(Object.fromEntries(Object.entries(d.slots).map(([k, l]) => [k, l.map((x) => sortObj({ ...x }))]))),
    gone: sortObj(d.gone),
    ord: sortObj(d.ord),
  });
}

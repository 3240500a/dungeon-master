/**
 * ⭐⭐ ВЕСА СЛОЁВ ПО ЧАСТЯМ ТЕЛА (`pe_layers`): сколько каждой части достаётся ЛОКОМОЦИИ, а сколько — авторской СТОЙКЕ.
 *
 * Жалоба автора (19.09): «при беге руки почти не дрыгаются — берётся почти на 100 % idle-поза, если оружие в руке
 * и щит; надо, чтобы бег влиял сильнее… надо, чтобы можно было настраивать, какие анимации как влияют при беге».
 *
 * ЧТО БЫЛО. Верх тела блендится к стойке весом `hw = 1 − sway·ход`, и `sway` (`pe_sway`) — ОДНО число на оружие:
 * общее для ходьбы и бега, обеих рук, кистей, ключиц и груди. ЗАМЕР (опубликованный воин, бег 120 u/с, «только клипы»,
 * размах плеча): `none` (sway 0.5) — 30.0°, `sword` и `sword+shield` (записи нет → умолчание 0.2) — 13.8°, а при
 * sway 1 — 56.0°. То есть под мечом клипу бега доставалась пятая часть рук, и поднять её было нечем: ползунок на
 * вкладке «Бег» рисовался только у ТОЧНОГО ключа оружия с клипом стойки, а у `sword+shield` такого клипа нет.
 *
 * ЧТО СТАЛО. Вес — на ЧАСТЬ тела (модель Blend Mask из Unreal / веса слоя Animator из Unity), парой ходьба/бег
 * (интерполяция по той же оси `sb`, что у всех ручек походки) и с разрежённой колонкой БОЯ (нет записи — как в
 * релаксе; смешивается тем же плавным `combat`, что блендит саму стойку).
 *
 * ⚠ ЧАСТИ — ТОЛЬКО ТЕ, ЗА КОТОРЫЕ СТОЙКА И ЛОКОМОЦИЯ РЕАЛЬНО СПОРЯТ. Таз, ноги и поясница — всегда у локомоции
 * (в «только клипы» их больше некому вести), пальцы — всегда у хвата (вес 1, см. `applyGripChannels`). Кисть
 * (запястье) отделена от руки НАМЕРЕННО: оружие висит на кости кисти, и общий вес «рука» при подъёме маха заодно
 * распрямлял бы запястье к позе клипа — меч смотрел бы не туда, куда его поставил автор стойки.
 *
 * ⚠⚠ «Л/П» — СВОИ стороны персонажа (кости `Left*` / `Right*`), как везде после таблицы истины страйфа (`pose.ts`).
 *
 * Модуль ЧИСТЫЙ (только разбор данных и арифметика) — тестируется в node; один и тот же код читают игра
 * (`localStorageContent`) и редактор (`resolveUpper` поз-редактора): поиск ключа у них раньше РАСХОДИЛСЯ
 * (игра искала полную стойку по историческому имени `idle_<w>`, редактор — по привязке), и для `none+shield`
 * редактор показывал 0.2, пока игра играла 0.5.
 */

export type LayerPart = 'armL' | 'armR' | 'wristL' | 'wristR' | 'chest' | 'head';

/** Части в порядке показа. Кости части — ровно те, что смешиваются этим весом в `poseRuntime.applyUpper`. */
export const LAYER_PARTS: readonly { id: LayerPart; label: string; bones: readonly string[] }[] = [
  { id: 'armL', label: 'рука Л', bones: ['LeftShoulder', 'LeftUpperArm', 'LeftLowerArm'] },
  { id: 'armR', label: 'рука П', bones: ['RightShoulder', 'RightUpperArm', 'RightLowerArm'] },
  { id: 'wristL', label: 'кисть Л', bones: ['LeftHand'] },
  { id: 'wristR', label: 'кисть П', bones: ['RightHand'] },
  { id: 'chest', label: 'грудь', bones: ['Chest', 'UpperChest'] },
  { id: 'head', label: 'голова', bones: ['Neck', 'Head'] },
];
/** То, у чего ручки НЕТ и не будет, — чтобы панель говорила это прямо, а не заставляла искать ползунок. */
export const LAYER_FIXED: readonly { label: string; owner: string }[] = [
  { label: 'таз · ноги · поясница', owner: 'всегда локомоция' },
  { label: 'пальцы', owner: 'всегда хват' },
];
export const LAYER_PART_IDS: readonly LayerPart[] = LAYER_PARTS.map((p) => p.id);
/** Кость → часть. Кости вне таблицы весом слоёв не управляются. */
export const LAYER_PART_OF: Readonly<Record<string, LayerPart>> = (() => {
  const m: Record<string, LayerPart> = {};
  for (const p of LAYER_PARTS) for (const b of p.bones) m[b] = p.id;
  return m;
})();

export type PartWeights = Partial<Record<LayerPart, number>>;
/** Настройка одного ключа оружия. Всё разрежённое: нет числа — работает уровень ниже (бой → релакс → умолчание). */
export interface LayerEntry {
  walk?: PartWeights;
  run?: PartWeights;
  combat?: { walk?: PartWeights; run?: PartWeights };
}
/** Содержимое ключа `pe_layers`: персонаж → ключ оружия → настройка. */
export type LayerStore = Record<string, Record<string, LayerEntry>>;
/** Легаси `pe_sway`: персонаж → ключ оружия → одно число на весь верх. */
export type SwayStore = Record<string, Record<string, number>>;

/** Умолчание легаси-`sway`: с ним жили все ненастроенные оружия. Менять — значит двигать всех разом. */
export const LAYER_LEGACY_DEFAULT = 0.2;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? clamp01(v) : undefined);

/** Убрать суффикс щита — то же правило, что `poseRuntime.baseWeapon` (дубль осознанный: модуль чистый, без THREE). */
export const layerBaseWeapon = (w: string): string => (w.endsWith('+shield') ? w.slice(0, -'+shield'.length) : w);

/**
 * Легаси-число → настройка. ⚠ ГОЛОВА НЕ ЗАПОЛНЯЕТСЯ: `sway` ею никогда не управлял (в смешанном режиме головой
 * владеют ручки походки по ходу, в «только клипы» — стойка), и записать сюда число значило бы изменить позу.
 */
export function entryFromSway(s: number): LayerEntry {
  const v = clamp01(s);
  const one = (): PartWeights => ({ armL: v, armR: v, wristL: v, wristR: v, chest: v });
  return { walk: one(), run: one() };
}

export interface LayerLookup {
  /** Найденная запись `pe_layers`; `null` — её нет, все части верха = `swing`. */
  entry: LayerEntry | null;
  /**
   * Легаси-число на ТОМ ЖЕ ключе (или умолчание 0.2): им живут части без своей записи. ⚠ Настройку из него НЕ
   * синтезируем: `resolveLayers(null, …, swing)` даёт ровно те же пять весов, а объект на каждый кадр — мусор.
   */
  swing: number;
  /** Откуда: новая запись, легаси `pe_sway` или умолчание. */
  source: 'layers' | 'sway' | 'default';
  /** Чей персонаж и какой ключ оружия ответили (для подписи панели «действует настройка для …»). */
  charId: string;
  weapon: string;
}

/**
 * ⭐ ПОИСК НАСТРОЙКИ — ОДИН НА ИГРУ И РЕДАКТОР. Порядок: свой персонаж (точный ключ → базовое оружие), затем
 * персонаж-фолбэк (монстры → воин) в том же порядке, затем умолчание. На каждом ключе новая запись (`pe_layers`)
 * бьёт легаси (`pe_sway`).
 *
 * ⚠ УСЛОВИЕ «ЕСТЬ ЛИ ПОЛНАЯ СТОЙКА НА ТОЧНЫЙ КЛЮЧ» УБРАНО. Раньше ключ выбирался по нему, и проверялось оно в двух
 * местах ПО-РАЗНОМУ (см. шапку). На опубликованных данных (`pe_sway = {warrior: {none: 0.5}}`) новый порядок даёт
 * те же числа, что играла игра: `none`/`none+shield` → 0.5, `sword`/`sword+shield` → умолчание 0.2.
 */
export function lookupLayers(layers: LayerStore | null | undefined, sway: SwayStore | null | undefined,
  charId: string, weapon: string, fallbackId?: string): LayerLookup {
  const base = layerBaseWeapon(weapon);
  const keys = base === weapon ? [weapon] : [weapon, base];
  for (const id of fallbackId && fallbackId !== charId ? [charId, fallbackId] : [charId]) {
    for (const k of keys) {
      const e = layers?.[id]?.[k];
      const s = num(sway?.[id]?.[k]);
      if (e && typeof e === 'object') return { entry: e, swing: s ?? LAYER_LEGACY_DEFAULT, source: 'layers', charId: id, weapon: k };
      if (s !== undefined) return { entry: null, swing: s, source: 'sway', charId: id, weapon: k };
    }
  }
  return { entry: null, swing: LAYER_LEGACY_DEFAULT, source: 'default', charId, weapon };
}

/** Веса этого кадра: доля ЛОКОМОЦИИ 0..1 на часть (до ворот по ходу — их кладёт рантайм). */
export type ResolvedLayers = Record<LayerPart, number>;
export const newResolvedLayers = (): ResolvedLayers => ({ armL: 0, armR: 0, wristL: 0, wristR: 0, chest: 0, head: 0 });

/**
 * ⚠ ТОЧНЫЙ НА КОНЦАХ: `a + (b − a)·1` в плавающей точке НЕ равно `b` (0.9 + (0.2 − 0.9) = 0.20000000000000007), и на
 * чистом беге вес ХОДЬБЫ протекал бы в позу последним битом — «бит в бит» на концах оси держится только ветками.
 */
const lerp = (a: number, b: number, t: number): number => (t <= 0 ? a : t >= 1 ? b : a + (b - a) * t);

/**
 * Настройка → веса кадра. `sb` — ходьба(0)↔бег(1), `combat` — боевая ось 0..1 (обе уже сглажены рантаймом).
 *
 * `dflt` — умолчание пяти частей верха (легаси-`sway` либо `LAYER_LEGACY_DEFAULT`), `headDflt` — умолчание головы,
 * и оно ЗАВИСИТ ОТ РЕЖИМА: в смешанном головой владеют ручки походки (1), в «только клипы» — стойка (0). Это
 * сегодняшнее поведение обоих режимов, и без записи о голове оно сохраняется бит в бит.
 *
 * ⚠ Колонка боя разрежена ПО КЛЮЧУ (часть × скорость): пропуск наследует релакс ТОЙ ЖЕ скорости, а не ноль.
 */
export function resolveLayers(entry: LayerEntry | null | undefined, sb: number, combat: number,
  dflt: number, headDflt: number, out: ResolvedLayers): ResolvedLayers {
  const s = clamp01(sb), c = clamp01(combat);
  for (const p of LAYER_PART_IDS) {
    const d = p === 'head' ? headDflt : dflt;
    const w0 = num(entry?.walk?.[p]) ?? d, r0 = num(entry?.run?.[p]) ?? d;
    let v = lerp(w0, r0, s);
    if (c > 0 && entry?.combat) {
      const wc = num(entry.combat.walk?.[p]) ?? w0, rc = num(entry.combat.run?.[p]) ?? r0;
      v = lerp(v, lerp(wc, rc, s), c);
    }
    out[p] = clamp01(v);
  }
  return out;
}

/** Все части одним числом — для перекрытия запекания (см. `setLayerBakeOverride` в `poseRuntime.ts`). */
export function fillLayers(out: ResolvedLayers, v: number): ResolvedLayers {
  for (const p of LAYER_PART_IDS) out[p] = v;
  return out;
}

// ── Правка (редактор) ────────────────────────────────────────────────────────────────────────────

export type LayerSpeed = 'walk' | 'run';

/**
 * Значение ячейки панели С УЧЁТОМ НАСЛЕДОВАНИЯ — то, что реально сработает: бой без записи показывает релакс,
 * релакс без записи — умолчание. `own` — есть ли у ячейки СВОЯ запись (для подсветки и кнопки сброса).
 */
export function layerCell(entry: LayerEntry | null | undefined, part: LayerPart, speed: LayerSpeed, combat: boolean,
  dflt: number, headDflt: number): { value: number; own: boolean } {
  const d = part === 'head' ? headDflt : dflt;
  const relax = num(entry?.[speed]?.[part]);
  if (!combat) return { value: relax ?? d, own: relax !== undefined };
  const cv = num(entry?.combat?.[speed]?.[part]);
  return { value: cv ?? relax ?? d, own: cv !== undefined };
}

/** Записать ячейку (значение зажимается в 0..1). Возвращает ТОТ ЖЕ объект — живую запись читает кукла. */
export function setLayerCell(entry: LayerEntry, part: LayerPart, speed: LayerSpeed, combat: boolean, v: number): LayerEntry {
  const tgt = combat ? ((entry.combat ??= {})[speed] ??= {}) : (entry[speed] ??= {});
  tgt[part] = clamp01(v);
  return entry;
}

/** Снять СВОЮ запись ячейки: снова работает уровень ниже. Пустые контейнеры убираются — в `pe_layers` не едет мусор. */
export function clearLayerCell(entry: LayerEntry, part: LayerPart, speed: LayerSpeed, combat: boolean): LayerEntry {
  const box = combat ? entry.combat : entry;
  const tgt = box?.[speed];
  if (tgt) { delete tgt[part]; if (!Object.keys(tgt).length) delete box![speed]; }
  if (entry.combat && !Object.keys(entry.combat).length) delete entry.combat;
  return entry;
}

/**
 * Запись для ПРАВКИ под точным ключом: есть — она сама; нет — заводится КОПИЕЙ того, что действует сейчас
 * (`lookupLayers`), чтобы первое касание ползунка не сбрасывало остальные части в умолчание.
 */
export function ensureLayerEntry(layers: LayerStore, sway: SwayStore | null | undefined,
  charId: string, weapon: string, fallbackId?: string): LayerEntry {
  const own = layers[charId]?.[weapon];
  if (own && typeof own === 'object') return own;
  const cur = lookupLayers(layers, sway, charId, weapon, fallbackId);
  // Действует чужая запись — копируем её; действует легаси-число — разворачиваем его в пять частей; умолчание — пусто
  // (пустая запись = умолчание, и панель честно покажет ячейки «без своей записи»).
  const copy: LayerEntry = cur.entry ? JSON.parse(JSON.stringify(cur.entry)) as LayerEntry
    : cur.source === 'sway' ? entryFromSway(cur.swing) : {};
  (layers[charId] ??= {})[weapon] = copy;
  return copy;
}

/** Разобрать сырой `pe_layers` (чужой JSON): мусорные ветки отбрасываются, числа зажимаются. */
export function readLayerStore(raw: unknown): LayerStore {
  const out: LayerStore = {};
  if (!raw || typeof raw !== 'object') return out;
  const parts = (v: unknown): PartWeights | undefined => {
    if (!v || typeof v !== 'object') return undefined;
    const o: PartWeights = {};
    for (const p of LAYER_PART_IDS) { const n = num((v as Record<string, unknown>)[p]); if (n !== undefined) o[p] = n; }
    return Object.keys(o).length ? o : undefined;
  };
  for (const [id, byW] of Object.entries(raw as Record<string, unknown>)) {
    if (!byW || typeof byW !== 'object') continue;
    for (const [w, e] of Object.entries(byW as Record<string, unknown>)) {
      if (!e || typeof e !== 'object') continue;
      const src = e as Record<string, unknown>;
      const entry: LayerEntry = {};
      const wk = parts(src.walk), rn = parts(src.run);
      if (wk) entry.walk = wk;
      if (rn) entry.run = rn;
      if (src.combat && typeof src.combat === 'object') {
        const c = src.combat as Record<string, unknown>;
        const cw = parts(c.walk), cr = parts(c.run);
        if (cw || cr) entry.combat = { ...(cw ? { walk: cw } : {}), ...(cr ? { run: cr } : {}) };
      }
      (out[id] ??= {})[w] = entry;
    }
  }
  return out;
}

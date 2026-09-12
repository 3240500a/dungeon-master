/**
 * ЛИЧНЫЕ НАСТРОЙКИ ИНСТРУМЕНТА (`pe_prefs`) — то, что относится к рабочему месту, а не к контенту.
 *
 * ЗАЧЕМ ОТДЕЛЬНО. В индустрии это разведено жёстко: Unity кладёт `ProjectSettings` в систему контроля версий,
 * а `UserSettings`/`EditorPrefs` — «can't be checked into source control and shared between users». У нас же
 * тумблеры вьюпорта либо не сохранялись вовсе, либо случайно попадали в КОНТЕНТ (`pe_ragdoll`, `pe_phys`) и
 * ехали на сервер, перетирая соседу его вид.
 *
 * ЗАМЕР, ради которого это сделано: 8 из 10 тумблеров не переживали F5 —
 * `таз: вращать→двигать`, `физ: выкл→вкл`, `манекен: тело→скелет`, `солвер: FABRIK→аналитика`,
 * `баланс: выкл→вкл`, `боксы: видны→скрыты`, `гизмо предела: выкл→вкл`, `клэмп FK: выкл→вкл`.
 *
 * ПРАВИЛО: ключ `pe_prefs` НЕ входит в `POSE_KEYS` и не публикуется никогда. Если настройка влияет на то,
 * КАК ВЫГЛЯДИТ ИГРА (пределы суставов, профиль физики, стойки) — это контент, ей здесь не место.
 */
const KEY = 'pe_prefs';

export interface EditorPrefs {
  // вид вьюпорта
  phys?: boolean;            // физ-силуэт вокруг скелета
  boxes?: boolean;           // боксы физ-тел
  mannequin?: string;        // 'skeleton' | 'solid' — вид манекена
  hipsMode?: string;         // 'move' | 'rotate' — что делает гизмо таза
  limitGizmo?: boolean;      // гизмо предела сустава
  clampFk?: boolean;         // клэмп FK по пределам
  solver?: string;           // 'analytic' | 'fabrik'
  balance?: boolean;         // компенсация баланса
  groundFeet?: boolean;      // заземление стоп
  snap?: boolean;            // шаг гизмо включён
  snapMove?: number;         // шаг перемещения, ед. мира
  snapRot?: number;          // шаг поворота, градусы
  floorMannequin?: boolean;  // манекен на полу
  // рабочее место
  tab?: string;              // выбранная вкладка панели
  charId?: string; weapon?: string; clip?: string;   // на чём остановился
  pro?: boolean; posMark?: boolean; aSkel?: number; aHandle?: number;
  open?: Record<string, boolean>;                    // свёрнутость свитков
  clipKind?: string; clipSort?: string; panelW?: number;
  [k: string]: unknown;
}

function read(): EditorPrefs {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') as EditorPrefs; } catch { return {}; }
}
let cache: EditorPrefs | null = null;
/** Весь словарь (читается один раз за сессию, дальше из памяти). */
export function prefs(): EditorPrefs { return (cache ??= read()); }

/** Записать личную настройку. Пишется сразу — «сохранить настройки» кнопкой быть не должно. */
export function setPref<K extends keyof EditorPrefs>(key: K, value: EditorPrefs[K]): void {
  const p = prefs(); p[key] = value;
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* приватный режим */ }
}
/** Прочитать с дефолтом (дефолт = поведение до Ф12, чтобы ничего не поехало у тех, у кого ключа ещё нет). */
export function getPref<T>(key: string, fallback: T): T {
  const v = prefs()[key];
  return v === undefined ? fallback : v as T;
}

/**
 * Разовый переезд из `pe_ui` (там личное лежало вперемешку с прочим) — чтобы у юзера не слетели уже
 * настроенные прозрачности и свитки. Зовётся из редактора на старте; идемпотентна.
 */
export function migrateFromUi(ui: Record<string, unknown>): void {
  const p = prefs();
  let moved = false;
  for (const k of ['pro', 'posMark', 'aSkel', 'aHandle', 'open', 'clipKind', 'clipSort', 'panelW']) {
    if (ui[k] !== undefined && p[k] === undefined) { p[k] = ui[k]; moved = true; }
  }
  if (moved) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* */ } }
}

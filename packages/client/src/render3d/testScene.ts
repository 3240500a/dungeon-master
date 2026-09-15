/**
 * ТЕСТОВАЯ СЦЕНА поз-редактора: НАСТОЯЩЕЕ серверное ядро, запущенное локально.
 *
 * Зачем так, а не «сделать в редакторе движение по WASD». Проверять походку в редакторе, а потом
 * перепроверять в клиенте — значит каждый раз гадать, что именно разошлось: настройка или превью.
 * А написать в редакторе своё движение — гарантированно завести второе поведение, которое разойдётся
 * с игрой ровно там, где интереснее всего: на разгоне, на развороте, у стены.
 *
 * Поэтому здесь крутится `GameSession` — то же самое ядро, которым ходит сервер, теми же тиками
 * (30 Гц) и тем же `PlayerInput`. Правило «перемещение и поворот только на сервере» не нарушено: мы
 * не пишем клиентское движение, мы ЗАПУСКАЕМ серверное. Дальше снапшот идёт в куклу общим приводом
 * (`driveActor`), то есть тем же кодом, что и в игре.
 *
 * Комната пустая и это осознанно: меньше движущихся частей — проще доказать, что расхождений нет.
 * Монстр добавляется отдельным шагом, когда база подтвердится.
 */
// Импорт ТОЛЬКО через бочку `@dm/shared`: глубокие пути работают в tsc и vitest, но `vite build`
// резолвит алиас в сам index.ts и падает. Один раз наступив, записываем.
import { ConfigRegistry, Cell, TILE, makeGrid, cellToWorld, newBotSave, GameSession, type Grid, type PlayerInput, type SessionEvent } from '@dm/shared';

/** Тик сервера. Та же цифра, что в `scheduler.ts`; расходиться ей нельзя — от неё зависит вся динамика. */
export const TEST_TICK_DT = 1 / 30;
/** Размер комнаты в клетках. Хватает разогнаться до бега и затормозить у стены. */
const ROOM_W = 28, ROOM_H = 20;

export interface TestPlayerView {
  x: number; z: number; facing: number;
  alive: boolean; inCombat: boolean; stun: boolean;
  hp: number; maxHp: number;
}

export interface TestScene {
  /** Прокрутить ядро НАКОПЛЕННЫМ временем фиксированными тиками — ровно как это делает сервер. */
  step(dt: number, input: PlayerInput): SessionEvent[];
  readonly view: TestPlayerView;
  /** Границы комнаты в мировых единицах — для пола и рамки. */
  readonly bounds: { w: number; h: number };
  /** Поставить персонажа в центр и обнулить накопитель. */
  reset(): void;
  /**
   * Секция `balance` того же конфига, на котором крутится сцена. Нужна вкладке для КАМЕРЫ: её
   * настройки живут в конфиге, а второй раз читать и парсить `pe_config` каждый кадр — дорого
   * и означало бы вторую правду о том, какой конфиг сейчас в силе.
   */
  readonly balance: unknown;
}

/** Открытое поле с бордюром-стеной: в него можно упереться, и это тоже надо уметь посмотреть. */
function openField(cols: number, rows: number): Grid {
  const g = makeGrid(cols, rows, Cell.Floor);
  for (let x = 0; x < cols; x++) { g[0]![x] = Cell.Wall; g[rows - 1]![x] = Cell.Wall; }
  for (let y = 0; y < rows; y++) { g[y]![0] = Cell.Wall; g[y]![cols - 1] = Cell.Wall; }
  return g;
}

/** Конфиг берём тот же, что синкнул редактор (`pe_config`); нет его — встроенные дефолты. */
function registry(): ConfigRegistry {
  const r = new ConfigRegistry();
  try {
    const raw = localStorage.getItem('pe_config');
    if (raw) { r.loadAll(JSON.parse(raw) as Record<string, unknown>); return r; }
  } catch { /* битый кэш — не повод остаться без сцены */ }
  r.loadAll();
  return r;
}

/** Классы, за которые можно играть. Персонаж редактора может быть монстром — тогда берём воина. */
const CLASSES = new Set(['warrior', 'mage', 'archer']);

export function createTestScene(charId: string): TestScene {
  const reg = registry();
  const cls = CLASSES.has(charId) ? charId : 'warrior';
  const session = new GameSession(reg, 1, 'normal');
  session.addPlayer('me', newBotSave(reg, cls));
  const grid = openField(ROOM_W, ROOM_H);
  const spawn = cellToWorld((ROOM_W / 2) | 0, (ROOM_H / 2) | 0);
  session.enterFloor(1, { grid, spawn, monsters: [] });

  const p = session.world.players['me']!;   // WorldState.players — карта по id, не массив
  const view: TestPlayerView = { x: p.pos.x, z: p.pos.y, facing: 0, alive: true, inCombat: false, stun: false, hp: 1, maxHp: 1 };
  let acc = 0;

  const sync = (): void => {
    view.x = p.pos.x; view.z = p.pos.y; view.facing = p.facing;
    view.alive = p.hp > 0; view.hp = p.hp; view.maxHp = p.maxHp;
    view.inCombat = !!p.combatTimer;
    view.stun = p.stunTimer > 0;
  };
  sync();

  return {
    step(dt, input): SessionEvent[] {
      // ФИКСИРОВАННЫЙ шаг, как у сервера: переменный dt дал бы другую физику, и «1:1» кончилось бы
      // здесь же. Потолок в 4 тика — против спирали смерти после сворачивания вкладки.
      acc = Math.min(acc + dt, TEST_TICK_DT * 4);
      const out: SessionEvent[] = [];
      while (acc >= TEST_TICK_DT) { acc -= TEST_TICK_DT; out.push(...session.tick(TEST_TICK_DT, { me: input })); }
      sync();
      return out;
    },
    view,
    bounds: { w: ROOM_W * TILE, h: ROOM_H * TILE },
    balance: reg.get('balance'),
    reset(): void {
      p.pos.x = spawn.x; p.pos.y = spawn.y; acc = 0;
      sync();
    },
  };
}

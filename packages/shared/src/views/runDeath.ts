/**
 * ⭐⭐ С-views (29.10): ОКНО СМЕРТИ — надписи считает СЕРВЕР, у клиента остаётся ровно одно: открыто ли окно.
 *
 * Порт `DeathWindow.OnFrame/View/Dock` (Unity `Assets/DM/UI/DeathWindow.cs`; исходник правила — веб `ui/deathWindow.ts`). Ключи —
 * поля C# `DeathState` / `DeathView` / `DeathDock`.
 *
 * ⚠⚠ КАК ДЕЛИТСЯ РАБОТА. Состояние смерти — это память о ПОТЕРЯХ (из кадра самой смерти) и режим (из статусов `died`); всё это
 * сервер знает лучше клиента — он сам шлёт эти кадры. Единственный вход, которого сервер не знает, — «Смотреть» (`dismiss`):
 * игрок закрыл окно у себя. Поэтому сервер шлёт на каждый `died` готовые `view` и `dock` (плашку — какой она была бы при ЗАКРЫТОМ
 * окне) и флаг `opens` («эта смерть открывает окно»), а клиент хранит только `open`:
 *   `opens` → open = true; open → показать `view`, иначе — `dock` (если есть); «Смотреть» → open = false, показать `dock`.
 * Сторож `runGolden.test.ts` проигрывает так эталонные последовательности `death` и сверяет каждый шаг с `DeathFlow` Unity.
 */

/** C# `DeathState`. */
export interface RunDeathState {
  hasLosses: boolean; lossGold: number; lossItems: number;
  toTown: boolean; canLeave: boolean; pvp: boolean; wipe: boolean; open: boolean;
}
/** C# `DeathView`. */
export interface RunDeathView { title: string; loss: string | null; status: string; spectate: string | null; town: string | null }
/** C# `DeathDock`. */
export interface RunDeathDock { status: string; town: string }

/** Кадр `died` (поля, которые читает окно). */
export interface RunDiedFrame {
  goldLost?: number; itemsLost?: number; toTown?: boolean; pvp?: boolean; status?: boolean; canLeave?: boolean;
}

/** Тексты окна — C# `DeathWindow.*`. */
export const RUN_DEATH_TEXT = {
  canLeave: 'Живых в пати не осталось: напарник отключился посреди боя. Ждите его — или уходите в город (отключившийся погибнет, забег без живых кончится).',
  town: 'В город',
  wait: 'Ожидайте: пати спустится — там возродитесь.',
  spectate: 'Смотреть',
} as const;

const flag = (v: unknown): boolean => v === true;
/** C# `Int`: целое — как есть, дробное — отбросом дробной части, прочее — 0. */
const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0);

/** Новое состояние по кадру `died` (C# `DeathWindow.OnFrame`). */
export function runDeathOnFrame(prev: RunDeathState | null, f: RunDiedFrame): RunDeathState {
  const canLeave = flag(f.canLeave), pvp = flag(f.pvp), toTown = flag(f.toTown);
  if (!flag(f.status) || pvp) {
    return {
      hasLosses: !pvp, lossGold: pvp ? 0 : int(f.goldLost), lossItems: pvp ? 0 : int(f.itemsLost),
      toTown, canLeave, pvp, wipe: !pvp && toTown, open: true,
    };
  }
  if (!prev) return { hasLosses: false, lossGold: 0, lossItems: 0, toTown, canLeave, pvp: false, wipe: false, open: true };
  return { hasLosses: prev.hasLosses, lossGold: prev.lossGold, lossItems: prev.lossItems, toTown, canLeave, pvp: prev.pvp, wipe: false, open: prev.open };
}

/** Надписи и кнопки окна (C# `DeathWindow.View`). */
export function runDeathView(s: RunDeathState): RunDeathView {
  if (s.pvp) return { title: 'Вы повержены', loss: null, status: 'Возрождение через пару секунд…', spectate: 'Смотреть за соперником', town: null };
  return {
    title: 'Вы погибли',
    loss: s.hasLosses ? `Потеряно: <b>${s.lossGold}</b> золота, <b>${s.lossItems}</b> предм.` : null,
    status: s.toTown ? 'Возвращаетесь в город…' : s.canLeave ? RUN_DEATH_TEXT.canLeave : RUN_DEATH_TEXT.wait,
    spectate: s.wipe ? null : RUN_DEATH_TEXT.spectate,
    town: s.canLeave && !s.toTown ? RUN_DEATH_TEXT.town : null,
  };
}

/** Плашка вне окна (C# `DeathWindow.Dock`): только пока окно закрыто, а выход есть. */
export function runDeathDock(s: RunDeathState | null): RunDeathDock | null {
  if (!s || s.open || s.pvp || !s.canLeave || s.toTown) return null;
  return { status: RUN_DEATH_TEXT.canLeave, town: RUN_DEATH_TEXT.town };
}

/** Что сервер кладёт в кадр `died` получателю (см. шапку). */
export interface RunDeathFrameView {
  /** Новое состояние — сервер хранит его на героя до сброса (возрождение, вход, смена области). */
  state: RunDeathState;
  /** Открывает ли этот кадр окно (новая смерть, арена, статус без смерти в памяти); иначе окно остаётся, как его оставил игрок. */
  opens: boolean;
  view: RunDeathView;
  /** Плашка при ЗАКРЫТОМ окне (null — плашки нет). Открыто окно — клиент её не рисует. */
  dock: RunDeathDock | null;
}

/**
 * ⭐⭐ ШАГ СЕРВЕРА НА КАДР `died`. `prev` — состояние, которое сервер держит на героя (null — жив / сброшено).
 * Сервер: `const dv = runDeathFrame(this.deathOf(pid), frame); this.deathOf(pid) = dv.state; send({...frame, view: dv.view, dock: dv.dock, opens: dv.opens})`.
 */
export function runDeathFrame(prev: RunDeathState | null, f: RunDiedFrame): RunDeathFrameView {
  const state = runDeathOnFrame(prev, f);
  const opens = !flag(f.status) || flag(f.pvp) || !prev;
  return { state, opens, view: runDeathView(state), dock: runDeathDock({ ...state, open: false }) };
}

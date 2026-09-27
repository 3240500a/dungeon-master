import type { ServerFrame } from '@dm/shared';

/** Кадр смерти (`died`): сама смерть — с потерями; ⭐ R13-05: `status` — новый режим окна той же смерти. */
export type DiedFrame = Extract<ServerFrame, { t: 'died' }>;

/** Что сейчас с окном смерти своего героя. `null` снаружи — жив (вход, смена области, возрождение). */
export interface DeathState {
  /** Потери этой смерти — из её кадра; `null` — окно открыто статусом (вошёл мёртвым: штраф взят раньше, до входа). */
  losses: { gold: number; items: number } | null;
  toTown: boolean;
  /** Живых подключённых нет, пати ждёт отвалившегося посреди боя — увести её в город может и мёртвый (кнопка «В город»). */
  canLeave: boolean;
  pvp: boolean;
  /** Смерть вайпом (соло): окно до возврата в город, без «Смотреть» — как было. */
  wipe: boolean;
  /** Окно на экране; «Смотреть» его закрывает, и статусы той же смерти его больше не открывают (выход «В город» — плашкой, R14-03). */
  open: boolean;
}

/**
 * ⭐ R13-05: ОКНО СМЕРТИ ПО КАДРУ `died` — одно правило для 2D (`OnlineScene`) и 3D (`online3d`). Раньше каждый `died` строил окно
 * заново, а сервер слал `died {0, 0}` и как статус (последний живой ушёл — «в город», вернулся — «ждите», вошёл мёртвым): настоящие
 * потери подменялись нулями, окно, закрытое «Смотреть», вставало посреди экрана (у «возвращаетесь в город» — без кнопки, на 15 с), и
 * так на каждую перезагрузку напарника. Теперь статус (`status`) меняет только режим: потери — из кадра самой смерти, закрытое окно
 * остаётся закрытым. Статус без смерти в памяти (вход мёртвым в комнату) — окно без строки потерь.
 */
export function deathOnFrame(prev: DeathState | null, f: DiedFrame): DeathState {
  const canLeave = f.canLeave === true;
  if (f.status !== true || f.pvp) {
    return {
      losses: f.pvp ? null : { gold: f.goldLost, items: f.itemsLost }, toTown: f.toTown, canLeave, pvp: f.pvp === true,
      wipe: !f.pvp && f.toTown, open: true,
    };
  }
  if (!prev) return { losses: null, toTown: f.toTown, canLeave, pvp: false, wipe: false, open: true };
  return { ...prev, toTown: f.toTown, canLeave, wipe: false };
}

/** Надписи окна, которые у 2D и 3D свои. */
export interface DeathLabels { wait: string; spectate: string }

/** Что показать в окне: заголовок, строка потерь (или нет), режим, кнопки (`spectate` — закрыть и смотреть; `town` — `return`). */
export interface DeathView { title: string; loss?: string; status: string; spectate?: string; town?: string }

/** Режим «ждите — или в город» (`canLeave`): одни слова у окна и у плашки вне его (R14-03). */
const CAN_LEAVE = 'Живых в пати не осталось: напарник отключился посреди боя. Ждите его — или уходите в город (отключившийся погибнет, забег без живых кончится).';
const TOWN = 'В город';

export function deathView(s: DeathState, labels: DeathLabels): DeathView {
  if (s.pvp) return { title: 'Вы повержены', status: 'Возрождение через пару секунд…', spectate: 'Смотреть за соперником' };
  const status = s.toTown ? 'Возвращаетесь в город…' : s.canLeave ? CAN_LEAVE : labels.wait;
  return {
    title: 'Вы погибли',
    ...(s.losses ? { loss: `Потеряно: <b>${s.losses.gold}</b> золота, <b>${s.losses.items}</b> предм.` } : {}),
    status,
    ...(s.wipe ? {} : { spectate: labels.spectate }),
    ...(s.canLeave && !s.toTown ? { town: TOWN } : {}),
  };
}

/** Плашка вне окна: режим и кнопка «В город» (`return`). */
export interface DeathDock { status: string; town: string }

/**
 * ⭐ R14-03: ВЫХОД НЕ ПРЯЧЕТСЯ ЗА «СМОТРЕТЬ». Окно закрыто, а у мёртвого есть выход (`canLeave`: живых подключённых нет, пати ждёт
 * отвалившегося посреди боя) — плашка с «В город» вне окна: не модалка, наблюдению не мешает, а закрытое окно само не встаёт (R13-05).
 * Раньше статус `canLeave`, пришедший ПОСЛЕ «Смотреть» (обычный порядок: напарник отвалился позже), не рисовался нигде — сервер
 * шлёт его один раз, — и мёртвый до часа (`reconnectGraceSec`) ждал без текста и кнопки: выход — F5 или «Завершить» со штрафом за
 * весь забег. `null` — плашки нет (окно на экране, выхода нет, пати и так уходит в город, арена).
 */
export function deathDock(s: DeathState | null): DeathDock | null {
  if (!s || s.open || s.pvp || !s.canLeave || s.toTown) return null;
  return { status: CAN_LEAVE, town: TOWN };
}

/**
 * ⭐ R13-05: окно смерти клиента — состояние (`deathOnFrame`) и отрисовка (`show`/`hide` — DOM клиента). `dismiss` — «Смотреть»,
 * `reset` — жив снова или мир сменился (вход, смена области, возрождение арены, потеря связи). ⭐ R14-03: `dock` — плашка «В город»
 * вне окна (`deathDock`), зовётся на каждую смену состояния; `null` — убрать.
 */
export class DeathWindow {
  private s: DeathState | null = null;
  constructor(private readonly ui: { show(v: DeathView): void; hide(): void; dock(v: DeathDock | null): void },
    private readonly labels: DeathLabels) {}
  get state(): DeathState | null { return this.s; }
  onDied(f: DiedFrame): void {
    this.s = deathOnFrame(this.s, f);
    if (this.s.open) this.ui.show(deathView(this.s, this.labels));
    this.ui.dock(deathDock(this.s));
  }
  dismiss(): void {
    if (this.s) this.s.open = false;
    this.ui.hide();
    this.ui.dock(deathDock(this.s));
  }
  reset(): void {
    this.s = null;
    this.ui.hide();
    this.ui.dock(null);
  }
}

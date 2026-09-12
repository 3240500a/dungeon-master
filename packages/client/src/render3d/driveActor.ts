/**
 * СНАПШОТ → КУКЛА. Единственный шов, которым серверное состояние превращается в состояние куклы.
 *
 * Вынесен из `online3d.ts` ради вкладки «Тест» в поз-редакторе: она обязана вести себя 1:1 с клиентом,
 * а «1:1» держится не обещанием, а тем, что код ОДИН. Стоит завести в редакторе «почти такой же»
 * привод — и он разойдётся с игрой ровно там, где это интереснее всего: на разгоне, на развороте,
 * на границе боевого состояния. Отличить потом настроечную ошибку от расхождения приводов нельзя.
 *
 * Модуль намеренно ничего не знает ни про сеть, ни про сцену: ему дают числа из снапшота и куклу.
 */

/** Что умеет кукла — ровно то, что дёргает привод. Шире брать нечего: остальное его не касается. */
export interface DrivenDoll {
  setPose(x: number, z: number, yaw: number): void;
  setWorldVel?(vx: number, vz: number): void;
  setMove(m: number): void;
  setDead(d: boolean): void;
  setCombat?(c: boolean): void;
  setState?(stunned: boolean, downed: boolean): void;
  update(dt: number): void;
}

/** Хвост состояния привода между кадрами: прошлая позиция и сглаженная скорость. */
export interface DriveState {
  d: DrivenDoll;
  vx: number; vz: number;
  lx: number; lz: number;
}

/** Серверный `facing` (0 = +X, против часовой) → yaw куклы (0 = +Z). Одна копия на оба клиента. */
export const facingToYaw = (facing: number): number => Math.PI / 2 - facing;

/** Низкочастотный фильтр скорости: без него 30-герцевый снапшот на 60 кадрах даёт ложный страйф. */
export const VEL_LOWPASS = 0.25;
/** Скорость, на которой «доля хода» достигает единицы (ед/с). */
export const MOVE_FULL = 120;

export interface DriveOpts {
  /** Тяжёлый шаг куклы (позинг/физика/скин). false — только дешёвые сеттеры (temporal-LOD дальних). */
  doUpdate?: boolean;
  /** Боевой айдл — серверный флаг, self и пиры одинаково. */
  combat?: boolean;
  /**
   * dt для тяжёлого шага. При temporal-LOD сюда идёт НАКОПЛЕННЫЙ dt, чтобы фаза анимации шла верно,
   * а не в slow-mo; дешёвые сеттеры при этом зовутся каждый кадр со своим dt.
   */
  updateDt?: number;
  stun?: boolean;
  downed?: boolean;
}

/**
 * Применить строку снапшота к кукле.
 *
 * Скорость НЕ приходит с сервера — она считается разностью позиций и сглаживается, потому что
 * снапшоты идут реже кадров. Ровно из неё живёт вся походка: направление шага, ходьба↔бег, страйф.
 */
export function driveActor(a: DriveState, x: number, z: number, facing: number, alive: boolean, dt: number, opts: DriveOpts = {}): void {
  const nvx = (x - a.lx) / Math.max(dt, 1e-3), nvz = (z - a.lz) / Math.max(dt, 1e-3);
  a.vx += (nvx - a.vx) * VEL_LOWPASS; a.vz += (nvz - a.vz) * VEL_LOWPASS;
  a.lx = x; a.lz = z;
  a.d.setPose(x, z, facingToYaw(facing));
  a.d.setWorldVel?.(a.vx, a.vz);
  a.d.setMove(Math.min(1, Math.hypot(a.vx, a.vz) / MOVE_FULL));
  a.d.setDead(!alive);
  a.d.setCombat?.(opts.combat ?? false);
  a.d.setState?.(opts.stun ?? false, opts.downed ?? false);
  if (opts.doUpdate ?? true) a.d.update(opts.updateDt ?? dt);
}

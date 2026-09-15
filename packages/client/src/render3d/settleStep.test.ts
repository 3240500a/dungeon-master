import { describe, it, expect, afterEach } from 'vitest';
import { PoseDriver, GAIT, GAIT_BASE } from './pose.js';

/**
 * ⭐ ПРИБИТАЯ СТОПА НЕ ДВИГАЕТСЯ. ТОЧКА.
 *
 * Жалоба: «крутишься на месте — это не похоже на заданную idle-стойку; останавливаешься, и он
 * как-то доезжает ногами в idle. Надо, чтобы каждый подшаг был СРАЗУ в idle-стойку и потом ничего
 * не подтягивалось».
 *
 * ПРИЧИНА: доводка стоя шла ТЕЛЕПОРТОМ. Ветка «успокоились» делала `l.px = stanceX(i)` — стопа
 * ближе `SETTLE_EPS` = 2 u к планту просто прыгала в idle-стойку, и этот рывок до двух юнитов
 * читался как «доезжает». Теперь всё дальше `SETTLE_STEP_EPS` = 0.25 u доводится НАСТОЯЩИМ
 * приставным шагом, а телепорта нет вовсе.
 *
 * ⚠ ЗАЩЁЛКА ОБЯЗАТЕЛЬНА: без неё порог в четверть юнита превращается в ТОПТАНИЕ — шаг сажает стопу
 * домой, таз доворачивает на градус, порог снова пройден, и так вечно.
 *
 * ⚠ ЦЕНА, ЗАПЛАЧЕННАЯ ОСОЗНАННО: golden-вектор поехал в кейсе `turn_slow` (1046 значений, до 1.44
 * по тазу) — в медленном повороте телепорт был ЕДИНСТВЕННЫМ, что приводило стопы домой. Это ровно
 * то поведение, которое просили изменить; остальные 13 кейсов бит в бит прежние.
 */
describe('поворот на месте: доводка шагом, без телепорта', () => {
  /**
   * Стоим в стойке A, успокоились; затем стойка МЕНЯЕТСЯ на B (ровно это делает переключение
   * спокойная↔боевая — планты разъезжаются, а стопы остаются на полу). Возвращаем: худший сдвиг
   * ПРИБИТОЙ стопы за кадр, число переносов и остаточное расстояние до планта.
   */
  function restance(dx: number): { jump: number; steps: number; left: number } {
    const d = new PoseDriver();
    d.setStance(8, 5.3, -7.4, -2.4, 33.4);
    d.setMove(0);
    d.setWorld(0, 0, 0, 0, 0); d.setGoalYaw(0);
    for (let i = 0; i < 200; i++) d.update(1 / 60);              // устояться в стойке A
    d.setStance(8 + dx, 5.3, -7.4 - dx, -2.4, 33.4);             // стойка B: планты уехали
    let jump = 0, steps = 0;
    let prev: [number, number][] = [d.plantTarget(0), d.plantTarget(1)];
    let wasSw: [boolean, boolean] = [d.swingLegs[0], d.swingLegs[1]];
    for (let i = 0; i < 600; i++) {
      d.setWorld(0, 0, 0, 0, 0); d.setGoalYaw(0); d.update(1 / 60);
      const sw: [boolean, boolean] = [d.swingLegs[0], d.swingLegs[1]];
      for (let k = 0; k < 2; k++) {
        const p = d.plantTarget(k);
        if (!sw[k] && !wasSw[k]) jump = Math.max(jump, Math.hypot(p[0] - prev[k]![0], p[1] - prev[k]![1]));
        if (sw[k] && !wasSw[k]) steps++;
        prev[k] = p;
      }
      wasSw = sw;
    }
    const l = d.plantTarget(0);
    return { jump, steps, left: Math.hypot(l[0] - (8 + dx), l[1] - 5.3) };
  }

  it('⭐ ПРИБИТАЯ СТОПА НЕ СДВИГАЕТСЯ НИ НА ЙОТУ — телепорта доводки больше нет', () => {
    // ⚠ Мутация «вернуть телепорт» валит именно это: стопа прыгнет в новую стойку, не будучи в переносе.
    expect(restance(1).jump, '⚠ ПРИБИТАЯ СТОПА ПОЕХАЛА — её подтягивает что-то помимо шага').toBeLessThan(1e-9);
  });

  it('⭐ и при этом стопа ВСЁ РАВНО приходит в стойку — приставным шагом', () => {
    const { steps, left } = restance(1);
    // ⚠ Мутация «порог доводки обратно на 2 u» валит это: сдвиг в 1 u шагом уже не доводится.
    expect(steps, '⚠ переступа не было — стойка так и осталась старой').toBeGreaterThan(0);
    expect(left, '⚠ стопа не дошла до нового планта').toBeLessThan(0.25);
  });

  it('⚠ доводка срабатывает ОДИН раз — без топтания', () => {
    // ⚠ Мутация «убрать защёлку» валит это: порог в четверть юнита начнёт переступать без конца.
    expect(restance(1).steps, '⚠ ТОПЧЕТСЯ').toBeLessThanOrEqual(2);
  });

  it('⚠ МЕДЛЕННЫЙ поворот: доводка не превращается в топтание (работа защёлки)', () => {
    // Крутимся ОЧЕНЬ медленно (0.015 рад/с — ниже порога «таз стоит»), поэтому доводка разрешена
    // всё время, а плант непрерывно уезжает. ⚠ Мутация «убрать защёлку» валит это: шаг сажает стопу
    // домой, таз доворачивает на градус, порог в четверть юнита снова пройден — и так без конца.
    const d = new PoseDriver();
    d.setStance(8, 5.3, -7.4, -2.4, 33.4);
    d.setMove(0);
    let yaw = 0;
    d.setWorld(0, 0, yaw, 0, 0); d.setGoalYaw(yaw);
    for (let i = 0; i < 200; i++) d.update(1 / 60);
    let steps = 0; let wasSw: [boolean, boolean] = [d.swingLegs[0], d.swingLegs[1]];
    for (let i = 0; i < 1200; i++) {
      yaw += 0.015 / 60;
      d.setWorld(0, 0, yaw, 0, 0); d.setGoalYaw(yaw); d.update(1 / 60);
      const sw: [boolean, boolean] = [d.swingLegs[0], d.swingLegs[1]];
      for (let k = 0; k < 2; k++) if (sw[k] && !wasSw[k]) steps++;
      wasSw = sw;
    }
    expect(steps, '⚠ ТОПЧЕТСЯ на медленном повороте — защёлка доводки не держит').toBeLessThanOrEqual(2);
  });

  it('⭐ СРЕДНИЙ поворот: стопа не прыгает даже там, где доводка ещё не разрешена', () => {
    // Крутимся со скоростью МЕЖДУ порогами (0.1 рад/с: выше «таз стоит» 0.02, ниже «крутимся» 0.45).
    // Доводка тут не разрешена вовсе, и раньше стопы домой приводил ТОЛЬКО телепорт ветки
    // «успокоились» — ⚠ мутация «вернуть телепорт» валит именно этот тест. Это же и есть golden-кейс
    // `turn_slow`, единственный, который у нас поехал.
    const d = new PoseDriver();
    d.setStance(8, 5.3, -7.4, -2.4, 33.4);
    d.setMove(0);
    let yaw = 0;
    d.setWorld(0, 0, yaw, 0, 0); d.setGoalYaw(yaw);
    for (let i = 0; i < 200; i++) d.update(1 / 60);
    let jump = 0;
    let prev: [number, number][] = [d.plantTarget(0), d.plantTarget(1)];
    let wasSw: [boolean, boolean] = [d.swingLegs[0], d.swingLegs[1]];
    for (let i = 0; i < 900; i++) {
      yaw += 0.1 / 60;
      d.setWorld(0, 0, yaw, 0, 0); d.setGoalYaw(yaw); d.update(1 / 60);
      const sw: [boolean, boolean] = [d.swingLegs[0], d.swingLegs[1]];
      for (let k = 0; k < 2; k++) {
        const p = d.plantTarget(k);
        if (!sw[k] && !wasSw[k]) jump = Math.max(jump, Math.hypot(p[0] - prev[k]![0], p[1] - prev[k]![1]));
        prev[k] = p;
      }
      wasSw = sw;
    }
    expect(jump, '⚠ ПРИБИТАЯ СТОПА ПРЫГНУЛА в стойку — вернулся телепорт доводки').toBeLessThan(1e-9);
  });

  it('стойка не менялась — не переступает вовсе', () => {
    expect(restance(0).steps, '⚠ топчется на ровном месте').toBe(0);
  });
});

/**
 * ⭐ ТУМБЛЕР «УХОД В IDLE-ПОЗУ» (`GAIT.idleSettle`).
 *
 * Жалоба: «даже если он доступил куда надо, потом в idle-позу раздвигается, ступни скручиваются —
 * выглядит не очень; сделай галку, чтобы отключить и посмотреть».
 *
 * Доводка ставит стопу ТУДА, ГДЕ ЕЁ ЖДЁТ ПЛАНИРОВЩИК, а idle-поза — ДРУГАЯ поза целиком (свои углы
 * бедра, свой рыск стопы, свой аддукт). Переход между ними и читается как «раздвигается». Гейт
 * ОДИН: `settled` правит `stepping` → `legMag`, то есть КТО ведёт ноги.
 */
describe('тумблер ухода в idle-позу', () => {
  const saved: Record<string, number> = {};
  const set = (k: string, v: number): void => {
    const g = GAIT as unknown as Record<string, number>;
    if (!(k in saved)) saved[k] = g[k]!;
    g[k] = v;
  };
  afterEach(() => {
    const g = GAIT as unknown as Record<string, number>;
    for (const k in saved) g[k] = saved[k]!;
    for (const k in saved) delete saved[k];
  });

  /** Постоять на месте и сказать, отдал ли планировщик ноги позе. */
  const stand = (): boolean => {
    const d = new PoseDriver();
    d.setStance(8, 5.3, -7.4, -2.4, 33.4);
    d.setMove(0);
    d.setWorld(0, 0, 0, 0, 0); d.setGoalYaw(0);
    for (let i = 0; i < 400; i++) d.update(1 / 60);
    return !d.stepping;                                  // stepping === !settled
  };

  it('умолчание — уход в idle включён (как было)', () => {
    expect(GAIT_BASE.idleSettle).toBe(1);
    expect(stand(), '⚠ постояли, а ноги позе так и не отдали').toBe(true);
  });

  it('⭐ тумблер СНИМАЕТ уже установленное состояние, а не только не пускает в него', () => {
    // ⚠ Поймано ЖИВОЙ проверкой: подпись кнопки менялась, а `settled` оставался с прошлого раза —
    // ноги так и висели на авторской стойке, пока что-нибудь не сбросит состояние.
    const d = new PoseDriver();
    d.setStance(8, 5.3, -7.4, -2.4, 33.4);
    d.setMove(0);
    d.setWorld(0, 0, 0, 0, 0); d.setGoalYaw(0);
    for (let i = 0; i < 400; i++) d.update(1 / 60);
    expect(d.stepping, 'подстраховка: сперва ноги ушли в позу').toBe(false);
    set('idleSettle', 0);                                 // выключаем ПОСЛЕ того, как уже успокоились
    for (let i = 0; i < 10; i++) d.update(1 / 60);
    expect(d.stepping, '⚠ ТУМБЛЕР НЕ СНИМАЕТ состояние — выключил, а ничего не поменялось').toBe(true);
  });

  it('⭐ выключенный тумблер НЕ отдаёт ноги позе — видно походку без перехода', () => {
    set('idleSettle', 0);
    // ⚠ Мутация «игнорировать тумблер» валит именно это.
    expect(stand(), '⚠ ТУМБЛЕР НЕ ДЕЙСТВУЕТ: ноги всё равно ушли в авторскую стойку').toBe(false);
  });
});

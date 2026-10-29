import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PosePlayer, localStorageContent, emptyGrid } from './poseRuntime.js';
import { comboWindow, type Clip, type Pose } from './clipModel.js';
import { buildHumanoid } from './humanoid.js';

/**
 * ⭐⭐ ОКНО КОМБО: ЗАЖАТАЯ АТАКА ЖИВЁТ ВНУТРИ РАЗМЕЧЕННОЙ ГРАНИЦЫ.
 *
 * Метку `combo` не читал НИКТО — ни клиент, ни сервер (проверено поиском по всему репозиторию):
 * разметка была, поведения не было. Требование: конец окна ЗАКАНЧИВАЕТ анимацию и НАЧИНАЕТ
 * следующую, пока мышь зажата; отпустил — доигрывает хвост и уходит в стойку.
 *
 * Разметка взята с живых клипов воина: `combo` 0.12 + 0.8 с, `swing` 0.32 + 0.133, `impact` 0.453,
 * длина клипа 1.04 с.
 */
describe('окно комбо', () => {
  beforeEach(() => {
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0,
    } as Storage;
  });
  afterEach(() => { delete (globalThis as unknown as { localStorage?: Storage }).localStorage; });

  const clip = (name: string, withCombo = true): Clip => ({
    name, character: 'warrior', weapon: 'none', loop: false,
    keys: [
      { t: 0, pose: {} as Pose },
      { t: 0.12, pose: {} as Pose, marks: withCombo ? [{ type: 'combo', dur: 0.8 }] : undefined },
      { t: 0.453, pose: {} as Pose, marks: [{ type: 'impact' }] },
      { t: 1.04, pose: {} as Pose },
    ],
  } as unknown as Clip);

  const mk = (): PosePlayer => new PosePlayer(buildHumanoid({}), () => [], localStorageContent('warrior'), 'none',
    { armDown: 1.35, elbowBend: 0.25 }, emptyGrid());

  /** Прогнать N секунд по 1/60 и записать, какой клип играет в каждом кадре. */
  const play = (p: PosePlayer, sec: number): string[] => {
    const out: string[] = [];
    for (let i = 0; i < Math.round(sec * 60); i++) { p.step(1 / 60); out.push(p.attacking ? '?' : '—'); }
    return out;
  };

  it('окно читается из метки-отрезка', () => {
    expect(comboWindow(clip('a'))).toEqual({ start: 0.12, end: 0.92 });
    expect(comboWindow(clip('a', false)), 'нет метки — нет окна').toBe(null);
  });

  it('⚠ точечная метка комбо окном НЕ является — за автора не додумываем', () => {
    const c = { keys: [{ t: 0.2, pose: {}, marks: [{ type: 'combo' }] }] } as unknown as Clip;
    expect(comboWindow(c)).toBe(null);
  });

  it('⭐⭐ ЗАЖАТО — на конце окна начинается СЛЕДУЮЩИЙ удар, а не стойка', () => {
    // ⚠ Мутация «не сцеплять на конце окна» валит это: удар доиграл бы до 1.04 и кончился.
    const p = mk();
    const a = clip('hit_r'), b = clip('hit_l');
    let idx = 0;
    p.comboNext = () => [a, b][idx++ % 2]!;
    p.attackHold = true;
    p.triggerAttack(a);
    const seen: (string | null)[] = [];
    for (let i = 0; i < 180; i++) { p.step(1 / 60); seen.push(p.attackClipName); }
    expect(seen.includes(null), '⚠ УДАР ОТПУСТИЛО В СТОЙКУ при зажатой атаке').toBe(false);
    expect(new Set(seen).size, '⚠ играет всё время один клип — цепочка не чередуется').toBe(2);
  });

  it('⭐⭐ ОТПУЩЕНО — конец окна ничего не начинает, удар доигрывает и уходит в стойку', () => {
    const p = mk();
    p.comboNext = () => clip('hit_l');
    p.attackHold = false;
    p.triggerAttack(clip('hit_r'));
    play(p, 3);
    expect(p.attacking, '⚠ удар не кончился, хотя атаку не держат').toBe(false);
  });

  it('⭐ ЗАЖАТО, НО ОКНА НЕТ — поведение прежнее: удар кончается', () => {
    // Без разметки ничего не меняется бит в бит — это гарантия, что старые клипы не поехали.
    const p = mk();
    p.comboNext = () => clip('hit_l', false);
    p.attackHold = true;
    p.triggerAttack(clip('hit_r', false));
    play(p, 3);
    expect(p.attacking, '⚠ клип БЕЗ метки комбо зациклился — сломано прежнее поведение').toBe(false);
  });

  it('⭐ ПЛЕЙХЕД НЕ ВЫХОДИТ ЗА ГРАНИЦУ ОКНА, пока атака зажата', () => {
    // Ровно просьба: «анимации должны играться только в этой границе».
    const p = mk();
    const a = clip('hit_r'), b = clip('hit_l');
    let idx = 0;
    p.comboNext = () => [a, b][idx++ % 2]!;
    p.attackHold = true;
    p.triggerAttack(a);
    let worst = 0;
    for (let i = 0; i < 300; i++) {
      p.step(1 / 60);
      if (i > 40) worst = Math.max(worst, p.attackTime);     // после входа: первый проход идёт с нуля
    }
    expect(worst, '⚠ плейхед вышел за конец окна комбо (0.92)').toBeLessThanOrEqual(0.92 + 1 / 60 + 1e-6);
  });

  it('⭐ СЛЕДУЮЩИЙ УДАР ВХОДИТ В НАЧАЛО ОКНА, а не с нуля', () => {
    // ⚠ Мутация «входить в 0» валит это: вступление проигрывалось бы заново на каждом звене цепочки.
    const p = mk();
    let idx = 0;
    p.comboNext = () => [clip('hit_r'), clip('hit_l')][idx++ % 2]!;
    p.attackHold = true;
    p.triggerAttack(clip('hit_r'));
    const first = p.attackClipName;
    let entry = -1;
    for (let i = 0; i < 300 && entry < 0; i++) { p.step(1 / 60); if (p.attackClipName !== first) entry = p.attackTime; }
    expect(entry, '⚠ цепочка не сработала').toBeGreaterThanOrEqual(0);
    expect(entry, '⚠ вошли не в начало окна комбо').toBeGreaterThanOrEqual(0.12 - 1e-6);
    expect(entry, '⚠ вошли слишком поздно — пропустили часть окна').toBeLessThan(0.12 + 2 / 60);
  });

  it('⭐⭐ СВИНГ СРАЗУ ПОСЛЕ АВТОСЦЕПКИ НЕ ПЕРЕЗАПУСКАЕТ КЛИП', () => {
    // ⚠ Мутация «убрать перехват» валит это: пока атака зажата, работают два источника (наша сцепка
    // и свинг сервера), и второй дёргал бы клип заново через долю секунды после первой.
    const p = mk();
    let idx = 0;
    p.comboNext = () => [clip('hit_r'), clip('hit_l')][idx++ % 2]!;
    p.attackHold = true;
    p.triggerAttack(clip('hit_r'));
    const first = p.attackClipName;
    while (p.attackClipName === first) p.step(1 / 60);          // дождались автосцепки
    const after = p.attackClipName, t0 = p.attackTime;
    p.triggerAttack(clip('hit_r'));                             // «свинг сервера» через кадр
    expect(p.attackClipName, '⚠ свинг перезапустил только что сцепленный удар').toBe(after);
    expect(p.attackTime, '⚠ плейхед отброшен назад').toBeCloseTo(t0, 6);
  });

  it('⭐⭐ ПОДАВЛЕННЫЙ СВИНГ ГОВОРИТ «Я НЕ ЗАПУСТИЛСЯ» — иначе очередь ударов съезжает', () => {
    // Вторая половина жалобы «повторяет один и тот же удар»: кукла двигала очередь на КАЖДЫЙ свинг,
    // включая подавленный перехватом. Удар «расходовался», не сыграв, и на пуле из двух клипов
    // очередь прибавлялась дважды за цикл — то есть не двигалась вовсе.
    // ⚠ Мутация «всегда возвращать true» валит это.
    const p = mk();
    let idx = 0;
    p.comboNext = () => [clip('hit_r'), clip('hit_l')][idx++ % 2]!;
    p.attackHold = true;
    expect(p.triggerAttack(clip('hit_r')), 'первый удар обязан запуститься').toBe(true);
    const first = p.attackClipName;
    while (p.attackClipName === first) p.step(1 / 60);          // дождались автосцепки
    expect(p.triggerAttack(clip('hit_r')), '⚠ подавленный свинг отчитался как запущенный').toBe(false);
  });

  it('пустой клип не запускается и так и говорит', () => {
    expect(mk().triggerAttack(null)).toBe(false);
  });

  it('свинг ПОЗЖЕ окна перехвата работает как раньше — перезапускает цепочку', () => {
    const p = mk();
    let idx = 0;
    p.comboNext = () => [clip('hit_r'), clip('hit_l')][idx++ % 2]!;
    p.attackHold = true;
    p.triggerAttack(clip('hit_r'));
    const first = p.attackClipName;
    while (p.attackClipName === first) p.step(1 / 60);
    for (let i = 0; i < 20; i++) p.step(1 / 60);               // 0.33 с — дольше окна перехвата
    p.triggerAttack(clip('hit_r'));
    expect(p.attackClipName, '⚠ поздний свинг не сменил клип').toBe('hit_r');
  });
});

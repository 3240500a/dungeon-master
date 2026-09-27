import { describe, it, expect } from 'vitest';
import { MOCAP_SET, matchMocapSet, isMocapSetFile } from './mocapSetMap.js';
import { REQUIRED_NAMES } from './locoSetAudit.js';

/** Имена тейков главного файла пакета (замер: `MovementAnimsetPro.fbx`, 117 тейков — берём значимые). */
const MAIN_FILE = [
  'Idle', 'WalkFwdLoop', 'RunFwdLoop', 'TurnLt90_Loop', 'TurnRt90_Loop', 'TurnLt180', 'TurnRt180',
  'WalkFwdStop_LU', 'WalkFwdStop_RU', 'RunFwdStop_LU', 'RunFwdStop_RU', 'WalkFwdStart', 'RunFwdStart',
  'WalkFwdLoop_LeanL', 'WalkFwdLoop_LeanR', 'RunFwdTurn180_L_LU',
  // …и то, что в набор попасть НЕ должно:
  'Crouch_WalkFwdLoop', 'Crouch_WalkFwdStop_LU', 'Jump_place_ALL', 'PullLever_RH', 'BindPose', 'DontKnow',
];

describe('таблица набора мокапа', () => {
  /**
   * ⭐⭐ ГЛАВНЫЙ СТОРОЖ: таблица обязана отвечать за КАЖДОЕ имя, которое спрашивает движок.
   * Добавят в набор новое направление — тест скажет, что мокап его не закрывает, вместо того чтобы
   * оставить дырку, которую заметят по «персонаж скользит».
   */
  it('⭐⭐ ЯДРО ТАБЛИЦЫ = РОВНО `REQUIRED_NAMES` движка', () => {
    const core = MOCAP_SET.filter((t) => t.core).map((t) => t.clip);
    expect([...core].sort(), '⚠ таблица разошлась с тем, что спрашивает движок').toEqual([...REQUIRED_NAMES].sort());
  });

  it('⭐ ИМЕНА В ТАБЛИЦЕ НЕ ПОВТОРЯЮТСЯ (иначе второй клип лёг бы как `..._2` и молча)', () => {
    const names = MOCAP_SET.map((t) => t.clip);
    expect([...new Set(names)].length).toBe(names.length);
  });

  /**
   * ⭐⭐ ДОПОЛНИТЕЛЬНОЕ СОДЕРЖИМОЕ НЕ СМЕЕТ НАЧИНАТЬСЯ НА `walk_`/`run_`.
   * `locoSetAudit.isGait` считает клипом ХОДА всё с такой приставкой и требует от него скорость съёма,
   * ревизию и чистый верх. Двадцать клипов старта/остановки/диагоналей встали бы в панель покрытия
   * ложными дефектами, и панель перестала бы что-то значить.
   */
  it('⭐⭐ ДОПОЛНИТЕЛЬНОЕ — ВСЁ С ПРИСТАВКОЙ `mocap_`, чтобы аудит не считал его ходом', () => {
    for (const t of MOCAP_SET.filter((x) => !x.core)) {
      expect(t.clip.startsWith('mocap_'), `${t.clip}: дополнительное содержимое обязано нести приставку`).toBe(true);
      expect(/^(walk|run)_/.test(t.clip), `${t.clip}: аудит принял бы его за клип хода`).toBe(false);
    }
  });

  /**
   * ⭐⭐ СТОРОНЫ ПОВОРОТОВ ЗЕРКАЛЬНЫ, КАК И У СТРАЙФОВ — И ЭТО ПРОВЕРЯЕТСЯ ПО ЗНАКУ АВТОРСКОЙ КРИВОЙ.
   * Замер бинарника: `TurnLt90_Loop` несёт +90.0000°, `TurnRt90_Loop` −90.0000°. В нашей системе
   * положительный рыск — это `turn_R` (`clipBake.TURN_PRESETS`: `turn_L` = −a, `turn_R` = +a).
   * Значит `Lt` обязан лечь в `turn_R`. Перенос по буквам имени даёт персонажа, который на поворот
   * влево крутится вправо: ноги переступают в одну сторону, тело едет в другую.
   */
  it('⭐⭐ `Lt` ЛОЖИТСЯ В `turn_R`, А `Rt` В `turn_L`', () => {
    const by = Object.fromEntries(MOCAP_SET.filter((t) => t.clip.startsWith('turn_')).map((t) => [t.clip, t.take]));
    expect(by['turn_R_90'], 'Lt несёт +90 = наш turn_R').toBe('TurnLt90_Loop');
    expect(by['turn_L_90'], 'Rt несёт −90 = наш turn_L').toBe('TurnRt90_Loop');
    expect(by['turn_R_180']).toBe('TurnLt180');
    expect(by['turn_L_180']).toBe('TurnRt180');
    expect(by['turn_R_45'], '45° — половина того же цикла 90°').toBe('TurnLt90_Loop');
    expect(by['turn_L_45']).toBe('TurnRt90_Loop');
  });

  it('⭐ все шесть поворотов снимают курс и ни один не запрещён', () => {
    const turns = MOCAP_SET.filter((t) => t.clip.startsWith('turn_'));
    expect(turns.length).toBe(6);
    for (const t of turns) {
      expect(t.rootYaw, `${t.clip}: курс обязан сниматься`).toBe(true);
      expect(t.blocked, `${t.clip}: запрета нет`).toBeUndefined();
    }
    expect(matchMocapSet(MAIN_FILE).core.filter((t) => t.clip.startsWith('turn_')).length).toBe(6);
    expect(matchMocapSet(MAIN_FILE).blocked.length).toBe(0);
  });

  /**
   * ⚠ РЕКОНСТРУКЦИЯ ИЗ СТОП осталась в запекателе фолбэком для пакетов без авторской кривой. Здесь её
   * не должно быть ни у кого: у Kubold кривая есть, и она точнее (0.0–0.2° против 2–15°).
   */
  it('⚠ никто не восстанавливает курс из стоп — есть авторская кривая', () => {
    expect(MOCAP_SET.filter((t) => t.yawFromFeet).map((t) => t.clip)).toEqual([]);
  });

  /**
   * ⚠ СРАВНЕНИЕ ПО ТОЧНОМУ ИМЕНИ. Угадывание («содержит walk») притащило бы в набор хода `Crouch_WalkFwdLoop`
   * — тейк ПРИСЕДА, у которого таз на 25 см ниже. В игре это дало бы крадущуюся ходьбу вместо обычной.
   */
  it('⭐⭐ ПОХОЖИЕ ИМЕНА В НАБОР НЕ ЛЕЗУТ (`Crouch_WalkFwdLoop` — не ходьба)', () => {
    const m = matchMocapSet(MAIN_FILE);
    const all = [...m.core, ...m.extra].map((t) => t.take);
    expect(all).toContain('WalkFwdLoop');
    expect(all.some((n) => n.startsWith('Crouch_')), '⚠ присед попал в набор хода').toBe(false);
    expect(all.some((n) => n.startsWith('Jump') || n.startsWith('PullLever')), '⚠ прыжки/взаимодействия').toBe(false);
  });

  it('⭐ ЧЕГО В ЭТОМ ФАЙЛЕ НЕТ — НАЗВАНО (набор разложен по семи файлам пакета)', () => {
    const m = matchMocapSet(MAIN_FILE);
    // Ходьба назад и бок лежат в Additionals, бег назад и бок — в RunStrafeUpdate.
    expect(m.absentCore).toEqual(expect.arrayContaining(['walk_back', 'walk_strafe_L', 'walk_strafe_R', 'run_back', 'run_strafe_L', 'run_strafe_R']));
    expect(m.core.map((t) => t.clip)).toEqual(expect.arrayContaining(['idle', 'walk_fwd', 'run_fwd']));
  });

  it('⚠ обрезка — доли 0..1 по возрастанию (иначе тейк режется в пустоту)', () => {
    for (const t of MOCAP_SET) {
      if (!t.trim) continue;
      expect(t.trim[0], t.clip).toBeGreaterThanOrEqual(0);
      expect(t.trim[1], t.clip).toBeLessThanOrEqual(1);
      expect(t.trim[1], t.clip).toBeGreaterThan(t.trim[0]);
    }
  });

  it('⚠ чужой файл блок переноса не показывает', () => {
    expect(isMocapSetFile(['mixamo.com', 'Take 001'])).toBe(false);
    expect(isMocapSetFile(MAIN_FILE)).toBe(true);
    // ⚠ Раньше здесь стояло `false`: файл только с поворотами переносить было нечем, они шли в `blocked`.
    // Теперь курс снимается из опорной стопы, поворот — обычное ядро, и блок обязан показаться.
    expect(isMocapSetFile(['TurnLt180', 'TurnRt180'])).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { GAIT, POSE, ASYM, STRAFE, STRAFE_R, STRAFE_L, BACK, COMBAT, GAIT_BASE, POSE_BASE, clamp } from './gaitKnobs.js';
import { PoseDriver } from './stepPlanner.js';

/**
 * ⭐⭐ РАЗРЕЗ `pose.ts` (Э11): ручки отдельно, планировщик отдельно.
 *
 * Зачем резали. В одном модуле жили ДАННЫЕ настроек (их читает каждый кадр игры) и ПРОЦЕДУРНЫЙ
 * ПЛАНИРОВЩИК ШАГОВ (1080 строк, нужен редактору и запекателю). Пока они вместе, дерево-шейкинг не
 * выкинет класс из игрового бандла, и «вырезан ли планировщик» нельзя доказать замером — только верой.
 *
 * ⚠ ЧЕГО ЭТОТ КОММИТ НЕ ДЕЛАЕТ. Он НЕ убирает планировщик из игры: `PosePlayer` по-прежнему держит
 * `PoseDriver`, и кукла без запечённого набора уезжает на него прямо в игре (`hasLocoSet`). Разрез —
 * предусловие, а не результат.
 */
const DIR = __dirname;
const SRC = (f: string): string => readFileSync(path.join(DIR, f), 'utf8');

describe('разрез pose.ts', () => {
  it('⭐ `pose.ts` БОЛЬШЕ НЕТ — барреля-реэкспорта не осталось', () => {
    // Баррель был бы удобен (52 импорта не трогать), но он же и вернул бы проблему: из него по-прежнему
    // достижим планировщик, и «кто что читает» снова стало бы вопросом веры.
    expect(existsSync(path.join(DIR, 'pose.ts')), '⚠ pose.ts вернулся').toBe(false);
    // ⚠ Ищем ИМПОРТ-ОПЕРАТОР, а не подстроку: имя `./pose.js` стоит в тексте этой же проверки, и наивный
    // `includes` ловил бы сторожа на самом себе (эта грабля в проекте уже случалась — сторож находил
    // собственное объяснение в комментарии).
    const IMPORTS_POSE = /^\s*import[^\n]*from '\.\/pose\.js'/m;
    const live = readdirSync(DIR).filter((f) => f.endsWith('.ts'));
    expect(live.filter((f) => IMPORTS_POSE.test(SRC(f))), '⚠ кто-то снова импортирует ./pose.js').toEqual([]);
  });

  it('⭐⭐ ЗАВИСИМОСТЬ ОДНОСТОРОННЯЯ: планировщик → ручки, и никогда обратно', () => {
    expect(SRC('stepPlanner.ts').includes("from './gaitKnobs.js'"), 'планировщик берёт ручки').toBe(true);
    // ⚠ Снова ИМПОРТ, а не упоминание: шапка `gaitKnobs.ts` объясняет разрез и называет `stepPlanner.ts`
    // по имени, да и перееханный комментарий про `StepPlanner.legRest` остался — подстрокой не проверить.
    expect(/^\s*import[^\n]*from '\.\/stepPlanner\.js'/m.test(SRC('gaitKnobs.ts')),
      '⚠ ручки потянулись к планировщику — это цикл импортов и конец разреза').toBe(false);
  });

  it('⭐⭐ КЛАССА ПЛАНИРОВЩИКА В РУЧКАХ НЕТ, А РУЧЕК В ПЛАНИРОВЩИКЕ НЕ ОБЪЯВЛЕНО', () => {
    const knobs = SRC('gaitKnobs.ts');
    expect(knobs.includes('class StepPlanner'), '⚠ планировщик остался в ручках').toBe(false);
    expect(knobs.includes('class PoseDriver'), '⚠ привод остался в ручках').toBe(false);
    const plan = SRC('stepPlanner.ts');
    // ⚠ Вторая копия ЛЮБОЙ из этих карт — молчаливая катастрофа (см. следующий тест).
    for (const nm of ['export const GAIT =', 'export const POSE =', 'export const ASYM', 'export const STRAFE']) {
      expect(plan.includes(nm), `⚠ планировщик завёл свою копию: ${nm}`).toBe(false);
    }
  });

  /**
   * ⚠⚠ ГЛАВНЫЙ РИСК РАЗРЕЗА. Все эти объекты МУТИРУЕМЫЕ: `poseRuntime.applyGaitConfig` перезаливает их
   * (`Object.assign` + `delete` всех ключей), редактор правит их же. В README уже записана живая грабля:
   * динамический `import()` дал ВТОРОЙ экземпляр модуля (`GAIT === GAIT` → false), правки ручек до
   * планировщика не доезжали, и три гипотезы подряд дали ложный ответ. После разреза цена выше: копия
   * в `stepPlanner.ts` означала бы, что редактор крутит одно, а запекатель снимает другое — без ошибок.
   */
  it('⭐⭐ ПЛАНИРОВЩИК ВИДИТ ТЕ ЖЕ САМЫЕ ОБЪЕКТЫ НАСТРОЕК, А НЕ КОПИИ', () => {
    const d = new PoseDriver();
    const was = GAIT.standY;
    try {
      GAIT.standY = was + 7;                       // правка «редактором»
      d.setWorld(0, 0, 0, 0, 0);                   // планировщик создаётся лениво и читает GAIT
      const out = d.update(1 / 60);
      GAIT.standY = was;
      const a = out.bobY;
      const d2 = new PoseDriver();
      d2.setWorld(0, 0, 0, 0, 0);
      expect(a, '⚠ правка GAIT не доехала до планировщика — у него своя копия модуля').not.toBe(d2.update(1 / 60).bobY);
    } finally { GAIT.standY = was; }
  });

  it('снимок дефолтов лежит РЯДОМ со своим источником и совпадает с ним на старте', () => {
    // `GAIT_BASE`/`POSE_BASE` снимаются на инициализации модуля. Разнеси их с `GAIT`/`POSE` по разным
    // файлам — и корректность снимка станет зависеть от порядка вычисления модулей, а он разный у игры,
    // редактора и vitest. Поэтому они обязаны быть в ОДНОМ файле и НИЖЕ источника.
    const knobs = SRC('gaitKnobs.ts');
    expect(knobs.indexOf('export const GAIT_BASE')).toBeGreaterThan(knobs.indexOf('export const GAIT ='));
    expect(knobs.indexOf('export const POSE_BASE')).toBeGreaterThan(knobs.indexOf('export const POSE ='));
    expect(Object.keys(GAIT_BASE).length).toBe(Object.keys(GAIT).length);
    expect(Object.keys(POSE_BASE).length).toBe(Object.keys(POSE).length);
  });

  it('⭐ `clamp` ЖИВЁТ В РУЧКАХ И ЭКСПОРТИРОВАН — иначе цикл или четыре копии одной формулы', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(SRC('stepPlanner.ts')).not.toMatch(/^const clamp = /m);
  });

  /**
   * ⭐⭐ МЁРТВЫЙ КОД ПЛАНИРОВЩИКА НЕ ВОЗВРАЩАЕТСЯ.
   *
   * Удар, боевой гард и поза трупа жили в `PoseDriver` от времён, когда клипов не было вовсе. Включать их
   * было НЕКОМУ: `setArmed`/`attack`/`setDead` не звал никто, включая тесты.
   *
   * ⚠ Почему это не заметили годами: grep по именам давал десятки попаданий, и ни одно не вело сюда.
   * `.attack(` в проекте — трёхаргументный, на `PosePlayer`/кукле; `.setDead(` — на рэгдолле; `.attacking` —
   * свойство `PosePlayer`. Одинаковые имена у РАЗНЫХ объектов делают мёртвый код неотличимым от живого,
   * поэтому сторож проверяет ИМЕННО отсутствие членов у `PoseDriver`, а не отсутствие слов в проекте.
   */
  it('⭐⭐ УДАР, ГАРД И ПОЗА ТРУПА НЕ ВЕРНУЛИСЬ В ПЛАНИРОВЩИК', () => {
    const d = new PoseDriver() as unknown as Record<string, unknown>;
    for (const m of ['attack', 'setArmed', 'setDead', 'isDead', 'attacking']) {
      expect(d[m], `⚠ мёртвый член \`PoseDriver.${m}\` вернулся: удар и смерть делают клипы и рэгдолл`).toBeUndefined();
    }
    // ⚠ БЕЗ КОММЕНТАРИЕВ: в шапке и в объяснении «здесь были удалены» эти имена названы НАРОЧНО — это
    // единственный след того, почему веток больше нет. Наивный поиск подстроки ловил бы сторожа на
    // собственном объяснении (в проекте это уже случалось дважды).
    const code = (f: string): string => SRC(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const plan = code('stepPlanner.ts');
    expect(plan.includes('ATTACK_DUR'), '⚠ константа процедурного удара вернулась').toBe(false);
    expect(plan.includes('GUARD.'), '⚠ боевой гард вернулся в планировщик').toBe(false);
    expect(SRC('gaitKnobs.ts').includes('export const GUARD'), '⚠ поза гарда вернулась в ручки').toBe(false);
  });

  it('карты колонок — те же объекты, что видит игра (пересборка конфига обязана доезжать до обоих)', () => {
    for (const m of [ASYM, STRAFE, STRAFE_R, STRAFE_L, BACK, COMBAT]) expect(typeof m).toBe('object');
    // Ссылочная целостность проверяется тем, что импорт один: два модуля с одинаковым путём дают один объект.
    expect(SRC('poseRuntime.ts').includes("from './gaitKnobs.js'"), 'рантайм берёт ручки оттуда же').toBe(true);
  });
});

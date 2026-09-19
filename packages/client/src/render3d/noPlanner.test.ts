import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { buildHumanoid } from './humanoid.js';
import { PosePlayer, localStorageContent, emptyGrid } from './poseRuntime.js';
import { BakePlayer } from './bakePlayer.js';

/**
 * ⭐⭐ ПЛАНИРОВЩИК ВЫРЕЗАН ИЗ ИГРЫ — И ЭТО ДОКАЗЫВАЕТ ТИП, А НЕ ДИСЦИПЛИНА.
 *
 * Пока `PosePlayer` держал `readonly driver = new PoseDriver()`, вопрос «исполняется ли планировщик»
 * решал ФЛАГ КАДРА, а ссылка на класс оставалась у каждой куклы сцены — включая монстров и чужих
 * игроков. Значит: дерево-шейкинг класс не выкидывал, и ответ приходилось перепроверять чтением.
 *
 * Теперь граница проведена ВЛАДЕНИЕМ: планировщик живёт в `BakePlayer` (редактор и запекатель), а у
 * игровой куклы его нет ВООБЩЕ. Сторож проверяет именно это — по объекту и по графу импортов.
 */
const DIR = __dirname;
const SRC = (f: string): string => readFileSync(path.join(DIR, f), 'utf8');
const GX = { armDown: 1.35, elbowBend: 0.25 };
const mk = <T,>(C: new (...a: never[]) => T): T =>
  new (C as unknown as new (...a: unknown[]) => T)(
    buildHumanoid({}), () => [], localStorageContent('warrior'), 'none', GX, emptyGrid());

describe('планировщик вырезан из игры', () => {
  it('⭐⭐ У ИГРОВОЙ КУКЛЫ ПОЛЯ `driver` НЕТ ВОВСЕ', () => {
    const p = mk(PosePlayer) as unknown as Record<string, unknown>;
    expect('driver' in p, '⚠ планировщик вернулся в игровую куклу — вырезание отменено').toBe(false);
    expect(p['driver']).toBeUndefined();
  });

  it('⭐ А У ЗАПЕКАТЕЛЬНОЙ — ЕСТЬ, И ЭТО ТОТ ЖЕ ЭКЗЕМПЛЯР МЕЖДУ ВЫЗОВАМИ', () => {
    const b = mk(BakePlayer);
    expect(b.driver, 'планировщик у куклы запекания обязан быть').toBeTruthy();
    expect(b.driver, '⚠ два обращения — два планировщика: состояние походки терялось бы каждый кадр').toBe(b.driver);
    expect(b instanceof PosePlayer, 'это та же кукла, просто с планировщиком').toBe(true);
  });

  /**
   * ⚠⚠ ГЛАВНАЯ ГРАБЛЯ ЭТОГО РЕФАКТОРИНГА, ПОЙМАННАЯ ЗАМЕРОМ.
   *
   * `target: ES2022` ⇒ `useDefineForClassFields: true`: инициализаторы полей ПОДКЛАССА отрабатывают ПОСЛЕ
   * `super()`. А конструктор базы зовёт `measureStance()` → шов `plannerStance` → планировщик нужен УЖЕ
   * ВНУТРИ `super()`. Объяви его полем — во время `super()` он `undefined`, а после `super()` инициализатор
   * ПЕРЕЗАПИШЕТ созданный лениво экземпляр вместе с уже переданной стойкой.
   *
   * ⚠ Сломалось бы МОЛЧА: `PoseDriver.setStance` без планировщика только ЗАПОМИНАЕТ стойку, и потеря
   * всплыла бы позже — `StepPlanner` создаётся в `setWorld` и взял бы полутаз рига вместо замеренного.
   */
  it('⭐⭐ СТОЙКА, ЗАМЕРЕННАЯ В КОНСТРУКТОРЕ, ДОЕХАЛА ДО ПЛАНИРОВЩИКА (порядок инициализации полей)', () => {
    const b = mk(BakePlayer);
    const d = b.driver as unknown as { stanceLatL: number | null };
    expect(d.stanceLatL, '⚠ стойка потерялась: поле подкласса затёрло планировщик, созданный внутри super()').not.toBeNull();
  });

  it('⭐⭐ ИГРА СТРОИТ ИМЕННО ИГРОВУЮ КУКЛУ', () => {
    const doll = SRC('gamePlayerDoll.ts');
    expect(doll.includes('new PosePlayer('), 'игра строит PosePlayer').toBe(true);
    expect(doll.includes('BakePlayer'), '⚠ в игровую куклу затащили планировщик').toBe(false);
  });

  /**
   * ⭐⭐ ОБХОД ГРАФА ИМПОРТОВ: из точки входа игры `stepPlanner.ts` НЕДОСТИЖИМ.
   *
   * Это единственная проверка, которую нельзя обмануть: типы можно привести, поле можно дописать сбоку,
   * а вот путь в графе модулей либо есть, либо нет. Именно он отвечает на «выкинет ли сборка класс».
   */
  it('⭐⭐ ИЗ `online3d.ts` НЕ ДОСТИЖИМ `stepPlanner.ts`', () => {
    const files = new Set(readdirSync(DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')));
    const seen = new Set<string>(), path2 = new Map<string, string>();
    const walk = (f: string): void => {
      if (seen.has(f) || !files.has(f)) return;
      seen.add(f);
      for (const m of SRC(f).matchAll(/from '\.\/([A-Za-z0-9_.-]+)\.js'/g)) {
        const next = m[1]! + '.ts';
        if (!seen.has(next)) path2.set(next, f);
        walk(next);
      }
    };
    walk('online3d.ts');
    // Цепочку печатаем ЦЕЛИКОМ: «достижим» без пути — бесполезное сообщение, искать пришлось бы руками.
    const chain: string[] = [];
    for (let f: string | undefined = 'stepPlanner.ts'; f; f = path2.get(f)) { chain.push(f); if (chain.length > 40) break; }
    expect(seen.has('stepPlanner.ts'),
      '⚠⚠ планировщик снова достижим из игры: ' + chain.reverse().join(' → ')).toBe(false);
    expect(seen.has('poseRuntime.ts'), 'контроль: обход графа работает').toBe(true);
    expect(seen.has('gaitKnobs.ts'), 'контроль: ручки игре нужны').toBe(true);
  });

  it('⭐ И ОБРАТНО: запекатель с редактором планировщик ВИДЯТ (иначе печь будет нечем)', () => {
    expect(SRC('bakePlayer.ts').includes("from './stepPlanner.js'"), 'кукла запекания').toBe(true);
    expect(SRC('clipBake.ts').includes("from './bakePlayer.js'"), 'запекатель').toBe(true);
  });

  it('⚠ `step()` НЕ ПЕРЕОПРЕДЕЛЁН: кадровый конвейер остаётся ОДИН', () => {
    // Копия `step()` в подклассе была бы второй правдой на самом горячем месте проекта: две сотни строк,
    // которые обязаны меняться синхронно, и ничто бы этого не проверяло.
    const bp = SRC('bakePlayer.ts');
    expect(/\boverride\s+step\s*\(/.test(bp), '⚠ `step()` переопределён — это копия кадрового конвейера').toBe(false);
    expect(bp.includes('this.driver'), 'планировщик трогает только подкласс').toBe(true);
    // ⚠ Ищем `.driver` ВООБЩЕ, а не буквальный `this.driver`: обход через приведение типа
    // (`(this as unknown as {driver}).driver`) — ровно то, чем легче всего вернуть связь незаметно
    // (проверено мутацией: буквальный поиск проходил мимо). Комментарии вырезаем — в них имя названо нарочно.
    const rtCode = SRC('poseRuntime.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
    expect(rtCode.includes('.driver'), '⚠ база снова полезла к планировщику').toBe(false);
  });
});

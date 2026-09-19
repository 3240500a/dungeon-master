import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * ⭐⭐ ТИП `UpperPose` ОБЯЗАН БЫТЬ ОДИН — И ЭТО НЕ ЧИСТОПЛЮЙСТВО.
 *
 * В редакторе жила УРЕЗАННАЯ копия рантаймового типа, без `clipName` и `fingersAnimated`. Копия была
 * барьером в ОБЕ стороны и потому незаметной:
 *  • недостающие поля опциональны → присваивание в `PoseContent` проходило без единой ошибки;
 *  • дописать их в литерал возврата было НЕЛЬЗЯ — срабатывал excess property check по локальному типу.
 * То есть копия одновременно скрывала проблему и мешала её починить.
 *
 * Цена не теоретическая: без `clipName` не работал хват КЛИПА (`GripConfig.byClip`) на вкладках,
 * идущих через `PosePlayer` («Бег», «Повороты», кукла «Тест») — живой хват всегда перебивал авторский.
 * То есть редактор и игра расходились РОВНО НА ШВАХ ХВАТА, там, где автор и сверяет меч в руке.
 *
 * ⚠ Что это НЕ чинит: манекен вкладки «Анимация» идёт не через `PosePlayer`, а через `applyGripOver`,
 * и имя клипа туда передавалось правильно и раньше. Проверять починку, глядя на «Анимацию», — значит
 * получить ложное «всё в порядке».
 */
const DIR = __dirname;
const SRC = (f: string): string => readFileSync(path.join(DIR, f), 'utf8');

describe('UpperPose: один тип на редактор и игру', () => {
  it('⭐⭐ У РЕДАКТОРА НЕТ СВОЕГО `interface UpperPose`', () => {
    const ed = SRC('pose-editor.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
    expect(/\binterface\s+UpperPose\b/.test(ed),
      '⚠ копия типа вернулась: она молча разрешит вернуть неполный объект и запретит вернуть полный').toBe(false);
    expect(SRC('pose-editor.ts').includes('type UpperPose,'), 'тип берётся из рантайма').toBe(true);
  });

  it('⭐⭐ РЕДАКТОР ОТДАЁТ `clipName` И `fingersAnimated`, КАК ИГРА', () => {
    const ed = SRC('pose-editor.ts');
    const i = ed.indexOf('function resolveUpper(');
    expect(i, '⚠ `resolveUpper` редактора не найден').toBeGreaterThan(0);
    const fn = ed.slice(i, ed.indexOf('\n}', i));
    expect(fn.includes('clipName: lead?.name'), 'имя ведущего клипа стойки').toBe(true);
    expect(fn.includes('fingersAnimated: fingersAnimated(lead)'), 'анимированы ли пальцы').toBe(true);
    // ⚠ ОБА возврата (сборка слоями И фолбэк по базовому оружию) — иначе на редком пути поля пропадут молча.
    expect((fn.match(/\.\.\.meta/g) ?? []).length, '⚠ метаданные приложены НЕ ко всем возвратам').toBe(2);
  });

  it('⭐⭐ ВЕДУЩИЙ КЛИП ВЫБИРАЕТСЯ ТЕМ ЖЕ ПРАВИЛОМ, ЧТО В ИГРЕ', () => {
    // Правило: боевая стойка при combat > 0.5, иначе обычная; нет — полная стойка по конвенции.
    // Разойдись они — и хват в редакторе брался бы с другого клипа, чем в игре, ровно в бою.
    const rule = /combat > 0\.5 \? .*'combat_idle', ?weapon.* : .*'idle', ?weapon/;
    const ruleEd = /combat > 0\.5 \? lookClip\('combat_idle', wpn\) : lookClip\('idle', wpn\)/;
    expect(rule.test(SRC('poseRuntime.ts')), 'правило игры на месте').toBe(true);
    expect(ruleEd.test(SRC('pose-editor.ts')), '⚠ редактор выбирает ведущий клип ИНАЧЕ, чем игра').toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readAnimCfg, defaultStanceName } from './animConfig.js';

/**
 * ИМЯ СТОЙКИ — ИЗ ПРИВЯЗКИ, А НЕ ИЗ КОНВЕНЦИИ.
 *
 * Жалоба: «сделай чтобы не было хардкода имён, что я назначил — то и цепляется». Привязка
 * (`pe_anim` → `clipName`) в РАНТАЙМЕ работала с Ф1.2, а редактор всё равно брал имя как
 * `'idle_' + оружие` — поэтому «захватить стойку» плодила `idle_none` рядом с авторским клипом,
 * как бы тот ни назывался, а панель писала «стойка не задана» при вполне заданной стойке.
 *
 * Модель (кто кого перебивает) покрыта в `animConfig.test.ts`. Здесь — ПРОВОДКА В РЕДАКТОРЕ:
 * что имя берётся через резолвер и что писать привязку имеет право ровно одно место. Проверка
 * структурная: `pose-editor.ts` в node-vitest не импортируется (DOM + физика), а именно проводка
 * и разъезжалась — рантайм умел, редактор нет.
 */
const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'pose-editor.ts'), 'utf8');
const lineOf = (re: RegExp): string => {
  const m = SRC.match(re);
  expect(m, `в pose-editor.ts должно найтись ${re}`).not.toBeNull();
  return m![0];
};

describe('редактор берёт имя стойки через привязку', () => {
  it('⭐ stanceName и combatStanceName идут через clipName, а не склеивают строку', () => {
    for (const [fn, kind] of [['stanceName', 'idle'], ['combatStanceName', 'combat_idle']] as const) {
      const src = lineOf(new RegExp(`const ${fn} = \\(w: string\\): string => .*`));
      expect(src, `${fn}: имя обязано резолвиться конфигом`).toContain(`clipName('${kind}'`);
      expect(src, `${fn}: склейка имени — это и есть хардкод, из-за которого захват плодил клипы`)
        .not.toMatch(/'(?:combat_)?idle_'\s*\+/);
    }
  });

  it('⭐ привязку пишет РОВНО ОДНО место — setStanceRole', () => {
    // Тот же класс, что с призраками кадров: два хозяина у одного решения расходятся молча.
    const from = SRC.indexOf('function setStanceRole(');
    expect(from, 'setStanceRole должен существовать').toBeGreaterThan(0);
    const to = SRC.indexOf('\n}', from);
    const hits: number[] = [];
    const re = /\b(?:b|c)\.(?:idle|combatIdle)\s*=/g;
    for (let m = re.exec(SRC); m; m = re.exec(SRC)) hits.push(m.index);
    expect(hits.length, 'записи вообще есть — иначе тест пустой').toBeGreaterThan(1);
    const outside = hits.filter((i) => i < from || i > to).map((i) => SRC.slice(0, i).split('\n').length);
    expect(outside.length, `привязка пишется мимо setStanceRole — строки ${outside.join(', ')}`).toBe(0);
  });

  it('захват стойки пишет В ПРИВЯЗАННЫЙ клип (имя по умолчанию — не литерал)', () => {
    expect(lineOf(/function captureUpper\(nm: string = [^)]*\)/)).toContain('stanceName(weapon)');
  });
});

describe('и сама модель ведёт себя как обещано', () => {
  it('назначенное имя перебивает конвенцию, его отсутствие — возвращает', () => {
    const bound = readAnimCfg({ hero: { base: { idle: 'моя_стойка' } } }, 'hero');
    expect(bound.clipName('idle', 'none'), 'назначено — цепляется назначенное').toBe('моя_стойка');
    expect(bound.clipName('combat_idle', 'none'), 'не назначено — конвенция').toBe(defaultStanceName('combat_idle', 'none'));
    const bare = readAnimCfg({}, 'hero');
    expect(bare.clipName('idle', 'none'), 'пустой конфиг = прежнее поведение').toBe('idle_none');
  });
});

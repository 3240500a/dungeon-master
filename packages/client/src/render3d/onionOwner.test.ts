import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * У ВИДИМОСТИ ПРИЗРАКОВ СОСЕДНИХ КАДРОВ — РОВНО ОДИН ХОЗЯИН.
 *
 * Жалоба «сломались призраки соседних кадров» приходила ДВАЖДЫ, и во второй раз — по моей вине:
 * заслонок было ДВЕ, я снял одну и на этом остановился.
 *
 * • первая жила в `updateOnion()` (гасила онионы при загруженном атласе — снята в `26aed50`);
 * • вторая — в КАДРОВОМ ЦИКЛЕ, и именно она добивала: `updateOnion` зовётся ПО СОБЫТИЯМ
 *   (смена кадра, `refreshAll`), а цикл идёт каждый кадр и сразу же гасил то, что тот показал.
 *   Снаружи это выглядит как «тумблер включён, а призраков нет» — то есть как поломка.
 *
 * Поэтому проверяем не поведение, а СТРУКТУРУ: кто вообще имеет право трогать `visible` у онионов.
 * Поведенческий тест здесь невозможен (кадровый цикл поз-редактора тянет DOM и физику), а вот
 * «решение принимается в одном месте» проверяется честно и ловит ровно тот регресс, что случился.
 */
const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'pose-editor.ts'), 'utf8');

/** Тело функции от её заголовка до закрывающей скобки в нулевой колонке. */
function bodyOf(name: string): { from: number; to: number } {
  const from = SRC.indexOf(`function ${name}(`);
  expect(from, `функция ${name} должна существовать`).toBeGreaterThan(0);
  const to = SRC.indexOf('\n}', from);
  expect(to, `у ${name} должна найтись закрывающая скобка`).toBeGreaterThan(from);
  return { from, to };
}

describe('видимость призраков соседних кадров', () => {
  it('⭐ её ставит ТОЛЬКО updateOnion — второй заслонки быть не должно', () => {
    const own = bodyOf('updateOnion');
    const hits: number[] = [];
    const re = /onion(?:Prev|Next)!?\.root\.visible\s*=/g;
    for (let m = re.exec(SRC); m; m = re.exec(SRC)) hits.push(m.index);

    expect(hits.length, 'сама видимость где-то выставляется — иначе тест пустой').toBeGreaterThan(1);
    const outside = hits.filter((i) => i < own.from || i > own.to);
    const lines = outside.map((i) => SRC.slice(0, i).split('\n').length);
    expect(outside.length,
      `видимость онионов правится ВНЕ updateOnion — строки ${lines.join(', ')}. ` +
      'Именно так призраки и «ломались»: кадровый цикл гасил то, что показал updateOnion.',
    ).toBe(0);
  });

  it('и сами онионы строятся скелетом, когда загружен атлас (иначе они закрывают меш)', () => {
    const mk = bodyOf('mkOnion');
    const body = SRC.slice(mk.from, mk.to);
    expect(body, 'стиль выбирается по наличию атласа').toMatch(/atlasBS\(\)/);
    expect(body, "скелет — это style: 'skeleton'").toMatch(/style:\s*skel\s*\?\s*'skeleton'/);
  });
});

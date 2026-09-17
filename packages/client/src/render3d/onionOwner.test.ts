import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * У ВИДИМОСТИ ПРИЗРАКОВ КАДРОВ — РОВНО ОДИН ХОЗЯИН.
 *
 * Жалоба «сломались призраки соседних кадров» приходила ДВАЖДЫ, и во второй раз — по моей вине:
 * заслонок было ДВЕ, я снял одну и на этом остановился.
 *
 * • первая жила в `updateOnion()` (гасила онионы при загруженном атласе — снята в `26aed50`);
 * • вторая — в КАДРОВОМ ЦИКЛЕ, и именно она добивала: `updateOnion` зовётся ПО СОБЫТИЯМ
 *   (смена кадра, `refreshAll`), а цикл идёт каждый кадр и сразу же гасил то, что тот показал.
 *   Снаружи это выглядит как «тумблер включён, а призраков нет» — то есть как поломка.
 *
 * Поэтому проверяем не поведение, а СТРУКТУРУ: кто вообще имеет право трогать `visible` у призраков.
 * Поведенческий тест здесь невозможен (кадровый цикл поз-редактора тянет DOM и физику), а вот
 * «решение принимается в одном месте» проверяется честно и ловит ровно тот регресс, что случился.
 *
 * 18.09.2026: двух полей `onionPrev`/`onionNext` больше нет — есть ПУЛ `onionGhosts` под произвольные
 * отмеченные кадры. Сторож переписан на пул: показ идёт через `onionVisible`, и звать его может только
 * `updateOnion`. Чистая часть (выбор кадров, оттенок, кэш оседания) — `onionPick.test.ts`.
 */
const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'pose-editor.ts'), 'utf8');

/** Тело функции по ПАРНЫМ скобкам (однострочная тоже): [начало заголовка; закрывающая `}`]. */
function bodyOf(name: string): { from: number; to: number } {
  const m = new RegExp(`function ${name}\\([^)]*\\)[^{]*\\{`).exec(SRC);
  expect(m, `функция ${name} должна существовать`).toBeTruthy();
  const from = m!.index;
  let i = SRC.indexOf('{', from), depth = 0;
  for (; i < SRC.length; i++) { if (SRC[i] === '{') depth++; else if (SRC[i] === '}' && --depth === 0) break; }
  return { from, to: i };
}
const inside = (i: number, r: { from: number; to: number }): boolean => i >= r.from && i <= r.to;
const lineOf = (i: number): number => SRC.slice(0, i).split('\n').length;

describe('видимость призраков кадров', () => {
  it('⭐ её ставит ТОЛЬКО updateOnion — второй заслонки быть не должно', () => {
    const own = bodyOf('updateOnion'), setter = bodyOf('onionVisible');

    // 1. Сам показ/скрытие — вызовы `onionVisible`. Все они обязаны быть внутри `updateOnion`.
    const calls: number[] = [];
    const re = /\bonionVisible\(/g;
    for (let m = re.exec(SRC); m; m = re.exec(SRC)) if (!inside(m.index, setter)) calls.push(m.index);
    expect(calls.length, 'показ призраков где-то происходит — иначе тест пустой').toBeGreaterThan(1);
    const out = calls.filter((i) => !inside(i, own));
    expect(out.length,
      `onionVisible зовут ВНЕ updateOnion — строки ${out.map(lineOf).join(', ')}. ` +
      'Именно так призраки и «ломались»: кадровый цикл гасил то, что показал updateOnion.',
    ).toBe(0);

    // 2. И мимо этого шва видимость призракам никто не пишет: у каждого `X.root.visible =` вне
    //    `updateOnion`/`onionVisible` получатель обязан быть НЕ призраком (манекен или физ-призрак).
    const OWN_RIGS = ['human', 'ghostHuman'];
    const vis = /(\w[\w.[\]!]*)\.root\.visible\s*=/g;
    const bad: string[] = [];
    for (let m = vis.exec(SRC); m; m = vis.exec(SRC)) {
      if (inside(m.index, own) || inside(m.index, setter)) continue;
      if (!OWN_RIGS.includes(m[1]!)) bad.push(`${m[1]} (строка ${lineOf(m.index)})`);
    }
    expect(bad.length, `видимость чужому ригу пишут мимо updateOnion: ${bad.join(', ')}`).toBe(0);

    // 3. Пул не гасится обходом в другом месте (мутация «for (const g of onionGhosts) g.root.visible = …»).
    const pool: number[] = [];
    const poolRe = /onionGhosts/g;
    for (let m = poolRe.exec(SRC); m; m = poolRe.exec(SRC)) pool.push(m.index);
    const poolVis = pool.filter((i) => !inside(i, own) && /visible/.test(SRC.slice(i, SRC.indexOf('\n', i))));
    expect(poolVis.length, `пул трогают за видимость вне updateOnion — строки ${poolVis.map(lineOf).join(', ')}`).toBe(0);
  });

  it('и сами призраки строятся скелетом при атласе и когда их много (иначе они закрывают меш и мылят кадр)', () => {
    const mk = bodyOf('mkOnion'), body = SRC.slice(mk.from, mk.to);
    expect(body, "скелет — это style: 'skeleton'").toMatch(/style:\s*onionSkel|style:\s*skel\s*\?\s*'skeleton'/);
    const up = SRC.slice(...Object.values(bodyOf('updateOnion')) as [number, number]);
    expect(up, 'стиль пула: атлас ИЛИ много призраков').toMatch(/atlasBS\(\)\s*\|\|\s*want\.length\s*>=\s*ONION_SKEL_AT/);
    expect(up, 'смена стиля пересобирает пул — иначе половина призраков осталась бы телами').toMatch(/skel !== onionSkel.*disposeOnion\(\)/);
    expect(body, 'видимость свежего призрака ставит updateOnion, а не сборка').not.toMatch(/visible/);
  });

  it('⚠ разбор пула освобождает И материалы: скелет-стиль выделяет их НА МЕШ (40-60 на призрака)', () => {
    const d = bodyOf('disposeOnion'), body = SRC.slice(d.from, d.to);
    expect(body).toMatch(/geometry\.dispose\(\)/);
    expect(body, 'материалы текли: разбирали только геометрию').toMatch(/material[\s\S]*\.dispose\(\)/);
    expect(body, 'пул очищается целиком').toMatch(/onionGhosts\.length = 0/);
    expect(body, 'кэш оседания принадлежит пулу и уходит вместе с ним').toMatch(/onionSettle\.clear\(\)/);
  });

  it('⭐ выбор кадров едет за правкой клипа: каждая вставка/удаление ключа двигает отметки', () => {
    const lines = SRC.split('\n');
    const splices = lines.map((l, i) => ({ l, i })).filter((x) => /c\.keys\.splice\(/.test(x.l));
    expect(splices.length, 'вставка и удаление кадра где-то есть — иначе тест пустой').toBeGreaterThan(1);
    const miss = splices.filter((x) => !/shiftOnionPicks\(c, /.test(x.l));
    expect(miss.length,
      `ключи двигают без отметок — строки ${miss.map((x) => x.i + 1).join(', ')}: ` +
      'призраки молча переедут на чужие кадры',
    ).toBe(0);
  });

  it('выбор живёт ПО КЛИПУ и в личных настройках (на сервер не уходит)', () => {
    const from = SRC.indexOf('const onionPickRaw');
    expect(from, 'чтение набора должно быть отдельным швом').toBeGreaterThan(0);
    const read = SRC.slice(from, bodyOf('onionPicks').to);
    expect(read, 'ключ набора — общий onionClipKey (персонаж|оружие|имя)').toMatch(/onionClipKey\(c\)/);
    expect(read, "хранилище — pe_prefs ('onionPick'), а не контент клипа").toMatch(/getPref<Record<string, number\[\]>>\('onionPick'/);
    expect(read, '⚠ индексы зажимаются по длине клипа: клип мог укоротиться').toMatch(/clampPicks\([^;]*c\.keys\.length\)/);
    expect(read, '⚠ в localStorage могло оказаться что угодно').toMatch(/Array\.isArray/);
    expect(SRC, 'выбор не публикуется: в клип его никто не пишет').not.toMatch(/c\.(onionPick|picks)\s*=/);
  });

  it('устаревший риг ловится у ВСЕГО пула, а не у первых двух призраков (грабля Ф27)', () => {
    const s = SRC.slice(...Object.values(bodyOf('syncRigs')) as [number, number]);
    expect(s).toMatch(/onionGhosts\.some\(\(g\) => rigKeyOf\(g\) !== key\)[\s\S]{0,40}disposeOnion\(\)/);
  });
});

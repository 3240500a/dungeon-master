import { describe, it, expect } from 'vitest';
import { makeStageOwner } from './stageOwner.js';

/**
 * ГОНКИ АСИНХРОННОЙ СБОРКИ — то, из-за чего в сцене оставалась вторая кукла.
 *
 * Жалоба: «после того как я нажал тест, появился ещё один меш». Меш был настоящий — игровая кукла
 * вкладки «Тест», оставшаяся в сцене поз-редактора: белая, в бинд-позе (её больше никто не ведёт),
 * в начале координат, поверх манекена.
 *
 * Здесь проверяется ровно тот узел, где это случалось: владение результатом АСИНХРОННОЙ сборки.
 * Сборка куклы — это физика + конфиг + GLB, то есть секунды, и всё ломалось в этом окне.
 */

/** Управляемая сборка: резолвим руками, чтобы окно «собирается» было под контролем теста. */
function rig() {
  let builds = 0, dropped = 0, on = 0, off = 0;
  const pending: { resolve: (v: number | null) => void; alive: () => boolean }[] = [];
  const owner = makeStageOwner<number>({
    build: (alive) => { builds++; return new Promise<number | null>((resolve) => pending.push({ resolve, alive })); },
    drop: () => { dropped++; },
    on: () => { on++; },
    off: () => { off++; },
  });
  return {
    owner, pending,
    get counts() { return { builds, dropped, on, off }; },
    /** Достроить самую старую незавершённую сборку. */
    finish(v: number | null = 1): Promise<void> { pending.shift()!.resolve(v); return new Promise((r) => setTimeout(r, 0)); },
  };
}

describe('что собрано — то убрано', () => {
  it('обычный цикл: собрались, поработали, ушли', async () => {
    const r = rig();
    void r.owner.start();
    await r.finish();
    expect(r.owner.active, 'собрались').toBe(true);
    expect(r.owner.liveCount).toBe(1);
    r.owner.stop();
    expect(r.owner.liveCount, 'в сцене пусто').toBe(0);
    expect(r.counts.dropped, 'снято ровно одно').toBe(1);
    expect(r.owner.active).toBe(false);
  });

  it('⭐ УШЛИ, ПОКА СОБИРАЛОСЬ — кукла не остаётся в сцене', async () => {
    // Первая из двух дыр. Сборка доезжает уже на ЧУЖОЙ вкладке; раньше она просто добавляла
    // куклу в сцену, и снять её было нечем.
    const r = rig();
    void r.owner.start();
    expect(r.owner.active, 'ещё не собрались').toBe(false);
    r.owner.stop();
    await r.finish();
    expect(r.owner.liveCount, 'ничего не осело в сцене').toBe(0);
    expect(r.counts.dropped, 'собранное снесено, а не потеряно').toBe(1);
    expect(r.owner.active).toBe(false);
  });

  it('⭐ ДВЕ ГОНЯЩИЕСЯ СБОРКИ — живёт ровно одна, вторая снята', async () => {
    // Вторая дыра, и это ровно то, что видел юзер: две куклы в сцене, ссылка на последней,
    // предыдущая — сирота навсегда.
    const r = rig();
    void r.owner.start();
    void r.owner.rebuild();                 // вторая сборка, пока первая в полёте
    expect(r.counts.builds, 'обе стартовали').toBe(2);
    await r.finish(1);                      // достраивается ПЕРВАЯ (устаревшая)
    await r.finish(2);                      // затем вторая
    expect(r.owner.liveCount, 'в сцене одна').toBe(1);
    expect(r.counts.dropped, 'устаревшая снесена').toBe(1);
    r.owner.stop();
    expect(r.counts.dropped, 'после ухода снято всё').toBe(2);
  });

  it('порядок завершения не важен: даже если устаревшая доезжает ПОСЛЕДНЕЙ', async () => {
    const r = rig();
    void r.owner.start();
    void r.owner.rebuild();
    r.pending.reverse();                    // сперва достраивается новая, потом старая
    await r.finish(2);
    await r.finish(1);
    expect(r.owner.liveCount).toBe(1);
    expect(r.counts.dropped).toBe(1);
  });
});

describe('гейт снаружи смотрит на НАМЕРЕНИЕ, а не на результат', () => {
  it('⭐ `wanted` поднимается СРАЗУ, `active` — только в конце сборки', async () => {
    // Ровно этим и была первая дыра: гейт вкладки спрашивал `active`, а он в окне загрузки false,
    // поэтому «уйти» было некому — `stop()` не звался вовсе.
    const r = rig();
    void r.owner.start();
    expect(r.owner.wanted, 'намерение есть сразу').toBe(true);
    expect(r.owner.active, 'а результата ещё нет').toBe(false);
    await r.finish();
    expect(r.owner.active).toBe(true);
  });

  it('повторный `start()` не плодит вторую сборку', async () => {
    const r = rig();
    void r.owner.start();
    void r.owner.start();
    void r.owner.start();
    expect(r.counts.builds, 'сборка одна').toBe(1);
    await r.finish();
    expect(r.owner.liveCount).toBe(1);
  });

  it('`alive()` внутри сборки честно говорит «уже не нужны»', async () => {
    const r = rig();
    void r.owner.start();
    const first = r.pending[0]!;
    expect(first.alive(), 'пока нужны').toBe(true);
    r.owner.stop();
    expect(first.alive(), 'ушли — дальше грузить незачем').toBe(false);
    await r.finish(null);
  });

  it('ресурсы отдаются даже если собраться не успели', async () => {
    // Клавиатура и орбита захватываются на входе; уход во время загрузки обязан их вернуть,
    // иначе редактор остаётся без орбиты, а стрелки едут «в тест».
    const r = rig();
    void r.owner.start();
    r.owner.stop();
    expect(r.counts).toMatchObject({ on: 1, off: 1 });
    await r.finish();
  });

  it('«собрались ни во что» — не ошибка и ничего не сносит', async () => {
    const r = rig();
    void r.owner.start();
    await r.finish(null);
    expect(r.owner.liveCount).toBe(0);
    expect(r.counts.dropped, 'сносить нечего').toBe(0);
    expect(r.owner.active, 'и активными не притворяемся').toBe(false);
  });

  it('пересборка без намерения ничего не строит', async () => {
    const r = rig();
    await r.owner.rebuild();
    expect(r.counts.builds).toBe(0);
  });

  it('stop() повторно — без последствий', async () => {
    const r = rig();
    void r.owner.start();
    await r.finish();
    r.owner.stop(); r.owner.stop(); r.owner.stop();
    expect(r.counts.dropped, 'снято один раз').toBe(1);
    expect(r.counts.off, 'ресурсы отданы один раз').toBe(1);
  });
});

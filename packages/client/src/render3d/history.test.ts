import { describe, it, expect } from 'vitest';
import { makeHistory } from './history.js';
import { migrateClip, type Clip } from './clipModel.js';

describe('history — командный стек', () => {
  it('run записывает «до/после» и откатывает ровно на шаг', () => {
    const h = makeHistory();
    let v = 0;
    const take = (): number => v, put = (s: number): void => { v = s; };
    h.run('+1', take, put, () => { v += 1; });
    h.run('+10', take, put, () => { v += 10; });
    expect(v).toBe(11);
    expect(h.undo()).toBe('+10'); expect(v).toBe(1);
    expect(h.undo()).toBe('+1'); expect(v).toBe(0);
    expect(h.undo()).toBe(null); expect(v).toBe(0);
    expect(h.redo()).toBe('+1'); expect(v).toBe(1);
    expect(h.redo()).toBe('+10'); expect(v).toBe(11);
    expect(h.redo()).toBe(null);
  });

  it('новая правка обрывает redo', () => {
    const h = makeHistory();
    let v = 0; const take = (): number => v, put = (s: number): void => { v = s; };
    h.run('a', take, put, () => { v = 1; });
    h.undo();
    expect(h.canRedo()).toBe(true);
    h.run('b', take, put, () => { v = 2; });
    expect(h.canRedo()).toBe(false);
    expect(h.peek().undo).toBe('b');
  });

  it('cap вытесняет самые старые шаги', () => {
    const h = makeHistory(3);
    let v = 0; const take = (): number => v, put = (s: number): void => { v = s; };
    for (let i = 1; i <= 5; i++) h.run('s' + i, take, put, () => { v = i; });
    expect(h.size().undo).toBe(3);
    h.undo(); h.undo(); h.undo();
    expect(v).toBe(2);                       // откатились только до состояния перед s3
    expect(h.canUndo()).toBe(false);
  });

  it('undo/redo сами не пишутся в историю (нет рекурсии)', () => {
    const h = makeHistory();
    let v = 0;
    h.push('x', () => { v = 0; h.push('вложенная', () => { /* */ }, () => { /* */ }); }, () => { v = 1; });
    h.undo();
    expect(h.size().undo).toBe(0);
    expect(h.size().redo).toBe(1);
  });

  it('структурная правка клипа откатывается целиком (кадры, не только поза)', () => {
    const h = makeHistory();
    let clip: Clip = migrateClip({ name: 'hit_sword', character: 'a', weapon: 'sword', keys: [{ Spine: [0, 0, 0] }, { Spine: [1, 0, 0] }] });
    const take = (): string => JSON.stringify(clip);
    const put = (s: string): void => { clip = JSON.parse(s) as Clip; };

    h.run('удалить кадр', take, put, () => { clip.keys.splice(1, 1); });
    expect(clip.keys.length).toBe(1);
    h.undo();
    expect(clip.keys.length).toBe(2);
    expect(clip.keys[1]!.pose['Spine']).toEqual([1, 0, 0]);
    h.redo();
    expect(clip.keys.length).toBe(1);
  });

  it('clear обнуляет обе стороны', () => {
    const h = makeHistory();
    let v = 0; const take = (): number => v, put = (s: number): void => { v = s; };
    h.run('a', take, put, () => { v = 1; });
    h.undo();
    h.clear();
    expect(h.canUndo()).toBe(false); expect(h.canRedo()).toBe(false);
    expect(h.peek()).toEqual({ undo: null, redo: null });
  });
});

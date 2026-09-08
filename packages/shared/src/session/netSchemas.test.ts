import { describe, it, expect } from 'vitest';
import { parseClientFrame, validateInput } from './netSchemas.js';

/**
 * Валидация кадров клиента (Ф0.6). Главное, что проверяем: в игровое ядро не может попасть
 * ни `NaN`, ни `Infinity`, ни кадр неизвестной формы.
 */
const goodInput = { move: { x: 0.6, y: -0.8 }, facing: 1.2, attack: true, cast: null, interact: false };

describe('validateInput', () => {
  it('пропускает корректный ввод', () => {
    const r = validateInput(goodInput);
    expect(r).not.toBeNull();
    expect(r!.facing).toBeCloseTo(1.2, 10);
  });

  it('отбрасывает NaN и Infinity в координатах и во взгляде', () => {
    expect(validateInput({ ...goodInput, move: { x: NaN, y: 0 } })).toBeNull();
    expect(validateInput({ ...goodInput, move: { x: 0, y: Infinity } })).toBeNull();
    expect(validateInput({ ...goodInput, facing: NaN })).toBeNull();
    expect(validateInput({ ...goodInput, facing: -Infinity })).toBeNull();
  });

  it('отбрасывает не-числа там, где ждём числа', () => {
    expect(validateInput({ ...goodInput, move: { x: '1', y: 0 } })).toBeNull();
    expect(validateInput({ ...goodInput, facing: '0' })).toBeNull();
    expect(validateInput({ ...goodInput, move: null })).toBeNull();
    expect(validateInput(null)).toBeNull();
    expect(validateInput('строка')).toBeNull();
  });

  it('отбрасывает неверные флаги и слишком длинный cast', () => {
    expect(validateInput({ ...goodInput, attack: 'да' })).toBeNull();
    expect(validateInput({ ...goodInput, interact: 1 })).toBeNull();
    expect(validateInput({ ...goodInput, cast: 'x'.repeat(65) })).toBeNull();
    expect(validateInput({ ...goodInput, cast: 'x'.repeat(64) })).not.toBeNull();
  });

  it('ограничивает вектор движения единичной длиной', () => {
    const r = validateInput({ ...goodInput, move: { x: 1000, y: 0 } })!;
    expect(Math.hypot(r.move.x, r.move.y)).toBeCloseTo(1, 10);
    // короткий вектор (аналоговый стик) не растягивается
    const half = validateInput({ ...goodInput, move: { x: 0.3, y: 0 } })!;
    expect(half.move.x).toBeCloseTo(0.3, 10);
  });

  it('проверяет диапазон слота пояса', () => {
    expect(validateInput({ ...goodInput, useBelt: -1 })).toBeNull();
    expect(validateInput({ ...goodInput, useBelt: 99 })).toBeNull();
    expect(validateInput({ ...goodInput, useBelt: 1.5 })).toBeNull();
    expect(validateInput({ ...goodInput, useBelt: 3 })!.useBelt).toBe(3);
  });
});

describe('parseClientFrame', () => {
  it('разбирает ввод', () => {
    const f = parseClientFrame(JSON.stringify({ t: 'input', seq: 5, input: goodInput }));
    expect(f?.t).toBe('input');
  });

  it('отбрасывает ввод с битым seq или содержимым', () => {
    expect(parseClientFrame(JSON.stringify({ t: 'input', seq: NaN, input: goodInput }))).toBeNull();
    expect(parseClientFrame(JSON.stringify({ t: 'input', seq: 1, input: { ...goodInput, facing: NaN } }))).toBeNull();
  });

  it('разбирает join и требует токен с charId', () => {
    expect(parseClientFrame(JSON.stringify({ t: 'join', token: 'abc', charId: 'c1', fresh: true }))?.t).toBe('join');
    expect(parseClientFrame(JSON.stringify({ t: 'join', charId: 'c1' }))).toBeNull();
    expect(parseClientFrame(JSON.stringify({ t: 'join', token: '', charId: 'c1' }))).toBeNull();
  });

  it('разбирает команды города и отбрасывает неизвестные', () => {
    expect(parseClientFrame(JSON.stringify({ t: 'cmd', command: { cmd: 'buy', uid: 'it_1' } }))?.t).toBe('cmd');
    expect(parseClientFrame(JSON.stringify({ t: 'cmd', command: { cmd: 'нет-такой', uid: 'x' } }))).toBeNull();
    expect(parseClientFrame(JSON.stringify({ t: 'cmd', command: { cmd: 'moveItem', uid: 'i', x: -5, y: 0 } }))).toBeNull();
  });

  it('отбрасывает мусор и неизвестные типы кадров', () => {
    expect(parseClientFrame('не json')).toBeNull();
    expect(parseClientFrame('null')).toBeNull();
    expect(parseClientFrame('[]')).toBeNull();
    expect(parseClientFrame(JSON.stringify({ t: 'выключи-сервер' }))).toBeNull();
    expect(parseClientFrame(JSON.stringify({ t: 'ping', id: 'нет' }))).toBeNull();
  });

  it('ограничивает длину строковых полей', () => {
    expect(parseClientFrame(JSON.stringify({ t: 'join', token: 'x'.repeat(300), charId: 'c' }))).toBeNull();
    expect(parseClientFrame(JSON.stringify({ t: 'cmd', command: { cmd: 'buy', uid: 'x'.repeat(100) } }))).toBeNull();
  });
});

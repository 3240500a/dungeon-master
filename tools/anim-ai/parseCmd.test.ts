import { describe, it, expect } from 'vitest';
import { parseCmd, fillArgs } from './cmd.js';

/**
 * Разбор команды движка. Проверяется отдельно, потому что здесь проходит ГРАНИЦА ДОВЕРИЯ:
 * промпт пишет человек, а мы по нему запускаем процесс. Оболочки нет намеренно — подстановка
 * идёт в уже разобранные аргументы, и текст запроса не может стать синтаксисом команды.
 */
describe('команда движка', () => {
  it('разбирается по пробелам, кавычки склеивают аргумент', () => {
    expect(parseCmd('kimodo_gen --model soma --out out.bvh')).toEqual(['kimodo_gen', '--model', 'soma', '--out', 'out.bvh']);
    expect(parseCmd('"C:/Program Files/kimodo/gen.exe" --steps 50')).toEqual(['C:/Program Files/kimodo/gen.exe', '--steps', '50']);
    expect(parseCmd("gen --prompt '{prompt}'")).toEqual(['gen', '--prompt', '{prompt}']);
    expect(parseCmd('')).toEqual([]);
  });

  it('подстановки идут В АРГУМЕНТЫ, а не в строку команды', () => {
    const argv = parseCmd('gen --prompt {prompt} --frames {frames} --out {out}');
    const got = fillArgs(argv, { prompt: 'взмах мечом', frames: '60', out: 'C:/tmp/a.bvh' });
    expect(got).toEqual(['gen', '--prompt', 'взмах мечом', '--frames', '60', '--out', 'C:/tmp/a.bvh']);
    // Промпт остался ОДНИМ аргументом, хотя внутри пробел, — оболочка его не разрежет.
    expect(got[2]).toBe('взмах мечом');
  });

  it('ОПАСНЫЙ ПРОМПТ ОСТАЁТСЯ ТЕКСТОМ: точка с запятой и кавычки не становятся командой', () => {
    const argv = parseCmd('gen --prompt {prompt}');
    const evil = '"; rm -rf / #';
    const got = fillArgs(argv, { prompt: evil });
    expect(got).toEqual(['gen', '--prompt', evil]);
    expect(got.length).toBe(3);
  });

  it('незнакомая подстановка остаётся как есть — молча пустой аргумент хуже видимой ошибки', () => {
    expect(fillArgs(['--x', '{nope}'], { prompt: 'a' })).toEqual(['--x', '{nope}']);
  });
});

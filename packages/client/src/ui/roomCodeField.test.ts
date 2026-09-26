import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOM_CODE_LEN, ROOM_CODE_ALPHABET } from '@dm/shared';

/**
 * R4-18: код комнаты вырос (буква ноды + 7 знаков без двусмысленных) — поле кода в лобби обязано вмещать его целиком:
 * обрезанный код — это «Комната не найдена» и потраченный промах из лимита адреса. Длину поле берёт из того же места,
 * что и сервер, и схема кадра `join`.
 */
const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'entryScreens.ts'), 'utf8');

describe('R4-18: поле кода комнаты в лобби', () => {
  it('длина поля — общая длина кода, а не число в разметке', () => {
    expect(SRC).toMatch(/maxlength="\$\{ROOM_CODE_LEN\}"/);
    expect(SRC, '⚠ длина кода числом в разметке вернулась').not.toMatch(/class="code"[^>]*maxlength="\d+"/);
    expect(ROOM_CODE_LEN).toBe(8);
    expect(new Set(ROOM_CODE_ALPHABET).size, '32 знака без повторов').toBe(32);
    expect(ROOM_CODE_ALPHABET, 'без двусмысленных 0/O и 1/I').not.toMatch(/[01OI]/);
  });
});

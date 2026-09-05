/**
 * ПРОДЮСЕР golden-эталона походки. На каждом `npm test` перегенерирует `__golden__/gait.json` из ТЕКУЩЕГО веб-кода
 * (веб = источник истины). Unity-паритет-тест сверяет свой скопированный JSON с этим. Когда веб-походку правят
 * осознанно — эталон обновляется тут, потом синкается в Unity (`cp` в Assets/DM/PoseEditor/Tests/gait_golden.json).
 */
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildGaitGolden } from './gaitGolden.js';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('gaitGolden — продюсер эталона (пишет __golden__/gait.json)', () => {
  it('генерит непустой конечный эталон и пишет на диск', () => {
    const g = buildGaitGolden();
    expect(g.cases.length).toBeGreaterThan(5);
    for (const c of g.cases) {
      expect(c.frames.length).toBe(c.out.length);
      expect(c.out.length).toBeGreaterThan(0);
      for (const o of c.out) {
        for (const v of Object.values(o)) expect(Number.isFinite(v)).toBe(true);
      }
    }
    const dir = join(HERE, '__golden__');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'gait.json'), JSON.stringify(g, null, 0));
  });
});

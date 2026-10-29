import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ⭐ С3 (29.10): ИСХОДНИК `render3d` ДЛЯ СТОРОЖЕЙ-ПО-ТЕКСТУ («редактор зовёт тот же шов») — по имени файла из поз-редактора.
 * ⭐ С11 (29.10): веб-стенда игры (`packages/client/src/render3d`) больше нет (тег `web-client-final`) — искать больше негде.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const DIRS = [HERE];

export function render3dSrc(name: string): string {
  for (const d of DIRS) { const p = join(d, name); if (existsSync(p)) return readFileSync(p, 'utf8'); }
  throw new Error(`render3d: нет файла ${name} в поз-редакторе`);
}

/** Имена `.ts` (кроме тестов) обеих папок `render3d`. */
export function render3dFiles(): Set<string> {
  const out = new Set<string>();
  for (const d of DIRS) if (existsSync(d)) for (const f of readdirSync(d)) if (f.endsWith('.ts') && !f.endsWith('.test.ts')) out.add(f);
  return out;
}

/** Соседи модуля по импортам — `./x.js` и `@dm/pose-editor/render3d/x.js` — именами файлов. */
export function render3dImports(src: string): string[] {
  return [...src.matchAll(/from '(?:\.\/|@dm\/pose-editor\/render3d\/)([A-Za-z0-9_.-]+)\.js'/g)].map((m) => m[1]! + '.ts');
}

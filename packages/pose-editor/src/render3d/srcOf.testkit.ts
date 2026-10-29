import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ⭐ С3 (29.10): ИСХОДНИК `render3d` ДЛЯ СТОРОЖЕЙ-ПО-ТЕКСТУ. Поз-редактор уехал в свой пакет (`packages/pose-editor/src/render3d`), а
 * веб-стенд игры остался в `packages/client/src/render3d` — сторожа, читающие соседний файл по имени («в `online3d.ts` нет планировщика»,
 * «редактор зовёт тот же шов»), берут его отсюда: сперва из поз-редактора, потом из веб-клиента.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const DIRS = [HERE, join(HERE, '../../../client/src/render3d')];

export function render3dSrc(name: string): string {
  for (const d of DIRS) { const p = join(d, name); if (existsSync(p)) return readFileSync(p, 'utf8'); }
  throw new Error(`render3d: нет файла ${name} ни в поз-редакторе, ни в веб-клиенте`);
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

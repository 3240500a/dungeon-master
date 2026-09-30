import { getConfigOverrides, setConfigOverride } from './db.js';
import { closePool } from './pool.js';
import { repairOverrides } from './repairOverrides.js';

/**
 * Починка оверрайдов конфига, отставших от схемы (что и почему — `repairOverrides.ts`).
 *
 *   npm run db:repair          — показать, что не проходит и что будет исправлено
 *   npm run db:repair -- --fix — записать исправленное
 *
 * ⭐ R21-01: оверрайды проверяются вместе — тем же кандидатом, что собирает сервер (`configCandidate.ts`), а не каждый поверх файлов.
 */
const FIX = process.argv.includes('--fix');

async function main(): Promise<void> {
  await repairOverrides({ overrides: await getConfigOverrides(), fix: FIX, write: setConfigOverride, out: (line) => console.log(line) });
  await closePool();
}

void main();

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStampOf, isBuildStampSource } from '@dm/shared';

/**
 * ⭐ R18-08: ШТАМП СБОРКИ СЕРВЕРА — хэш исходников `packages/shared/src`, с которых этот процесс и работает (`node --import tsx`, без
 * сборки), тем же `buildStampOf`, что сборка клиента вписывает в бандл (`client/vite.config.ts` → `__DM_BUILD__`). Едет в кадре `joined`
 * (`build`): вкладка с другим штампом пережила деплой со старым кодом цен — `App` скажет игроку «перезагрузите».
 *
 * Считается ОДИН раз — на старте процесса, вместе с загрузкой кода (~115 файлов, ~1.8 МБ — миллисекунды): `git pull` под работающим
 * сервером меняет файлы, но не код в его памяти, и штамп, посчитанный по ним позже (при первом входе), назвал бы вкладкам сборку, которой
 * сервер ещё не исполняет. Исходников нет (сервер собран в один файл, урезанная выкладка) — пустая строка: поля в кадре нет, сравнения
 * нет, как у сервера старше штампа.
 */
const SHARED_SRC = join(dirname(fileURLToPath(import.meta.url)), '../../shared/src');

function stampOfSources(): string {
  try {
    const files = readdirSync(SHARED_SRC, { recursive: true }).map(String).filter(isBuildStampSource);
    return buildStampOf(files.map((p) => [p, readFileSync(join(SHARED_SRC, p), 'utf8')] as const));
  } catch (e) {
    console.warn(`[build] штамп сборки не посчитан (${SHARED_SRC}) — вкладкам не с чем сравнить свой:`, e instanceof Error ? e.message : e);
    return '';
  }
}
const STAMP = stampOfSources();

/** Штамп сборки этого процесса ('' — не посчитать). */
export function serverBuild(): string { return STAMP; }

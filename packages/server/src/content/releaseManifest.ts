import { sha256 } from './blobStore.js';

/**
 * ⭐ 08.10 (Д1): МАНИФЕСТ РЕЛИЗА КОНТЕНТА — что входит в версию данных и по каким файлам это лежит. Клиент на запуске сверяет ОДИН номер
 * (указатель → хэш манифеста), совпал — ничего не качает; нет — берёт манифест и докачивает только файлы, которых у него нет.
 *
 *  • Конфиг — одним файлом, ровно тело `/api/config` (снимок реестра сервера).
 *  • Анимации — ПО ФАЙЛУ НА КЛИП (`pe_clips` в порядке библиотеки: клип ищется первым совпадением), прочие ключи поз-редактора — по файлу
 *    на ключ. Правка одного клипа = один новый файл, а не вся библиотека (~1.5 МБ).
 *  • Ревизии конфига (полная и игровая) — чтобы клиент клал в согласие кузницы ту же игровую ревизию, что у сервера.
 *
 * Манифест детерминирован: одно содержимое — одни байты и один хэш (ключи в постоянном порядке, без времени и номера). Номер релиза и время
 * живут в базе (`content_releases`); подпись манифеста — фаза Д3.
 */

/** Номер совместимости контента и кода клиента (ABI): контент другой ABI клиент не возьмёт. Смена схемы данных, которую старый клиент не
 *  прочтёт, — +1 (и новый клиент в Steam). */
export const CONTENT_ABI = 1;
/** Формат самого манифеста. */
export const MANIFEST_FORMAT = 1;
/** Ключи поз-редактора, которые не контент игры (роадмап — данные вкладки редактора). */
export const POSE_EXCLUDED: ReadonlySet<string> = new Set(['pe_roadmap']);

export interface ReleaseInput {
  /** Тело `/api/config` — JSON снимка реестра. */
  config: string;
  configRev: string;
  gameRev: string;
  /** Весь `pose_store`: ключ → значение. */
  pose: Record<string, unknown>;
}

export interface Manifest {
  format: number;
  abi: number;
  data: { config: string; pose: Record<string, string>; clips: string[] };
  rev: { config: string; game: string };
  /** Все файлы релиза с размерами (без самого манифеста): по ним клиент считает «надо скачать N байт». */
  files: Record<string, { size: number }>;
}

export interface BuiltRelease {
  manifest: Manifest;
  manifestBytes: Buffer;
  manifestSha: string;
  /** Файлы релиза (без манифеста), каждый — один раз. */
  blobs: Map<string, Buffer>;
}

export function buildRelease(input: ReleaseInput): BuiltRelease {
  const blobs = new Map<string, Buffer>();
  const add = (bytes: Buffer): string => {
    const sha = sha256(bytes);
    if (!blobs.has(sha)) blobs.set(sha, bytes);
    return sha;
  };
  const json = (v: unknown): Buffer => Buffer.from(JSON.stringify(v) ?? 'null', 'utf8');

  const config = add(Buffer.from(input.config, 'utf8'));
  const rawClips = input.pose.pe_clips;
  const clips = Array.isArray(rawClips) ? rawClips.map((c) => add(json(c))) : [];
  const pose: Record<string, string> = {};
  for (const key of Object.keys(input.pose).sort()) {
    if (key === 'pe_clips' || POSE_EXCLUDED.has(key)) continue;
    pose[key] = add(json(input.pose[key]));
  }
  const files: Record<string, { size: number }> = {};
  for (const sha of [...blobs.keys()].sort()) files[sha] = { size: blobs.get(sha)!.length };

  const manifest: Manifest = {
    format: MANIFEST_FORMAT,
    abi: CONTENT_ABI,
    data: { config, pose, clips },
    rev: { config: input.configRev, game: input.gameRev },
    files,
  };
  const manifestBytes = json(manifest);
  return { manifest, manifestBytes, manifestSha: sha256(manifestBytes), blobs };
}

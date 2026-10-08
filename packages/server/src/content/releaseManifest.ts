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
  /** ⭐ Д2: арт-релиз Unity (`art-abi<N>.json`: каталог Addressables и бандлы) — файлы уже в хранилище; нет — релиз без арта. */
  art?: ArtRelease;
}

export interface ArtFile { name: string; sha: string; size: number }
/** ⭐ Д2: описание арт-релиза, которое пишет публикатор Unity (`ArtContentPublisher.cs`). */
export interface ArtRelease { catalog: ArtFile; bundles: ArtFile[] }

/** Описание арт-релиза из JSON или `null` — не по форме (имя без путей, sha256, размер — неотрицательное целое). */
export function parseArtRelease(v: unknown): ArtRelease | null {
  const file = (x: unknown): ArtFile | null => {
    const o = x as Partial<ArtFile> | null;
    if (!o || typeof o.name !== 'string' || !/^[A-Za-z0-9_.-]{1,200}$/.test(o.name)) return null;
    if (typeof o.sha !== 'string' || !/^[0-9a-f]{64}$/.test(o.sha)) return null;
    if (typeof o.size !== 'number' || !Number.isInteger(o.size) || o.size < 0) return null;
    return { name: o.name, sha: o.sha, size: o.size };
  };
  const o = v as { catalog?: unknown; bundles?: unknown } | null;
  const catalog = file(o?.catalog);
  if (!catalog || !Array.isArray(o?.bundles)) return null;
  const bundles: ArtFile[] = [];
  for (const b of o.bundles) { const f = file(b); if (!f) return null; bundles.push(f); }
  bundles.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { catalog, bundles };
}

export interface Manifest {
  format: number;
  abi: number;
  data: { config: string; pose: Record<string, string>; clips: string[]; art?: ArtRelease };
  rev: { config: string; game: string };
  /** Все файлы релиза с размерами (без самого манифеста): по ним клиент считает «надо скачать N байт». */
  files: Record<string, { size: number }>;
}

export interface BuiltRelease {
  manifest: Manifest;
  manifestBytes: Buffer;
  manifestSha: string;
  /** Файлы данных релиза (без манифеста и арта — арт уже в хранилище), каждый — один раз. */
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
  const sizes = new Map<string, number>([...blobs].map(([sha, b]) => [sha, b.length]));
  if (input.art) for (const f of [input.art.catalog, ...input.art.bundles]) sizes.set(f.sha, f.size);   // файлы арта уже в хранилище
  const files: Record<string, { size: number }> = {};
  for (const sha of [...sizes.keys()].sort()) files[sha] = { size: sizes.get(sha)! };

  const manifest: Manifest = {
    format: MANIFEST_FORMAT,
    abi: CONTENT_ABI,
    data: { config, pose, clips, ...(input.art ? { art: input.art } : {}) },
    rev: { config: input.configRev, game: input.gameRev },
    files,
  };
  const manifestBytes = json(manifest);
  return { manifest, manifestBytes, manifestSha: sha256(manifestBytes), blobs };
}

import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isSha, type BlobStore } from './blobStore.js';
import { ChannelOpError } from './channelRules.js';
import { parseArtRelease } from './releaseManifest.js';

/**
 * ⭐ 08.10 (Д3, план «Обновление контента без пересборки клиента»): ФАЙЛЫ РЕЛИЗА И УБОРКА ХРАНИЛИЩА.
 *
 *  • `releaseFiles` — всё, на что опирается релиз: сам манифест и каждый файл из него (`files`, плюс ссылки `data` — на случай
 *    манифеста, где `files` неполон). По нему выпуск в канал проверяет, что у релиза всё на месте (`missingFiles`), а уборка — что держать.
 *  • `collectGarbage` — файл удаляется, ТОЛЬКО если на него не ссылается ни один из держимых манифестов (последние N релизов и каждый
 *    указатель канала, текущий и прежний) и ни один защищённый файл (арт, уже залитый, но ещё не в релизе), И он старше срока. Не
 *    читается хоть один держимый манифест — не удаляем ничего (неизвестно, на что он ссылался). Сухой прогон — по умолчанию.
 *    Обрывки (`*.part`, `.gz` без своего файла) старше срока — тоже прочь.
 */
interface ManifestRefs {
  files?: Record<string, unknown>;
  data?: { config?: unknown; pose?: Record<string, unknown>; clips?: unknown[]; art?: { catalog?: { sha?: unknown }; bundles?: Array<{ sha?: unknown } | null> } };
}

/** Манифест и все его файлы или `null` — манифеста нет в хранилище (или он не JSON). */
export function releaseFiles(store: BlobStore, manifestSha: string): string[] | null {
  if (!store.has(manifestSha)) return null;
  let m: ManifestRefs;
  try { m = JSON.parse(readFileSync(store.pathOf(manifestSha), 'utf8')) as ManifestRefs; } catch { return null; }
  if (!m || typeof m !== 'object') return null;
  const out = new Set<string>([manifestSha]);
  const add = (s: unknown): void => { if (isSha(s)) out.add(s); };
  for (const k of Object.keys(m.files ?? {})) add(k);
  add(m.data?.config);
  for (const v of Object.values(m.data?.pose ?? {})) add(v);
  for (const v of m.data?.clips ?? []) add(v);
  add(m.data?.art?.catalog?.sha);
  for (const b of m.data?.art?.bundles ?? []) add(b?.sha);
  return [...out];
}

/** Файлы релиза, которых нет в хранилище; манифеста нет — он один. */
export function missingFiles(store: BlobStore, manifestSha: string): string[] {
  const files = releaseFiles(store, manifestSha);
  if (!files) return [manifestSha];
  return files.filter((s) => !store.has(s));
}

/**
 * Файлы арт-описаний в папке контента (`art-abi<N>.json`, Д2): публикатор Unity кладёт бандлы ДО описания, а нарезчик берёт их в релиз
 * позже — уборка их держит. Описание не читается — уборка останавливается (неизвестно, что оно держит).
 */
export function artFilesIn(dir: string): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const out: string[] = [];
  for (const name of names) {
    if (!/^art-abi\d+\.json$/.test(name)) continue;
    let art: ReturnType<typeof parseArtRelease> = null;
    try { art = parseArtRelease(JSON.parse(readFileSync(join(dir, name), 'utf8'))); } catch { /* ниже — отказ */ }
    if (!art) throw new ChannelOpError(409, `${name} не по форме — уборка остановлена`);
    out.push(art.catalog.sha, ...art.bundles.map((b) => b.sha));
  }
  return out;
}

export interface GcOptions {
  store: BlobStore;
  /** Держимые манифесты: последние N релизов и все указатели каналов. */
  keepManifests: Iterable<string>;
  /** Ещё держимые файлы (арт-описания `art-abi<N>.json`, ещё не нарезанные). */
  protect?: Iterable<string>;
  /** Срок: моложе — не трогаем, даже если ссылок нет. */
  minAgeMs: number;
  dryRun: boolean;
  now?: number;
}

export interface GcReport {
  dryRun: boolean;
  /** Держимых файлов (по ссылкам). */
  kept: number;
  /** Файлов в хранилище (без `.gz` и `.part`). */
  scanned: number;
  /** Без ссылок, но моложе срока. */
  young: number;
  /** Удалено — или было бы удалено при `dryRun`. */
  removed: number;
  /** Их байты вместе с `.gz`. */
  bytes: number;
  /** Обрывков старше срока (`.part`, `.gz` без своего файла) — удалено (или было бы). */
  parts: number;
  /** До 20 удалённых sha. */
  sample: string[];
}

export function collectGarbage(o: GcOptions): GcReport {
  const now = o.now ?? Date.now();
  const keep = new Set<string>();
  const broken: string[] = [];
  for (const m of o.keepManifests) {
    const files = releaseFiles(o.store, m);
    if (!files) { broken.push(m); continue; }
    for (const f of files) keep.add(f);
  }
  if (broken.length) {
    throw new ChannelOpError(409, `манифест держимого релиза не читается (${broken.length}) — уборка остановлена`, { manifests: broken.slice(0, 10) });
  }
  for (const f of o.protect ?? []) if (isSha(f)) keep.add(f);

  const report: GcReport = { dryRun: o.dryRun, kept: 0, scanned: 0, young: 0, removed: 0, bytes: 0, parts: 0, sample: [] };
  const base = join(o.store.root, 'b');
  let dirs: string[];
  try { dirs = readdirSync(base); } catch { return report; }
  const old = (path: string): { size: number } | null => {
    try {
      const st = statSync(path);
      return now - st.mtimeMs >= o.minAgeMs ? { size: st.size } : null;
    } catch { return null; }
  };
  for (const d of dirs) {
    if (!/^[0-9a-f]{2}$/.test(d)) continue;
    const dir = join(base, d);
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    const here = new Set(names);
    for (const name of names) {
      // обрывок записи или сжатая копия без своего файла (уборка, прерванная между ними)
      const orphanGz = name.endsWith('.gz') && isSha(name.slice(0, -3)) && !here.has(name.slice(0, -3)) && !keep.has(name.slice(0, -3));
      if (name.endsWith('.part') || orphanGz) {
        if (old(join(dir, name))) {
          report.parts++;
          if (!o.dryRun) rmSync(join(dir, name), { force: true });
        }
        continue;
      }
      if (!isSha(name) || name.slice(0, 2) !== d) continue;   // `.gz` идёт вместе со своим файлом
      report.scanned++;
      if (keep.has(name)) { report.kept++; continue; }
      const path = join(dir, name);
      const st = old(path);
      if (!st) { report.young++; continue; }
      let gzSize = 0;
      try { gzSize = statSync(path + '.gz').size; } catch { /* сжатой копии нет */ }
      report.removed++;
      report.bytes += st.size + gzSize;
      if (report.sample.length < 20) report.sample.push(name);
      // Файл — первым: кто не нашёл его, сжатую копию не спросит (кладёт `put` наоборот — копию раньше файла)
      if (!o.dryRun) { rmSync(path, { force: true }); rmSync(path + '.gz', { force: true }); }
    }
  }
  return report;
}

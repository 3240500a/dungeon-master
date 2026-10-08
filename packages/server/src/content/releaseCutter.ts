import type { BlobStore } from './blobStore.js';
import { buildRelease, CONTENT_ABI, type ReleaseInput } from './releaseManifest.js';
import type { Recorded, ReleaseRecord } from './releaseDb.js';

/**
 * ⭐ 08.10 (Д1): НАРЕЗЧИК РЕЛИЗОВ. Сервер сам режет релиз контента из того, что у него СЕЙЧАС: живой конфиг (тело `/api/config`) и
 * `pose_store`. Повод — любая правка (редактор конфигов, публикация поз-редактора, файл данных, сверка с соседним процессом) и старт;
 * правки идут пачками (публикация пишет ключ за ключом), поэтому — с паузой тишины `debounceMs`. Редакторы при этом не меняются: их
 * «Опубликовать» уже пишет на сервер, а релиз вырастает из записи — «правка в редакторе сразу видна в игре» остаётся.
 *
 * Порядок по плану: сперва файлы в хранилище, потом манифест, потом запись релиза и перевод канала (`record`). Клиент, увидевший новый
 * указатель, найдёт всё, на что тот ссылается. Нарезки идут по одной; повод во время нарезки — ещё одна после неё.
 */
export interface CutterDeps {
  readInput(): Promise<ReleaseInput>;
  store: BlobStore;
  record(r: ReleaseRecord): Promise<Recorded>;
  /** Пауза тишины после повода, мс. */
  debounceMs?: number;
  log?(msg: string): void;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(t: unknown): void;
}

export interface CutResult { seq: number; fresh: boolean; manifest: string; files: number; newFiles: number; bytes: number; newBytes: number }

export interface ReleaseCutter {
  /** Повод нарезать: правка контента. Нарезка — после паузы тишины. */
  poke(): void;
  /** Нарезать сейчас (ручка разработчика, тесты). */
  cutNow(): Promise<CutResult>;
  /** Дождаться, пока отложенная и идущая нарезки закончатся. */
  idle(): Promise<void>;
  /** Последняя удачная нарезка. */
  last(): CutResult | null;
}

export function releaseCutter(deps: CutterDeps): ReleaseCutter {
  const wait = deps.debounceMs ?? 1500;
  const setT = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let timer: unknown = null;
  let chain: Promise<unknown> = Promise.resolve();
  let pendingWake: (() => void) | null = null;
  let pending: Promise<void> | null = null;
  let lastCut: CutResult | null = null;

  async function cut(): Promise<CutResult> {
    const input = await deps.readInput();
    // Д2: арт — только если ВСЕ его файлы уже в хранилище (публикатор кладёт их ДО описания); нет — релиз без арта и строка в лог
    if (input.art) {
      const missing = [input.art.catalog, ...input.art.bundles].filter((f) => !deps.store.has(f.sha));
      if (missing.length) {
        deps.log?.(`арт-релиз без файлов в хранилище (${missing.length}: ${missing.slice(0, 3).map((f) => f.name).join(', ')}) — релиз без арта`);
        delete input.art;
      }
    }
    const built = buildRelease(input);
    let newFiles = 0, bytes = 0, newBytes = 0;
    for (const bytesOf of built.blobs.values()) {
      const r = deps.store.put(bytesOf);
      bytes += r.size;
      if (r.fresh) { newFiles++; newBytes += r.size; }
    }
    deps.store.put(built.manifestBytes);   // манифест — после файлов, на которые он ссылается
    const rec = await deps.record({
      abi: CONTENT_ABI, manifest: built.manifestSha, manifestSize: built.manifestBytes.length,
      configRev: input.configRev, gameRev: input.gameRev,
    });
    const res: CutResult = {
      seq: rec.seq, fresh: rec.fresh, manifest: built.manifestSha,
      files: built.blobs.size, newFiles, bytes, newBytes,
    };
    if (rec.fresh) {
      deps.log?.(`релиз контента #${rec.seq}: файлов ${res.files} (новых ${newFiles}, ${(newBytes / 1024).toFixed(1)} КБ из ${(bytes / 1024).toFixed(1)} КБ), манифест ${built.manifestSha.slice(0, 12)}`);
    }
    lastCut = res;
    return res;
  }

  /** Нарезки строго по одной: следующая ждёт предыдущую, её ошибка не рвёт цепочку. */
  function enqueue(): Promise<CutResult> {
    const run = chain.then(cut, cut);
    chain = run.catch(() => undefined);
    return run;
  }

  return {
    poke() {
      if (timer !== null) clearT(timer);
      if (!pending) pending = new Promise<void>((resolve) => { pendingWake = resolve; });
      timer = setT(() => {
        timer = null;
        const wake = pendingWake;
        pending = null; pendingWake = null;
        enqueue()
          .catch((e: unknown) => deps.log?.(`нарезка релиза не удалась: ${e instanceof Error ? e.message : String(e)}`))
          .finally(() => wake?.());
      }, wait);
    },
    cutNow: () => enqueue(),
    async idle() {
      if (pending) await pending;
      await chain;
    },
    last: () => lastCut,
  };
}

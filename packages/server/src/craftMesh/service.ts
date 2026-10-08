import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configSetRev, type ConfigRegistry, type CraftParts } from '@dm/shared';
import { CRAFT_MESH_DEPS } from '../../../client/src/modules/town/craftMesh/configVersion.js';
import { serverBuild, stampOfDir } from '../buildStamp.js';
import { CraftMeshBaker, type BakeJob, type BakeResult } from './baker.js';
import { CRAFT_BIN_FORMAT } from './binFormat.js';
import { GlbCache, type CacheExt } from './cache.js';
import type { CraftMeshFormat } from './protocol.js';

/**
 * МОДЕЛЬ ИЗ ДЕТАЛЕЙ ПО ВИДУ: ключ, кэш, печь (`GET /api/craft-mesh.glb` и `.bin`, ручка — `net/craftMeshRoutes.ts`).
 *
 * КЛЮЧ = штамп кода печи + ревизия таблиц модели + подпись вида.
 * - Ревизия таблиц — `configSetRev` по `CRAFT_MESH_DEPS` (тот же список, по которому веб-клиент пересобирает модель, R1-22): по
 *   СОДЕРЖИМОМУ, одинаковая у всех процессов и после рестарта (память ревизии — по объекту таблицы, дёшево на каждый запрос).
 *   Правка детали в редакторе — новый ключ, новый ETag, клиент перечитает модель. Таблицы берутся СНИМКОМ вместе с ключом
 *   (`keyOf`) и тем же снимком уходят печи: правка конфига посреди запроса не положит под старый ключ модель новых таблиц.
 * - Штамп кода — исходники построителей (`client/modules/town/craftMesh`), печи (`server/craftMesh`), `shared` (`serverBuild`) и
 *   версия `three` (экспортёр): деплой, сменивший форму модели, не отдаст с диска старую. Штампа нет (урезанная выкладка без
 *   исходников) — дисковый кэш выключается: без штампа он не отличил бы старый код от нового.
 *
 * ⭐ 08.10 (Ф4, план «Unity — дом визуального контента»): ФОРМАТ — часть ключа. GLB — прежний вид ключа и ETag `"cm-…"` (штамп кода печи
 * сменился вместе с энкодером — ETag GLB сменятся один раз; кэш Unity только в памяти); DMCM v1 — ключ с хвостом `|bin1` и ETag `"cmb1-…"`, на диске — `.dmcm` (`FORMATS`). LRU общий, и байты
 * одного формата на запрос другого не уйдут ни из памяти, ни с диска, ни по `If-None-Match`: у них разные ключи и ETag.
 *
 * Одна печь на ключ: запросы одного вида, пришедшие, пока он печётся, ждут ту же работу. Несобираемые ключи помнятся
 * (`FAILED_KEEP`, как у веба `craftWeapon3d.ts`) — поток одного кривого вида печь не занимает.
 *
 * ⭐ ИСКЛЮЧЕНИЕ ПОСТРОИТЕЛЯ (`error`) — НЕ СРАЗУ «не строится»: бывает и сбой мгновения (память, перегруз потока), и запомнить его до
 * следующей ревизии конфига значило бы отдавать процедурный меш вместо модели весь день. Сбой — 503 (клиент повторит позже), счёт
 * сбоев вида — подряд (`ERROR_STRIKES`); третий подряд — вид несобираем (422, помнится). Удача счёт обнуляет. Наружу — общая фраза:
 * текст исключения (пути, внутренности построителя) остаётся в журнале сервера.
 */

const FAILED_KEEP = 1024;
/** Сбоев построителя подряд на одном виде, после которых он считается несобираемым. */
export const ERROR_STRIKES = 3;
/** Сколько видов со сбоями помним (счёт подряд); сверх — счёт начинается заново. */
const ERRORS_KEEP = 1024;
/** Что видит клиент на сбой построителя: подробность — в журнале сервера. */
const ERROR_REASON = 'Печь моделей: сбой, попробуйте позже';
const UNBUILDABLE_REASON = 'Модель этого вида не строится';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILDER_SRC = join(HERE, '../../../client/src/modules/town/craftMesh');

/** Версия `three`, которую возьмёт печь: `package.json` пакета (его `exports` сам файл не отдаёт — ищем от входа вверх). */
function threeVersion(): string {
  let dir = dirname(createRequire(import.meta.url).resolve('three'));
  for (let i = 0; i < 4; i++, dir = dirname(dir)) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
      if (pkg.name === 'three' && pkg.version) return pkg.version;
    } catch { /* выше */ }
  }
  return '';
}

/** Штамп кода печи; '' — исходников нет. */
export function craftMeshCodeStamp(): string {
  try {
    const three = threeVersion();
    const parts = [stampOfDir(BUILDER_SRC), stampOfDir(HERE), serverBuild(), three];
    return parts.every(Boolean) ? `${parts.slice(0, 3).join('.')}.three${three}` : '';
  } catch {
    return '';
  }
}

/** Таблицы модели живого реестра — ссылками (реестр таблицы на месте не правит: правка — новый объект). */
export function craftMeshTables(reg: ConfigRegistry): Record<string, unknown> {
  return Object.fromEntries(CRAFT_MESH_DEPS.map((k) => [k, reg.get(k)]));
}

/** Ревизия таблиц модели. */
export function craftMeshRev(tables: Record<string, unknown>): string {
  return configSetRev(CRAFT_MESH_DEPS, (k) => tables[k]);
}

/** Ключ, ETag и диск по формату. Поднял `CRAFT_BIN_FORMAT` — новый хвост ключа и ETag: старые файлы DMCM не спрашиваются. */
export const FORMATS: Readonly<Record<CraftMeshFormat, { keySuffix: string; etagPrefix: string; ext: CacheExt }>> = {
  glb: { keySuffix: '', etagPrefix: 'cm', ext: 'glb' },
  bin: { keySuffix: `|bin${CRAFT_BIN_FORMAT}`, etagPrefix: `cmb${CRAFT_BIN_FORMAT}`, ext: 'dmcm' },
};

/** Что нужно, чтобы отдать модель вида: ключ и ETag (до всякой работы — для 304), снимок таблиц, вид. */
export interface MeshRequest {
  fmt: CraftMeshFormat;
  key: string;
  etag: string;
  rev: string;
  tables: Record<string, unknown>;
  sig: string;
  weaponClass: string;
  hands: number;
  parts: CraftParts;
}

export type MeshAnswer =
  | { ok: true; bytes: Uint8Array; source: 'memory' | 'disk' | 'bake' }
  | { ok: false; status: 422 | 503; reason: string };

export interface CraftMeshServiceOptions {
  config: ConfigRegistry;
  baker?: { bake(job: BakeJob): Promise<BakeResult>; close?(): Promise<void> };
  cache?: GlbCache;
  /** Штамп кода (тест подставляет свой). */
  codeStamp?: string;
}

export class CraftMeshService {
  readonly config: ConfigRegistry;
  readonly cache: GlbCache;
  private readonly baker: NonNullable<CraftMeshServiceOptions['baker']>;
  private readonly code: string;
  private readonly inflight = new Map<string, Promise<MeshAnswer>>();
  private readonly failed = new Map<string, string>();
  /** Сбоев построителя подряд по ключу (`ERROR_STRIKES`). */
  private readonly errors = new Map<string, number>();

  constructor(o: CraftMeshServiceOptions) {
    this.config = o.config;
    this.code = o.codeStamp ?? craftMeshCodeStamp();
    this.cache = o.cache ?? new GlbCache();
    if (this.cache.hasDisk && !this.code) console.warn('[craft-mesh] штампа кода нет — дисковый кэш моделей не используется');
    this.baker = o.baker ?? new CraftMeshBaker();
  }

  /** Запрос модели по подписи вида: ключ, ETag и снимок таблиц — без печи. `fmt` — формат файла (по умолчанию GLB). */
  request(sig: string, weaponClass: string, hands: number, parts: CraftParts, fmt: CraftMeshFormat = 'glb'): MeshRequest {
    const tables = craftMeshTables(this.config);
    const rev = craftMeshRev(tables);
    const f = FORMATS[fmt];
    const key = `${this.code}|${rev}|${sig}${f.keySuffix}`;
    const etag = `"${f.etagPrefix}-${createHash('sha256').update(key).digest('base64url').slice(0, 27)}"`;
    return { fmt, key, etag, rev, tables, sig, weaponClass, hands, parts };
  }

  /** Модель: память → диск → печь (одна на ключ). */
  get(q: MeshRequest): Promise<MeshAnswer> {
    const hit = this.cache.get(q.key);
    if (hit) return Promise.resolve({ ok: true, bytes: hit, source: 'memory' });
    const bad = this.failed.get(q.key);
    if (bad !== undefined) return Promise.resolve({ ok: false, status: 422, reason: bad });
    let p = this.inflight.get(q.key);
    if (!p) {
      p = this.load(q).finally(() => this.inflight.delete(q.key));
      this.inflight.set(q.key, p);
    }
    return p;
  }

  async close(): Promise<void> {
    await this.baker.close?.();
  }

  /** Вид не строится на этой ревизии: 422, ключ помнится — печь его больше не печёт. */
  private unbuildable(key: string, reason: string): MeshAnswer {
    if (this.failed.size >= FAILED_KEEP) this.failed.clear();
    this.failed.set(key, reason);
    return { ok: false, status: 422, reason };
  }

  private async load(q: MeshRequest): Promise<MeshAnswer> {
    if (this.code) {
      const disk = await this.cache.getDisk(q.key, FORMATS[q.fmt].ext);
      if (disk) return { ok: true, bytes: disk, source: 'disk' };
    }
    const r = await this.baker.bake({
      fmt: q.fmt, rev: q.rev, tables: () => q.tables, look: q.sig, weaponClass: q.weaponClass, hands: q.hands, parts: q.parts,
    });
    if (r.ok) {
      this.errors.delete(q.key);
      this.cache.set(q.key, r.bytes);
      if (this.code) void this.cache.putDisk(q.key, r.bytes, FORMATS[q.fmt].ext);
      return { ok: true, bytes: r.bytes, source: 'bake' };
    }
    if (r.kind === 'error') {
      const n = (this.errors.get(q.key) ?? 0) + 1;
      console.warn(`[craft-mesh] сбой построителя на «${q.sig}» (${n}/${ERROR_STRIKES}): ${r.reason}`);
      if (n < ERROR_STRIKES) {
        if (this.errors.size >= ERRORS_KEEP) this.errors.clear();
        this.errors.set(q.key, n);
        return { ok: false, status: 503, reason: ERROR_REASON };
      }
      this.errors.delete(q.key);
      return this.unbuildable(q.key, UNBUILDABLE_REASON);
    }
    if (r.kind === 'unbuildable') return this.unbuildable(q.key, r.reason);
    return { ok: false, status: 503, reason: r.reason };
  }
}

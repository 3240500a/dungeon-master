import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * ⭐ 08.10 (Д3, план «Обновление контента без пересборки клиента»): ПОДПИСЬ УКАЗАТЕЛЯ КОНТЕНТА (Ed25519, `node:crypto`).
 *
 * Подписывается строка-контракт (UTF-8, без пробелов и перевода строки):
 *
 *     dmcontent:v1|<abi>|<seq>|<manifest>|<channel>
 *
 *  • `abi`, `seq` — десятичные целые без ведущих нулей (как в JSON указателя);
 *  • `manifest` — sha256 манифеста, 64 знака hex в нижнем регистре (тот самый `manifest` указателя);
 *  • `channel` — канал ОТВЕТА (`channel` указателя: `dev` у запасного указателя, см. `releaseRoutes.ts`).
 *
 * Подпись — 64 байта Ed25519 (RFC 8032, чистый Ed25519 без хэша), в ответе — base64 со знаками `=` (поле `sig`). Ключ — пара Ed25519;
 * открытый ключ раздаётся как 32 сырых байта в base64 (`publicKey`) и как SPKI PEM; `keyId` — первые 16 знаков hex sha256 сырых 32 байт
 * (клиент по нему выбирает ключ из СВОИХ доверенных, ротация без нового клиента не нужна).
 *
 * Подпись покрывает номер и хэш манифеста: подменённый на CDN манифест не сойдётся по sha256, старый релиз — по номеру (клиент берёт
 * только `seq` не меньше сохранённого), чужой канал — по `channel`. Ключ: `DM_CONTENT_SIGN_KEY_FILE` (PKCS#8 PEM на диске сервера) или,
 * без переменной, ДЕВ-ключ, который сервер заводит сам один раз (`packages/server/dev-secrets/content-sign.key`, вне папки контента; на ПРОДЕ без переменной подписи нет) — описание в `docs/DEPLOY.md`.
 */
export const SIGN_PREFIX = 'dmcontent:v1';
export const SIGN_ALG = 'ed25519';

/** Строка, которую подписывает сервер и проверяет клиент. */
export function signedString(abi: number, seq: number, manifest: string, channel: string): string {
  return `${SIGN_PREFIX}|${abi}|${seq}|${manifest}|${channel}`;
}

export interface ContentSigner {
  /** Первые 16 знаков hex sha256 сырого открытого ключа. */
  readonly keyId: string;
  /** Открытый ключ: 32 сырых байта в base64. */
  readonly publicKey: string;
  /** Открытый ключ SPKI PEM (для `openssl` и стенда). */
  readonly publicPem: string;
  /** Ключ заведён сервером сам (нет `DM_CONTENT_SIGN_KEY_FILE`) — клиенты прода ему не верят. */
  readonly dev: boolean;
  /** Откуда ключ (путь файла). */
  readonly source: string;
  /** Подпись указателя: base64 64 байт. */
  sign(abi: number, seq: number, manifest: string, channel: string): string;
}

/** Сырые 32 байта открытого ключа Ed25519. */
export function rawPublicKey(k: KeyObject): Buffer {
  const pub = k.type === 'private' ? createPublicKey(k) : k;
  const x = (pub.export({ format: 'jwk' }) as { x?: string }).x;
  if (!x) throw new Error('ключ без открытой части Ed25519');
  return Buffer.from(x, 'base64url');
}

export function keyIdOf(raw: Buffer): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/** Открытый ключ Ed25519 из 32 сырых байт (base64) — так его держит клиент. */
export function publicKeyFromRaw(b64: string): KeyObject {
  const raw = Buffer.from(b64, 'base64');
  if (raw.length !== 32) throw new Error(`открытый ключ Ed25519 — 32 байта, а не ${raw.length}`);
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });
}

/** Проверка подписи указателя — так же, как её делает клиент. */
export function verifyContentSig(publicKeyB64: string, abi: number, seq: number, manifest: string, channel: string, sigB64: string): boolean {
  const sig = Buffer.from(sigB64, 'base64');
  if (sig.length !== 64) return false;
  try {
    return verify(null, Buffer.from(signedString(abi, seq, manifest, channel), 'utf8'), publicKeyFromRaw(publicKeyB64), sig);
  } catch { return false; }
}

export function signerFromKey(priv: KeyObject, source: string, dev: boolean): ContentSigner {
  if (priv.type !== 'private' || priv.asymmetricKeyType !== 'ed25519') {
    throw new Error(`${source}: нужен закрытый ключ Ed25519 (PKCS#8 PEM), а не ${priv.asymmetricKeyType ?? priv.type}`);
  }
  const raw = rawPublicKey(priv);
  const publicPem = createPublicKey(priv).export({ format: 'pem', type: 'spki' }).toString();
  return {
    keyId: keyIdOf(raw), publicKey: raw.toString('base64'), publicPem, dev, source,
    sign: (abi, seq, manifest, channel) => sign(null, Buffer.from(signedString(abi, seq, manifest, channel), 'utf8'), priv).toString('base64'),
  };
}

export interface LoadSignerOptions {
  /** `DM_CONTENT_SIGN_KEY_FILE`: путь к PKCS#8 PEM. Задан, но не читается или не Ed25519 — ОШИБКА (сервер не стартует). */
  keyFile?: string;
  /** Где лежит (или заводится) ДЕВ-ключ. */
  devKeyPath: string;
  /** Продакшен без `keyFile` — без подписи (null) и громкое предупреждение: дев-ключ на проде не заводится. */
  production?: boolean;
  log?(msg: string): void;
  warn?(msg: string): void;
}

/**
 * Ключ подписи. Есть `keyFile` — только он. Нет — ДЕВ-ключ: лежит — читаем; нет — заводим ОДИН раз (`wx`: второй процесс, успевший
 * первым, не перезапишет — читаем его ключ). В лог — откуда ключ и его открытая часть (`keyId` и base64): её вписывают в клиент стенда.
 */
export function loadContentSigner(o: LoadSignerOptions): ContentSigner | null {
  const log = o.log ?? ((m: string) => console.log(m));
  const warn = o.warn ?? ((m: string) => console.warn(m));
  let signer: ContentSigner;
  // ⭐ Д3 (проверка): продакшен без боевого ключа НЕ подписывает дев-ключом (его закрытая часть живёт в разработке) — указатель уходит
  // без подписи, выпускные клиенты его отвергают и играют старым путём; громко в лог на каждом старте
  if (!o.keyFile && o.production) {
    warn('[content] ⚠ ПРОДАКШЕН БЕЗ КЛЮЧА ПОДПИСИ (DM_CONTENT_SIGN_KEY_FILE): указатель НЕ подписан — выпускные клиенты отвергнут релизы контента (docs/DEPLOY.md)');
    return null;
  }
  if (o.keyFile) {
    signer = signerFromKey(createPrivateKey(readFileSync(o.keyFile, 'utf8')), o.keyFile, false);
  } else {
    let pem: string;
    if (existsSync(o.devKeyPath)) {
      pem = readFileSync(o.devKeyPath, 'utf8');
    } else {
      const fresh = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
      mkdirSync(dirname(o.devKeyPath), { recursive: true });
      try {
        writeFileSync(o.devKeyPath, fresh, { flag: 'wx', mode: 0o600 });
        pem = fresh;
        log(`[content] заведён ДЕВ-ключ подписи контента: ${o.devKeyPath}`);
      } catch (e) {
        if ((e as { code?: string }).code !== 'EEXIST') throw e;
        pem = readFileSync(o.devKeyPath, 'utf8');
      }
    }
    signer = signerFromKey(createPrivateKey(pem), o.devKeyPath, true);
  }
  log(`[content] ключ подписи указателя ${signer.dev ? 'ДЕВ' : 'боевой'} (${signer.source}): keyId ${signer.keyId}, открытый (base64, 32 байта) ${signer.publicKey}`);
  return signer;
}

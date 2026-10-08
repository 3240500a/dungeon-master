import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, verify } from 'node:crypto';
import { loadContentSigner, publicKeyFromRaw, signedString, verifyContentSig, keyIdOf } from './contentSign.js';

/**
 * ⭐ 08.10 (Д3): ПОДПИСЬ УКАЗАТЕЛЯ — строка контракта, Ed25519, ДЕВ-ключ заводится один раз, боевой — только из файла переменной.
 */
let dir = '';
const quiet = { log: () => undefined, warn: () => undefined };
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dm-sign-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const MAN = 'ab'.repeat(32);

describe('⭐ Д3: подпись указателя контента', () => {
  it('строка контракта — ровно "dmcontent:v1|abi|seq|manifest|channel"', () => {
    expect(signedString(1, 42, MAN, 'live')).toBe(`dmcontent:v1|1|42|${MAN}|live`);
  });

  it('подпись проверяется открытым ключом (32 байта base64) — и тем же способом, что в node:crypto напрямую', () => {
    const s = loadContentSigner({ devKeyPath: join(dir, 'dev-sign.key'), ...quiet })!;
    const sig = s.sign(1, 42, MAN, 'live');
    expect(Buffer.from(sig, 'base64')).toHaveLength(64);
    expect(Buffer.from(s.publicKey, 'base64')).toHaveLength(32);
    expect(s.keyId).toBe(keyIdOf(Buffer.from(s.publicKey, 'base64')));
    expect(verifyContentSig(s.publicKey, 1, 42, MAN, 'live', sig)).toBe(true);
    expect(verify(null, Buffer.from(`dmcontent:v1|1|42|${MAN}|live`), publicKeyFromRaw(s.publicKey), Buffer.from(sig, 'base64'))).toBe(true);
    expect(s.publicPem).toContain('BEGIN PUBLIC KEY');
  });

  it('подмена любой части — подпись не сходится: номер (старый релиз), манифест (CDN), канал, ABI', () => {
    const s = loadContentSigner({ devKeyPath: join(dir, 'dev-sign.key'), ...quiet })!;
    const sig = s.sign(1, 42, MAN, 'live');
    expect(verifyContentSig(s.publicKey, 1, 41, MAN, 'live', sig)).toBe(false);
    expect(verifyContentSig(s.publicKey, 1, 42, 'cd'.repeat(32), 'live', sig)).toBe(false);
    expect(verifyContentSig(s.publicKey, 1, 42, MAN, 'beta', sig)).toBe(false);
    expect(verifyContentSig(s.publicKey, 2, 42, MAN, 'live', sig)).toBe(false);
    expect(verifyContentSig(s.publicKey, 1, 42, MAN, 'live', 'AAAA')).toBe(false);
  });

  it('ДЕВ-ключ заводится один раз: второй запуск читает тот же; в лог — его открытая часть', () => {
    const path = join(dir, 'sub', 'dev-sign.key');
    const logs: string[] = [];
    const a = loadContentSigner({ devKeyPath: path, log: (m) => logs.push(m), warn: () => undefined })!;
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('BEGIN PRIVATE KEY');
    expect(a.dev).toBe(true);
    const b = loadContentSigner({ devKeyPath: path, ...quiet })!;
    expect(b.publicKey).toBe(a.publicKey);
    expect(logs.some((l) => l.includes(a.publicKey) && l.includes(a.keyId))).toBe(true);
  });

  it('продакшен без ключа — громкое предупреждение и БЕЗ подписи (дев-ключ на проде не заводится и не берётся)', () => {
    const warns: string[] = [];
    const s = loadContentSigner({ devKeyPath: join(dir, 'dev-sign.key'), production: true, log: () => undefined, warn: (m) => warns.push(m) });
    expect(s).toBeNull();
    expect(existsSync(join(dir, 'dev-sign.key'))).toBe(false);
    expect(warns.join('\n')).toContain('DM_CONTENT_SIGN_KEY_FILE');
  });

  it('боевой ключ — из файла переменной (PKCS#8 PEM); не тот тип или нет файла — ошибка, а не ДЕВ-ключ', () => {
    const file = join(dir, 'prod.pem');
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    writeFileSync(file, privateKey.export({ format: 'pem', type: 'pkcs8' }));
    const s = loadContentSigner({ keyFile: file, devKeyPath: join(dir, 'dev-sign.key'), ...quiet })!;
    expect(s.dev).toBe(false);
    expect(existsSync(join(dir, 'dev-sign.key'))).toBe(false);
    expect(verify(null, Buffer.from(signedString(1, 5, MAN, 'live')), publicKey, Buffer.from(s.sign(1, 5, MAN, 'live'), 'base64'))).toBe(true);

    const rsa = join(dir, 'rsa.pem');
    writeFileSync(rsa, generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ format: 'pem', type: 'pkcs8' }));
    expect(() => loadContentSigner({ keyFile: rsa, devKeyPath: join(dir, 'dev-sign.key'), ...quiet })).toThrow(/Ed25519/);
    expect(() => loadContentSigner({ keyFile: join(dir, 'нет.pem'), devKeyPath: join(dir, 'dev-sign.key'), ...quiet })).toThrow();
  });
});

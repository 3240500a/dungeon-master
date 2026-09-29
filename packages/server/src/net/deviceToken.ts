import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * ⭐ R11-05: ТОКЕН УСТРОЙСТВА ВХОДА — «с этого устройства в этот ник уже входили с верным паролем» (приём OWASP против блокировки
 * входа чужими неудачами). Бакет сети адреса (`limits.login`) держит перебор пароля с одного адреса, но его же опустошал тролль за
 * общим NAT (оператор, общежитие, офис) неверными паролями к любым существующим никам — и сосед с верным паролем получал 429.
 * Вход с токеном устройства бакет адреса не спрашивает и не платит: его держат потолки НИКА (`loginUserDevice`, `loginOk`), которые тролль
 * без пароля этого ника не обойдёт, — а сам токен ничего не открывает: пароль нужен как прежде. ⭐ R18-05: потолок ника у входа с токеном —
 * СВОЙ (`loginUserDevice`): общий (`loginUser`) тролль держал пустым неверными паролями без токена, и владелец со своим токеном получал 429.
 *
 * Вид — 64 hex: 24 случайных знака и 40 знаков HMAC-SHA256 (ключ процессов, `setDeviceKey`) над ником без регистра и случайной
 * частью. Базы не спрашивает: проверка — пересчёт подписи. Выдаётся на верный пароль и регистрацию; клиент хранит его по нику.
 * Ключ — один на базу (`db.serverKey`), общий у всех процессов и переживает рестарт; до его загрузки (и в тестах) — свой на процесс:
 * токены прошлого ключа просто не пропускают мимо бакета адреса (вход — как без токена).
 */
let key: Buffer = randomBytes(32);

/** Ключ процессов из базы (`index.ts`, старт гейтвея и одиночного процесса). */
export function setDeviceKey(hex: string): void {
  key = Buffer.from(hex, 'hex');
}

const DEVICE_RE = /^[0-9a-f]{64}$/;

function mac(who: string, rand: string): string {
  return createHmac('sha256', key).update(`dm-device|${who}|${rand}`).digest('hex').slice(0, 40);
}

/** Токен устройства для ника `who` (без регистра). */
export function deviceToken(who: string): string {
  const rand = randomBytes(12).toString('hex');
  return rand + mac(who, rand);
}

/** Годен ли `v` как токен устройства ника `who` (без регистра). Не того вида — нет, без исключений. */
export function deviceOk(v: unknown, who: string): boolean {
  if (typeof v !== 'string' || !DEVICE_RE.test(v)) return false;
  const want = Buffer.from(mac(who, v.slice(0, 24)), 'hex');
  const got = Buffer.from(v.slice(24), 'hex');
  return want.length === got.length && timingSafeEqual(want, got);
}

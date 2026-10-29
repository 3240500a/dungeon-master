/**
 * ХУК ПОД AI-ГЕНЕРАЦИЮ АНИМАЦИИ (Ф9).
 *
 * Никакой новой инфраструктуры здесь нет и не нужно: канал уже целиком собран раньше.
 *   текст-запрос → сервис генерации → BVH → `clipBaker.bakeAnimationToClip` (BVH уже поддержан
 *   загрузчиком) → наш `Clip` → библиотека → превью → принять / перегенерировать / доработать руками.
 * BVH выбран форматом обмена потому, что его отдаёт большинство text-to-motion моделей (MDM и т.п.),
 * и потому, что у нас уже есть обратный ретаргет с него.
 *
 * СЕРВИС ТЕПЕРЬ ЕСТЬ: `tools/anim-ai` — шим, который закрывает этот контракт и гоняет движок
 * (либо отдаёт заглушку в режиме `--stub`). Путь «из файла» остаётся: им удобно тащить
 * готовые BVH со стороны и проверять запекатель без сети вообще.
 *
 * КЛЮЧ ДОСТУПА ЖИВЁТ НЕ ЗДЕСЬ. Адрес сервиса — общий для всех машин в сети, поэтому он
 * едет в `pe_ai` и публикуется; а ключ — учётные данные, и ему место в личных `pe_prefs`,
 * которые на сервер не уходят вовсе. Поэтому ключ передаётся аргументом, а не полем конфига.
 */
import type { Clip } from './clipModel.js';

export interface AiConfig {
  /** Адрес сервиса генерации (POST). Пусто → доступен только режим «из файла». */
  url: string;
  /** Последний запрос — чтобы не набирать заново. */
  prompt: string;
  /** Сколько секунд просить. */
  seconds: number;
}
export const DEFAULT_AI_CONFIG = (): AiConfig => ({ url: '', prompt: '', seconds: 2 });

export interface AiRequest { prompt: string; seconds: number; character: string; weapon: string }
export interface AiResponse {
  /** BVH-текст (основной путь — его отдают text-to-motion модели и экспорт Kimodo). */
  bvh?: string;
  /**
   * Скелетный GLB. `kimodo.cpp` экспортирует именно его, а не BVH. Конвертер писать не надо:
   * `modelAssets`/`clipBaker` УЖЕ читают GLB с анимациями — нужно было только не испортить байты
   * разбором ответа как текста.
   */
  glb?: ArrayBuffer;
  /** Либо сразу наш клип (если сервис знает наш формат). */
  clip?: Clip;
  error?: string;
}

/** Что отвечает `GET /health` шима — под кнопку «проверить связь». */
export interface AiHealth { ok?: boolean; backend?: string; model?: string; device?: string; error?: string }

const auth = (key: string): Record<string, string> => (key ? { authorization: `Bearer ${key}` } : {});

/** Сообщение об отказе: голый статус заставляет гадать, поэтому тянем текст сервиса. */
async function failure(res: Response): Promise<string> {
  if (res.status === 401) return 'сервис не принял ключ (401)';
  let why = '';
  try { why = ((await res.json()) as { error?: string }).error ?? ''; } catch { /* не JSON — не беда */ }
  return why ? `сервис ${res.status}: ${why}` : `сервис ответил ${res.status}`;
}

/** Жив ли сервис и что на том конце — кнопка «проверить связь». Адрес `\u2026/gen` → `\u2026/health` того же сервиса. */
export async function checkHealth(cfg: AiConfig, key: string, fetchImpl: typeof fetch = fetch): Promise<AiHealth> {
  if (!cfg.url) return { error: 'адрес сервиса не задан' };
  const url = cfg.url.replace(/\/gen\/?$/, '') + '/health';
  let res: Response;
  try { res = await fetchImpl(url, { headers: auth(key) }); }
  catch (e) { return { error: 'сеть: ' + String(e) }; }
  if (!res.ok) return { error: await failure(res) };
  try { return await res.json() as AiHealth; } catch { return { error: 'ответ не разобрался' }; }
}

/** Отправить запрос сервису. Ошибки НЕ глотаем — их надо показать автору, а не молча ничего не сделать. */
export async function requestGeneration(cfg: AiConfig, req: AiRequest, key = '', fetchImpl: typeof fetch = fetch): Promise<AiResponse> {
  if (!cfg.url) return { error: 'адрес сервиса не задан' };
  let res: Response;
  try {
    res = await fetchImpl(cfg.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(key) },
      body: JSON.stringify(req),
    });
  } catch (e) { return { error: 'сеть: ' + String(e) }; }
  if (!res.ok) return { error: await failure(res) };
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    const j = await res.json() as AiResponse;
    return j.clip || j.bvh ? j : { error: 'в ответе нет ни clip, ни bvh' };
  }
  // ДВОИЧНЫЙ ОТВЕТ НЕЛЬЗЯ ЧИТАТЬ КАК ТЕКСТ: `res.text()` прогонит GLB через UTF-8
  // и портит байты безвозвратно. Поэтому ветка по типу содержимого, а не «всё остальное — текст».
  if (/gltf-binary|octet-stream/.test(ct)) {
    const buf = await res.arrayBuffer();
    return buf.byteLength ? { glb: buf } : { error: 'пустой ответ' };
  }
  const text = await res.text();
  return text.trim() ? { bvh: text } : { error: 'пустой ответ' };
}

/** Похоже ли на BVH (чтобы не скармливать запекателю мусор и дать внятную ошибку). */
export const looksLikeBvh = (s: string): boolean => /^\s*HIERARCHY/i.test(s) && /MOTION/i.test(s);

/** Имя для сгенерированного клипа: из запроса, безопасное и не конфликтующее. */
export function generatedClipName(prompt: string, taken: readonly string[]): string {
  const base = 'ai_' + (prompt.toLowerCase().replace(/[^a-zа-я0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'clip');
  if (!taken.includes(base)) return base;
  for (let i = 2; i < 999; i++) { const n = `${base}_${i}`; if (!taken.includes(n)) return n; }
  return base + '_' + Date.now().toString(36);
}

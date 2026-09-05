/**
 * ХУК ПОД AI-ГЕНЕРАЦИЮ АНИМАЦИИ (Ф9).
 *
 * Никакой новой инфраструктуры здесь нет и не нужно: канал уже целиком собран раньше.
 *   текст-запрос → сервис генерации → BVH → `clipBaker.bakeAnimationToClip` (BVH уже поддержан
 *   загрузчиком) → наш `Clip` → библиотека → превью → принять / перегенерировать / доработать руками.
 * BVH выбран форматом обмена потому, что его отдаёт большинство text-to-motion моделей (MDM и т.п.),
 * и потому, что у нас уже есть обратный ретаргет с него.
 *
 * ВАЖНО ПРО ЧЕСТНОСТЬ: сервиса генерации у нас пока нет. Поэтому вкладка умеет две вещи —
 * сходить на УКАЗАННЫЙ адрес (когда он появится) и принять BVH из файла/буфера, чтобы весь путь
 * «ответ модели → клип в библиотеке» можно было проверить уже сейчас, без сервера.
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
  /** BVH-текст (основной путь). */
  bvh?: string;
  /** Либо сразу наш клип (если сервис знает наш формат). */
  clip?: Clip;
  error?: string;
}

/** Отправить запрос сервису. Ошибки НЕ глотаем — их надо показать автору, а не молча ничего не сделать. */
export async function requestGeneration(cfg: AiConfig, req: AiRequest, fetchImpl: typeof fetch = fetch): Promise<AiResponse> {
  if (!cfg.url) return { error: 'адрес сервиса не задан' };
  let res: Response;
  try {
    res = await fetchImpl(cfg.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    });
  } catch (e) { return { error: 'сеть: ' + String(e) }; }
  if (!res.ok) return { error: `сервис ответил ${res.status}` };
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    const j = await res.json() as AiResponse;
    return j.clip || j.bvh ? j : { error: 'в ответе нет ни clip, ни bvh' };
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

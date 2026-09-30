import type { z } from 'zod';
import { configSchemas, configCrossIssues, CONFIG_CROSS_KEYS, type ConfigKey } from '@dm/shared';
import type { LiveConfigBase } from './liveConfig.js';

/** Ответ инструментальной ручки — то, что каналу нужно от `Response`. */
export interface ChannelReply { ok: boolean; status: number; json(): Promise<unknown> }

/** Ввод-вывод канала: сеть, вкладки игры, строка статуса (`main.ts` — `devFetch`, `BroadcastChannel`, `#status`; тесты — сервер в памяти). */
export interface ChannelIo {
  /** Запрос к инструментальной ручке записи (`devFetch`: роль admin). */
  send(url: string, init: { method: 'POST' | 'DELETE'; headers?: Record<string, string>; body?: string }): Promise<ChannelReply>;
  /** Живой конфиг сервера (`GET /api/config`). */
  read(): Promise<Record<string, unknown>>;
  /** Открытым вкладкам игры — таблица, которую сервер ПРИНЯЛ (`BroadcastChannel` «dm-config»). */
  post(key: string, value: unknown): void;
  /** Строка статуса редактора. */
  status(text: string, color: string): void;
  /** Подпись таблицы для статуса. */
  label(key: string): string;
  /** Пауза перед повтором (сервер перезапускается). */
  later(fn: () => void, ms: number): void;
}

const OK = '#7fd67f', WAIT = '#9fb0c0', WARN = '#ffb020', BAD = '#ff8080';
/** Повторы запроса на рестарт сервера (`tsx watch` поднимает его за 1–2 с). */
const RETRIES = 4;
const RETRY_MS = 800;

/**
 * ЗАПИСЬ КОНФИГА ИЗ РЕДАКТОРА — «Применить на сервере», «Применить везде» (в файл), «Сбросить к дефолту» — и проверка правки до отправки.
 * Вынесено из `main.ts` (⭐ R22-08), чтобы проверять настоящими ручками сервера (`configChannel.test.ts`, фаззер `configChannel.fuzz.test.ts`).
 *
 * Три правды, и двигаются они вместе с ответом сервера, а не раньше:
 *  - рабочая копия (`data`) — то, что видит и правит хозяин;
 *  - база записи и живые таблицы (`LiveConfigBase`, C-09) — поверх чего правка: сервер отказывает (409) правке поверх чужой;
 *  - вкладки игры (`post`) — только принятое сервером.
 *
 * ⭐ R22-08: СБРОС — СПЕРВА СЕРВЕР. Раньше «Сбросить к дефолту» клал в рабочую копию встроенные дефолты таблицы и рассылал их вкладкам игры до
 * ответа, а с R21-01 сервер сброс может отклонить (422: без оверрайда связанная таблица нарушит правило поверх таблиц). Форма оставалась на
 * дефолтах, которых сервер не ставил, база — на живом оверрайде, и следующее «Применить» одного поля слало дефолты всех прочих полей поверх
 * совпавшей базы: сервер молча заменял таблицу хозяина у всех игроков (класс C-09). Теперь отказ не трогает ничего, а принятый сброс
 * перечитывает таблицу у сервера — форма показывает то, что сервер собрал (файл на ДИСКЕ, а не бандл редактора; зажим правила — вслух у сервера).
 * ⭐ R22-08: и правило поверх таблиц (D4) для правки — над ЖИВЫМИ прочими таблицами (`LiveConfigBase.value`), как проверит сервер, а не над
 * неприменёнными таблицами рабочей копии: иначе редактор отказывал правке, которую сервер примет, и пропускал ту, которой сервер откажет.
 */
export class ConfigChannel {
  constructor(private readonly data: Record<string, unknown>, private readonly live: LiveConfigBase, private readonly io: ChannelIo) {}

  /** ⭐ C-09: тело записи поверх загруженного конфига (`live.body`) — или отказ строкой статуса: живой конфиг ещё не загружен. */
  body(values: Record<string, unknown>): Record<string, unknown> | null {
    const body = this.live.body(values);
    if (!body) this.io.status('Не сохранено: конфиг сервера ещё не загружен — показаны встроенные дефолты, и таблица из них затёрла бы правки на сервере. Жду сервер…', BAD);
    return body;
  }

  /**
   * Проверить схемой НЕСКОЛЬКО ключей разом и вернуть разобранные значения. Первая ошибка — в статус и `null`: частично не отправляем ничего
   * (вкладка «Ковка → Клинки» правит `balance` и `weapon-parts` вместе, и половина правки на сервере хуже, чем никакой).
   * ⭐ D4: правила поверх нескольких таблиц (время баффа: откат из древа и вставок, отдых из баланса) — над тем, что уйдёт, поверх ЖИВОГО
   * (⭐ R22-08: прочие таблицы — как их держит сервер; до загрузки живого — рабочая копия, запись тогда закрыта). Схема одной таблицы их не
   * видит, а сервер всё равно откажет: говорим до отправки и что поправить.
   */
  validated(keys: readonly string[]): Record<string, unknown> | null {
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      const schema = configSchemas[key as ConfigKey] as z.ZodTypeAny | undefined;
      if (!schema) { this.io.status(`Нет такого конфига: ${key}`, BAD); return null; }
      const result = schema.safeParse(this.data[key]);
      if (!result.success) {
        const where = keys.length > 1 ? ` «${this.io.label(key)}»` : '';
        this.io.status(`Ошибка валидации${where}: ` + result.error.issues[0]?.message + ' @ ' + result.error.issues[0]?.path.join('.'), BAD);
        return null;
      }
      out[key] = result.data;
    }
    if (keys.some((k) => (CONFIG_CROSS_KEYS as readonly string[]).includes(k))) {
      const view = (k: ConfigKey): unknown => {
        if (k in out) return out[k];
        const r = configSchemas[k].safeParse(this.live.loaded ? this.live.value(k) : this.data[k]);
        return r.success ? r.data : undefined;
      };
      const issues = configCrossIssues(view);
      if (issues.length) {
        this.io.status(`Ошибка валидации «${this.io.label(issues[0]!.key)}»: ${issues[0]!.msg}${issues.length > 1 ? ` (и ещё ${issues.length - 1})` : ''}`, BAD);
        return null;
      }
    }
    return out;
  }

  /**
   * «Применить на сервере»: оверрайд в БД сервера (`/api/dev/config`) — действует сразу и переживает рестарт, в файлы не попадает. Игра
   * серверно-авторитетна: правку надо доставить СЕРВЕРУ; вкладкам игры — после его ответа (C-09). `true` — сервер принял.
   */
  async push(values: Record<string, unknown>, onOk?: () => void): Promise<boolean> {
    return this.write('/api/dev/config', values, 'Сохранение на сервере (БД, для тестов)…',
      'Сохранено на сервере (переживёт рестарт) и применено к игре. Balance — сразу; статы монстров/лут — со следующего этажа.', onOk);
  }

  /** «Применить везде»: уже проверенные значения — в файлы `data/*.json` (git, деплой) и оверрайдом на сервер (`/api/dev/config-file`). */
  async toFile(values: Record<string, unknown>, onOk?: () => void): Promise<boolean> {
    return this.write('/api/dev/config-file', values, 'Запись в файл…',
      'Записано в ФАЙЛ data/*.json (попадёт в git/деплой) и применено к игре. Не забудь закоммитить.', onOk);
  }

  private async write(url: string, values: Record<string, unknown>, pending: string, okMsg: string, onOk?: () => void): Promise<boolean> {
    const body = this.body(values);   // C-09: поверх загруженного конфига — или никак
    if (!body) return false;
    this.io.status(pending, WAIT);
    const reply = await this.send(() => this.io.send(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
    if (!reply) return false;
    this.live.saved(reply.rev, values);   // база и живые таблицы — принятое (ответ несёт ревизии)
    this.io.status(okMsg, OK);
    for (const [key, value] of Object.entries(values)) this.io.post(key, value);
    onOk?.();
    return true;
  }

  /**
   * «Сбросить к дефолту»: снять оверрайд таблицы на сервере (`DELETE /api/dev/config/:key`, переживёт рестарт). ⭐ R22-08: рабочая копия, база
   * записи и вкладки игры — только ПОСЛЕ ответа и таблицей, которую сервер собрал (перечитана `GET /api/config`). Отказ (422 — правило поверх
   * таблиц, 409), нет связи, не вышло перечитать — не трогается ничего: база прежняя, и правка поверх старой копии получит 409, а не отменит
   * сброс молча. `onDone` — таблица перечитана (перерисовать). `true` — сброшено и перечитано.
   */
  async reset(key: string, onDone?: () => void): Promise<boolean> {
    this.io.status('Сброс на сервере…', WAIT);
    const reply = await this.send(() => this.io.send(`/api/dev/config/${encodeURIComponent(key)}`, { method: 'DELETE' }));
    if (!reply) return false;
    let snapshot: Record<string, unknown>;
    try {
      snapshot = await this.io.read();
    } catch {
      this.io.status('Сброшено на сервере, но таблица не перечитана (сервер перезапускается?) — обнови страницу редактора: правка поверх старой копии получит отказ (409).', WARN);
      return false;
    }
    if (!Object.prototype.hasOwnProperty.call(snapshot, key)) {
      this.io.status(`Сброшено на сервере, но таблицы «${this.io.label(key)}» в его конфиге нет — обнови страницу редактора.`, WARN);
      return false;
    }
    const value = snapshot[key];
    this.live.adopt(key, value);
    this.data[key] = structuredClone(value);
    this.io.post(key, value);
    onDone?.();
    this.io.status('Сброшено к дефолту на сервере — показана таблица, которую собрал сервер.', OK);
    return true;
  }

  /**
   * Запрос на dev-ручку конфига С АВТО-ПОВТОРОМ. Зачем: dev-сервер крутится под `tsx watch` и перезапускается на каждую правку кода (~1–2 c
   * недоступен) — клик может попасть ровно в это окно. Сетевую ошибку/5xx/404 (сервер поднимается) повторяем; 422 (данные не прошли валидацию)
   * — не повторяем, это реальный отказ. ⭐ C-09: 409 — тоже отказ без повтора: таблица на сервере уже не та, поверх которой правка (сохранили в
   * другой вкладке, инструментом, с другой машины), и запись затёрла бы чужую правку. Принято — тело ответа (`rev`), отказ — `null` (причина в статусе).
   */
  private async send(req: () => Promise<ChannelReply>): Promise<{ rev?: unknown } | null> {
    for (let attempt = 0; ; attempt++) {
      let r: ChannelReply | null = null;
      try {
        r = await req();
      } catch { /* нет связи — повтор ниже */ }
      if (r?.ok) {
        const j = await r.json().then((x) => x as { rev?: unknown } | null, () => null);
        return j ?? {};
      }
      if (r?.status === 422) {
        const e = await r.json().then((x) => x as { error?: string } | null, () => null);
        this.io.status(e ? `Сервер отклонил конфиг: ${e.error ?? '422'}` : 'Сервер отклонил конфиг (422).', WARN);
        return null;
      }
      if (r?.status === 409) {
        const e = await r.json().then((x) => x as { conflicts?: string[]; disk?: boolean; error?: string } | null, () => null);
        // ⭐ R22-02: конфликт с ФАЙЛОМ на диске («в файл»: файл не принят сервером — битый, не взят наблюдателем) — причина от сервера.
        if (e?.disk && e.error) this.io.status(e.error, BAD);
        else {
          const keys = e?.conflicts;
          this.io.status(`Не сохранено: на сервере ${keys?.length ? `«${keys.map((k) => this.io.label(k)).join('», «')}»` : 'эта таблица'} уже не та, что загружена здесь (сохранили в другой вкладке, инструментом или с другой машины) — правка затёрла бы её. Обнови страницу редактора и повтори правку.`, BAD);
        }
        return null;
      }
      // 404/5xx/нет связи — вероятно рестарт, повторяем.
      if (attempt >= RETRIES) {
        this.io.status('Сервер недоступен — не сохранено. Запусти `npm run dev` и повтори.', WARN);
        return null;
      }
      this.io.status(`Сервер перезапускается… повтор (${attempt + 1}/${RETRIES})`, WAIT);
      await new Promise<void>((resolve) => this.io.later(resolve, RETRY_MS));
    }
  }
}

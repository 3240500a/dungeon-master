import type { ServerFrame } from '@dm/shared';

/** Ответ сервера на команду города (кадр `cmdResult`, D3). */
export type CmdReply = Extract<ServerFrame, { t: 'cmdResult' }>;

/**
 * Сколько ждём ответа на команду. Сервер отвечает на КАЖДУЮ обработанную команду, так что тишина
 * означает обрыв связи или смерть сокета, а не «думает». Ковка — это три похода в базу, в норме
 * десятки миллисекунд; восемь секунд — с большим запасом на медленную базу под нагрузкой.
 */
export const CMD_REPLY_MS = 8000;
/** R5-18: сколько ждавших без ответа помнят о своём позднем ответе. */
const LATE_KEEP = 16;

/**
 * ⭐ ОЖИДАНИЕ ОТВЕТА ПО НОМЕРУ КОМАНДЫ. Клиент нумерует команды (Ф2.5), сервер возвращает номер в
 * `cmdResult` — по нему окно узнаёт, чем кончилась ИМЕННО ЕГО заявка.
 *
 * `null` вместо ответа — «неизвестно»: не дошёл ответ (обрыв, таймаут) или ждущего сменили тем же
 * номером. ⚠ Неизвестно — НЕ отказ: команда могла и выполниться. Истина — сейв, он приходит сам, а
 * повторить ковку безопасно только ТЕМ ЖЕ ключом заявки (`nonce`): сервер ответит прежней вещью.
 *
 * Чистый класс, без DOM и сети: его гоняют node-тесты с поддельными часами.
 */
export class CmdReplies {
  private readonly waiting = new Map<number, { resolve: (r: CmdReply | null) => void; timer: ReturnType<typeof setTimeout> }>();
  /**
   * ⭐ R5-18: ждавшие, чей таймаут истёк, — номер → кому отдать ПОЗДНИЙ ответ (`onLate`). Сервер при медленной базе
   * отвечает и через 8 с, а окно, получившее «неизвестно», итога не узнавало: верстак повторял тот же номер, и дедуп
   * сервера отвечал эхом давно известного отказа — повтор не исполнялся. Помним немного: старейший вытесняется.
   */
  private readonly late = new Map<number, (r: CmdReply) => void>();

  /**
   * Ждать ответа на команду `id`. Ждущего регистрируют ДО отправки: мост редактора отвечает синхронно. `onLate` — ответ,
   * пришедший ПОСЛЕ таймаута (ждущий уже получил `null`): итог стал известен (R5-18).
   */
  wait(id: number, ms = CMD_REPLY_MS, onLate?: (r: CmdReply) => void): Promise<CmdReply | null> {
    this.finish(id, null); // тот же номер дважды не ждут — прежний ждущий получает «неизвестно»
    this.late.delete(id);  // ответ на повтор тем же номером достаётся новому ждущему
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.finish(id, null);
        if (!onLate) return;
        this.late.set(id, onLate);
        for (const old of this.late.keys()) { if (this.late.size <= LATE_KEEP) break; this.late.delete(old); }
      }, Math.max(0, ms));
      this.waiting.set(id, { resolve, timer });
    });
  }

  /**
   * Пришёл `cmdResult`. true — нашёлся ждущий. Кадр без номера или с чужим номером — не наш:
   * на команды без ожидания (купить, надеть из сумки) сервер тоже отвечает, их просто никто не ждёт.
   * Поздний ответ (R5-18) уходит в `onLate` — но false: ждущего нет, и отказ App пишет в лог, как любой без ждущего.
   */
  settle(r: CmdReply): boolean {
    if (typeof r?.id !== 'number') return false;
    if (!this.waiting.has(r.id)) {
      const cb = this.late.get(r.id);
      this.late.delete(r.id);
      cb?.(r);
      return false;
    }
    this.finish(r.id, r);
    return true;
  }

  /** Отпустить всех ждущих с «неизвестно» (смена соединения, выход из мира). Поздних ответов по старому сокету не будет. */
  dropAll(): void {
    for (const id of [...this.waiting.keys()]) this.finish(id, null);
    this.late.clear();
  }

  /** Сколько команд ждут ответа — для тестов и отладки. */
  get pending(): number { return this.waiting.size; }

  private finish(id: number, r: CmdReply | null): void {
    const w = this.waiting.get(id);
    if (!w) return;
    this.waiting.delete(id);
    clearTimeout(w.timer);
    w.resolve(r);
  }
}

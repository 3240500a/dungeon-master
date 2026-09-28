import { ROOM_CODE_LEN } from '@dm/shared';
import type { EntryView, JoinOpts } from '../net/entryFlow.js';

/**
 * ЭКРАНЫ ВХОДА В МИР — одни на 2D и веб-3D: плашка «Подключение к серверу…», лобби (Соло / Создать комнату / Войти по
 * коду) и «Незавершённое прохождение» (Продолжить / Забросить). Когда какой показывать, решает `net/entryFlow.ts`;
 * здесь только DOM. Раньше у каждого клиента была своя копия разметки — и своя копия логики, которая разошлась (L2).
 *
 * Экран на весь экран поверх игры, один за раз: показ нового снимает прежний. ⚠ `pointer-events:auto` — сам: корень
 * DOM веб-3D мышь не ловит (`pointer-events:none`, чтобы клики шли в канвас), и без этого кнопки были бы мёртвыми.
 *
 * `root` — куда вешать (зовётся на каждый показ); `onShow` — крючок клиента на показ любого экрана (прячет лог игры и
 * миникарту: экраны входа — не игра).
 */
const CENTER = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.8);z-index:90;pointer-events:auto';
const CARD = 'background:#171b24;border:1px solid #2b323f;border-radius:10px;color:#e6ddc9;text-align:center';
const STATUS = '<div class="status" style="margin-top:10px;font-size:12px;color:#8f897c"></div>';

/** Буквы русской раскладки на клавишах A…Z (ЙЦУКЕН над QWERTY): Ф — это A, И — B, … Я — Z. */
const RU_KEYS = 'ФИСВУАПРШОЛДЬТЩЗЙКЫЕГМЦЧНЯ';

/**
 * ⭐ R4-12: КОД КОМНАТЫ ИЗ НАБРАННОГО — заглавными, без пробелов и разделителей, не длиннее кода (`ROOM_CODE_LEN`).
 * Набранное на русской раскладке — те же клавиши (`ruLayout`): «ф7л3…» — это «A7K3…», а не «Комната не найдена».
 */
export function roomCodeOf(raw: string, ruLayout = true): string {
  let out = '';
  for (const ch of raw.toUpperCase()) {
    const ru = ruLayout ? RU_KEYS.indexOf(ch) : -1;
    const c = ru >= 0 ? String.fromCharCode(65 + ru) : ch;
    if (/^[0-9A-Z]$/.test(c)) out += c;
  }
  return out.slice(0, ROOM_CODE_LEN);
}

/**
 * Код из ВСТАВЛЕННОГО: выделение мышью с плашки «Комната: …» хватает пробел или всю строку. Слово ровно длины кода —
 * оно и есть код; иначе («A7K3-F9XY») — знаки подряд. Кириллицу вставки не переводим: это подпись, а не раскладка.
 */
export function pastedRoomCode(text: string): string {
  const whole = new RegExp(`(?:^|[^0-9A-Z])([0-9A-Z]{${ROOM_CODE_LEN}})(?![0-9A-Z])`).exec(text.toUpperCase());
  return whole ? whole[1]! : roomCodeOf(text, false);
}

export function entryScreens(root: () => HTMLElement, onShow?: () => void): EntryView {
  let box: HTMLElement | undefined;
  let kind: 'connecting' | 'lobby' | 'resume' | undefined;
  let statusEl: HTMLElement | undefined;
  const hide = (): void => { box?.remove(); box = undefined; kind = undefined; statusEl = undefined; };
  const open = (k: NonNullable<typeof kind>, html: string): HTMLElement => {
    hide();
    onShow?.();
    const b = document.createElement('div');
    b.style.cssText = CENTER;
    b.innerHTML = html;
    root().appendChild(b);
    box = b; kind = k;
    statusEl = b.querySelector('.status') as HTMLElement;
    return b;
  };
  const on = (b: HTMLElement, sel: string, f: () => void): void => { b.querySelector(sel)!.addEventListener('click', f); };
  return {
    showConnecting() {
      if (kind === 'connecting') { onShow?.(); return; }
      open('connecting', `<div style="${CARD};padding:24px 30px">
        <div style="font-size:16px">Подключение к серверу…</div>
        <div class="status" style="margin-top:8px;font-size:12px;color:#8f897c"></div></div>`);
    },
    showLobby(go: (o: JoinOpts) => void, roomCode?: string) {
      // ⭐ C-05: код, куда «Продолжить» не пустило (пати забега), — в поле: «Войти» ведёт к ней, как только там будет место.
      const prefill = (b: HTMLElement): void => { if (roomCode) (b.querySelector('.code') as HTMLInputElement).value = roomCodeOf(roomCode, false); };
      // Уже на экране — не пересоздаём: набранный код комнаты не должен пропадать.
      if (kind === 'lobby') { onShow?.(); if (box) prefill(box); return; }
      const b = open('lobby', `<div style="${CARD};padding:24px;min-width:280px">
        <div style="font-size:18px;margin-bottom:14px">Кооп</div>
        <button data-a="solo" style="display:block;width:100%;margin:6px 0;padding:8px;background:#1e2a3a;color:#cfe0f2;border:1px solid #6f9bcf;border-radius:6px;cursor:pointer">Соло (комната на 1)</button>
        <button data-a="host" style="display:block;width:100%;margin:6px 0;padding:8px;background:#22301c;color:#cfe0c0;border:1px solid #8aa84a;border-radius:6px;cursor:pointer">Создать комнату</button>
        <div style="display:flex;gap:6px;margin-top:6px"><input class="code" placeholder="КОД" maxlength="${ROOM_CODE_LEN}" style="flex:1;text-transform:uppercase;padding:8px;background:#0f131a;color:#e6ddc9;border:1px solid #2b323f;border-radius:6px"><button data-a="join" style="padding:8px 12px;background:#3a2c15;color:#f0d9a8;border:1px solid #e39a3c;border-radius:6px;cursor:pointer">Войти</button></div>
        ${STATUS}</div>`);
      prefill(b);
      on(b, '[data-a="solo"]', () => go({ fresh: true }));
      on(b, '[data-a="host"]', () => go({ fresh: true }));
      // ⭐ R4-12: код доходит до сервера ЦЕЛИКОМ. Браузер режет вставку по `maxlength` раньше любого `trim`: « A7K3F9XY»
      // из выделения на плашке становился « A7K3F9X» — «Комната не найдена». Вставку поле разбирает само, набор — чистит
      // на лету (разделитель не съедает место под знак), а неполный код не уходит вовсе: промах платит лимит адреса (R4-18).
      const field = b.querySelector('.code') as HTMLInputElement;
      field.addEventListener('paste', (e) => {
        const text = e.clipboardData?.getData('text');
        if (text == null) return;
        e.preventDefault();
        field.value = pastedRoomCode(text);
      });
      field.addEventListener('input', () => {
        const code = roomCodeOf(field.value);
        if (code !== field.value.toUpperCase()) field.value = code;   // только регистр — не трогаем: курсор не прыгает
      });
      on(b, '[data-a="join"]', () => {
        const code = roomCodeOf(field.value);
        if (code.length === ROOM_CODE_LEN) { go({ roomCode: code }); return; }
        if (statusEl) statusEl.textContent = `Код комнаты — ${ROOM_CODE_LEN} знаков, как на плашке у хозяина комнаты`;
      });
    },
    showResume(roomCode: string, depth: number, act: { resume: () => void; abandon: () => void }, dead = false) {
      const where = depth > 0 ? `этаж ${depth}` : 'подземелье';
      // Кода комнаты нет, когда забег поднят из сейва (грейс-комнаты уже нет) — тогда и «комната» не пишем.
      const room = roomCode ? `, комната ${roomCode}` : '';
      // ⭐ R16 C-09: погибший в этом забеге (штраф взят, `runStatus.dead`) — «Забросить» ему ничего не стоит (V1), а «Продолжить» вернёт его
      // мёртвым ждать пати (K1). Раньше и ему — «штраф золота и части предметов»: бесплатный выход выглядел платным.
      const ask = dead ? 'Герой в этом забеге погиб — штраф за смерть уже взят.' : 'Продолжить забег или забросить?';
      const note = dead
        ? '«Продолжить» — вернуться к пати мёртвым и ждать её (пати уже нет — в город, забег окончен). «Забросить» — без штрафа: он уже взят за гибель в этом забеге.'
        : '«Забросить» — персонаж считается погибшим (штраф золота и части предметов).';
      const b = open('resume', `<div style="${CARD};padding:24px;min-width:300px">
        <div style="font-size:18px;margin-bottom:8px">Незавершённое прохождение</div>
        <div style="font-size:13px;color:#a8a090;margin-bottom:16px">Забег не завершён (${where}${room}). ${ask}</div>
        <button data-a="resume" style="display:block;width:100%;margin:6px 0;padding:9px;background:#22301c;color:#cfe0c0;border:1px solid #8aa84a;border-radius:6px;cursor:pointer">Продолжить</button>
        <button data-a="abandon" style="display:block;width:100%;margin:6px 0;padding:9px;background:#3a1c1c;color:#e6bcae;border:1px solid #c85a48;border-radius:6px;cursor:pointer">Забросить прохождение</button>
        <div style="font-size:11px;color:#8f7a72;margin-top:6px">${note}</div>
        ${STATUS}</div>`);
      on(b, '[data-a="resume"]', act.resume);
      on(b, '[data-a="abandon"]', act.abandon);
    },
    hide,
    setStatus(text: string) { if (statusEl) statusEl.textContent = text; },
  };
}

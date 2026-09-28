import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ROOM_CODE_LEN } from '@dm/shared';
import { entryScreens, roomCodeOf, pastedRoomCode } from './entryScreens.js';
import type { JoinOpts } from '../net/entryFlow.js';

/**
 * ⭐ R4-12: ВХОД К ДРУГУ ПО КОДУ — КОД ДОХОДИТ ДО СЕРВЕРА ЦЕЛИКОМ.
 *
 * Хозяин видит «Комната: A7K3F9XY», друг копирует код и вставляет в поле лобби. Поле обрезало его по `maxlength`: было 4
 * при коде из 5 знаков — «Комната не найдена» у каждого, кто входил по коду, в обоих веб-клиентах. Длину выровнял R4-18
 * (`ROOM_CODE_LEN`), но вставка по-прежнему резалась: выделение мышью с плашки хватает пробел или «Комната: », и браузер
 * режет ВСТАВЛЕННОЕ до `maxlength` раньше, чем код увидит `trim` — пропадал последний знак. Здесь браузер эмулирован
 * ровно в этом: вставка и набор режутся по `maxlength` из разметки, если поле само их не разобрало.
 *
 * DOM-окружения в проекте нет (тесты идут в node) — заглушка ровно тех свойств, которыми пользуются экраны.
 */
type Ev = { clipboardData?: { getData: (k: string) => string }; preventDefault: () => void; prevented?: boolean };
class El {
  children: El[] = []; style: Record<string, string> = {}; textContent = ''; parent: El | null = null; value = '';
  private sel = new Map<string, El>();
  private html = '';
  private on = new Map<string, ((e: Ev) => void)[]>();
  /** `maxlength` поля — из разметки родителя, как у браузера. */
  maxLength = Infinity;
  constructor(public tag: string) { }
  set innerHTML(v: string) { this.children = []; this.sel.clear(); this.html = v; }
  get innerHTML(): string { return this.html; }
  addEventListener(t: string, f: (e: Ev) => void): void { this.on.set(t, [...(this.on.get(t) ?? []), f]); }
  append(...c: El[]): void { for (const x of c) { x.parent = this; this.children.push(x); } }
  appendChild(c: El): El { this.append(c); return c; }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; }
  private fire(t: string, e: Ev): void { for (const f of this.on.get(t) ?? []) f(e); }
  click(): void { this.fire('click', { preventDefault: () => { } }); }
  /** Набор с клавиатуры: знак за знаком, сверх `maxlength` браузер не пускает; после каждого — `input`. */
  type(text: string): void {
    for (const ch of text) {
      if (this.value.length >= this.maxLength) continue;
      this.value += ch;
      this.fire('input', { preventDefault: () => { } });
    }
  }
  /** Вставка: поле не разобрало её само (`preventDefault`) — браузер вставляет, обрезав до `maxlength`. */
  paste(text: string): void {
    const e: Ev = { clipboardData: { getData: () => text }, preventDefault: () => { e.prevented = true; } };
    this.fire('paste', e);
    if (e.prevented) return;
    this.value = (this.value + text).slice(0, this.maxLength);
    this.fire('input', { preventDefault: () => { } });
  }
  querySelector(s: string): El {
    let e = this.sel.get(s);
    if (!e) {
      e = new El('q'); e.parent = this; this.sel.set(s, e);
      const m = new RegExp(`class="${s.replace(/^\./, '')}"[^>]*maxlength="(\\d+)"`).exec(this.html);
      if (m) e.maxLength = Number(m[1]);
    }
    return e;
  }
}

/** Код, какой выдаёт нода: буква ноды и знаки алфавита без двусмысленных (R4-18). */
const CODE = 'A7K3F9XY';

describe('⭐ R4-12: код комнаты из поля лобби — целиком', () => {
  const G = globalThis as unknown as { document?: unknown };
  beforeEach(() => { G.document = { createElement: (t: string) => new El(t), getElementById: () => null, body: new El('body') }; });
  afterEach(() => { delete G.document; });

  function lobby() {
    const root = new El('ui-root');
    const gone: JoinOpts[] = [];
    entryScreens(() => root as unknown as HTMLElement).showLobby((o) => gone.push(o));
    const box = root.children.at(-1)!;
    const field = box.querySelector('.code');
    return { gone, field, join: () => box.querySelector('[data-a="join"]').click(), status: () => box.querySelector('.status').textContent };
  }

  it('код той же длины, что выдаёт нода (без него проверка ниже ничего не значит)', () => {
    expect(CODE).toHaveLength(ROOM_CODE_LEN);
    expect(lobby().field.maxLength, 'поле вмещает код целиком').toBeGreaterThanOrEqual(ROOM_CODE_LEN);
  });

  it('набран строчными — уходит весь код заглавными', () => {
    const l = lobby();
    l.field.type(CODE.toLowerCase());
    l.join();
    expect(l.gone).toEqual([{ roomCode: CODE }]);
  });

  it('⭐ вставлен с пробелом из выделения на плашке — было: браузер резал вставку до maxlength, пропадал последний знак', () => {
    const l = lobby();
    l.field.paste(` ${CODE}`);
    l.join();
    expect(l.gone).toEqual([{ roomCode: CODE }]);
  });

  it('⭐ вставлена вся строка плашки «Комната: …» — из неё берётся код', () => {
    const l = lobby();
    l.field.paste(`Комната: ${CODE}\n`);
    l.join();
    expect(l.gone).toEqual([{ roomCode: CODE }]);
  });

  it('вставлен с разделителями (как диктуют: «A7K3-F9XY») — разделители сняты, код целиком', () => {
    const l = lobby();
    l.field.paste('a7k3-f9xy');
    l.join();
    expect(l.gone).toEqual([{ roomCode: CODE }]);
  });

  it('набран на русской раскладке — те же клавиши, тот же код', () => {
    const l = lobby();
    l.field.type('ф7л3а9чн');   // Ф=A, Л=K, А=F, Ч=X, Н=Y на тех же клавишах
    l.join();
    expect(l.gone).toEqual([{ roomCode: CODE }]);
  });

  it('код короче — на сервер не уходит (промах платит лимит адреса, R4-18), а в строке состояния — почему', () => {
    const l = lobby();
    l.field.type(CODE.slice(0, -1));
    l.join();
    expect(l.gone).toEqual([]);
    expect(l.status()).toContain(String(ROOM_CODE_LEN));
    l.field.value = '';
    l.join();
    expect(l.gone, 'пустое поле — тоже никуда').toEqual([]);
  });

  it('разбор кода — чистые функции: лишнее снято, длина не больше кода', () => {
    expect(roomCodeOf(` ${CODE.toLowerCase()} `)).toBe(CODE);
    expect(roomCodeOf(`${CODE}ZZZ`)).toBe(CODE);
    expect(pastedRoomCode(`Комната: ${CODE} (2 игрока)`)).toBe(CODE);
    expect(pastedRoomCode('A7K3 F9XY')).toBe(CODE);
  });
});

describe('⭐ C-05: лобби с кодом пати забега, куда «Продолжить» не пустило', () => {
  const G = globalThis as unknown as { document?: unknown };
  beforeEach(() => { G.document = { createElement: (t: string) => new El(t), getElementById: () => null, body: new El('body') }; });
  afterEach(() => { delete G.document; });

  it('код держателя — уже в поле: «Войти» уходит с ним; лобби уже на экране — код вписан, экран не пересоздан', () => {
    const root = new El('ui-root');
    const gone: JoinOpts[] = [];
    const view = entryScreens(() => root as unknown as HTMLElement);
    view.showLobby((o) => gone.push(o));
    const box = root.children.at(-1)!;
    expect(box.querySelector('.code').value).toBe('');
    view.showLobby((o) => gone.push(o), CODE.toLowerCase());
    expect(root.children.at(-1), 'тот же экран').toBe(box);
    expect(box.querySelector('.code').value).toBe(CODE);
    box.querySelector('[data-a="join"]').click();
    expect(gone).toEqual([{ roomCode: CODE }]);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardTyping, isTextEntry } from './typingGuard.js';
import { entryScreens } from './entryScreens.js';
import { KeyNode, phaserKeyboard } from '../net/phaserKeyboardHarness.js';

/**
 * ⭐ R6-03: НАБОР В ПОЛЕ ВВОДА — НЕ ИГРОВЫЕ КЛАВИШИ (2D).
 *
 * Phaser слушает клавиатуру на `window` и глотает (`preventDefault`) каждую перехваченную клавишу без модификатора, не
 * глядя, где фокус; перехват — на всю страницу и переживает сцену. Драйвер 2D перехватывал W/A/S/D/E/Q и пробел, сцена —
 * E: в код комнаты в лобби переподключения не набиралась «a» (а код каждой комнаты одиночного процесса начинается с A —
 * «Код комнаты — 8 знаков»), после ухода на вход (R4-22) в ник и пароль не набирались w/a/s/d/q/e и пробел — «swordfish»
 * не ввести до F5. Сторож (`guardTyping(document)`) обрывает нажатие в поле на `document`: до слушателя Phaser на
 * `window` оно не доходит — ни перехват, ни игровые клавиши его не видят.
 *
 * Клавиатура Phaser здесь настоящая (`phaserKeyboardHarness`), DOM — заглушка со всплытием.
 */
/** Элемент разметки экранов входа: узел со всплытием + ровно то, чем пользуются экраны. */
class El extends KeyNode {
  children: El[] = []; style: Record<string, string> = {}; textContent = ''; value = '';
  private sel = new Map<string, El>();
  private html = '';
  set innerHTML(v: string) { this.children = []; this.sel.clear(); this.html = v; }
  get innerHTML(): string { return this.html; }
  append(...c: El[]): void { for (const x of c) { x.parent = this; this.children.push(x); } }
  appendChild(c: El): El { this.append(c); return c; }
  remove(): void { const p = this.parent as El | null; if (p) p.children = p.children.filter((x) => x !== this); this.parent = null; }
  /** Элемент разметки по селектору: поле кода — `INPUT`, кнопки — `BUTTON`. */
  querySelector(s: string): El {
    let e = this.sel.get(s);
    if (!e) { e = new El(s === '.code' ? 'INPUT' : s.startsWith('[data-a') ? 'BUTTON' : 'DIV'); e.parent = this; this.sel.set(s, e); }
    return e;
  }
}

/** Знак → физическая клавиша (`keyCode`): буквы и цифры — свои коды, пробел — 32. */
const codeOf = (ch: string): number => (ch === ' ' ? 32 : ch.toUpperCase().charCodeAt(0));

describe('⭐ R6-03: набор в поле ввода не глотается перехватом клавиш Phaser', () => {
  const G = globalThis as unknown as { document?: unknown };
  let win: KeyNode, doc: KeyNode, body: El;
  beforeEach(() => {
    win = new KeyNode('#window');
    doc = win.child('#document');
    body = new El('BODY'); body.parent = doc;
    G.document = { createElement: (t: string) => new El(t.toUpperCase()), getElementById: () => null, body };
  });
  afterEach(() => { delete G.document; });

  /** Страница 2D: клавиатура Phaser с перехватом, как его ставил драйвер (A, E, пробел…), канвас и лобби с полем кода. */
  function page(guard = true) {
    const kb = phaserKeyboard(win);
    kb.manager.addCapture([87, 65, 83, 68, 69, 81, 32]);   // W A S D E Q пробел — было в `NetDriver`/`OnlineScene`
    for (const c of [65, 69, 32]) kb.plugin.addKey(c, false);   // игра следит за A, E и пробелом
    const off = guard ? guardTyping(doc as unknown as EventTarget) : () => undefined;
    const canvas = body.child('CANVAS');
    const root = new El('DIV'); body.append(root);
    entryScreens(() => root as unknown as HTMLElement).showLobby(() => undefined);
    const field = root.children.at(-1)!.querySelector('.code');
    /** Набор строки в узел: что вставил бы браузер (нажатия, которые никто не отменил). */
    const type = (target: KeyNode, text: string): string => {
      let out = '';
      for (const ch of text) {
        const e = kb.press(target, codeOf(ch), ch);
        if (!e.defaultPrevented) out += ch;
        kb.press(target, codeOf(ch), ch, 'keyup');
      }
      return out;
    };
    return { kb, off, canvas, field, type };
  }

  it('стенд честный: без сторожа «a» и «e» в поле кода глотаются — ровно то, что видел игрок', () => {
    const p = page(false);
    expect(p.type(p.field, 'a7k3f9xy')).toBe('7k3f9xy');
    expect(p.type(p.field, 'e')).toBe('');
  });

  it('⭐ код комнаты «a7k3f9xy» (и «e») набирается в поле лобби целиком — хотя A и E перехвачены', () => {
    const p = page();
    expect(p.type(p.field, 'a7k3f9xy'), 'было: «7k3f9xy» → «Код комнаты — 8 знаков»').toBe('a7k3f9xy');
    expect(p.type(p.field, 'e'), 'было: E глотался уже на первом лобби страницы').toBe('e');
  });

  it('⭐ игра нажатий в поле не видит: [E] у NPC и WASD не срабатывают от набора кода', () => {
    const p = page();
    p.kb.press(p.field, 69, 'e');
    p.kb.press(p.field, 65, 'a');
    expect(p.kb.isDown(69), 'E, набранная в поле, — не «[E] Кузница» под лобби').toBe(false);
    expect(p.kb.isDown(65)).toBe(false);
  });

  it('пароль с пробелом и ник из w/a/s/d — в любом текстовом поле (вход, имя героя), в textarea и contenteditable', () => {
    const p = page();
    const pass = body.child('INPUT');
    expect(p.type(pass, 'swordfish qed'), 'было: «orfih»').toBe('swordfish qed');
    expect(p.type(body.child('TEXTAREA'), 'wasd')).toBe('wasd');
    const editable = body.child('DIV'); editable.isContentEditable = true;
    expect(p.type(editable, 'wasd e')).toBe('wasd e');
  });

  it('вне поля игра как была: перехваченное глотается (пробел не жмёт кнопку в фокусе), клавиша видна игре', () => {
    const p = page();
    const e = p.kb.press(p.canvas, 32, ' ');
    expect(e.defaultPrevented, 'рывок пробелом не «нажимает» кнопку, оставшуюся в фокусе').toBe(true);
    expect(p.kb.isDown(32)).toBe(true);
    const onButton = p.kb.press(body.child('BUTTON'), 32, ' ');
    expect(onButton.defaultPrevented, 'кнопка — не поле ввода').toBe(true);
  });

  it('отпускание не обрывается: клавиша, зажатая в игре и отпущенная уже в поле, в игре отпущена (не залипает)', () => {
    const p = page();
    p.kb.press(p.canvas, 65, 'a');
    expect(p.kb.isDown(65)).toBe(true);
    p.kb.press(p.field, 65, 'a', 'keyup');
    expect(p.kb.isDown(65), 'иначе герой шёл бы влево, пока A не нажмут ещё раз').toBe(false);
  });

  it('сторож снимается; что поле ввода — решает `isTextEntry`', () => {
    const p = page();
    p.off();
    expect(p.type(p.field, 'a'), 'снят — снова как без него').toBe('');
    expect(isTextEntry(new KeyNode('INPUT') as unknown as EventTarget)).toBe(true);
    expect(isTextEntry(new KeyNode('CANVAS') as unknown as EventTarget)).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });

  it('⭐ R11-16: поле — то, куда НАБИРАЮТ: галка, ползунок, кнопка, выпадающий список — не поле (игровые клавиши идут дальше)', () => {
    const input = (type: string): EventTarget => Object.assign(new KeyNode('INPUT'), { type }) as unknown as EventTarget;
    for (const t of ['text', 'password', 'search', 'email', 'number', 'url', 'tel', '']) expect(isTextEntry(input(t)), t || 'без типа').toBe(true);
    for (const t of ['checkbox', 'range', 'radio', 'button', 'submit', 'color', 'file']) {
      expect(isTextEntry(input(t)), `${t}: было — любой INPUT считался полем, и галка настроек глотала WASD`).toBe(false);
    }
    expect(isTextEntry(new KeyNode('SELECT') as unknown as EventTarget)).toBe(false);
    const p = page();
    const cb = Object.assign(body.child('INPUT'), { type: 'checkbox' });
    p.kb.press(cb, 65, 'a');
    expect(p.kb.isDown(65), 'галка в фокусе — клавиша игре видна').toBe(true);
  });

  it('2D ставит сторожа на `document` при старте страницы', () => {
    const MAIN = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'main.ts'), 'utf8');
    expect(MAIN).toMatch(/guardTyping\(document\);/);
  });
});

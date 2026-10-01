/**
 * ПОДДЕЛЬНЫЙ DOM ДЛЯ ЭТАЛОНОВ UNITY (U6 review): настоящие окна веба (`characterPanel`, `masterPanel`, `forgeBench`, `compareTable`,
 * `renderSkillTree`, `mountHud3d`) рисуются в node без браузера — и эталон снимается с их ВЫВОДА, а не с копии их правил. Ровно то, что
 * эти окна трогают: элементы и SVG, `style.cssText`, текст и `innerHTML`, слушатели (подсказку `attachTooltip` снимаем, послав `mouseenter`
 * и прочитав `innerHTML` последнего изменённого элемента — общей подсказки kit). Не `*.test.ts` — vitest его не гоняет, им пользуются
 * генераторы эталонов (`unityStatsGolden.gen.test.ts`).
 */

type Listener = (e: unknown) => void;

/** `a-b` → `aB` (как `CSSStyleDeclaration`). */
const camel = (k: string): string => k.trim().replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());

export class FakeStyle {
  [k: string]: unknown;
  get cssText(): string { return ''; }
  set cssText(css: string) {
    for (const k of Object.keys(this)) delete this[k];
    for (const part of css.split(';')) {
      const at = part.indexOf(':');
      if (at > 0) this[camel(part.slice(0, at))] = part.slice(at + 1).trim();
    }
  }
}

export class FakeText {
  readonly nodeType = 3;
  parentElement: FakeEl | null = null;
  constructor(public data: string) {}
  get textContent(): string { return this.data; }
  set textContent(v: string) { this.data = v; }
  get isConnected(): boolean { return true; }
  remove(): void { this.parentElement?.removeChild(this); }
}

/** Последний элемент, которому поставили `innerHTML` (общая подсказка kit — её `show`). */
export const dom = { lastHtml: null as FakeEl | null, byId: new Map<string, FakeEl>() };

export class FakeEl {
  readonly nodeType = 1;
  readonly style = new FakeStyle();
  readonly attrs: Record<string, string> = {};
  childNodes: (FakeEl | FakeText)[] = [];
  parentElement: FakeEl | null = null;
  listeners: Record<string, Listener[]> = {};
  html: string | undefined;
  title = '';
  disabled = false;
  colSpan = 1;
  value = '';
  draggable = false;
  clientWidth = 0;
  clientHeight = 0;
  offsetWidth = 0;
  offsetHeight = 0;
  scrollTop = 0;
  className = '';
  readonly classList = { add: (): void => {}, remove: (): void => {}, toggle: (): void => {}, contains: (): boolean => false };
  readonly dataset: Record<string, string> = {};
  constructor(public readonly tagName: string, public readonly ns?: string) {}

  get id(): string { return this.attrs.id ?? ''; }
  set id(v: string) { this.attrs.id = v; dom.byId.set(v, this); }
  get children(): FakeEl[] { return this.childNodes.filter((n): n is FakeEl => n instanceof FakeEl); }
  get firstChild(): FakeEl | FakeText | null { return this.childNodes[0] ?? null; }
  get lastChild(): FakeEl | FakeText | null { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get firstElementChild(): FakeEl | null { return this.children[0] ?? null; }
  get lastElementChild(): FakeEl | null { const c = this.children; return c[c.length - 1] ?? null; }
  get parentNode(): FakeEl | null { return this.parentElement; }
  get isConnected(): boolean { return true; }

  get textContent(): string {
    if (this.html !== undefined) return htmlText(this.html);
    return this.childNodes.map((n) => n.textContent).join('');
  }
  set textContent(v: string) { this.html = undefined; this.childNodes = [new FakeText(String(v))]; }
  get innerHTML(): string { return this.html ?? ''; }
  set innerHTML(v: string) { this.html = v; this.childNodes = []; dom.lastHtml = this; }

  append(...nodes: (FakeEl | FakeText | string)[]): void {
    for (const n of nodes) this.appendChild(typeof n === 'string' ? new FakeText(n) : n);
  }
  appendChild<T extends FakeEl | FakeText>(n: T): T {
    if (n.parentElement) n.parentElement.removeChild(n);
    if (this.html !== undefined) { this.childNodes = [new FakeText(htmlText(this.html))]; this.html = undefined; }
    n.parentElement = this;
    this.childNodes.push(n);
    return n;
  }
  prepend(...nodes: (FakeEl | FakeText | string)[]): void {
    const add = nodes.map((n) => (typeof n === 'string' ? new FakeText(n) : n));
    for (const n of add) { if (n.parentElement) n.parentElement.removeChild(n); n.parentElement = this; }
    this.childNodes = [...add, ...this.childNodes];
  }
  insertBefore<T extends FakeEl | FakeText>(n: T, ref: FakeEl | FakeText | null): T {
    if (!ref) return this.appendChild(n);
    if (n.parentElement) n.parentElement.removeChild(n);
    n.parentElement = this;
    const i = this.childNodes.indexOf(ref);
    this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, n);
    return n;
  }
  removeChild<T extends FakeEl | FakeText>(n: T): T { this.childNodes = this.childNodes.filter((x) => x !== n); n.parentElement = null; return n; }
  replaceChildren(...nodes: (FakeEl | FakeText | string)[]): void { this.childNodes = []; this.html = undefined; this.append(...nodes); }
  remove(): void { this.parentElement?.removeChild(this); }
  contains(n: unknown): boolean { let p = n as FakeEl | null; while (p) { if (p === this) return true; p = p.parentElement; } return false; }

  setAttribute(k: string, v: string): void { this.attrs[k] = String(v); if (k === 'id') dom.byId.set(String(v), this); }
  getAttribute(k: string): string | null { return this.attrs[k] ?? null; }
  removeAttribute(k: string): void { delete this.attrs[k]; }
  hasAttribute(k: string): boolean { return k in this.attrs; }

  addEventListener(t: string, fn: Listener): void { (this.listeners[t] ??= []).push(fn); }
  removeEventListener(t: string, fn: Listener): void { this.listeners[t] = (this.listeners[t] ?? []).filter((f) => f !== fn); }
  dispatch(t: string, e: Record<string, unknown> = {}): void {
    const ev = { clientX: 0, clientY: 0, button: 0, deltaY: 0, target: this, preventDefault: (): void => {}, stopPropagation: (): void => {}, ...e };
    for (const fn of [...(this.listeners[t] ?? [])]) fn(ev);
  }
  click(): void { this.dispatch('click'); }
  focus(): void {}
  blur(): void {}
  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number; x: number; y: number } {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
  }
  querySelector(): null { return null; }
  querySelectorAll(): FakeEl[] { return []; }
  getContext(): null { return null; }

  /** Все потомки по порядку (обход в глубину), сам — первым. */
  all(): FakeEl[] { return [this, ...this.children.flatMap((c) => c.all())]; }
}

/** Текст из html подсказки или `innerHTML`: `<br>` и границы блоков — строки, теги прочь, сущности — знаками. */
export function htmlText(html: string): string {
  return html
    .replace(/\s+/g, ' ')   // как вёрстка: пробелы и переводы строк исходника — один пробел; строки — только <br> и блоки
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p|h\d|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
}

/** Поставить подделку в глобал (`document`, `window`, `localStorage`); вернуть снятие. */
export function installFakeDom(): () => void {
  const G = globalThis as Record<string, unknown>;
  const saved = { document: G.document, window: G.window, localStorage: G.localStorage, requestAnimationFrame: G.requestAnimationFrame };
  const body = new FakeEl('body');
  const listeners: Record<string, Listener[]> = {};
  G.document = {
    body,
    createElement: (tag: string) => new FakeEl(tag),
    createElementNS: (ns: string, tag: string) => new FakeEl(tag, ns),
    createTextNode: (t: string) => new FakeText(t),
    getElementById: (id: string) => dom.byId.get(id) ?? null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (t: string, fn: Listener) => { (listeners[t] ??= []).push(fn); },
    removeEventListener: () => {},
  };
  G.window = {
    innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 1,
    addEventListener: () => {}, removeEventListener: () => {},
    setTimeout, clearTimeout, confirm: () => true,
  };
  G.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  G.requestAnimationFrame = () => 0;
  return () => { G.document = saved.document; G.window = saved.window; G.localStorage = saved.localStorage; G.requestAnimationFrame = saved.requestAnimationFrame; };
}

/** Подсказка элемента (kit `attachTooltip`): послать `mouseenter` и прочитать, что легло в общую подсказку; нет подсказки — `null`. */
export function tipOf(el: FakeEl): string | null {
  if (!el.listeners.mouseenter?.length) return null;
  dom.lastHtml = null;
  el.dispatch('mouseenter');
  const t = dom.lastHtml as FakeEl | null;
  return t ? htmlText(t.innerHTML) : null;
}

/** Текст элемента без лишних пробелов по краям строк. */
export const textOf = (el: FakeEl | FakeText | null | undefined): string => (el ? el.textContent.replace(/[ \t]+\n/g, '\n').trim() : '');

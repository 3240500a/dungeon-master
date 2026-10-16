import { describe, it, expect, beforeAll, vi } from 'vitest';
import { defaultConfigData } from '@dm/shared';

/**
 * ⭐ 16.10 (Артбук): ДЫМОВОЙ ПРОГОН СТРАНИЦ на настоящем сиде и конфиге — без браузера. Каждая подвкладка и маршрут рисуются
 * без исключения (страница не показывает «⚠ Страница упала»), правка текста по клику ложится в `pe_artbook`, брошенный на слот
 * файл уходит на `POST /api/dev/assets/<id>?dir=artbook` и встаёт в слот. DOM здесь — самодельный минимум (в репозитории нет
 * jsdom): ровно те вызовы, которыми пользуется вкладка.
 */

// ── Минимальный DOM ──────────────────────────────────────────────────────────────────────────────
type Fn = (e: Record<string, unknown>) => void;
class FNode {
  childNodes: FNode[] = [];
  parentNode: FNode | null = null;
  listeners: Record<string, Fn[]> = {};
  text = '';
  get isConnected(): boolean { let n: FNode = this; while (n.parentNode) n = n.parentNode; return n === doc.body; }
  get textContent(): string { return this.text + this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v: string) { this.childNodes = []; this.text = v ?? ''; }
  set innerHTML(v: string) { this.childNodes = []; this.text = v; }
  get innerHTML(): string { return this.textContent; }
  append(...ns: (FNode | string)[]): void {
    for (const n of ns) {
      const node = typeof n === 'string' ? new FText(n) : n;
      if (node instanceof FFrag) { for (const c of [...node.childNodes]) this.append(c); continue; }
      node.remove(); node.parentNode = this; this.childNodes.push(node);
    }
  }
  appendChild(n: FNode): FNode { this.append(n); return n; }
  after(n: FNode): void { const p = this.parentNode; if (!p) return; n.remove(); n.parentNode = p; p.childNodes.splice(p.childNodes.indexOf(this) + 1, 0, n); }
  remove(): void { if (this.parentNode) { const p = this.parentNode; p.childNodes.splice(p.childNodes.indexOf(this), 1); this.parentNode = null; } }
  contains(n: FNode | null): boolean { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  addEventListener(t: string, fn: Fn): void { (this.listeners[t] ??= []).push(fn); }
  removeEventListener(): void { /* */ }
  dispatch(t: string, extra: Record<string, unknown> = {}): void {
    let stopped = false;
    const ev = { type: t, target: this, preventDefault: () => {}, stopPropagation: () => { stopped = true; }, ...extra };
    for (let n: FNode | null = this; n && !stopped; n = n.parentNode) for (const fn of n.listeners[t] ?? []) fn(ev);
  }
  all(): FEl[] { const out: FEl[] = []; const walk = (n: FNode): void => { for (const c of n.childNodes) { if (c instanceof FEl) out.push(c); walk(c); } }; walk(this); return out; }
  querySelector(sel: string): FEl | null {
    const tags = sel.split(',').map((s) => s.trim()).filter((s) => /^[a-z]+$/.test(s));
    return this.all().find((e) => tags.includes(e.tagName.toLowerCase())) ?? null;
  }
  get lastElementChild(): FEl | null { return [...this.childNodes].reverse().find((c): c is FEl => c instanceof FEl) ?? null; }
}
class FText extends FNode { constructor(t: string) { super(); this.text = t; } }
class FFrag extends FNode {}
class FEl extends FNode {
  style: Record<string, string> = { cssText: '' };
  dataset: Record<string, string> = {};
  title = ''; value = ''; type = ''; checked = false; src = ''; alt = ''; href = ''; scrollTop = 0; selected = false;
  [k: string]: unknown;
  constructor(public tagName: string) { super(); }
  focus(): void { /* */ }
  blur(): void { this.dispatch('change'); }
  click(): void { this.dispatch('click'); }
}
class FTextArea extends FEl { scrollHeight = 40; constructor() { super('TEXTAREA'); } }
const doc = {
  body: new FEl('BODY'),
  visibilityState: 'visible',
  createElement: (t: string): FEl => (t === 'textarea' ? new FTextArea() : new FEl(t.toUpperCase())),
  createTextNode: (t: string): FText => new FText(t),
  createDocumentFragment: (): FFrag => new FFrag(),
};
class MemStorage {
  m = new Map<string, string>();
  getItem(k: string): string | null { return this.m.get(k) ?? null; }
  setItem(k: string, v: string): void { this.m.set(k, String(v)); }
  removeItem(k: string): void { this.m.delete(k); }
}

// ── Сервер-подделка ──────────────────────────────────────────────────────────────────────────────
const posts: { url: string; body: unknown }[] = [];
vi.mock('@dm/client/devAuth.js', () => ({
  devFetch: async (url: string, init: RequestInit): Promise<Response> => {
    posts.push({ url, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body });
    if (url.startsWith('/api/dev/assets/')) {
      const id = url.slice('/api/dev/assets/'.length).split('?')[0];
      return new Response(JSON.stringify({ ok: true, url: `/assets/artbook/${id}.png` }));
    }
    return new Response(JSON.stringify({ ok: true, rev: { pe_artbook: 5 } }));
  },
}));

const g = globalThis as unknown as Record<string, unknown>;
let render: (host: HTMLElement, data: Record<string, unknown>, opts: { gotoConfig: (k: string) => void }) => void;
let store: { doc: { texts: Record<string, { text: string }>; slots: Record<string, { url: string }[]> }; flush(): Promise<void> };
const host = new FEl('MAIN');

beforeAll(async () => {
  g.document = doc; g.window = g; g.Node = FNode; g.HTMLTextAreaElement = FTextArea;
  g.localStorage = new MemStorage();
  g.addEventListener = (): void => {}; g.removeEventListener = (): void => {};
  g.requestAnimationFrame = (f: () => void): number => { f(); return 0; };
  g.getSelection = (): { toString(): string } => ({ toString: () => '' });
  g.confirm = (): boolean => true;
  g.fetch = async (url: string): Promise<Response> => new Response(url === '/api/pose/rev' ? '{}' : '{}');
  // Все разделы раскрыты — рисуется весь Некрополь, а не только заголовки.
  // ⭐ Монстры (шаг B): и все разделы страниц подтипов, и матрицы.
  const subSections = ['egypt_mesopotamia', 'greece', 'rome', 'vikings', 'medieval'].flatMap((s) => ['lore', 'decay', 'palette', 'silhouette', 'motion', 'motifs', 'gameplay', 'depth', 'art', 'sources'].map((k) => `sub:${s}:${k}`));
  (g.localStorage as MemStorage).setItem('artbook_open', ['loc:crypt:look', 'loc:crypt:slots', 'crypt:intro', 'crypt:eras', 'crypt:layers', 'crypt:decay', 'crypt:statuses', 'crypt:signatures', 'crypt:packs', 'crypt:readability', 'crypt:engine', 'crypt:questions', 'crypt:sources', ...subSections, 'mon:matrix:traits', 'mon:matrix:canon'].join('|'));
  doc.body.append(host);
  ({ renderArtbookPage: render } = await import('./artbook.js') as never);
  ({ artbookStore: store } = await import('./store.js') as never);
  render(host as unknown as HTMLElement, defaultConfigData, { gotoConfig: () => {} });
  await vi.waitFor(() => { if (!host.textContent.includes('Локации') || host.textContent.includes('Загрузка артбука')) throw new Error('ещё грузится'); });
});

const clickText = (root: FNode, label: string): void => {
  const b = root.all().find((e) => e.tagName === 'BUTTON' && e.textContent.trim() === label);
  if (!b) throw new Error('нет кнопки ' + label);
  b.click();
};
const page = (): string => host.textContent;
const noCrash = (): void => { expect(page()).not.toContain('Страница упала'); };

describe('artbook: страницы рисуются', () => {
  it('Локации: список биомов и Некрополь целиком', () => {
    clickText(host, '🏛 Локации');
    noCrash();
    expect(page()).toContain('Некрополь Мёртвой Короны');
    host.all().find((e) => e.textContent === 'Некрополь Мёртвой Короны')!.dispatch('click');
    noCrash();
    for (const s of ['Некрополь: нежить крипты', 'Эпохи мира', 'Слои крипты по глубине', 'Лестница разложения', 'Подписи подтипов', 'Читаемость на камере', 'Рычаги движка', 'Открытые вопросы', 'Концепты окружения', 'Мудборд локации']) expect(page(), s).toContain(s);
    expect(page()).toContain('Склепы Короны');
    clickText(host, '← все локации');
    host.all().find((e) => e.textContent === 'Логова Крови и Зверя')!.dispatch('click');
    noCrash();
    expect(page()).toContain('Заметки художнику');
    expect(page()).not.toContain('Некрополь: нежить крипты');
  });

  it('Персонажи: семь классов и живые числа каждого', () => {
    clickText(host, '🧙 Персонажи');
    noCrash();
    for (const n of ['Заступник', 'Волкодав', 'Вьюга', 'Ловчая', 'Заклинатель', 'Ворожея', 'Вольный стрелок']) expect(page(), n).toContain(n);
    for (const id of (defaultConfigData.classes as { id: string; name: string }[])) {
      clickText(host, '🧙 Персонажи');
      if (page().includes('← все классы')) clickText(host, '← все классы');
      host.all().find((e) => e.textContent === id.name)!.dispatch('click');
      noCrash();
      expect(page(), id.id).toContain('Стартовые атрибуты');
      expect(page(), id.id).toContain('ур. 20');
      expect(page(), id.id).toContain('Стартовый комплект');
      expect(page(), id.id).not.toContain('Конфиг не разобрался');
    }
  });

  it('Монстры: подтипы → страница подтипа с таблицей живых чисел → карточка архетипа → матрица', () => {
    clickText(host, '💀 Монстры');
    noCrash();
    for (const n of ['Ушедшие следом', 'Посеянные', 'Непогребённый легион', 'Мёрзлая дружина', 'Присяжные Короны']) expect(page(), n).toContain(n);
    expect(page()).toContain('в конфиге 19 монстр.');
    const card = (name: string): FEl => host.all().find((e) => e.textContent === name && e.parentNode instanceof FEl)!;
    const row = (text: string): FEl => host.all().find((e) => e.tagName === 'TR' && e.textContent.includes(text))!;

    // Европа: все 19 зомби — в таблице архетипов с числами.
    card('Присяжные Короны').dispatch('click');
    noCrash();
    for (const s of ['Главный концепт и варианты', 'Архетипы подтипа — живые числа', 'уровень монстров:', 'Ополченец', 'Зомби-разведчик', 'Зомби-рыцарь', 'Монстры подтипа без архетипа', 'Зомби-берсерк', 'ещё нет в конфиге', 'Лор', 'Палитра и материалы', 'Геймплей', 'Где встречается', 'Источники']) expect(page(), s).toContain(s);
    expect(page()).not.toContain('Конфиг не разобрался');
    clickText(host, '40');
    clickText(host, 'уникальный');
    noCrash();
    const cmp = host.all().find((e) => e.tagName === 'SELECT' && e.childNodes.some((o) => (o as FEl).value === 'greece'))!;
    cmp.value = 'greece';
    cmp.dispatch('change');
    noCrash();
    expect(page()).toContain('Сравнение: Присяжные Короны ↔ Посеянные');

    // Карточка архетипа с монстром конфига: бой, атрибуты, гир, умения. Уникальные зовутся по пулу имён — строку ищем по id.
    row('zombie-raider').dispatch('click');
    noCrash();
    for (const s of ['Концепт целиком (фронт и 3/4 сверху)', 'В подтипе «Присяжные Короны»', 'Рычаги движка', 'Живые числа монстров конфига', 'Атрибуты заготовки', 'Снаряжение', 'Умения', 'Кожа мертвеца', 'Ржавая кольчуга', 'Блок щитом', 'zombie-crusher']) expect(page(), s).toContain(s);
    clickText(host, 'обычный');
    clickText(host, '1');
    clickText(host, 'Посеянный');   // «в других подтипах»: тот же архетип у Греции
    noCrash();
    expect(page()).toContain('Ещё нет в конфиге.');
    expect(page()).toContain('Завести монстра');

    // Подтип без монстров в конфиге и все прочие страницы подтипов — без падений.
    const toList = (): void => { if (!page().includes('▦ Матрица «архетип × подтип»')) { clickText(host, '▦ Матрица'); clickText(host, '← все подтипы'); } };
    for (const name of ['Посеянные', 'Непогребённый легион', 'Мёрзлая дружина', 'Ушедшие следом']) {
      toList();
      card(name).dispatch('click');
      noCrash();
      expect(page(), name).toContain('ещё нет в конфиге');
    }
    expect(page()).toContain('Дома');   // у Египта и Междуречья — два дома

    clickText(host, '▦ Матрица');
    noCrash();
    for (const s of ['Матрица «архетип × подтип»', 'Общие архетипы', 'Особые архетипы подтипа', 'Хопешник', 'Мёртвый король под Короной', 'Черты подтипов', 'Покрытие канона ролей']) expect(page(), s).toContain(s);
    const bare = host.all().find((e) => e.tagName === 'INPUT' && e.type === 'checkbox' && e.parentNode?.textContent.includes('только без концепта'))!;
    bare.checked = true;
    bare.dispatch('change');
    noCrash();
    expect(page()).toContain('Рядовой');
    host.all().find((e) => e.textContent === 'Строевой мертвец')!.dispatch('click');
    noCrash();
    expect(page()).toContain('В подтипе «Непогребённый легион»');
  });

  it('Модели (заглушка)', () => {
    clickText(host, '🧩 Модели');
    noCrash();
    expect(page()).toContain('Появится после концептов');
  });
});

describe('artbook: правка и картинки', () => {
  it('клик по тексту → поле → «Сохранить»: правка в pe_artbook и на сервер', async () => {
    clickText(host, '🧙 Персонажи');
    if (page().includes('← все классы')) clickText(host, '← все классы');
    host.all().find((e) => e.textContent === 'Заклинатель')!.dispatch('click');
    const lore = host.all().find((e) => e.title === 'нажми, чтобы править' && e.textContent.startsWith('Постиг огонь'))!;
    lore.dispatch('click');
    const ta = lore.querySelector('textarea')!;
    ta.value = 'Звездочёт, правка владельца';
    clickText(lore, 'Сохранить');
    expect(store.doc.texts['classes/classes/mage/lore']?.text).toBe('Звездочёт, правка владельца');
    expect(lore.textContent).toContain('Звездочёт, правка владельца');
    await store.flush();
    const saved = posts.filter((p) => p.url === '/api/dev/pose').pop()!.body as { pe_artbook: { texts: Record<string, unknown> } };
    expect(Object.keys(saved.pe_artbook.texts)).toContain('classes/classes/mage/lore');
  });

  it('файл, брошенный на слот, уходит на сервер и встаёт в слот; не картинка — ошибка в слоте', async () => {
    const slotTitle = host.all().find((e) => e.textContent === 'Концепт героя (фронт и 3/4 сверху)')!;
    let slot: FNode = slotTitle;
    while (slot.parentNode && !(slot as FEl).listeners.drop) slot = slot.parentNode;
    const file = { name: 'mage.png', type: 'image/png', size: 8, arrayBuffer: async () => new ArrayBuffer(8) };
    slot.dispatch('drop', { dataTransfer: { types: ['Files'], files: [file] } });
    await vi.waitFor(() => { if (!store.doc.slots['cls:mage:concept']?.length) throw new Error('ещё грузится'); });
    const up = posts.find((p) => p.url.startsWith('/api/dev/assets/'))!;
    expect(up.url).toMatch(/^\/api\/dev\/assets\/ab_cls-mage-concept_[a-z0-9]+\?dir=artbook$/);
    expect(store.doc.slots['cls:mage:concept']![0]!.url).toMatch(/^\/assets\/artbook\/ab_/);
    await vi.waitFor(() => { if (!page().includes('1 шт.')) throw new Error('не перерисовано'); });

    const slot2Title = host.all().find((e) => e.textContent === 'Лист снаряжения и деталей')!;
    let slot2: FNode = slot2Title;
    while (slot2.parentNode && !(slot2 as FEl).listeners.drop) slot2 = slot2.parentNode;
    const before = posts.length;
    slot2.dispatch('drop', { dataTransfer: { types: ['Files'], files: [{ name: 'eskiz.psd', type: '', size: 1, arrayBuffer: async () => new ArrayBuffer(1) }] } });
    await vi.waitFor(() => { if (!page().includes('не картинка png / jpg / webp')) throw new Error('нет ошибки'); });
    expect(store.doc.slots['cls:mage:gear']).toBeUndefined();
    // ⭐ больше предела сервера — отказ в слоте ДО сети (64+ МБ ради 413 не гоняем)
    let slot3: FNode = host.all().find((e) => e.textContent === 'Силуэт сверху в кадре игры (~155 px, 45°)')!;
    while (slot3.parentNode && !(slot3 as FEl).listeners.drop) slot3 = slot3.parentNode;
    slot3.dispatch('drop', { dataTransfer: { types: ['Files'], files: [{ name: 'huge.png', type: 'image/png', size: 65 * 1024 * 1024, arrayBuffer: async () => new ArrayBuffer(1) }] } });
    await vi.waitFor(() => { if (!page().includes('больше предела сервера')) throw new Error('нет ошибки'); });
    expect(posts.length, 'на сервер ничего не ушло').toBe(before);
    expect(store.doc.slots['cls:mage:silhouette']).toBeUndefined();
  });
});

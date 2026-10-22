import { describe, it, expect, beforeAll, vi } from 'vitest';
import { defaultConfigData } from '@dm/shared';
import cryptJson from './seed/crypt.json';
import { loadRoster, loadRosterIndex, type CryptDraft, type RosterIndex, type RosterV2 } from './seed.js';

/**
 * ⭐ 16.10 (Артбук): ДЫМОВОЙ ПРОГОН СТРАНИЦ на настоящем сиде и конфиге — без браузера. Каждая подвкладка и маршрут рисуются
 * без исключения (страница не показывает «⚠ Страница упала»), правка текста по клику ложится в `pe_artbook`, брошенный на слот
 * файл уходит на `POST /api/dev/assets/<id>?dir=artbook` и встаёт в слот. DOM здесь — самодельный минимум (в репозитории нет
 * jsdom): ровно те вызовы, которыми пользуется вкладка.
 *
 * ⭐ 17.10: шесть подтипов и ростеры по ярусам (v2): Некрополь — сводка решений и «Решение владельца» у каждого вопроса, слоёв
 * «этажи X» нет; страница подтипа — ярусы v2 (по 5 карточек на ярус, 3 босса), грузятся лениво; страница карточки v2 (слоты
 * `v2:<подтип>:<id>:<слот>`, правка по пути `v2/<подтип>/…`); «Ярусы × подтипы» и «Ростер и очерёдность» (счёты); прежние
 * архетипы по ролям — архив (свёрнутый раздел, карточка архетипа и матрица работают как раньше).
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
const crypt = cryptJson as unknown as CryptDraft;
/** Подтипы в порядке документа и их ростеры v2. */
const IDS = ['mesopotamia', 'egypt', 'greece', 'rome', 'vikings', 'medieval'];
const NAME: Record<string, string> = Object.fromEntries(crypt.subtypes.map((s) => [s.id, s.name]));
let R: Record<string, RosterV2> = {};
let IDX: RosterIndex;

beforeAll(async () => {
  g.document = doc; g.window = g; g.Node = FNode; g.HTMLTextAreaElement = FTextArea;
  g.localStorage = new MemStorage();
  g.addEventListener = (): void => {}; g.removeEventListener = (): void => {};
  g.requestAnimationFrame = (f: () => void): number => { f(); return 0; };
  g.getSelection = (): { toString(): string } => ({ toString: () => '' });
  g.confirm = (): boolean => true;
  g.fetch = async (url: string): Promise<Response> => new Response(url === '/api/pose/rev' ? '{}' : '{}');
  // Все разделы раскрыты — рисуется весь Некрополь, а не только заголовки.
  // ⭐ Монстры: и все разделы страниц подтипов (с архивом прежней раскладки — он свёрнут по умолчанию), и матрицы.
  const subSections = IDS.flatMap((s) => ['lore', 'decay', 'palette', 'silhouette', 'motion', 'motifs', 'gameplay', 'depth', 'art', 'sources', 'archive'].map((k) => `sub:${s}:${k}`));
  (g.localStorage as MemStorage).setItem('artbook_open', ['loc:crypt:look', 'loc:crypt:slots', 'crypt:decisions', 'crypt:intro', 'crypt:eras', 'crypt:selection', 'crypt:decay', 'crypt:statuses', 'crypt:signatures', 'crypt:packs', 'crypt:readability', 'crypt:engine', 'crypt:composite', 'crypt:questions', 'crypt:sources', ...subSections, 'mon:matrix:traits', 'mon:matrix:canon'].join('|'));
  doc.body.append(host);
  ({ renderArtbookPage: render } = await import('./artbook.js') as never);
  ({ artbookStore: store } = await import('./store.js') as never);
  IDX = await loadRosterIndex();
  R = Object.fromEntries(await Promise.all(IDS.map(async (id) => [id, await loadRoster(id)] as const)));
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
/** Ждать, пока на странице появится текст (ростеры v2 грузятся лениво — страница перерисуется сама). */
const until = async (text: string): Promise<void> => { await vi.waitFor(() => { if (!page().includes(text)) throw new Error('нет «' + text + '»'); }); };
/** Кликабельные строки таблицы (`onRow`). */
const clickRows = (root: FNode): FEl[] => root.all().filter((e) => e.tagName === 'TR' && !!e.listeners.click?.length);
/** Подвкладка «Монстры», список подтипов — с любой страницы внутри неё (кнопки «← …» ведут наверх). */
const toMonsterList = (): void => {
  clickText(host, '💀 Монстры');
  for (let i = 0; i < 4 && !page().includes('Нежить крипты — шесть подтипов'); i++) {
    host.all().find((e) => e.tagName === 'BUTTON' && e.textContent.startsWith('← '))?.click();
  }
  expect(page()).toContain('Нежить крипты — шесть подтипов');
};
const card = (name: string): FEl => host.all().find((e) => e.textContent === name && e.parentNode instanceof FEl)!;
/** Правимое поле по точному тексту: клик → поле → новый текст → «Сохранить». */
const editField = (text: string, value: string): void => {
  const box = host.all().find((e) => e.title === 'нажми, чтобы править' && e.textContent === text);
  if (!box) throw new Error('нет правимого поля «' + text.slice(0, 40) + '»');
  box.dispatch('click');
  box.querySelector('textarea')!.value = value;
  clickText(box, 'Сохранить');
};
/** Бросить файл на слот с заголовком `title`. */
const dropOn = (title: string, file: Record<string, unknown>): void => {
  let slot: FNode = host.all().find((e) => e.textContent === title)!;
  while (slot.parentNode && !(slot as FEl).listeners.drop) slot = slot.parentNode;
  slot.dispatch('drop', { dataTransfer: { types: ['Files'], files: [file] } });
};
const png = (name: string): Record<string, unknown> => ({ name, type: 'image/png', size: 8, arrayBuffer: async () => new ArrayBuffer(8) });
/** Текст, как его видно на странице: пометки движка `[есть]` — бейджами без скобок, `id` в обратных кавычках — без кавычек. */
const shown = (s: string): string => s.replace(/\[(есть[^\]]*|данные[^\]]*|легко[^\]]*|на будущее[^\]]*|код[^\]]*|мёртвое поле[^\]]*|К\d+[^\]]*)\]/g, '$1').replace(/`([^`\n]+)`/g, '$1');

describe('artbook: страницы рисуются', () => {
  it('Локации: Некрополь — сводка решений, выбор подтипа при спуске, «Решение владельца» у каждого вопроса', () => {
    clickText(host, '🏛 Локации');
    noCrash();
    expect(page()).toContain('Некрополь Мёртвой Короны');
    host.all().find((e) => e.textContent === 'Некрополь Мёртвой Короны')!.dispatch('click');
    noCrash();
    for (const s of ['Некрополь: нежить крипты', 'Сводка решений владельца (16–17.10)', 'Эпохи мира', 'Выбор подтипа при спуске', 'Лестница разложения', 'Подписи подтипов',
      'Знаменосцы по подтипам', 'Читаемость на камере', 'Рычаги движка', 'Пометки в карточках', 'Если дойдём до кода', 'Составные юниты', 'Вопросы и решения',
      'Концепты окружения', 'Мудборд локации']) expect(page(), s).toContain(s);
    // ⭐ 17.10: слоёв по этажам нет — печать подтипа, «лор ярусов — только лор» и концепт яруса Некрополя у каждого из шести подтипов
    for (const s of ['Печать подтипа', 'Ярусы Некрополя — только лор', 'Концепт яруса: Дом Праха', 'Концепт яруса: Двор Тростника', 'Концепт яруса: Присяжные Короны']) expect(page(), s).toContain(s);
    const chips = host.all().filter((e) => e.tagName === 'SPAN' && String(e.style.cssText).includes('border-radius:9px'));
    expect(chips.filter((e) => /^этажи /.test(e.textContent)), 'нет раздела слоёв с чипами «этажи X»').toEqual([]);
    for (const s of ['Слои крипты по глубине', 'Открытые вопросы', 'До демо', 'у всех пяти', 'пять подтипов']) expect(page(), s).not.toContain(s);
    // статусы — «Настройка» и «Не единственный, а самый частый»
    for (const n of crypt.statuses.notes) expect(page(), n.id).toContain(n.title);

    // Сводка решений — все пункты, заголовок пункта жирным
    for (const x of crypt.decisions) expect(page(), x.id).toContain(shown(x.text.slice(x.title.length)));
    expect(host.all().some((e) => e.tagName === 'B' && e.textContent === crypt.decisions[0]!.title)).toBe(true);
    // У каждого вопроса — «Решение владельца» с текстом решения; правится кликом по пути questions/<i>/decision
    expect(host.all().filter((e) => e.textContent === 'Решение владельца').length).toBe(crypt.questions.length);
    for (const q of crypt.questions) expect(page(), `вопрос ${q.n}`).toContain(shown(q.decision));
    editField(crypt.questions[1]!.decision, 'Решение: правка владельца');
    expect(store.doc.texts['crypt/questions/1/decision']?.text).toBe('Решение: правка владельца');
    expect(page()).toContain('Решение: правка владельца');

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

  it('Монстры: шесть подтипов → страница подтипа: ярусы v2 (по 5 карточек на ярус, 3 босса), особые, пачки, банк идей свёрнут', async () => {
    toMonsterList();
    noCrash();
    for (const id of IDS) expect(page(), id).toContain(NAME[id]!);
    // порядок владельца: № 1 Греция … № 5 Двор Тростника, № 6 Дом Праха
    const from = page().indexOf('Нажми на подтип');
    const pos = ['greece', 'rome', 'vikings', 'medieval', 'egypt', 'mesopotamia'].map((id) => page().indexOf(NAME[id]!, from));
    expect(pos).toEqual([...pos].sort((a, b) => a - b));
    await until('ярусы: 15 карточек · 3 босса');
    expect(page()).toContain('в конфиге 19 монстр.');
    for (const s of ['▦ Ярусы × подтипы', '☰ Ростер и очерёдность', '▦ Архив: «архетип × подтип»']) expect(page(), s).toContain(s);

    for (const id of IDS) {
      toMonsterList();
      card(NAME[id]!).dispatch('click');
      await until('Сетка ярусов');
      noCrash();
      const r = R[id]!;
      for (const t of r.tiers) {
        const wrap = host.all().find((e) => e.dataset.v2Tier === t.id)!;
        expect(clickRows(wrap).length, `${id}/${t.id}: 5 карточек`).toBe(5);
        for (const c of t.cards) expect(wrap.textContent, `${id}/${c.id}`).toContain(c.name);
      }
      expect(host.all().filter((e) => e.dataset.v2Boss).map((e) => e.dataset.v2Boss), `${id}: три босса`).toEqual(r.bosses.map((b) => b.id));
      const sp = host.all().find((e) => e.dataset.v2Specials === id)!;
      expect(clickRows(sp).length, `${id}: особые`).toBe(r.specials.length);
      for (const s of ['Ярусы (v2)', 'Боссы: 5 · 14 · 19', 'Бой по фазам', 'Особые', 'Пачки', r.packs[0]!.name, 'Переход ярусов по кругу', 'Комплект моделей по ярусам',
        'Новые вещи гира', 'Статусы и стойкость', 'Банк идей', 'Архив: прежняя раскладка по ролям (до 17.10)', 'Лор', 'Где встречается']) expect(page(), `${id}: ${s}`).toContain(s);
      expect(page(), `${id}: банк идей свёрнут`).not.toContain(r.ideaBank.bosses[0]!.differs);
      // архив прежней раскладки: у всех, кроме Европы, монстров конфига нет
      if (id !== 'medieval') expect(page(), id).toContain('ещё нет в конфиге');
      if (id === 'mesopotamia') expect(page()).toContain('Ратник свиты');   // ⭐ 16.10: Дом Праха — свой подтип (бывший «дом» слитого Египта-Междуречья)
    }
  });

  it('Монстры: банк идей раскрывается; карточка v2 — слоты v2:<подтип>:<id>:<слот>, все поля, правка по пути v2/…', async () => {
    toMonsterList();
    card('Присяжные Короны').dispatch('click');
    await until('Сетка ярусов');
    const med = R.medieval!;
    host.all().find((e) => e.textContent === 'Банк идей' && e.tagName === 'SPAN')!.dispatch('click');
    noCrash();
    expect(page()).toContain(med.ideaBank.bosses[0]!.differs);
    expect(page()).toContain(med.ideaBank.ideas[0]!.what);

    // Боец яруса: клик по строке — его страница
    const c = med.tiers[0]!.cards[0]!;
    clickRows(host.all().find((e) => e.dataset.v2Tier === 'light')!).find((tr) => tr.textContent.includes(c.name))!.dispatch('click');
    noCrash();
    for (const s of ['← Присяжные Короны', 'Концепт целиком (фронт и 3/4 сверху)', 'Силуэт сверху в кадре игры (~155 px, 45°)', 'Лист деталей и гира', 'боец яруса',
      'лёгкий (weak)', 'Роль движка', 'Оружие', 'Статус удара', 'Механика держится на', 'на будущее: К9 (крупно)', 'В пачках', 'Деревенский дозор', 'Живые числа',
      'Ещё нет в конфиге: делаем заново.', 'Нынешние 19 зомби конфига — тестовые', 'Завести монстра', c.prototype, c.role, c.move.split('[')[0]!]) expect(page(), s).toContain(s);
    // слот карточки: файл встаёт под ключ v2:medieval:<id>:concept
    dropOn('Концепт целиком (фронт и 3/4 сверху)', png('militia.png'));
    await vi.waitFor(() => { if (!store.doc.slots[`v2:medieval:${c.id}:concept`]?.length) throw new Error('ещё грузится'); });
    expect(posts.some((p) => p.url.startsWith(`/api/dev/assets/ab_v2-medieval-${c.id}-concept_`))).toBe(true);
    // правка поля — по пути v2/<подтип>/tiers/<ярус>/cards/<id>/<поле>; видна и на странице подтипа
    editField(c.role, 'Толпа: правка владельца');
    expect(store.doc.texts[`v2/medieval/tiers/light/cards/${c.id}/role`]?.text).toBe('Толпа: правка владельца');
    clickText(host, '← Присяжные Короны');
    noCrash();
    expect(page()).toContain('Толпа: правка владельца');

    // Босс: облик, зал, бой по фазам; соседние боссы — кнопками
    host.all().find((e) => e.dataset.v2Boss === med.bosses[0]!.id)!.dispatch('click');
    noCrash();
    for (const s of [med.bosses[0]!.name, 'босс 5 · лёгкий', 'тир boss', 'Облик', 'Зал и свита', 'Чем отличается', 'Бой по фазам', 'Базовая версия без кода']) expect(page(), s).toContain(s);
    // ⭐ 22.10: промт Nano Banana под слотами — стиль и фон подтипа, описание босса, концовка; «Копировать» собирает целиком
    const b0 = med.bosses[0]!;
    for (const s of ['Промт для Nano Banana', IDX.prompt!.style, med.promptBackdrop!, b0.prompt!, IDX.prompt!.close]) expect(page(), s).toContain(s);
    let copied = '';
    vi.stubGlobal('navigator', { clipboard: { writeText: async (t: string) => { copied = t; } } });
    clickText(host.all().find((e) => e.dataset.v2Prompt === 'medieval')!, '📋 Копировать');
    await vi.waitFor(() => { if (!copied) throw new Error('ещё не скопировано'); });
    expect(copied).toBe(`${IDX.prompt!.style} ${med.promptBackdrop}\n\n${b0.prompt}\n\n${IDX.prompt!.close}`);
    // правка описания — по пути v2/<подтип>/bosses/<id>/prompt, копируется уже с правкой
    editField(b0.prompt!, 'Босс-зомби: правка владельца.');
    expect(store.doc.texts[`v2/medieval/bosses/${b0.id}/prompt`]?.text).toBe('Босс-зомби: правка владельца.');
    copied = '';
    clickText(host.all().find((e) => e.dataset.v2Prompt === 'medieval')!, '📋 Копировать');
    await vi.waitFor(() => { if (!copied) throw new Error('ещё не скопировано'); });
    expect(copied).toContain('\n\nБосс-зомби: правка владельца.\n\n');
    vi.unstubAllGlobals();
    clickText(host, med.bosses[1]!.name);
    noCrash();
    expect(page()).toContain('босс 14 · средний');

    // Особый: механика, телеграф, контригра
    clickText(host, '← Присяжные Короны');
    const sp = med.specials[0]!;
    clickRows(host.all().find((e) => e.dataset.v2Specials === 'medieval')!).find((tr) => tr.textContent.includes(sp.name))!.dispatch('click');
    noCrash();
    for (const s of [sp.name, 'особый, 1-я волна', 'Механика', 'Телеграф', 'Контригра', 'В пачках']) expect(page(), s).toContain(s);
  });

  it('«Ярусы × подтипы»: имена карточек шести подтипов по ярусам и строка боссов; клик — карточка', async () => {
    toMonsterList();
    clickText(host, '▦ Ярусы × подтипы');
    await until('Лёгкий · ближний бой (3)');
    noCrash();
    const head = host.all().filter((e) => e.tagName === 'TH').map((e) => e.textContent).slice(0, 7);
    expect(head, 'колонки — в порядке документа').toEqual(['Ярус', ...IDX.order.map((id) => `${NAME[id]} (№${crypt.subtypes.find((s) => s.id === id)!.ownerNo})`)]);
    for (const s of ['Лёгкий · стрелки (2)', 'Средний · ближний бой (3)', 'Тяжёлый · броня (карточек)', 'Боссы 5 · 14 · 19', 'Особые (1-я волна, затем 2-я)', 'стёганая 2, кожа 3']) expect(page(), s).toContain(s);
    let names = 0;
    for (const r of Object.values(R)) {
      for (const t of r.tiers) for (const c of t.cards) { expect(page(), `${r.id}/${c.id}`).toContain(c.name); names++; }
      for (const b of r.bosses) expect(page(), `${r.id}/${b.id}`).toContain(b.name);
    }
    expect(names).toBe(90);
    const links = host.all().filter((e) => e.tagName === 'SPAN' && !!e.listeners.click?.length && e.title === 'карточка: концепты и все поля');
    expect(links.length, '90 карточек + 18 боссов + особые').toBe(90 + 18 + Object.values(R).reduce((n, r) => n + r.specials.length, 0));
    links.find((e) => e.textContent === 'Хопешник')!.dispatch('click');
    noCrash();
    expect(page()).toContain('← Двор Тростника');
    expect(page()).toContain('средний (medium)');
  });

  it('«Ростер и очерёдность»: очереди, Европа первой, счёты по подтипам и итого', async () => {
    toMonsterList();
    clickText(host, '☰ Ростер и очерёдность');
    await until('Всего в работе (1–3)');
    noCrash();
    for (const q of IDX.roster.queues) expect(page(), q.id).toContain(q.label);
    const rows = host.all().filter((e) => e.tagName === 'TR').map((tr) => tr.childNodes.map((td) => td.textContent));
    const sum = rows.filter((r) => r[0] === 'Итого' || IDS.some((id) => r[0]!.startsWith(NAME[id]! + ' (')));
    expect(sum.map((r) => r[0]!.split(' (')[0]), 'Европа первой').toEqual([...IDX.roster.productionOrder.map((id) => NAME[id]), 'Итого']);
    expect(sum[0]).toEqual(['Присяжные Короны (Европа XII–XV вв., №4) — первый', '10', '6 (5 + босс 5)', '8 (2 босса + 6 особых)', '13 (2 босса + 11 идей)', '24']);
    expect(sum.find((r) => r[0]!.startsWith('Дом Праха'))!.slice(1)).toEqual(['10', '6 (5 + босс 5)', '7 (2 босса + 5 особых)', '17 (3 босса + 14 идей)', '23']);
    expect(sum[sum.length - 1]).toEqual(['Итого', '60', '36', '47 (12 боссов + 35 особых)', '135 (17 боссов + 118 идей)', '143']);
    // раскрыт ростер Европы: 10 + 6 + 8 строк, у ополченца — сводка пометок
    expect(rows.filter((r) => r[0] === '1 · сначала').length).toBe(10);
    expect(rows.filter((r) => r[0] === '2 · следом').length).toBe(6);
    expect(rows.filter((r) => r[0] === '3 · потом').length).toBe(8);
    const militia = rows.find((r) => r[1] === 'Ополченец')!;
    expect(militia[5]).toBe('легко: новые вещи u-bucklerна будущее: К9 (крупно)');
    expect(rows.some((r) => r[1] === 'Босс 5 «Сержант Последнего Караула»')).toBe(true);
    expect(page()).toContain('Р · банк идей: 2 вар. босса');
  });

  it('Архив прежней раскладки: живые числа архетипов, карточка архетипа, матрица «архетип × подтип»', () => {
    toMonsterList();
    card('Присяжные Короны').dispatch('click');
    noCrash();
    const row = (text: string): FEl => host.all().find((e) => e.tagName === 'TR' && e.textContent.includes(text))!;
    // Европа: нынешние 19 зомби (тестовые) — в архивной таблице архетипов с числами.
    for (const s of ['Главный концепт и варианты', 'Архетипы подтипа — живые числа', 'уровень монстров:', 'Ополченец', 'Зомби-разведчик', 'Зомби-рыцарь', 'Монстры подтипа без архетипа', 'Зомби-берсерк', 'ещё нет в конфиге', 'Палитра и материалы', 'Геймплей', 'Источники']) expect(page(), s).toContain(s);
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

    clickText(host, '▦ Архив: «архетип × подтип»');
    noCrash();
    for (const s of ['Архив: матрица «архетип × подтип»', 'Общие архетипы', 'Особые архетипы подтипа', 'Хопешник', 'Черты подтипов', 'Покрытие канона ролей']) expect(page(), s).toContain(s);
    for (const id of IDS) expect(page(), id).toContain(`${NAME[id]} · №`);
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
    expect(Object.keys(saved.pe_artbook.texts)).toEqual(expect.arrayContaining(['classes/classes/mage/lore', 'crypt/questions/1/decision', 'v2/medieval/tiers/light/cards/militiaman/role']));
  });

  it('файл, брошенный на слот, уходит на сервер и встаёт в слот; не картинка — ошибка в слоте', async () => {
    dropOn('Концепт героя (фронт и 3/4 сверху)', png('mage.png'));
    await vi.waitFor(() => { if (!store.doc.slots['cls:mage:concept']?.length) throw new Error('ещё грузится'); });
    const up = posts.find((p) => p.url.startsWith('/api/dev/assets/ab_cls-'))!;
    expect(up.url).toMatch(/^\/api\/dev\/assets\/ab_cls-mage-concept_[a-z0-9]+\?dir=artbook$/);
    expect(store.doc.slots['cls:mage:concept']![0]!.url).toMatch(/^\/assets\/artbook\/ab_/);
    await vi.waitFor(() => { if (!page().includes('1 шт.')) throw new Error('не перерисовано'); });

    const before = posts.length;
    dropOn('Лист снаряжения и деталей', { name: 'eskiz.psd', type: '', size: 1, arrayBuffer: async () => new ArrayBuffer(1) });
    await vi.waitFor(() => { if (!page().includes('не картинка png / jpg / webp')) throw new Error('нет ошибки'); });
    expect(store.doc.slots['cls:mage:gear']).toBeUndefined();
    // ⭐ больше предела сервера — отказ в слоте ДО сети (64+ МБ ради 413 не гоняем)
    dropOn('Силуэт сверху в кадре игры (~155 px, 45°)', { name: 'huge.png', type: 'image/png', size: 65 * 1024 * 1024, arrayBuffer: async () => new ArrayBuffer(1) });
    await vi.waitFor(() => { if (!page().includes('больше предела сервера')) throw new Error('нет ошибки'); });
    expect(posts.length, 'на сервер ничего не ушло').toBe(before);
    expect(store.doc.slots['cls:mage:silhouette']).toBeUndefined();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from '../core/app.js';
import { runAuthFlow } from './screens3d.js';

/**
 * ⭐ R11-15: «ВЫЙТИ ИЗ АККАУНТА» ВЕБ-3D ГАСИТ СЕССИЮ НА СЕРВЕРЕ, как «Выйти» 2D. Раньше кнопка только стирала `dm:auth` в этой
 * вкладке и `POST /api/logout` не слала вовсе: токен жил на сервере ещё неделю (срок продлевается на каждом запросе), и у того,
 * кто его успел унести (скопированный запрос, расширение, читающее localStorage), доступ оставался после «выхода» на чужом ПК.
 *
 * DOM-окружения в проекте нет (тесты идут в node) — заглушка ровно того, чем пользуются экраны.
 */
class El {
  children: El[] = []; parent: El | null = null; style: Record<string, string> = {};
  textContent = ''; placeholder = ''; autocomplete = ''; type = ''; value = ''; maxLength = 0;
  private on = new Map<string, ((e: unknown) => void)[]>();
  constructor(public tag: string) { }
  set innerHTML(_v: string) { for (const c of this.children) c.parent = null; this.children = []; }
  append(...c: El[]): void { for (const x of c) { x.parent = this; this.children.push(x); } }
  appendChild(c: El): El { this.append(c); return c; }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; }
  addEventListener(t: string, fn: (e: unknown) => void): void { this.on.set(t, [...(this.on.get(t) ?? []), fn]); }
  focus(): void { }
  click(): void { for (const fn of this.on.get('click') ?? []) fn({}); }
  all(): El[] { return this.children.flatMap((c) => [c, ...c.all()]); }
  text(): string { return [this.textContent, ...this.all().map((c) => c.textContent)].join(' | '); }
}

const TOKEN = 'ab'.repeat(32);
const store = new Map<string, string>();
let calls: { url: string; method: string; auth?: string }[];
let offline: boolean;
const G = globalThis as unknown as { document?: unknown };
beforeEach(() => {
  vi.useFakeTimers();   // фокус поля входа — по таймеру: не тянем его за пределы теста
  store.clear(); calls = []; offline = false;
  G.document = { createElement: (t: string) => new El(t) };
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  });
  vi.stubGlobal('fetch', async (url: string, init: { method?: string; headers?: Record<string, string> }) => {
    calls.push({ url, method: init.method ?? 'GET', auth: init.headers?.Authorization });
    if (offline) throw new Error('сети нет');
    return new Response(JSON.stringify(url.endsWith('/characters') ? { characters: [] } : { ok: true }), { status: 200 });
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); delete G.document; });

/** Промисы экранов (ростер, выход) доиграть до конца. */
const settle = async (): Promise<void> => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const button = (root: El, label: string): El => {
  const b = root.all().find((e) => e.tag === 'button' && e.textContent === label);
  expect(b, `кнопка «${label}»`).toBeTruthy();
  return b!;
};

/** Вошедший игрок на экране «Выбор персонажа» веб-3D. */
async function atCharacters(): Promise<{ app: App; root: El }> {
  const app = new App({ offline: true });
  app.setAuth({ token: TOKEN, userId: 'u1', username: 'hero' });
  expect(store.has('dm:auth')).toBe(true);
  const root = new El('div');
  void runAuthFlow(app, root as unknown as HTMLElement);
  button(root, 'Играть').click();
  await settle();
  expect(root.text()).toContain('Выбор персонажа');
  return { app, root };
}

describe('⭐ R11-15: веб-3D — «Выйти из аккаунта»', () => {
  it('⭐ шлёт POST /api/logout с токеном сессии, забывает вход и показывает экран входа', async () => {
    const { app, root } = await atCharacters();
    button(root, 'Выйти из аккаунта').click();
    await settle();
    expect(calls.filter((c) => c.url === '/api/logout'), 'было: сервер о выходе не узнавал — токен жил неделю')
      .toEqual([{ url: '/api/logout', method: 'POST', auth: `Bearer ${TOKEN}` }]);
    expect(store.has('dm:auth')).toBe(false);
    expect(app.auth).toBeNull();
    expect(root.children, 'один экран — вход').toHaveLength(1);
    expect(root.text()).toContain('Онлайн · вход в аккаунт');
  });

  it('сервер недоступен — всё равно вышли (вход забыт, экран входа), без необработанного отказа', async () => {
    const { app, root } = await atCharacters();
    offline = true;
    button(root, 'Выйти из аккаунта').click();
    await settle();
    expect(calls.some((c) => c.url === '/api/logout')).toBe(true);
    expect(store.has('dm:auth')).toBe(false);
    expect(app.auth).toBeNull();
    expect(root.text()).toContain('Онлайн · вход в аккаунт');
  });

  it('2D и веб-3D выходят одним швом (`signOut`)', () => {
    const HERE = dirname(fileURLToPath(import.meta.url));
    const SCREENS = readFileSync(join(HERE, 'screens3d.ts'), 'utf8');
    const SCENE = readFileSync(join(HERE, '..', 'scenes', 'CharacterSelectScene.ts'), 'utf8');
    expect(SCREENS).toMatch(/'Выйти из аккаунта', \(\) => \{ void signOut\(app\);/);
    expect(SCENE).toMatch(/await signOut\(App\.from\(this\)\);/);
    expect(SCENE, 'своего выхода мимо шва у 2D больше нет').not.toMatch(/\blogout\(/);
  });
});

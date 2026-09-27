import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConfigRegistry } from '@dm/shared';
import { ClassSelectScene } from './ClassSelectScene.js';
import { createCharacter } from '../modules/auth/authApi.js';

/**
 * ⭐ R9-15: 2D-СОЗДАНИЕ ПЕРСОНАЖА ПЕРЕЖИВАЕТ ПЕРЕЗАПУСК СЦЕНЫ. Phaser держит ОДИН экземпляр сцены на всю страницу:
 * `scene.start('ClassSelect')` лишь заново зовёт `create()`, а поля остаются прежними. Флаг «запрос в пути» (`busy`)
 * ставился на клик и снимался только в ветке обычной ошибки — после успеха (герой создан → мир → возврат R4-22 в
 * «Персонажей») и после 401 (сессия истекла → «Вход» → снова «+ Создать персонажа») каждая карточка класса молча
 * ничего не делала: ни запроса, ни текста ошибки — до F5. Веб-3D (`screens3d.showCreate`) держит флаг на показ экрана.
 *
 * Сцена настоящая; Phaser и REST подменены, объекты сцены — заглушки с записью обработчиков.
 */
vi.mock('phaser', () => ({
  default: {
    Scene: class { constructor(_key?: string) { } },
    Scenes: { Events: { SHUTDOWN: 'shutdown' } },
  },
}));
vi.mock('../modules/auth/authApi.js', () => ({ createCharacter: vi.fn() }));

const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const create = vi.mocked(createCharacter);

/** Объект сцены (текст/картинка/прямоугольник): цепочки возвращают себя, `on` запоминает обработчики. */
class Obj {
  width = 100; height = 100; text = '';
  readonly on_ = new Map<string, () => void>();
  on(t: string, f: () => void): this { this.on_.set(t, f); return this; }
  setText(t: string): this { this.text = t; return this; }
  setOrigin(): this { return this; } setScale(): this { return this; } setStrokeStyle(): this { return this; }
  setInteractive(): this { return this; } setBackgroundColor(): this { return this; } setColor(): this { return this; }
  add(): this { return this; } updateText(): void { }
}

function setup() {
  const app = { config: reg, auth: { token: 'ab'.repeat(32) } as { token: string } | null, pendingCharId: null as string | null, clearAuth: vi.fn() };
  const scene = new ClassSelectScene() as unknown as { create(): void };
  const rects: Obj[] = [];
  const texts: Obj[] = [];
  const start = vi.fn();
  Object.assign(scene, {
    game: { registry: { get: () => app } },
    scale: { width: 1280, height: 720 },
    add: {
      text: () => { const o = new Obj(); texts.push(o); return o; },
      image: () => new Obj(), container: () => new Obj(),
      rectangle: () => { const o = new Obj(); rects.push(o); return o; },
    },
    scene: { start },
    events: { once: () => { } },
  });
  /** Показ сцены, как `scene.start('ClassSelect')`: тот же экземпляр, заново `create()`; карточки — этого показа. */
  const show = (): { cards: Obj[]; err: () => string } => {
    rects.length = 0; texts.length = 0;
    scene.create();
    const cards = [...rects];
    const err = texts.at(-2)!;   // под карточками: строка ошибки, затем кнопка «Назад»
    return { cards, err: () => err.text };
  };
  return { app, start, show };
}

/** Дать отработать продолжениям `await` (ответ заглушки REST уже готов) — без часов. */
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('⭐ R9-15: ClassSelectScene — флаг «запрос в пути» не переживает показ сцены', () => {
  const G = globalThis as unknown as { document?: unknown };
  beforeEach(() => {
    create.mockReset();
    G.document = {
      createElement: () => ({ style: {}, value: '', focus: () => { }, remove: () => { } }),
      getElementById: () => null,
    };
  });
  afterEach(() => { delete G.document; });

  it('⭐ путь B: герой создан → мир → возврат (R4-22) → снова «Создать» — карточка шлёт запрос', async () => {
    const s = setup();
    create.mockResolvedValue({ charId: 'c1', name: 'Герой', classId: reg.get('classes')[0]!.id, level: 1 });
    const first = s.show();
    expect(first.cards.length, 'карточки классов построены').toBeGreaterThan(0);
    first.cards[0]!.on_.get('pointerdown')!();
    await settle();
    expect(s.start).toHaveBeenLastCalledWith('Online');
    expect(s.app.pendingCharId).toBe('c1');
    const again = s.show();
    again.cards[0]!.on_.get('pointerdown')!();
    await settle();
    expect(create, 'было: 1 — второй клик молча ничего не делал до F5').toHaveBeenCalledTimes(2);
  });

  it('⭐ путь A: 401 (сессия истекла) → «Вход» → снова «Создать» — карточка шлёт запрос', async () => {
    const s = setup();
    create.mockRejectedValueOnce(new Error('Требуется вход'));
    s.show().cards[0]!.on_.get('pointerdown')!();
    await settle();
    expect(s.app.clearAuth).toHaveBeenCalledTimes(1);
    expect(s.start).toHaveBeenLastCalledWith('Login');
    create.mockResolvedValueOnce({ charId: 'c2', name: 'Герой', classId: reg.get('classes')[0]!.id, level: 1 });
    s.show().cards[0]!.on_.get('pointerdown')!();
    await settle();
    expect(create, 'было: 1 — после повторного входа карточки мертвы').toHaveBeenCalledTimes(2);
    expect(s.start).toHaveBeenLastCalledWith('Online');
  });

  it('контроль: пока запрос в пути, повторный клик второго героя не создаёт (ради этого флаг и есть)', async () => {
    const s = setup();
    let resolve!: (v: Awaited<ReturnType<typeof createCharacter>>) => void;
    create.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const v = s.show();
    v.cards[0]!.on_.get('pointerdown')!();
    v.cards.at(-1)!.on_.get('pointerdown')!();
    expect(create, 'двойной клик — один запрос').toHaveBeenCalledTimes(1);
    resolve({ charId: 'c3', name: 'Герой', classId: reg.get('classes')[0]!.id, level: 1 });
    await settle();
    expect(s.start).toHaveBeenLastCalledWith('Online');
    expect(s.app.pendingCharId).toBe('c3');
  });

  it('ответ запроса прошлого показа («Назад» во время запроса) не снимает флаг нынешнего', async () => {
    const s = setup();
    let fail1!: (e: Error) => void;
    create.mockReturnValueOnce(new Promise((_r, j) => { fail1 = j; }));
    s.show().cards[0]!.on_.get('pointerdown')!();       // запрос 1 в пути, игрок ушёл «Назад» и вернулся
    const now = s.show();
    create.mockReturnValueOnce(new Promise(() => { })); // запрос 2 в пути (ответа ещё нет)
    now.cards[0]!.on_.get('pointerdown')!();
    expect(create).toHaveBeenCalledTimes(2);
    fail1(new Error('Имя занято'));
    await settle();
    now.cards[0]!.on_.get('pointerdown')!();
    expect(create, 'запрос 2 ещё в пути — третьего нет').toHaveBeenCalledTimes(2);
  });

  it('контроль: обычная ошибка (имя занято) — текст под карточками, и тот же показ снова шлёт запрос', async () => {
    const s = setup();
    create.mockRejectedValueOnce(new Error('Имя занято'));
    const w = s.show();
    w.cards[0]!.on_.get('pointerdown')!();
    await settle();
    expect(w.err()).toBe('Имя занято');
    expect(s.start).not.toHaveBeenCalled();
    create.mockResolvedValueOnce({ charId: 'c4', name: 'Другой', classId: reg.get('classes')[0]!.id, level: 1 });
    w.cards[0]!.on_.get('pointerdown')!();
    await settle();
    expect(create).toHaveBeenCalledTimes(2);
    expect(s.app.pendingCharId).toBe('c4');
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LoginScene } from './LoginScene.js';
import { login, register } from '../modules/auth/authApi.js';

/**
 * ⭐ R13-15: 2D-ВХОД — ОДИН ЗАПРОС НА ОДНУ ПОПЫТКУ. Флаг «запрос в пути» был только у кнопки (`go.disabled`: отключённая
 * кнопка `click` не шлёт), а Enter в поле пароля звал отправку мимо него. Двойной Enter (или удержание — автоповтор, или
 * клик и Enter) слал два `/api/login`: при верном пароле — две сессии на 7 дней и два поворота токена устройства, при
 * неверном — два жетона из вёдер «по нику» и «по адресу» (блокировка вдвое быстрее); на регистрации второй ответ («ник
 * занят») мигал поверх успеха первого. Веб-3D (`screens3d.showLogin`) держит флаг на оба пути.
 *
 * Сцена настоящая; Phaser и REST подменены, DOM — заглушка с записью обработчиков.
 */
vi.mock('phaser', () => ({
  default: {
    Scene: class { constructor(_key?: string) { } },
    Scenes: { Events: { SHUTDOWN: 'shutdown' } },
  },
}));
vi.mock('../modules/auth/authApi.js', () => ({ login: vi.fn(), register: vi.fn() }));

const loginMock = vi.mocked(login);
const registerMock = vi.mocked(register);
type Session = Awaited<ReturnType<typeof login>>;
const SESSION = { token: 'ab'.repeat(32), userId: 7, username: 'Герой' } as unknown as Session;

/** Элемент DOM-формы: элемент по селектору — один на селектор; `click` — как у браузера (отключённая кнопка молчит). */
class El {
  style = { cssText: '' }; textContent = ''; value = ''; disabled = false; innerHTML = '';
  private sel = new Map<string, El>();
  private on = new Map<string, ((e: unknown) => void)[]>();
  addEventListener(t: string, f: (e: unknown) => void): void { this.on.set(t, [...(this.on.get(t) ?? []), f]); }
  querySelector(s: string): El { let e = this.sel.get(s); if (!e) { e = new El(); this.sel.set(s, e); } return e; }
  appendChild(c: El): El { return c; }
  focus(): void { }
  remove(): void { }
  click(): void { if (!this.disabled) for (const f of this.on.get('click') ?? []) f({}); }
  keydown(key: string, repeat = false): void { for (const f of this.on.get('keydown') ?? []) f({ key, repeat }); }
}

function setup() {
  const app = { setAuth: vi.fn() };
  const scene = new LoginScene() as unknown as { create(): void };
  const start = vi.fn();
  Object.assign(scene, {
    game: { registry: { get: () => app } },
    scene: { start },
    events: { once: () => { } },
  });
  let box!: El;
  (globalThis as unknown as { document: unknown }).document = {
    getElementById: () => null,
    body: { appendChild: (c: El) => c },
    createElement: () => { box = new El(); return box; },
  };
  scene.create();
  const $ = (s: string): El => box.querySelector(s);
  $('.u').value = 'Герой'; $('.p').value = 'secret-1';
  return { app, start, go: $('.go'), pass: $('.p'), err: $('.err'), switchMode: () => $('.switch').click() };
}

/** Дать отработать продолжениям `await` (ответ заглушки REST уже готов) — без часов. */
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('⭐ R13-15: LoginScene — пока запрос в пути, Enter второй не шлёт', () => {
  beforeEach(() => { loginMock.mockReset(); registerMock.mockReset(); });
  afterEach(() => { delete (globalThis as unknown as { document?: unknown }).document; });

  it('⭐ двойной Enter, удержание (автоповтор) и клик вдогонку — один `/api/login`; ответ ведёт к выбору героя', async () => {
    const s = setup();
    let resolve!: (v: Session) => void;
    loginMock.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    s.pass.keydown('Enter');
    s.pass.keydown('Enter');
    s.pass.keydown('Enter', true);
    s.go.click();
    expect(loginMock, 'было: 3 — каждый Enter слал свой запрос (две сессии, два жетона лимитера)').toHaveBeenCalledTimes(1);
    expect(loginMock).toHaveBeenCalledWith('Герой', 'secret-1');
    resolve(SESSION);
    await settle();
    expect(s.app.setAuth).toHaveBeenCalledTimes(1);
    expect(s.start).toHaveBeenCalledWith('CharacterSelect');
  });

  it('⭐ клик, затем Enter — тоже один запрос', () => {
    const s = setup();
    loginMock.mockReturnValueOnce(new Promise(() => { }));
    s.go.click();
    s.pass.keydown('Enter');
    expect(loginMock, 'было: 2').toHaveBeenCalledTimes(1);
  });

  it('⭐ регистрация: двойной Enter — один `/api/register` (второй «ник занят» не мигает поверх успеха)', () => {
    const s = setup();
    s.switchMode();
    registerMock.mockReturnValueOnce(new Promise(() => { }));
    s.pass.keydown('Enter');
    s.pass.keydown('Enter');
    expect(registerMock, 'было: 2').toHaveBeenCalledTimes(1);
    expect(loginMock).not.toHaveBeenCalled();
  });

  it('контроль: отказ (неверный пароль) — текст ошибки, и следующая попытка (Enter или клик) снова шлёт запрос', async () => {
    const s = setup();
    loginMock.mockRejectedValueOnce(new Error('Неверный ник или пароль'));
    s.pass.keydown('Enter');
    await settle();
    expect(s.err.textContent).toBe('Неверный ник или пароль');
    expect(s.start).not.toHaveBeenCalled();
    loginMock.mockRejectedValueOnce(new Error('Неверный ник или пароль'));
    s.pass.keydown('Enter');
    await settle();
    loginMock.mockResolvedValueOnce(SESSION);
    s.go.click();
    await settle();
    expect(loginMock).toHaveBeenCalledTimes(3);
    expect(s.start).toHaveBeenCalledWith('CharacterSelect');
  });

  it('контроль: не-Enter в поле пароля запрос не шлёт', () => {
    const s = setup();
    s.pass.keydown('a');
    s.pass.keydown('Tab');
    expect(loginMock).not.toHaveBeenCalled();
  });
});

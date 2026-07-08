import Phaser from 'phaser';
import { App } from '../core/app.js';
import { login, register } from '../modules/auth/authApi.js';
import { FONT_TITLE } from '../ui/kit.js';

/**
 * Экран входа/регистрации (DOM-форма). Аккаунт = ник+пароль (сервер, `/api/register|login`).
 * При успехе сохраняет сессию в `App.auth` (+localStorage) и ведёт на выбор персонажа.
 */
export class LoginScene extends Phaser.Scene {
  private root?: HTMLElement;

  constructor() { super('Login'); }

  create(): void {
    const app = App.from(this);
    const host = document.getElementById('ui-root') ?? document.body;
    const box = document.createElement('div');
    // Фон — та же картинка меню (public/menu-bg.png): вписана по ВЫСОТЕ (`auto 100%`), по центру,
    // бока залиты чёрным (`#000`); сверху затемнение для читаемости формы. Нет файла → просто чёрный.
    box.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;'
      + 'background:linear-gradient(rgba(6,6,12,0.6),rgba(6,6,12,0.6)),url(/menu-bg.png) center/auto 100% no-repeat,#000;z-index:80';
    box.innerHTML = `<div style="background:#171b24;border:1px solid #2b323f;border-radius:10px;padding:26px 28px;min-width:300px;color:#e6ddc9;text-align:center">
      <div style="font-family:${FONT_TITLE};font-size:26px;letter-spacing:1px;margin-bottom:4px;color:#e0b45a">Dungeon Master</div>
      <div class="sub" style="font-size:13px;color:#8f897c;margin-bottom:16px">Вход в аккаунт</div>
      <input class="u" placeholder="Ник" maxlength="20" autocomplete="username"
        style="display:block;width:100%;margin:6px 0;padding:9px;background:#0f131a;color:#e6ddc9;border:1px solid #2b323f;border-radius:6px;box-sizing:border-box">
      <input class="p" type="password" placeholder="Пароль" maxlength="200" autocomplete="current-password"
        style="display:block;width:100%;margin:6px 0;padding:9px;background:#0f131a;color:#e6ddc9;border:1px solid #2b323f;border-radius:6px;box-sizing:border-box">
      <button class="go" style="display:block;width:100%;margin:10px 0 6px;padding:10px;background:#3a2c15;color:#f0d9a8;border:1px solid #e39a3c;border-radius:6px;cursor:pointer;font-size:15px">Войти</button>
      <div class="err" style="min-height:16px;font-size:12px;color:#c85a48;margin:4px 0"></div>
      <div style="font-size:12px;color:#8f897c">
        <span class="switch-label">Нет аккаунта?</span>
        <a class="switch" style="color:#7fa8d0;cursor:pointer;text-decoration:underline">Регистрация</a>
      </div>
    </div>`;
    host.appendChild(box);
    this.root = box;

    const $ = <T extends HTMLElement>(s: string) => box.querySelector(s) as T;
    const u = $<HTMLInputElement>('.u');
    const p = $<HTMLInputElement>('.p');
    const err = $<HTMLElement>('.err');
    const go = $<HTMLButtonElement>('.go');
    let mode: 'login' | 'register' = 'login';

    const setMode = (m: 'login' | 'register'): void => {
      mode = m;
      $<HTMLElement>('.sub').textContent = m === 'login' ? 'Вход в аккаунт' : 'Регистрация';
      go.textContent = m === 'login' ? 'Войти' : 'Создать аккаунт';
      $<HTMLElement>('.switch-label').textContent = m === 'login' ? 'Нет аккаунта?' : 'Уже есть аккаунт?';
      $<HTMLElement>('.switch').textContent = m === 'login' ? 'Регистрация' : 'Вход';
      err.textContent = '';
    };
    $<HTMLElement>('.switch').addEventListener('click', () => setMode(mode === 'login' ? 'register' : 'login'));

    const submit = async (): Promise<void> => {
      err.textContent = '';
      go.disabled = true;
      try {
        const session = await (mode === 'login' ? login(u.value.trim(), p.value) : register(u.value.trim(), p.value));
        app.setAuth(session);
        this.scene.start('CharacterSelect');
      } catch (e) {
        err.textContent = (e as Error).message;
        go.disabled = false;
      }
    };
    go.addEventListener('click', () => void submit());
    p.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') void submit(); });
    setTimeout(() => u.focus(), 50);

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => { this.root?.remove(); this.root = undefined; });
  }
}

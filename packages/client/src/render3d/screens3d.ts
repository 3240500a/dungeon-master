/**
 * DOM-экраны авторизации 3D-клиента (аналог Phaser-сцен Login/CharacterSelect/ClassSelect, но чистый DOM
 * поверх Three.js-канваса). Reuse `authApi` (сервер — единственная истина аккаунтов) + `listClasses` (конфиг).
 * `runAuthFlow(app, root)` показывает вход → выбор/создание персонажа и РЕЗОЛВИТСЯ, когда `app.auth` и
 * `app.pendingCharId` готовы — дальше `online3d` подключается к миру. Игра только онлайн (оффлайна нет).
 */
import type { App } from '../core/app.js';
import { login, register, listCharacters, createCharacter, deleteCharacter, type CharacterSummary } from '../modules/auth/authApi.js';
import { listClasses } from '../modules/classes/index.js';

const TITLE = "'Cinzel','Forum',Georgia,serif";
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, css = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag); if (css) e.style.cssText = css; if (text) e.textContent = text; return e;
};
const btn = (label: string, onClick: () => void, accent = '#6f9bcf'): HTMLButtonElement => {
  const b = el('button', `display:block;width:100%;margin:6px 0;padding:10px;background:#1c2130;color:#e6e6ee;border:1px solid ${accent};border-radius:8px;cursor:pointer;font:15px ${TITLE}`, label);
  b.addEventListener('click', onClick); return b;
};

/** Полноэкранный оверлей-экран (центрированная карточка). */
function screen(root: HTMLElement): { card: HTMLElement; close: () => void } {
  const overlay = el('div', 'position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;background:radial-gradient(ellipse at center,#12131c 0%,#05060a 80%);pointer-events:auto');
  const card = el('div', 'background:#141822;border:1px solid #2b323f;border-radius:12px;padding:26px 30px;min-width:320px;max-width:min(94vw,860px);max-height:88vh;overflow:auto;color:#e6ddc9;box-shadow:0 16px 50px rgba(0,0,0,0.6)');
  overlay.appendChild(card); root.appendChild(overlay);
  return { card, close: () => overlay.remove() };
}

/** Запустить поток авторизации. Резолвится, когда выбран персонаж (`app.pendingCharId` установлен). */
export function runAuthFlow(app: App, root: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    const showLogin = (): void => {
      const { card, close } = screen(root);
      card.append(el('h1', `font:28px ${TITLE};color:#e0b45a;margin:0 0 4px;text-align:center;letter-spacing:2px`, 'DUNGEON MASTER · 3D'));
      card.append(el('div', 'color:#8a90a4;text-align:center;margin-bottom:18px;font-size:13px', 'Онлайн · вход в аккаунт'));
      const u = el('input', 'display:block;width:100%;box-sizing:border-box;margin:6px 0;padding:10px;background:#0f131a;color:#e6ddc9;border:1px solid #3e4756;border-radius:6px;font-size:15px'); u.placeholder = 'Логин'; u.autocomplete = 'username';
      const p = el('input', 'display:block;width:100%;box-sizing:border-box;margin:6px 0;padding:10px;background:#0f131a;color:#e6ddc9;border:1px solid #3e4756;border-radius:6px;font-size:15px'); p.type = 'password'; p.placeholder = 'Пароль'; p.autocomplete = 'current-password';
      const err = el('div', 'color:#c85a48;font-size:13px;min-height:18px;margin:6px 0;text-align:center');
      card.append(u, p, err);
      let busy = false;
      const go = async (fn: typeof login): Promise<void> => {
        if (busy) return; busy = true; err.textContent = '';
        try {
          const auth = await fn(u.value.trim(), p.value);
          app.setAuth(auth); close(); showCharacters();
        } catch (e) { err.textContent = (e as Error).message; busy = false; }
      };
      card.append(btn('Войти', () => void go(login), '#8aa84a'), btn('Регистрация', () => void go(register)));
      card.append(btn('← В меню', () => { close(); showMainMenu(); }, '#6a3a3a'));
      p.addEventListener('keydown', (e) => { if (e.key === 'Enter') void go(login); });
      setTimeout(() => u.focus(), 50);
    };

    const showCharacters = (): void => {
      const { card, close } = screen(root);
      card.append(el('h1', `font:26px ${TITLE};color:#e0b45a;margin:0 0 16px;text-align:center`, 'Выбор персонажа'));
      const listBox = el('div', 'min-height:60px');
      card.append(listBox);
      const status = el('div', 'color:#8a90a4;text-align:center;font-size:13px;margin:8px 0');
      card.append(status);
      status.textContent = 'Загрузка…';
      const refresh = async (): Promise<void> => {
        let chars: CharacterSummary[] = [];
        try { chars = await listCharacters(app.auth!.token); }
        catch (e) { const m = (e as Error).message; if (/вход|401/i.test(m)) { app.clearAuth(); close(); showLogin(); return; } status.textContent = m; return; }
        listBox.innerHTML = ''; status.textContent = '';
        if (!chars.length) listBox.append(el('div', 'color:#8a90a4;text-align:center;font-size:13px;margin:10px 0', 'Нет персонажей — создайте нового.'));
        for (const c of chars) {
          const row = el('div', 'display:flex;align-items:center;gap:10px;margin:6px 0;padding:10px 12px;background:#1c2130;border:1px solid #39405a;border-radius:8px');
          const info = el('div', 'flex:1;cursor:pointer');
          info.append(el('div', 'font-size:16px;color:#e6ddc9', c.name), el('div', 'font-size:12px;color:#8a90a4', `${classNameOf(c.classId)} · ур. ${c.level}`));
          info.addEventListener('click', () => { app.pendingCharId = c.charId; close(); resolve(); });
          const del = el('button', 'padding:6px 10px;background:#3a1e1e;color:#e6bcae;border:1px solid #6a3a3a;border-radius:6px;cursor:pointer', '✕');
          del.addEventListener('click', () => { void (async () => { if (!confirm(`Удалить «${c.name}»?`)) return; try { await deleteCharacter(app.auth!.token, c.charId); void refresh(); } catch (e) { status.textContent = (e as Error).message; } })(); });
          row.append(info, del); listBox.append(row);
        }
      };
      const classNameOf = (id: string): string => listClasses(app.config).find((c) => c.id === id)?.name ?? id;
      card.append(btn('+ Новый персонаж', () => { close(); showCreate(); }, '#8aa84a'));
      card.append(btn('← В меню', () => { close(); showMainMenu(); }, '#6f9bcf'));
      card.append(btn('Выйти из аккаунта', () => { app.clearAuth(); close(); showLogin(); }, '#6a3a3a'));
      void refresh();
    };

    const showCreate = (): void => {
      const { card, close } = screen(root);
      card.append(el('h1', `font:26px ${TITLE};color:#e0b45a;margin:0 0 12px;text-align:center`, 'Создание персонажа'));
      const name = el('input', 'display:block;margin:0 auto 14px;width:240px;box-sizing:border-box;padding:9px;text-align:center;background:#0f131a;color:#e6ddc9;border:1px solid #3e4756;border-radius:6px;font-size:15px'); name.placeholder = 'Имя героя'; name.maxLength = 16;
      card.append(name);
      const grid = el('div', 'display:flex;gap:12px;flex-wrap:wrap;justify-content:center');
      card.append(grid);
      const err = el('div', 'color:#c85a48;font-size:13px;min-height:18px;margin:10px 0;text-align:center');
      let busy = false;
      for (const cls of listClasses(app.config)) {
        const a = cls.startAttributes;
        const cardC = el('div', 'width:150px;padding:12px;background:#1c2130;border:1px solid #39405a;border-radius:10px;cursor:pointer;text-align:center');
        cardC.append(el('div', 'font-size:17px;color:#e6ddc9;margin-bottom:6px', cls.name));
        cardC.append(el('div', 'font-size:12px;color:#c4bca8;line-height:1.5', `Сила ${a.strength} · Ловк ${a.dexterity}\nИнт ${a.intelligence} · Жив ${a.vitality}`));
        cardC.addEventListener('mouseenter', () => { cardC.style.borderColor = '#e39a3c'; });
        cardC.addEventListener('mouseleave', () => { cardC.style.borderColor = '#39405a'; });
        cardC.addEventListener('click', () => { void (async () => {
          if (busy) return; busy = true; err.textContent = '';
          try { const ch = await createCharacter(app.auth!.token, cls.id, name.value.trim() || 'Герой'); app.pendingCharId = ch.charId; close(); resolve(); }
          catch (e) { const m = (e as Error).message; if (/вход|401/i.test(m)) { app.clearAuth(); close(); showLogin(); return; } err.textContent = m; busy = false; }
        })(); });
        grid.append(cardC);
      }
      card.append(err, btn('← Назад', () => { close(); showCharacters(); }, '#6a3a3a'));
      setTimeout(() => name.focus(), 50);
    };

    // Титульный экран (как 2D MainMenuScene): «Играть» → вход/персонажи, «Редактор» → HTML-редактор конфигов.
    const showMainMenu = (): void => {
      const { card, close } = screen(root);
      card.append(el('h1', `font:36px ${TITLE};color:#e0b45a;margin:0 0 4px;text-align:center;letter-spacing:3px`, 'DUNGEON MASTER'));
      card.append(el('div', 'color:#8a90a4;text-align:center;margin-bottom:24px;font-size:14px;letter-spacing:3px', '3D · ОНЛАЙН'));
      card.append(btn('Играть', () => { close(); if (app.auth) showCharacters(); else showLogin(); }, '#8aa84a'));
      card.append(btn('Редактор', () => { window.open('/editor/', '_blank'); }, '#e39a3c'));
    };

    showMainMenu();
  });
}

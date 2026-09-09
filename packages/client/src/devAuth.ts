/**
 * ДОСТУП К ИНСТРУМЕНТАЛЬНЫМ РОУТАМ (`/api/dev/*`) — общий для поз-редактора и редактора конфигов.
 *
 * ЗАЧЕМ. Раньше эти роуты пускали по адресу сокета: «запрос пришёл с локальной машины». Это не
 * пропуск, а его видимость — браузер разработчика тоже локальный, значит под гейт подпадала ЛЮБАЯ
 * открытая в нём страница и могла переписать баланс, файлы `data/*.json` и залить 64-мегабайтный
 * ассет. Теперь сервер требует роль `admin` (или `DM_ADMIN_KEY` для процессов), а этот модуль —
 * единственное место в клиенте, которое хранит токен и подставляет его в запросы.
 *
 * ⚠ ТОКЕН НЕ КЛАДЁТСЯ В `pe_*`. Ключи `pe_*` — рабочая копия, которую кнопка «Опубликовать»
 * отправляет НА СЕРВЕР целиком (`poseServer.POSE_KEYS`). Учётные данные не должны ездить вместе
 * с контентом ни при каких обстоятельствах, поэтому у токена свой ключ и своя жизнь.
 */
import { login as apiLogin } from './modules/auth/authApi.js';

const KEY = 'dm_admin_token';

export const getDevToken = (): string => { try { return localStorage.getItem(KEY) ?? ''; } catch { return ''; } };
export const setDevToken = (t: string): void => { try { t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY); } catch { /* приватный режим */ } };

/** Одно окно входа на все параллельные отказы: десять запросов, упавших в 401, не должны открыть десять форм. */
let pending: Promise<boolean> | null = null;

/**
 * Запрос к инструментальному роуту. При 401 показывает вход и ПОВТОРЯЕТ запрос один раз.
 * При 403 (вошёл, но роль не та) не повторяет — это не решается повторным вводом пароля.
 */
export async function devFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const send = (): Promise<Response> => {
    const token = getDevToken();
    return fetch(url, { ...init, headers: { ...(init.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  };
  let res = await send();
  if (res.status === 401) {
    // Тело первого ответа не читаем и не используем — важен только статус; повтор пойдёт с токеном.
    if (await requireDevLogin()) res = await send();
  }
  return res;
}

/** Показать вход, если токена нет или он не подошёл. `true` — токен в наличии. */
export function requireDevLogin(): Promise<boolean> {
  return (pending ??= openLoginModal().finally(() => { pending = null; }));
}

/** Выйти: токен забывается, следующий инструментальный запрос снова спросит вход. */
export function devLogout(): void { setDevToken(''); }

// ── Окно входа ───────────────────────────────────────────────────────────────────────────────────
// Голый DOM с инлайновыми стилями намеренно: модуль общий для двух приложений с РАЗНЫМИ
// UI-китами, и тащить сюда любой из них — значит связать их друг с другом ради одной формы.
function openLoginModal(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;font:13px system-ui,sans-serif';
    const box = document.createElement('div');
    box.style.cssText = 'background:#1b1f2a;color:#dfe6f3;border:1px solid #39435a;border-radius:8px;padding:18px;min-width:320px;display:flex;flex-direction:column;gap:8px';
    const title = document.createElement('div');
    title.textContent = 'Вход администратора';
    title.style.cssText = 'font-weight:600;font-size:15px';
    const hint = document.createElement('div');
    hint.textContent = 'Правка конфигов, заливка моделей и публикация контента требуют учётной записи с ролью admin. Роль выдаётся командой npm run grant-admin.';
    hint.style.cssText = 'opacity:.7;line-height:1.4';
    const inp = (ph: string, type = 'text'): HTMLInputElement => {
      const i = document.createElement('input');
      i.type = type; i.placeholder = ph;
      i.style.cssText = 'background:#11141c;color:#dfe6f3;border:1px solid #39435a;border-radius:4px;padding:7px 9px;font:inherit';
      return i;
    };
    const user = inp('логин'), pass = inp('пароль', 'password'), key = inp('или ключ DM_ADMIN_KEY', 'password');
    const err = document.createElement('div');
    err.style.cssText = 'color:#ff8a8a;min-height:16px';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:4px';
    const mk = (t: string): HTMLButtonElement => {
      const b = document.createElement('button'); b.textContent = t;
      b.style.cssText = 'background:#2a3345;color:#dfe6f3;border:1px solid #4a5670;border-radius:4px;padding:7px 14px;font:inherit;cursor:pointer';
      return b;
    };
    const cancel = mk('отмена'), ok = mk('войти');

    const close = (v: boolean): void => { wrap.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close(false); };
    const submit = (): void => {
      err.textContent = '';
      // Ключ — путь для тех, у кого нет аккаунта (скрипты, чужая машина): он и есть готовый токен.
      if (key.value.trim()) { setDevToken(key.value.trim()); close(true); return; }
      ok.disabled = true;
      void apiLogin(user.value.trim(), pass.value)
        .then((s) => { setDevToken(s.token); close(true); })
        .catch((e: unknown) => { err.textContent = e instanceof Error ? e.message : 'не вышло войти'; ok.disabled = false; });
    };
    ok.onclick = submit;
    cancel.onclick = () => close(false);
    for (const i of [user, pass, key]) i.onkeydown = (e): void => { if (e.key === 'Enter') submit(); };
    document.addEventListener('keydown', onKey);

    row.append(cancel, ok);
    box.append(title, hint, user, pass, key, err, row);
    wrap.append(box);
    document.body.append(wrap);
    user.focus();
  });
}

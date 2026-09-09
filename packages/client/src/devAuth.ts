/**
 * ДОСТУП К ИНСТРУМЕНТАЛЬНЫМ РОУТАМ (`/api/dev/*`) — общий для поз-редактора и редактора конфигов.
 *
 * ЗАЧЕМ. Раньше эти роуты пускали по адресу сокета: «запрос пришёл с локальной машины». Это не
 * пропуск, а его видимость — браузер разработчика тоже локальный, значит под гейт подпадала ЛЮБАЯ
 * открытая в нём страница и могла переписать баланс, файлы `data/*.json` и залить 64-мегабайтный
 * ассет. Теперь сервер требует роль `admin` (или `DM_ADMIN_KEY` для процессов), а этот модуль —
 * единственное место в клиенте, которое хранит токен и подставляет его в запросы.
 *
 * ДВА РЕЖИМА, и это намеренно:
 *  • `ensureAdmin()` — ВХОД НА ВХОДЕ. Редакторы зовут его ДО того, как что-либо показать:
 *    без прав администратора инструмент не открывается вообще. Отмены здесь нет.
 *  • `devFetch()` — подставляет токен и переспрашивает вход, если сервер ответил 401
 *    (сессию могли отозвать посреди работы — терять из-за этого правку нельзя).
 *
 * САМ ПО СЕБЕ ЭКРАН ВХОДА — НЕ ЗАЩИТА, а удобство и честная граница: страница — это код
 * в браузере, его можно обойти. Защищает СЕРВЕР: `/api/dev/*` и публикация требуют роли
 * на КАЖДОМ запросе. Экран убирает две другие беды: инструмент не выглядит открытым для всех,
 * и правка не упирается в отказ после часа работы.
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
  return (pending ??= openLoginModal(false).finally(() => { pending = null; }));
}

/** Кто вошёл. `via: 'key'` — не человек, а ключ процессов, имени у него нет. */
export interface DevIdentity { username?: string; role: string; via: 'session' | 'key' }

/**
 * Спросить у СЕРВЕРА, кто мы. Именно у сервера, а не у localStorage: роль могли снять,
 * сессию отозвать, ключ сменить — сохранённая строка об этом не знает.
 */
export async function whoAmI(): Promise<DevIdentity | null> {
  const token = getDevToken();
  if (!token) return null;
  try {
    const res = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    return await res.json() as DevIdentity;
  } catch { return null; }        // сервер не поднят — это не «нет прав», разбирается вызывающий
}

/**
 * ВХОД НА ВХОДЕ в инструмент. Не возвращается, пока не вошли админом: отмены нет,
 * потому что половинчатый редактор без прав — хуже закрытого.
 *
 * Сервер недоступен — НЕ ЗАПИРАЕМ. Редактор умеет работать оффлайн на рабочей копии
 * (так задумано в `poseServer`), и превращать падение сервера в потерю инструмента нельзя.
 * Публиковать всё равно не выйдет — это решает сервер, когда поднимется.
 */
export async function ensureAdmin(): Promise<DevIdentity | null> {
  for (;;) {
    const me = await whoAmI();
    if (me?.role === 'admin') return me;
    if (me) {
      // Вошли, но роль не та: повторный ввод пароля этого не чинит — говорим прямо.
      setDevToken('');
      await openLoginModal(true, `Вы вошли как «${me.username ?? '?'}», но у этого аккаунта нет прав администратора.`);
      continue;
    }
    if (getDevToken()) setDevToken('');   // токен есть, но сервер его не знает — хранить мусор незачем
    // Сервер мог быть просто не поднят. Различаем это от «нет прав» отдельной проверкой.
    if (!await serverAlive()) return null;
    await openLoginModal(true);
  }
}

/** Жив ли сервер. Без этого отказ сети неотличим от отказа в доступе. */
async function serverAlive(): Promise<boolean> {
  try { return (await fetch('/api/health')).ok; } catch { return false; }
}

/** Выйти: токен забывается, следующий инструментальный запрос снова спросит вход. */
export function devLogout(): void { setDevToken(''); }

// ── Окно входа ───────────────────────────────────────────────────────────────────────────────────
// Голый DOM с инлайновыми стилями намеренно: модуль общий для двух приложений с РАЗНЫМИ
// UI-китами, и тащить сюда любой из них — значит связать их друг с другом ради одной формы.
function openLoginModal(blocking = false, why = ''): Promise<boolean> {
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
    if (why) err.textContent = why;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:4px';
    const mk = (t: string): HTMLButtonElement => {
      const b = document.createElement('button'); b.textContent = t;
      b.style.cssText = 'background:#2a3345;color:#dfe6f3;border:1px solid #4a5670;border-radius:4px;padding:7px 14px;font:inherit;cursor:pointer';
      return b;
    };
    const cancel = mk('отмена'), ok = mk('войти');
    // В блокирующем режиме уходить некуда: за формой пустая страница, отмена лишь создала бы видимость выбора.
    if (blocking) cancel.style.display = 'none';

    const close = (v: boolean): void => { wrap.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape' && !blocking) close(false); };
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

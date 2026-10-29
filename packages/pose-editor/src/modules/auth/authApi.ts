/**
 * REST-клиент аккаунтов (база `/api`, Vite проксирует на сервер :3001). Все вызовы бросают
 * `Error` с текстом сервера при не-ok — UI показывает сообщение. Игра требует сервер (оффлайна нет).
 */
export interface AuthSession { token: string; userId: string; username: string; }
export interface CharacterSummary { charId: string; name: string; classId: string; level: number; }

const BASE = '/api';

async function api<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const { token, headers, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...rest,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
    });
  } catch {
    throw new Error('Сервер недоступен');
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) throw new Error(data.error ?? `Ошибка ${res.status}`);
  return data;
}

/**
 * ⭐ R11-05: ТОКЕН УСТРОЙСТВА — сервер выдаёт его на верный пароль и регистрацию, клиент хранит по нику (`dm:device:<ник>`) и шлёт
 * со входом в этот ник. С ним вход не упирается в общий лимит адреса: соседа по NAT, чей лимит адреса опустошил тролль неверными
 * паролями, этот вход обходит (его держит лимит ника). Пароль нужен как прежде; хранилища нет (приватный режим) — вход как раньше.
 */
const deviceKey = (username: string): string => `dm:device:${username.trim().toLowerCase()}`;
function deviceOf(username: string): string | undefined {
  try { return localStorage.getItem(deviceKey(username)) ?? undefined; } catch { return undefined; }
}
function keepDevice(username: string, s: AuthSession & { device?: unknown }): AuthSession {
  if (typeof s.device === 'string') { try { localStorage.setItem(deviceKey(username), s.device); } catch { /* нет хранилища */ } }
  return { token: s.token, userId: s.userId, username: s.username };   // в сессию (`dm:auth`) токен устройства не идёт
}

export const register = (username: string, password: string): Promise<AuthSession> =>
  api<AuthSession>('/register', { method: 'POST', body: JSON.stringify({ username, password }) }).then((s) => keepDevice(username, s));

export const login = (username: string, password: string): Promise<AuthSession> =>
  api<AuthSession>('/login', { method: 'POST', body: JSON.stringify({ username, password, device: deviceOf(username) }) })
    .then((s) => keepDevice(username, s));

export const logout = (token: string): Promise<void> =>
  api('/logout', { method: 'POST', token }).then(() => undefined);

export const listCharacters = (token: string): Promise<CharacterSummary[]> =>
  api<{ characters: CharacterSummary[] }>('/characters', { token }).then((r) => r.characters);

export const createCharacter = (token: string, classId: string, name: string): Promise<CharacterSummary> =>
  api<{ character: CharacterSummary }>('/characters', { method: 'POST', token, body: JSON.stringify({ classId, name }) }).then((r) => r.character);

export const deleteCharacter = (token: string, charId: string): Promise<void> =>
  api(`/characters/${encodeURIComponent(charId)}`, { method: 'DELETE', token }).then(() => undefined);

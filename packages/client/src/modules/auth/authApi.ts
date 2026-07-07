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

export const register = (username: string, password: string): Promise<AuthSession> =>
  api('/register', { method: 'POST', body: JSON.stringify({ username, password }) });

export const login = (username: string, password: string): Promise<AuthSession> =>
  api('/login', { method: 'POST', body: JSON.stringify({ username, password }) });

export const logout = (token: string): Promise<void> =>
  api('/logout', { method: 'POST', token }).then(() => undefined);

export const listCharacters = (token: string): Promise<CharacterSummary[]> =>
  api<{ characters: CharacterSummary[] }>('/characters', { token }).then((r) => r.characters);

export const createCharacter = (token: string, classId: string, name: string): Promise<CharacterSummary> =>
  api<{ character: CharacterSummary }>('/characters', { method: 'POST', token, body: JSON.stringify({ classId, name }) }).then((r) => r.character);

export const deleteCharacter = (token: string, charId: string): Promise<void> =>
  api(`/characters/${encodeURIComponent(charId)}`, { method: 'DELETE', token }).then(() => undefined);

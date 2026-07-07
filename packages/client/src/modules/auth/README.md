# Модуль: auth (аккаунты + сессия)

Вход по нику+паролю; персонажи принадлежат аккаунту и хранятся на СЕРВЕРЕ. Клиент держит
только сессию (`dm:auth` в localStorage) — весь ростер и сейвы приходят с сервера (анти-чит).

- **API:** `authApi.ts` — `register/login/logout`, `listCharacters/createCharacter/deleteCharacter`
  (fetch на `/api`, токен в `Authorization: Bearer`). Не-ok → `Error` с текстом сервера. Оффлайна нет.
- **Стор:** в `App` — `auth: {token,userId,username} | null` (персист `dm:auth`), `pendingCharId`
  (выбранный персонаж для входа). `App.setAuth/clearAuth`. Токен валидируется ленивым
  `GET /api/characters` (401 → `clearAuth` → экран входа).
- **Сцены:** `LoginScene` (вход/регистрация) → `CharacterSelectScene` (ростер с сервера,
  «Создать»/«Удалить»/«Выйти») → `ClassSelectScene` (`POST /api/characters`) → `OnlineScene`
  (join `{token, charId}`; полный сейв приходит в `joined`).
- **Сервер:** `packages/server` — `/api/register|login|logout`, `/api/characters` CRUD
  (`requireAuth` по токену). Пароль — scrypt+соль (`auth/password.ts`, без зависимостей),
  сессия — токен в БД (`node:sqlite`: таблицы `users`/`sessions`/`characters`). WS-join проверяет
  сессию и ВЛАДЕНИЕ персонажем (`characters.userId`); чужой `charId` → `forbidden`.
- **На будущее:** `charId`/token — гостевая модель без 2FA; email-верификация, rate-limit брутфорса,
  refresh-токены — вне объёма. Прод: обязательно https/wss (токен идёт в join-кадре/заголовке).

# Модуль: auth (аккаунты + сессия)

Вход по нику+паролю; персонажи принадлежат аккаунту и хранятся на СЕРВЕРЕ. Клиент держит
только сессию (`dm:auth` в localStorage) — весь ростер и сейвы приходят с сервера (анти-чит).

- **API:** `authApi.ts` — `register/login/logout`, `listCharacters/createCharacter/deleteCharacter`
  (fetch на `/api`, токен в `Authorization: Bearer`). Не-ok → `Error` с текстом сервера. Оффлайна нет.
- **Стор:** в `App` — `auth: {token,userId,username} | null` (персист `dm:auth`), `pendingCharId`
  (выбранный персонаж для входа). `App.setAuth/clearAuth`. Токен валидируется ленивым
  `GET /api/characters` (401 → `clearAuth` → экран входа).
- **Выход (R11-15):** `signOut.ts` — `signOut(app)`, ОДИН шов для 2D («Выйти» `CharacterSelectScene`) и веб-3D («Выйти из
  аккаунта» `render3d/screens3d.ts`): токен уходит `POST /api/logout` (сервер удаляет сессию), вход страница забывает сразу
  (`clearAuth`), сервер недоступен — всё равно вышли. Раньше веб-3D только стирал `dm:auth`, и токен жил на сервере неделю
  (срок продлевается на каждом запросе) у любого, кто его унёс. `clearAuth` сам сервер не зовёт — он для протухшего токена
  (401), где гасить нечего. Сторожа — `signOut.test.ts`, `render3d/screens3d.test.ts`.
- **Сцены:** `LoginScene` (вход/регистрация) → `CharacterSelectScene` (ростер с сервера,
  «Создать»/«Удалить»/«Выйти») → `ClassSelectScene` (`POST /api/characters`) → `OnlineScene`
  (join `{token, charId}`; полный сейв приходит в `joined`).
  ⚠ Phaser держит ОДИН экземпляр сцены на страницу: `scene.start` лишь заново зовёт `create()`, поля переживают
  показ. Состояние показа сбрасывать в `create()` — R9-15: флаг «запрос создания в пути» `ClassSelectScene` был полем
  и после успеха (мир → возврат в «Персонажей») или 401 («Вход» → снова «Создать») глушил все карточки до F5. Теперь
  флаг — на показ (как `busy` в `screens3d.showCreate`); сторож — `scenes/ClassSelectScene.test.ts`.
  ⭐ R13-15: `LoginScene` держит флаг «запрос в пути» на ОБА пути отправки — кнопку и Enter в поле пароля (как `busy` в
  `screens3d.showLogin`). Раньше его держала только кнопка (`disabled` глушит лишь её `click`): двойной Enter, автоповтор
  или клик и Enter слали второй `/api/login|register` — лишняя сессия и поворот токена устройства, двойной расход жетонов
  лимитера входа (по нику и по адресу), на регистрации — «ник занят» поверх успеха. Сторож — `scenes/LoginScene.test.ts`.
- **Сервер:** `packages/server` — `/api/register|login|logout`, `/api/characters` CRUD
  (`requireAuth` по токену). Пароль — scrypt+соль (`auth/password.ts`, без зависимостей),
  сессия — токен в БД (Postgres: таблицы `users`/`sessions`/`characters`). WS-join проверяет
  сессию и ВЛАДЕНИЕ персонажем (`characters.userId`); чужой `charId` → `forbidden`.
- **Токен устройства (R11-05):** `/api/login` и `/api/register` отдают `device` — `authApi` хранит его по нику
  (`dm:device:<ник>`, не в `dm:auth`) и шлёт со следующим входом в этот ник. С ним вход не упирается в общий лимит адреса
  (сосед по NAT, опустошивший его неверными паролями, этот вход не запирает); пароль нужен как прежде. Сторож — `authApi.test.ts`.
- **На будущее:** `charId`/token — гостевая модель без 2FA; email-верификация, rate-limit брутфорса,
  refresh-токены — вне объёма. Прод: обязательно https/wss (токен идёт в join-кадре/заголовке).

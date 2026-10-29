# CLAUDE.md — карта проекта (индекс-«якорь»)

Онлайн dungeon-crawler в духе Diablo 2. Top-down экшн-RPG: город → процедурное
подземелье → лут → экипировка → прокачка → смерть/возврат → город. Стек: **Node + Express +
Postgres** (сервер, TypeScript), **Unity** (клиент — отдельный репозиторий `ashes of the past`),
**HTML-редактор** конфигов и **поз-редактор** анимаций (Vite). Всё, что касается баланса и контента, —
data-driven (JSON + zod-схемы).

> ⭐⭐ **Сервер авторитетен во всём (29.10.2026).** Все механики живут на сервере (`packages/shared` —
> правила, `packages/server` — исполнение); клиент только рисует то, что шлёт сервер: мир — видом пати
> (туман войны, `reveal`), интерактивы — `FloorInit.interactables`, модели окон — кадрами `view`/`hero`
> (`shared/src/views`). Своих формул правил у клиента нет. Сервер самодостаточен: стартует и проходит
> тесты без веб-клиента.

> **Как пользоваться этим файлом:** это оглавление. При доработке любой механики открой
> строку модуля ниже → перейди в его папку и `README.md` → там контракт, события, конфиг,
> формулы и тесты именно этой части. Полная таблица связей — в [docs/MODULE_MAP.md](docs/MODULE_MAP.md).

## Архитектурные принципы (не нарушать)
1. **Модули изолированы.** Общаются только через типизированный **Event Bus**
   (`packages/shared/src/events`) и общие типы (`packages/shared/src/types`). Модуль НЕ
   импортирует внутренности другого модуля.
2. **Данные отделены от кода.** Все правила/баланс/контент — в `packages/shared/src/config/data`
   через zod-схемы. Тот же реестр читает игра и HTML-редактор.
3. **Формулы чистые.** Вся математика — в `packages/shared/src/formulas` (без Phaser/DOM),
   покрыта юнит-тестами, переиспользуется клиентом и сервером (анти-чит).
4. **Definition of Done для любой правки:** обновить `README.md` модуля и строку в
   [docs/MODULE_MAP.md](docs/MODULE_MAP.md).

## Общие UI/мир-хелперы
- `client/src/ui/domUi.ts` — менеджер НЕСКОЛЬКИХ плавающих окон (инвентарь+скиллы одновременно), перетаскиваемых.
- `client/src/ui/kit.ts` — UI-кит (кнопки, вкладки, слоты-иконки, тултипы, тема) для всех панелей.
- `client/src/world/lineOfSight.ts` — прямая видимость по сетке (восприятие монстров, туман).
- `client/src/world/fogOfWar.ts` — туман войны (RenderTexture, раскрытие по LoS).
- Боевые формулы — `shared/formulas/combat.ts` (`resolveAttack`), стат-блок игрока —
  `client/src/modules/combat/playerStats.ts`, монстров — `shared/formulas/monstergen.ts`.
- `client/src/world/tileWorld.ts`, `grid.ts` — сетка мира и её отрисовка.

## Структура
- `packages/shared` — типы, формулы, события, config registry, протокол (`session/netTypes.ts`, `netSchemas.ts`), виды окон
  (`views/`). Общий фундамент: его исполняет сервер, его же зовёт редактор.
- `packages/server` — Express + Postgres (`db/pool.ts`, доступ АСИНХРОННЫЙ): аккаунты и ростер (`/api/register|login|characters`),
  конфиг (`/api/config`), модели (`/assets`), игра — WebSocket `/ws` (`net/roomManager.ts` → `net/room.ts` → `GameSession`),
  инструменты — `/api/dev/*` (только вне продакшена и с ролью admin). Роль процесса (`DM_ROLE`): supervisor / gateway / node / single.
- `packages/craft-mesh` — модель оружия из деталей (three): её печёт сервер (DMCM/GLB для Unity), ею меряет клинки редактор.
- `packages/pose-editor` — поз-редактор анимаций (Three.js + Jolt), `pose-editor.html`; пишет `/api/dev/pose`, Unity читает.
- `packages/editor` — HTML-редактор конфигов (страницы по механикам, CRUD, live-apply).
- `packages/client` — ⚠ веб-клиент (Phaser 2D и Three.js 3D) — НЕ поддерживается, на него ничего не опирается; уходит из ветки.

## Модули веб-клиента (`packages/client/src/modules/`) — ⚠ не поддерживается, справочно
| Модуль | Что делает | Статус |
|---|---|---|
| movement | WASD-движение, коллизии | готово |
| combat | оружие, базовая атака, расчёт боя, каст скиллов | готово |
| dungeon-gen | процедурная генерация этажей | готово |
| loot | генерация случайных предметов, дроп | готово |
| inventory | инвентарь, экипировка, требования | готово |
| classes | Воин/Маг/Лучник, выбор класса | готово |
| skills | единое РАДИАЛЬНОЕ древо скилов (актив+пассив, для всех; за очки скилла, сброс за золото; выносливость/мана) | готово |
| mastery | дерево мастерства (общие %-пассивы; за золото + очки мастерства) | готово |
| progression | атрибуты, XP, распределение очков | готово |
| town | магазин, кузница, мастер прокачки | готово |
| quests | основные + случайные квесты (серверные) | готово |
| death | смерть, возврат, потеря лута | готово |
| auth | аккаунты (логин/пароль), серверный ростер персонажей | готово |
| sfx | звуковые заглушки (WebAudio) на события | готово |

## Команды
- `npm install` — установка (workspaces).
- `npm run dev` — сервер (Express) + поз-редактор (Vite, http://localhost:5173/pose-editor.html) параллельно.
- `npm run editor` — HTML-редактор конфигов.
- `npm test` — юнит-тесты формул (vitest).

## Клиенты
- **Unity** — единственный игровой клиент (`C:\work\Games_Art\Games_Art\ashes of the past\Ashes of the past`, `Assets/DM`):
  тот же `/api` + `/ws`; проверка без редактора — `tools/unity-check/unity_check.py`.
- **Веб (2D Phaser, 3D Three.js)** — сняты (16.10, 29.10): не развиваются и не проверяются.

## Ключевые файлы-ориентиры
- Типы данных: `packages/shared/src/types/index.ts`
- Шина событий: `packages/shared/src/events/index.ts`
- Реестр конфигов + схемы: `packages/shared/src/config/`
- Формулы: `packages/shared/src/formulas/`
- Комната игры: `packages/server/src/net/room.ts`, сессия мира: `packages/shared/src/session/session.ts`
- Виды окон (что сервер считает клиенту): `packages/shared/src/views/`; интерактивы и туман — `session/interactables.ts`, `session/reveal.ts`

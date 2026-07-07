# CLAUDE.md — карта проекта (индекс-«якорь»)

Браузерный dungeon-crawler в духе Diablo 2. Top-down экшн-RPG: город → процедурное
подземелье → лут → экипировка → прокачка → смерть/возврат → город. Стек: **Phaser 3 +
TypeScript + Vite** (клиент), **Node + Express + SQLite** (сервер), **HTML-редактор**
конфигов. Всё, что касается баланса и контента, — data-driven (JSON + zod-схемы).

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
- `packages/shared` — типы, формулы, события, config registry. Общий фундамент.
- `packages/client` — Phaser-игра. Сцены в `src/scenes`, фичи в `src/modules/<feature>`.
- `packages/server` — Express + SQLite: `/auth`, `/save`, `/load` + валидация.
- `packages/editor` — HTML-редактор конфигов (страницы по механикам, CRUD, live-apply).

## Модули клиента (`packages/client/src/modules/`)
| Модуль | Что делает | Статус |
|---|---|---|
| movement | WASD-движение, коллизии | готово |
| combat | оружие, базовая атака, расчёт боя, каст скиллов | готово |
| dungeon-gen | процедурная генерация этажей | готово |
| loot | генерация случайных предметов, дроп | готово |
| inventory | инвентарь, экипировка, требования | готово |
| classes | Воин/Маг/Лучник, выбор класса | готово |
| skills-active | активные скиллы per-class (3 ветки, за очки) | готово |
| skills-passive | общее пассивное дерево (за золото) | готово |
| progression | атрибуты, XP, распределение очков | готово |
| town | магазин, кузница, мастер прокачки | готово |
| quests | основные + случайные квесты (серверные) | готово |
| death | смерть, возврат, потеря лута | готово |
| auth | аккаунты (логин/пароль), серверный ростер персонажей | готово |
| sfx | звуковые заглушки (WebAudio) на события | готово |

## Команды
- `npm install` — установка (workspaces).
- `npm run dev` — клиент (Vite) + сервер (Express) параллельно.
- `npm run editor` — HTML-редактор конфигов.
- `npm test` — юнит-тесты формул (vitest).

## Ключевые файлы-ориентиры
- Типы данных: `packages/shared/src/types/index.ts`
- Шина событий: `packages/shared/src/events/index.ts`
- Реестр конфигов + схемы: `packages/shared/src/config/`
- Формулы: `packages/shared/src/formulas/`
- Bootstrap игры: `packages/client/src/main.ts`, сцены: `packages/client/src/scenes/`

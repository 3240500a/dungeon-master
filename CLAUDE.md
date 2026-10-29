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
3. **Формулы чистые.** Вся математика — в `packages/shared/src/formulas` (без DOM),
   покрыта юнит-тестами; её исполняет сервер (клиент Unity формул правил не держит — рисует виды сервера).
4. **Definition of Done для любой правки:** обновить `README.md` модуля и строку в
   [docs/MODULE_MAP.md](docs/MODULE_MAP.md).

## Общие хелперы
- Боевые формулы — `shared/formulas/combat.ts` (`resolveAttack`), стат-блок игрока — `shared/session/derive.ts` (`playerSnapshot`), бот/сим — `shared/sim/playerBot.ts` (`makePlayerModel`),
  монстров — `shared/formulas/monstergen.ts`; лист героя глазами сервера — `shared/views/hero.ts`.
- Туман войны и вид комнаты — `shared/session/reveal.ts` (куски 16×16, `revealOf`) + `server/net/room.ts` (`roomView`, `eventVisible`);
  прямая видимость — `shared/world/lineOfSight.ts`.
- Панели калькулятора редактора (бывший веб-клиент: `App`, окна, `domUi`, `kit`) — `packages/editor/src/game/` (только редактору).

## Структура
- `packages/shared` — типы, формулы, события, config registry, протокол (`session/netTypes.ts`, `netSchemas.ts`), виды окон
  (`views/`). Общий фундамент: его исполняет сервер, его же зовёт редактор.
- `packages/server` — Express + Postgres (`db/pool.ts`, доступ АСИНХРОННЫЙ): аккаунты и ростер (`/api/register|login|characters`),
  конфиг (`/api/config`), модели (`/assets`), игра — WebSocket `/ws` (`net/roomManager.ts` → `net/room.ts` → `GameSession`),
  инструменты — `/api/dev/*` (только вне продакшена и с ролью admin). Роль процесса (`DM_ROLE`): supervisor / gateway / node / single.
- `packages/craft-mesh` — модель оружия из деталей (three): её печёт сервер (DMCM/GLB для Unity), ею меряет клинки редактор.
- `packages/pose-editor` — поз-редактор анимаций (Three.js + Jolt), `pose-editor.html`; пишет `/api/dev/pose`, Unity читает. Тут же стенд
  паритета анимации (`render3d/parityHarness.ts`) и генератор эталона кадров Unity.
- `packages/editor` — HTML-редактор конфигов (страницы по механикам, CRUD, live-apply); калькулятор и песочница ковки — на панелях
  `src/game/` (перенесены из веб-клиента).
- ⭐ С11 (29.10.2026): веб-клиента (`packages/client`: Phaser 2D, Three.js 3D) больше нет — последнее состояние с ним под тегом
  `web-client-final`. Его эталоны для Unity заморожены: в Unity (`Assets/DM/**/Tests/*_golden.json`) и регрессией видов
  (`shared/src/views/__fixtures__`).

## Команды
- `npm install` — установка (workspaces).
- `npm run dev` — сервер (Express) + поз-редактор (Vite, http://localhost:5173/pose-editor.html) параллельно.
- `npm run editor` — HTML-редактор конфигов.
- `npm test` — юнит-тесты формул (vitest).

## Клиенты
- **Unity** — единственный игровой клиент (`C:\work\Games_Art\Games_Art\ashes of the past\Ashes of the past`, `Assets/DM`):
  тот же `/api` + `/ws`; проверка без редактора — `tools/unity-check/unity_check.py`.
- **Веб (2D Phaser, 3D Three.js)** — удалены (С11, 29.10; тег `web-client-final`).

## Ключевые файлы-ориентиры
- Типы данных: `packages/shared/src/types/index.ts`
- Шина событий: `packages/shared/src/events/index.ts`
- Реестр конфигов + схемы: `packages/shared/src/config/`
- Формулы: `packages/shared/src/formulas/`
- Комната игры: `packages/server/src/net/room.ts`, сессия мира: `packages/shared/src/session/session.ts`
- Виды окон (что сервер считает клиенту): `packages/shared/src/views/`; интерактивы и туман — `session/interactables.ts`, `session/reveal.ts`

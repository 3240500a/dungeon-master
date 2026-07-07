# ARCHITECTURE.md

## Обзор

Игра построена как набор **слабосвязанных фиче-модулей** поверх трёх общих механизмов из
пакета `@dm/shared`:

1. **Event Bus** — типизированная шина событий.
2. **Config Registry** — единая загрузка/доступ ко всем JSON-конфигам (со схемами zod).
3. **Module contract** — единый интерфейс модуля.

Модули не знают друг о друге. Они читают конфиги из реестра, публикуют/слушают события
на шине и оперируют общими типами из `@dm/shared`. Заменить или переписать один модуль
можно, не трогая остальные, пока сохраняется контракт (типы + события).

## Event Bus

`packages/shared/src/events` определяет карту `GameEvents` (имя события → тип payload) и
класс `EventBus` с типобезопасными `on/off/emit`. Примеры событий:

| Событие | Payload | Кто шлёт | Кто слушает |
|---|---|---|---|
| `monster:died` | `{ monsterId, x, y, level, dropTableId }` | combat | loot, progression, quests |
| `item:dropped` | `{ item, x, y }` | loot | dungeon world |
| `item:picked` | `{ item }` | inventory | quests |
| `player:levelup` | `{ level, attributePoints, skillPoints }` | progression | ui, quests |
| `player:died` | `{ depth }` | combat | death |
| `floor:entered` | `{ depth }` | dungeon-gen | quests, spawner |
| `quest:progress` | `{ questId, objectiveId, current, total }` | quests | ui |
| `config:reloaded` | `{ keys }` | config registry / editor | все модули |

> При добавлении события: объяви его в `GameEvents`, укажи в таблице выше и в README
> модулей-участников.

## Config Registry

`packages/shared/src/config`:
- `schemas.ts` — zod-схемы всех конфигов (единственный источник истины по форме данных).
- `data/*.json` — значения по умолчанию (контент игры).
- `registry.ts` — `ConfigRegistry`: загружает и валидирует JSON, отдаёт типизированный
  доступ (`get('balance')`), поддерживает `reload(partial)` для live-apply из редактора и
  эмитит `config:reloaded`.

Игра и HTML-редактор используют один и тот же `schemas.ts`, поэтому новое поле схемы
автоматически появляется и в валидации игры, и в формах редактора.

## Module contract

```ts
export interface GameModule {
  readonly name: string;
  init(ctx: ModuleContext): void;
  destroy?(): void;
}

export interface ModuleContext {
  bus: EventBus;
  config: ConfigRegistry;
  state: GameState;   // runtime + persisted состояние игрока/мира
  scene: Phaser.Scene; // текущая активная игровая сцена (для клиентских модулей)
}
```

Модули регистрируются в `packages/client/src/core` и получают `ctx` при `init`. Всё
взаимодействие наружу — через `ctx.bus` и `ctx.config`; прямых импортов между
`modules/<a>` и `modules/<b>` быть не должно (следит eslint-правило на границы папок).

## Поток данных (типичный тик)

1. Ввод (WASD/мышь) → `movement`/`combat` двигают/атакуют.
2. `combat` считает урон через `@dm/shared/formulas/damage`, при смерти монстра эмитит
   `monster:died`.
3. `loot` ловит `monster:died`, катит дроп через `formulas/itemgen`, эмитит `item:dropped`.
4. `progression` ловит `monster:died`, добавляет XP; при левелапе эмитит `player:levelup`.
5. `quests` ловит `monster:died`/`item:picked`/`floor:entered`, двигает цели.
6. `save` периодически сериализует `GameState` в localStorage и шлёт на сервер.

## Границы клиент/сервер

Клиент авторитетен для игрового процесса (одиночная игра). Сервер хранит сейвы и
**повторно валидирует** входящий `SaveState` через zod + пересчёт критичных величин теми
же формулами из `@dm/shared` (базовый анти-чит). Общие формулы/типы делают эту проверку
дешёвой и непротиворечивой.

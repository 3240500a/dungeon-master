# Модуль: loot

Дроп случайных предметов и золота, подбор с земли.

- **Контракт:** `LootController` (`lootController.ts`) — слушает `monster:died`, катит
  золото и (с шансом) предмет, роняет `DroppedItem`. Подбор: **клик** по предмету (в любой
  момент) ИЛИ **авто** при проходе рядом для редкостей из `balance.autoPickup`.
  `dropToGround(item)` — выбросить из инвентаря (с задержкой перед авто-подбором).
  Создаётся в базовой `GameScene` — работает и в городе, и в подземелье. `destroy()`.
- **Сущность:** `DroppedItem` (`droppedItem.ts`) — спрайт+подпись, цвет по редкости
  (`RARITY_COLOR`/`RARITY_HEX`).
- **Конфиг:** `items.base`, `affixes`, `uniques`, `dungeons` (dropBias темы).
- **События:** слушает `monster:died`; шлёт `item:dropped`, `item:picked`, `gold:changed`.
- **Формулы:** `generateItem`, `rollRarity` (`@dm/shared/formulas/itemgen`).
- **Единый конвейер:** все предметы (старт/квест/магазин/дроп/уник) собираются одним
  `buildItem` в `itemgen.ts`; `itemFromBase`/`generateItem` — тонкие обёртки. Тир берётся
  по уровню предмета ВЕЗДЕ (старт/награды тоже) — исключений нет. Единая база — `items.base`.
- **Тесты:** генерация предметов — `shared/formulas.test.ts`.
- **Использование:** `scenes/DungeonScene.ts`.

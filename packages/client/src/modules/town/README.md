# Модуль: town

NPC города: магазин, кузница и сундук (мастер прокачки — в модуле progression).

- **Магазин** (`shopPanel.ts`): продажа предметов инвентаря и покупка из ассортимента.
  Ассортимент генерируется `generateItem` (персистентен на сессию, `resetShopStock()`
  при входе в город, кнопка «Обновить»). Цены — `pricing.ts` (`buyPrice`/`sellPrice`).
- **Кузница** (`forgePanel.ts`): выбор предмета из инвентаря → «Улучшить» (усиление плоских
  базовых статов, +метка ★) или «Реролл» (перекат аффиксов через `rollAffixes`). Цены —
  `balance.forgePrices`.
- **Сундук** (`stashPanel.ts`): ОБЩИЙ на аккаунт (shared stash) — доступен всем героям
  пользователя (перенос шмота между персонажами). Вкладки + сетка; раскладка авторитетна на
  сервере (кадр `stash` → `app.stash`), команды `stashOpen`/`stashMove`. Курсор общий с
  инвентарём (`inventory/heldItem.ts`), сетка — общий `inventory/gridView.ts`. Хранится вне
  `SaveState` (таблица `account_stash`); см. [SERVER_AUTHORITY.md](../../../../../docs/SERVER_AUTHORITY.md).
- **Конфиг:** `items.base`, `affixes`, `uniques`, `dungeons` (для генерации), `balance`
  (forgePrices, `stash {tabs,cols,rows}` — деф. 2×20×12).
- **События:** открытие — по `ui:open` (NPC города шлют его при взаимодействии); операции
  шлют `state:changed`/`gold:changed` и сохраняют через модуль save.
- **Формулы:** `generateItem`, `rollAffixes` (`@dm/shared/formulas/itemgen`); сундук —
  `economy/stashActions.ts` (`stashMove`).
- **UI:** регистрируются в `main.ts` (`shop`, `forge`, `stash`).

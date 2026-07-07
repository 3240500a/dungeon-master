# Модуль: town

NPC города: магазин и кузница (мастер прокачки — в модуле progression).

- **Магазин** (`shopPanel.ts`): продажа предметов инвентаря и покупка из ассортимента.
  Ассортимент генерируется `generateItem` (персистентен на сессию, `resetShopStock()`
  при входе в город, кнопка «Обновить»). Цены — `pricing.ts` (`buyPrice`/`sellPrice`).
- **Кузница** (`forgePanel.ts`): выбор предмета из инвентаря → «Улучшить» (усиление плоских
  базовых статов, +метка ★) или «Реролл» (перекат аффиксов через `rollAffixes`). Цены —
  `balance.forgePrices`.
- **Конфиг:** `items.base`, `affixes`, `uniques`, `dungeons` (для генерации), `balance`
  (forgePrices).
- **События:** открытие — по `ui:open` (NPC города шлют его при взаимодействии); операции
  шлют `state:changed`/`gold:changed` и сохраняют через модуль save.
- **Формулы:** `generateItem`, `rollAffixes` (`@dm/shared/formulas/itemgen`).
- **UI:** регистрируются в `main.ts` (`shop`, `forge`).

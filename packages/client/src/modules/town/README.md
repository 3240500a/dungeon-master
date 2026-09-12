# Модуль: town

NPC города: магазин, кузница и сундук (мастер прокачки — в модуле progression).

- **Магазин** (`shopPanel.ts`): продажа предметов инвентаря и покупка из ассортимента.
  Ассортимент генерируется `generateItem` (персистентен на сессию, `resetShopStock()`
  при входе в город, кнопка «Обновить»). Цены — `pricing.ts` (`buyPrice`/`sellPrice`).
- **Кузница** (`forgePanel.ts`): выбор предмета из инвентаря → «Улучшить» (**подъём ТИРА** до
  `base.maxTier`, статы и требования пересчитываются ОТ БАЗЫ со скидкой `upgradeReqDiscount`),
  «Реролл» (перекат аффиксов, предел `rerollLimit`), «Починить» (снимает `broken` с трофея) и
  «Разобрать» (полный выход материалов против 30 % в поле). Цены — `balance.forgePrices`.
  ⚠ Материалы тратятся СПЕРВА ИЗ СУМКИ, потом из сундука (`canAffordBoth`/`spendBoth`): иначе
  игрок с полной сумкой сырья упирался бы в «нет материалов» перед самым действием.
- **Сундук** (`stashPanel.ts`): ОБЩИЙ на аккаунт (shared stash) — доступен всем героям
  пользователя (перенос шмота между персонажами). Вкладки + сетка; раскладка авторитетна на
  сервере (кадр `stash` → `app.stash`), команды `stashOpen`/`stashMove`. Курсор общий с
  инвентарём (`inventory/heldItem.ts`), сетка — общий `inventory/gridView.ts`. Хранится вне
  `SaveState` (таблица `account_stash`); см. [SERVER_AUTHORITY.md](../../../../../docs/SERVER_AUTHORITY.md).
  ⭐ **Вкладка «Ресурсы»** (ключ `'mats'`) — кошелёк сырья аккаунта и кнопка «Сдать всё».
  ⚠ Она живёт ВНЕ `balance.stash.tabs`: счётчик вкладок задаёт валидные индексы для `stashMove`,
  и попадание в него сделало бы валидным перенос вещи в несуществующую сетку. Сырьё хранится
  отдельным полем `AccountStash.materials`, а НЕ ещё одной вкладкой `tabs`, потому что леджер
  предметов разворачивает `tabs` в строки `items` по uid — слияние стеков убило бы uid, и
  ночной аудит записал бы исчезнувший как `gone`.
- **Конфиг:** `items.base`, `affixes`, `uniques`, `dungeons` (для генерации), `craft-materials`,
  `salvage-rules`, `balance` (forgePrices, `stash {tabs,cols,rows}` — деф. 2×20×12,
  `inventory.materialStack`).
- **События:** открытие — по `ui:open` (NPC города шлют его при взаимодействии); операции
  шлют `state:changed`/`gold:changed` и сохраняют через модуль save.
- **Формулы:** `generateItem`, `rollAffixes` (`@dm/shared/formulas/itemgen`); сундук —
  `economy/stashActions.ts` (`stashMove`, `migrateWalletToStash`), кузница и сдача сырья —
  `economy/townActions.ts` (`forgeUpgrade`/`forgeRepair`/`forgeSalvage`/`depositMaterials`).
  ⚠ Команды, трогающие И сейв, И сундук, идут через `withStash` в `server/net/room.ts`: пишет
  атомарно и откатывает ОБА в памяти при сбое (образец — `stashMove`).
- **UI:** регистрируются в `main.ts` (`shop`, `forge`, `stash`).
